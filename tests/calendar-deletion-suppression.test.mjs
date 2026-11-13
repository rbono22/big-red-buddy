import test from 'node:test';
import assert from 'node:assert/strict';
import {idFor,normalizeEvent} from '../lib/domain.mjs';
import {writeCalendarTombstones} from '../lib/calendar-mutations.mjs';
import {persistCandidates} from '../lib/ingest.mjs';
import {importCourseSelection} from '../lib/course-import.mjs';
import {connectCanvasFeed,syncCanvasFeed} from '../lib/canvas-feed.mjs';
import {ingestCampusSnapshot,addCampusEvent} from '../lib/campus-calendar.mjs';
import {ingestLumaSnapshot,addLumaEvent} from '../lib/luma-calendar.mjs';
import {ingestPartifulSnapshot,addPartifulEvent} from '../lib/partiful-calendar.mjs';
import {buildEventHub} from '../lib/event-hub.mjs';
import {refreshPersonalCalendar} from '../lib/personal-calendar.mjs';
import {createEventEmail} from '../lib/event-email.mjs';

const NOW=Date.parse('2026-11-12T13:00:00Z'),now=()=>NOW;
function student(userId='student-a'){
 const rows=new Map(),key=(bucket,id)=>`${bucket}:${id}`;
 return {userId,
  async get(bucket,id){return structuredClone(rows.get(key(bucket,id))??null);},
  async all(bucket){return [...rows].filter(([k])=>k.startsWith(`${bucket}:`)).map(([,value])=>structuredClone(value));},
  async put(bucket,id,value){rows.set(key(bucket,id),structuredClone(value));return value;},
  async delete(bucket,id){rows.delete(key(bucket,id));},
  async putIfAbsent(bucket,id,value){if(!rows.has(key(bucket,id)))rows.set(key(bucket,id),structuredClone(value));return structuredClone(rows.get(key(bucket,id)));},
  async compareAndSet(bucket,id,before,after){if(JSON.stringify(rows.get(key(bucket,id))??null)!==JSON.stringify(before))return false;rows.set(key(bucket,id),structuredClone(after));return true;}
 };
}
const tombstone=(store,target)=>writeCalendarTombstones(store,target,{proposalId:'synthetic-confirmed-delete',status:'deleted',at:new Date(NOW).toISOString()});

test('a deleted syllabus class stays removed through reprocessing and catalog import',async()=>{
 const store=student(),source={id:'syllabus-source',name:'Finance syllabus'},candidate=normalizeEvent({title:'NBAY 5300 · Finance',kind:'class',date:'2026-11-16',time:'13:25',endTime:'14:40',location:'Tata L23',evidence:'Published meeting schedule',evidenceVerified:true});
 await persistCandidates(store,source,[candidate]);
 const original=(await store.all('events'))[0],removed={...original,status:'dismissed',cancelled:true};
 await store.put('events',original.id,removed);await tombstone(store,{localId:original.id});
 await persistCandidates(store,source,[{...candidate,location:'Tata L24'}]);
 await persistCandidates(store,source,[]);
 assert.deepEqual(await store.get('events',original.id),removed);
 const result=await importCourseSelection(store,{source:{id:'catalog',name:'Finance catalog'},course:{id:'NBAY-5300',code:'NBAY 5300'},section:{id:'section-1'},events:[{...candidate,id:'catalog-class'}],warnings:[]});
 assert.equal(result.imported,0);assert.match(result.warnings.join(' '),/previously removed/);
 assert.equal((await store.all('events')).length,1);assert.equal((await store.all('reminders')).length,0);
});

test('Canvas cannot recreate a deleted item even after its local source row is absent',async()=>{
 const store=student(),url='https://canvas.cornell.edu/feeds/calendars/user_SyntheticToken0123456789abcdefghij.ics';
 const feed=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:event-assignment-1001','DTSTART:20261116T134000Z','SUMMARY:Quiz: Finance [NBAY5300]','END:VEVENT','END:VCALENDAR'].join('\r\n');
 const sync=text=>syncCanvasFeed(store,{fetchImpl:async()=>new Response(text),now:NOW});
 await connectCanvasFeed(store,url,{now:NOW});await sync(feed);
 const event=(await store.all('events'))[0];await tombstone(store,{localId:event.id});await store.delete('events',event.id);
 const result=await sync(feed.replace('20261116T134000Z','20261117T134000Z'));
 assert.equal(result.added,0);assert.equal(await store.get('events',event.id),null);assert.equal((await store.all('reminders')).length,0);
});

