import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {getCareerProfile,saveCareerProfile,reviewResume,draftCareerAnswer,saveCareerAnswer} from '../lib/career.mjs';

const RESUME='Alex Example\nalex@example.edu\nBuilt an inventory forecasting tool using Python.\nLed user interviews for a campus product.\nCornell Tech graduate student.\nWork authorization: private-authorization-declaration';
const JOB={id:'job-one',title:'Product Analyst',company:'Sony',description:'Build forecasting tools and study customer needs.',url:'https://example.com/jobs/one'};
async function database(t){const dir=await mkdtemp(path.join(tmpdir(),'brf-career-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});return db;}
async function seed(store){await store.put('documents','resume',{name:'Resume.pdf',text:RESUME,file:'private-pdf-content',updatedAt:'2026-11-10T18:00:00Z'});await store.put('jobs',JOB.id,JOB);}
const review=()=>({value:{summary:'A useful starting point with clear technical work.',suggestions:[{original:'Built an inventory forecasting tool using Python.',suggested:'Built a Python tool for inventory forecasting.',reason:'Lead with the implementation and purpose.'}],facts:{fullName:{value:'Alex Example',evidence:'Alex Example'},email:{value:'alex@example.edu',evidence:'alex@example.edu'}},gaps:['Add a measured outcome only if you have one.']},metrics:{model:'test-model',ms:12,inputTokens:100,outputTokens:80,prompt:'must-not-be-retained'}});
const draft=()=>({value:{answer:'My Python forecasting work connects with this role’s focus on forecasting tools.',evidence:[{source:'resume',quote:'Built an inventory forecasting tool using Python.'},{source:'job',quote:'Build forecasting tools and study customer needs.'}],gaps:['Add your personal motivation for joining Sony.']},metrics:{model:'test-model',ms:8,inputTokens:100,outputTokens:50}});

test('profile starts with unanswered eligibility fields and exposes only its allowlisted shape',async t=>{
  const store=(await database(t)).forUser('profile'),initial=await getCareerProfile(store);
  assert.equal(initial.workAuthorizationUS,'unanswered');assert.equal(initial.sponsorship,'unanswered');assert.equal(initial.veteranStatus,'unanswered');assert.equal(initial.fullName,'');
  await store.put('career','profile',{fullName:'Alex Example',accessToken:'must-stay-hidden',resumeText:'must-stay-hidden',source:'student-entered'});
  const safe=await getCareerProfile(store);assert.equal(safe.fullName,'Alex Example');assert.equal(safe.accessToken,undefined);assert.equal(safe.resumeText,undefined);assert.equal(safe.source,undefined);
});

test('profile saves explicit facts with tenant isolation and merges concurrent category edits',async t=>{
  const db=await database(t),a=db.forUser('a'),b=db.forUser('b');
  await saveCareerProfile(a,{fullName:'Alex Example',workAuthorizationUS:'yes',sponsorship:'no',veteranStatus:'decline'});
  await Promise.all([saveCareerProfile(a,{phone:'+1 (555) 123-4567'}),saveCareerProfile(a,{availability:'After graduation'})]);
  const profile=await getCareerProfile(a);assert.equal(profile.phone,'+1 (555) 123-4567');assert.equal(profile.availability,'After graduation');assert.equal(profile.veteranStatus,'decline');assert.equal((await getCareerProfile(b)).workAuthorizationUS,'unanswered');assert.equal((await getCareerProfile(b)).fullName,'');
});

test('profile rejects unknown keys, unsafe URLs, inferred enums and overlong values without saving',async t=>{
  const store=(await database(t)).forUser('invalid');
  for(const patch of [{userId:'other'}, {fullName:'x'.repeat(161)}, {workAuthorizationUS:true}, {sponsorship:'probably'}, {veteranStatus:'inferred'}, {email:'invalid'}, {phone:'none'}, {linkedin:'https://notlinkedin.com/x'}, {portfolio:'javascript:alert(1)'}, {portfolio:'https://user:password@example.com'}, {availability:'line\nline'}, {},null,[]])await assert.rejects(saveCareerProfile(store,patch),{status:400});
  assert.equal(await store.get('career','profile'),null);
  const saved=await saveCareerProfile(store,{linkedin:'https://www.linkedin.com/in/example',portfolio:'https://example.com',veteranStatus:'non_veteran'});assert.equal(saved.veteranStatus,'non_veteran');
});

test('resume review keeps exact supported contact candidates unconfirmed and never overwrites saved profile',async t=>{
  const store=(await database(t)).forUser('review');await seed(store);await saveCareerProfile(store,{fullName:'Confirmed student name',workAuthorizationUS:'yes',veteranStatus:'veteran'});
  const prompts=[],result=await reviewResume(store,{generate:async prompt=>{prompts.push(prompt);return review();}});
  assert.equal(result.status,'review');assert.equal(result.facts.fullName.value,'Alex Example');assert.equal(result.facts.fullName.status,'unconfirmed');assert.equal(result.suggestions[0].evidenceVerified,true);assert.equal((await getCareerProfile(store)).fullName,'Confirmed student name');
  assert.equal(prompts.length,1);assert.equal(prompts[0].includes('Confirmed student name'),false);assert.equal(prompts[0].includes('private-authorization-declaration'),false);assert.equal(prompts[0].includes('private-pdf-content'),false);
  const saved=await store.get('career','resumeReview');assert.equal(saved.source.name,'Resume.pdf');assert.equal(saved.source.text,undefined);assert.equal(saved.source.file,undefined);
  const metrics=await store.all('metrics');assert.equal(metrics.length,1);assert.equal(metrics[0].task,'resume review');assert.equal(metrics[0].ms,12);assert.equal(metrics[0].prompt,undefined);
});

test('hallucinated resume facts, protected candidate fields, and unmatched edits are discarded',async t=>{
  const store=(await database(t)).forUser('unverified');await seed(store);const response=review();
  response.value.facts.phone={value:'5551234567',evidence:'5551234567'};response.value.facts.workAuthorizationUS={value:'yes',evidence:'Cornell Tech graduate student.'};response.value.facts.fullName={value:'Different person',evidence:'Alex Example'};
  response.value.suggestions.push({original:'Led a team of 100 engineers.',suggested:'Led 100 engineers to success.',reason:'More compelling.'});
  const result=await reviewResume(store,{generate:async()=>response});assert.equal(result.facts.phone,undefined);assert.equal(result.facts.fullName,undefined);assert.equal(result.facts.workAuthorizationUS,undefined);assert.equal(result.suggestions.length,1);assert.ok(result.gaps.some(gap=>/matching resume passage/.test(gap)));assert.ok(result.gaps.some(gap=>/could not be verified/.test(gap)));
});

test('resume review rejects malformed output and a changed resume without retaining stale analysis',async t=>{
  const store=(await database(t)).forUser('changed-review');await seed(store);
  await assert.rejects(reviewResume(store,{generate:async()=>({value:{summary:12,suggestions:[]}})}),{status:502});
  await assert.rejects(reviewResume(store,{generate:async()=>{await store.put('documents','resume',{text:RESUME+'\nNew role',updatedAt:'new'});return review();}}),{status:409});
  assert.equal(await store.get('career','resumeReview'),null);
});

test('custom answer uses only owned resume and job evidence, respects short questions, and records a draft',async t=>{
  const store=(await database(t)).forUser('answer');await seed(store);await saveCareerProfile(store,{fullName:'PRIVATE_PROFILE_ONLY',availability:'PRIVATE_AVAILABILITY',workAuthorizationUS:'yes',veteranStatus:'veteran'});
  let prompt;const answer=await draftCareerAnswer(store,{jobId:JOB.id,question:'Why Sony?',guidance:'Use a concise, friendly tone.'},{id:'queue-job-1',generate:async p=>{prompt=p;return draft();}});
  assert.equal(answer.id,'queue-job-1');assert.equal(answer.status,'draft');assert.equal(answer.needsManual,false);assert.equal(answer.answer,answer.draft);assert.ok(answer.evidence.every(item=>item.verified));assert.equal(prompt.includes('PRIVATE_PROFILE_ONLY'),false);assert.equal(prompt.includes('PRIVATE_AVAILABILITY'),false);assert.equal(prompt.includes('private-authorization-declaration'),false);assert.ok(prompt.includes('Why Sony?'));assert.equal(answer.destination,'Student review only; no employer submission');
  assert.equal((await store.all('metrics'))[0].task,'custom application answer');
});

test('answer idempotency preserves student edits across queue retries',async t=>{
  const store=(await database(t)).forUser('retry');await seed(store);let calls=0;
  const options={id:'stable-job',generate:async()=>{calls++;return draft();}},input={jobId:JOB.id,question:'Why Sony?',guidance:''};
  const first=await draftCareerAnswer(store,input,options);await saveCareerAnswer(store,{id:first.id,answer:'My personally reviewed explanation.'});
  const repeated=await draftCareerAnswer(store,input,options);assert.equal(calls,1);assert.equal(repeated.status,'reviewed');assert.equal(repeated.answer,'My personally reviewed explanation.');
  await assert.rejects(draftCareerAnswer(store,{...input,question:'Why another company?'},options),{status:409});
});

test('student guidance may supply personal motivation with explicit self-reported evidence',async t=>{
  const store=(await database(t)).forUser('guidance');await seed(store);const guidance='I grew up playing PlayStation; emphasize this.';let prompt;
  const answer=await draftCareerAnswer(store,{jobId:JOB.id,question:'Why Sony?',guidance},{generate:async value=>{prompt=value;return {value:{answer:'I grew up playing PlayStation, which motivates my interest in Sony.',evidence:[{source:'guidance',quote:'I grew up playing PlayStation'}],gaps:[]}};}});
  assert.equal(answer.evidence[0].source,'guidance');assert.equal(answer.evidence[0].verified,true);assert.equal(answer.evidence[0].selfReported,true);assert.deepEqual(answer.gaps,[]);assert.match(prompt,/self-reported information, not independently verified/);assert.equal((await getCareerProfile(store)).fullName,'');
});

test('manual-sensitive and legal questions never call the model or infer an answer from saved facts',async t=>{
  const store=(await database(t)).forUser('manual');await store.put('jobs',JOB.id,JOB);await saveCareerProfile(store,{workAuthorizationUS:'yes',sponsorship:'no',veteranStatus:'veteran'});
  let calls=0;for(const question of ['Are you authorized to work in the United States?','Will you require sponsorship?','What is your veteran status?','Do you have a disability?','What salary do you expect?','What is your availability?']){
    const answer=await draftCareerAnswer(store,{jobId:JOB.id,question},{generate:async()=>{calls++;return draft();}});assert.equal(answer.needsManual,true);assert.equal(answer.answer,'');assert.equal(answer.status,'draft');assert.ok(answer.gaps.length);
  }
  const guidance=await draftCareerAnswer(store,{jobId:JOB.id,question:'Why Sony?',guidance:'Mention my citizenship status.'},{generate:async()=>{calls++;return draft();}});assert.equal(guidance.needsManual,true);assert.equal(calls,0);
});

test('draft source citations are checked and missing evidence stays visible as a gap',async t=>{
  const store=(await database(t)).forUser('citations');await seed(store);const response=draft();response.value.evidence=[{source:'resume',quote:'Invented claim that is not in the source.'},{source:'other',quote:'Unknown source'}];
  const answer=await draftCareerAnswer(store,{jobId:JOB.id,question:'Describe my experience?'},{generate:async()=>response});assert.equal(answer.evidence.length,1);assert.equal(answer.evidence[0].verified,false);assert.ok(answer.gaps.some(g=>/could not be matched/.test(g)));assert.ok(answer.gaps.some(g=>/No exact resume or student-guidance evidence/.test(g)));
});

test('unowned jobs/answers and missing resumes cannot be accessed or modified across tenants',async t=>{
  const db=await database(t),a=db.forUser('a'),b=db.forUser('b');await seed(a);const answer=await saveCareerAnswer(a,{jobId:JOB.id,question:'Why Sony?',answer:'My own explanation.'});
  await assert.rejects(draftCareerAnswer(b,{jobId:JOB.id,question:'Why Sony?'},{generate:async()=>{throw new Error('must not call');}}),{status:404});
  await assert.rejects(saveCareerAnswer(b,{id:answer.id,answer:'Unauthorized change'}),{status:404});
  await b.put('jobs',JOB.id,JOB);await assert.rejects(draftCareerAnswer(b,{jobId:JOB.id,question:'Why Sony?'}),{status:400});
  assert.equal((await a.get('applicationAnswers',answer.id)).answer,'My own explanation.');assert.equal((await b.all('applicationAnswers')).length,0);
});

test('manual answers need no resume or model, are bounded, reviewed, and idempotent',async t=>{
  const store=(await database(t)).forUser('write');await store.put('jobs',JOB.id,JOB);
  const input={jobId:JOB.id,question:'Why Sony?',answer:'I enjoy building tools for creative teams.'};
  const first=await saveCareerAnswer(store,input),second=await saveCareerAnswer(store,input);assert.equal(first.id,second.id);assert.equal(first.status,'reviewed');assert.equal(first.method,'student-written');assert.equal(first.needsManual,false);assert.equal((await store.all('applicationAnswers')).length,1);assert.equal((await store.all('metrics')).length,0);
  for(const patch of [{...input,answer:''},{...input,answer:'x'.repeat(8001)},{...input,answer:12},{...input,question:'No'},{...input,userId:'other'}])await assert.rejects(saveCareerAnswer(store,patch),{status:400});
  await assert.rejects(saveCareerAnswer(store,{id:first.id,jobId:'another',answer:'Different'}),{status:400});
});

test('student review keeps original citations only for the unchanged generated answer',async t=>{
  const store=(await database(t)).forUser('confirm');await seed(store);const answer=await draftCareerAnswer(store,{jobId:JOB.id,question:'Why Sony?'},{generate:async()=>draft()});
  const confirmed=await saveCareerAnswer(store,{id:answer.id,answer:answer.answer});assert.equal(confirmed.method,'student-reviewed');assert.equal(confirmed.evidence.length,2);assert.equal(confirmed.status,'reviewed');
  const edited=await saveCareerAnswer(store,{id:answer.id,answer:'An entirely different answer I wrote.'});assert.equal(edited.method,'student-written');assert.deepEqual(edited.evidence,[]);assert.equal(edited.draft,answer.draft);assert.match(edited.note,/not independently verified/);
});

test('invalid, sensitive, or stale model answers are not persisted',async t=>{
  const store=(await database(t)).forUser('bad-model');await seed(store);
  for(const value of [{answer:'',evidence:[],gaps:[]},{answer:'x'.repeat(8001),evidence:[],gaps:[]},{answer:'yes',evidence:'not-an-array',gaps:[]},{answer:'I am a veteran.',evidence:[],gaps:[]}])await assert.rejects(draftCareerAnswer(store,{jobId:JOB.id,question:'Why Sony?'},{generate:async()=>({value})}),{status:502});
  await assert.rejects(draftCareerAnswer(store,{jobId:JOB.id,question:'Why Sony?'},{generate:async()=>{await store.put('jobs',JOB.id,{...JOB,description:'A changed posting'});return draft();}}),{status:409});assert.equal((await store.all('applicationAnswers')).length,0);
});
