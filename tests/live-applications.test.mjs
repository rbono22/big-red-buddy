import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {startLiveApplication,startLiveApplicationFromURL,executeLiveApplication,handleLiveApplicationAction,handleLiveApplicationMessage,experienceSuggestion} from '../lib/live-applications.mjs';
import {ashbyApplicationURL,liveApplicationSupported,allowedAshbyResource} from '../lib/ashby-browser.mjs';
import {saveCareerProfile,getCareerProfile} from '../lib/career.mjs';
import {listApplicationTracker} from '../lib/application-tracker.mjs';
import {validateTelegramReplyMarkup} from '../lib/telegram-delivery.mjs';
import {applicationURL,applicationProviderFor,liveApplicationSupported as providerSupported} from '../lib/application-providers.mjs';
import {editDemographics} from '../lib/demographics.mjs';
const FORM=JSON.parse(await readFile(new URL('./fixtures/ramp-application-form.json',import.meta.url),'utf8'));
const APP_URL='https://jobs.ashbyhq.com/ramp/a84ae1e2-8c88-4e05-9cb6-fa3e11b55aeb/application';
function memory(userId){const rows=new Map();return {userId,get:async(b,k)=>structuredClone(rows.get(b+':'+k)||null),put:async(b,k,v)=>rows.set(b+':'+k,structuredClone(v)),delete:async(b,k)=>rows.delete(b+':'+k),all:async b=>[...rows].filter(([k])=>k.startsWith(b+':')).map(([,v])=>structuredClone(v)),compareAndSet:async(b,k,old,next)=>{if(JSON.stringify(rows.get(b+':'+k)||null)!==JSON.stringify(old))return false;rows.set(b+':'+k,structuredClone(next));return true;}};}
async function setup(t,{profile=true,form=FORM,url=APP_URL,company='Ramp',demographics}={}){
 const before={APPLICATION_BROWSER_ENABLED:process.env.APPLICATION_BROWSER_ENABLED,APP_ORIGIN:process.env.APP_ORIGIN,PILOT_SHEET_ID:process.env.PILOT_SHEET_ID};t.after(()=>{for(const [k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});process.env.APPLICATION_BROWSER_ENABLED='true';process.env.APP_ORIGIN='https://app.bigredbuddy.com';delete process.env.PILOT_SHEET_ID;
 const a=memory('alice'),b=memory('bob'),sent=[],queue={enqueue:async(userId,type,payload,options)=>{const previous=sent.find(j=>j.options.idempotencyKey===options.idempotencyKey);if(previous)return previous;const job={id:String(sent.length),userId,type,payload,options};sent.push(job);if(type==='telegram-send')validateTelegramReplyMarkup(payload.replyMarkup);return job;}};
 const db={forUser:id=>id==='alice'?a:b};await a.put('jobs','ramp',{id:'ramp',title:form.title,company,applyUrl:url});await a.put('documents','resume',{name:'Example.pdf',file:Buffer.from('%PDF-1.7\nsynthetic').toString('base64'),text:'Example Student\nProduct Manager at Example, 2020 to 2025.'});await a.put('secrets','telegram',{chatId:101,linkedAt:'link-1'});
 if(profile)await saveCareerProfile(a,{fullName:'Example Student',email:'student@example.edu',phone:'+1 212 555 1234',linkedin:'https://www.linkedin.com/in/example',plannedWorkLocation:'New York City, New York, United States',officeThreeDays:'local_nyc_sf',recruitingSMS:'no',recruitingWhatsApp:'no'});
 if(demographics)await editDemographics(a,demographics);
 const current=async()=>(await a.all('liveApplications'))[0],action=async(op,extra={})=>{const app=await current();return handleLiveApplicationAction(a,queue,{id:app.id,revision:app.revision,op,...extra},'action:'+sent.length);};
 const run=async(type,overrides={})=>{const task=sent.filter(j=>j.type===type).at(-1);return executeLiveApplication(db,task,{queue,inspect:async()=>structuredClone(form),analyze:async()=>({roles:[],analyzed:true}),...overrides});};
 await startLiveApplication(a,queue,'ramp','start');await run('application-inspect');
 return {a,b,db,queue,sent,current,action,run};
}
async function ready(s){
 for(let n=0;n<30;n++){const a=await s.current();if(a.status==='ready')return a;const index=a.form.fields.findIndex(f=>!a.answers[f.key]?.reviewed);assert.ok(index>=0);const f=a.form.fields[index];if(f.options.length)await s.action('answer',{field:index,choice:0});else if(!f.required)await s.action('skip',{field:index});else await handleLiveApplicationMessage(s.a,s.queue,{chat:{id:101,type:'private'},text:'A factual student-written response.'},100+n);}
 throw Error('Did not reach review');
}
test('destination and resource allowlists reject host confusion and arbitrary employers',()=>{
 assert.equal(ashbyApplicationURL(APP_URL.replace('/application','')),APP_URL);
 for(const url of [APP_URL.replace('/ramp/','/other/'),APP_URL+'?next=evil',APP_URL+'#fragment',APP_URL.replace('jobs.ashbyhq.com','jobs.ashbyhq.com.evil.test'),APP_URL.replace('https://','https://user:pass@'),APP_URL.replace('a84ae1e2','zzzzzzzz'),'http://127.0.0.1/'])assert.equal(ashbyApplicationURL(url),'');
 for(const url of ['http://127.0.0.1','https://evil.test','https://app.ashbyhq.com:444/a','https://user:pass@app.ashbyhq.com'])assert.equal(allowedAshbyResource(url),false);
 assert.equal(allowedAshbyResource('https://app.ashbyhq.com/api/nonsecret'),true);
});
test('reusable profile stores payroll, office and separate explicit communication choices',async t=>{
 const s=await setup(t,{profile:false}),initial=await getCareerProfile(s.a);assert.equal(initial.recruitingSMS,'unanswered');assert.equal(initial.recruitingWhatsApp,'unanswered');
 await saveCareerProfile(s.a,{plannedWorkLocation:'Queens, New York, United States',officeThreeDays:'relocate_nyc_sf',recruitingSMS:'yes',recruitingWhatsApp:'no'});await s.action('profile');const a=await s.current();assert.equal(a.answers.smsConsent.value,FORM.fields.find(f=>f.key==='smsConsent').options[0]);assert.equal(a.answers.whatsAppConsent.value,FORM.fields.find(f=>f.key==='whatsAppConsent').options[1]);
 assert.equal((await getCareerProfile(s.b)).plannedWorkLocation,'');await assert.rejects(saveCareerProfile(s.a,{officeThreeDays:'probably'}));
 await saveCareerProfile(s.a,{recruitingSMS:'unanswered'});await s.action('profile');assert.equal((await s.current()).answers.smsConsent,undefined);
});
test('a real form is inspected once and saved demographics are not included',async t=>{
 const s=await setup(t);await s.a.put('career','demographics',{values:{disabilityStatus:'private'}});await startLiveApplication(s.a,s.queue,'ramp','again');assert.equal(s.sent.filter(j=>j.type==='application-inspect').length,1);assert.equal(s.sent.filter(j=>j.type==='application-submit').length,0);assert.equal((await s.current()).status,'collecting');assert.doesNotMatch(JSON.stringify(await s.current()),/disability|private/);
 await assert.rejects(startLiveApplication(s.b,s.queue,'ramp','foreign'),/not supported/);
});
test('experience estimate uses product titles, unions overlap, caps future months and excludes internships and contracts',()=>{
 const f=FORM.fields.find(f=>f.type==='yesno');const role=(title,startMonth,endMonth,employmentType='full-time')=>({title,startMonth,endMonth,employmentType});
 const result=experienceSuggestion(f,{asOfMonth:'2026-11',roles:[role('Product Manager','2020-01','2024-12'),role('Senior Product Manager','2024-01','2030-12'),role('Product Manager Intern','2010-01','2020-12','internship'),role('Product Manager','2000-01','2010-12','contract'),role('Sales Lead','2000-01','2010-12')]});
 assert.equal(result.value,'Yes');assert.equal(result.reviewed,false);assert.match(result.note,/6.9 years/);assert.equal(experienceSuggestion(f,{stale:true,roles:[role('Product Manager','2020-01','present')]}),null);
});
test('duplicate text cannot answer the next question and AI drafts need explicit acceptance',async t=>{
 const s=await setup(t);const a=await s.current(),field=a.form.fields.findIndex(f=>f.type==='yesno');await s.action('answer',{field,choice:1});
 const msg={chat:{id:101,type:'private'},text:'My own project example.'};await handleLiveApplicationMessage(s.a,s.queue,msg,200);const before=await s.current();await handleLiveApplicationMessage(s.a,s.queue,msg,200);assert.deepEqual(await s.current(),before);
 const flow=await s.a.get('settings','liveApplicationFlow');await s.action('generate',{field:flow.field});await s.run('application-answer',{draft:async()=>({answer:'Reviewable example.',needsManual:false})});const after=await s.current();assert.equal(after.answers[after.form.fields[flow.field].key],undefined);assert.equal(after.drafts[after.form.fields[flow.field].key].value,'Reviewable example.');
 assert.equal(await handleLiveApplicationMessage(s.a,s.queue,{chat:{id:202,type:'private'},text:'Wrong user'},201),false);
});
test('submission requires a complete review and concurrent confirmation queues exactly once',async t=>{
 const s=await setup(t);await assert.rejects(s.action('submit'),/Review all answers/);const a=await ready(s);
 const x={id:a.id,revision:a.revision,op:'submit'};const attempts=await Promise.allSettled([handleLiveApplicationAction(s.a,s.queue,x,'click1'),handleLiveApplicationAction(s.a,s.queue,x,'click2')]);assert.ok(attempts.some(r=>r.status==='fulfilled'));assert.equal(s.sent.filter(j=>j.type==='application-submit').length,1);assert.equal(s.sent.find(j=>j.type==='application-submit').options.maxAttempts,1);
 let submissions=0;const submit=async({beforeSubmit})=>{await beforeSubmit();submissions++;return {confirmedAt:new Date().toISOString(),confirmation:'Application submitted!',url:APP_URL};};await s.run('application-submit',{submit});await s.run('application-submit',{submit});assert.equal(submissions,1);assert.equal((await s.current()).status,'submitted');
 const row=(await listApplicationTracker(s.a))[0];assert.equal(row.submissionSource,'employer-confirmed');assert.match(row.statusLabel,/employer confirmed/);
});
test('post-click failure stays unconfirmed and cannot automatically retry',async t=>{
 const s=await setup(t);await ready(s);await s.action('submit');let submissions=0;await s.run('application-submit',{submit:async({beforeSubmit})=>{await beforeSubmit();submissions++;throw Error('Network lost');}});assert.equal((await s.current()).status,'uncertain');await s.action('retry');await s.run('application-submit',{submit:async()=>submissions++});assert.equal(submissions,1);assert.equal(s.sent.filter(j=>j.type==='application-submit').length,1);assert.equal((await listApplicationTracker(s.a))[0].submissionSource,null);
});
test('changed profile reopens review and changed resume blocks submission',async t=>{
 const s=await setup(t);await ready(s);await saveCareerProfile(s.a,{recruitingSMS:'yes'});await s.action('submit');assert.equal(s.sent.filter(j=>j.type==='application-submit').length,0);assert.equal((await s.current()).answers.smsConsent.value,FORM.fields.find(f=>f.key==='smsConsent').options[0]);
 await s.a.put('documents','resume',{file:'replaced'});await assert.rejects(s.action('submit'),/resume changed/);
});
test('changed form or exact-location requirement is resolved before any submit attempt',async t=>{
 const s=await setup(t);await ready(s);await s.action('submit');await s.run('application-submit',{submit:async()=>{throw Object.assign(Error('CHOOSE_EXACT_LOCATION'),{code:'CHOOSE_EXACT_LOCATION',options:['Queens, New York, United States']});}});const a=await s.current();assert.equal(a.status,'collecting');assert.equal(a.submitAttemptAt,undefined);assert.equal(a.form.fields[a.activeField].type,'location');
});
test('relinked chat cannot read or submit a saved application',async t=>{
 const s=await setup(t);await ready(s);await s.a.put('secrets','telegram',{chatId:101,linkedAt:'link-2'});await assert.rejects(s.action('submit'),/not available/);await assert.rejects(startLiveApplication(s.a,s.queue,'ramp','relinked'),/connection changed/);assert.equal(s.sent.filter(j=>j.type==='application-submit').length,0);
});
test('edit menu reaches all questions including both consent choices',async t=>{
 const s=await setup(t);await ready(s);await s.action('edit',{offset:9});const buttons=s.sent.at(-1).payload.replyMarkup.inline_keyboard.flat();assert.ok(buttons.some(b=>b.text==='Recruiting updates by SMS'));assert.ok(buttons.some(b=>b.text==='Recruiting updates by WhatsApp'));
});

test('expired review can be reopened, and failed pre-submit jobs recover without sending',async t=>{
 const s=await setup(t);let a=await ready(s);await s.a.put('liveApplications',a.id,{...a,reviewExpiresAt:Date.now()-1});await assert.rejects(s.action('submit'),/Review all answers/);await s.action('show');assert.ok((await s.current()).reviewExpiresAt>Date.now());await s.action('submit');s.queue.get=async()=>({status:'needs_review'});await s.action('show');assert.equal((await s.current()).status,'needs_attention');assert.equal((await s.current()).submitAttemptAt,undefined);
});
test('queued application answers cannot be delivered after revision or chat binding changes',async t=>{
 const {dispatchQueuedTelegram}=await import('../lib/telegram-delivery.mjs');const s=await setup(t),message=s.sent.filter(j=>j.type==='telegram-send').at(-1);let calls=0;const send=async()=>{calls++;return {result:{message_id:100}};};
 let a=await s.current();await s.a.put('liveApplications',a.id,{...a,revision:a.revision+1});assert.equal((await dispatchQueuedTelegram(s.a,message,{send})).reason,'application-changed');assert.equal(calls,0);
 await s.a.put('liveApplications',a.id,a);await s.a.put('secrets','telegram',{chatId:202,linkedAt:'new'});assert.equal((await dispatchQueuedTelegram(s.a,message,{send})).reason,'telegram-link-changed');assert.equal(calls,0);
});

test('provider registry keeps existing Ashby records compatible and rejects provider swaps',()=>{
 assert.equal(applicationProviderFor({url:APP_URL}).id,'ashby');
 assert.throws(()=>applicationProviderFor({url:APP_URL,provider:'lever'}),/UNSUPPORTED_EMPLOYER/);
 assert.equal(applicationURL('https://jobs.lever.co.evil.test/company/aaaa'),'');
 assert.equal(applicationURL('https://job-boards.greenhouse.io/reddit/jobs/8023563?gh_src=example'),'https://job-boards.greenhouse.io/reddit/jobs/8023563');
 assert.equal(applicationProviderFor({provider:'workable',url:'https://apply.workable.com/valsoft-corp/j/4560CF5DD0/apply/'}).label,'Workable');
 assert.equal(applicationURL('https://apply.workable.com/other/j/4560CF5DD0/apply/'),'');
});
test('large employer dropdowns are searchable and paginated without exceeding Telegram limits',async t=>{
 const choices=Array.from({length:249},(_,i)=>`Country ${i+1}`),form={title:'Example role',consentText:'',fields:[{key:'country',label:'Country dialing code',type:'select',required:true,options:choices}]};
 const s=await setup(t,{form,url:'https://job-boards.greenhouse.io/example/jobs/123456',company:'Example'});
 assert.equal((await s.current()).provider,'greenhouse');assert.ok(providerSupported(await s.a.get('jobs','ramp')));
 let message=s.sent.filter(j=>j.type==='telegram-send').at(-1);assert.ok(message.payload.replyMarkup.inline_keyboard.length<=12);assert.match(message.payload.text,/Country 5/);assert.doesNotMatch(message.payload.text,/Country 6\b/);
 await s.action('choices',{field:0,offset:5});message=s.sent.at(-1);assert.match(message.payload.text,/Country 6/);
 await handleLiveApplicationMessage(s.a,s.queue,{chat:{id:101,type:'private'},text:'Country 24'},800);
 // Exact labels are immediately accepted; partial labels narrow the menu.
 assert.equal((await s.current()).answers.country.value,'Country 24');
 await s.action('edit-field',{field:0});await handleLiveApplicationMessage(s.a,s.queue,{chat:{id:101,type:'private'},text:'249'},801);assert.equal((await s.current()).answers.country.value,'Country 249');
});
test('multi-select answers remain unreviewed until Done and stale buttons cannot alter them',async t=>{
 const form={title:'Example role',consentText:'',fields:[{key:'choices',label:'Choose up to two',type:'select',multiple:true,maxChoices:2,required:true,options:['One','Two','Three']}]};
 const s=await setup(t,{form,url:'https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply',company:'Example'});
 let before=await s.current();await s.action('answer',{field:0,choice:0});assert.equal((await s.current()).answers.choices,undefined);
 await assert.rejects(handleLiveApplicationAction(s.a,s.queue,{id:before.id,revision:before.revision,op:'answer',field:0,choice:1},'stale'),/changed/);
 await s.action('answer',{field:0,choice:1});await assert.rejects(s.action('answer',{field:0,choice:2}),/at most 2/);
 await s.action('selection-done',{field:0});assert.equal((await s.current()).answers.choices.value,'One\nTwo');assert.equal((await s.current()).status,'ready');
 await s.action('submit');let called=0;await s.run('application-submit',{submit:async({answers,beforeSubmit})=>{assert.equal(answers.choices.value,'One\nTwo');await beforeSubmit();called++;return {confirmedAt:new Date().toISOString(),confirmation:'Application submitted'};}});assert.equal(called,1);assert.equal((await s.current()).status,'submitted');
});
test('explicit name parts reuse saved values; a full name is never silently split',async t=>{
 const form={title:'Example role',consentText:'',fields:[{key:'first',label:'First name',type:'text',profileField:'firstName',required:true,options:[]},{key:'last',label:'Last name',type:'text',profileField:'lastName',required:true,options:[]}]};
 const s=await setup(t,{form});assert.equal((await s.current()).answers.first,undefined);
 await saveCareerProfile(s.a,{firstName:'Example',lastName:'Student'});await s.action('profile');assert.equal((await s.current()).answers.first.value,'Example');assert.equal((await s.current()).answers.last.value,'Student');
 assert.equal((await getCareerProfile(s.b)).firstName,'');
});
test('an explicit employer link queues inspection and learns its title without inventing a publication date',async t=>{
 const s=await setup(t),url='https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply';
 await startLiveApplicationFromURL(s.a,s.queue,url,'link');await startLiveApplicationFromURL(s.a,s.queue,url,'repeat-link');
 assert.equal(s.sent.filter(j=>j.type==='application-inspect').length,2);assert.equal(s.sent.filter(j=>j.type==='application-submit').length,0);
 let linkJob=(await s.a.all('jobs')).find(j=>j.source==='student-link');assert.equal(linkJob.publishedAt,undefined);assert.equal(linkJob.titlePending,true);
 await s.run('application-inspect',{inspect:async()=>({title:'Product Manager',consentText:'',fields:[{key:'name',profileField:'fullName',label:'Name',type:'text',required:true,options:[]}]})});
 linkJob=await s.a.get('jobs',linkJob.id);assert.equal(linkJob.title,'Product Manager');assert.equal(linkJob.titlePending,false);assert.equal(linkJob.publishedAt,undefined);
 const app=(await s.a.all('liveApplications')).find(a=>a.url===url);assert.equal(app.title,'Product Manager');assert.equal(app.status,'ready');assert.equal(app.provider,'lever');
 assert.equal((await s.b.all('jobs')).length,0);await assert.rejects(startLiveApplicationFromURL(s.a,s.queue,'https://evil.example/apply','bad'),/not supported/);
});
test('reference telephone questions never reuse the applicant phone',async t=>{
 const form={title:'Example role',consentText:'',fields:[{key:'ref-phone',label:'Reference telephone number',type:'tel',required:true,options:[]}]};
 const s=await setup(t,{form});assert.equal((await s.current()).answers['ref-phone'],undefined);
});
test('saved demographic suggestions need acceptance and cannot use deleted or changed preferences',async t=>{
 const form={title:'Example role',consentText:'',fields:[{key:'gender',label:'Gender identity',type:'select',required:true,options:['Man','Woman','Non-binary','Prefer not to answer']}]};
 const s=await setup(t,{form,demographics:{gender:'male',disabilityStatus:'yes'}});let a=await s.current();
 assert.equal(a.drafts.gender.value,'Man');assert.equal(a.drafts.gender.reviewed,false);assert.equal(a.answers.gender,undefined);assert.doesNotMatch(JSON.stringify(a),/disabilityStatus/);
 await editDemographics(s.a,{gender:'female'});await s.action('use-draft',{field:0});a=await s.current();assert.equal(a.answers.gender,undefined);assert.equal(a.drafts.gender.value,'Woman');
 await editDemographics(s.a,{gender:'unanswered'});await s.action('use-draft',{field:0});a=await s.current();assert.equal(a.answers.gender,undefined);assert.equal(a.drafts.gender,undefined);
 await s.action('answer',{field:0,choice:3});assert.equal((await s.current()).answers.gender.value,'Prefer not to answer');assert.equal((await s.current()).status,'ready');
});
