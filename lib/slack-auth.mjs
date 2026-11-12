import { HttpError } from './security.mjs';

export const SLACK_USER_SCOPES = ['channels:read', 'channels:history', 'groups:read', 'groups:history'];
const channelId = value => typeof value === 'string' && /^[CG][A-Z0-9]{5,30}$/.test(value);
const slackId = value => typeof value === 'string' && /^[TUW][A-Z0-9]{4,30}$/.test(value);
function workspaceURL(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && /^[a-z0-9-]+\.slack\.com$/.test(url.hostname) && !url.username && !url.password ? url.origin : null; }
  catch { return null; }
}

export function createSlackAuth({ database, auth, config, env = process.env, fetchImpl = fetch, now = Date.now }) {
  const clientId = env.SLACK_CLIENT_ID || '', clientSecret = env.SLACK_CLIENT_SECRET || '';
  const allowedTeams = String(env.SLACK_ALLOWED_TEAM_IDS || env.ALLOWED_SLACK_TEAM_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  const configured = Boolean(clientId && clientSecret), redirectURI = `${config.origin}/auth/slack/callback`;
  if (config.production && configured && (!allowedTeams.length || allowedTeams.some(id => !/^T[A-Z0-9]{4,30}$/.test(id)))) throw new Error('Production Slack requires valid SLACK_ALLOWED_TEAM_IDS.');
  async function call(method, { token, body = {}, basic = false, get = false } = {}) {
    const params = new URLSearchParams(body), url = `https://slack.com/api/${method}${get ? `?${params}` : ''}`;
    let response, result;
    try {
      response = await fetchImpl(url, { method: get ? 'GET' : 'POST', headers: { Authorization: basic ? `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}` : `Bearer ${token}`, ...(get ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) }, ...(!get ? { body: params } : {}), signal: AbortSignal.timeout(20000), redirect: 'error' });
      result = await response.json();
    } catch { throw new HttpError(502, 'Slack could not be reached. Try connecting again.', 'slack_unavailable'); }
    if (!response.ok || result.ok !== true) throw new HttpError(response.status === 429 ? 429 : 403, response.status === 429 ? 'Slack is rate limiting this connection. Retry shortly.' : 'Slack could not authorize this request. Check app approval and reconnect.', 'slack_authorization_failed');
    return result;
  }
  async function currentUser(req, user) {
    const context = await auth.authenticate(req);
    if (user && user.id !== context.user.id) throw new HttpError(403, 'This Slack connection belongs to a different student.', 'invalid_oauth_session');
    return context;
  }
  async function begin(req, res, { user } = {}) {
    if (!configured) throw new HttpError(503, 'Slack connection is not configured yet.', 'slack_not_configured');
    const context = await currentUser(req, user);
    const pending = await auth.beginOAuthState(req, res, { purpose: 'slack', userSession: context, returnPath: '/#connections' });
    const params = new URLSearchParams({ client_id: clientId, user_scope: SLACK_USER_SCOPES.join(','), redirect_uri: redirectURI, state: pending.state });
    if (allowedTeams.length === 1) params.set('team', allowedTeams[0]);
    return { url: `https://slack.com/oauth/v2/authorize?${params}` };
  }
  async function complete(req, res, url, { user } = {}) {
    if (!configured) throw new HttpError(503, 'Slack connection is not configured yet.', 'slack_not_configured');
    const context = await currentUser(req, user);
    if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length > 1) throw new HttpError(400, 'Invalid Slack response.', 'invalid_oauth_state');
    const pending = await auth.consumeOAuthState(req, url.searchParams.get('state'), { purpose: 'slack' });
    if (pending.userId !== context.user.id) throw new HttpError(403, 'This Slack connection belongs to a different student.', 'invalid_oauth_session');
    if (url.searchParams.has('error')) throw new HttpError(400, 'Slack authorization was declined.', 'oauth_declined');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) throw new HttpError(400, 'Slack did not return an authorization code.', 'invalid_oauth_code');
    const result = await call('oauth.v2.access', { basic: true, body: { code, redirect_uri: redirectURI } });
    const granted = result.authed_user;
    if (!granted?.access_token || granted.token_type !== 'user' || !slackId(granted.id) || !SLACK_USER_SCOPES.every(scope => String(granted.scope || '').split(',').includes(scope))) throw new HttpError(403, 'Slack must authorize your user account with the requested read permissions.', 'invalid_slack_identity');
    const identity = await call('auth.test', { token: granted.access_token });
    const teamURL = workspaceURL(identity.url);
    if (identity.bot_id || identity.user_id !== granted.id || !slackId(identity.user_id) || !/^T[A-Z0-9]{4,30}$/.test(identity.team_id || '') || identity.team_id !== result.team?.id || !teamURL || (allowedTeams.length && !allowedTeams.includes(identity.team_id))) throw new HttpError(403, 'This Slack account or workspace is not allowed for the pilot.', 'invalid_slack_identity');
    // Recheck after the provider round trip so logout/deletion cancels pending writes.
    const stillCurrent = await currentUser(req, user);
    if (stillCurrent.session.idHash !== context.session.idHash) throw new HttpError(403, 'Sign-in session changed. Reconnect Slack.', 'invalid_oauth_session');
    const store = database.forUser(context.user.id), previous = await store.get('secrets', 'slack');
    const sameIdentity = previous?.userId === identity.user_id && previous?.teamId === identity.team_id;
    const connection = { userToken: granted.access_token, userId: identity.user_id, teamId: identity.team_id, teamURL, channel: sameIdentity ? previous.channel || null : null, channelName: sameIdentity ? previous.channelName || null : null, scope: granted.scope, connectedAt: new Date(now()).toISOString(), ...(granted.expires_in ? { expiresAt: now() + Number(granted.expires_in) * 1000 } : {}) };
    // Rotating credentials are not silently retained without a coordinated refresh worker.
    // Expiring tokens fail closed and ask for reconnect; ordinary Slack user tokens do not expire.
    await store.put('secrets', 'slack', connection);
    return { user: context.user, teamId: identity.team_id, redirectPath: pending.returnPath };
  }
  async function selectChannel(store, channel) {
    if (!store?.userId) throw new HttpError(403, 'A student-owned store is required.', 'invalid_owner');
    if (!channelId(channel)) throw new HttpError(400, 'Enter the Slack channel ID from its URL.', 'invalid_slack_channel');
    const connection = await store.get('secrets', 'slack');
    if (!connection?.userToken || (connection.expiresAt && connection.expiresAt <= now())) throw new HttpError(400, 'Connect your Slack account first.', 'slack_not_connected');
    const response = await call('conversations.info', { token: connection.userToken, body: { channel }, get: true });
    const selected = response.channel;
    if (selected?.id !== channel || selected.is_member !== true || selected.is_im || selected.is_mpim || selected.is_archived || (!selected.is_channel && !selected.is_group)) throw new HttpError(403, 'Choose an active channel that you belong to.', 'slack_channel_not_allowed');
    await store.put('secrets', 'slack', { ...connection, channel, channelName: String(selected.name || channel).slice(0, 160), channelVerifiedAt: new Date(now()).toISOString() });
    return { channel, name: String(selected.name || channel).slice(0, 160) };
  }
  return { begin, complete, selectChannel, publicConfig: () => ({ configured, scopes: SLACK_USER_SCOPES }) };
}
