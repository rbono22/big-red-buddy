import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {idFor} from '../lib/domain.mjs';

// Only a synthetic web process runs. No worker, Gmail request, Telegram message,
// or LinkedIn request is made; the shared mailbox credential is a fixture.
test('LinkedIn email HTTP consent, jobs, and queue remain student-owned and preserve the shared mailbox',{timeout:30000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brb-linkedin-email-api-')),origin='http://127.0.0.1:4498';
 const env={PATH:process.env.PATH,LANG:'en_US.UTF-8',NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4498',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64'),DEV_AUTH_EMAILS:'linkedin-a@cornell.edu,linkedin-b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});let output='',database,queue;
 child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),11000);timer.unref();try{await stopped;}finally{clearTimeout(timer);}}await queue?.close();await database?.close();await rm(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<150;i++){try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(`Synthetic server failed: ${output}`);await delay(50);}assert.ok(ready,output);
 async function login(email){const response=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');return{...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json(),cookie};}
 async function api(user,route,body,headers={}){const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{Cookie:user.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':user.csrfToken,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json()};}
 const route='/api/career/linkedin-alerts';assert.equal((await fetch(origin+route)).status,401);
 const alice=await login('linkedin-a@cornell.edu'),bob=await login('linkedin-b@cornell.edu');
 database=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});queue=await createQueue(database,{workerDatabaseUrl:null});
 const a=database.forUser(alice.user.id),b=database.forUser(bob.user.id),initial=await api(alice,route);assert.equal(initial.status,200);assert.equal(initial.body.connected,false);assert.equal(initial.body.continuous,false);assert.deepEqual(initial.body.jobs,[]);
 assert.equal((await api(alice,route+'/enable',{delivery:'alerts'},{'X-CSRF-Token':''})).status,403);assert.equal((await api(alice,route+'/enable',{delivery:'alerts'},{'X-CSRF-Token':bob.csrfToken})).status,403);assert.equal((await api(alice,route+'/stop',{}, {Origin:'https://attacker.invalid'})).status,403);assert.equal((await api(alice,route,undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
 const grant={subject:'synthetic-alice-google',email:'alice-private@example.com',scope:'https://www.googleapis.com/auth/gmail.readonly',connectionRevision:'mailbox-a',refresh_token:'PRIVATE_SYNTHETIC_REFRESH_TOKEN'};await a.put('secrets','eventEmailGoogle',grant);await a.put('settings','eventEmail',{continuous:true,connectionRevision:'mailbox-a',revision:'event-source'});await a.put('settings','newsEmail',{continuous:true,connectionRevision:'mailbox-a',revision:'news-source'});
 for(const invalid of [{delivery:'weekly'},{delivery:'alerts',userId:bob.user.id},{delivery:'alerts',query:'from:anywhere'}])assert.equal((await api(alice,route+'/enable',invalid)).status,400);
 const started=await api(alice,route+'/enable',{delivery:'alerts'});assert.equal(started.status,202);assert.ok(started.body.taskId);const task=await queue.get(alice.user.id,started.body.taskId);assert.equal(task.type,'linkedin-job-email-sync');assert.equal(task.userId,alice.user.id);assert.equal(await queue.get(bob.user.id,started.body.taskId),null);
 const active=(await api(alice,route)).body;assert.equal(active.connected,true);assert.equal(active.continuous,true);assert.equal(active.delivery,'alerts');assert.equal(active.accountEmail,'alice-private@example.com');assert.doesNotMatch(JSON.stringify(active),/PRIVATE_SYNTHETIC_REFRESH_TOKEN|synthetic-alice-google/);
 const externalId='123456789',id=idFor('linkedin-email',externalId),stamp=new Date().toISOString();
 await a.put('jobs',id,{id,externalId,provider:'linkedin-email',sourceLabel:'LinkedIn alert',title:'ALICE_PRIVATE_ANALYST_ROLE',company:'Synthetic Employer',location:'New York',url:'https://www.linkedin.com/jobs/view/123456789',eligible:true,status:'discovered',receivedAt:stamp,publishedAt:null,publicationTimeVerified:false,rawBody:'PRIVATE_RAW_EMAIL_BODY',linkedinEmail:{mailboxKey:createHash('sha256').update(grant.subject).digest('hex'),connectionRevision:grant.connectionRevision,receivedAt:stamp,messageId:'aa',alertName:'Your job alert'}});
 const imported=(await api(alice,route)).body;assert.equal(imported.jobs[0].title,'ALICE_PRIVATE_ANALYST_ROLE');assert.equal(imported.jobs[0].receivedAt,stamp);assert.ok(!imported.jobs[0].publishedAt);assert.doesNotMatch(JSON.stringify(imported),/PRIVATE_RAW_EMAIL_BODY|PRIVATE_SYNTHETIC_REFRESH_TOKEN|synthetic-alice-google/);
 const other=(await api(bob,route)).body;assert.equal(other.connected,false);assert.equal(other.continuous,false);assert.doesNotMatch(JSON.stringify(other),/alice-private|mailbox-a/);assert.deepEqual((await api(bob,'/api/tasks')).body,[]);
 assert.deepEqual(other.jobs,[]);await a.put('careerRemovals',id,{id,foundRemovedAt:stamp});assert.deepEqual((await api(alice,route)).body.jobs,[],'cleared career roles do not reappear in the email-alert section');
 assert.equal((await api(bob,route+'/stop',{})).status,200);assert.equal((await a.get('settings','linkedinJobEmail')).continuous,true);
 assert.equal((await api(alice,route+'/stop',{})).status,200);assert.equal((await api(alice,route)).body.continuous,false);assert.deepEqual(await a.get('secrets','eventEmailGoogle'),grant);assert.equal((await a.get('settings','eventEmail')).continuous,true);assert.equal((await a.get('settings','newsEmail')).continuous,true);
 const resumed=await api(alice,route+'/enable',{delivery:'daily'});assert.equal(resumed.status,202);assert.equal((await api(alice,route)).body.delivery,'daily');await a.put('secrets','eventEmailGoogle',{...grant,connectionRevision:'replacement-mailbox'});assert.equal((await api(alice,route)).body.continuous,false,'reconnecting Gmail cannot silently resume a prior mailbox consent');
 const appState=(await api(alice,'/api/state')).body;assert.doesNotMatch(JSON.stringify(appState),/PRIVATE_RAW_EMAIL_BODY|PRIVATE_SYNTHETIC_REFRESH_TOKEN|synthetic-alice-google/);assert.ok(appState.jobs.every(job=>!job.linkedinEmail));assert.equal(await b.get('secrets','eventEmailGoogle'),null);
});
