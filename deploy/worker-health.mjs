import { statSync } from 'node:fs';
try {
  if (!['all','model','reminders','discovery'].includes(process.env.WORKER_ROLE || 'all')) throw new Error('Invalid worker role.');
  const age = Date.now() - statSync(process.env.WORKER_HEARTBEAT_PATH || '/tmp/dabas-worker-heartbeat').mtimeMs;
  const maximumAge = Number(process.env.WORKER_HEARTBEAT_MAX_AGE_MS || 120000);
  if (!Number.isFinite(maximumAge) || maximumAge <= 0 || age < -5000 || age > maximumAge) process.exitCode = 1;
} catch { process.exitCode = 1; }
