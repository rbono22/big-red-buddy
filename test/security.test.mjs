import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { loadSecurityConfig, enforceRequestOrigin, enforceRequestHost, applySecurityHeaders, RateLimiter, clientIP, safeEqual, safeError, HttpError, privateModelURL } from '../lib/security.mjs';

const production = () => ({ NODE_ENV: 'production', APP_ORIGIN: 'https://assistant.example.edu', SESSION_SECRET: randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), DATABASE_URL: 'postgresql://runtime@db/assistant', GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'configured-secret', PILOT_EMAILS: 'alice@cornell.edu', OLLAMA_URL: 'http://ollama:11434' });
test('production refuses insecure configuration and implicit development identities', () => {
  assert.equal(loadSecurityConfig(production()).secureCookies, true);
  for (const overrides of [ { APP_ORIGIN: 'http://assistant.example.edu' }, { APP_ORIGIN: 'https://assistant.example.edu/path' }, { SESSION_SECRET: 'a'.repeat(64) }, { DATA_ENCRYPTION_KEY: '00'.repeat(32) }, { DATABASE_URL: '' }, { DEV_AUTH_EMAILS: 'alice@cornell.edu' }, { GOOGLE_CLIENT_SECRET: '' }, { PILOT_EMAILS: '' }, { OLLAMA_URL: 'https://public-model.example.com' } ]) assert.throws(() => loadSecurityConfig({ ...production(), ...overrides }));
  assert.doesNotThrow(() => loadSecurityConfig({ ...production(), PILOT_EMAILS: '', ALLOW_ALL_CORNELL: 'true' }));
  assert.throws(() => loadSecurityConfig({ APP_ORIGIN: 'http://192.168.1.20:4318', DEV_AUTH_EMAILS: 'alice@cornell.edu' }));
  assert.throws(() => loadSecurityConfig({ APP_ORIGIN: 'http://127.attacker.example:4318', DEV_AUTH_EMAILS: 'alice@cornell.edu' }));
  assert.equal(loadSecurityConfig({}).devEmails.length, 0);
});
test('Cornell sign-in domain and pilot membership cannot be broadened through configuration', () => {
  for (const base of [{}, production()]) {
    for (const value of ['gmail.com', 'example.edu', 'cornell.edu,example.edu', 'sub.cornell.edu', 'cornell.edu.attacker.example']) {
      assert.throws(() => loadSecurityConfig({...base, ALLOWED_GOOGLE_DOMAINS:value}));
      assert.throws(() => loadSecurityConfig({...base, ALLOWED_GOOGLE_DOMAINS:value, ALLOW_ALL_CORNELL:'true'}));
    }
    for (const value of ['alice@gmail.com', 'alice@sub.cornell.edu', 'alice@cornell.edu.attacker.example', 'alice@cornell.edu,bob@example.edu', 'not-an-email']) assert.throws(() => loadSecurityConfig({...base, PILOT_EMAILS:value}));
    const valid=loadSecurityConfig({...base,ALLOWED_GOOGLE_DOMAINS:'CORNELL.EDU',PILOT_EMAILS:'ALICE@CORNELL.EDU,bob@cornell.edu'});
    assert.deepEqual(valid.allowedDomains,['cornell.edu']);assert.deepEqual(valid.pilotEmails,['alice@cornell.edu','bob@cornell.edu']);
  }
});
test('a public origin requires deliberate Cornell admission even if NODE_ENV was not set to production', () => {
  for (const origin of ['https://assistant.example.edu','http://192.168.1.20:4318','http://localhost.attacker.example:4318']) {
    assert.throws(() => loadSecurityConfig({APP_ORIGIN:origin}));
    assert.doesNotThrow(() => loadSecurityConfig({APP_ORIGIN:origin,PILOT_EMAILS:'alice@cornell.edu'}));
    assert.doesNotThrow(() => loadSecurityConfig({APP_ORIGIN:origin,ALLOW_ALL_CORNELL:'true'}));
    assert.throws(() => loadSecurityConfig({APP_ORIGIN:origin,PILOT_EMAILS:'alice@cornell.edu',DEV_AUTH_EMAILS:'alice@cornell.edu'}));
  }
  assert.doesNotThrow(() => loadSecurityConfig({APP_ORIGIN:'http://127.0.0.1:4318'}));
  for (const email of ['alice@gmail.com','alice@sub.cornell.edu','alice@cornell.edu.attacker.example']) assert.throws(() => loadSecurityConfig({DEV_AUTH_EMAILS:email}));
});
test('private model validation rejects public, credentialed and unsupported endpoints', () => {
  for (const url of ['http://127.0.0.1:11434', 'http://[::1]:11434', 'http://10.0.0.5:11434', 'http://172.16.1.1:11434', 'http://192.168.2.4:11434', 'http://ollama:11434']) assert.equal(privateModelURL(url), true);
  for (const url of ['http://169.254.169.254', 'http://172.15.1.1', 'http://8.8.8.8', 'https://public.example', 'http://user:pass@ollama', 'file:///tmp/model']) assert.equal(privateModelURL(url), false);
});
test('Origin, fetch metadata and Host guards ignore spoofed forwarded headers', () => {
  const config = loadSecurityConfig({});
  assert.doesNotThrow(() => enforceRequestOrigin({ method: 'POST', headers: { origin: config.origin } }, config));
  assert.throws(() => enforceRequestOrigin({ method: 'POST', headers: {} }, config), error => error.status === 403);
  assert.throws(() => enforceRequestOrigin({ method: 'POST', headers: { origin: 'https://evil.example' } }, config), error => error.status === 403);
  assert.throws(() => enforceRequestOrigin({ method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }, config), error => error.status === 403);
  assert.throws(() => enforceRequestHost({ headers: { host: 'evil.example', 'x-forwarded-host': '127.0.0.1:4318' } }, config), error => error.status === 403);
  assert.equal(clientIP({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '8.8.8.8' } }), '127.0.0.1');
});
test('rate limiting bounds bursts, retains active limits, and recovers after the window', () => {
  let now = 1000; const limiter = new RateLimiter({ limit: 2, windowMs: 1000, maxEntries: 2, now: () => now });
  limiter.check('alice'); limiter.check('alice');
  assert.throws(() => limiter.check('alice'), error => error.status === 429 && error.retryAfter === 1);
  limiter.check('bob'); assert.throws(() => limiter.check('charlie'), error => error.status === 429);
  now += 1000; assert.doesNotThrow(() => limiter.check('charlie'));
});
test('security headers block embedding and errors do not expose credentials or raw exceptions', () => {
  const headers = new Map(); applySecurityHeaders({ setHeader: (k, v) => headers.set(k, v) }, loadSecurityConfig(production()));
  assert.match(headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(headers.get('Strict-Transport-Security'), /max-age=/);
  assert.equal(headers.get('Cache-Control'), 'no-store');
  assert.equal(safeError(new Error('secret token is password')).body.error.includes('password'), false);
  assert.equal(safeError(new HttpError(401, 'Sign in.')).status, 401);
  assert.equal(safeEqual('a', 'é'), false); assert.equal(safeEqual(undefined, undefined), false);
});
