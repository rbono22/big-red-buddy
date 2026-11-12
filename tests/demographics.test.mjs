import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {DEMOGRAPHIC_FIELDS,getDemographics,inviteDemographics,startDemographics,answerDemographics,skipDemographics,editDemographics} from '../lib/demographics.mjs';
import {saveCareerProfile,getCareerProfile,draftCareerAnswer} from '../lib/career.mjs';

async function database(t){const dir=await mkdtemp(path.join(tmpdir(),'brf-demographics-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});return {db,dir};}
const response=(question,value,updateId)=>({field:question.field,value,questionToken:question.token,updateId});

test('definitions are optional bounded choices and distinguish protected veteran and disability history',()=>{
  assert.equal(DEMOGRAPHIC_FIELDS.length,6);
  for(const field of DEMOGRAPHIC_FIELDS){assert.equal(field.optional,true);assert.ok(field.options.some(option=>option.value==='decline'));assert.ok(field.options.some(option=>option.value==='unanswered'));}
  assert.match(DEMOGRAPHIC_FIELDS.find(field=>field.field==='disabilityStatus').prompt,/history of one/);
  assert.match(DEMOGRAPHIC_FIELDS.find(field=>field.field==='protectedVeteranStatus').prompt,/separate from veteran status/);
  assert.ok(DEMOGRAPHIC_FIELDS.find(field=>field.field==='gender').options.some(option=>option.value==='other'));
});

test('invitation is atomic once per student, with a stable retry ID and no automatic questionnaire start',async t=>{
  const {db}=await database(t),store=db.forUser('invite');
  const offers=await Promise.all([inviteDemographics(store,{updateId:1}),inviteDemographics(store,{updateId:2})]);
  assert.equal(offers.filter(result=>result.shouldInvite).length,1);const chosen=offers.findIndex(result=>result.shouldInvite),again=await inviteDemographics(store,{updateId:chosen+1});assert.equal(again.shouldInvite,true);assert.equal(again.invitationId,offers[chosen].invitationId);
  assert.equal((await inviteDemographics(store,{updateId:3})).shouldInvite,false);assert.equal((await getDemographics(store)).questionnaire.active,null);
  assert.equal((await startDemographics(store)).question,null);assert.equal((await startDemographics(store,{manual:true,updateId:4})).question.field,'veteranStatus');
});

test('asked marker is persisted before returning a prompt and old updates cannot answer a later field',async t=>{
  const store=(await database(t)).db.forUser('tokens'),first=await startDemographics(store,{manual:true,updateId:10});
  assert.ok((await getDemographics(store)).questionnaire.askedFields.includes(first.question.field));
  const next=await answerDemographics(store,response(first.question,'veteran',11));assert.equal(next.question.field,'protectedVeteranStatus');assert.notEqual(next.question.token,first.question.token);
  const replay=await answerDemographics(store,response(first.question,'veteran',11));assert.equal(replay.duplicate,true);assert.equal(replay.question,null);
  await assert.rejects(answerDemographics(store,response(first.question,'non_veteran',12)),{status:409});
  assert.equal((await getDemographics(store)).values.veteranStatus,'veteran');assert.equal((await getDemographics(store)).values.protectedVeteranStatus,'unanswered');
});

test('concurrent answers to the same token have one winner',async t=>{
  const store=(await database(t)).db.forUser('race-replies'),first=await startDemographics(store,{manual:true});
  const replies=await Promise.allSettled([answerDemographics(store,response(first.question,'veteran',20)),answerDemographics(store,response(first.question,'non_veteran',21))]);
  assert.equal(replies.filter(result=>result.status==='fulfilled').length,1);assert.equal(replies.filter(result=>result.status==='rejected'&&result.reason.status===409).length,1);
  assert.equal((await getDemographics(store)).questionnaire.active.field,'protectedVeteranStatus');
});

test('existing explicit veteran choice is reused and new veteran answers synchronize one canonical profile field',async t=>{
  const store=(await database(t)).db.forUser('legacy');await saveCareerProfile(store,{fullName:'Example Student',veteranStatus:'decline'});
  const first=await startDemographics(store,{manual:true});assert.equal(first.question.field,'protectedVeteranStatus');assert.equal(first.state.values.veteranStatus,'decline');assert.ok(first.state.questionnaire.answeredFields.includes('veteranStatus'));assert.equal(first.state.values.protectedVeteranStatus,'unanswered');
  const editing=await startDemographics(store,{manual:true,edit:true,field:'veteranStatus'});await answerDemographics(store,response(editing.question,'veteran',30));
  assert.equal((await getCareerProfile(store)).veteranStatus,'veteran');assert.equal((await getCareerProfile(store)).fullName,'Example Student');
  const raw=await store.get('career','demographics');assert.equal(raw.values.veteranStatus,undefined);assert.equal(raw.profileWrite,undefined);
  await saveCareerProfile(store,{veteranStatus:'non_veteran'});assert.equal((await getDemographics(store)).values.veteranStatus,'non_veteran');
});

test('skip all is permanent for automatic invitations and explicit manual resume remains possible',async t=>{
  const store=(await database(t)).db.forUser('skip-all');await inviteDemographics(store,{updateId:40});
  const skipped=await skipDemographics(store,{all:true,updateId:41});assert.equal(skipped.question,null);assert.ok(skipped.state.questionnaire.skippedAllAt);
  assert.equal((await inviteDemographics(store,{updateId:42})).shouldInvite,false);assert.equal((await startDemographics(store)).question,null);
  await store.put('secrets','telegram',{chatId:'new-chat'});assert.equal((await inviteDemographics(store,{updateId:43})).shouldInvite,false);
  const manual=await startDemographics(store,{manual:true,updateId:44});assert.equal(manual.question.field,'veteranStatus');
});

test('individual skips and declines are not asked again automatically, and completed questions do not repeat',async t=>{
  const store=(await database(t)).db.forUser('complete');let current=await startDemographics(store,{manual:true});let updateId=50;
  current=await skipDemographics(store,{field:current.question.field,questionToken:current.question.token,updateId:updateId++});
  while(current.question)current=await answerDemographics(store,response(current.question,current.question.multiple?['decline']:'decline',updateId++));
  assert.ok(current.state.questionnaire.completedAt);assert.ok(current.state.questionnaire.skippedFields.includes('veteranStatus'));assert.equal(current.state.values.gender,'decline');
  assert.equal((await startDemographics(store)).question,null);assert.equal((await inviteDemographics(store,{updateId:90})).shouldInvite,false);
  const manual=await startDemographics(store,{manual:true});assert.equal(manual.question.field,'veteranStatus');
  const edited=await startDemographics(store,{manual:true,edit:true,field:'gender',updateId:91});assert.equal(edited.question.field,'gender');assert.notEqual(edited.question.token,manual.question.token);
});

test('race supports multiple explicit categories and rejects contradictory decline/skip combinations',async t=>{
  const store=(await database(t)).db.forUser('race');
  const values=await editDemographics(store,{race:['asian','white','asian'],gender:'other'});assert.deepEqual(values.values.race,['asian','white']);assert.equal(values.values.gender,'other');
  for(const patch of [{race:[]},{race:['decline','white']},{race:['unanswered','asian']},{race:['invented']},{gender:'self_describe'},{disabilityStatus:true},{protectedVeteranStatus:'veteran'},{medicalDetails:'private'},{}])await assert.rejects(editDemographics(store,patch),{status:400});
  assert.deepEqual((await getDemographics(store)).values.race,['asian','white']);
});

test('explicit editing invalidates the old prompt token and never restarts automatic invitations',async t=>{
  const store=(await database(t)).db.forUser('edit'),first=await startDemographics(store,{manual:true});
  await editDemographics(store,{veteranStatus:'decline'});await assert.rejects(answerDemographics(store,response(first.question,'veteran',100)),{status:409});
  assert.equal((await getDemographics(store)).values.veteranStatus,'decline');assert.equal((await inviteDemographics(store,{updateId:101})).shouldInvite,false);
});

test('tenant ownership isolates all saved answers and tokens',async t=>{
  const {db}=await database(t),a=db.forUser('a'),b=db.forUser('b'),prompt=await startDemographics(a,{manual:true});
  await answerDemographics(a,response(prompt.question,'veteran',110));await editDemographics(a,{race:['asian'],disabilityStatus:'decline'});
  const other=await getDemographics(b);assert.equal(other.values.veteranStatus,'unanswered');assert.deepEqual(other.values.race,['unanswered']);assert.equal(other.questionnaire.active,null);
  await assert.rejects(answerDemographics(b,response(prompt.question,'non_veteran',111)),{status:409});assert.equal((await getDemographics(a)).values.veteranStatus,'veteran');
});

test('deleting a student removes questionnaire access without changing another student’s preferences',async t=>{
  const {db}=await database(t),a=db.forUser('delete-a'),b=db.forUser('keep-b');
  await skipDemographics(a,{all:true,updateId:115});await editDemographics(b,{gender:'decline',race:['white']});
  await db.deleteStudent('delete-a');assert.equal(await db.isDeleted('delete-a'),true);
  await assert.rejects(getDemographics(a));assert.equal((await getDemographics(b)).values.gender,'decline');assert.deepEqual((await getDemographics(b)).values.race,['white']);
});

test('persisted markers survive a second database handle and pending veteran synchronization recovers',async t=>{
  const {db,dir}=await database(t),store=db.forUser('restart');await skipDemographics(store,{all:true,updateId:120});
  const second=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});t.after(()=>second.close());
  assert.equal((await inviteDemographics(second.forUser('restart'),{updateId:121})).shouldInvite,false);
  const record=await store.get('career','demographics');await store.put('career','demographics',{...record,profileWrite:{id:'recover',expected:'unanswered',value:'veteran'}});
  assert.equal((await getDemographics(second.forUser('restart'))).values.veteranStatus,'veteran');assert.equal((await store.get('career','demographics')).profileWrite,undefined);
  await store.put('career','demographics',{...(await store.get('career','demographics')),profileWrite:{id:'stale',expected:'unanswered',value:'non_veteran'}});
  assert.equal((await getDemographics(store)).values.veteranStatus,'veteran','a delayed intent cannot overwrite a newer explicit value');
});

test('demographic questions and saved answers never enter career model generation',async t=>{
  const store=(await database(t)).db.forUser('model-exclusion');await store.put('jobs','job',{id:'job',title:'Analyst',description:'Use data.'});await editDemographics(store,{race:['asian'],gender:'non_binary',disabilityStatus:'yes'});let calls=0;
  for(const field of DEMOGRAPHIC_FIELDS){const result=await draftCareerAnswer(store,{jobId:'job',question:field.prompt},{generate:async()=>{calls++;throw new Error('Sensitive questions must not enter the model.');}});assert.equal(result.needsManual,true);}
  assert.equal(calls,0);assert.equal((await store.all('metrics')).length,0);
});
