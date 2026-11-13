# Greenhouse hosted-form adapter

Observed read-only on November 12, 2026:

- https://job-boards.greenhouse.io/reddit/jobs/8023563 — Senior Business Analyst, Revenue Analytics. The production adapter reads 23 fields, including required legal/demographic consent, three multiple-choice demographic controls, a resume attachment and a text alternative for the cover letter.
- Country choices use a React dropdown; the chosen value displays a flag and calling code only. The adapter compares both the observed flag and calling code to the reviewed option, distinguishing countries that share a code.
- City suggestions require typing and opening the menu with ArrowDown. The hosted form requests `api-geocode-earth-proxy.greenhouse.io`; only exact visible suggestions are accepted.
- Greenhouse's official Job Board API documentation (https://docs.greenhouse.io/job-board.html#authentication) states that public GETs require no authentication, but application POSTs require an employer Job Board API key. This adapter uses the public hosted browser form. It does not request or extract employer API credentials.

The synthetic HTML fixture models observed public control structure without employer copy or student data. `node scripts/verify-greenhouse-browser.mjs` tests filling, optional skips, exact choices, multiple choices, country identity, file upload, post-upload autofill/conditional changes, URL binding, CAPTCHA, revoked authorization, one final click, and success versus missing/false receipts. Network is blocked; the only document navigation is fulfilled from the in-memory fixture.

`node --test tests/greenhouse-browser.test.mjs` verifies URL/resource restrictions, complete control enumeration, reviewed answers, explicit consent, supported types, and form fingerprints without launching a browser.

Supported: modern `#application-form` pages on exact `job-boards.greenhouse.io`/legacy `boards.greenhouse.io` URLs; contact/text fields, native select/radio/checkbox controls, observed React select/multi-select and city controls, PDF resume, cover-letter textarea. Forms are bounded to 60 fields, 300 options per choice, a 12 MB PDF and a 150-second browser lifetime.

Unsupported controls, additional attachment-only fields, custom/legacy layouts, changed questions, unrecognized defaults, visible human verification and redirects leave submission with the user. Every demographic and legal answer must be reviewed; no sensitive attributes are inferred. A submission attempt cannot automatically retry. Receipt acceptance requires a visible confirmation heading with the application form gone and the exact same employer/job URL. Custom confirmation redirects are deliberately unconfirmed until explicitly supported.

No live employer application or resume upload was performed during implementation. Public live-form inspection and offline success fixtures do not establish that a particular employer accepted a real application.
