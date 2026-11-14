#!/usr/bin/env python3
"""Bounded, local-only MarkItDown PDF bridge; invoked by BRB with python -I.

Usage: markitdown_extract.py /absolute/private/input.pdf --pages 3
       markitdown_extract.py --check

Only the PDF converter is called, with in-memory single-page streams. Images
and scanned PDF pages continue through BRB's existing local OCR pipeline.
"""

import importlib.metadata
import io
import json
import logging
import os
from pathlib import Path
import stat
import sys
import warnings

MAX_BYTES = 12 * 1024 * 1024
MAX_PAGES = 6
MAX_CHARS = 200_000
MAX_MEMORY = 512 * 1024 * 1024
PACKAGE_VERSION = "0.1.9"
PYPDF_VERSION = "7.1.0"


class ExtractionError(Exception):
    """A fixed public error code; never contains document content or paths."""


def deny_external_access(event, _args):
    # Install before importing conversion libraries. No network, child process,
    # shell, or system browser is needed to convert a local PDF byte stream.
    if (event.startswith("socket.") or event in {
        "subprocess.Popen", "os.system", "os.posix_spawn", "os.posix_spawnp",
        "os.exec", "os.spawn", "urllib.Request", "http.client.connect",
        "webbrowser.open",
    }):
        raise PermissionError("external_access_disabled")


def apply_resource_limits(output_fd=1):
    import resource

    def lower_limit(kind, soft, hard=None):
        current_soft, current_hard = resource.getrlimit(kind)
        hard = soft if hard is None else hard
        if current_hard != resource.RLIM_INFINITY:
            hard = min(hard, current_hard)
        if current_soft != resource.RLIM_INFINITY:
            soft = min(soft, current_soft)
        resource.setrlimit(kind, (min(soft, hard), hard))

    lower_limit(resource.RLIMIT_CORE, 0)
    lower_limit(resource.RLIMIT_CPU, 25, 26)
    # Linux supports a hard address-space cap. macOS rejects smaller AS/DATA
    # limits on some versions, so monitor resident memory there instead. The
    # Node caller also enforces a wall-clock timeout and kills this child.
    try:
        lower_limit(resource.RLIMIT_AS, MAX_MEMORY)
    except (ValueError, OSError):
        if sys.platform != "darwin":
            raise
        import threading
        import time

        def monitor_memory():
            while True:
                # Darwin reports ru_maxrss in bytes (Linux uses KiB).
                if resource.getrusage(resource.RUSAGE_SELF).ru_maxrss > MAX_MEMORY:
                    try:
                        os.write(output_fd, b'{"version":1,"engine":"markitdown",'
                                            b'"packageVersion":"0.1.9","available":false,'
                                            b'"error":"resource_limit"}\n')
                    except OSError:
                        pass
                    os._exit(1)
                time.sleep(0.1)

        threading.Thread(target=monitor_memory, daemon=True).start()


def read_pdf(filename):
    path = Path(filename)
    if not path.is_absolute() or "\x00" in filename:
        raise ExtractionError("invalid_input")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise ExtractionError("invalid_input")
            if info.st_size < 5 or info.st_size > MAX_BYTES:
                raise ExtractionError("input_size_limit")
            data = stream.read(MAX_BYTES + 1)
    except ExtractionError:
        raise
    except (ValueError, OSError):
        raise ExtractionError("invalid_input") from None
    if len(data) > MAX_BYTES:
        raise ExtractionError("input_size_limit")
    if not data.startswith(b"%PDF-"):
        raise ExtractionError("invalid_pdf")
    return data


def load_converters():
    try:
        if not (3, 11, 5) <= sys.version_info[:3] < (3, 15, 0):
            raise ExtractionError("unsupported_python")
        if (importlib.metadata.version("markitdown") != PACKAGE_VERSION
                or importlib.metadata.version("pypdf") != PYPDF_VERSION):
            raise ExtractionError("dependency_version_mismatch")
        from markitdown import StreamInfo
        from markitdown.converters import PdfConverter
        from pypdf import PdfReader, PdfWriter
        # PdfConverter defers optional-dependency failures until conversion;
        # check them explicitly so --check reports genuine PDF availability.
        import pdfminer.high_level  # noqa: F401
        import pdfplumber  # noqa: F401
        return StreamInfo, PdfConverter, PdfReader, PdfWriter
    except ExtractionError:
        raise
    except (ImportError, importlib.metadata.PackageNotFoundError):
        raise ExtractionError("dependency_unavailable") from None


