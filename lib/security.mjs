import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export class HttpError extends Error {
  constructor(status, message, code = 'request_rejected') {
    super(message); this.name = 'HttpError'; this.status = status; this.statusCode = status; this.code = code;
  }
}

export const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function isLoopback(address = '') {
  if (address === 'localhost' || address === '::1' || address === '[::1]') return true;
  const ipv4 = String(address).replace(/^::ffff:/i, '');
  return isIP(ipv4) === 4 && ipv4.startsWith('127.');
}
export function privateModelURL(value) {
  try {
    const url = new URL(value), host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
    if (isLoopback(host) || ['ollama', 'host.docker.internal'].includes(host)) return true;
    if (isIP(host) === 4) {
      const [a, b] = host.split('.').map(Number);
      return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    }
    return isIP(host) === 6 && /^(fc|fd)/.test(host);
  } catch { return false; }
}
const list = value => [...new Set(String(value || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean))];
export const CORNELL_EMAIL_DOMAIN='cornell.edu';
export function isCornellEmail(value){
  return typeof value==='string'&&value===value.trim()&&/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@cornell\.edu$/i.test(value);
}
function strongSecret(value) {
  return typeof value === 'string' && Buffer.byteLength(value) >= 32 && new Set(value).size >= 12 && !/placeholder|change.?me|example|replace.?me/i.test(value);
}
export function decodeEncryptionKey(value) {
  if (typeof value !== 'string') return null;
  const key = /^[a-f\d]{64}$/i.test(value) ? Buffer.from(value, 'hex') : /^[A-Za-z\d+/]{43}=$/.test(value) ? Buffer.from(value, 'base64') : null;
  return key?.length === 32 && new Set(key).size >= 12 ? key : null;
}

/** Validation runs at process startup, before accepting HTTP connections. */
export function loadSecurityConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  let origin;
  try { origin = new URL(env.APP_ORIGIN || `http://127.0.0.1:${env.PORT || 4318}`); }
  catch { throw new Error('APP_ORIGIN must be a valid absolute origin.'); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('APP_ORIGIN must contain only scheme, host, and optional port.');
  if (production && origin.protocol !== 'https:') throw new Error('Production requires an HTTPS APP_ORIGIN.');
  const devEmails = list(env.DEV_AUTH_EMAILS);
  if (devEmails.length && (production || !isLoopback(origin.hostname))) throw new Error('DEV_AUTH_EMAILS is permitted only for a loopback development origin.');
  if (devEmails.some(email => !isCornellEmail(email))) throw new Error('Development identities must be Cornell email addresses.');
  const allowedDomains = list(env.ALLOWED_GOOGLE_DOMAINS || 'cornell.edu');
  if (allowedDomains.length!==1||allowedDomains[0]!==CORNELL_EMAIL_DOMAIN) throw new Error('ALLOWED_GOOGLE_DOMAINS must be exactly cornell.edu; other login domains are not supported.');
  const pilotEmails = list(env.PILOT_EMAILS), allowAllCornell = env.ALLOW_ALL_CORNELL === 'true';
  if(pilotEmails.some(email=>!isCornellEmail(email)))throw new Error('PILOT_EMAILS must contain only valid @cornell.edu addresses.');
  if ((production||!isLoopback(origin.hostname)) && !pilotEmails.length && !allowAllCornell) throw new Error('Set PILOT_EMAILS for the pilot or explicitly set ALLOW_ALL_CORNELL=true.');
  const googleClientId = env.GOOGLE_CLIENT_ID || '', googleClientSecret = env.GOOGLE_CLIENT_SECRET || '';
  if (production && (!googleClientId.endsWith('.apps.googleusercontent.com') || !googleClientSecret)) throw new Error('Production requires Google OAuth web application credentials.');
  if (production && !strongSecret(env.SESSION_SECRET)) throw new Error('Production SESSION_SECRET must be a random secret of at least 32 bytes.');
  if (production && !decodeEncryptionKey(env.DATA_ENCRYPTION_KEY)) throw new Error('Production DATA_ENCRYPTION_KEY must be a random 32-byte hex or base64 key.');
  if (production && !env.DATABASE_URL) throw new Error('Production requires PostgreSQL DATABASE_URL.');
  const ollamaURL = env.OLLAMA_URL || 'http://127.0.0.1:11434';
  if (production && !privateModelURL(ollamaURL)) throw new Error('Production OLLAMA_URL must target loopback, an RFC1918/ULA address, ollama, or host.docker.internal. Keep the model private.');
  return Object.freeze({
    production, origin: origin.origin, secureCookies: origin.protocol === 'https:',
    googleClientId, googleClientSecret, allowedDomains, pilotEmails, allowAllCornell,
    devEmails, sessionSecret: env.SESSION_SECRET || randomToken(),
    sessionTTL: 8 * 60 * 60 * 1000, oauthTTL: 10 * 60 * 1000,
    oauthRedirectURI: `${origin.origin}/auth/google/callback`, ollamaURL,
  });
}

