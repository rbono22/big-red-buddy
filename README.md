# Big Red Buddy · Cornell Tech student assistant

**New collaborators:** start with [CONTRIBUTING.md](CONTRIBUTING.md) for an isolated local checkout, setup, tests, and the pull request workflow. This private repository contains application code and sanitized reference data. Production credentials, student records, uploaded documents, and generated local reports are excluded. Repository access does not grant access to the deployed pilot or its infrastructure.

## Course catalog import

Academics now searches the public Cornell Tech course planner snapshots for FA26 and SP27. A student chooses an exact section and explicitly approves its published meeting schedule with one import action. Supported occurrences are stored in that student's workspace and, if Google Calendar is connected, a durable job syncs only those selected meetings. Repeated imports reuse event IDs and matching syllabus class records. This does not enroll students or verify their eligibility. Import is additive: adding a different section does not remove an earlier selection.

The source snapshot dates are visible. This is not live roster monitoring; a fresh fetch of the JSON does not make its underlying schedule current. Verified term/session boundaries and no-class dates are applied; unsupported sessions, tentative or missing times, conflicting source evidence, and unsupported exceptions block automatic import. Unpublished rooms remain blank with warnings. Upload a syllabus separately for assignments and exams. Enrollment PDFs and JPEG/PNG photos can be uploaded in Academics or sent to the linked Telegram bot. Set the term with `/enrollment FA26` or `/enrollment SP27`, attach the document, then confirm only your enrolled sections using the numbered review. Matches start unchecked; catalog matching cannot establish enrollment status from icons. Reviews expire after 24 hours. Syllabus PDFs for assignment extraction still use the website upload. Local OCR prefers Tesseract (installed on the pilot Mac and included in the Linux image), with an Apple Vision fallback on macOS; PDF processing requires Poppler. Uploads are limited to 12 MB, 6 PDF pages, and 4 OCR pages.

The local investigation report is recorded in `output/course-planner-analysis.json` (generated artifacts are excluded from this repository). Public JavaScript was inspected as inert text; the third-party server implementation and subscription service were not tested. The BRB adapter uses public structured schedule facts and independently written import logic.


A student-owned workspace for syllabus planning, Product Studio announcements, campus events, and application preparation. The app now has Google sign-in, encrypted PostgreSQL records with forced row-level security, durable jobs, separate model/reminder workers, and operational measurements.

**Local website:** http://127.0.0.1:4318. **Pilot website:** https://app.bigredbuddy.com, operated separately from this repository. A fresh checkout does not inherit its configuration or access. Local development sign-in is explicitly labeled and is not verified Google authentication. Real Google sign-in activates after operator OAuth configuration.

## Run the application

Requirements: Node 24+, PostgreSQL, Poppler (`pdftotext`), and a private Ollama server. Use the pinned dependencies in `package-lock.json`.

```sh
npm ci
npm start
```

Run workers in separate terminals/processes:

```sh
WORKER_ROLE=model npm run worker
WORKER_ROLE=reminders npm run worker
WORKER_ROLE=discovery npm run worker
```

The supplied local `.env`, when present, is private and ignored. It contains a password-authenticated local PostgreSQL connection and an explicitly enabled development identity. Do not copy it into an image or source archive. The isolated local PostgreSQL cluster uses port 55439; starting the website does not start PostgreSQL or Ollama. If that local cluster is stopped:

```sh
/opt/homebrew/bin/pg_ctl -D data/postgres-local -l data/postgres-local/server.log start
```

For a fresh checkout, start from `.env.example`. Production startup requires HTTPS, Google credentials, explicit enrollment policy, strong secrets, PostgreSQL, and a private model address; development identities are forbidden. The optional SQLite adapter is only for local tests/development, and production never silently falls back to it. [Pilot deployment instructions](deploy/PILOT.md) cover the always-on Linux deployment, secrets, backups, monitoring, and restore procedure.

## What each student does

1. Sign in with a verified `@cornell.edu` Google account from Cornell's Workspace. The pilot additionally requires an invitation in the server's email allowlist.
2. Upload their own syllabus and resume. Review extracted dates and resolve missing times.
3. Connect their own Google Calendar with separate OAuth consent. The app writes only to its dedicated app-created calendar.
4. Link their private Telegram chat through a short-lived, single-use link. **One shared bot serves everyone. Students do not create bots.**
5. Authorize their own Slack account and choose a channel they belong to. Membership is checked again when reading history.
6. Set target job titles, fetch employer postings, and review resume-grounded application drafts.

Student identity comes from the authenticated session, never a request body. Resumes, sources, events, connector credentials, jobs, drafts, exports, and tasks are scoped to that identity. Google account switching cannot attach another student's calendar authorization. Slack access is based on the student's user token, not a shared bot's ability to see a channel.

## Operator connector setup

**Google:** create a web OAuth client, enable Calendar API, and register `http://127.0.0.1:4318/auth/google/callback` for local use and `https://YOUR_DOMAIN/auth/google/callback` for hosting. Configure `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` privately. Sign-in verifies Google's identity token, Workspace domain, nonce, state, audience, issuer, and expiration. Calendar consent requests `calendar.app.created` and does not itself grant Gmail inbox access. Optional invitation and newsletter reading requires a separate Gmail read-only grant, Gmail API enabled in the same Google project, and explicit monitoring preferences. Cornell app restrictions and Google consent/testing configuration must be checked for each deployment.

