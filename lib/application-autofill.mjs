import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {HttpError} from './security.mjs';
import {getCareerProfile} from './career.mjs';
import {applicationURL} from './application-providers.mjs';
import {applicationDocument,isCoverLetterField} from './application-documents.mjs';
import {savedEmploymentProfileAnswer} from './application-profile-choices.mjs';
import {savedDemographicSuggestion} from './application-suggestions.mjs';
import {suggestSavedApplicationAnswer,suggestCommonAnswer,classifyCommonQuestion,AUTOPILOT_SOURCE} from './application-answer-memory.mjs';
import {resolveApplicationResume} from './resume-enhancer.mjs';

const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const clean=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const label=value=>clean(value).replace(/[✱*]/g,'').replace(/\s*\((?:required|optional)\)\s*$/i,'').replace(/[?:.]+$/,'').trim().toLowerCase();
const bad=message=>{throw new HttpError(400,message,'application_autofill_invalid');};
const changed=()=>{throw new HttpError(409,'Your saved information changed. Click Autofill again.','application_autofill_changed');};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const TYPES=new Set(['text','email','tel','textarea','location','number','select','radio','checkbox','yesno','consent','file']);
const FIELD_KEYS=new Set(['key','label','type','required','controlId','controlName','options','optionValues','radioIds','checkboxIds','multiple','maxLength','accept','document']);
const SENSITIVE=/\b(?:password|passcode|secret|api[ -]?key|access[ -]?token|social security|ssn|passport|bank|routing|credit card|debit card|account number|payment)\b/i;
const resumeLabel=value=>/^(?:(?:please )?(?:attach|upload|provide|add|include|submit)(?: (?:a|your|the))? )?(?:resume|résumé|curriculum vitae|cv)(?:\s*\/\s*(?:resume|résumé|curriculum vitae|cv))?(?:\s+(?:upload|attachment|required|optional))?$/.test(label(value));

