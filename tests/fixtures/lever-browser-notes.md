Lever adapter evidence (2026-11-12)

- Official API reference: https://github.com/lever/postings-api#apply-to-a-job-posting. POST requires an employer-issued API key; public postings expose `applyUrl`, but the API does not expose employer custom questions. BRB uses the hosted candidate form, not an unauthenticated API submission.
- Read-only observed form: https://jobs.lever.co/tenna/ed0a2111-ff61-40a8-aed9-23c1081d97dd/apply, Product Manager, 35 fields. `lever-tenna-application.html` is the public title/form markup with scripts, frames and hidden values removed; it contains no applicant answers.
- Observed controls: resume, text, email, structured location, textarea, select, radio. Native checkbox groups/multiple selects are covered by synthetic additions in the offline browser contract.
- Current location must select an exact dropdown result; typed free text is cleared on blur. Resume parsing runs asynchronously and can overwrite blank fields, so every reviewed value (including intentionally skipped optional fields) is rechecked after parsing finishes.
- In-page hCaptcha can require a human after the submit click. BRB does not solve, suppress or bypass it; unsupported resource hosts, challenges, changed forms, conditional/unsupported controls, extra file uploads and unconfirmed receipts stop automation.
- Global `jobs.lever.co` only; EU/custom career domains are not claimed supported. Optional custom pronouns and disability signatures can have conditional controls; concealed applicant controls fail closed.
- This verifies live form reading and offline filling/submission state transitions. No real applicant information was sent and no employer application was submitted. A real employer success receipt has not been observed in this test.

Checks:

    node --test tests/lever-browser.test.mjs
    node scripts/verify-lever-browser.mjs
    node scripts/inspect-lever-public.mjs

The offline script intercepts every request and uses synthetic answers/PDF. It checks exact options, structured location, consent, multi-selection, PDF autofill changes, additional required questions, form changes, authorization cancellation, challenges, one submit click, and receipt-only success.