def extract_pages(data, expected_pages, converters):
    StreamInfo, PdfConverter, PdfReader, PdfWriter = converters
    try:
        reader = PdfReader(io.BytesIO(data), strict=True)
        if reader.is_encrypted:
            raise ExtractionError("encrypted_pdf")
        count = len(reader.pages)
        if count < 1 or count > MAX_PAGES:
            raise ExtractionError("page_limit")
        if count != expected_pages:
            raise ExtractionError("page_count_mismatch")

        converter = PdfConverter()
        stream_info = StreamInfo(extension=".pdf", mimetype="application/pdf")
        result = []
        total_chars = 0
        for page in reader.pages:
            # PdfConverter's whole-document table extraction does not preserve
            # blank pages. Isolating each page preserves OCR alignment/order.
            writer = PdfWriter()
            writer.add_page(page)
            with io.BytesIO() as page_stream:
                writer.write(page_stream)
                if page_stream.tell() > MAX_BYTES:
                    raise ExtractionError("input_size_limit")
                page_stream.seek(0)
                markdown = converter.convert(page_stream, stream_info).markdown
            writer.close()
            if not isinstance(markdown, str):
                raise ExtractionError("invalid_output")
            markdown = markdown.replace("\x00", "").strip(" \t\r\n\f")
            total_chars += len(markdown)
            if total_chars > MAX_CHARS:
                raise ExtractionError("text_limit")
            result.append(markdown)
        return result
    except ExtractionError:
        raise
    except MemoryError:
        raise ExtractionError("resource_limit") from None
    except Exception:
        raise ExtractionError("invalid_pdf") from None


def emit_result(output_fd, result):
    # A private duplicate of the original stdout is the sole public channel.
    # File I/O handles partial pipe writes; UTF-8 avoids expanding non-Latin
    # document text past the Node bridge's 1 MiB output limit.
    with os.fdopen(os.dup(output_fd), "w", encoding="utf-8", errors="strict") as stream:
        stream.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")


def run(arguments, output_fd):
    metadata = {"version": 1, "engine": "markitdown", "packageVersion": PACKAGE_VERSION}
    try:
        check = arguments == ["--check"]
        if not check:
            if (len(arguments) != 3 or arguments[1] != "--pages"
                    or not arguments[2].isascii() or not arguments[2].isdigit()):
                raise ExtractionError("invalid_arguments")
            expected_pages = int(arguments[2])
            if expected_pages < 1 or expected_pages > MAX_PAGES:
                raise ExtractionError("page_limit")

        sys.dont_write_bytecode = True
        sys.addaudithook(deny_external_access)
        apply_resource_limits(output_fd)
        logging.disable(logging.CRITICAL)
        warnings.simplefilter("ignore")
        data = None if check else read_pdf(arguments[0])
        converters = load_converters()
        output = ({**metadata, "available": True} if check else {
            **metadata, "pages": extract_pages(data, expected_pages, converters)
        })
        emit_result(output_fd, output)
        return 0
    except ExtractionError as error:
        code = str(error)
    except MemoryError:
        code = "resource_limit"
    except Exception:
        code = "conversion_failed"
    emit_result(output_fd, {**metadata, "available": False, "error": code})
    return 1


def main(arguments):
    # Native libraries can write directly to fd 1/2, bypassing Python's stream
    # redirects. This bridge owns its process: mute both descriptors until exit
    # so even delayed C stdio flushes/atexit logs cannot expose document data.
    # Keep only a private stdout duplicate for the final sanitized JSON result.
    sys.stdout.flush()
    sys.stderr.flush()
    output_fd = os.dup(1)
    try:
        with open(os.devnull, "w", encoding="utf-8") as sink:
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
        return run(arguments, output_fd)
    finally:
        os.close(output_fd)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
