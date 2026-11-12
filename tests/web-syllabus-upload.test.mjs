import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {validateUpload} from '../lib/job-handlers.mjs';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {processSyllabusUpload} from '../lib/syllabus-upload.mjs';
import {idFor} from '../lib/domain.mjs';
import {persistCandidates} from '../lib/ingest.mjs';

// Synthetic 1-pixel PNG. These tests exercise file admission and queue ownership;
// local OCR of readable syllabus images is covered by enrollment.test.mjs.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const syllabus=(overrides={})=>({type:'syllabus',name:'syllabus.png',base64:png.toString('base64'),mimeType:'image/png',term:'SP27',...overrides});

test('website syllabus admission accepts image bytes and keeps resume uploads PDF-only',()=>{
  assert.deepEqual(validateUpload(syllabus()),png);
  const pdf=Buffer.from('%PDF-1.4\nSynthetic admission fixture\n%%EOF');
  assert.deepEqual(validateUpload(syllabus({name:'syllabus.pdf',base64:pdf.toString('base64'),mimeType:'application/pdf'})),pdf);
  assert.deepEqual(validateUpload({type:'resume',name:'resume.pdf',base64:pdf.toString('base64'),mimeType:'application/pdf'}),pdf);
  assert.throws(()=>validateUpload(syllabus({type:'resume'})),/PDF/i);
});

test('website syllabus admission rejects spoofed MIME, malformed encoding, oversized photos and unsupported images',()=>{
  assert.throws(()=>validateUpload(syllabus({mimeType:'image/jpeg'})));
  assert.throws(()=>validateUpload(syllabus({base64:Buffer.from('%PDF-1.4\n').toString('base64')})));
  assert.throws(()=>validateUpload(syllabus({base64:png.toString('base64')+'='})));
  assert.throws(()=>validateUpload(syllabus({mimeType:'image/heic',name:'syllabus.heic'})),/JPEG|PNG|HEIC/i);
  const huge=Buffer.from(png);huge.writeUInt32BE(12000,16);huge.writeUInt32BE(12000,20);
  assert.throws(()=>validateUpload(syllabus({base64:huge.toString('base64')})),/megapixel|pixels/i);
  assert.throws(()=>validateUpload(syllabus({base64:Buffer.alloc(12*1024*1024+1).toString('base64')})),/12 MB/i);
});

function memoryStore(){const collections=new Map();return {async get(collection,id){return collections.get(collection)?.get(id)||null;},async all(collection){return [...(collections.get(collection)?.values()||[])];},async put(collection,id,value){if(!collections.has(collection))collections.set(collection,new Map());collections.get(collection).set(id,structuredClone(value));},async delete(collection,id){collections.get(collection)?.delete(id);}};}
const deadline={kind:'assignment',title:'Economics research deck',date:'2027-03-01',time:'17:00',start:'2027-03-01T22:00:00Z',end:'2027-03-01T22:01:00Z',location:'Canvas',evidence:'Research deck due March 1, 2027 at 5 pm.',evidenceVerified:true,status:'approved'};

test('website photo extraction uses the selected term and stages deadlines for review without adding class meetings',async()=>{
  const store=memoryStore(),calls=[];
  const result=await processSyllabusUpload(store,syllabus(),{read:async input=>{calls.push(input);return {text:deadline.evidence,method:'Tesseract OCR'};},extract:async(...args)=>{calls.push(args);return {events:[deadline,{...deadline,kind:'class',title:'Unrequested lecture'}],method:'private model',metrics:{ms:12}};}});
  assert.equal(calls[0].mimeType,'image/png');assert.equal(calls[0].term,'SP27');assert.deepEqual(calls[0].buffer,png);
  assert.equal(calls[1][0],deadline.evidence);assert.equal(calls[1][1],'syllabus');assert.deepEqual(calls[1][3],{deadlinesOnly:true,academicTerm:'Spring 2027'});
  assert.equal(result.count,1);assert.match(result.method,/OCR/);const events=await store.all('events');assert.equal(events.length,1);assert.equal(events[0].kind,'assignment');assert.equal(events[0].status,'review');assert.equal(events[0].googleId,undefined);assert.deepEqual(await store.all('reminders'),[]);
});

test('independent syllabus photos with the same camera filename coexist and retrying one does not duplicate deadlines',async()=>{
  const store=memoryStore(),second=Buffer.from(png);second[second.length-1]^=1;
  const deps={read:async()=>({text:deadline.evidence,method:'OCR'}),extract:async()=>({events:[deadline],method:'private model'})};
  await processSyllabusUpload(store,syllabus({name:'image.jpg'}),deps);
  await processSyllabusUpload(store,syllabus({name:'image.jpg',base64:second.toString('base64')}),deps);
  await processSyllabusUpload(store,syllabus({name:'image.jpg'}),deps);
  const events=await store.all('events');assert.equal(events.length,2);assert.equal(new Set(events.map(event=>event.sourceId)).size,2);assert.equal(events.some(event=>event.cancelled),false);assert.equal((await store.all('sources')).length,2);
});

