import {createHash,randomBytes} from 'node:crypto';
import {HttpError} from './security.mjs';
import {draftCareerAnswer} from './career.mjs';
import {modelJSON} from './model-client.mjs';
import {officialCompanyContext,companyContextText} from './company-context.mjs';

const BUCKET='applicationAnswerMemory',VERSION=1;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize=value=>String(value||'').normalize('NFKC').replace(/[’]/g,"'").replace(/\s+/g,' ').trim().replace(/[\s?!.:*]+$/,'').toLowerCase();
const controls=/[\u0000-\u0008\u000b\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
// Existing profile/demographic flows own these facts. This memory never learns
// a consent, declaration, protected characteristic, or changing eligibility.
const excluded=/\b(?:consent|agree|certif\w*|attest\w*|acknowledg\w*|terms|privacy|declar\w*|signature|truthful|accurate|work\s+authori[sz]\w*|authori[sz](?:ed|ation).{0,40}\bwork|legally.{0,25}\bwork|eligible|eligibility|sponsor\w*|visas?|citizenship|citizen|nationality|veterans?|military\s+(?:service|status)|disabilit\w*|disabled|gender|ethnic\w*|religio\w*|marital|birthdate|date\s+of\s+birth|pregnan\w*|sexual\s+orientation|social\s+security|ssn|passport|race|racial|criminal|background\s+check|salary|compensation|pay\s+expectations|availability|available|start\s+date|notice\s+period|relocat\w*|travel|payroll|full\s+name|first\s+name|last\s+name|email|phone|address|linkedin|portfolio|current\s+(?:company|employer|location)|recruiting\s+(?:sms|whatsapp)|receive\s+(?:texts?|messages?|updates?))\b/i;
const demographic=/\b(?:eeo|equal employment|self[- ]?identif\w*|male|female|non[- ]?binary|transgender|hispanic|latino|latina|latinx|white|black|asian|native hawaiian|pacific islander|american indian|alaska native|middle eastern|north african|prefer not to (?:say|answer|disclose)|decline to (?:answer|disclose))\b/i;
const experience=/\b(?:experience|skills?|proficien\w*|expertise|projects?|achievement\w*|accomplishment\w*|leadership|strengths?|tools?|technolog\w*)\b/i;
const roleSpecific=/\b(?:this|the|our)\s+(?:role|position|job|team)|\b(?:why (?:are|would|do) you|interest\w*|motivat\w*|applying|apply|company|employer|organization|organisation|mission|values|culture)\b/i;
const month=()=>new Date().toISOString().slice(0,7);
const resumeBinding=resume=>hash({file:resume?.file||'',text:resume?.text||''});
const companyBinding=job=>normalize(job?.company);
const roleBinding=job=>hash({company:companyBinding(job),title:normalize(job?.title),location:normalize(job?.location)});
const descriptionBinding=job=>hash(String(job?.description||''));
const includesCompany=(text,job)=>companyBinding(job).length>=2&&normalize(text).includes(companyBinding(job));
const hasResume=resume=>typeof resume?.text==='string'&&resume.text.trim().length>=20;
const scopeExplanation=(scope,company,roleTitle)=>scope==='global'?'Reusable for the same question and choices with your current resume.':scope==='company'?`Reusable at ${company} for the same question and unchanged posting.`:`Reusable for ${roleTitle} at ${company} with the same question and unchanged posting.`;

export function isCompanyMotivationQuestion(fieldOrQuestion,job={}){
 const question=typeof fieldOrQuestion==='string'?fieldOrQuestion:fieldOrQuestion?.label;
 if(typeof question!=='string'||excluded.test(question))return false;
 return /\b(?:why|interest\w*|motivat\w*|attract\w*|excite\w*|drawn|appeal\w*)\b/i.test(question)&&(/\b(?:company|employer|organization|organisation|mission|values|culture|us|our)\b/i.test(question)||includesCompany(question,job));
}

function definition(field){
 if(!field||!['text','textarea','number','select','radio','yesno'].includes(field.type)||field.multiple||field.profileField||typeof field.label!=='string'||field.label.length<3||field.label.length>2000||controls.test(field.label)||excluded.test(field.label)||demographic.test(field.label)||/\bcover[ -]?letter\b/i.test(field.label))return null;
 const options=field.options??[];
 if(!Array.isArray(options)||options.length>300||options.some(v=>typeof v!=='string'||!v.trim()||v.length>2400||controls.test(v)||excluded.test(v)||demographic.test(v))||new Set(options).size!==options.length)return null;
 if(['select','radio','yesno'].includes(field.type)&&!options.length)return null;
 return {question:normalize(field.label),type:field.type,options};
}

/** Whether a student-written or explicitly approved answer can be remembered. */
export function canRememberApplicationAnswer(field){return Boolean(definition(field));}

function validValue(field,value){
 const max=Number.isSafeInteger(field.maxLength)&&field.maxLength>0?Math.min(field.maxLength,2000):2000;
 return typeof value==='string'&&Boolean(value.trim())&&value.length<=max&&!controls.test(value)&&!excluded.test(value)&&!demographic.test(value)&&(!(field.options?.length)||field.options.includes(value));
}
function scopeFor(field,job,value){
 if(isCompanyMotivationQuestion(field,job)&&!(/\b(?:role|position|job|team)\b/i.test(field.label+' '+value))&&!(normalize(job.title).length>=3&&normalize(value).includes(normalize(job.title))))return 'company';
 if(experience.test(field.label)&&!roleSpecific.test(field.label)&&!includesCompany(field.label,job)&&!includesCompany(value,job)&&!roleSpecific.test(value))return 'global';
 return 'role';
}
function idFor(signature,scope,job){return hash({signature,scope,...(scope!=='global'?{company:companyBinding(job)}:{}),...(scope==='role'?{role:roleBinding(job)}:{})});}
async function ownedContext(store,job){
 if(!job||typeof job.id!=='string')return null;
 const saved=await store.get('jobs',job.id);
 if(!saved||companyBinding(saved)!==companyBinding(job)||roleBinding(saved)!==roleBinding(job)||descriptionBinding(saved)!==descriptionBinding(job))return null;
 return saved;
}

/** The caller obtains an explicit answer or approval and explains future reuse. */
export async function saveApplicationAnswerMemory(store,{field,job,value,source,resumeHash}={}){
 if(!['student','approved-ai'].includes(source))throw new HttpError(400,'Only an answer you wrote or approved can be saved for reuse.');
 const shape=definition(field);
 if(!shape||!validValue(field,value))throw new HttpError(400,'This answer cannot be saved for reuse. Use your saved profile for personal facts.');
 job=await ownedContext(store,job);if(!job)throw new HttpError(409,'The selected job changed. Open its current application before saving an answer.');
 const resume=await store.get('documents','resume');if(!hasResume(resume))throw new HttpError(400,'Upload a readable resume before saving reusable application answers.');
 // Workflow resumeHash is the existing binary hash. Text is bound separately
 // here so replacing extracted facts also invalidates a remembered answer.
 const binaryHash=createHash('sha256').update(String(resume.file||'')).digest('hex');
 if(resumeHash!==undefined&&resumeHash!==binaryHash)throw new HttpError(409,'Your resume changed. Answer this question again before saving it.');
 const signature=hash(shape),scope=scopeFor(field,job,value),id=idFor(signature,scope,job),previous=await store.get(BUCKET,id),at=new Date().toISOString();
 const record={id,version:VERSION,signature,question:field.label,type:field.type,options:shape.options,value:shape.options.length?value:value.trim(),source,scope,scopeExplanation:scopeExplanation(scope,job.company,job.title),company:job.company,roleTitle:job.title,roleKey:roleBinding(job),resumeBinding:resumeBinding(resume),...(scope!=='global'?{companyBinding:companyBinding(job),descriptionBinding:descriptionBinding(job),officialContextBinding:hash(officialCompanyContext(job.company))}:{}),...(scope==='role'?{roleBinding:roleBinding(job)}:{}),...(/\b(?:years?|months?|currently|current|recent|today)\b/i.test(field.label)?{asOfMonth:month()}:{}),createdAt:previous?.createdAt||at,updatedAt:at};
 if((await store.get('settings','account'))?.deleting)throw new HttpError(409,'Account deletion is in progress.');
 await store.put(BUCKET,id,record);return record;
}

/** A matching memory is still a suggestion, never an implicit submission. */
export async function suggestSavedApplicationAnswer(store,{field,job,resume}={}){
 const shape=definition(field);if(!shape||!await ownedContext(store,job))return null;
 const currentResume=await store.get('documents','resume');
 if(!hasResume(currentResume)||resume&&resumeBinding(resume)!==resumeBinding(currentResume))return null;
 const signature=hash(shape),binding=resumeBinding(currentResume);
 for(const scope of ['role','company','global']){
  const saved=await store.get(BUCKET,idFor(signature,scope,job));
  if(!saved||saved.version!==VERSION||saved.scope!==scope||saved.signature!==signature||saved.resumeBinding!==binding||!['student','approved-ai'].includes(saved.source)||!validValue(field,saved.value)||saved.asOfMonth&&saved.asOfMonth!==month())continue;
  if(scope!=='global'&&(saved.companyBinding!==companyBinding(job)||saved.descriptionBinding!==descriptionBinding(job)||saved.officialContextBinding!==hash(officialCompanyContext(job.company))))continue;
  if(scope==='role'&&saved.roleBinding!==roleBinding(job))continue;
  return {value:saved.value,source:'saved application answer',scope,scopeExplanation:saved.scopeExplanation,company:saved.company,roleTitle:saved.roleTitle,roleKey:saved.roleKey,reviewed:false,memoryId:saved.id,memoryUpdatedAt:saved.updatedAt,note:scope==='global'?'Your saved answer, matched to the same question and choices.':'Your saved answer for this employer, matched to the same question and current posting.'};
 }
 return null;
}

/** Private account management; tenant encryption/deletion is handled by store. */
export async function listApplicationAnswerMemory(store){
 const resume=await store.get('documents','resume'),binding=resumeBinding(resume);
 return (await store.all(BUCKET)).filter(row=>row?.version===VERSION).sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))).map(row=>({id:row.id,question:row.question,value:row.value,source:row.source,scope:row.scope,scopeExplanation:row.scopeExplanation,company:row.company,roleTitle:row.roleTitle,roleKey:row.roleKey,createdAt:row.createdAt,updatedAt:row.updatedAt,needsRefresh:row.resumeBinding!==binding||Boolean(row.asOfMonth&&row.asOfMonth!==month())||row.scope!=='global'&&row.officialContextBinding!==hash(officialCompanyContext(row.company))}));
}

