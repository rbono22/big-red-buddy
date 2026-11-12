import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {handleCallbackQuery,handleMessage} from '../lib/telegram.mjs';
import {processInvitationUpload} from '../lib/invitation-telegram.mjs';
import {dispatchQueuedTelegram,validateTelegramReplyMarkup} from '../lib/telegram-delivery.mjs';
import {MODEL_TYPES,REMINDER_TYPES,DISCOVERY_TYPES,executeJob} from '../lib/job-handlers.mjs';
import {pilotSheetConfig} from '../lib/pilot-access.mjs';
import {calendarDescription} from '../lib/calendar-description.mjs';
import {aggregateEventHub} from '../lib/event-hub.mjs';
import {CALENDAR_SCOPE} from '../lib/auth.mjs';

// All files, users, credentials, OCR results, and Telegram delivery are synthetic.
// Tests cross the actual shared router and durable queue without contacting providers.
async function setup(t,queueOptions={}){
  const dir=await mkdtemp(path.join(tmpdir(),'brb-invitation-routing-'));
  const db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
  const queue=await createQueue(db,{workerDatabaseUrl:null,...queueOptions});
  t.after(async()=>{await queue.close();await db.close();await rm(dir,{recursive:true,force:true});});
  const a=db.forUser('alice'),b=db.forUser('bob'),jobs=new Map(),answers=[],enqueue=queue.enqueue.bind(queue);
  for(const [store,chatId]of [[a,101],[b,202]]){
    await store.put('secrets','telegram',{chatId,linkedAt:'original-link'});
    await db.system.put('telegramChats',createHash('sha256').update(String(chatId)).digest('hex'),{userId:store.userId});
  }
  queue.enqueue=async(...args)=>{
    const job=await enqueue(...args);
    if(!jobs.has(job.id))jobs.set(job.id,{id:job.id,userId:args[0],type:args[1],payload:structuredClone(args[2])});
    return job;
  };
  let sequence=100;
  const message=(body,updateId=sequence++)=>handleMessage(db,queue,{from:{id:101,is_bot:false},chat:{id:101,type:'private'},...body},updateId);
  const send=(text,id)=>message({text},id);
  const photo=(caption='',id)=>message({photo:[{file_id:'synthetic-small',width:80,height:80,file_size:100},{file_id:'synthetic-full',width:1000,height:1000,file_size:1000}],...(caption?{caption}:{})},id);
  const click=(data,overrides={},updateId=sequence++,instant=Date.now())=>handleCallbackQuery(db,queue,{id:`callback-${updateId}`,data,from:{id:101,is_bot:false},message:{message_id:72,chat:{id:101,type:'private'}},...overrides},updateId,{now:()=>instant,answer:async body=>{answers.push(body);return{ok:true};}});
  const rows=type=>[...jobs.values()].filter(job=>!type||job.type===type);
  const last=()=>rows('telegram-send').at(-1)?.payload;
  const button=(pattern,payload=last())=>{
    const found=payload?.replyMarkup?.inline_keyboard?.flat().find(item=>pattern.test(item.text));
    assert.ok(found,`Expected button ${pattern}, got ${JSON.stringify(payload?.replyMarkup)}`);
    return found.callback_data;
  };
  const fields={title:'Synthetic campus gathering',date:new Date(Date.now()+14*86400000).toISOString().slice(0,10),time:'19:00',location:'Tata L24',duration:60};
  const extract=async()=>({fields,rsvpUrl:'https://luma.com/synthetic-event',provider:'luma',sourceText:'Synthetic Luma invitation with event date and location.',warnings:[],method:'synthetic-ocr'});
  const process=async(options={})=>{
    const job=rows('telegram-invitation').at(-1);assert.ok(job,'Invitation processing job was queued');
    return processInvitationUpload(a,queue,{...job.payload,jobId:job.id},{download:async()=>Buffer.from('synthetic-image'),extract,now:Date.now,...options});
  };
  return{db,queue,a,b,rows,answers,message,send,photo,click,last,button,fields,extract,process,flow:()=>a.get('settings','invitationFlow')};
}

