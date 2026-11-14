import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {startQuickApplication,startLiveApplication,executeLiveApplication,handleLiveApplicationAction} from '../lib/live-applications.mjs';
import {canCreateApplicationHandoff,createApplicationHandoff,redeemApplicationHandoff} from '../lib/application-handoff.mjs';
import {saveCareerProfile} from '../lib/career.mjs';
import {saveApplicationAnswerMemory,suggestSavedApplicationAnswer} from '../lib/application-answer-memory.mjs';
import {queueResumeEnhancement,executeResumeEnhancement,selectResumeEnhancement} from '../lib/resume-enhancer.mjs';

const URL='https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply';
const hash=value=>createHash('sha256').update(value).digest('hex');
const BASE={title:'Product Analyst',fields:[
 {key:'_systemfield_resume',label:'Resume',type:'file',required:true,options:[]},
 {key:'name',label:'Full name',type:'text',profileField:'fullName',required:true,options:[]},
 {key:'email',label:'Email',type:'email',profileField:'email',required:true,options:[]}
],consentText:''};
const sourceText='Alex Example\nProduct Analyst\nBuilt SQL dashboards to measure customer retention.\nExample University, MBA';
function memory(userId){
 const rows=new Map();return {userId,get:async(b,k)=>structuredClone(rows.get(b+':'+k)||null),put:async(b,k,v)=>rows.set(b+':'+k,structuredClone(v)),delete:async(b,k)=>rows.delete(b+':'+k),compareAndSetMany:async changes=>{if(changes.some(c=>JSON.stringify(rows.get(c.bucket+':'+c.id)||null)!==JSON.stringify(c.expected)))return false;for(const c of changes)if(Object.hasOwn(c,'value'))rows.set(c.bucket+':'+c.id,structuredClone(c.value));return true;},all:async b=>[...rows].filter(([k])=>k.startsWith(b+':')).map(([,v])=>structuredClone(v)),compareAndSet:async(b,k,old,next)=>{if(JSON.stringify(rows.get(b+':'+k)||null)!==JSON.stringify(old))return false;rows.set(b+':'+k,structuredClone(next));return true;}};
}
async function setup(t,{form=BASE}={}){
 const previous={APPLICATION_BROWSER_ENABLED:process.env.APPLICATION_BROWSER_ENABLED,APP_ORIGIN:process.env.APP_ORIGIN,PILOT_SHEET_ID:process.env.PILOT_SHEET_ID};
 t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 process.env.APPLICATION_BROWSER_ENABLED='true';process.env.APP_ORIGIN='https://app.bigredbuddy.com';delete process.env.PILOT_SHEET_ID;
 const a=memory('alice'),b=memory('bob'),tasks=[];
 const queue={enqueue:async(userId,type,payload,options={})=>{const row={id:String(tasks.length),userId,type,payload,options};tasks.push(row);return row;}};
 const original={name:'Original Resume.pdf',file:Buffer.from('%PDF-1.7 original fixture').toString('base64'),text:sourceText,updatedAt:'2026-11-14T12:00:00.000Z'};
 const job={id:'role',title:BASE.title,company:'Example',url:URL,description:'Build SQL dashboards for data visualization and customer retention analysis.'};
 for(const [store,chatId] of [[a,101],[b,202]]){
  await store.put('documents','resume',original);await store.put('jobs','role',job);
  await store.put('secrets','telegram',{chatId,linkedAt:'link-'+store.userId});await saveCareerProfile(store,{fullName:'Alex Example',email:'alex@example.edu'});
 }
 const db={forUser:id=>id==='alice'?a:b},current=async()=>(await a.all('liveApplications'))[0];
 const run=async(type,overrides={})=>executeLiveApplication(db,tasks.filter(task=>task.type===type).at(-1),{queue,inspect:async()=>structuredClone(form),analyze:async()=>({analyzed:true,stale:false,roles:[]}),submit:async args=>{await args.beforeSubmit();return {confirmation:'Application received',confirmedAt:new Date().toISOString()};},...overrides});
 return {a,b,db,queue,tasks,current,run,original,job};
}
// Exercise the real enhancer approval path with a deterministic grounded model and PDF renderer.
async function selectTailored(s,{store=s.a,suffix='one'}={}){
 const queued=await queueResumeEnhancement(store,s.queue,{jobId:'role'});
 const id=queued.id;
 const document={name:`Tailored ${suffix}.pdf`,file:Buffer.from(`%PDF-1.7 tailored fixture ${suffix}`).toString('base64')};
 await executeResumeEnhancement({forUser:()=>store},{userId:store.userId,payload:{jobId:'role',enhancementId:id}},{generate:async()=>({value:{changes:[{id:'line-2',original:'Built SQL dashboards to measure customer retention.',suggested:'Built SQL dashboards for data visualization to measure customer retention.',keywords:['data visualization']}]}}),renderPDF:async()=>document});
 const selected=await selectResumeEnhancement(store,{jobId:'role',enhancementId:id});
 return {id,document:{...document,name:selected.fileName}};
}

