# HCI review: BRB web and Telegram

This pass applies the eight course readings in the supplied HCI folder to common student tasks. It is a heuristic review and implementation exercise, not evidence that students have validated the design. Automated checks and visual inspection cannot establish accessibility for every assistive technology or prove time savings.

The organizing goal is: **help a student understand the next useful action, complete it on their current device, and know what actually happened.**

## Reading-to-design map

Page numbers below refer to PDF pages, including title pages. The source PDFs remain outside the repository.

| Reading | Relevant evidence | BRB design decision |
| --- | --- | --- |
| `02 Device language (1).pdf` | Pages 20, 24, 28 and 31-33: context determines content; responsive layouts must adapt for touch and mixed input devices. Page 46: reuse familiar patterns. | Keep Telegram actions as recognizable buttons and retain command shortcuts. Use a labeled mobile navigation control, readable single-column content, and comfortable touch controls on the website. |
| `10 info-hierarchy (1).pdf` | Pages 9-19: size, color, alignment, proximity and whitespace guide attention. Pages 26 and 30-31: consistent patterns make interfaces easier to interpret. | Give each screen a clear heading and task area. Group related controls; make primary actions distinct without treating every panel or secondary action as equally important. |
| `11 typography (1).pdf` | Pages 12 and 18-19: available typefaces and deliberate pairing. Pages 14-15 and 22-23: line spacing, line length and alignment affect reading. | Keep the existing heading/body pairing, constrain long prose, reduce oversized headings, and use a consistent readable type scale. |
| `12 color theory (1).pdf` | Pages 30, 36 and 39: contrast and restrained accent colors. Pages 50-51 and 56: use neutrals and let the product goal guide color choices. | Retain Cornell red with neutral surfaces; reserve strong color for selected states, primary actions and meaningful feedback. Keep text or icons alongside status colors. |
| `Slides--Lecture2-understanding.pdf` | Pages 8-11: users differ and need visible actions/state. Pages 16, 19 and 22: signifiers, familiar mapping and feedback. | Use explicit button labels, current-page state, page titles, route focus and visible progress. Do not make students infer whether a click or queued action succeeded. |
| `Slides-usability (1).pdf` | Pages 18-27: status, freedom, consistency, error prevention, recognition, flexibility, minimalism and recovery. Pages 28-31 distinguish heuristic review from user testing. | Keep routine choices visible, make errors recoverable, offer cancellation before changes, and preserve both menu and shortcut paths. Test completion of real tasks rather than merely counting clicks. |
| `Design for User Empowerment (1).pdf` | Pages 3-4: universal design includes options and ability-based adaptation. Pages 4-6: people with disabilities should participate throughout design, with access built in. | Support keyboard navigation, screen-reader status, reduced motion and user-controlled preferences. Keep optional data choices optional. Involve students with relevant access needs in the next design iteration. |
| `Slides--Lecture21-marginalized (1).pdf` | Pages 8 and 11: mobile use and intermittent connectivity. Pages 14, 18-19 and 23: fit the local context and give users useful control. | Design for phone use between classes and interrupted connections. Show when work is queued, avoid guessing success, and let students retry or reconnect without silently repeating an action. |

## Review findings addressed in this pass

The implementation review identified these concrete problems:

- Hash navigation replaced the main content without updating the browser title or moving keyboard focus to the new page.
- Generic errors disappeared after a short timeout, leaving slow readers without a persistent recovery message.
- Some operations used a global busy flag without a clear visible explanation while work was pending.
- Background task feedback used generic completion text and needed an explicit guard against displaying a previous account's work after a session change.
- The small-screen layout exposed the full navigation before the task content instead of a clearly labeled menu control.

Event browsing and the populated calendar now come before connector instructions, which remain available under Manage event sources. The visual pass reduces oversized page headers and the events introduction so useful controls appear sooner. It uses consistent 44-pixel controls, 16-pixel mobile input text, readable metadata, and a 72-character maximum line length for long explanatory text. Event names remain visible rather than being truncated. Cornell red continues to identify primary actions and selected states, with neutral surfaces, quieter status indicators and visible selected borders in forced-color mode.

These choices follow the hierarchy deck's proximity and consistency examples (pages 16, 19 and 26), the typography deck's line-length guidance (page 22), and the color deck's red-against-neutrals example (page 36). Representative pages from those decks and the accessibility/usability readings were rendered and inspected, rather than relying only on extracted text.

