import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAuth, CALENDAR_SCOPE, CAMPUS_CALENDAR_SCOPES, EVENT_EMAIL_SCOPE, GMAIL_SEND_SCOPE, identityId, pruneExpiredAuthRecords } from '../lib/auth.mjs';
import { loadSecurityConfig, sha256 } from '../lib/security.mjs';

function setup(overrides = {}) {
  const rows = new Map(), tenants = new Map(), deleted = new Set(); let time = 1000000;
  const storage = {
    async allEntries(bucket, { limit, after }) { return [...rows].filter(([key]) => key.startsWith(`${bucket}:`)).map(([key, value]) => ({ id: key.slice(bucket.length + 1), value: structuredClone(value) })).sort((a, b) => a.id.localeCompare(b.id)).filter(row => !after || row.id > after).slice(0, limit); },
    async get(bucket, id) { return structuredClone(rows.get(`${bucket}:${id}`) || null); },
    async put(bucket, id, value) { rows.set(`${bucket}:${id}`, structuredClone(value)); return value; },
    async putIfAbsent(bucket, id, value) { if (!rows.has(`${bucket}:${id}`)) await this.put(bucket, id, value); return this.get(bucket, id); },
    async delete(bucket, id) { rows.delete(`${bucket}:${id}`); },
    async take(bucket, id) { const value = rows.get(`${bucket}:${id}`); rows.delete(`${bucket}:${id}`); return value || null; },
  };
  const database = { auth: storage, async isDeleted(userId) { return deleted.has(userId); }, forUser(userId) { if (!tenants.has(userId)) tenants.set(userId, new Map()); const tenant = tenants.get(userId); return { userId, async get(bucket, id) { return structuredClone(tenant.get(`${bucket}:${id}`)); }, async put(bucket, id, value) { tenant.set(`${bucket}:${id}`, structuredClone(value)); }, async putIfAbsent(bucket,id,value){if(!tenant.has(`${bucket}:${id}`))await this.put(bucket,id,value);return this.get(bucket,id);}, async compareAndSet(bucket,id,before,after){if(JSON.stringify(await this.get(bucket,id))!==JSON.stringify(before))return false;await this.put(bucket,id,after);return true;} }; } };
  const config = { ...loadSecurityConfig({ DEV_AUTH_EMAILS: 'alice@cornell.edu,bob@cornell.edu', GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'testsecret', PILOT_EMAILS: 'alice@cornell.edu,bob@cornell.edu' }), ...overrides };
  let payload = {}, tokenOptions, tokenOverrides = {};
  const client = { async getToken(options) { tokenOptions = options; return { tokens: { id_token: 'verified-by-client', access_token: 'access', refresh_token: 'refresh', expiry_date: time + 3600000, scope: `openid email ${CALENDAR_SCOPE}`, ...tokenOverrides } }; }, async verifyIdToken(options) { assert.equal(options.audience, config.googleClientId); return { getPayload: () => payload }; } };
  const auth = createAuth({ database, config, oauthClient: client, now: () => time });
  return { auth, config, client, rows, tenants, database, deleted, setPayload: value => { payload = value; }, setTokens: value => { tokenOverrides = value; }, tokenOptions: () => tokenOptions, advance: value => { time += value; } };
}
function response() { const headers = new Map(); return { setHeader(k, v) { headers.set(k, v); }, getHeader(k) { return headers.get(k); }, headers }; }
function cookies(res) { return res.getHeader('Set-Cookie').map(cookie => cookie.split(';')[0]).join('; '); }
function request(cookie = '', remoteAddress = '127.0.0.1') { return { method: 'POST', headers: { cookie }, socket: { remoteAddress } }; }
async function dev(fixture, email = 'alice@cornell.edu') { const res = response(); const context = await fixture.auth.devSignIn(request(), res, email); return { context, cookie: cookies(res) }; }
async function googleStart(fixture, cookie = '', options = {}) {
  const res = response(), value = await fixture.auth.beginGoogle(request(cookie), res, options), url = new URL(value.url);
  return { url, cookie: [cookie, cookies(res)].filter(Boolean).join('; '), state: url.searchParams.get('state'), nonce: url.searchParams.get('nonce') };
}
function googlePayload(start, extra = {}) { return { sub: 'google-alice', email: 'alice@cornell.edu', email_verified: true, hd: 'cornell.edu', name: 'Alice', nonce: start.nonce, ...extra }; }
function callback(fixture, start, responseObject = response()) { return fixture.auth.completeGoogle(request(start.cookie), responseObject, new URL(`${fixture.config.oauthRedirectURI}?code=authorization-code&state=${start.state}`)); }

