import {createHash} from 'node:crypto';
import {idFor} from './domain.mjs';
import {HttpError} from './security.mjs';
import {menuCard} from './telegram-menu.mjs';
import {getCareerProfile,saveCareerProfile,draftCareerAnswer} from './career.mjs';
import {readCareerExperience,analyzeCareerExperience} from './career-experience.mjs';
import {pauseDemographics,getDemographics} from './demographics.mjs';
import {savedDemographicSuggestion} from './application-suggestions.mjs';
import {applicationURL,applicationProvider,applicationProviderFor,liveApplicationSupported} from './application-providers.mjs';
import {pilotWorkAllowed} from './pilot-access.mjs';
import {offerReferralBeforeApplication} from './linkedin-referrals-telegram.mjs';
import {isCoverLetterField} from './application-documents.mjs';
import {createApplicationCoverLetter} from './application-cover-letter.mjs';
import {canRememberApplicationAnswer,saveApplicationAnswerMemory,suggestSavedApplicationAnswer,isCompanyMotivationQuestion,generateCompanyMotivation} from './application-answer-memory.mjs';
import {officialCompanyContext} from './company-context.mjs';
import {employmentProfileField,savedEmploymentProfileAnswer} from './application-profile-choices.mjs';
import {canCreateApplicationHandoff} from './application-handoff.mjs';

