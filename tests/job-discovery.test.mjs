import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {refreshJobBoard as refreshOnly,dispatchJobAlerts,scoreJobRelevance,jobMatchingFingerprint,JOB_DISCOVERY_LIMITS} from '../lib/job-discovery.mjs';

const NOW=Date.parse('2026-11-10T12:00:00Z');
const posting=(id='one',extra={})=>({id,title:'Product Manager',location:'New York, NY',descriptionPlain:'Use SQL, Python and product management to build useful products.',jobUrl:`https://jobs.ashbyhq.com/example/${id}`,applyUrl:`https://jobs.ashbyhq.com/example/${id}/application`,publishedAt:'2026-11-09T09:00:00Z',...extra});
const source=rows=>async()=>new Response(JSON.stringify({jobs:rows}),{status:200,headers:{'content-type':'application/json'}});
// These existing alert assertions explicitly run both stages. A separate test
// below verifies that source refresh alone only enqueues the deferred digest.
async function refreshJobBoard(store,board,provider,options){const result=await refreshOnly(store,board,provider,options);return result.alreadyRunning||result.superseded?result:{...result,...await dispatchJobAlerts(store,options)};}
const telegramTasks=async(queue,userId)=>(await queue.list(userId)).filter(task=>task.type==='telegram-send');
async function setup(t){
  const dir=await mkdtemp(path.join(tmpdir(),'brf-job-discovery-'));
  const db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
  t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
  const store=db.forUser('student-a'),queue=await createQueue(db),messages=new Map(),enqueue=queue.enqueue.bind(queue);
  queue.enqueue=async(...args)=>{const result=await enqueue(...args);if(args[1]==='telegram-send'&&!messages.has(result.id))messages.set(result.id,structuredClone(args[2]));return result;};
  await store.put('settings','profile',{jobTitles:'Product Manager',jobLocation:'NYC',paused:false});
  await store.put('documents','resume',{name:'Synthetic.pdf',text:'Built Python and SQL products. Experience with product management.',updatedAt:'2026-11-01T00:00:00Z'});
  await store.put('secrets','telegram',{chatId:123});
  return {db,store,queue,messages,options:{queue,now:NOW,fetchImpl:source([posting()])}};
}

test('relevance combines target titles, resume evidence and explicit location without guessing qualification',()=>{
  const good=scoreJobRelevance({title:'Senior Product Manager',description:'Python and SQL research',location:'New York, NY'},{titles:'Product Manager',location:'NYC',resume:'Uses Python and SQL.'});
  assert.equal(good.eligible,true);assert.deepEqual(good.matchEvidence.skills,['Python','SQL']);assert.equal(good.locationFit,'matched');assert.match(good.matchBasis,/not evidence of qualification/);
  assert.equal(scoreJobRelevance({title:'Product Designer',description:'SQL',location:'NYC'},{titles:'Product Manager',resume:'SQL'}).eligible,false);
  assert.equal(scoreJobRelevance({title:'Product Manager',location:'London'},{titles:'Product Manager',location:'NYC',resume:'Python'}).eligible,false);
  assert.equal(scoreJobRelevance({title:'Product Manager',location:'Remote',isRemote:true},{titles:'Product Manager',location:'NYC'}).locationFit,'unverified');
  assert.equal(scoreJobRelevance({title:'Data Analyst',description:'Python and SQL',location:''},{resume:'Python and SQL'}).eligible,true);
  assert.equal(scoreJobRelevance({title:'Data Analyst',description:'Python and SQL'},{resume:'Veteran disability accommodation Python SQL'}).eligible,false);
});

test('LinkedIn alert imports do not consume employer-board discovery capacity',async t=>{
 const s=await setup(t),records=[];
 for(let i=0;i<1799;i++)records.push({bucket:'jobs',id:`old-board-${i}`,expected:null,value:{id:`old-board-${i}`,provider:'greenhouse',board:'other',status:'closed',closed:true}});
 for(let i=0;i<200;i++)records.push({bucket:'jobs',id:`linkedin-${i}`,expected:null,value:{id:`linkedin-${i}`,provider:'linkedin-email',publishedAt:null}});
 assert.equal(await s.store.compareAndSetMany(records),true);
 const result=await refreshOnly(s.store,'example','ashby',s.options);assert.equal(result.count,1);
 assert.equal((await s.store.all('jobs')).length,2000);
});

