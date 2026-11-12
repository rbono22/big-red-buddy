import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm,utimes} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {tmpdir,cpus} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {MODEL_TYPES,REMINDER_TYPES,DISCOVERY_TYPES} from '../lib/job-handlers.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
async function until(check,{timeout=15000,interval=30}={}){const start=Date.now();while(Date.now()-start<timeout){const value=await check();if(value)return value;await delay(interval);}throw new Error('Timed out awaiting worker test condition');}
const quantile=(values,q)=>values.slice().sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*q))]??null;

test('worker claim groups keep job discovery out of reminder and model capacity',()=>{
 assert.deepEqual(DISCOVERY_TYPES,['jobs-search','job-alerts']);
 assert.equal(REMINDER_TYPES.includes('jobs-search'),false);
 assert.equal(MODEL_TYPES.includes('jobs-search'),false);
 assert.ok(MODEL_TYPES.includes('career-experience'));
 assert.ok(MODEL_TYPES.includes('telegram-syllabus'));
 for(const group of [MODEL_TYPES,REMINDER_TYPES,DISCOVERY_TYPES])assert.equal(new Set(group).size,group.length);
 const all=[...MODEL_TYPES,...REMINDER_TYPES,...DISCOVERY_TYPES];assert.equal(new Set(all).size,all.length);
});

test('dedicated discovery process preserves reminder throughput with its capacity fully occupied',{timeout:30000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'brf-discovery-worker-')),children=[],key=randomBytes(32).toString('base64');let db,queue;
 const stop=async child=>{if(child.exitCode!==null||child.signalCode!==null)return;const ended=once(child,'exit');child.kill('SIGTERM');await Promise.race([ended,delay(7000,undefined,{ref:false}).then(()=>child.kill('SIGKILL'))]);};
 try {
  db=await openDatabase({dataDir:directory,databaseUrl:null,encryptionKey:key,allowLocal:true,production:false});queue=await createQueue(db,{workerDatabaseUrl:null,concurrency:1});
  const guard=path.join(directory,'no-network.mjs');await writeFile(guard,"globalThis.fetch=async()=>{throw new Error('Network disabled in synthetic worker test');};\n");
  const student='synthetic-worker-student';await db.forUser(student).put('settings','profile',{jobTitles:'Synthetic Product Manager',paused:false});
  const searches=[];for(let i=0;i<8;i++)searches.push(await queue.enqueue(student,'jobs-search',{board:`synthetic${i}`,provider:'greenhouse'},{priority:-10,retrySafe:true}));
  const held=await queue.claim('synthetic-held-discovery',{types:DISCOVERY_TYPES,leaseMs:90000});assert.equal(held.id,searches[0].id);
  const chat=await queue.enqueue(student,'chat',{question:'Synthetic queued model work'},{retrySafe:true});
  const reminder=await queue.enqueue(student,'reminders',{}, {priority:100,retrySafe:false,maxAttempts:1});
  const launch=async role=>{
   const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--import',guard,'worker.mjs'],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1:4318',DATA_ENCRYPTION_KEY:key,ASSISTANT_DATA:directory,WORKER_ROLE:role,WORKER_CONCURRENCY:'1',REMINDER_CONCURRENCY:'2',DISCOVERY_CONCURRENCY:'1',WORKER_HEARTBEAT_PATH:path.join(directory,`${role}-heartbeat`),OLLAMA_URL:'http://127.0.0.1:1'},stdio:['ignore','pipe','pipe']});
   children.push(child);let ready=false,error='';child.stdout.on('data',data=>{if(data.toString().includes(`worker ready (${role})`))ready=true;});child.stderr.on('data',data=>{error+=data.toString().slice(0,1000);});
   await until(()=>{if(child.exitCode!==null)throw new Error(`Worker startup failed: ${error}`);return ready;});
  };
  await launch('discovery');
  await until(async()=>(await db.system.all('workerHealth')).some(row=>row.role==='discovery'));
  assert.equal(await db.forUser(student).get('settings','newsRetention'),null,'discovery must not run the shared scheduler');
  assert.equal((await queue.get(student,reminder.id)).status,'queued','discovery never claims reminder work');
  await launch('reminders');
  const result=await until(async()=>{const row=await queue.get(student,reminder.id);return row?.status==='completed'?row:null;});
  assert.equal(result.result.reason,'telegram-not-linked');
  assert.equal((await queue.get(student,chat.id)).status,'queued','neither worker claims model work');
  assert.equal((await queue.get(student,held.id)).status,'running');
  for(const search of searches.slice(1))assert.equal((await queue.get(student,search.id)).status,'queued','only the occupied discovery group may claim job searches');
  const health=await db.system.all('workerHealth');assert.ok(health.some(row=>row.role==='discovery'));assert.ok(health.some(row=>row.role==='reminders'));
 } finally {await Promise.all(children.map(stop));if(queue)await queue.close();if(db)await db.close();await rm(directory,{recursive:true,force:true});}
});

