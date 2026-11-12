import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';

// Only a synthetic local web process runs. Queued searches/analysis are never
// executed, and the child's fetch is disabled so it cannot contact providers.
test('job-search HTTP routes select starter employers and preserve per-student inputs and settings',{timeout:30000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brf-job-search-api-')),origin='http://127.0.0.1:4359';
 const env={PATH:process.env.PATH,LANG:'en_US.UTF-8',NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4359',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64'),DEV_AUTH_EMAILS:'jobs-a@cornell.edu,jobs-b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
 const guard=path.join(dir,'no-network.mjs');await writeFile(guard,"globalThis.fetch=async()=>{throw new Error('Provider calls disabled in synthetic API test');};\n");
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--import',guard,'server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});let output='',database,queue;
 child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),11000);timer.unref();try{await stopped;}finally{clearTimeout(timer);}}await queue?.close();await database?.close();await rm(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<150;i++){try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(`Synthetic server failed: ${output}`);await delay(50);}assert.ok(ready,output);
 async function login(email){const response=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');return {...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json(),cookie};}
 async function api(user,route,body,headers={}){const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{Cookie:user.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':user.csrfToken,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
 for(const route of ['/api/jobs/sources','/api/jobs/discovery/settings','/api/career/experience','/api/tasks'])assert.equal((await fetch(origin+route)).status,401);
 assert.equal((await fetch(origin+'/api/jobs/search',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,401);
 const alice=await login('jobs-a@cornell.edu'),bob=await login('jobs-b@cornell.edu');
 database=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});queue=await createQueue(database,{workerDatabaseUrl:null});
 const a=database.forUser(alice.user.id),b=database.forUser(bob.user.id);

 await t.test('authentication, CSRF, and origin checks precede search mutations',async()=>{
  assert.equal((await api(alice,'/api/jobs/search',{}, {'X-CSRF-Token':''})).status,403);
  assert.equal((await api(alice,'/api/jobs/search',{}, {'X-CSRF-Token':bob.csrfToken})).status,403);
  assert.equal((await api(alice,'/api/jobs/search',{}, {Origin:'https://attacker.example'})).status,403);
  assert.equal((await api(alice,'/api/jobs/sources',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.deepEqual(await queue.list(alice.user.id),[]);
 });

 let catalog,first;
 await t.test('target roles alone permit one-action search across eight named starters',async()=>{
  const empty=await api(alice,'/api/jobs/search',{});assert.equal(empty.status,400);assert.match(empty.body.error,/target job titles|resume/i);
  catalog=(await api(alice,'/api/jobs/sources')).body;assert.equal(catalog.sources.length,8);assert.match(catalog.coverage,/not a whole-web search/);assert.equal(catalog.verification,undefined);
  assert.equal((await api(alice,'/api/settings',{jobTitles:'Product Manager, Data Analyst',jobLocation:'New York'})).status,200);
  first=await api(alice,'/api/jobs/search',{});assert.equal(first.status,202);assert.equal(first.body.taskIds.length,8);assert.equal(first.body.sources.length,8);assert.equal(first.body.experienceTaskId,null);assert.equal(first.body.taskId,first.body.taskIds[0]);assert.match(first.body.coverage,/not a whole-web search/);
  assert.deepEqual(new Set(first.body.sources.map(source=>`${source.provider}:${source.board}`)),new Set(catalog.sources.map(source=>`${source.provider}:${source.board}`)));
  const tasks=await queue.list(alice.user.id);assert.equal(tasks.length,8);assert.ok(tasks.every(task=>task.type==='jobs-search'&&task.status==='queued'&&task.userId===alice.user.id&&task.payload===undefined));
  assert.deepEqual(await queue.list(bob.user.id),[]);
  assert.equal((await api(alice,'/api/career/experience')).body.status,'no-resume');
 });

 await t.test('current private resume adds one separate experience-analysis task without copying its text',async()=>{
  const resume={name:'BOB_PRIVATE_SYNTHETIC_RESUME.pdf',text:'BOB_PRIVATE_RESUME_TEXT\nSynthetic Product Analyst\nExplicit full-time role from January 2024 to March 2025. Built SQL dashboards.',updatedAt:'2026-11-10T12:00:00Z'};
  await b.put('documents','resume',resume);
  const searched=await api(bob,'/api/jobs/search',{});assert.equal(searched.status,202);assert.equal(searched.body.sources.length,8);assert.equal(searched.body.taskIds.length,9);assert.ok(searched.body.experienceTaskId);assert.ok(searched.body.taskIds.includes(searched.body.experienceTaskId));
  const analysis=await queue.get(bob.user.id,searched.body.experienceTaskId);assert.equal(analysis.type,'career-experience');assert.equal(analysis.status,'queued');assert.equal(analysis.payload,undefined);assert.equal(await queue.get(alice.user.id,analysis.id),null);
  const own=(await api(bob,'/api/career/experience')).body;assert.equal(own.source.name,resume.name);assert.equal(own.analyzed,false);assert.equal(own.totalMonths,null);assert.equal(own.status,'needs-review');
  assert.equal((await api(alice,'/api/career/experience')).body.status,'no-resume');
  assert.doesNotMatch(JSON.stringify((await api(alice,'/api/state')).body),/BOB_PRIVATE/);
  assert.doesNotMatch(JSON.stringify((await api(bob,'/api/tasks')).body),/BOB_PRIVATE|full-time role|January 2024/);
  const claimed=await queue.claim('job-search-api-experience-inspector',{types:['career-experience'],leaseMs:90000});assert.equal(claimed.id,analysis.id);assert.equal(claimed.userId,bob.user.id);assert.deepEqual(Object.keys(claimed.payload),['sourceHash']);assert.equal(claimed.payload.sourceHash,own.sourceHash);
  assert.equal((await a.all('career')).length,0);
 });

 await t.test('two- or three-year stretch is explicit, validated, and isolated',async()=>{
  assert.deepEqual((await api(alice,'/api/jobs/discovery/settings')).body,{stretchYears:3});
  assert.deepEqual((await api(bob,'/api/jobs/discovery/settings')).body,{stretchYears:3});
  assert.equal((await api(alice,'/api/jobs/discovery/settings',{stretchYears:2},{'X-CSRF-Token':''})).status,403);
  for(const invalid of [{},{stretchYears:0},{stretchYears:1},{stretchYears:4},{stretchYears:'2'},{stretchYears:null},{stretchYears:2,userId:bob.user.id},[],null])assert.equal((await api(alice,'/api/jobs/discovery/settings',invalid)).status,400);
  const changed=await api(alice,'/api/jobs/discovery/settings',{stretchYears:2});assert.equal(changed.status,200);assert.deepEqual(changed.body,{stretchYears:2});
  assert.deepEqual((await api(bob,'/api/jobs/discovery/settings')).body,{stretchYears:3});
  assert.equal((await api(alice,'/api/state')).body.jobDiscovery.settings.stretchYears,2);
  assert.equal((await api(bob,'/api/state')).body.jobDiscovery.settings.stretchYears,3);
  assert.equal((await api(alice,'/api/jobs/discovery/settings',{stretchYears:3})).status,200);
 });

 await t.test('registry IDs and advanced board choice support selected sources without cross-tenant mutation',async()=>{
  const selected=await api(alice,'/api/jobs/search',{sourceIds:['figma','notion','figma']});assert.equal(selected.status,202);assert.equal(selected.body.sources.length,2);assert.deepEqual(selected.body.sources.map(source=>source.name),['Figma','Notion']);
  const advanced=await api(alice,'/api/jobs/search',{provider:'greenhouse',board:'synthetic_custom_employer'});assert.equal(advanced.status,202);assert.equal(advanced.body.sources.length,1);assert.equal(advanced.body.sources[0].board,'synthetic_custom_employer');assert.equal(await queue.get(bob.user.id,advanced.body.taskId),null);
  for(const invalid of [{sourceIds:['not-a-catalog-employer']},{sourceIds:'figma'},{userId:bob.user.id},{sourceIds:['figma'],provider:'greenhouse',board:'figma'}])assert.equal((await api(alice,'/api/jobs/search',invalid)).status,400);
  assert.doesNotMatch(JSON.stringify((await api(bob,'/api/tasks')).body),/synthetic_custom_employer/);
 });

 await t.test('hosted career URLs are parsed locally and unsafe or mixed selections are rejected',async()=>{
  const parsed=await api(bob,'/api/jobs/search',{careerUrl:'https://jobs.ashbyhq.com/synthetic_company?token=PRIVATE_QUERY#apply'});assert.equal(parsed.status,202);assert.equal(parsed.body.sources.length,1);assert.equal(parsed.body.sources[0].provider,'ashby');assert.equal(parsed.body.sources[0].board,'synthetic_company');assert.doesNotMatch(JSON.stringify(parsed.body),/PRIVATE_QUERY|token=/);
  const invalids=[{careerUrl:'http://jobs.ashbyhq.com/notion'},{careerUrl:'https://127.0.0.1/private'},{careerUrl:'https://secret@jobs.ashbyhq.com/notion'},{provider:'unsupported',board:'example'},{provider:'greenhouse',board:'../../private'},{careerUrl:'https://jobs.ashbyhq.com/notion',sourceIds:['notion']}];
  for(const invalid of invalids)assert.equal((await api(bob,'/api/jobs/search',invalid)).status,400);
 });

 await t.test('queued discovery payloads contain only fixed provider identifiers; workers and providers never run',async()=>{
  const allTasks=[...await queue.list(alice.user.id),...await queue.list(bob.user.id)];
  assert.ok(allTasks.filter(task=>task.type==='jobs-search').every(task=>task.status==='queued'));
  const sources=[];
  while(true){const task=await queue.claim('job-search-api-source-inspector',{types:['jobs-search'],leaseMs:90000});if(!task)break;assert.deepEqual(Object.keys(task.payload).sort(),['board','provider']);assert.ok(['greenhouse','ashby'].includes(task.payload.provider));assert.match(task.payload.board,/^[A-Za-z0-9_-]{1,80}$/);assert.equal(task.priority,-10);assert.ok([alice.user.id,bob.user.id].includes(task.userId));sources.push(task.payload);await queue.complete(task,{syntheticInspectionOnly:true});}
  assert.ok(sources.length>=18);assert.equal(JSON.stringify(sources).includes('PRIVATE'),false);
  assert.equal((await a.all('jobs')).length,0);assert.equal((await b.all('jobs')).length,0);
  assert.equal((await a.all('applications')).length,0);assert.equal((await b.all('applications')).length,0);
  assert.deepEqual(await database.system.all('workerHealth'),[]);
 });
});
