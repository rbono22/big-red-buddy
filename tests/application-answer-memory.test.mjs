import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {draftCareerAnswer} from '../lib/career.mjs';
import {officialCompanyContext} from '../lib/company-context.mjs';
import {canRememberApplicationAnswer,isCompanyMotivationQuestion,saveApplicationAnswerMemory,suggestSavedApplicationAnswer,generateCompanyMotivation,listApplicationAnswerMemory,deleteApplicationAnswerMemory} from '../lib/application-answer-memory.mjs';

const RESUME={name:'Resume.pdf',file:'private-file',text:'Built an inventory forecasting tool using Python.\nLed user interviews for a campus product.\nWork authorization: private-declaration'};
const JOB={id:'splunk',company:'Splunk',title:'Product Analyst',location:'New York',description:'Build forecasting tools and study customer needs.'};
const OTHER={id:'ramp',company:'Ramp',title:'Product Analyst',location:'New York',description:'Build financial tools and study business needs.'};
const FIELD={key:'years',label:'How many years of Python experience do you have?',type:'radio',options:['0–2','3–5','6+'],required:true};
async function setup(t){
 const dir=await mkdtemp(path.join(tmpdir(),'brb-answer-memory-'));let db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 const a=db.forUser('alice'),b=db.forUser('bob');
 for(const store of [a,b]){await store.put('documents','resume',RESUME);await store.put('jobs',JOB.id,JOB);await store.put('jobs',OTHER.id,OTHER);}
 return {a,b,db,reopen:async()=>{await db.close();db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});return db.forUser('alice');}};
}
const input=(extra={})=>({field:FIELD,job:JOB,value:'3–5',source:'student',...extra});

test('explicit saved experience answers survive restart and relink without crossing student accounts',async t=>{
 const s=await setup(t),record=await saveApplicationAnswerMemory(s.a,input());assert.equal(record.scope,'global');
 assert.equal(await suggestSavedApplicationAnswer(s.b,{field:FIELD,job:JOB}),null);
 const a=await s.reopen();await a.put('secrets','telegram',{chatId:'replacement-chat'});
 const suggestion=await suggestSavedApplicationAnswer(a,{field:{...FIELD,key:'different-key',label:'  How many years of Python experience do you have? * '},job:OTHER});
 assert.equal(suggestion.value,'3–5');assert.equal(suggestion.reviewed,false);assert.equal(suggestion.source,'saved application answer');assert.equal(suggestion.scope,'global');
});

test('matching preserves exact choices, negation, numbers, types and maximum lengths',async t=>{
 const s=await setup(t);await saveApplicationAnswerMemory(s.a,input());
 for(const field of [{...FIELD,options:['0–2','3–5 years','6+']},{...FIELD,options:['3–5','0–2','6+']},{...FIELD,label:FIELD.label.replace('Python','Java')},{...FIELD,label:FIELD.label.replace('do you have','do you not have')},{...FIELD,type:'select'},{...FIELD,maxLength:2}])assert.equal(await suggestSavedApplicationAnswer(s.a,{field,job:JOB}),null);
});

test('Why Splunk never reuses at Ramp and role-specific wording does not cross roles',async t=>{
 const s=await setup(t),field={key:'why',label:'Why this company?',type:'textarea',options:[]};
 const saved=await saveApplicationAnswerMemory(s.a,input({field,value:'Splunk’s focus on forecasting connects with my Python work.',source:'approved-ai'}));assert.equal(saved.scope,'company');
 assert.ok(await suggestSavedApplicationAnswer(s.a,{field,job:JOB}));assert.equal(await suggestSavedApplicationAnswer(s.a,{field,job:OTHER}),null);
 await saveApplicationAnswerMemory(s.a,input({field,value:'I want the Product Analyst role at Splunk because it connects with my Python work.'}));
 const different={...JOB,id:'splunk-manager',title:'Engineering Manager'};await s.a.put('jobs',different.id,different);
 // A separate, company-scoped response may still match. Replace it with a
 // role-only memory fixture to establish the boundary independently.
 await s.a.delete('applicationAnswerMemory',saved.id);
 assert.equal(await suggestSavedApplicationAnswer(s.a,{field,job:different}),null);
});

