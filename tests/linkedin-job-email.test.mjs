import test from 'node:test';
import assert from 'node:assert/strict';
import {createLinkedInJobEmail,getLinkedInAlertJobs} from '../lib/linkedin-job-email.mjs';
import {idFor} from '../lib/domain.mjs';

const NOW=Date.parse('2026-11-14T15:00:00Z'),DAY=86400000,now=()=>NOW;
const grant={subject:'mailbox-one',email:'student@example.test',connectionRevision:'mailbox-revision',access_token:'synthetic-access',refresh_token:'synthetic-refresh',expiresAt:NOW+DAY,scope:'https://www.googleapis.com/auth/gmail.readonly'};
const body=(externalId='1234567891')=>`Your job alert for data analyst in NYC\nData Analyst\nExampleCo\nNew York, NY\n\n6 connections\nView job: https://www.linkedin.com/comm/jobs/view/${externalId}/?trackingId=discard\n\nPRIVATE_UNRELATED_FOOTER`;
function student(userId='student-one'){
 const records=new Map(),copy=value=>value===undefined?undefined:structuredClone(value),get=(bucket,id)=>copy(records.get(`${bucket}:${id}`)||null);
 return {userId,records,async get(bucket,id){return get(bucket,id);},async all(bucket){return [...records].filter(([key])=>key.startsWith(`${bucket}:`)).map(([,value])=>copy(value));},async put(bucket,id,value){records.set(`${bucket}:${id}`,copy(value));return value;},async putIfAbsent(bucket,id,value){if(!records.has(`${bucket}:${id}`))records.set(`${bucket}:${id}`,copy(value));return get(bucket,id);},async compareAndSet(bucket,id,expected,value){if(JSON.stringify(get(bucket,id))!==JSON.stringify(expected))return false;records.set(`${bucket}:${id}`,copy(value));return true;},async compareAndSetMany(changes,{buckets=[]}={}){if(buckets.some(guard=>JSON.stringify([...records.keys()].filter(key=>key.startsWith(`${guard.bucket}:`)).map(key=>key.slice(guard.bucket.length+1)).sort())!==JSON.stringify([...guard.ids].sort())))return false;if(changes.some(row=>JSON.stringify(get(row.bucket,row.id))!==JSON.stringify(row.expected)))return false;for(const row of changes){if(row.delete)records.delete(`${row.bucket}:${row.id}`);else if(Object.hasOwn(row,'value'))records.set(`${row.bucket}:${row.id}`,copy(row.value));}return true;},async delete(bucket,id){records.delete(`${bucket}:${id}`);}};
}
function message(id='aa',{sender='LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',age=1000,text=body(),labels=['INBOX']}={}){
 return {id,labelIds:labels,internalDate:String(NOW-age),payload:{mimeType:'text/plain',headers:[{name:'From',value:sender},{name:'Subject',value:'Your job alert for data analyst in NYC'}],body:{data:Buffer.from(text).toString('base64url')}}};
}
function fixture({messages=[message()],before=async()=>{}}={}){
 const calls=[],json=value=>new Response(JSON.stringify(value));
 const client=createLinkedInJobEmail({now,fetchImpl:async(url,options)=>{
  const u=new URL(url);assert.equal(u.origin,'https://gmail.googleapis.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer synthetic-access');
  if(u.pathname.endsWith('/messages')){assert.equal(u.searchParams.get('q'),'newer_than:30d from:jobalerts-noreply@linkedin.com');assert.equal(u.searchParams.get('includeSpamTrash'),'false');calls.push({stage:'list'});await before('list');return json({messages:messages.map(row=>({id:row.id})),resultSizeEstimate:messages.length});}
  const id=u.pathname.split('/').at(-1),stage=u.searchParams.get('format'),row=messages.find(row=>row.id===id);assert.ok(row);calls.push({stage,id});await before(stage,id);return json(stage==='metadata'?{...row,payload:{headers:row.payload.headers}}:row);
 }});return {client,calls};
}
async function enable(client,store=student(),delivery='alerts'){await store.put('secrets','eventEmailGoogle',grant);await client.enable(store,{delivery});return store;}
async function seedJob(store,externalId,{age=DAY,status='discovered'}={}){
 const cfg=await store.get('settings','linkedinJobEmail'),id=idFor('linkedin-email',externalId),receivedAt=new Date(NOW-age).toISOString(),job={id,externalId,provider:'linkedin-email',title:'Data Analyst',company:'ExampleCo',location:'New York, NY',url:`https://www.linkedin.com/jobs/view/${externalId}`,status,receivedAt,linkedinEmail:{mailboxKey:cfg.mailboxKey,connectionRevision:cfg.connectionRevision,receivedAt}};await store.put('jobs',id,job);return job;
}

