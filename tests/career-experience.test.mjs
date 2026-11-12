import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {analyzeCareerExperience,readCareerExperience,saveCareerExperience,jobExperienceFit} from '../lib/career-experience.mjs';

const NOW=Date.parse('2026-11-10T18:00:00Z');
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'brf-experience-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});return {db,store:db.forUser('alice'),other:db.forUser('bob')};}
const role=(title,dates,type='Full-time',extra={})=>({title,employer:'Example Co',kind:'employment',employmentType:type==='Full-time'?'full-time':'unknown',typeEvidence:type,dateEvidence:dates,evidence:`${title} · Example Co\n${type}\n${dates}`,startMonth:'2020-01',endMonth:'2020-12',...extra});
async function seed(store,roles,extra={}){await store.put('documents','resume',{name:'Synthetic resume.pdf',text:['Alex Example',...roles.map(row=>row.evidence),'Work authorization: PRIVATE_DECLARATION'].join('\n\n'),file:'SYNTHETIC_PDF_BYTES',updatedAt:'2026-11-10T18:00:00Z',...extra});}
const analyze=(store,roles,options={})=>analyzeCareerExperience(store,{now:NOW,generate:async()=>({value:{roles},metrics:{model:'synthetic',ms:20,inputTokens:80,outputTokens:40,prompt:'PRIVATE_PROMPT'}}),...options});
const ready=months=>({status:'ready',stale:false,analyzed:true,totalMonths:months,totalYears:months/12});

test('explicit full-time intervals form an inclusive union; overlapping jobs/promotions and duplicates do not double count',async t=>{
 const {store}=await fixture(t),roles=[role('Analyst','January 2020 – December 2020'),role('Senior Analyst','Jun 2020 – Jun 2021','Full-time',{startMonth:'2020-06',endMonth:'2021-06'}),role('Intern','Jan 2019 – Dec 2019','Full-time internship',{startMonth:'2019-01',endMonth:'2019-12'})];await seed(store,roles);
 const result=await analyze(store,[...roles,roles[0]]);assert.equal(result.status,'ready');assert.equal(result.totalMonths,18);assert.equal(result.totalYears,1.5);assert.equal(result.roles.length,3);assert.equal(result.excluded.length,1);assert.equal(result.roles.find(row=>row.title==='Intern').employmentType,'internship');assert.equal(result.roles.find(row=>row.title==='Intern').included,false);assert.match(result.warnings.join(' '),/not a precise day-level/);
 const metrics=await store.all('metrics');assert.equal(metrics.length,1);assert.equal(metrics[0].task,'experience analysis');assert.equal(metrics[0].prompt,undefined);
});

test('the model receives only owned professional resume text, never saved profile or demographic answers',async t=>{
 const {store,other}=await fixture(t),roles=[role('Analyst','Jan 2020 - Dec 2020')];await seed(store,roles);await store.put('career','profile',{fullName:'PRIVATE_PROFILE',workAuthorizationUS:'yes'});await store.put('career','demographics',{gender:'PRIVATE_DEMOGRAPHICS'});await seed(other,[role('Other student role','Jan 2020 - Dec 2020')],{name:'FOREIGN_RESUME'});
 let prompt;const result=await analyze(store,roles,{generate:async value=>{prompt=value;return {value:{roles}};}});for(const secret of ['PRIVATE_PROFILE','PRIVATE_DEMOGRAPHICS','PRIVATE_DECLARATION','SYNTHETIC_PDF_BYTES','FOREIGN_RESUME','Other student role'])assert.equal(prompt.includes(secret),false,secret);assert.match(prompt,/Analyst/);assert.equal(result.roles[0].evidence,roles[0].evidence);assert.equal((await readCareerExperience(other,{now:NOW})).analyzed,false);
});

test('unknown type, forty-hour work, and year-only dates remain reviewable; full-time education never counts',async t=>{
 const {store}=await fixture(t),roles=[role('Engineer','Jan 2020 - Dec 2020','40 hours per week'),role('Analyst','2018 – 2019','Full-time',{startMonth:'2018-01',endMonth:'2019-12'}),role('MBA','Jan 2024 - Dec 2024','Full-time student',{kind:'education',startMonth:'2024-01',endMonth:'2024-12'})];await seed(store,roles);const result=await analyze(store,roles);
 assert.equal(result.status,'needs-review');assert.equal(result.pending.length,2);assert.equal(result.totalMonths,0);assert.equal(result.roles.find(row=>row.title==='Engineer').employmentType,'unknown');assert.equal(result.roles.find(row=>row.title==='Analyst').startMonth,null);assert.equal(result.roles.find(row=>row.title==='MBA').employmentType,'other');assert.equal(jobExperienceFit({description:'Required: 8 years of professional experience.'},result).eligible,null);
});

