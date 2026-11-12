import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth } from '../lib/auth.mjs';
import { createSlackAuth, SLACK_USER_SCOPES } from '../lib/slack-auth.mjs';
import { loadSecurityConfig } from '../lib/security.mjs';

function response() { const headers = new Map(); return { setHeader: (k, v) => headers.set(k, v), getHeader: k => headers.get(k) }; }
const cookies = res => res.getHeader('Set-Cookie').map(value => value.split(';')[0]).join('; ');
const request = (cookie = '') => ({ method: 'POST', headers: { cookie }, socket: { remoteAddress: '127.0.0.1' } });
async function fixture({ exchangeOverrides = {}, identityOverrides = {}, channelOverrides = {} } = {}) {
  const records = new Map(), calls = [], tenants = new Map();
  const storage = {
    async get(bucket, id) { return records.get(`${bucket}:${id}`) || null; },
    async put(bucket, id, value) { records.set(`${bucket}:${id}`, value); return value; },
    async delete(bucket, id) { records.delete(`${bucket}:${id}`); },
    async putIfAbsent(bucket, id, value) { const key = `${bucket}:${id}`; if (!records.has(key)) records.set(key, value); return records.get(key); },
    async take(bucket, id) { const key = `${bucket}:${id}`, value = records.get(key); records.delete(key); return value; },
  };
  const database = { auth: storage, forUser(userId) { if (!tenants.has(userId)) tenants.set(userId, new Map()); const rows = tenants.get(userId); return { userId, async get(bucket, id) { return rows.get(`${bucket}:${id}`); }, async put(bucket, id, value) { rows.set(`${bucket}:${id}`, value); } }; } };
  const config = loadSecurityConfig({ DEV_AUTH_EMAILS: 'alice@cornell.edu,bob@cornell.edu' });
  const auth = createAuth({ database, config });
  const env = { SLACK_CLIENT_ID: '123.456', SLACK_CLIENT_SECRET: 'client-secret', SLACK_ALLOWED_TEAM_IDS: 'TCORNELL' };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const method = new URL(url).pathname.split('/').pop();
    const bodies = {
      'oauth.v2.access': { ok: true, team: { id: 'TCORNELL' }, authed_user: { id: 'UALICE', token_type: 'user', access_token: 'xoxp-alice-secret', scope: SLACK_USER_SCOPES.join(',') }, ...exchangeOverrides },
      'auth.test': { ok: true, user_id: 'UALICE', team_id: 'TCORNELL', url: 'https://cornelltech.slack.com/', ...identityOverrides },
      'conversations.info': { ok: true, channel: { id: 'C0BSGSNHM5J', name: 'product-studio', is_member: true, is_channel: true, ...channelOverrides } },
    };
    return { ok: true, status: 200, async json() { return bodies[method]; } };
  };
  const slack = createSlackAuth({ database, auth, config, env, fetchImpl });
  const res = response(), context = await auth.devSignIn(request(), res, 'alice@cornell.edu');
  return { auth, slack, config, database, calls, context, cookie: cookies(res) };
}
async function begin(f) {
  const res = response(), started = await f.slack.begin(request(f.cookie), res, { user: f.context.user });
  const url = new URL(started.url); return { url, state: url.searchParams.get('state'), cookie: `${f.cookie}; ${cookies(res)}` };
}
async function complete(f, started) { return f.slack.complete(request(started.cookie), response(), new URL(`${f.config.origin}/auth/slack/callback?state=${started.state}&code=slack-code`), { user: f.context.user }); }

