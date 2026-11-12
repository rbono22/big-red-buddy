import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {parseAcademicCalendar,createAcademicCalendar,addAcademicCalendarEvents,ACADEMIC_SOURCE_URL,ACADEMIC_CATEGORIES} from '../lib/academic-calendar.mjs';
import {calendarBounds,calendarICS,reminderSpecs,localISO} from '../lib/domain.mjs';
import {syncGoogle} from '../lib/integrations.mjs';
import {eventApprovalVersion} from '../lib/event-version.mjs';

const SNAPSHOT=JSON.parse(await readFile(new URL('../resources/academic-calendar-2026-2027.json',import.meta.url),'utf8'));
const NOW=Date.parse(SNAPSHOT.fetchedAt)+3600000;
const escape=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function html(events=SNAPSHOT.events){let previous='',body='';for(const event of events){const date=new Date(`${event.date}T12:00:00Z`),heading=date.toLocaleString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});if(previous!==heading){body+=`<h3>${heading}</h3>`;previous=heading;}body+=`<div class="calendar-row-item views-row"><div><span class="calendar-date">${event.dateLabel}</span><span class="calendar-time">${event.timeLabel}</span></div><div><span class="calendar-date-title">${escape(event.title)}</span></div></div>`;}return `<!DOCTYPE html><html><body><h1>Academic Calendar 2026-2027</h1>${body}</body></html>`;}
const entry=(title,dateLabel,timeLabel='All Day')=>`<div class="calendar-row-item views-row"><span class="calendar-date">${dateLabel}</span><span class="calendar-time">${timeLabel}</span><span class="calendar-date-title">${title}</span></div>`;
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'brf-academic-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true}),queue=await createQueue(db,{workerDatabaseUrl:null});t.after(async()=>{await queue.close();await db.close();await rm(dir,{recursive:true,force:true});});return {db,queue,a:db.forUser('student-a'),b:db.forUser('student-b')};}
const selected=snapshot=>snapshot.events.find(e=>e.title==='Thanksgiving Break/No classes');

test('checked-in official snapshot preserves all95 entries, exact date ranges, and every source category',()=>{
 const parsed=parseAcademicCalendar(html(),{fetchedAt:SNAPSHOT.fetchedAt,minimumEntries:50});
 assert.equal(parsed.count,95);assert.equal(new Set(parsed.events.map(e=>e.id)).size,95);assert.equal(parsed.events.filter(e=>e.allDay).length,62);
 assert.deepEqual(new Set(parsed.events.map(e=>e.category)),new Set(ACADEMIC_CATEGORIES));
 const thanksgiving=selected(parsed);assert.equal(thanksgiving.date,'2026-11-25');assert.equal(thanksgiving.inclusiveEndDate,'2026-11-29');assert.equal(thanksgiving.endDate,'2026-11-30');assert.equal(thanksgiving.start,null);assert.equal(thanksgiving.noClasses,true);
 const spring=parsed.events.find(e=>e.title==='Spring Break/No classes');assert.equal(spring.date,'2027-03-27');assert.equal(spring.endDate,'2027-04-05');
 assert.ok(parsed.events.every(e=>e.sourceUrl===ACADEMIC_SOURCE_URL&&e.evidence.includes(e.title)&&e.fetchedAt===SNAPSHOT.fetchedAt));
 assert.ok(parsed.events.some(e=>/Commencement weekend/.test(e.title)));assert.ok(parsed.events.some(e=>/recognition ceremony/.test(e.title)));
});

