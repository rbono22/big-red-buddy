# One reviewed list

Before Big Red Buddy, a student checks Canvas, syllabus PDFs, Slack and email,
copies dates into a spreadsheet, checks for collisions, and updates a calendar.
With Big Red Buddy, the student imports those records into one workspace, checks
the supporting text beside each extracted date, resolves missing times, and
approves the resulting list for calendar sync. The Academics screen explains this
workflow and exposes **Why this date?** beside deadlines and in the review dialog.

| Owner | Task | Reason |
| --- | --- | --- |
| Model | Read syllabus text and propose events; draft answers from retrieved records. | Handle variation in document wording without giving the model authority to act. |
| Code | Normalize dates and time zones, select the requested range, flag missing times, and enforce approval/connector permissions before calendar writes or sending. | Arithmetic, completeness and authorization must have inspectable rules. |
| Student | Compare dates to their source, resolve ambiguity, approve calendar items and separately opt into connector automation. | The student knows their enrollment and intended actions. |

## Knowledge source

The knowledge source is **the student's imported records**, including Canvas,
syllabi, Telegram-provided documents and announcements, stored with source IDs,
names, available links, excerpts and import timestamps. The owner-scoped event
records are the schedule used by the dashboard and date-range answers. They are
not a general web corpus or another student's calendar.

For schedule questions, code selects relevant records before building the model
request. Sending all records would waste context, expose irrelevant information,
and risk losing later records when a prompt is truncated. Canonical dates,
missing-time flags and the full matching list remain controlled by code.

## Freshness and review

Refresh connected feeds or re-import a revised syllabus PDF under the same
filename. The syllabus import compares its fingerprint with the previous import.
A changed fingerprint records a change timestamp, warns on the source, and
reopens review for its extracted dates, even if their visible fields match.
Removed items are marked for cancellation review. Re-importing unchanged content
preserves approvals. Calendar sync and reminders still require eligible reviewed
items; importing a changed source alone does not authorize a new calendar write.

Independent photos remain separate sources to avoid replacing unrelated pages
that share camera filenames. Renamed PDFs may likewise be separate imports;
students should check duplicates. The app cannot detect edits in a document that
has not been re-imported. Import timestamps establish when BRB checked a source,
not a promise that the original has not changed since.
