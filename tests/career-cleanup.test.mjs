import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {idFor} from '../lib/domain.mjs';
import {previewCareerCleanup,performCareerCleanup,listVisibleJobs,listVisibleDraftApplications,isCareerJobRemoved} from '../lib/career-cleanup.mjs';
import {listApplicationTracker,startApplicationTracking,trackDraftExecution} from '../lib/application-tracker.mjs';
import {listCareerJobs,setJobSaved} from '../lib/job-saves.mjs';
import {startQuickApplication,handleLiveApplicationAction,executeLiveApplication} from '../lib/live-applications.mjs';
import {canCreateApplicationHandoff} from '../lib/application-handoff.mjs';
import {executeApplicationDraft} from '../lib/career-jobs.mjs';

const url='https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply';
const role={id:'role',title:'Product Manager',company:'Example',url};
async function setup(t){
 const dir=await mkdtemp(path.join(tmpdir(),'brb-cleanup-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 const a=db.forUser('alice'),b=db.forUser('bob');
 for(const store of [a,b]){await store.put('jobs','role',role);await setJobSaved(store,{id:'role',saved:true});await store.put('documents','resume',{name:'Resume.pdf',file:'synthetic',text:'My experience'});await store.put('secrets','telegram',{chatId:'101',linkedAt:'linked'});await store.put('career','profile',{fullName:'Example Student'});await store.put('applicationAnswerMemory','remember',{id:'remember',answer:'Reusable answer'});}
 const queue={enqueue:async()=>({id:'task'})};return {db,a,b,queue};
}
async function remove(store,scope,id){const p=await previewCareerCleanup(store,{scope,...(id?{id}:{})});return performCareerCleanup(store,{token:p.token});}

test('saved and found lists reset independently and refresh cannot resurrect removed discoveries',async t=>{
 const {a,b}=await setup(t);
 await remove(a,'found','role');assert.equal(await isCareerJobRemoved(a,'role'),true);assert.deepEqual(await listVisibleJobs(a),[]);
 let jobs=await listCareerJobs(a);assert.equal(jobs.length,1);assert.equal(jobs[0].saved,true);assert.equal(jobs[0].foundRemoved,true);
 await a.put('jobs','role',{...role,title:'Fresh source title'});assert.deepEqual(await listVisibleJobs(a),[]);
 await remove(a,'saved');assert.deepEqual(await listCareerJobs(a),[]);assert.equal((await listCareerJobs(b))[0].saved,true);
 assert.equal((await a.get('documents','resume')).text,'My experience');assert.equal((await a.get('applicationAnswerMemory','remember')).answer,'Reusable answer');
});

test('archived applications stay absent after legacy history reconstruction and preserve employer receipts',async t=>{
 const {a}=await setup(t),receipt={confirmation:'Received',confirmedAt:'2026-11-14T10:00:00Z'};
 await a.put('applications','draft',{id:'draft',jobId:'role',title:role.title,createdAt:'2026-11-13T10:00:00Z'});
 await a.put('liveApplications','live',{id:'live',jobId:'role',title:role.title,status:'submitted',submitAttemptAt:'2026-11-14T09:59:00Z',receipt,revision:3});
 await remove(a,'applications','role');
 assert.deepEqual(await listApplicationTracker(a),[]);assert.deepEqual(await listVisibleDraftApplications(a),[]);
 const retained=await a.get('liveApplications','live');assert.deepEqual(retained.receipt,receipt);assert.equal(retained.status,'submitted');assert.ok(retained.removedAt);
 assert.equal((await listCareerJobs(a))[0].saved,true);
 const tracker=(await a.all('applicationTracker'))[0];assert.equal((await trackDraftExecution(a,{id:'stale',payload:{id:'role',replyTo:'telegram'},createdAt:Date.now()})).staleRequest,true);
 assert.ok((await a.get('applicationTracker',tracker.id)).removedAt);
});

test('preview tokens are owner-scoped, expire, cannot replay, and never remove jobs arriving afterwards',async t=>{
 const {a,b}=await setup(t),p=await previewCareerCleanup(a,{scope:'found'});
 await assert.rejects(()=>performCareerCleanup(b,{token:p.token}),/expired/);
 await a.put('jobs','new',{...role,id:'new'});await performCareerCleanup(a,{token:p.token});assert.deepEqual((await listVisibleJobs(a)).map(row=>row.id),['new']);
 await assert.rejects(()=>performCareerCleanup(a,{token:p.token}),/already used/);
 const expired=await previewCareerCleanup(a,{scope:'saved'},{now:()=>100});await assert.rejects(()=>performCareerCleanup(a,{token:expired.token},{now:()=>600101}),/expired/);
 await assert.rejects(()=>previewCareerCleanup(a,{scope:'found',id:'not-owned'}),/not in your/);
});

test('active work blocks removal and changed rows invalidate confirmation without partial writes',async t=>{
 const {a}=await setup(t);await a.put('liveApplications','active',{id:'active',jobId:'role',title:role.title,status:'submitting',revision:1});
 let p=await previewCareerCleanup(a,{scope:'all'});assert.equal(p.canConfirm,false);assert.equal(p.blocked.length,1);
 await assert.rejects(()=>performCareerCleanup(a,{token:p.token}),/processing/);assert.equal((await a.get('jobSaves','role')).saved,true);
 await a.put('liveApplications','active',{id:'active',jobId:'role',title:role.title,status:'ready',revision:2});p=await previewCareerCleanup(a,{scope:'all'});
 await a.put('liveApplications','active',{id:'active',jobId:'role',title:role.title,status:'queued',revision:3});
 await assert.rejects(()=>performCareerCleanup(a,{token:p.token}),/changed/);assert.equal(await isCareerJobRemoved(a,'role'),false);assert.equal((await a.get('jobSaves','role')).saved,true);
});

test('atomic cleanup rolls back everything when application changes at commit',async t=>{
 const {a}=await setup(t);await a.put('liveApplications','active',{id:'active',jobId:'role',status:'ready',revision:1});const p=await previewCareerCleanup(a,{scope:'all'}),commit=a.compareAndSetMany;
 a.compareAndSetMany=async(changes,guards)=>{await a.put('liveApplications','active',{id:'active',jobId:'role',status:'queued',revision:2});return commit(changes,guards);};
 await assert.rejects(()=>performCareerCleanup(a,{token:p.token}),/changed/);assert.equal((await a.get('jobSaves','role')).saved,true);assert.equal(await isCareerJobRemoved(a,'role'),false);assert.equal((await a.get('careerCleanupPreviews',p.token)).usedAt,null);
});

test('removed application rejects stale actions, handoff and queued work, while retaining uncertain duplicate guard',async t=>{
 const {a,db,queue}=await setup(t),id=idFor('lever-application',url),record={id,jobId:'role',url,provider:'lever',title:role.title,status:'uncertain',submitAttemptAt:'2026-11-14T10:00:00Z',revision:1,chatId:'101',linkedAt:'linked'};
 await a.put('liveApplications',id,record);await remove(a,'applications');
 await assert.rejects(()=>handleLiveApplicationAction(a,queue,{id,revision:1,op:'submit'},'old'),/not available/);
 assert.equal(await canCreateApplicationHandoff(a,{applicationId:id}),false);
 assert.deepEqual(await executeLiveApplication(db,{userId:'alice',type:'application-submit',payload:{applicationId:id,revision:1}},{queue}),{stale:true});
 const previous=process.env.APPLICATION_BROWSER_ENABLED;process.env.APPLICATION_BROWSER_ENABLED='true';t.after(()=>{if(previous===undefined)delete process.env.APPLICATION_BROWSER_ENABLED;else process.env.APPLICATION_BROWSER_ENABLED=previous;});
 await assert.rejects(()=>startQuickApplication(a,queue,'role',1),/submission record/);assert.equal((await a.get('liveApplications',id)).status,'uncertain');
});

test('a new explicit preparation can re-add an archived unsent tracker',async t=>{
 const {a}=await setup(t);await a.put('applications','draft',{id:'draft',jobId:'role',title:role.title,createdAt:'2026-11-13T10:00:00Z'});await remove(a,'applications');
 const next=await startApplicationTracking(a,role,{source:'web'});assert.equal(next.removedAt,null);assert.equal((await listApplicationTracker(a)).length,1);
});

test('new explicit live application keeps increasing revisions and old buttons stay invalid',async t=>{
 const {a,queue}=await setup(t),id=idFor('lever-application',url);
 const previous=process.env.APPLICATION_BROWSER_ENABLED;process.env.APPLICATION_BROWSER_ENABLED='true';t.after(()=>{if(previous===undefined)delete process.env.APPLICATION_BROWSER_ENABLED;else process.env.APPLICATION_BROWSER_ENABLED=previous;});
 await a.put('liveApplications',id,{id,jobId:'role',url,provider:'lever',title:role.title,status:'ready',revision:8,chatId:'101',linkedAt:'linked'});
 await a.put('settings','liveApplicationFlow',{id,revision:8,field:0});await remove(a,'applications');
 assert.deepEqual(await a.get('settings','liveApplicationFlow'),{});assert.equal((await a.get('liveApplications',id)).revision,9);
 await startQuickApplication(a,queue,'role','fresh');const latest=await a.get('liveApplications',id);assert.equal(latest.revision,10);assert.equal(latest.removedAt,undefined);assert.equal(latest.status,'inspecting');
 await assert.rejects(()=>handleLiveApplicationAction(a,queue,{id,revision:8,op:'submit'},'old'),/changed/);
 assert.equal((await listApplicationTracker(a)).length,1);
});

test('atomic removal detects a newly created application even when no existing row changed',async t=>{
 const {a}=await setup(t);await a.put('applications','draft',{id:'draft',jobId:'role',title:role.title,createdAt:'2026-11-13T10:00:00Z'});
 const p=await previewCareerCleanup(a,{scope:'all'}),commit=a.compareAndSetMany;
 a.compareAndSetMany=async(changes,guards)=>{await a.put('liveApplications','new',{id:'new',jobId:'role',status:'queued',revision:1});return commit(changes,guards);};
 await assert.rejects(()=>performCareerCleanup(a,{token:p.token}),/changed/);assert.equal((await a.get('jobSaves','role')).saved,true);assert.equal((await a.get('applications','draft')).removedAt,undefined);
});

test('an untracked legacy draft finishing after removal cannot recreate the removed materials',async t=>{
 const {a,db}=await setup(t),id=idFor('application','role');await a.put('applications',id,{id,jobId:'role',title:role.title,createdAt:'2026-11-13T10:00:00Z'});
 let entered,release;const ready=new Promise(resolve=>{entered=resolve;});
 const work=executeApplicationDraft(db,{id:'legacy-task',userId:'alice',payload:{id:'role'}},{generate:async()=>{entered();return new Promise(resolve=>{release=resolve;});}});await ready;
 await remove(a,'applications');release({value:{whyCompany:'Example',relevantExperience:'Example',gaps:[],unanswered:[]},metrics:{}});
 assert.deepEqual(await work,{stale:true});assert.deepEqual(await listVisibleDraftApplications(a),[]);
});