test('worker health recognizes discovery while rejecting stale files and invalid configuration',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'brf-discovery-health-')),heartbeat=path.join(directory,'heartbeat');
 const check=extra=>spawnSync(process.execPath,['deploy/worker-health.mjs'],{cwd:root,env:{PATH:process.env.PATH,WORKER_ROLE:'discovery',WORKER_HEARTBEAT_PATH:heartbeat,...extra},encoding:'utf8'});
 try {
  await writeFile(heartbeat,String(Date.now()));assert.equal(check().status,0);
  assert.equal(check({WORKER_ROLE:'unknown'}).status,1);assert.equal(check({WORKER_HEARTBEAT_MAX_AGE_MS:'not-a-number'}).status,1);
  const old=new Date(Date.now()-180000);await utimes(heartbeat,old,old);assert.equal(check().status,1);
  const failed=spawnSync(process.execPath,['worker.mjs'],{cwd:root,env:{PATH:process.env.PATH,NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1:4318',WORKER_ROLE:'discovery',DISCOVERY_CONCURRENCY:'0',ASSISTANT_DATA:directory},encoding:'utf8'});
  assert.equal(failed.status,1);assert.match(failed.stderr,/DISCOVERY_CONCURRENCY must be an integer from 1 to 16/);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('real PostgreSQL worker processes preserve reminders during blocked generation, recover crashes, and measure synthetic batch capacity',{skip:!process.env.TEST_POSTGRES_ADMIN_URL,timeout:60000},async()=>{
 const adminUrl=process.env.TEST_POSTGRES_ADMIN_URL,suffix=randomBytes(5).toString('hex'),name=`dabas_worker_test_${suffix}`,owner=`worker_owner_${suffix}`,app=`worker_app_${suffix}`,worker=`worker_jobs_${suffix}`;
 const admin=new Pool({connectionString:adminUrl,max:1}),directory=await mkdtemp(path.join(tmpdir(),'dabas-worker-test-')),children=[];
 const urlFor=(role,database=name)=>{const url=new URL(adminUrl);url.username=role;url.password='';url.pathname=`/${database}`;return url.toString();};
 let db,queue,ownerPool,server,blocked=true,requestCount=0,concurrentRequests=0,maximumConcurrent=0;const prompts=[];
 const heldResponses=new Set();
 const respond=res=>{if(res.destroyed)return;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({message:{content:JSON.stringify({answer:'Synthetic test response; no personal source data.'})}}));};
 const stop=async(child,signal='SIGTERM')=>{if(child.exitCode!==null||child.signalCode!==null)return;const ended=once(child,'exit');child.kill(signal);await Promise.race([ended,delay(7000,undefined,{ref:false}).then(()=>child.kill('SIGKILL'))]);};
 try {
  await admin.query('BEGIN');await admin.query('SELECT pg_advisory_xact_lock(118327,99)');
  for(const role of ['dabas_app','dabas_worker'])if(!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query('COMMIT');
  for(const role of [owner,app,worker])await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT dabas_app TO ${app},${worker}`);await admin.query(`GRANT dabas_worker TO ${worker}`);await admin.query(`CREATE DATABASE ${name} OWNER ${owner}`);
  ownerPool=new Pool({connectionString:urlFor(owner),max:2});await ownerPool.query(await readFile(new URL('../migrations/001_tenants_and_queue.sql',import.meta.url),'utf8'));
  const key=randomBytes(32).toString('base64');db=await openDatabase({databaseUrl:urlFor(app),encryptionKey:key,production:true});queue=await createQueue(db,{workerDatabaseUrl:urlFor(worker),concurrency:1});
  server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);prompts.push(JSON.parse(Buffer.concat(chunks).toString()).messages);requestCount++;concurrentRequests++;maximumConcurrent=Math.max(maximumConcurrent,concurrentRequests);heldResponses.add(res);res.on('close',()=>{concurrentRequests--;heldResponses.delete(res);});if(!blocked)respond(res);});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const launch=async role=>{
   const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','worker.mjs'],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'test',APP_ORIGIN:'http://127.0.0.1:4318',DATABASE_URL:urlFor(app),WORKER_DATABASE_URL:urlFor(worker),DATA_ENCRYPTION_KEY:key,ASSISTANT_DATA:directory,WORKER_ROLE:role,WORKER_CONCURRENCY:'1',REMINDER_CONCURRENCY:'2',WORKER_HEARTBEAT_PATH:path.join(directory,`heartbeat-${children.length}`),OLLAMA_URL:`http://127.0.0.1:${server.address().port}`,OLLAMA_MODEL:'synthetic-test-stub'},stdio:['ignore','pipe','pipe']});
   children.push(child);let ready=false,error='';child.stdout.on('data',data=>{if(data.toString().includes('worker ready'))ready=true;});child.stderr.on('data',data=>{error+=data.toString().slice(0,1000);});
   await until(()=>{if(child.exitCode!==null)throw new Error(`Worker exited during startup: ${error}`);return ready;});return child;
  };
  const first=await launch('all'),second=await launch('all');
  await db.forUser('isolation-student').put('events','one',{title:'UNIQUE_STUDENT_A',date:'2026-11-13'});await db.forUser('isolation-other').put('events','one',{title:'UNIQUE_STUDENT_B',date:'2026-11-13'});
  const slow=await queue.enqueue('isolation-student','chat',{question:'Synthetic generation request'},{retrySafe:true});
  await until(()=>requestCount===1);const other=await queue.enqueue('isolation-other','chat',{question:'Another synthetic request'},{retrySafe:true});await delay(700);assert.equal(maximumConcurrent,1);assert.equal(requestCount,1);
  const reminderStart=Date.now(),reminder=await queue.enqueue('isolation-student','reminders',{}, {retrySafe:false,maxAttempts:1});
  const reminded=await until(async()=>{const job=await queue.get('isolation-student',reminder.id);return job?.status==='completed'?job:null;});
  const reminderElapsedMs=Date.now()-reminderStart;
  assert.equal(reminded.result.reason,'telegram-not-linked');assert.equal((await queue.get('isolation-student',slow.id)).status,'running','generation remains blocked while reminders complete');
  await stop(first,'SIGKILL');await stop(second,'SIGKILL');await until(()=>concurrentRequests===0);
  await ownerPool.query("UPDATE dabas.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[slow.id]);
  blocked=false;await launch('all');await launch('all');
  const recovered=await until(async()=>{const job=await queue.get('isolation-student',slow.id);return job?.status==='completed'?job:null;});assert.equal(recovered.attempts,2);await until(async()=>(await queue.get('isolation-other',other.id))?.status==='completed');assert.equal(requestCount,3);
  for(const messages of prompts){const text=JSON.stringify(messages);assert.notEqual(text.includes('UNIQUE_STUDENT_A'),text.includes('UNIQUE_STUDENT_B'),'each model request has exactly one student context');}
  const fixture='Hi Section 2! Milestone 5 and Maker Day 3 PDF uploads are due by Friday November 13. Milestone 5: One PDF: your risk register, your three experiment cards, and the data from the experiments underway. Maker Day 3: Upload your slides as one PDF by 5:00 p.m. on Nov 13. Your Milestone 5 PDF is a separate upload.';
  const batchStart=Date.now(),ids=[];
  for(let student=0;student<10;student++)for(let item=0;item<3;item++)ids.push(await queue.enqueue(`capacity-student-${student}`,'studio',{text:fixture,sourceUrl:`https://example.test/synthetic/${student}/${item}`},{retrySafe:true}));
  const finished=await until(async()=>{const jobs=(await Promise.all(Array.from({length:10},(_,student)=>queue.list(`capacity-student-${student}`)))).flat();return jobs.length===30&&jobs.every(job=>job.status==='completed')?jobs:null;});
  const elapsedMs=Date.now()-batchStart;
  assert.equal(finished.length,30);assert.equal(finished.every(job=>job.result.count===2),true);assert.equal(requestCount,3,'deterministic adapter benchmark must not call a model');
  for(let student=0;student<10;student++){const events=await db.forUser(`capacity-student-${student}`).all('events');assert.equal(events.length,6);assert.equal(events.every(event=>event.sourceUrl.startsWith(`https://example.test/synthetic/${student}/`)),true);}
  const result={generatedAt:new Date().toISOString(),scope:'Synthetic deterministic extraction and PostgreSQL orchestration; not real model throughput or Telegram delivery',environment:{node:process.version,postgres:(await admin.query('SHOW server_version')).rows[0].server_version,platform:process.platform,architecture:process.arch,cpu:cpus()[0]?.model,workerProcesses:2,globalModelConcurrency:1,reminderConcurrency:2},batch:{students:10,jobs:30,events:60,elapsedMs,completed:30,failed:0,queueDelayP50Ms:quantile(finished.map(job=>job.startedAt-job.createdAt),.5),queueDelayP95Ms:quantile(finished.map(job=>job.startedAt-job.createdAt),.95),processingP50Ms:quantile(finished.map(job=>job.completedAt-job.startedAt),.5),processingP95Ms:quantile(finished.map(job=>job.completedAt-job.startedAt),.95)},reliability:{reminderProcessedWhileModelBlocked:true,reminderProcessingElapsedMs:reminderElapsedMs,reminderDelivery:'not attempted; no Telegram account/token configured',maximumConcurrentStubRequests:maximumConcurrent,crashRecoveryAttempts:recovered.attempts,duplicateActiveClaimsObserved:0},cost:{realModelInferenceMeasured:false,dollarsMeasured:null,note:'No paid external API calls. Hosting and real inference costs require a measured deployment.'}};
  if(process.env.WRITE_CAPACITY_REPORT==='true'){await mkdir(path.join(root,'output'),{recursive:true});await writeFile(path.join(root,'output','capacity-test.json'),JSON.stringify(result,null,2)+'\n');}
 } finally {
  blocked=false;for(const res of heldResponses)respond(res);
  await Promise.all(children.map(child=>stop(child)));if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(queue)await queue.close();if(db)await db.close();if(ownerPool)await ownerPool.end();
  try {
   // Pool.end() may resolve before PostgreSQL sees the final socket close.
   // Drain normally; forcing backend termination can emit late client errors.
   const deadline=Date.now()+5000;let connections;
   do {
    connections=Number((await admin.query('SELECT count(*) AS count FROM pg_stat_activity WHERE datname=$1',[name])).rows[0].count);
    if(!connections)break;
    await delay(20);
   }while(Date.now()<deadline);
   assert.equal(connections,0,'all worker test database clients must disconnect before teardown');
   await admin.query(`DROP DATABASE IF EXISTS ${name}`);
   for(const role of [app,worker,owner])await admin.query(`DROP ROLE IF EXISTS ${role}`);
  } finally {await admin.end();await rm(directory,{recursive:true,force:true});}
 }
});
