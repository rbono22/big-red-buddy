import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {idFor} from '../lib/domain.mjs';
import {extractRequiredExperience,listApplicationTracker,reportApplicationSubmitted,setApplicationStatus,startApplicationTracking,trackDraftExecution,updateApplicationTracking} from '../lib/application-tracker.mjs';
import {executeApplicationDraft} from '../lib/career-jobs.mjs';
import {handleCareerMessage} from '../lib/career-telegram.mjs';

const role={id:'job-a',title:'Product Manager',company:'Example Company',location:'New York, NY',description:'Qualifications:\n3–5 years of product management experience required.\nExperience using SQL preferred.',applyUrl:'https://example.test/apply'};
const generated={value:{whyCompany:'Synthetic company answer.',relevantExperience:'Synthetic experience answer.',gaps:[],unanswered:['Work authorization']},metrics:{ms:1}};
async function setup(t){
 const dir=await mkdtemp(path.join(tmpdir(),'brf-application-tracker-'));let db,queue,a,b;const payloads=new Map();
 async function open(){db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});queue=await createQueue(db);a=db.forUser('alice');b=db.forUser('bob');const enqueue=queue.enqueue.bind(queue);queue.enqueue=async(...args)=>{const task=await enqueue(...args);if(!payloads.has(task.id))payloads.set(task.id,{userId:args[0],type:args[1],payload:structuredClone(args[2])});return task;};}
 await open();t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 await a.put('jobs',role.id,role);await b.put('jobs','job-b',{...role,id:'job-b',company:'Private other company'});await a.put('documents','resume',{name:'Resume.pdf',text:'Synthetic student resume. Worked for 50 years — this must not become posting experience.'});await a.put('secrets','telegram',{chatId:101});await b.put('secrets','telegram',{chatId:202});
 const send=(text,updateId,extra={})=>handleCareerMessage(db,queue,a,{text,chat:{id:101,type:'private'},...extra},updateId);
 return {get db(){return db;},get queue(){return queue;},get a(){return a;},get b(){return b;},send,payloads,restart:async()=>{await db.close();await open();},rows:()=>a.all('applicationTracker'),messages:()=>[...payloads.values()].filter(row=>row.type==='telegram-send').map(row=>row.payload.text)};
}
const taskFor=(row,id='task-a',extra={})=>({id,userId:'alice',type:'draft',createdAt:Date.now(),payload:{id:row.jobId,trackerId:row.id,trackerRequestId:row.requestId,replyTo:'telegram'},...extra});

test('posting experience uses explicit evidence and excludes company age, education, resume facts, and seniority inference',()=>{
 assert.match(extractRequiredExperience(role).experience,/3–5 years/);
 for(const description of ['Our company has 50 years of experience serving customers.','5 years ago we launched an experience platform.','20 years in business delivering customer experience solutions.','You must be at least 18 years of age and have some customer service experience.','4 years of education or equivalent experience.','Senior executive, generous four-year stock vesting.','We look for enthusiasm and curiosity.'])assert.deepEqual(extractRequiredExperience({description}),{experience:'Not specified',experienceEvidence:''},description);
 assert.match(extractRequiredExperience({description:'No prior experience required.'}).experience,/No prior experience required/);
 assert.match(extractRequiredExperience({description:'Qualifications:\n2 years of relevant experience preferred.'}).experience,/preferred/);
 assert.match(extractRequiredExperience({description:'Company overview collapsed.',rawSource:{content:'<h3>Qualifications</h3><ul><li>At least 3 years of engineering experience required.</li></ul>'}}).experience,/3 years/);
});

test('per-job snapshot is durable, tenant-scoped, and unchanged when the source posting is removed',async t=>{
 const s=await setup(t);const [one,two]=await Promise.all([startApplicationTracking(s.a,role,{source:'telegram',updateId:1}),startApplicationTracking(s.a,role,{source:'telegram',updateId:1})]);assert.equal(one.id,two.id);assert.equal((await s.rows()).length,1);
 await s.a.delete('jobs',role.id);await s.restart();const [row]=await listApplicationTracker(s.a,{queue:s.queue});assert.equal(row.title,role.title);assert.equal(row.location,role.location);assert.match(row.experience,/3–5 years/);
 await setApplicationStatus(s.a,{id:row.id,status:'submitted'});assert.equal((await s.rows())[0].status,'submitted');
 await assert.rejects(setApplicationStatus(s.b,{id:row.id,status:'submitted'}),error=>error.status===404);assert.equal((await listApplicationTracker(s.b)).length,0);
 await assert.rejects(startApplicationTracking(s.a,{id:'job-b'},{source:'telegram',updateId:2}),error=>error.status===404);
});