test('Ashby records source facts, compensation and firstSeen separately from published dates',async t=>{
  const s=await setup(t),raw=posting('one',{compensation:{scrapeableCompensationSalarySummary:'$100K–$140K'}});let requested;
  const options={...s.options,fetchImpl:async url=>{requested=url;return source([raw])();}};
  const result=await refreshJobBoard(s.store,'example','ashby',options);assert.equal(result.count,1);assert.match(requested,/includeCompensation=true/);
  const [job]=await s.store.all('jobs');assert.equal(job.firstSeenAt,new Date(NOW).toISOString());assert.equal(job.publishedAt,'2026-11-09T09:00:00.000Z');assert.equal(job.salary,'$100K–$140K');assert.deepEqual(job.rawSource,raw);assert.ok(job.matchReasons.some(reason=>reason.includes('SQL')));
  assert.ok([...s.messages.values()].every(message=>!message.text.includes('not a veteran')));
  const originalFingerprint=await jobMatchingFingerprint(s.store);await s.store.put('career','demographics',{gender:'PRIVATE',race:['PRIVATE']});await s.store.put('career','profile',{veteranStatus:'veteran'});assert.equal(await jobMatchingFingerprint(s.store),originalFingerprint);
  await refreshJobBoard(s.store,'example','ashby',{...options,now:NOW+6*3600000});assert.equal((await s.store.get('jobs',job.id)).firstSeenAt,job.firstSeenAt);
});

test('Greenhouse update timestamps are never labeled publication dates and complete disappearance closes roles',async t=>{
  const s=await setup(t),raw={id:12,title:'Product Manager',location:{name:'New York'},content:'SQL Python',absolute_url:'https://boards.greenhouse.io/example/jobs/12',updated_at:'2026-11-10T10:00:00Z'};
  await refreshJobBoard(s.store,'example','greenhouse',{...s.options,fetchImpl:source([raw])});const [job]=await s.store.all('jobs');
  assert.equal(job.publishedAt,null);assert.equal(job.publicationTimeVerified,false);assert.equal(job.sourceUpdatedAt,'2026-11-10T10:00:00.000Z');assert.equal(s.messages.size,0,'unknown publication times are saved but never pushed as recent alerts');
  await refreshJobBoard(s.store,'example','greenhouse',{...s.options,now:NOW+6*3600000,fetchImpl:source([])});assert.equal((await s.store.get('jobs',job.id)).status,'closed');
});

test('source display facts retain published employment/workplace types and reject malformed pay ranges',async t=>{
 const s=await setup(t),raw=posting('hybrid',{workplaceType:'Hybrid',isRemote:true,employmentType:'FullTime'});
 await refreshJobBoard(s.store,'example','ashby',{...s.options,fetchImpl:source([raw])});const [hybrid]=await s.store.all('jobs');assert.equal(hybrid.workplaceType,'hybrid');assert.equal(hybrid.employmentType,'full-time');assert.equal(hybrid.isRemote,false);
 const greenhouse={id:12,title:'Product Manager',location:{name:'New York'},content:'SQL Python',absolute_url:'https://boards.greenhouse.io/example/jobs/12',pay_input_ranges:[null,{currency_type:'USD',min_cents:10000000},{currency_type:'USD',min_cents:'10000000',max_cents:15000000},{currency_type:'USD',min_cents:200,max_cents:100},{currency_type:'USD',min_cents:10000000,max_cents:15000000,title:'New York salary'}]};
 await refreshJobBoard(s.store,'example','greenhouse',{...s.options,fetchImpl:source([greenhouse])});const job=(await s.store.all('jobs')).find(job=>job.provider==='greenhouse');assert.equal(job.salary,'USD 100000–150000 New York salary');assert.equal(job.workplaceType,null);assert.equal(job.employmentType,null);assert.doesNotMatch(job.salary,/NaN|undefined/);
 await refreshJobBoard(s.store,'example','greenhouse',{...s.options,fetchImpl:source([{...greenhouse,pay_input_ranges:{bad:'shape'}}])});assert.equal((await s.store.get('jobs',job.id)).salary,null);
});