async function secondaryStart(f,student,extra={}){const start=await googleStart(f,student.cookie,{purpose:'event-email',userSession:student.context});f.setPayload(googlePayload(start,{sub:'private-google-sub',email:'private.user@gmail.com',hd:undefined,...extra}));f.setTokens({scope:`openid email ${EVENT_EMAIL_SCOPE}`});return start;}
test('event email explicitly connects a verified secondary mailbox without changing Cornell identity or calendar grants',async()=>{
 const f=setup(),student=await dev(f),other=await dev(f,'bob@cornell.edu'),store=f.database.forUser(student.context.user.id);await store.put('secrets','google',{refresh_token:'own-calendar'});
 const start=await secondaryStart(f,student),scope=start.url.searchParams.get('scope').split(' ');assert.ok(scope.includes(EVENT_EMAIL_SCOPE));assert.ok(!scope.includes(CALENDAR_SCOPE));assert.ok(!scope.includes(CAMPUS_CALENDAR_SCOPES[0]));assert.equal(start.url.searchParams.has('hd'),false);assert.equal(start.url.searchParams.has('login_hint'),false);assert.equal(start.url.searchParams.get('prompt'),'select_account consent');assert.equal(start.url.searchParams.get('code_challenge_method'),'S256');
 const responseObject=response(),result=await callback(f,start,responseObject),credentials=await store.get('secrets','eventEmailGoogle');assert.equal(result.user.id,student.context.user.id);assert.equal(result.user.email,'alice@cornell.edu');assert.equal(responseObject.getHeader('Set-Cookie'),undefined);assert.equal(credentials.email,'private.user@gmail.com');assert.equal(credentials.subject,'private-google-sub');assert.equal(credentials.id_token,undefined);assert.equal(credentials.refresh_token,'refresh');assert.equal((await store.get('settings','eventEmail')).continuous,false);assert.equal((await store.get('settings','eventEmail')).labelId,null);assert.deepEqual(await store.get('secrets','google'),{refresh_token:'own-calendar'});assert.equal(await f.database.forUser(other.context.user.id).get('secrets','eventEmailGoogle'),undefined);assert.equal(f.rows.has(`users:${identityId('google','private-google-sub')}`),false);assert.equal((await f.auth.authenticate(request(student.cookie))).user.id,student.context.user.id);assert.equal(result.tokens,undefined);await assert.rejects(callback(f,start),e=>e.code==='invalid_oauth_state');
});
test('secondary mailbox consent still rejects missing Gmail scope, unverified identity, wrong nonce and student session switching',async()=>{
 for(const invalid of ['scope','unverified','nonce','session']){const f=setup(),student=await dev(f),other=await dev(f,'bob@cornell.edu'),start=await secondaryStart(f,student);if(invalid==='scope')f.setTokens({scope:`openid email ${CALENDAR_SCOPE}`});if(invalid==='unverified')f.setPayload(googlePayload(start,{sub:'private',email:'p@gmail.com',hd:undefined,email_verified:false}));if(invalid==='nonce')f.setPayload(googlePayload(start,{sub:'private',email:'p@gmail.com',hd:undefined,nonce:'wrong'}));if(invalid==='session')start.cookie=start.cookie.replace(student.cookie,other.cookie);await assert.rejects(callback(f,start),e=>e.status===403);assert.equal(await f.database.forUser(student.context.user.id).get('secrets','eventEmailGoogle'),undefined);}
});
test('secondary mailbox refresh token is never inherited across Google identities and pending consent cannot undo disconnect',async()=>{
 const f=setup(),student=await dev(f),store=f.database.forUser(student.context.user.id),first=await secondaryStart(f,student);await callback(f,first);const before=await store.get('secrets','eventEmailGoogle');
 const switched=await secondaryStart(f,student,{sub:'different-private-sub',email:'other@gmail.com'});f.setTokens({scope:EVENT_EMAIL_SCOPE,refresh_token:undefined});await assert.rejects(callback(f,switched),e=>e.code==='missing_refresh_token');assert.deepEqual(await store.get('secrets','eventEmailGoogle'),before);
 const same=await secondaryStart(f,student);f.setTokens({scope:EVENT_EMAIL_SCOPE,refresh_token:undefined});await callback(f,same);assert.equal((await store.get('secrets','eventEmailGoogle')).refresh_token,'refresh');
 const stale=await secondaryStart(f,student),settings=await store.get('settings','eventEmail');await store.put('settings','eventEmail',{...settings,connectionRevision:'disconnected-revision',continuous:false});await assert.rejects(callback(f,stale),e=>e.code==='connection_changed');assert.equal((await store.get('settings','eventEmail')).connectionRevision,'disconnected-revision');
});
test('secondary mailbox permission never relaxes Cornell restrictions for login or Calendar purposes',async()=>{
 const f=setup(),login=await googleStart(f);f.setPayload(googlePayload(login,{email:'private@gmail.com',hd:undefined}));await assert.rejects(callback(f,login),e=>e.code==='account_not_allowed');
 await assert.rejects(f.auth.beginGoogle(request(),response(),{purpose:'event-email'}),e=>e.status===401);
});

