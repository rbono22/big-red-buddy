import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {PassThrough} from 'node:stream';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createJsonBodyReader,JSON_BODY_LIMITS,jsonBodyPolicy,safeError} from '../lib/security.mjs';

function input(url='/api/settings',headers={}) {
  const stream=new PassThrough();stream.url=url;stream.headers={'content-type':'application/json',...headers};return stream;
}
async function json(reader,url,value,owner='student-a') {
  const req=input(url),pending=reader(req,{owner});req.end(JSON.stringify(value));return pending;
}
const rejected=(status,code)=>error=>error.status===status&&error.code===code&&error.closeConnection===true;

test('ordinary actions have a small body budget; explicit imports retain their format budgets',()=>{
  assert.equal(jsonBodyPolicy('/api/settings').maxBytes,64*1024);
  assert.equal(jsonBodyPolicy('/api/chat').maxBytes,64*1024);
  assert.equal(jsonBodyPolicy('/api/upload').maxBytes,17*1024*1024);
  assert.equal(jsonBodyPolicy('/api/enrollment/analyze').maxBytes,17*1024*1024);
  assert.equal(jsonBodyPolicy('/api/career/linkedin/import').maxBytes,17*1024*1024);
  assert.equal(jsonBodyPolicy('/api/events/review').maxBytes,4*1024*1024);
  assert.equal(jsonBodyPolicy('/api/events/import-ics').maxBytes,8*1024*1024);
  assert.equal(jsonBodyPolicy('/api/news/import').maxBytes,768*1024);
  assert.equal(jsonBodyPolicy('/api/upload/not-an-upload').maxBytes,64*1024);
});

test('oversized declared bodies and unsupported representations are rejected before buffering',async()=>{
  const read=createJsonBodyReader();
  for(const headers of [{'content-length':String(JSON_BODY_LIMITS.standard+1)},{'content-length':'999999999999999999999'}]){
    const req=input('/api/settings',headers);await assert.rejects(read(req),rejected(413,'request_body_too_large'));assert.equal(req.listenerCount('data'),0);req.destroy();
  }
  for(const headers of [{'content-type':'application/jsonp'},{'content-type':'text/plain'},{'content-encoding':'gzip'}]){
    const req=input('/api/settings',headers);await assert.rejects(read(req),error=>error.status===415);req.destroy();
  }
  const badSize=input('/api/settings',{'content-length':'-1'});await assert.rejects(read(badSize),rejected(400,'invalid_content_length'));badSize.destroy();
  assert.deepEqual(await json(read,'/api/settings',{paused:true}),{paused:true});
});

test('chunked limits count bytes and never forward partial JSON',async()=>{
  const read=createJsonBodyReader(),req=input('/api/settings'),pending=read(req),failure=assert.rejects(pending,rejected(413,'request_body_too_large'));
  req.write('{"name":"');req.write('💡'.repeat(JSON_BODY_LIMITS.standard/3));req.end('"}');await failure;
  assert.equal(req.listenerCount('data'),0);
  assert.deepEqual(await json(read,'/api/settings',{name:'A valid name'}),{name:'A valid name'});
});

test('a full 12MB base64 document stays accepted without increasing ordinary action budgets',async()=>{
  const read=createJsonBodyReader(),raw=Buffer.alloc(12*1024*1024,32);raw.write('%PDF-1.4\n');
  const result=await json(read,'/api/upload',{type:'syllabus',name:'synthetic.pdf',mimeType:'application/pdf',base64:raw.toString('base64')});
  assert.equal(Buffer.from(result.base64,'base64').length,12*1024*1024);
  assert.equal(result.base64,raw.toString('base64'));
});

test('per-student upload admission and separate small-request lanes release after aborts',async()=>{
  const read=createJsonBodyReader({uploadTimeoutMs:1000});
  const waiting=[];
  for(const owner of ['a','b','c']){const req=input('/api/upload'),promise=read(req,{owner});promise.catch(()=>{});waiting.push({req,promise});}
  for(const owner of ['a','d']){const req=input('/api/upload');await assert.rejects(read(req,{owner}),rejected(429,'request_body_busy'));req.destroy();}
  assert.deepEqual(await json(read,'/api/settings',{paused:false},'a'),{paused:false});
  waiting[0].req.destroy();await assert.rejects(waiting[0].promise,rejected(400,'incomplete_request_body'));
  assert.deepEqual(await json(read,'/api/upload',{name:'replacement upload'},'d'),{name:'replacement upload'});
  for(const {req,promise} of waiting.slice(1)){req.destroy();await assert.rejects(promise,rejected(400,'incomplete_request_body'));}
});

