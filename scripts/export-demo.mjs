import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openDatabase } from '../lib/database.mjs';
import { createQueue } from '../lib/queue.mjs';
import { studentMetrics } from '../lib/metrics.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const email = String(process.env.EXPORT_STUDENT_EMAIL || '').trim().toLowerCase();
if (!email) throw new Error('Set EXPORT_STUDENT_EMAIL to the existing student whose submission data you intend to export.');
const database = await openDatabase({ dataDir: process.env.ASSISTANT_DATA || path.join(root, 'data') });
let queue;
const csv = value => {
  let text = String(value ?? '');
  // Quoting alone does not stop spreadsheet formula execution in imported CSVs.
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};
const countByStatus = rows => rows.reduce((counts, row) => {
  const key = String(row.status || 'unknown');
  counts[key] = (Object.hasOwn(counts, key) ? counts[key] : 0) + 1;
  return counts;
}, Object.create(null));
try {
  const matches = (await database.auth.all('users')).filter(user => String(user.email || '').toLowerCase() === email);
  const google = matches.filter(user => user.provider === 'google');
  const development = matches.filter(user => user.provider === 'dev');
  const user = google.length === 1 ? google[0] : google.length === 0 && development.length === 1 ? development[0] : null;
  if (!user || await database.isDeleted(user.id)) throw new Error('No unambiguous active identity exists for that email. Sign in as the intended student before exporting.');
  const store = database.forUser(user.id);
  queue = await createQueue(database, { workerDatabaseUrl: null });
  const [allEvents, jobs, applications, sources, metrics, reminders, telegram, googleConnection, slack] = await Promise.all([
    store.all('events'), store.all('jobs'), store.all('applications'), store.all('sources'), store.all('metrics'), store.all('reminders'),
    store.get('secrets', 'telegram'), store.get('secrets', 'google'), store.get('secrets', 'slack'),
  ]);
  const events = allEvents.filter(event => !event.cancelled).sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date));
  const rows = [
    ['title', 'kind', 'date', 'time_New_York', 'start_UTC', 'end_UTC', 'location', 'source', 'page', 'review_status', 'warning'],
    ...events.map(event => [event.title, event.kind, event.date, event.time, event.start, event.end, event.location, event.sourceName, event.page, event.status, event.warning]),
  ];
  const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const slackConfigured = Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
  const report = {
    generatedAt: new Date().toISOString(),
    scope: 'Explicitly selected existing student in the current tenant-scoped database; source fixtures do not establish general extraction accuracy.',
    identity: { provider: user.provider, verifiedGoogleSignIn: user.provider === 'google', selection: 'Explicit EXPORT_STUDENT_EMAIL; prefer one matching Google identity, otherwise one matching local development identity.' },
    storage: database.kind,
    importedCandidates: events.length,
    reviewedCandidates: events.filter(event => event.status === 'approved').length,
    unresolvedTimes: events.filter(event => !event.start).length,
    liveJobsRetrieved: jobs.filter(job => job.status !== 'closed').length,
    localApplicationDrafts: applications.length,
    capacity: await studentMetrics(database, queue, user.id),
    modelRequests: metrics.map(metric => ({ model: metric.model, task: metric.task, at: metric.at, ms: metric.ms, inputTokens: metric.inputTokens, outputTokens: metric.outputTokens })),
    sourceCoverage: sources.map(source => ({ name: source.name, type: source.type, method: source.method, count: source.count, lastImported: source.updatedAt })),
    connectionStatus: {
      googleOAuth: googleConfigured ? 'configured; authorization status listed separately' : 'not configured',
      googleCalendarAuthorized: Boolean(googleConnection?.refresh_token),
      slackOAuth: slackConfigured ? 'configured; authorization status listed separately' : 'not configured',
      slackAuthorized: Boolean(slack?.userToken),
      sharedTelegramBotConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      telegramLinked: Boolean(telegram?.chatId),
      campusgroupsAutomatic: false,
    },
    reminders: countByStatus(reminders),
    deployment: { publicHost: 'not deployed', pilotConfiguration: 'prepared; provider credentials, hosting target, and approved budget are still required' },
    separateEvidence: {
      realModelBenchmark: 'output/model-benchmark.json contains the separately measured queued model request; these exports do not run a model benchmark.',
      syntheticCapacity: 'output/capacity-test.json measures synthetic PostgreSQL orchestration; it is not model throughput or Telegram delivery.',
      visualQA: 'Standalone Chrome checks use synthetic fixtures; see output/design-qa/report.json. The in-app browser tool is unavailable.',
    },
    exclusions: ['Resume contents and files', 'Student email and identity IDs', 'Connector credentials and chat IDs', 'Source document text and private filesystem paths', 'Application answers and chat prompts'],
    limitations: [
      'Local development sign-in is not verified Google authentication.',
      'No broad independent extraction accuracy or student time-saving measurement.',
      'CampusGroups automatic authenticated monitoring is not implemented.',
      'Employer submission is a labeled local sandbox.',
      'Google/Slack authorization and Telegram delivery require operator configuration and student consent.',
      'Visual checks with synthetic fixtures do not verify real provider OAuth or delivery.',
      'Public hosting and the student pilot have not launched.',
      'A video outline exists; no submission video has been recorded.',
    ],
  };
  const output = path.join(root, 'output');
  await mkdir(output, { recursive: true });
  const scheduleFile = path.join(output, 'imported-schedule.csv'), reportFile = path.join(output, 'demo-evaluation.json');
  await writeFile(scheduleFile, `${rows.map(row => row.map(csv).join(',')).join('\n')}\n`, { mode: 0o600 });
  await chmod(scheduleFile, 0o600);
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await chmod(reportFile, 0o600);
  console.log(JSON.stringify({ exported: ['imported-schedule.csv', 'demo-evaluation.json'], storage: database.kind, identityProvider: user.provider, candidates: events.length, resumeAndCredentialsExcluded: true }));
} finally {
  await queue?.close();
  await database.close();
}
