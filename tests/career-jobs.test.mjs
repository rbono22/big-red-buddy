import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {executeCareerJob} from '../lib/career-jobs.mjs';
async function setup(t){const dir=await mkdtemp(path.join(tmpdir(),'brf-career-jobs-'));const db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});return db;}
test('Telegram career jobs bind output to their owner and personal declarations never invoke inference',async t=>{
 const db=await setup(t),store=db.forUser('alice');
 await store.put('secrets','telegram',{chatId:123});await store.put('jobs','job',{id:'job',title:'Product role',company:'Example'});
 const original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('No network or model calls expected');};t.after(()=>globalThis.fetch=original);
 const result=await executeCareerJob(db,{id:'fixture-job',userId:'alice',type:'career-answer',payload:{jobId:'job',question:'Are you authorized to work in the US?',replyTo:'telegram'}});
 assert.equal(result.needsManual,true);assert.equal((await db.forUser('bob').all('applicationAnswers')).length,0);
 const queue=await createQueue(db,{workerDatabaseUrl:null}),reply=await queue.claim('test-worker',{types:['telegram-send']});
 assert.equal(reply.userId,'alice');assert.match(reply.payload.text,/needs your input/);assert.match(reply.payload.text,/No application was submitted/);
 await queue.complete(reply,{});await queue.close();
});
test('disconnect and account deletion block queued resume processing before file access',async t=>{
 const db=await setup(t);const original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('No file download expected');};t.after(()=>globalThis.fetch=original);
 await assert.rejects(executeCareerJob(db,{id:'x',userId:'alice',type:'telegram-resume',payload:{fileId:'private'}}),/no longer linked/);
 await db.forUser('alice').put('settings','account',{deleting:true});
 await assert.rejects(executeCareerJob(db,{id:'x',userId:'alice',type:'resume-review',payload:{}}),/deletion/);
});