test('company-specific text in an otherwise generic experience answer remains scoped',async t=>{
 const s=await setup(t),field={key:'skills',label:'Describe your Python experience.',type:'textarea',options:[]};
 const record=await saveApplicationAnswerMemory(s.a,input({field,value:'My Python work prepares me to contribute to Splunk.'}));assert.equal(record.scope,'role');
 assert.equal(await suggestSavedApplicationAnswer(s.a,{field,job:OTHER}),null);
});

test('resume changes, source-description changes, and a later month invalidate stale answers',async t=>{
 const s=await setup(t),record=await saveApplicationAnswerMemory(s.a,input());
 await s.a.put('documents','resume',{...RESUME,text:RESUME.text+'\nA new role.'});assert.equal(await suggestSavedApplicationAnswer(s.a,{field:FIELD,job:JOB}),null);
 await s.a.put('documents','resume',RESUME);await s.a.put('applicationAnswerMemory',record.id,{...record,asOfMonth:'2000-01'});assert.equal(await suggestSavedApplicationAnswer(s.a,{field:FIELD,job:JOB}),null);
 const field={key:'why',label:'Why Splunk?',type:'textarea',options:[]};await saveApplicationAnswerMemory(s.a,input({field,value:'I value Splunk’s focus on forecasting.'}));
 const job={...JOB,description:'Different work and company priorities.'};await s.a.put('jobs',JOB.id,job);assert.equal(await suggestSavedApplicationAnswer(s.a,{field,job}),null);
});

test('unapproved AI, sensitive facts, legal declarations, unknown choices and unsupported widgets cannot be remembered',async t=>{
 const s=await setup(t);
 await assert.rejects(saveApplicationAnswerMemory(s.a,input({source:'ai-draft'})),{status:400});
 for(const label of ['Gender','Disability status','Veteran status','Are you legally authorized to work here?','Will you require sponsorship?','I certify my answers are accurate','I agree to the terms','When are you available to start?','Salary expectations','Current employer','Cover letter']){
  const field={...FIELD,label};assert.equal(canRememberApplicationAnswer(field),false);await assert.rejects(saveApplicationAnswerMemory(s.a,input({field})),{status:400});
 }
 for(const field of [{...FIELD,multiple:true},{...FIELD,type:'consent'},{...FIELD,type:'file'},{...FIELD,profileField:'fullName'},{...FIELD,options:['Yes, I agree','No']},{...FIELD,label:'Choose one',options:['Male','Female','Non-binary']},{...FIELD,label:'Choose one',options:['Asian','White','Black']}])assert.equal(canRememberApplicationAnswer(field),false);
 await assert.rejects(saveApplicationAnswerMemory(s.a,input({value:'Different option'})),{status:400});assert.equal((await s.a.all('applicationAnswerMemory')).length,0);
});

test('stale supplied resume and employer context cannot read or overwrite memories',async t=>{
 const s=await setup(t);await saveApplicationAnswerMemory(s.a,input());
 const staleJob={...JOB,title:'Changed title'};assert.equal(await suggestSavedApplicationAnswer(s.a,{field:FIELD,job:staleJob}),null);
 assert.equal(await suggestSavedApplicationAnswer(s.a,{field:FIELD,job:JOB,resume:{...RESUME,file:'old'}}),null);
 await assert.rejects(saveApplicationAnswerMemory(s.a,input({job:staleJob})),{status:409});
 await assert.rejects(saveApplicationAnswerMemory(s.a,input({resumeHash:'stale-hash'})),{status:409});
 const hash=createHash('sha256').update(RESUME.file).digest('hex');await saveApplicationAnswerMemory(s.a,input({resumeHash:hash}));
});

test('account deletion removes the memory through the existing tenant deletion path',async t=>{
 const s=await setup(t);await saveApplicationAnswerMemory(s.a,input());await s.db.deleteStudent('alice');
 assert.equal(await s.db.isDeleted('alice'),true);await assert.rejects(s.a.all('applicationAnswerMemory'));
 assert.equal((await s.b.all('applicationAnswerMemory')).length,0);
});

