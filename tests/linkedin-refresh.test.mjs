import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {importLinkedInConnections,saveLinkedInConnectionSettings,deleteLinkedInConnections} from '../lib/linkedin-connections.mjs';
import {saveNotificationPreferences} from '../lib/notification-preferences.mjs';
import {scheduleLinkedInRefresh,dispatchLinkedInRefresh} from '../lib/linkedin-refresh.mjs';
const NOW=Date.parse('2026-11-10T18:00:00Z'),DAY=86400000,csv='First Name,Last Name,URL,Company,Position,Connected On\nAlex,Example,https://www.linkedin.com/in/alex,Example,Manager,2025-01-01\n';
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'brf-linkedin-refresh-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false}),store=db.forUser('student'),queue=await createQueue(db);t.after(async()=>{await queue.close();await db.close();await rm(dir,{recursive:true,force:true});});await store.put('secrets','telegram',{chatId:123});await saveNotificationPreferences(store,{topics:{jobs:'alerts'}});await importLinkedInConnections(store,{csv},{now:NOW});return {db,store,queue};}
test('refresh reminders default off, respect job-alert preferences and repeat only once per selected period',async t=>{
 const {store,queue}=await fixture(t);assert.equal((await scheduleLinkedInRefresh(store,queue,{now:NOW+15*DAY})).scheduled,false);await saveLinkedInConnectionSettings(store,{refreshDays:7},{now:NOW});assert.equal((await scheduleLinkedInRefresh(store,queue,{now:NOW+6*DAY})).scheduled,false);await saveNotificationPreferences(store,{topics:{jobs:'daily'}});assert.equal((await scheduleLinkedInRefresh(store,queue,{now:NOW+7*DAY})).reason,'delivery-disabled');await saveNotificationPreferences(store,{topics:{jobs:'alerts'}});
 const results=await Promise.all([scheduleLinkedInRefresh(store,queue,{now:NOW+7*DAY}),scheduleLinkedInRefresh(store,queue,{now:NOW+7*DAY})]);assert.ok(results.some(r=>r.scheduled));assert.equal((await queue.list(store.userId)).length,1);
 const job=await queue.claim('fixture',{types:['linkedin-refresh-reminder']});let calls=0;const result=await dispatchLinkedInRefresh(store,job.payload,{now:NOW+7*DAY,send:async()=>{calls++;return {result:{message_id:1}};}});assert.equal(result.sent,true);assert.equal(calls,1);assert.equal((await scheduleLinkedInRefresh(store,queue,{now:NOW+13*DAY})).scheduled,false);assert.equal((await scheduleLinkedInRefresh(store,queue,{now:NOW+14*DAY})).scheduled,true);
});
test('replacement, deletion and uncertain delivery invalidate pending refreshes without automatic retries',async t=>{
 const {store,queue}=await fixture(t);await saveLinkedInConnectionSettings(store,{refreshDays:14},{now:NOW});await scheduleLinkedInRefresh(store,queue,{now:NOW+14*DAY});const job=await queue.claim('fixture',{types:['linkedin-refresh-reminder']});await importLinkedInConnections(store,{csv},{now:NOW+14*DAY});let calls=0;assert.equal((await dispatchLinkedInRefresh(store,job.payload,{now:NOW+14*DAY,send:async()=>{calls++;}})).sent,false);
 await scheduleLinkedInRefresh(store,queue,{now:NOW+28*DAY});const second=await queue.claim('fixture2',{types:['linkedin-refresh-reminder']});assert.ok(second);const uncertain=await dispatchLinkedInRefresh(store,second.payload,{now:NOW+28*DAY,send:async()=>{calls++;throw new Error('uncertain');}});assert.equal(uncertain.reason,'delivery-uncertain');assert.equal((await scheduleLinkedInRefresh(store,queue,{now:NOW+29*DAY})).scheduled,false);await deleteLinkedInConnections(store,{now:NOW+29*DAY});assert.equal((await scheduleLinkedInRefresh(store,queue,{now:NOW+45*DAY})).scheduled,false);assert.equal(calls,1);
});

