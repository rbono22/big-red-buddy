import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {handlePartifulMessage} from '../lib/partiful-telegram.mjs';
import {handleMessage} from '../lib/telegram.mjs';

const calendarId='partiful@import.calendar.google.com';
const eventURL='https://partiful.com/e/TQ9R6V4MN2ZX7aBcDeF1GH';
async function setup(t){
 const dir=await mkdtemp(path.join(tmpdir(),'brf-partiful-telegram-'));
 const db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 const a=db.forUser('alice'),b=db.forUser('bob'),queue=await createQueue(db),payloads=new Map(),instant=Date.now();
 const originalEnqueue=queue.enqueue.bind(queue);queue.enqueue=async(...args)=>{const job=await originalEnqueue(...args);if(!payloads.has(job.id))payloads.set(job.id,structuredClone(args[2]));return job;};
 const event=(id,patch={})=>({id,sourceCalendarId:calendarId,sourceCalendarName:'Partiful invitations',remoteId:id,title:'Synthetic alumni gathering',description:'PRIVATE DESCRIPTION NOT FOR TELEGRAM',start:new Date(instant+86400000).toISOString(),end:new Date(instant+90000000).toISOString(),date:new Date(instant+86400000).toISOString().slice(0,10),time:'17:00',timezone:'America/New_York',location:'Tata lobby',rsvpUrl:eventURL,sourceUrl:eventURL,allDay:false,status:'available',warnings:[],localIntent:null,sourceUpdatedAt:new Date(instant).toISOString(),updatedAt:new Date(instant).toISOString(),...patch});
 await a.put('secrets','telegram',{chatId:101});await b.put('secrets','telegram',{chatId:202});
 await a.put('settings','partifulCalendar',{calendarId,calendarName:'Partiful invitations',continuous:true,autoAdd:false});await b.put('settings','partifulCalendar',{calendarId,calendarName:'Partiful invitations',continuous:true,autoAdd:false});
 await a.put('partifulEvents','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',event('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));await b.put('partifulEvents','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',event('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',{title:'Bob private gathering'}));
 let update=1;
 const send=(text,updateId=update++,extra={})=>handlePartifulMessage(a,queue,{text,chat:{id:101,type:'private'},...extra},updateId,{now:()=>instant});
 const jobs=()=>queue.list('alice');
 const messages=async()=>{const replies=new Set((await jobs()).filter(j=>j.type==='telegram-send').map(j=>j.id));return [...payloads].filter(([id])=>replies.has(id)).map(([,payload])=>payload.text);};
 return {db,a,b,queue,event,instant,send,jobs,messages,payloads};
}

test('Partiful commands require the linked private chat and never reveal another student event',async t=>{
 const s=await setup(t);
 for(const [text,extra]of [['/partiful',{chat:{id:202,type:'private'}}],['/partiful',{chat:{id:101,type:'group'}}],['/partiful@other_bot',{}],['ordinary question',{}]])assert.equal(await s.send(text,1,extra),false);
 assert.equal((await s.jobs()).length,0);
 assert.equal(await s.send('/partiful',2),true);
 const [message]=await s.messages();assert.match(message,/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);assert.doesNotMatch(message,/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|Bob private|PRIVATE DESCRIPTION/);
 await assert.rejects(s.send('/partiful going bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',3),error=>error.status===404);
 assert.equal((await s.b.get('partifulEvents','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).localIntent,null);
 assert.equal((await s.a.all('events')).length,0);
 await assert.rejects(s.send('/partiful going aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',-1),/update ID/);assert.equal((await s.a.get('partifulEvents','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).localIntent,null);
 await s.a.delete('secrets','telegram');assert.equal(await s.send('/partiful',4),false);
});

test('Partiful list uses the selected source, excludes cancelled and past events, and preserves valid RSVP links',async t=>{
 const s=await setup(t);
 await s.a.put('partifulEvents','other-source',s.event('other-source',{sourceCalendarId:'other-calendar',title:'Wrong selected source'}));
 await s.a.put('partifulEvents','cancelled',s.event('cancelled',{status:'cancelled',title:'Cancelled gathering'}));
 await s.a.put('partifulEvents','past',s.event('past',{start:new Date(s.instant-7200000).toISOString(),end:new Date(s.instant-3600000).toISOString(),title:'Historical gathering'}));
 await s.a.put('partifulEvents','past-all-day',s.event('past-all-day',{start:null,end:null,allDay:true,date:'2000-01-01',endDate:'2000-01-02',title:'Historical all-day gathering'}));
 await s.a.put('partifulEvents','ongoing',s.event('ongoing',{start:new Date(s.instant-3600000).toISOString(),title:'Ongoing gathering',location:''}));
 await s.send('/partiful list');
 const [message]=await s.messages();assert.match(message,/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);assert.match(message,/Ongoing gathering/);assert.ok(message.includes(eventURL));assert.match(message,/Location not published/);
 assert.doesNotMatch(message,/Wrong selected source|Cancelled gathering|Historical/);assert.match(message,/Neither action submits an RSVP/);
 await assert.rejects(s.send('/partiful maybe other-source'),error=>error.status===404);
});

test('going, maybe, and decline save local intent only and never claim a completed RSVP',async t=>{
 const s=await setup(t);await s.a.put('secrets','google',{refresh_token:'synthetic-write-token'});
 for(const [command,intent]of [['going','going'],['maybe','maybe'],['decline','declined']]){
  await s.send(`/partiful ${command} aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
  const event=await s.a.get('partifulEvents','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');assert.equal(event.localIntent,intent);assert.equal(event.localIntentSource,'student-local');
 }
 assert.equal((await s.a.all('events')).length,0);assert.equal((await s.a.all('reminders')).length,0);assert.equal((await s.jobs()).some(j=>j.type!=='telegram-send'),false);
 for(const message of await s.messages()){
  assert.match(message,/local planning preference/);assert.match(message,/does not submit an RSVP or add an event/);assert.ok(message.includes(eventURL));
  assert.doesNotMatch(message,/(?:^|[.!?]\s+)(?:(?:Your|The|Partiful) )?RSVP (?:is |was |has been )?(?:sent|confirmed|submitted)\b/im);assert.doesNotMatch(message,/you(?:'re| are) (?:registered|confirmed)/i);
 }
 assert.equal((await s.b.get('partifulEvents','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).localIntent,null);
});

test('explicit add creates student reminders and queues one calendar update across a repeated Telegram update',async t=>{
 const s=await setup(t);await s.a.put('secrets','google',{refresh_token:'synthetic-write-token'});
 await s.send('/partiful add aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',10);await s.send('/partiful add aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',10);
 const events=await s.a.all('events'),jobs=await s.jobs();assert.equal(events.length,1);assert.equal(events[0].status,'approved');assert.equal(events[0].kind,'event');
 assert.equal((await s.a.all('reminders')).filter(r=>r.status==='pending').length,1);
 const syncs=jobs.filter(j=>j.type==='google-sync');assert.equal(syncs.length,1);assert.deepEqual(s.payloads.get(syncs[0].id),{eventIds:[events[0].id]});
 assert.equal((await s.b.all('events')).length,0);assert.equal((await s.a.get('partifulEvents','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).localIntent,null);
 const messages=await s.messages();assert.equal(messages.length,1);assert.match(messages[0],/Google Calendar sync queued/);assert.match(messages[0],/does not RSVP/);assert.ok(messages[0].includes(eventURL));
 assert.ok(jobs.every(j=>['google-sync','telegram-send'].includes(j.type)));
});

test('unpublished event times block adding reminders while local intent stays independent',async t=>{
 const s=await setup(t);await s.a.put('partifulEvents','cccccccccccccccccccccccccccccccc',s.event('cccccccccccccccccccccccccccccccc',{start:null,end:null,allDay:true}));
 await s.send('/partiful maybe cccccccccccccccccccccccccccccccc',1);await assert.rejects(s.send('/partiful add cccccccccccccccccccccccccccccccc',2),error=>error.status>=400&&error.status<500);
 assert.equal((await s.a.get('partifulEvents','cccccccccccccccccccccccccccccccc')).localIntent,'maybe');assert.equal((await s.a.all('events')).length,0);assert.equal((await s.a.all('reminders')).length,0);
});

test('declining an added event explains the local reminder change and keeps any Google copy intact',async t=>{
 const s=await setup(t);await s.send('/partiful add aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1);const [event]=await s.a.all('events');
 await s.a.put('events',event.id,{...event,googleId:'synthetic-google-event'});
 await s.send('/partiful decline aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',2);
 const dismissed=await s.a.get('events',event.id);assert.equal(dismissed.status,'dismissed');assert.equal(dismissed.googleId,'synthetic-google-event');
 assert.equal((await s.a.all('reminders')).filter(r=>r.status==='pending').length,0);
 const reply=(await s.messages()).at(-1);assert.match(reply,/Google Calendar/);assert.match(reply,/local planning preference/);
 await assert.rejects(s.send('/partiful add aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',3),error=>error.status>=400&&error.status<500);
 await s.send('/partiful going aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',4);assert.equal((await s.a.get('events',event.id)).status,'dismissed');
 assert.equal((await s.a.all('reminders')).filter(r=>r.status==='pending').length,0);
 assert.ok((await s.jobs()).every(j=>j.type==='telegram-send'));
});

test('invalid links and malformed commands cannot reach Partiful endpoints or trigger model processing',async t=>{
 const s=await setup(t);await s.a.put('partifulEvents','dddddddddddddddddddddddddddddddd',s.event('dddddddddddddddddddddddddddddddd',{rsvpUrl:'https://partiful.com.evil.example/e/private',sourceUrl:'javascript:alert(1)',title:'External link fixture'}));
 await s.send('/partiful going dddddddddddddddddddddddddddddddd');
 for(const command of ['/partiful yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','/partiful going aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa extra','/partiful add ../aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','/partiful list extra'])await s.send(command);
 const messages=await s.messages();assert.match(messages[0],/verified Partiful event link is unavailable/);assert.doesNotMatch(messages.join('\n'),/evil.example|javascript:|alert\(1\)/);
 assert.equal((await s.a.all('events')).length,0);assert.ok((await s.jobs()).every(j=>j.type==='telegram-send'));
 await s.a.delete('settings','partifulCalendar');await s.send('/partiful add aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');assert.match((await s.messages()).at(-1),/Choose a subscribed Partiful calendar/);
});

test('long lists remain bounded and keep complete IDs plus the RSVP limitation',async t=>{
 const s=await setup(t);
 for(let n=0;n<12;n++){const id=`party-${n}-`+'a'.repeat(180);await s.a.put('partifulEvents',id,s.event(id,{title:'Very long synthetic event '.repeat(20),location:'Location '.repeat(40),rsvpUrl:eventURL+'?private=omit-me'}));}
 await s.send('/partiful');const [message]=await s.messages();assert.ok(message.length<=3900);assert.match(message,/Neither action submits an RSVP\.$/);assert.doesNotMatch(message,/private=omit-me/);
 const ids=[...message.matchAll(/^ID: (.+)$/gm)].map(match=>match[1]);assert.ok(ids.length<=8&&ids.length>0);for(const id of ids)assert.ok(await s.a.get('partifulEvents',id));
});

test('shared Telegram router handles Partiful deterministically under the bound student identity',async t=>{
 const s=await setup(t),key=createHash('sha256').update('101').digest('hex');await s.db.system.put('telegramChats',key,{userId:'alice'});
 await handleMessage(s.db,s.queue,{text:'/partiful going aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',chat:{id:101,type:'private'}},100);
 assert.equal((await s.a.get('partifulEvents','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).localIntent,'going');assert.equal((await s.b.get('partifulEvents','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).localIntent,null);
 assert.equal((await s.jobs()).some(j=>j.type==='telegram-chat'),false);assert.match((await s.messages())[0],/local planning preference/);
 await handleMessage(s.db,s.queue,{text:'/partiful going bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',chat:{id:101,type:'private'}},101);assert.equal((await s.b.get('partifulEvents','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).localIntent,null);assert.match((await s.messages()).at(-1),/not available/);
});
