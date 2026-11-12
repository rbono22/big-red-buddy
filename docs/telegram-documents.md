# Syllabus and schedule photos in Telegram

First sign into BRB, connect your own Google Calendar, and link your own private Telegram chat under Connections. All students use the same bot with separate account ownership.

## Syllabus photos on the website

In Academics, go to **Add your syllabus deadlines**, choose the term, and select **Upload PDF or photo**. On a phone, **Take photo** opens the device's file/camera picker where supported. Use JPEG, PNG, a searchable PDF, or a scanned PDF. Convert HEIC photos to JPEG first. Upload the pages with deadlines and any rules that specify their times. The upload area shows progress and errors, and successful uploads appear under **Needs review** before calendar synchronization or reminders. Each file must be at most 12 MB; PDFs are limited to six pages, including at most four scanned pages.

## Syllabus deadlines

1. Send `/syllabus FA26` for Fall 2026 or `/syllabus SP27` for Spring 2027.
2. Within 15 minutes, attach a clear JPEG/PNG photo or PDF of the syllabus pages containing assignments, quizzes, exams, dates, and deadline rules. You can instead put `/syllabus FA26` in the file caption. Send files individually. For several pages, use one PDF where possible so rules and dates are read together.
3. The bot returns numbered deadlines and an eight-character review code. `/syllabus_review CODE 2` shows the next page when needed. All candidates are also available in Academics.
4. If a time is missing or wrong, send `/syllabus_time CODE NUMBER HH:MM`. Times are 24-hour New York time. For exams, include the end time: `/syllabus_time CODE NUMBER 09:00 11:00`. Review the updated response. Correct dates or unmatched evidence in Academics.
5. Send `/syllabus_confirm CODE 1 2` to approve your selected items and queue Google Calendar synchronization. Use the actual code/numbers shown by the bot. An upload has one confirmation batch; remaining items can be reviewed in Academics. Missing times, changed records, and unmatched source evidence block bot confirmation.

Source photos use local OCR and the private model. Original upload bytes are removed from temporary local storage after extraction; derived event evidence is stored in the student's workspace. Telegram also processes the files sent to its bot. OCR/model output is not independent verification. Photograph complete lines, dates, course headings, and deadline-time rules without blur or glare. Re-uploading identical file bytes in the same term reuses the source; overlapping or separately photographed pages may still need duplicate review.

Uploads are limited to 12 MB, 24-megapixel images, six PDF pages, and at most four scanned PDF pages per file. Send a shorter document when extraction limits are reached. The model extracts deadline candidates only, keeping class meetings in the separate catalog-based schedule flow.

## Class schedule

Send `/enrollment FA26` or `/enrollment SP27`, then attach the Cornell enrollment PDF or a sharp schedule photo. Include course codes, class numbers/sections, and enrollment status. BRB matches against its supported Cornell catalog snapshot and returns meeting dates, times, and locations. It cannot match arbitrary schedule pictures that lack those identifiers. Check current details in Student Center; the catalog is a snapshot.

Reply `/confirm CODE 1 3`, using the bot's actual code and your enrolled class numbers. Dropped and waitlisted classes must not be selected. Google Calendar sync is queued after confirmation when connected.

Switching to `/enrollment` or `/resume_upload` exits syllabus mode; `/syllabus` exits resume-upload mode. Unlabelled attachments retain the existing enrollment behavior when no upload mode is active. Explicit commands avoid ambiguity.

Enable school notifications in Connections to receive reminders. Default timing is ten minutes before classes, and 24 hours/four hours before deadlines; students can edit it. Calendar writing and reminders require the host and workers to remain available.
