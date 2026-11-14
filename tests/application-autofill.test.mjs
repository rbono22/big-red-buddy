import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareStandaloneAutofill,standaloneApplicationURL} from '../lib/application-autofill.mjs';
import {getCareerProfile,saveCareerProfile} from '../lib/career.mjs';
import {rememberCommonAnswer} from '../lib/application-answer-memory.mjs';

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const url='https://careers.example.org/openings/growth/apply?ref=student#application';
const lever='https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply';
const field=(key,label,type='text',extra={})=>({key,label,type,required:false,...extra});
function store(){const rows=new Map();return {userId:'test-student',get:async(b,k)=>structuredClone(rows.get(b+':'+k)||null),put:async(b,k,v)=>rows.set(b+':'+k,structuredClone(v)),all:async b=>[...rows].filter(([k])=>k.startsWith(b+':')).map(([,v])=>structuredClone(v)),dump:()=>structuredClone([...rows])};}
async function fixture(){
 const s=store();await saveCareerProfile(s,{fullName:'Alex Example',firstName:'Alex',lastName:'Example',email:'alex@example.edu',phone:'+1 555 010 0100',location:'New York, NY',currentCompany:'Example Co',workAuthorizationUS:'yes',sponsorship:'no',veteranStatus:'non_veteran',recruitingSMS:'no'});
 await s.put('documents','resume',{name:'Resume.pdf',file:Buffer.from('%PDF-1.7\nsynthetic fixture').toString('base64'),text:'Alex Example. Built product dashboards.'});
 return s;
}
function readonly(s){return {...s,put:()=>assert.fail('Autofill must never save'),delete:()=>assert.fail('Autofill must never delete'),compareAndSet:()=>assert.fail('Autofill must never mutate')};}
async function existing(s,{status='collecting'}={}){
 const job={id:'job',title:'Analyst',company:'Example',applyUrl:lever,description:'Build product dashboards.'};await s.put('jobs','job',job);
 const a={id:'app',jobId:'job',title:job.title,company:job.company,url:lever,status,revision:2,profileHash:hash(await getCareerProfile(s)),resumeHash:hash((await s.get('documents','resume')).file),form:{fields:[field('oldname','Full name'),field('oldwhy','Why this role?','textarea'),field('oldskip','Phone')]},answers:{oldname:{value:'Alex E.',reviewed:true},oldwhy:{value:'I have relevant dashboard experience.',reviewed:true},oldskip:{value:null,source:'student',reviewed:true}},...(status==='uncertain'?{submitAttemptAt:'2026-11-13T02:00:00Z'}:{})};
 await s.put('liveApplications','app',a);return {job,a};
}
test('standalone generic HTTPS page fills recognized saved facts and PDF without Telegram or any write',async()=>{
 const s=await fixture(),before=s.dump();
 const fields=[field('field-0','Full name'),field('field-1','Email','email'),field('field-2','Current location'),field('_systemfield_resume','Resume/CV','file',{document:'resume',controlName:'resume',accept:'.pdf'}),field('unknown','How did you hear about us?')];
 const result=await prepareStandaloneAutofill(readonly(s),{url,title:'Growth job',company:'Example',fields},{now:1000});
 assert.equal(result.mode,'standalone');assert.equal(result.url,url);assert.equal(result.expiresAt,301000);assert.equal(result.answers['field-0'].value,'Alex Example');assert.equal(result.answers['field-1'].value,'alex@example.edu');assert.equal(result.answers['field-2'].value,'New York, NY');assert.equal(result.documents.resume.file,(await s.get('documents','resume')).file);assert.equal(result.answers.unknown,undefined);assert.deepEqual(result.omitted,['How did you hear about us?']);assert.deepEqual(s.dump(),before);assert.equal(result.jobId,undefined);
});
test('unsafe target schemes, credentials, local addresses, and BRB are rejected',()=>{
 for(const target of ['http://careers.example.org','https://localhost/a','https://10.0.0.1/a','https://127.1/a','https://[::1]/a','https://jobs.internal/a','https://jobs.local/a','https://user:pass@careers.example.org','https://careers.example.org:8443','file:///tmp/a','data:text/html,hi','https://app.bigredbuddy.com/form','https://localhost.'])assert.throws(()=>standaloneApplicationURL(target),{status:400},target);
 assert.equal(standaloneApplicationURL(url),url);
});
test('Harvey legal and preferred name fields use the saved applicant names without filling reference names',async()=>{
 const s=await fixture(),fields=[field('legal','Legal First and Last Name*'),field('first','Preferred First Name*'),field('last','Preferred Last Name*'),field('amp','Legal first & last name (required)'),field('reference','Reference legal first and last name'),field('contact','Emergency contact preferred last name')];
 const result=await prepareStandaloneAutofill(readonly(s),{url,fields});
 assert.deepEqual(result.answers,{legal:{value:'Alex Example'},first:{value:'Alex'},last:{value:'Example'},amp:{value:'Alex Example'}});
 await saveCareerProfile(s,{lastName:''});
 assert.equal((await prepareStandaloneAutofill(readonly(s),{url,fields})).answers.last,undefined,'a missing surname is not guessed by splitting the full name');
});
test('untrusted metadata cannot request raw answers, profile hints, password controls, or unrelated attachments',async()=>{
 const s=await fixture();
 for(const input of [{url,fields:[field('one','Email')],token:'secret'},{url,fields:[field('one','Email','text',{profileField:'email'})]},{url,fields:[field('one','Email','password')]},{url,fields:[field('same','Name'),field('same','Email')]},{url,fields:[field('__proto__','Name')]},{url,fields:[field('one','Email','text',{value:'present'})]}])await assert.rejects(prepareStandaloneAutofill(s,input),{status:400});
 const result=await prepareStandaloneAutofill(s,{url,fields:[field('_systemfield_email','Reference email'),field('one','Name','text',{controlName:'password'}),field('_systemfield_resume','Bank statement','file',{document:'resume'}),field('secret','API key')]});
 assert.deepEqual(result.answers,{});assert.deepEqual(result.documents,{});
});
test('saved work authorization and demographics map to precise employer choices while new consent stays empty',async()=>{
 const s=await fixture();await s.put('career','demographics',{values:{gender:'female',race:['asian']},revision:2});
 const fields=[field('auth','Are you legally authorized to work in the United States?','radio',{options:['Yes','No'],optionValues:['true','false']}),field('sponsor','Will you now or in the future require sponsorship for employment visa status','radio',{options:['Yes','No','Not Applicable']}),field('gender','Gender','select',{options:['Male','Female','Prefer not to answer']}),field('veteran','Are you a veteran?','radio',{options:['Yes','No']}),field('uk','Are you legally authorized to work in the UK?','radio',{options:['Yes','No']}),field('consent','I agree to all terms','checkbox',{options:['Yes','No']}),field('sms','Recruiting updates by SMS','checkbox',{options:['Yes','No']})];
 const result=await prepareStandaloneAutofill(readonly(s),{url,fields});
 assert.equal(result.answers.auth.value,'Yes');assert.equal(result.answers.sponsor.value,'No');assert.equal(result.answers.gender.value,'Female');assert.equal(result.answers.veteran.value,'No');assert.equal(result.answers.uk,undefined);assert.equal(result.answers.consent,undefined);assert.equal(result.answers.sms.value,'No');assert.deepEqual(result.fields,fields);
});
test('pending demographic synchronization cannot cause writes or expose an ambiguous veteran value',async()=>{
 const s=await fixture();await s.put('career','demographics',{values:{gender:'female'},profileWrite:{id:'pending',value:'veteran',expected:'non_veteran'}});
 const result=await prepareStandaloneAutofill(readonly(s),{url,fields:[field('veteran','Are you a veteran?','radio',{options:['Yes','No']})]});assert.deepEqual(result.answers,{});
});
test('current accepted application answers and deliberate skips survive key changes, preserving uncertain status',async()=>{
 const s=await fixture(),{a}=await existing(s,{status:'uncertain'}),before=s.dump();
 const result=await prepareStandaloneAutofill(readonly(s),{url:lever,fields:[field('newname','Full name'),field('newwhy','Why this role?','textarea'),field('newphone','Phone')]});
 assert.equal(result.answers.newname.value,'Alex E.');assert.equal(result.answers.newwhy.value,'I have relevant dashboard experience.');assert.equal(result.answers.newphone,undefined);assert.equal(result.priorSubmissionUnconfirmed,true);assert.equal(result.jobId,'job');assert.deepEqual(await s.get('liveApplications','app'),a);assert.deepEqual(s.dump(),before);
});
test('DOM title binding is preserved when the saved job uses a different role title',async()=>{
 const s=await fixture();await existing(s);const result=await prepareStandaloneAutofill(s,{url:lever,title:'Apply for this job',company:'Untrusted page title',fields:[field('why','Why this role?','textarea')]});
 assert.equal(result.title,'Apply for this job');assert.equal(result.jobTitle,'Analyst');assert.equal(result.company,'Example');assert.equal(result.answers.why.value,'I have relevant dashboard experience.');
});
test('stale application answers are omitted and current saved profile is used',async()=>{
 const s=await fixture();await existing(s);await saveCareerProfile(s,{fullName:'Changed Name'});
 const result=await prepareStandaloneAutofill(s,{url:lever,fields:[field('name','Full name'),field('why','Why this role?','textarea')]});assert.equal(result.answers.name.value,'Changed Name');assert.equal(result.answers.why,undefined);
});
test('company/title claims from a different URL never expose saved employer answers or cover letters',async()=>{
 const s=await fixture();await existing(s);const result=await prepareStandaloneAutofill(s,{url,title:'Analyst',company:'Example',fields:[field('why','Why this role?','textarea'),field('letter','Cover letter','file',{document:'coverLetter'})]});assert.equal(result.jobId,undefined);assert.deepEqual(result.answers,{});assert.deepEqual(result.documents,{});
});
test('generic saved common answers reuse exact questions, never autopilot-generated or negated wording',async()=>{
 const s=await fixture(),question=field('q','Describe a project you are proud of.','textarea');await rememberCommonAnswer(s,{field:question,job:{},value:'I built a dashboard.',source:'student'});
 const result=await prepareStandaloneAutofill(s,{url,fields:[question,field('negative','Describe a project you are not proud of.','textarea')]});assert.equal(result.answers.q.value,'I built a dashboard.');assert.equal(result.answers.negative,undefined);
 await rememberCommonAnswer(s,{field:question,job:{},value:'Generated text',source:'AI answer (autopilot)'});assert.deepEqual((await prepareStandaloneAutofill(s,{url,fields:[question]})).answers,{});
});
test('closed job, invalid PDFs, and missing profile yield blanks without creating records',async()=>{
 const s=store();await s.put('documents','resume',{name:'Resume.pdf',file:Buffer.from('not pdf').toString('base64')});const result=await prepareStandaloneAutofill(readonly(s),{url,fields:[field('name','Full name'),field('resume','Resume','file',{document:'resume'})]});assert.deepEqual(result.answers,{});assert.deepEqual(result.documents,{});assert.equal((await s.all('liveApplications')).length,0);
});
test('submitted and in-progress applications expose duplicate warnings without changing their records',async()=>{
 for(const [status,key] of [['submitted','alreadySubmitted'],['submitting','submissionInProgress'],['queued','submissionInProgress']]){const s=await fixture();await existing(s,{status});const result=await prepareStandaloneAutofill(readonly(s),{url:lever,fields:[field('name','Full name')]});assert.equal(result[key],true);assert.equal((await s.get('liveApplications','app')).status,status);}
});
test('concurrent profile change aborts export',async()=>{
 const s=await fixture();let reads=0;const changing={...s,get:async(b,k)=>{const result=await s.get(b,k);if(b==='career'&&k==='profile'&&++reads>1)return {...result,fullName:'Changed'};return result;}};await assert.rejects(prepareStandaloneAutofill(changing,{url,fields:[field('name','Full name')]}),{status:409});
});
test('cover letter only exports with matching current résumé, employer, role, and signature',async()=>{
 const s=await fixture(),{a,job}=await existing(s),resume=await s.get('documents','resume'),profile=await getCareerProfile(s);
 const document={name:'Cover Letter.pdf',file:Buffer.from('%PDF-1.7\nletter fixture').toString('base64')};
 a.coverLetter={text:'I have relevant dashboard experience.',document,sourceBinding:hash({resume:resume.text,description:job.description}),jobBinding:hash({id:job.id,title:job.title,company:job.company,location:'',url:lever}),profileBinding:hash(profile.fullName)};
 await s.put('liveApplications','app',a);const fields=[field('cover','Cover letter','file',{document:'coverLetter'})];
 assert.equal((await prepareStandaloneAutofill(readonly(s),{url:lever,fields})).documents.coverLetter.file,document.file);
 await s.put('jobs','job',{...job,description:'A different description.'});assert.deepEqual((await prepareStandaloneAutofill(s,{url:lever,fields})).documents,{});
});
test('selected job résumé is used only on its matching URL and stale selections are not silently replaced',async()=>{
 const s=await fixture(),resume=await s.get('documents','resume'),job={id:'selected-job',title:'Analyst',company:'Example',applyUrl:lever,description:'Build product dashboards.'};await s.put('jobs',job.id,job);
 const digest=value=>hash(JSON.stringify(value)),document={name:'Tailored Resume.pdf',file:Buffer.from('%PDF-1.7\ntailored fixture').toString('base64')};
 const enhanced={id:'enhanced',jobId:job.id,status:'ready',reviewedAt:'2026-11-13T00:00:00Z',completedAt:'2026-11-13T00:00:00Z',document,sourceHash:digest([resume.name,resume.text,resume.updatedAt||'',digest(resume.file)]),jobHash:digest([job.title,job.company,job.description,job.applyUrl,job.url||''])};
 await s.put('resumeEnhancements','enhanced',enhanced);await s.put('resumeEnhancementJobs',job.id,{selectedId:'enhanced'});const fields=[field('resume','Resume','file',{document:'resume'})];
 assert.equal((await prepareStandaloneAutofill(readonly(s),{url:lever,fields})).documents.resume.file,document.file);
 assert.equal((await prepareStandaloneAutofill(readonly(s),{url,fields})).documents.resume.file,resume.file);
 await s.put('jobs',job.id,{...job,description:'Changed role.'});const stale=await prepareStandaloneAutofill(s,{url:lever,fields});assert.equal(stale.resumeNeedsRefresh,true);assert.deepEqual(stale.documents,{});
});
test('PDF-only documents are withheld from file fields that accept only other formats',async()=>{
 const s=await fixture(),result=await prepareStandaloneAutofill(s,{url,fields:[field('resume','Resume','file',{document:'resume',accept:'.docx'})]});assert.deepEqual(result.answers,{});assert.deepEqual(result.documents,{});
});
test('concurrent deletion of saved answer memory aborts export',async()=>{
 const s=await fixture(),question=field('q','Describe a project you are proud of.','textarea');await rememberCommonAnswer(s,{field:question,job:{},value:'I built a dashboard.',source:'student'});
 let reads=0;const changing={...s,all:async bucket=>bucket==='applicationCommonAnswers'&&++reads>1?[]:s.all(bucket)};
 await assert.rejects(prepareStandaloneAutofill(changing,{url,fields:[question]}),{status:409});
});
test('common-answer categories cannot change office schedule, relocation city, or compensation meaning',async()=>{
 const s=await fixture();
 for(const [before,after] of [['Are you comfortable working in the office 3 days each week in New York?','Are you comfortable working in the office 5 days each week in Seattle?'],['Are you willing to relocate to Boston?','Are you willing to relocate to Seattle?'],['What is your desired base salary?','What is your desired total compensation?']]){
  await rememberCommonAnswer(s,{field:field('old',before),job:{},value:'Yes',source:'student'});
  assert.deepEqual((await prepareStandaloneAutofill(s,{url,fields:[field('new',after)]})).answers,{});
 }
});
test('company-scoped common narratives and broad profile keywords cannot bypass exact identity and role bindings',async()=>{
 const s=await fixture(),{job}=await existing(s),question=field('why','Why this role?','textarea');
 await rememberCommonAnswer(s,{field:question,job,value:'An answer for a different role here.',source:'student'});
 const app=await s.get('liveApplications','app');await s.put('liveApplications','app',{...app,answers:{}});
 await saveCareerProfile(s,{linkedin:'https://www.linkedin.com/in/alex-example'});
 const result=await prepareStandaloneAutofill(s,{url:lever,fields:[question,field('ref','Your reference’s LinkedIn profile')]});assert.deepEqual(result.answers,{});
});
test('quick-application accepted answers are invalidated by changed role description or location',async()=>{
 for(const patch of [{description:'Now a different responsibility.'},{location:'Seattle, WA'}]){
  const s=await fixture(),{a,job}=await existing(s),resume=await s.get('documents','resume');
  await s.put('liveApplications','app',{...a,coverLetterSourceHash:hash({resume:resume.text,description:job.description}),quickJobHash:hash({id:job.id,title:job.title,company:job.company,location:'',url:lever})});
  await s.put('jobs','job',{...job,...patch});const result=await prepareStandaloneAutofill(s,{url:lever,fields:[field('why','Why this role?','textarea')]});assert.deepEqual(result.answers,{});
 }
});
