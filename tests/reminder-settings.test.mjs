import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {readReminderSettings,saveReminderSettings,parseReminderCommand,DEFAULT_REMINDER_SETTINGS} from '../lib/reminder-settings.mjs';
import {reminderSpecs,calendarICS} from '../lib/domain.mjs';
import {reconcileReminders,dispatchReminders,syncGoogle} from '../lib/integrations.mjs';

const NOW=Date.parse('2026-11-10T18:00:00Z');
const event=(id='event',kind='class',start=NOW+2*86400000)=>({id,kind,title:'Test item',status:'approved',start:new Date(start).toISOString(),end:new Date(start+3600000).toISOString(),sourceName:'Test evidence',evidence:'Published schedule',location:'Tata L23'});
async function database(t){const dir=await mkdtemp(path.join(tmpdir(),'brf-reminders-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});return db;}
const futurePending=async store=>(await store.all('reminders')).filter(r=>r.status==='pending').map(r=>r.minutes).sort((a,b)=>b-a);

test('defaults cover classes, events and every deadline kind; approved timed events only',async t=>{
  const store=(await database(t)).forUser('defaults');
  assert.deepEqual(await readReminderSettings(store),{classes:[10],events:[10],deadlines:[1440,240],updatedAt:null});
  for(const kind of ['class','event','assignment','quiz','exam','studio'])assert.deepEqual(reminderSpecs(event('e',kind)).map(r=>r.minutes),['class','event'].includes(kind)?[10]:[1440,240]);
  for(const patch of [{status:'review'},{cancelled:true},{start:null}])assert.deepEqual(reminderSpecs({...event(),...patch}),[]);
});

test('student settings and pending reminders are isolated by the real tenant store',async t=>{
  const db=await database(t),a=db.forUser('a'),b=db.forUser('b');
  await a.put('events','same',event('same'));await b.put('events','same',event('same'));
  await saveReminderSettings(a,{classes:[15,60]},{now:()=>NOW});await saveReminderSettings(b,{classes:[5]},{now:()=>NOW});
  await reconcileReminders(a,{now:()=>NOW});await reconcileReminders(b,{now:()=>NOW});
  assert.deepEqual(await futurePending(a),[60,15]);assert.deepEqual(await futurePending(b),[5]);
  assert.deepEqual((await readReminderSettings(a)).events,[10]);
  await saveReminderSettings(a,{classes:[]});await reconcileReminders(a,{now:()=>NOW});
  assert.deepEqual(await futurePending(a),[]);assert.deepEqual(await futurePending(b),[5]);
});

test('validation rejects arbitrary settings, invalid units, excessive lists and unknown categories without writes',async t=>{
  const store=(await database(t)).forUser('invalid');
  const invalid=[null,[],{}, {model:'other'}, {classes:[0]}, {events:[40321]}, {deadlines:[1.5]}, {classes:['15']}, {events:null}, {classes:[1,2,3,4,5,6]},JSON.parse('{"__proto__":{"paused":false}}')];
  for(const patch of invalid)await assert.rejects(saveReminderSettings(store,patch),{status:400});
  assert.equal(await store.get('settings','reminders'),null);
  const saved=await saveReminderSettings(store,{classes:[15,15,60],events:[40320],deadlines:[]},{now:()=>NOW});
  assert.deepEqual(saved,{classes:[60,15],events:[40320],deadlines:[],updatedAt:new Date(NOW).toISOString()});
  assert.deepEqual(DEFAULT_REMINDER_SETTINGS,{classes:[10],events:[10],deadlines:[1440,240]});
});

test('concurrent category edits preserve both patches rather than overwriting a student preference',async t=>{
  const store=(await database(t)).forUser('concurrent');
  await Promise.all([saveReminderSettings(store,{classes:[20]}),saveReminderSettings(store,{deadlines:[120]})]);
  const saved=await readReminderSettings(store);assert.deepEqual(saved.classes,[20]);assert.deepEqual(saved.deadlines,[120]);assert.deepEqual(saved.events,[10]);
});

test('changing offsets cancels obsolete pending alerts and never adds pending alerts in the past',async t=>{
  const store=(await database(t)).forUser('changed'),e=event('deadline','assignment',NOW+6*3600000);
  await store.put('events',e.id,e);await reconcileReminders(store,{now:()=>NOW});
  assert.deepEqual(await futurePending(store),[240]);
  await saveReminderSettings(store,{deadlines:[1440,120]});await reconcileReminders(store,{now:()=>NOW});
  const rows=await store.all('reminders');assert.equal(rows.find(r=>r.minutes===240).status,'cancelled');assert.equal(rows.find(r=>r.minutes===1440).status,'historical');assert.deepEqual(await futurePending(store),[120]);
  await reconcileReminders(store,{now:()=>NOW});assert.equal((await store.all('reminders')).length,3);
});

test('turning alerts off and on cannot replay sent, uncertain or expired occurrences',async t=>{
  const store=(await database(t)).forUser('no-replay'),e=event('e','class',NOW+60*60000);
  await store.put('events',e.id,e);await saveReminderSettings(store,{classes:[40,30,20,10]});await reconcileReminders(store,{now:()=>NOW});
  for(const r of await store.all('reminders'))if([40,30].includes(r.minutes))await store.put('reminders',r.id,{...r,status:r.minutes===40?'sent':'needs-review',attempts:1});
  await saveReminderSettings(store,{classes:[]});await reconcileReminders(store,{now:()=>NOW});
  await saveReminderSettings(store,{classes:[40,30,20,10]});await reconcileReminders(store,{now:()=>NOW+45*60000});
  const rows=await store.all('reminders');assert.equal(rows.find(r=>r.minutes===40).status,'sent');assert.equal(rows.find(r=>r.minutes===30).status,'needs-review');assert.equal(rows.find(r=>r.minutes===20).status,'historical');assert.deepEqual(await futurePending(store),[10]);
});

test('ICS alarms share the configured category settings, including off',()=>{
  const events=[event('class','class'),event('network','event'),event('deadline','exam')];
  const ics=calendarICS(events,{classes:[15],events:[],deadlines:[1440,120]});
  assert.equal((ics.match(/BEGIN:VEVENT/g)||[]).length,3);assert.equal((ics.match(/BEGIN:VALARM/g)||[]).length,3);
  for(const minutes of [15,1440,120])assert.ok(ics.includes(`TRIGGER:-PT${minutes}M`));assert.equal(ics.includes('TRIGGER:-PT10M'),false);
  assert.equal(calendarICS(events,{classes:[],events:[],deadlines:[]}).includes('BEGIN:VALARM'),false);
});

test('Telegram command parsing is explicit, bounded and supports bot-qualified commands',()=>{
  assert.deepEqual(parseReminderCommand('/reminders'),{action:'show'});
  assert.deepEqual(parseReminderCommand('/reminders@brf_bot reset'),{action:'reset'});
  assert.deepEqual(parseReminderCommand('/reminders classes 15m'),{action:'update',patch:{classes:[15]}});
  assert.deepEqual(parseReminderCommand('/reminders deadlines 1d 2h'),{action:'update',patch:{deadlines:[1440,120]}});
  assert.deepEqual(parseReminderCommand('/reminders events off'),{action:'update',patch:{events:[]}});
  assert.deepEqual(parseReminderCommand('/reminders events 4w'),{action:'update',patch:{events:[40320]}});
  for(const command of ['/reminders all off','/reminders classes','/reminders classes 0m','/reminders events 5w','/reminders events 1.5h','/reminders classes off 10m','/reminders reset now','/reminders events 1m 2m 3m 4m 5m 6m'])assert.throws(()=>parseReminderCommand(command),{status:400});
  assert.equal(parseReminderCommand('please remind me earlier'),null);assert.equal(parseReminderCommand('/reminders-other'),null);
});

test('Google popups honor student settings, omit past offsets and keep eventIds scope',async t=>{
  const store=(await database(t)).forUser('google'),now=Date.now(),calls=[];
  for(const e of [event('chosen','class',now+3600000),event('other','class',now+3600000)])await store.put('events',e.id,e);
  await store.put('secrets','google',{refresh_token:'test-only',access_token:'test-only',expiresAt:now+3600000,calendarId:'test-calendar'});
  await saveReminderSettings(store,{classes:[1440,20]});
  const original=globalThis.fetch;globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({id:'remote',htmlLink:'https://calendar.google.com/'}),{headers:{'content-type':'application/json'}});};t.after(()=>{globalThis.fetch=original;});
  await syncGoogle(store,{eventIds:['chosen']});assert.equal(calls.length,1);assert.deepEqual(calls[0].body.reminders,{useDefault:false,overrides:[{method:'popup',minutes:20}]});assert.equal((await store.get('events','other')).googleId,undefined);
  await saveReminderSettings(store,{classes:[]});await syncGoogle(store,{eventIds:['chosen']});assert.deepEqual(calls[1].body.reminders,{useDefault:false,overrides:[]});
});

test('Telegram dispatch uses current preferences and never transmits disabled pending alerts',async t=>{
  const store=(await database(t)).forUser('telegram'),now=Date.now(),e=event('telegram-class','class',now+9*60000);
  await store.put('events',e.id,e);await store.put('secrets','telegram',{chatId:123});
  const originalFetch=globalThis.fetch,originalToken=process.env.TELEGRAM_BOT_TOKEN,calls=[];
  process.env.TELEGRAM_BOT_TOKEN='test-only';globalThis.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({ok:true,result:{message_id:1}}),{headers:{'content-type':'application/json'}});};t.after(()=>{globalThis.fetch=originalFetch;if(originalToken===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=originalToken;});
  const [defaultReminder]=reminderSpecs(e);await store.put('reminders',defaultReminder.id,{...defaultReminder,status:'pending',attempts:0});
  await saveReminderSettings(store,{classes:[]});assert.equal((await dispatchReminders(store)).sent,0);assert.equal(calls.length,0);
  await saveReminderSettings(store,{classes:[10]});assert.equal((await dispatchReminders(store)).sent,0);assert.equal(calls.length,0,'an expired offset is historical after re-enabling');
  await saveReminderSettings(store,{classes:[5]});await reconcileReminders(store);const [pending]=(await store.all('reminders')).filter(r=>r.status==='pending');
  // Simulate a previously scheduled reminder becoming due, without waiting four minutes.
  const dueEvent={...e,start:new Date(Date.now()+4*60000).toISOString()};await store.put('events',e.id,dueEvent);const [due]=reminderSpecs(dueEvent,{classes:[5]});await store.put('reminders',due.id,{...due,status:'pending',attempts:0});
  assert.equal((await dispatchReminders(store)).sent,1);assert.equal(calls.length,1);assert.equal(calls[0].chat_id,123);assert.equal((await dispatchReminders(store)).sent,0);assert.equal(calls.length,1);assert.ok(pending);
});
