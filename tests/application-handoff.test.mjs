import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createApplicationHandoff,redeemApplicationHandoff} from '../lib/application-handoff.mjs';
import {getCareerProfile,saveCareerProfile} from '../lib/career.mjs';
import {saveApplicationAnswerMemory,suggestSavedApplicationAnswer} from '../lib/application-answer-memory.mjs';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const url='https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply';
function store(userId){const rows=new Map();return {userId,get:async(b,k)=>structuredClone(rows.get(b+':'+k)||null),put:async(b,k,v)=>rows.set(b+':'+k,structuredClone(v)),delete:async(b,k)=>rows.delete(b+':'+k),all:async b=>[...rows].filter(([k])=>k.startsWith(b+':')).map(([,v])=>structuredClone(v)),compareAndSet:async(b,k,old,next)=>{if(JSON.stringify(rows.get(b+':'+k)||null)!==JSON.stringify(old))return false;rows.set(b+':'+k,structuredClone(next));return true;}};}
async function fixture(){
 const s=store('a'),file=Buffer.from('%PDF-1.7\nsynthetic resume').toString('base64');
 await s.put('secrets','telegram',{chatId:101,linkedAt:'one'});await saveCareerProfile(s,{fullName:'Alex Example',email:'alex@example.edu'});
 await s.put('documents','resume',{name:'Resume.pdf',file,text:'Synthetic resume with product experience.'});await s.put('jobs','job',{id:'job',title:'Analyst',company:'Example',applyUrl:url,description:'Lead product experiments and customer research.'});
 const fields=[{key:'_systemfield_resume',controlName:'resume',label:'Resume',type:'file',required:true},{key:'name',controlName:'name',label:'Full name',type:'text',required:true},{key:'missing',controlName:'why',label:'Why this role?',type:'textarea',required:true},{key:'optional',controlName:'gender',label:'Gender',type:'text',required:false}];
 const a={id:'app',jobId:'job',title:'Analyst',company:'Example',provider:'lever',url,revision:2,status:'collecting',chatId:'101',linkedAt:'one',resumeHash:hash(file),profileHash:hash(await getCareerProfile(s)),form:{title:'Analyst',fields},answers:{_systemfield_resume:{value:'Resume.pdf',reviewed:true},name:{value:'Alex Example',reviewed:true},missing:{value:'UNREVIEWED_DRAFT',reviewed:false},optional:{value:null,reviewed:true}},drafts:{missing:{value:'PRIVATE_DRAFT'}},privateSecret:'never exported'};
 await s.put('liveApplications','app',a);return {s,a};
}
test('same-tenant handoff is one-time and exports reviewed partial answers and the exact PDF only',async()=>{
 const {s}=await fixture(),created=await createApplicationHandoff(s,{applicationId:'app'},{now:1000});assert.match(created.token,/^[a-f0-9]{64}$/);assert.equal(created.url,url);
 assert.ok(!(await s.all('applicationHandoffs')).some(row=>JSON.stringify(row).includes(created.token)));
 const payload=await redeemApplicationHandoff(s,{token:created.token},{now:1100});assert.deepEqual(payload.answers.name,{value:'Alex Example'});assert.equal(payload.answers.missing,undefined);assert.equal(payload.answers.optional,undefined);assert.equal(payload.documents.resume.name,'Resume.pdf');assert.equal(payload.provider,'lever');
 assert.equal(payload.documents.resume.sha256,createHash('sha256').update(Buffer.from(payload.documents.resume.file,'base64')).digest('hex'));
 assert.equal(payload.status,'browser_handoff');assert.equal(payload.revision,3);assert.equal((await s.get('liveApplications','app')).status,'browser_handoff');
 assert.doesNotMatch(JSON.stringify(payload),/PRIVATE_DRAFT|UNREVIEWED_DRAFT|never exported|privateSecret/);await assert.rejects(redeemApplicationHandoff(s,{token:created.token},{now:1200}),/expired or the application changed/);
});
test('token cannot cross tenant, expire, or survive changed application sources or relink',async()=>{
 for(const change of ['tenant','expiry','profile','resume','job','revision','link','deleting']){
  const {s,a}=await fixture(),created=await createApplicationHandoff(s,{applicationId:'app'},{now:1000});
  if(change==='profile')await saveCareerProfile(s,{fullName:'Changed'});
  if(change==='resume')await s.put('documents','resume',{name:'Changed.pdf',file:'changed'});
  if(change==='job')await s.put('jobs','job',{...(await s.get('jobs','job')),company:'Other company'});
  if(change==='revision')await s.put('liveApplications','app',{...a,revision:3});
  if(change==='link')await s.put('secrets','telegram',{chatId:202,linkedAt:'two'});
  if(change==='deleting')await s.put('settings','account',{deleting:true});
  await assert.rejects(redeemApplicationHandoff(change==='tenant'?store('b'):s,{token:created.token},{now:change==='expiry'?999999:1100}),/expired or the application changed/);
 }
});
test('queued, attempted, submitted, or ambiguous submissions cannot be duplicated through handoff',async()=>{
 for(const patch of [{status:'queued'},{status:'submitting'},{status:'submitted'},{status:'uncertain'},{submitAttemptAt:new Date().toISOString()}]){
  const {s,a}=await fixture();await s.put('liveApplications','app',{...a,...patch});await assert.rejects(createApplicationHandoff(s,{applicationId:'app'}),/expired or the application changed/);
 }
});
test('simultaneous redemption returns private contents only once',async()=>{
 const {s}=await fixture(),created=await createApplicationHandoff(s,{applicationId:'app'});
 const results=await Promise.allSettled([redeemApplicationHandoff(s,{token:created.token}),redeemApplicationHandoff(s,{token:created.token})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('redemption at time zero is still one-time, and mismatched requested revisions are rejected',async()=>{
 const {s}=await fixture();await assert.rejects(createApplicationHandoff(s,{applicationId:'app',revision:1}),/expired or the application changed/);
 const created=await createApplicationHandoff(s,{applicationId:'app',revision:2},{now:0});await redeemApplicationHandoff(s,{token:created.token},{now:0});await assert.rejects(redeemApplicationHandoff(s,{token:created.token},{now:1}),/expired or the application changed/);
});
test('missing cover letter is skipped, never replaced by the resume, and unexpected files are refused',async()=>{
 const {s,a}=await fixture();a.form.fields.push({key:'cover',controlName:'cover',label:'Cover letter',type:'file',required:true});a.answers.cover={value:'Cover Letter.pdf',reviewed:true};await s.put('liveApplications','app',a);
 const first=await createApplicationHandoff(s,{applicationId:'app'}),payload=await redeemApplicationHandoff(s,{token:first.token});assert.equal(payload.documents.coverLetter,undefined);assert.equal(payload.answers.cover,undefined);
 a.form.fields.push({key:'salary-proof',label:'Salary proof',type:'file',required:true});await s.put('liveApplications','app',a);const second=await createApplicationHandoff(s,{applicationId:'app'});await assert.rejects(redeemApplicationHandoff(s,{token:second.token}),/expired or the application changed/);
});
test('handoff atomically disables quick flow and allows a fresh browser-only retry',async()=>{
 const {s,a}=await fixture();a.mode='quick';a.quickAuthorizationExpiresAt=Date.now()+60000;await s.put('liveApplications','app',a);
 const created=await createApplicationHandoff(s,{applicationId:'app'}),payload=await redeemApplicationHandoff(s,{token:created.token});
 assert.equal(payload.status,'browser_handoff');assert.equal(payload.revision,3);const after=await s.get('liveApplications','app');assert.equal(after.quickAuthorizationExpiresAt,0);
 assert.equal(await s.compareAndSet('liveApplications','app',a,{...a,status:'queued',revision:3}),false);
 const retry=await createApplicationHandoff(s,{applicationId:'app',revision:3}),again=await redeemApplicationHandoff(s,{token:retry.token});assert.equal(again.status,'browser_handoff');assert.equal(again.revision,4);
});
test('a queued submission or concurrent source edit wins instead of exporting a stale handoff',async()=>{
 for(const change of ['queued','source']){
  const {s}=await fixture(),created=await createApplicationHandoff(s,{applicationId:'app'}),cas=s.compareAndSet;let triggered=false;
  s.compareAndSet=async(bucket,id,old,next)=>{
   if(bucket==='liveApplications'&&!triggered){triggered=true;if(change==='queued')await cas(bucket,id,old,{...old,status:'queued',revision:old.revision+1});else await s.put('jobs','job',{...(await s.get('jobs','job')),description:'Changed while claiming browser handoff.'});}
   return cas(bucket,id,old,next);
  };
  await assert.rejects(redeemApplicationHandoff(s,{token:created.token}),/expired or the application changed/);assert.equal((await s.get('liveApplications','app')).status,change==='queued'?'queued':'browser_handoff');
 }
});
test('two independently created tokens cannot claim the same application revision',async()=>{
 const {s}=await fixture(),one=await createApplicationHandoff(s,{applicationId:'app'}),two=await createApplicationHandoff(s,{applicationId:'app'});
 const results=await Promise.allSettled([redeemApplicationHandoff(s,{token:one.token}),redeemApplicationHandoff(s,{token:two.token})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await s.get('liveApplications','app')).revision,3);
});
async function withCover(){
 const {s,a}=await fixture(),resume=await s.get('documents','resume'),job=await s.get('jobs','job'),profile=await getCareerProfile(s);
 a.coverLetter={text:'I led synthetic product research.',document:{name:'Cover Letter.pdf',file:Buffer.from('%PDF-1.7\nSynthetic cover').toString('base64')},sourceBinding:hash({resume:resume.text,description:job.description}),jobBinding:hash({id:job.id,title:job.title,company:job.company,location:'',url}),profileBinding:hash(profile.fullName)};
 a.form.fields.push({key:'cover',controlName:'cover',label:'Cover letter',type:'file',required:true},{key:'cover-text',controlName:'cover-text',label:'Cover letter',type:'textarea',required:true});
 a.answers.cover={value:'Cover Letter.pdf',reviewed:true,source:'generated cover letter from resume and role'};a.answers['cover-text']={value:a.coverLetter.text,reviewed:true,source:'generated cover letter from resume and role'};await s.put('liveApplications','app',a);return {s,a,resume,job};
}
test('only a cover letter bound to current resume text, role, and signature is exported',async()=>{
 for(const change of ['none','resume-text','description','job','signature','missing-binding']){
  const {s,a,resume,job}=await withCover();
  if(change==='resume-text')await s.put('documents','resume',{...resume,text:'Changed extracted experience in the same PDF.'});
  if(change==='description')await s.put('jobs','job',{...job,description:'Different job requirements.'});
  if(change==='job')await s.put('jobs','job',{...job,company:'Changed employer'});
  if(change==='signature'){a.coverLetter.profileBinding='stale';await s.put('liveApplications','app',a);}
  if(change==='missing-binding'){delete a.coverLetter.sourceBinding;await s.put('liveApplications','app',a);}
  const created=await createApplicationHandoff(s,{applicationId:'app'}),payload=await redeemApplicationHandoff(s,{token:created.token});
  assert.equal(Boolean(payload.documents.coverLetter),change==='none');assert.equal(Boolean(payload.answers.cover),change==='none');assert.equal(Boolean(payload.answers['cover-text']),change==='none');assert.ok(payload.documents.resume);
  if(change!=='none')assert.deepEqual(payload.omitted.map(o=>o.reason),['cover_letter_changed','cover_letter_changed']);
 }
});
async function withMemory(){
 const {s,a}=await fixture(),job=await s.get('jobs','job'),field={key:'experience',label:'Describe your product experience',type:'textarea',required:true,options:[]};
 const memory=await saveApplicationAnswerMemory(s,{field,job,value:'I led customer research and product experiments.',source:'student'}),suggestion=await suggestSavedApplicationAnswer(s,{field,job});
 a.form.fields.push(field);a.answers.experience={...suggestion,reviewed:true};await s.put('liveApplications','app',a);return {s,a,memory};
}
test('deleted, changed, or stale saved memories are omitted from a partial browser handoff',async()=>{
 for(const change of ['none','deleted','updated','resume-text']){
  const {s,memory}=await withMemory();if(change==='deleted')await s.delete('applicationAnswerMemory',memory.id);
  if(change==='updated')await s.put('applicationAnswerMemory',memory.id,{...memory,updatedAt:'later',value:'I led different research.'});
  if(change==='resume-text')await s.put('documents','resume',{...(await s.get('documents','resume')),text:'The updated resume has different product evidence.'});
  const created=await createApplicationHandoff(s,{applicationId:'app'}),payload=await redeemApplicationHandoff(s,{token:created.token});assert.equal(Boolean(payload.answers.experience),change==='none');
  if(change!=='none')assert.ok(payload.omitted.some(o=>o.key==='experience'&&o.reason==='saved_answer_changed'));
 }
});
test('memory deletion during the application claim prevents any private export',async()=>{
 const {s,memory}=await withMemory(),created=await createApplicationHandoff(s,{applicationId:'app'}),cas=s.compareAndSet;
 s.compareAndSet=async(bucket,id,old,next)=>{const claimed=await cas(bucket,id,old,next);if(bucket==='liveApplications'&&claimed)await s.delete('applicationAnswerMemory',memory.id);return claimed;};
 await assert.rejects(redeemApplicationHandoff(s,{token:created.token}),/expired or the application changed/);assert.equal((await s.get('liveApplications','app')).status,'browser_handoff');
});
