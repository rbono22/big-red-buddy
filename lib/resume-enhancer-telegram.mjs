import {menuCard} from './telegram-menu.mjs';
import {listCareerJobs} from './job-saves.mjs';
import {getResumeEnhancement,queueResumeEnhancement,selectResumeEnhancement,executeResumeEnhancement} from './resume-enhancer.mjs';

const action=value=>({resumeEnhancer:value});
const compact=(value,max=200)=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
const bindingOf=linked=>linked?.chatId?{chatId:String(linked.chatId),linkedAt:linked.linkedAt||''}:null;
const sameBinding=(a,b)=>!!a&&!!b&&a.chatId===b.chatId&&a.linkedAt===b.linkedAt;
const back=[[['Choose another job',action({operation:'show'})],['Jobs',{page:'jobs'}]]];
const safeError=error=>Number(error?.status)>=400&&Number(error?.status)<500?compact(error.message,350):['STUDENT_QUEUE_FULL','STUDENT_MODEL_QUEUE_FULL'].includes(error?.message)?'Your processing queue is full. Let current tasks finish, then try again.':'The résumé could not be enhanced. Your original is still available. Try again when the private model is ready.';
const webURL=jobId=>`${process.env.APP_ORIGIN||'http://127.0.0.1:4318'}/#resume-enhancer/${encodeURIComponent(jobId)}`;

export async function showResumeEnhancer(store,queue,key,{jobId,offset=0,notice='',binding:expectedBinding}={}){
 const binding=bindingOf(await store.get('secrets','telegram'));if(!binding||expectedBinding&&!sameBinding(binding,expectedBinding))return;
 if(!jobId){
  const jobs=(await listCareerJobs(store)).filter(job=>!job.closed&&job.status!=='closed'&&job.eligible!==false);
  const start=Number.isSafeInteger(offset)&&offset>=0?Math.min(offset,Math.max(0,Math.floor((jobs.length-1)/6)*6)):0,shown=jobs.slice(start,start+6);
  const buttons=shown.map(job=>[[`${compact(job.company,24)} · ${compact(job.title,42)}`,action({operation:'show',jobId:job.id})]]);
  const nav=[];if(start)nav.push(['Previous',action({operation:'show',offset:Math.max(0,start-6)})]);if(start+6<jobs.length)nav.push(['More jobs',action({operation:'show',offset:start+6})]);if(nav.length)buttons.push(nav);
  return menuCard(store,queue,`Resume AI Enhancer\n\n${jobs.length?'Choose a job to tailor your résumé. Exact job titles, employers, dates, and qualifications are preserved. Matching keywords are added only when your résumé supports them.':'Find or save a job in Career Studio first.'}`,[...buttons,[['Career Studio',{url:`${process.env.APP_ORIGIN||'http://127.0.0.1:4318'}/#careers`}],['Jobs',{page:'jobs'}]]],key,{binding});
 }
 try{
  const view=await getResumeEnhancement(store,jobId,{queue}),buttons=[],heading=`Resume AI Enhancer\n${compact(view.job?.title,130)} — ${compact(view.job?.company,80)}`;
  let text=notice?`${notice}\n\n${heading}`:heading;
  if(view.stale){text+='\n\nYour résumé or this posting changed. Generate a fresh version before using it.';buttons.push([['Enhance for this job',action({operation:'generate',jobId})]]);}
  else if(['queued','working'].includes(view.status)){
   text+='\n\nYour tailored résumé is being prepared. Use Check progress to see the result.';
   buttons.push([['Check progress',action({operation:'show',jobId})]]);
  }else if(view.status==='ready'){
   text+=`\n\n${view.changes.length} wording change${view.changes.length===1?'':'s'}. Your original job titles are preserved.`;
   for(const change of view.changes.slice(0,3))text+=`\n\nBefore: ${compact(change.original,260)}\nAfter: ${compact(change.suggested,300)}`;
   if(view.keywords.length)text+=`\n\nKeywords: ${view.keywords.slice(0,12).map(k=>compact(k,55)).join(', ')}`;
   if(view.gaps.length)text+=`\n\nNot added without evidence: ${view.gaps.slice(0,6).map(k=>compact(k,55)).join(', ')}`;
   text+=view.selected?'\n\nSelected for new applications to this job.':'\n\nChoose Use for this job to select this version for new applications.';
   buttons.push([[view.selected?'Use original résumé':'Use for this job',action({operation:'select',jobId,enhancementId:view.selected?null:view.id})]]);
   buttons.push([['View all edits & download PDF',{url:webURL(jobId)}]]);
  }else{
   text+=view.status==='failed'?`\n\n${compact(view.error,300)||'Generation could not finish. Try again.'}`:'\n\nTailor your experience to this posting using supported keywords. Your original résumé stays saved.';
   buttons.push([['Enhance for this job',action({operation:'generate',jobId})]]);
  }
  if(view.selectedEnhancementId&&(view.stale||view.status!=='ready'||!view.selected)){
   text+='\n\nA previous tailored résumé is still selected for this job. You can switch back to your original.';
   buttons.push([['Use original résumé',action({operation:'select',jobId,enhancementId:null})]]);
  }
  return menuCard(store,queue,text,[...buttons,...back],key,{binding});
 }catch(error){return menuCard(store,queue,safeError(error),back,key,{binding});}
}

export async function handleResumeEnhancerAction(store,queue,input,key){
 if(!input||typeof input!=='object'||Array.isArray(input))return;
 const binding=bindingOf(await store.get('secrets','telegram'));if(!binding)return;
 if(input.operation==='show')return showResumeEnhancer(store,queue,key,{jobId:input.jobId,offset:input.offset,binding});
 try{
  if(input.operation==='generate'){
   await queueResumeEnhancement(store,queue,{jobId:input.jobId},{replyTo:'telegram',telegramBinding:binding});
   return showResumeEnhancer(store,queue,key,{jobId:input.jobId,binding});
  }
  if(input.operation==='select'){
   await selectResumeEnhancement(store,{jobId:input.jobId,enhancementId:input.enhancementId});
   return showResumeEnhancer(store,queue,key,{jobId:input.jobId,notice:input.enhancementId?'Selected for new applications to this job. Applications already started keep their chosen document.':'Your original résumé will be used for new applications to this job.',binding});
  }
 }catch(error){return menuCard(store,queue,safeError(error),back,key,{binding});}
}

export async function executeResumeEnhancementJob(database,task,{queue,execute=executeResumeEnhancement}={}){
 const store=database.forUser(task.userId),payload=task.payload||{},binding=payload.telegramBinding;
 try{
  const result=await execute(database,task);
  if(payload.replyTo==='telegram'&&binding&&!result?.superseded&&result?.id===payload.enhancementId){
   await showResumeEnhancer(store,queue,`resume-enhance:${task.id}`,{jobId:payload.jobId,binding});
  }
  return result;
 }catch(error){
  if(payload.replyTo==='telegram'&&binding&&(!payload.enhancementId||(await getResumeEnhancement(store,payload.jobId).catch(()=>null))?.id===payload.enhancementId))await menuCard(store,queue,safeError(error),[[['Try again',action({operation:'generate',jobId:payload.jobId})]],...back],`resume-enhance-error:${task.id}`,{binding});
  throw error;
 }
}
