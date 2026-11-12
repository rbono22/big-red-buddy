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
import {startDemographics} from '../lib/demographics.mjs';

test('demographic HTTP form enforces identity, CSRF, strict choices, atomic revisions and per-student privacy',{timeout:30000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brb-demographics-api-')),origin='http://127.0.0.1:4382';
 const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4382',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64'),DEV_AUTH_EMAILS:'demo-a@cornell.edu,demo-b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
 const guard=path.join(dir,'no-network.mjs');await writeFile(guard,"globalThis.fetch=async()=>{throw new Error('No external calls in demographic form tests');};\n");
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--import',guard,'server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});let output='',db;
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),11000);timer.unref();try{await stopped;}finally{clearTimeout(timer);}}await db?.close();await rm(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<150;i++){try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(output);await delay(50);}assert.ok(ready,output);
 async function login(email){const r=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(r.status,200);const cookie=r.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');return{...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json(),cookie};}
 async function read(user){const r=await fetch(origin+'/api/career/demographics',{headers:{Cookie:user?.cookie||''}});return{status:r.status,body:await r.json()};}
 async function post(user,input,headers={}){const r=await fetch(origin+'/api/career/demographics',{method:'POST',headers:{Cookie:user?.cookie||'',Origin:origin,'Content-Type':'application/json','X-CSRF-Token':user?.csrfToken||'',...headers},body:JSON.stringify(input)});return{status:r.status,body:await r.json()};}
 const alice=await login('demo-a@cornell.edu'),bob=await login('demo-b@cornell.edu');db=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});const a=db.forUser(alice.user.id),b=db.forUser(bob.user.id);
 assert.equal((await read(null)).status,401);const initial=await read(alice);assert.equal(initial.status,200);assert.equal(initial.body.fields.length,6);assert.equal(typeof initial.body.revision,'string');assert.equal(initial.body.values.veteranStatus,'unanswered');
 const values={veteranStatus:'non_veteran',protectedVeteranStatus:'not_protected',disabilityStatus:'decline',ethnicity:'decline',race:['asian','white'],gender:'non_binary'},input={values,expectedRevision:initial.body.revision};
 assert.equal((await post(null,input)).status,401);assert.equal((await post(alice,input,{'X-CSRF-Token':''})).status,403);assert.equal((await post(alice,input,{'X-CSRF-Token':bob.csrfToken})).status,403);assert.equal((await post(alice,input,{Origin:'https://attacker.example'})).status,403);
 for(const invalid of [{...input,userId:bob.user.id},{values},{...input,values:{}},{...input,values:{medicalDetails:'private'}},{...input,values:{race:['decline','white']}},{...input,values:{disabilityStatus:true}},null,[]])assert.equal((await post(alice,invalid)).status,400);
 assert.equal((await read(alice)).body.values.veteranStatus,'unanswered');assert.equal((await b.get('career','demographics')),null);
 const saved=await post(alice,input);assert.equal(saved.status,200);assert.deepEqual(saved.body.values,values);assert.notEqual(saved.body.revision,initial.body.revision);assert.equal((await a.get('career','profile')).veteranStatus,'non_veteran');
 const stale=await post(alice,{values:{gender:'female'},expectedRevision:initial.body.revision});assert.equal(stale.status,409);assert.equal((await read(alice)).body.values.gender,'non_binary');assert.equal((await read(bob)).body.values.gender,'unanswered');
 const state=await(await fetch(origin+'/api/state',{headers:{Cookie:alice.cookie}})).json();assert.equal(state.demographics,undefined);assert.doesNotMatch(JSON.stringify(state),/"disabilityStatus"|"protectedVeteranStatus"|"ethnicity"/);
 await startDemographics(a,{manual:true,edit:true,field:'gender'});const changed=(await read(alice)).body;assert.notEqual(changed.revision,saved.body.revision);assert.equal((await post(alice,{values:{gender:'male'},expectedRevision:saved.body.revision})).status,409);
 const skipped=await post(alice,{values:{gender:'unanswered'},expectedRevision:changed.revision});assert.equal(skipped.status,200);assert.ok(skipped.body.questionnaire.skippedFields.includes('gender'));assert.equal(skipped.body.questionnaire.active,null);
 assert.equal((await a.all('metrics')).length,0);assert.equal((await b.all('career')).length,0);
 await a.put('settings','account',{deleting:true});assert.equal((await post(alice,{values:{gender:'decline'},expectedRevision:skipped.body.revision})).status,409);
});
