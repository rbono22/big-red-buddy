import { randomUUID } from 'node:crypto';
import { HttpError, isCornellEmail, sha256 } from './security.mjs';

export const PILOT_SHEET_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const PILOT_REFRESH_MS = 60000;
export const PILOT_MAX_STALE_MS = 15 * 60000;
const BUCKET = 'pilot_access';

export function pilotSheetConfig(env = process.env) {
  if (!env.PILOT_SHEET_ID) return null;
  const id = env.PILOT_SHEET_ID, owner = String(env.PILOT_SHEET_OWNER || '').trim().toLowerCase();
  const gid = Number(env.PILOT_SHEET_GID || 0);
  if (!/^[\w-]{20,150}$/.test(id) || !isCornellEmail(owner) || !Number.isSafeInteger(gid) || gid < 0) throw new Error('Invalid pilot sheet configuration.');
  return { id, owner, gid, key: sha256(`${id}:${gid}:${owner}`) };
}
export function isPilotOwner(config, user) {
  return Boolean(config.pilotSheet && user?.provider === 'google' && user.email === config.pilotSheet.owner);
}
export function parsePilotRows(rows, owner) {
  const fail = message => { throw new HttpError(400, message, 'invalid_pilot_sheet'); };
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 10000) fail('Use a header and at most 9,999 student rows.');
  if (String(rows[0]?.[0]).trim().toLowerCase() !== 'email' || String(rows[0]?.[1]).trim().toLowerCase() !== 'access') fail('The first two headers must be Email and Access.');
  const seen = new Set(), approved = [], revoked = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) fail(`Invalid row ${i + 1}.`);
    const email = String(row[0] ?? '').trim().toLowerCase(), access = String(row[1] ?? '').trim().toLowerCase();
    if (!email && !access) continue;
    if (!isCornellEmail(email) || !['approved', 'revoked'].includes(access)) fail(`Row ${i + 1}: enter a Cornell email and Approved or Revoked. Formulas are not accepted.`);
    if (seen.has(email)) fail(`Duplicate email at row ${i + 1}. Keep one row per student.`);
    seen.add(email);
    (access === 'approved' ? approved : revoked).push(email);
  }
  if (!approved.includes(owner)) fail('Keep the operator email Approved so the connection can be maintained.');
  return { approved: approved.sort(), revokedCount: revoked.length };
}

// Before the first successful import, preserve the operator-managed pilot list.
// After activation the sheet is authoritative, including removals. Never fall
// back to the old env list after a failed refresh or restart.
export async function pilotEmailAllowed(database, config, email, now = Date.now()) {
  if (!isCornellEmail(email)) return false;
  const sheet = config.pilotSheet;
  if (sheet) {
    const snapshot = await database.auth.get(BUCKET, `snapshot:${sheet.key}`);
    if (snapshot) {
      // Only the configured operator retains recovery access during an outage.
      if (email === sheet.owner && config.pilotEmails.includes(email)) return true;
      return Number.isFinite(snapshot.syncedAt) && snapshot.syncedAt <= now && now - snapshot.syncedAt <= PILOT_MAX_STALE_MS && Array.isArray(snapshot.approved) && snapshot.approved.includes(email);
    }
  }
  return config.pilotEmails.length ? config.pilotEmails.includes(email) : config.allowAllCornell === true;
}

// Also stop revoked students using an existing Telegram binding or queued jobs.
export async function pilotWorkAllowed(database, userId, env = process.env) {
  const sheet = pilotSheetConfig(env);
  if (!sheet) return true;
  const snapshot = await database.auth.get(BUCKET, `snapshot:${sheet.key}`);
  if (!snapshot) return true;
  const user = await database.auth.get('users', userId);
  return Boolean(user?.provider === 'google' && user.hostedDomain === 'cornell.edu' && await pilotEmailAllowed(database, { pilotSheet: sheet, pilotEmails: String(env.PILOT_EMAILS || '').split(',').map(s => s.trim().toLowerCase()), allowAllCornell: false }, user.email));
}