test('published opening/deadline times remain precise and are labeled one-minute calendar markers',()=>{
 const parsed=parseAcademicCalendar(html(),{fetchedAt:SNAPSHOT.fetchedAt});
 const opening=parsed.events.find(e=>e.title==='Fall 2026: Add/Drop begins for Graduate/Professional/Cornell Tech');
 assert.equal(opening.start,'2026-08-17T13:00:00.000Z');assert.equal(opening.end,'2026-08-17T13:01:00.000Z');assert.equal(opening.durationIsDisplayOnly,true);assert.equal(opening.timeKind,'opens');
 const window=parsed.events.find(e=>e.title==='Spring 2027: Enrollment begins for Graduate/Professional/Cornell Tech');assert.equal(window.start,'2026-11-10T12:30:00.000Z');assert.equal(window.end,'2026-11-13T04:59:00.000Z');assert.equal(window.allDay,false);
 const deadline=parsed.events.find(e=>e.title==='Fall 2026: University fall grade deadline');assert.equal(deadline.start,'2026-12-24T13:00:00.000Z');assert.equal(deadline.timeKind,'deadline');
 const ceremony=parsed.events.find(e=>/recognition ceremony/.test(e.title));assert.equal(ceremony.start,'2026-12-20T15:00:00.000Z');assert.equal(ceremony.end,'2026-12-20T19:00:00.000Z');assert.equal(ceremony.durationIsDisplayOnly,false);
});

test('all-day dates survive daylight-saving boundaries and cross-year inclusive ranges',()=>{
 const source=`<h3>October 2026</h3>${entry('Synthetic Fall Break','Oct 31 – Nov 2','Oct 31 12:00 AM – Nov 2 11:59 PM')}<h3>December 2026</h3>${entry('Synthetic year boundary','Dec 31 – Jan 1','Dec 31 12:00 AM – Jan 1 11:59 PM')}<h3>March 2027</h3>${entry('Synthetic spring break','Mar 13 – Mar 15','Mar 13 12:00 AM – Mar 15 11:59 PM')}`;
 const [fall,winter,spring]=parseAcademicCalendar(source).events;
 assert.equal(fall.endDate,'2026-11-03');assert.equal(winter.endDate,'2027-01-02');assert.equal(spring.endDate,'2027-03-16');
 assert.equal((Date.parse(localISO(fall.endDate))-Date.parse(localISO(fall.date)))/3600000,73);
 assert.equal((Date.parse(localISO(spring.endDate))-Date.parse(localISO(spring.date)))/3600000,71);
 assert.deepEqual(calendarBounds({...spring,status:'approved'}),{start:{date:'2027-03-13'},end:{date:'2027-03-16'}});
});

test('stable identities survive changed dates; ambiguous duplicates and incomplete markup fail closed',()=>{
 const first=parseAcademicCalendar(`<h3>September 2026</h3>${entry('Labor Day/Holiday/No classes','Sep 7')}`);
 const changed=parseAcademicCalendar(`<h3>September 2026</h3>${entry('Labor Day/Holiday/No classes','Sep 8')}`);assert.equal(first.events[0].id,changed.events[0].id);
 for(const source of [`<h3>September 2026</h3>${entry('Duplicate','Sep 7')}${entry('Duplicate','Sep 8')}`,`<h3>September 2026</h3>${entry('Bad date','Sep 31')}`,`<h3>September 2026</h3>${entry('Bad time','Sep 7','Someday after lunch')}`,entry('Missing year','Sep 7'),html().replace('calendar-time','unrecognized-time')])assert.throws(()=>parseAcademicCalendar(source));
 assert.throws(()=>parseAcademicCalendar(html().replace('</html>',''),{minimumEntries:50}));
 assert.throws(()=>parseAcademicCalendar(`<h3>November 2026</h3>${entry('Conflicting date labels','Nov 25 – Nov 29','Nov 26 12:00 AM – Nov 29 11:59 PM')}`),/labels disagree/);
});

test('first list seeds public candidates only; explicit imports stay owned and deduplicate without cancelling classes',async t=>{
 const {a,b,queue}=await fixture(t),service=createAcademicCalendar({snapshot:SNAPSHOT,now:()=>NOW,fetchImpl:()=>{throw Error('No fetch expected')}});
 const listed=await service.listAcademicCalendar(a);assert.equal(listed.events.length,95);assert.equal((await a.all('events')).length,0);assert.equal((await b.all('academicEvents')).length,0);
 await a.put('events','personal-class',{id:'personal-class',title:'My class',kind:'class',date:'2026-11-25',start:'2026-11-25T18:00:00Z',end:'2026-11-25T19:00:00Z',status:'approved'});
 const id=selected(SNAPSHOT).id;await assert.rejects(addAcademicCalendarEvents(b,{ids:[id]},queue),e=>e.status===404);
 const first=await addAcademicCalendarEvents(a,{ids:[id]},queue,{now:()=>NOW}),again=await addAcademicCalendarEvents(a,{ids:[id]},queue,{now:()=>NOW});assert.equal(first.imported,1);assert.equal(again.reused,1);assert.equal((await a.all('events')).length,2);assert.equal((await a.get('events','personal-class')).status,'approved');
 assert.equal((await a.all('reminders')).some(r=>r.eventId===first.eventIds[0]),false);assert.equal((await queue.list(a.userId)).length,0);
 for(const ids of [[],[id,id],['bad-id']])await assert.rejects(addAcademicCalendarEvents(a,{ids},queue),e=>e.status===400);
});

