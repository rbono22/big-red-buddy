# Workable application adapter

The initial browser adapter supports Valsoft Corporation jobs on `https://apply.workable.com/valsoft-corp/j/<10-character uppercase job code>/apply/`. Other Workable employers are not enabled until their forms and destinations are verified. `APPLICATION_BROWSER_ENABLED=true` is required.

Observed public example on November 12, 2026: [Commercial Lead — Sales & Partnerships](https://apply.workable.com/valsoft-corp/j/4560CF5DD0/apply/). The application has ten fields: first and last name, email, phone, address, salary expectations, resume, two written questions, and a work-authorization question. Employer-specific answers and consent are never inferred by this adapter. Phone numbers must include their international dialing prefix.

The adapter reads the actual rendered form, compares the reviewed fingerprint before submitting, and rejects unfamiliar controls. It fills only reviewed answers, leaves skipped optional uploads alone, waits for both the upload response and completed upload widget, then checks all answers again. The caller's `beforeSubmit` gate runs immediately before one final click. An explicit Workable success component on the same job URL is required to record success; a click, upload, or HTTP 200 is insufficient. Unconfirmed results must not be retried automatically.

Each run uses a fresh sandboxed Chrome context with service workers, WebSockets and downloads disabled. Network destinations are a fixed list of observed Workable assets plus Cloudflare's challenge host. The public upload-policy metadata identified `workable-application-form.s3.us-east-1.amazonaws.com` as the resume destination. Unknown upload hosts and visible human-verification challenges stop the flow.

## Validation and limits

- `node --test tests/workable-browser.test.mjs`: seven parser, URL, allowlist, unsupported-control and fingerprint tests.
- `node scripts/verify-workable-browser.mjs`: thirteen offline browser checks; external network requests are blocked. Includes delayed upload/autofill, optional upload skip, changed destinations, refusal before final click, disabled submit and missing receipt.
- `node scripts/inspect-workable-public.mjs`: read-only current public-form inspection.
- `node scripts/inspect-workable-public.mjs --mock-upload`: synthetic file-selection inspection, with the upload POST intercepted and answered locally. No resume bytes or application are transmitted to Workable or the employer. Used to observe the completion widget and its stable field labels.

No real employer application has been submitted to validate this adapter. CAPTCHA, a changed form, a different destination, complex education/work-history editors, and new employer-specific controls require manual completion or further adapter work. A job may add additional optional EEO questions after application submission; this adapter does not silently answer them.

## Official API research

Workable's [candidate-creation API](https://workable.readme.io/reference/job-candidates-create) requires an account token with the `w_candidates` scope; it is not a universal applicant-owned submission credential. The browser adapter uses the public candidate flow instead.

SmartRecruiters' [Application API](https://developers.smartrecruiters.com/docs/application-api) protects all endpoints and requires `candidate_applications_manage` for OAuth. Its [authentication guide](https://developers.smartrecruiters.com/docs/authentication) distinguishes public Posting API reads from customer/partner credentials. SmartRecruiters has not been enabled here without those credentials or a separately verified public browser adapter.
