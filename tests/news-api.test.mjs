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

test('automatic newsletter API requires consent and CSRF and scopes setup and jobs to the student',{timeout:30000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brb-news-api-')),origin='http://127.0.0.1:4380';
 const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4380',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64'),DEV_AUTH_EMAILS:'news-a@cornell.edu,news-b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
 let database,queue,output='';const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}await queue?.close();await database?.close();await rm(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(output);await delay(50);}assert.ok(ready,output);
 async function login(email){const r=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(r.status,200);const cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');return {...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json(),cookie};}
 async function post(user,route,body,headers={}){const r=await fetch(origin+route,{method:'POST',headers:{Cookie:user?.cookie||'',Origin:origin,'Content-Type':'application/json','X-CSRF-Token':user?.csrfToken||'',...headers},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}
 const a=await login('news-a@cornell.edu'),b=await login('news-b@cornell.edu');database=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});queue=await createQueue(database,{workerDatabaseUrl:null});const own=database.forUser(a.user.id),other=database.forUser(b.user.id);
 const notifications={enabled:true,topics:{news:'off'}},events={labelId:'Events-only',continuous:true};await own.put('settings','notifications',notifications);await own.put('settings','eventEmail',events);
 await own.put('secrets','eventEmailGoogle',{subject:'synthetic-google-a',connectionRevision:'synthetic-revision-a',refresh_token:'SYNTHETIC_SECRET_NEVER_RETURN',scope:'https://www.googleapis.com/auth/gmail.readonly',email:'news-a@cornell.edu'});
 const route='/api/news/automatic',input={sources:['wsj10point','dailypitch']};
 assert.equal((await post(null,route,input)).status,401);assert.equal((await post(a,route,input,{'X-CSRF-Token':''})).status,403);
 assert.equal((await post(b,route,input)).status,403);
 assert.equal((await post(a,route,{...input,userId:b.user.id})).status,400);
 assert.equal((await post(a,route,{sources:['unknown']})).status,400);
 assert.equal((await post(a,route,{sources:[]})).status,400);
 const result=await post(a,route,input);assert.equal(result.status,202);assert.ok(result.body.taskId);assert.doesNotMatch(JSON.stringify(result.body),/SYNTHETIC_SECRET|synthetic-google/);
 const config=await own.get('settings','newsEmail');assert.equal(config.mode,'automatic');assert.equal(config.continuous,true);assert.equal(config.connectionRevision,'synthetic-revision-a');assert.ok(!config.labelId);
 assert.deepEqual((await own.get('settings','news')).sources,input.sources);assert.deepEqual(await own.get('settings','notifications'),notifications);assert.deepEqual(await own.get('settings','eventEmail'),events);
 assert.ok(!await other.get('settings','newsEmail'));assert.ok(!await other.get('settings','news'));
 const job=await queue.claim('synthetic-news-worker',{types:['news-sync']});assert.equal(job.id,result.body.taskId);assert.equal(job.userId,a.user.id);assert.deepEqual(job.payload,{});assert.equal((await queue.list(b.user.id)).length,0);await queue.complete(job,{processed:0});
 const state=await(await fetch(origin+'/api/news',{headers:{Cookie:a.cookie}})).json();assert.equal(state.mailbox.mode,'automatic');assert.equal(state.mailbox.accountEmail,'news-a@cornell.edu');assert.doesNotMatch(JSON.stringify(state),/SYNTHETIC_SECRET|synthetic-google/);
 assert.equal((await post(a,'/api/news/disconnect',{})).status,200);assert.equal((await own.get('settings','newsEmail')).continuous,false);assert.ok(await own.get('secrets','eventEmailGoogle'));assert.deepEqual(await own.get('settings','eventEmail'),events);
});
