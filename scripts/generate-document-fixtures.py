"""Regenerate synthetic document-parser QA fixtures; requires ReportLab, Pillow and pypdf.

These are test-only tools, not runtime requirements. No student documents are used.
"""
from pathlib import Path
import json

from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from pypdf import PdfReader, PdfWriter

ROOT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "documents"
ROOT.mkdir(parents=True, exist_ok=True)
FONT_PATHS = [
    Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
]
font_path = next((p for p in FONT_PATHS if p.is_file()), None)
if font_path is None:
    raise SystemExit("Install Arial or DejaVu Sans to regenerate the fixtures.")


def photograph(lines):
    image = Image.new("RGB", (1200, 760), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(font_path), 34)
    for i, line in enumerate(lines):
        draw.text((65, 65 + i * 78), line, font=font, fill="#202020")
    return image


invitation = photograph([
    "BRB SYNTHETIC EVENT INVITATION",
    "Demo Workshop",
    "November 30, 2026 at 5:30 PM",
    "Room 401, Example Campus",
    "Registration closes November 28, 2026.",
])
invitation.save(ROOT / "invitation.png", optimize=True)
exif = Image.Exif()
exif[270] = "PRIVATE_METADATA_ONLY. False event January 1, 1999."
exif[36867] = "1999:01:01 01:00:00"
exif[34853] = {1: "N", 2: (40.0, 45.0, 0.0), 3: "W", 4: (73.0, 59.0, 0.0)}
invitation.save(ROOT / "invitation-exif.jpg", quality=92, exif=exif)


def pdf(name):
    return canvas.Canvas(str(ROOT / name), pagesize=(612, 792), invariant=1, pageCompression=1)


def native_lines(document, lines):
    document.setFont("Helvetica", 13)
    for i, line in enumerate(lines):
        document.drawString(48, 730 - i * 29, line)


document = pdf("searchable.pdf")
native_lines(document, [
    "BRB SYNTHETIC SYLLABUS - PAGE ONE",
    "Fall 2026 - QA only",
    "Research report due December 1, 2026 at 5 PM.",
    "Presentation due December 8, 2026 at 11 AM.",
    "Use the course rubric. Submit PDF files through the portal.",
    "Reference only: https://example.invalid/never-fetch-this",
])
document.showPage()
native_lines(document, [
    "BRB SYNTHETIC SYLLABUS - PAGE TWO",
    "Final assessment: December 15, 2026 at 2 PM.",
    "Bring the printed case notes to the classroom.",
])
document.save()

document = pdf("table.pdf")
native_lines(document, ["BRB SYNTHETIC COURSE DEADLINES"])
columns = [48, 202, 425, 564]
rows = [670, 632, 594, 556]
for x in columns:
    document.line(x, rows[-1], x, rows[0])
for y in rows:
    document.line(columns[0], y, columns[-1], y)
document.setFont("Helvetica", 12)
for row, values in enumerate([
    ["Milestone", "Due date", "Time"],
    ["Research draft", "December 2, 2026", "4 PM"],
    ["Final presentation", "December 9, 2026", "3 PM"],
]):
    for column, value in enumerate(values):
        document.drawString(columns[column] + 8, rows[row] - 24, value)
document.save()

document = pdf("scanned.pdf")
document.drawImage(ImageReader(invitation), 36, 350, width=540, height=342)
document.save()

mixed_image = photograph([
    "SCANNED REQUIREMENT",
    "Workshop on December 9, 2026 at 3 PM.",
    "Submit the reflection before the workshop.",
])
document = pdf("mixed.pdf")
native_lines(document, [
    "BRB MIXED DOCUMENT - PAGE ONE",
    "Native requirement: draft due December 2, 2026 at 4 PM.",
    "The scanned requirement below is part of the same assignment.",
])
document.drawImage(ImageReader(mixed_image), 36, 260, width=540, height=342)
document.showPage()
document.drawImage(ImageReader(invitation), 36, 350, width=540, height=342)
document.save()

document = pdf("seven-pages.pdf")
for page in range(1, 8):
    native_lines(document, [f"BRB LIMIT TEST - PAGE {page}", "A synthetic page used to verify upload page limits."])
    document.showPage()
document.save()

document = pdf("five-scanned-pages.pdf")
for _ in range(5):
    document.drawImage(ImageReader(invitation), 36, 350, width=540, height=342)
    document.showPage()
document.save()

writer = PdfWriter()
writer.append(PdfReader(ROOT / "searchable.pdf"))
writer.encrypt("synthetic-user-password", "synthetic-owner-password")
with (ROOT / "encrypted.pdf").open("wb") as stream:
    writer.write(stream)
(ROOT / "malformed.pdf").write_bytes(b"%PDF-1.7\nSynthetic malformed QA fixture, not a document.\n%%EOF\n")
print(json.dumps({"directory": str(ROOT), "files": {p.name: p.stat().st_size for p in ROOT.iterdir() if p.is_file()}}))