/** Only public HTTPS pages may receive profile data. This performs no network request. */
export function standaloneApplicationURL(value){
 if(!text(value,4096)||!value.trim())bad('Open an HTTPS job application before using Autofill.');
 let url;try{url=new URL(value);}catch{bad('Open a valid HTTPS job application.');}
 const host=url.hostname.toLowerCase();
 if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||isIP(host.replace(/^\[|\]$/g,''))||!host.includes('.')||!/^[a-z0-9.-]+$/.test(host)||host.endsWith('.')||host.split('.').some(part=>!part||part.startsWith('-')||part.endsWith('-'))||/\.(?:localhost|local|internal|test|invalid|example|lan|home|arpa)$/.test(host)||host==='localhost'||host==='app.bigredbuddy.com'||host==='bigredbuddy.com')bad('Autofill requires a public HTTPS employer application page.');
 return url.href;
}
function request(input){
 if(!plain(input)||Object.keys(input).some(key=>!['url','title','company','fields'].includes(key)))bad('Invalid application scan.');
 const url=standaloneApplicationURL(input.url);
 for(const key of ['title','company'])if(input[key]!==undefined&&!text(input[key],key==='title'?600:240))bad('Application title or company is too long.');
 if(!Array.isArray(input.fields)||!input.fields.length||input.fields.length>100||JSON.stringify(input).length>160000)bad('Scan between 1 and 100 application fields.');
 const keys=new Set();
 const fields=input.fields.map(field=>{
  if(!plain(field)||Object.keys(field).some(key=>!FIELD_KEYS.has(key))||!text(field.key,160)||!field.key||['__proto__','prototype','constructor'].includes(field.key)||keys.has(field.key)||!text(field.label,2400)||!field.label.trim()||!TYPES.has(field.type)||field.required!==undefined&&typeof field.required!=='boolean')bad('The application scan contains an unsupported field.');
  keys.add(field.key);const result={key:field.key,label:field.label,type:field.type,required:!!field.required};
  for(const key of ['controlId','controlName','accept'])if(field[key]!==undefined){if(!text(field[key],key==='accept'?1000:200))bad('Invalid application control metadata.');result[key]=field[key];}
  for(const key of ['options','optionValues','radioIds','checkboxIds'])if(field[key]!==undefined){if(!Array.isArray(field[key])||field[key].length>300||field[key].some(v=>!text(v,2400)))bad('Invalid application choices.');result[key]=[...field[key]];}
  if(field.multiple!==undefined){if(typeof field.multiple!=='boolean')bad('Invalid selection type.');if(field.multiple)result.multiple=true;}
  if(field.maxLength!==undefined){if(!Number.isSafeInteger(field.maxLength)||field.maxLength<1||field.maxLength>1000000)bad('Invalid field length.');result.maxLength=field.maxLength;}
  if(field.document!==undefined){if(field.type!=='file'||!['resume','coverLetter'].includes(field.document))bad('Invalid document type.');result.document=field.document;}
  else if(field.type==='file'&&!field.multiple){if(resumeLabel(field.label))result.document='resume';else if(isCoverLetterField(field))result.document='coverLetter';}
  return result;
 });
 return {url,title:input.title||'Job application',company:input.company||'',fields};
}
const matchingURL=value=>{try{return applicationURL(value)||standaloneApplicationURL(value);}catch{return '';}};
const sameJob=(job,url)=>matchingURL(job?.applyUrl||job?.url)===matchingURL(url);
const signature=field=>JSON.stringify({label:label(field.label),type:field.type==='location'?'text':field.type,options:field.options||[],multiple:!!field.multiple});
function fits(value,field){
 if(typeof value!=='string'||!value.trim()||value.length>Math.min(5000,field.maxLength||5000)||/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(value))return false;
 if(field.options?.length){const values=field.multiple?value.split('\n'):[value];return values.every(v=>field.options.includes(v))&&new Set(values).size===values.length;}
 return !['radio','select','checkbox','yesno','consent'].includes(field.type);
}
const PROFILE_LABELS={fullName:['full name','name','your name','legal name'],firstName:['first name','given name','preferred first name'],lastName:['last name','surname','family name'],email:['email','email address','your email','your email address'],phone:['phone','phone number','mobile phone','mobile phone number','telephone','telephone number'],currentCompany:['current company','current employer'],location:['current location','location','city and state','city, state','where are you currently located'],plannedWorkLocation:['planned work location','planned work city/state','payroll location'],linkedin:['linkedin','linkedin profile','linkedin url','linkedin profile url'],portfolio:['portfolio','portfolio url','personal website','website','website url'],availability:['availability','available start date']};
function profileAnswer(field,profile){
 const employment=savedEmploymentProfileAnswer(field,profile);if(employment!==null)return employment;
 const consentKey=['recruiting updates by sms','sms updates'].includes(label(field.label))?'recruitingSMS':['recruiting updates by whatsapp','whatsapp updates'].includes(label(field.label))?'recruitingWhatsApp':null;
 if(consentKey&&!field.multiple&&['yes','no'].includes(profile[consentKey]))return field.options?.find(option=>label(option)===profile[consentKey])||null;
 if(field.multiple||['file','consent','checkbox'].includes(field.type))return null;
 const key=Object.keys(PROFILE_LABELS).find(key=>PROFILE_LABELS[key].includes(label(field.label)));
 if(key){const value=profile[key];if(typeof value!=='string'||!value.trim())return null;return field.options?.length?field.options.find(option=>label(option)===label(value))||null:value;}
 // These preferences describe this precise question, not a different office schedule.
 if(label(field.label)==='are you comfortable working in-person at the office (in new york or san francisco) at least 3 days/week'){
  const choices={local_nyc_sf:'Yes | Currently located in the broader NYC or SF area and comfortable being in the office at least 3 days/week',relocate_nyc_sf:'Yes | Able to relocate to the NYC or SF area upon offer acceptance and comfortable being in the office at least 3 days/week',remote_only:'No | Would prefer to work remotely'};
  return field.options?.find(option=>label(option)===label(choices[profile.officeThreeDays]))||null;
 }
 return null;
}
function currentLetter(application,job,resume,profile){
 const letter=application?.coverLetter;
 return !!letter&&letter.sourceBinding===hash({resume:String(resume?.text||''),description:String(job?.description||'')})&&letter.jobBinding===hash({id:job.id,title:job.title,company:job.company,location:job.location||'',url:applicationURL(job.applyUrl||job.url)})&&letter.profileBinding===hash(profile.fullName||[profile.firstName,profile.lastName].filter(Boolean).join(' '));
}
async function acceptedAnswer(store,application,field,job,coverCurrent){
 const matches=application.form?.fields?.filter(original=>signature(original)===signature(field))||[];if(matches.length!==1)return null;
 const original=matches[0],answer=application.answers?.[original.key];
 if(!answer||answer.reviewed!==true)return null;
 if(answer.value===null)return {skip:answer.source!=='omitted optional field'};
 if(answer.source==='saved application answer'||answer.memoryId){const saved=await suggestSavedApplicationAnswer(store,{field:original,job});if(!saved||saved.memoryId!==answer.memoryId||saved.memoryUpdatedAt!==answer.memoryUpdatedAt||saved.value!==answer.value)return null;}
 if(isCoverLetterField(field)&&!coverCurrent)return null;
 return fits(answer.value,field)?{value:answer.value}:null;
}
function memorySnapshot(store){
 const reads=new Map(),buckets=new Set(['applicationAnswerMemory','applicationCommonAnswers']);
 const read=async(method,bucket,key)=>{
  if(!buckets.has(bucket))return store[method](bucket,key);
  const id=JSON.stringify([method,bucket,key]);
  if(!reads.has(id))reads.set(id,{method,bucket,key,promise:store[method](bucket,key)});
  return structuredClone(await reads.get(id).promise);
 };
 return {store:{...store,get:(bucket,key)=>read('get',bucket,key),all:bucket=>read('all',bucket)},verify:async()=>{
  for(const item of reads.values())if(hash(await store[item.method](item.bucket,item.key))!==hash(await item.promise))changed();
 }};
}

