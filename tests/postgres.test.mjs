import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';

test('real PostgreSQL runtime roles, FORCE RLS, atomic queue concurrency and lease fencing',{skip:!process.env.TEST_POSTGRES_ADMIN_URL},async t=>{
 const adminUrl=process.env.TEST_POSTGRES_ADMIN_URL,suffix=randomBytes(5).toString('hex'),name=`dabas_test_${suffix}`,owner=`dabas_owner_${suffix}`,app=`dabas_app_${suffix}`,worker=`dabas_worker_${suffix}`;
 const admin=new Pool({connectionString:adminUrl,max:1});let db,q,ownerPool,runtimePool;
 const urlFor=(role,database=name)=>{const url=new URL(adminUrl);url.username=role;url.password='';url.pathname=`/${database}`;return url.toString();};
 try {
  await admin.query('BEGIN');await admin.query('SELECT pg_advisory_xact_lock(118327,99)');
  for(const role of ['dabas_app','dabas_worker'])if(!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query('COMMIT');
  await admin.query(`CREATE ROLE ${owner} LOGIN NOSUPERUSER NOBYPASSRLS`);await admin.query(`CREATE ROLE ${app} LOGIN NOSUPERUSER NOBYPASSRLS`);await admin.query(`CREATE ROLE ${worker} LOGIN NOSUPERUSER NOBYPASSRLS`);
  await admin.query(`GRANT dabas_app TO ${app},${worker}`);await admin.query(`GRANT dabas_worker TO ${worker}`);await admin.query(`CREATE DATABASE ${name} OWNER ${owner}`);
  ownerPool=new Pool({connectionString:urlFor(owner),max:1});await ownerPool.query(await readFile(new URL('../migrations/001_tenants_and_queue.sql',import.meta.url),'utf8'));
  const key=randomBytes(32).toString('base64');db=await openDatabase({databaseUrl:urlFor(app),encryptionKey:key,production:true});q=await createQueue(db,{workerDatabaseUrl:urlFor(worker),concurrency:1});
  await db.forUser('a').put('resumes','same',{text:'private a'});await db.forUser('b').put('resumes','same',{text:'private b'});
  assert.equal((await db.forUser('a').get('resumes','same')).text,'private a');assert.equal((await db.forUser('b').get('resumes','same')).text,'private b');
  runtimePool=new Pool({connectionString:urlFor(app),max:1});assert.equal((await runtimePool.query('SELECT * FROM dabas.records')).rowCount,0);
  const connection=await runtimePool.connect();
  try {await connection.query('BEGIN');await connection.query("SELECT set_config('app.user_id','a',true)");assert.equal((await connection.query('SELECT * FROM dabas.records')).rowCount,1);await assert.rejects(()=>connection.query("INSERT INTO dabas.records VALUES('b','resumes','forged','bad')"),{code:'42501'});await connection.query('ROLLBACK');}finally{connection.release();}
  assert.equal((await runtimePool.query('SELECT * FROM dabas.records')).rowCount,0,'tenant scope must reset after transaction');
  await assert.rejects(()=>runtimePool.query('ALTER TABLE dabas.records DISABLE ROW LEVEL SECURITY'),{code:'42501'});await assert.rejects(()=>runtimePool.query('TRUNCATE dabas.records'),{code:'42501'});
  await assert.rejects(()=>runtimePool.query("SELECT * FROM dabas.claim_job('forged',NULL,60000,1,gen_random_uuid())"),{code:'42501'});
  await assert.rejects(()=>openDatabase({databaseUrl:urlFor(owner),encryptionKey:key,production:true}),/own/);await assert.rejects(()=>openDatabase({databaseUrl:adminUrl,encryptionKey:key,production:true}),/superuser/);
  const outcomes=await Promise.all(Array.from({length:8},()=>db.forUser('a').compareAndSet('reminders','atomic',null,{sent:true})));assert.equal(outcomes.filter(Boolean).length,1);
  await db.auth.put('oauth_states','one-time',{safe:true});assert.equal((await Promise.all([db.auth.take('oauth_states','one-time'),db.auth.take('oauth_states','one-time')])).filter(Boolean).length,1);
  const jobs=await Promise.all([q.enqueue('a','chat',{text:'A'},{idempotencyKey:'same'}),q.enqueue('a','chat',{text:'A'},{idempotencyKey:'same'})]);assert.equal(jobs[0].id,jobs[1].id);
  await q.enqueue('b','chat',{text:'B'});const claims=await Promise.all(Array.from({length:6},(_,i)=>q.claim(`worker-${i}`,{types:['chat']})));assert.equal(claims.filter(Boolean).length,1);
  const old=claims.find(Boolean);await q.cancelPending('a');await q.cancelPending('b');await ownerPool.query("UPDATE dabas.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[old.id]);const renewed=await q.claim('replacement',{types:['chat']});assert.equal(renewed.id,old.id);assert.equal(renewed.attempts,2);
  await assert.rejects(()=>q.complete(old,{}),/JOB_LEASE_LOST/);await q.complete(renewed,{answer:'encrypted result'});assert.equal((await q.get(renewed.userId,renewed.id)).result.answer,'encrypted result');assert.equal(await q.get(renewed.userId==='a'?'b':'a',renewed.id),null);
  await q.enqueue('a','telegram-send',{chat:'secret'},{retrySafe:true});const send=await q.claim('send',{types:['telegram-send'],concurrency:2});await ownerPool.query("UPDATE dabas.jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[send.id]);assert.equal(await q.claim('send-retry',{types:['telegram-send']}),null);assert.equal((await q.get('a',send.id)).status,'needs_review');
  await Promise.allSettled([db.forUser('a').put('resumes','racing',{}),db.deleteStudent('a'),q.enqueue('a','chat',{})]);assert.equal(await db.isDeleted('a'),true);assert.equal((await db.listUserIds()).includes('a'),false);
  await assert.rejects(()=>db.forUser('a').put('resumes','resurrect',{}),/STUDENT_DELETED/);await assert.rejects(()=>q.enqueue('a','chat',{}),/STUDENT_DELETED/);await assert.rejects(()=>db.auth.putIfAbsent('users','a',{}),/STUDENT_DELETED/);
  assert.equal((await ownerPool.query("SELECT * FROM dabas.records WHERE user_id='a'")).rowCount,0);assert.equal((await ownerPool.query("SELECT * FROM dabas.jobs WHERE user_id='a'")).rowCount,0);
  await assert.rejects(()=>runtimePool.query("UPDATE dabas.tenants SET deleted_at=NULL WHERE user_id='a'"),{code:'42501'});
  const deletedConnection=await runtimePool.connect();try{await deletedConnection.query('BEGIN');await deletedConnection.query("SELECT set_config('app.user_id','a',true)");await assert.rejects(()=>deletedConnection.query("INSERT INTO dabas.records VALUES('a','resumes','resurrect','bad')"),{code:'42501'});await deletedConnection.query('ROLLBACK');}finally{deletedConnection.release();}
  for(let iteration=0;iteration<5;iteration++){
   const student=`claim-delete-${iteration}`,type=`claim-delete-${iteration}`;await q.enqueue(student,type,{}, {retrySafe:false});
   const [deletion,claim]=await Promise.allSettled([db.deleteStudent(student),q.claim(`race-${iteration}`,{types:[type]})]);assert.equal(claim.status,'fulfilled');
   if(claim.value){assert.equal(deletion.status,'rejected');assert.match(deletion.reason.message,/STUDENT_JOBS_RUNNING/);await q.complete(claim.value,{});await db.deleteStudent(student);}else assert.equal(deletion.status,'fulfilled');
   assert.equal(await db.isDeleted(student),true);
  }
  await q.enqueue('expiry','chat',{});const expiring=await q.claim('expiry',{types:['chat']});await ownerPool.query("UPDATE dabas.jobs SET lease_until=now()-interval '1 second',expires_at=now()-interval '1 second' WHERE id=$1",[expiring.id]);assert.equal(await q.claim('expiry-recovery',{types:['chat']}),null);assert.equal((await q.get('expiry',expiring.id)).status,'failed');await q.claim('expiry-cleanup',{types:['chat']});assert.equal(await q.get('expiry',expiring.id),null);
 } finally {
  if(q)await q.close();if(db)await db.close();if(runtimePool)await runtimePool.end();if(ownerPool)await ownerPool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH(FORCE)`);for(const role of [app,worker,owner])await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();
 }
});
