import test from 'node:test';
import assert from 'node:assert/strict';
import {startQuickApplication,startLiveApplication,executeLiveApplication,handleLiveApplicationAction,quickApplicationAnswers,quickApplicationJobFingerprint} from '../lib/live-applications.mjs';
import {saveCareerProfile} from '../lib/career.mjs';
import {editDemographics} from '../lib/demographics.mjs';

const URL='https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply';
const field=(key,label,type='text',required=true,profileField)=>({key,label,type,required,options:[],...(profileField?{profileField}:{})});
const BASE={title:'Product Manager',fields:[field('_systemfield_resume','Resume','file'),field('name','Full name','text',true,'fullName'),field('email','Email','email',true,'email'),field('phone','Phone','tel',true,'phone'),field('why','Why this company?','textarea',false)],consentText:''};
function memory(userId){const rows=new Map();return {userId,get:async(b,k)=>structuredClone(rows.get(b+':'+k)||null),put:async(b,k,v)=>rows.set(b+':'+k,structuredClone(v)),delete:async(b,k)=>rows.delete(b+':'+k),all:async b=>[...rows].filter(([k])=>k.startsWith(b+':')).map(([,v])=>structuredClone(v)),compareAndSet:async(b,k,old,next)=>{if(JSON.stringify(rows.get(b+':'+k)||null)!==JSON.stringify(old))return false;rows.set(b+':'+k,structuredClone(next));return true;}};}
async function setup(t,{form=BASE}={}){
 const prior={APPLICATION_BROWSER_ENABLED:process.env.APPLICATION_BROWSER_ENABLED,APP_ORIGIN:process.env.APP_ORIGIN,PILOT_SHEET_ID:process.env.PILOT_SHEET_ID};
 t.after(()=>{for(const [k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 process.env.APPLICATION_BROWSER_ENABLED='true';process.env.APP_ORIGIN='https://app.bigredbuddy.com';delete process.env.PILOT_SHEET_ID;
 const a=memory('alice'),b=memory('bob'),tasks=[],queue={enqueue:async(userId,type,payload,options)=>{const old=tasks.find(j=>j.options.idempotencyKey===options.idempotencyKey);if(old)return old;const row={id:String(tasks.length),userId,type,payload,options};tasks.push(row);return row;}};
 await a.put('secrets','telegram',{chatId:101,linkedAt:'link-a'});await b.put('secrets','telegram',{chatId:202,linkedAt:'link-b'});
 await a.put('jobs','role',{id:'role',title:form.title,company:'Example',url:URL});
 await a.put('documents','resume',{name:'Student.pdf',file:Buffer.from('%PDF-1.7 synthetic').toString('base64'),text:'Synthetic resume'});
 await saveCareerProfile(a,{fullName:'Example Student',email:'student@example.edu',phone:'+1 212 555 1234',recruitingSMS:'no',recruitingWhatsApp:'no'});
 const db={forUser:id=>id==='alice'?a:b},current=async()=>(await a.all('liveApplications'))[0];
 let analyses=0,drafts=0,submissions=0;
 const run=async(type,overrides={})=>executeLiveApplication(db,tasks.filter(j=>j.type===type).at(-1),{queue,inspect:async()=>structuredClone(form),analyze:async()=>{analyses++;throw Error('must not analyze');},draft:async()=>{drafts++;throw Error('must not draft');},submit:async args=>{await args.beforeSubmit();submissions++;return {confirmedAt:new Date().toISOString(),confirmation:'Application received'};},...overrides});
 return {a,b,db,queue,tasks,current,run,counts:()=>({analyses,drafts,submissions})};
}

test('Apply now uses saved facts, omits optional questions, submits once, and only reports an employer receipt',async t=>{
 const s=await setup(t);await startQuickApplication(s.a,s.queue,'role',1);await startQuickApplication(s.a,s.queue,'role',1);await startQuickApplication(s.a,s.queue,'role',2);
 assert.equal(s.tasks.filter(j=>j.type==='application-inspect').length,1);
 await s.run('application-inspect');const a=await s.current();assert.equal(a.mode,'quick');assert.equal(a.status,'queued');assert.equal(a.answers.name.value,'Example Student');assert.equal(a.answers.why.value,null);assert.equal(a.answers.why.source,'omitted optional field');assert.equal(a.answers._systemfield_resume.value,'Student.pdf');
 assert.equal(s.tasks.filter(j=>j.type==='application-submit').length,1);assert.equal(s.tasks.find(j=>j.type==='application-submit').options.maxAttempts,1);
 assert.doesNotMatch(s.tasks.filter(j=>j.type==='telegram-send').map(j=>j.payload.text).join('\n'),/Review your application|Ready to send|Submit to Example/);
 await s.run('application-submit');assert.equal((await s.current()).status,'submitted');assert.match(s.tasks.at(-1).payload.text,/Application received/);assert.deepEqual(s.counts(),{analyses:0,drafts:0,submissions:1});
 await s.run('application-submit');await startQuickApplication(s.a,s.queue,'role',3);assert.equal(s.tasks.filter(j=>j.type==='application-submit').length,1);assert.equal(s.counts().submissions,1);
});

test('required cover letter text is generated from the selected resume and role and submitted without review',async t=>{
 const cover=field('cover','Cover letter','textarea'),s=await setup(t,{form:{...BASE,fields:[...BASE.fields,cover]}});
 await s.a.put('jobs','role',{...(await s.a.get('jobs','role')),description:'Build analytics tools and collaborate with product teams.'});
 let generated=0,submitted;
 await startQuickApplication(s.a,s.queue,'role',1);
 await s.run('application-inspect',{generateCoverLetter:async input=>{
  generated++;assert.equal(input.job.description,'Build analytics tools and collaborate with product teams.');assert.equal(input.resume.text,'Synthetic resume');assert.equal(input.fullName,'Example Student');assert.deepEqual(input.fields,[cover]);assert.deepEqual(Object.keys(input).sort(),['fields','fullName','job','resume']);
  return {text:'Dear hiring team,\n\nI built analytics tools. Thank you for considering my application.',evidence:{resumeQuotes:['Synthetic resume']}};
 }});
 const a=await s.current();assert.equal(a.status,'queued');assert.equal(a.answers.cover.value,a.coverLetter.text);assert.match(a.answers.cover.source,/generated cover letter/);
 await s.run('application-submit',{submit:async args=>{submitted=args;await args.beforeSubmit();return {confirmation:'Application received',confirmedAt:new Date().toISOString()};}});
 assert.equal(submitted.answers.cover.value,a.coverLetter.text);assert.equal(submitted.coverLetter,undefined);assert.equal((await s.current()).status,'submitted');assert.equal(generated,1);
 assert.doesNotMatch(s.tasks.filter(j=>j.type==='telegram-send').map(j=>j.payload.text).join('\n'),/Review your application|Ready to send/);
 assert.match(s.tasks.at(-1).payload.text,/Cover letter: included/);
 const done=await s.current();await handleLiveApplicationAction(s.a,s.queue,{id:done.id,revision:done.revision,op:'cover-letter'},5);assert.match(s.tasks.at(-1).payload.text,/I built analytics tools/);
 await assert.rejects(handleLiveApplicationAction(s.b,s.queue,{id:done.id,revision:done.revision,op:'cover-letter'},6),/not available/);
});

test('required cover PDF is separate from the saved resume and generation is not repeated',async t=>{
 const s=await setup(t,{form:{...BASE,fields:[...BASE.fields,field('cover','Cover letter','file')]}}),document={name:'Cover Letter.pdf',file:Buffer.from('%PDF-1.7 synthetic cover').toString('base64')};let generated=0;
 await startQuickApplication(s.a,s.queue,'role',1);const inspect={generateCoverLetter:async()=>{generated++;return {text:'A grounded cover letter.',document};}};
 await s.run('application-inspect',inspect);await s.run('application-inspect',inspect);
 assert.equal((await s.current()).answers.cover.value,document.name);
 await s.run('application-submit',{submit:async args=>{assert.deepEqual(args.coverLetter,document);assert.notEqual(args.coverLetter.file,args.resume.file);await args.beforeSubmit();return {confirmation:'Application received',confirmedAt:new Date().toISOString()};}});
 assert.equal((await s.current()).status,'submitted');assert.equal(generated,1);
});

test('optional letters stay omitted and other missing facts prevent automatic letter generation',async t=>{
 for(const required of [false,true]){
  const form={...BASE,fields:[...BASE.fields,field('cover','Cover letter','textarea',required),...(required?[field('salary','Salary expectation')]:[])]},s=await setup(t,{form});let generated=0;
  await startQuickApplication(s.a,s.queue,'role',1);await s.run('application-inspect',{generateCoverLetter:async()=>{generated++;throw Error('should not generate');}});
  assert.equal(generated,0);assert.equal((await s.current()).status,required?'collecting':'queued');
  if(!required)assert.equal((await s.current()).answers.cover.value,null);
 }
});

test('failed, malformed, or over-limit cover letters never queue submission',async t=>{
 for(const kind of ['failure','empty','too-long','file-missing']){
  const s=await setup(t,{form:{...BASE,fields:[...BASE.fields,{...field('cover','Cover letter',kind==='file-missing'?'file':'textarea'),maxLength:40}]}});
  await startQuickApplication(s.a,s.queue,'role',1);await s.run('application-inspect',{generateCoverLetter:async()=>{
   if(kind==='failure')throw Object.assign(Error('private model detail'),{code:'COVER_LETTER_INVALID_OUTPUT'});
   return {text:kind==='empty'?'':kind==='too-long'?'x'.repeat(50):'Valid text but no file.'};
  }});
  assert.equal((await s.current()).status,'needs_attention');assert.equal(s.tasks.some(j=>j.type==='application-submit'),false);assert.doesNotMatch(s.tasks.at(-1).payload.text,/private model detail/);
 }
});

test('changing the resume text or role description during generation or before submission invalidates cover authorization',async t=>{
 for(const timing of ['generation','submission'])for(const source of ['resume','job']){
  const s=await setup(t,{form:{...BASE,fields:[...BASE.fields,field('cover','Cover letter','textarea')]}});
  const mutate=async()=>source==='resume'?s.a.put('documents','resume',{...(await s.a.get('documents','resume')),text:'Changed source text'}):s.a.put('jobs','role',{...(await s.a.get('jobs','role')),description:'Changed role description'});
  await startQuickApplication(s.a,s.queue,'role',1);await s.run('application-inspect',{generateCoverLetter:async()=>{if(timing==='generation')await mutate();return {text:'A grounded letter.'};}});
  if(timing==='submission'){await mutate();await s.run('application-submit');}
  assert.equal((await s.current()).status,'needs_attention');assert.equal(s.counts().submissions,0);assert.match((await s.current()).error,/changed/);
 }
});

test('a quick request authorized before cover-letter support cannot silently add generated content',async t=>{
 const s=await setup(t,{form:{...BASE,fields:[...BASE.fields,field('cover','Cover letter','textarea')]}});let generated=0;
 await startQuickApplication(s.a,s.queue,'role',1);const a=await s.current();delete a.coverLetterPolicy;await s.a.put('liveApplications',a.id,a);
 await s.run('application-inspect',{generateCoverLetter:async()=>{generated++;return {text:'Not authorized'};}});
 assert.equal(generated,0);assert.equal((await s.current()).status,'needs_attention');assert.equal(s.tasks.some(j=>j.type==='application-submit'),false);
});

test('required consent and experience are asked in Telegram without inferring answers',async t=>{
 const form={...BASE,fields:[...BASE.fields,field('years','Do you have a minimum of 4 years of product management experience?','radio'),field('consent','I agree to the employer terms','checkbox')]};form.fields.at(-2).options=['Yes','No'];form.fields.at(-1).options=['Yes','No'];
 const s=await setup(t,{form});await editDemographics(s.a,{gender:'male',veteranStatus:'non_veteran'});
 await startQuickApplication(s.a,s.queue,'role',1);await s.run('application-inspect');const a=await s.current();
 assert.equal(a.status,'collecting');assert.deepEqual(a.missingFields,form.fields.slice(-2).map(f=>f.label));assert.match(s.tasks.at(-1).payload.text,/minimum of 4 years/);assert.equal(a.answers.years,undefined);assert.equal(s.tasks.some(j=>j.type==='application-submit'),false);assert.deepEqual(s.counts(),{analyses:0,drafts:0,submissions:0});
 const buttons=s.tasks.at(-1).payload.replyMarkup.inline_keyboard.flat();assert.ok(buttons.some(b=>b.text==='Resume & Profile'));assert.ok(buttons.some(b=>b.text==='Continue in my browser'));
});

test('optional demographic and consent fields are omitted; explicit saved SMS/WhatsApp choices can be reused',()=>{
 const form={fields:[{...field('gender','Gender','radio',false),options:['Man','Woman']},{...field('marketing','I consent to marketing','checkbox',false),options:['Yes','No']},{...field('smsConsent','SMS updates','consent'),options:['Yes, text me','No, do not text me']},{...field('whatsAppConsent','WhatsApp updates','consent'),options:['Yes, contact me','No, do not contact me']}]};
 const result=quickApplicationAnswers(form,{recruitingSMS:'no',recruitingWhatsApp:'yes'},'Student.pdf');assert.deepEqual(result.missing,[]);assert.equal(result.answers.gender.value,null);assert.equal(result.answers.marketing.value,null);assert.equal(result.answers.smsConsent.value,'No, do not text me');assert.equal(result.answers.whatsAppConsent.value,'Yes, contact me');
 const missing=quickApplicationAnswers(form,{recruitingSMS:'unanswered',recruitingWhatsApp:'unanswered'},'Student.pdf');assert.deepEqual(missing.missing,['SMS updates','WhatsApp updates']);
});

test('quick application is tenant-scoped and cannot reuse a guided draft',async t=>{
 const s=await setup(t);await assert.rejects(startQuickApplication(s.b,s.queue,'role',1),/not supported/);
 await startLiveApplication(s.a,s.queue,'role',2);await startQuickApplication(s.a,s.queue,'role',3);
 assert.equal((await s.current()).mode,undefined);assert.equal(s.tasks.filter(j=>j.type==='application-inspect').length,1);assert.match(s.tasks.at(-1).payload.text,/already a guided application/);assert.equal(s.tasks.some(j=>j.type==='application-submit'),false);
});
test('required current company asks until explicitly saved, then Use saved profile resumes submission',async t=>{
 const form={...BASE,fields:[...BASE.fields,field('org','Current company','text',true,'currentCompany')]},s=await setup(t,{form});
 await startQuickApplication(s.a,s.queue,'role',1);await s.run('application-inspect');assert.equal((await s.current()).status,'collecting');assert.deepEqual((await s.current()).missingFields,['Current company']);assert.equal(s.counts().submissions,0);
 await saveCareerProfile(s.a,{currentCompany:'Student Example Company'});const current=await s.current();await handleLiveApplicationAction(s.a,s.queue,{id:current.id,revision:current.revision,op:'profile'},2);assert.equal((await s.current()).answers.org.value,'Student Example Company');await s.run('application-submit');assert.equal((await s.current()).status,'submitted');assert.deepEqual(s.counts(),{analyses:0,drafts:0,submissions:1});
});
test('quick apply reuses office preference only for the exact supported question and choice',()=>{
 const label='Are you comfortable working in-person at the office (in New York or San Francisco) at least 3 days/week?',option='Yes | Currently located in the broader NYC or SF area and comfortable being in the office at least 3 days/week';
 const office={...field('office',label,'radio'),options:[option,'No | Would prefer to work remotely']},profile={officeThreeDays:'local_nyc_sf'};
 assert.equal(quickApplicationAnswers({fields:[office]},profile,'Student.pdf').answers.office.value,option);
 for(const changed of [{...office,label:label+' And relocate immediately?'},{...office,options:[option+' and travel weekly']},{...office,label:label.replace('at least','exactly')}])assert.deepEqual(quickApplicationAnswers({fields:[changed]},profile,'Student.pdf').missing,[changed.label]);
});
test('Apply now job identity includes location and canonical destination',()=>{
 const job={id:'a',title:'Role',company:'Company',location:'New York',url:URL},hash=quickApplicationJobFingerprint(job);
 assert.equal(hash,quickApplicationJobFingerprint({...job,url:URL+'?utm_source=test'}));
 for(const [key,value] of Object.entries({id:'b',title:'Another role',company:'Another company',location:'Chicago',url:URL.replace('/example/','/another/')}))assert.notEqual(hash,quickApplicationJobFingerprint({...job,[key]:value}));
});

test('quick application rejects a job changed between the displayed-card check and its own read',async t=>{
 const s=await setup(t),expectedJobHash=quickApplicationJobFingerprint(await s.a.get('jobs','role'));
 await s.a.put('jobs','role',{...(await s.a.get('jobs','role')),company:'Changed company'});
 await assert.rejects(startQuickApplication(s.a,s.queue,'role',1,{expectedJobHash}),/details changed/);
 assert.equal((await s.a.all('liveApplications')).length,0);assert.equal(s.tasks.length,0);
});

test('profile, resume, selected job or authorization expiry changes block automatic submission',async t=>{
 for(const kind of ['profile','resume','title','company','location','expiry'])await t.test(kind,async t=>{
  const s=await setup(t);await startQuickApplication(s.a,s.queue,'role',1);await s.run('application-inspect');
  if(kind==='profile')await saveCareerProfile(s.a,{fullName:'Changed Student'});
  else if(kind==='resume')await s.a.put('documents','resume',{name:'Changed.pdf',file:'changed'});
  else if(kind==='expiry'){const a=await s.current();await s.a.put('liveApplications',a.id,{...a,quickAuthorizationExpiresAt:Date.now()-1});}
  else await s.a.put('jobs','role',{...(await s.a.get('jobs','role')),[kind]:'Changed'});
  await s.run('application-submit');assert.equal(s.counts().submissions,0);assert.equal((await s.current()).status,'needs_attention');assert.match((await s.current()).error,/changed/);
 });
});

test('relink suppresses an existing quick request and changing profile at final click still blocks submission',async t=>{
 const s=await setup(t);await startQuickApplication(s.a,s.queue,'role',1);await s.a.put('secrets','telegram',{chatId:202,linkedAt:'changed'});
 assert.deepEqual(await s.run('application-inspect'),{stale:true});await assert.rejects(startQuickApplication(s.a,s.queue,'role',2),/connection changed/);
 await s.a.put('secrets','telegram',{chatId:101,linkedAt:'link-a'});await s.run('application-inspect');let clicked=0;
 await s.run('application-submit',{submit:async args=>{await saveCareerProfile(s.a,{fullName:'Another Person'});await args.beforeSubmit();clicked++;return {confirmation:'Unexpected',confirmedAt:new Date().toISOString()};}});
 assert.equal(clicked,0);assert.equal((await s.current()).status,'needs_attention');
});

test('uncertain quick submission is never retried and guarded actions cannot bypass missing facts',async t=>{
 const s=await setup(t);await startQuickApplication(s.a,s.queue,'role',1);await s.run('application-inspect');
 await s.run('application-submit',{submit:async args=>{await args.beforeSubmit();throw Error('network ended after click');}});const a=await s.current();assert.equal(a.status,'uncertain');
 await startQuickApplication(s.a,s.queue,'role',2);assert.equal(s.tasks.filter(j=>j.type==='application-submit').length,1);
 const blocked=await setup(t,{form:{...BASE,fields:[...BASE.fields,field('missing','Salary expectation')]}});await startQuickApplication(blocked.a,blocked.queue,'role',3);await blocked.run('application-inspect');const b=await blocked.current();
 await assert.rejects(handleLiveApplicationAction(blocked.a,blocked.queue,{id:b.id,revision:b.revision,op:'submit'},4),/Choose Apply now again/);assert.equal(blocked.tasks.some(j=>j.type==='application-submit'),false);
});