test('an uncaptioned screenshot asks its purpose and event selection queues only invitation extraction',async t=>{
  const s=await setup(t);await s.photo('',100);
  const chooser=s.last();
  for(const label of [/^Event invitation$/i,/^Class schedule$/i,/^Syllabus$/i])s.button(label,chooser);
  assert.equal(s.rows('telegram-invitation').length,0);assert.equal(s.rows('telegram-enrollment').length,0);assert.equal(s.rows('telegram-chat').length,0);
  assert.equal(chooser.expectedChatId,'101');assert.equal(chooser.expectedTelegramLinkedAt,'original-link');
  assert.doesNotThrow(()=>validateTelegramReplyMarkup(chooser.replyMarkup));
  const token=s.button(/^Event invitation$/i,chooser);assert.match(token,/^invite:[a-f0-9]{32}$/);
  await s.click(token,{},101);await s.click(token,{},101);await s.click(token,{},102);
  const uploads=s.rows('telegram-invitation');assert.equal(uploads.length,1);assert.equal(uploads[0].payload.fileId,'synthetic-full');
  assert.equal(uploads[0].payload.expectedChatId,'101');assert.equal(uploads[0].payload.expectedTelegramLinkedAt,'original-link');
  assert.equal(s.rows('telegram-enrollment').length,0);assert.equal(s.rows('google-sync').length,0);assert.deepEqual(await s.a.all('events'),[]);
});

test('the screenshot chooser preserves the explicit term for syllabus and class schedule work',async t=>{
  for(const [label,type]of [[/^Class schedule$/i,'telegram-enrollment'],[/^Syllabus$/i,'telegram-syllabus']])await t.test(type,async t=>{
    const s=await setup(t);await s.photo();await s.click(s.button(label));await s.click(s.button(/^Spring 2027$/i));
    assert.equal(s.rows(type).length,1);assert.equal(s.rows(type)[0].payload.term,'SP27');assert.equal(s.rows(type)[0].payload.fileId,'synthetic-full');
    assert.equal(s.rows('telegram-invitation').length,0);assert.equal(s.rows('telegram-chat').length,0);
  });
});

test('explicit invite commands and captions override existing upload windows without routing images to another document type',async t=>{
  for(const mode of ['syllabusUpload','careerUpload','enrollmentUpload'])await t.test(mode,async t=>{
    const s=await setup(t);await s.a.put('settings',mode,{term:'SP27',expiresAt:Date.now()+600000});
    await s.photo('/invite',200);await s.photo('/invite',200);
    assert.equal(s.rows('telegram-invitation').length,1);
    for(const type of ['telegram-syllabus','telegram-resume','telegram-enrollment','telegram-chat'])assert.equal(s.rows(type).length,0,type);
    assert.ok(!(await s.a.get('settings',mode))?.expiresAt,'The competing upload window is cleared');
  });
  await t.test('command then photo',async t=>{
    const s=await setup(t);await s.send('/invite');await s.photo();assert.equal(s.rows('telegram-invitation').length,1);
  });
});

test('explicit syllabus, enrollment, and resume commands take over an earlier invitation flow',async t=>{
  for(const [command,type,attachment]of [
    ['/syllabus SP27','telegram-syllabus',{photo:[{file_id:'synthetic-syllabus',width:100,height:100,file_size:1000}]}],
    ['/enrollment SP27','telegram-enrollment',{photo:[{file_id:'synthetic-schedule',width:100,height:100,file_size:1000}]}],
    ['/resume_upload','telegram-resume',{document:{file_id:'synthetic-resume',mime_type:'application/pdf',file_name:'Resume.pdf',file_size:1000}}]
  ])await t.test(command,async t=>{
    const s=await setup(t);await s.send('/invite');await s.send(command);await s.message(attachment);
    assert.equal(s.rows(type).length,1);assert.equal(s.rows('telegram-invitation').length,0);assert.equal(s.rows('telegram-chat').length,0);
    assert.ok(['cancelled','expired'].includes((await s.flow())?.status)||!(await s.flow()),'The earlier invitation cannot capture this upload');
  });
});

