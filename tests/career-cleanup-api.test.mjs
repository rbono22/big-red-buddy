import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes} from 'node:crypto';
import {openDatabase} from '../lib/database.mjs';

test('career reset API requires CSRF, scopes confirmations to the owner, and removes only previewed records',{timeout:30000},async t=>{
 const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${reserve.address().port}`,port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const dir=await mkdtemp(path.join(tmpdir(),'brb-cleanup-api-')),encryptionKey=randomBytes(32).toString('hex');
 const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:encryptionKey,SESSION_SECRET:randomBytes(32).toString('base64url'),DEV_AUTH_EMAILS:'reset-a@cornell.edu,reset-b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
 let output='',database;const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}if(database)await database.close();await rm(dir,{recursive:true,force:true});});
 for(let n=0;n<200&&!output.includes(`Big Red Buddy web ready: ${origin}`);n++){if(child.exitCode!==null)throw new Error(output);await delay(30);}assert.match(output,/web ready/);
 async function login(email){const response=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);const cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');return {cookie,...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json()};}
 const alice=await login('reset-a@cornell.edu'),bob=await login('reset-b@cornell.edu');
 const request=(endpoint,{student=alice,method='POST',value={},csrf=student?.csrfToken}={})=>fetch(origin+endpoint,{method,headers:{Origin:origin,...(student?{Cookie:student.cookie}:{}),...(method==='POST'?{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})}:{})},...(method==='POST'?{body:JSON.stringify(value)}:{})});
 database=await openDatabase({dataDir:dir,encryptionKey,databaseUrl:null,production:false,allowLocal:true});
 const a=database.forUser(alice.user.id),b=database.forUser(bob.user.id);
 const job={id:'same-job',title:'Analyst',company:'Fixture employer',status:'discovered',applyUrl:'https://jobs.lever.co/fixture/12345678-1234-1234-1234-123456789abc/apply'};
 for(const store of [a,b]){await store.put('jobs',job.id,job);await store.put('jobSaves',job.id,{id:job.id,saved:true,savedAt:'2026-11-14T12:00:00Z'});await store.put('applications','draft',{id:'draft',jobId:job.id,status:'reviewed',createdAt:'2026-11-14T12:00:00Z'});}
 await a.put('documents','resume',{name:'Keep.pdf',text:'Saved résumé context'});
 await a.put('career','profile',{fullName:'Keep profile'});
 await a.put('applicationAnswerMemory','keep',{id:'keep',value:'Keep my answer'});
 const previewURL='/api/career/cleanup/preview',confirmURL='/api/career/cleanup/confirm';
 for(const endpoint of [previewURL,confirmURL]){
  assert.equal((await request(endpoint,{student:null})).status,401);
  assert.equal((await request(endpoint,{csrf:null})).status,403);
  assert.equal((await request(endpoint,{csrf:bob.csrfToken})).status,403);
  assert.equal((await request(endpoint,{method:'GET'})).status,404);
 }
 for(const value of [{scope:'unknown'},{scope:'all',userId:bob.user.id},{scope:'found',id:'../foreign'}])assert.equal((await request(previewURL,{value})).status,400);
 let response=await request(previewURL,{value:{scope:'all'}});assert.equal(response.status,200);
 assert.equal(response.headers.get('cache-control'),'no-store');const preview=await response.json();
 assert.equal(preview.canConfirm,true);assert.deepEqual(preview.counts,{applications:1,saved:1,found:1});assert.ok(preview.token);
 assert.equal((await a.get('jobSaves',job.id)).saved,true,'preview does not mutate lists');
 assert.equal((await request(confirmURL,{student:bob,value:{token:preview.token}})).status,409);
 await a.put('jobs','later',{...job,id:'later',title:'Added after preview'});
 response=await request(confirmURL,{value:{token:preview.token}});assert.equal(response.status,200);
 response=await request('/api/state',{method:'GET'});const state=await response.json();
 assert.equal(state.applicationTracker.length,0);assert.equal(state.applications.length,0);
 assert.equal(state.jobs.some(j=>j.id===job.id&&!j.foundRemoved),false);assert.ok(state.jobs.some(j=>j.id==='later'));
 assert.equal(state.jobs.some(j=>j.saved),false);assert.equal(state.resume.name,'Keep.pdf');
 for(const endpoint of ['/api/applications/review','/api/applications/sandbox-submit'])assert.equal((await request(endpoint,{value:{id:'draft',whyCompany:'stale review'}})).status,409,'removed drafts reject stale actions');
 assert.ok((await a.get('applications','draft')).removedAt);
 assert.deepEqual(await a.get('career','profile'),{fullName:'Keep profile'});assert.equal((await a.get('applicationAnswerMemory','keep')).value,'Keep my answer');
 const other=await(await request('/api/state',{student:bob,method:'GET'})).json();assert.equal(other.applicationTracker.length,1);assert.equal(other.jobs[0].saved,true);
 assert.equal((await request(confirmURL,{value:{token:preview.token}})).status,409);
});
