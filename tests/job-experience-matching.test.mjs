import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {analyzeCareerExperience,readCareerExperience} from '../lib/career-experience.mjs';
import {scoreJobRelevance,refreshJobBoard,refreshStoredJobMatches,jobMatchingFingerprint,resumeStretchSignals,dispatchJobAlerts} from '../lib/job-discovery.mjs';
import {saveJobDiscoverySettings} from '../lib/job-preferences.mjs';
import {saveNotificationPreferences} from '../lib/notification-preferences.mjs';
import {dispatchQueuedTelegram} from '../lib/telegram-delivery.mjs';
import {sendTelegram} from '../lib/integrations.mjs';
import {queueExperienceAnalysis} from '../lib/career-experience-jobs.mjs';

const roles=[{title:'Product Manager',employer:'Example Co',kind:'employment',employmentType:'full-time',typeEvidence:'Full-time',dateEvidence:'January 2020 – December 2022',evidence:'Product Manager · Example Co\nFull-time\nJanuary 2020 – December 2022',startMonth:'2020-01',endMonth:'2022-12'},{title:'Intern',employer:'Example Co',kind:'employment',employmentType:'internship',typeEvidence:'Full-time internship',dateEvidence:'January 2019 – December 2019',evidence:'Intern · Example Co\nFull-time internship\nJanuary 2019 – December 2019',startMonth:'2019-01',endMonth:'2019-12'}];
const posting=years=>({id:String(years),title:'Product Manager',location:'New York',descriptionPlain:`Required: ${years} years of professional experience. SQL experience.`,jobUrl:`https://jobs.ashbyhq.com/example/${years}`,publishedAt:new Date(Date.now()-3600000).toISOString()});
async function setup(t){const dir=await mkdtemp(path.join(tmpdir(),'brf-match-experience-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true}),store=db.forUser('student');t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});await store.put('documents','resume',{name:'Synthetic.pdf',text:roles.map(r=>r.evidence).join('\n\n')+'\nLed a product team. Increased adoption 20% using SQL.',updatedAt:'2026-11-10'});await store.put('settings','profile',{jobTitles:'Product Manager',jobLocation:'New York'});await store.put('secrets','telegram',{chatId:123});await saveNotificationPreferences(store,{topics:{jobs:'alerts'}});await analyzeCareerExperience(store,{generate:async()=>({value:{roles}})});return {db,store};}

test('three full-time years exclude internships, allow the chosen stretch and re-score saved jobs without losing applications',async t=>{
 const {store}=await setup(t),experience=await readCareerExperience(store);assert.equal(experience.totalMonths,36);
 const fetchImpl=async()=>new Response(JSON.stringify({jobs:[posting(3),posting(6),posting(7)]}));
 const result=await refreshJobBoard(store,'example','ashby',{fetchImpl});assert.equal(result.count,2);
 let jobs=await store.all('jobs');assert.deepEqual(jobs.map(j=>j.externalId).sort(),['3','6']);
 const stretch=jobs.find(j=>j.externalId==='6');assert.equal(stretch.experienceFit.category,'stretch');assert.equal(stretch.experienceFit.minimumRequired,6);assert.ok(stretch.stretchSignals.some(s=>s.kind==='impact'));assert.match(stretch.matchBasis,/not.*percentage/);
 await store.put('jobs',stretch.id,{...stretch,status:'drafted'});await store.put('applications',stretch.id,{jobId:stretch.id,status:'submitted',studentReported:true});
 const before=await jobMatchingFingerprint(store);await saveJobDiscoverySettings(store,{stretchYears:2});assert.notEqual(await jobMatchingFingerprint(store),before);await refreshStoredJobMatches(store);
 const rescored=await store.get('jobs',stretch.id);assert.equal(rescored.eligible,false);assert.equal(rescored.status,'drafted');assert.equal(rescored.experienceFit.category,'outside-range');assert.equal((await store.get('applications',stretch.id)).status,'submitted');
 await saveJobDiscoverySettings(store,{stretchYears:3});await refreshStoredJobMatches(store);assert.equal((await store.get('jobs',stretch.id)).eligible,true);
});

test('uncertain experience or preferred-only requirements remain reviewable, with evidence rather than an invented qualification score',async t=>{
 const {store}=await setup(t),experience=await readCareerExperience(store),base={titles:'Product Manager',resume:'Promoted to manager. Led a team. Increased revenue 30%. SQL.',experience};
 assert.equal(scoreJobRelevance({title:'Product Manager',description:'Preferred: 10 years of experience.'},base).experienceFit.category,'unknown');
 const unknown=scoreJobRelevance({title:'Product Manager',description:'Required: 10 years of experience.'},{...base,experience:{...experience,status:'needs-review'}});assert.equal(unknown.eligible,true);assert.equal(unknown.experienceFit.category,'unknown');
 assert.deepEqual(resumeStretchSignals('Built SQL products.').map(s=>s.kind),[]);assert.equal(resumeStretchSignals('Disability: improved outcomes by 20%.').length,0);
 const before=await jobMatchingFingerprint(store);await store.put('career','demographics',{race:['private'],veteranStatus:'private'});assert.equal(await jobMatchingFingerprint(store),before);
});

test('changes while a source fetch is in flight prevent obsolete matches and alerts from being stored',async t=>{
 const {store}=await setup(t);let calls=0;
 const result=await refreshJobBoard(store,'example','ashby',{queue:{enqueue:async()=>{calls++;}},fetchImpl:async()=>{await saveJobDiscoverySettings(store,{stretchYears:2});return new Response(JSON.stringify({jobs:[posting(6)]}));}});
 assert.equal(result.superseded,true);assert.equal((await store.all('jobs')).length,0);assert.equal(calls,0);assert.equal((await store.get('settings','jobBoards')).boards[0].lastStatus,'superseded');
});

test('queued discovery alerts carry matching inputs and stale alerts are suppressed at the final send boundary',async t=>{
 const {store}=await setup(t),queued=[],calls=[],oldFetch=globalThis.fetch,oldToken=process.env.TELEGRAM_BOT_TOKEN;
 process.env.TELEGRAM_BOT_TOKEN='synthetic-job-experience';globalThis.fetch=async(url,options)=>{assert.equal(String(url),'https://api.telegram.org/botsynthetic-job-experience/sendMessage');calls.push(JSON.parse(options.body));return new Response(JSON.stringify({ok:true,result:{message_id:calls.length}}));};
 t.after(()=>{globalThis.fetch=oldFetch;if(oldToken===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=oldToken;});
 const queue={enqueue:async(userId,type,payload,options)=>{if(type==='telegram-send')queued.push({userId,type,payload,...options});return {id:'synthetic-task'};}};
 await refreshJobBoard(store,'example','ashby',{queue,fetchImpl:async()=>new Response(JSON.stringify({jobs:[posting(6)]}))});await dispatchJobAlerts(store,{queue});
 assert.equal(queued.length,1);assert.equal(queued[0].payload.notification.matchingFingerprint,await jobMatchingFingerprint(store));assert.match(queued[0].payload.text,/Experience:.*stretch/i);
 await dispatchQueuedTelegram(store,queued[0],{send:sendTelegram});assert.equal(calls.length,1);
 await saveJobDiscoverySettings(store,{stretchYears:2});const suppressed=await dispatchQueuedTelegram(store,queued[0],{send:sendTelegram});assert.equal(suppressed.suppressed,true);assert.equal(suppressed.reason,'job-matching-changed');assert.equal(calls.length,1);
 const legacy=await dispatchQueuedTelegram(store,{idempotencyKey:'job-discovery:legacy:0',payload:{text:'Old unsourced match'}},{send:sendTelegram});assert.equal(legacy.suppressed,true);assert.equal(calls.length,1);
 await saveJobDiscoverySettings(store,{stretchYears:3});let changed=false;const changing={...store,get:async(bucket,id)=>{const value=await store.get(bucket,id);if(!changed&&bucket==='career'&&id==='experience'){changed=true;await saveNotificationPreferences(store,{topics:{jobs:'off'}});}return value;}};
 const muted=await dispatchQueuedTelegram(changing,queued[0],{send:sendTelegram});assert.equal(muted.suppressed,true);assert.equal(muted.reason,'notification-preferences');assert.equal(calls.length,1);
});

test('analysis capacity errors preserve an uploaded resume and allow an explicit later retry',async t=>{
 const {store}=await setup(t),resume=await store.get('documents','resume');await store.delete('career','experience');const queue={enqueue:async()=>{throw new Error('STUDENT_MODEL_QUEUE_FULL');}};
 const deferred=await queueExperienceAnalysis(store,queue,{allowDeferred:true});assert.equal(deferred.taskId,null);assert.match(deferred.warning,/capacity/);assert.deepEqual(await store.get('documents','resume'),resume);
 await assert.rejects(queueExperienceAnalysis(store,queue,{force:true}),{status:429});
});
