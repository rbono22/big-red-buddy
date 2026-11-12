import test from 'node:test';
import assert from 'node:assert/strict';
import {agendaWindow,inAgendaWindow,agendaSort,buildScheduleBrief,googleCalendarEventURL} from '../lib/calendar-agenda.mjs';
import {showMenu,handleMenuMessage} from '../lib/telegram-menu.mjs';
import {sendTelegram} from '../lib/integrations.mjs';
import {validateTelegramReplyMarkup} from '../lib/telegram-delivery.mjs';
const NOW=Date.parse('2026-11-12T23:00:00Z'),now=()=>NOW;
const sample={id:'meeting',remoteId:'remote1',sourceCalendarId:'student@cornell.edu',title:'EMC2 Fellows Monthly Meeting',date:'2026-11-13',start:'2026-11-13T17:00:00Z',end:'2026-11-13T18:00:00Z',location:'Tata 391'};
const allDay={...sample,id:'maker',remoteId:'remote2',title:'Maker Day',allDay:true,start:null,end:null,date:'2026-11-13',endDate:'2026-11-14'};
function fixture(userId='student-a'){
 process.env.APP_ORIGIN='https://app.synthetic.example';
 const records=new Map(),sent=[],clone=v=>v==null?null:structuredClone(v);
 const store={userId,async get(b,id){return clone(records.get(`${b}:${id}`));},async put(b,id,v){records.set(`${b}:${id}`,clone(v));},async all(b){return [...records].filter(([key])=>key.startsWith(`${b}:`)).map(([,v])=>clone(v));},async delete(b,id){records.delete(`${b}:${id}`);},async compareAndSet(b,id,before,after){if(JSON.stringify(await this.get(b,id))!==JSON.stringify(before))return false;await this.put(b,id,after);return true;}};
 records.set('secrets:telegram',{chatId:101,linkedAt:'fixture'});
 const queue={async enqueue(user,type,payload,options){assert.equal(user,userId);sent.push({type,payload,options});return {id:options.idempotencyKey};}};
 const seed=async(events)=>{
  await store.put('secrets','campusGoogle',{refresh_token:'synthetic'});
  await store.put('settings','personalCalendar',{enabled:true,calendars:[{id:'student@cornell.edu',name:'Mine'}],events,lastSuccess:new Date(NOW).toISOString(),revision:2});
 };
 return {store,queue,sent,seed};
}
test('Events includes personal all-day, ongoing and upcoming entries, with safe open links and no add actions',async()=>{
 const f=fixture(),ongoing={...sample,id:'ongoing',remoteId:'ongoing',title:'Study group',date:'2026-11-12',start:'2026-11-12T22:30:00Z',end:'2026-11-13T00:00:00Z'};
 await f.seed([sample,allDay,ongoing,{...ongoing,id:'ended',remoteId:'ended',title:'Finished meeting',end:'2026-11-12T22:59:00Z'}]);
 await showMenu(f.store,f.queue,'events',1,{now});
 const cards=f.sent.filter(j=>j.payload.notification?.personalCalendarRevision===2);
 assert.equal(cards.length,3);assert.match(cards[0].payload.text,/Study group/);assert.match(cards[1].payload.text,/Maker Day[\s\S]*All day/);
 assert.match(cards[2].payload.text,/12:00 PM – 1:00 PM/);
 for(const card of cards){assert.match(card.payload.text,/Already on Google Calendar/);assert.deepEqual(card.payload.replyMarkup.inline_keyboard.flat().map(b=>b.text),['Open in Google Calendar']);validateTelegramReplyMarkup(card.payload.replyMarkup);}
 assert.equal((await f.store.all('events')).length,0);assert.ok(f.sent.every(j=>j.type==='telegram-send'));
});
test('personal copies replace suggestions while distinct synced events keep their own cards',async()=>{
 const f=fixture();await f.seed([sample]);
 for(const e of [{...sample,id:'copy'}, {...sample,id:'other',title:'Another event',start:'2026-11-13T19:00:00Z'}, {...sample,id:'third',title:'Third event',start:'2026-11-13T20:00:00Z'}])await f.store.put('events',e.id,{...e,kind:'event',status:'approved',googleId:e.id});
 await f.store.put('secrets','google',{calendarId:'output@group.calendar.google.com'});
 await showMenu(f.store,f.queue,'events',1,{now});
 assert.equal(f.sent.filter(j=>j.payload.text.startsWith(sample.title)).length,1);
 assert.equal(f.sent.filter(j=>j.payload.text.includes('Already on Google Calendar')).length,3);
 assert.ok(f.sent.every(j=>!j.payload.replyMarkup.inline_keyboard.flat().some(b=>b.text==='Add to calendar')));
});
test('calendar-only pagination exposes every event and discovery remains available',async()=>{
 const f=fixture();await f.seed(Array.from({length:10},(_,i)=>({...sample,id:`e${i}`,remoteId:`r${i}`,title:`Meeting ${i}`})));
 await f.store.put('events','invite',{...sample,id:'invite',title:'New invitation',kind:'event',status:'review'});
 await showMenu(f.store,f.queue,'calendar',1,{now});assert.equal(f.sent.filter(j=>j.payload.notification).length,8);
 const buttons=f.sent.at(-1).payload.replyMarkup.inline_keyboard.flat();assert.ok(buttons.some(b=>b.text==='More events'));assert.ok(buttons.some(b=>b.text==='Discover events'));
 await showMenu(f.store,f.queue,'calendar:8',2,{now});assert.equal(f.sent.filter(j=>j.payload.notification).length,10);
 await showMenu(f.store,f.queue,'discover',3,{now});assert.ok(f.sent.some(j=>j.payload.text.startsWith('New invitation')&&j.payload.replyMarkup.inline_keyboard.flat().some(b=>b.text==='Add to calendar')));
});
test('My day, Tomorrow and week use New York dates, include all-day plans, and preserve review status',async()=>{
 const f=fixture();await f.seed([sample,allDay,{...sample,id:'today',remoteId:'today',title:'Today plan',date:'2026-11-12',start:'2026-11-12T20:00:00Z',end:'2026-11-12T21:00:00Z'}]);
 await f.store.put('events','review',{id:'review',title:'Unconfirmed deadline',date:'2026-11-13',kind:'assignment',status:'review'});
 const today=await buildScheduleBrief(f.store,1,{now}),tomorrow=await buildScheduleBrief(f.store,1,{now,offset:1}),week=await buildScheduleBrief(f.store,7,{now});
 assert.match(today.text,/Today plan/);assert.doesNotMatch(today.text,/Maker Day|Unconfirmed deadline/);
 assert.match(tomorrow.text,/Tomorrow · 2026-11-13/);assert.match(tomorrow.text,/All day · Maker Day/);assert.match(tomorrow.text,/Unconfirmed deadline \[review\]/);assert.doesNotMatch(tomorrow.text,/Today plan/);
 assert.match(week.text,/Today plan/);assert.match(week.text,/Maker Day/);assert.equal(week.notification.personalCalendarRevision,2);
 await showMenu(f.store,f.queue,'tomorrow',1,{now});assert.match(f.sent.at(-1).payload.text,/EMC2 Fellows/);
 const summer=agendaWindow(Date.parse('2026-03-08T12:00:00Z'),1);assert.equal(summer.end-summer.start,23*3600000);
 const late=agendaWindow(Date.parse('2026-11-13T02:00:00Z'),1);assert.equal(late.date,'2026-11-12');
 const tonight={...sample,id:'tonight',start:'2026-11-13T00:00:00Z'};
 assert.deepEqual([allDay,tonight,sample].sort(agendaSort).map(e=>e.id),['tonight','maker','meeting']);
 assert.equal(inAgendaWindow({...allDay,date:'2026-11-10',endDate:'2026-11-13'},agendaWindow(NOW,1)),true);
 assert.equal(inAgendaWindow({...allDay,date:'2026-11-10',endDate:'2026-11-12'},agendaWindow(NOW,1)),false);
});
test('calendar reading is opt-in per student; disconnected snapshots are not displayed',async()=>{
 const f=fixture();await f.seed([sample]);
 const other=fixture('student-b');await showMenu(other.store,other.queue,'events',1,{now});
 assert.doesNotMatch(other.sent.map(j=>j.payload.text).join('\n'),/EMC2/);assert.match(other.sent.at(-1).payload.text,/Choose calendars in Connections/);
 await f.store.delete('secrets','campusGoogle');await showMenu(f.store,f.queue,'events',2,{now});
 assert.doesNotMatch(f.sent.map(j=>j.payload.text).join('\n'),/EMC2/);assert.match(f.sent.at(-1).payload.text,/disconnected/);
});
test('queued personal agenda content is suppressed after opt-out or selection changes',async()=>{
 const f=fixture();await f.seed([sample]);await showMenu(f.store,f.queue,'events',1,{now});
 const notice=f.sent[0].payload.notification;
 await f.store.put('settings','personalCalendar',{enabled:true,revision:3,events:[]});
 assert.deepEqual(await sendTelegram(f.store,'private agenda',{notification:notice}),{suppressed:true,reason:'personal-calendars-changed'});
 await f.store.put('settings','personalCalendar',{enabled:false,revision:2,events:[]});
 assert.equal((await sendTelegram(f.store,'private agenda',{notification:notice})).suppressed,true);
});
test('Google Calendar button validation rejects redirect parameters and lookalike hosts',()=>{
 const markup=url=>({inline_keyboard:[[{text:'Open in Google Calendar',url}]]}),valid=googleCalendarEventURL(sample);
 validateTelegramReplyMarkup(markup(valid));
 assert.equal(Buffer.from(new URL(valid).searchParams.get('eid'),'base64url').toString(),'remote1 student@cornell.edu');
 for(const url of [valid+'&redirect=https://evil.example',valid+'#evil',valid.replace('calendar.google.com','calendar.google.com.evil.example'),valid.replace('https://','https://user:pass@'),'https://calendar.google.com/calendar/event?eid='])assert.throws(()=>validateTelegramReplyMarkup(markup(url)));
});
test('today, tomorrow and week shortcuts route to the same menus without a model',async()=>{
 const f=fixture();for(const command of ['/today','/tomorrow','/week'])assert.equal(await handleMenuMessage(f.store,f.queue,{text:command},command),true);
 assert.ok(f.sent.every(j=>j.type==='telegram-send'));assert.match(f.sent[1].payload.text,/Tomorrow/);assert.match(f.sent[2].payload.text,/Your week/);
});