test('first crawl alerts at most ten roles, preserves backlog and never re-alerts unchanged jobs after resume updates',async t=>{
  const s=await setup(t),fetchImpl=source(Array.from({length:12},(_,i)=>posting(`role-${i}`))),options={...s.options,fetchImpl};
  const first=await refreshJobBoard(s.store,'example','ashby',options);assert.equal(first.alertQueued,10);assert.equal(first.pendingAlerts,2);
  assert.ok((await s.queue.list(s.store.userId)).some(task=>task.type==='job-alerts'&&task.availableAt===NOW+15*60000),'global backlog gets its own follow-up digest');
  assert.ok([...s.messages.values()].every(m=>m.text.length<3900&&m.text.includes('/#careers')&&m.text.includes('No employer submission')));
  const second=await refreshJobBoard(s.store,'example','ashby',{...options,now:NOW+15*60000});assert.equal(second.alertQueued,2);
  const sent=s.messages.size;await s.store.put('documents','resume',{text:'Updated SQL Python experience and product management',updatedAt:'2026-11-10T14:00:00Z'});
  const third=await refreshJobBoard(s.store,'example','ashby',{...options,now:NOW+30*60000});assert.equal(third.alertQueued,0);assert.equal(s.messages.size,sent);assert.equal((await s.store.all('jobAlerts')).length,12);
});

test('failed sources remain registered with bounded backoff and old successful data is never presented as freshly refreshed',async t=>{
  const s=await setup(t),bad=async()=>new Response('outage',{status:503});
  await assert.rejects(refreshJobBoard(s.store,'example','ashby',{...s.options,fetchImpl:bad}),/HTTP 503/);
  let board=(await s.store.get('settings','jobBoards')).boards[0];assert.equal(board.lastSuccess,undefined);assert.equal(board.nextRun,NOW+3600000);assert.equal(board.lastStatus,'error');
  await assert.rejects(refreshJobBoard(s.store,'example','ashby',{...s.options,fetchImpl:bad,now:NOW+3600000}));board=(await s.store.get('settings','jobBoards')).boards[0];assert.equal(board.failureCount,2);assert.equal(board.nextRun,NOW+3*3600000);
  await refreshJobBoard(s.store,'example','ashby',{...s.options,now:NOW+3*3600000});board=(await s.store.get('settings','jobBoards')).boards[0];assert.equal(board.failureCount,0);assert.equal(board.lastError,null);assert.equal(board.errorMessage,null);assert.equal(board.lastStatus,'ok');
  await assert.rejects(refreshJobBoard(s.store,'example','ashby',{...s.options,fetchImpl:bad,now:NOW+9*3600000}));const health=await s.store.get('settings','jobsHealth');assert.equal(health.lastSuccess,new Date(NOW+3*3600000).toISOString());assert.match(health.coverage,/No whole-web/);
});

test('partial or oversized source responses never falsely close previous postings',async t=>{
  const s=await setup(t);await refreshJobBoard(s.store,'example','ashby',s.options);const [original]=await s.store.all('jobs');
  const result=await refreshJobBoard(s.store,'example','ashby',{...s.options,now:NOW+6*3600000,fetchImpl:source([{id:'broken',title:'No URL'}])});assert.equal(result.truncated,true);assert.notEqual((await s.store.get('jobs',original.id)).status,'closed');
  await assert.rejects(refreshJobBoard(s.store,'example','ashby',{...s.options,fetchImpl:async()=>new Response('{}',{headers:{'content-length':String(JOB_DISCOVERY_LIMITS.responseBytes+1)}})}),/12 MB/);
  assert.notEqual((await s.store.get('jobs',original.id)).status,'closed');
});

test('durable alert outbox recovers an uncertain enqueue using identical queue IDs',async t=>{
  const s=await setup(t),enqueue=s.queue.enqueue.bind(s.queue);let fail=true;
  s.queue.enqueue=async(...args)=>{const job=await enqueue(...args);if(args[1]==='telegram-send'&&fail){fail=false;throw new Error('simulated crash after durable enqueue');}return job;};
  const first=await refreshJobBoard(s.store,'example','ashby',s.options);assert.equal(first.alerts,'retry-pending');assert.equal((await s.store.all('jobAlerts')).length,0);assert.equal((await telegramTasks(s.queue,s.store.userId)).length,1);
  const second=await refreshJobBoard(s.store,'example','ashby',{...s.options,now:NOW+3600000});assert.equal(second.alertQueued,1);assert.equal((await telegramTasks(s.queue,s.store.userId)).length,1);assert.equal((await s.store.all('jobAlerts')).length,1);
});