test('Slack asks only user read permissions and stores authenticated student credentials', async () => {
  const f = await fixture(), start = await begin(f);
  assert.equal(start.url.searchParams.get('scope'), null);
  assert.equal(start.url.searchParams.get('user_scope'), SLACK_USER_SCOPES.join(','));
  assert.equal(start.url.searchParams.get('redirect_uri'), `${f.config.origin}/auth/slack/callback`);
  const result = await complete(f, start);
  assert.equal(result.teamId, 'TCORNELL');
  const stored = await f.database.forUser(f.context.user.id).get('secrets', 'slack');
  assert.equal(stored.userToken, 'xoxp-alice-secret'); assert.equal(stored.botToken, undefined);
  assert.equal(stored.teamURL, 'https://cornelltech.slack.com'); assert.equal(stored.channel, null);
  assert.match(f.calls[0].options.headers.Authorization, /^Basic /);
  assert.equal(f.calls[1].options.headers.Authorization, 'Bearer xoxp-alice-secret');
  await assert.rejects(complete(f, start), error => error.code === 'invalid_oauth_state');
});
test('Slack callback cannot transfer a connection to another signed-in student or browser', async () => {
  const f = await fixture(), start = await begin(f);
  await assert.rejects(complete(f, { ...start, cookie: f.cookie }), error => error.code === 'invalid_oauth_state');
  const res = response(), bob = await f.auth.devSignIn(request(), res, 'bob@cornell.edu');
  const bobCookie = `${cookies(res)}; ${start.cookie.split('; ').find(value => value.startsWith('dabas_oauth='))}`;
  await assert.rejects(f.slack.complete(request(bobCookie), response(), new URL(`${f.config.origin}/auth/slack/callback?state=${start.state}&code=code`), { user: bob.user }), error => error.code === 'invalid_oauth_session');
  assert.equal(f.calls.length, 0);
});
test('Slack rejects bot tokens, unapproved teams, provider identity mismatch and missing scopes', async () => {
  for (const options of [
    { exchangeOverrides: { authed_user: { id: 'UALICE', token_type: 'bot', access_token: 'bot', scope: SLACK_USER_SCOPES.join(',') } } },
    { exchangeOverrides: { authed_user: { id: 'UALICE', token_type: 'user', access_token: 'user', scope: 'channels:read' } } },
    { identityOverrides: { bot_id: 'BBOT' } },
    { identityOverrides: { user_id: 'UBOBBB' } },
    { identityOverrides: { team_id: 'TEVILLL' } },
    { identityOverrides: { url: 'https://evil.example/' } },
  ]) {
    const f = await fixture(options), start = await begin(f);
    await assert.rejects(complete(f, start), error => error.code === 'invalid_slack_identity');
    assert.equal(await f.database.forUser(f.context.user.id).get('secrets', 'slack'), undefined);
  }
});
test('channel selection checks membership using the student token and rejects DMs or absent membership', async () => {
  const f = await fixture(), start = await begin(f); await complete(f, start);
  const store = f.database.forUser(f.context.user.id), result = await f.slack.selectChannel(store, 'C0BSGSNHM5J');
  assert.equal(result.channel, 'C0BSGSNHM5J');
  assert.equal((await store.get('secrets', 'slack')).channelName, 'product-studio');
  assert.equal(f.calls.at(-1).options.headers.Authorization, 'Bearer xoxp-alice-secret');
  assert.equal(f.calls.at(-1).options.method, 'GET');
  for (const channelOverrides of [{ is_member: false }, { is_member: undefined }, { is_archived: true }, { is_im: true }, { is_channel: false, is_group: false }]) {
    const bad = await fixture({ channelOverrides }); await complete(bad, await begin(bad));
    await assert.rejects(bad.slack.selectChannel(bad.database.forUser(bad.context.user.id), 'C0BSGSNHM5J'), error => error.code === 'slack_channel_not_allowed');
  }
});
test('Slack configured in production requires an approved workspace allowlist', () => {
  assert.throws(() => createSlackAuth({ config: { production: true, origin: 'https://assistant.example' }, env: { SLACK_CLIENT_ID: 'id', SLACK_CLIENT_SECRET: 'secret' } }), /SLACK_ALLOWED_TEAM_IDS/);
  assert.doesNotThrow(() => createSlackAuth({ config: { production: true, origin: 'https://assistant.example' }, env: {} }));
});
