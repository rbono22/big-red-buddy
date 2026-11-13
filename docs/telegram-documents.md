# Invitations, syllabi, and schedule photos in Telegram

First sign into BRB, connect your own Google Calendar, and link your own private Telegram chat under Connections. All students use the same bot with separate account ownership.

## Invitation screenshots

1. Send `/invite`, then attach a clear screenshot of a Luma, Partiful, SMS, or WhatsApp invitation. You can also put `invite` in the photo caption. An unlabelled image outside an active upload flow offers an **Event invitation** button.
2. BRB reads the screenshot with local OCR and the private model. It checks the public event page when an actual Luma/Partiful URL is visible in the screenshot or caption. A picture of an “RSVP” button does not contain its hidden link; paste the original link in the caption if you want it saved.
3. Reply to any missing-detail questions, then check the title, exact date including year, New York start time, duration, and location. Use the edit buttons to correct a detail.
4. Tap **Add to Google Calendar** to save and queue synchronization to your connected BRB calendar. Without a Google connection, you can save to your BRB schedule and connect Google later. Calendar synchronization and reminders require the host and workers to be online.

The bot retains a bounded event excerpt and the confirmed details, not a permanent screenshot file. Temporary local OCR files are removed after processing; Telegram still processes the photo you send. Drafts and their buttons expire. No RSVP, registration, payment, or invitation to other people is submitted. Use the original event link to register. Reminders follow your event notification preferences.

The upload window lasts 15 minutes and an unconfirmed review lasts 30 minutes. Interrupted saves retain their pending details for at most 24 hours so they can recover; cleanup preserves any event already saved. Encrypted queue payloads follow the existing 24-hour cleanup window. Retention cleanup continues even if pilot access is revoked.

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

Switching to `/enrollment`, `/resume_upload`, or `/invite` exits syllabus mode; `/syllabus` exits resume-upload mode. Use an explicit upload command to switch purpose. Unlabelled images outside an active mode offer a purpose chooser so invitations are not treated as class schedules.

Enable school notifications in Connections to receive reminders. Default timing is ten minutes before classes, and 24 hours/four hours before deadlines; students can edit it. Calendar writing and reminders require the host and workers to remain available.

## Menu and everyday changes

Send `/menu`, `/start`, or the word `menu` in your linked private chat. My day, Add something, Jobs, Events, and Settings provide button navigation. Setup checklist reports your connected accounts, resume, classes, and notification settings; authorization opens the secure BRB website. An unlinked student's `/start` offers a Cornell sign-in link, then Connections links the private chat.

Unlabelled JPEG/PNG images and PDFs get a purpose chooser. Local OCR suggests syllabus, class schedule, resume, or invitation where supported text is recognizable; students choose the actual purpose. Choosing coursework asks for Fall 2026 or Spring 2027. Resumes still require PDF. Active explicit upload modes retain precedence. OCR classification does not import or approve anything.

Supported routine phrases include “Remind me 30 minutes before classes”, “Remind me 2 hours before deadlines”, “Turn off job alerts”, and “Move studying to Thursday”. Reminder changes and personal-event moves require a confirmation button. A move must identify exactly one upcoming personal event; its existing time and duration are shown/preserved, and the next named weekday is displayed as an exact date. Imported campus events and classes are not moved by this phrase. Changed records invalidate old proposals. Turning off separate job alerts preserves an existing daily jobs briefing.

Settings also offers reminder category and lead-time buttons. These apply to every event in the chosen category. Job cards offer preparation, connection lookup, Save, and Skip; preparation does not submit to an employer. Save uses the same bookmark as Career Studio. Skip hides the job from subsequent menu recommendations and discovery batches. Event cards offer calendar import, registration links, and dismissal from suggestions. Dismissing a suggestion does not remove an existing Google event. Deadline reminders offer requirements, a copyable starter prompt, and reminder settings.

Telegram-origin calendar jobs report provider-confirmed completion, or an accurate partial/failure notice with Retry and Reconnect. Provider timeouts do not become success messages; stable event IDs protect retries from duplicate inserts. An uncertain calendar creation still requires reconciliation in Connections. Receipts are best-effort queued messages; Google success remains recorded even if receipt delivery fails. Buttons expire after 30 minutes and are bound to the student and current Telegram connection; expired buttons offer a fresh menu. Temporary action records are capped and pruned by the worker.


## Remove an event

1. Choose **Events → Remove an event**, or tap **Remove from calendar** on a calendar event. You can also type “Delete studying” or `/deleteevent Studying with Josh`.
2. Choose the specific event from the results. Search includes the previous 30 days and next 90 days, with upcoming events first. Dates and calendar names distinguish events with similar titles.
3. Review the exact date, time, calendar, and cancellation impact. Recurring entries remove only the selected occurrence. If you organized a meeting, the preview explains that Google may notify its guests.
4. Tap **Delete this event**. BRB reports the result after Google responds. **Cancel** leaves the event in place. A plain “yes” is not a deletion confirmation.

Events on the BRB assistant calendar use the Google connection you already authorized. To remove events from your selected personal calendars, open **Connections → Remove calendar events in Telegram → Enable calendar editing** and complete Google's consent screen once. Select your calendars in the reading section above it. Read-only subscriptions cannot be edited. Disabling editing keeps calendar reading connected.

Changed events need a new preview. If Google cannot confirm deletion, **Check event / Retry** reads the event again before asking for confirmation; the bot never blindly repeats a deletion. Unresolved removals can also be found through the removal search. BRB reminders remain paused while a confirmed removal is unresolved. Deleted imports are remembered so later synchronization does not bring them back. Removing an event does not cancel a Partiful/Luma registration or ticket. This flow supports one event or occurrence at a time.

## Apply to supported Ramp jobs

Choose **Jobs → Apply via Telegram**. Fill reusable payroll location, office preferences, and SMS/WhatsApp choices in **Resume & profile → Common application details**; the bot’s profile button opens this form directly. Tap **Use saved profile** afterwards. BRB estimates relevant product-management experience from resume titles and dates and shows the basis for review. Answer remaining employer questions, or tap **Draft with AI** and review the suggested text.

The final **Submit to Ramp** button sends your reviewed application. BRB reports “Submitted” only after an employer confirmation appears. `/application` resumes your current review. Other employer forms retain **Prepare application** and the employer link. If receipt is unconfirmed after an interruption, check your employer email before trying another application; BRB never automatically retries a submission.
