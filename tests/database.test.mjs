import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase,databaseInternals,postgresPoolOptions} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';

async function local(t){const dir=await mkdtemp(path.join(tmpdir(),'dabas-storage-'));const db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});return {db,dir};}

test('tenant ownership, encrypted payloads, bounded reads and ciphertext swap resistance',async t=>{
 const {db,dir}=await local(t),a=db.forUser('student-a'),b=db.forUser('student-b');
 await a.put('resumes','same',{text:'private resume A'});await b.put('resumes','same',{text:'private resume B'});
 assert.equal((await a.get('resumes','same')).text,'private resume A');assert.equal((await b.get('resumes','same')).text,'private resume B');
 await a.delete('resumes','same');assert.equal(await a.get('resumes','same'),null);assert.equal((await b.all('resumes')).length,1);
 await assert.rejects(()=>a.all('resumes',{limit:100000}),/bounded/);assert.throws(()=>db.forUser(''),/student ID/);
 const raw=databaseInternals(db).sqlite.prepare('SELECT payload FROM records WHERE user_id=?').get('student-b').payload;
 assert.ok(!raw.includes('private resume'));databaseInternals(db).sqlite.prepare('INSERT INTO records VALUES(?,?,?,?)').run('student-a','resumes','same',raw);
 await assert.rejects(()=>a.get('resumes','same'));
 const file=await readFile(path.join(dir,'tenant.sqlite'));assert.equal(file.includes(Buffer.from('private resume B')),false);
});

test('atomic OAuth take, identity creation, and compare-and-set have one winner',async t=>{
 const {db}=await local(t);await db.auth.put('oauth_states','hash',{redirect:'safe'});
 const states=await Promise.all([db.auth.take('oauth_states','hash'),db.auth.take('oauth_states','hash')]);assert.equal(states.filter(Boolean).length,1);
 const identities=await Promise.all([db.auth.putIfAbsent('users','a',{name:'first'}),db.auth.putIfAbsent('users','a',{name:'second'})]);assert.deepEqual(identities[0],identities[1]);assert.deepEqual(await db.listUserIds(),['a']);
 const outcomes=await Promise.all([db.forUser('a').compareAndSet('reminders','x',null,{sent:true}),db.forUser('a').compareAndSet('reminders','x',null,{sent:true})]);assert.equal(outcomes.filter(Boolean).length,1);
 for(const id of ['a','b','c'])await db.auth.put('expired_states',id,{id});const first=await db.auth.allEntries('expired_states',{limit:2});assert.deepEqual(first.map(row=>row.id),['a','b']);await db.auth.delete('expired_states','a');assert.deepEqual((await db.auth.allEntries('expired_states',{after:first.at(-1).id,limit:2})).map(row=>row.id),['c']);
});

test('durable queue isolates users, deduplicates per student and limits global generation independently of reminders',async t=>{
 const {db}=await local(t),q=await createQueue(db,{concurrency:1});
 const a=await q.enqueue('a','chat',{text:'secret-a'},{idempotencyKey:'same'});assert.equal((await q.enqueue('a','chat',{text:'different'},{idempotencyKey:'same'})).id,a.id);
 const b=await q.enqueue('b','chat',{text:'secret-b'},{idempotencyKey:'same'});assert.notEqual(a.id,b.id);assert.equal(await q.get('b',a.id),null);
 await q.enqueue('a','reminders',{});
 const claims=await Promise.all([q.claim('w1',{types:['chat']}),q.claim('w2',{types:['chat']})]);assert.equal(claims.filter(Boolean).length,1);
 const reminder=await q.claim('reminders',{types:['reminders'],concurrency:2});assert.equal(reminder.type,'reminders');
 const active=claims.find(Boolean);await q.complete(active,{answer:'temporary answer'});assert.equal((await q.get(active.userId,active.id)).result.answer,'temporary answer');
 assert.equal((await q.list('b')).every(job=>job.userId==='b'&&!('payload'in job)),true);
 assert.equal((await q.metrics(active.userId)).counts.completed,1);
});

test('lease recovery retries pure work, fences stale workers, and never repeats uncertain sends',async t=>{
 const {db}=await local(t),q=await createQueue(db,{concurrency:2});
 await q.enqueue('a','chat',{text:'hello'},{maxAttempts:3});await q.enqueue('a','telegram-send',{chatId:'sensitive'},{retrySafe:true,maxAttempts:3});
 const old=await q.claim('old',{types:['chat']}),send=await q.claim('sender',{types:['telegram-send']});
 databaseInternals(db).sqlite.prepare('UPDATE jobs SET lease_until=0 WHERE id IN(?,?)').run(old.id,send.id);
 const recovered=await q.claim('new',{types:['chat']});assert.equal(recovered.id,old.id);assert.notEqual(recovered.leaseToken,old.leaseToken);assert.equal(recovered.attempts,2);
 await assert.rejects(()=>q.complete(old,{}),/JOB_LEASE_LOST/);assert.equal((await q.get('a',send.id)).status,'needs_review');
 assert.equal(await q.claim('new-sender',{types:['telegram-send']}),null);
 await assert.rejects(()=>q.cancelUser('a'),/STUDENT_JOBS_RUNNING/);await q.complete(recovered,{});await q.cancelUser('a');assert.equal((await q.list('a')).length,0);
});

