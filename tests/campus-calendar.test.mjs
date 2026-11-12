import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMPUS_CALENDAR_SCOPES } from '../lib/auth.mjs';
import { addCampusEvent, campusRSVP, createCampusCalendar, ingestCampusSnapshot } from '../lib/campus-calendar.mjs';
import { calendarDescription } from '../lib/calendar-description.mjs';
import { calendarICS, idFor } from '../lib/domain.mjs';
import { eventApprovalVersion } from '../lib/event-version.mjs';

const NOW=Date.parse('2026-11-10T21:00:00Z'),now=()=>NOW,calendarId='campus-events@import.calendar.google.com';
const credentials={access_token:'synthetic-read-token',refresh_token:'synthetic-refresh',expiresAt:NOW+3600000,scope:CAMPUS_CALENDAR_SCOPES.join(' ')};
function student(userId='student-a'){
 const records=new Map();return {userId,records,async get(bucket,id){return structuredClone(records.get(`${bucket}:${id}`)||null);},async put(bucket,id,value){records.set(`${bucket}:${id}`,structuredClone(value));return value;},async all(bucket){return [...records].filter(([key])=>key.startsWith(`${bucket}:`)).map(([,value])=>structuredClone(value));},async putIfAbsent(bucket,id,value){const key=`${bucket}:${id}`;if(!records.has(key))records.set(key,structuredClone(value));return structuredClone(records.get(key));},async compareAndSet(bucket,id,before,after){const key=`${bucket}:${id}`;if(JSON.stringify(records.get(key)||null)!==JSON.stringify(before))return false;records.set(key,structuredClone(after));return true;},async delete(bucket,id){records.delete(`${bucket}:${id}`);}};
}
const event=(id='panel-1',extra={})=>({id,summary:'Product leadership panel',description:'Meet alumni.<br>RSVP: <a href="https://cornelltech.campusgroups.com/rsvp?id=2133121&amp;source=calendar">Register</a>',location:'Sign in to download the location',start:{dateTime:'2026-11-11T17:00:00-05:00'},end:{dateTime:'2026-11-11T18:00:00-05:00'},htmlLink:'https://calendar.google.com/calendar/event?eid=synthetic',updated:'2026-11-10T20:00:00Z',...extra});
const snapshot=items=>({calendarId,calendarName:'Cornell Tech events',items,windowStart:new Date(NOW).toISOString(),windowEnd:new Date(NOW+90*86400000).toISOString(),fetchedAt:new Date(NOW).toISOString()});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
async function connected(){const store=student();await store.put('secrets','campusGoogle',credentials);await store.put('settings','campusCalendar',{calendarId,calendarName:'Cornell Tech events',continuous:true});return store;}
function sourceClient(getEvents,{getList}={}){
 const calls=[];const client=createCampusCalendar({now,fetchImpl:async(url,options)=>{calls.push({url:String(url),method:options.method});assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer synthetic-read-token');const u=new URL(url);if(u.pathname==='/calendar/v3/users/me/calendarList')return response(getList?getList(u):{items:[{id:calendarId,summary:'Cornell Tech events',accessRole:'reader',timeZone:'America/New_York'},{id:'private-other@group.calendar.google.com',summary:'Other calendar',accessRole:'owner'}]});if(u.pathname===`/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`)return response({id:calendarId,summary:'Cornell Tech events',accessRole:'reader',timeZone:'America/New_York'});if(u.pathname===`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`)return getEvents(u);throw new Error(`Unexpected provider path: ${u.pathname}`);}});return {client,calls};
}

test('approval checks the latest source version after locking and cannot approve an intervening time change',async()=>{
 const store=student();await ingestCampusSnapshot(store,snapshot([event()]),{now});const original=(await store.all('campusEvents'))[0],expectedVersion=eventApprovalVersion(original),jobs=[];await store.put('secrets','google',{refresh_token:'synthetic-write'});
 const putIfAbsent=store.putIfAbsent.bind(store);let changed=false;
 store.putIfAbsent=async(bucket,id,value)=>{if(bucket==='settings'&&id==='campusCalendarLock'&&!changed){changed=true;await store.put('campusEvents',original.id,{...original,start:'2026-11-11T23:00:00.000Z',end:'2026-11-12T00:00:00.000Z',time:'18:00'});}return putIfAbsent(bucket,id,value);};
 const queue={async enqueue(...args){jobs.push(args);return{id:'queued'};}};
 await assert.rejects(addCampusEvent(store,{id:original.id},queue,{now,expectedVersion}),error=>error.status===409);assert.equal((await store.all('events')).length,0);assert.equal((await store.all('reminders')).length,0);assert.equal(jobs.length,0);
 const latest=await store.get('campusEvents',original.id);const result=await addCampusEvent(store,{id:original.id},queue,{now,expectedVersion:eventApprovalVersion(latest)});assert.equal(result.imported,1);assert.equal((await store.all('events'))[0].start,latest.start);assert.equal(jobs.length,1);
});

test('approval ignores source polling timestamps while stale status and batch version mismatches reject before writes',async()=>{
 const store=student();await ingestCampusSnapshot(store,snapshot([event(),event('second')]),{now});const rows=await store.all('campusEvents'),original=rows[0],expectedVersion=eventApprovalVersion(original);
 await store.put('campusEvents',original.id,{...original,fetchedAt:'2026-11-10T22:00:00Z',updatedAt:'2026-11-10T22:00:00Z'});
 await assert.rejects(addCampusEvent(store,{ids:rows.map(e=>e.id)},null,{now,expectedVersion}),error=>error.status===409);
 assert.equal((await store.all('events')).length,0);assert.equal((await addCampusEvent(store,{id:original.id},null,{now,expectedVersion})).imported,1);
 const second=rows[1];await store.put('campusEvents',second.id,{...second,status:'cancelled'});await assert.rejects(addCampusEvent(store,{id:second.id},null,{now,expectedVersion:eventApprovalVersion(second)}),error=>error.status===409);assert.equal((await store.all('events')).length,1);
});

test('campus source needs its own explicit read grant and lists only subscription metadata',async()=>{
 const store=student(),other=student('student-b');await store.put('secrets','google',{...credentials,calendarId:'assistant-calendar'});
 const {client,calls}=sourceClient(()=>response({items:[]}));await assert.rejects(client.listCampusCalendars(store),error=>error.status===403);assert.equal(calls.length,0);
 await store.put('secrets','campusGoogle',credentials);const calendars=await client.listCampusCalendars(store);
 assert.deepEqual(calendars.map(c=>c.id),[calendarId,'private-other@group.calendar.google.com']);assert.equal(calls.some(c=>c.url.includes('/events?')),false);
 await client.selectCampusCalendar(store,{calendarId});assert.equal((await store.get('settings','campusCalendar')).calendarId,calendarId);assert.equal((await store.get('secrets','google')).calendarId,'assistant-calendar');
 await assert.rejects(client.listCampusCalendars(other),error=>error.status===403);assert.equal((await other.all('campusEvents')).length,0);
});

test('bounded paged refresh reads only the selected calendar and keeps candidates separate from student reminders',async()=>{
 const store=await connected(),{client,calls}=sourceClient(u=>{assert.equal(u.searchParams.get('singleEvents'),'true');assert.equal(u.searchParams.get('showDeleted'),'true');assert.equal(Date.parse(u.searchParams.get('timeMax'))-Date.parse(u.searchParams.get('timeMin')),90*86400000);return response(u.searchParams.has('pageToken')?{items:[event('all-day',{start:{date:'2026-11-12'},end:{date:'2026-11-13'},description:'All-day campus program'})]}:{items:[event()],nextPageToken:'next-page'});});
 const result=await client.syncCampusCalendar(store);assert.equal(result.count,2);assert.equal(result.complete,true);assert.equal(result.continuous,true);
 const candidates=await store.all('campusEvents'),timed=candidates.find(c=>c.remoteId==='panel-1'),allDay=candidates.find(c=>c.remoteId==='all-day');
 assert.equal(timed.rsvpUrl,'https://cornelltech.campusgroups.com/rsvp?id=2133121');assert.equal(timed.location,'');assert.match(timed.warnings.join(' '),/Room is not published/);assert.doesNotMatch(timed.description,/<a|<br/);assert.equal(timed.start,'2026-11-11T22:00:00.000Z');assert.equal(timed.time,'17:00');
 assert.equal(allDay.start,null);assert.equal(allDay.allDay,true);assert.equal((await store.all('events')).length,0);assert.equal((await store.all('reminders')).length,0);
 assert.equal(calls.filter(c=>c.url.includes('/events?')).length,2);assert.ok(calls.every(c=>!c.url.includes('private-other')));
});

test('explicit add preserves RSVP context and queues only selected events; duplicates reuse stable records',async()=>{
 const store=student();await ingestCampusSnapshot(store,snapshot([event(),event('all-day',{start:{date:'2026-11-12'},end:{date:'2026-11-13'}})]),{now});
 const candidate=(await store.all('campusEvents')).find(c=>c.remoteId==='panel-1'),allDay=(await store.all('campusEvents')).find(c=>c.allDay),jobs=[];
 await store.put('secrets','google',{refresh_token:'write-only-synthetic'});const queue={async enqueue(owner,type,payload){jobs.push({owner,type,payload});return{id:'sync-task'};}};
 const result=await addCampusEvent(store,{id:candidate.id},queue,{now});assert.equal(result.imported,1);assert.equal(result.calendarTask.taskId,'sync-task');assert.deepEqual(jobs,[{owner:store.userId,type:'google-sync',payload:{eventIds:result.eventIds}}]);
 const own=await store.get('events',result.eventIds[0]);assert.equal(own.status,'approved');assert.equal(own.kind,'event');assert.equal(own.sourceUrl,candidate.rsvpUrl);assert.match(calendarDescription(own),/rsvp\?id=2133121/);assert.match(calendarICS([own]),/rsvp\?id=2133121/);
 const reminders=await store.all('reminders');assert.equal(reminders.length,1);assert.equal(reminders[0].minutes,10);assert.equal(reminders[0].status,'pending');
 const repeated=await addCampusEvent(store,{id:candidate.id},null,{now});assert.equal(repeated.reused,1);assert.equal((await store.all('events')).length,1);assert.equal((await store.all('reminders')).length,1);
 await assert.rejects(addCampusEvent(store,{id:allDay.id},queue,{now}),error=>error.status===400);assert.equal(jobs.length,1);
 const other=student('student-b');await other.put('settings','campusCalendar',{calendarId});await assert.rejects(addCampusEvent(other,{id:candidate.id},queue,{now}),error=>error.status===404);
});

test('source changes reopen added events for review and cancel stale reminders without provider writes',async()=>{
 const store=await connected();let items=[event()];const {client,calls}=sourceClient(()=>response({items}));await client.syncCampusCalendar(store);
 const candidate=(await store.all('campusEvents'))[0],added=await addCampusEvent(store,{id:candidate.id},null,{now}),old=await store.get('events',added.eventIds[0]);await store.put('events',old.id,{...old,googleId:'already-synced',googleLink:'https://calendar.google.com/'});
 items=[event('panel-1',{start:{dateTime:'2026-11-11T18:00:00-05:00'},end:{dateTime:'2026-11-11T19:00:00-05:00'},location:'Tata L24'})];
 const refresh=await client.syncCampusCalendar(store);assert.equal(refresh.changed,1);const changed=await store.get('events',old.id);assert.equal(changed.status,'review');assert.equal(changed.googleId,'already-synced');assert.equal(changed.start,'2026-11-11T23:00:00.000Z');assert.equal(changed.previousSource.start,old.start);assert.equal((await store.all('reminders'))[0].status,'cancelled');assert.ok(calls.every(c=>c.method==='GET'));
 await addCampusEvent(store,{id:candidate.id},null,{now});assert.equal((await store.get('events',old.id)).status,'approved');assert.equal((await store.all('reminders')).filter(r=>r.status==='pending').length,1);
});

test('failed pagination and partial snapshots preserve old candidates; only complete windows reconcile missing events',async()=>{
 const store=await connected();await ingestCampusSnapshot(store,{...snapshot([event()]),continuous:true,complete:true},{now});const candidate=(await store.all('campusEvents'))[0];await addCampusEvent(store,{id:candidate.id},null,{now});
 await ingestCampusSnapshot(store,{...snapshot([]),continuous:true,complete:false},{now});assert.equal((await store.get('campusEvents',candidate.id)).status,'available');
 const failed=sourceClient(u=>u.searchParams.has('pageToken')?response({error:'private provider detail'},500):response({items:[],nextPageToken:'later'}));await assert.rejects(failed.client.syncCampusCalendar(store),/HTTP 500/);assert.equal((await store.get('campusEvents',candidate.id)).status,'available');assert.equal((await store.all('events'))[0].status,'approved');
 const outside={...candidate,id:idFor('outside'),remoteId:'old',date:'2026-10-01',start:'2026-10-01T20:00:00Z',end:'2026-10-01T21:00:00Z',addedEventId:null};await store.put('campusEvents',outside.id,outside);
 const complete=sourceClient(()=>response({items:[]}));const result=await complete.client.syncCampusCalendar(store);assert.equal(result.cancelled,1);assert.equal((await store.get('campusEvents',outside.id)).status,'available');assert.equal((await store.get('campusEvents',candidate.id)).status,'cancelled');const own=(await store.all('events'))[0];assert.equal(own.status,'review');assert.equal(own.cancelled,true);assert.equal((await store.all('reminders'))[0].status,'cancelled');
});

test('malformed or duplicate snapshots fail before mutating records and hostile RSVP hosts are ignored',async()=>{
 const store=student();await assert.rejects(ingestCampusSnapshot(store,snapshot([event(),event('panel-1',{summary:'Contradiction'})]),{now}),/Duplicate/);assert.equal((await store.all('campusEvents')).length,0);
 await assert.rejects(ingestCampusSnapshot(store,{...snapshot([event()]),windowEnd:'2027-12-01T00:00:00Z'},{now}),/90 days/);assert.equal((await store.all('campusEvents')).length,0);
 assert.equal(campusRSVP('https://cornelltech.campusgroups.com/rsvp?id=\n2133121'),'https://cornelltech.campusgroups.com/rsvp?id=2133121');
 for(const value of ['https://cornelltech.campusgroups.com.evil.test/rsvp?id=123','https://evil.test/rsvp?id=123','http://cornelltech.campusgroups.com/rsvp?id=123','https://cornelltech.campusgroups.com/rsvp?id=123x'])assert.equal(campusRSVP(value),'');
});

test('token refresh uses campus credentials alone and cannot resurrect a disconnected connection',async()=>{
 const store=await connected();await store.put('secrets','campusGoogle',{...credentials,expiresAt:NOW-1});await store.put('secrets','google',{refresh_token:'do-not-use',calendarId:'keep-calendar'});
 const calls=[];const client=createCampusCalendar({now,fetchImpl:async(url,options)=>{calls.push(String(url));assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(new URLSearchParams(options.body).get('refresh_token'),'synthetic-refresh');await store.delete('secrets','campusGoogle');return response({access_token:'new-read-token',expires_in:3600,scope:CAMPUS_CALENDAR_SCOPES.join(' ')});}});
 await assert.rejects(client.listCampusCalendars(store),error=>error.status===409);assert.equal(await store.get('secrets','campusGoogle'),null);assert.equal((await store.get('secrets','google')).calendarId,'keep-calendar');assert.equal(calls.length,1);
});

test('pagination loops and oversized provider data are bounded without clearing source history',async()=>{
 const store=await connected();const loop=sourceClient(()=>response({items:[event()],nextPageToken:'repeat'}));await assert.rejects(loop.client.syncCampusCalendar(store),/pagination/);assert.equal(loop.calls.filter(c=>c.url.includes('/events?')).length,2);assert.equal((await store.all('campusEvents')).length,0);
 const large=createCampusCalendar({now,fetchImpl:async()=>new Response('{}',{headers:{'Content-Length':String(3*1024*1024)}})});await assert.rejects(large.listCampusCalendars(store),/size limit/);
});

test('disconnect during a provider fetch does not recreate the connection or import its late response',async()=>{
 const store=await connected();const {client}=sourceClient(async()=>{await store.delete('secrets','campusGoogle');await store.delete('settings','campusCalendar');return response({items:[event()]});});
 await assert.rejects(client.syncCampusCalendar(store),error=>error.status===409);
 assert.equal(await store.get('settings','campusCalendar'),null);assert.equal(await store.get('secrets','campusGoogle'),null);assert.equal((await store.all('campusEvents')).length,0);
});

test('malformed successful responses cannot cancel source history, while a typed empty listing is complete',async()=>{
 const store=await connected();await ingestCampusSnapshot(store,{...snapshot([event()]),continuous:true,complete:true},{now});const candidate=(await store.all('campusEvents'))[0];await addCampusEvent(store,{id:candidate.id},null,{now});
 const malformed=sourceClient(()=>response({}));await assert.rejects(malformed.client.syncCampusCalendar(store),/invalid paging data/);
 assert.equal((await store.get('campusEvents',candidate.id)).status,'available');assert.equal((await store.all('events'))[0].status,'approved');assert.equal((await store.all('reminders'))[0].status,'pending');
 const empty=sourceClient(()=>response({kind:'calendar#events'}));const result=await empty.client.syncCampusCalendar(store);assert.equal(result.complete,true);assert.equal(result.cancelled,1);assert.equal((await store.get('campusEvents',candidate.id)).status,'cancelled');
});