test('private management lists scope and refresh status and can delete only the student’s own answer',async t=>{
 const s=await setup(t),record=await saveApplicationAnswerMemory(s.a,input()),rows=await listApplicationAnswerMemory(s.a);
 assert.equal(rows.length,1);assert.equal(rows[0].id,record.id);assert.equal(rows[0].needsRefresh,false);assert.match(rows[0].scopeExplanation,/same question/);assert.equal(rows[0].resumeBinding,undefined);assert.equal(rows[0].roleTitle,JOB.title);assert.equal((await listApplicationAnswerMemory(s.b)).length,0);
 await assert.rejects(deleteApplicationAnswerMemory(s.b,record.id),{status:404});await assert.rejects(deleteApplicationAnswerMemory(s.a,'../other'),{status:400});
 await s.a.put('documents','resume',{...RESUME,text:RESUME.text+'\nNew experience.'});assert.equal((await listApplicationAnswerMemory(s.a))[0].needsRefresh,true);
 assert.deepEqual(await deleteApplicationAnswerMemory(s.a,record.id),{deleted:true,id:record.id});assert.equal((await listApplicationAnswerMemory(s.a)).length,0);
});

const draft=(job=JOB)=>({value:{answer:`My Python forecasting work connects with ${job.company} and its focus on ${job.description.toLowerCase()}`,evidence:[{source:'resume',quote:'Built an inventory forecasting tool using Python.'},{source:'job',quote:job.description}],gaps:[]}});
test('company motivation uses the current company and resume, with verified evidence and no automatic memory',async t=>{
 const s=await setup(t);await s.a.put('career','profile',{fullName:'PRIVATE_PROFILE',workAuthorizationUS:'yes',veteranStatus:'veteran'});let prompt;
 const result=await generateCompanyMotivation(s.a,{job:JOB,question:'Why Splunk?'},{generate:async p=>{prompt=p;return draft();}});
 assert.equal(result.reviewed,false);assert.equal(result.needsManual,false);assert.equal(result.source,'AI draft for this employer');assert.ok(result.evidence.every(e=>e.verified));
 assert.match(prompt,/Company values.*only be stated when explicitly supported/s);assert.match(prompt,/Splunk/);assert.doesNotMatch(prompt,/PRIVATE_PROFILE|private-declaration|private-file/);
 assert.equal((await s.a.all('applicationAnswerMemory')).length,0);
 const other=await generateCompanyMotivation(s.a,{job:OTHER,question:'Why Ramp?'},{generate:async p=>{assert.match(p,/Ramp/);assert.doesNotMatch(p,/Splunk/);return draft(OTHER);}});assert.match(other.answer,/Ramp/);
});

test('official employer values supplement role and resume evidence and keep their attribution',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-11-13T04:00:00Z'));
 const s=await setup(t),context=officialCompanyContext('Splunk'),quote=context.sources[0].summaries[1],response=draft();response.value.evidence.push({source:'job',quote});
 response.value.answer+=' Splunk’s emphasis on openness and teamwork also appeals to me.';
 const result=await generateCompanyMotivation(s.a,{job:JOB,question:'Why Splunk?'},{generate:async prompt=>{assert.match(prompt,/OFFICIAL EMPLOYER CONTEXT/);assert.ok(prompt.includes(quote));assert.ok(prompt.includes(context.sources[0].url));assert.doesNotMatch(prompt,/Ramp encourages|Stripe’s operating/);return response;}});
 assert.equal(result.needsManual,false);const evidence=result.evidence.find(e=>e.source==='company');assert.equal(evidence.company,'Splunk');assert.equal(evidence.url,context.sources[0].url);assert.equal(evidence.checkedAt,context.sources[0].checkedAt);assert.equal(evidence.verified,true);assert.equal(result.companyContext.company,'Splunk');assert.deepEqual(await s.a.get('jobs',JOB.id),JOB);
});

test('official context never replaces the selected role or leaks to a different employer',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-11-13T04:00:00Z'));
 const s=await setup(t),splunk=officialCompanyContext('Splunk'),ramp=officialCompanyContext('Ramp');
 for(const kind of ['other-company','missing-role']){
  const response=draft();response.value.evidence.push({source:'job',quote:(kind==='other-company'?ramp:splunk).sources[0].summaries[0]});if(kind==='missing-role')response.value.evidence.splice(1,1);
  const result=await generateCompanyMotivation(s.a,{job:JOB,question:'Why Splunk?'},{generate:async()=>response});assert.equal(result.needsManual,true);assert.equal(result.answer,'');
 }
 const unknown={...JOB,id:'splunk-labs',company:'Splunk Labs'};await s.a.put('jobs',unknown.id,unknown);
 const result=await generateCompanyMotivation(s.a,{job:unknown,question:'Why Splunk Labs?'},{generate:async prompt=>{assert.ok(!prompt.includes(splunk.sources[0].summaries[0]));return draft(unknown);}});assert.equal(result.companyContext,null);assert.equal(result.needsManual,false);
});