export function createPilotSheetSync({ database, config, fetchImpl = fetch, now = Date.now }) {
  const sheet = config.pilotSheet, records = database.auth;
  let running;
  async function status() {
    if (!sheet) return { configured: false };
    const [snapshot, health, credentials] = await Promise.all([
      records.get(BUCKET, `snapshot:${sheet.key}`), records.get(BUCKET, `health:${sheet.key}`), records.get(BUCKET, `credentials:${sheet.key}`),
    ]);
    return { configured: true, connected: Boolean(credentials?.refresh_token), active: Boolean(snapshot),
      stale: Boolean(snapshot && now() - snapshot.syncedAt > PILOT_MAX_STALE_MS),
      approvedCount: snapshot?.approved?.length ?? config.pilotEmails.length, lastSuccess: snapshot?.syncedAt || null,
      error: health?.error || null, refreshSeconds: 60,
      sheetURL: `https://docs.google.com/spreadsheets/d/${sheet.id}/edit#gid=${sheet.gid}` };
  }
  async function request(url, options = {}) {
    let response;
    try {
      response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new HttpError(503, `Google Sheets connection failed (HTTP ${response.status}). Enable the Sheets API and reconnect if needed.`, 'pilot_sheet_unavailable');
      const reader = response.body.getReader(); let bytes = 0; const chunks = [];
      while (true) { const {done, value} = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Oversized response'); } chunks.push(Buffer.from(value)); }
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'Google Sheets could not be read. Check the connection and try again.', 'pilot_sheet_unavailable');
    }
  }
  async function perform() {
    if (!sheet) return status();
    const credentials = await records.get(BUCKET, `credentials:${sheet.key}`);
    if (!credentials?.refresh_token) return status();
    const leaseKey = `lease:${sheet.key}`, previous = await records.get(BUCKET, leaseKey);
    if (previous?.expiresAt > now()) return status();
    const lease = { nonce: randomUUID(), expiresAt: now() + 90000 };
    if (!await records.compareAndSet(BUCKET, leaseKey, previous, lease)) return status();
    try {
      let token = credentials.access_token;
      if (!token || credentials.expiresAt < now() + 60000) {
        const result = await request('https://oauth2.googleapis.com/token', { method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({client_id: config.googleClientId, client_secret: config.googleClientSecret, refresh_token: credentials.refresh_token, grant_type: 'refresh_token'}) });
        if (typeof result.access_token !== 'string' || !result.access_token) throw new HttpError(503, 'Reconnect Google Sheets to refresh access.', 'pilot_sheet_unavailable');
        token = result.access_token;
        await records.compareAndSet(BUCKET, `credentials:${sheet.key}`, credentials, {...credentials, access_token: token, expiresAt: now() + (Number(result.expires_in) || 3600) * 1000});
      }
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}`, headers = {Authorization: `Bearer ${token}`};
      const metadata = await request(`${base}?fields=sheets(properties(sheetId,title,gridProperties(rowCount)))`, {headers});
      const tab = metadata.sheets?.find(s => s.properties?.sheetId === sheet.gid)?.properties;
      if (!tab || !Number.isInteger(tab.gridProperties?.rowCount) || tab.gridProperties.rowCount > 10000) throw new HttpError(400, 'The configured sheet tab is missing or exceeds 10,000 rows.', 'invalid_pilot_sheet');
      const range = `'${tab.title.replaceAll("'", "''")}'!A1:B${tab.gridProperties.rowCount}`;
      const result = await request(`${base}/values/${encodeURIComponent(range)}?valueRenderOption=FORMULA&majorDimension=ROWS`, {headers});
      const parsed = parsePilotRows(result.values, sheet.owner);
      const activeGrant = await records.get(BUCKET, `credentials:${sheet.key}`);
      if (!activeGrant || activeGrant.subject !== credentials.subject || activeGrant.connectedAt !== credentials.connectedAt) return status();
      const currentLease = await records.get(BUCKET, leaseKey);
      if (currentLease?.nonce !== lease.nonce || currentLease.expiresAt <= now()) return status();
      await records.put(BUCKET, `snapshot:${sheet.key}`, {...parsed, syncedAt: now()});
      await records.put(BUCKET, `health:${sheet.key}`, {error: null, checkedAt: now()});
    } catch (error) {
      await records.put(BUCKET, `health:${sheet.key}`, {error: error instanceof HttpError ? error.message : 'Sheet refresh failed. The last validated list was preserved.', checkedAt: now()});
    } finally { await records.compareAndSet(BUCKET, leaseKey, lease, {...lease, expiresAt: 0}); }
    return status();
  }
  function sync() { if (!running) running = perform().finally(() => { running = null; }); return running; }
  return {status, sync};
}
