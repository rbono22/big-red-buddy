import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';

test('social email consent API enforces CSRF, student ownership, explicit auto-add and independent stop',{timeout:30000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brb-social-email-api-')),origin='http://127.0.0.1:4383';
 const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4383',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64'),DEV_AUTH_EMAILS:'invite-a@cornell.edu,invite-b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
 let database,queue,output='';const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}await queue?.close();await database?.close();await rm(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(output);await delay(50);}assert.ok(ready,output);
 async function login(email){const r=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(r.status,200);const cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');return {...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json(),cookie};}
 async function post(user,route,body,headers={}){const r=await fetch(origin+route,{method:'POST',headers:{Cookie:user?.cookie||'',Origin:origin,'Content-Type':'application/json','X-CSRF-Token':user?.csrfToken||'',...headers},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
 const a=await login('invite-a@cornell.edu'),b=await login('invite-b@cornell.edu');database=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});queue=await createQueue(database,{workerDatabaseUrl:null});const own=database.forUser(a.user.id),other=database.forUser(b.user.id),route='/api/event-email/automatic',input={providers:['luma','partiful'],autoAdd:false};
 const news={mode:'automatic',continuous:true,connectionRevision:'synthetic-revision-a'},notifications={enabled:true,topics:{events:'daily'}};await own.put('settings','newsEmail',news);await own.put('settings','notifications',notifications);
 assert.equal((await post(null,route,input)).status,401);assert.equal((await post(a,route,input,{'X-CSRF-Token':''})).status,403);
 assert.equal((await post(a,route,input)).status,403);
 const credentials={subject:'synthetic-google-a',connectionRevision:'synthetic-revision-a',refresh_token:'SYNTHETIC_SECRET_NEVER_RETURN',scope:'https://www.googleapis.com/auth/gmail.readonly',email:'private-invites@example.test'};await own.put('secrets','eventEmailGoogle',credentials);
 assert.equal((await post(b,route,input)).status,403);assert.equal((await post(a,route,{...input,userId:b.user.id})).status,400);
 for(const invalid of [{providers:['unknown'],autoAdd:false},{providers:[],autoAdd:false},{providers:['luma','luma'],autoAdd:false},{providers:['luma']},{providers:['luma'],autoAdd:'true'}])assert.equal((await post(b,route,invalid)).status,400);
 assert.equal((await post(a,route,{...input,autoAdd:true})).status,403);
 const result=await post(a,route,input);assert.equal(result.status,202);assert.ok(result.body.taskId);assert.doesNotMatch(JSON.stringify(result.body),/SYNTHETIC_SECRET|synthetic-google/);
 const config=await own.get('settings','eventEmail');assert.equal(config.mode,'automatic');assert.equal(config.continuous,true);assert.equal(config.autoAdd,false);assert.equal(config.connectionRevision,credentials.connectionRevision);assert.deepEqual(config.providers,input.providers);assert.equal(config.labelId,null);
 assert.ok(!await other.get('settings','eventEmail'));assert.deepEqual(await own.get('settings','newsEmail'),news);assert.deepEqual(await own.get('settings','notifications'),notifications);
 const job=await queue.claim('synthetic-invite-worker',{types:['event-email-sync']});assert.equal(job.id,result.body.taskId);assert.equal(job.userId,a.user.id);assert.deepEqual(job.payload,{});assert.equal((await queue.list(b.user.id)).length,0);await queue.complete(job,{processed:0});
 const state=await(await fetch(origin+'/api/state',{headers:{Cookie:a.cookie}})).json();assert.equal(state.eventEmail.mode,'automatic');assert.equal(state.eventEmail.autoAdd,false);assert.deepEqual(state.eventEmail.providers,input.providers);assert.equal(state.eventEmail.accountEmail,credentials.email);assert.doesNotMatch(JSON.stringify(state),/SYNTHETIC_SECRET|synthetic-google/);
 const otherState=await(await fetch(origin+'/api/state',{headers:{Cookie:b.cookie}})).json();assert.equal(otherState.eventEmail.connected,false);assert.deepEqual(otherState.eventEmail.providers,[]);assert.doesNotMatch(JSON.stringify(otherState),/private-invites|synthetic-revision-a/);
 assert.equal((await post(a,'/api/event-email/stop',{}, {'X-CSRF-Token':''})).status,403);assert.equal((await fetch(origin+'/api/event-email/stop',{headers:{Cookie:a.cookie}})).status,404);assert.equal((await own.get('settings','eventEmail')).continuous,true);
 assert.equal((await post(b,'/api/event-email/stop',{userId:a.user.id})).status,200);assert.equal((await own.get('settings','eventEmail')).continuous,true);
 const stop=await post(a,'/api/event-email/stop',{});assert.equal(stop.status,200);assert.equal(stop.body.continuous,false);assert.equal(stop.body.autoAdd,false);assert.equal((await own.get('settings','eventEmail')).continuous,false);assert.deepEqual(await own.get('settings','newsEmail'),news);assert.deepEqual(await own.get('secrets','eventEmailGoogle'),credentials);
 await own.put('secrets','google',{refresh_token:'SYNTHETIC_CALENDAR_SECRET',scope:'https://www.googleapis.com/auth/calendar.app.created'});
 const auto=await post(a,route,{providers:['partiful'],autoAdd:true});assert.equal(auto.status,202);assert.equal((await own.get('settings','eventEmail')).autoAdd,true);assert.deepEqual((await own.get('settings','eventEmail')).providers,['partiful']);assert.equal((await own.all('events')).length,0);
 const profile=await own.get('settings','profile');await own.put('settings','profile',{...profile,paused:true});assert.equal((await post(a,route,input)).status,409);await own.put('settings','profile',{...profile,paused:false});
 await own.put('settings','account',{deleting:true});assert.equal((await post(a,route,input)).status,409);
});