test('syllabus OCR and extraction failures expose safe codes and never leave partial event records',async()=>{
  const store=memoryStore(),privateFailure=new Error('/Users/private/SECRET_SOURCE_BYTES');
  await assert.rejects(processSyllabusUpload(store,syllabus(),{read:async()=>{throw privateFailure;}}),error=>error.code==='SYLLABUS_OCR_FAILED'&&!error.message.includes('SECRET_SOURCE_BYTES'));
  await assert.rejects(processSyllabusUpload(store,syllabus(),{read:async()=>({text:deadline.evidence,method:'OCR'}),extract:async()=>{throw privateFailure;}}),error=>error.code==='SYLLABUS_EXTRACTION_FAILED'&&!error.message.includes('SECRET_SOURCE_BYTES'));
  assert.deepEqual(await store.all('events'),[]);assert.deepEqual(await store.all('sources'),[]);
});

test('re-uploading a legacy PDF preserves its class meetings while reconciling changed deadlines',async()=>{
  const store=memoryStore(),name='legacy-syllabus.pdf',sourceId=idFor('syllabus',name);
  await persistCandidates(store,{id:sourceId,name,type:'syllabus'},[{...deadline,kind:'class',title:'Existing economics lecture'},{...deadline,title:'Removed assignment'}]);
  const meeting=(await store.all('events')).find(event=>event.kind==='class');
  await store.put('events',meeting.id,{...meeting,status:'approved',googleId:'existing-calendar-event'});
  const original=structuredClone(await store.get('events',meeting.id));
  await processSyllabusUpload(store,syllabus({name,mimeType:'application/pdf',base64:Buffer.from('%PDF-1.4\nSynthetic fixture\n%%EOF').toString('base64')}),{read:async()=>({text:deadline.evidence,method:'PDF text'}),extract:async()=>({events:[deadline],method:'private model'})});
  assert.deepEqual(await store.get('events',meeting.id),original);
  assert.equal((await store.all('events')).find(event=>event.title==='Removed assignment').cancelled,true);
  assert.equal((await store.all('events')).find(event=>event.title===deadline.title).status,'review');
});

test('syllabus photo API authenticates, checks CSRF, owns queued bytes and exposes actionable safe failures',{timeout:30000},async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'brb-web-syllabus-api-')),origin='http://127.0.0.1:4377';
  // Isolate fixture processes from all personal credentials and the running pilot.
  const env={PATH:process.env.PATH,LANG:'en_US.UTF-8',NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4377',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64'),DEV_AUTH_EMAILS:'syllabus-a@cornell.edu,syllabus-b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
  let database,queue,output='';
  const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}await queue?.close();await database?.close();await rm(dir,{recursive:true,force:true});});
  let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(output);await delay(50);}assert.ok(ready,output);
  async function login(email){const response=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');return {...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json(),cookie};}
  async function api(user,route,payload,headers={}){const response=await fetch(origin+route,{method:payload===undefined?'GET':'POST',headers:{Cookie:user?.cookie||'',Origin:origin,'Content-Type':'application/json','X-CSRF-Token':user?.csrfToken||'',...headers},...(payload===undefined?{}:{body:JSON.stringify(payload)})});return {status:response.status,body:await response.json()};}
  assert.equal((await api(null,'/api/upload',syllabus())).status,401);
  const alice=await login('syllabus-a@cornell.edu'),bob=await login('syllabus-b@cornell.edu');
  assert.equal((await api(alice,'/api/upload',syllabus(),{'X-CSRF-Token':''})).status,403);
  assert.equal((await api(alice,'/api/upload',syllabus(),{'X-CSRF-Token':bob.csrfToken})).status,403);
  assert.equal((await api(alice,'/api/upload',syllabus(),{Origin:'https://attacker.example'})).status,403);
  const spoofed=await api(alice,'/api/upload',syllabus({mimeType:'image/jpeg'}));assert.ok(spoofed.status>=400&&spoofed.status<500);
  assert.equal((await api(alice,'/api/tasks')).body.length,0,'invalid or unauthorized uploads never enter the queue');
  const queued=await api(alice,'/api/upload',syllabus({userId:bob.user.id}));assert.equal(queued.status,202);assert.ok(queued.body.taskId);
  assert.deepEqual((await api(bob,'/api/tasks?id='+queued.body.taskId)).body,[]);
  const visible=(await api(alice,'/api/tasks')).body;assert.equal(visible.length,1);assert.equal(JSON.stringify(visible).includes(png.toString('base64')),false);
  database=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});queue=await createQueue(database,{workerDatabaseUrl:null});
  const claimed=await queue.claim('syllabus-test-worker',{types:['pdf']});assert.equal(claimed.id,queued.body.taskId);assert.equal(claimed.userId,alice.user.id);
  assert.deepEqual(claimed.payload,syllabus());assert.equal(claimed.payload.userId,undefined);
  assert.deepEqual(await database.forUser(bob.user.id).all('sources'),[]);assert.deepEqual(await database.forUser(bob.user.id).all('events'),[]);
  await queue.fail(claimed,{retryable:false,code:'SYLLABUS_OCR_FAILED'});
  let failed=(await api(alice,'/api/tasks?id='+claimed.id)).body[0];assert.match(failed.error,/photo|image|scan|read|clear/i);assert.doesNotMatch(failed.error,/Processing failed\. Check source|\/Users\/|stack/i);
  const second=await api(alice,'/api/upload',syllabus());assert.equal(second.status,202);const extraction=await queue.claim('syllabus-test-worker',{types:['pdf']});
  await queue.fail(extraction,{retryable:false,code:'SYLLABUS_EXTRACTION_FAILED'});
  failed=(await api(alice,'/api/tasks?id='+extraction.id)).body[0];assert.match(failed.error,/date|deadline|extract|model/i);assert.doesNotMatch(failed.error,/Processing failed\. Check source|\/Users\/|stack/i);
});
