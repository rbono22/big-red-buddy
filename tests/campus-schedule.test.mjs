import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase,databaseInternals} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {CALENDAR_SCOPE,CAMPUS_CALENDAR_SCOPES} from '../lib/auth.mjs';
import {createCampusCalendar,saveCampusSettings} from '../lib/campus-calendar.mjs';
import {campusSourceKey,scheduleCampusSync,runScheduledCampusSync,syncCampusWithImports} from '../lib/campus-schedule.mjs';

const NOW=Date.parse('2026-11-11T10:05:00Z'),calendarId='cornell@import.calendar.google.com',now=()=>NOW;
const readGrant={refresh_token:'read-refresh',access_token:'read-access',expiresAt:NOW+3600000,scope:CAMPUS_CALENDAR_SCOPES.join(' ')};
const writeGrant={refresh_token:'write-refresh',calendarId:'assistant-calendar',scope:CALENDAR_SCOPE};
const event=(id,patch={})=>({id,summary:`Campus gathering ${id}`,description:'Published campus gathering.',location:'Tata L23',start:{dateTime:'2026-11-12T17:00:00-05:00'},end:{dateTime:'2026-11-12T18:00:00-05:00'},htmlLink:'https://calendar.google.com/calendar/event?eid=synthetic',...patch});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
function provider(getItems=()=>[event('one')]){const calls=[];const fetchImpl=async(url,options)=>{calls.push({url:String(url),method:options.method});assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer read-access');const parsed=new URL(url);assert.equal(parsed.origin,'https://www.googleapis.com');if(parsed.pathname.includes('/users/me/calendarList/')){const id=decodeURIComponent(parsed.pathname.split('/').at(-1));return response({id,summary:'Cornell Tech events',accessRole:'reader',timeZone:'America/New_York'});}if(parsed.pathname.endsWith('/events')){const items=await getItems();return items instanceof Response?items:response({items});}throw new Error('Unexpected provider path');};return {fetchImpl,calls};}
async function fixture(t,userId='a'){const dir=await mkdtemp(path.join(tmpdir(),'brf-campus-daily-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true}),queue=await createQueue(db,{workerDatabaseUrl:null}),store=db.forUser(userId);t.after(async()=>{await queue.close();await db.close();await rm(dir,{recursive:true,force:true});});await store.put('secrets','campusGoogle',readGrant);await store.put('secrets','google',writeGrant);await store.put('settings','campusCalendar',{calendarId,calendarName:'Cornell Tech events',continuous:true,selectedAt:'2026-11-10T12:00:00Z',connectionRevision:'source-one',autoAdd:false});return {db,queue,store};}
async function dailyJob(queue){const job=await queue.claim('daily-test',{types:['campus-daily-sync']});assert.ok(job);return job;}

test('auto-add is explicit, requires both grants, validates booleans and stays tenant-owned',async t=>{
 const {db,store}=await fixture(t);assert.equal((await store.get('settings','campusCalendar')).autoAdd,false);await store.delete('secrets','google');await assert.rejects(saveCampusSettings(store,{autoAdd:true},{now}),{status:403});
 await store.put('secrets','google',writeGrant);await store.delete('secrets','campusGoogle');await assert.rejects(saveCampusSettings(store,{autoAdd:true},{now}),{status:403});await store.put('secrets','campusGoogle',readGrant);
 const saved=await saveCampusSettings(store,{autoAdd:true},{now});assert.equal(saved.autoAdd,true);assert.equal(saved.dailySyncTime,'05:00');assert.equal(saved.dailySyncTimezone,'America/New_York');assert.equal(await db.forUser('b').get('settings','campusCalendar'),null);
 for(const patch of [null,{},[],{autoAdd:'yes'},{autoAdd:true,time:'06:00'}])await assert.rejects(saveCampusSettings(store,patch,{now}),{status:400});
});

test('source changes reset automatic approval and the output calendar is rejected before provider reads',async t=>{
 const {store}=await fixture(t),{fetchImpl,calls}=provider(),client=createCampusCalendar({fetchImpl,now});await saveCampusSettings(store,{autoAdd:true},{now});const old=campusSourceKey(await store.get('settings','campusCalendar'));
 const changed=await client.selectCampusCalendar(store,{calendarId:'another-source@import.calendar.google.com'});assert.equal(changed.autoAdd,false);assert.notEqual(campusSourceKey(changed),old);
 const before=calls.length;await assert.rejects(client.selectCampusCalendar(store,{calendarId:'assistant-calendar'}),{status:400});assert.equal(calls.length,before);
 await store.put('settings','campusCalendar',{...changed,calendarId:'assistant-calendar'});await assert.rejects(syncCampusWithImports(store,{fetchImpl,now}),{status:400});assert.equal(calls.length,before);
});

test('daily reads run without auto-add or a write connection and do not approve calendar events',async t=>{
 const {queue,store}=await fixture(t),{fetchImpl}=provider();await store.delete('secrets','google');const scheduled=await scheduleCampusSync(store,queue,{now});assert.equal(scheduled.scheduled,true);const job=await dailyJob(queue);assert.equal(job.retrySafe,true);
 const result=await runScheduledCampusSync(store,job.payload,{queue,now,fetchImpl});assert.equal(result.count,1);assert.equal(result.autoAdded,0);assert.equal((await store.all('events')).length,0);assert.equal((await store.all('campusEvents')).length,1);assert.equal((await store.get('settings','campusCalendar')).dailyStatus,'completed');
});

test('05:00 follows New York DST, has a six-hour catch-up window, and paused or disconnected sources are skipped',async t=>{
 const {queue,store}=await fixture(t);assert.equal((await scheduleCampusSync(store,queue,{now:'2026-11-11T09:59:00Z'})).reason,'not-due');assert.equal((await scheduleCampusSync(store,queue,{now:'2026-11-11T16:01:00Z'})).reason,'outside-catchup-window');
 // Refresh tokens are valid; access-token expiry is irrelevant to scheduling.
 await scheduleCampusSync(store,queue,{now:'2026-10-31T09:05:00Z'});await scheduleCampusSync(store,queue,{now:'2026-11-01T10:05:00Z'});
 const markers=await store.all('campusSyncRuns');assert.equal(markers.find(row=>row.date==='2026-10-31').scheduledAt,'2026-10-31T09:00:00.000Z');assert.equal(markers.find(row=>row.date==='2026-11-01').scheduledAt,'2026-11-01T10:00:00.000Z');
 await store.put('settings','profile',{paused:true});assert.equal((await scheduleCampusSync(store,queue,{now})).reason,'paused');await store.put('settings','profile',{paused:false});await store.delete('secrets','campusGoogle');assert.equal((await scheduleCampusSync(store,queue,{now})).reason,'read-not-connected');
});

test('once-daily markers survive queue-row expiry and repeated scheduler calls without another fetch',async t=>{
 const {db,queue,store}=await fixture(t),{fetchImpl,calls}=provider();await Promise.all([scheduleCampusSync(store,queue,{now}),scheduleCampusSync(store,queue,{now})]);assert.equal((await queue.list(store.userId)).length,1);const job=await dailyJob(queue);await runScheduledCampusSync(store,job.payload,{queue,now,fetchImpl});await queue.complete(job,{});const reads=calls.length;
 databaseInternals(db).sqlite.prepare('DELETE FROM jobs WHERE user_id=?').run(store.userId);assert.equal((await scheduleCampusSync(db.forUser(store.userId),queue,{now})).scheduled,false);assert.equal((await runScheduledCampusSync(store,job.payload,{queue,now,fetchImpl})).skipped,true);assert.equal(calls.length,reads);
});

test('automatic additions process the whole eligible batch beyond twenty and queue only scoped stable IDs',async t=>{
 const {queue,store}=await fixture(t),{fetchImpl}=provider(()=>[...Array.from({length:45},(_,index)=>event(`timed-${index}`)),event('all-day',{start:{date:'2026-11-12'},end:{date:'2026-11-13'}})]);await saveCampusSettings(store,{autoAdd:true},{now});
 const result=await syncCampusWithImports(store,{queue,now,fetchImpl});assert.equal(result.autoAdded,45);assert.equal(result.autoAddPending,0);assert.equal((await store.all('events')).length,45);assert.equal((await store.all('reminders')).filter(item=>item.status==='pending').length,45);const writes=(await queue.list(store.userId)).filter(job=>job.type==='google-sync');assert.equal(writes.length,3);assert.ok((await store.all('campusAutoSync')).every(row=>row.status==='queued'));
 const again=await syncCampusWithImports(store,{queue,now,fetchImpl});assert.equal(again.autoAdded,0);assert.equal((await store.all('events')).length,45);assert.equal((await queue.list(store.userId)).filter(job=>job.type==='google-sync').length,3);
});

test('a 500-event automatic cap reports a visible backlog that the next refresh drains',async t=>{
 const {queue,store}=await fixture(t),{fetchImpl}=provider(()=>Array.from({length:501},(_,index)=>event(`bounded-${index}`)));await saveCampusSettings(store,{autoAdd:true},{now});
 const first=await syncCampusWithImports(store,{queue,now,fetchImpl});assert.equal(first.autoAdded,500);assert.equal(first.autoAddPending,1);assert.match(first.autoAddWarning,/1 additional timed/);assert.equal((await store.get('settings','campusCalendar')).autoAddPending,1);
 const second=await syncCampusWithImports(store,{queue,now,fetchImpl});assert.equal(second.autoAdded,1);assert.equal(second.autoAddPending,0);assert.equal((await store.all('events')).length,501);
});

test('changed, cancelled or dismissed imported events never regain approval through auto-add',async t=>{
 const {queue,store}=await fixture(t);let items=[event('changed'),event('dismissed')];const {fetchImpl}=provider(()=>items);await saveCampusSettings(store,{autoAdd:true},{now});await syncCampusWithImports(store,{queue,now,fetchImpl});const events=await store.all('events'),dismissed=events.find(row=>row.title.endsWith('dismissed'));await store.put('events',dismissed.id,{...dismissed,status:'dismissed'});
 items=[event('changed',{location:'New room'}),event('dismissed')];const changed=await syncCampusWithImports(store,{queue,now,fetchImpl});assert.equal(changed.autoAdded,0);assert.equal((await store.get('events',dismissed.id)).status,'dismissed');assert.equal((await store.all('events')).find(row=>row.title.endsWith('changed')).status,'review');
 items=[];await syncCampusWithImports(store,{queue,now,fetchImpl});assert.ok((await store.all('events')).every(row=>row.status==='review'&&row.cancelled));assert.equal((await store.all('reminders')).filter(row=>row.status==='pending').length,0);
});

test('an uncertain Google enqueue recovers from durable plans without duplicate events or queue jobs',async t=>{
 const {queue,store}=await fixture(t),{fetchImpl}=provider(()=>[event('one'),event('two')]);await saveCampusSettings(store,{autoAdd:true},{now});let first=true;const uncertain={async enqueue(...args){const result=await queue.enqueue(...args);if(first){first=false;throw new Error('Lost queue response');}return result;}};
 await assert.rejects(syncCampusWithImports(store,{queue:uncertain,now,fetchImpl}));assert.equal((await store.all('events')).length,2);assert.ok((await store.all('campusAutoSync')).every(row=>row.status==='pending'));
 const recovered=await syncCampusWithImports(store,{queue:uncertain,now,fetchImpl});assert.equal(recovered.autoAdded,0);assert.equal((await store.all('events')).length,2);assert.equal((await queue.list(store.userId)).length,1);assert.ok((await store.all('campusAutoSync')).every(row=>row.status==='queued'));
});

test('partial local writes reconnect candidate ownership before source changes are reconciled',async t=>{
 const {queue,store}=await fixture(t);let items=[event('one')];const {fetchImpl}=provider(()=>items);await saveCampusSettings(store,{autoAdd:true},{now});let fail=true;
 const interrupted={...store,async put(bucket,id,value){if(bucket==='campusEvents'&&value.addedEventId&&fail){fail=false;throw new Error('Process interrupted after the event write');}return store.put(bucket,id,value);}};
 await assert.rejects(syncCampusWithImports(interrupted,{queue,now,fetchImpl}));assert.equal((await store.all('events')).length,1);assert.equal((await store.all('campusEvents'))[0].addedEventId,undefined);
 items=[event('one',{location:'Changed after interruption'})];const recovered=await syncCampusWithImports(store,{queue,now,fetchImpl});assert.equal(recovered.autoAdded,0);assert.equal((await store.all('events'))[0].status,'review');assert.ok((await store.all('campusEvents'))[0].addedEventId);assert.equal((await queue.list(store.userId)).length,0);
});

test('source changes, disconnects and another student cannot execute an old scheduled payload',async t=>{
 const {db,queue,store}=await fixture(t),{fetchImpl,calls}=provider();await scheduleCampusSync(store,queue,{now});const job=await dailyJob(queue);assert.equal((await runScheduledCampusSync(db.forUser('b'),job.payload,{queue,now,fetchImpl})).skipped,true);assert.equal(calls.length,0);
 const config=await store.get('settings','campusCalendar');await store.put('settings','campusCalendar',{...config,connectionRevision:'changed'});assert.equal((await runScheduledCampusSync(store,job.payload,{queue,now,fetchImpl})).skipped,true);assert.equal(calls.length,0);
 await store.put('settings','campusCalendar',config);await store.delete('secrets','campusGoogle');assert.equal((await scheduleCampusSync(store,queue,{now})).reason,'read-not-connected');assert.equal((await db.forUser('b').all('campusEvents')).length,0);
});

test('failed reads can retry their same queued day and stale queued days cannot catch up late',async t=>{
 const {queue,store}=await fixture(t);let failing=true;const {fetchImpl}=provider(()=>failing?response({error:'synthetic'},503):[event('one')]);await scheduleCampusSync(store,queue,{now});const job=await dailyJob(queue);await assert.rejects(runScheduledCampusSync(store,job.payload,{queue,now,fetchImpl}),{status:502});assert.equal((await store.get('settings','campusCalendar')).dailyStatus,'failed');
 failing=false;assert.equal((await runScheduledCampusSync(store,job.payload,{queue,now,fetchImpl})).skipped,false);assert.equal((await store.get('settings','campusCalendar')).dailyStatus,'completed');
 const {queue:otherQueue,store:other}=await fixture(t,'late');await scheduleCampusSync(other,otherQueue,{now});const old=await dailyJob(otherQueue);assert.equal((await runScheduledCampusSync(other,old.payload,{queue:otherQueue,now:NOW+7*3600000,fetchImpl})).skipped,true);assert.equal((await other.all('campusEvents')).length,0);
});
