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
import {executeResumeEnhancement} from '../lib/resume-enhancer.mjs';
import {openDatabase} from '../lib/database.mjs';

test('resume enhancer API requires authentication and CSRF and isolates requests and PDF downloads',{timeout:30000},async t=>{
 const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${reserve.address().port}`,port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const dir=await mkdtemp(path.join(tmpdir(),'brb-enhancer-api-')),encryptionKey=randomBytes(32).toString('hex');
 const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:encryptionKey,SESSION_SECRET:randomBytes(32).toString('base64url'),DEV_AUTH_EMAILS:'enhance-a@cornell.edu,enhance-b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1',GOOGLE_CLIENT_ID:'synthetic-client.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'synthetic-client-secret'};
 let output='',database;const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}if(database)await database.close();await rm(dir,{recursive:true,force:true});});
 for(let n=0;n<200&&!output.includes(`Big Red Buddy web ready: ${origin}`);n++){if(child.exitCode!==null)throw new Error(output);await delay(30);}assert.match(output,/web ready/);
 async function login(email){const response=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);const cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');return {cookie,...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json()};}
 const alice=await login('enhance-a@cornell.edu'),bob=await login('enhance-b@cornell.edu');
 const request=(endpoint,{student=alice,method='POST',value={},csrf=student?.csrfToken}={})=>fetch(origin+endpoint,{method,headers:{Origin:origin,...(student?{Cookie:student.cookie}:{}),...(method==='POST'?{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})}:{})},...(method==='POST'?{body:JSON.stringify(value)}:{})});
 database=await openDatabase({dataDir:dir,encryptionKey,databaseUrl:null,production:false,allowLocal:true});
 const a=database.forUser(alice.user.id),b=database.forUser(bob.user.id);
 for(const [returnTo,expected] of [['/#resume-enhancer/job-a','/#resume-enhancer/job-a'],['/#resume-enhancer/provider%3Ajob','/#resume-enhancer/provider%3Ajob'],['https://untrusted.example/','/'],['/#resume-enhancer/%2F%2Funtrusted.example','/']]){
  const response=await fetch(origin+'/auth/google/start?returnTo='+encodeURIComponent(returnTo),{redirect:'manual'});assert.equal(response.status,303);
  const state=new URL(response.headers.get('location')).searchParams.get('state');
  assert.equal((await database.auth.get('oauth_states',createHash('sha256').update(state).digest('hex'))).returnPath,expected);
 }
 const job={id:'job-a',title:'Growth Analyst',company:'Synthetic Company',description:'Use data analysis to analyze customer data and campaign performance. Work with stakeholders on customer acquisition and reporting.',applyUrl:'https://example.com/jobs/a'};
 await a.put('jobs',job.id,job);
 await a.put('documents','resume',{name:'Original.pdf',file:Buffer.from('%PDF-1.7\nsynthetic').toString('base64'),updatedAt:'2026-11-14T12:00:00Z',text:'SYNTHETIC STUDENT\nstudent@example.test\nEXPERIENCE\nExample Company\nOperations Analyst | January 2022 - Present\n• Analyzed customer data and campaign performance to improve customer acquisition reporting.\n• Collaborated with stakeholders to develop dashboards and weekly reports.\nEDUCATION\nExample University | Bachelor of Science | 2021'});
 const generate='/api/career/resume-enhance',select='/api/career/resume-enhancement/select',read='/api/career/resume-enhancement?jobId=job-a',download='/api/career/resume-enhancement/download?jobId=job-a&enhancementId=missing';
 for(const endpoint of [generate,select]){
  assert.equal((await request(endpoint,{student:null})).status,401);
  assert.equal((await request(endpoint,{csrf:null})).status,403);
  assert.equal((await request(endpoint,{csrf:bob.csrfToken})).status,403);
  assert.equal((await request(endpoint,{method:'GET'})).status,404);
 }
 for(const endpoint of [read,download])assert.equal((await request(endpoint,{student:null,method:'GET'})).status,401);
 for(const value of [null,[],{}, {jobId:'job-a',userId:bob.user.id}])assert.equal((await request(generate,{value})).status,400);
 let response=await request(read,{method:'GET'});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).status,'none');
 for(const [endpoint,method,value] of [[read,'GET',{}],[download,'GET',{}],[generate,'POST',{jobId:'job-a'}],[select,'POST',{jobId:'job-a',enhancementId:null}]])assert.ok([400,404,409].includes((await request(endpoint,{student:bob,method,value})).status),'another student cannot access this job');
 response=await request(generate,{value:{jobId:'job-a'}});assert.equal(response.status,202);const queued=await response.json();assert.ok(queued.taskId);assert.equal(queued.status,'queued');
 response=await request(read,{method:'GET'});const view=await response.json();assert.equal(view.status,'queued');assert.equal(view.downloadable,false);assert.equal(view.file,undefined);assert.equal(view.buffer,undefined);
 assert.ok([400,404,409].includes((await request(download,{method:'GET'})).status));
 assert.equal((await request(select,{value:{jobId:'job-a',enhancementId:null,owner:bob.user.id}})).status,400);
 assert.equal((await request(select,{value:{jobId:'job-a',enhancementId:{id:queued.id}}})).status,400);
 response=await request(select,{value:{jobId:'job-a',enhancementId:null}});assert.equal(response.status,200);assert.equal((await response.json()).selected,false);
 await executeResumeEnhancement(database,{userId:alice.user.id,payload:{jobId:'job-a',enhancementId:queued.id}},{generate:async()=>({value:{changes:[{id:'line-5',original:'Analyzed customer data and campaign performance to improve customer acquisition reporting.',suggested:'Analyzed customer data for data analysis and campaign performance to improve customer acquisition reporting.',keywords:['data analysis']}]}}),renderPDF:async()=>({file:Buffer.from('%PDF-1.7\nsynthetic enhanced PDF').toString('base64')})});
 const readyURL='/api/career/resume-enhancement/download?jobId=job-a&enhancementId='+queued.id;
 response=await request(readyURL,{method:'GET'});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/pdf');assert.equal(response.headers.get('cache-control'),'no-store');assert.match(response.headers.get('content-disposition'),/^attachment;/);assert.match(await response.text(),/^%PDF-/);
 assert.equal((await request(readyURL,{student:bob,method:'GET'})).status,404);
 response=await request(select,{value:{jobId:'job-a',enhancementId:queued.id}});assert.equal(response.status,200);assert.equal((await response.json()).selected,true);
 await a.put('documents','resume',{...await a.get('documents','resume'),updatedAt:'2026-11-15T12:00:00Z'});assert.equal((await request(readyURL,{method:'GET'})).status,409);
 assert.equal((await a.get('documents','resume')).name,'Original.pdf');assert.equal(await b.get('documents','resume'),null);
});