**Cornell-only access:** the server requires both a verified email ending in exactly `@cornell.edu` and Google's `hd=cornell.edu` Workspace claim. Gmail, other domains, Cornell subdomains, and lookalikes such as `cornell.edu.example.com` cannot create a login. Configuration cannot widen the domain; non-Cornell domain or pilot-email settings prevent startup. A nonempty `PILOT_EMAILS` list restricts access further, and every authenticated request rechecks the identity and current list. Empty-list access requires explicit `ALLOW_ALL_CORNELL=true`, which still admits only verified Cornell accounts; the pilot deployment keeps the invitation list. Public origins require explicit access configuration even outside production. Development sign-in is Cornell-only and confined to loopback development. Optional personal Gmail connectors require an existing Cornell session and cannot create or replace the login identity.

**Telegram:** revoke the token previously pasted in conversation. Store its replacement in `TELEGRAM_BOT_TOKEN` privately; never paste it into chat or source code. Set `TELEGRAM_BOT_USERNAME=dabas_class_bot`. A shared poller maps private chat IDs to students. Commands include `/today`, `/week`, `/pause`, and `/resume`. Other questions enter the model queue; replies are sent by the independent notification worker. Telegram processes messages transmitted through its service.

**Slack:** configure `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and the Cornell workspace ID in `SLACK_ALLOWED_TEAM_IDS`. Register `/auth/slack/callback` at the same authorized app origin. User scopes are `channels:read`, `channels:history`, `groups:read`, and `groups:history`; workspace approval may be required. Product Studio channel: `C0BSGSNHM5J`. After the initial import, new selected announcements enqueue Telegram notifications when linked and unpaused. Reads are paged with a 24-hour overlap for recent edits; partial history stays marked incomplete. Older edits may require manual review. Slack rotating tokens currently require reconnect at expiry; automatic rotation refresh is not implemented.

**CampusGroups:** automatic authenticated monitoring is not connected. Import a non-recurring timed `.ics` export or enter an event. The app does not collect Cornell passwords and importing does not register for events.

**Careers:** students search with target roles, location, and their resume. The starter catalog covers eight named employers through public Greenhouse/Ashby feeds; provider names and board slugs are optional Advanced inputs. Registered sources refresh approximately every six hours. Matching uses titles, resume skills, location, and a reviewable full-time experience estimate. Drafts use only the student's resume and supplied employer information. **Employer submission is still a labeled local sandbox.** No sandbox receipt means an employer received an application.

## Dates, delivery, and reliability

Default class/event reminders run 10 minutes before start; assignments/quizzes/exams use 24-hour and 4-hour reminders. Each student can change these in Connections or with `/reminders classes 15m`, `/reminders deadlines 1d 2h`, and `/reminders events off`. `/reminders` shows settings and `/reminders reset` restores defaults. Up to five offsets per category (1 minute–28 days) apply to Telegram, synced Google alerts, and new ICS exports. Changing preferences does not replay sent alerts. Only reviewed items with confirmed times generate reminders. Missing source coverage is never treated as a clear schedule. The supplied Milestone 5 announcement does not specify a time; Maker Day 3's 5 p.m. time is not copied to it.

Reminders run separately from model generation and use atomic claims. Provider timeouts or crashed transmissions become `needs-review`, with no automatic duplicate send. Late messages display actual remaining time; reminders past the event or more than 30 minutes late become missed. Telegram API acceptance does not establish that a student saw a message.

Source changes reopen review. Confirm a source-removed item's calendar removal, then sync Google to delete its previously created event. Calendar creation after an uncertain provider response is held for operator reconciliation instead of blindly creating another calendar. Do not combine manual ICS import with Google API sync unless duplicates between those methods are acceptable.

The queue persists across web/worker restarts, fences expired worker leases, limits model work globally, and reserves notification capacity. Pure extraction/drafting can retry; uncertain sends do not. Temporary queued payloads/results are eligible for cleanup after 24 hours while the worker runs. The initial model concurrency is one; raising it does not create GPU capacity.

## Privacy and security

Record payloads use AES-256-GCM with student/bucket/record identity bound to authentication tags. PostgreSQL enforces row-level isolation and runtime roles cannot own the tables or bypass RLS. A separate migration owner changes schema. Queue claims use a restricted worker role. Database encryption keys are kept separately from public files.

Security controls include HttpOnly session cookies, Secure cookies under HTTPS, CSRF tokens, exact Host/Origin checks, a restrictive content security policy, bounded uploads, admission limits, safe error responses, private model validation, encrypted connection credentials, and production configuration checks. Containers run nonroot with a read-only filesystem; PostgreSQL and Ollama are not exposed publicly. CI runs dependency auditing, tests, deployment checks, and an image build.

These controls are not a penetration-test certification. A privileged host operator can access processed data; encryption does not remove that trust. Necessary stored data extends beyond the resume and schedule: identity/session state, credentials, preferences, source evidence, drafts, queued work, and delivery metadata. The model receives a fresh student-scoped context each request and has no tool execution privileges.

Deletion permanently closes the pilot identity, revokes sessions, removes active student records and queued jobs, and leaves an opaque tombstone that prevents delayed work from recreating the account. Running work must finish first. Re-enrollment after deletion is not implemented. Provider-held records, original PDFs, database page remnants, and backup retention are separate. A backup retention period and tested restoration procedure must be agreed before real students join.

## Existing local data

The original single-student database is preserved at `data/assistant.sqlite`. It is never assigned automatically to whichever student signs in first. To deliberately migrate the supplied user's data after their identity exists:

```sh
IMPORT_STUDENT_EMAIL=student@cornell.edu node --env-file=.env scripts/import-legacy.mjs
```

The migration copies content, resets event review, pauses reminders, and requires connections to be authorized again. It keeps the original database. `npm run seed` with `IMPORT_STUDENT_EMAIL`, `SYLLABUS_PDF_PATH`, and `RESUME_PDF_PATH` deliberately re-reads privately configured PDFs; it is not a general onboarding command. Store those paths only in your ignored `.env` and load it when invoking the import script. Submission exports require `EXPORT_STUDENT_EMAIL` and read only that existing student's scoped records; they exclude resumes and connector credentials.

## n8n

n8n is optional operator automation, outside the student-facing security boundary. It does not own sign-in, student tokens, shared storage, or reminder execution. The old single-user `/api/automation/tick` endpoint is retired; use the durable worker processes. The old n8n reminder workflow is not part of this deployment. Keep any n8n editor private, and review its license for the intended commercial use before adopting it as a paid product dependency.

## Validation and class deliverables

```sh
npm test
npm run check:deployment
```

PostgreSQL integration tests use a disposable database when `TEST_POSTGRES_ADMIN_URL` is set; they do not modify the pilot database. The original syllabus fixture test skips on machines without that private PDF. Test data is synthetic, and ordinary tests do not contact Telegram, Google, or Slack.

- `output/capacity-test.json`: observed PostgreSQL orchestration, crash recovery, global concurrency, student context separation, and independent reminder processing under a blocked model. This is not real model throughput or delivery performance.
- `output/model-benchmark.json`, when generated: one real queued local-model request, without personal content in the report.
- `output/video-script.txt`: a recording outline under ten minutes. No video has been recorded.
- `output/evaluation-plan.csv`: pilot evidence to collect. Accuracy/time-saving targets remain unmeasured.
- `/api/evaluation.json`: a student's own exported measurements.
- `/api/operations`: operator-only aggregate capacity and cost estimate; enable operators through `ADMIN_EMAILS`. Cost uses the configured `MONTHLY_INFRA_COST_USD`, not provider billing.

[Capacity methodology and economics](deploy/CAPACITY.md) explains how to measure the actual hosted workload before adding infrastructure. Standalone Chrome visual and accessibility checks use synthetic fixtures; screenshots and the latest findings are in `output/design-qa/`. The in-app browser tool is unavailable. These visual checks do not verify real provider OAuth or notification delivery. Public deployment, real provider authorization, hosted restore testing, independent extraction evaluation, and actual student time-saving measurements remain launch work.

### Calendar AI starter prompts

Approved assignments, Product Studio deliverables, quizzes, and exams include a source-backed, copyable AI starter prompt in Google Calendar descriptions and new ICS exports. Presentations request slide content and speaker scripts; quizzes/exams request practice questions; other assignments request a checklist and draft. Missing requirements remain explicit. ChatGPT and Claude links open plain homepages without transmitting document content or credentials. Existing calendar entries receive this format on their next sync; exported ICS files must be downloaded again.

### Resume feedback and guided application answers

Career Studio separates **Find jobs**, **Saved**, **Applications**, and **Resume & profile**. Search and source controls sit beside a compact results list and a selected job's details; on mobile, a Back to jobs action returns to the list. Browsing filters cover title/company/skill text, location, posting date, company, published workplace and employment type, salary availability, and the existing experience comparison. Filters apply to postings already in the student's workspace. Searching configured employers remains a separate durable discovery action; UI result counts do not claim market-wide coverage.

**Save job** bookmarks an owned posting without starting an application. Bookmarks are stored separately from provider data, survive source refreshes, and remain private to the student. Closed saved postings stay identifiable as closed. Known posting dates sort newest first; missing, day-only, or future dates never qualify as recent. Salary and workplace/type filters use published fields, with unknown values kept separate. In particular, Ashby's `isRemote` flag alone cannot distinguish fully remote from hybrid work.

Career Studio accepts a resume PDF, asks the private model for suggested edits and source-backed contact facts, and keeps those suggestions separate from the student-entered application profile. Work authorization, sponsorship, veteran status, and availability must be explicitly supplied by the student. These saved declarations are not passed to the drafting model. Custom questions support either a guided AI draft or a student-written answer; only reviewed answers enter the downloadable application packet.

**Review your resume** uses the supplied **2026–2027 JCT MBA resume template**, captured in `resources/jct-mba-resume-template.json` with its source hash and explicit/observed rule provenance. The reference shows Calibri 12 pt, US Letter, centered bold headings, and Education → optional Technical Proficiency → Professional Experience → Projects → Additional Information. The file's font/margin settings and stored one-page metadata are observations, not asserted current Cornell mandates. The Quick Look preview was not a faithful Word render; the resource records that limitation and does not claim a verified rendered page count.

Reviews separate **format checks** from **writing edits**. Local Poppler tools estimate the uploaded PDF's page count/size, font runs, and text bounds. Text bounds do not establish the original Word margin settings or visual quality; headings, date alignment, indentation, and spacing still need visual review. Missing tools, unavailable original PDFs, scanned pages, or bounded processing failures leave a usable text review with explicit limitations. Temporary PDF inspection files are private and removed after processing; measurements do not go to an external service.

The private model proposes concise action-oriented rewrites while preserving the student's role, scope, and stated results. Each edit shows the exact original excerpt, proposed wording, purpose, and questions for missing facts. Unmatched excerpts, unsupported numeric claims, unfilled metric placeholders, and sensitive declarations are omitted from copyable rewrites. Numeric guards cannot verify semantic meaning, ownership, or causality; students must check every proposed claim. AI can select relevant passages for template guidance, but the stored reference supplies the actual format recommendation. Copying one rewrite does not edit the original PDF or application profile. Re-run the review after changing the resume; changed PDF contents invalidate work in progress even when text and timestamps match.

Telegram: `/resume_upload` opens a 15-minute PDF upload window; `/resume_review` requests feedback; `/jobs` lists saved job IDs; `/apply <job ID>` prepares materials and links to the employer. `/answer <job ID> | Why Sony? | optional personal context` starts a question, followed by `/generate` or `/write <your answer>`. `/save_answer <answer ID>` explicitly marks an answer reviewed. `/career_profile` opens the private website profile. `/resume` still resumes reminders.

Employer discovery currently uses public Greenhouse/Ashby postings. Career Ops was examined for its assisted-application workflow; its single-user CLI is not installed or run inside student workers. BRB does not claim to submit live employer applications. Students review materials and submit on the employer’s site; browser autofill/submission requires a tested employer-specific adapter. See `docs/career-ops-assessment.md` for source references and deployment constraints.

Career Studio's **Application tracker** keeps a student-owned history of jobs started through Telegram or Career Studio. Rows include role/title, company, location, experience explicitly mentioned in the posting, when preparation began, the employer link, and preparation/submission status. Missing posting fields remain “Not specified”; experience is never inferred from the student's resume. Job details are retained when the live posting disappears. Search and status filters help find previous entries.

`/apply JOB_ID` adds the job to this tracker while requesting application materials; it does not submit an employer application. `/applications` lists the student's tracked jobs. After submitting on the employer's site, `/applied JOB_ID` or the tracker's **I submitted this** action records **Submitted (student-reported)**. This is a personal record, not independently confirmed delivery to an employer. Correcting that status updates BRB only; it does not withdraw anything from the employer. A delayed drafting job cannot erase a student's reported submission.

Existing application drafts are included when available. Prior Telegram origin is shown only when explicit application metadata or retained draft-job metadata establishes it; otherwise the entry is labeled as a previous draft. Old queue history may have expired, so historical channel attribution can be incomplete. A local sandbox receipt never counts as a real submitted application. Tracker history persists in the student's encrypted workspace until account deletion, separately from temporary processing jobs.

### Optional demographic preferences

The linked private Telegram chat offers demographic setup once during career onboarding. `/demographics` opens one overview of all six optional topics, with readable buttons for individual questions, remaining questions, and stopping. Choice buttons keep internal tokens out of the instructions. Race supports multiple selections followed by Done. Exact answer labels (including a numbered label such as `2. Not a veteran`) are handled deterministically while the matching question is active. Other questionnaire text stays out of AI and other conversation flows. Legacy tokenized commands remain compatible with older messages.

**Fill all at once** opens the signed-in `/#demographics` page in Career Studio's Resume & profile tab. It shows the six questions together, supports explicit consent and one save, and loads private choices only when needed. Stale form revisions cannot replace newer Telegram answers. Work authorization and sponsorship stay in the separate application details form. Skip and Prefer not to answer remain distinct choices.

