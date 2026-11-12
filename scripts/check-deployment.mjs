import { readFileSync, existsSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { privateModelURL, CORNELL_EMAIL_DOMAIN, isCornellEmail } from '../lib/security.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const configFile = path.join(root, 'deploy', production ? 'pilot.env' : 'pilot.env.example');
const failures = [];
const checks = [];
function check(condition, label) { (condition ? checks : failures).push(label); }
function source(name) { return readFileSync(path.join(root, name), 'utf8'); }

if (!existsSync(configFile)) {
  console.error('Missing deploy/pilot.env; copy deploy/pilot.env.example and configure the pilot.');
  process.exit(1);
}
const config = parseEnv(readFileSync(configFile, 'utf8'));
const composeSource = source('compose.pilot.yml');
const dockerfile = source('Dockerfile');
check(dockerfile.includes('USER node'), 'Application image runs as nonroot');
check(!dockerfile.includes('COPY . '), 'Image copies an explicit application allowlist');
check(source('.dockerignore').startsWith('**\n'), 'Build context denies private files by default');
check(composeSource.includes('internal: true'), 'Database network is internal');
check(['model','reminders','discovery'].every(role=>composeSource.includes(`WORKER_ROLE: ${role}`)), 'Model, reminders and job discovery run in separate processes');
for(const name of ['job-source-catalog.json','jct-mba-resume-template.json','academic-calendar-2026-2027.json'])check(dockerfile.includes(`resources/${name}`)&&source('.dockerignore').includes(`!resources/${name}`), `${name} is explicitly packaged for runtime`);
check(!/DEV_AUTH_EMAILS|ALLOW_ALL_CORNELL\s*:\s*["']?true/.test(composeSource), 'Production manifest disables development sign-in and requires a pilot allowlist');
check(/^\s*ALLOWED_GOOGLE_DOMAINS:\s*cornell\.edu\s*$/m.test(composeSource) && !/ALLOWED_GOOGLE_DOMAINS:\s*.*\$\{/.test(composeSource), 'Production sign-in domain is fixed to cornell.edu');
const domainList = [...new Set(String(config.ALLOWED_GOOGLE_DOMAINS || CORNELL_EMAIL_DOMAIN).split(',').map(value => value.trim().toLowerCase()).filter(Boolean))];
check(domainList.length === 1 && domainList[0] === CORNELL_EMAIL_DOMAIN, 'Configuration cannot broaden the Cornell sign-in domain');
const pilotMembers = String(config.PILOT_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
check(pilotMembers.length > 0 && pilotMembers.every(isCornellEmail), 'Pilot membership contains only explicit Cornell email addresses');
check(config.ALLOW_ALL_CORNELL !== 'true' && !/ALLOW_ALL_CORNELL\s*:/.test(composeSource), 'Deployment preserves the invited pilot rather than opening all Cornell accounts');
check(/^\s*PILOT_EMAILS:\s*\$\{PILOT_EMAILS:\?[^}\n]+\}\s*$/m.test(composeSource), 'Production manifest requires an explicit pilot allowlist');
check(!/docker\.sock|privileged:\s*true|network_mode:\s*host/.test(composeSource), 'No privileged containers, Docker socket, or host networking');
check(source('deploy/Caddyfile').includes('admin off'), 'Proxy administration API disabled');
check(privateModelURL(config.OLLAMA_URL), 'Configured model address is private');
let origin;
try { origin = new URL(config.APP_ORIGIN); } catch {}
check(origin?.protocol === 'https:' && origin?.host === config.APP_DOMAIN && origin?.pathname === '/', 'HTTPS origin matches the proxy hostname');
for(const name of ['WORKER_CONCURRENCY','REMINDER_CONCURRENCY','DISCOVERY_CONCURRENCY']){const value=Number(config[name]??(name==='REMINDER_CONCURRENCY'?2:1));check(Number.isInteger(value)&&value>=1&&value<=16,`${name} is bounded`);}

if (production) {
  check(!Object.hasOwn(config, 'DEV_AUTH_EMAILS'), 'No development auth configuration');
  check(!!config.PILOT_EMAILS && !config.PILOT_EMAILS.includes('student@cornell.edu'), 'Pilot membership explicitly configured');
  check(!!config.GOOGLE_CLIENT_ID && !config.GOOGLE_CLIENT_ID.includes('replace-with'), 'Google OAuth client configured');
  check(!config.APP_DOMAIN?.includes('example.'), 'Real pilot domain configured');
  for (const key of ['NODE_IMAGE', 'CADDY_IMAGE', 'POSTGRES_IMAGE']) check(/@sha256:[a-f0-9]{64}$/.test(config[key] || ''), `${key} pinned to a tested digest`);
  const secretDir = path.join(root, 'deploy/secrets');
  check(existsSync(secretDir) && (statSync(secretDir).mode & 0o077) === 0, 'Host secret directory is private');
  for (const name of ['postgres_admin_password', 'database_owner_password', 'database_web_password', 'database_worker_password', 'data_encryption_key', 'session_secret', 'google_client_secret']) {
    const file = path.join(secretDir, name);
    const value = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
    check(name === 'google_client_secret' ? value.length >= 10 : /^[a-f0-9]{64}$/.test(value), `${name} secret is present and valid`);
  }
}

const docker = spawnSync('docker', ['compose', '--env-file', configFile, '-f', path.join(root, 'compose.pilot.yml'), 'config', '--format', 'json'], { cwd: root, encoding: 'utf8', timeout: 30000 });
if (docker.error?.code === 'ENOENT') {
  console.log('Docker is unavailable: manifest checks only; Compose rendering, image build, and container startup remain unverified.');
  if (args.has('--require-docker') || production) failures.push('Docker runtime available for deployment validation');
} else if (docker.status !== 0) {
  failures.push('Docker Compose renders successfully (run docker compose config locally for details)');
} else {
  const manifest = JSON.parse(docker.stdout);
  check(true, 'Docker Compose renders successfully');
  for (const name of ['web', 'worker', 'reminders', 'discovery', 'postgres']) {
    const service = manifest.services[name];
    check(!service.ports?.length, `${name} has no published ports`);
    check(service.read_only === true && service.cap_drop?.includes('ALL') && service.security_opt?.includes('no-new-privileges:true'), `${name} container restrictions enabled`);
    check(!!service.mem_limit && !!service.pids_limit, `${name} resource limits enabled`);
    if (name !== 'postgres') {
      check(service.environment?.ALLOWED_GOOGLE_DOMAINS === CORNELL_EMAIL_DOMAIN && !service.environment?.DEV_AUTH_EMAILS && service.environment?.ALLOW_ALL_CORNELL !== 'true', `${name} uses Cornell-only pilot authentication`);
      const renderedPilot = [...new Set(String(service.environment?.PILOT_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean))].sort();
      check(JSON.stringify(renderedPilot) === JSON.stringify([...new Set(pilotMembers)].sort()), `${name} preserves the configured pilot membership`);
    }
  }
  check(manifest.services.web.user === '1000:1000', 'Web container UID explicitly unprivileged');
  check(manifest.services.discovery.environment.WORKER_ROLE === 'discovery' && manifest.services.discovery.user === '1000:1000', 'Discovery runs as an unprivileged dedicated worker');
  const discoverySecrets = manifest.services.discovery.secrets.map(s => s.source);
  check(!discoverySecrets.includes('telegram_bot_token') && !discoverySecrets.includes('slack_client_secret'), 'Discovery has no Telegram or Slack transmission credentials');
  const webSecrets = manifest.services.web.secrets.map(s => s.source);
  check(!webSecrets.includes('database_owner_password') && !webSecrets.includes('database_worker_password') && !webSecrets.includes('postgres_admin_password'), 'Web cannot read privileged database credentials');
}
for (const label of checks) console.log(`PASS ${label}`);
for (const label of failures) console.error(`FAIL ${label}`);
console.log(`${checks.length} passed; ${failures.length} failed. No credential values printed.`);
if (failures.length) process.exitCode = 1;