const BUCKET='liveApplications',now=()=>new Date().toISOString();
const fingerprint=resume=>createHash('sha256').update(String(resume?.file||'')).digest('hex');
const profileFingerprint=profile=>createHash('sha256').update(JSON.stringify(profile)).digest('hex');
const coverProfileFingerprint=profile=>createHash('sha256').update(profile.fullName||[profile.firstName,profile.lastName].filter(Boolean).join(' ')).digest('hex');
const coverLetterSourceHash=(resume,job)=>createHash('sha256').update(JSON.stringify({resume:String(resume?.text||''),description:String(job?.description||'')})).digest('hex');
const draftSourceHash=(resume,job)=>createHash('sha256').update(JSON.stringify({resume:fingerprint(resume),sources:coverLetterSourceHash(resume,job),job:quickApplicationJobFingerprint(job),company:officialCompanyContext(job.company)})).digest('hex');
export const quickApplicationJobFingerprint=job=>createHash('sha256').update(JSON.stringify({id:job.id,title:job.title,company:job.company,location:job.location||'',url:applicationURL(job.applyUrl||job.url)})).digest('hex');
const settingsURL=()=>`${process.env.APP_ORIGIN}/#career-profile`;
const handoffURL=a=>`${process.env.APP_ORIGIN}/#application-handoff/${a.id}`;
const handoffAction=a=>[['Open & fill in my browser',{url:handoffURL(a)}]];
const handoffInstructions='Open the BRB link in desktop Chrome, then click the B helper on that BRB tab to fill supported fields and attach your saved documents. Finish any remaining questions on the employer page.';
const handoffAvailable=(store,a)=>canCreateApplicationHandoff(store,{applicationId:a.id,revision:a.revision});
const fail=message=>{throw new HttpError(400,message);};
const own=(object,key)=>Object.hasOwn(object||{},key);
const terminal=new Set(['submitted','submitting','uncertain','queued','browser_handoff']);
const applicationCard=(store,queue,a,text,actions,key)=>menuCard(store,queue,text,actions,key,{binding:{chatId:a.chatId,linkedAt:a.linkedAt,applicationId:a.id,revision:a.revision}});
const applicationAction=(a,op,extra={})=>({liveApplication:{id:a.id,revision:a.revision,op,...extra}});
const bound=async(store,a)=>{const t=await store.get('secrets','telegram');return t?.chatId&&String(t.chatId)===a.chatId&&(t.linkedAt||'')===a.linkedAt&&!(await store.get('settings','account'))?.deleting;};
const hasGeneratedCoverLetter=a=>Boolean(a.coverLetter?.text&&a.form?.fields.some(f=>isCoverLetterField(f)&&a.answers[f.key]?.value!=null&&a.answers[f.key]?.value===(f.type==='file'?a.coverLetter.document?.name:a.coverLetter.text)));
async function coverLetterCurrent(store,a,job){
 return !hasGeneratedCoverLetter(a)||(a.coverLetter.sourceBinding===coverLetterSourceHash(await store.get('documents','resume'),job)&&a.coverLetter.jobBinding===quickApplicationJobFingerprint(job)&&a.coverLetter.profileBinding===coverProfileFingerprint(await getCareerProfile(store)));
}
async function prepareRequiredCoverLetter(store,a,form,resume,job,profile,generate){
 const fields=form.fields.filter(f=>f.required&&isCoverLetterField(f));if(!fields.length)return {};
 const sourceBinding=coverLetterSourceHash(resume,job),jobBinding=quickApplicationJobFingerprint(job),profileBinding=coverProfileFingerprint(profile);
 const generated=await generate({resume,job,fullName:profile.fullName||[profile.firstName,profile.lastName].filter(Boolean).join(' '),fields});
 if(!generated?.text)throw Object.assign(Error('COVER_LETTER_INVALID_OUTPUT'),{code:'COVER_LETTER_INVALID_OUTPUT'});
 const coverLetter={...generated,sourceBinding,jobBinding,profileBinding},result=quickApplicationAnswers({fields},profile,a.resumeName,{coverLetter});
 if(result.missing.length)throw Object.assign(Error('COVER_LETTER_INVALID_OUTPUT'),{code:'COVER_LETTER_INVALID_OUTPUT'});
 const latestJob=await store.get('jobs',a.jobId),latestResume=await store.get('documents','resume');
 if(!latestJob||sourceBinding!==coverLetterSourceHash(latestResume,latestJob)||jobBinding!==quickApplicationJobFingerprint(latestJob)||profileBinding!==coverProfileFingerprint(await getCareerProfile(store))||fingerprint(latestResume)!==a.resumeHash||!await bound(store,a))throw Error('QUICK_AUTHORIZATION_CHANGED');
 return {coverLetter,answers:result.answers};
}
async function change(store,a,patch){const next={...a,...patch,revision:a.revision+1,updatedAt:now()};if(!await store.compareAndSet(BUCKET,a.id,a,next))throw new HttpError(409,'This application changed. Open its latest review.');return next;}
function profileField(field){
 const employment=employmentProfileField(field);if(employment)return employment;
 if(['workAuthorizationUS','sponsorship'].includes(field.profileField))return null;
 const hints={fullName:'fullName',firstName:'firstName',lastName:'lastName',email:'email',phone:'phone',currentCompany:'currentCompany',linkedin:'linkedin',portfolio:'portfolio',location:'location',currentLocation:'location',workAuthorizationUS:'workAuthorizationUS',sponsorship:'sponsorship'};
 if(Object.hasOwn(hints,field.profileField))return hints[field.profileField];
 if(field.key==='_systemfield_name')return 'fullName';if(field.key==='_systemfield_email')return 'email';
 if(field.type==='tel'&&/^phone(?: number)?$/i.test(field.label))return 'phone';if(/^linkedin profile$/i.test(field.label))return 'linkedin';
 if(field.key==='_systemfield_location'&&/payroll/i.test(field.label))return 'plannedWorkLocation';
 if(field.key==='smsConsent'&&field.type==='consent'&&/^(?:Recruiting updates by SMS|SMS updates)$/i.test(field.label))return 'recruitingSMS';
 if(field.key==='whatsAppConsent'&&field.type==='consent'&&/^(?:Recruiting updates by WhatsApp|WhatsApp updates)$/i.test(field.label))return 'recruitingWhatsApp';
 if(field.type==='radio'&&/New York or San Francisco/.test(field.label)&&/3 days\/week/.test(field.label))return 'officeThreeDays';
 return null;
}
function profileAnswer(field,profile){
 const key=profileField(field),value=profile[key];if(!key||!value||value==='unanswered')return null;
 if(['workAuthorizationUS','sponsorship'].includes(key))return savedEmploymentProfileAnswer(field,profile);
 if(field.type==='consent'){
  const accepted=key==='recruitingSMS'?{yes:['yes - i consent to receiving sms text messages','yes, text me'],no:['no - i do not consent to receiving sms text messages','no, do not text me']}:key==='recruitingWhatsApp'?{yes:['yes - i consent to receiving whatsapp messages','yes, contact me'],no:['no - i do not consent to receiving whatsapp messages','no, do not contact me']}:{};
  return field.options.find(option=>accepted[value]?.includes(option.replace(/\s+/g,' ').trim().toLowerCase()))||null;
 }
 if(key==='officeThreeDays'){const pattern={local_nyc_sf:/^Yes.*Currently located/,relocate_nyc_sf:/^Yes.*Able to relocate/,remote_only:/^No/}[value];return pattern?field.options.find(o=>pattern.test(o))||null:null;}
 // Do not insert a saved value that is not one of the employer's choices.
 if(field.options?.length)return field.options.find(o=>o.toLowerCase()===value.toLowerCase())||null;
 return value;
}
/** Ordinary answers reuse saved facts; a required letter comes from the grounded generator. */
export function quickApplicationAnswers(form,profile,resumeName,{coverLetter}={}){
 const answers={},missing=[];
 for(const field of form.fields){
  if(field.required&&isCoverLetterField(field)&&coverLetter){
   const value=field.type==='file'?coverLetter.document?.name:coverLetter.text;
   if(typeof value!=='string'||!value.trim()||value.length>(field.type==='file'?240:Math.min(2000,field.maxLength>0?field.maxLength:2000))){missing.push(field.label);continue;}
   answers[field.key]={value,source:'generated cover letter from resume and role',reviewed:true};continue;
  }
  const isResume=field.type==='file'&&field.key==='_systemfield_resume';
  const key=profileField(field),knownConsent=['recruitingSMS','recruitingWhatsApp'].includes(key);
  // Never turn a new checkbox, legal certification, or unfamiliar consent into an accepted declaration.
  const consent=/\b(?:consent|agree|certify|certification|terms|privacy|acknowledge)\b/i.test(field.label||'');
  let value=isResume?resumeName:field.type==='file'||field.multiple||(consent||field.type==='consent'||field.type==='checkbox')&&!knownConsent?null:profileAnswer(field,profile);
  // Office preferences describe this exact question, not other schedules or conditions.
  if(key==='officeThreeDays'){
   const normalize=text=>String(text||'').replace(/\s+/g,' ').trim().toLowerCase();
   const label='Are you comfortable working in-person at the office (in New York or San Francisco) at least 3 days/week?';
   const options={local_nyc_sf:'Yes | Currently located in the broader NYC or SF area and comfortable being in the office at least 3 days/week',relocate_nyc_sf:'Yes | Able to relocate to the NYC or SF area upon offer acceptance and comfortable being in the office at least 3 days/week',remote_only:'No | Would prefer to work remotely'};
   value=normalize(field.label)===normalize(label)?field.options?.find(option=>normalize(option)===normalize(options[profile.officeThreeDays]))||null:null;
  }
  if(value!==null&&(typeof value!=='string'||!value.trim()||value.length>2000))value=null;
  if(value===null&&field.required){missing.push(field.label);continue;}
  answers[field.key]={value,source:isResume?'saved resume':value===null?'omitted optional field':'saved profile',reviewed:true};
 }
 return {answers,missing};
}
async function quickAuthorizationCurrent(store,a,job){
 const resume=await store.get('documents','resume');
 return Boolean(job&&a.mode==='quick'&&a.quickAuthorizationExpiresAt>Date.now()&&a.quickJobHash===quickApplicationJobFingerprint(job)&&a.profileHash===profileFingerprint(await getCareerProfile(store))&&a.resumeHash===fingerprint(resume)&&(a.coverLetterPolicy!==1||a.coverLetterSourceHash===coverLetterSourceHash(resume,job))&&await bound(store,a));
}
async function renewQuickInteraction(store,a){
 if(a.mode!=='quick')return a;
 if(!await quickAuthorizationCurrent(store,{...a,quickAuthorizationExpiresAt:Date.now()+30000},await store.get('jobs',a.jobId)))fail('Your job, résumé, or saved profile changed. Choose Apply now again.');
 return change(store,a,{quickAuthorizationExpiresAt:Date.now()+30*60000});
}
async function rememberedAnswersCurrent(store,a,job){
 for(const f of a.form.fields){const answer=a.answers[f.key];if(answer?.source!=='saved application answer')continue;const saved=await suggestSavedApplicationAnswer(store,{field:f,job});if(!saved||saved.memoryId!==answer.memoryId||saved.memoryUpdatedAt!==answer.memoryUpdatedAt||saved.value!==answer.value)return false;}
 return true;
}
async function prepareQuickAnswers(store,a,form,profile,resume,job){
 const {answers}=quickApplicationAnswers(form,profile,a.resumeName);
 for(const f of form.fields){
  const old=a.form?.fields.find(old=>old.key===f.key),answer=a.answers?.[f.key];
  if(old&&JSON.stringify(old)===JSON.stringify(f)&&answer?.reviewed&&['student','reviewed estimate or AI draft','student-reviewed preference'].includes(answer.source)&&(!profileField(f)||profileAnswer(f,profile)===null||profileAnswer(f,profile)===answer.value))answers[f.key]=answer;
  if(!answers[f.key]||answers[f.key].value===null){const saved=await suggestSavedApplicationAnswer(store,{field:f,job,resume});if(saved)answers[f.key]={...saved,reviewed:true};}
 }
 return {answers,missing:form.fields.filter(f=>f.required&&!answers[f.key]?.value).map(f=>f.label)};
}
const choiceValues=(a,f)=>a.choices[f.key]||f.options||[];
const selections=(a,f)=>a.selections?.[f.key]??(a.answers[f.key]?.value?.split('\n')||[]);
const selectedValues=value=>String(value||'').split('\n').map(v=>v.trim()).filter(Boolean);
async function toggleChoice(store,a,index,value,extra={}){
 const f=a.form.fields[index],choices=choiceValues(a,f);if(!f.multiple||!choices.includes(value))fail('Choose an option from this question.');
 const selected=new Set(selections(a,f));if(selected.has(value))selected.delete(value);else selected.add(value);
 if(selected.size>(f.maxChoices||20))fail(`Choose at most ${f.maxChoices||20} options.`);
 return change(store,a,{status:'collecting',activeField:index,selections:{...a.selections,[f.key]:choices.filter(c=>selected.has(c))},...extra});
}
export function experienceSuggestion(field,experience){
 const match=field.label.match(/minimum of (\d+) years of product management experience/i);if(!match||!experience?.roles?.length||experience.stale)return null;
 const roles=experience.roles.filter(r=>/\bproduct (?:manager|management|owner)\b|\b(?:head|director|vp|vice president) of product\b/i.test(r.title)&&!['internship','part-time','contract','volunteer','other'].includes(r.employmentType));
 const months=new Set();let ambiguous=false;
 for(const r of roles){if(!/^\d{4}-\d{2}$/.test(r.startMonth||'')||!/^\d{4}-\d{2}$/.test(r.endMonth==='present'?experience.asOfMonth:r.endMonth||'')){ambiguous=true;continue;}const from=Number(r.startMonth.slice(0,4))*12+Number(r.startMonth.slice(5))-1,end=r.endMonth==='present'?experience.asOfMonth:r.endMonth,to=Math.min(Number(end.slice(0,4))*12+Number(end.slice(5))-1,Number(experience.asOfMonth.slice(0,4))*12+Number(experience.asOfMonth.slice(5))-1);if(r.employmentType!=='full-time')ambiguous=true;for(let i=from;i<=to&&i<from+1200;i++)months.add(i);}
 const years=Math.round(months.size/12*10)/10;
 return {value:months.size>=Number(match[1])*12?'Yes':'No',source:'experience estimate',reviewed:false,note:`Resume estimate: ${years} years in clearly titled product-management roles${roles.length?`: ${roles.map(r=>r.title).join('; ')}`:'. No explicit product-management titles found'}. ${ambiguous?'Some employment types or dates need checking. ':''}Related responsibilities may not be captured by titles. Check this answer before using it.`};
}
async function enqueue(queue,store,a,type,extra={}){
 const task=await queue.enqueue(store.userId,type,{applicationId:a.id,revision:a.revision,...extra},{idempotencyKey:`live:${type}:${a.id}:${a.revision}`,retrySafe:false,maxAttempts:1});
 await store.put('liveApplicationTasks',`${a.id}:${a.revision}`,{id:task.id,revision:a.revision,type});return task;
}
async function queueOrPause(queue,store,a,type,extra={}){
 try{await enqueue(queue,store,a,type,extra);return a;}
 catch{return change(store,a,{status:'needs_attention',error:'Nothing was submitted. Processing could not be queued. Your answers are saved.'});}
}
/** Called only by an explicit per-job Apply now command/button. No additional review is required. */
export async function startQuickApplication(store,queue,jobId,key,{expectedJobHash}={}){
 const job=await store.get('jobs',jobId);
 if(!job||job.closed||job.status==='closed'||job.eligible===false||!liveApplicationSupported(job))fail('This employer form is not supported for direct Telegram submission.');
 if(expectedJobHash&&quickApplicationJobFingerprint(job)!==expectedJobHash)fail('This job’s details changed. Open a fresh job card before choosing Apply now.');
 if(job.titlePending||!job.title||!job.company)fail('Open a saved role with a confirmed title and company before choosing Apply now.');
 const t=await store.get('secrets','telegram');if(!t?.chatId)fail('Link Telegram in Connections first.');
 const resume=await store.get('documents','resume');if(!resume?.file)fail('Upload your PDF resume first in Resume & Profile.');
 const profile=await getCareerProfile(store),provider=applicationProvider(job.applyUrl||job.url),id=idFor(`${provider.id}-application`,provider.url),existing=await store.get(BUCKET,id);
 if(existing){
  if(!await bound(store,existing))fail('The Telegram connection changed. Contact the operator to recover this application safely.');
  if(existing.submitAttemptAt||terminal.has(existing.status)||existing.mode==='quick'&&(['inspecting','collecting','drafting','locating'].includes(existing.status)||existing.quickRequestKey===String(key))){await store.put('settings','liveApplicationFlow',{id:existing.id});return showLiveApplication(store,queue,existing,key);}
  if(existing.status!=='cancelled'&&existing.mode!=='quick')return applicationCard(store,queue,existing,'There is already a guided application for this role. Cancel it before choosing Apply now so old drafts are not sent.',[[['Open existing application',applicationAction(existing,'show')],['Cancel existing application',applicationAction(existing,'cancel')]]],key);
 }
 const keepAnswers=existing?.status==='needs_attention'&&existing.resumeHash===fingerprint(resume)&&existing.quickJobHash===quickApplicationJobFingerprint(job)&&existing.coverLetterSourceHash===coverLetterSourceHash(resume,job);
 const a={id,jobId,url:provider.url,provider:provider.id,title:job.title,company:job.company,mode:'quick',status:'inspecting',revision:(existing?.revision||0)+1,chatId:String(t.chatId),linkedAt:t.linkedAt||'',resumeHash:fingerprint(resume),resumeName:resume.name||'Resume.pdf',profileHash:profileFingerprint(profile),quickJobHash:quickApplicationJobFingerprint(job),coverLetterPolicy:1,coverLetterSourceHash:coverLetterSourceHash(resume,job),quickRequestKey:String(key),authorizedAt:now(),quickAuthorizationExpiresAt:Date.now()+30*60000,answers:keepAnswers?existing.answers:{},...(keepAnswers?{form:existing.form}:{}),drafts:{},choices:{},createdAt:existing?.createdAt||now(),updatedAt:now()};
 if(!await store.compareAndSet(BUCKET,id,existing,a))fail('This application is already starting. Open its progress.');
 await pauseDemographics(store,{finish:true});await store.put('settings','liveApplicationFlow',{id});
 try{await enqueue(queue,store,a,'application-inspect');}catch{await change(store,a,{status:'needs_attention',error:'Could not queue the application. Choose Apply now again.'});throw new HttpError(503,'Could not queue the application. Try again.');}
 return applicationCard(store,queue,a,`Applying to ${job.title} at ${job.company} using your saved profile and ${a.resumeName}. I’ll ask for missing answers here, remember reusable answers, and submit when complete. If the employer needs you to finish in a browser, I’ll send an Open & fill button once the form is ready. Required cover letters are written from your résumé and the role description and included automatically.`,[[['Application progress',applicationAction(a,'show')]]],key);
}
export async function startLiveApplicationFromURL(store,queue,value,key){
 const provider=applicationProvider(value);
 if(!provider||!liveApplicationSupported({url:value}))fail('This link is not supported for Telegram submission. Open the employer’s application page to continue.');
 const t=await store.get('secrets','telegram');if(!t?.chatId)fail('Link Telegram in Connections first.');
 if(!(await store.get('documents','resume'))?.file)fail('Upload your PDF resume first in Resume & Profile.');
 // A pasted link is an explicit choice, not a newly discovered matching job.
 // It has no publication date and cannot qualify for recent-job alerts.
 const matches=(await store.all('jobs')).filter(job=>applicationURL(job.applyUrl||job.url)===provider.url);
 let job=matches.find(job=>!job.closed&&job.status!=='closed'&&job.eligible!==false)||matches[0];
 if(!job){
  const id=idFor('application-link',provider.url),company=new URL(provider.url).pathname.split('/')[1];
  job={id,title:'Employer application',company,url:provider.url,applyUrl:provider.url,source:'student-link',provider:provider.id,titlePending:true,publicationStatus:'unknown',createdAt:now()};
  if(!await store.compareAndSet('jobs',id,null,job))job=await store.get('jobs',id);
 }
 return startLiveApplication(store,queue,job.id,key);
}
export async function startLiveApplication(store,queue,jobId,key,{skipReferral=false}={}){
 const job=await store.get('jobs',jobId);if(!job||job.closed||job.status==='closed'||job.eligible===false||!liveApplicationSupported(job))fail('This employer form is not supported for Telegram submission. Open the employer posting.');
 const t=await store.get('secrets','telegram');if(!t?.chatId)fail('Link Telegram in Connections to continue this application.');
 const resume=await store.get('documents','resume');if(!resume?.file)fail('Upload your PDF resume first in Resume & Profile.');
 const provider=applicationProvider(job.applyUrl||job.url),url=provider.url,id=idFor(`${provider.id}-application`,url),existing=await store.get(BUCKET,id);
 if(existing&&existing.status!=='cancelled'){
  if(!await bound(store,existing))fail('The Telegram connection changed. Contact the operator to recover this application safely.');
  return showLiveApplication(store,queue,existing,key);
 }
 if(!skipReferral&&!job.titlePending&&await offerReferralBeforeApplication(store,queue,job,key))return;
 const a={id,jobId,url,provider:provider.id,title:job.title,titlePending:job.source==='student-link'&&job.titlePending===true,company:job.company,status:'inspecting',revision:(existing?.revision||0)+1,chatId:String(t.chatId),linkedAt:t.linkedAt||'',resumeHash:fingerprint(resume),resumeName:resume.name||'Resume.pdf',answers:{},drafts:{},choices:{},createdAt:now(),updatedAt:now()};
 if(!await store.compareAndSet(BUCKET,id,existing,a))fail('This application is already starting. Open it again.');
 await pauseDemographics(store,{finish:true});
 await store.put('settings','liveApplicationFlow',{id});
 try{await enqueue(queue,store,a,'application-inspect');}catch{await change(store,a,{status:'needs_attention',error:'The application could not be queued. Retry inspection.'});throw new HttpError(503,'Could not queue application inspection. Try again.');}
 return applicationCard(store,queue,a,`Reading the real application for ${job.title} at ${job.company}. I’ll reuse your saved profile, ask only for missing answers, remember reusable answers, and show a review before you submit.`,[[['Application progress',applicationAction(a,'show')]]],key);
}
export async function showLiveApplication(store,queue,a,key){
 if(!await bound(store,a))return;
 if(['inspecting','drafting','locating','queued','submitting'].includes(a.status)&&queue.get){
  const marker=await store.get('liveApplicationTasks',`${a.id}:${a.status==='submitting'?a.revision-1:a.revision}`),task=marker&&await queue.get(store.userId,marker.id);
  if(task&&['failed','needs_review','expired'].includes(task.status))a=await change(store,a,{status:a.submitAttemptAt?'uncertain':'needs_attention',error:a.submitAttemptAt?'The worker stopped after a submission attempt. Check for an employer receipt.':'Processing was interrupted before submission. Retry inspection.'});
 }
 if(a.status==='submitted')return applicationCard(store,queue,a,`Submitted to ${a.company}: ${a.title}\n\n${a.receipt.confirmation}\nConfirmed ${a.receipt.confirmedAt}\nResume: ${a.resumeName}${hasGeneratedCoverLetter(a)?'\nCover letter: included, tailored to this role':''}`,[[['Open employer posting',{url:a.url}]],...(hasGeneratedCoverLetter(a)?[[['View sent cover letter',applicationAction(a,'cover-letter')]]]:[])],key);
 if(a.status==='browser_handoff'||a.status==='uncertain'){
  const canHandoff=await handoffAvailable(store,a),uncertain=a.status==='uncertain';
  const text=uncertain?`${a.company} application: receipt unconfirmed. A previous submission attempt may have reached the employer. Check for an employer confirmation before submitting again. BRB will not retry this submission.`:`Continue your ${a.company} application in your browser. BRB has stopped automatic submission for this application.`;
  return applicationCard(store,queue,a,`${text}\n\n${canHandoff?`${handoffInstructions} Each time you use the helper, it creates a fresh handoff. The helper fills fields; you submit on the employer page.`:'Your saved details or application form changed, so a browser autofill handoff is not ready. Open the employer page to continue manually.'}`,[...(canHandoff?[handoffAction(a)]:[[['Resume & Profile',{url:settingsURL()}]]]),[['Check progress',applicationAction(a,'show')],['Open employer posting',{url:a.url}]]],key);
 }
 if(terminal.has(a.status))return applicationCard(store,queue,a,a.status==='queued'?`Your ${a.mode==='quick'?'saved-profile':'reviewed'} application to ${a.company} is queued for submission.`:`${a.company} application: ${a.status==='uncertain'?'receipt unconfirmed':'submission in progress'}. BRB will not automatically retry a submission. Check the employer confirmation before applying again.`,[[['Check progress',applicationAction(a,'show')],['Open employer posting',{url:a.url}]]],key);
 if(a.status==='inspecting'||a.status==='drafting'||a.status==='locating')return applicationCard(store,queue,a,`Working on your ${a.company} application. ${a.mode==='quick'?'I’ll ask for missing answers here, then send the employer confirmation or a browser handoff if you need to finish there.':'Your next question will appear here.'}`,[[['Check progress',applicationAction(a,'show')]]],key);
 if(a.status==='cancelled')return applicationCard(store,queue,a,'Application cancelled. Nothing was submitted.',[[['Jobs',{page:'jobs'}]]],key);
 if(a.status==='needs_attention'){
  const canHandoff=await handoffAvailable(store,a);
  const next=canHandoff?`Your saved application is ready to fill in your browser. ${handoffInstructions}`:'A browser autofill handoff is not ready. Retry inspection or check Resume & Profile; you can also open the employer page to continue manually.';
  const retry=a.mode==='quick'?[[['Try Apply now again',{quickApply:{jobId:a.jobId,jobHash:a.quickJobHash}}],['Use guided application',applicationAction(a,'guided')]]]:[[['Retry inspection',applicationAction(a,'retry')],['Apply when complete',applicationAction(a,'quick')]]];
  return applicationCard(store,queue,a,`${a.company} application needs attention. ${a.error||'Please review the employer page.'}\n\n${next}`,[...(canHandoff?[handoffAction(a)]:[]),...retry,[['Resume & Profile',{url:settingsURL()}],['Open employer posting',{url:a.url}]]],key);
 }
 const index=a.activeField??a.form.fields.findIndex(f=>(!own(a.answers,f.key)||!a.answers[f.key].reviewed)&&!(a.mode==='quick'&&f.required&&isCoverLetterField(f)));
 if(index>=0){
  const f=a.form.fields[index],draft=a.drafts[f.key],choices=choiceValues(a,f),filter=a.choiceFilter||'';
  if(a.mode==='quick'&&f.type==='textarea'&&!draft&&!a.generationAttempted?.includes(f.key)&&isCompanyMotivationQuestion(f,await store.get('jobs',a.jobId))){
   a=await change(store,a,{status:'drafting',activeField:index,generationAttempted:[...(a.generationAttempted||[]),f.key]});a=await queueOrPause(queue,store,a,'application-answer',{field:index});return showLiveApplication(store,queue,a,key);
  }
  const filtered=choices.map((choice,i)=>({choice,i})).filter(({choice})=>!filter||choice.toLowerCase().includes(filter.toLowerCase()));
  const offset=Math.max(0,Math.min(a.choiceOffset||0,Math.max(0,filtered.length-1))),visible=filtered.slice(offset,offset+5),selected=selections(a,f);
  const rows=visible.map(({choice,i})=>[[`${f.multiple&&selected.includes(choice)?'✓ ':''}${i+1}. ${choice}`.slice(0,64),applicationAction(a,'answer',{field:index,choice:i})]]);
  const pages=[];if(offset)pages.push(['Previous choices',applicationAction(a,'choices',{field:index,offset:Math.max(0,offset-5)})]);if(offset+5<filtered.length)pages.push(['More choices',applicationAction(a,'choices',{field:index,offset:offset+5})]);if(filter)pages.push(['All choices',applicationAction(a,'choices',{field:index,offset:0,clear:true})]);if(pages.length)rows.push(pages);
  if(f.multiple&&selected.length)rows.push([['Done selecting',applicationAction(a,'selection-done',{field:index})]]);
  if(draft)rows.unshift([[draft.source==='saved demographic preference'?'Use saved preference':'Use suggested answer',applicationAction(a,'use-draft',{field:index})]]);
  if(f.type==='textarea')rows.push([['Draft with AI',applicationAction(a,'generate',{field:index})]]);
  if(!f.required)rows.push([['Skip optional question',applicationAction(a,'skip',{field:index})]]);
  rows.push([['Resume & Profile',{url:settingsURL()}],['Use saved profile',applicationAction(a,'profile')]]);
  if(a.mode!=='quick')rows.push([['Apply when complete',applicationAction(a,'quick')]]);
  if(await handoffAvailable(store,a))rows.push(handoffAction(a));
  rows.push([['Cancel application',applicationAction(a,'cancel')]]);
  let text=`${a.company} · ${a.title}\nQuestion ${index+1} of ${a.form.fields.length}\n\n${f.label}${f.type==='consent'?'\n'+a.form.consentText:''}${choices.length?'\n\n'+visible.map(({choice,i})=>`${i+1}. ${choice}`).join('\n'):''}${filter?`\nShowing matches for “${filter}” (${filtered.length}).`:''}${f.multiple?`\n\nSelected: ${selected.join('; ')||'None'}\nTap choices, then Done selecting.`:''}${draft?`\n\nSuggested answer (review first):\n${draft.value}${draft.note?'\n'+draft.note:''}`:''}\n\n${choices.length?'Tap a choice or reply with its number.'+(choices.length>5?' Type part of an option to find it.':''):'Type your answer here.'}${profileField(f)?' I’ll save this detail in Resume & Profile when its wording matches a profile field.':canRememberApplicationAnswer(f)?' I’ll remember reusable answers. You can remove them in Resume & Profile.':''}${a.answerNotice?'\n\n'+a.answerNotice:''}`;
  await store.put('settings','liveApplicationFlow',{id:a.id,field:index,revision:a.revision});
  let part=0;while(text.length>3300){await applicationCard(store,queue,a,text.slice(0,3300),[[['Application progress',applicationAction(a,'show')]]],`${key}:question:${part++}`);text=text.slice(3300);}
  return applicationCard(store,queue,a,text,rows,key);
 }
 if(a.mode==='quick'){
  const selectedJob=await store.get('jobs',a.jobId);
  if(!await quickAuthorizationCurrent(store,a,selectedJob)||!await rememberedAnswersCurrent(store,a,selectedJob)){
   a=await change(store,a,{status:'needs_attention',error:'Your saved details or authorization changed. Choose Apply now again.'});return showLiveApplication(store,queue,a,key);
  }
  if(a.form.fields.some(f=>f.required&&isCoverLetterField(f)&&!a.answers[f.key]?.value)){
   a=await change(store,a,{status:'drafting',activeField:null});a=await queueOrPause(queue,store,a,'application-answer',{coverLetter:true});return showLiveApplication(store,queue,a,key);
  }
  a=await change(store,a,{status:'queued',activeField:null});a=await queueOrPause(queue,store,a,'application-submit');return showLiveApplication(store,queue,a,key);
 }
 if(a.status!=='ready'||a.reviewExpiresAt<Date.now())a=await change(store,a,{status:'ready',reviewExpiresAt:Date.now()+30*60000,activeField:null});
 await store.put('settings','liveApplicationFlow',{id:a.id});
 let chunk=`Review your application to ${a.company}\n${a.title}\nResume: ${a.resumeName}\n`,part=0;
 for(const f of a.form.fields){let line=`\n${f.label}\n${a.answers[f.key].value??'Not provided (optional)'}${f.type==='file'&&isCoverLetterField(f)&&hasGeneratedCoverLetter(a)?'\n'+a.coverLetter.text:''}\n`;while(line.length){const count=Math.min(3300-chunk.length,line.length);chunk+=line.slice(0,count);line=line.slice(count);if(chunk.length===3300){await applicationCard(store,queue,a,chunk,[[['Edit an answer',applicationAction(a,'edit')]]],`${key}:review:${part++}`);chunk='';}}}
 await applicationCard(store,queue,a,chunk,[[['Edit an answer',applicationAction(a,'edit')]]],`${key}:review:${part++}`);
 const canHandoff=await handoffAvailable(store,a);
 return applicationCard(store,queue,a,`Ready to send these reviewed answers and ${a.resumeName} to ${a.company} through ${applicationProviderFor(a).label}? The Submit button sends the real job application.${canHandoff?' Or open and fill the application in your browser to finish there.':''}`,[[[`Submit to ${a.company}`.slice(0,64),applicationAction(a,'submit')]],...(canHandoff?[handoffAction(a)]:[]),[['Edit answers',applicationAction(a,'edit')],['Cancel application',applicationAction(a,'cancel')]],[['Open employer form & terms',{url:a.url}]]],`${key}:submit`);
}
async function refreshProfile(store,a){
 const profile=await getCareerProfile(store),answers={...a.answers};
 for(const f of a.form.fields){const value=profileAnswer(f,profile);if(!answers[f.key]||['profile','saved profile'].includes(answers[f.key].source)||answers[f.key].source==='omitted optional field'&&answers[f.key].value===null){if(value)answers[f.key]={value,source:'profile',reviewed:true};else if(a.mode==='quick'&&!f.required)answers[f.key]={value:null,source:'omitted optional field',reviewed:true};else delete answers[f.key];}}
 return change(store,a,{answers,profileHash:profileFingerprint(profile),status:'collecting',activeField:null,choiceOffset:0,choiceFilter:''});
}
async function recordAnswer(store,a,field,value,source='student',extra={}){
 const f=a.form.fields[field];if(!f)fail('Question not found. Open the latest application.');
 if(value===null&&f.required||value!==null&&(typeof value!=='string'||!value.trim()||value.length>Math.min(2000,f.maxLength>0?f.maxLength:2000)))fail('Provide an answer within the employer’s character limit (up to 2,000 characters).');
 const choices=choiceValues(a,f),values=f.multiple?selectedValues(value):[value];if(value!==null&&choices.length&&(!values.length||values.some(v=>!choices.includes(v))||new Set(values).size!==values.length||values.length>(f.maxChoices||20)))fail('Choose only options shown for this question.');
 const answers={...a.answers,[f.key]:{value:value?.trim()??null,source,reviewed:true}};
 a=await change(store,a,{answers,activeField:null,status:'collecting',choiceOffset:0,choiceFilter:'',selections:{...a.selections,[f.key]:undefined},answerNotice:null,...extra});
 if(value!==null){
  const key=profileField(f),currentProfile=await getCareerProfile(store),profileKeys=['fullName','firstName','lastName','email','phone','currentCompany','location','plannedWorkLocation','linkedin','portfolio'];
  let profileValue=['workAuthorizationUS','sponsorship'].includes(key)&&/^(yes|no)$/i.test(value)?value.toLowerCase():key&&profileKeys.includes(key)&&(!f.options?.length||f.type==='location')?value:null;
  if(['recruitingSMS','recruitingWhatsApp'].includes(key))profileValue=['yes','no'].find(choice=>profileAnswer(f,{...currentProfile,[key]:choice})===value)||null;
  if(key==='officeThreeDays')profileValue=['local_nyc_sf','relocate_nyc_sf','remote_only'].find(choice=>quickApplicationAnswers({fields:[f]},{...currentProfile,officeThreeDays:choice},a.resumeName).answers[f.key]?.value===value)||null;
  if(profileValue!==null&&currentProfile[key]!==profileValue){
   try{const updated=await saveCareerProfile(store,{[key]:profileValue});a=await change(store,a,{profileHash:profileFingerprint(updated),answerNotice:'Saved to Resume & Profile.'});}catch{ /* Answer remains usable for this application. */ }
  }else if(canRememberApplicationAnswer(f)){
   try{await saveApplicationAnswerMemory(store,{field:f,job:await store.get('jobs',a.jobId),value,source:source==='student'?'student':'approved-ai',resumeHash:a.resumeHash});a=await change(store,a,{answerNotice:'Remembered for matching future questions. Manage saved answers in Resume & Profile.'});}catch{ /* A one-off or sensitive answer remains local to this application. */ }
  }
 }
 return a;
}
export async function handleLiveApplicationAction(store,queue,x,key){
 let a=await store.get(BUCKET,x.id);if(!a||!await bound(store,a))fail('This application is not available in your linked chat.');
 if(x.op==='show')return showLiveApplication(store,queue,a,key);
 if(a.revision!==x.revision)fail('This application changed. Use Application progress to open its latest version.');
 if(x.op==='cover-letter'&&a.status==='submitted'&&hasGeneratedCoverLetter(a))return applicationCard(store,queue,a,`Cover letter sent to ${a.company}\n${a.title}\n\n${a.coverLetter.text}`,[[['Application progress',applicationAction(a,'show')]]],key);
 if(terminal.has(a.status))return showLiveApplication(store,queue,a,key);
 if(x.op==='cancel'){a=await change(store,a,{status:'cancelled'});return showLiveApplication(store,queue,a,key);}
 if(x.op==='quick'&&a.mode!=='quick'){
  const selected=await store.get('jobs',a.jobId),resume=await store.get('documents','resume');
  if(a.submitAttemptAt||!['collecting','ready','needs_attention'].includes(a.status)||!selected||selected.title!==a.title||selected.company!==a.company||applicationURL(selected.applyUrl||selected.url)!==a.url||fingerprint(resume)!==a.resumeHash)fail('Open a fresh job card before choosing Apply now.');
  a=await change(store,a,{mode:'quick',status:'inspecting',quickJobHash:quickApplicationJobFingerprint(selected),coverLetterPolicy:1,coverLetterSourceHash:coverLetterSourceHash(resume,selected),profileHash:profileFingerprint(await getCareerProfile(store)),quickRequestKey:String(key),authorizedAt:now(),quickAuthorizationExpiresAt:Date.now()+30*60000,error:null});
  await enqueue(queue,store,a,'application-inspect');return showLiveApplication(store,queue,a,key);
 }
 if(a.mode==='quick'&&x.op==='guided'){
  if(a.status!=='needs_attention'||a.submitAttemptAt)fail('Choose Apply now again or switch to the guided application.');
  a=await change(store,a,{mode:'guided',quickAuthorizationExpiresAt:0,status:'inspecting',answers:{},drafts:{},choices:{},coverLetter:null,error:null});
  await enqueue(queue,store,a,'application-inspect');return showLiveApplication(store,queue,a,key);
 }
 if(a.mode==='quick'){
  if(a.status!=='collecting'||!['answer','selection-done','skip','use-draft','generate','choices','profile'].includes(x.op))fail('Choose Apply now again or switch to the guided application.');
  if(x.op==='profile')a=await refreshProfile(store,a);
  a=await renewQuickInteraction(store,a);
 }
 if(x.op==='retry'){
  if(a.status!=='needs_attention'||a.submitAttemptAt)fail('Submission cannot be retried automatically.');
  a=await change(store,a,{status:'inspecting',coverLetter:null,error:null});await enqueue(queue,store,a,'application-inspect');return showLiveApplication(store,queue,a,key);
 }
 if(x.op==='profile')a=await refreshProfile(store,a);
 else if(x.op==='edit'){
  const fields=a.form.fields.filter(f=>f.type!=='file'),offset=Number.isSafeInteger(x.offset)&&x.offset>=0?x.offset:0;
  return applicationCard(store,queue,a,'Which answer would you like to change?',fields.slice(offset,offset+9).map(f=>[[f.label.slice(0,64),applicationAction(a,'edit-field',{field:a.form.fields.indexOf(f)})]]).concat(fields.length>offset+9?[[['More answers',applicationAction(a,'edit',{offset:offset+9})]]]:[],[[['Back to review',applicationAction(a,'show')]]]),key);
 }
 else if(x.op==='edit-field'){if(!Number.isInteger(x.field)||!a.form.fields[x.field]||a.form.fields[x.field].type==='file')fail('Choose an answer from the review.');a=await change(store,a,{status:'collecting',activeField:x.field,choiceOffset:0,choiceFilter:''});}
 else if(x.op==='choices'){if(!Number.isSafeInteger(x.offset)||x.offset<0||!a.form.fields[x.field])fail('Choose a question from the latest review.');a=await change(store,a,{activeField:x.field,choiceOffset:x.offset,...(x.clear?{choiceFilter:''}:{})});}
 else if(x.op==='skip')a=await recordAnswer(store,a,x.field,null);
 else if(x.op==='answer'){const f=a.form.fields[x.field];if(!f||!Number.isInteger(x.choice))fail('Choose an option from the latest question.');const value=choiceValues(a,f)[x.choice];a=f.multiple?await toggleChoice(store,a,x.field,value):await recordAnswer(store,a,x.field,value);}
 else if(x.op==='selection-done'){const f=a.form.fields[x.field];if(!f?.multiple)fail('Choose a question from the latest review.');a=await recordAnswer(store,a,x.field,selections(a,f).join('\n'));}
 else if(x.op==='use-draft'){
  const f=a.form.fields[x.field],draft=f&&a.drafts[f.key];if(!draft)fail('No draft is available.');
  if(draft.source==='AI draft'&&draft.sourceBinding!==draftSourceHash(await store.get('documents','resume'),await store.get('jobs',a.jobId))){
   const drafts={...a.drafts};delete drafts[f.key];a=await change(store,a,{drafts,status:'collecting',activeField:x.field,answerNotice:'The sources for this draft changed. Type your answer or tap Draft with AI for a fresh one.'});return showLiveApplication(store,queue,a,key);
  }
  if(draft.source==='saved application answer'){
   const current=await suggestSavedApplicationAnswer(store,{field:f,job:await store.get('jobs',a.jobId)});
   if(!current||current.memoryId!==draft.memoryId||current.memoryUpdatedAt!==draft.memoryUpdatedAt){const drafts={...a.drafts};if(current)drafts[f.key]=current;else delete drafts[f.key];a=await change(store,a,{drafts,status:'collecting',activeField:x.field});return showLiveApplication(store,queue,a,key);}
  }
  if(draft.source==='saved demographic preference'){
   const demographics=await getDemographics(store);
   if(demographics.revision!==draft.preferenceRevision){
    const replacement=savedDemographicSuggestion(f,demographics),drafts={...a.drafts};if(replacement)drafts[f.key]=replacement;else delete drafts[f.key];
    a=await change(store,a,{drafts,status:'collecting',activeField:x.field});return showLiveApplication(store,queue,a,key);
   }
  }
  a=await recordAnswer(store,a,x.field,draft.value,draft.source==='saved demographic preference'?'student-reviewed preference':'reviewed estimate or AI draft');
 }
 else if(x.op==='generate'){
  if(a.form.fields[x.field]?.type!=='textarea')fail('This question needs your own answer.');
  a=await change(store,a,{status:'drafting',activeField:x.field});await enqueue(queue,store,a,'application-answer',{field:x.field});return showLiveApplication(store,queue,a,key);
 }else if(x.op==='submit'){
  if(a.status!=='ready'||a.reviewExpiresAt<Date.now()||a.form.fields.some(f=>!a.answers[f.key]?.reviewed||f.required&&!a.answers[f.key]?.value))fail('Review all answers again before submitting.');
  if(profileFingerprint(await getCareerProfile(store))!==a.profileHash){a=await refreshProfile(store,a);return showLiveApplication(store,queue,a,key);}
  if(fingerprint(await store.get('documents','resume'))!==a.resumeHash)fail('Your resume changed. Cancel and start a new application review.');
  a=await change(store,a,{status:'queued',authorizedAt:now()});
  try{await enqueue(queue,store,a,'application-submit');}catch{a=await change(store,a,{status:'ready',error:'Submission could not be queued.'});throw new HttpError(503,'Submission was not queued. Open the application to try again.');}
 }
 return showLiveApplication(store,queue,a,key);
}
export async function handleLiveApplicationMessage(store,queue,msg,key){
 if(!msg.text||String(msg.text).startsWith('/')||msg.chat?.type!=='private')return false;
 const flow=await store.get('settings','liveApplicationFlow');if(!flow?.id)return false;
 let a=await store.get(BUCKET,flow.id);if(!a||String(msg.chat.id)!==a.chatId||!await bound(store,a))return false;
 if(Number.isSafeInteger(key)&&a.lastTextUpdateId>=key)return true;
 if(['submitted','cancelled'].includes(a.status))return false;
 if(!Number.isInteger(flow.field)||a.status!=='collecting'||a.revision!==flow.revision){await showLiveApplication(store,queue,a,key);return true;}
 const f=a.form.fields[flow.field],choices=choiceValues(a,f),text=String(msg.text).trim();
 if(a.mode==='quick')a=await renewQuickInteraction(store,a);
 const received=Number.isSafeInteger(key)?{lastTextUpdateId:key}:{};
 if(choices.length){const choice=/^\d+$/.test(text)?choices[Number(text)-1]:choices.find(c=>c.toLowerCase()===text.toLowerCase());if(!choice){if(text.length<=100&&choices.length>5)a=await change(store,a,{choiceFilter:text,choiceOffset:0,...received});await showLiveApplication(store,queue,a,key);return true;}a=f.multiple?await toggleChoice(store,a,flow.field,choice,received):await recordAnswer(store,a,flow.field,choice,'student',received);}
 else if(f.type==='location'){
  if(text.length<2||text.length>200)fail('Enter a city, state, and country.');
  a=await change(store,a,{status:'locating',activeField:flow.field,...received});await enqueue(queue,store,a,'application-location',{field:flow.field,query:text});
 }else a=await recordAnswer(store,a,flow.field,text,'student',received);
 await showLiveApplication(store,queue,a,key);return true;
}
export async function executeLiveApplication(database,job,{queue,inspect,submit,locate,draft=draftCareerAnswer,motivation=generateCompanyMotivation,analyze=analyzeCareerExperience,generateCoverLetter=createApplicationCoverLetter}={}){
 const store=database.forUser(job.userId);let a=await store.get(BUCKET,job.payload.applicationId);
 let referralJob,inspectedQuick;
 if(!a||a.revision!==job.payload.revision||!await bound(store,a))return {stale:true};
 const expected=job.type==='application-inspect'?'inspecting':job.type==='application-answer'?'drafting':job.type==='application-location'?'locating':'queued';
 if(a.status!==expected)return {stale:true};
 try{
  const provider=applicationProviderFor(a);inspect??=provider.inspect;submit??=provider.submit;locate??=provider.locate;
  const savedJob=await store.get('jobs',a.jobId);if(!liveApplicationSupported(savedJob)||savedJob.closed||savedJob.status==='closed'||savedJob.eligible===false||applicationURL(savedJob.applyUrl||savedJob.url)!==a.url)fail('This employer integration is unavailable.');
  if(a.mode==='quick'&&(!await quickAuthorizationCurrent(store,a,savedJob)||!await pilotWorkAllowed(database,store.userId)))throw Error('QUICK_AUTHORIZATION_CHANGED');
  if(job.type==='application-inspect'){
   const form=await inspect(a.url);if(!a.titlePending&&form.title.replace(/\s+/g,' ').trim()!==a.title.replace(/\s+/g,' ').trim())throw Error('JOB_CHANGED');
   if(a.titlePending){
    if(savedJob.source!=='student-link'||typeof form.title!=='string'||!form.title.trim()||form.title.length>500)throw Error('JOB_CHANGED');
    const updatedJob={...savedJob,title:form.title,titlePending:false,formCheckedAt:now()};
    if(!await store.compareAndSet('jobs',savedJob.id,savedJob,updatedJob))throw Error('JOB_CHANGED');
    referralJob=updatedJob;
   }
   const resume=await store.get('documents','resume');if(fingerprint(resume)!==a.resumeHash)throw Error('RESUME_CHANGED');
   if(a.mode==='quick'){
    if(!await quickAuthorizationCurrent(store,a,await store.get('jobs',a.jobId)))throw Error('QUICK_AUTHORIZATION_CHANGED');
    const profile=await getCareerProfile(store),prepared=await prepareQuickAnswers(store,a,form,profile,resume,savedJob),answers=prepared.answers;
    // Keep a successful inspection available if later drafting fails, without
    // advancing the running task's revision until its result is persisted.
    inspectedQuick={form,answers};
    const requiredLetters=form.fields.filter(f=>f.required&&isCoverLetterField(f)&&!answers[f.key]?.value);
    let coverLetter;
    if(requiredLetters.length&&!form.fields.some(f=>f.required&&!isCoverLetterField(f)&&!answers[f.key]?.value)){
     if(a.coverLetterPolicy!==1)throw Error('QUICK_AUTHORIZATION_CHANGED');
     const generated=await prepareRequiredCoverLetter(store,a,{...form,fields:requiredLetters},resume,savedJob,profile,generateCoverLetter);coverLetter=generated.coverLetter;Object.assign(answers,generated.answers);
     if(!await quickAuthorizationCurrent(store,a,await store.get('jobs',a.jobId)))throw Error('QUICK_AUTHORIZATION_CHANGED');
    }
    const missing=form.fields.filter(f=>f.required&&!answers[f.key]?.value).map(f=>f.label),drafts={},demographics=await getDemographics(store);
    for(const f of form.fields){if(!answers[f.key]?.value){const suggestion=savedDemographicSuggestion(f,demographics);if(suggestion)drafts[f.key]=suggestion;}}
    a=await change(store,a,{form,answers,drafts,coverLetter:coverLetter||null,missingFields:missing,status:'collecting',activeField:null,error:null});
   }else{
    const letter=await prepareRequiredCoverLetter(store,a,form,resume,await store.get('jobs',a.jobId),await getCareerProfile(store),generateCoverLetter);
    let experience=await readCareerExperience(store);if(!experience.analyzed||experience.stale){try{experience=await analyze(store);}catch{ /* The student can answer if analysis is unavailable. */ }}
    const demographics=await getDemographics(store),drafts={};for(const f of form.fields){const suggestion=await suggestSavedApplicationAnswer(store,{field:f,job:await store.get('jobs',a.jobId),resume})||experienceSuggestion(f,experience)||savedDemographicSuggestion(f,demographics);if(suggestion)drafts[f.key]=suggestion;}
    a=await change(store,a,{title:form.title,titlePending:false,form,coverLetter:letter.coverLetter||null,answers:{_systemfield_resume:{value:a.resumeName,source:'saved resume',reviewed:true}},drafts,status:'collecting',activeField:null});a=await refreshProfile(store,a);
    if(letter.answers)a=await change(store,a,{answers:{...a.answers,...letter.answers}});
   }
  }else if(job.type==='application-answer'){
   if(job.payload.coverLetter){
    if(a.mode!=='quick'||a.coverLetterPolicy!==1)throw Error('QUICK_AUTHORIZATION_CHANGED');
    const fields=a.form.fields.filter(f=>f.required&&isCoverLetterField(f)&&!a.answers[f.key]?.value);
    const generated=await prepareRequiredCoverLetter(store,a,{...a.form,fields},await store.get('documents','resume'),savedJob,await getCareerProfile(store),generateCoverLetter);
    a=await change(store,a,{status:'collecting',activeField:null,coverLetter:generated.coverLetter,answers:{...a.answers,...generated.answers}});
   }else{
    const f=a.form.fields[job.payload.field];if(!f||f.type!=='textarea')throw Error('FORM_CHANGED');
    const sourceBinding=draftSourceHash(await store.get('documents','resume'),savedJob);
    const guidance='Keep the answer under 150 words. Use only supported resume and role evidence. If evidence is missing, explicitly state what the student must supply; never invent an example.';
    const result=isCompanyMotivationQuestion(f,savedJob)?await motivation(store,{job:savedJob,question:f.label,guidance}):await draft(store,{jobId:a.jobId,question:f.label,guidance});
    const drafts={...a.drafts},limit=Math.min(2000,f.maxLength>0?f.maxLength:2000);
    if(result.answer&&!result.needsManual&&result.answer.length<=limit&&sourceBinding===draftSourceHash(await store.get('documents','resume'),await store.get('jobs',a.jobId)))drafts[f.key]={value:result.answer,source:'AI draft',sourceBinding,reviewed:false,note:[...(result.gaps||[]).slice(0,3),...(result.companyContext?.sources||[]).map(s=>`Company context: ${s.url}`)].join('\n').slice(0,1000)};else delete drafts[f.key];
    a=await change(store,a,{status:'collecting',drafts,answerNotice:drafts[f.key]?null:'I could not produce a supported answer within this field’s limit. Type your answer here or try Draft with AI again.'});
   }
  }else if(job.type==='application-location'){
   const choices=await locate(a.url,job.payload.query,{field:a.form.fields[job.payload.field]});if(!choices.length)throw Error('LOCATION_NOT_FOUND');const f=a.form.fields[job.payload.field];a=await change(store,a,{status:'collecting',choices:{...a.choices,[f.key]:choices}});
  }else{
   const resume=await store.get('documents','resume');if(fingerprint(resume)!==a.resumeHash)throw Error('RESUME_CHANGED');
   if(!await rememberedAnswersCurrent(store,a,savedJob))throw Error('SAVED_ANSWER_CHANGED');
   if(!await coverLetterCurrent(store,a,savedJob))throw Object.assign(Error('COVER_LETTER_SOURCE_CHANGED'),{code:'COVER_LETTER_SOURCE_CHANGED'});
   const receipt=await submit({url:a.url,form:a.form,answers:a.answers,resume,coverLetter:hasGeneratedCoverLetter(a)?a.coverLetter?.document:undefined,beforeSubmit:async()=>{
    const latestJob=await store.get('jobs',a.jobId);
    if(!latestJob||latestJob.closed||latestJob.status==='closed'||latestJob.eligible===false||applicationURL(latestJob.applyUrl||latestJob.url)!==a.url||!await bound(store,a)||!await pilotWorkAllowed(database,store.userId)||fingerprint(await store.get('documents','resume'))!==a.resumeHash||profileFingerprint(await getCareerProfile(store))!==a.profileHash||!liveApplicationSupported(latestJob))throw Error('ACCOUNT_CHANGED');
    if(a.mode==='quick'&&!await quickAuthorizationCurrent(store,a,latestJob))throw Error('QUICK_AUTHORIZATION_CHANGED');
    if(!await rememberedAnswersCurrent(store,a,latestJob))throw Error('SAVED_ANSWER_CHANGED');
    if(!await coverLetterCurrent(store,a,latestJob))throw Object.assign(Error('COVER_LETTER_SOURCE_CHANGED'),{code:'COVER_LETTER_SOURCE_CHANGED'});
    a=await change(store,a,{status:'submitting',submitAttemptAt:now()});
   }});
   if(a.status!=='submitting'||!receipt?.confirmation||!receipt?.confirmedAt)throw Error('SUBMISSION_UNCONFIRMED');
   a=await change(store,a,{status:'submitted',receipt});
  }
 }catch(error){
  const latest=await store.get(BUCKET,a.id);if(latest?.revision!==a.revision)return {stale:true};
  if(a.status==='submitting')a=await change(store,a,{status:'uncertain',error:'Employer receipt could not be confirmed. No automatic retry.'});
  else if(String(error.code||error.message).startsWith('COVER_LETTER_'))a=await change(store,a,{...inspectedQuick,status:'needs_attention',error:`Nothing was submitted. I could not create or validate a cover letter from the current résumé and job description. Check that both are available, then ${a.mode==='quick'?'try Apply now again':'retry inspection'}.`});
  else if(job.type==='application-answer'&&!job.payload.coverLetter&&Number.isInteger(job.payload.field)&&!['QUICK_AUTHORIZATION_CHANGED','ACCOUNT_CHANGED'].includes(error.code||error.message))a=await change(store,a,{status:'collecting',activeField:job.payload.field,answerNotice:'AI could not finish this answer. Type your answer here or tap Draft with AI to retry.'});
  else if(error.code==='CHOOSE_EXACT_LOCATION'){
   const index=a.form.fields.findIndex(f=>f.type==='location'&&(!error.field||f.key===error.field));
   if(index>=0&&Array.isArray(error.options)&&error.options.length&&error.options.every(value=>typeof value==='string'&&value.length<=500))a=await change(store,a,{status:'collecting',activeField:index,choices:{...a.choices,[a.form.fields[index].key]:error.options},choiceOffset:0,choiceFilter:'',error:null});
   else a=await change(store,a,{status:'needs_attention',error:'The employer could not confirm that location. Open the employer form to finish.'});
  }else {
   const reason=error.code||error.message;
   const explanation=['FORM_CHANGED','JOB_CHANGED'].includes(reason)?'The employer form changed. Retry inspection to load its current questions.':['QUICK_AUTHORIZATION_CHANGED','ACCOUNT_CHANGED','RESUME_CHANGED','SAVED_ANSWER_CHANGED'].includes(reason)?'The selected job, saved profile, résumé, saved answer, or authorization changed. Choose Apply now again.':reason==='HUMAN_VERIFICATION_REQUIRED'?'The employer requires human verification.':reason==='UNSUPPORTED_FORM'?'This form has a control BRB cannot complete automatically.':reason==='REQUIRED_CONSENT'?'The employer requires an additional consent.':reason==='INVALID_PHONE'?'Save an international phone number starting with + and its country code in Resume & Profile, then retry.':'The browser could not complete an employer form control. Your answers are saved.';
   a=await change(store,a,{...inspectedQuick,status:'needs_attention',error:`Nothing was submitted. ${explanation}`});
  }
 }
 // A pasted URL has no reliable title until its read-only form inspection finishes.
 if(referralJob&&a.status==='collecting'&&await bound(store,a)&&await offerReferralBeforeApplication(store,queue,referralJob,`application-result:${job.id}`))return {status:a.status,referralOffered:true};
 await showLiveApplication(store,queue,a,`application-result:${job.id}`);return {status:a.status};
}
