import {randomUUID} from 'node:crypto';
import {idFor,localISO,TZ} from './domain.mjs';
import {CALENDAR_SCOPE,CAMPUS_CALENDAR_SCOPES} from './auth.mjs';
import {HttpError} from './security.mjs';
import {createCampusCalendar,addCampusEvent,withCalendarSourceLock} from './campus-calendar.mjs';

export const CAMPUS_DAILY_SCHEDULE=Object.freeze({time:'05:00',timezone:TZ,catchupHours:6,maxAutomaticEvents:500});
const HOUR=3600000,WINDOW=6*HOUR,MAX_ROUNDS=3,MAX_AUTO=500;
const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'});
const localDay=at=>dateFormat.format(new Date(at));
function clock(value=Date.now){return ()=>{const current=typeof value==='function'?value():value;const at=current instanceof Date?current.getTime():typeof current==='number'?current:Date.parse(current);if(!Number.isFinite(at))throw new HttpError(400,'Use a valid campus refresh date.');return at;};}
export const campusSourceKey=config=>config?.calendarId?idFor('campus-source-revision',config.calendarId,config.connectionRevision||config.selectedAt||'legacy'):null;
const hasScope=(credential,scope)=>String(credential?.scope||'').split(/\s+/).includes(scope);
async function state(store){
 if(!store?.userId||!store.compareAndSet)throw new Error('Campus scheduling requires a student-owned atomic store.');
 const [config,read,write,profile]=await Promise.all([store.get('settings','campusCalendar'),store.get('secrets','campusGoogle'),store.get('secrets','google'),store.get('settings','profile')]);
 const readReason=!config?.calendarId?'no-source':!config.continuous?'source-disconnected':!read?.refresh_token||!CAMPUS_CALENDAR_SCOPES.every(scope=>hasScope(read,scope))?'read-not-connected':config.calendarId===write?.calendarId?'output-calendar-is-source':null;
 return {config,sourceKey:campusSourceKey(config),read,write,paused:profile?.paused===true,readReason,writeReady:!!write?.refresh_token&&hasScope(write,CALENDAR_SCOPE)};
}
async function health(store,sourceKey,patch){for(let i=0;i<8;i++){const previous=await store.get('settings','campusCalendar');if(campusSourceKey(previous)!==sourceKey)return;const next={...previous,dailySyncTime:'05:00',dailySyncTimezone:TZ,...patch};if(await store.compareAndSet('settings','campusCalendar',previous,next))return;}}
const markerId=(sourceKey,date)=>idFor('campus-daily-sync',sourceKey,date);
const safeError=error=>error instanceof HttpError?error.message.slice(0,300):'Campus refresh or calendar queue is unavailable. Retry shortly.';