/** Authenticated, CSRF-protected, fill-only export. Never fetches a page or changes an application. */
export async function prepareStandaloneAutofill(store,input,{now=Date.now}={}){
 const scan=request(input),at=typeof now==='function'?now():now;if(!Number.isFinite(at))bad('Invalid request time.');
 const memory=memorySnapshot(store);
 const [profile,rawDemographics,account,jobs,applications,originalResume]=await Promise.all([getCareerProfile(store),store.get('career','demographics'),store.get('settings','account'),store.all('jobs'),store.all('liveApplications'),store.get('documents','resume')]);
 if(account?.deleting)throw new HttpError(409,'This account is being deleted.');
 // Identity always comes from a stored URL match, never the page's claimed company/title.
 const job=jobs.find(row=>!row.removedAt&&!row.closed&&row.status!=='closed'&&row.eligible!==false&&sameJob(row,scan.url));
 const related=applications.filter(row=>!row.removedAt&&matchingURL(row.url)===matchingURL(scan.url)).sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')));
 const application=job&&related.find(row=>row.jobId===job.id&&['collecting','ready','needs_attention','browser_handoff','uncertain'].includes(row.status));
 let selected,resumeError=false;
 try{selected=await resolveApplicationResume(store,job?.id,application?{enhancementId:application.resumeEnhancementId??null}:job?{}:{enhancementId:null});}
 catch(error){if(error instanceof HttpError&&[400,404,409].includes(error.status)){resumeError=true;selected={resume:null};}else throw error;}
 const resume=selected.resume;
 const appCurrent=!!application&&hash(profile)===application.profileHash&&typeof resume?.file==='string'&&hash(resume.file)===application.resumeHash&&(!application.resumeSourceHash||selected.sourceHash===application.resumeSourceHash)&&clean(application.title)===clean(job.title)&&clean(application.company)===clean(job.company)&&(!application.coverLetterSourceHash||application.coverLetterSourceHash===hash({resume:String(resume.text||''),description:String(job.description||'')}))&&(!application.quickJobHash||application.quickJobHash===hash({id:job.id,title:job.title,company:job.company,location:job.location||'',url:applicationURL(job.applyUrl||job.url)}));
 const coverCurrent=appCurrent&&currentLetter(application,job,resume,profile);
 const demographics={values:{...(rawDemographics?.values||{}),veteranStatus:rawDemographics?.profileWrite?'unanswered':profile.veteranStatus}};
 const answers={},documents={},omitted=[];
 for(const field of scan.fields){
  let value=null,skip=false;
  if(SENSITIVE.test([field.label,field.controlId,field.controlName].filter(Boolean).join(' '))){omitted.push(field.label);continue;}
  if(field.type==='file'){
   if(field.document==='resume'&&resume&&resumeLabel(field.label)||field.document==='coverLetter'&&coverCurrent&&isCoverLetterField(field)){
    try{const document=applicationDocument(field.document==='resume'?{...field,key:'_systemfield_resume'}:field,{resume,coverLetter:application?.coverLetter?.document});documents[field.document]={name:document.name,mimeType:'application/pdf',file:document.buffer.toString('base64'),sha256:hash(document.buffer)};value=document.name;}catch(error){if(!error.code)throw error;}
   }
  }else{
   if(appCurrent){const accepted=await acceptedAnswer(memory.store,application,field,job,coverCurrent);value=accepted?.value??null;skip=!!accepted?.skip;}
   if(value===null&&!skip)value=profileAnswer(field,profile)??savedDemographicSuggestion(field,demographics)?.value??null;
   if(value===null&&!skip&&!isCoverLetterField(field)&&!['consent','checkbox'].includes(field.type)){
    const remembered=job?await suggestSavedApplicationAnswer(memory.store,{field,job,resume}):null;
    if(remembered)value=remembered.value;
    else{
     const info=classifyCommonQuestion(field,job||{});
     // Company answers need a verified saved-job match; never trust scraped company metadata.
     if(info&&!(info.category==='question'&&info.scope!=='global')&&(!info.companyFact&&!info.namesCompany&&info.scope==='global'||job)){
      const common=await suggestCommonAnswer(memory.store,{field,job:job||{},resume,profile});
      if(common&&common.source!==AUTOPILOT_SOURCE){
       const record=common.memoryId?await memory.store.get('applicationCommonAnswers',common.memoryId):null;
       // Categories alone lose constraints such as city, office days, or salary type.
       // Company/role narratives instead require the stricter résumé/role-bound memory above.
       if(record&&label(record.question)===label(field.label))value=common.value;
      }
     }
    }
   }
  }
  if(value!==null&&(field.type==='file'||fits(value,field)))answers[field.key]={value};else omitted.push(field.label);
 }
 // Avoid exporting data across an account deletion or a concurrent profile/application edit.
 if((await store.get('settings','account'))?.deleting||hash(await getCareerProfile(store))!==hash(profile)||hash(await store.get('career','demographics'))!==hash(rawDemographics)||hash(await store.get('documents','resume'))!==hash(originalResume)||application&&hash(await store.get('liveApplications',application.id))!==hash(application)||job&&hash(await store.get('jobs',job.id))!==hash(job))changed();
 if(selected.enhancementId){let fresh;try{fresh=await resolveApplicationResume(store,job.id,{enhancementId:selected.enhancementId});}catch(error){if(error instanceof HttpError&&[400,404,409].includes(error.status))changed();throw error;}if(hash(fresh.resume)!==hash(resume))changed();}
 await memory.verify();
 return {version:1,mode:'standalone',url:scan.url,title:scan.title,company:job?.company||scan.company,fields:scan.fields,answers,documents,omitted,expiresAt:at+5*60*1000,priorSubmissionUnconfirmed:related.some(row=>row.status==='uncertain'&&typeof row.submitAttemptAt==='string'&&Number.isFinite(Date.parse(row.submitAttemptAt))),alreadySubmitted:related.some(row=>row.status==='submitted'),submissionInProgress:related.some(row=>['queued','submitting'].includes(row.status)),...(job?{jobId:job.id,jobTitle:job.title}:{}),...(resumeError?{resumeNeedsRefresh:true}:{})};
}