export async function deleteApplicationAnswerMemory(store,id){
 if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw new HttpError(400,'Choose a saved answer from your profile.');
 if(!await store.get(BUCKET,id))throw new HttpError(404,'Saved answer not found in your account.');
 await store.delete(BUCKET,id);return {deleted:true,id};
}

/** Reuse the existing draft pipeline, with employer-specific source constraints. */
export async function generateCompanyMotivation(store,{job,question,guidance=''}={}, {generate=modelJSON,id}={}){
 if(!isCompanyMotivationQuestion(question,job))throw new HttpError(400,'Choose a question about why you want to join this employer.');
 const currentJob=await ownedContext(store,job);
 if(!currentJob||typeof currentJob.description!=='string'||currentJob.description.trim().length<20)throw new HttpError(400,'A current employer posting is needed to tailor this answer.');
 const companyContext=officialCompanyContext(currentJob.company),officialText=companyContextText(companyContext);
 // The existing draft pipeline validates evidence against its supplied job
 // source. Add attributed official context only to this read view, never to the
 // student's stored posting. Re-reads still see source changes during drafting.
 const draftStore=officialText?{...store,get:async(bucket,key)=>{
  const value=await store.get(bucket,key);
  if(bucket==='jobs'&&key===currentJob.id&&companyBinding(value)===companyBinding(currentJob))return {...value,description:`${value.description||''}\n\nOFFICIAL EMPLOYER CONTEXT (separate from this role's posting):\n${officialText}`};
  return value;
 }}:store;
 // A fresh explicit generation must not reuse an older generic cached draft.
 // Workers may supply a stable id to preserve their own queue idempotency.
 const currentResume=await store.get('documents','resume');
 const draftId=`company-motivation-${hash({request:id||randomBytes(12).toString('hex'),resume:resumeBinding(currentResume),resumeUpdatedAt:currentResume?.updatedAt,company:companyBinding(currentJob),role:roleBinding(currentJob),description:descriptionBinding(currentJob),officialContext:companyContext})}`;
 const generated=await draftCareerAnswer(draftStore,{jobId:currentJob.id,question,guidance},{id:draftId,generate:(prompt,options)=>generate(`Write this motivation answer specifically for the employer named in JOB_DATA. Connect transferable themes and achievements in RESUME_DATA to work actually described in that employer's posting. Company values, products, mission, culture, and strategy may only be stated when explicitly supported by JOB_DATA, including its separately attributed OFFICIAL EMPLOYER CONTEXT if present. Official context is a dated source snapshot, not a claim that every team operates identically. Do not use outside knowledge or infer values from a company name. Do not recycle another company's answer or invent personal enthusiasm or history. Include exact supporting evidence from BOTH resume and the role's original posting; official company evidence may supplement but never replace either. Use evidence source job for official-context quotes so the source checker can validate them; attribution is restored separately. Keep the answer under 150 words and 2,000 characters. The student must approve this draft before reuse.\n\n${prompt}`,options)});
 const evidence=(generated.evidence||[]).map(item=>{
  if(item.source!=='job'||normalize(currentJob.description).includes(normalize(item.quote)))return item;
  const source=companyContext?.sources.find(source=>source.summaries.some(summary=>item.quote.length>=20&&normalize(summary).includes(normalize(item.quote))));
  return source?{...item,source:'company',company:companyContext.company,url:source.url,checkedAt:source.checkedAt}:{...item,verified:false};
 });
 const result={...generated,evidence,companyContext};
 if(result.needsManual||result.answer.length>2000||!result.evidence.some(e=>e.source==='resume'&&e.verified&&e.quote.length>=20)||!result.evidence.some(e=>e.source==='job'&&e.verified&&e.quote.length>=20&&normalize(currentJob.description).includes(normalize(e.quote)))||result.evidence.some(e=>!e.verified))return {...result,answer:'',needsManual:true,reviewed:false,gaps:[...(result.gaps||[]),'The draft could not be grounded in both your resume and this employer’s posting. Add your own guidance or write an answer.']};
 return {...result,source:'AI draft for this employer',scope:'role',reviewed:false};
}
