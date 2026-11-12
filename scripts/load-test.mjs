import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const index = arg.indexOf('=');
  return index < 0 ? [arg.slice(2), true] : [arg.slice(2, index), arg.slice(index + 1)];
}));
const base = new URL(options.url || 'http://127.0.0.1:4318');
const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
if (!local && (!options['allow-remote'] || base.protocol !== 'https:')) throw new Error('Remote testing requires an authorized HTTPS staging host and --allow-remote');
const endpoint = options.path || '/healthz';
if (!['/healthz', '/api/state'].includes(endpoint)) throw new Error('Use the read-only /healthz or /api/state endpoint');
const durationSeconds = Number(options.seconds || 15);
const concurrency = Number(options.concurrency || 5);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50 || !Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 120) throw new Error('Allowed range: concurrency 1–50, seconds 1–120');
const cookie = options['cookie-file'] ? readFileSync(options['cookie-file'], 'utf8').trim() : '';
if (endpoint === '/api/state' && !cookie) throw new Error('/api/state requires --cookie-file for a synthetic staging student');
const samples = [];
const statuses = {};
let bytes = 0;
let failures = 0;
const start = performance.now();
const deadline = start + durationSeconds * 1000;
async function lane() {
  while (performance.now() < deadline) {
    const before = performance.now();
    try {
      const response = await fetch(new URL(endpoint, base), { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(10000), redirect: 'error' });
      bytes += (await response.arrayBuffer()).byteLength;
      statuses[response.status] = (statuses[response.status] || 0) + 1;
      if (!response.ok) failures++;
    } catch { failures++; statuses.network_error = (statuses.network_error || 0) + 1; }
    samples.push(performance.now() - before);
  }
}
await Promise.all(Array.from({ length: concurrency }, lane));
const elapsed = (performance.now() - start) / 1000;
samples.sort((a, b) => a - b);
const quantile = p => Math.round((samples[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)] || 0) * 100) / 100;
const report = {
  measuredAt: new Date().toISOString(), endpoint, host: base.host, concurrency,
  elapsedSeconds: Number(elapsed.toFixed(2)), requests: samples.length, failures, statuses,
  throughputRequestsPerSecond: Number((samples.length / elapsed).toFixed(2)),
  latencyMs: { p50: quantile(0.5), p95: quantile(0.95), p99: quantile(0.99), max: quantile(1) },
  responseBytes: bytes,
  scope: 'HTTP read path only. Does not measure model capacity, queue throughput, reminder delivery, or supported student count.',
};
const json = JSON.stringify(report, null, 2);
if (options.output) writeFileSync(options.output, `${json}\n`, { mode: 0o600 });
console.log(json);
if (failures) process.exitCode = 1;
