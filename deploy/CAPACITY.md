# Capacity and unit economics

No supported student count or production delivery rate has been established. The current pilot runs on the operator’s Mac with separate model, reminder, and discovery workers. An always-on hosting allocation and budget still need a representative workload trial; a planned 4-vCPU/8-GB app VM is a starting allocation to test, not a scalability claim.

A local 10-second, five-lane `/healthz` measurement is saved in `output/http-capacity.json`. It ran on the local Node/PostgreSQL app before the separate SCRAM cluster migration. This narrow loopback read measurement does not include sign-in, document processing, model inference, or notification delivery; it cannot establish hosted capacity. Repeat representative workload measurements on the selected pilot hardware.

## Local observations · November 12, 2026

Synthetic PDF fixtures were parsed three times before and three times after the change on the pilot Mac. These are median **local text extraction** times; they exclude upload, queueing, AI date extraction, student review, and calendar sync.

| Synthetic fixture | Before | After | Observed reduction |
| --- | ---: | ---: | ---: |
| Six searchable pages with small illustrations | 91 ms | 46 ms | 49% |
| Four scanned pages | 1,237 ms | 661 ms | 47% |

Extracted character and deadline-mention counts were unchanged for these fixtures. The parser now inspects images once per PDF and uses at most two single-threaded Tesseract page jobs; Apple Vision stays sequential. This small test does not establish accuracy or speed for arbitrary documents. Local evidence: `output/document-performance/baseline.json` and `improved.json` (operator artifacts, excluded from Git).

A separate **two-call** synthetic short-answer trial used `qwen3.5:9b-q4_K_M`, 130 input tokens and 36 output tokens per call. The first request, with no model loaded, took **4,041 ms**, including **3,073 ms** of model loading. The immediately repeated warm request took **821 ms**, including **5 ms** of loading. Generation itself took 765/773 ms. This illustrates the observed cold-start cost; it is neither a before/after optimization comparison nor an end-to-end response-time or capacity claim. No student content was used. Local evidence: `output/performance/model-synthetic.json`.

Student-scoped `/api/metrics` now includes `model.timing`: loading, prompt-processing, generation, output-token speed, and latency by task profile where the provider supplied those measurements. Use those breakdowns alongside queue delay to identify the next bottleneck; absent measurements remain absent rather than counting as zero.

## What to measure

For each test run save the commit/image digests, hardware and GPU VRAM, model name/digest and quantization, prompt/input sizes, inference concurrency, active synthetic students, timestamp, and whether the model was warm. Keep prompts, resumes, student emails, tokens, and message contents out of shared measurements.

| Measure | Definition | Why it matters |
| --- | --- | --- |
| HTTP p50/p95/p99 | Request start to complete response body | Website responsiveness |
| Queue delay p50/p95 | Job claim time minus enqueue time | Work waiting behind the model |
| Model latency p50/p95 | Inference request start to complete validated response | Hardware/model suitability |
| Queue throughput | Completed jobs per minute, failures/retries separately | Sustainable arrivals |
| Reminder lateness | Provider acceptance time minus scheduled delivery time | The core academic promise |
| Reminder failure/uncertainty | Failed, missed, or unreconciled sends | Delivery gaps hidden by averages |
| Worker freshness | Now minus last heartbeat | A healthy web page is not a healthy worker |
| Monthly cost/active student | Total recurring monthly cost divided by unique active students in a matching period | Hosting economics |
| Cost/useful outcome | Total allocated cost divided by user-accepted useful results | Value after correction/review |

`/api/operations` is restricted to signed-in operator emails. `/api/metrics` is student-scoped. The operational cost field comes from `MONTHLY_INFRA_COST_USD`, not a provider billing API; update it after reviewing invoices. If there are no active students, cost per active student is undefined. Zero configured budget does not mean free hosting. Actual tuition value, saved time, or willingness to pay must be measured separately.

## A repeatable staging trial

1. Use synthetic resumes/syllabi and 2, then 5, then 10 invited test students. Verify cross-student isolation first. Start with `WORKER_CONCURRENCY=1` and one model request at a time.
2. Measure the read path with the provided harness, first `/healthz`, then authenticated `/api/state`. Store a staging session’s cookie in a mode-0600 file, not a command argument or report. This tests one student session per run; use separate runs/fixtures for different students.
3. Through the authenticated application/API, enqueue representative syllabus extraction, Studio message extraction, short chat, and application draft jobs. Use unique job IDs; do not bypass quotas. Record input size and completion/failure, wait time, model time, and accepted/needs-review results. Scheduling only empty jobs would not represent the workload.
4. While model requests are running, schedule synthetic reminders to a controlled test Telegram account. Record provider-accepted lateness and failures. Kill/restart the model worker, interrupt the private model route, and revoke a test provider token; confirm the reminder process remains alive and uncertain sends do not duplicate.
5. Repeat with a cold model and one orderly host restart. Increase offered load until queue delay grows across successive observation windows or a reminder target fails. Stop before impacting production. Report the highest **measured sustainable arrival rate** with the actual workload, not a fictional number of concurrent students.
6. Repeat with concurrency 2 only if GPU memory and observed queue demand justify it. Add model capacity before increasing web replicas if inference is the bottleneck; improve database/query paths if database time is the bottleneck. Higher worker concurrency alone cannot create GPU capacity.

```sh
node scripts/load-test.mjs --url=http://127.0.0.1:4318 --seconds=15 --concurrency=5
node scripts/load-test.mjs --url=https://STAGING_DOMAIN --allow-remote --path=/api/state --cookie-file=/secure/staging-cookie --seconds=30 --concurrency=5 --output=/secure/read-path.json
```

The script performs bounded GETs only and stores status counts, durations, and response-byte totals; it does not store response bodies or credentials. It deliberately refuses arbitrary write endpoints. `/healthz` throughput alone says nothing about model processing, reminder delivery, or student capacity. A 401, 429, timeout, or redirect counts as failure rather than a fast success. Run only against a host you operate and have designated for testing.

## Economics worksheet

Use actual quotes/invoices once the host is selected:

`monthly operating cost = app VM + GPU/model host + database/storage + encrypted backups + network/monitoring + messaging/provider fees`

`cost per active student = monthly operating cost / active students during that month`

`gross margin per student = subscription revenue - operating cost per active student - variable support/payment cost`

Local/open-weight inference removes a per-token model API bill; it still consumes compute, electricity, storage, and operations time. Include one-time build effort and support time separately. Avoid converting monthly budget into per-task accuracy or claiming that an open-weight model prevents Google/Slack/Telegram from processing connector data.

For the class demo, show one observed extraction time, one observed draft time, queue delay under a small burst, reminder acceptance/lateness, a real cost assumption table, and the limits of that evidence. Compare saved coordination time with all setup, review, correction, and source-checking time included. Do not present targets from the proposal as measured outcomes.