test('wall-clock body deadline stops slow trickles and frees admission immediately',async()=>{
  const read=createJsonBodyReader({uploadTimeoutMs:60,standardTimeoutMs:60}),req=input('/api/upload'),promise=read(req,{owner:'a'});
  const failure=assert.rejects(promise,rejected(408,'request_body_timeout'));
  req.write('{"text":"');const trickle=setInterval(()=>req.write('a'),10);
  try{await failure;}finally{clearInterval(trickle);req.destroy();}
  assert.deepEqual(await json(read,'/api/upload',{name:'retry'},'a'),{name:'retry'});
});

test('invalid JSON and premature request errors release slots without exposing raw errors',async()=>{
  const read=createJsonBodyReader();
  for(const text of ['[]','null','{']){
    const req=input('/api/upload'),promise=read(req,{owner:'a'});req.end(text);await assert.rejects(promise,rejected(400,'invalid_json'));
  }
  const req=input('/api/upload'),promise=read(req,{owner:'a'});req.destroy(new Error('private transport information'));
  await assert.rejects(promise,error=>{assert.doesNotMatch(error.message,/private transport/);return rejected(400,'incomplete_request_body')(error);});
  assert.deepEqual(await json(read,'/api/upload',{},'a'),{});
});

async function listen(server){await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${server.address().port}`;}

test('HTTP slow-body errors return408 and close the socket; chunked413 and later healthy requests work',async t=>{
  const read=createJsonBodyReader({standardTimeoutMs:80,uploadTimeoutMs:80});
  const server=http.createServer((req,res)=>void read(req).then(value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));}).catch(error=>{
    const result=safeError(error);res.shouldKeepAlive=false;res.setHeader('Connection','close');res.once('finish',()=>req.destroy());res.writeHead(result.status,{'Content-Type':'application/json'});res.end(JSON.stringify(result.body));
  }));
  const origin=await listen(server);t.after(()=>{server.closeAllConnections();server.close();});
  async function partial(path,chunks){
    let request;
    const response=new Promise((resolve,reject)=>{request=http.request(origin+path,{method:'POST',headers:{'Content-Type':'application/json'}},res=>{let text='';res.on('data',data=>text+=data);res.on('end',()=>resolve({status:res.statusCode,connection:res.headers.connection,body:JSON.parse(text)}));});request.on('error',reject);});
    chunks.forEach(chunk=>request.write(chunk));
    const result=await response;request.destroy();return result;
  }
  const slow=await partial('/api/settings',['{']);assert.equal(slow.status,408);assert.equal(slow.connection,'close');
  const huge=await partial('/api/settings',['{"name":"','x'.repeat(70*1024)]);assert.equal(huge.status,413);assert.equal(huge.connection,'close');
  const response=await fetch(origin+'/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"paused":true}'});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{paused:true});
});

test('authenticated app rejects large settings before writes and keeps the full supported upload size',{timeout:30000},async t=>{
  const reserve=http.createServer(),origin=await listen(reserve),port=new URL(origin).port;await new Promise(resolve=>reserve.close(resolve));
  const dir=await mkdtemp(path.join(tmpdir(),'brb-body-api-'));
  const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:port,APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64url'),DEV_AUTH_EMAILS:'body-fixture@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
  let output='';const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exit=once(child,'exit');child.kill('SIGTERM');await exit;}await rm(dir,{recursive:true,force:true});});
  for(let i=0;i<100&&!output.includes(`Big Red Buddy web ready: ${origin}`);i++){if(child.exitCode!==null)throw new Error(output);await delay(30);}
  assert.match(output,/web ready/);
  const login=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:'body-fixture@cornell.edu'})});assert.equal(login.status,200);
  const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const session=await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json();
  const headers={Origin:origin,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrfToken};
  let response=await fetch(origin+'/api/settings',{method:'POST',headers,body:JSON.stringify({name:'x'.repeat(70*1024)})});
  assert.equal(response.status,413);assert.equal((await response.json()).code,'request_body_too_large');
  response=await fetch(origin+'/api/settings',{method:'POST',headers,body:'{"name":"Synthetic safe student"}'});assert.equal(response.status,200);
  const raw=Buffer.alloc(12*1024*1024,32);raw.write('%PDF-1.4\n');
  // Queue admission only: no worker/OCR/model/provider is started by this fixture.
  response=await fetch(origin+'/api/upload',{method:'POST',headers,body:JSON.stringify({type:'resume',name:'synthetic.pdf',base64:raw.toString('base64')})});assert.equal(response.status,202);assert.equal(typeof(await response.json()).taskId,'string');
  const jobs=await(await fetch(origin+'/api/tasks',{headers:{Cookie:cookie}})).json();assert.equal(jobs.length,1);assert.equal(jobs[0].label,'pdf');
});
