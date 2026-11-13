import test from 'node:test';
import assert from 'node:assert/strict';
import {handleCalendarDeletionMessage,handleCalendarDeletionAction,executeCalendarDeletionJob,parseCalendarDeletionRequest} from '../lib/calendar-deletion-telegram.mjs';
import {handleMenuCallback,showMenu,menuCard} from '../lib/telegram-menu.mjs';
import {createDeletionProposal,listDeletionCandidates} from '../lib/calendar-deletion.mjs';
import {dispatchQueuedTelegram,validateTelegramReplyMarkup} from '../lib/telegram-delivery.mjs';
import {REMINDER_TYPES} from '../lib/job-handlers.mjs';

process.env.APP_ORIGIN='https://app.synthetic.example';
function setup({deduplicate=false}={}){
 const rows=new Map(),sent=[];
 const key=(b,k)=>`${b}:${k}`,clone=v=>structuredClone(v??null);
 const store={userId:'synthetic-student',get:async(b,k)=>clone(rows.get(key(b,k))),put:async(b,k,v)=>rows.set(key(b,k),clone(v)),delete:async(b,k)=>rows.delete(key(b,k)),all:async b=>[...rows].filter(([k])=>k.startsWith(b+':')).map(([,v])=>clone(v)),compareAndSet:async(b,k,old,next)=>{if(JSON.stringify(rows.get(key(b,k))??null)!==JSON.stringify(old))return false;rows.set(key(b,k),clone(next));return true;},putIfAbsent:async(b,k,v)=>{if(!rows.has(key(b,k)))rows.set(key(b,k),clone(v));return clone(rows.get(key(b,k)));}};
 rows.set('secrets:telegram',{chatId:101,linkedAt:'first-link'});
 const queued=new Map(),queue={enqueue:async(user,type,payload,options)=>{const identity=options?.idempotencyKey;if(deduplicate&&identity&&queued.has(identity))return queued.get(identity);const task={id:String(sent.length),user,type,payload,options};sent.push(task);if(identity)queued.set(identity,task);return task;}};
 const last=type=>sent.filter(j=>j.type===type).at(-1),button=label=>last('telegram-send').payload.replyMarkup.inline_keyboard.flat().find(b=>b.text===label);
 const click=(label,id=sent.length)=>handleMenuCallback(null,store,queue,{data:button(label).callback_data,message:{chat:{id:101,type:'private'}}},id);
 const run=(type,deps={})=>{const job=last(type);return executeCalendarDeletionJob(store,queue,type,job.payload,{key:job.id,...deps});};
 return {store,queue,sent,last,button,click,run};
}
async function eventSetup(){
 const s=setup(),start=new Date(Date.now()+86400000).toISOString(),end=new Date(Date.now()+90000000).toISOString();
 const event={id:'study',title:'Studying with Josh',start,end,kind:'event',status:'approved',googleId:'remote-study'};
 await s.store.put('events',event.id,event);await s.store.put('secrets','google',{calendarId:'brb-calendar',refresh_token:'SYNTHETIC_SECRET'});
 const raw={id:'remote-study',summary:event.title,start:{dateTime:start},end:{dateTime:end},etag:'"one"',organizer:{self:true},extendedProperties:{private:{dabasId:'study'}}};
 const client={get:async()=>raw};
 const preview=(store,input,options)=>createDeletionProposal(store,input,{...options,client});
 return {...s,event,raw,preview};
}
async function openPreview(s){
 await handleCalendarDeletionAction(s.store,s.queue,{operation:'preview',localId:'study'},'open');
 await s.run('calendar-delete-preview',{preview:s.preview});
}