test('LinkedIn monitoring is off by default and does not use mailbox scope as consent',async()=>{
 const {client,calls}=fixture(),store=student();await store.put('secrets','eventEmailGoogle',grant);
 const state=await client.status(store);assert.equal(state.connected,true);assert.equal(state.continuous,false);assert.deepEqual(state.jobs,[]);
 await assert.rejects(client.sync(store),error=>error.status===409);assert.equal(calls.length,0);
 await assert.rejects(client.enable(store,{delivery:'all',query:'private'}),error=>error.status===400);
});

test('exact-sender metadata gates bodies; imports preserve unknown publication dates and discard mail bodies',async()=>{
 const f=fixture({messages:[message('aa'),message('bb',{sender:'jobalerts-noreply@linkedin.com.evil.test'}),message('cc',{labels:['TRASH']}),message('dd',{age:31*DAY}),message('ee',{sender:'Other <jobalerts-noreply@linkedin.com>, attacker@example.test'})]}),store=await enable(f.client);
 const result=await f.client.sync(store);assert.equal(result.imported,1);assert.deepEqual(f.calls.filter(row=>row.stage==='full').map(row=>row.id),['aa']);
 const [job]=await store.all('jobs');assert.equal(job.provider,'linkedin-email');assert.equal(job.title,'Data Analyst');assert.equal(job.publicationTimeVerified,false);assert.equal(job.publishedAt,null);assert.equal(job.receivedAt,new Date(NOW-1000).toISOString());assert.equal(job.url,'https://www.linkedin.com/jobs/view/1234567891');
 assert.doesNotMatch(JSON.stringify([...store.records]),/PRIVATE_UNRELATED_FOOTER|trackingId|synthetic-access.*PRIVATE/);
 assert.equal((await getLinkedInAlertJobs(store,{now})).jobs.length,1);
});

test('message and posting dedupe survive refreshes, and repeated older alerts do not overwrite newer facts',async()=>{
 const f=fixture({messages:[message('aa'),message('bb',{age:DAY})]}),store=await enable(f.client);
 assert.equal((await f.client.sync(store)).imported,1);assert.equal((await f.client.sync(store)).read,0);assert.equal((await store.all('jobs')).length,1);
 const [job]=await store.all('jobs');assert.equal(job.linkedinEmail.messageId,'aa');assert.equal((await store.all('linkedinJobEmailMessages')).length,2);
});

test('only six new bodies are read per refresh and a later refresh resumes the backlog',async()=>{
 const messages=Array.from({length:8},(_,index)=>message(`a${index}`,{text:body(`123456789${index}`)})),f=fixture({messages}),store=await enable(f.client);
 const first=await f.client.sync(store);assert.equal(first.read,6);assert.equal(first.backlog,2);assert.equal(first.complete,false);
 const second=await f.client.sync(store);assert.equal(second.read,2);assert.equal(second.backlog,0);assert.equal((await store.all('jobs')).length,8);
});

test('an oversized first alert is checkpointed and does not block later valid mail',async()=>{
 const f=fixture({messages:[message('aa',{text:'PRIVATE_OVERSIZED_BODY '.repeat(3000)}),message('bb')]}),store=await enable(f.client);
 const result=await f.client.sync(store);assert.equal(result.read,2);assert.equal(result.imported,1);assert.equal(result.skipped,1);
 const record=await store.get('linkedinJobEmailMessages',idFor('linkedin-job-email',grant.subject,'aa'));assert.equal(record.status,'done');assert.equal(record.reason,'message-too-large');assert.deepEqual(record.jobIds,[]);assert.doesNotMatch(JSON.stringify([...store.records]),/PRIVATE_OVERSIZED_BODY/);
 const again=await f.client.sync(store);assert.equal(again.read,0);assert.equal(f.calls.filter(row=>row.stage==='full'&&row.id==='aa').length,1);
});