Veteran and protected-veteran status are separate declarations. Disability status concerns the student's own current/past self-identification; BRB does not request diagnoses. Race, ethnicity, and gender are optional preferences, not assumptions extracted from a resume. Employer labels differ: BRB's questionnaire is not official Form CC-305 or a substitute for an employer's self-identification form. Sources: [DOL voluntary self-identification forms](https://www.dol.gov/agencies/ofccp/self-id-forms), [DOL veteran FAQs](https://www.dol.gov/agencies/ofccp/faqs/vevraa), [EEOC applicant demographic data guidance](https://www.eeoc.gov/foia/eeoc-informal-discussion-letter-100).

Answers and questionnaire progress are encrypted student-owned records. They are not supplied to the model, used for job ranking, or automatically transmitted to employers. Telegram also processes messages and button interactions sent through the bot. Button actions are bound to the student, private chat, connection, and current question, with expiry and replay checks. Newly collected demographic fields are excluded from default application-packet downloads; the pre-existing student-entered veteran profile field retains its existing behavior. Skipped/declined questions stay handled across restarts and chat relinking. Deleting all assistant data removes these active records too; the existing account-deletion flow permanently closes the pilot identity, and Telegram/provider copies and backup retention remain separate.

### Campus calendar, job alerts, and the morning briefing