test('natural removal phrases and commands start an explicit selection, never a mutation',async()=>{
 for(const phrase of ['/deleteevent Josh','/removeevent Josh','/deleteevent@big_red_buddy_bot Josh','/removeevent@big_red_buddy_bot Josh','Remove Josh from my calendar','Delete Josh']){
  assert.equal(parseCalendarDeletionRequest(phrase),'Josh');const s=setup();assert.equal(await handleCalendarDeletionMessage(s.store,s.queue,{text:phrase},1),true);
  assert.equal(s.last('calendar-delete-search').payload.query,'Josh');assert.equal(s.last('calendar-delete'),undefined);
 }
 assert.equal(parseCalendarDeletionRequest('delete an event'),'');assert.equal(parseCalendarDeletionRequest('what is my schedule?'),null);
});
test('replayed Telegram updates retain the durable flow used by deduplicated jobs and preserve newer searches',async()=>{
 const s=setup({deduplicate:true});await handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent Josh'},10);
 const first=await s.store.get('settings','calendarDeletionFlow');
 await handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent Josh'},10);
 assert.equal((await s.store.get('settings','calendarDeletionFlow')).id,first.id);assert.equal(s.sent.filter(j=>j.type==='calendar-delete-search').length,1);
 await s.run('calendar-delete-search',{list:async()=>({items:[],notice:'Synthetic search completed'})});
 assert.match(s.last('telegram-send').payload.text,/Synthetic search completed/);
 await handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent Josh'},10);assert.equal((await s.store.get('settings','calendarDeletionFlow')).status,'results');
 await handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent New event'},11);const newer=await s.store.get('settings','calendarDeletionFlow');
 await handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent Josh'},10);assert.deepEqual(await s.store.get('settings','calendarDeletionFlow'),newer);
});
test('replay recovers a reserved flow after a crash before installing it in settings',async()=>{
 const s=setup({deduplicate:true}),cas=s.store.compareAndSet;let crash=true;
 s.store.compareAndSet=async(bucket,id,before,after)=>{if(crash&&bucket==='settings'&&id==='calendarDeletionFlow'){crash=false;throw Error('Synthetic crash after reservation');}return cas(bucket,id,before,after);};
 await assert.rejects(handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent Josh'},20),/Synthetic crash/);
 const reserved=(await s.store.all('calendarDeletionRequests'))[0];assert.ok(reserved);assert.equal(await s.store.get('settings','calendarDeletionFlow'),null);
 await handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent Josh'},20);
 assert.equal((await s.store.get('settings','calendarDeletionFlow')).id,reserved.id);assert.equal(s.last('calendar-delete-search').payload.flowId,reserved.id);
 await s.run('calendar-delete-search',{list:async()=>({items:[]})});assert.equal((await s.store.get('settings','calendarDeletionFlow')).status,'results');
});
test('preview entry replay reuses the reserved flow without overwriting a completed preview',async()=>{
 const s=setup({deduplicate:true}),target={operation:'preview',localId:'study'};
 await handleCalendarDeletionAction(s.store,s.queue,target,30);const first=await s.store.get('settings','calendarDeletionFlow');
 await handleCalendarDeletionAction(s.store,s.queue,target,30);assert.equal(s.sent.filter(j=>j.type==='calendar-delete-preview').length,1);
 await s.run('calendar-delete-preview',{preview:async()=>({id:'a'.repeat(32),revision:1,title:'Study',date:'2027-01-01',start:'2027-01-01',end:'2027-01-02',allDay:true,calendarName:'Personal',impact:'Delete one event.'})});
 await handleCalendarDeletionAction(s.store,s.queue,target,30);const current=await s.store.get('settings','calendarDeletionFlow');assert.equal(current.id,first.id);assert.equal(current.status,'preview');
});
test('plain text during preview and confirmation is consumed without authorizing deletion or reaching another flow',async()=>{
 const s=await eventSetup();await handleCalendarDeletionAction(s.store,s.queue,{operation:'preview',localId:'study'},'plain-preview');
 assert.equal(await handleCalendarDeletionMessage(s.store,s.queue,{text:'yes'},40),true);assert.equal(s.last('calendar-delete'),undefined);assert.match(s.last('telegram-send').payload.text,/still checking/);
 await s.run('calendar-delete-preview',{preview:s.preview});
 assert.equal(await handleCalendarDeletionMessage(s.store,s.queue,{text:'yes'},41),true);assert.equal(s.last('calendar-delete'),undefined);assert.match(s.last('telegram-send').payload.text,/text reply does not delete/);
 const flow=await s.store.get('settings','calendarDeletionFlow');await s.store.put('settings','calendarDeletionFlow',{...flow,status:'confirming'});
 for(const text of ['yes','cancel','/cancel']){assert.equal(await handleCalendarDeletionMessage(s.store,s.queue,{text},`confirming:${text}`),true);assert.match(s.last('telegram-send').payload.text,/being processed/);}
 assert.equal(s.last('calendar-delete'),undefined);
});
test('Events and My calendar expose removal without typing a command',async()=>{
 const s=setup();await showMenu(s.store,s.queue,'calendar',1,{readPersonal:async()=>({enabled:true,events:[]})});assert.ok(s.button('Remove an event'));
 await s.click('Remove an event');assert.ok(s.last('calendar-delete-search'));assert.ok(s.button('Cancel'));
});
test('same-title events retain dates and calendars and require choosing a specific result',async()=>{
 const s=await eventSetup();await handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent Studying'},1);
 const items=[{id:'a'.repeat(32),title:'Studying',start:s.event.start,end:s.event.end,calendarName:'School'},{id:'b'.repeat(32),title:'Studying',start:s.event.start,end:s.event.end,calendarName:'Personal'}];
 await s.run('calendar-delete-search',{list:async()=>({items,hasMore:false,notice:'Choose one.'})});
 assert.match(s.last('telegram-send').payload.text,/School[\s\S]*Personal/);assert.ok(s.button('Review 1 · Studying'));assert.ok(s.button('Review 2 · Studying'));
 assert.equal(s.last('calendar-delete'),undefined);await s.click('Review 2 · Studying');assert.deepEqual(s.last('calendar-delete-preview').payload.target,{candidateId:'b'.repeat(32)});
});
test('preview shows real date, calendar, and guest cancellation impact; confirm queues only once',async()=>{
 const s=await eventSetup();s.raw.attendees=[{email:'synthetic@example.test'}];await openPreview(s);
 const message=s.last('telegram-send').payload.text;assert.match(message,/Studying with Josh/);assert.match(message,/Calendar: Big Red Buddy/);assert.match(message,/notify invited guests/);
 assert.equal(s.last('calendar-delete'),undefined);assert.equal((await s.store.get('events','study')).status,'approved');
 const data=s.button('Delete this event').callback_data;await s.click('Delete this event');
 assert.equal(s.sent.filter(j=>j.type==='calendar-delete').length,1);const job=s.last('calendar-delete');assert.equal(job.options.retrySafe,false);assert.equal(job.options.maxAttempts,1);assert.equal(job.payload.binding.chatId,'101');
 assert.match(s.last('telegram-send').payload.text,/Removal queued/);assert.doesNotMatch(s.last('telegram-send').payload.text,/Deleted from/);
 await handleMenuCallback(null,s.store,s.queue,{data,message:{chat:{id:101,type:'private'}}},'repeat');assert.equal(s.sent.filter(j=>j.type==='calendar-delete').length,1);
 assert.doesNotMatch(JSON.stringify(s.sent),/SYNTHETIC_SECRET/);
});
test('Cancel invalidates the sibling delete button and preserves the event',async()=>{
 const s=await eventSetup();await openPreview(s);const data=s.button('Delete this event').callback_data,flow=await s.store.get('settings','calendarDeletionFlow');
 await s.click('Cancel');assert.equal((await s.store.get('calendarDeletionProposals',flow.proposalId)).status,'cancelled');
 await handleMenuCallback(null,s.store,s.queue,{data,message:{chat:{id:101}}},'late');assert.equal(s.last('calendar-delete'),undefined);assert.equal((await s.store.get('events','study')).status,'approved');
});
test('leaving the flow or opening a newer selection prevents old confirmations',async()=>{
 for(const leave of [async s=>showMenu(s.store,s.queue,'home',2),async s=>handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent another'},2)]){
  const s=await eventSetup();await openPreview(s);const data=s.button('Delete this event').callback_data;await leave(s);
  await handleMenuCallback(null,s.store,s.queue,{data,message:{chat:{id:101}}},3);assert.equal(s.last('calendar-delete'),undefined);
 }
});
test('expired, foreign-chat and relinked confirmations cannot queue deletions',async()=>{
 for(const scenario of ['expired','foreign','relinked']){
  const s=await eventSetup();await openPreview(s);const data=s.button('Delete this event').callback_data;
  if(scenario==='expired'){const f=await s.store.get('settings','calendarDeletionFlow');await s.store.put('settings','calendarDeletionFlow',{...f,expiresAt:0});}
  if(scenario==='relinked')await s.store.put('secrets','telegram',{chatId:101,linkedAt:'new-link'});
  await handleMenuCallback(null,s.store,s.queue,{data,message:{chat:{id:scenario==='foreign'?202:101}}},3);assert.equal(s.last('calendar-delete'),undefined);
 }
});
test('late search results and queued preview messages are suppressed after cancellation',async()=>{
 const s=setup();await handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent'},1);
 const job=s.last('calendar-delete-search');await s.click('Cancel');let called=false;
 await executeCalendarDeletionJob(s.store,s.queue,job.type,job.payload,{list:async()=>{called=true;return {items:[]};}});assert.equal(called,false);
 const original=s.sent[0];const result=await dispatchQueuedTelegram(s.store,original,{send:async()=>{throw Error('must not send cancelled flow');}});assert.equal(result.suppressed,true);
});
test('new search and cancel arriving while Google responds discard the old response',async()=>{
 const s=setup();await handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent old'},1);
 await s.run('calendar-delete-search',{list:async()=>{await handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent new'},2);return {items:[{id:'a'.repeat(32),title:'Old result'}]};}});
 assert.ok(!s.sent.some(j=>j.payload.text?.includes('Old result')));assert.equal((await s.store.get('settings','calendarDeletionFlow')).query,'new');
});
test('personal permissions link is exact and does not authorize automatically',async()=>{
 const s=setup();await handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent'},1);await s.run('calendar-delete-search',{list:async()=>({items:[],needsPermission:true})});
 assert.equal(s.button('Enable calendar editing').url,'https://app.synthetic.example/#calendar-edit');assert.equal(s.last('calendar-delete'),undefined);
 for(const job of s.sent.filter(j=>j.type==='telegram-send'))validateTelegramReplyMarkup(job.payload.replyMarkup);
});
test('provider-confirmed results are distinct from failures and retries create a fresh preview',async()=>{
 for(const status of ['deleted','already-deleted','local-only','uncertain','stale','reconnect','failed']){
  const s=setup(),payload={proposalId:'c'.repeat(32),revision:1,binding:{chatId:'101',linkedAt:'first-link'}};
  const result=await executeCalendarDeletionJob(s.store,s.queue,'calendar-delete',payload,{remove:async()=>({status,proposalId:payload.proposalId,title:'Study',message:status==='deleted'?'Deleted from Google Calendar.':`${status}: test provider result`})});
  assert.equal(result.status,status);assert.equal(!!s.button('Check event / Retry'),!['deleted','already-deleted','local-only'].includes(status));
  if(s.button('Check event / Retry')){await s.click('Check event / Retry');assert.deepEqual(s.last('calendar-delete-preview').payload.target,{retryProposalId:payload.proposalId});assert.equal(s.last('calendar-delete'),undefined);}
  for(const job of s.sent.filter(j=>j.type==='telegram-send'))validateTelegramReplyMarkup(job.payload.replyMarkup);
 }
});
test('revoked access, deletion of account, and relinked chat block jobs and completion messages',async()=>{
 for(const scenario of ['revoked','deleting','relinked']){
  const s=setup(),payload={proposalId:'c'.repeat(32),revision:1,binding:{chatId:'101',linkedAt:'first-link'}};
  if(scenario==='deleting')await s.store.put('settings','account',{deleting:true});
  if(scenario==='relinked')await s.store.put('secrets','telegram',{chatId:202,linkedAt:'second-link'});
  const r=await executeCalendarDeletionJob(s.store,s.queue,'calendar-delete',payload,{isAllowed:async()=>scenario!=='revoked',remove:async()=>{throw Error('must not mutate');}});assert.equal(r.skipped,true);assert.equal(s.sent.length,0);
 }
 const s=setup();await executeCalendarDeletionJob(s.store,s.queue,'calendar-delete',{proposalId:'c'.repeat(32),revision:1,binding:{chatId:'101',linkedAt:'first-link'}},{remove:async()=>{await s.store.put('secrets','telegram',{chatId:202,linkedAt:'second-link'});return {status:'deleted',message:'Deleted'};}});assert.equal(s.sent.length,0);
});
test('all-day ranges and recurring occurrence are legible and buttons stay valid',async()=>{
 const s=setup();await handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent'},1);
 await s.run('calendar-delete-search',{list:async()=>({items:[{id:'a'.repeat(32),title:'Holiday\n'.repeat(40),date:'2027-01-01',start:'2027-01-01',end:'2027-01-04',allDay:true,recurring:true,calendarName:'School'}]})});
 assert.match(s.last('telegram-send').payload.text,/2027-01-01 – 2027-01-03 · All day/);assert.match(s.last('telegram-send').payload.text,/One occurrence/);validateTelegramReplyMarkup(s.last('telegram-send').payload.replyMarkup);
});
test('deletion jobs are registered with the calendar worker and stale event actions cannot restore tombstones',async()=>{
 for(const type of ['calendar-delete','calendar-delete-search','calendar-delete-preview'])assert.ok(REMINDER_TYPES.includes(type));
 const {writeCalendarTombstones}=await import('../lib/calendar-mutations.mjs'),s=await eventSetup();
 await writeCalendarTombstones(s.store,{localId:'study'});await menuCard(s.store,s.queue,'Old card',[[['Add',{event:'study',operation:'add'}]]],'old');await s.click('Add');assert.equal(s.last('google-sync'),undefined);assert.match(s.last('telegram-send').payload.text,/was removed/);
});
test('search can use durable local candidates without modifying them',async()=>{
 const s=await eventSetup();await handleCalendarDeletionMessage(s.store,s.queue,{text:'/deleteevent Josh'},1);
 await s.run('calendar-delete-search',{list:listDeletionCandidates});assert.match(s.last('telegram-send').payload.text,/Studying with Josh/);assert.equal((await s.store.get('events','study')).status,'approved');assert.equal((await s.store.all('calendarDeletionTombstones')).length,0);
});