test('malformed MIME is skipped within the body budget while connection failures remain retryable',async()=>{
 const malformed=message('aa');malformed.payload.mimeType='multipart/mixed';malformed.payload.parts=Array.from({length:41},()=>({mimeType:'text/plain',body:{data:Buffer.from('part').toString('base64url')}}));
 const f=fixture({messages:[malformed,message('bb')]}),store=await enable(f.client);const result=await f.client.sync(store);assert.equal(result.read,2);assert.equal(result.imported,1);assert.equal((await store.get('linkedinJobEmailMessages',idFor('linkedin-job-email',grant.subject,'aa'))).reason,'message-unreadable');
 const broken=fixture({before:async stage=>{if(stage==='full')throw new Error('synthetic network failure');}}),other=await enable(broken.client,student('other'));
 await assert.rejects(broken.client.sync(other),error=>error.status===502);assert.deepEqual(await other.all('linkedinJobEmailMessages'),[]);
});

test('failed size validation consumes the six-body scan budget and cannot checkpoint after withdrawal',async()=>{
 const messages=Array.from({length:7},(_,index)=>message(`a${index}`,{text:index<6?'x'.repeat(41000):body()})),f=fixture({messages}),store=await enable(f.client);
 const first=await f.client.sync(store);assert.equal(first.read,6);assert.equal(first.skipped,6);assert.equal(first.backlog,1);assert.equal((await f.client.sync(store)).imported,1);
 const other=student('withdrawn');let client;const withdrawn=fixture({messages:[message('aa',{text:'x'.repeat(41000)})],before:async stage=>{if(stage==='full')await client.stop(other);}});client=withdrawn.client;await enable(client,other);
 await assert.rejects(client.sync(other),error=>error.status===409);assert.deepEqual(await other.all('linkedinJobEmailMessages'),[]);
});

test('withdrawal during metadata lookup prevents full-body reads and import',async()=>{
 const store=student();let client;const f=fixture({before:async stage=>{if(stage==='metadata')await client.stop(store);}});client=f.client;await enable(client,store);
 await assert.rejects(client.sync(store),error=>error.status===409);assert.equal(f.calls.filter(row=>row.stage==='full').length,0);assert.deepEqual(await store.all('jobs'),[]);assert.equal((await client.status(store)).continuous,false);
});

test('withdrawal after full-body retrieval prevents checkpoint and role writes',async()=>{
 const store=student();let client;const f=fixture({before:async stage=>{if(stage==='full')await client.stop(store);}});client=f.client;await enable(client,store);
 await assert.rejects(client.sync(store),error=>error.status===409);assert.deepEqual(await store.all('jobs'),[]);assert.deepEqual(await store.all('linkedinJobEmailMessages'),[]);
});

test('atomic consent fence stops a revocation racing the final role write',async()=>{
 const f=fixture(),store=await enable(f.client),compare=store.compareAndSetMany.bind(store);let revoked=false;
 store.compareAndSetMany=async changes=>{if(!revoked&&changes.some(row=>row.bucket==='jobs'&&Object.hasOwn(row,'value'))){revoked=true;await f.client.stop(store);}return compare(changes);};
 await assert.rejects(f.client.sync(store),error=>error.status===409);assert.deepEqual(await store.all('jobs'),[]);assert.equal((await store.get('settings','linkedinJobEmail')).continuous,false);
});

test('a crash after saving a role resumes the checkpoint without re-reading mail or duplicating the role',async()=>{
 const f=fixture(),store=await enable(f.client),compare=store.compareAndSetMany.bind(store);let crashed=false;
 store.compareAndSetMany=async changes=>{if(!crashed&&changes.some(row=>row.bucket==='linkedinJobEmailMessages'&&row.value?.status==='done')){crashed=true;throw new Error('synthetic crash');}return compare(changes);};
 await assert.rejects(f.client.sync(store),/synthetic crash/);assert.equal((await store.all('jobs')).length,1);assert.equal((await store.all('linkedinJobEmailMessages'))[0].status,'processing');
 const resumed=await f.client.sync(store);assert.equal(resumed.read,0);assert.equal(resumed.imported,0);assert.equal((await store.all('jobs')).length,1);assert.equal((await store.all('linkedinJobEmailMessages'))[0].status,'done');assert.equal(f.calls.filter(row=>row.stage==='full').length,1);
});