for(const [provider,ingest,add,url] of [
 ['campus',ingestCampusSnapshot,addCampusEvent,'https://cornelltech.campusgroups.com/rsvp?id=123'],
 ['luma',ingestLumaSnapshot,addLumaEvent,'https://luma.com/synthetic-event'],
 ['partiful',ingestPartifulSnapshot,addPartifulEvent,'https://partiful.com/e/synthetic-event']
])test(`${provider} refresh cannot reopen a deleted copy or offer it as a new suggestion`,async()=>{
 const store=student(),calendarId=`${provider}@import.calendar.google.com`;
 const event={id:'remote-instance-1',summary:'Student networking night',description:`Register: ${url}`,location:'Tata L23',start:{dateTime:'2026-11-13T17:00:00-05:00'},end:{dateTime:'2026-11-13T18:00:00-05:00'}};
 const snapshot=items=>({calendarId,calendarName:'Synthetic source',items,windowStart:new Date(NOW).toISOString(),windowEnd:new Date(NOW+7*86400000).toISOString(),fetchedAt:new Date(NOW).toISOString(),complete:true});
 await ingest(store,snapshot([event]),{now});const candidate=(await store.all(`${provider}Events`))[0];
 const first=await add(store,{id:candidate.id},null,{now}),localId=first.eventIds[0],saved=await store.get('events',localId),removed={...saved,status:'dismissed',cancelled:true};
 await store.put('events',localId,removed);await tombstone(store,{localId});
 await ingest(store,snapshot([{...event,location:'Tata L24'}]),{now});
 assert.deepEqual(await store.get('events',localId),removed);
 await assert.rejects(add(store,{id:candidate.id},null,{now}),error=>error.status===409&&/removed/.test(error.message));
 assert.equal((await buildEventHub(store,{now:NOW})).items.length,0);
 assert.equal((await store.all('reminders')).some(reminder=>reminder.status==='pending'),false);
 // A lost source link must not revive the suggestion after the local row is pruned.
 await store.delete('events',localId);const source=await store.get(`${provider}Events`,candidate.id);
 await store.put(`${provider}Events`,candidate.id,{...source,addedEventId:null});
 assert.equal((await buildEventHub(store,{now:NOW})).items.length,0);
});

test('personal-calendar tombstones filter cached and late snapshots by calendar and occurrence',async()=>{
 const store=student(),removed={id:'one',sourceCalendarId:'mine',remoteId:'series_20261113',title:'Study',start:'2026-11-13T22:00:00Z'},nextOccurrence={...removed,id:'two',remoteId:'series_20261120'},otherCalendar={...removed,id:'three',sourceCalendarId:'shared'};
 await store.put('secrets','campusGoogle',{refresh_token:'synthetic'});
 await store.put('settings','personalCalendar',{enabled:true,calendars:[{id:'mine',name:'Mine'}],events:[removed,nextOccurrence,otherCalendar],lastSuccess:new Date(NOW).toISOString(),revision:1});
 await tombstone(store,{calendarId:'mine',remoteId:removed.remoteId});
 const cached=await refreshPersonalCalendar(store,{now,client:{readPersonalCalendar(){throw new Error('A fresh cache should not fetch.');}}});
 assert.deepEqual(cached.events.map(e=>e.id),['two','three']);
 const late=await refreshPersonalCalendar(store,{now:()=>NOW+6*60000,client:{async readPersonalCalendar(){
  // Simulate deletion occurring after provider read began but before its result.
  await tombstone(store,{calendarId:'mine',remoteId:nextOccurrence.remoteId});
  return [removed,nextOccurrence,otherCalendar];
 }}});
 assert.deepEqual(late.events.map(e=>e.id),['three']);
 assert.deepEqual((await store.get('settings','personalCalendar')).events.map(e=>e.id),['three']);
 const other=student('student-b');await other.put('secrets','campusGoogle',{refresh_token:'synthetic'});await other.put('settings','personalCalendar',{enabled:true,events:[removed],lastSuccess:new Date(NOW).toISOString()});
 assert.equal((await refreshPersonalCalendar(other,{now})).events.length,1);
});

test('re-importing the same email cannot revive its removed event after message history is pruned',async()=>{
 const store=student(),text='Join the Finance study session November 16, 2026 at 1:25 pm in Tata L23.';
 const service=createEventEmail({now,extract:async()=>({events:[{title:'Finance study session',date:'2026-11-16',time:'13:25',endTime:'14:25',location:'Tata L23',evidence:text}]})});
 await service.importEventEmail(store,{text});const event=(await store.all('events'))[0];assert.ok(event);
 await tombstone(store,{localId:event.id});await store.delete('events',event.id);
 for(const message of await store.all('eventEmailMessages'))await store.delete('eventEmailMessages',message.id);
 const repeated=await service.importEventEmail(store,{text});
 assert.equal(repeated.imported,0);assert.equal((await store.all('events')).length,0);
});
