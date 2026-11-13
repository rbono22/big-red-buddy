import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes,createHash} from 'node:crypto';
import {openDatabase} from '../lib/database.mjs';
import {getCareerProfile,saveCareerProfile} from '../lib/career.mjs';
import {saveApplicationAnswerMemory} from '../lib/application-answer-memory.mjs';

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
test('browser handoff and saved-answer APIs require session/CSRF and keep private contents in the owning tenant',{timeout:30000},async t=>{
 const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port,origin=`http://127.0.0.1:${port}`;await new Promise(resolve=>reserve.close(resolve));
 const dir=await mkdtemp(path.join(tmpdir(),'brb-handoff-api-')),encryptionKey=randomBytes(32).toString('hex');
 const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:encryptionKey,SESSION_SECRET:randomBytes(32).toString('base64url'),DEV_AUTH_EMAILS:'handoff-a@cornell.edu,handoff-b@cornell.edu',GOOGLE_CLIENT_ID:'fixture.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'synthetic-secret',OLLAMA_URL:'http://127.0.0.1:1'};
 let output='',database;const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}if(database)await database.close();await rm(dir,{recursive:true,force:true});});
 for(let n=0;n<150&&!output.includes(`Big Red Buddy web ready: ${origin}`);n++){if(child.exitCode!==null)throw new Error(output);await delay(30);}assert.match(output,/web ready/);
 for(const method of ['GET','HEAD']){
  const response=await fetch(origin+'/browser-helper.zip',{method});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/zip');assert.equal(response.headers.get('content-disposition'),'attachment; filename="BRB-browser-helper.zip"');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  const bytes=Buffer.from(await response.arrayBuffer());if(method==='GET'){assert.equal(bytes.subarray(0,4).toString('hex'),'504b0304');assert.ok(bytes.length>100);}else assert.equal(bytes.length,0);
 }
 async function login(email){const response=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);const cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');const session=await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json();return {cookie,...session};}
 const alice=await login('handoff-a@cornell.edu'),bob=await login('handoff-b@cornell.edu');
 const request=(endpoint,{student=alice,method='GET',value,csrf=student?.csrfToken}={})=>fetch(origin+endpoint,{method,headers:{Origin:origin,...(student?{Cookie:student.cookie}:{}),...(method==='POST'?{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})}:{})},...(method==='POST'?{body:JSON.stringify(value??{})}:{})});
 database=await openDatabase({dataDir:dir,encryptionKey,databaseUrl:null,production:false,allowLocal:true});const store=database.forUser(alice.user.id);
 for(const destination of ['/#application-handoff/fixture-application','//outside.example/','https://outside.example/','/#application-handoff/bad?next=elsewhere']){
  const response=await fetch(origin+'/auth/google/start?returnTo='+encodeURIComponent(destination),{redirect:'manual'});assert.equal(response.status,303);
  const oauthState=new URL(response.headers.get('location')).searchParams.get('state'),pending=await database.auth.get('oauth_states',hash(oauthState));assert.equal(pending.returnPath,destination==='/#application-handoff/fixture-application'?destination:'/');
 }
 const url='https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply',file=Buffer.from('%PDF-1.7\nsynthetic resume').toString('base64');
 await saveCareerProfile(store,{fullName:'Synthetic Student',email:'synthetic@example.edu'});
 await store.put('documents','resume',{name:'Resume.pdf',file,text:'Synthetic student built an internal reporting tool.'});
 await store.put('secrets','telegram',{chatId:123,linkedAt:'fixture-link'});
 const job={id:'fixture-job',title:'Analyst',company:'Example',applyUrl:url,description:'Build internal reporting tools for the product team.'};await store.put('jobs',job.id,job);
 await store.put('liveApplications','fixture-application',{id:'fixture-application',jobId:job.id,title:job.title,company:job.company,url,provider:'lever',revision:3,status:'collecting',chatId:'123',linkedAt:'fixture-link',resumeHash:hash(file),profileHash:hash(await getCareerProfile(store)),form:{fields:[{key:'name',label:'Full name',controlName:'name',type:'text',required:true}]},answers:{name:{value:'PRIVATE_OWNER_ANSWER',reviewed:true}}});
 const saved=await saveApplicationAnswerMemory(store,{field:{key:'experience',label:'Describe a project you built',type:'textarea'},job,value:'I built an internal reporting tool.',source:'student'});
 for(const endpoint of ['/api/career/saved-answers','/api/career/application-handoff','/api/career/application-handoff/redeem','/api/career/saved-answers/delete']){
  const method=endpoint.endsWith('saved-answers')?'GET':'POST';assert.equal((await request(endpoint,{student:null,method})).status,401,endpoint);
  if(method==='POST'){assert.equal((await request(endpoint,{method,csrf:null})).status,403,endpoint);assert.equal((await request(endpoint,{method,csrf:bob.csrfToken})).status,403,endpoint);assert.equal((await request(endpoint)).status,404,endpoint);}
 }
 let response=await request('/api/career/saved-answers');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const list=await response.json();assert.equal(list.answers.length,1);assert.equal(list.answers[0].question,saved.question);assert.equal(list.answers[0].value,saved.value);
 response=await request('/api/career/saved-answers',{student:bob});assert.deepEqual(await response.json(),{answers:[]});
 response=await request('/api/state');const state=await response.json();assert.equal(state.savedApplicationAnswers.length,1);assert.doesNotMatch(JSON.stringify(state),/PRIVATE_OWNER_ANSWER|applicationHandoffs|resumeBinding/);
 assert.equal((await request('/api/career/saved-answers/delete',{student:bob,method:'POST',value:{id:saved.id}})).status,404);
 assert.equal((await request('/api/career/application-handoff',{student:bob,method:'POST',value:{applicationId:'fixture-application'}})).status,409);
 assert.equal((await request('/api/career/application-handoff',{method:'POST',value:{applicationId:'fixture-application',revision:2}})).status,409);
 assert.equal((await request('/api/career/application-handoff',{method:'POST',value:{applicationId:'fixture-application',userId:bob.user.id}})).status,400);
 response=await request('/api/career/application-handoff',{method:'POST',value:{applicationId:'fixture-application',revision:3}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const {handoff}=await response.json();assert.match(handoff.token,/^[a-f0-9]{64}$/);
 assert.equal((await request('/api/career/application-handoff/redeem',{student:bob,method:'POST',value:{token:handoff.token}})).status,409);
 assert.equal((await request('/api/career/application-handoff/redeem',{method:'POST',csrf:null,value:{token:handoff.token}})).status,403);
 response=await request('/api/career/application-handoff/redeem',{method:'POST',value:{token:handoff.token}});assert.equal(response.status,200);assert.equal((await response.json()).handoff.answers.name.value,'PRIVATE_OWNER_ANSWER');
 assert.equal((await request('/api/career/application-handoff/redeem',{method:'POST',value:{token:handoff.token}})).status,409);
 response=await request('/api/career/saved-answers/delete',{method:'POST',value:{id:saved.id}});assert.equal(response.status,200);assert.deepEqual(await response.json(),{deleted:true,id:saved.id});assert.deepEqual(await(await request('/api/career/saved-answers')).json(),{answers:[]});
});