test('mailbox switches invalidate imports and notification snapshots until separately re-enabled',async()=>{
 const store=student(),f=fixture();await enable(f.client,store);await f.client.sync(store);
 const replacement={...grant,subject:'mailbox-two',connectionRevision:'mailbox-two-revision'};await store.put('secrets','eventEmailGoogle',replacement);
 assert.deepEqual((await getLinkedInAlertJobs(store,{now})).jobs,[]);assert.equal((await f.client.status(store)).continuous,false);await assert.rejects(f.client.sync(store),error=>error.status===409);
 await f.client.enable(store,{delivery:'daily'});assert.deepEqual((await getLinkedInAlertJobs(store,{now})).jobs,[]);await f.client.sync(store);assert.equal((await getLinkedInAlertJobs(store,{now})).jobs.length,1);
});

test('mailbox swap while reading cannot import data from the preceding mailbox',async()=>{
 const store=student(),f=fixture({before:async stage=>{if(stage==='full')await store.put('secrets','eventEmailGoogle',{...grant,connectionRevision:'reconnected'});}});await enable(f.client,store);
 await assert.rejects(f.client.sync(store),error=>error.status===409);assert.deepEqual(await store.all('jobs'),[]);
});

test('removed, skipped, dismissed and closed roles remain suppressed without losing saved/application state',async()=>{
 const f=fixture(),store=await enable(f.client);await f.client.sync(store);const [job]=await store.all('jobs');
 await store.put('jobSaves',job.id,{id:job.id,saved:true});await store.put('applications','draft',{id:'draft',jobId:job.id,status:'prepared'});await store.put('careerRemovals',job.id,{id:job.id,foundRemovedAt:new Date(NOW).toISOString()});
 const next=fixture({messages:[message('bb',{age:0})]});await next.client.sync(store);assert.deepEqual((await getLinkedInAlertJobs(store,{now})).jobs,[]);assert.equal((await store.get('jobs',job.id)).linkedinEmail.messageId,'aa');assert.equal((await store.get('jobSaves',job.id)).saved,true);assert.equal((await store.get('applications','draft')).status,'prepared');
 await store.delete('careerRemovals',job.id);await store.put('skippedJobs',job.id,{id:job.id});assert.deepEqual((await getLinkedInAlertJobs(store,{now})).jobs,[]);await store.put('skippedJobs',job.id,{id:job.id,hidden:false});assert.equal((await getLinkedInAlertJobs(store,{now})).jobs.length,1);await store.delete('skippedJobs',job.id);
 for(const status of ['dismissed','closed']){await store.put('jobs',job.id,{...job,status});assert.deepEqual((await getLinkedInAlertJobs(store,{now})).jobs,[]);}
});

test('snapshots stop on pause, account deletion, revoked Gmail scope and source stop without deleting shared Gmail',async()=>{
 const f=fixture(),store=await enable(f.client);await f.client.sync(store);
 for(const [bucket,id,value] of [['settings','profile',{paused:true}],['settings','account',{deleting:true}],['secrets','eventEmailGoogle',{...grant,scope:''}]]){const previous=await store.get(bucket,id);await store.put(bucket,id,value);assert.deepEqual((await getLinkedInAlertJobs(store,{now})).jobs,[]);await store.put(bucket,id,previous);}
 await f.client.stop(store);assert.deepEqual((await getLinkedInAlertJobs(store,{now})).jobs,[]);assert.deepEqual(await store.get('secrets','eventEmailGoogle'),grant);
});

test('message retention stays within 30 days and 300 rows',async()=>{
 const f=fixture({messages:[]}),store=await enable(f.client);
 for(let index=0;index<305;index++)await store.put('linkedinJobEmailMessages',`old${index}`,{id:`old${index}`,createdAt:new Date(NOW-index).toISOString(),receivedAt:new Date(NOW-index).toISOString()});
 await store.put('linkedinJobEmailMessages','expired',{id:'expired',createdAt:new Date(NOW-31*DAY).toISOString()});await f.client.sync(store);assert.equal((await store.all('linkedinJobEmailMessages')).length,300);assert.equal(await store.get('linkedinJobEmailMessages','expired'),null);
});