test('active document modes and explicit term captions are respected without an invitation chooser',async t=>{
  for(const [command,type]of [['/syllabus FA26','telegram-syllabus'],['/enrollment SP27','telegram-enrollment']])await t.test(command,async t=>{
    const s=await setup(t);await s.send(command);await s.photo();assert.equal(s.rows(type).length,1);assert.equal(s.rows('telegram-invitation').length,0);assert.equal(await s.flow(),null);
  });
  await t.test('term caption',async t=>{
    const s=await setup(t);await s.photo('My classes SP27');assert.equal(s.rows('telegram-enrollment').length,1);assert.equal(s.rows('telegram-enrollment')[0].payload.term,'SP27');assert.equal(s.rows('telegram-invitation').length,0);
  });
});

test('callback routing rejects groups, spoofed senders, bots, other students, relinks, expiry and deletion',async t=>{
  const s=await setup(t);await s.photo();const token=s.button(/^Event invitation$/i),initial=await s.flow();
  for(const overrides of [{from:{id:202}},{from:{id:101,is_bot:true}},{message:{chat:{id:101,type:'group'}}}])assert.equal(await s.click(token,overrides),false);
  await s.click(token,{from:{id:202},message:{chat:{id:202,type:'private'}}});
  assert.equal(s.rows('telegram-invitation').length,0);assert.deepEqual(await s.flow(),initial);assert.equal(await s.b.get('settings','invitationFlow'),null);
  await s.click(token,{},300,Date.now()+31*60000);assert.equal(s.rows('telegram-invitation').length,0);
  await s.photo();const fresh=s.button(/^Event invitation$/i);await s.a.put('secrets','telegram',{chatId:101,linkedAt:'replacement-link'});
  await s.click(fresh);assert.equal(s.rows('telegram-invitation').length,0);
  await s.photo();const final=s.button(/^Event invitation$/i);await s.a.put('settings','account',{deleting:true});
  assert.equal(await s.click(final),false);assert.equal(s.rows('telegram-invitation').length,0);
  assert.deepEqual(await s.a.all('events'),[]);assert.deepEqual(await s.b.all('events'),[]);
});

test('revoked pilot membership blocks invitation callbacks, new uploads, and queued worker execution',async t=>{
  const s=await setup(t);await s.photo();const token=s.button(/^Event invitation$/i);
  const previous={id:process.env.PILOT_SHEET_ID,owner:process.env.PILOT_SHEET_OWNER};
  t.after(()=>{for(const [name,value]of [['PILOT_SHEET_ID',previous.id],['PILOT_SHEET_OWNER',previous.owner]])value===undefined?delete process.env[name]:process.env[name]=value;});
  process.env.PILOT_SHEET_ID='synthetic_sheet_1234567890';process.env.PILOT_SHEET_OWNER='owner@cornell.edu';
  const config=pilotSheetConfig();await s.db.auth.put('pilot_access',`snapshot:${config.key}`,{syncedAt:Date.now(),approved:['owner@cornell.edu']});
  await s.db.auth.put('users','alice',{id:'alice',email:'alice@cornell.edu',provider:'google',hostedDomain:'cornell.edu'});
  assert.equal(await s.click(token),false);await s.photo('/invite');assert.equal(s.rows('telegram-invitation').length,0);
  assert.deepEqual(await executeJob(s.db,{id:'synthetic-revoked',userId:'alice',type:'telegram-invitation',payload:{fileId:'never-download'}}),{skipped:true,reason:'pilot_access_revoked'});
  assert.deepEqual(await s.a.all('events'),[]);
});