test('paused and unlinked students retain matches without sending or sharing alerts',async t=>{
  const s=await setup(t),profile=await s.store.get('settings','profile');await s.store.put('settings','profile',{...profile,paused:true});
  await refreshJobBoard(s.store,'example','ashby',s.options);assert.equal((await s.queue.list(s.store.userId)).length,0);assert.equal((await s.store.all('jobs')).length,1);
  await s.store.put('settings','profile',{...profile,paused:false});await refreshJobBoard(s.store,'example','ashby',{...s.options,now:NOW+6*3600000});assert.equal((await s.store.all('jobAlerts')).length,1);
  const b=s.db.forUser('student-b');await b.put('settings','profile',profile);await b.put('documents','resume',{text:'SQL Python and product management'});
  await refreshJobBoard(b,'example','ashby',{...s.options,now:NOW+6*3600000});assert.equal((await s.queue.list('student-b')).length,0);assert.equal((await b.all('jobAlerts')).length,0);assert.equal((await b.all('jobs')).length,1);
});

test('skipped roles stay out of alerts until restored, including legacy skip records',async t=>{
 const s=await setup(t);await refreshOnly(s.store,'example','ashby',s.options);const [job]=await s.store.all('jobs');
 await s.store.put('skippedJobs',job.id,{id:job.id});
 const hidden=await dispatchJobAlerts(s.store,s.options);assert.equal(hidden.alertQueued,0);assert.equal((await telegramTasks(s.queue,s.store.userId)).length,0);
 await s.store.put('skippedJobs',job.id,{id:job.id,hidden:false,revision:'restored'});
 const restored=await dispatchJobAlerts(s.store,{...s.options,now:NOW+60000});assert.equal(restored.alertQueued,1);
 assert.equal((await telegramTasks(s.queue,s.store.userId)).length,1);
});

test('a per-student board lease prevents concurrent duplicate fetches without blocking another board',async t=>{
  const s=await setup(t);let started,release;const pending=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{started=resolve;});
  const first=refreshJobBoard(s.store,'example','ashby',{...s.options,fetchImpl:async()=>{started();await pending;return source([posting()])();}});await ready;
  const duplicate=await refreshJobBoard(s.store,'example','ashby',s.options);assert.equal(duplicate.alreadyRunning,true);release();await first;
  assert.equal((await s.store.all('jobs')).length,1);assert.equal((await s.store.all('jobAlerts')).length,1);
});

