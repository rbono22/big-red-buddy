import test from 'node:test';
import assert from 'node:assert/strict';
import {startQuickApplication,startLiveApplication,executeLiveApplication,handleLiveApplicationAction,handleLiveApplicationMessage,showLiveApplication} from '../lib/live-applications.mjs';
import {getCareerProfile,saveCareerProfile} from '../lib/career.mjs';
import {saveApplicationAnswerMemory,deleteApplicationAnswerMemory} from '../lib/application-answer-memory.mjs';

const URL='https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply';
const field=(key,label,type='text',extra={})=>({key,label,type,required:true,options:[],...extra});
const YEARS=field('years','How many years of Python experience do you have?','radio',{options:['0–2','3–5','6+']});
const BASE={title:'Product Analyst',fields:[field('_systemfield_resume','Resume','file'),field('name','Full name','text',{profileField:'fullName'}),field('email','Email','email',{profileField:'email'})],consentText:''};
function memory(userId){const rows=new Map();return {userId,get:async(b,k)=>structuredClone(rows.get(b+':'+k)||null),put:async(b,k,v)=>rows.set(b+':'+k,structuredClone(v)),delete:async(b,k)=>rows.delete(b+':'+k),all:async b=>[...rows].filter(([k])=>k.startsWith(b+':')).map(([,v])=>structuredClone(v)),compareAndSet:async(b,k,old,next)=>{if(JSON.stringify(rows.get(b+':'+k)||null)!==JSON.stringify(old))return false;rows.set(b+':'+k,structuredClone(next));return true;}};}
async function setup(t,extraFields=[]){
 const previous={APPLICATION_BROWSER_ENABLED:process.env.APPLICATION_BROWSER_ENABLED,APP_ORIGIN:process.env.APP_ORIGIN,PILOT_SHEET_ID:process.env.PILOT_SHEET_ID};
 t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 process.env.APPLICATION_BROWSER_ENABLED='true';process.env.APP_ORIGIN='https://app.bigredbuddy.com';delete process.env.PILOT_SHEET_ID;
 const a=memory('alice'),b=memory('bob'),tasks=[];let form={...BASE,fields:[...BASE.fields,...extraFields]},key=100,submissions=0,failedType;
 const queue={enqueue:async(userId,type,payload,options)=>{if(failedType===type){failedType=null;throw Error('Synthetic queue failure');}const existing=tasks.find(task=>task.options.idempotencyKey===options.idempotencyKey);if(existing)return existing;const task={id:String(tasks.length),userId,type,payload,options};tasks.push(task);return task;}};
 await a.put('secrets','telegram',{chatId:'101',linkedAt:'original-link'});await b.put('secrets','telegram',{chatId:'202',linkedAt:'other-link'});
 const job={id:'role',title:BASE.title,company:'Example',description:'Build forecasting tools and study customer needs.',url:URL};await a.put('jobs',job.id,job);
 await a.put('documents','resume',{name:'Resume.pdf',file:Buffer.from('%PDF-1.7 synthetic resume').toString('base64'),text:'Built an inventory forecasting tool using Python. Led customer interviews.'});
 await saveCareerProfile(a,{fullName:'Example Student',email:'student@example.edu'});
 const db={forUser:id=>id==='alice'?a:b},current=async()=>(await a.all('liveApplications'))[0];
 const run=async(type,overrides={})=>executeLiveApplication(db,tasks.filter(task=>task.type===type).at(-1),{queue,inspect:async()=>structuredClone(form),analyze:async()=>{throw Error('No experience inference in this fixture');},draft:async()=>{throw Error('An unrequested model draft would be a test failure');},motivation:async()=>{throw Error('No live model calls in this fixture');},submit:async args=>{await args.beforeSubmit();submissions++;return {confirmation:'Application received',confirmedAt:new Date().toISOString()};},...overrides});
 const start=async()=>{await startQuickApplication(a,queue,job.id,++key);return run('application-inspect');};
 const reply=async(text,update=++key)=>handleLiveApplicationMessage(a,queue,{chat:{id:'101',type:'private'},text},update);
 const action=async(op,index,extra={})=>{const application=await current();return handleLiveApplicationAction(a,queue,{id:application.id,revision:application.revision,op,...(index===undefined?{}:{field:index}),...extra},++key);};
 return {a,b,db,job,queue,tasks,current,run,start,reply,action,setForm:value=>{form=value;},failNext:type=>{failedType=type;},submissions:()=>submissions};
}