Campus Events can read a student's selected subscribed Google calendar after a separate optional consent flow. Read access requires `calendar.calendarlist.readonly` and `calendar.events.readonly`; these Google grants cover more than the selected calendar, while BRB enforces selection in code. The write connection remains separate. Choose **Connect calendar reading**, select the subscription, and refresh. Scheduled campus reads run daily at **05:00 America/New_York**, following daylight saving time, with catch-up until 11:00 if the host returns late. Initial assistant-imported snapshots are explicitly labeled until this consent is granted. Manual refresh remains available.

Event cards retain the CampusGroups RSVP link. **Add to my calendar** approves only that event's published time and queues its Google write. Registration remains a separate action on CampusGroups. Timed approved events use the student's event-reminder preference (default ten minutes); missing times and all-day entries cannot silently acquire a reminder time. Hidden source locations remain unknown. Material source changes reopen review and suppress obsolete reminders until checked.

The campus **automatic import** switch is off by default and requires both the selected source's read connection and the student's Google write connection. Once enabled, new timed events from that source are approved and queued for the student's assistant calendar. Changing the source resets this opt-in. Previously added, dismissed, changed, or cancelled events are not automatically reapproved. Imports use stable identifiers, scoped Google jobs, and durable daily scheduling records; they do not register attendees or send invitations. A successful Google read shows the subscription's current copy, not proof that the upstream CampusGroups feed has refreshed.

