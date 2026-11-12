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

test('unified agenda endpoints isolate mail/plans and keep registrar additions explicit', {timeout:30000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brf-event-hub-api-')),origin='http://127.0.0.1:4353';
 const env={PATH:process.env.PATH,LANG:'en_US.UTF-8',NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4353',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64'),DEV_AUTH_EMAILS:'a@cornell.edu,b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const end=once(child,'exit');child.kill('SIGTERM');await end;}await rm(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(`${origin}/healthz`)).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(output);await delay(50);}assert.ok(ready,output);
 async function login(email){const r=await fetch(`${origin}/auth/dev`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(r.status,200);const cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');return {...await(await fetch(`${origin}/api/session`,{headers:{Cookie:cookie}})).json(),cookie};}
 async function api(user,route,body,headers={}){const r=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{Cookie:user.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':user.csrfToken,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
 for(const route of ['/api/event-hub','/api/academic','/api/event-email/labels'])assert.equal((await fetch(origin+route)).status,401);
 const alice=await login('a@cornell.edu'),bob=await login('b@cornell.edu');
 const first=(await api(alice,'/api/state')).body;assert.ok(first.eventHub.items.filter(e=>e.sources.some(s=>s.kind==='academic')).length>=90);assert.equal(first.events.length,0,'registrar availability is not a calendar approval');
 await api(alice,'/api/events/manual',{title:'Alice private gathering',date:'2026-11-20',time:'16:00',location:'Private room'});
 const hub=(await api(alice,'/api/event-hub')).body,item=hub.items.find(e=>e.title==='Alice private gathering');assert.ok(item);
 assert.doesNotMatch(JSON.stringify((await api(bob,'/api/event-hub')).body),/Alice private gathering/);
 assert.equal((await api(bob,'/api/event-hub/add',{id:item.id})).status,404);
 assert.equal((await api(alice,'/api/event-hub/add',{id:item.id},{'X-CSRF-Token':''})).status,403);
 assert.equal((await api(alice,'/api/event-hub/add',{id:item.id,revision:'stale'})).status,409);
 assert.equal((await api(alice,'/api/event-hub/add',{id:item.id,revision:item.revision})).status,200);
 const after=(await api(alice,'/api/state')).body;assert.equal(after.events.find(e=>e.title===item.title).status,'approved');
 const holiday=hub.items.find(e=>e.holiday&&e.allDay);assert.ok(holiday);
 assert.equal((await api(alice,'/api/academic/add',{ids:[holiday.action.id]},{'X-CSRF-Token':''})).status,403);
 assert.equal((await api(alice,'/api/academic/add',{ids:[holiday.action.id]})).status,200);
 assert.equal((await api(bob,'/api/state')).body.events.length,0);
 assert.equal((await api(bob,'/api/event-email/labels')).status,403);
 const db=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});
 try{await db.forUser(alice.user.id).put('events','email-duration',{id:'email-duration',title:'Email without end time',kind:'event',connector:'event-email',status:'review',date:'2026-11-20',start:null,end:null,evidence:'Original event date November 20',evidenceVerified:true});}finally{await db.close();}
 assert.equal((await api(alice,'/api/events/time',{id:'email-duration',time:'16:00'})).status,200);
 assert.equal((await api(alice,'/api/state')).body.events.find(e=>e.id==='email-duration').end,null,'confirming a missing email start does not silently invent a one-minute event');
 const mailItem=(await api(alice,'/api/event-hub')).body.items.find(e=>e.title==='Email without end time');
 assert.equal((await api(alice,'/api/event-hub/add',{id:mailItem.id,revision:mailItem.revision})).status,400);
 assert.equal((await api(alice,'/api/event-hub/add',{id:mailItem.id,revision:mailItem.revision,durationMinutes:90})).status,200);
 const savedMail=(await api(alice,'/api/state')).body.events.find(e=>e.id==='email-duration');assert.equal(savedMail.end,'2026-11-20T22:30:00.000Z');assert.equal(savedMail.durationOrigin,'student');
 assert.equal((await api(alice,'/api/event-email/import',{text:'Meet Alice at the private event on November 20, 2026 at 4 PM.',format:'text'})).status,202);
 assert.equal((await api(bob,'/api/tasks')).body.length,0);
 assert.equal((await api(bob,'/api/event-email/disconnect',{})).status,200);
 assert.equal((await api(alice,'/api/event-email/import',{text:'too short'})).status,400);
});
