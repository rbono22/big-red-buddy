import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase,databaseInternals} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {executeJob} from '../lib/job-handlers.mjs';
import {normalizeEvent} from '../lib/domain.mjs';
import {ASSISTANT_REPLIES_BUCKET,prepareAssistantDelivery,pruneAssistantReplies} from '../lib/assistant-delivery.mjs';
import {dispatchQueuedTelegram} from '../lib/telegram-delivery.mjs';

async function fixture(t){
  const dir=await mkdtemp(path.join(tmpdir(),'brb-assistant-delivery-'));
  const db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
  const queue=await createQueue(db,{workerDatabaseUrl:null});
  t.after(async()=>{await queue.close();await db.close();await rm(dir,{recursive:true,force:true});});
  const store=db.forUser('student-a');await store.put('secrets','telegram',{chatId:'1001',linkedAt:'initial-link'});
  return {db,store,queue,sql:databaseInternals(db).sqlite};
}

test('real telegram-chat handler retries partially queued answer without omissions, regeneration or duplicate parts',async t=>{
  const {db,store,queue,sql}=await fixture(t);
  for(let i=0;i<41;i++)await store.put('events',`deadline-${i}`,normalizeEvent({id:`deadline-${i}`,title:`Synthetic deadline ${String(i).padStart(2,'0')}`,date:'2026-11-21',kind:'assignment',sourceName:'Canvas synthetic regression fixture',evidence:'Only synthetic test content.'}));
  const job={id:'chat-parent',userId:store.userId,type:'telegram-chat',payload:{question:'What is due 2026-11-20 through 2026-12-04?'},expiresAt:Date.now()+86400000};
  // Leave room for two parts, then force the real queue's admission failure.
  for(let i=0;i<118;i++)await queue.enqueue(store.userId,'reminders',{},{idempotencyKey:`filler:${i}`});
  await assert.rejects(()=>executeJob(db,job),/STUDENT_QUEUE_FULL/);
  const snapshot=await store.get(ASSISTANT_REPLIES_BUCKET,job.id);
  assert.ok(snapshot.parts.length>2);assert.ok(snapshot.parts.every(p=>p.length<=3900));
  assert.equal(sql.prepare("SELECT count(*) AS n FROM jobs WHERE type='telegram-send'").get().n,2);
  // Simulate new imports between attempts: subsequent parts must remain from
  // the same original response whose first two parts are already enqueued.
  await store.clear('events');
  await store.put('events','changed',normalizeEvent({id:'changed',title:'CHANGED_AFTER_FIRST_ATTEMPT',date:'2026-11-21',kind:'assignment'}));
  sql.prepare("DELETE FROM jobs WHERE type='reminders'").run();
  assert.deepEqual(await executeJob(db,job),{prepared:true});
  assert.deepEqual(await executeJob(db,job),{prepared:true});
  assert.equal(sql.prepare("SELECT count(*) AS n FROM jobs WHERE type='telegram-send'").get().n,snapshot.parts.length);
  const received=[];
  for(let i=0;i<snapshot.parts.length;i++){
    const part=await queue.claim('reply-test',{types:['telegram-send']});
    assert.equal(part.userId,store.userId);assert.equal(part.retrySafe,false);assert.equal(part.maxAttempts,1);
    assert.equal(part.payload.expectedChatId,'1001');assert.equal(part.payload.expectedTelegramLinkedAt,'initial-link');
    assert.ok(part.expiresAt<=job.expiresAt+1000);
    received.push(part.payload.text);await queue.complete(part,{accepted:true});
  }
  assert.deepEqual(received,snapshot.parts);
  const full=received.join('\n');for(let i=0;i<41;i++)assert.ok(full.includes(`Synthetic deadline ${String(i).padStart(2,'0')}`));
  assert.doesNotMatch(full,/CHANGED_AFTER_FIRST_ATTEMPT/);
  assert.equal(await db.forUser('student-b').get(ASSISTANT_REPLIES_BUCKET,job.id),null);
});

test('reply snapshots expire, disappear on account deletion, and never move to a relinked chat',async t=>{
  const {db,store,sql}=await fixture(t),at=Date.now();
  let generated=0;
  const job={id:'snapshot-test',expiresAt:at+86400000};
  const snapshot=await prepareAssistantDelivery(store,job,async()=>{generated++;return 'Private synthetic answer';},{now:at});
  assert.equal(snapshot.expiresAt,at+86400000);
  await prepareAssistantDelivery(store,job,async()=>{throw new Error('Must reuse snapshot');},{now:at+1});assert.equal(generated,1);
  await store.put('secrets','telegram',{chatId:'2002',linkedAt:'new-link'});
  assert.equal(await prepareAssistantDelivery(store,job,async()=>{throw new Error('Must not regenerate after relink');},{now:at+2}),null);
  const suppressed=await dispatchQueuedTelegram(store,{payload:{text:snapshot.parts[0],expectedChatId:snapshot.expectedChatId,expectedTelegramLinkedAt:snapshot.expectedTelegramLinkedAt}},{send:async()=>{throw new Error('Must not deliver to changed chat');}});
  assert.equal(suppressed.reason,'telegram-link-changed');
  await assert.rejects(()=>prepareAssistantDelivery(store,job,async()=>'',{now:at+86400000}),/EXPIRED/);
  assert.equal(await pruneAssistantReplies(store,{now:at+86400000}),1);
  assert.equal(await store.get(ASSISTANT_REPLIES_BUCKET,job.id),null);
  await prepareAssistantDelivery(store,{id:'delete-test',expiresAt:at+86400000},async()=>'Delete this with account',{now:at});
  assert.equal(sql.prepare('SELECT count(*) AS n FROM records WHERE bucket=?').get(ASSISTANT_REPLIES_BUCKET).n,1);
  await db.deleteStudent(store.userId);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM records WHERE bucket=?').get(ASSISTANT_REPLIES_BUCKET).n,0);
});