test('academic approval checks the exact reviewed source version inside its source lock',async t=>{
 const {a,queue}=await fixture(t);await createAcademicCalendar({snapshot:SNAPSHOT}).listAcademicCalendar(a);
 const id=selected(SNAPSHOT).id,candidate=await a.get('academicEvents',id),expectedVersion=eventApprovalVersion(candidate);
 await a.put('secrets','google',{refresh_token:'synthetic'});await a.put('academicEvents',id,{...candidate,date:'2026-11-24'});
 await assert.rejects(addAcademicCalendarEvents(a,{ids:[id]},queue,{expectedVersion}),e=>e.status===409);
 assert.equal((await a.all('events')).length,0);assert.equal((await queue.list(a.userId)).length,0);
 await assert.rejects(addAcademicCalendarEvents(a,{ids:SNAPSHOT.events.slice(0,2).map(e=>e.id)},queue,{expectedVersion}),e=>e.status===400);
 const current=await a.get('academicEvents',id),result=await addAcademicCalendarEvents(a,{ids:[id]},queue,{expectedVersion:eventApprovalVersion(current)});assert.equal(result.imported,1);assert.equal((await a.get('events',result.eventIds[0])).date,'2026-11-24');
});

test('refresh fetches only the fixed official source, shares public fetches, and queues only selected Google additions',async t=>{
 const {a,b,queue}=await fixture(t),calls=[];let clock=NOW;
 const service=createAcademicCalendar({now:()=>clock,fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(html());}});
 await Promise.all([service.refreshAcademicCalendar(a),service.refreshAcademicCalendar(b)]);assert.equal(calls.length,1);assert.equal(calls[0].url,ACADEMIC_SOURCE_URL);assert.equal(calls[0].options.redirect,'error');
 await a.put('secrets','google',{refresh_token:'synthetic'});const result=await addAcademicCalendarEvents(a,{ids:[selected(SNAPSHOT).id]},queue,{now:()=>clock});assert.ok(result.calendarTask);
 const task=await queue.claim('synthetic-worker',{types:['google-sync']});assert.deepEqual(task.payload.eventIds,result.eventIds);assert.equal(task.userId,a.userId);await queue.complete(task,{});assert.equal((await b.all('events')).length,0);
 clock+=600001;await service.refreshAcademicCalendar(a);assert.equal(calls.length,2);
});

test('changed or removed Registrar entries require review while unchanged imports retain approval and Google IDs',async t=>{
 const {a}=await fixture(t);let clock=NOW,body=html();const service=createAcademicCalendar({now:()=>clock,fetchImpl:async()=>new Response(body)});await service.refreshAcademicCalendar(a);
 const id=selected(SNAPSHOT).id,{eventIds}=await addAcademicCalendarEvents(a,{ids:[id]},null,{now:()=>clock});let added=await a.get('events',eventIds[0]);await a.put('events',added.id,{...added,googleId:'existing-google-copy'});
 clock+=600001;await service.refreshAcademicCalendar(a);assert.equal((await a.get('events',added.id)).status,'approved');
 body=html(SNAPSHOT.events.map(e=>e.id===id?{...e,dateLabel:'Nov 24 – Nov 29',timeLabel:'Nov 24 12:00 AM – Nov 29 11:59 PM'}:e));clock+=600001;await service.refreshAcademicCalendar(a);added=await a.get('events',added.id);assert.equal(added.status,'review');assert.equal(added.date,'2026-11-24');assert.equal(added.googleId,'existing-google-copy');
 await addAcademicCalendarEvents(a,{ids:[id]},null,{now:()=>clock});body=html(SNAPSHOT.events.filter(e=>e.id!==id));clock+=600001;await service.refreshAcademicCalendar(a);added=await a.get('events',added.id);assert.equal(added.status,'review');assert.equal(added.cancelled,true);assert.equal(added.googleId,'existing-google-copy');
});