test('quick apply pins and sends the selected enhanced PDF while keeping factual evidence and original upload intact',async t=>{
 const cover={key:'cover',label:'Cover letter',type:'textarea',required:true,options:[]};
 const s=await setup(t,{form:{...BASE,fields:[...BASE.fields,cover]}}),chosen=await selectTailored(s);
 await startQuickApplication(s.a,s.queue,'role','quick');
 let a=await s.current();assert.equal(a.resumeEnhancementId,chosen.id);assert.equal(a.resumeHash,hash(chosen.document.file));assert.equal(a.resumeName,chosen.document.name);
 await s.run('application-inspect',{generateCoverLetter:async({resume})=>{assert.equal(resume.text,sourceText);assert.equal(resume.file,chosen.document.file);return {text:'I built SQL dashboards to measure customer retention.'};}});
 a=await s.current();assert.equal(a.status,'queued');assert.equal(a.answers._systemfield_resume.value,chosen.document.name);
 await selectResumeEnhancement(s.a,{jobId:'role',enhancementId:null});
 let submitted;
 await s.run('application-submit',{submit:async args=>{submitted=args;assert.equal(args.resume.file,chosen.document.file);await args.beforeSubmit();return {confirmation:'Application received',confirmedAt:new Date().toISOString()};}});
 assert.equal((await s.current()).status,'submitted');assert.equal(submitted.resume.text,sourceText);assert.deepEqual(await s.a.get('documents','resume'),s.original);
 await startQuickApplication(s.a,s.queue,'role','again');assert.equal(s.tasks.filter(row=>row.type==='application-submit').length,1);
});

test('guided application hands off only its pinned enhanced PDF after selection changes',async t=>{
 const s=await setup(t),chosen=await selectTailored(s);
 await startLiveApplication(s.a,s.queue,'role','guided',{skipReferral:true});await s.run('application-inspect');
 const a=await s.current();assert.equal(a.status,'ready');assert.equal(a.resumeEnhancementId,chosen.id);
 await selectResumeEnhancement(s.a,{jobId:'role',enhancementId:null});
 const token=await createApplicationHandoff(s.a,{applicationId:a.id,revision:a.revision});
 const payload=await redeemApplicationHandoff(s.a,{token:token.token});
 assert.equal(payload.documents.resume.file,chosen.document.file);assert.equal(payload.documents.resume.name,chosen.document.name);assert.equal(payload.answers._systemfield_resume.value,chosen.document.name);
 assert.equal(payload.documents.resume.sha256,hash(Buffer.from(chosen.document.file,'base64')));assert.equal(payload.status,'browser_handoff');
 assert.deepEqual(await s.a.get('documents','resume'),s.original);
});

test('original and legacy applications never adopt a subsequently selected enhanced PDF',async t=>{
 for(const legacy of [false,true])await t.test(legacy?'legacy':'explicit original',async t=>{
  const s=await setup(t);await startLiveApplication(s.a,s.queue,'role','guided',{skipReferral:true});
  let a=await s.current();assert.equal(a.resumeEnhancementId,null);
  if(legacy){delete a.resumeEnhancementId;delete a.resumeSourceHash;await s.a.put('liveApplications',a.id,a);}
  await selectTailored(s);await s.run('application-inspect');a=await s.current();assert.equal(a.status,'ready');assert.equal(a.resumeName,s.original.name);
  const token=await createApplicationHandoff(s.a,{applicationId:a.id});const payload=await redeemApplicationHandoff(s.a,{token:token.token});assert.equal(payload.documents.resume.file,s.original.file);
 });
});

test('enhanced application cannot submit or export after its original or job source changes',async t=>{
 for(const change of ['file','text','description'])await t.test(change,async t=>{
  const s=await setup(t);await selectTailored(s);await startQuickApplication(s.a,s.queue,'role','quick');await s.run('application-inspect');assert.equal((await s.current()).status,'queued');
  if(change==='description')await s.a.put('jobs','role',{...s.job,description:s.job.description+' Additional requirements.'});
  else await s.a.put('documents','resume',{...s.original,[change]:s.original[change]+' changed'});
  await s.run('application-submit',{submit:async()=>assert.fail('Changed source must stop before opening a submission')});const a=await s.current();assert.equal(a.status,'needs_attention');assert.equal(a.submitAttemptAt,undefined);assert.match(a.error,/changed/);
  assert.equal(await canCreateApplicationHandoff(s.a,{applicationId:a.id}),false);await assert.rejects(createApplicationHandoff(s.a,{applicationId:a.id}),/expired or the application changed/);
 });
});