test('the 200-role bound preserves existing roles and checkpoints omitted new roles with a clear limit warning',async()=>{
 const f=fixture({messages:[message('aa'),message('bb',{age:0,text:body('1000000000')})]}),store=await enable(f.client);
 for(let index=0;index<200;index++)await seedJob(store,String(1000000000+index));
 const result=await f.client.sync(store);assert.equal(result.capacityReached,true);assert.equal(result.complete,false);assert.equal(result.imported,0);assert.equal(result.reused,1);assert.equal((await store.all('jobs')).length,200);
 assert.equal((await store.get('jobs',idFor('linkedin-email','1000000000'))).linkedinEmail.messageId,'bb');assert.match((await f.client.status(store)).coverageWarning,/200 LinkedIn-job limit/);assert.equal((await f.client.sync(store)).read,0);
});

test('a full Career Studio job list prevents imports even below the LinkedIn-specific limit',async()=>{
 const f=fixture(),store=await enable(f.client);for(let index=0;index<2000;index++)await store.put('jobs',`manual${index}`,{id:`manual${index}`,provider:'manual'});
 const result=await f.client.sync(store);assert.equal(result.imported,0);assert.equal(result.capacityReached,true);assert.equal(result.globalCapacityReached,true);assert.equal((await store.all('jobs')).length,2000);assert.match((await f.client.status(store)).warnings.join(' '),/job list is full/);
});

test('only removed or older unsaved, unreferenced LinkedIn roles are pruned; even archived applications retain their roles',async()=>{
 const f=fixture(),store=await enable(f.client),expired=await seedJob(store,'1000000000',{age:31*DAY}),saved=await seedJob(store,'1000000001',{age:31*DAY}),removed=await seedJob(store,'1000000002');
 await store.put('jobSaves',saved.id,{id:saved.id,saved:true});await store.put('careerRemovals',removed.id,{id:removed.id,foundRemovedAt:new Date(NOW).toISOString()});
 const linked=[];for(const [index,bucket] of ['applications','applicationTracker','liveApplications'].entries()){const job=await seedJob(store,String(1000000010+index),{age:31*DAY});linked.push(job);await store.put(bucket,`application${index}`,{id:`application${index}`,jobId:job.id,removedAt:new Date(NOW).toISOString()});}
 for(const [index,status] of ['applied','submitted'].entries())linked.push(await seedJob(store,String(1000000020+index),{age:31*DAY,status}));
 await store.put('jobs','ordinary',{id:'ordinary',provider:'ashby',receivedAt:new Date(NOW-60*DAY).toISOString()});await f.client.sync(store);
 assert.equal(await store.get('jobs',expired.id),null);assert.equal(await store.get('jobs',removed.id),null);assert.ok(await store.get('careerRemovals',removed.id));assert.ok(await store.get('jobs',saved.id));assert.ok(await store.get('jobs','ordinary'));for(const job of linked)assert.ok(await store.get('jobs',job.id));
});

test('a save or new application racing retention prevents deletion',async()=>{
 for(const change of ['save','application']){
  const f=fixture({messages:[]}),store=await enable(f.client),old=await seedJob(store,'1000000000',{age:31*DAY}),compare=store.compareAndSetMany.bind(store);let raced=false;
  store.compareAndSetMany=async(changes,options)=>{if(!raced&&changes.some(row=>row.delete)){raced=true;if(change==='save')await store.put('jobSaves',old.id,{id:old.id,saved:true});else await store.put('applications','new-app',{id:'new-app',jobId:old.id});}return compare(changes,options);};
  await assert.rejects(f.client.sync(store),error=>error.status===409);assert.ok(await store.get('jobs',old.id));
 }
});

test('different students never reuse one another’s message checkpoints or imported roles',async()=>{
 const f=fixture(),alice=await enable(f.client,student('alice')),bob=student('bob');await bob.put('secrets','eventEmailGoogle',grant);await f.client.sync(alice);
 assert.deepEqual((await f.client.status(bob)).jobs,[]);assert.equal(await bob.get('jobs',idFor('linkedin-email','1234567891')),null);
});
