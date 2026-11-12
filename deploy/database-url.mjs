import { readFileSync } from 'node:fs';

const password = readFileSync(process.env.DATABASE_PASSWORD_FILE, 'utf8').trim();
if (!password || !process.env.DATABASE_USER) throw new Error('Missing database credential');
const url = new URL(`postgresql://${process.env.DATABASE_HOST || 'postgres'}:5432/${process.env.DATABASE_NAME || 'dabas'}`);
url.username = process.env.DATABASE_USER;
url.password = password;
// This stream is captured by entrypoint; do not run manually in a shared terminal.
process.stdout.write(url.href);