test('changed or expired official evidence invalidates remembered employer-specific answers',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-11-13T04:00:00Z'));
 const s=await setup(t),field={key:'why',label:'Why Splunk?',type:'textarea',options:[]};
 const saved=await saveApplicationAnswerMemory(s.a,input({field,value:'Splunk’s focus on resilient digital systems connects with my analytics experience.',source:'approved-ai'}));assert.ok(await suggestSavedApplicationAnswer(s.a,{field,job:JOB}));
 await s.a.put('applicationAnswerMemory',saved.id,{...saved,officialContextBinding:'older-source'});assert.equal(await suggestSavedApplicationAnswer(s.a,{field,job:JOB}),null);assert.equal((await listApplicationAnswerMemory(s.a))[0].needsRefresh,true);
 await s.a.put('applicationAnswerMemory',saved.id,saved);t.mock.method(Date,'now',()=>Date.parse('2027-06-01T00:00:00Z'));assert.equal(await suggestSavedApplicationAnswer(s.a,{field,job:JOB}),null);
});

test('motivation generation does not offer unsupported evidence or an answer without both sources',async t=>{
 for(const kind of ['unverified','missing-resume','too-long','title-only']){
  const s=await setup(t),value=draft().value;
  if(kind==='unverified')value.evidence[1].quote='A made-up company value.';
  if(kind==='missing-resume')value.evidence=value.evidence.slice(1);
  if(kind==='too-long')value.answer='x'.repeat(2100);
  if(kind==='title-only')value.evidence[1].quote=JOB.title;
  const result=await generateCompanyMotivation(s.a,{job:JOB,question:'Why Splunk?'},{generate:async()=>({value})});assert.equal(result.answer,'');assert.equal(result.needsManual,true);assert.equal((await s.a.all('applicationAnswerMemory')).length,0);
 }
});

test('explicit regeneration cannot inherit an older generic draft and stable worker IDs are idempotent',async t=>{
 const s=await setup(t);await draftCareerAnswer(s.a,{jobId:JOB.id,question:'Why Splunk?'},{generate:async()=>draft()});let calls=0;
 const options={generate:async()=>{calls++;return draft();}};
 await generateCompanyMotivation(s.a,{job:JOB,question:'Why Splunk?'},options);await generateCompanyMotivation(s.a,{job:JOB,question:'Why Splunk?'},options);assert.equal(calls,2);
 const first=await generateCompanyMotivation(s.a,{job:JOB,question:'Why Splunk?'},{...options,id:'same-worker'}),second=await generateCompanyMotivation(s.a,{job:JOB,question:'Why Splunk?'},{...options,id:'same-worker'});assert.equal(first.id,second.id);assert.equal(calls,3);
});

test('motivation requires a recognized employer question and a current owned posting',async t=>{
 const s=await setup(t);assert.equal(isCompanyMotivationQuestion('Why do you want to work at Splunk?',JOB),true);assert.equal(isCompanyMotivationQuestion('What interests you about our company?',JOB),true);assert.equal(isCompanyMotivationQuestion('What is your citizenship?',JOB),false);
 let calls=0;const options={generate:async()=>{calls++;return draft();}};
 await assert.rejects(generateCompanyMotivation(s.a,{job:JOB,question:'What is your citizenship?'},options),{status:400});
 await assert.rejects(generateCompanyMotivation(s.a,{job:{...JOB,id:'not-owned'},question:'Why Splunk?'},options),{status:400});assert.equal(calls,0);
 await assert.rejects(generateCompanyMotivation(s.a,{job:JOB,question:'Why Splunk?'},{generate:async()=>{await s.a.put('jobs',JOB.id,{...JOB,description:'Changed posting during generation.'});return draft();}}),{status:409});
});