test('/apply validates a readable resume before tracking, and persists a failure when enqueue fails',async t=>{
 const s=await setup(t);await s.a.put('documents','resume',{text:'   '});await assert.rejects(s.send('/apply job-a',1),/resume first/);assert.equal((await s.rows()).length,0);
 await s.a.put('documents','resume',{text:'Readable synthetic resume.'});const enqueue=s.queue.enqueue.bind(s.queue);s.queue.enqueue=async(owner,type,...rest)=>{if(type==='draft'){const [row]=await s.rows();assert.equal(row.status,'requested');assert.equal(row.company,role.company);throw new Error('STUDENT_MODEL_QUEUE_FULL');}return enqueue(owner,type,...rest);};
 await s.send('/apply job-a',2);const [row]=await s.rows();assert.equal(row.status,'needs_attention');assert.equal(row.errorCode,'ENQUEUE_FAILED');assert.match(s.messages().at(-1),/could not be queued/);assert.equal((await s.a.all('applications')).length,0);
});

test('Telegram preparation links the durable task and completes with materials, without employer submission',async t=>{
 const s=await setup(t);await s.send('/apply job-a',10);let [row]=await s.rows();assert.equal(row.status,'queued');const task=await s.queue.claim('tracker-worker',{types:['draft']});assert.equal(task.id,row.taskId);assert.equal(task.payload.trackerId,row.id);assert.equal(task.payload.trackerRequestId,row.requestId);
 let prompt;const result=await executeApplicationDraft(s.db,task,{generate:async value=>{prompt=value;return generated;}});await s.queue.complete(task,result);[row]=await listApplicationTracker(s.a,{queue:s.queue});assert.equal(row.status,'prepared');assert.equal(row.applicationId,result.id);assert.equal(row.source,'telegram');assert.doesNotMatch(prompt,/Private other company/);
 const application=await s.a.get('applications',result.id);assert.equal(application.tracking.source,'telegram');assert.equal(application.tracking.taskId,task.id);assert.equal(application.status,'draft');assert.equal(application.submittedAt,undefined);assert.equal((await s.b.all('applications')).length,0);
});

test('worker failure stays visible after posting deletion and cannot turn an older prepared draft into current success',async t=>{
 const s=await setup(t);const tracked=await startApplicationTracking(s.a,role,{source:'telegram',updateId:1});await s.a.put('applications','old',{id:'old',jobId:role.id,title:role.title,company:role.company,answers:{whyCompany:'old'},status:'draft'});await s.a.delete('jobs',role.id);
 await assert.rejects(executeApplicationDraft(s.db,taskFor(tracked),{generate:async()=>{throw new Error('must not run');}}),/own job/);
 const [row]=await listApplicationTracker(s.a,{queue:s.queue});assert.equal(row.status,'needs_attention');assert.equal(row.title,role.title);assert.equal((await s.a.get('applications','old')).answers.whyCompany,'old');
});

test('student-reported submission and explicit correction survive delayed worker completion or failure',async t=>{
 const s=await setup(t);const row=await startApplicationTracking(s.a,role,{source:'telegram',updateId:1});let release,entered;
 const ready=new Promise(resolve=>{entered=resolve;}),work=executeApplicationDraft(s.db,taskFor(row),{generate:async()=>{entered();return new Promise(resolve=>{release=resolve;});}});await ready;
 await setApplicationStatus(s.a,{id:row.id,status:'submitted'});release(generated);await work;let [saved]=await s.rows();assert.equal(saved.status,'submitted');assert.equal(saved.preparationStatus,'prepared');assert.equal(saved.submissionSource,'student-reported');
 await setApplicationStatus(s.a,{id:row.id,status:'prepared'});await updateApplicationTracking(s.a,{id:row.id,requestId:row.requestId,status:'needs_attention',taskId:'task-a',errorCode:'LATE_FAILURE'});[saved]=await s.rows();assert.equal(saved.status,'prepared');assert.ok(saved.submissionReportedAt);assert.ok(saved.submissionCorrectedAt);
});