### Add a personal event through Telegram

Send `/newevent Yo let's study tomorrow night`, or send `/newevent` first and paste the message next. BRB proposes the details it can recognize and asks for missing date, exact time, location and duration. Dates use New York time; vague times remain unanswered. Check relative dates when pasting an older message. The final summary includes a confirmation command; nothing is added until the student confirms it. The resulting event uses the student's reminder settings and queues a Google Calendar update when connected. A queued write is not a confirmed provider write.

Use `/newevent edit title|date|time|location|duration VALUE` to revise a draft and `/newevent cancel` to discard it. Drafts expire after 30 minutes and remain private to the linked student's chat. Repeated confirmation cannot create a second event. This flow creates a personal calendar entry, not an invitation to the person named in the message.

Connected Greenhouse/Ashby employer boards refresh every six hours, with earlier refresh after changed matching inputs and 15-minute backlog processing. Matching is a bounded title/resume-skill/location heuristic, not exhaustive semantic matching or a probability of qualification. Newly found matches create durable, deduplicated Telegram alerts with source details and `/apply` preparation instructions. Failed reads, partial/capped results, alert backlog, and stale sources remain visible. A within-24-hours target depends on configured sources, host uptime, provider availability and the bounded result limits; it is not a guarantee of finding every relevant posting online. No employer boards are silently configured for a student.

Clicking **Find matching jobs** with no source fields searches the vetted starter catalog (Figma, Stripe, Datadog, Duolingo, Notion, Ramp, Linear, Ashby) and that student's previously configured sources, up to 20 sources. The catalog is a bounded starting set, not a whole-web job search. Only public provider GET requests are made; resumes and preferences are never sent to those feeds. Source choices are registered when their discovery task runs. Job fetching runs under `WORKER_ROLE=discovery`, independently of `model` and `reminders`; all three worker roles must run for the pilot.

Resume uploads queue a private Ollama employment analysis. Exact source passages support each role and date range. Full-time work is counted only when explicitly stated or confirmed by the student; internships/co-ops, part-time work, volunteer work, study, and projects are excluded. Contract roles require student confirmation as full-time to count. Unknown employment types and year-only dates remain review items. The estimate unions inclusive calendar months, so overlapping positions and promotions count once; it is not an exact day-level employment duration. New uploads invalidate old estimates and corrections remain attached to their source version.

Students choose a maximum **two- or three-year stretch** above their estimated full-time experience (default three). Explicit required experience is compared with that estimate; preferred years, ambiguous alternative qualification routes, and unresolved resume history do not create hard exclusions. Specialized experience remains a separate posting requirement that total years cannot prove. Cards show the source excerpt and label the comparison within range, stretch, or unknown. Quoted impact, promotion, leadership, and skill overlap can support reviewing a stretch role; BRB does not invent a percentage of requirements met or an employer's willingness to waive qualifications. Changed preferences and confirmations re-score saved jobs and invalidate obsolete queued job alerts, while application tracking remains intact.

Job recommendations sent through Telegram now require an explicit provider publication timestamp with a time zone. They are grouped into the last 24 hours and the remaining 1–7 days, newest first. BRB never substitutes first-seen, fetch, or update time for publication time. Unknown dates, date-only values, future timestamps, and postings older than seven days are excluded from recommendation messages. Older/undated postings remain available through Career Studio's All dates/Unknown date filters; bookmarks have their own Saved tab and historical application records remain accessible.

Board refreshes enqueue a lower-priority `job-alerts` discovery task with a 30-second delay. It sorts all currently fetched matching sources together, sends up to ten previously unalerted jobs per batch, and schedules remaining recent matches after 15 minutes. A student-wide lease and durable outbox prevent duplicate chunks. This orders currently available results, not future or unvisited sources. Publication windows and student ownership are checked again immediately before Telegram delivery; a queued message that becomes stale is suppressed. Daily briefings use the same publication rules. `/jobs 24h` and `/jobs week` provide explicit lists; `/apply JOB_ID` prepares materials, `/answer JOB_ID | question | optional guidance` starts an answer, and `/generate` or `/write` selects AI-assisted or student-written text. Employer submission still requires the employer's supported application route; the bot does not claim submission.