test('global confirmation creates one owned event and queues only its Google Calendar sync',async t=>{
  const s=await setup(t);await s.a.put('secrets','google',{refresh_token:'synthetic-token',scope:CALENDAR_SCOPE});await s.photo('/invite');await s.process();
  assert.deepEqual(await s.a.all('events'),[]);assert.equal(s.rows('google-sync').length,0);
  const review=s.last();assert.doesNotThrow(()=>validateTelegramReplyMarkup(review.replyMarkup));
  const confirm=s.button(/Add to Google Calendar/i,review);
  await s.click(confirm,{from:{id:202},message:{chat:{id:202,type:'private'}}});assert.deepEqual(await s.b.all('events'),[]);assert.deepEqual(await s.a.all('events'),[]);
  await s.click(confirm,{},500);await s.click(confirm,{},500);await s.click(confirm,{},501);
  const events=await s.a.all('events');assert.equal(events.length,1);assert.equal(events[0].title,s.fields.title);assert.equal(events[0].location,s.fields.location);assert.equal(events[0].status,'approved');
  const description=calendarDescription(events[0]);assert.match(description,/Register on Luma: https:\/\/luma\.com\/synthetic-event/);assert.match(description,/does not register you/);
  const hub=aggregateEventHub({events});assert.equal(hub.items[0].invitationProvider,'luma');assert.equal(hub.items[0].action.kind,'manual');assert.equal(hub.items[0].registrationUrl,'https://luma.com/synthetic-event');assert.deepEqual(hub.items[0].sourceLabels,['Telegram invitation']);
  const syncs=s.rows('google-sync');assert.equal(syncs.length,1);assert.deepEqual(syncs[0].payload.eventIds,[events[0].id]);
  assert.equal((await s.a.all('reminders')).filter(item=>item.status==='pending').length,1);
  assert.doesNotMatch(s.rows('telegram-send').map(row=>row.payload.text).join('\n'),/registered you|RSVP (?:confirmed|submitted)|Google Calendar event created/i);
});

test('optional demographic replies cannot become invitation fields or model questions',async t=>{
  const s=await setup(t);await s.photo('/invite');await s.process({extract:async()=>({...await s.extract(),fields:{...s.fields,location:null}})});
  const draft=await s.flow();await s.send('/demographics start');await s.send('2. Not a veteran');await s.send('PRIVATE_UNRECOGNIZED_DEMOGRAPHIC_ANSWER');
  assert.equal(s.rows('telegram-chat').length,0);assert.deepEqual(await s.flow(),draft);
  assert.ok(s.rows().every(row=>!JSON.stringify(row.payload).includes('PRIVATE_UNRECOGNIZED_DEMOGRAPHIC_ANSWER')));
  assert.deepEqual(await s.a.all('events'),[]);
});

test('queued invitation cards are fenced to the original chat and linked account revision',async t=>{
  const s=await setup(t);await s.photo();const payload=s.last(),calls=[];
  const send=async(...args)=>{calls.push(args);return{result:{message_id:1}};};
  await dispatchQueuedTelegram(s.a,{payload},{send});assert.equal(calls.length,1);
  await s.a.put('secrets','telegram',{chatId:101,linkedAt:'replacement-link'});
  assert.equal((await dispatchQueuedTelegram(s.a,{payload},{send})).suppressed,true);assert.equal(calls.length,1);
  await s.a.put('secrets','telegram',{chatId:303,linkedAt:'replacement-link'});
  assert.equal((await dispatchQueuedTelegram(s.a,{payload},{send})).suppressed,true);assert.equal(calls.length,1);
  for(const value of ['invite:short','invite:'+'x'.repeat(32),'invite:'+'a'.repeat(33),'invite:<script>'])assert.throws(()=>validateTelegramReplyMarkup({inline_keyboard:[[{text:'Event invitation',callback_data:value}]]}));
});