for(const days of [30,90]){
 test(`${days}-day reminders wait for the exact boundary and send once per repeat period`,async t=>{
  const {db,store,queue}=await fixture(t),due=NOW+days*DAY;
  await saveLinkedInConnectionSettings(store,{refreshDays:days},{now:NOW});
  assert.equal((await scheduleLinkedInRefresh(store,queue,{now:due-1})).reason,'not-due');
  const scheduled=await Promise.all([scheduleLinkedInRefresh(store,queue,{now:due}),scheduleLinkedInRefresh(store,queue,{now:due})]);
  assert.ok(scheduled.some(result=>result.scheduled));assert.equal((await queue.list(store.userId)).length,1);
  const first=await queue.claim('fixture',{types:['linkedin-refresh-reminder']});assert.ok(first);
  assert.doesNotMatch(JSON.stringify(first.payload),/Alex|Example|linkedin\.com\/in|Connections\.csv/);
  let calls=0;const send=async()=>{calls++;return {result:{message_id:calls}};};
  assert.equal((await dispatchLinkedInRefresh(db.forUser('other'),first.payload,{now:due,send})).sent,false);
  assert.equal((await dispatchLinkedInRefresh(store,first.payload,{now:due,send})).sent,true);
  assert.equal((await dispatchLinkedInRefresh(store,first.payload,{now:due,send})).sent,false);
  const repeat=due+days*DAY;
  assert.equal((await scheduleLinkedInRefresh(store,queue,{now:repeat-1})).reason,'already-handled');
  assert.equal((await scheduleLinkedInRefresh(store,queue,{now:repeat})).scheduled,true);
  const second=await queue.claim('fixture-repeat',{types:['linkedin-refresh-reminder']});assert.ok(second);
  assert.notEqual(second.payload.key,first.payload.key);
  assert.equal((await dispatchLinkedInRefresh(store,first.payload,{now:repeat,send})).sent,false);
  assert.equal((await dispatchLinkedInRefresh(store,second.payload,{now:repeat,send})).sent,true);
  assert.equal((await scheduleLinkedInRefresh(store,queue,{now:repeat+1})).reason,'already-handled');
  assert.equal(calls,2);
 });

 test(`changing to ${days}-day reminders invalidates an older queued reminder and waits for the new period`,async t=>{
  const {store,queue}=await fixture(t);
  await saveLinkedInConnectionSettings(store,{refreshDays:14},{now:NOW});
  await scheduleLinkedInRefresh(store,queue,{now:NOW+14*DAY});
  const old=await queue.claim('fixture-old',{types:['linkedin-refresh-reminder']});assert.ok(old);
  const changed=await saveLinkedInConnectionSettings(store,{refreshDays:days},{now:NOW+14*DAY});
  assert.equal(changed.sourceVersion,old.payload.sourceVersion);assert.notEqual(changed.version,old.payload.version);
  let calls=0;const send=async()=>{calls++;return {result:{message_id:calls}};};
  assert.equal((await dispatchLinkedInRefresh(store,old.payload,{now:NOW+14*DAY,send})).sent,false);
  const due=NOW+days*DAY;
  assert.equal((await scheduleLinkedInRefresh(store,queue,{now:due-1})).reason,'not-due');
  assert.equal((await dispatchLinkedInRefresh(store,old.payload,{now:due,send})).sent,false);
  assert.equal((await scheduleLinkedInRefresh(store,queue,{now:due})).scheduled,true);
  const current=await queue.claim('fixture-current',{types:['linkedin-refresh-reminder']});assert.ok(current);
  assert.equal((await dispatchLinkedInRefresh(store,current.payload,{now:due,send})).sent,true);
  await saveLinkedInConnectionSettings(store,{refreshDays:null},{now:due});
  assert.equal((await scheduleLinkedInRefresh(store,queue,{now:due+days*DAY})).scheduled,false);
  assert.equal(calls,1);
 });
}