export function applySecurityHeaders(res, config) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('Cache-Control', 'no-store');
  if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

/** OAuth callbacks are top-level cross-site navigations; callers explicitly exempt those. */
export function enforceRequestOrigin(req, config, { allowMissingOrigin = false } = {}) {
  const origin = req.headers.origin;
  if (origin && origin !== config.origin) throw new HttpError(403, 'Cross-origin access denied.', 'invalid_origin');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site access denied.', 'invalid_origin');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !origin && !allowMissingOrigin) throw new HttpError(403, 'An Origin header is required.', 'invalid_origin');
}
export function enforceRequestHost(req, config) {
  const expected = new URL(config.origin).host.toLowerCase();
  if (String(req.headers.host || '').toLowerCase() !== expected) throw new HttpError(403, 'Invalid request host.', 'invalid_host');
}

export function parseCookies(header = '') {
  const cookies = Object.create(null);
  for (const item of String(header).split(';')) {
    const equals = item.indexOf('='); if (equals <= 0) continue;
    const name = item.slice(0, equals).trim(), value = item.slice(equals + 1).trim();
    // Reject duplicate security cookie names rather than letting proxy/parser order choose an identity.
    cookies[name] = Object.hasOwn(cookies, name) ? null : value;
  }
  return cookies;
}
export function setCookie(res, name, value, { secure = false, maxAge = 0 } = {}) {
  const cookie = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAge / 1000))}${secure ? '; Secure' : ''}`;
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : existing ? [existing] : []), cookie]);
}

/** Per-process admission control; deploy an edge limiter as an additional fleet-wide layer. */
export class RateLimiter {
  constructor({ limit = 120, windowMs = 60000, maxEntries = 10000, now = Date.now } = {}) {
    this.limit = limit; this.windowMs = windowMs; this.maxEntries = maxEntries; this.now = now; this.entries = new Map();
  }
  check(key, { limit = this.limit, windowMs = this.windowMs } = {}) {
    const now = this.now();
    let entry = this.entries.get(String(key));
    if (!entry || now >= entry.expiresAt) {
      if (this.entries.size >= this.maxEntries) {
        for (const [id, current] of this.entries) if (now >= current.expiresAt) this.entries.delete(id);
        if (this.entries.size >= this.maxEntries) throw new HttpError(429, 'Service is busy. Please retry shortly.', 'rate_limited');
      }
      entry = { count: 0, expiresAt: now + windowMs }; this.entries.set(String(key), entry);
    }
    entry.count++;
    if (entry.count > limit) { const error = new HttpError(429, 'Too many requests. Please retry shortly.', 'rate_limited'); error.retryAfter = Math.max(1, Math.ceil((entry.expiresAt - now) / 1000)); throw error; }
    return { remaining: Math.max(0, limit - entry.count), resetAt: entry.expiresAt };
  }
}
// Never trust user-controlled forwarding headers for admission-control identity.
export const clientIP = req => req.socket?.remoteAddress || 'unknown';
export function safeError(error) {
  return error instanceof HttpError ? { status: error.status, body: { error: error.message, code: error.code } } : { status: 500, body: { error: 'The request could not be completed. Please retry or check service status.', code: 'internal_error' } };
}
