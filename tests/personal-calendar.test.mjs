import test from 'node:test';
import assert from 'node:assert/strict';
import {savePersonalCalendars,refreshPersonalCalendar,uniquePersonalEvents,personalCalendarRevisionMatches} from '../lib/personal-calendar.mjs';
import {createCampusCalendar} from '../lib/campus-calendar.mjs';
import {CAMPUS_CALENDAR_SCOPES} from '../lib/auth.mjs';
const NOW=Date.parse('2026-11-12T13:00:00Z'),now=()=>NOW;
function student(userId='student-a'){
 const records=new Map();return {userId,records,async get(bucket,id){return structuredClone(records.get(`${bucket}:${id}`)||null);},async put(bucket,id,value){records.set(`${bucket}:${id}`,structuredClone(value));return value;},async all(bucket){return [...records].filter(([key])=>key.startsWith(`${bucket}:`)).map(([,value])=>structuredClone(value));},async putIfAbsent(bucket,id,value){const key=`${bucket}:${id}`;if(!records.has(key))records.set(key,structuredClone(value));return structuredClone(records.get(key));},async compareAndSet(bucket,id,before,after){const key=`${bucket}:${id}`;if(JSON.stringify(records.get(key)||null)!==JSON.stringify(before))return false;records.set(key,structuredClone(after));return true;},async delete(bucket,id){records.delete(`${bucket}:${id}`);}};
}

const sample={id:'event',remoteId:'remote',title:'Study with Josh',date:'2026-11-12',start:'2026-11-12T23:00:00Z',end:'2026-11-13T00:00:00Z',location:'Library'};
const client={async listCampusCalendars(){return [{id:'mine',name:'My calendar'}];},async readPersonalCalendar(){return [sample];}};
async function enabled(){const s=student();await s.put('secrets','campusGoogle',{refresh_token:'test'});await savePersonalCalendars(s,{enabled:true,calendarIds:['mine']},{client,now});return s;}
test('explicit selection is scoped, bounded and off by default; opting out clears snapshot',async()=>{
 const s=student();assert.equal((await refreshPersonalCalendar(s)).enabled,false);
 await assert.rejects(savePersonalCalendars(s,{enabled:true,calendarIds:['someone-else']},{client,now}),e=>e.status===403);
 await assert.rejects(savePersonalCalendars(s,{enabled:true,calendarIds:['a','b','c','d']},{client,now}),e=>e.status===400);
 const a=await enabled();await refreshPersonalCalendar(a,{client,now});assert.equal((await a.get('settings','personalCalendar')).events.length,1);
 assert.equal((await refreshPersonalCalendar(student('other'))).enabled,false);
 const revision=(await a.get('settings','personalCalendar')).revision;assert.equal(await personalCalendarRevisionMatches(a,revision),true);
 await savePersonalCalendars(a,{enabled:false,calendarIds:[]},{client,now});assert.deepEqual((await a.get('settings','personalCalendar')).events,[]);assert.equal(await personalCalendarRevisionMatches(a,revision),false);
});
test('refresh replaces deleted and moved events; failure and disconnect never show stale entries',async()=>{
 const s=await enabled();await refreshPersonalCalendar(s,{client,now});
 const later=()=>NOW+6*60000;
 const moved=await refreshPersonalCalendar(s,{client:{...client,async readPersonalCalendar(){return [{...sample,start:'2026-11-13T00:00:00Z'}];}},now:later});assert.equal(moved.events[0].start,'2026-11-13T00:00:00Z');
 const removed=await refreshPersonalCalendar(s,{client:{...client,async readPersonalCalendar(){return [];}},now:()=>NOW+12*60000});assert.deepEqual(removed.events,[]);
 const failed=await refreshPersonalCalendar(s,{client:{...client,async readPersonalCalendar(){throw Error('private provider detail');}},now:()=>NOW+18*60000});assert.deepEqual(failed.events,[]);assert.match(failed.lastError,/could not be refreshed/);assert.doesNotMatch(failed.lastError,/private provider/);
 await s.delete('secrets','campusGoogle');assert.deepEqual((await refreshPersonalCalendar(s,{client,now})).events,[]);
});
test('duplicates collapse across calendars and BRB output while recurring occurrences remain',()=>{
 assert.deepEqual(uniquePersonalEvents([sample,{...sample,id:'copy',remoteId:'copy'}],[]),[sample]);
 assert.deepEqual(uniquePersonalEvents([sample],[{...sample,title:'Renamed locally',remoteId:null,googleId:'remote'}]),[]);
 assert.equal(uniquePersonalEvents([{...sample,remoteId:'occ1',iCalUID:'series'},{...sample,remoteId:'occ2',iCalUID:'series',start:'2026-11-13T23:00:00Z'}],[]).length,2);
});
test('Google adapter is read only, omits descriptions and guests, excludes declined and cancelled events',async()=>{
 const s=student();await s.put('secrets','campusGoogle',{refresh_token:'test',access_token:'test',expiresAt:NOW+3600000,scope:CAMPUS_CALENDAR_SCOPES.join(' ')});
 const row={id:'one',summary:'Meeting',description:'DO NOT RETAIN',attendees:[{email:'PRIVATE'}],start:{dateTime:'2026-11-12T18:00:00-05:00'},end:{dateTime:'2026-11-12T19:00:00-05:00'}};
 const c=createCampusCalendar({now,fetchImpl:async(url,options)=>{assert.equal(options.method,'GET');const body=String(url).includes('/events?')?{items:[row,{...row,id:'declined',attendees:[{self:true,responseStatus:'declined'}]},{...row,id:'cancelled',status:'cancelled'},{id:'holiday',summary:'Holiday',start:{date:'2026-11-12'},end:{date:'2026-11-13'}}]}:{id:'mine',summary:'Mine',accessRole:'owner'};return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});}});
 const rows=await c.readPersonalCalendar(s,'mine');assert.equal(rows.length,2);assert.equal(rows[1].allDay,true);assert.doesNotMatch(JSON.stringify(rows),/DO NOT RETAIN|PRIVATE|attendees|description/);
});

test('disconnect during refresh cannot restore a cleared snapshot',async()=>{
 const s=await enabled();const result=await refreshPersonalCalendar(s,{now,client:{...client,async readPersonalCalendar(){const cfg=await s.get('settings','personalCalendar');await s.delete('secrets','campusGoogle');await s.put('settings','personalCalendar',{...cfg,enabled:false,events:[],revision:cfg.revision+1});return [sample];}}});
 assert.deepEqual(result.events,[]);assert.equal((await s.get('settings','personalCalendar')).enabled,false);assert.deepEqual((await s.get('settings','personalCalendar')).events,[]);
});