test('an old web snapshot cannot revert newer worker data or clear refresh failures',async t=>{
 const {a}=await fixture(t),oldWeb=createAcademicCalendar({snapshot:SNAPSHOT,now:()=>NOW});await oldWeb.listAcademicCalendar(a);
 const id=selected(SNAPSHOT).id,body=html(SNAPSHOT.events.map(e=>e.id===id?{...e,dateLabel:'Nov 24 – Nov 29',timeLabel:'Nov 24 12:00 AM – Nov 29 11:59 PM'}:e));
 const worker=createAcademicCalendar({now:()=>NOW+600000,fetchImpl:async()=>new Response(body)});await worker.refreshAcademicCalendar(a);
 let current=await oldWeb.listAcademicCalendar(a);assert.equal(current.events.find(e=>e.id===id).date,'2026-11-24');
 const failed=createAcademicCalendar({now:()=>NOW+1200000,fetchImpl:async()=>new Response('broken',{status:503})});await assert.rejects(failed.refreshAcademicCalendar(a),e=>e.status===502);
 const failedAt=(await a.get('settings','academicCalendar')).lastAttemptAt;current=await oldWeb.listAcademicCalendar(a);assert.match(current.settings.lastError,/refresh failed/);assert.equal(current.settings.lastAttemptAt,failedAt);assert.equal(current.events.find(e=>e.id===id).date,'2026-11-24');
 const staleRefresh=createAcademicCalendar({now:()=>NOW,fetchImpl:async()=>new Response(html())});await staleRefresh.refreshAcademicCalendar(a);assert.match((await a.get('settings','academicCalendar')).lastError,/refresh failed/);assert.equal((await a.get('academicEvents',id)).date,'2026-11-24');
});

test('bad, oversized and partial refreshes preserve the last complete source and imported events',async t=>{
 const {a}=await fixture(t);await createAcademicCalendar({snapshot:SNAPSHOT}).listAcademicCalendar(a);const id=selected(SNAPSHOT).id;await addAcademicCalendarEvents(a,{ids:[id]});
 for(const response of [()=>new Response(html(SNAPSHOT.events.slice(0,20))),()=>new Response(html().replace('calendar-time','missing')),()=>new Response('x',{headers:{'content-length':String(3*1024*1024)}})]){
  const service=createAcademicCalendar({now:()=>NOW,fetchImpl:async()=>response()});await assert.rejects(service.refreshAcademicCalendar(a),e=>e.status===502);assert.equal((await a.all('academicEvents')).length,95);assert.equal((await a.all('events'))[0].status,'approved');
 }
});

test('partial source writes recover changed and cancelled saved copies before reporting source success',async t=>{
 const {a}=await fixture(t),initial=createAcademicCalendar({snapshot:SNAPSHOT});await initial.listAcademicCalendar(a);
 const id=selected(SNAPSHOT).id,{eventIds}=await addAcademicCalendarEvents(a,{ids:[id]});let saved=await a.get('events',eventIds[0]);await a.put('events',saved.id,{...saved,googleId:'keep-this-copy'});
 const changedBody=html(SNAPSHOT.events.map(e=>e.id===id?{...e,dateLabel:'Nov 24 – Nov 29',timeLabel:'Nov 24 12:00 AM – Nov 29 11:59 PM'}:e)),changed=parseAcademicCalendar(changedBody,{fetchedAt:new Date(NOW).toISOString()});
 // Simulate a crash from the old write order: new candidate already stored but
 // its saved copy remains approved at the earlier date, with old health metadata.
 await a.put('academicEvents',id,{...changed.events.find(e=>e.id===id),addedEventId:saved.id});
 let crash=true;const interrupted={...a,put:async(bucket,key,value)=>{if(crash&&bucket==='events'&&key===saved.id&&value.status==='review'){crash=false;throw Error('Synthetic persistence interruption');}return a.put(bucket,key,value);}};
 const worker=createAcademicCalendar({now:()=>NOW,fetchImpl:async()=>new Response(changedBody)});
 await assert.rejects(worker.refreshAcademicCalendar(interrupted),e=>e.status===502);assert.equal((await a.get('settings','academicCalendar')).contentHash,SNAPSHOT.contentHash);
 await worker.refreshAcademicCalendar(a);saved=await a.get('events',saved.id);assert.equal(saved.status,'review');assert.equal(saved.date,'2026-11-24');assert.equal(saved.googleId,'keep-this-copy');assert.equal((await a.get('settings','academicCalendar')).contentHash,changed.contentHash);
 await addAcademicCalendarEvents(a,{ids:[id]});await a.put('academicEvents',id,{...(await a.get('academicEvents',id)),status:'cancelled'});
 const removed=createAcademicCalendar({now:()=>NOW+600001,fetchImpl:async()=>new Response(html(SNAPSHOT.events.filter(e=>e.id!==id)))});await removed.refreshAcademicCalendar(a);saved=await a.get('events',saved.id);assert.equal(saved.cancelled,true);assert.equal(saved.status,'review');assert.equal(saved.googleId,'keep-this-copy');
});

