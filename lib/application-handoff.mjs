import {createHash,randomBytes} from 'node:crypto';
import {HttpError} from './security.mjs';
import {getCareerProfile} from './career.mjs';
import {applicationProvider,applicationURL} from './application-providers.mjs';
import {applicationDocument,isCoverLetterField} from './application-documents.mjs';
import {suggestSavedApplicationAnswer} from './application-answer-memory.mjs';
import {savedEmploymentProfileAnswer} from './application-profile-choices.mjs';

const BUCKET='applicationHandoffs',TTL=5*60*1000;
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const reject=()=>{throw new HttpError(409,'This browser handoff expired or the application changed. Open a fresh handoff from BRB.','application_handoff_changed');};
const time=now=>typeof now==='function'?now():now;
const allowedStatuses=new Set(['collecting','ready','needs_attention','browser_handoff']);
const sameText=(left,right)=>typeof left==='string'&&typeof right==='string'&&left.trim()&&left.replace(/\s+/g,' ').trim()===right.replace(/\s+/g,' ').trim();
// An unconfirmed attempt may be inspected in the student's own browser, but
// must remain uncertain so no worker can treat this handoff as a fresh attempt.
const priorSubmissionUnconfirmed=application=>application?.status==='uncertain'&&typeof application.submitAttemptAt==='string'&&Number.isFinite(Date.parse(application.submitAttemptAt));
const sourceBinding=current=>hash({application:current.application,job:current.job,resume:{file:current.resume.file,text:current.resume.text,updatedAt:current.resume.updatedAt},profile:current.profile,telegram:{chatId:current.telegram.chatId,linkedAt:current.telegram.linkedAt||''}});
const currentCoverLetter=({application,job,resume,profile})=>{
 const letter=application.coverLetter;
 return !!letter&&letter.sourceBinding===hash({resume:String(resume?.text||''),description:String(job?.description||'')})&&letter.jobBinding===hash({id:job.id,title:job.title,company:job.company,location:job.location||'',url:applicationURL(job.applyUrl||job.url)})&&letter.profileBinding===hash(profile.fullName||[profile.firstName,profile.lastName].filter(Boolean).join(' '));
};
function fieldView(field){
 const string=(value,max=2400)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
 if(!field||!string(field.key,160)||!field.key||['__proto__','prototype','constructor'].includes(field.key)||!string(field.label)||!field.label.trim()||!['text','email','tel','textarea','location','select','radio','checkbox','yesno','consent','file'].includes(field.type))reject();
 const result={key:field.key,label:field.label,type:field.type,required:!!field.required};
 for(const key of ['controlId','controlName'])if(field[key]!==undefined){if(!string(field[key],200))reject();result[key]=field[key];}
 for(const key of ['options','optionValues','radioIds','checkboxIds'])if(field[key]!==undefined){if(!Array.isArray(field[key])||field[key].length>300||field[key].some(v=>!string(v)))reject();result[key]=field[key];}
 if(field.multiple)result.multiple=true;
 if(Number.isSafeInteger(field.maxLength)&&field.maxLength>0)result.maxLength=field.maxLength;
 if(field.type==='file'){if(field.key!=='_systemfield_resume'&&!isCoverLetterField(field))reject();result.document=isCoverLetterField(field)?'coverLetter':'resume';}
 return result;
}
async function source(store,applicationId){
 const application=await store.get('liveApplications',applicationId);
 if(!application||application.removedAt||!(allowedStatuses.has(application.status)&&!application.submitAttemptAt||priorSubmissionUnconfirmed(application))||!Number.isSafeInteger(application.revision)||application.revision<0||!application.form||!Array.isArray(application.form.fields)||!application.form.fields.length||application.form.fields.length>70)reject();
 const [job,resume,profile,telegram,account]=await Promise.all([store.get('jobs',application.jobId),store.get('documents','resume'),getCareerProfile(store),store.get('secrets','telegram'),store.get('settings','account')]);
 const provider=applicationProvider(application.url);
 if(!job||job.closed||job.eligible===false||job.status==='closed'||!sameText(job.title,application.title)||!sameText(job.company,application.company)||!provider||applicationURL(job.applyUrl||job.url)!==provider.url||provider.url!==application.url||provider.id!==(application.provider||'ashby')||account?.deleting||!telegram?.chatId||String(telegram.chatId)!==application.chatId||(telegram.linkedAt||'')!==application.linkedAt||typeof resume?.file!=='string'||!resume.file||hash(resume.file)!==application.resumeHash||hash(profile)!==application.profileHash)reject();
 const current={application,job,resume,profile,provider,telegram};return {...current,binding:sourceBinding(current)};
}
/** UI readiness only: never mints a token, exports answers, or changes state. */
export async function canCreateApplicationHandoff(store,{applicationId,revision}={}){
 if(typeof applicationId!=='string'||!/^[A-Za-z0-9:_-]{1,160}$/.test(applicationId))return false;
 try{
  const current=await source(store,applicationId);
  if(revision!==undefined&&revision!==current.application.revision)return false;
  current.application.form.fields.forEach(fieldView);
  return true;
 }catch(error){
  if(error instanceof HttpError&&error.status===409&&error.code==='application_handoff_changed')return false;
  throw error;
 }
}
/** Called only by an authenticated, CSRF-protected BRB request for this tenant. */
export async function createApplicationHandoff(store,{applicationId,revision}={}, {now=Date.now}={}){
 if(typeof applicationId!=='string'||!/^[A-Za-z0-9:_-]{1,160}$/.test(applicationId))reject();
 const at=time(now);if(!Number.isFinite(at))reject();
 const current=await source(store,applicationId);
 if(revision!==undefined&&revision!==current.application.revision)reject();
 const rows=(await store.all(BUCKET)).sort((a,b)=>b.createdAt-a.createdAt);
 for(const [index,row] of rows.entries())if(row.expiresAt<=at||row.usedAt!=null||index>=9)await store.delete(BUCKET,row.id);
 const token=randomBytes(32).toString('hex'),id=hash(token),record={id,applicationId,revision:current.application.revision,binding:current.binding,createdAt:at,expiresAt:at+TTL,usedAt:null};
 await store.put(BUCKET,id,record);
 return {token,expiresAt:record.expiresAt,url:current.provider.url,title:current.application.title,company:current.application.company,applicationId,priorSubmissionUnconfirmed:priorSubmissionUnconfirmed(current.application)};
}
async function exportContents(store,current){
 const fields=current.application.form.fields.map(fieldView),answers={},documents={},omitted=[];
 const coverCurrent=currentCoverLetter(current);
 for(const field of fields){
  const original=current.application.form.fields.find(f=>f.key===field.key);
  let answer=current.application.answers?.[field.key];
  // Older inspections omitted these optional custom questions despite an
  // explicit saved profile answer. Repair only that omission during export;
  // a student-selected skip or per-application answer stays authoritative.
  if(!answer||answer.source==='omitted optional field'&&answer.value===null){
   const value=savedEmploymentProfileAnswer(original,current.profile);
   if(value!==null)answer={value,reviewed:true,source:'saved profile'};
  }
  if(answer?.reviewed!==true||typeof answer.value!=='string'||!answer.value.trim()||answer.value.length>5000)continue;
  if(field.maxLength&&answer.value.length>field.maxLength)continue;
  if(answer.source==='saved application answer'||answer.memoryId){
   const saved=await suggestSavedApplicationAnswer(store,{field:original,job:current.job,resume:current.resume});
   if(!saved||saved.memoryId!==answer.memoryId||saved.memoryUpdatedAt!==answer.memoryUpdatedAt||saved.value!==answer.value){omitted.push({key:field.key,reason:'saved_answer_changed'});continue;}
  }
  const generatedCover=isCoverLetterField(original)&&(field.type==='file'||answer.source==='generated cover letter from resume and role'||answer.value===current.application.coverLetter?.text);
  if(generatedCover&&!coverCurrent){omitted.push({key:field.key,reason:'cover_letter_changed'});continue;}
  if(field.type==='file'){
   let selected;try{selected=applicationDocument(original,{resume:current.resume,coverLetter:current.application.coverLetter?.document});}catch{continue;}
   if(answer.value!==selected.name)continue;
   documents[field.document]={name:selected.name,mimeType:'application/pdf',file:selected.buffer.toString('base64'),sha256:hash(selected.buffer)};
  }
  answers[field.key]={value:answer.value};
 }
 return {fields,answers,documents,omitted};
}
/** Authentication and CSRF remain required; possession of this token alone is insufficient. */
export async function redeemApplicationHandoff(store,{token}={}, {now=Date.now}={}){
 if(typeof token!=='string'||!/^([a-f0-9]{64})$/.test(token))reject();
 const id=hash(token),record=await store.get(BUCKET,id),at=time(now);
 if(!record||record.usedAt!=null||!Number.isFinite(at)||record.expiresAt<=at)reject();
 const current=await source(store,record.applicationId);
 if(current.binding!==record.binding||current.application.revision!==record.revision)reject();
 const contents=await exportContents(store,current);
 // Claim both the single-use token and the exact application revision before
 // private contents leave BRB. Any concurrent quick-submit claim wins instead
 // of creating two independent paths that could submit the same application.
 if(!await store.compareAndSet(BUCKET,id,record,{...record,usedAt:at}))reject();
 const uncertain=priorSubmissionUnconfirmed(current.application);
 const next={...current.application,status:uncertain?'uncertain':'browser_handoff',revision:current.application.revision+1,...(uncertain||current.application.mode==='quick'?{quickAuthorizationExpiresAt:0}:{}),browserHandoffAt:new Date(at).toISOString(),updatedAt:new Date(at).toISOString()};
 if(!await store.compareAndSet('liveApplications',record.applicationId,current.application,next))reject();
 const after=await source(store,record.applicationId);
 const expected=sourceBinding({...current,application:next});
 if(after.binding!==expected||hash(await exportContents(store,after))!==hash(contents)||(await source(store,record.applicationId)).binding!==expected)reject();
 return {version:1,applicationId:record.applicationId,revision:next.revision,status:next.status,priorSubmissionUnconfirmed:uncertain,provider:current.provider.id,url:current.provider.url,title:current.application.title,company:current.application.company,...contents,expiresAt:record.expiresAt};
}
