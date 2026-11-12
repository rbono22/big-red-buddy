import test from 'node:test';
import assert from 'node:assert/strict';
import { importCourseSelection } from '../lib/course-import.mjs';
import { normalizeEvent } from '../lib/domain.mjs';
import { syncGoogle } from '../lib/integrations.mjs';
function fixture(){
  const records=new Map(); const key=(b,id)=>`${b}:${id}`;
  return {async all(b){return [...records].filter(([k])=>k.startsWith(b+':')).map(([,v])=>structuredClone(v));},async get(b,id){return structuredClone(records.get(key(b,id))||null);},async put(b,id,v){records.set(key(b,id),structuredClone(v));return v;},async delete(b,id){records.delete(key(b,id));}};
}
function selection(){return {source:{id:'catalog-source',name:'NBAY 5300 catalog',url:'https://www.cornelltech.tech/catalogue.json'},course:{id:'NBAY-5300',code:'NBAY 5300'},section:{id:'section-1'},warnings:[],skipped:0,events:[normalizeEvent({id:'catalog-meeting',title:'NBAY 5300 · Finance',kind:'class',date:'2026-11-16',time:'13:25',endTime:'14:40',location:'Tata L23',evidence:'Published meeting schedule',evidenceVerified:true,status:'approved'})]};}
test('course selection reuses an existing syllabus class and its Google ID; repeated clicks do not duplicate reminders',async()=>{
 const store=fixture(),s=selection(); await store.put('events','syllabus-id',{...s.events[0],id:'syllabus-id',status:'review',googleId:'existing-google-event'});
 const first=await importCourseSelection(store,s); assert.equal(first.imported,0);assert.equal(first.reused,1);
 await importCourseSelection(store,s);const events=await store.all('events');assert.equal(events.length,1);assert.equal(events[0].status,'approved');assert.equal(events[0].googleId,'existing-google-event');assert.equal((await store.all('reminders')).length,1);
 const other=fixture();assert.equal((await other.all('events')).length,0);
});
test('blocked course selection does not persist partial events',async()=>{const store=fixture();await assert.rejects(importCourseSelection(store,{...selection(),blocked:true,warnings:['Unpublished dates']}),/Unpublished dates/);assert.equal((await store.all('events')).length,0);});
test('course calendar sync writes only the selected meeting, leaving unrelated approved events untouched',async()=>{
 const store=fixture(),s=selection();await importCourseSelection(store,s);
 await store.put('events','unrelated',{...s.events[0],id:'unrelated',title:'Unrelated approved class'});
 await store.put('secrets','google',{refresh_token:'test-refresh',access_token:'test-access',expiresAt:Date.now()+3600000,calendarId:'test-calendar'});
 const original=globalThis.fetch,urls=[];
 globalThis.fetch=async(url,options)=>{urls.push({url,method:options.method,body:JSON.parse(options.body)});return new Response(JSON.stringify({id:'remote-event',htmlLink:'https://calendar.google.com/'}),{status:200,headers:{'Content-Type':'application/json'}});};
 try {await syncGoogle(store,{eventIds:['catalog-meeting']});}finally{globalThis.fetch=original;}
 assert.equal(urls.length,1);assert.equal(urls[0].body.summary,'NBAY 5300 · Finance');assert.equal((await store.get('events','unrelated')).googleId,undefined);
});