test('original source change during browser fill blocks beforeSubmit without recording a submission attempt',async t=>{
 const s=await setup(t);await selectTailored(s);await startQuickApplication(s.a,s.queue,'role','quick');await s.run('application-inspect');
 await s.run('application-submit',{submit:async args=>{await s.a.put('documents','resume',{...s.original,text:sourceText+'\nNew achievement.'});await args.beforeSubmit();assert.fail('Submission must stop');}});
 const a=await s.current();assert.equal(a.status,'needs_attention');assert.equal(a.submitAttemptAt,undefined);
});

test('an enhancement id from another tenant cannot be used in a pinned application or browser handoff',async t=>{
 const s=await setup(t),foreign=await selectTailored(s,{store:s.b});
 await startQuickApplication(s.a,s.queue,'role','quick');await s.run('application-inspect');let a=await s.current();
 await s.a.put('liveApplications',a.id,{...a,resumeEnhancementId:foreign.id,resumeHash:hash(foreign.document.file),resumeName:foreign.document.name});
 await s.run('application-submit',{submit:async()=>assert.fail('Cross-tenant selection must stop before submission')});a=await s.current();assert.equal(a.status,'needs_attention');assert.equal(a.submitAttemptAt,undefined);assert.equal(await canCreateApplicationHandoff(s.a,{applicationId:a.id}),false);
});

test('a handoff token issued for an enhanced application stops exporting after source changes',async t=>{
 const s=await setup(t);await selectTailored(s);await startLiveApplication(s.a,s.queue,'role','guided',{skipReferral:true});await s.run('application-inspect');
 const a=await s.current(),token=await createApplicationHandoff(s.a,{applicationId:a.id});
 await s.a.put('jobs','role',{...s.job,description:s.job.description+' Updated scope.'});
 await assert.rejects(redeemApplicationHandoff(s.a,{token:token.token}),/expired or the application changed/);assert.equal((await s.current()).status,'ready');
});

test('cancelling an unsubmitted original application allows a new explicit start to select its enhanced version',async t=>{
 const s=await setup(t);await startLiveApplication(s.a,s.queue,'role','guided',{skipReferral:true});let a=await s.current();
 const chosen=await selectTailored(s);await handleLiveApplicationAction(s.a,s.queue,{id:a.id,revision:a.revision,op:'cancel'},'cancel');
 await startQuickApplication(s.a,s.queue,'role','quick');a=await s.current();assert.equal(a.resumeEnhancementId,chosen.id);assert.equal(a.resumeHash,hash(chosen.document.file));
});


test('saved original-source answers remain available when an enhanced PDF is attached',async t=>{
 const field={key:'experience',label:'Describe your product experience',type:'textarea',required:true,options:[]};
 const s=await setup(t,{form:{...BASE,fields:[...BASE.fields,field]}}),value='I built SQL dashboards to measure customer retention.';
 const memory=await saveApplicationAnswerMemory(s.a,{field,job:s.job,value,source:'student'});
 await selectTailored(s);await startQuickApplication(s.a,s.queue,'role','quick');await s.run('application-inspect');
 let a=await s.current();assert.equal(a.status,'queued');assert.equal(a.answers.experience.value,value);assert.equal(a.answers.experience.memoryId,memory.id);
 // Recover a failed automatic submission through the same partial handoff path.
 await s.run('application-submit',{submit:async()=>{throw Object.assign(Error('verification'),{code:'HUMAN_VERIFICATION_REQUIRED'});}});a=await s.current();
 const token=await createApplicationHandoff(s.a,{applicationId:a.id}),payload=await redeemApplicationHandoff(s.a,{token:token.token});
 assert.equal(payload.answers.experience.value,value);assert.equal(payload.omitted.length,0);
 assert.ok(await suggestSavedApplicationAnswer(s.a,{field,job:s.job}));
});


test('guided confirmation submits the exact selected enhanced PDF',async t=>{
 const s=await setup(t),chosen=await selectTailored(s);
 await startLiveApplication(s.a,s.queue,'role','guided',{skipReferral:true});await s.run('application-inspect');let a=await s.current();assert.equal(a.status,'ready');
 await handleLiveApplicationAction(s.a,s.queue,{id:a.id,revision:a.revision,op:'submit'},'submit');
 await s.run('application-submit',{submit:async args=>{assert.equal(args.resume.file,chosen.document.file);assert.equal(args.resume.name,chosen.document.name);await args.beforeSubmit();return {confirmation:'Application received',confirmedAt:new Date().toISOString()};}});
 assert.equal((await s.current()).status,'submitted');assert.deepEqual(await s.a.get('documents','resume'),s.original);
});