test('alerts use only real publication windows and remain newest-first through bounded chunks',async t=>{
 const s=await setup(t),hour=3600000,stamp=age=>new Date(NOW-age).toISOString();
 const records=[
  posting('old-week',{title:'Product Manager OlderWeek',publishedAt:stamp(6*24*hour)}),
  posting('unknown',{title:'Product Manager Unknown',publishedAt:undefined,updatedAt:stamp(0)}),
  posting('newer',{title:'Product Manager Newer',publishedAt:stamp(2*hour)}),
  posting('date-only',{title:'Product Manager DateOnly',publishedAt:'2026-11-10'}),
  posting('recent-week',{title:'Product Manager RecentWeek',publishedAt:stamp(25*hour)}),
  posting('future',{title:'Product Manager Future',publishedAt:stamp(-hour)}),
  posting('old',{title:'Product Manager Old',publishedAt:stamp(8*24*hour)}),
  posting('newest',{title:'Product Manager Newest',publishedAt:stamp(hour)})
 ];
 for(const item of records)item.jobUrl=`https://jobs.ashbyhq.com/example/${item.id}?context=${'x'.repeat(1200)}`;
 const result=await refreshJobBoard(s.store,'example','ashby',{...s.options,fetchImpl:source(records)});
 assert.equal(result.count,8);assert.equal(result.alertQueued,4);assert.equal(result.pendingAlerts,0);
 const messages=[...s.messages.values()];assert.ok(messages.length>=2);assert.ok(messages.every(message=>message.text.length<=3850));
 const jobs=await s.store.all('jobs'),byId=new Map(jobs.map(job=>[job.id,job]));
 const snapshots=messages.flatMap(message=>message.notification.jobs);
 assert.deepEqual(snapshots.map(snapshot=>byId.get(snapshot.id).externalId),['newest','newer','recent-week','old-week']);
 assert.deepEqual(snapshots.map(snapshot=>snapshot.bucket),['last24Hours','last24Hours','pastWeek','pastWeek']);
 for(const message of messages){assert.equal(message.notification.requireCurrentPublication,true);assert.equal(message.notification.requireCurrentMatching,true);assert.match(message.text,/LinkedIn 1st-degree connections/);assert.match(message.text,/\/leads JOB_ID checks your uploaded export/);assert.match(message.text,/not an identified connection/);for(const snapshot of message.notification.jobs){assert.equal(snapshot.publishedAt,byId.get(snapshot.id).publishedAt);assert.ok(message.text.includes(`/apply ${snapshot.id}`));assert.ok(message.text.includes(snapshot.bucket==='last24Hours'?'Published in the last 24 hours':'Published in the past week'));}}
 assert.equal(jobs.find(job=>job.externalId==='date-only').publishedAt,null);
 assert.equal(jobs.find(job=>job.externalId==='unknown').publishedAt,null);
 await refreshJobBoard(s.store,'example','ashby',{...s.options,now:NOW+hour/2,fetchImpl:source(records)});assert.equal(s.messages.size,messages.length,'unchanged jobs do not re-alert');
});

test('unknown, future and older source dates never generate Telegram alerts despite fresh discovery',async t=>{
 const s=await setup(t),rows=[posting('unknown',{publishedAt:null}),posting('day',{publishedAt:'2026-11-10'}),posting('timezone-missing',{publishedAt:'2026-11-10T08:00:00'}),posting('future',{publishedAt:'2026-11-11T00:00:00Z'}),posting('old',{publishedAt:'2026-10-01T00:00:00Z'})];
 const result=await refreshJobBoard(s.store,'example','ashby',{...s.options,fetchImpl:source(rows)});
 assert.equal(result.count,5);assert.equal(result.alertQueued,0);assert.equal(result.pendingAlerts,0);assert.equal(s.messages.size,0);assert.equal((await s.store.all('jobAlerts')).length,0);
 assert.ok((await s.store.all('jobs')).every(job=>job.firstSeenAt===new Date(NOW).toISOString()));
});

test('uncertain pending alert is not replayed under a new bucket after crossing24hours',async t=>{
 const s=await setup(t),raw=posting('boundary',{publishedAt:new Date(NOW-23.5*3600000).toISOString()}),original=s.queue.enqueue.bind(s.queue);let fail=true;
 s.queue.enqueue=async(...args)=>{const queued=await original(...args);if(args[1]==='telegram-send'&&fail){fail=false;throw new Error('Synthetic interruption after durable enqueue');}return queued;};
 const first=await refreshJobBoard(s.store,'example','ashby',{...s.options,fetchImpl:source([raw])});assert.equal(first.alerts,'retry-pending');assert.equal(s.messages.size,1);
 const oldPayload=[...s.messages.values()][0];assert.equal(oldPayload.notification.jobs[0].bucket,'last24Hours');
 const second=await refreshJobBoard(s.store,'example','ashby',{...s.options,now:NOW+3600000,fetchImpl:source([raw])});assert.equal(second.alertQueued,0);assert.equal(s.messages.size,1,'do not rebuild an uncertain old chunk with a new idempotency key');
 const [outbox]=await s.store.all('jobAlertOutbox');assert.equal(outbox.status,'superseded');assert.equal(outbox.reason,'publication-or-matching-changed');
 const [marker]=await s.store.all('jobAlerts');assert.equal(marker.status,'suppressed');assert.equal(marker.queuedAt,undefined,'a suppression marker is not a delivery claim');
 assert.equal(oldPayload.notification.requireCurrentPublication,true,'final send must reject the now-wrong last24hour label');
});

