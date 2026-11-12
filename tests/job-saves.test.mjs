import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {setJobSaved,listCareerJobs} from '../lib/job-saves.mjs';
import {sourceJobDisplayFacts,jobDisplayFacts} from '../lib/job-display.mjs';
import {refreshJobBoard} from '../lib/job-discovery.mjs';

async function setup(t){
 const dir=await mkdtemp(path.join(tmpdir(),'brb-job-saves-')),options={dataDir:dir,databaseUrl:null,production:false};let db=await openDatabase(options);
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 return {get db(){return db;},async reopen(){await db.close();db=await openDatabase(options);return db;},a:db.forUser('student-a'),b:db.forUser('student-b')};
}
const fixture={id:'shared-job',title:'Product Manager',company:'Example',status:'discovered',salary:null,provider:'ashby',rawSource:{employmentType:'FullTime',workplaceType:'Hybrid',isRemote:true},publishedAt:'2026-11-10T12:00:00Z',publicationTimeVerified:true};
const at='2026-11-11T12:00:00.000Z';

test('saving is private, durable and independent of application stages and posting fields',async t=>{
 const s=await setup(t);await s.a.put('jobs',fixture.id,fixture);await s.b.put('jobs',fixture.id,{...fixture,title:'PRIVATE_OTHER_TITLE'});
 const application={id:'application',jobId:fixture.id,status:'reviewed',answers:{whyCompany:'Reviewed answer'}};await s.a.put('applications',application.id,application);
 assert.deepEqual(await setJobSaved(s.a,{id:fixture.id,saved:true},{now:()=>at}),{id:fixture.id,saved:true,savedAt:at});
 assert.deepEqual(await setJobSaved(s.a,{id:fixture.id,saved:true},{now:()=>{throw new Error('Idempotent save should retain timestamp');}}),{id:fixture.id,saved:true,savedAt:at});
 assert.deepEqual(await s.a.get('jobs',fixture.id),fixture);assert.deepEqual(await s.a.get('applications',application.id),application);
 let [job]=await listCareerJobs(s.a);assert.equal(job.saved,true);assert.equal(job.savedAt,at);assert.equal(job.workplaceType,'hybrid');assert.equal(job.employmentType,'full-time');assert.doesNotMatch(JSON.stringify(job),/PRIVATE_OTHER/);
 assert.equal((await listCareerJobs(s.b))[0].saved,false);assert.equal(await s.b.get('jobSaves',fixture.id),null);
 const db=await s.reopen(),store=db.forUser('student-a');assert.equal((await listCareerJobs(store))[0].saved,true);
 assert.deepEqual(await setJobSaved(store,{id:fixture.id,saved:false}),{id:fixture.id,saved:false,savedAt:null});assert.equal((await listCareerJobs(store))[0].saved,false);assert.deepEqual(await store.get('applications',application.id),application);
});

test('save accepts only an owned ID and explicit boolean with no extra ownership/status fields',async t=>{
 const {a,b}=await setup(t);await a.put('jobs','owned',{...fixture,id:'owned'});await b.put('jobs','foreign',{...fixture,id:'foreign'});
 await assert.rejects(setJobSaved({}, {id:'owned',saved:true}),{status:401});
 for(const input of [null,[],{}, {id:'owned'}, {id:'owned',saved:'true'}, {id:'owned',saved:1}, {id:'owned',saved:true,userId:b.userId}, {id:'owned',saved:true,status:'submitted'}, {id:'../foreign',saved:true}, {id:'x'.repeat(201),saved:true}])await assert.rejects(setJobSaved(a,input),{status:400});
 await assert.rejects(setJobSaved(a,{id:'foreign',saved:true}),{status:404});assert.deepEqual(await a.all('jobSaves'),[]);assert.deepEqual(await b.all('jobSaves'),[]);
 await a.put('settings','account',{deleting:true});await assert.rejects(setJobSaved(a,{id:'owned',saved:true}),{status:409});assert.deepEqual(await a.all('jobSaves'),[]);
});