test('account deletion blocks photo ingestion before any fallback document handler runs',async t=>{
  const s=await setup(t);await s.a.put('settings','account',{deleting:true});
  await s.photo('/invite');await s.photo();
  assert.deepEqual(s.rows(),[]);assert.equal(await s.flow(),null);
});

test('queued older invitation menus do not replace the current review after processing or cancellation',async t=>{
  const s=await setup(t);await s.photo();const chooser=s.last();await s.click(s.button(/^Event invitation$/i,chooser));const processing=s.last();
  await s.process();const review=s.last(),calls=[],send=async(...args)=>{calls.push(args);return{result:{message_id:1}};};
  for(const payload of [chooser,processing])assert.equal((await dispatchQueuedTelegram(s.a,{payload},{send})).suppressed,true);
  assert.equal(calls.length,0);await dispatchQueuedTelegram(s.a,{payload:review},{send});assert.equal(calls.length,1);
  await s.send('/invite cancel');assert.equal((await dispatchQueuedTelegram(s.a,{payload:review},{send})).suppressed,true);assert.equal(calls.length,1);
  await dispatchQueuedTelegram(s.a,{payload:s.last()},{send});assert.equal(calls.length,2);
});

test('a full model queue can recover by resending the same invitation image after capacity frees',async t=>{
  const s=await setup(t,{maxPendingModelPerUser:1});await s.queue.enqueue('alice','telegram-chat',{question:'Synthetic existing work'});
  await s.photo('/invite');assert.equal(s.rows('telegram-invitation').length,0);assert.match(s.last().text,/queue is full|processing (?:queue|slot)/i);
  const prior=await s.queue.claim('synthetic-model-worker',{types:MODEL_TYPES});await s.queue.complete(prior,{complete:true});
  await s.photo('/invite');assert.equal(s.rows('telegram-invitation').length,1);assert.equal((await s.flow()).status,'processing');
  assert.equal(s.rows('telegram-enrollment').length,0);
});

test('a chooser tap when the model queue is full gives a useful reply without aborting the shared poller',async t=>{
  const s=await setup(t,{maxPendingModelPerUser:1});await s.queue.enqueue('alice','telegram-chat',{question:'Synthetic existing work'});
  await s.photo();const choice=s.button(/^Event invitation$/i);await s.click(choice);
  assert.equal(s.rows('telegram-invitation').length,0);assert.match(s.last().text,/queue is full|uploads to finish|processing queue|processing slot/i);
});

test('invitation extraction uses model capacity while reminder work keeps an independent lane',async t=>{
  const s=await setup(t,{maxPendingModelPerUser:1});
  assert.ok(MODEL_TYPES.includes('telegram-invitation'));assert.ok(!REMINDER_TYPES.includes('telegram-invitation'));assert.ok(!DISCOVERY_TYPES.includes('telegram-invitation'));
  await s.queue.enqueue('alice','telegram-invitation',{fileId:'synthetic-file'},{idempotencyKey:'invitation-one'});
  await assert.rejects(s.queue.enqueue('alice','telegram-chat',{question:'Another model task'}),/STUDENT_MODEL_QUEUE_FULL/);
  await assert.rejects(s.queue.enqueue('alice','telegram-invitation',{fileId:'synthetic-second'}),/STUDENT_MODEL_QUEUE_FULL/);
  await s.queue.enqueue('alice','reminders',{});const reminder=await s.queue.claim('synthetic-reminder-worker',{types:REMINDER_TYPES});assert.equal(reminder.type,'reminders');
  const model=await s.queue.claim('synthetic-model-worker',{types:MODEL_TYPES});assert.equal(model.type,'telegram-invitation');
  assert.equal(await s.queue.claim('synthetic-discovery-worker',{types:DISCOVERY_TYPES}),null);
});