The Telegram pass shows current notification choices in everyday language, previews delivery changes before Confirm/Cancel, and offers readable reminder presets. Contextual Back buttons reduce dead ends; setup distinguishes optional resume upload from required connection steps and checks Calendar permission separately from Google sign-in. Settings show the relevant Pause or Resume action. Job posting dates use readable calendar dates. Skipped jobs and hidden events offer Undo with ownership and version checks. Invitation upload, reading and review have numbered stages, and a student can change the document's purpose without resending it. Final upload messages provide a route back to the main menu.

These changes apply the device-language deck's context and familiar-pattern guidance (page 20), the understanding-users deck's visibility and feedback principles (pages 11 and 22), and the usability deck's control, recognition and recovery principles (pages 20, 23 and 26). They preserve tenant ownership, confirmation for consequential changes, and the distinction between queued work and confirmed external actions.

## Student usability session

Use synthetic syllabi, invitations, resumes and job records for the initial sessions. Do not ask participants to reveal sensitive demographic answers or grant unnecessary account access. Invite participants to help revise the flows, including students who use a keyboard, screen reader, magnification, or other access tools. Let them choose their preferred input method; do not treat everyone as a mobile touch user.

| Task, expressed as a student goal | Observable completion condition |
| --- | --- |
| 1. Find today's classes and the next deadline from Telegram without memorizing commands. | Student opens the appropriate menu and identifies the time/location or missing-information state without moderator coaching. |
| 2. Send a syllabus image, correct BRB's document interpretation if necessary, and review the extracted deadlines. | Student recognizes what BRB thinks the document is, can choose another purpose, and knows which dates remain unconfirmed. |
| 3. Change class reminders to 30 minutes before, inspect the proposal, cancel it, then save the desired setting. | Cancellation leaves the old value unchanged; confirmation saves the new value; the student can find the current setting. |
| 4. Add a social event to Google Calendar and find its registration link. | Student distinguishes adding a calendar entry from registering with the organizer, and recognizes queued versus confirmed calendar status. |
| 5. Find a relevant recent job on a phone, save it, and prepare an application. | Student can navigate filters/details, locate the saved job and understand that preparing an application is different from submitting it. |
| 6. Navigate between web sections using a keyboard and recover from a simulated connection error. | Focus reaches the new section, controls remain operable, the error remains readable, and the student can identify the next recovery action. |
| 7. Choose which topics arrive in the daily briefing and skip optional profile questions. | Student can change delivery preferences without accidentally changing unrelated choices, and can continue without supplying optional sensitive data. |

Record completion, elapsed time from task instruction to verified outcome, errors, unwanted changes, moderator assistance, and a brief ease rating. Count source checks and corrections in elapsed time. Capture the participant's interpretation of queued, saved, approved and submitted states rather than assuming the labels are understood.

Compare the old and revised flow where practical, using the same task data and alternating task order. Report the number and characteristics of participants, device/input method, unsuccessful attempts and accessibility barriers alongside any median time. These are proposed measurements, not measured improvements. Do not label a small convenience sample as representative of all Cornell Tech students.

## Verification boundaries

- Integrated browser checks used synthetic records across eight sections at 1440px, 390px and 320px widths. The 24 views had no JavaScript errors, horizontal page overflow, or automated WCAG A/AA findings from axe. The expanded mobile menu was also checked, including readable hover/focus states, Escape dismissal, page focus, and persistent error dismissal. This does not establish comprehensive accessibility or replace testing with assistive technology.
- The local full suite passed 841 tests, with three PostgreSQL-dependent tests skipped. After the final event-order and menu-contrast refinements, the 146 web interface/behavior tests passed again. Telegram-focused tests cover stale confirmations, ownership, cancellation, Undo, and changing upload purpose.
- Eight focused web behavior tests in `tests/hci-web.test.mjs` passed during this review: route naming/focus and mobile-menu closure, focus retention after a refresh, persistent dismissible errors, pending-action feedback and duplicate prevention, worker-confirmed task feedback, suppression of a previous session's in-flight response, and two cases preventing false Telegram-delivery confirmation. These use a synthetic DOM and mocked services; they do not substitute for browser or screen-reader testing.
- Automated tests should exercise cancellation, stale callbacks, ownership, status announcements and keyboard behavior using synthetic data.
- Visual inspection should cover a narrow phone viewport, a desktop viewport, zoomed text, focus indicators and long content. Inspect changes with reduced-motion preference where supported.
- No test should send a real Telegram message, submit a job application or write to a student's Google Calendar merely to demonstrate the interface.
- Record actual checks and unresolved issues in the release report. Passing implementation checks does not replace student testing or a formal accessibility audit.
