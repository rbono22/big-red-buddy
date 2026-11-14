# Synthetic document extraction fixtures

These fixtures contain invented course/event text and no student information.
They exercise the real MarkItDown, Poppler and local OCR pipeline in
`tests/markitdown-integration.test.mjs`:

- `searchable.pdf`: two text pages with distinct deadlines and a non-fetchable reference URL.
- `table.pdf`: a ruled deadline table; extraction must preserve each milestone/date/time row in Markdown.
- `scanned.pdf`: an invitation image with dates and a room.
- `mixed.pdf`: native text plus an embedded scan on page one, then an image-only page two. Both sources and page order must survive.
- `invitation.png` and `invitation-exif.jpg`: identical visible invitation text. The JPEG additionally carries a false 1999 date, `PRIVATE_METADATA_ONLY`, and synthetic GPS coordinates in EXIF. None may become extracted evidence.
- `seven-pages.pdf` and `five-scanned-pages.pdf`: exceed the page and scanned-page limits respectively.
- `encrypted.pdf`: password-protected synthetic PDF; extraction must reject it.
- `malformed.pdf`: invalid PDF structure with a PDF signature.

Regenerate only when changing the fixtures:

```sh
python3 scripts/generate-document-fixtures.py
```

The optional generator needs ReportLab, Pillow, pypdf and Arial or DejaVu Sans.
These are fixture-authoring tools, not additional production/CI dependencies.
The checked-in files are sufficient for running tests. Require the actual tests
(instead of skipping when local tools are absent) with:

```sh
REQUIRE_MARKITDOWN_TESTS=1 node --test tests/markitdown-integration.test.mjs
```