async function repairPlannedLinks(store,expected,now){
 const plans=(await store.all('campusAutoSync')).filter(plan=>plan.sourceKey===expected.sourceKey&&plan.status==='pending');if(!plans.length)return;
 await withCalendarSourceLock(store,now,async()=>{
  const current=await state(store);if(current.sourceKey!==expected.sourceKey)return;
  for(const plan of plans){const [candidate,event]=await Promise.all([store.get('campusEvents',plan.candidateId),store.get('events',plan.eventId)]);if(candidate&&!candidate.addedEventId&&event?.campusCandidateId===candidate.id&&event.campusCalendarId===current.config.calendarId)await store.compareAndSet('campusEvents',candidate.id,candidate,{...candidate,addedEventId:event.id,addedAt:event.reviewedAt||event.updatedAt});}
 });
}
async function requireAutomatic(store,expected){
 const current=await state(store);
 if(current.sourceKey!==expected.sourceKey||current.readReason||!current.config.autoAdd||!current.writeReady||current.paused)throw new HttpError(409,'Campus automatic additions are no longer authorized for this source.');
 return current;
}
async function flushOutbox(store,queue,expected,now){
 const rows=(await store.all('campusAutoSync')).filter(row=>row.sourceKey===expected.sourceKey&&row.status==='pending').sort((a,b)=>a.id.localeCompare(b.id)),ready=[];
 for(const row of rows){
  const event=await store.get('events',row.eventId);if(!event)continue;
  if(event.campusCandidateId!==row.candidateId||event.campusCalendarId!==expected.config.calendarId||event.status!=='approved'||event.cancelled){await store.compareAndSet('campusAutoSync',row.id,row,{...row,status:'review-required',updatedAt:new Date(now()).toISOString()});continue;}
  ready.push(row);
 }
 let queued=0;
 for(let start=0;start<ready.length;start+=20){
  await requireAutomatic(store,expected);const batch=ready.slice(start,start+20),eventIds=batch.map(row=>row.eventId);
  const job=await queue.enqueue(store.userId,'google-sync',{eventIds},{idempotencyKey:`campus-auto:${expected.sourceKey}:${idFor(...eventIds)}`,retrySafe:false,maxAttempts:1});
  for(const row of batch)await store.compareAndSet('campusAutoSync',row.id,row,{...row,status:'queued',jobId:job.id,queuedAt:new Date(now()).toISOString()});queued+=batch.length;
 }
 return queued;
}
async function importNewEvents(store,queue,expected,now){
 const current=await state(store);
 if(current.sourceKey!==expected.sourceKey||current.readReason)return {autoAdded:0,autoAddPending:0,autoAddWarning:'The selected source or its read connection changed.'};
 if(!current.config.autoAdd)return {autoAdded:0,autoAddPending:0,autoAddWarning:null};
 if(!current.writeReady||current.paused||!queue)return {autoAdded:0,autoAddPending:0,autoAddWarning:current.paused?'Automatic additions are paused.':!current.writeReady?'BRB Google Calendar write access is missing; no events were automatically approved.':'The calendar queue is unavailable; automatic additions were deferred.'};
 let calendarQueued=await flushOutbox(store,queue,current,now),autoAdded=0;
 const localEvents=new Set((await store.all('events')).map(event=>event.id));
 const eligible=(await store.all('campusEvents')).filter(event=>event.sourceCalendarId===current.config.calendarId&&event.status==='available'&&!event.addedEventId&&!event.allDay&&Number.isFinite(Date.parse(event.start))&&Number.isFinite(Date.parse(event.end))&&Date.parse(event.end)>now()&&!localEvents.has(idFor('campus-added',event.id))).sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
 const selected=eligible.slice(0,MAX_AUTO);
 for(let start=0;start<selected.length;start+=20){
  await requireAutomatic(store,current);const batch=selected.slice(start,start+20);
  // Plan before the per-event writes. Recovery can reconnect a partially written
  // candidate and queue its stable event ID without approving it a second time.
  for(const event of batch){const eventId=idFor('campus-added',event.id);await store.putIfAbsent('campusAutoSync',eventId,{id:eventId,eventId,candidateId:event.id,sourceKey:current.sourceKey,status:'pending',createdAt:new Date(now()).toISOString()});}
  const result=await addCampusEvent(store,{ids:batch.map(event=>event.id)},null,{now,approvalMethod:'Student enabled automatic additions from this selected Cornell campus calendar',validateCandidates:async(candidates)=>{
   await requireAutomatic(store,current);
   for(const candidate of candidates)if(candidate.addedEventId||await store.get('events',idFor('campus-added',candidate.id)))throw new HttpError(409,'An existing campus event needs explicit review before its approval can change.');
  }});
  autoAdded+=result.imported;
  calendarQueued+=await flushOutbox(store,queue,current,now);
 }
 const autoAddPending=Math.max(0,eligible.length-selected.length);
 return {autoAdded,autoAddPending,calendarQueued,autoAddWarning:autoAddPending?`${autoAddPending} additional timed events await the next refresh. This run imported at most ${MAX_AUTO}.`:null};
}

/** Manual and scheduled refresh share the same bounded, source-scoped importer. */
export async function syncCampusWithImports(store,{queue,now=Date.now,fetchImpl=globalThis.fetch}={}){
 const getNow=clock(now),before=await state(store);
 if(before.readReason)throw new HttpError(before.readReason==='output-calendar-is-source'?400:403,'Select a connected campus calendar with read access. The BRB output calendar cannot be its source.');
 try{
  await repairPlannedLinks(store,before,getNow);
  const refreshed=await createCampusCalendar({now:getNow,fetchImpl}).syncCampusCalendar(store),automatic=await importNewEvents(store,queue,before,getNow);
  await health(store,before.sourceKey,{autoAddedCount:automatic.autoAdded,autoAddPending:automatic.autoAddPending,autoAddWarning:automatic.autoAddWarning,autoAddLastRunAt:new Date(getNow()).toISOString()});
  return {...refreshed,...automatic};
 }catch(error){await health(store,before.sourceKey,{autoAddWarning:safeError(error)});throw error;}
}