test('newer request wins over an in-flight old model result and old replay cannot relink its task',async t=>{
 const s=await setup(t);const first=await startApplicationTracking(s.a,role,{source:'telegram',updateId:10});let release,entered;const ready=new Promise(resolve=>{entered=resolve;}),work=executeApplicationDraft(s.db,taskFor(first,'old-task'),{generate:async()=>{entered();return new Promise(resolve=>{release=resolve;});}});await ready;
 const next=await startApplicationTracking(s.a,role,{source:'telegram',updateId:11});await executeApplicationDraft(s.db,taskFor(next,'new-task'),{generate:async()=>({...generated,value:{...generated.value,whyCompany:'New request answer'}})});release(generated);assert.deepEqual(await work,{stale:true});
 assert.equal((await s.a.all('applications'))[0].answers.whyCompany,'New request answer');assert.equal((await s.rows())[0].requestId,next.requestId);assert.equal((await startApplicationTracking(s.a,role,{source:'telegram',updateId:10})).staleRequest,true);
});

test('retry of the same completed preparation preserves student-reviewed answers and sandbox status',async t=>{
 const s=await setup(t),row=await startApplicationTracking(s.a,role,{source:'telegram',updateId:1}),task=taskFor(row);const result=await executeApplicationDraft(s.db,task,{generate:async()=>generated});
 const app=await s.a.get('applications',result.id);await s.a.put('applications',app.id,{...app,answers:{...app.answers,whyCompany:'Student edited answer'},status:'sandbox-submitted'});
 await executeApplicationDraft(s.db,task,{generate:async()=>{throw new Error('Retry must reuse prior materials');}});const after=await s.a.get('applications',app.id);assert.equal(after.answers.whyCompany,'Student edited answer');assert.equal(after.status,'sandbox-submitted');assert.equal((await s.rows())[0].status,'prepared');
});

test('unknown legacy drafts remain previous drafts and sandbox submission never becomes real submitted',async t=>{
 const s=await setup(t);await s.a.put('applications','legacy',{id:'legacy',jobId:role.id,title:'Historical role',company:'Historical company',status:'sandbox-submitted',createdAt:'2026-10-01T12:00:00Z',submittedAt:'2026-10-02T12:00:00Z'});
 let [row]=await listApplicationTracker(s.a,{queue:s.queue});assert.equal(row.source,'legacy');assert.equal(row.sourceLabel,'Previous draft');assert.equal(row.status,'prepared');assert.equal(row.submissionReportedAt,null);
 await s.queue.enqueue('bob','draft',{id:'job-b',replyTo:'telegram'});[row]=await listApplicationTracker(s.a,{queue:s.queue});assert.equal(row.source,'legacy');assert.equal((await s.rows()).length,1);
});

test('historical task status refreshes without regressing to an older request or overriding an explicit modern request',async t=>{
 const s=await setup(t);let origins=[{taskId:'newest',jobId:role.id,source:'telegram',status:'queued',createdAt:2000}];const queue={listDraftOrigins:async()=>origins};
 let [row]=await listApplicationTracker(s.a,{queue});assert.equal(row.status,'queued');origins=[{...origins[0],status:'failed'}];[row]=await listApplicationTracker(s.a,{queue});assert.equal(row.status,'needs_attention');
 origins=[{taskId:'older',jobId:role.id,source:'telegram',status:'completed',createdAt:1000}];[row]=await listApplicationTracker(s.a,{queue});assert.equal(row.status,'needs_attention');assert.equal(row.taskId,'newest');
 const stale=await trackDraftExecution(s.a,{id:'older',createdAt:1000,payload:{id:role.id,replyTo:'telegram'}});assert.equal(stale.staleRequest,true);assert.equal((await s.rows())[0].taskId,'newest');
 const modern=await startApplicationTracking(s.a,role,{source:'web',updateId:'web-1'});assert.equal(modern.historical,false);[row]=await listApplicationTracker(s.a,{queue});assert.equal(row.requestId,modern.requestId);assert.equal(row.status,'requested');assert.ok(row.sources.includes('web'));
});

