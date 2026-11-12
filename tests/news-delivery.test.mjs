import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {saveNotificationPreferences} from '../lib/notification-preferences.mjs';
import {queueNewsAlerts,dispatchNewsAlert,newsAlertText} from '../lib/news-delivery.mjs';
import {sendTelegram} from '../lib/integrations.mjs';
import {dispatchQueuedTelegram} from '../lib/telegram-delivery.mjs';

async function fixture(t){
 const dir=await mkdtemp(path.join(tmpdir(),'brf-news-delivery-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false}),store=db.forUser('news-student'),at=Date.now(),now=()=>at,calls=[],jobs=[];
 const savedFetch=globalThis.fetch,token=process.env.TELEGRAM_BOT_TOKEN;process.env.TELEGRAM_BOT_TOKEN='synthetic-news-token';
 globalThis.fetch=async(url,options)=>{assert.equal(String(url),'https://api.telegram.org/botsynthetic-news-token/sendMessage');calls.push(JSON.parse(options.body));return new Response(JSON.stringify({ok:true,result:{message_id:calls.length}}));};
 t.after(async()=>{globalThis.fetch=savedFetch;if(token===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=token;await db.close();await rm(dir,{recursive:true,force:true});});
 await store.put('secrets','telegram',{chatId:123});await store.put('settings','news',{sources:['wsj10point'],revision:'selected'});await saveNotificationPreferences(store,{topics:{news:'alerts'}});
 const summary={id:'a'.repeat(32),provider:'wsj10point',name:'WSJ · The 10-Point',subject:'Synthetic newsletter',date:new Date(at).toISOString().slice(0,10),receivedAt:new Date(at-60000).toISOString(),createdAt:new Date(at).toISOString(),bullets:[{text:'Businesses are taking a cautious approach as demand remains uncertain.',url:'https://www.wsj.com/business/companies/story?tracking=private'}],source:{kind:'gmail',dateKind:'mailbox-received'},wordCount:12};
 await store.put('newsSummaries',summary.id,summary);
 const queue={async enqueue(userId,type,payload,options){let job=jobs.find(j=>j.options.idempotencyKey===options.idempotencyKey);if(!job){job={id:`job-${jobs.length}`,userId,type,payload,options};jobs.push(job);}return job;}};
 return {db,store,at,now,calls,jobs,queue,summary};
}

test('news alert queue requires selected publisher and alert opt-in and deduplicates across repeat syncs',async t=>{
 const {store,queue,jobs,now}=await fixture(t);await saveNotificationPreferences(store,{topics:{news:'daily'}});assert.equal((await queueNewsAlerts(store,queue,{now})).queued,0);
 await saveNotificationPreferences(store,{topics:{news:'both'}});assert.equal((await queueNewsAlerts(store,queue,{now})).queued,1);assert.equal((await queueNewsAlerts(store,queue,{now})).queued,0);
 assert.equal(jobs.length,1);assert.equal(jobs[0].userId,'news-student');assert.equal(jobs[0].type,'telegram-news-alert');assert.deepEqual(Object.keys(jobs[0].payload),['id']);assert.equal(jobs[0].options.retrySafe,false);assert.equal(jobs[0].options.maxAttempts,1);
 await store.put('settings','news',{sources:[],revision:'withdrawn'});assert.equal((await queueNewsAlerts(store,queue,{now})).queued,0);
});
test('source deselection, topic mute, and global pause suppress an already queued newsletter',async t=>{
 const {store,summary,now,calls}=await fixture(t);await saveNotificationPreferences(store,{topics:{news:'off'}});assert.equal((await dispatchNewsAlert(store,{id:summary.id},{now})).suppressed,true);
 await saveNotificationPreferences(store,{topics:{news:'alerts'}});await store.put('settings','profile',{paused:true});assert.equal((await dispatchNewsAlert(store,{id:summary.id},{now})).suppressed,true);
 await store.put('settings','profile',{paused:false});await store.put('settings','news',{sources:[],revision:'withdrawn'});assert.equal((await dispatchNewsAlert(store,{id:summary.id},{now})).accepted,false);assert.equal(calls.length,0);
});
test('source change after summary retrieval is caught by the shared delivery guard',async t=>{
 const {store,summary,now,calls}=await fixture(t);
 for(const trigger of ['telegram','profile','notifications']){
  await store.put('settings','news',{sources:['wsj10point'],revision:'selected'});
  const changing={...store,get:async(bucket,id)=>{const value=await store.get(bucket,id);if(id===trigger)await store.put('settings','news',{sources:[],revision:'withdrawn-after-read'});return value;}};
  const result=await dispatchNewsAlert(changing,{id:summary.id},{now,send:sendTelegram});assert.equal(result.suppressed,true);assert.equal(result.reason,'news-sources-changed');assert.equal(calls.length,0);
 }
});
test('undated manual imports and known old editions are never announced as fresh news',async t=>{
 const {store,queue,summary,now,at,calls}=await fixture(t);
 for(const date of [null,new Date(at-7*86400000).toISOString().slice(0,10)]){await store.put('newsSummaries',summary.id,{...summary,receivedAt:null,date,source:{kind:'manual',dateKind:date?'email-header-unverified':'not-provided'}});assert.equal((await queueNewsAlerts(store,queue,{now})).queued,0);assert.equal((await dispatchNewsAlert(store,{id:summary.id},{now})).accepted,false);}
 assert.equal(calls.length,0);
});
test('news delivery remains private to the student and strips tracking links',async t=>{
 const {db,store,summary,now,calls}=await fixture(t),other=db.forUser('other-student');await other.put('secrets','telegram',{chatId:456});await saveNotificationPreferences(other,{topics:{news:'both'}});await other.put('settings','news',{sources:['wsj10point'],revision:'other-selected'});
 assert.equal((await dispatchNewsAlert(other,{id:summary.id},{now})).accepted,false);assert.equal((await dispatchNewsAlert(store,{id:summary.id},{now})).accepted,true);assert.equal(calls.length,1);assert.equal(calls[0].chat_id,123);assert.doesNotMatch(calls[0].text,/tracking=|private\?/);assert.match(calls[0].text,/https:\/\/www\.wsj\.com\/business\/companies\/story/);
 const text=newsAlertText({...summary,bullets:[{text:'A supported summary without a direct article URL.',url:'https://attacker.test/redirect'}]});assert.match(text,/supported summary/);assert.doesNotMatch(text,/attacker/);
});
test('unconfirmed Telegram results cannot be reported as accepted and must not be blindly retried',async t=>{
 const {store,summary,now}=await fixture(t);await assert.rejects(dispatchNewsAlert(store,{id:summary.id},{now,send:async()=>({ok:true})}),/unconfirmed/);await assert.rejects(dispatchQueuedTelegram(store,{payload:{text:'Explicit reply'}},{send:async()=>({ok:true})}),/unconfirmed/);
});
