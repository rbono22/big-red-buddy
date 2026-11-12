import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {sendTelegram,dispatchReminders} from '../lib/integrations.mjs';
import {saveNotificationPreferences,readNotificationPreferences} from '../lib/notification-preferences.mjs';
import {dispatchQueuedTelegram,queuedNotification} from '../lib/telegram-delivery.mjs';
import {reminderSpecs} from '../lib/domain.mjs';

async function fixture(t){
 const dir=await mkdtemp(path.join(tmpdir(),'brf-delivery-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false}),store=db.forUser('student'),calls=[],originalFetch=globalThis.fetch,token=process.env.TELEGRAM_BOT_TOKEN;
 process.env.TELEGRAM_BOT_TOKEN='synthetic-token';globalThis.fetch=async(url,options)=>{assert.match(String(url),/^https:\/\/api\.telegram\.org\/botsynthetic-token\/sendMessage$/);calls.push(JSON.parse(options.body));return new Response(JSON.stringify({ok:true,result:{message_id:calls.length}}),{status:200});};
 await store.put('secrets','telegram',{chatId:123});
 t.after(async()=>{globalThis.fetch=originalFetch;if(token===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=token;await db.close();await rm(dir,{recursive:true,force:true});});return {db,store,calls};
}
test('daily-only topics suppress separate alerts; explicit replies still work while proactive delivery is off',async t=>{
 const {store,calls}=await fixture(t);await saveNotificationPreferences(store,{topics:{jobs:'daily',school:'alerts',games:'both'}});
 assert.equal((await sendTelegram(store,'Job alert',{notification:{channel:'alerts',topic:'jobs'}})).suppressed,true);
 assert.equal((await sendTelegram(store,'Future game',{notification:{channel:'alerts',topic:'games'}})).suppressed,true);
 await sendTelegram(store,'Class soon',{notification:{channel:'alerts',topic:'school'}});assert.equal(calls.length,1);
 await saveNotificationPreferences(store,{enabled:false});assert.equal((await sendTelegram(store,'Muted class',{notification:{channel:'alerts',topic:'school'}})).suppressed,true);
 await sendTelegram(store,'Your requested settings');assert.equal(calls.length,2);assert.equal(calls[1].text,'Your requested settings');
});
test('old queued job and Slack alerts respect current settings before transmitting',async t=>{
 const {store,calls}=await fixture(t);await saveNotificationPreferences(store,{topics:{jobs:'off',school:'daily'}});
 for(const key of ['job-discovery:old-batch:0','slack:source:hash']){const result=await dispatchQueuedTelegram(store,{idempotencyKey:key,payload:{text:'Old queued alert'}},{send:sendTelegram});assert.equal(result.suppressed,true);assert.equal(result.accepted,false);}
 assert.equal(calls.length,0);assert.equal(queuedNotification({payload:{text:'Reply'}}),undefined);
 await dispatchQueuedTelegram(store,{idempotencyKey:'career-reply:123',payload:{text:'Requested application answer'}},{send:sendTelegram});assert.equal(calls.length,1);
});
test('delivery rechecks after reading credentials and rejects stale briefing versions',async t=>{
 const {store,calls}=await fixture(t);const before=await saveNotificationPreferences(store,{topics:{school:'both'}});
 const changing={...store,get:async(bucket,id)=>{const value=await store.get(bucket,id);if(bucket==='secrets'&&id==='telegram')await saveNotificationPreferences(store,{topics:{school:'off'}});return value;}};
 assert.equal((await sendTelegram(changing,'Unwanted school message',{notification:{channel:'alerts',topic:'school'}})).suppressed,true);
 assert.equal((await sendTelegram(store,'Old briefing',{notification:{channel:'daily',topics:['school'],revision:before.revision}})).suppressed,true);assert.equal(calls.length,0);
 const current=await saveNotificationPreferences(store,{topics:{school:'daily'}});await sendTelegram(store,'Current briefing',{notification:{channel:'daily',topics:['school'],revision:current.revision}});assert.equal(calls.length,1);
});
test('school and event reminders are independent; muted due reminders stay suppressed without catch-up spam',async t=>{
 const {store,calls}=await fixture(t);await saveNotificationPreferences(store,{topics:{school:'alerts',events:'off'}});
 const at=Date.now();for(const kind of ['class','event']){const row={id:kind,title:`Synthetic ${kind}`,kind,status:'approved',start:new Date(at+5*60000).toISOString(),end:new Date(at+65*60000).toISOString(),date:new Date(at).toISOString().slice(0,10),sourceName:'Synthetic source'};await store.put('events',row.id,row);for(const reminder of reminderSpecs(row))await store.put('reminders',reminder.id,{...reminder,status:'pending',attempts:0});}
 const result=await dispatchReminders(store);assert.equal(result.sent,1);assert.match(calls[0].text,/Synthetic class/);assert.equal((await store.all('reminders')).find(r=>r.eventId==='event').status,'suppressed');
 await saveNotificationPreferences(store,{topics:{events:'both'}});await dispatchReminders(store);assert.equal(calls.length,1);
});
test('proactive preference checks remain scoped to the destination student',async t=>{
 const {db,store,calls}=await fixture(t),other=db.forUser('other');await other.put('secrets','telegram',{chatId:456});await saveNotificationPreferences(store,{enabled:false});await saveNotificationPreferences(other,{topics:{news:'alerts'}});
 assert.equal((await sendTelegram(store,'Private newsletter',{notification:{channel:'alerts',topic:'news',newsSourceRevision:null}})).suppressed,true);await sendTelegram(other,'Other private newsletter',{notification:{channel:'alerts',topic:'news',newsSourceRevision:null}});assert.equal(calls.length,1);assert.equal(calls[0].chat_id,456);assert.equal((await readNotificationPreferences(store)).enabled,false);
});
test('requested daily preview works with master off but still requires current topic and source revisions',async t=>{
 const {store,calls}=await fixture(t);const prefs=await saveNotificationPreferences(store,{enabled:false,topics:{news:'daily'}});await store.put('settings','news',{sources:['wsj10point'],revision:'current'});
 const metadata={channel:'requested-daily',topics:['news'],revision:prefs.revision,newsSourceRevision:'current'};
 await sendTelegram(store,'Requested private news',{notification:metadata});assert.equal(calls.length,1);
 await store.put('settings','news',{sources:[],revision:'withdrawn'});const blocked=await sendTelegram(store,'Stale private news',{notification:metadata});assert.equal(blocked.suppressed,true);assert.equal(blocked.reason,'news-sources-changed');assert.equal(calls.length,1);
});