export async function scheduleCampusSync(store,queue,{now=Date.now}={}){
 const at=clock(now)(),current=await state(store),date=localDay(at);if(current.readReason||current.paused)return {scheduled:false,date,reason:current.readReason||'paused'};
 const scheduledAt=localISO(date,'05:00'),late=at-Date.parse(scheduledAt);if(late<0||late>WINDOW)return {scheduled:false,date,reason:late<0?'not-due':'outside-catchup-window'};
 const id=markerId(current.sourceKey,date);
 for(let attempt=0;attempt<8;attempt++){
  const old=await store.get('campusSyncRuns',id);let round=old?.round||0;
  if(old){
   if(['completed','queued','skipped'].includes(old.status))return {scheduled:false,date,reason:'already-scheduled'};
   if(old.status==='running'&&at-Date.parse(old.startedAt)<5*60000)return {scheduled:false,date,reason:'running'};
   if(old.status==='failed'&&at-Date.parse(old.failedAt)<15*60000)return {scheduled:false,date,reason:'retry-backoff'};
   if(['running','failed'].includes(old.status)){if(round>=MAX_ROUNDS-1)return {scheduled:false,date,reason:'daily-retry-limit'};round++;}
  }
  const reserved={id,date,sourceKey:current.sourceKey,scheduledAt,round,status:'reserved',reservedAt:new Date(at).toISOString()};
  if(!await store.compareAndSet('campusSyncRuns',id,old,reserved))continue;
  const job=await queue.enqueue(store.userId,'campus-daily-sync',{date,sourceKey:current.sourceKey,scheduledAt,round},{idempotencyKey:`campus-daily:${id}:${round}`,priority:30,retrySafe:true,maxAttempts:3,ttlMs:86400000});
  await store.compareAndSet('campusSyncRuns',id,reserved,{...reserved,status:'queued',jobId:job.id});return {scheduled:true,date,jobId:job.id};
 }
 return {scheduled:false,date,reason:'concurrent-update'};
}

export async function runScheduledCampusSync(store,payload={}, {queue,now=Date.now,fetchImpl=globalThis.fetch}={}){
 const getNow=clock(now),at=getNow(),{date,sourceKey,scheduledAt,round=0}=payload;
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||typeof sourceKey!=='string'||!/^[a-f0-9]{32}$/.test(sourceKey)||!Number.isInteger(round)||round<0||round>=MAX_ROUNDS)throw new HttpError(400,'Invalid campus refresh schedule.');
 const id=markerId(sourceKey,date),old=await store.get('campusSyncRuns',id),current=await state(store);
 if(!old||old.round!==round||old.scheduledAt!==scheduledAt||['completed','skipped'].includes(old.status))return {skipped:true,reason:'already-handled-or-superseded'};
 const stale=current.sourceKey!==sourceKey||current.readReason||current.paused||date!==localDay(at)||scheduledAt!==localISO(date,'05:00')||at<Date.parse(scheduledAt)||at-Date.parse(scheduledAt)>WINDOW;
 if(stale){await store.compareAndSet('campusSyncRuns',id,old,{...old,status:'skipped',finishedAt:new Date(at).toISOString()});return {skipped:true,reason:'source-changed-disabled-or-outside-window'};}
 if(old.status==='running'&&at-Date.parse(old.startedAt)<5*60000)throw new HttpError(409,'This scheduled campus refresh is already running.');
 const running={...old,status:'running',runToken:randomUUID(),startedAt:new Date(at).toISOString()};if(!await store.compareAndSet('campusSyncRuns',id,old,running))throw new HttpError(409,'Campus refresh state changed concurrently.');
 await health(store,sourceKey,{dailyLastAttemptAt:new Date(at).toISOString(),dailyStatus:'running'});
 try{
  const result=await syncCampusWithImports(store,{queue,now:getNow,fetchImpl});
  await store.compareAndSet('campusSyncRuns',id,running,{...running,status:'completed',completedAt:new Date(getNow()).toISOString(),counts:{read:result.count,added:result.autoAdded,pending:result.autoAddPending}});
  await health(store,sourceKey,{dailyLastSuccessAt:new Date(getNow()).toISOString(),dailyStatus:'completed'});return {skipped:false,...result};
 }catch(error){await store.compareAndSet('campusSyncRuns',id,running,{...running,status:'failed',failedAt:new Date(getNow()).toISOString(),errorCode:'CAMPUS_REFRESH_FAILED'});await health(store,sourceKey,{dailyStatus:'failed'});throw error;}
}
