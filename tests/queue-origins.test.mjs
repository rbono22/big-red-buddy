import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase,databaseInternals} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';

async function fixture(t){
  const dir=await mkdtemp(path.join(tmpdir(),'brf-draft-origins-'));
  const db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
  const queue=await createQueue(db,{workerDatabaseUrl:null});
  t.after(async()=>{await queue.close();await db.close();await rm(dir,{recursive:true,force:true});});
  return {db,queue,sql:databaseInternals(db).sqlite};
}

test('draft origins prove own Telegram request without exposing payload, result, or other tenants',async t=>{
  const {queue}=await fixture(t);
  const own=await queue.enqueue('student-a','draft',{id:'role-a',replyTo:'telegram',resume:'PRIVATE RESUME',extra:'PRIVATE MESSAGE'});
  await queue.enqueue('student-b','draft',{id:'role-b',replyTo:'telegram'});
  await queue.enqueue('student-a','draft',{id:'web-role',replyTo:'web'});
  await queue.enqueue('student-a','career-answer',{id:'answer-role',replyTo:'telegram'});
  const running=await queue.claim('history-test',{types:['draft'],concurrency:1});
  assert.equal(running.id,own.id);
  await queue.complete(running,{id:'application-a',private:'PRIVATE RESULT'});
  const origins=await queue.listDraftOrigins('student-a');
  assert.equal(origins.length,1);
  assert.deepEqual(Object.keys(origins[0]).sort(),['taskId','jobId','source','status','createdAt','startedAt','completedAt'].sort());
  assert.equal(origins[0].taskId,own.id);assert.equal(origins[0].jobId,'role-a');
  assert.equal(origins[0].source,'telegram');assert.equal(origins[0].status,'completed');
  assert.ok(Number.isFinite(origins[0].createdAt));assert.ok(Number.isFinite(origins[0].completedAt));
  assert.equal(JSON.stringify(origins).includes('PRIVATE'),false);
  assert.equal((await queue.listDraftOrigins('student-b'))[0].jobId,'role-b');
  assert.equal((await queue.list('student-a')).some(row=>'payload'in row),false);
  assert.equal('payload'in(await queue.get('student-a',own.id)),false);
});

test('draft origin lookup bounds examined rows and rejects malformed provenance',async t=>{
  const {queue,sql}=await fixture(t);
  const old=await queue.enqueue('student-a','draft',{id:'old-role',replyTo:'telegram'});
  sql.prepare('UPDATE jobs SET created_at=1 WHERE id=?').run(old.id);
  const invalid=[null,[],{id:123,replyTo:'telegram'},{id:'role\nsecret',replyTo:'telegram'},{id:'x'.repeat(201),replyTo:'telegram'},{id:'valid',replyTo:true}];
  for(const payload of invalid)await queue.enqueue('student-a','draft',payload);
  const newest=await queue.enqueue('student-a','draft',{id:'new-role',replyTo:'telegram'});
  sql.prepare('UPDATE jobs SET created_at=9999999999999 WHERE id=?').run(newest.id);
  assert.deepEqual((await queue.listDraftOrigins('student-a',{limit:1})).map(row=>row.jobId),['new-role']);
  assert.deepEqual((await queue.listDraftOrigins('student-a',{limit:500})).map(row=>row.jobId),['new-role','old-role']);
  for(const limit of [0,501,1.5,'100'])await assert.rejects(()=>queue.listDraftOrigins('student-a',{limit}),/Invalid queue option/);
  await assert.rejects(()=>queue.listDraftOrigins(''),/student ID/);
});

test('expired or deleted queue history cannot be presented as durable application evidence',async t=>{
  const {queue,sql}=await fixture(t);
  const old=await queue.enqueue('student-a','draft',{id:'expired-role',replyTo:'telegram'});
  sql.prepare('UPDATE jobs SET expires_at=0 WHERE id=?').run(old.id);
  assert.equal(await queue.claim('cleanup',{types:['draft']}),null);
  assert.deepEqual(await queue.listDraftOrigins('student-a'),[]);
  await queue.enqueue('student-a','draft',{id:'deleted-role',replyTo:'telegram'});
  await queue.cancelUser('student-a');
  assert.deepEqual(await queue.listDraftOrigins('student-a'),[]);
});