test('/applied accepts closed or removed tracked postings, and an owned direct self-report needs no resume',async t=>{
 const s=await setup(t);await s.send('/apply job-a',1);await s.a.delete('jobs',role.id);await s.send('/applied job-a',2);assert.equal((await s.rows())[0].status,'submitted');assert.match(s.messages().at(-1),/student-reported/);assert.match(s.messages().at(-1),/has not verified employer receipt/);
 await s.a.put('jobs','closed',{...role,id:'closed',closed:true});await s.a.delete('documents','resume');await s.send('/applied closed',3);assert.equal((await s.rows()).find(row=>row.jobId==='closed').preparationStatus,null);
 await assert.rejects(s.send('/applied job-b',4),error=>error.status===404);assert.equal((await s.b.all('applicationTracker')).length,0);
});

test('tracker commands pass an active optional questionnaire without consuming sensitive replies',async t=>{
 const s=await setup(t);await s.a.put('career','demographics',{questionnaire:{active:{field:'race',token:'private-token'}}});await s.send('/applications',1);assert.match(s.messages().at(-1),/No applications are tracked/);await s.send('/applied job-a',2);assert.equal((await s.rows())[0].status,'submitted');
 const replies=s.messages().join('\n');assert.doesNotMatch(replies,/private-token/);assert.equal((await s.a.get('career','demographics')).questionnaire.active.field,'race');
});

test('explicit web provenance remains web, while a generic untagged draft does not gain Telegram attribution',async t=>{
 const s=await setup(t),row=await startApplicationTracking(s.a,role,{source:'web',updateId:'web-route'});const task=taskFor(row,'web-task');delete task.payload.replyTo;await executeApplicationDraft(s.db,task,{generate:async()=>generated});assert.equal((await s.a.all('applications'))[0].tracking.source,'web');assert.equal((await listApplicationTracker(s.a,{queue:s.queue}))[0].source,'web');
 await s.b.put('documents','resume',{text:'Other synthetic resume.'});await executeApplicationDraft(s.db,{id:'untagged-task',userId:'bob',type:'draft',payload:{id:'job-b'}},{generate:async()=>generated});assert.equal((await listApplicationTracker(s.b,{queue:s.queue}))[0].source,'legacy');
});

test('terminal queue failure after a worker crash is reconciled for the exact current web or Telegram request',async t=>{
 for(const source of ['web','telegram']){
  const s=await setup(t),row=await startApplicationTracking(s.a,role,{source,updateId:1}),task=await s.queue.enqueue('alice','draft',{id:role.id,...(source==='telegram'?{replyTo:'telegram'}:{})},{retrySafe:true});
  await updateApplicationTracking(s.a,{id:row.id,requestId:row.requestId,status:'queued',taskId:task.id});const claimed=await s.queue.claim('crashed-worker',{types:['draft']});await s.queue.fail(claimed,{code:'LEASE_EXPIRED',retryable:false});
  if(source==='telegram')await setApplicationStatus(s.a,{id:row.id,status:'submitted'});
  const [after]=await listApplicationTracker(s.a,{queue:s.queue});assert.equal(after.preparationStatus,'needs_attention');assert.equal(after.errorCode,'WORKER_TASK_FAILED');assert.equal(after.status,source==='telegram'?'submitted':'needs_attention');
 }
});

test('queue reconciliation cannot downgrade prepared materials or a newer request started during the read',async t=>{
 const s=await setup(t),old=await startApplicationTracking(s.a,role,{source:'web',updateId:'old'});await updateApplicationTracking(s.a,{id:old.id,requestId:old.requestId,status:'queued',taskId:'old-task'});
 let next;const queue={async get(){next=await startApplicationTracking(s.a,role,{source:'web',updateId:'new'});return {id:'old-task',status:'failed'};}};
 let [row]=await listApplicationTracker(s.a,{queue});assert.equal(row.requestId,next.requestId);assert.equal(row.status,'requested');
 await updateApplicationTracking(s.a,{id:row.id,requestId:row.requestId,status:'prepared',taskId:'new-task',applicationId:'prepared-app'});
 [row]=await listApplicationTracker(s.a,{queue:{get:async()=>{throw new Error('Prepared materials should not be downgraded from queue state');}}});assert.equal(row.status,'prepared');
});
