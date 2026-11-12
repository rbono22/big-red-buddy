import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'secrets');
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const names = ['postgres_admin_password', 'database_owner_password', 'database_web_password', 'database_worker_password', 'data_encryption_key', 'session_secret'];
let created = 0;
for (const name of names) {
  const target = path.join(directory, name);
  if (existsSync(target)) continue;
  // File mounts must be readable by distinct nonroot container UIDs. The parent
  // directory remains 0700; each service sees only its explicitly mounted files.
  writeFileSync(target, `${randomBytes(32).toString('hex')}\n`, { mode: 0o444, flag: 'wx' });
  created++;
}
console.log(`Created ${created} secret files; existing secrets preserved. No values printed.`);
for (const name of ['telegram_bot_token', 'slack_client_secret']) {
  const target = path.join(directory, name);
  if (!existsSync(target)) writeFileSync(target, '', { mode: 0o444, flag: 'wx' });
}
console.log('Create deploy/secrets/google_client_secret from your Google OAuth app before launch; use file mode 0444 and keep the secrets directory 0700.');