test('deferred digest globally sorts currently fetched boards and schedules a bounded remaining backlog',async t=>{
 const s=await setup(t),hour=3600000;
 const older=Array.from({length:6},(_,i)=>posting(`older-${i}`,{title:`Product Manager Old${i}`,publishedAt:new Date(NOW-(4*24+i)*hour).toISOString()}));
 const newer=Array.from({length:6},(_,i)=>posting(`newer-${i}`,{title:`Product Manager New${i}`,publishedAt:new Date(NOW-(i+1)*hour).toISOString()}));
 const first=await refreshOnly(s.store,'older-board','ashby',{...s.options,fetchImpl:source(older)});assert.equal(first.alertQueued,0);assert.equal(first.alerts,'digest-queued');assert.equal(s.messages.size,0,'a source read never emits a Telegram message immediately');
 await refreshOnly(s.store,'newer-board','ashby',{...s.options,fetchImpl:source(newer)});assert.equal(s.messages.size,0);
 const queued=(await s.queue.list(s.store.userId)).filter(task=>task.type==='job-alerts');assert.equal(queued.length,1,'source reads within30seconds coalesce');assert.equal(queued[0].priority,-20);assert.equal(queued[0].availableAt,NOW+30000);
 const result=await dispatchJobAlerts(s.store,s.options);assert.equal(result.alertQueued,10);assert.equal(result.pendingAlerts,2);
 const jobs=new Map((await s.store.all('jobs')).map(job=>[job.id,job])),firstSnapshots=[...s.messages.values()].flatMap(message=>message.notification.jobs);
 assert.deepEqual(firstSnapshots.map(snapshot=>jobs.get(snapshot.id).externalId),[...newer.map(job=>job.id),...older.slice(0,4).map(job=>job.id)]);
 assert.ok([...s.messages.values()].every(message=>/currently fetched employer sources/.test(message.text)&&/Unfetched sources are not covered/.test(message.text)));
 assert.ok((await s.queue.list(s.store.userId)).some(task=>task.type==='job-alerts'&&task.availableAt===NOW+15*60000&&task.priority===-20));
 assert.equal((await s.store.get('settings','jobAlertsHealth')).pendingAlerts,2);
 const second=await dispatchJobAlerts(s.store,{...s.options,now:NOW+15*60000});assert.equal(second.alertQueued,2);assert.equal(second.pendingAlerts,0);
 const all=[...s.messages.values()].flatMap(message=>message.notification.jobs);assert.equal(all.length,12);assert.equal(new Set(all.map(snapshot=>snapshot.id)).size,12);assert.equal((await s.store.all('jobAlertOutbox')).length,1,'one student-wide outbox');
});

test('concurrent digests share one student lease and never enqueue duplicate chunks',async t=>{
 const s=await setup(t);await refreshOnly(s.store,'example','ashby',s.options);
 let release,started;const pending=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>started=resolve),original=s.queue.enqueue.bind(s.queue);
 s.queue.enqueue=async(...args)=>{if(args[1]==='telegram-send'){started();await pending;}return original(...args);};
 const first=dispatchJobAlerts(s.store,s.options);await ready;
 const second=await dispatchJobAlerts(s.store,s.options);assert.equal(second.alerts,'already-running');release();assert.equal((await first).alertQueued,1);
 assert.equal(s.messages.size,1);assert.equal((await s.store.all('jobAlerts')).length,1);
});

test('digest recovery recomputes unseen global backlog after a partial enqueue failure',async t=>{
 const s=await setup(t),rows=Array.from({length:12},(_,i)=>posting(`recover-${i}`));await refreshOnly(s.store,'example','ashby',{...s.options,fetchImpl:source(rows)});
 const original=s.queue.enqueue.bind(s.queue);let fail=true;
 s.queue.enqueue=async(...args)=>{const task=await original(...args);if(args[1]==='telegram-send'&&fail){fail=false;throw new Error('Synthetic uncertain enqueue');}return task;};
 assert.equal((await dispatchJobAlerts(s.store,s.options)).alerts,'retry-pending');
 const recovered=await dispatchJobAlerts(s.store,{...s.options,now:NOW+15*60000});assert.equal(recovered.alertQueued,10);assert.equal(recovered.pendingAlerts,2);
 assert.ok((await s.queue.list(s.store.userId)).some(task=>task.type==='job-alerts'&&task.availableAt===NOW+30*60000),'remaining two are scheduled even after outbox recovery');
});