test('part-time, contract and volunteer roles are excluded even when hours or full-time words appear',async t=>{
 const {store}=await fixture(t),roles=[role('Researcher','Jan 2020 - Dec 2020','Part-time'),role('Designer','Jan 2020 - Dec 2020','Full-time contract'),role('Volunteer','Jan 2020 - Dec 2020','Full-time volunteer')];await seed(store,roles);const result=await analyze(store,roles);assert.equal(result.status,'ready');assert.equal(result.totalMonths,0);assert.equal(result.excluded.length,3);assert.equal(result.pending.length,0);
});

test('type evidence about education or other workers does not classify the applicant; paid coordinator/manager titles stay distinct',async t=>{
 const {store}=await fixture(t),roles=[role('Analyst','Jan 2020 - Dec 2020','Full-time MBA student',{typeEvidence:'Full-time'}),role('Team Lead','Jan 2020 - Dec 2020','Mentored full-time interns',{typeEvidence:'full-time'}),role('Contract Manager','Jan 2020 - Dec 2020','Full-time'),role('Volunteer Coordinator','Jan 2020 - Dec 2020','Full-time')];await seed(store,roles);const result=await analyze(store,roles);assert.equal(result.status,'needs-review');assert.equal(result.pending.length,2);assert.equal(result.totalMonths,12);assert.equal(result.roles.find(row=>row.title==='Contract Manager').employmentType,'full-time');assert.equal(result.roles.find(row=>row.title==='Volunteer Coordinator').employmentType,'full-time');
});

test('supporting others, negated full-time status, and seeking work never establish completed full-time employment',async t=>{
 const {store}=await fixture(t);
 for(const line of ['Supported full-time analysts.','Not a full-time position.','Seeking full-time employment.','This was not classified as full-time work.','Looking for a full-time role.']){
  const row=role('Product Analyst','January 2020 – December 2021',line,{typeEvidence:'full-time',endMonth:'2021-12'});await seed(store,[row]);const result=await analyze(store,[row]);assert.equal(result.status,'needs-review',line);assert.equal(result.totalMonths,0,line);assert.equal(result.roles[0].employmentType,'unknown',line);assert.equal(result.pending.length,1,line);assert.equal(jobExperienceFit({description:'8 years of professional experience required.'},result).eligible,null,line);
 }
 for(const line of ['Full-time Product Analyst; supported teammates.','Full-time Product Analyst — managed forecasts.','Employment type: Full-time','Not remote but Full-time']){
  const row=role('Product Analyst','January 2020 – December 2021',line,{typeEvidence:'Full-time',endMonth:'2021-12'});await seed(store,[row]);const result=await analyze(store,[row]);assert.equal(result.status,'ready',line);assert.equal(result.totalMonths,24,line);assert.equal(result.roles[0].employmentType,'full-time',line);
 }
});

test('student confirmations can correct internship classification with retained source provenance and cannot add arbitrary roles',async t=>{
 const {store,other}=await fixture(t),roles=[role('Intern','Jan 2020 - Dec 2020','Full-time internship')];await seed(store,roles);const original=await analyze(store,roles),id=original.roles[0].id;
 const saved=await saveCareerExperience(store,{sourceHash:original.sourceHash,roles:[{id,employmentType:'full-time',startMonth:'2020-01',endMonth:'2020-12'}]},{now:NOW});assert.equal(saved.totalMonths,12);assert.equal(saved.roles[0].sourceEmploymentType,'internship');assert.equal(saved.roles[0].provenance,'student-confirmed');assert.deepEqual(saved.roles[0].overrides,['employmentType']);
 const repeated=await analyze(store,roles);assert.equal(repeated.totalMonths,12);assert.equal(repeated.roles[0].provenance,'student-confirmed');
 await assert.rejects(saveCareerExperience(store,{sourceHash:original.sourceHash,roles:[{id:'f'.repeat(32),employmentType:'full-time',startMonth:'2020-01',endMonth:'2020-12'}]}),{status:404});await assert.rejects(saveCareerExperience(other,{sourceHash:original.sourceHash,roles:[{id,employmentType:'full-time',startMonth:'2020-01',endMonth:'2020-12'}]}),{status:409});
});

