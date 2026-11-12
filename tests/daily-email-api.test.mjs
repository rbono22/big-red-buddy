import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {GMAIL_SEND_SCOPE,identityId} from '../lib/auth.mjs';
import {localISO,TZ} from '../lib/domain.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const token=()=>randomBytes(32).toString('base64url');

test('daily email API keeps consent, previews, credentials and delivery student-owned',{timeout:30000},async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'brb-daily-email-api-')),origin='http://127.0.0.1:4384';
  // Deliberately do not inherit provider credentials, production data or workers.
  const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4384',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:token(),PILOT_EMAILS:'email-a@cornell.edu,email-b@cornell.edu',GOOGLE_CLIENT_ID:'synthetic.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'synthetic-only',OLLAMA_URL:'http://127.0.0.1:1'};
  let database,queue,output='';
  const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}
    await queue?.close();await database?.close();await rm(dir,{recursive:true,force:true});
  });
  let ready=false;
  for(let i=0;i<100;i++){try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(output);await delay(50);}
  assert.ok(ready,output);
  database=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});
  queue=await createQueue(database,{workerDatabaseUrl:null});

  // Seed verified synthetic identities, rather than asking a real Google account
  // to consent. Authentication and CSRF still run through the HTTP middleware.
  async function account(letter){
    const subject=`synthetic-email-subject-${letter}`,id=identityId('google',subject),sessionToken=token(),csrfToken=token(),email=`email-${letter}@cornell.edu`;
    const user={id,provider:'google',subject,email,name:`Student ${letter}`,hostedDomain:'cornell.edu'};
    await database.auth.put('users',id,user);
    await database.auth.put('sessions',hash(sessionToken),{idHash:hash(sessionToken),userId:id,createdAt:Date.now(),expiresAt:Date.now()+3600000,csrfToken,epoch:'initial'});
    const result={user,csrfToken,cookie:`dabas_session=${sessionToken}`,store:database.forUser(id)};
    const authenticated=await(await get(result,'/api/session')).json();
    assert.equal(authenticated.user.id,id);assert.equal(authenticated.csrfToken,csrfToken);
    return result;
  }
  function get(account,route){return fetch(origin+route,{headers:account?{Cookie:account.cookie}:{}});}
  async function post(account,route,body={},headers={}){
    const response=await fetch(origin+route,{method:'POST',headers:{Cookie:account?.cookie||'',Origin:origin,'Content-Type':'application/json','X-CSRF-Token':account?.csrfToken||'',...headers},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  }
  const a=await account('a'),b=await account('b');
  const grant=user=>({subject:user.subject,email:user.email,connectionRevision:`SYNTHETIC_BINDING_${user.id}`,access_token:'SYNTHETIC_ACCESS_NEVER_RETURN',refresh_token:'SYNTHETIC_REFRESH_NEVER_RETURN',scope:GMAIL_SEND_SCOPE,expiresAt:Date.now()+3600000,connectedAt:new Date().toISOString()});
  const grantA=grant(a.user),grantB=grant(b.user);
  const secretPattern=/SYNTHETIC_(?:ACCESS|REFRESH|BINDING)|synthetic-email-subject|refresh_token|access_token/;
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  for(const [user,title] of [[a,'ONLY_STUDENT_A_CLASS'],[b,'ONLY_STUDENT_B_CLASS']]){
    await user.store.put('events','class',{id:'class',kind:'class',status:'approved',title,start:localISO(date,'12:00'),end:localISO(date,'13:00'),location:'Campus room'});
    await user.store.put('settings','notifications',{enabled:true,topics:{school:'daily',events:'off',jobs:'off',news:'off',games:'off'},revision:1});
  }

  await t.test('authentication, same-origin checks and CSRF protect every email action',async()=>{
    assert.equal((await get(null,'/api/daily-email/preview')).status,401);
    for(const route of ['/api/daily-email/connect','/api/daily-email/send','/api/daily-email/disconnect','/api/daily-briefing/settings']){
      const input=route.endsWith('/settings')?{emailEnabled:true}:{};
      assert.equal((await post(null,route,input)).status,401,route);
      assert.equal((await post(a,route,input,{'X-CSRF-Token':''})).status,403,route);
      assert.equal((await post(a,route,input,{'X-CSRF-Token':b.csrfToken})).status,403,route);
      assert.equal((await post(a,route,input,{Origin:'https://untrusted.example'})).status,403,route);
    }
    assert.deepEqual(await queue.list(a.user.id),[]);
    assert.ok(!await a.store.get('secrets','dailyEmailGoogle'));
  });

  await t.test('HTML preview is private, sandboxed, student-scoped and never queues delivery',async()=>{
    const response=await get(a,`/api/daily-email/preview?userId=${b.user.id}`),html=await response.text();
    assert.equal(response.status,200,`${html}\n${output}`);assert.match(response.headers.get('content-type'),/^text\/html/);
    assert.equal(response.headers.get('cache-control'),'no-store');
    const csp=response.headers.get('content-security-policy');
    for(const rule of ["default-src 'none'","script-src 'none'","img-src 'none'","style-src 'unsafe-inline'","frame-ancestors 'none'","form-action 'none'","base-uri 'none'"])assert.ok(csp.includes(rule),rule);
    assert.match(csp,/(?:^|;)\s*sandbox(?:\s|;|$)/);assert.doesNotMatch(csp,/allow-scripts|allow-same-origin/);
    assert.match(html,/ONLY_STUDENT_A_CLASS/);assert.doesNotMatch(html,/ONLY_STUDENT_B_CLASS|<script\b/i);
    const other=await(await get(b,'/api/daily-email/preview')).text();
    assert.match(other,/ONLY_STUDENT_B_CLASS/);assert.doesNotMatch(other,/ONLY_STUDENT_A_CLASS/);
    assert.deepEqual(await queue.list(a.user.id),[]);assert.deepEqual(await queue.list(b.user.id),[]);
    assert.deepEqual(await a.store.all('dailyEmails'),[]);
  });

  await t.test('Gmail send consent is separate and never enables delivery by itself',async()=>{
    const readGrant={refresh_token:'READ_ONLY_SECRET',email:a.user.email,scope:'https://www.googleapis.com/auth/gmail.readonly'};
    await a.store.put('secrets','eventEmailGoogle',readGrant);
    assert.equal((await post(a,'/api/daily-briefing/settings',{emailEnabled:true})).status,409);
    assert.equal((await post(a,'/api/daily-email/send')).status,409);
    const connect=await post(a,'/api/daily-email/connect',{userId:b.user.id,email:b.user.email});
    assert.equal(connect.status,200);assert.doesNotMatch(JSON.stringify(connect.body),secretPattern);
    const url=new URL(connect.body.url),params=url.searchParams;
    assert.equal(url.origin,'https://accounts.google.com');
    assert.deepEqual(params.get('scope').split(' '),['openid','email','profile',GMAIL_SEND_SCOPE]);
    assert.equal(params.get('access_type'),'offline');assert.equal(params.get('login_hint'),a.user.email);
    assert.equal(params.get('hd'),'cornell.edu');assert.equal(params.get('redirect_uri'),`${origin}/auth/google/callback`);
    assert.equal(params.has('include_granted_scopes'),false);
    const pending=await database.auth.get('oauth_states',hash(params.get('state')));
    assert.equal(pending.purpose,'daily-email');assert.equal(pending.userId,a.user.id);assert.equal(pending.returnPath,'/#connections');
    assert.ok(!await a.store.get('secrets','dailyEmailGoogle'));assert.ok(!await a.store.get('settings','dailyBriefing'));
    assert.deepEqual(await a.store.get('secrets','eventEmailGoogle'),readGrant);
    assert.deepEqual(await queue.list(a.user.id),[]);
  });

  await t.test('send accepts no recipient overrides and binds queued work to the verified owner',async()=>{
    await a.store.put('secrets','dailyEmailGoogle',grantA);
    await b.store.put('secrets','dailyEmailGoogle',grantA);
    // A copied credential cannot become another student's connection.
    assert.equal((await post(b,'/api/daily-briefing/settings',{emailEnabled:true})).status,409);
    assert.equal((await post(b,'/api/daily-email/send')).status,409);
    const unconnectedState=await(await get(b,'/api/state')).json();
    assert.equal(unconnectedState.dailyEmail.connected,false);assert.equal(unconnectedState.dailyEmail.accountEmail,null);
    await b.store.put('secrets','dailyEmailGoogle',grantB);
    for(const input of [{to:b.user.email},{recipient:b.user.email},{email:b.user.email},{userId:b.user.id},{subject:'Injected'},{html:'<p>Injected</p>'},{raw:'payload'}])assert.equal((await post(a,'/api/daily-email/send',input)).status,400);
    assert.equal((await post(a,'/api/daily-briefing/settings',{emailEnabled:true,userId:b.user.id})).status,400);
    const enabled=await post(a,'/api/daily-briefing/settings',{emailEnabled:true,telegramEnabled:false});
    assert.equal(enabled.status,200);assert.equal(enabled.body.emailEnabled,true);assert.equal(enabled.body.telegramEnabled,false);
    assert.ok(!await b.store.get('settings','dailyBriefing'));
    const sent=await post(a,'/api/daily-email/send');
    assert.equal(sent.status,202);assert.ok(sent.body.taskId);assert.doesNotMatch(JSON.stringify(sent.body),secretPattern);
    assert.equal((await post(a,'/api/daily-email/send')).status,409);
    const job=await queue.claim('synthetic-email-api-worker',{types:['daily-email-preview']});
    assert.equal(job.id,sent.body.taskId);assert.equal(job.userId,a.user.id);
    assert.deepEqual(Object.keys(job.payload).sort(),['attemptId','connectionRevision','date','id','scheduledAt']);
    assert.equal(job.payload.connectionRevision,grantA.connectionRevision);
    assert.deepEqual(await queue.list(b.user.id),[]);
    await queue.complete(job,{sent:false,reason:'synthetic-test-no-delivery'});
  });

  await t.test('status and disconnect reveal no tokens and cannot affect another student',async()=>{
    for(const user of [a,b]){
      const state=await(await get(user,`/api/state?userId=${user===a?b.user.id:a.user.id}`)).json();
      assert.equal(state.dailyEmail.connected,true);assert.equal(state.dailyEmail.accountEmail,user.user.email);
      assert.doesNotMatch(JSON.stringify(state),secretPattern);
      assert.deepEqual(Object.keys(state.dailyEmail).sort(),['accountEmail','connected','lastDate','lastError','lastReason','lastSentAt','lastStatus']);
    }
    const disconnected=await post(a,`/api/daily-email/disconnect?userId=${b.user.id}`,{userId:b.user.id});
    assert.equal(disconnected.status,200);assert.deepEqual(disconnected.body,{connected:false});
    const tombstone=await a.store.get('secrets','dailyEmailGoogle');
    assert.deepEqual(Object.keys(tombstone).sort(),['connectionRevision','disconnectedAt']);
    assert.notEqual(tombstone.connectionRevision,grantA.connectionRevision);assert.ok(Number.isFinite(Date.parse(tombstone.disconnectedAt)));
    assert.deepEqual(await b.store.get('secrets','dailyEmailGoogle'),grantB);
    assert.equal((await post(a,'/api/daily-email/send')).status,409);
    assert.equal((await post(a,'/api/daily-briefing/settings',{emailEnabled:true})).status,409);
    const state=await(await get(a,'/api/state')).json();assert.equal(state.dailyEmail.connected,false);assert.equal(state.dailyEmail.accountEmail,null);
    assert.doesNotMatch(JSON.stringify(state),secretPattern);
  });
});