test('queue reserves notification capacity and persists across database restart',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'dabas-restart-'));let db=await openDatabase({dataDir:dir,databaseUrl:null,production:false});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});let q=await createQueue(db,{maxPendingModelPerUser:1});
 const job=await q.enqueue('a','chat',{text:'persist me'});await assert.rejects(()=>q.enqueue('a','pdf',{}),/STUDENT_MODEL_QUEUE_FULL/);await assert.rejects(()=>q.enqueue('a','telegram-syllabus',{}),/STUDENT_MODEL_QUEUE_FULL/);await q.enqueue('a','reminders',{});
 await db.close();db=await openDatabase({dataDir:dir,databaseUrl:null,production:false});q=await createQueue(db);assert.equal((await q.claim('restart',{types:['chat']})).payload.text,'persist me');assert.equal(await q.hasRunning('a'),true);
 assert.equal(await q.cancelPending('a'),1);assert.equal((await q.get('a',job.id)).status,'running');
});

test('production cannot silently fall back to development storage or missing encryption',async()=>{
 await assert.rejects(()=>openDatabase({production:true,databaseUrl:null}),/DATABASE_URL/);
 await assert.rejects(()=>openDatabase({production:true,databaseUrl:'postgres://invalid',encryptionKey:null}),/DATA_ENCRYPTION_KEY/);
});

test('managed PostgreSQL connections verify TLS and expired leases never revive expired payloads',async t=>{
 assert.equal(new URL(postgresPoolOptions('postgres://app:secret@managed.example/db').connectionString).searchParams.get('sslmode'),'verify-full');
 assert.throws(()=>postgresPoolOptions('postgres://app:secret@managed.example/db?sslmode=no-verify'),/verified TLS/);
 assert.throws(()=>postgresPoolOptions('postgres://app:secret@managed.example/db?ssl=0'),/verified TLS/);
 assert.equal(new URL(postgresPoolOptions('postgres://app:secret@postgres/db').connectionString).searchParams.has('sslmode'),false);
 const {db}=await local(t),q=await createQueue(db);await q.enqueue('a','chat',{});const job=await q.claim('before-expiry');databaseInternals(db).sqlite.prepare('UPDATE jobs SET lease_until=0,expires_at=0 WHERE id=?').run(job.id);
 assert.equal(await q.claim('after-expiry'),null);assert.equal((await q.get('a',job.id)).status,'failed');assert.equal(await q.claim('cleanup'),null);assert.equal(await q.get('a',job.id),null);
});

test('permanent student deletion is atomic with writes and queue insertion, and waits for running work',async t=>{
 const {db}=await local(t),q=await createQueue(db),store=db.forUser('delete-me');
 await db.auth.putIfAbsent('users','delete-me',{id:'delete-me'});await store.put('documents','resume',{private:'text'});await q.enqueue('delete-me','chat',{});
 const running=await q.claim('worker');await assert.rejects(()=>db.deleteStudent('delete-me'),/STUDENT_JOBS_RUNNING/);assert.equal(await db.isDeleted('delete-me'),false);await q.complete(running,{});
 await Promise.allSettled([store.put('documents','race-before',{}),db.deleteStudent('delete-me'),q.enqueue('delete-me','chat',{}),store.put('documents','race-after',{})]);
 assert.equal(await db.isDeleted('delete-me'),true);assert.equal((await db.listUserIds()).includes('delete-me'),false);assert.equal(await db.auth.get('users','delete-me'),null);
 await assert.rejects(()=>store.put('documents','after',{}),/STUDENT_DELETED/);await assert.rejects(()=>q.enqueue('delete-me','chat',{}),/STUDENT_DELETED/);await assert.rejects(()=>db.auth.putIfAbsent('users','delete-me',{}),/STUDENT_DELETED/);
 assert.equal(databaseInternals(db).sqlite.prepare('SELECT count(*) AS count FROM records WHERE user_id=?').get('delete-me').count,0);assert.equal(databaseInternals(db).sqlite.prepare('SELECT count(*) AS count FROM jobs WHERE user_id=?').get('delete-me').count,0);
});