test('quick apply asks missing questions, remembers an explicit answer and submits once after the last reply',async t=>{
 const s=await setup(t,[YEARS,field('salary','Salary expectation')]);await s.start();assert.equal((await s.current()).status,'collecting');
 await s.reply('2',200);let a=await s.current();assert.equal(a.answers.years.value,'3–5');assert.equal(a.status,'collecting');assert.equal((await s.a.all('applicationAnswerMemory')).length,1);
 // Telegram can redeliver the same update after a restart. It must not become
 // the answer to the next question or trigger a second submission.
 await s.reply('2',200);a=await s.current();assert.equal(a.answers.salary,undefined);
 await s.reply('$120,000',201);assert.equal((await s.current()).status,'queued');assert.equal((await s.a.all('applicationAnswerMemory')).length,1);
 assert.equal(s.tasks.filter(task=>task.type==='application-submit').length,1);
 assert.doesNotMatch(s.tasks.filter(task=>task.type==='telegram-send').map(task=>task.payload.text).join('\n'),/Review your application|Ready to send these reviewed/);
 await s.run('application-submit');await s.run('application-submit');assert.equal(s.submissions(),1);assert.equal((await s.current()).status,'submitted');
});

test('a missing profile fact is saved and its updated authorization still permits the current application',async t=>{
 const s=await setup(t,[field('employer','Current company','text',{profileField:'currentCompany'})]);await s.start();assert.equal((await s.current()).status,'collecting');
 await s.reply('Example Studio');assert.equal((await getCareerProfile(s.a)).currentCompany,'Example Studio');assert.equal((await s.a.all('applicationAnswerMemory')).length,0);assert.equal((await s.current()).status,'queued');
 await s.run('application-submit');assert.equal(s.submissions(),1);
});

test('matching explicit memories answer quick questions but changed employer choices still prompt',async t=>{
 for(const changed of [false,true]){
  const s=await setup(t,[YEARS]);await saveApplicationAnswerMemory(s.a,{field:YEARS,job:s.job,value:'3–5',source:'student'});
  if(changed)s.setForm({...BASE,fields:[...BASE.fields,{...YEARS,options:['0–2','3–5 years','6+']}]});
  await s.start();const a=await s.current();assert.equal(a.status,changed?'collecting':'queued');
  if(!changed){assert.equal(a.answers.years.source,'saved application answer');assert.equal(a.answers.years.value,'3–5');await s.run('application-submit');assert.equal(s.submissions(),1);}
  else{assert.equal(a.answers.years,undefined);assert.equal(s.tasks.some(task=>task.type==='application-submit'),false);}
 }
});

test('removing a remembered answer before execution or immediately before the click prevents submission',async t=>{
 for(const timing of ['before-execution','before-click']){
  const s=await setup(t,[YEARS]),saved=await saveApplicationAnswerMemory(s.a,{field:YEARS,job:s.job,value:'3–5',source:'student'});await s.start();assert.equal((await s.current()).status,'queued');let clicked=0;
  if(timing==='before-execution')await deleteApplicationAnswerMemory(s.a,saved.id);
  await s.run('application-submit',{submit:async args=>{if(timing==='before-click')await deleteApplicationAnswerMemory(s.a,saved.id);await args.beforeSubmit();clicked++;return {confirmation:'Should not happen',confirmedAt:new Date().toISOString()};}});
  assert.equal(clicked,0);assert.equal((await s.current()).status,'needs_attention');
 }
});

test('other students and a relinked chat cannot answer or resume the original student’s application',async t=>{
 const s=await setup(t,[YEARS]);await s.start();const a=await s.current();
 assert.equal(await handleLiveApplicationMessage(s.a,s.queue,{chat:{id:'202',type:'private'},text:'2'},300),false);
 await assert.rejects(handleLiveApplicationAction(s.b,s.queue,{id:a.id,revision:a.revision,op:'answer',field:3,choice:1},301),/not available/);
 await s.a.put('secrets','telegram',{chatId:'303',linkedAt:'replacement-link'});assert.equal(await s.reply('2'),false);
 await assert.rejects(s.action('answer',3,{choice:1}),/not available/);assert.equal((await s.a.all('applicationAnswerMemory')).length,0);assert.equal(s.tasks.some(task=>task.type==='application-submit'),false);
});