test('a saved academic copy left before candidate linking is recovered and reviewed against later source changes',async t=>{
 const {a}=await fixture(t);await createAcademicCalendar({snapshot:SNAPSHOT}).listAcademicCalendar(a);const id=selected(SNAPSHOT).id,{eventIds}=await addAcademicCalendarEvents(a,{ids:[id]});
 const candidate=await a.get('academicEvents',id);delete candidate.addedEventId;delete candidate.addedAt;await a.put('academicEvents',id,candidate);
 const body=html(SNAPSHOT.events.map(e=>e.id===id?{...e,dateLabel:'Nov 24 – Nov 29',timeLabel:'Nov 24 12:00 AM – Nov 29 11:59 PM'}:e));await createAcademicCalendar({now:()=>NOW,fetchImpl:async()=>new Response(body)}).refreshAcademicCalendar(a);
 assert.equal((await a.get('academicEvents',id)).addedEventId,eventIds[0]);assert.equal((await a.get('events',eventIds[0])).status,'review');assert.equal((await a.all('events')).length,1);
});

test('ICS and Google use exclusive date-only bounds for all-day events and retain timed event behavior',async t=>{
 const {a}=await fixture(t);await createAcademicCalendar({snapshot:SNAPSHOT}).listAcademicCalendar(a);const ids=[selected(SNAPSHOT).id,SNAPSHOT.events.find(e=>/recognition ceremony/.test(e.title)).id],result=await addAcademicCalendarEvents(a,{ids});
 const events=await a.all('events'),holiday=events.find(e=>e.allDay);assert.deepEqual(reminderSpecs({...holiday,start:localISO(holiday.date)}),[]);
 const ics=calendarICS(events);assert.match(ics,/DTSTART;VALUE=DATE:20261125/);assert.match(ics,/DTEND;VALUE=DATE:20261130/);assert.match(ics,/DTSTART:20261220T150000Z/);assert.equal((ics.match(/BEGIN:VALARM/g)||[]).length,1);
 await a.put('secrets','google',{refresh_token:'synthetic-refresh',access_token:'synthetic-access',expiresAt:Date.now()+3600000,calendarId:'synthetic-calendar'});
 const calls=[],original=globalThis.fetch;globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({id:'synthetic-google',htmlLink:'https://calendar.google.com/'}));};t.after(()=>{globalThis.fetch=original;});
 await syncGoogle(a,{eventIds:result.eventIds});assert.equal(calls.length,2);const allDay=calls.find(c=>c.body.start.date),timed=calls.find(c=>c.body.start.dateTime);
 assert.deepEqual(allDay.body.start,{date:'2026-11-25'});assert.deepEqual(allDay.body.end,{date:'2026-11-30'});assert.deepEqual(allDay.body.reminders,{useDefault:false,overrides:[]});assert.equal(timed.body.start.dateTime,'2026-12-20T15:00:00.000Z');assert.equal(timed.body.start.timeZone,'America/New_York');
});