test('strict corrections validate fields and merge concurrent changes to separate owned roles',async t=>{
 const {store}=await fixture(t),roles=[role('Engineer','Jan 2020 - Dec 2020','Not specified'),role('Designer','Jan 2021 - Dec 2021','Not specified',{startMonth:'2021-01',endMonth:'2021-12'})];await seed(store,roles);const original=await analyze(store,roles),patch=i=>({id:original.roles[i].id,employmentType:'full-time',startMonth:i?'2021-01':'2020-01',endMonth:i?'2021-12':'2020-12'});
 for(const bad of [{...patch(0),employmentType:'guess'},{...patch(0),startMonth:'2020'},{...patch(0),startMonth:'2021-01',endMonth:'2020-12'},{...patch(0),title:'Invented'},{...patch(0),endMonth:undefined}])await assert.rejects(saveCareerExperience(store,{sourceHash:original.sourceHash,roles:[bad]}),{status:400});
 await Promise.all([saveCareerExperience(store,{sourceHash:original.sourceHash,roles:[patch(0)]},{now:NOW}),saveCareerExperience(store,{sourceHash:original.sourceHash,roles:[patch(1)]},{now:NOW})]);const result=await readCareerExperience(store,{now:NOW});assert.equal(result.status,'ready');assert.equal(result.totalMonths,24);
});

test('present recalculates on reads using New York current month without model calls or future-month counting',async t=>{
 const {store}=await fixture(t),roles=[role('Current Engineer','November 2026 – Present','Full-time',{startMonth:'2026-11',endMonth:'present'}),role('Future Analyst','January 2027 – December 2027','Full-time',{startMonth:'2027-01',endMonth:'2027-12'})];await seed(store,roles);await analyze(store,roles);
 let result=await readCareerExperience(store,{now:Date.parse('2026-12-01T00:30:00Z')});assert.equal(result.asOfMonth,'2026-11');assert.equal(result.totalMonths,1);assert.equal(result.excluded.length,1);
 result=await readCareerExperience(store,{now:Date.parse('2026-12-01T05:01:00Z')});assert.equal(result.asOfMonth,'2026-12');assert.equal(result.totalMonths,2);
});

test('resume filename, PDF bytes and text updates invalidate estimates; in-flight stale extraction is not saved',async t=>{
 const {store}=await fixture(t),roles=[role('Analyst','Jan 2020 - Dec 2020')];await seed(store,roles);const original=await analyze(store,roles),resume=await store.get('documents','resume');
 for(const change of [{name:'New filename.pdf'},{file:'CHANGED_PDF'},{text:resume.text+'\nNew work'},{updatedAt:'later'}]){await store.put('documents','resume',{...resume,...change});const stale=await readCareerExperience(store,{now:NOW});assert.equal(stale.stale,true);assert.equal(stale.analyzed,true);assert.equal(stale.status,'needs-review');assert.equal(stale.totalMonths,null);assert.notEqual(stale.sourceHash,original.sourceHash);assert.equal(stale.analyzedSourceHash,original.sourceHash);}
 await seed(store,roles);await store.delete('career','experience');await assert.rejects(analyze(store,roles,{generate:async()=>{await store.put('documents','resume',{...resume,file:'DIFFERENT'});return {value:{roles}};}}),{status:409});assert.equal(await store.get('career','experience'),null);
});

test('unsupported evidence, reversed model date ranges and empty extraction never establish a zero-year history',async t=>{
 const {store}=await fixture(t),base=role('Analyst','Jan 2020 - Dec 2020');await seed(store,[base]);let result=await analyze(store,[{...base,evidence:'Invented source evidence'}]);assert.equal(result.status,'needs-review');assert.equal(result.totalMonths,0);assert.equal(result.roles.length,0);
 result=await analyze(store,[{...base,startMonth:'2020-12',endMonth:'2020-01'}]);assert.equal(result.status,'needs-review');assert.equal(result.pending.length,1);assert.equal(result.roles[0].startMonth,null);
 await assert.rejects(analyze(store,[],{generate:async()=>({value:{roles:'wrong'}})}),{status:502});
});

test('numeric month-year dates are supported but ambiguous day/month/year strings are not silently reinterpreted',async t=>{
 const {store}=await fixture(t),rows=[role('ISO Engineer','2020-01 – 2020-12'),role('Numeric Analyst','01/2021 – 12/2021','Full-time',{startMonth:'2021-01',endMonth:'2021-12'}),role('Ambiguous Analyst','01/02/2022 – 03/04/2022','Full-time',{startMonth:'2022-02',endMonth:'2022-04'})];await seed(store,rows);const result=await analyze(store,rows);assert.equal(result.totalMonths,24);assert.equal(result.status,'needs-review');const unclear=result.roles.find(row=>row.title==='Ambiguous Analyst');assert.equal(unclear.startMonth,null);assert.equal(unclear.endMonth,null);
});