**Optional LinkedIn warm leads:** Career Studio accepts a student's own UTF-8 `Connections.csv` (up to 8 MB and 30,000 rows). It stores only normalized names, company/title, validated profile URL, and connection date in the student's encrypted records. Raw CSV, filenames, and email columns are discarded; contacts are not supplied to a model or sent to public job feeds. Exact company-name matching (with common legal suffix normalization) suggests possible contacts, not confirmed current employment, relationship strength, or a referral. A per-job lookup or `/leads JOB_ID` is explicit; no outreach is sent. Telegram queues hold only job/source IDs and resolve contacts at delivery, so deleting/replacing an export prevents stale contact delivery. Upload age is shown separately from any claim about when the export was created.

Refresh reminders default off. Students may select biweekly (14 days), monthly (30 days), or quarterly (90 days). Existing weekly settings are preserved until changed. These are elapsed-day intervals from the upload, not calendar-month anniversaries. Delivery also requires Jobs alerts, a linked Telegram chat, an unpaused account, and the master notification switch. Reminders are checked approximately every 15 minutes and are sent at most once per selected period while an export is due. Changing the interval or replacing/deleting the export invalidates queued reminders. A reminder asks the student to download and upload a new export; it does not perform a LinkedIn login or automatic download. Account deletion removes the active records; Telegram copies and hosting backups follow their existing separate retention behavior.

