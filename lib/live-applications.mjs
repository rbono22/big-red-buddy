import {createHash} from 'node:crypto';
import {idFor} from './domain.mjs';
import {HttpError} from './security.mjs';
import {menuCard} from './telegram-menu.mjs';
import {getCareerProfile,draftCareerAnswer} from './career.mjs';
import {readCareerExperience,analyzeCareerExperience} from './career-experience.mjs';
import {pauseDemographics} from './demographics.mjs';
import {ashbyApplicationURL,liveApplicationSupported,inspectAshbyApplication,submitAshbyApplication,ashbyLocationChoices} from './ashby-browser.mjs';
import {pilotWorkAllowed} from './pilot-access.mjs';

const BUCKET='liveApplications',now=()=>new Date().toISOString();
const fingerprint=resume=>createHash('sha256').update(String(resume?.file||'')).digest('hex');
const profileFingerprint=profile=>createHash('sha256').update(JSON.stringify(profile)).digest('hex');
const settingsURL=()=>`${process.env.APP_ORIGIN}/#career-profile`;
const fail=message=>{throw new HttpError(400,message);};
const own=(object,key)=>Object.hasOwn(object||{},key);
const terminal=new Set(['submitted','submitting','uncertain','queued']);
const applicationCard=(store,queue,a,text,actions,key)=>menuCard(store,queue,text,actions,key,{binding:{chatId:a.chatId,linkedAt:a.linkedAt,applicationId:a.id,revision:a.revision}});
const applicationAction=(a,op,extra={})=>({liveApplication:{id:a.id,revision:a.revision,op,...extra}});
const bound=async(store,a)=>{const t=await store.get('secrets','telegram');return t?.chatId&&String(t.chatId)===a.chatId&&(t.linkedAt||'')===a.linkedAt&&!(await store.get('settings','account'))?.deleting;};
async function change(store,a,patch){const next={...a,...patch,revision:a.revision+1,updatedAt:now()};if(!await store.compareAndSet(BUCKET,a.id,a,next))throw new HttpError(409,'This application changed. Open its latest review.');return next;}
function profileField(field){
 if(field.key==='_systemfield_name')return 'fullName';if(field.key==='_systemfield_email')return 'email';
 if(field.type==='tel')return 'phone';if(/^linkedin profile$/i.test(field.label))return 'linkedin';
 if(field.key==='_systemfield_location'&&/payroll/i.test(field.label))return 'plannedWorkLocation';
 if(field.key==='smsConsent')return 'recruitingSMS';if(field.key==='whatsAppConsent')return 'recruitingWhatsApp';
 if(field.type==='radio'&&/New York or San Francisco/.test(field.label)&&/3 days\/week/.test(field.label))return 'officeThreeDays';
 return null;
}
function profileAnswer(field,profile){
 const key=profileField(field),value=profile[key];if(!key||!value||value==='unanswered')return null;
 if(field.type==='consent')return field.options.find(o=>new RegExp('^'+(value==='yes'?'Yes':'No')+'\\b','i').test(o))||null;
 if(key==='officeThreeDays'){const pattern={local_nyc_sf:/^Yes.*Currently located/,relocate_nyc_sf:/^Yes.*Able to relocate/,remote_only:/^No/}[value];return pattern?field.options.find(o=>pattern.test(o))||null:null;}
 return value;
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
export async function startLiveApplication(store,queue,jobId,key){
 const job=await store.get('jobs',jobId);if(!job||job.closed||job.status==='closed'||job.eligible===false||!liveApplicationSupported(job))fail('This employer form is not supported for Telegram submission. Open the employer posting.');
 const t=await store.get('secrets','telegram');if(!t?.chatId)fail('Link Telegram in Connections to continue this application.');
 const resume=await store.get('documents','resume');if(!resume?.file)fail('Upload your PDF resume first in Resume & Profile.');
 const url=ashbyApplicationURL(job.applyUrl||job.url),id=idFor('ashby-application',url),existing=await store.get(BUCKET,id);
 if(existing&&existing.status!=='cancelled'){
  if(!await bound(store,existing))fail('The Telegram connection changed. Contact the operator to recover this application safely.');
  return showLiveApplication(store,queue,existing,key);
 }
 const a={id,jobId,url,title:job.title,company:job.company,status:'inspecting',revision:(existing?.revision||0)+1,chatId:String(t.chatId),linkedAt:t.linkedAt||'',resumeHash:fingerprint(resume),resumeName:resume.name||'Resume.pdf',answers:{},drafts:{},choices:{},createdAt:now(),updatedAt:now()};
 if(!await store.compareAndSet(BUCKET,id,existing,a))fail('This application is already starting. Open it again.');
 await pauseDemographics(store,{finish:true});
 await store.put('settings','liveApplicationFlow',{id});
 try{await enqueue(queue,store,a,'application-inspect');}catch{await change(store,a,{status:'needs_attention',error:'The application could not be queued. Retry inspection.'});throw new HttpError(503,'Could not queue application inspection. Try again.');}
 return applicationCard(store,queue,a,`Reading the real application for ${job.title} at ${job.company}. I’ll reuse your saved profile, ask only for missing answers, and show a review before you submit.`,[[['Application progress',applicationAction(a,'show')]]],key);
}
export async function showLiveApplication(store,queue,a,key){
 if(!await bound(store,a))return;
 if(['inspecting','drafting','locating','queued','submitting'].includes(a.status)&&queue.get){
  const marker=await store.get('liveApplicationTasks',`${a.id}:${a.status==='submitting'?a.revision-1:a.revision}`),task=marker&&await queue.get(store.userId,marker.id);
  if(task&&['failed','needs_review','expired'].includes(task.status))a=await change(store,a,{status:a.submitAttemptAt?'uncertain':'needs_attention',error:a.submitAttemptAt?'The worker stopped after a submission attempt. Check for an employer receipt.':'Processing was interrupted before submission. Retry inspection.'});
 }
 if(a.status==='submitted')return applicationCard(store,queue,a,`Submitted to ${a.company}: ${a.title}\n\n${a.receipt.confirmation}\nConfirmed ${a.receipt.confirmedAt}\nResume: ${a.resumeName}`,[[['Open employer posting',{url:a.url}]]],key);
 if(terminal.has(a.status))return applicationCard(store,queue,a,a.status==='queued'?`Your reviewed application to ${a.company} is queued for submission.`:`${a.company} application: ${a.status==='uncertain'?'receipt unconfirmed':'submission in progress'}. BRB will not automatically retry a submission. Check the employer confirmation before applying again.`,[[['Check progress',applicationAction(a,'show')],['Open employer posting',{url:a.url}]]],key);
 if(a.status==='inspecting'||a.status==='drafting'||a.status==='locating')return applicationCard(store,queue,a,`Working on your ${a.company} application. Your next question will appear here.`,[[['Check progress',applicationAction(a,'show')]]],key);
 if(a.status==='cancelled')return applicationCard(store,queue,a,'Application cancelled. Nothing was submitted.',[[['Jobs',{page:'jobs'}]]],key);
 if(a.status==='needs_attention')return applicationCard(store,queue,a,`${a.company} application needs attention. ${a.error||'Please review the employer page.'}`,[[['Retry inspection',applicationAction(a,'retry')],['Open employer posting',{url:a.url}]]],key);
 const index=a.activeField??a.form.fields.findIndex(f=>!own(a.answers,f.key)||!a.answers[f.key].reviewed);
 if(index>=0){
  const f=a.form.fields[index],draft=a.drafts[f.key],choices=a.choices[f.key]||f.options;
  const rows=choices.map((choice,i)=>[[`${i+1}. ${choice}`.slice(0,64),applicationAction(a,'answer',{field:index,choice:i})]]);
  if(draft)rows.unshift([['Use suggested answer',applicationAction(a,'use-draft',{field:index})]]);
  if(f.type==='textarea')rows.push([['Draft with AI',applicationAction(a,'generate',{field:index})]]);
  if(!f.required)rows.push([['Skip optional question',applicationAction(a,'skip',{field:index})]]);
  rows.push([['Resume & Profile',{url:settingsURL()}],['Use saved profile',applicationAction(a,'profile')]]);
  rows.push([['Cancel application',applicationAction(a,'cancel')]]);
  const text=`${a.company} · ${a.title}\nQuestion ${index+1} of ${a.form.fields.length}\n\n${f.label}${f.type==='consent'?'\n'+a.form.consentText:''}${choices.length?'\n\n'+choices.map((c,i)=>`${i+1}. ${c}`).join('\n'):''}${draft?`\n\nSuggested answer (review first):\n${draft.value}${draft.note?'\n'+draft.note:''}`:''}\n\n${choices.length?'Tap your choice.':'Type your answer here.'}${profileField(f)?' This detail can also be saved in Resume & Profile.':''}`;
  await store.put('settings','liveApplicationFlow',{id:a.id,field:index,revision:a.revision});
  return applicationCard(store,queue,a,text,rows,key);
 }
 if(a.status!=='ready'||a.reviewExpiresAt<Date.now())a=await change(store,a,{status:'ready',reviewExpiresAt:Date.now()+30*60000,activeField:null});
 await store.put('settings','liveApplicationFlow',{id:a.id});
 let chunk=`Review your application to ${a.company}\n${a.title}\nResume: ${a.resumeName}\n`,part=0;
 for(const f of a.form.fields){let line=`\n${f.label}\n${a.answers[f.key].value??'Not provided (optional)'}\n`;while(line.length){const count=Math.min(3300-chunk.length,line.length);chunk+=line.slice(0,count);line=line.slice(count);if(chunk.length===3300){await applicationCard(store,queue,a,chunk,[[['Edit an answer',applicationAction(a,'edit')]]],`${key}:review:${part++}`);chunk='';}}}
 await applicationCard(store,queue,a,chunk,[[['Edit an answer',applicationAction(a,'edit')]]],`${key}:review:${part++}`);
 return applicationCard(store,queue,a,`Ready to send these reviewed answers and ${a.resumeName} to ${a.company} through Ashby? The button below submits the real job application.`,[[[`Submit to ${a.company}`.slice(0,64),applicationAction(a,'submit')]], [['Edit answers',applicationAction(a,'edit')],['Cancel application',applicationAction(a,'cancel')]],[['Open employer form & terms',{url:a.url}]]],`${key}:submit`);
}
async function refreshProfile(store,a){
 const profile=await getCareerProfile(store),answers={...a.answers};
 for(const f of a.form.fields){const value=profileAnswer(f,profile);if(!answers[f.key]||answers[f.key].source==='profile'){if(value)answers[f.key]={value,source:'profile',reviewed:true};else delete answers[f.key];}}
 return change(store,a,{answers,profileHash:profileFingerprint(profile),status:'collecting',activeField:null});
}
async function recordAnswer(store,a,field,value,source='student',extra={}){
 const f=a.form.fields[field];if(!f)fail('Question not found. Open the latest application.');
 if(value===null&&f.required||value!==null&&(typeof value!=='string'||!value.trim()||value.length>2000))fail('Provide an answer of up to 2,000 characters.');
 const choices=a.choices[f.key]||f.options;if(value!==null&&choices.length&&!choices.includes(value))fail('Choose one of the options shown.');
 const answers={...a.answers,[f.key]:{value:value?.trim()??null,source,reviewed:true}};
 return change(store,a,{answers,activeField:null,status:'collecting',...extra});
}
export async function handleLiveApplicationAction(store,queue,x,key){
 let a=await store.get(BUCKET,x.id);if(!a||!await bound(store,a))fail('This application is not available in your linked chat.');
 if(x.op==='show')return showLiveApplication(store,queue,a,key);
 if(a.revision!==x.revision)fail('This application changed. Use Application progress to open its latest version.');
 if(terminal.has(a.status))return showLiveApplication(store,queue,a,key);
 if(x.op==='cancel'){a=await change(store,a,{status:'cancelled'});return showLiveApplication(store,queue,a,key);}
 if(x.op==='retry'){
  if(a.status!=='needs_attention'||a.submitAttemptAt)fail('Submission cannot be retried automatically.');
  a=await change(store,a,{status:'inspecting',error:null});await enqueue(queue,store,a,'application-inspect');return showLiveApplication(store,queue,a,key);
 }
 if(x.op==='profile')a=await refreshProfile(store,a);
 else if(x.op==='edit'){
  const fields=a.form.fields.filter(f=>f.type!=='file'),offset=Number.isSafeInteger(x.offset)&&x.offset>=0?x.offset:0;
  return applicationCard(store,queue,a,'Which answer would you like to change?',fields.slice(offset,offset+9).map(f=>[[f.label.slice(0,64),applicationAction(a,'edit-field',{field:a.form.fields.indexOf(f)})]]).concat(fields.length>offset+9?[[['More answers',applicationAction(a,'edit',{offset:offset+9})]]]:[],[[['Back to review',applicationAction(a,'show')]]]),key);
 }
 else if(x.op==='edit-field'){if(!Number.isInteger(x.field)||!a.form.fields[x.field]||a.form.fields[x.field].type==='file')fail('Choose an answer from the review.');a=await change(store,a,{status:'collecting',activeField:x.field});}
 else if(x.op==='skip')a=await recordAnswer(store,a,x.field,null);
 else if(x.op==='answer'){const f=a.form.fields[x.field];a=await recordAnswer(store,a,x.field,(a.choices[f.key]||f.options)[x.choice]);}
 else if(x.op==='use-draft'){const f=a.form.fields[x.field],draft=a.drafts[f.key];if(!draft)fail('No draft is available.');a=await recordAnswer(store,a,x.field,draft.value,'reviewed estimate or AI draft');}
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
 const f=a.form.fields[flow.field],choices=a.choices[f.key]||f.options,text=String(msg.text).trim();
 const received=Number.isSafeInteger(key)?{lastTextUpdateId:key}:{};
 if(choices.length){const choice=/^\d+$/.test(text)?choices[Number(text)-1]:choices.find(c=>c.toLowerCase()===text.toLowerCase());if(!choice){await showLiveApplication(store,queue,a,key);return true;}a=await recordAnswer(store,a,flow.field,choice,'student',received);}
 else if(f.type==='location'){
  if(text.length<2||text.length>200)fail('Enter a city, state, and country.');
  a=await change(store,a,{status:'locating',activeField:flow.field,...received});await enqueue(queue,store,a,'application-location',{field:flow.field,query:text});
 }else a=await recordAnswer(store,a,flow.field,text,'student',received);
 await showLiveApplication(store,queue,a,key);return true;
}
export async function executeLiveApplication(database,job,{queue,inspect=inspectAshbyApplication,submit=submitAshbyApplication,locate=ashbyLocationChoices,draft=draftCareerAnswer,analyze=analyzeCareerExperience}={}){
 const store=database.forUser(job.userId);let a=await store.get(BUCKET,job.payload.applicationId);
 if(!a||a.revision!==job.payload.revision||!await bound(store,a))return {stale:true};
 const expected=job.type==='application-inspect'?'inspecting':job.type==='application-answer'?'drafting':job.type==='application-location'?'locating':'queued';
 if(a.status!==expected)return {stale:true};
 try{
  const savedJob=await store.get('jobs',a.jobId);if(!liveApplicationSupported(savedJob)||savedJob.closed||savedJob.status==='closed'||savedJob.eligible===false||ashbyApplicationURL(savedJob.applyUrl||savedJob.url)!==a.url)fail('This employer integration is unavailable.');
  if(job.type==='application-inspect'){
   const form=await inspect(a.url);if(form.title.replace(/\s+/g,' ').trim()!==a.title.replace(/\s+/g,' ').trim())throw Error('JOB_CHANGED');
   const resume=await store.get('documents','resume');if(fingerprint(resume)!==a.resumeHash)throw Error('RESUME_CHANGED');
   let experience=await readCareerExperience(store);if(!experience.analyzed||experience.stale){try{experience=await analyze(store);}catch{ /* The student can answer if analysis is unavailable. */ }}const drafts={};for(const f of form.fields){const suggestion=experienceSuggestion(f,experience);if(suggestion)drafts[f.key]=suggestion;}
   a=await change(store,a,{form,answers:{_systemfield_resume:{value:a.resumeName,source:'saved resume',reviewed:true}},drafts,status:'collecting',activeField:null});a=await refreshProfile(store,a);
  }else if(job.type==='application-answer'){
   const f=a.form.fields[job.payload.field],result=await draft(store,{jobId:a.jobId,question:f.label,guidance:'Keep the answer under 150 words. Use only resume evidence. If evidence is missing, explicitly state what the student must supply; never invent an example.'});
   const drafts={...a.drafts};if(result.answer&&!result.needsManual)drafts[f.key]={value:result.answer.slice(0,2000),source:'AI draft',reviewed:false,note:(result.gaps||[]).slice(0,3).join(' ').slice(0,600)};else delete drafts[f.key];
   a=await change(store,a,{status:'collecting',drafts});
  }else if(job.type==='application-location'){
   const choices=await locate(a.url,job.payload.query);if(!choices.length)throw Error('LOCATION_NOT_FOUND');const f=a.form.fields[job.payload.field];a=await change(store,a,{status:'collecting',choices:{...a.choices,[f.key]:choices}});
  }else{
   const resume=await store.get('documents','resume');if(fingerprint(resume)!==a.resumeHash)throw Error('RESUME_CHANGED');
   const receipt=await submit({url:a.url,form:a.form,answers:a.answers,resume,beforeSubmit:async()=>{
    const latestJob=await store.get('jobs',a.jobId);
    if(!latestJob||latestJob.closed||latestJob.status==='closed'||latestJob.eligible===false||ashbyApplicationURL(latestJob.applyUrl||latestJob.url)!==a.url||!await bound(store,a)||!await pilotWorkAllowed(database,store.userId)||fingerprint(await store.get('documents','resume'))!==a.resumeHash||profileFingerprint(await getCareerProfile(store))!==a.profileHash||!liveApplicationSupported(savedJob))throw Error('ACCOUNT_CHANGED');
    a=await change(store,a,{status:'submitting',submitAttemptAt:now()});
   }});
   if(a.status!=='submitting'||!receipt?.confirmation||!receipt?.confirmedAt)throw Error('SUBMISSION_UNCONFIRMED');
   a=await change(store,a,{status:'submitted',receipt});
  }
 }catch(error){
  const latest=await store.get(BUCKET,a.id);if(latest?.revision!==a.revision)return {stale:true};
  if(a.status==='submitting')a=await change(store,a,{status:'uncertain',error:'Employer receipt could not be confirmed. No automatic retry.'});
  else if(error.code==='CHOOSE_EXACT_LOCATION'){
   const index=a.form.fields.findIndex(f=>f.type==='location');a=await change(store,a,{status:'collecting',activeField:index,choices:{...a.choices,[a.form.fields[index].key]:error.options},error:null});
  }else a=await change(store,a,{status:'needs_attention',error:['FORM_CHANGED','JOB_CHANGED'].includes(error.code||error.message)?'The employer form changed. Refresh and review it again.':error.code==='HUMAN_VERIFICATION_REQUIRED'?'The employer requires human verification. Open the employer posting.':'Processing stopped before submission. Check your profile and retry inspection.'});
 }
 await showLiveApplication(store,queue,a,`application-result:${job.id}`);return {status:a.status};
}
