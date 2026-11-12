import {pruneMenuActions} from './lib/telegram-menu.mjs';
import { pilotWorkAllowed, pilotSheetConfig } from './lib/pilot-access.mjs';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from './lib/database.mjs';
import { createQueue } from './lib/queue.mjs';
import { executeJob, MODEL_TYPES, REMINDER_TYPES, DISCOVERY_TYPES } from './lib/job-handlers.mjs';
import { pollSharedTelegram, pruneSharedMetadata } from './lib/telegram.mjs';
import { loadSecurityConfig } from './lib/security.mjs';
import { pruneExpiredAuthRecords } from './lib/auth.mjs';
import {scheduleDailyBriefing} from './lib/daily-briefing.mjs';
import {scheduleDailyEmail} from './lib/daily-email.mjs';
import {scheduleCampusSync} from './lib/campus-schedule.mjs';
import {pruneExpiredNewEventFlow} from './lib/newevent-telegram.mjs';
import {pruneExpiredInvitationFlow} from './lib/invitation-telegram.mjs';
import {jobMatchingFingerprint} from './lib/job-discovery.mjs';
import {pruneNews} from './lib/news.mjs';
import {scheduleLinkedInRefresh} from './lib/linkedin-refresh.mjs';
loadSecurityConfig();
pilotSheetConfig();
const role=process.env.WORKER_ROLE||'all';
if(!['all','model','reminders','discovery'].includes(role))throw new Error('WORKER_ROLE must be model, reminders, discovery, or all.');
function concurrency(name,fallback){const value=Number(process.env[name]??fallback);if(!Number.isInteger(value)||value<1||value>16)throw new Error(`${name} must be an integer from 1 to 16.`);return value;}
const modelConcurrency=concurrency('WORKER_CONCURRENCY',1),reminderConcurrency=concurrency('REMINDER_CONCURRENCY',2),discoveryConcurrency=concurrency('DISCOVERY_CONCURRENCY',1);
const db=await openDatabase({dataDir:process.env.ASSISTANT_DATA||'./data'});
const modelQueue=await createQueue(db,{concurrency:modelConcurrency,maxPendingPerUser:120});
const reminderQueue=await createQueue(db,{concurrency:reminderConcurrency,maxPendingPerUser:120});
const discoveryQueue=await createQueue(db,{concurrency:discoveryConcurrency,maxPendingPerUser:120});
const workerId=`${role}-${randomUUID()}`;let stopping=false;
const heartbeatPath=process.env.WORKER_HEARTBEAT_PATH||'/tmp/dabas-worker-heartbeat';
const stop=()=>{stopping=true;};process.on('SIGTERM',stop);process.on('SIGINT',stop);
async function loop(queue,types) {
  while(!stopping) {
    let job;
    try{job=await queue.claim(workerId,{types,leaseMs:90000});}catch{await delay(3000);continue;}
    if(!job){await delay(600);continue;}
    let renewing=false;
    const timer=setInterval(async()=>{if(renewing)return;renewing=true;try{await queue.heartbeat(job,{leaseMs:90000});}catch{/* Final transition remains fenced. */}finally{renewing=false;}},20000);
    try {const result=await executeJob(db,job);await queue.complete(job,result);}
    catch(error) {const code=['SYLLABUS_OCR_FAILED','SYLLABUS_EXTRACTION_FAILED'].includes(error?.code)?error.code:'PROCESSING_FAILED';await queue.fail(job,{retryable:error?.retryable!==false,code}).catch(()=>{});}
    finally{clearInterval(timer);}
  }
}
async function scheduler() {
  let lastSchedule=0,lastTelegram=0,lastMaintenance=0,lastLinkedIn=0;
  while(!stopping) {
    try {
      await db.system.put('workerHealth',workerId,{role,lastSeen:Date.now()});
      await writeFile(heartbeatPath,String(Date.now()),{mode:0o600});
      if(Date.now()-lastMaintenance>300000){lastMaintenance=Date.now();await pruneExpiredAuthRecords(db);await pruneSharedMetadata(db);}
      if(Date.now()-lastSchedule>15000) {
        lastSchedule=Date.now();
        const checkLinkedIn=Date.now()-lastLinkedIn>15*60000;if(checkLinkedIn)lastLinkedIn=Date.now();
        for(const userId of await db.listUserIds()) {
          const store=db.forUser(userId);if((await store.get('settings','account'))?.deleting)continue;
          // Retention cleanup also runs after pilot access is revoked.
          await pruneExpiredInvitationFlow(store).catch(()=>{});
          await pruneMenuActions(store).catch(()=>{});
          if (!await pilotWorkAllowed(db, userId)) continue;
          const newsRetention=await store.get('settings','newsRetention');
          if(!newsRetention?.lastRun||Date.parse(newsRetention.lastRun)<Date.now()-86400000){await pruneNews(store);await store.put('settings','newsRetention',{lastRun:new Date().toISOString()});}
          await pruneExpiredNewEventFlow(store).catch(()=>{});
          // A crashed transmission is uncertain, never blindly repeated.
          for(const r of await store.all('reminders'))if(r.status==='sending'&&Date.parse(r.sendingAt||0)<Date.now()-120000)await store.compareAndSet('reminders',r.id,r,{...r,status:'needs-review'});
          if(await store.get('secrets','telegram'))await reminderQueue.enqueue(userId,'reminders',{}, {idempotencyKey:`tick:${Math.floor(Date.now()/15000)}`,priority:100,retrySafe:false,maxAttempts:1});
          await scheduleDailyBriefing(store,reminderQueue).catch(()=>{});
          await scheduleDailyEmail(store,reminderQueue).catch(()=>{});
          if(checkLinkedIn)await scheduleLinkedInRefresh(store,reminderQueue).catch(()=>{});
          const slack=await store.get('secrets','slack'), health=await store.get('settings','slackHealth');
          if(slack?.channel&&Date.parse(health?.lastSuccess||0)<Date.now()-15*60000)await modelQueue.enqueue(userId,'slack-sync',{}, {idempotencyKey:`slack:${Math.floor(Date.now()/900000)}`,retrySafe:false,maxAttempts:1}).catch(()=>{});
          await scheduleCampusSync(store,reminderQueue).catch(()=>{});
          const campusSecret=await store.get('secrets','campusGoogle');
          const partiful=await store.get('settings','partifulCalendar');
          if(partiful?.continuous&&partiful.calendarId&&campusSecret?.refresh_token&&(!partiful.lastSuccess||Date.parse(partiful.lastSuccess)<Date.now()-15*60000))await reminderQueue.enqueue(userId,'partiful-sync',{}, {idempotencyKey:`partiful:${Math.floor(Date.now()/900000)}`,retrySafe:true}).catch(()=>{});
          const luma=await store.get('settings','lumaCalendar');
          if(luma?.continuous&&luma.calendarId&&campusSecret?.refresh_token&&(!luma.lastSuccess||Date.parse(luma.lastSuccess)<Date.now()-15*60000))await reminderQueue.enqueue(userId,'luma-sync',{}, {idempotencyKey:`luma:${Math.floor(Date.now()/900000)}`,retrySafe:false,maxAttempts:1}).catch(()=>{});
          const eventEmail=await store.get('settings','eventEmail'),eventGrant=await store.get('secrets','eventEmailGoogle');
          if(eventEmail?.continuous&&(eventEmail.mode==='automatic'&&eventEmail.providers?.length||eventEmail.labelId)&&eventGrant?.refresh_token&&eventEmail.connectionRevision===eventGrant.connectionRevision&&!(await store.get('settings','profile'))?.paused&&(!eventEmail.lastSuccess||Date.parse(eventEmail.lastSuccess)<Date.now()-15*60000))await modelQueue.enqueue(userId,'event-email-sync',{}, {idempotencyKey:`event-email:${Math.floor(Date.now()/900000)}`,retrySafe:false,maxAttempts:1}).catch(()=>{});
          const newsEmail=await store.get('settings','newsEmail'),newsSettings=await store.get('settings','news'),newsGrant=await store.get('secrets','eventEmailGoogle');
          if(newsEmail?.continuous&&(newsEmail.mode==='automatic'||newsEmail.labelId)&&newsSettings?.sources?.length&&newsGrant?.refresh_token&&newsEmail.connectionRevision===newsGrant.connectionRevision&&!(await store.get('settings','profile'))?.paused&&!(await store.get('settings','account'))?.deleting&&(!newsEmail.lastSuccess||Date.parse(newsEmail.lastSuccess)<Date.now()-15*60000))await modelQueue.enqueue(userId,'news-sync',{}, {idempotencyKey:`news:${Math.floor(Date.now()/900000)}`,retrySafe:false,maxAttempts:1}).catch(()=>{});
          const canvas=await store.get('settings','canvasFeed');
          if(canvas?.connected&&!(await store.get('settings','profile'))?.paused&&(!canvas.lastAttempt||Date.parse(canvas.lastAttempt)<Date.now()-4*3600000))await reminderQueue.enqueue(userId,'canvas-sync',{}, {idempotencyKey:`canvas:${Math.floor(Date.now()/(4*3600000))}`,retrySafe:true,maxAttempts:2}).catch(()=>{});
          const academic=await store.get('settings','academicCalendar');
          if(academic&&(!academic.lastSuccess||Date.parse(academic.lastSuccess)<Date.now()-86400000))await reminderQueue.enqueue(userId,'academic-refresh',{}, {idempotencyKey:`academic:${Math.floor(Date.now()/86400000)}`,retrySafe:false,maxAttempts:1}).catch(()=>{});
          const boards=(await store.get('settings','jobBoards'))?.boards||[];
          const matchingFingerprint=boards.length?await jobMatchingFingerprint(store):null;
          for(const board of boards)if(board.nextRun<Date.now()||(board.matchingFingerprint!==matchingFingerprint&&board.attemptedFingerprint!==matchingFingerprint))await discoveryQueue.enqueue(userId,'jobs-search',{board:board.board,provider:board.provider},{idempotencyKey:`board:${board.key}:${Math.floor(Date.now()/900000)}:${matchingFingerprint}`,priority:-10,retrySafe:true}).catch(()=>{});
        }
      }
      if(Date.now()-lastTelegram>5000){lastTelegram=Date.now();void pollSharedTelegram(db,modelQueue,workerId).catch(()=>{});}
    }catch{/* Health timestamp becomes stale; operations monitor detects outages. */}
    await delay(1000);
  }
}
async function workerHeartbeat(){while(!stopping){try{await db.system.put('workerHealth',workerId,{role,lastSeen:Date.now()});await writeFile(heartbeatPath,String(Date.now()),{mode:0o600});}catch{}await delay(5000);}}
const loops=[];
if(role==='all'||role==='model')for(let i=0;i<modelConcurrency;i++)loops.push(loop(modelQueue,MODEL_TYPES));
if(role==='all'||role==='discovery')for(let i=0;i<discoveryConcurrency;i++)loops.push(loop(discoveryQueue,DISCOVERY_TYPES));
if(role==='all'||role==='reminders'){loops.push(scheduler());for(let i=0;i<reminderConcurrency;i++)loops.push(loop(reminderQueue,REMINDER_TYPES));}else loops.push(workerHeartbeat());
console.log(`Dabas worker ready (${role}); private payloads are not logged.`);
await Promise.all(loops);await modelQueue.close();await reminderQueue.close();await discoveryQueue.close();await db.close();
