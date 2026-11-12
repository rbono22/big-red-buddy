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

test('social event card APIs scope Telegram queues to the signed-in student and require CSRF',{timeout:30000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brb-social-api-')),origin='http://127.0.0.1:4379';
 const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4379',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64'),DEV_AUTH_EMAILS:'social-a@cornell.edu,social-b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
 let database,queue,output='';const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}await queue?.close();await database?.close();await rm(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(output);await delay(50);}assert.ok(ready,output);
 async function login(email){const r=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(r.status,200);const cookie=r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');return {...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json(),cookie};}
 async function send(user,provider,id,headers={}){const r=await fetch(origin+`/api/${provider}/telegram`,{method:'POST',headers:{Cookie:user?.cookie||'',Origin:origin,'Content-Type':'application/json','X-CSRF-Token':user?.csrfToken||'',...headers},body:JSON.stringify({id,userId:'ignored-other-student'})});return {status:r.status,body:await r.json()};}
 const a=await login('social-a@cornell.edu'),b=await login('social-b@cornell.edu');database=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});queue=await createQueue(database,{workerDatabaseUrl:null});const own=database.forUser(a.user.id),other=database.forUser(b.user.id);
 await own.put('secrets','telegram',{chatId:101,linkedAt:'synthetic-link'});await other.put('secrets','telegram',{chatId:202,linkedAt:'other-link'});
 for(const provider of ['partiful','luma']){
  const calendarId=provider+'@import.calendar.google.com',id=(provider==='partiful'?'a':'b').repeat(32),foreign='c'.repeat(32),url=provider==='partiful'?'https://partiful.com/e/fixture':'https://luma.com/fixture';
  const event={id,sourceCalendarId:calendarId,title:'Synthetic social gathering',location:'Synthetic campus room',start:new Date(Date.now()+86400000).toISOString(),end:new Date(Date.now()+90000000).toISOString(),date:new Date(Date.now()+86400000).toISOString().slice(0,10),status:'available',rsvpUrl:url,warnings:[]};
  await own.put('settings',provider+'Calendar',{calendarId,continuous:true});await other.put('settings',provider+'Calendar',{calendarId,continuous:true});await own.put(provider+'Events',id,event);await other.put(provider+'Events',foreign,{...event,id:foreign,title:'Private other student event'});
  assert.equal((await send(null,provider,id)).status,401);assert.equal((await send(a,provider,id,{'X-CSRF-Token':''})).status,403);assert.equal((await send(a,provider,foreign)).status,404);
  const queued=await send(a,provider,id);assert.equal(queued.status,202);assert.ok(queued.body.taskId);assert.deepEqual(Object.keys(queued.body),['taskId']);
  const job=await queue.claim('synthetic-card-worker',{types:['telegram-send']});assert.equal(job.userId,a.user.id);assert.equal(job.id,queued.body.taskId);assert.equal(job.payload.expectedChatId,'101');assert.equal(job.payload.replyMarkup.inline_keyboard[0][0].url,url);assert.doesNotMatch(job.payload.text,/Private other/);await queue.complete(job,{accepted:true});
 }
 assert.equal((await queue.list(b.user.id)).length,0);await own.delete('secrets','telegram');assert.equal((await send(a,'partiful','a'.repeat(32))).status,400);
});