test('development sign-in is explicit, loopback-only, isolated, and stores only a session hash', async () => {
  const f = setup(), a = await dev(f), b = await dev(f, 'bob@cornell.edu');
  assert.notEqual(a.context.user.id, b.context.user.id);
  const signedIn = await f.auth.authenticate(request(a.cookie));
  assert.equal(signedIn.user.email, 'alice@cornell.edu');
  assert.equal(signedIn.user.subject, undefined);
  const raw = a.cookie.split('=')[1];
  assert.ok(f.rows.has(`sessions:${sha256(raw)}`));
  assert.equal(JSON.stringify([...f.rows]).includes(raw), false);
  await assert.rejects(f.auth.devSignIn(request('', '10.0.0.5'), response(), 'alice@cornell.edu'), /unavailable/);
  await assert.rejects(f.auth.devSignIn(request(), response(), 'stranger@cornell.edu'), /unavailable/);
  await assert.rejects(f.auth.authenticate(request('', '127.0.0.1')), error => error.status === 401);
  await assert.rejects(f.auth.authenticate(request(a.cookie, '10.0.0.5')), error => error.status === 401);
});
test('session rotation, fixed expiry, logout and all-device revocation invalidate old credentials', async () => {
  const f = setup(), first = await dev(f), res = response();
  await f.auth.devSignIn(request(first.cookie), res, 'alice@cornell.edu');
  const second = cookies(res);
  await assert.rejects(f.auth.authenticate(request(first.cookie)), error => error.status === 401);
  const secondContext = await f.auth.authenticate(request(second));
  await f.auth.revokeAll(secondContext.user.id);
  await assert.rejects(f.auth.authenticate(request(second)), error => error.status === 401);
  const third = await dev(f); await f.auth.logout(request(third.cookie), response());
  await assert.rejects(f.auth.authenticate(request(third.cookie)), error => error.status === 401);
  const fourth = await dev(f); f.advance(f.config.sessionTTL + 1);
  await assert.rejects(f.auth.authenticate(request(fourth.cookie)), error => error.status === 401);
});
test('CSRF tokens are scoped to the authenticated session', async () => {
  const f = setup(), a = await dev(f), b = await dev(f, 'bob@cornell.edu');
  assert.doesNotThrow(() => f.auth.requireCSRF({ headers: { 'x-csrf-token': a.context.csrfToken } }, a.context));
  assert.throws(() => f.auth.requireCSRF({ headers: { 'x-csrf-token': b.context.csrfToken } }, a.context), error => error.status === 403);
  assert.throws(() => f.auth.requireCSRF({ headers: {} }, a.context), error => error.status === 403);
});
test('deleted pilot identities cannot authenticate or silently enroll again', async () => {
  const f = setup(), alice = await dev(f);
  f.deleted.add(alice.context.user.id);
  await assert.rejects(f.auth.authenticate(request(alice.cookie)), error => error.status === 401);
  await assert.rejects(dev(f), error => error.code === 'account_deleted');
  const start = await googleStart(f); f.setPayload(googlePayload(start));
  f.deleted.add(identityId('google', 'google-alice'));
  await assert.rejects(callback(f, start), error => error.code === 'account_deleted');
});
test('bounded maintenance deletes expired auth rows, including legacy payloads, and preserves active sessions', async () => {
  const f = setup();
  await f.database.auth.put('sessions', 'aaa-active', { expiresAt: 2000 });
  await f.database.auth.put('sessions', 'bbb-expired', { expiresAt: 999 });
  await f.database.auth.put('oauth_states', 'ccc-expired-legacy', { expiresAt: 999 });
  await f.database.auth.put('oauth_states', 'ddd-active', { expiresAt: 2000 });
  const first = await pruneExpiredAuthRecords(f.database, { now: 1000, limit: 2 });
  assert.deepEqual(first, { scanned: 2, deleted: 1 });
  assert.ok(await f.database.auth.get('sessions', 'aaa-active'));
  assert.equal(await f.database.auth.get('oauth_states', 'ccc-expired-legacy'), null);
  const second = await pruneExpiredAuthRecords(f.database, { now: 1000, limit: 2 });
  assert.deepEqual(second, { scanned: 2, deleted: 1 });
  assert.equal(await f.database.auth.get('sessions', 'bbb-expired'), null);
  assert.ok(await f.database.auth.get('oauth_states', 'ddd-active'));
  await assert.rejects(pruneExpiredAuthRecords(f.database, { limit: 1000000 }), /bounds/);
});
test('Google sign-in binds state to browser, nonce and PKCE and consumes state once', async () => {
  const f = setup(), start = await googleStart(f); f.setPayload(googlePayload(start));
  assert.equal(start.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(start.url.searchParams.get('scope'), 'openid email profile');
  await assert.rejects(callback(f, { ...start, cookie: '' }), error => error.code === 'invalid_oauth_state');
  const res = response(), result = await callback(f, start, res);
  assert.equal(result.user.id, identityId('google', 'google-alice'));
  assert.equal(createHash('sha256').update(f.tokenOptions().codeVerifier).digest('base64url'), start.url.searchParams.get('code_challenge'));
  assert.equal((await f.auth.authenticate(request(cookies(res)))).user.email, 'alice@cornell.edu');
  await assert.rejects(callback(f, start), error => error.code === 'invalid_oauth_state');
});
test('Google sign-in rejects wrong nonce, unverified email, absent Workspace domain and uninvited accounts', async () => {
  for (const extra of [{ nonce: 'wrong' }, { email_verified: false }, { hd: undefined }, { hd: 'evil.edu' }, { email: 'stranger@cornell.edu' }]) {
    const f = setup(), start = await googleStart(f); f.setPayload(googlePayload(start, extra));
    await assert.rejects(callback(f, start), error => error.status === 403);
    assert.equal([...f.rows.keys()].some(key => key.startsWith('sessions:')), false);
  }
});
test('all-Cornell sign-in requires both the exact verified email domain and exact hosted domain',async()=>{
  for(const extra of [
    {email:'person@gmail.com'},
    {email:'person@cornell.edu.attacker.example'},
    {email:'person@notcornell.edu'},
    {email:'person@tech.cornell.edu'},
    {email:'person@cornell.edu.'},
    {email:'person@cornell.edu',hd:'attacker.example'},
    {email:'person@cornell.edu',hd:'cornell.edu.attacker.example'},
    {email:'person@cornell.edu',hd:'tech.cornell.edu'},
    {email:'person@cornell.edu',hd:undefined},
    {email:'person@cornell.edu',email_verified:false},
    {email:'person@cornell.edu',email_verified:'true'}
  ]){
    const f=setup({pilotEmails:[],allowAllCornell:true}),start=await googleStart(f);f.setPayload(googlePayload(start,extra));
    await assert.rejects(callback(f,start),error=>error.status===403,JSON.stringify(extra));
    assert.equal([...f.rows.keys()].some(key=>key.startsWith('users:')||key.startsWith('sessions:')),false,'rejected domains create no local identity or session');
  }
  const f=setup({pilotEmails:[],allowAllCornell:true}),start=await googleStart(f);f.setPayload(googlePayload(start,{email:'New.Student@CORNELL.EDU',hd:'CORNELL.EDU'}));
  const res=response(),result=await callback(f,start,res);assert.equal(result.user.email,'new.student@cornell.edu');assert.equal((await f.auth.authenticate(request(cookies(res)))).user.email,'new.student@cornell.edu');
});
test('a widened injected domain configuration cannot authorize a non-Cornell login',async()=>{
  const f=setup({allowedDomains:['attacker.example','cornell.edu'],pilotEmails:[],allowAllCornell:true}),start=await googleStart(f);
  f.setPayload(googlePayload(start,{email:'person@attacker.example',hd:'attacker.example'}));
  await assert.rejects(callback(f,start),error=>error.status===403);
  assert.equal([...f.rows.keys()].some(key=>key.startsWith('users:')||key.startsWith('sessions:')),false);
});
test('an empty pilot list requires explicit all-Cornell opt-in and rechecks it for existing sessions',async()=>{
  const denied=setup({pilotEmails:[],allowAllCornell:false}),start=await googleStart(denied);denied.setPayload(googlePayload(start));
  await assert.rejects(callback(denied,start),error=>error.status===403);
  const allowed=setup({pilotEmails:[],allowAllCornell:true}),login=await googleStart(allowed);allowed.setPayload(googlePayload(login));const res=response();await callback(allowed,login,res);
  allowed.config.allowAllCornell=false;await assert.rejects(allowed.auth.authenticate(request(cookies(res))),error=>error.status===401);
});
test('development helpers cannot bypass Cornell identity policy through injected configuration',async()=>{
  const f=setup({devEmails:['outsider@gmail.com','alice@cornell.edu']});
  await assert.rejects(f.auth.devSignIn(request(),response(),'outsider@gmail.com'),error=>error.status===403);
  const student=await dev(f),id=student.context.user.id;
  await f.database.auth.put('users',id,{...await f.database.auth.get('users',id),email:'outsider@gmail.com'});
  await assert.rejects(f.auth.authenticate(request(student.cookie)),error=>error.status===401);
});
test('existing Google sessions recheck exact email and hosted domains on every request',async()=>{
  for(const patch of [{email:'alice@gmail.com'},{email:'alice@cornell.edu.attacker.example'},{email:null},{hostedDomain:'attacker.example'},{hostedDomain:'cornell.edu.attacker.example'},{hostedDomain:''}]){
    const f=setup({pilotEmails:[],allowAllCornell:true}),start=await googleStart(f);f.setPayload(googlePayload(start));
    const res=response();await callback(f,start,res);const cookie=cookies(res),userId=identityId('google','google-alice');
    assert.ok(await f.auth.authenticate(request(cookie)));
    await f.database.auth.put('users',userId,{...await f.database.auth.get('users',userId),...patch});
    await assert.rejects(f.auth.authenticate(request(cookie)),error=>error.status===401,JSON.stringify(patch));
    assert.equal([...f.rows.keys()].some(key=>key.startsWith('sessions:')),false,'denied stored identities revoke the current session');
  }
});
test('an existing Google session loses access when its Cornell address is removed from the pilot list',async()=>{
  const f=setup(),start=await googleStart(f);f.setPayload(googlePayload(start));const res=response();await callback(f,start,res);const cookie=cookies(res);
  assert.ok(await f.auth.authenticate(request(cookie)));f.config.pilotEmails.splice(f.config.pilotEmails.indexOf('alice@cornell.edu'),1);
  await assert.rejects(f.auth.authenticate(request(cookie)),error=>error.status===401);
  assert.equal([...f.rows.keys()].some(key=>key.startsWith('sessions:')),false);
});
test('SDK signature or claims-verification failure cannot create an identity or session',async()=>{
  const f=setup({pilotEmails:[],allowAllCornell:true}),start=await googleStart(f);f.setPayload(googlePayload(start));
  f.client.verifyIdToken=async()=>{throw new Error('Synthetic invalid token signature or audience');};
  const res=response();await assert.rejects(callback(f,start,res),error=>error.status===403&&error.code==='invalid_identity');
  assert.equal([...f.rows.keys()].some(key=>key.startsWith('users:')||key.startsWith('sessions:')),false);
  assert.equal(res.getHeader('Set-Cookie'),undefined);
});
test('expired OAuth state cannot establish a session', async () => {
  const f = setup(), start = await googleStart(f); f.setPayload(googlePayload(start)); f.advance(f.config.oauthTTL + 1);
  await assert.rejects(callback(f, start), error => error.code === 'invalid_oauth_state');
});
test('Calendar connection belongs to current Google user and stores scoped credentials only', async () => {
  const f = setup(), start = await googleStart(f); f.setPayload(googlePayload(start));
  const res = response(); await callback(f, start, res); const cookie = cookies(res), context = await f.auth.authenticate(request(cookie));
  const connection = await googleStart(f, cookie, { purpose: 'calendar', userSession: context });
  f.setPayload(googlePayload(connection));
  const result = await callback(f, connection);
  assert.equal(result.purpose, 'calendar');
  const credentials = await f.database.forUser(context.user.id).get('secrets', 'google');
  assert.equal(credentials.refresh_token, 'refresh'); assert.equal(credentials.id_token, undefined);
  assert.equal(credentials.clientSecret, undefined);
  assert.equal(await f.database.forUser(identityId('google', 'google-bob')).get('secrets', 'google'), undefined);
});
test('Calendar connection rejects account switching and callbacks from a different student session', async () => {
  const f = setup(), start = await googleStart(f); f.setPayload(googlePayload(start));
  const res = response(); await callback(f, start, res); const cookie = cookies(res), context = await f.auth.authenticate(request(cookie));
  const connection = await googleStart(f, cookie, { purpose: 'calendar', userSession: context });
  f.setPayload(googlePayload(connection, { sub: 'google-bob', email: 'bob@cornell.edu' }));
  await assert.rejects(callback(f, connection), error => error.code === 'account_mismatch');
  const second = await googleStart(f, cookie, { purpose: 'calendar', userSession: context });
  const bob = await dev(f, 'bob@cornell.edu');
  await assert.rejects(callback(f, { ...second, cookie: `${bob.cookie}; ${second.cookie.split('; ').find(c => c.startsWith('dabas_oauth='))}` }), error => error.code === 'invalid_oauth_session');
});
test('Secure deployments use host-only Secure HttpOnly cookies and reject duplicate session cookies', async () => {
  const f = setup({ origin: 'https://assistant.example.edu', secureCookies: true }), start = await googleStart(f);
  f.setPayload(googlePayload(start)); const res = response(); await callback(f, start, res);
  assert.match(res.getHeader('Set-Cookie')[0], /^__Host-dabas_session=.*; Path=\/; HttpOnly; SameSite=Lax; Max-Age=28800; Secure$/);
  const cookie = cookies(res); await assert.rejects(f.auth.authenticate(request(`${cookie}; ${cookie}`)), error => error.status === 401);
});

test('campus calendar consent is optional, incremental and stores separate student credentials without changing the write calendar', async () => {
  const f=setup(),login=await googleStart(f);f.setPayload(googlePayload(login));const res=response();await callback(f,login,res);const cookie=cookies(res),context=await f.auth.authenticate(request(cookie)),store=f.database.forUser(context.user.id);
  await store.put('secrets','google',{refresh_token:'existing-write-refresh',calendarId:'existing-assistant-calendar',scope:CALENDAR_SCOPE});
  const connection=await googleStart(f,cookie,{purpose:'campus-calendar',userSession:context});
  const scopes=connection.url.searchParams.get('scope').split(' ');
  for(const scope of CAMPUS_CALENDAR_SCOPES)assert.ok(scopes.includes(scope));
  assert.equal(scopes.includes(CALENDAR_SCOPE),false);assert.equal(connection.url.searchParams.get('include_granted_scopes'),'true');assert.equal(connection.url.searchParams.get('access_type'),'offline');assert.equal(connection.url.searchParams.get('code_challenge_method'),'S256');
  f.setPayload(googlePayload(connection));f.setTokens({scope:`openid email ${CAMPUS_CALENDAR_SCOPES.join(' ')}`,refresh_token:'read-refresh'});
  const completed=await callback(f,connection);assert.equal(completed.purpose,'campus-calendar');assert.equal(completed.redirectPath,'/#events');
  assert.equal((await store.get('secrets','campusGoogle')).refresh_token,'read-refresh');assert.equal((await store.get('secrets','campusGoogle')).id_token,undefined);
  assert.deepEqual(await store.get('secrets','google'),{refresh_token:'existing-write-refresh',calendarId:'existing-assistant-calendar',scope:CALENDAR_SCOPE});
  const regular=await googleStart(f,cookie,{purpose:'calendar',userSession:context});for(const scope of CAMPUS_CALENDAR_SCOPES)assert.equal(regular.url.searchParams.get('scope').includes(scope),false);
  await assert.rejects(callback(f,connection),error=>error.code==='invalid_oauth_state');
});
test('campus calendar consent rejects partial scopes, switched Google accounts, and another student session',async()=>{
  for(const variant of ['partial','account','session']){
    const f=setup(),login=await googleStart(f);f.setPayload(googlePayload(login));const res=response();await callback(f,login,res);const cookie=cookies(res),context=await f.auth.authenticate(request(cookie));
    const connection=await googleStart(f,cookie,{purpose:'campus-calendar',userSession:context});f.setPayload(googlePayload(connection,variant==='account'?{sub:'google-bob',email:'bob@cornell.edu'}:{}));f.setTokens({scope:CAMPUS_CALENDAR_SCOPES.slice(0,variant==='partial'?1:2).join(' ')});
    if(variant==='session'){const bob=await dev(f,'bob@cornell.edu');connection.cookie=`${bob.cookie}; ${connection.cookie.split('; ').find(c=>c.startsWith('dabas_oauth='))}`;}
    await assert.rejects(callback(f,connection),error=>error.code===({partial:'missing_calendar_scope',account:'account_mismatch',session:'invalid_oauth_session'})[variant]);
    assert.equal(await f.database.forUser(context.user.id).get('secrets','campusGoogle'),undefined);
  }
});

test('pilot sheet consent is restricted to the verified operator and stores credentials only in auth storage', async()=>{
 const {pilotSheetConfig,PILOT_SHEET_SCOPE}=await import('../lib/pilot-access.mjs');
 const pilotSheet=pilotSheetConfig({PILOT_SHEET_ID:'private-sheet-test-config',PILOT_SHEET_OWNER:'alice@cornell.edu'});
 for(const scenario of ['valid','scope','account','nonce']){
  const f=setup({pilotSheet}),login=await googleStart(f),res=response();f.setPayload(googlePayload(login));await callback(f,login,res);
  const cookie=cookies(res),context=await f.auth.authenticate(request(cookie));
  const start=await googleStart(f,cookie,{purpose:'pilot-sheet',userSession:context});
  assert.deepEqual(start.url.searchParams.get('scope').split(' '),['openid','email','profile',PILOT_SHEET_SCOPE]);
  assert.equal(start.url.searchParams.get('code_challenge_method'),'S256');
  f.setPayload(googlePayload(start,scenario==='account'?{sub:'google-bob',email:'bob@cornell.edu'}:scenario==='nonce'?{nonce:'wrong'}:{}));
  f.setTokens({scope:scenario==='scope'?CALENDAR_SCOPE:PILOT_SHEET_SCOPE});
  if(scenario==='valid'){
   const result=await callback(f,start);assert.equal(result.purpose,'pilot-sheet');assert.equal(result.redirectPath,'/#connections');assert.equal(result.tokens,undefined);
   const grant=await f.database.auth.get('pilot_access',`credentials:${pilotSheet.key}`);assert.equal(grant.refresh_token,'refresh');assert.equal(grant.id_token,undefined);
   assert.equal(await f.database.forUser(context.user.id).get('secrets','pilotSheet'),undefined);
   await f.auth.deleteIdentity(context.user.id);assert.equal(await f.database.auth.get('pilot_access',`credentials:${pilotSheet.key}`),null);
  }else{
   await assert.rejects(callback(f,start),e=>e.status===403);
   assert.equal(await f.database.auth.get('pilot_access',`credentials:${pilotSheet.key}`),null);
  }
 }
 const f=setup({pilotSheet}),bob=await dev(f,'bob@cornell.edu');
 await assert.rejects(googleStart(f,bob.cookie,{purpose:'pilot-sheet',userSession:bob.context}),e=>e.code==='operator_required');
 await assert.rejects(googleStart(f,'',{purpose:'pilot-sheet'}),e=>e.code==='operator_required');
});

test('sheet invitations govern fresh Google login and revoke existing sessions without restart',async()=>{
 const {pilotSheetConfig}=await import('../lib/pilot-access.mjs');
 const pilotSheet=pilotSheetConfig({PILOT_SHEET_ID:'private-sheet-test-config',PILOT_SHEET_OWNER:'alice@cornell.edu'}),f=setup({pilotSheet});
 const key=`snapshot:${pilotSheet.key}`;
 await f.database.auth.put('pilot_access',key,{approved:['alice@cornell.edu','carol@cornell.edu'],syncedAt:1000000});
 const start=await googleStart(f),res=response();f.setPayload(googlePayload(start,{sub:'google-carol',email:'carol@cornell.edu'}));await callback(f,start,res);
 const cookie=cookies(res);assert.equal((await f.auth.authenticate(request(cookie))).user.email,'carol@cornell.edu');
 await f.database.auth.put('pilot_access',key,{approved:['alice@cornell.edu'],syncedAt:1000000});
 await assert.rejects(f.auth.authenticate(request(cookie)),e=>e.status===401);
 const revoked=await googleStart(f);f.setPayload(googlePayload(revoked,{sub:'google-carol',email:'carol@cornell.edu'}));await assert.rejects(callback(f,revoked),e=>e.code==='account_not_allowed');
 // A configured bootstrap member cannot bypass the now-authoritative sheet.
 const old=await googleStart(f);f.setPayload(googlePayload(old,{sub:'google-bob',email:'bob@cornell.edu'}));await assert.rejects(callback(f,old),e=>e.code==='account_not_allowed');
});

async function dailyEmailStudent(f) {
  const login=await googleStart(f),res=response();f.setPayload(googlePayload(login));await callback(f,login,res);
  const cookie=cookies(res),context=await f.auth.authenticate(request(cookie));
  return {cookie,context,store:f.database.forUser(context.user.id)};
}
async function dailyEmailStart(f,student) {
  const start=await googleStart(f,student.cookie,{purpose:'daily-email',userSession:student.context});
  f.setPayload(googlePayload(start));f.setTokens({scope:`openid email ${GMAIL_SEND_SCOPE}`});return start;
}
test('daily email consent requests send-only access and stores a separate owned grant without enabling delivery',async()=>{
  const f=setup(),student=await dailyEmailStudent(f),{store}=student;
  await store.put('secrets','eventEmailGoogle',{subject:'private-reader',refresh_token:'read-only-refresh',scope:EVENT_EMAIL_SCOPE});
  await store.put('secrets','google',{refresh_token:'calendar-refresh',scope:CALENDAR_SCOPE});
  await store.put('settings','dailyBriefing',{enabled:true,time:'08:00'});
  const start=await dailyEmailStart(f,student);
  assert.deepEqual(start.url.searchParams.get('scope').split(' '),['openid','email','profile',GMAIL_SEND_SCOPE]);
  assert.equal(start.url.searchParams.get('hd'),'cornell.edu');assert.equal(start.url.searchParams.get('login_hint'),'alice@cornell.edu');
  assert.equal(start.url.searchParams.get('access_type'),'offline');assert.equal(start.url.searchParams.get('include_granted_scopes'),null);
  assert.equal(start.url.searchParams.get('code_challenge_method'),'S256');
  const res=response(),result=await callback(f,start,res),grant=await store.get('secrets','dailyEmailGoogle');
  assert.equal(result.purpose,'daily-email');assert.equal(result.redirectPath,'/#connections');assert.equal(result.tokens,undefined);
  assert.equal(result.user.id,student.context.user.id);assert.equal(res.getHeader('Set-Cookie'),undefined);
  assert.equal(grant.subject,'google-alice');assert.equal(grant.email,'alice@cornell.edu');assert.equal(grant.refresh_token,'refresh');
  assert.equal(grant.id_token,undefined);assert.match(grant.connectionRevision,/^[\w-]{43}$/);
  assert.deepEqual(await store.get('settings','dailyBriefing'),{enabled:true,time:'08:00'});
  assert.equal((await store.get('secrets','eventEmailGoogle')).refresh_token,'read-only-refresh');assert.equal((await store.get('secrets','google')).refresh_token,'calendar-refresh');
  const other=await dev(f,'bob@cornell.edu');assert.equal(await f.database.forUser(other.context.user.id).get('secrets','dailyEmailGoogle'),undefined);
  await assert.rejects(callback(f,start),e=>e.code==='invalid_oauth_state');
});
test('daily email consent rejects missing send scope, wrong or unverified identities, session switches and absent offline token',async()=>{
  for(const variant of ['scope','account','domain','nonce','unverified','session','offline']){
    const f=setup(),student=await dailyEmailStudent(f),start=await dailyEmailStart(f,student);
    if(variant==='scope')f.setTokens({scope:EVENT_EMAIL_SCOPE});
    if(variant==='account')f.setPayload(googlePayload(start,{sub:'google-bob',email:'bob@cornell.edu'}));
    if(variant==='domain')f.setPayload(googlePayload(start,{email:'alice@gmail.com',hd:undefined}));
    if(variant==='nonce')f.setPayload(googlePayload(start,{nonce:'wrong'}));
    if(variant==='unverified')f.setPayload(googlePayload(start,{email_verified:false}));
    if(variant==='session'){const bob=await dev(f,'bob@cornell.edu');start.cookie=`${bob.cookie}; ${start.cookie.split('; ').find(c=>c.startsWith('dabas_oauth='))}`;}
    if(variant==='offline'){await student.store.put('secrets','eventEmailGoogle',{subject:'google-alice',refresh_token:'read-only-refresh'});await student.store.put('secrets','google',{refresh_token:'calendar-refresh'});f.setTokens({scope:GMAIL_SEND_SCOPE,refresh_token:undefined});}
    await assert.rejects(callback(f,start),e=>e.code===({scope:'missing_email_send_scope',account:'account_mismatch',domain:'account_not_allowed',nonce:'invalid_identity',unverified:'invalid_identity',session:'invalid_oauth_session',offline:'missing_refresh_token'})[variant],variant);
    assert.equal(await student.store.get('secrets','dailyEmailGoogle'),undefined,variant);
  }
});
test('daily email reconnect reuses only its same-subject send refresh token and fences competing OAuth callbacks',async()=>{
  const f=setup(),student=await dailyEmailStudent(f),first=await dailyEmailStart(f,student);await callback(f,first);
  const before=await student.store.get('secrets','dailyEmailGoogle');
  const a=await dailyEmailStart(f,student),b=await dailyEmailStart(f,student);
  f.setPayload(googlePayload(a));f.setTokens({scope:GMAIL_SEND_SCOPE,refresh_token:undefined});await callback(f,a);
  const current=await student.store.get('secrets','dailyEmailGoogle');assert.equal(current.refresh_token,before.refresh_token);assert.notEqual(current.connectionRevision,before.connectionRevision);
  f.setPayload(googlePayload(b));await assert.rejects(callback(f,b),e=>e.code==='connection_changed');assert.deepEqual(await student.store.get('secrets','dailyEmailGoogle'),current);
  await student.store.put('secrets','dailyEmailGoogle',{...current,subject:'different-google-sub'});
  const switched=await dailyEmailStart(f,student);f.setTokens({scope:GMAIL_SEND_SCOPE,refresh_token:undefined});await assert.rejects(callback(f,switched),e=>e.code==='missing_refresh_token');
});
test('a disconnect revision prevents pending Gmail consent from reconnecting and no token is inherited from its tombstone',async()=>{
  const f=setup(),student=await dailyEmailStudent(f),start=await dailyEmailStart(f,student);
  const tombstone={connectionRevision:'disconnect-generation',disconnectedAt:'2026-11-12T12:00:00Z'};await student.store.put('secrets','dailyEmailGoogle',tombstone);
  await assert.rejects(callback(f,start),e=>e.code==='connection_changed');assert.deepEqual(await student.store.get('secrets','dailyEmailGoogle'),tombstone);
  const retry=await dailyEmailStart(f,student);f.setTokens({scope:GMAIL_SEND_SCOPE,refresh_token:undefined});await assert.rejects(callback(f,retry),e=>e.code==='missing_refresh_token');
  const explicit=await dailyEmailStart(f,student);f.setTokens({scope:GMAIL_SEND_SCOPE,refresh_token:'new-consent-token'});await callback(f,explicit);assert.equal((await student.store.get('secrets','dailyEmailGoogle')).refresh_token,'new-consent-token');
});
test('a disconnect racing the final Gmail grant write wins the exact-value compare and set',async()=>{
  const f=setup(),student=await dailyEmailStudent(f),start=await dailyEmailStart(f,student),original=f.database.forUser.bind(f.database);
  const tombstone={connectionRevision:'raced-disconnect',disconnectedAt:'2026-11-12T12:00:00Z'};
  f.database.forUser=userId=>{const store=original(userId),compare=store.compareAndSet.bind(store);return{...store,async compareAndSet(bucket,id,previous,next){if(bucket==='secrets'&&id==='dailyEmailGoogle')await store.put(bucket,id,tombstone);return compare(bucket,id,previous,next);}};};
  await assert.rejects(callback(f,start),e=>e.code==='connection_changed');assert.deepEqual(await student.store.get('secrets','dailyEmailGoogle'),tombstone);
});
