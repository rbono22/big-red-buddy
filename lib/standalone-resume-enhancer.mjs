import {createHash,randomUUID} from 'node:crypto';
import {HttpError} from './security.mjs';
import {standaloneApplicationURL} from './application-autofill.mjs';
import {generateGroundedResume,validateResumeEnhancementSources} from './resume-enhancer.mjs';

const BUCKET='standaloneResumeEnhancements',INDEX='standaloneResumeEnhancementKeys',TTL=30*60*1000;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceHash=resume=>hash(resume);
const clock=now=>typeof now==='function'?now():now;
const fail=(status,message,code='STANDALONE_RESUME_INVALID')=>new HttpError(status,message,code);
const stale=()=>fail(409,'Your résumé or this request changed. Click Tailor résumé & autofill again.','STANDALONE_RESUME_STALE');
const id=value=>{if(typeof value!=='string'||!/^[a-f0-9-]{36}$/.test(value))throw fail(400,'Choose a résumé request from your account.');return value;};
const instructions=/\b(?:ignore (?:all |previous |above )?instructions|system prompt|developer message|secret token|api[ _-]?key|javascript:)\b/i;
const text=(value,max)=>typeof value==='string'&&value.length<=max&&!/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(value);
function context(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['url','title','company','description'].includes(key)))throw fail(400,'Supply the application URL, role, company and job description.');
 const url=standaloneApplicationURL(input.url);
 for(const key of ['title','company'])if(!text(input[key],key==='title'?300:200)||!input[key].trim()||/[\r\n<>]/.test(input[key])||instructions.test(input[key]))throw fail(400,'Enter the role title and company shown on this application.');
 if(!text(input.description,20000)||input.description.trim().length<80)throw fail(400,'Open the full job description, or paste it in the helper, before tailoring your résumé.','STANDALONE_RESUME_DESCRIPTION_REQUIRED');
 const description=input.description.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ').trim();
 if(description.length<80)throw fail(400,'Add the full job description before tailoring your résumé.','STANDALONE_RESUME_DESCRIPTION_REQUIRED');
 const result={url,title:input.title.trim(),company:input.company.trim(),description};
 resumeCompanyFileName(result.company);return result;
}
export function resumeCompanyFileName(company){
 const label=String(company||'').normalize('NFKC').replace(/[^\p{L}\p{N} _-]/gu,'').replace(/\s+/g,' ').trim().slice(0,70).trim();
 if(!label||!/[\p{L}\p{N}]/u.test(label))throw fail(400,'Enter a company name for the résumé filename.');
 return `Resume_${label}.pdf`;
}
function requireStore(store){if(!store?.userId||typeof store.compareAndSetMany!=='function')throw fail(401,'Sign in to BRB before tailoring your résumé.');}
async function state(store){
 requireStore(store);const [resume,account,profile]=await Promise.all([store.get('documents','resume'),store.get('settings','account'),store.get('settings','profile')]);
 if(account?.deleting||profile?.paused)throw fail(409,'Resume your BRB workspace before tailoring an application.','STANDALONE_RESUME_UNAVAILABLE');
 return {resume,account,profile};
}
const guards=source=>[{bucket:'documents',id:'resume',expected:source.resume},{bucket:'settings',id:'account',expected:source.account},{bucket:'settings',id:'profile',expected:source.profile}];
const fresh=(record,source,at)=>!!record&&record.sourceHash===sourceHash(source.resume)&&record.expiresAt>at&&record.contextHash===hash(record.context);
function view(record,{current=true}={}){
 return {id:record.id,status:current?record.status:'stale',taskId:record.taskId||null,expiresAt:record.expiresAt,company:record.context.company,title:record.context.title,
  ...(record.document?{fileName:record.document.name,noChanges:record.noChanges===true}:{}),
  ...(current?record.error?{error:record.error,errorCode:record.errorCode}:{}:{error:stale().message,errorCode:stale().code})};
}
async function activeTask(store,record,queue,at){
 if(!record.taskId||typeof queue?.get!=='function')return at-record.createdAt<10*60*1000;
 const task=await queue.get(store.userId,record.taskId);
 return !!task&&['queued','running'].includes(task.status)&&(!task.expiresAt||task.expiresAt>at)&&!(task.status==='running'&&task.leaseUntil&&task.leaseUntil+30000<at);
}
export async function getStandaloneResumeEnhancement(store,enhancementId,{queue,now=Date.now}={}){
 const source=await state(store),record=await store.get(BUCKET,id(enhancementId));
 if(!record)throw fail(404,'This résumé request is not available in your account.','STANDALONE_RESUME_NOT_FOUND');
 const at=clock(now),current=fresh(record,source,at);
 if(current&&queue&&['queued','working'].includes(record.status)&&!await activeTask(store,record,queue,at))return view({...record,status:'failed',error:'The résumé task stopped before finishing. Click Tailor résumé & autofill again.','errorCode':'STANDALONE_RESUME_STOPPED'});
 return view(record,{current});
}
async function prune(store,at){
 for(const record of await store.all(BUCKET))if(record.expiresAt<=at){
  const pointer=await store.get(INDEX,record.cacheKey),changes=[{bucket:BUCKET,id:record.id,expected:record,delete:true}];
  if(pointer?.id===record.id)changes.push({bucket:INDEX,id:record.cacheKey,expected:pointer,delete:true});
  await store.compareAndSetMany(changes);
 }
}
/** Explicit toolbar action; no application, job, or global résumé selection is changed. */
export async function queueStandaloneResumeEnhancement(store,queue,input,{now=Date.now}={}){
 const job=context(input),at=clock(now);if(!Number.isFinite(at))throw fail(400,'Invalid request time.');
 requireStore(store);await prune(store,at);
 for(let attempt=0;attempt<4;attempt++){
  const source=await state(store);validateResumeEnhancementSources(source.resume,job);
  const cacheKey=hash({context:job,source:sourceHash(source.resume)}),pointer=await store.get(INDEX,cacheKey),previous=pointer?.id?await store.get(BUCKET,pointer.id):null;
  if(fresh(previous,source,at)&&previous.contextHash===hash(job)){
   if(previous.status==='ready'||['queued','working'].includes(previous.status)&&await activeTask(store,previous,queue,at))return view(previous);
  }
  const records=await store.all(BUCKET);
  if(records.length>=50)throw fail(429,'Too many résumé requests are active. Try again after earlier requests expire.','STANDALONE_RESUME_LIMIT');
  const enhancementId=randomUUID(),record={id:enhancementId,cacheKey,context:job,contextHash:hash(job),sourceHash:sourceHash(source.resume),status:'queued',createdAt:at,expiresAt:at+TTL};
  if(!await store.compareAndSetMany([...guards(source),{bucket:BUCKET,id:enhancementId,expected:null,value:record},{bucket:INDEX,id:cacheKey,expected:pointer,value:{id:enhancementId}}],{buckets:[{bucket:BUCKET,ids:records.map(row=>row.id)}]}))continue;
  try{
   const task=await queue.enqueue(store.userId,'autofill-resume-enhance',{enhancementId},{idempotencyKey:`standalone-resume:${enhancementId}`,priority:5,retrySafe:false,maxAttempts:1,ttlMs:TTL});
   const latest=await store.get(BUCKET,enhancementId);if(latest)await store.compareAndSet(BUCKET,enhancementId,latest,{...latest,taskId:task.id});
   return getStandaloneResumeEnhancement(store,enhancementId,{now});
  }catch(error){
   const latest=await store.get(BUCKET,enhancementId);if(latest)await store.compareAndSet(BUCKET,enhancementId,latest,{...latest,status:'failed',error:'The résumé task could not start. Try again after current tasks finish.',errorCode:'STANDALONE_RESUME_QUEUE_FAILED'});
   throw fail(['STUDENT_QUEUE_FULL','STUDENT_MODEL_QUEUE_FULL'].includes(error.message)?429:503,'The résumé task could not start. Try again after current tasks finish.','STANDALONE_RESUME_QUEUE_FAILED');
  }
 }
 throw stale();
}
export async function executeStandaloneResumeEnhancement(database,task,{now=Date.now,...deps}={}){
 const store=database.forUser(task.userId),enhancementId=id(task.payload?.enhancementId),executionId=randomUUID();let record=await store.get(BUCKET,enhancementId),claimed=false;
 if(!record)throw fail(404,'This résumé request is unavailable.','STANDALONE_RESUME_NOT_FOUND');
 try{
  const source=await state(store),at=clock(now);if(!fresh(record,source,at))throw stale();
  if(record.status==='ready')return view(record);
  if(record.status==='working')throw fail(409,'This résumé is already being prepared.','STANDALONE_RESUME_WORKING');
  if(record.status!=='queued')throw fail(409,'Start a new résumé request to retry.','STANDALONE_RESUME_NOT_QUEUED');
  const working={...record,status:'working',executionId};
  if(!await store.compareAndSetMany([...guards(source),{bucket:BUCKET,id:enhancementId,expected:record,value:working}]))throw stale();record=working;claimed=true;
  const result=await generateGroundedResume(source.resume,record.context,{...deps,allowNoChanges:true});
  const latest=await store.get(BUCKET,enhancementId),ready={...latest,status:'ready',completedAt:clock(now),document:{...result.document,name:resumeCompanyFileName(record.context.company)},noChanges:result.noChanges,keywords:result.keywords};
  if(!latest||latest.status!=='working'||latest.executionId!==executionId||!fresh(latest,source,clock(now))||!await store.compareAndSetMany([...guards(source),{bucket:BUCKET,id:enhancementId,expected:latest,value:ready}]))throw stale();
  return view(ready);
 }catch(error){
  const safe=error instanceof HttpError?error:fail(503,'The résumé could not be prepared. Try again; your saved résumé is unchanged.','STANDALONE_RESUME_FAILED');
  const latest=await store.get(BUCKET,enhancementId);
  if(latest&&!['ready','failed'].includes(latest.status)&&((claimed&&latest.executionId===executionId)||!claimed&&latest.status==='queued')&&safe.code!=='STANDALONE_RESUME_WORKING')await store.compareAndSet(BUCKET,enhancementId,latest,{...latest,status:'failed',error:safe.message,errorCode:safe.code});
  throw safe;
 }
}
/** Resolve only for this exact page and latest saved résumé. Call verify at export time. */
export async function resolveStandaloneResumeEnhancement(store,{enhancementId,url},{now=Date.now}={}){
 const target=standaloneApplicationURL(url),source=await state(store),record=await store.get(BUCKET,id(enhancementId));
 if(!record)throw fail(404,'This résumé request is not available in your account.','STANDALONE_RESUME_NOT_FOUND');
 if(record.context.url!==target||!fresh(record,source,clock(now)))throw stale();
 if(record.status!=='ready'||!record.document)throw fail(409,'Wait for your résumé to finish before attaching it.','STANDALONE_RESUME_NOT_READY');
 const verify=async()=>{
  const latestSource=await state(store),latest=await store.get(BUCKET,enhancementId);
  if(!fresh(latest,latestSource,clock(now))||hash(latest)!==hash(record)||sourceHash(latestSource.resume)!==sourceHash(source.resume))throw stale();
 };
 return {document:structuredClone(record.document),enhancementId:record.id,noChanges:record.noChanges===true,company:record.context.company,title:record.context.title,sourceHash:record.sourceHash,expiresAt:record.expiresAt,verify};
}
