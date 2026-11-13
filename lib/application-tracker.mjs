import {randomBytes} from 'node:crypto';
import {idFor} from './domain.mjs';
import {HttpError} from './security.mjs';

const BUCKET='applicationTracker',SOURCES=['telegram','web','legacy'];
const STATUS_LABELS={requested:'Preparation requested',queued:'Preparation queued',prepared:'Materials prepared',needs_attention:'Needs attention',submitted:'Submitted (student-reported)'};
const safeID=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(value);
const recordID=jobId=>idFor('application-tracker',jobId);
const clean=(value,max=500)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';
const iso=value=>Number.isFinite(typeof value==='number'?value:Date.parse(value))?new Date(value).toISOString():null;
const link=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}};
const sourceLabel=source=>source==='telegram'?'Telegram':source==='web'?'Career Studio':'Previous draft';
function requireStore(store){if(!store?.userId||typeof store.compareAndSet!=='function')throw new Error('A student-scoped CAS store is required.');}
function plain(value){return String(value||'').slice(0,100000).replace(/<(?:br|\/p|\/div|\/li)\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&#39;|&apos;/gi,"'").replace(/&quot;/gi,'"').replace(/&ndash;|&#8211;/gi,'–').replace(/&mdash;|&#8212;/gi,'—');}

/** Only explicit posting language; no model, resume dates, seniority, or company-age inference. */
export function extractRequiredExperience(job){
 const text=plain(job?.rawSource?.descriptionPlain||job?.rawSource?.descriptionHtml||job?.rawSource?.content||job?.description||job?.descriptionPlain||job?.descriptionText||''),snippets=[];
 const number='(?:\\d{1,2}(?:\\.\\d)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)';
 const years=new RegExp(`\\b${number}(?:\\s*(?:[-–—]|to)\\s*${number})?\\+?\\s*(?:years?|yrs?)\\b`,'i');
 let requirements=false;
 for(const raw of text.split(/\n+|(?<=[.!?;])\s+(?=[A-Z0-9•*-])/)){
  const sentence=clean(raw,1200);if(!sentence)continue;
  if(/^(?:about (?:us|the company)|our (?:company|story|benefits)|benefits|compensation|what we offer|responsibilities)\b/i.test(sentence))requirements=false;
  if(/^(?:minimum |preferred |basic )?(?:requirements|qualifications)\b|^what (?:you bring|you need|we look for)\b/i.test(sentence))requirements=true;
  const match=sentence.match(years),noExperience=/\bno (?:prior |previous |professional |work )?experience (?:is )?(?:required|necessary)\b/i.test(sentence);
  if(!match&&!noExperience)continue;
  const before=match?sentence.slice(0,match.index):'',after=match?sentence.slice(match.index+match[0].length):'';
  if(/\b(?:our company|our team|our business|we have|we bring|we offer|company has|company with|founded|since|celebrat\w*|serving (?:our )?customers)\b/i.test(before)||/\b(?:make us|makes us|our company|our business|industry leader)\b/i.test(after))continue;
  const explicit=requirements||/\b(?:required|requires?|must|minimum|at least|qualifications|requirements|you (?:have|bring|will need)|candidate|we (?:require|seek)|preferred)\b/i.test(sentence)||/^[-*•]?\s*(?:\d|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b)/i.test(sentence);
  if(/^\s+(?:ago\b|in\s+(?:business|operation|service)\b|of\s+(?:operation|business|service)\b)/i.test(after))continue;
  const experienceAt=after.search(/\bexperience\b/i);
  if(/\b(?:age|education|schooling|college|university|degree)\b/i.test(after.slice(0,experienceAt<0?100:experienceAt)))continue;
  const relevant=/^\s*['’]?\s*(?:of\s+)?(?:[A-Za-z-]+\s+){0,6}experience\b/i.test(after)||explicit&&/^\s*(?:of\s+)?(?:in|as|working|building|developing|managing|leading|designing|delivering)\b/i.test(after);
  if(noExperience||explicit&&relevant){if(sentence.length>600)continue;snippets.push(sentence);if(snippets.length===2)break;}
 }
 const evidence=[...new Set(snippets)].join(' ');
 return {experience:evidence||'Not specified',experienceEvidence:evidence};
}
function snapshot(job={},application={}){
 const experience=extractRequiredExperience(job);
 return {title:clean(job.title||application.title,240)||'Not specified',company:clean(job.company||application.company,160)||'Not specified',location:clean(job.location||application.location,300)||'Not specified',...experience,applyUrl:link(job.applyUrl||job.url||application.applyUrl||application.url)};
}
function view(row){return {...row,statusLabel:STATUS_LABELS[row.status]||'Needs attention',sourceLabel:sourceLabel(row.source),historyNote:row.historyNote||null};}
function mergeSources(row,source){const sources=[...new Set([...(row.sources||[row.source]).filter(Boolean),source])];return {sources,source:sources.includes('telegram')?'telegram':sources.includes('web')?'web':'legacy'};}
function initial(jobId,details,source,at){return {id:recordID(jobId),jobId,...details,source,sources:[source],status:'requested',preparationStatus:'requested',statusOverride:null,startedAt:at,updatedAt:at,snapshotAt:at,requestId:null,taskId:null,applicationId:null,submissionReportedAt:null,submissionCorrectedAt:null,statusNote:'Preparation only; no employer submission has been recorded.',revision:0,requestHistory:[]};}
async function mutate(store,id,action){
 requireStore(store);
 for(let attempt=0;attempt<16;attempt++){
  const previous=await store.get(BUCKET,id),next=await action(previous);
  if(!next)return previous?view(previous):null;
  if(await store.compareAndSet(BUCKET,id,previous,{...next,revision:(previous?.revision||0)+1}))return view({...next,revision:(previous?.revision||0)+1});
 }
 throw new HttpError(409,'This application changed concurrently. Refresh and try again.');
}
const sourceValue=source=>{if(!SOURCES.includes(source))throw new HttpError(400,'Choose a supported application source.');return source;};

export async function startApplicationTracking(store,job,{source='web',updateId,now=Date.now}={}){
 requireStore(store);sourceValue(source);if(!safeID(job?.id))throw new HttpError(400,'Choose your own saved job.');
 const owned=await store.get('jobs',job.id);if(!owned)throw new HttpError(404,'That job is not available in your workspace.');
 if(updateId!==undefined&&!/^[A-Za-z0-9._:-]{1,200}$/.test(String(updateId)))throw new HttpError(400,'Invalid preparation request identifier.');
 const requestId=updateId===undefined?randomBytes(16).toString('hex'):idFor('application-request',source,String(updateId)),at=new Date(now()).toISOString();
 let staleRequest=false;
 const row=await mutate(store,recordID(owned.id),previous=>{
  if(previous?.requestId===requestId)return null;
  if(previous?.requestHistory?.includes(requestId)||source==='telegram'&&Number.isSafeInteger(updateId)&&previous?.lastTelegramUpdateId>=updateId){staleRequest=true;return null;}
  const base=previous||initial(owned.id,snapshot(owned),source,at),override=base.statusOverride==='submitted'?'submitted':null;
  return {...base,...mergeSources(base,source),historical:false,status:override||'requested',statusOverride:override,preparationStatus:'requested',requestId,requestSequence:(base.requestSequence||0)+1,taskId:null,applicationId:base.applicationId||null,errorCode:null,requestedAt:at,updatedAt:at,statusNote:override?'Student reports submission outside BRB; employer receipt is not verified.':'Preparation requested; no employer application was submitted.',requestHistory:[...(base.requestHistory||[]),requestId].slice(-128),...(source==='telegram'&&Number.isSafeInteger(updateId)?{lastTelegramUpdateId:updateId}:{})};
 });
 return {...row,staleRequest};
}

export async function updateApplicationTracking(store,{id,requestId,status,taskId,applicationId,errorCode}, {now=Date.now}={}){
 if(!/^[a-f0-9]{32}$/.test(id||'')||!/^[a-f0-9]{32}$/.test(requestId||'')||!['queued','prepared','needs_attention'].includes(status)||taskId!==undefined&&!safeID(taskId)||applicationId!==undefined&&!safeID(applicationId))throw new HttpError(400,'Invalid application preparation update.');
 const at=new Date(now()).toISOString();
 return mutate(store,id,previous=>{
  if(!previous)throw new HttpError(404,'Application tracker not found in your workspace.');
  if(previous.requestId!==requestId)return null;
  if(previous.preparationStatus==='prepared'&&status!=='prepared')return null;
  if(previous.taskId&&taskId&&previous.taskId!==taskId)return null;
  return {...previous,preparationStatus:status,status:previous.statusOverride||status,...(taskId?{taskId}:{}),...(applicationId?{applicationId}:{}),errorCode:status==='needs_attention'?(/^[A-Z0-9_]{1,80}$/.test(errorCode||'')?errorCode:'PREPARATION_FAILED'):null,preparedAt:status==='prepared'?at:previous.preparedAt||null,updatedAt:at,statusNote:previous.statusOverride==='submitted'?'Student reports submission outside BRB; employer receipt is not verified.':previous.statusOverride==='prepared'?'Student corrected this record to materials prepared; this does not withdraw any employer application.':status==='prepared'?'Application materials prepared for review. No employer application was submitted.':status==='needs_attention'?'Preparation did not finish. Review this job and retry; no employer submission was attempted.':'Preparation queued; no employer application was submitted.'};
 });
}

export async function setApplicationStatus(store,{id,status},{now=Date.now}={}){
 if(!/^[a-f0-9]{32}$/.test(id||'')||!['submitted','prepared'].includes(status))throw new HttpError(400,'Choose student-reported submitted or prepared.');
 const at=new Date(now()).toISOString();
 return mutate(store,id,previous=>{
  if(!previous)throw new HttpError(404,'Application tracker not found in your workspace.');
  return {...previous,status,statusOverride:status,updatedAt:at,...(status==='submitted'?{submissionReportedAt:at,submissionSource:'student-reported'}:{submissionCorrectedAt:at}),statusNote:status==='submitted'?'Student reports submission outside BRB; employer receipt is not verified.':'Student corrected this record to materials prepared; this does not withdraw any employer application.'};
 });
}

export async function reportApplicationSubmitted(store,{jobId,source='telegram'},{now=Date.now}={}){
 if(!safeID(jobId))throw new HttpError(400,'Use the complete job ID shown by /applications or /jobs.');sourceValue(source);
 const id=recordID(jobId),existing=await store.get(BUCKET,id);
 if(!existing){
  const job=await store.get('jobs',jobId);if(!job)throw new HttpError(404,'That job is not in your saved jobs or application tracker.');
  const at=new Date(now()).toISOString();await mutate(store,id,previous=>previous?null:{...initial(jobId,snapshot(job),source,at),preparationStatus:null,status:'submitted',statusOverride:'submitted',submissionReportedAt:at,submissionSource:'student-reported',statusNote:'Student reports submission outside BRB; employer receipt is not verified.'});
 }
 return setApplicationStatus(store,{id,status:'submitted'},{now});
}

/** History is reconstructed only from surviving owned drafts and explicit queue provenance. */
export async function listApplicationTracker(store,{queue,now=Date.now}={}){
 requireStore(store);const at=new Date(now()).toISOString(),applications=await store.all('applications'),origins=queue?.listDraftOrigins?await queue.listDraftOrigins(store.userId,{limit:500}):[];
 const grouped=new Map();
 for(const application of applications){if(safeID(application.jobId)){const item=grouped.get(application.jobId)||{};if(!item.application||String(application.createdAt||'')>String(item.application.createdAt||''))item.application=application;grouped.set(application.jobId,item);}}
 for(const origin of origins){if(origin.source!=='telegram'||!safeID(origin.jobId)||!safeID(origin.taskId))continue;const item=grouped.get(origin.jobId)||{};if(!item.origin||origin.createdAt>item.origin.createdAt)item.origin=origin;grouped.set(origin.jobId,item);}
 for(const [jobId,{application,origin}]of grouped){
  const job=await store.get('jobs',jobId),proven=origin||application?.tracking?.source==='telegram',source=proven?'telegram':application?.tracking?.source==='web'?'web':'legacy';
  const atSource=iso(origin?.createdAt)||iso(application?.createdAt)||at;
  await mutate(store,recordID(jobId),previous=>{
   // A real request or student stage is authoritative; history never replaces it.
   if(previous&&!previous.historical){const merged=mergeSources(previous,source);return merged.source!==previous.source||JSON.stringify(merged.sources)!==JSON.stringify(previous.sources)?{...previous,...merged}:null;}
   if(previous?.historical&&(!origin||previous.taskId===origin.taskId&&previous.historyTaskStatus===origin.status))return null;
   if(previous?.originCreatedAt&&origin?.createdAt<previous.originCreatedAt)return null;
   const status=origin?origin.status==='completed'?'prepared':['queued','running'].includes(origin.status)?'queued':'needs_attention':application?'prepared':'needs_attention';
   const base=previous||initial(jobId,snapshot(job||{},application||{}),source,atSource);
   return {...base,...mergeSources(base,source),historical:true,preparationStatus:status,status:base.statusOverride||status,taskId:origin?.taskId||null,originCreatedAt:origin?.createdAt||base.originCreatedAt||null,historyTaskStatus:origin?.status||null,requestId:origin?idFor('legacy-application-request',origin.taskId):null,applicationId:application?.id||base.applicationId||null,updatedAt:iso(origin?.completedAt)||atSource,historyNote:'Historical coverage is limited to surviving drafts and bounded queue history. Earlier requests may no longer be available.',statusNote:base.statusOverride==='submitted'?'Student reports submission outside BRB; employer receipt is not verified.':origin?status==='prepared'?'A Telegram preparation task completed. This is not evidence of employer submission.':status==='queued'?'A surviving Telegram preparation task is queued or running.':'A surviving Telegram preparation task needs attention; an older draft does not prove this request succeeded.':'Previous local draft; its original channel is not known. Sandbox actions are not employer submissions.'};
  });
 }
 // The queue lease reaper can fail a task after a process crash without running
 // the draft handler's catch. Only an exact current task/request may change here.
 const pending=(await store.all(BUCKET)).filter(row=>!row.historical&&row.taskId&&row.requestId&&['requested','queued'].includes(row.preparationStatus)).slice(0,100);
 const originsByTask=new Map(origins.map(origin=>[origin.taskId,origin]));
 for(const row of pending){
  const task=originsByTask.get(row.taskId)||(queue?.get?await queue.get(store.userId,row.taskId):null);
  if(task&&(task.taskId||task.id)===row.taskId&&['failed','needs_review'].includes(task.status))await updateApplicationTracking(store,{id:row.id,requestId:row.requestId,taskId:row.taskId,status:'needs_attention',errorCode:'WORKER_TASK_FAILED'},{now});
 }
 const results=new Map((await store.all(BUCKET)).map(row=>[row.jobId,view(row)]));
 for(const a of await store.all('liveApplications')){
  const job=await store.get('jobs',a.jobId),confirmed=a.status==='submitted'&&!!a.receipt?.confirmation;
  const labels={inspecting:'Reading employer form',collecting:'Awaiting your answers',drafting:'Drafting an answer',locating:'Checking work location',ready:'Ready for your review',queued:'Submission queued',submitting:'Submission in progress',uncertain:'Receipt unconfirmed',needs_attention:'Needs attention',browser_handoff:'Continue in your browser',cancelled:'Cancelled',submitted:'Submitted (employer confirmed)'};
  results.set(a.jobId,{id:recordID(a.jobId),jobId:a.jobId,...snapshot(job||{},a),source:'telegram',sourceLabel:'Telegram',liveApplicationId:a.id,liveApplicationStatus:a.status,browserHandoffAvailable:Array.isArray(a.form?.fields)&&a.form.fields.length<=70&&(a.status==='uncertain'&&Number.isFinite(Date.parse(a.submitAttemptAt))||!a.submitAttemptAt&&['collecting','ready','needs_attention','browser_handoff'].includes(a.status)),startedAt:a.createdAt,updatedAt:a.updatedAt,status:confirmed?'submitted':['needs_attention','uncertain'].includes(a.status)?'needs_attention':'requested',statusLabel:labels[a.status]||'Needs attention',statusNote:confirmed?a.receipt.confirmation:a.status==='uncertain'?'Submission was attempted, but receipt is unconfirmed. No automatic retry.':a.status==='browser_handoff'?'Finish and submit on the employer page. Automatic submission in Telegram is paused.':'Continue this application in Telegram with /application.',submissionSource:confirmed?'employer-confirmed':null,submissionConfirmedAt:confirmed?a.receipt.confirmedAt:null});
 }
 return [...results.values()].sort((a,b)=>String(b.startedAt||'').localeCompare(String(a.startedAt||''))||a.id.localeCompare(b.id));
}

/** Bind old queued Telegram tasks without fabricating channel attribution for unrelated drafts. */
export async function trackDraftExecution(store,task,{now=Date.now}={}){
 const payload=task.payload||{},jobId=payload.id;
 if(!safeID(jobId))return null;
 if(payload.trackerId||payload.trackerRequestId){
  if(payload.trackerId!==recordID(jobId)||!/^[a-f0-9]{32}$/.test(payload.trackerRequestId||''))throw new HttpError(400,'Invalid preparation tracking metadata.');
  const row=await store.get(BUCKET,payload.trackerId);if(!row||row.jobId!==jobId)throw new HttpError(404,'Preparation tracker not found in your workspace.');
  if(row.requestId!==payload.trackerRequestId)return {...view(row),staleRequest:true};
  return updateApplicationTracking(store,{id:row.id,requestId:row.requestId,status:'queued',taskId:task.id},{now});
 }
 if(payload.replyTo!=='telegram')return null;
 const id=recordID(jobId),requestId=idFor('legacy-application-request',task.id),at=iso(task.createdAt)||new Date(now()).toISOString(),job=await store.get('jobs',jobId),application=(await store.all('applications')).find(a=>a.jobId===jobId);
 const row=await mutate(store,id,previous=>{
  if(previous?.requestId&&previous.requestId!==requestId){
   if(!previous.historical)return null;
   if(previous.originCreatedAt&&(!Number.isFinite(task.createdAt)||task.createdAt<=previous.originCreatedAt))return null;
  }
  const base=previous||initial(jobId,snapshot(job||{},application||{}),'telegram',at);
  return {...base,...mergeSources(base,'telegram'),historical:false,requestId,taskId:task.id,preparationStatus:'queued',status:base.statusOverride||'queued',updatedAt:new Date(now()).toISOString()};
 });
 return {...row,staleRequest:row.requestId!==requestId};
}
