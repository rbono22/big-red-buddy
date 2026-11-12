import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openDatabase} from '../lib/database.mjs';

test('saved-job HTTP actions enforce identity, CSRF, strict input and private persistence',{timeout:30000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brb-job-saves-api-')),origin='http://127.0.0.1:4381';
 const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4381',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64'),DEV_AUTH_EMAILS:'saves-a@cornell.edu,saves-b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
 const guard=path.join(dir,'no-network.mjs');await writeFile(guard,"globalThis.fetch=async()=>{throw new Error('No provider calls in bookmark API tests');};\n");
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--import',guard,'server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});let output='',db;
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),11000);timer.unref();try{await stopped;}finally{clearTimeout(timer);}}await db?.close();await rm(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<150;i++){try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(output);await delay(50);}assert.ok(ready,output);
 async function login(email){const r=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(r.status,200);const cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');return {...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json(),cookie};}
 async function post(user,input,headers={}){const r=await fetch(origin+'/api/jobs/save',{method:'POST',headers:{Cookie:user?.cookie||'',Origin:origin,'Content-Type':'application/json','X-CSRF-Token':user?.csrfToken||'',...headers},body:JSON.stringify(input)});return {status:r.status,body:await r.json()};}
 const state=async user=>(await fetch(origin+'/api/state',{headers:{Cookie:user.cookie}})).json();
 const alice=await login('saves-a@cornell.edu'),bob=await login('saves-b@cornell.edu');db=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});const a=db.forUser(alice.user.id),b=db.forUser(bob.user.id);
 const job={id:'shared-job',title:'Product Manager',company:'Synthetic',status:'discovered',provider:'ashby',rawSource:{employmentType:'FullTime',workplaceType:'Remote'},publishedAt:'2026-11-10T12:00:00Z',publicationTimeVerified:true},application={id:'reviewed-app',jobId:job.id,status:'reviewed',answers:{whyCompany:'Student-reviewed answer'}};
 await a.put('jobs',job.id,job);await a.put('applications',application.id,application);await b.put('jobs',job.id,{...job,title:'PRIVATE_BOB_TITLE'});await b.put('jobs','bob-only',{...job,id:'bob-only',title:'PRIVATE_BOB_ONLY'});
 const input={id:job.id,saved:true};assert.equal((await post(null,input)).status,401);assert.equal((await post(alice,input,{'X-CSRF-Token':''})).status,403);assert.equal((await post(alice,input,{'X-CSRF-Token':bob.csrfToken})).status,403);assert.equal((await post(alice,input,{Origin:'https://attacker.example'})).status,403);
 for(const invalid of [{...input,userId:bob.user.id},{...input,saved:'true'},{id:job.id},{...input,status:'submitted'},null,[]])assert.equal((await post(alice,invalid)).status,400);
 assert.equal((await post(alice,{id:'bob-only',saved:true})).status,404);assert.deepEqual(await a.all('jobSaves'),[]);assert.deepEqual(await b.all('jobSaves'),[]);
 const saved=await post(alice,input);assert.equal(saved.status,200);assert.equal(saved.body.id,job.id);assert.equal(saved.body.saved,true);assert.ok(Number.isFinite(Date.parse(saved.body.savedAt)));assert.deepEqual((await post(alice,input)).body,saved.body);
 const first=await state(alice),other=await state(bob);assert.equal(first.jobs[0].saved,true);assert.equal(first.jobs[0].savedAt,saved.body.savedAt);assert.equal(first.jobs[0].employmentType,'full-time');assert.equal(first.jobs[0].workplaceType,'remote');assert.doesNotMatch(JSON.stringify(first),/PRIVATE_BOB/);assert.ok(other.jobs.every(job=>job.saved===false&&job.savedAt===null));assert.deepEqual(await a.get('applications',application.id),application);
 await a.put('jobs',job.id,{...job,title:'Refreshed role',status:'closed',closed:true});assert.equal((await state(alice)).jobs[0].saved,true);
 assert.deepEqual((await post(alice,{id:job.id,saved:false})).body,{id:job.id,saved:false,savedAt:null});assert.equal((await state(alice)).jobs[0].saved,false);assert.equal((await a.get('jobs',job.id)).status,'closed');assert.deepEqual(await a.get('applications',application.id),application);
 assert.equal((await fetch(origin+'/api/jobs/save',{headers:{Cookie:alice.cookie}})).status,404);await a.put('settings','account',{deleting:true});assert.equal((await post(alice,input)).status,409);
});
