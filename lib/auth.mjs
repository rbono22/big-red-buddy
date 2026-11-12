import { PILOT_SHEET_SCOPE, isPilotOwner, pilotEmailAllowed } from './pilot-access.mjs';
import { createHash, createHmac } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { HttpError, isLoopback, isCornellEmail, CORNELL_EMAIL_DOMAIN, parseCookies, randomToken, safeEqual, setCookie, sha256 } from './security.mjs';
import { withEventEmailLock, EVENT_EMAIL_PERMISSION_NOTICE } from './event-email.mjs';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
export const CAMPUS_CALENDAR_SCOPES = Object.freeze(['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly']);
export const EVENT_EMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const USER_BUCKET = 'users', SESSION_BUCKET = 'sessions', STATE_BUCKET = 'oauth_states';
const publicUser = user => ({ id: user.id, email: user.email, name: user.name, provider: user.provider });
export function identityId(provider, subject) {
  const bytes = createHash('sha256').update(`${provider}:${subject}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function safeReturnPath(value, fallback = '/') {
  return typeof value === 'string' && /^\/(?!\/)/.test(value) && !/[\\\r\n]/.test(value) ? value.slice(0, 512) : fallback;
}

/** Bounded server maintenance, including older rows whose payload did not contain its key. */
export async function pruneExpiredAuthRecords(database, { now = Date.now(), limit = 500 } = {}) {
  if (!Number.isInteger(limit) || limit < 2 || limit > 2000 || !Number.isFinite(now)) throw new Error('Invalid authentication maintenance bounds.');
  const store = database.auth, buckets = [SESSION_BUCKET, STATE_BUCKET];
  let scanned = 0, deleted = 0;
  for (let index = 0; index < buckets.length; index++) {
    const bucket = buckets[index], pageLimit = index === 0 ? Math.floor(limit / 2) : Math.ceil(limit / 2);
    const cursorKey = `expiry-cursor:${bucket}`, cursor = await store.get('auth_maintenance', cursorKey);
    const rows = await store.allEntries(bucket, { limit: pageLimit, after: cursor?.after || null });
    for (const row of rows) {
      scanned++;
      if (Number.isFinite(row.value?.expiresAt) && row.value.expiresAt <= now) { await store.delete(bucket, row.id); deleted++; }
    }
    await store.put('auth_maintenance', cursorKey, { after: rows.length === pageLimit ? rows.at(-1).id : null });
  }
  return { scanned, deleted };
}

/** Authentication credentials live in the server-only auth store; application records use forUser(). */
export function createAuth({ database, config, oauthClient, now = Date.now }) {
  if (!database?.auth) throw new Error('A persistent server authentication store is required.');
  const records = database.auth;
  const client = oauthClient || new OAuth2Client(config.googleClientId, config.googleClientSecret, config.oauthRedirectURI);
  const cookieName = config.secureCookies ? '__Host-dabas_session' : 'dabas_session';
  const bindingCookie = config.secureCookies ? '__Host-dabas_oauth' : 'dabas_oauth';
  const cookieOptions = { secure: config.secureCookies, maxAge: config.sessionTTL };
  const signed = value => `${value}.${createHmac('sha256', config.sessionSecret).update(value).digest('base64url')}`;
  function validBinding(value) {
    if (typeof value !== 'string' || !/^[\w-]{43}\.[\w-]{43}$/.test(value)) return false;
    return safeEqual(value, signed(value.split('.')[0]));
  }
  async function allowedIdentity(user) {
    // The verified email and Workspace claim must both be Cornell. The OAuth
    // chooser's hd hint and configurable lists cannot widen this invariant.
    if(!isCornellEmail(user?.email)||user.hostedDomain!==CORNELL_EMAIL_DOMAIN)return false;
    return pilotEmailAllowed(database, config, user.email.toLowerCase(), now());
  }
  async function assertGoogleIdentity(payload, nonce, { secondaryMailbox = false } = {}) {
    // verifyIdToken also validates Google signature, audience, issuer and token expiry.
    if (!payload || typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255 || payload.email_verified !== true || typeof payload.email !== 'string' || payload.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email) || !safeEqual(payload.nonce, nonce)) throw new HttpError(403, 'Google identity could not be verified. Restart sign-in.', 'invalid_identity');
    const identity = { id: identityId('google', payload.sub), provider: 'google', subject: payload.sub, email: payload.email.toLowerCase(), name: String(payload.name || payload.email.split('@')[0]).slice(0, 120), hostedDomain: String(payload.hd || '').toLowerCase() };
    if (!secondaryMailbox && !await allowedIdentity(identity)) throw new HttpError(403, 'This Cornell account is not invited to the pilot.', 'account_not_allowed');
    return identity;
  }
  async function saveIdentity(identity) {
    if (await database.isDeleted?.(identity.id)) throw new HttpError(403, 'This pilot account has been deleted. Contact the operator to request a new enrollment.', 'account_deleted');
    const timestamp = new Date(now()).toISOString();
    const initial = { ...identity, createdAt: timestamp, updatedAt: timestamp };
    const existing = await records.putIfAbsent(USER_BUCKET, identity.id, initial);
    if (existing.subject !== identity.subject || existing.provider !== identity.provider) throw new HttpError(403, 'Identity could not be linked.', 'invalid_identity');
    const user = { ...existing, email: identity.email, name: identity.name, hostedDomain: identity.hostedDomain, updatedAt: timestamp };
    await records.put(USER_BUCKET, identity.id, user);
    return user;
  }
  async function authenticate(req, { required = true } = {}) {
    const token = parseCookies(req.headers.cookie)[cookieName];
    let result = null;
    if (typeof token === 'string' && /^[\w-]{43}$/.test(token)) {
      const idHash = sha256(token), session = await records.get(SESSION_BUCKET, idHash);
      if (session && session.expiresAt > now()) {
        const user = await records.get(USER_BUCKET, session.userId);
        const epoch = await records.get('session_epochs', session.userId);
        const permitted = user && !(await database.isDeleted?.(session.userId)) && (user.provider === 'dev' ? !config.production && isLoopback(new URL(config.origin).hostname) && isLoopback(req.socket?.remoteAddress) && isCornellEmail(user.email) && user.hostedDomain===CORNELL_EMAIL_DOMAIN && config.devEmails.includes(user.email) : user.provider === 'google' && await allowedIdentity(user));
        if (permitted && safeEqual(session.epoch, epoch?.value || 'initial')) result = { user: publicUser(user), session: { ...session, idHash }, csrfToken: session.csrfToken };
      }
      if (!result && session) await records.delete(SESSION_BUCKET, idHash);
    }
    if (!result && required) throw new HttpError(401, 'Sign in with your Cornell account to continue.', 'authentication_required');
    return result;
  }
  function requireCSRF(req, context) {
    if (!context || !safeEqual(req.headers['x-csrf-token'], context.csrfToken)) throw new HttpError(403, 'Your session request could not be verified. Reload and retry.', 'invalid_csrf');
  }
  async function issueSession(req, res, user) {
    // Rotate on every login; a supplied old session can never choose the new identifier.
    const oldToken = parseCookies(req.headers.cookie)[cookieName];
    if (oldToken) await records.delete(SESSION_BUCKET, sha256(oldToken));
    const token = randomToken(), idHash = sha256(token), epoch = await records.get('session_epochs', user.id);
    const session = { idHash, userId: user.id, createdAt: now(), expiresAt: now() + config.sessionTTL, csrfToken: randomToken(), epoch: epoch?.value || 'initial' };
    await records.put(SESSION_BUCKET, idHash, session);
    setCookie(res, cookieName, token, cookieOptions);
    return { user: publicUser(user), session, csrfToken: session.csrfToken };
  }
  async function logout(req, res) {
    const token = parseCookies(req.headers.cookie)[cookieName];
    if (token) await records.delete(SESSION_BUCKET, sha256(token));
    setCookie(res, cookieName, '', { ...cookieOptions, maxAge: 0 });
    setCookie(res, bindingCookie, '', { ...cookieOptions, maxAge: 0 });
  }
  async function revokeAll(userId) {
    await records.put('session_epochs', userId, { value: randomToken(), revokedAt: now() });
  }
  async function deleteIdentity(userId) {
    await revokeAll(userId);
    if (config.pilotSheet) {
      const key = `credentials:${config.pilotSheet.key}`, grant = await records.get('pilot_access', key);
      if (grant?.subject && identityId('google', grant.subject) === userId) {
        await records.delete('pilot_access', key);
        await records.put('pilot_access', `health:${config.pilotSheet.key}`, {error: 'The operator account was deleted. Sheet access has been disconnected.', checkedAt: now()});
      }
    }
    await records.delete(USER_BUCKET, userId);
  }
  async function devSignIn(req, res, email) {
    const normalized = String(email || '').toLowerCase().trim();
    if (config.production || !isLoopback(new URL(config.origin).hostname) || !isLoopback(req.socket?.remoteAddress) || !isCornellEmail(normalized)||!config.devEmails.includes(normalized)) throw new HttpError(403, 'Development sign-in is unavailable.', 'dev_auth_disabled');
    const identity = await saveIdentity({ id: identityId('dev', normalized), provider: 'dev', subject: normalized, email: normalized, name: normalized.split('@')[0], hostedDomain: 'cornell.edu' });
    return issueSession(req, res, identity);
  }
  async function beginOAuthState(req, res, { purpose, userSession = null, returnPath = '/' }) {
    if (purpose !== 'login') {
      const current = await authenticate(req);
      if (!userSession || current.user.id !== userSession.user.id || current.session.idHash !== userSession.session.idHash) throw new HttpError(403, 'Connection must belong to your current session.', 'invalid_oauth_session');
    }
    const state = randomToken(), nonce = randomToken(), verifier = randomToken();
    const existingBinding = parseCookies(req.headers.cookie)[bindingCookie];
    const binding = validBinding(existingBinding) ? existingBinding : signed(randomToken());
    const pending = { idHash: sha256(state), purpose, nonce, verifier, bindingHash: sha256(binding), userId: userSession?.user.id || null, sessionHash: userSession?.session.idHash || null, expiresAt: now() + config.oauthTTL, returnPath: safeReturnPath(returnPath) };
    await records.put(STATE_BUCKET, pending.idHash, pending);
    setCookie(res, bindingCookie, binding, { secure: config.secureCookies, maxAge: config.oauthTTL });
    return { state, nonce, verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  }
  async function consumeOAuthState(req, rawState, { purpose } = {}) {
    if (typeof rawState !== 'string' || !/^[\w-]{43}$/.test(rawState)) throw new HttpError(400, 'Connection session expired or invalid. Start again.', 'invalid_oauth_state');
    const stateKey = sha256(rawState), pending = await records.get(STATE_BUCKET, stateKey);
    const binding = parseCookies(req.headers.cookie)[bindingCookie];
    if (!pending || pending.expiresAt <= now() || !validBinding(binding) || !safeEqual(sha256(binding), pending.bindingHash) || (purpose && pending.purpose !== purpose)) throw new HttpError(400, 'Connection session expired or invalid. Start again.', 'invalid_oauth_state');
    if (pending.userId) {
      const current = await authenticate(req);
      if (current.user.id !== pending.userId || !safeEqual(current.session.idHash, pending.sessionHash)) throw new HttpError(403, 'This connection belongs to a different sign-in session.', 'invalid_oauth_session');
    }
    const consumed = await records.take(STATE_BUCKET, stateKey);
    if (!consumed) throw new HttpError(400, 'This connection response was already used. Start again.', 'invalid_oauth_state');
    return consumed;
  }
  async function beginGoogle(req, res, { purpose = 'login', userSession = null, returnPath } = {}) {
    if (!['login', 'calendar', 'campus-calendar', 'event-email', 'daily-email', 'pilot-sheet'].includes(purpose)) throw new HttpError(400, 'Unsupported Google connection.', 'invalid_oauth_purpose');
    if (!config.googleClientId || !config.googleClientSecret) throw new HttpError(503, 'Google sign-in is not configured yet.', 'google_not_configured');
    if (purpose === 'pilot-sheet' && !isPilotOwner(config, userSession?.user)) throw new HttpError(403, 'Only the pilot operator can connect the access sheet.', 'operator_required');
    const state = await beginOAuthState(req, res, { purpose, userSession, returnPath: returnPath || (['campus-calendar','event-email'].includes(purpose) ? '/#events' : ['calendar','daily-email','pilot-sheet'].includes(purpose) ? '/#connections' : '/') });
    if (purpose === 'event-email') {
      const pending = await records.get(STATE_BUCKET, sha256(state.state));
      const settings = await database.forUser(userSession.user.id).get('settings', 'eventEmail');
      await records.put(STATE_BUCKET, pending.idHash, { ...pending, mailboxRevision: settings?.connectionRevision || null });
    }
    if (purpose === 'daily-email') {
      const pending = await records.get(STATE_BUCKET, sha256(state.state));
      const credentials = await database.forUser(userSession.user.id).get('secrets', 'dailyEmailGoogle');
      await records.put(STATE_BUCKET, pending.idHash, { ...pending, dailyEmailRevision: credentials?.connectionRevision || null });
    }
    const scopes = purpose === 'pilot-sheet' ? [PILOT_SHEET_SCOPE] : purpose === 'daily-email' ? [GMAIL_SEND_SCOPE] : purpose === 'event-email' ? [EVENT_EMAIL_SCOPE] : purpose === 'campus-calendar' ? CAMPUS_CALENDAR_SCOPES : purpose === 'calendar' ? [CALENDAR_SCOPE] : [];
    const params = new URLSearchParams({ client_id: config.googleClientId, redirect_uri: config.oauthRedirectURI, response_type: 'code', scope: ['openid', 'email', 'profile', ...scopes].join(' '), state: state.state, nonce: state.nonce, code_challenge: state.challenge, code_challenge_method: 'S256', hd: config.allowedDomains[0], prompt: purpose === 'login' ? 'select_account' : 'consent' });
    if (purpose !== 'login') { params.set('access_type', 'offline'); params.set('login_hint', userSession.user.email); }
    if (purpose === 'event-email') { params.delete('hd'); params.delete('login_hint'); params.set('prompt', 'select_account consent'); }
    if (purpose === 'campus-calendar') params.set('include_granted_scopes', 'true');
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` };
  }
  async function completeGoogle(req, res, url) {
    if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length > 1) throw new HttpError(400, 'Invalid Google response.', 'invalid_oauth_state');
    const pending = await consumeOAuthState(req, url.searchParams.get('state'));
    if (!['login', 'calendar', 'campus-calendar', 'event-email', 'daily-email', 'pilot-sheet'].includes(pending.purpose)) throw new HttpError(400, 'Invalid connection provider.', 'invalid_oauth_purpose');
    if (url.searchParams.has('error')) throw new HttpError(400, 'Google authorization was declined. You can try again.', 'oauth_declined');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) throw new HttpError(400, 'Google did not return an authorization code.', 'invalid_oauth_code');
    let tokens, payload;
    try {
      ({ tokens } = await client.getToken({ code, codeVerifier: pending.verifier, redirect_uri: config.oauthRedirectURI }));
      if (!tokens.id_token) throw new Error('Missing ID token');
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.googleClientId });
      payload = ticket.getPayload();
    } catch { throw new HttpError(403, 'Google could not verify this sign-in. Start again.', 'invalid_identity'); }
    const identity = await assertGoogleIdentity(payload, pending.nonce, { secondaryMailbox: pending.purpose === 'event-email' });
    if (pending.purpose === 'daily-email') {
      const current = await authenticate(req);
      if (current.user.id !== pending.userId || current.session.idHash !== pending.sessionHash) throw new HttpError(403, 'Sign-in session changed. Reconnect Gmail delivery.', 'invalid_oauth_session');
      if (identity.id !== pending.userId) throw new HttpError(403, 'Connect the same Cornell Google account you used to sign in.', 'account_mismatch');
      if (!String(tokens.scope || '').split(/\s+/).includes(GMAIL_SEND_SCOPE)) throw new HttpError(403, 'Gmail sending permission was not granted. Reconnect Gmail delivery.', 'missing_email_send_scope');
      const store = database.forUser(current.user.id), previous = await store.get('secrets', 'dailyEmailGoogle');
      if ((previous?.connectionRevision || null) !== pending.dailyEmailRevision) throw new HttpError(409, 'Gmail delivery changed while you were connecting. Start the connection again.', 'connection_changed');
      const refreshToken = tokens.refresh_token || (previous?.subject === identity.subject && previous.refresh_token);
      if (typeof refreshToken !== 'string' || !refreshToken) throw new HttpError(400, 'No offline Gmail sending permission returned. Reconnect and grant access.', 'missing_refresh_token');
      const credentials = { subject: identity.subject, email: identity.email, access_token: tokens.access_token, refresh_token: refreshToken, expiresAt: tokens.expiry_date || now() + 3600000, scope: tokens.scope, token_type: tokens.token_type || 'Bearer', connectedAt: new Date(now()).toISOString(), connectionRevision: randomToken() };
      // A disconnected grant keeps a revision tombstone. CAS prevents a late
      // callback from resurrecting it or replacing another completed connection.
      if (!await store.compareAndSet('secrets', 'dailyEmailGoogle', previous, credentials)) throw new HttpError(409, 'Gmail delivery changed while you were connecting. Start the connection again.', 'connection_changed');
      return { purpose: pending.purpose, user: current.user, redirectPath: pending.returnPath };
    }
    if (pending.purpose === 'pilot-sheet') {
      const current = await authenticate(req);
      if (!isPilotOwner(config, current.user) || current.user.id !== pending.userId || current.session.idHash !== pending.sessionHash || identity.id !== pending.userId) throw new HttpError(403, 'Connect the same operator account you signed in with.', 'operator_required');
      if (!String(tokens.scope || '').split(/\s+/).includes(PILOT_SHEET_SCOPE)) throw new HttpError(403, 'Google Sheets read permission was not granted.', 'missing_sheet_scope');
      const key = `credentials:${config.pilotSheet.key}`, previous = await records.get('pilot_access', key);
      const refreshToken = tokens.refresh_token || (previous?.subject === identity.subject && previous.refresh_token);
      if (!refreshToken) throw new HttpError(400, 'Reconnect Sheets and grant offline access.', 'missing_refresh_token');
      await records.put('pilot_access', key, {subject: identity.subject, access_token: tokens.access_token, refresh_token: refreshToken, expiresAt: tokens.expiry_date || now() + 3600000, connectedAt: now()});
      return {purpose: pending.purpose, user: current.user, redirectPath: pending.returnPath};
    }
    if (pending.purpose === 'event-email') {
      const current = await authenticate(req);
      if (current.user.id !== pending.userId || current.session.idHash !== pending.sessionHash) throw new HttpError(403, 'Sign-in session changed. Reconnect your event mailbox.', 'invalid_oauth_session');
      if (!String(tokens.scope || '').split(/\s+/).includes(EVENT_EMAIL_SCOPE)) throw new HttpError(403, 'The requested Gmail read permission was not granted.', 'missing_email_scope');
      const store = database.forUser(current.user.id);
      return withEventEmailLock(store, now, async () => {
        const settings = await store.get('settings', 'eventEmail');
        if ((settings?.connectionRevision || null) !== pending.mailboxRevision) throw new HttpError(409, 'Your event mailbox connection changed. Start the connection again.', 'connection_changed');
        const previous = await store.get('secrets', 'eventEmailGoogle');
        const sameMailbox = previous?.subject === identity.subject;
        const refreshToken = tokens.refresh_token || (sameMailbox && previous.refresh_token);
        if (!refreshToken) throw new HttpError(400, 'No offline Gmail permission returned for this mailbox. Reconnect and grant access.', 'missing_refresh_token');
        const connectionRevision = randomToken(), connectedAt = new Date(now()).toISOString();
        // Secondary identity is a connector, never a Cornell login or a new student record.
        const credentials = { subject: identity.subject, email: identity.email, access_token: tokens.access_token, refresh_token: refreshToken, expiresAt: tokens.expiry_date || now() + 3600000, scope: tokens.scope, token_type: tokens.token_type || 'Bearer', connectedAt, connectionRevision };
        await store.put('secrets', 'eventEmailGoogle', credentials);
        await store.put('settings', 'eventEmail', { provider: 'gmail', accountEmail: identity.email, connectionRevision, connectedAt, continuous: false, labelId: null, labelName: null, lastError: null, coverageWarning: 'Choose a custom Gmail label before any email is read.', permissionNotice: EVENT_EMAIL_PERMISSION_NOTICE });
        return { purpose: pending.purpose, user: current.user, redirectPath: pending.returnPath };
      });
    }
    if (pending.purpose === 'calendar' || pending.purpose === 'campus-calendar') {
      const current = await authenticate(req);
      if (current.user.id !== pending.userId || current.session.idHash !== pending.sessionHash) throw new HttpError(403, 'Sign-in session changed. Reconnect Calendar.', 'invalid_oauth_session');
      if (identity.id !== pending.userId) throw new HttpError(403, 'Connect the same Google account you used to sign in.', 'account_mismatch');
      const granted = String(tokens.scope || '').split(/\s+/);
      const needed = pending.purpose === 'campus-calendar' ? CAMPUS_CALENDAR_SCOPES : [CALENDAR_SCOPE];
      if (!needed.every(scope => granted.includes(scope))) throw new HttpError(403, 'The requested Google Calendar permission was not granted.', 'missing_calendar_scope');
      const credentialKey = pending.purpose === 'campus-calendar' ? 'campusGoogle' : 'google';
      const store = database.forUser(identity.id), previous = await store.get('secrets', credentialKey) || {};
      const refreshToken = tokens.refresh_token || previous.refresh_token;
      if (!refreshToken) throw new HttpError(400, 'No offline Calendar permission returned. Reconnect and grant access.', 'missing_refresh_token');
      const credentials = { ...previous, access_token: tokens.access_token, refresh_token: refreshToken, expiresAt: tokens.expiry_date || now() + 3600000, scope: tokens.scope, token_type: tokens.token_type || 'Bearer', connectedAt: new Date(now()).toISOString() };
      await store.put('secrets', credentialKey, credentials);
      return { purpose: pending.purpose, user: publicUser(identity), tokens: credentials, redirectPath: pending.returnPath };
    }
    const user = await saveIdentity(identity);
    await issueSession(req, res, user);
    return { purpose: 'login', user: publicUser(user), redirectPath: pending.returnPath };
  }
  function publicConfig() {
    return { googleConfigured: Boolean(config.googleClientId && config.googleClientSecret), devEnabled: !config.production && config.devEmails.length > 0, devEmails: config.production ? [] : config.devEmails, allowedDomains: config.allowedDomains };
  }
  return { authenticate, requireCSRF, consumeCSRF: requireCSRF, beginGoogle, completeGoogle, beginOAuthState, consumeOAuthState, devSignIn, logout, revokeAll, deleteIdentity, publicConfig, cookieName };
}