test('missing resume and unanalysed resume return unknown totals without invoking the model',async t=>{
 const {store}=await fixture(t);let called=false;assert.equal((await analyze(store,[],{generate:async()=>{called=true;}})).status,'no-resume');assert.equal(called,false);
 await seed(store,[role('Analyst','Jan 2020 - Dec 2020')]);const result=await readCareerExperience(store,{now:NOW});assert.equal(result.status,'needs-review');assert.equal(result.analyzed,false);assert.equal(result.totalMonths,null);
});

test('short exact employer names and titles remain supported without matching inside another word',async t=>{
 const {store}=await fixture(t),row={...role('VP','Jan 2020 - Dec 2020'),employer:'EY',evidence:'VP · EY\nFull-time\nJan 2020 - Dec 2020'};await seed(store,[row]);const result=await analyze(store,[row]);assert.equal(result.status,'ready');assert.equal(result.totalMonths,12);assert.equal(result.roles[0].employer,'EY');
 const wrong=await analyze(store,[{...row,title:'V'}]);assert.equal(wrong.status,'needs-review');assert.equal(wrong.roles.length,0);
});

test('job comparison distinguishes required ranges, preferred experience, stretch allowance, and domain-specific uncertainty',()=>{
 let fit=jobExperienceFit({description:'Minimum Qualifications\n3–5 years of software engineering experience required.\nPreferred Qualifications\n7 years of experience in distributed systems.'},ready(48));assert.equal(fit.status,'within-range');assert.equal(fit.minimumRequired,3);assert.equal(fit.maximumRequired,5);assert.equal(fit.minimumPreferred,7);assert.equal(fit.domainSpecific,true);assert.match(fit.rationale,/do not establish that domain experience/);assert.match(fit.requiredExcerpt,/3–5 years/);
 fit=jobExperienceFit({description:'At least 6 years of professional experience required.'},ready(36),{stretchYears:3});assert.equal(fit.status,'stretch');assert.equal(fit.eligible,true);
 fit=jobExperienceFit({description:'At least 6 years of professional experience required.'},ready(36),{stretchYears:2});assert.equal(fit.status,'outside-range');assert.equal(fit.eligible,false);
 assert.equal(jobExperienceFit({description:'Preferred: five years of experience.'},ready(12)).status,'unknown');assert.equal(jobExperienceFit({description:'Required: 2 years of work experience.'},ready(120)).status,'within-range');assert.throws(()=>jobExperienceFit({},ready(12),{stretchYears:4}),{status:400});
 for(const heading of ['Preferred:','Preferred Skills','Nice to have:','Bonus points:']){const preferred=jobExperienceFit({description:`${heading}\n10 years of experience in distributed systems.`},ready(0));assert.equal(preferred.minimumRequired,null,heading);assert.equal(preferred.minimumPreferred,10);assert.equal(preferred.eligible,null);}
});

test('job parsing ignores company age, education durations, benefits and absent requirements without hard exclusion',()=>{
 for(const description of ['Our company has 20 years of experience serving customers.','We have 10 years of engineering experience.','Benefits\nAfter 3 years of service, extra paid leave.','Requirements\n18 years of age.\n4 years of college education.','Founded 15 years ago.','A four-year degree is preferred.','Join our experienced product team.']){const result=jobExperienceFit({description},ready(0));assert.equal(result.minimumRequired,null,description);assert.equal(result.eligible,null,description);}
 const zero=jobExperienceFit({description:'No prior experience is required.'},ready(0));assert.equal(zero.minimumRequired,0);assert.equal(zero.status,'within-range');
});

test('alternative education routes and unresolved student history do not become hard numeric exclusions',()=>{
 const alternative=jobExperienceFit({description:'Required: Bachelor degree and 5 years of experience or Master degree and 3 years of experience.'},ready(12));assert.equal(alternative.status,'unknown');assert.equal(alternative.eligible,null);assert.match(alternative.rationale,/alternative/i);
 for(const experience of [{...ready(0),status:'needs-review'},{...ready(0),stale:true},{...ready(0),analyzed:false},null]){const result=jobExperienceFit({description:'10 years of professional experience required.'},experience);assert.equal(result.status,'unknown');assert.equal(result.eligible,null);}
 const multiline=jobExperienceFit({description:'Required qualifications\nBachelor degree and 5 years of experience\nOR\nMaster degree and 3 years of experience'},ready(12));assert.equal(multiline.status,'unknown');assert.equal(multiline.eligible,null);
 assert.equal(jobExperienceFit({description:'Five or more years of professional experience required.'},ready(60)).minimumRequired,5);
});
