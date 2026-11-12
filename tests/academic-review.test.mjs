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

const snapshot=event=>Object.fromEntries(['id','title','kind','date','start','end','location','status','cancelled','evidenceVerified','evidence','updatedAt','sourceId'].map(key=>[key,event[key]??null]));
const meeting=(id,extra={})=>({id,title:'Synthetic finance class',kind:'class',date:'2026-11-18',start:'2026-11-18T18:25:00Z',end:'2026-11-18T19:40:00Z',location:'Tata L23',status:'review',evidenceVerified:true,evidence:'Synthetic source date.',sourceId:'synthetic-source',...extra});

test('grouped academic reviews validate ownership, complete times and displayed snapshots before changing any selected event',{timeout:30000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brb-academic-review-api-')),origin='http://127.0.0.1:4378';
 const env={PATH:process.env.PATH,LANG:'en_US.UTF-8',NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4378',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64'),DEV_AUTH_EMAILS:'review-a@cornell.edu,review-b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
 let database,output='';const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}await database?.close();await rm(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(output);await delay(50);}assert.ok(ready,output);
 async function login(email){const response=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');return {...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json(),cookie};}
 async function review(user,events,{expected=events.map(snapshot),headers={}}={}){const response=await fetch(origin+'/api/events/review',{method:'POST',headers:{Cookie:user.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':user.csrfToken,...headers},body:JSON.stringify({action:'approve',ids:events.map(event=>event.id),expected})});return {status:response.status,body:await response.json()};}
 const alice=await login('review-a@cornell.edu'),bob=await login('review-b@cornell.edu');database=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});const a=database.forUser(alice.user.id),b=database.forUser(bob.user.id);
 const first=meeting('first'),changed=meeting('changed'),foreign=meeting('foreign');for(const event of [first,changed])await a.put('events',event.id,event);await b.put('events',foreign.id,foreign);
 assert.equal((await review(alice,[first],{headers:{'X-CSRF-Token':''}})).status,403);
 assert.equal((await review(alice,[first,foreign])).status,404);assert.equal((await a.get('events',first.id)).status,'review');assert.equal((await b.get('events',foreign.id)).status,'review');
 await a.put('events',changed.id,{...changed,start:'2026-11-18T20:00:00Z',end:'2026-11-18T21:15:00Z',updatedAt:'2026-11-11T22:00:00Z'});
 assert.equal((await review(alice,[first,changed])).status,409);assert.equal((await a.get('events',first.id)).status,'review');assert.equal((await a.get('events',changed.id)).status,'review');assert.equal((await a.all('reminders')).length,0);
 for(const [id,end]of [['missing-end',null],['invalid-end','not-a-date'],['backwards-end','2026-11-18T18:00:00Z']]){const bad=meeting(id,{end});await a.put('events',id,bad);assert.equal((await review(alice,[first,bad])).status,400);assert.equal((await a.get('events',first.id)).status,'review');assert.equal((await a.get('events',id)).status,'review');}
 const fresh=await a.get('events',changed.id),approved=await review(alice,[first,fresh]);assert.equal(approved.status,200);assert.equal(approved.body.count,2);assert.equal((await a.get('events',first.id)).status,'approved');assert.equal((await a.get('events',changed.id)).status,'approved');assert.equal((await a.get('events','invalid-end')).status,'review');assert.equal((await b.get('events',foreign.id)).status,'review');assert.equal((await b.all('reminders')).length,0);
});
