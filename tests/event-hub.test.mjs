import test from 'node:test';
import assert from 'node:assert/strict';
import {aggregateEventHub,buildEventHub,eventRegistrationURL} from '../lib/event-hub.mjs';
const now=Date.parse('2026-11-10T18:00:00Z');
const event=(id,extra={})=>({id,title:'Founders and friends',kind:'event',date:'2026-11-12',start:'2026-11-12T23:00:00.000Z',end:'2026-11-13T01:00:00.000Z',location:'Tata L23',status:'available',...extra});
const lumaCalendar={calendarId:'luma-selected'},campusCalendar={calendarId:'campus-selected'};
test('provider email invitations keep email review actions and a filterable provider identity',()=>{
 const hub=aggregateEventHub({now,events:[event('invitation',{connector:'event-email',sourceProvider:'luma',sourceName:'Luma invitation email',rsvpUrl:'https://luma.com/84uanwts?token=secret',status:'review'})]});
 assert.equal(hub.items[0].invitationProvider,'luma');assert.equal(hub.items[0].action.kind,'email');assert.equal(hub.items[0].sources[0].kind,'email');assert.equal(hub.items[0].registrationUrl,'https://luma.com/84uanwts');assert.doesNotMatch(JSON.stringify(hub),/secret/);
});
test('matching sources form one card with provenance; repeated reads are stable',()=>{
 const input={now,lumaCalendar,campusCalendar,luma:[event('l1',{sourceCalendarId:'luma-selected',rsvpUrl:'https://luma.com/founders?token=secret'})],campus:[event('c1',{sourceCalendarId:'campus-selected',rsvpUrl:'https://cornelltech.campusgroups.com/rsvp?id=123'})],events:[event('mail',{connector:'event-email',status:'review',sourceName:'CampusGroups email'})]};
 const hub=aggregateEventHub(input);assert.equal(hub.items.length,1);assert.equal(hub.stats.duplicates,2);assert.equal(hub.items[0].sources.length,3);assert.equal(hub.items[0].status,'review');assert.deepEqual(hub,aggregateEventHub(input));assert.doesNotMatch(JSON.stringify(hub),/secret/);
});
test('same event URL at conflicting times remains separate and warns; recurring dates stay separate',()=>{
 const hub=aggregateEventHub({now,lumaCalendar,luma:[event('a',{sourceCalendarId:'luma-selected',rsvpUrl:'https://lu.ma/founders'}),event('b',{sourceCalendarId:'luma-selected',rsvpUrl:'https://lu.ma/founders',start:'2026-11-13T00:00:00.000Z'}),event('c',{sourceCalendarId:'luma-selected',rsvpUrl:'https://lu.ma/founders',date:'2026-11-13',start:'2026-11-13T23:00:00Z'})]});
 assert.equal(hub.items.length,3);assert.ok(hub.items.slice(0,2).every(e=>e.warnings.some(w=>w.includes('different time'))));assert.equal(hub.items[2].warnings.length,0);
});
test('generic titles and missing locations do not cause fuzzy overmerging',()=>{
 const hub=aggregateEventHub({now,events:[event('a',{title:'Dinner',location:''}),event('b',{title:'Dinner',location:''}),event('c',{title:'Founders and friends',location:''}),event('d',{title:'Founders and friends',location:''})]});assert.equal(hub.items.length,4);
});
test('an approved saved copy remains primary when another copy needs review; disagreements stay visible',()=>{
 const hub=aggregateEventHub({now,events:[event('aaa',{status:'review'}),event('zzz',{status:'approved',googleId:'already-on-calendar',end:'2026-11-13T02:00:00Z'})]});
 assert.equal(hub.items.length,1);assert.equal(hub.items[0].status,'added');assert.equal(hub.items[0].action.id,'zzz');assert.ok(hub.items[0].warnings.some(w=>w.includes('end times')));assert.ok(hub.items[0].warnings.some(w=>w.includes('review status')));
});
test('material changes preserve hub identity but require a fresh approval revision',()=>{
 const input={now,events:[event('same',{status:'review'})]},before=aggregateEventHub(input).items[0];input.events[0].location='Different room';const after=aggregateEventHub(input).items[0];assert.equal(before.id,after.id);assert.notEqual(before.revision,after.revision);
});
test('imported copy and its source combine and retain review or decline states',()=>{
 const input={now,lumaCalendar,luma:[event('a',{sourceCalendarId:'luma-selected',addedEventId:'copy'})],events:[event('copy',{lumaCandidateId:'a',status:'review',start:'2026-11-13T00:00:00Z'})]};
 const hub=aggregateEventHub(input);assert.equal(hub.items.length,1);assert.equal(hub.items[0].status,'review');assert.equal(hub.items[0].action.id,'copy');assert.ok(hub.items[0].warnings.length);
 input.events[0].status='dismissed';assert.equal(aggregateEventHub(input).items[0].status,'dismissed');
});
test('selected sources only, holidays preserve all-day exclusive end and academic items do not fuzzymerge',()=>{
 const hub=aggregateEventHub({now,lumaCalendar,luma:[event('stale',{sourceCalendarId:'old-calendar'})],academic:[event('holiday',{title:'Thanksgiving Break',category:'break',allDay:true,date:'2026-11-25',endDate:'2026-11-30',start:null,end:null}),event('enroll',{category:'enrollment'})]});
 assert.equal(hub.items.length,2);const holiday=hub.items.find(e=>e.holiday);assert.equal(holiday.endDate,'2026-11-30');assert.equal(holiday.start,null);assert.equal(holiday.category,'holidays');assert.equal(hub.items.find(e=>!e.holiday).category,'academic');
});
test('private URLs never become registration or sharing links',()=>{
 for(const url of ['https://calendar.google.com/calendar/event?eid=private','https://luma.com/private?token=secret','https://user:secret@partiful.com/e/id','javascript:alert(1)','https://evil.test/?next=https://lu.ma/a'])assert.equal(eventRegistrationURL(url),'');
 assert.equal(eventRegistrationURL('https://cornelltech.campusgroups.com/rsvp?id=123&secret=omit'),'https://cornelltech.campusgroups.com/rsvp?id=123');
});
test('reads use only the provided student store and no global catalog of private events',async()=>{
 const store=userId=>({userId,all:async bucket=>bucket==='events'?[event(userId,{title:`${userId} private event`,status:'review'})]:[],get:async()=>null});
 const alice=await buildEventHub(store('alice'),{now}),bob=await buildEventHub(store('bob'),{now});assert.match(JSON.stringify(alice),/alice private/);assert.doesNotMatch(JSON.stringify(bob),/alice/);await assert.rejects(buildEventHub({...store('alice'),userId:null}),/student-owned/);
});