test('changed resume, selected job or saved profile blocks a pending quick answer before it can be remembered',async t=>{
 for(const kind of ['resume','job','profile']){
  const s=await setup(t,[YEARS]);await s.start();
  if(kind==='resume')await s.a.put('documents','resume',{...(await s.a.get('documents','resume')),text:'New resume facts while this question was open.'});
  if(kind==='job')await s.a.put('jobs',s.job.id,{...s.job,description:'A different employer posting.'});
  if(kind==='profile')await saveCareerProfile(s.a,{fullName:'Changed student name'});
  await assert.rejects(s.reply('2'),/changed/);assert.equal((await s.a.all('applicationAnswerMemory')).length,0);assert.equal(s.tasks.some(task=>task.type==='application-submit'),false);
 }
});

test('concurrent replies to one question cannot overwrite each other or queue duplicate applications',async t=>{
 const s=await setup(t,[YEARS]);await s.start();const a=await s.current(),request={id:a.id,revision:a.revision,op:'answer',field:3,choice:1};
 const results=await Promise.allSettled([handleLiveApplicationAction(s.a,s.queue,request,400),handleLiveApplicationAction(s.a,s.queue,{...request,choice:2},401)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal((await s.current()).answers.years.value,'3–5');assert.equal(s.tasks.filter(task=>task.type==='application-submit').length,1);assert.equal((await s.a.all('applicationAnswerMemory')).length,1);
});

test('required cover letter waits until other missing facts are answered, then queues one submission',async t=>{
 const cover=field('cover','Cover letter','textarea'),s=await setup(t,[cover,YEARS]);let generated=0;
 await startQuickApplication(s.a,s.queue,s.job.id,500);await s.run('application-inspect',{generateCoverLetter:async()=>{generated++;return {text:'A letter based on the current resume and posting.'};}});
 assert.equal(generated,0);assert.equal((await s.current()).status,'collecting');await s.reply('2');assert.equal((await s.current()).status,'drafting');
 const task=s.tasks.filter(task=>task.type==='application-answer').at(-1);assert.equal(task.payload.coverLetter,true);
 await s.run('application-answer',{generateCoverLetter:async()=>{generated++;return {text:'A letter based on the current resume and posting.'};}});
 assert.equal(generated,1);assert.equal((await s.current()).status,'queued');assert.equal((await s.current()).answers.cover.value,'A letter based on the current resume and posting.');assert.equal(s.tasks.filter(task=>task.type==='application-submit').length,1);
});

test('a company motivation is drafted automatically but cannot be submitted or remembered before acceptance',async t=>{
 const why=field('why','Why this company?','textarea'),s=await setup(t,[why]);await s.start();assert.equal((await s.current()).status,'drafting');let calls=0;
 await s.run('application-answer',{motivation:async(store,input)=>{calls++;assert.equal(store.userId,'alice');assert.equal(input.job.company,'Example');assert.equal(input.question,why.label);return {answer:'My Python forecasting work aligns with your focus on customer needs.',needsManual:false,gaps:[]};}});
 let a=await s.current();assert.equal(calls,1);assert.equal(a.status,'collecting');assert.equal(a.answers.why,undefined);assert.equal(a.drafts.why.reviewed,false);assert.equal((await s.a.all('applicationAnswerMemory')).length,0);assert.equal(s.tasks.some(task=>task.type==='application-submit'),false);
 await s.action('use-draft',3);a=await s.current();assert.equal(a.status,'queued');assert.equal(a.answers.why.value,'My Python forecasting work aligns with your focus on customer needs.');assert.equal((await s.a.all('applicationAnswerMemory'))[0].source,'approved-ai');await s.run('application-submit');assert.equal(s.submissions(),1);
});

test('failed motivation generation keeps the question resumable and does not loop or submit a fabricated fallback',async t=>{
 const s=await setup(t,[field('why','Why this company?','textarea')]);await s.start();await s.run('application-answer',{motivation:async()=>{throw Error('Private provider details');}});
 assert.equal((await s.current()).status,'collecting');assert.equal((await s.current()).answers.why,undefined);assert.equal(s.tasks.filter(task=>task.type==='application-answer').length,1);assert.equal(s.tasks.some(task=>task.type==='application-submit'),false);assert.doesNotMatch(s.tasks.at(-1).payload.text,/Private provider details/);
 await s.reply('My forecasting experience connects directly to the work described in this posting.');assert.equal((await s.current()).status,'queued');assert.equal((await s.a.all('applicationAnswerMemory'))[0].source,'student');
});

test('legal consent requires the student’s choice and is never learned as a reusable answer',async t=>{
 const consent=field('legal','I agree to the employer terms','radio',{options:['Yes','No']}),s=await setup(t,[consent]);await s.start();assert.equal((await s.current()).status,'collecting');assert.equal((await s.current()).answers.legal,undefined);
 await s.action('answer',3,{choice:0});assert.equal((await s.current()).answers.legal.value,'Yes');assert.equal((await s.a.all('applicationAnswerMemory')).length,0);assert.equal((await s.current()).status,'queued');
});

test('the employer’s character limit applies before a typed response is saved or submitted',async t=>{
 const s=await setup(t,[field('skills','Describe your Python skills.','textarea',{maxLength:12})]);await s.start();await assert.rejects(s.reply('This response is too long.'),/character limit/);assert.equal((await s.a.all('applicationAnswerMemory')).length,0);assert.equal(s.tasks.some(task=>task.type==='application-submit'),false);
});

test('a queue outage after the last answer preserves recovery instead of reporting a nonexistent queued application',async t=>{
 const s=await setup(t,[YEARS]);await s.start();s.failNext('application-submit');await s.reply('2').catch(()=>{});const a=await s.current();assert.equal(a.answers.years.value,'3–5');assert.notEqual(a.status,'queued');assert.equal(s.tasks.some(task=>task.type==='application-submit'),false);
 await showLiveApplication(s.a,s.queue,a,600);assert.doesNotMatch(s.tasks.at(-1).payload.text,/is queued for submission/);
});

test('Apply now retries a queue outage with accepted one-off answers intact and asks again for changed choices',async t=>{
 for(const changed of [false,true]){
  const salary=field('salary','Salary expectation'),s=await setup(t,[YEARS,salary]);await s.start();await s.reply('2');s.failNext('application-submit');await s.reply('$120,000');assert.equal((await s.current()).status,'needs_attention');
  for(const memory of await s.a.all('applicationAnswerMemory'))await deleteApplicationAnswerMemory(s.a,memory.id);
  if(changed)s.setForm({...BASE,fields:[...BASE.fields,{...YEARS,options:['0–2','3–5 years','6+']},salary]});
  await startQuickApplication(s.a,s.queue,s.job.id,700);await s.run('application-inspect');const a=await s.current();assert.equal(a.answers.salary.value,'$120,000');
  if(changed){assert.equal(a.status,'collecting');assert.equal(a.answers.years,undefined);}
  else{assert.equal(a.status,'queued');assert.equal(a.answers.years.value,'3–5');await s.run('application-submit');assert.equal(s.submissions(),1);}
 }
});

test('retry prefers an explicitly updated profile over the previous answer to the same profile field',async t=>{
 const employer=field('employer','Current company','text',{profileField:'currentCompany'}),s=await setup(t,[employer]);await s.start();s.failNext('application-submit');await s.reply('Old Studio');assert.equal((await s.current()).status,'needs_attention');
 await saveCareerProfile(s.a,{currentCompany:'New Studio'});await startQuickApplication(s.a,s.queue,s.job.id,701);await s.run('application-inspect');assert.equal((await s.current()).answers.employer.value,'New Studio');assert.equal((await s.current()).status,'queued');await s.run('application-submit');assert.equal(s.submissions(),1);
});

test('switching a guided application to Apply when complete preserves accepted answers',async t=>{
 const salary=field('salary','Salary expectation'),s=await setup(t,[salary]);await startLiveApplication(s.a,s.queue,s.job.id,702,{skipReferral:true});await s.run('application-inspect');assert.equal((await s.current()).status,'collecting');
 await s.reply('$130,000');assert.equal((await s.current()).status,'ready');assert.equal(s.tasks.some(task=>task.type==='application-submit'),false);
 await s.action('quick');await s.run('application-inspect');const a=await s.current();assert.equal(a.mode,'quick');assert.equal(a.status,'queued');assert.equal(a.answers.salary.value,'$130,000');await s.run('application-submit');assert.equal(s.submissions(),1);
});

test('expired official-company context invalidates a pending motivation draft before acceptance or memory',async t=>{
 t.mock.method(Date,'now',()=>Date.parse('2026-11-13T04:00:00Z'));
 const s=await setup(t,[field('why','Why this company?','textarea')]);await s.a.put('jobs',s.job.id,{...s.job,company:'Splunk'});await s.start();await s.run('application-answer',{motivation:async()=>({answer:'My analytics experience relates to Splunk’s security and observability work.',needsManual:false,gaps:[]})});
 assert.equal((await s.current()).status,'collecting');assert.ok((await s.current()).drafts.why.sourceBinding);
 t.mock.method(Date,'now',()=>Date.parse('2027-06-01T00:00:00Z'));await s.action('use-draft',3);const a=await s.current();assert.equal(a.status,'collecting');assert.equal(a.drafts.why,undefined);assert.equal(a.answers.why,undefined);assert.equal((await s.a.all('applicationAnswerMemory')).length,0);assert.equal(s.tasks.some(task=>task.type==='application-submit'),false);assert.match(s.tasks.at(-1).payload.text,/sources.*changed/i);
});

test('a source change during AI generation cannot install a stale motivation draft',async t=>{
 const s=await setup(t,[field('why','Why this company?','textarea')]);await s.start();await s.run('application-answer',{motivation:async()=>{await s.a.put('jobs',s.job.id,{...s.job,description:'Different role responsibilities appeared during generation.'});return {answer:'A draft based on the old employer description.',needsManual:false,gaps:[]};}});
 const a=await s.current();assert.equal(a.drafts.why,undefined);assert.equal(a.answers.why,undefined);assert.equal((await s.a.all('applicationAnswerMemory')).length,0);assert.equal(s.tasks.some(task=>task.type==='application-submit'),false);
});

test('explicit SMS, WhatsApp and office choices save their precise reusable profile preferences',async t=>{
 const sms=field('smsConsent','Recruiting updates by SMS','consent',{options:['Yes - I consent to receiving SMS text messages','No - I do not consent to receiving SMS text messages']}),whatsapp=field('whatsAppConsent','Recruiting updates by WhatsApp','consent',{options:['Yes - I consent to receiving WhatsApp messages','No - I do not consent to receiving WhatsApp messages']}),office=field('office','Are you comfortable working in-person at the office (in New York or San Francisco) at least 3 days/week?','radio',{options:['Yes | Currently located in the broader NYC or SF area and comfortable being in the office at least 3 days/week','No | Would prefer to work remotely']});
 const s=await setup(t,[sms,whatsapp,office]);await s.start();await s.action('answer',3,{choice:1});await s.action('answer',4,{choice:0});await s.action('answer',5,{choice:0});const profile=await getCareerProfile(s.a);
 assert.equal(profile.recruitingSMS,'no');assert.equal(profile.recruitingWhatsApp,'yes');assert.equal(profile.officeThreeDays,'local_nyc_sf');assert.equal((await s.a.all('applicationAnswerMemory')).length,0);assert.equal((await s.current()).status,'queued');await s.run('application-submit');assert.equal(s.submissions(),1);
});

test('compound office or messaging choices remain one-off answers and do not expand saved consent',async t=>{
 for(const item of [field('smsConsent','Recruiting updates by SMS','consent',{options:['Yes, text me and share my information with partners','No, do not text me']}),field('office','Are you comfortable working in-person at the office (in New York or San Francisco) at least 3 days/week? And travel every month?','radio',{options:['Yes | Currently located in the broader NYC or SF area and comfortable being in the office at least 3 days/week','No | Would prefer to work remotely']})]){
  const s=await setup(t,[item]);await s.start();await s.action('answer',3,{choice:0});const profile=await getCareerProfile(s.a);assert.equal(profile.recruitingSMS,'unanswered');assert.equal(profile.officeThreeDays,'unanswered');assert.equal((await s.a.all('applicationAnswerMemory')).length,0);assert.equal((await s.current()).answers[item.key].value,item.options[0]);
 }
});

test('a saved messaging preference cannot pre-authorize a broader employer-specific consent',async t=>{
 const sms=field('smsConsent','Recruiting updates by SMS','consent',{options:['Yes, text me and share my information with partners','No, do not text me']}),s=await setup(t,[sms]);await saveCareerProfile(s.a,{recruitingSMS:'yes'});await s.start();assert.equal((await s.current()).status,'collecting');assert.equal((await s.current()).answers.smsConsent,undefined);assert.equal(s.tasks.some(task=>task.type==='application-submit'),false);
});