LinkedIn's [export instructions](https://www.linkedin.com/help/recruiter/answer/a566336) may direct students to request the larger archive and extract `Connections.csv`. Automated contact downloads through a login bot conflict with LinkedIn's [published automation rules](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions); the [Connections API requires approved developer access](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/connections-api). An approved OAuth integration would need separate provider access before scheduling automatic synchronization. Similarly, [Greenhouse application submission requires authenticated employer API access](https://docs.greenhouse.io/job-board); reading public job feeds does not grant that permission.

Morning Telegram briefings default to 08:00 America/New_York and include only the student's selected topics: today's classes and due work, campus events, recent matching jobs, and optional cached newsletter summaries. Schedule items omit descriptions and include times, locations and source/application links where available. Available campus events are labeled separately from events added to the student's calendar. Review-pending dates and source gaps stay visible for selected topics. Delivery is once per local day, honors pause/off settings, and catches up at most two hours late. A sleeping/offline founder laptop cannot deliver alerts.

Use `/briefing 07:30`, `/briefing off`, `/briefing on`, `/schedule` (today on demand), and `/coverage` (connected-source freshness). The same controls and a text-only preview are in Connections. Unknown Telegram delivery outcomes are held for review, not automatically resent.

### Telegram topic preferences

**Connections → Telegram preferences** separates **School**, **Events**, **Jobs**, **News**, and **Games**. Each topic can be off, in the morning briefing only, in additional alerts only, or both. School covers classes, deadlines, academic dates, and Product Studio updates; Events covers campus, social, and personal calendar reminders. Reminder timing remains separately editable. These switches control Telegram delivery, not Google Calendar popups, source monitoring, or web content.

New student accounts start with every topic off. Existing students retain their previously enabled school/event/job notifications; News and Games remain off until chosen. A master switch pauses proactive Telegram messages while preserving choices. Explicit command replies and requested previews still work. Games settings are saveable for a future release; **no daily game, game delivery, or leaderboard is implemented**.

Use `/notifications` to see choices, `/notifications school both`, `/notifications jobs daily`, `/notifications news daily`, `/notifications events alerts`, or `/notifications games off`. `/notifications off` pauses proactive messages; `/notifications on` restores saved modes. `/briefing off` affects the morning briefing only. Pending reminders and queued alerts recheck current preferences immediately before sending; muted due reminders are suppressed without later catch-up spam. Legacy queued job and Slack alerts also honor the new settings. Changes cannot recall messages already sent to Telegram.

### Private newsletter summaries

**News** supports [WSJ's The 10-Point](https://www.wsj.com/preference-center/newsletters) and [PitchBook's The Daily Pitch](https://pitchbook.com/subscribe) through editions delivered to each student's own mailbox. Each student subscribes with their own publisher account. BRB does not request publisher passwords, scrape authenticated article pages, or pool subscriber content across students.

1. In News, choose WSJ's The 10-Point, PitchBook's The Daily Pitch, or both, then choose **Find my newsletters**. Connect a Google mailbox first if needed. This authorizes automatic newsletter processing, independently of Telegram delivery. No Gmail label or filter is required.
2. Automatic discovery searches recent email from the selected publishers and checks message metadata before reading matching newsletter bodies. A missing edition stays visibly missing; a PitchBook saved-search alert is not treated as The Daily Pitch. Advanced options retain custom-label monitoring and pasted text/`.eml` imports. A news label must differ from an active Events email label. Manual Outlook email imports work; direct Outlook connection is not implemented.
3. In Connections, enable News in the morning briefing, additional alerts, or both. The morning time remains **08:00 America/New_York** unless changed.

The optional Gmail grant is shared with private email Events; news discovery and event-label settings remain separate. The Gmail API and `gmail.readonly` consent setup described above still applies. Google grants mailbox-wide read access; BRB enforces publisher filters or the chosen custom label in code. Stopping News monitoring preserves the Events connection. A changed mailbox requires enabling newsletter monitoring again for that account.

While online, the worker checks opted-in newsletters about every 15 minutes. Automatic mode searches the past 30 days, checks bounded metadata results, and reads at most the newest matching body for each selected publisher (two bodies total). Already processed editions are skipped without working backward through old editions. Advanced label mode scans up to 100 recent message IDs, reads at most six new bodies, and summarizes at most two newsletters per refresh. Incomplete scans are visible. The morning briefing reads saved summaries without waiting for AI generation. An edition arriving after the briefing appears in a later briefing, or in a separate alert if enabled. No particular publisher delivery time is guaranteed.

Summaries use at most three original paraphrased bullets and 100 words per newsletter, with supported direct article links when present. Tracking redirects, remote images, attachments, and linked articles are not fetched. Unsupported items are omitted; a summary can remain useful without direct links and tells the student to open the original newsletter. Sender-domain matching is metadata, not authenticated reporting. Received dates, unverified imported email dates, undated excerpts, and stale caches remain distinct. Undated or known-old manual imports do not generate fresh-news alerts.

Full newsletter bodies and supporting excerpts are not stored as permanent records; only private summaries, small metadata, and evidence hashes are retained. Manual import content remains temporarily in the encrypted expiring queue. Active summaries and import markers have a 30-day retention window and a 300-record cap, with daily worker cleanup even after monitoring stops; offline cleanup resumes when the worker returns. Existing backup expiry and Telegram's copies are separate. Opting out of a topic or publisher blocks its queued delivery, and deleting the student's account removes its active private records.

### Partiful events

In **Campus Events → Partiful**, connect calendar reading and select your own Partiful Google Calendar subscription. If it is missing, follow [Partiful's desktop subscription instructions](https://help.partiful.com/en-us/articles/15525660-sync-to-google-calendar) first. Keep the private subscription URL private; BRB uses the authenticated Google calendar ID rather than requesting that URL or a Partiful password. This shares the optional Google read grant used for campus calendars, while the selected sources and event records remain separate and student-owned. Google grants access across readable calendars; BRB limits event reads to the selected sources in code.

Enable **automatic import** to approve newly discovered timed events from this selected subscription, or add events individually. Imports create copies in BRB's Google calendar, so the original subscribed calendar still displays its originals. Imported events use the student's event reminder preference (default ten minutes) and appear in the daily briefing. All-day or incomplete events need a confirmed time. Changed or cancelled source events reopen review and stop obsolete reminders; existing Google copies are not silently deleted. Automatic import does not RSVP or infer attendance from calendar membership.

`/partiful` lists upcoming entries. `/partiful add EVENT_ID` adds a specific event; `/partiful going EVENT_ID`, `/partiful maybe EVENT_ID`, and `/partiful decline EVENT_ID` save a BRB planning choice and provide the event's Partiful link. **The choice is not a submitted RSVP.** Complete or change the actual RSVP on Partiful, which [documents phone verification](https://help.partiful.com/en-us/articles/15525505-how-do-i-rsvp-to-an-event-on-partiful). BRB does not use undocumented RSVP endpoints, collect verification codes, or claim provider confirmation.

BRB checks the selected Google subscription about every fifteen minutes while its host is online. Partiful documents roughly **24 hours** for Google subscription updates; a successful BRB read cannot prove that the upstream feed is current. Only events exposed through that student's subscription are covered. Disconnecting Partiful stops its refresh and automatic imports while retaining the snapshot and shared campus read connection.

### One event agenda

**Events** combines selected CampusGroups, Partiful, and Luma calendars, private email event drafts, personal plans, and the Cornell University Registrar calendar. Search and filter by date, category, or source. Matching registration URLs at the same time, or exact title/time/location matches, share one card with source attribution. Conflicting times remain separate for review. This groups the discovery view and morning briefing; it does not delete existing copies in external calendars. Source connection controls live under **Manage event sources**.

A mini month calendar below the source status buttons shows daily counts from those same loaded events, with a selected-day preview and a shortcut to its full agenda. Source, category, and search filters apply; the agenda's date-range buttons do not hide other dates in the month. Cancelled, dismissed, declined, and undated entries are omitted. Holiday spans and timed overnight events use New York day boundaries and exclusive end dates. Browsing dates does not add events or register attendance. Arrow keys move by day/week; Page Up/Down changes months; Today returns to the current New York date.

The checked-in public Registrar snapshot contains all 95 published entries for **2026–2027**, including every listed holiday/break and the enrollment, term, exam, study-day, and ceremony dates. Public source: [Cornell Registrar](https://registrar.cornell.edu/calendars-exams/academic-calendar/2026-2027). A daily worker refresh preserves previous dates on incomplete or failed responses, and source changes reopen review for previously added items. This version pins the academic year rather than silently switching a student's calendar when the Registrar's current-year page changes. The official [Cornell Tech calendar](https://studentaffairs.tech.cornell.edu/academics/academic-calendar/) remains relevant for program-specific activities. No class is automatically cancelled based on a university holiday.

Registrar entries are available in the agenda without writing to Google. Students explicitly select dates to add. All-day dates and breaks remain all-day, with exclusive end dates in Google/iCal, and do not trigger a midnight or ten-minute Telegram reminder. Relevant dates appear in the morning briefing. A published opening/deadline with no duration uses a clearly labeled one-minute calendar marker.

### Private email event discovery

Students can paste an event email or import an `.eml` file from Cornell, CampusGroups, Gmail, or Outlook. The private model extracts review candidates, preserving supporting excerpts. Emails do not grant tool permissions or approve calendar writes. Original message text is processed in memory (and, for manual imports, the encrypted expiring job payload), not stored as a permanent inbox copy. No remote images or attachments are fetched.

Optional **Connect Gmail** links one Cornell or personal Google mailbox to the existing Cornell student session. It does not change the student's BRB identity. **Use Luma/Partiful invitation emails** opens an opt-in form: select either provider or both, choose review-first or automatic additions, and explicitly enable monitoring. BRB searches the newest 30 days for selected provider senders/links, reads at most 50 IDs per provider and three new message bodies per refresh, preserves direct embedded RSVP links, and checks bounded public event pages. It never logs into Luma or Partiful. Tracking links and private pages are not followed; uncertain or missing dates remain in review. The model may extract email details for review but cannot authorize a calendar addition.

Automatic additions require a connected Google Calendar and complete future start/end times, timezone, location, URL attribution, and scheduled status in the public page's structured event record. Existing canonical event URLs are reused; changed details reopen review. An active calendar subscription for the same provider holds email auto-add for review to avoid competing imports. Calendar descriptions retain the registration link; adding an event never registers attendance or buys tickets. **Stop invitation monitoring** revokes event searches without disconnecting the shared Gmail grant used by News.

For other invitations, choose a custom Gmail label such as `BRB Events`; Gmail filters can place relevant CampusGroups/Cornell newsletters under that label. Selecting a label replaces provider invitation monitoring. **The Google `gmail.readonly` permission itself is mailbox-wide**; provider and label filters are enforced by BRB, not by Google permissions. A separate Outlook account connection and multiple simultaneous Gmail mailboxes are not implemented; Outlook and other mailboxes work through paste/`.eml` import.

For the pilot operator: enable the Gmail API in the existing Google Cloud project, add `https://www.googleapis.com/auth/gmail.readonly` under Google Auth Platform → Data Access, and add any personal Gmail account used for testing under Audience → Test users. The existing OAuth callback is reused. Each student must separately consent and select invitation providers or a label. Cornell administrators may restrict consent. For a public rollout, consult [Google's Gmail scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes); Gmail read access is a restricted scope and production verification requirements apply.

Email refresh runs every 15 minutes while the host and workers are available, on the model queue so extraction does not block reminder delivery. Scans are bounded to recent messages; the connector reports partial coverage/backlog instead of promising complete inbox coverage. Disconnect stops new reads. Inbox metadata is bounded/expired; extracted event evidence remains in the student's encrypted workspace until deleted with their data. No email is sent by this connector.

### Luma events

In **Events → Your Luma events**, connect Google calendar reading and select a Luma subscription already added to your Google Calendar. [Luma's iCal instructions](https://help.luma.com/p/ical-syncing) cover personal events through **Luma Settings → Calendar Syncing → Add iCal Subscription**, as well as subscriptions from a community calendar or city Discover page. BRB reads only the selected subscription in code using the existing shared Google read grant. It does not request a Luma password or private iCal URL.

Add individual timed events or explicitly enable automatic import. This creates copies in BRB's assistant Google calendar; the original subscribed calendar remains visible. Imported events use your event reminder preferences (ten minutes by default) and join the morning briefing (08:00 New York by default). BRB polls Google roughly every fifteen minutes while online; Luma documents an upstream Google subscription delay of **12–24 hours**. All-day or incomplete entries stay visible but require confirmed timing before import. Changed or cancelled previously added events require review. The Luma, Partiful, and campus selections remain separate; disconnecting Luma retains its snapshot and the shared Google read grant.

Telegram supports `/luma`, `/luma add EVENT_ID`, and `/luma going|maybe|decline EVENT_ID`. These attendance preferences are local BRB plans. Adding an event does not register, buy a ticket, confirm admission, or move someone off a waitlist. Personal Luma subscriptions can include pending and waitlisted registrations; community/city feeds can include events the student has not registered for. Complete registration on the original Luma event page. A local decline stops BRB reminders while preserving an existing Google Calendar copy and the actual Luma registration.

### Sharing events with friends

Campus, Partiful, and Luma cards offer **Share event**. Preview the invitation and choose **Copy invitation** to share it yourself. The invitation contains only the displayed event title, timing, location, an optional personal note, and a safe registration link when available. It excludes source excerpts, account information, attendance preferences, Google Calendar event identifiers, and private subscription URLs. Opening the preview does not publish a post or send a message. This first social feature is manual event sharing; there is no student directory, public attendance list, or community feed.

## Private invitation sheet

An optional owner-authorized Google Sheet can replace the static pilot invitation list without app restarts. Configure the sheet and complete read-only Google consent in Connections → Pilot invitations. See [setup, revocations, and outage behavior](docs/pilot-sheet.md).
