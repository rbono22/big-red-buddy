# Working on Big Red Buddy

Accept the private repository invitation while signed in to your GitHub account. Collaborators with write access can clone the code and push branches. Repository access is separate from BRB pilot access and does not provide production credentials, student records, or deployment access.

## Start a separate development checkout

Install Git and Node.js **24 or newer**. Copy the repository's HTTPS or SSH URL from GitHub's **Code** menu:

```sh
git clone <private-repository-url> brb-dev
cd brb-dev
npm ci --ignore-scripts
cp .env.example .env
```

In this new checkout only, edit `.env` to use these local settings:

```dotenv
NODE_ENV=development
APP_ORIGIN=http://127.0.0.1:4318
HOST=127.0.0.1
PORT=4318
DEV_AUTH_EMAILS=student@cornell.edu
```

`student@cornell.edu` is an explicitly enabled synthetic development identity, not a verified Cornell login. Keep `DATABASE_URL`, `WORKER_DATABASE_URL`, Google, Telegram, and Slack credentials empty for this initial setup. Make sure your shell does not export production configuration. With no database URL, local development creates its own encrypted SQLite database and encryption key under ignored `data/`. This adapter is suitable for isolated development; it does not test PostgreSQL row-level security.

Start the website:

```sh
npm run dev
```

Open http://127.0.0.1:4318 and select the development identity. Do not expose this development instance through a public tunnel. Use synthetic documents and sample content; do not copy the pilot's `.env`, `data/`, database backup, OAuth grants, or uploaded student files into your checkout.

The UI can run without a model. To process queued work, run each worker in a separate terminal from the same checkout:

```sh
WORKER_ROLE=model WORKER_HEARTBEAT_PATH=./data/model-heartbeat npm run worker
WORKER_ROLE=reminders WORKER_HEARTBEAT_PATH=./data/reminders-heartbeat npm run worker
WORKER_ROLE=discovery WORKER_HEARTBEAT_PATH=./data/discovery-heartbeat npm run worker
```

AI extraction and drafting require a separately running private Ollama instance. Set `OLLAMA_URL` to its private address and `OLLAMA_MODEL` to a model you have actually installed and tested on your hardware; the example model name alone does not install it. PDF text extraction requires Poppler (`pdftotext`); image/scanned-document OCR uses Tesseract, with Apple Vision fallback on macOS. Dependency and deployment details are in [README.md](README.md) and [deploy/PILOT.md](deploy/PILOT.md).

## Connect your own test services

Use separate development credentials for integration testing. Google sign-in and Calendar require your own OAuth web client, enabled APIs, the matching local callbacks, and the appropriate consent/test-user configuration. Gmail reading is a separate optional consent and requires Gmail API. Each account must explicitly enable the requested monitoring and calendar actions. Use a separate Telegram test bot and a permitted Slack test workspace; never run a second poller against the shared pilot bot.

For PostgreSQL testing or deployment, follow [deploy/PILOT.md](deploy/PILOT.md) and the migrations. The application requires separate nonprivileged runtime roles, forced row-level security, and an operator-managed migration role. Do not point development workers or tests at the pilot database. `npm run seed` is an operator-only private document import, not a prerequisite for a fresh checkout.

## Check a change

```sh
npm test
npm run check:deployment
```

Tests include synthetic students, temporary databases, mocked providers, and local HTTP servers. They do not require live student credentials. PostgreSQL integration coverage requires `TEST_POSTGRES_ADMIN_URL` pointing to a **disposable test server** with permission to create test databases and roles. That test creates and removes its own databases and roles. Private-document and PostgreSQL checks may be skipped when their prerequisites are absent; report the skips instead of treating them as verified. Deployment checks without Docker validate only source/configuration; they do not prove a host is ready.

For a focused change, run the relevant test file with `node --test path/to/test.test.mjs`, then the full suite before opening a pull request. Check the affected UI on desktop and mobile. When changing ownership, permissions, queues, or connectors, include cross-student, revoked-consent, duplicate/retry, and failure cases as appropriate.

## Share changes

```sh
git switch -c feature/short-description
git add <changed-source-files>
git diff --cached
git commit -m "Describe the behavior changed"
git push -u origin feature/short-description
```

Open a pull request targeting `main`. Describe the problem, resulting behavior, tests run, and any remaining limitations. Prefer review before merging. GitHub's checks run tests, dependency auditing, deployment validation, and an image build; pushing code does not deploy it to the pilot. The operator applies an approved release separately.

Review every staged file, even in a private repository. Keep real `.env` files, secrets, keys, local databases, uploads, resumes, email content, personal screenshots, and generated private exports out of commits and issue/PR attachments. Use redacted or synthetic evidence when reporting a bug. Preserve student ownership checks and explicit connector consent. Never change a label to claim an employer application or RSVP was submitted unless the external service actually confirmed that action.
