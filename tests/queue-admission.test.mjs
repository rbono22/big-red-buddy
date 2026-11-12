import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase,databaseInternals} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';

async function fixture(t,options={}){
 const dir=await mkdtemp(path.join(tmpdir(),'brb-admission-'));
 const db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
 const queue=await createQueue(db,{workerDatabaseUrl:null,...options});
 t.after(async()=>{await queue.close();await db.close();await rm(dir,{recursive:true,force:true});});
 return {queue,db,sql:databaseInternals(db).sqlite};
}
const mustNotSerialize={toJSON(){throw new Error('PAYLOAD_WAS_PROCESSED_BEFORE_ADMISSION');}};

test('duplicate submissions reuse the owned job without touching the incoming large payload',async t=>{
 const {queue}=await fixture(t,{maxPendingModelPerUser:1});
 const original=await queue.enqueue('alice','pdf',{name:'Synthetic.pdf',base64:'synthetic-file'},{idempotencyKey:'upload-one'});
 const repeated=await queue.enqueue('alice','pdf',mustNotSerialize,{idempotencyKey:'upload-one'});
 assert.equal(repeated.id,original.id);
 assert.equal((await queue.list('alice')).length,1);
 const claimed=await queue.claim('fixture',{types:['pdf']});
 assert.deepEqual(claimed.payload,{name:'Synthetic.pdf',base64:'synthetic-file'});
 await queue.complete(claimed,{});
});

test('full model and student queues reject before serializing or encrypting a new upload',async t=>{
 const {queue}=await fixture(t,{maxPendingPerUser:2,maxPendingModelPerUser:1});
 await queue.enqueue('alice','pdf',{});
 await assert.rejects(queue.enqueue('alice','pdf',mustNotSerialize),/STUDENT_MODEL_QUEUE_FULL/);
 await queue.enqueue('alice','reminders',{});
 await assert.rejects(queue.enqueue('alice','pdf',mustNotSerialize),/STUDENT_QUEUE_FULL/);
 assert.equal((await queue.list('alice')).length,2);
});

test('admission cannot reuse another student’s upload and accepted payloads remain encrypted',async t=>{
 const {queue,sql}=await fixture(t);
 const a=await queue.enqueue('alice','pdf',{text:'SYNTHETIC_PRIVATE_A'},{idempotencyKey:'same'});
 await assert.rejects(queue.enqueue('bob','pdf',mustNotSerialize,{idempotencyKey:'same'}),/PAYLOAD_WAS_PROCESSED/);
 const b=await queue.enqueue('bob','pdf',{text:'SYNTHETIC_PRIVATE_B'},{idempotencyKey:'same'});
 assert.notEqual(a.id,b.id);
 assert.equal(await queue.get('bob',a.id),null);
 for(const row of sql.prepare('SELECT payload FROM jobs').all())assert.doesNotMatch(row.payload,/SYNTHETIC_PRIVATE/);
 const first=await queue.claim('fixture',{types:['pdf']});assert.equal(first.userId,'alice');
 assert.equal(first.payload.text,'SYNTHETIC_PRIVATE_A');await queue.complete(first,{});
 const second=await queue.claim('fixture',{types:['pdf']});assert.equal(second.userId,'bob');
 assert.equal(second.payload.text,'SYNTHETIC_PRIVATE_B');
});
