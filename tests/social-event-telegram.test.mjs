import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {CALENDAR_SCOPE,CAMPUS_CALENDAR_SCOPES} from '../lib/auth.mjs';
import {handleCallbackQuery} from '../lib/telegram.mjs';
import {handlePartifulMessage} from '../lib/partiful-telegram.mjs';
import {handleLumaMessage} from '../lib/luma-telegram.mjs';
import {queueSocialEventCard} from '../lib/social-event-telegram.mjs';
import {validateTelegramReplyMarkup,dispatchQueuedTelegram} from '../lib/telegram-delivery.mjs';
import {pilotSheetConfig} from '../lib/pilot-access.mjs';

const ID='a'.repeat(32),handlers={partiful:handlePartifulMessage,luma:handleLumaMessage};
async function setup(t,provider='partiful'){
 const dir=await mkdtemp(path.join(tmpdir(),'brb-social-buttons-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 const a=db.forUser('alice'),b=db.forUser('bob'),queue=await createQueue(db),payloads=new Map(),now=Date.now(),answers=[];
 const enqueue=queue.enqueue.bind(queue);queue.enqueue=async(...args)=>{const result=await enqueue(...args);if(!payloads.has(result.id))payloads.set(result.id,{type:args[1],payload:structuredClone(args[2])});return result;};
 const calendarId=`${provider}@import.calendar.google.com`,url=provider==='partiful'?'https://partiful.com/e/SyntheticEvent123':'https://luma.com/synthetic-event';
 for(const [store,chatId]of [[a,101],[b,202]]){
  await store.put('secrets','telegram',{chatId,linkedAt:'original-link'});
  await db.system.put('telegramChats',createHash('sha256').update(String(chatId)).digest('hex'),{userId:store.userId});
  await store.put('settings',`${provider}Calendar`,{calendarId,continuous:true,autoAdd:false});
  await store.put('secrets','google',{refresh_token:'synthetic-write',scope:CALENDAR_SCOPE});
  await store.put('secrets','campusGoogle',{refresh_token:'synthetic-read',scope:CAMPUS_CALENDAR_SCOPES.join(' ')});
 }
 const event={id:ID,sourceCalendarId:calendarId,sourceCalendarName:`${provider} calendar`,remoteId:'remote',title:'Private alumni meetup',description:'Private description not sent',start:new Date(now+86400000).toISOString(),end:new Date(now+90000000).toISOString(),date:new Date(now+86400000).toISOString().slice(0,10),location:'Tata lobby',rsvpUrl:url,sourceUrl:url,allDay:false,status:'available',warnings:[],localIntent:null};
 await a.put(`${provider}Events`,ID,event);
 const card=async(options={})=>{const result=await queueSocialEventCard(a,queue,provider,ID,{now:()=>now,...options});return {result,payload:payloads.get(result.taskId).payload};};
 const click=(data,updateId=100,overrides={},at=now)=>handleCallbackQuery(db,queue,{id:`callback-${updateId}`,from:{id:101,is_bot:false},message:{chat:{id:101,type:'private'}},data,...overrides},updateId,{now:()=>at,answer:async answer=>{answers.push(answer);return {ok:true};}});
 const data=(payload,action)=>payload.replyMarkup.inline_keyboard.flat().find(button=>button.text.startsWith(action)).callback_data;
 return {db,a,b,queue,payloads,now,answers,event,card,click,data,provider,calendarId};
}

for(const provider of ['partiful','luma']){
 test(`${provider} cards include provider links and owned expiring buttons without leaking details`,async t=>{
  const s=await setup(t,provider),{result,payload}=await s.card({idempotencyKey:'same-card'});
  assert.deepEqual(Object.keys(result),['taskId']);
  assert.equal(payload.expectedChatId,'101');
  assert.doesNotMatch(payload.text,/Private description/);
  const buttons=payload.replyMarkup.inline_keyboard.flat();
  assert.equal(buttons[0].text,provider==='partiful'?'RSVP on Partiful':'Register on Luma');
  assert.equal(buttons[0].url,s.event.rsvpUrl);
  assert.deepEqual(buttons.slice(1).map(button=>button.text),['Add to Google Calendar','Maybe · local plan','Decline · local plan']);
  for(const button of buttons.slice(1)){
   assert.match(button.callback_data,/^social:[a-f0-9]{32}$/);
   const token=await s.a.get('socialTelegramActions',button.callback_data.slice(7));
   assert.equal(token.expiresAt,s.now+86400000);assert.equal(token.eventId,ID);
   assert.equal(await s.b.get('socialTelegramActions',token.id),null);
  }
  assert.equal((await s.card({idempotencyKey:'same-card'})).result.taskId,result.taskId);
 });
 test(`${provider} add button queues Calendar once and rejects old buttons after changes`,async t=>{
  const s=await setup(t,provider),{payload}=await s.card(),add=s.data(payload,'Add');
  assert.equal(await s.click(add),true);
  const [saved]=await s.a.all('events');assert.equal(saved.status,'approved');
  const tasks=()=>[...s.payloads.values()].filter(job=>job.type==='google-sync');
  assert.equal(tasks().length,1);assert.deepEqual(tasks()[0].payload.eventIds,[saved.id]);
  await s.click(add);assert.equal(tasks().length,1);
  await s.click(s.data(payload,'Maybe'),101);assert.equal((await s.a.get(`${provider}Events`,ID)).localIntent,null);
  const fresh=await s.card();await s.click(s.data(fresh.payload,'Decline'),102);
  assert.equal((await s.a.get('events',saved.id)).status,'dismissed');
  assert.equal((await s.a.all('reminders')).filter(row=>row.status==='pending').length,0);
  assert.ok(s.answers.length>0);assert.equal((await s.b.all('events')).length,0);
 });
}

test('callbacks reject foreign owners, forged senders, groups, relinks and stale source details',async t=>{
 const s=await setup(t),{payload}=await s.card(),add=s.data(payload,'Add');
 assert.equal(await s.click(add,1,{from:{id:202}}),false);
 assert.equal(await s.click(add,2,{message:{chat:{id:101,type:'group'}}}),false);
 await s.click(add,3,{from:{id:202},message:{chat:{id:202,type:'private'}}});
 assert.equal((await s.b.all('events')).length,0);
 await s.a.put('partifulEvents',ID,{...s.event,location:'Changed room'});
 await s.click(add,4);assert.equal((await s.a.all('events')).length,0);
 const fresh=await s.card();
 await s.a.put('secrets','telegram',{chatId:101,linkedAt:'new-link'});
 await s.click(s.data(fresh.payload,'Add'),5);assert.equal((await s.a.all('events')).length,0);
 assert.ok([...s.payloads.values()].some(row=>/changed|expired/.test(row.payload.text||'')));
});

test('expired or changed-source buttons cannot add events',async t=>{
 const s=await setup(t),{payload}=await s.card(),add=s.data(payload,'Add');
 await s.click(add,1,{},s.now+86400001);assert.equal((await s.a.all('events')).length,0);
 await s.a.put('settings','partifulCalendar',{calendarId:'another@import.calendar.google.com'});
 await s.click(add,2);assert.equal((await s.a.all('events')).length,0);
 await assert.rejects(queueSocialEventCard(s.b,s.queue,'partiful',ID),{status:404});
});

test('revoked pilot users cannot use existing event buttons',async t=>{
 const s=await setup(t),{payload}=await s.card(),old={id:process.env.PILOT_SHEET_ID,owner:process.env.PILOT_SHEET_OWNER};
 t.after(()=>{for(const [name,value]of [['PILOT_SHEET_ID',old.id],['PILOT_SHEET_OWNER',old.owner]])value===undefined?delete process.env[name]:process.env[name]=value;});
 process.env.PILOT_SHEET_ID='synthetic_sheet_1234567890';process.env.PILOT_SHEET_OWNER='owner@cornell.edu';
 const cfg=pilotSheetConfig();await s.db.auth.put('pilot_access',`snapshot:${cfg.key}`,{syncedAt:Date.now(),approved:['owner@cornell.edu']});
 await s.db.auth.put('users','alice',{provider:'google',hostedDomain:'cornell.edu',email:'alice@cornell.edu'});
 assert.equal(await s.click(s.data(payload,'Add')),false);assert.equal((await s.a.all('events')).length,0);
});

test('lists send at most five actionable cards and display actual saved status',async t=>{
 const s=await setup(t,'luma');
 for(let index=1;index<=7;index++){const id=index.toString(16).padStart(32,'0');await s.a.put('lumaEvents',id,{...s.event,id});}
 await s.a.put('lumaEvents',ID,{...s.event,addedEventId:'saved'});await s.a.put('events','saved',{id:'saved',status:'dismissed'});
 const dismissed=await s.card();assert.match(dismissed.payload.text,/Reminders off/);assert.doesNotMatch(dismissed.payload.text,/Added to BRB schedule/);
 s.payloads.clear();await handlers.luma(s.a,s.queue,{text:'/luma',chat:{id:101,type:'private'}},5,{now:()=>s.now});
 const cards=[...s.payloads.values()].filter(job=>job.payload.replyMarkup);assert.equal(cards.length,5);
 assert.ok(cards.every(job=>job.payload.text.length<1000));
});

test('Partiful replays cannot undo a later decline or reapprove changed details',async t=>{
 const s=await setup(t),send=(text,id)=>handlers.partiful(s.a,s.queue,{text,chat:{id:101,type:'private'}},id,{now:()=>s.now});
 await send(`/partiful add ${ID}`,100);const [saved]=await s.a.all('events');
 await send(`/partiful going ${ID}`,101);await send(`/partiful decline ${ID}`,102);await send(`/partiful going ${ID}`,101);
 assert.equal((await s.a.get('partifulEvents',ID)).localIntent,'declined');
 await send(`/partiful going ${ID}`,103);await s.a.put('events',saved.id,{...saved,status:'review'});
 await send(`/partiful add ${ID}`,100);assert.equal((await s.a.get('events',saved.id)).status,'review');
 await s.a.put('settings','partifulTelegramMutation',{updateId:104,status:'handling',expiresAt:s.now+300000});
 await send(`/partiful maybe ${ID}`,104);assert.equal((await s.a.get('partifulEvents',ID)).localIntent,'going');
});

test('button validation permits only bounded event links and opaque callbacks',()=>{
 const good={inline_keyboard:[[{text:'RSVP',url:'https://partiful.com/e/Event123'}],[{text:'Add',callback_data:'social:'+'a'.repeat(32)}]]};
 assert.deepEqual(validateTelegramReplyMarkup(good),good);
 for(const value of [null,{}, {inline_keyboard:[]}, {inline_keyboard:[[ {text:'X',url:'https://evil.test/event'} ]]}, {inline_keyboard:[[ {text:'X',url:'https://partiful.com/e/Event123?token=private'} ]]}, {inline_keyboard:[[ {text:'X',url:'http://luma.com/event'} ]]}, {inline_keyboard:[[ {text:'X',url:'https://user:secret@luma.com/event'} ]]}, {inline_keyboard:[[ {text:'X',callback_data:'delete:all'} ]]}, {inline_keyboard:[[ {text:'X',url:'https://luma.com/event',callback_data:'social:'+'b'.repeat(32)} ]]}, {inline_keyboard:good.inline_keyboard,resize_keyboard:true}])assert.throws(()=>validateTelegramReplyMarkup(value));
});

test('delivery passes validated buttons and suppresses queued private cards after relinking',async t=>{
 const s=await setup(t),{payload}=await s.card(),calls=[];
 const send=async(...args)=>{calls.push(args);return {result:{message_id:1}};};
 await dispatchQueuedTelegram(s.a,{payload},{send});assert.deepEqual(calls[0][2].replyMarkup,payload.replyMarkup);
 await s.a.put('secrets','telegram',{chatId:303,linkedAt:'new'});
 const result=await dispatchQueuedTelegram(s.a,{payload},{send});assert.equal(result.suppressed,true);assert.equal(calls.length,1);
 await assert.rejects(dispatchQueuedTelegram(s.a,{payload:{...payload,replyMarkup:{inline_keyboard:[]}}},{send}),/Invalid Telegram buttons/);
});

test('cards without calendar write access promise only a saved BRB schedule',async t=>{
 const s=await setup(t);await s.a.delete('secrets','google');
 const {payload}=await s.card(),buttons=payload.replyMarkup.inline_keyboard.flat();
 assert.ok(buttons.some(button=>button.text==='Save to BRB schedule'));
 assert.ok(!buttons.some(button=>button.text==='Add to Google Calendar'));
});

test('callback acknowledgement failures do not drop actions and malformed callbacks stay bounded',async t=>{
 const s=await setup(t),{payload}=await s.card(),data=s.data(payload,'Add');
 const query={id:'synthetic-callback',from:{id:101},message:{chat:{id:101,type:'private'}},data};
 assert.equal(await handleCallbackQuery(s.db,s.queue,query,100,{now:()=>s.now,answer:()=>{throw new Error('Synthetic acknowledgement failure');}}),true);
 assert.equal((await s.a.all('events')).length,1);
 assert.equal(await handleCallbackQuery(s.db,s.queue,{...query,data:'social:malformed'},101,{answer:async()=>{throw new Error('Synthetic acknowledgement failure');}}),true);
 assert.equal(await handleCallbackQuery(s.db,s.queue,{...query,message:{chat:{type:'private'}}},102,{answer:async()=>{}}),false);
 assert.equal((await s.a.all('events')).length,1);
});
