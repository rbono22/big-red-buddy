import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {sampleEvents,eventsInRange,approveSample,changeSampleSource,sampleAnswer} from '../public/demo-data.js';

test('sample schedule keeps missing-time deadlines and changed sources in review',()=>{
 const events=sampleEvents();
 assert.deepEqual(eventsInRange(events,'2026-11-16','2026-11-23',true).map(e=>e.id),['demo-2','demo-3','demo-4']);
 assert.match(sampleAnswer(events,'What deadlines do I have this week?'),/3 deadlines/);
 assert.match(sampleAnswer(events,'What deadlines do I have this week?'),/Time not specified.*milestone 5/);
 assert.match(sampleAnswer(events,'What is due next week?'),/2026-11-24/);
 assert.equal(approveSample(events,'demo-3'),false);
 assert.equal(approveSample(events,'demo-2'),true);
 changeSampleSource(events);
 assert.equal(events.find(e=>e.id==='demo-6').status,'pending');
 assert.match(sampleAnswer(events,'What is due next week?'),/2026-11-25/);
 assert.doesNotMatch(sampleAnswer(events,'What is due next week?'),/2026-11-24/);
 assert.match(sampleAnswer(events,'Send this to my calendar'),/does not send messages or write/);
 assert.equal(sampleEvents().find(e=>e.id==='demo-6').date,'2026-11-24');
});

test('anonymous demo assets cannot grant access to private APIs or send writes',{timeout:30000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brb-public-demo-')),port=String(18000+Math.floor(Math.random()*10000)),origin=`http://127.0.0.1:${port}`;
 const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:port,APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64'),DEV_AUTH_EMAILS:'',OLLAMA_URL:'http://127.0.0.1:1'};
 const guard=path.join(dir,'no-network.mjs');await writeFile(guard,"globalThis.fetch=async()=>{throw new Error('No provider calls permitted in demo tests');};\n");
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--import',guard,'server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),11000);timer.unref();try{await stopped;}finally{clearTimeout(timer);}}await rm(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<150;i++){try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(output);await delay(50);}assert.ok(ready,output);
 for(const asset of ['/demo','/demo.html','/demo.js','/demo-data.js','/demo.css']){
  const r=await fetch(origin+asset);assert.equal(r.status,200,asset);assert.equal(r.headers.get('set-cookie'),null);
  assert.equal((await fetch(origin+asset,{method:'HEAD'})).status,200);
 }
 const html=await(await fetch(origin+'/demo')).text();assert.match(html,/NO ACCOUNT NEEDED/);assert.match(html,/All records are fictional/);
 const session=await(await fetch(origin+'/api/session')).json();assert.equal(session.user,null);assert.equal(session.devEnabled,false);
 for(const api of ['/api/state','/api/calendar.ics','/api/career/demographics'])assert.equal((await fetch(origin+api)).status,401,api);
 for(const api of ['/demo','/api/demo','/api/events','/api/google/connect'])assert.equal((await fetch(origin+api,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({demo:true,userId:'demo',approved:true})})).status,401,api);
 const app=await readFile(path.resolve(import.meta.dirname,'../public/app.js'),'utf8');assert.match(app,/href="\/demo">Try the demo/);
});
