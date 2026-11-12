import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {getDemographics,DEMOGRAPHIC_FIELDS} from '../lib/demographics.mjs';
import {handleDemographicsMessage} from '../lib/demographics-telegram.mjs';
import {handleCareerMessage} from '../lib/career-telegram.mjs';

async function setup(t){
  const dir=await mkdtemp(path.join(tmpdir(),'brf-demographics-telegram-'));
  const db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
  t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
  const queue=await createQueue(db),a=db.forUser('alice'),b=db.forUser('bob'),payloads=new Map(),enqueue=queue.enqueue.bind(queue);
  queue.enqueue=async(...args)=>{const job=await enqueue(...args);if(!payloads.has(job.id))payloads.set(job.id,structuredClone(args[2]));return job;};
  await a.put('secrets','telegram',{chatId:101});await b.put('secrets','telegram',{chatId:202});
  await a.put('jobs','job-a',{id:'job-a',title:'Product Manager',company:'Example Company'});
  await a.put('documents','resume',{name:'Resume.pdf',text:'Synthetic student builds software and interviews customers.'});
  let next=1;
  const message=text=>({text,chat:{id:101,type:'private'}});
  const send=(text,id=next++)=>handleCareerMessage(db,queue,a,message(text),id);
  const direct=(text,id=next++,extra={})=>handleDemographicsMessage(db,queue,a,{...message(text),...extra},id);
  const texts=async()=>Promise.all((await queue.list('alice')).filter(j=>j.type==='telegram-send').map(j=>payloads.get(j.id).text));
  return {db,queue,a,b,send,direct,texts,payloads,state:()=>getDemographics(a)};
}

test('one-time consent invitation accompanies career actions without blocking them; skip prevents future offers',async t=>{
  const s=await setup(t);
  assert.equal(await s.send('/resume_upload',10),true);await s.send('/resume_upload',10);
  await s.send('/resume_review',11);await s.send('/apply job-a',12);await s.send('/career_profile',13);
  assert.equal((await s.texts()).filter(text=>text.startsWith('Optional self-identification')).length,1);
  assert.ok((await s.queue.list('alice')).some(j=>j.type==='resume-review'));
  assert.ok((await s.queue.list('alice')).some(j=>j.type==='draft'));
  assert.equal((await s.state()).questionnaire.active,null);
  await s.send('/demographics skip',14);await s.send('/career_profile',15);
  assert.equal((await s.texts()).filter(text=>text.startsWith('Optional self-identification')).length,1);
  assert.ok((await s.state()).questionnaire.skippedAllAt);
  assert.equal((await getDemographics(s.b)).questionnaire.invitedAt,null);
});

test('questionnaire requires a linked private chat and explicit start; every question offers a skip',async t=>{
  const s=await setup(t);
  assert.equal(await s.direct('/demographics',10,{chat:{id:202,type:'private'}}),false);
  assert.equal(await s.direct('/demographics start',11,{chat:{id:101,type:'group'}}),false);
  assert.equal((await s.state()).questionnaire.active,null);
  await s.send('/demographics',12);assert.equal((await s.state()).questionnaire.active,null);
  await s.send('/demographics start',13);
  let count=0,id=14;
  while((await s.state()).questionnaire.active){
    const active=(await s.state()).questionnaire.active;
    const prompts=[...s.payloads.values()].filter(payload=>payload.replyMarkup?.inline_keyboard?.flat().some(button=>/skip/i.test(button.text)));
    assert.ok(prompts.length,'questions offer a tappable skip');
    assert.ok((await s.texts()).every(text=>!text.includes(active.token)),'security tokens stay inside opaque button data');
    const spec=DEMOGRAPHIC_FIELDS.find(field=>field.field===active.field);
    assert.ok(spec.options.some(option=>/decline|prefer not|not to (?:say|answer)/i.test(option.label)));
    await s.send(`/demographic ${active.token} ${active.field} 0`,id++);assert.ok(++count<=DEMOGRAPHIC_FIELDS.length);
  }
  assert.ok(count>0);assert.ok((await s.state()).questionnaire.completedAt);
});

test('active unstructured replies stay out of model jobs and tokenized answers resist replay and cross-tenant use',async t=>{
  const s=await setup(t);await s.send('/demographics start',10);
  const first=(await s.state()).questionnaire.active;
  assert.equal(await s.send('/resume',100),false);
  const privateText='PRIVATE_FIXTURE_DEMOGRAPHIC_RESPONSE';
  assert.equal(await s.send(privateText,11),true);
  assert.equal(await s.send('/unexpected demographic reply',12),true);
  assert.ok(!(await s.texts()).some(text=>text.includes(privateText)));
  assert.ok((await s.queue.list('alice')).every(j=>j.type==='telegram-send'));
  await assert.rejects(s.send(`/demographic wrong-token ${first.field} 1`,13));
  const otherField=DEMOGRAPHIC_FIELDS.find(item=>item.field!==first.field).field;
  await assert.rejects(s.send(`/demographic ${first.token} ${otherField} 1`,13));
  assert.deepEqual((await s.state()).questionnaire.active,first);
  const answer=`/demographic ${first.token} ${first.field} 1`;
  await s.send(answer,14);const after=await s.state();await s.send(answer,14);
  assert.deepEqual(await s.state(),after);
  await assert.rejects(s.send(answer,15));
  await assert.rejects(handleDemographicsMessage(s.db,s.queue,s.b,{text:answer,chat:{id:202,type:'private'}},16));
  assert.equal((await getDemographics(s.b)).questionnaire.active,null);
});

test('invitation marker survives database restart and Telegram relinking',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'brf-demographics-restart-'));
  let db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
  t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
  let queue=await createQueue(db),store=db.forUser('student');
  await store.put('secrets','telegram',{chatId:101});
  await handleDemographicsMessage(db,queue,store,{text:'/career_profile',chat:{id:101,type:'private'}},10);
  const invitedAt=(await getDemographics(store)).questionnaire.invitedAt;
  assert.equal((await queue.list('student')).length,1);
  await db.close();db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
  queue=await createQueue(db);store=db.forUser('student');
  await store.delete('secrets','telegram');await store.put('secrets','telegram',{chatId:303});
  await handleDemographicsMessage(db,queue,store,{text:'/career_profile',chat:{id:303,type:'private'}},11);
  assert.equal((await getDemographics(store)).questionnaire.invitedAt,invitedAt);
  assert.equal((await queue.list('student')).length,1);
});

test('existing veteran answer is preserved without repeat; explicit edit creates a new bounded question',async t=>{
  const s=await setup(t);await s.a.put('career','profile',{veteranStatus:'non_veteran'});
  await s.send('/demographics start',10);let id=11;
  while((await s.state()).questionnaire.active){
    const active=(await s.state()).questionnaire.active;
    assert.notEqual(active.field,'veteranStatus');
    await s.send(`/demographic ${active.token} ${active.field} 0`,id++);
  }
  const field=DEMOGRAPHIC_FIELDS[0].field;
  await s.send(`/demographics edit ${field}`,id++);
  const active=(await s.state()).questionnaire.active;assert.equal(active.field,field);
  await s.send(`/demographic ${active.token} ${field} 1`,id++);
  assert.equal((await s.state()).questionnaire.active,null);
  await assert.rejects(s.send('/demographics edit unsupported',id++),/Use \/demographics edit/);
});