test('a save conflict retries its own record without overwriting current job or application updates',async t=>{
 const {a}=await setup(t);await a.put('jobs',fixture.id,fixture);let raced=false,attempts=0;
 const store={...a,async compareAndSet(bucket,id,previous,next){attempts++;if(!raced){raced=true;await a.put('jobSaves',id,{id,saved:false,savedAt:null,updatedAt:'2026-11-11T11:00:00Z'});await a.put('jobs',id,{...fixture,title:'Updated source title',closed:true,status:'closed'});await a.put('applications','application',{id:'application',jobId:id,status:'reviewed'});}return a.compareAndSet(bucket,id,previous,next);}};
 assert.equal((await setJobSaved(store,{id:fixture.id,saved:true},{now:()=>at})).saved,true);assert.equal(attempts,2);
 assert.equal((await a.get('jobs',fixture.id)).status,'closed');assert.equal((await a.get('applications','application')).status,'reviewed');assert.equal((await listCareerJobs(a))[0].saved,true);
});

test('bookmark changes survive an in-flight source refresh, closing and reopening a posting',async t=>{
 const {a}=await setup(t);await a.put('settings','profile',{jobTitles:'Product Manager',paused:true});
 const row={id:'one',title:'Product Manager',jobUrl:'https://jobs.ashbyhq.com/example/one',location:'New York',descriptionPlain:'Product management',workplaceType:'Hybrid',employmentType:'FullTime',isRemote:true};
 const source=rows=>async()=>new Response(JSON.stringify({jobs:rows})),now=Date.parse(at);
 await refreshJobBoard(a,'example','ashby',{now,fetchImpl:source([row])});const [job]=await a.all('jobs');assert.equal(job.isRemote,false);assert.equal(job.workplaceType,'hybrid');
 let release,started;const ready=new Promise(resolve=>started=resolve),waiting=new Promise(resolve=>release=resolve);
 const refresh=refreshJobBoard(a,'example','ashby',{now:now+3600000,fetchImpl:async()=>{started();await waiting;return source([{...row,title:'Senior Product Manager'}])();}});await ready;
 await setJobSaved(a,{id:job.id,saved:true},{now:()=>at});release();await refresh;
 assert.equal((await listCareerJobs(a))[0].saved,true);assert.equal((await listCareerJobs(a))[0].title,'Senior Product Manager');
 await refreshJobBoard(a,'example','ashby',{now:now+7200000,fetchImpl:source([])});assert.equal((await listCareerJobs(a))[0].saved,true);assert.equal((await listCareerJobs(a))[0].status,'closed');
 await setJobSaved(a,{id:job.id,saved:false});await refreshJobBoard(a,'example','ashby',{now:now+10800000,fetchImpl:source([row])});assert.equal((await listCareerJobs(a))[0].saved,false);
});

test('only recognized explicit source metadata provides workplace and employment filters',()=>{
 for(const [raw,normalized] of [['FullTime','full-time'],['PartTime','part-time'],['Intern','internship'],['Contract','contract'],['Temporary','temporary']])assert.equal(sourceJobDisplayFacts('ashby',{employmentType:raw}).employmentType,normalized);
 for(const [raw,normalized] of [['OnSite','on-site'],['Remote','remote'],['Hybrid','hybrid']])assert.equal(sourceJobDisplayFacts('ashby',{workplaceType:raw}).workplaceType,normalized);
 for(const raw of [{isRemote:true},{isRemote:false},{title:'Remote internship',descriptionPlain:'Full time'},{employmentType:'Unknown',workplaceType:'__proto__'},{employmentType:{value:'FullTime'},workplaceType:['Remote']}])assert.deepEqual(sourceJobDisplayFacts('ashby',raw),{employmentType:null,workplaceType:null});
 assert.deepEqual(sourceJobDisplayFacts('greenhouse',{workplaceType:'Remote',employmentType:'FullTime'}),{employmentType:null,workplaceType:null});
 assert.deepEqual(jobDisplayFacts({...fixture,rawSource:null,isRemote:true}),{employmentType:null,workplaceType:null});
});
