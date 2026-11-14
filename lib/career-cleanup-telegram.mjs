import {menuCard} from './telegram-menu.mjs';
import {listApplicationTracker} from './application-tracker.mjs';
import {listCareerJobs} from './job-saves.mjs';
import {listVisibleJobs,previewCareerCleanup,performCareerCleanup} from './career-cleanup.mjs';

const FLOW='careerCleanupFlow',pageSize=6;
const labels={applications:'Applications',saved:'Saved jobs',found:'Found jobs',all:'All three job lists'};
const action=value=>({careerCleanup:value});
const back=[[['Manage job lists',{page:'manage-jobs'}],['Jobs',{page:'jobs'}]]];
const compact=(value,max=100)=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
const bindingOf=linked=>linked?.chatId?{chatId:String(linked.chatId),linkedAt:linked.linkedAt||''}:null;
const sameBinding=(a,b)=>!!a&&!!b&&a.chatId===b.chatId&&a.linkedAt===b.linkedAt;
const countsText=counts=>`${counts.applications||0} application${counts.applications===1?'':'s'} · ${counts.saved||0} saved job${counts.saved===1?'':'s'} · ${counts.found||0} found job${counts.found===1?'':'s'}`;
const safeError=error=>Number(error?.statusCode||error?.status)>=400&&Number(error?.statusCode||error?.status)<500?compact(error.message,400):'The list could not be updated. Open a fresh preview and try again.';

async function rowsFor(store,queue,scope){
 if(scope==='applications')return listApplicationTracker(store,{queue});
 if(scope==='saved')return (await listCareerJobs(store)).filter(job=>job.saved);
 return listVisibleJobs(store);
}

export async function showCareerCleanup(store,queue,key,{scope,offset=0,notice='',binding:expectedBinding}={}){
 const binding=bindingOf(await store.get('secrets','telegram'));if(!binding||expectedBinding&&!sameBinding(binding,expectedBinding))return;
 if(!scope){
  const [applications,jobs,found]=await Promise.all([listApplicationTracker(store,{queue}),listCareerJobs(store),listVisibleJobs(store)]);
  return menuCard(store,queue,`${notice?`${notice}\n\n`:''}Manage your job lists\n\nRemove individual items or reset a list. Your résumé, profile, demographics, and saved answers stay available.\n\nRemoving an application from BRB does not withdraw it from the employer.`,[[[`Applications · ${applications.length}`,action({operation:'list',scope:'applications'})]],[ [`Saved jobs · ${jobs.filter(job=>job.saved).length}`,action({operation:'list',scope:'saved'})] ],[[`Found jobs · ${found.length}`,action({operation:'list',scope:'found'})]],[['Reset all three lists',action({operation:'preview',scope:'all'})]],[['Jobs',{page:'jobs'}],['Main menu',{page:'home'}]]],key,{binding});
 }
 if(!['applications','saved','found'].includes(scope)||!Number.isSafeInteger(offset)||offset<0||offset>100000)return;
 const rows=await rowsFor(store,queue,scope),start=rows.length?Math.min(offset,Math.floor((rows.length-1)/pageSize)*pageSize):0,shown=rows.slice(start,start+pageSize);
 const details=shown.map((row,i)=>`${start+i+1}. ${compact(row.title)||'Untitled role'} — ${compact(row.company,70)||'Company not specified'}`).join('\n');
 const buttons=shown.map((row,i)=>[[`Remove ${start+i+1}: ${compact(row.title,46)||'Untitled role'}`,action({operation:'preview',scope,id:scope==='applications'?row.jobId:row.id})]]);
 const pagination=[];if(start>0)pagination.push(['Previous',action({operation:'list',scope,offset:Math.max(0,start-pageSize)})]);if(start+pageSize<rows.length)pagination.push(['Next',action({operation:'list',scope,offset:start+pageSize})]);if(pagination.length)buttons.push(pagination);
 if(rows.length)buttons.push([[`Reset ${labels[scope].toLowerCase()}`,action({operation:'preview',scope})]]);
 return menuCard(store,queue,`${notice?`${notice}\n\n`:''}${labels[scope]} · ${rows.length}\n\n${details||'This list is empty.'}${shown.length?'\n\nChoose an item to preview its removal.':''}`,[...buttons,...back],key,{binding});
}

export async function handleCareerCleanupAction(store,queue,input,key){
 if(!input||typeof input!=='object'||Array.isArray(input))return;
 const binding=bindingOf(await store.get('secrets','telegram'));if(!binding)return;
 if(input.operation==='list')return showCareerCleanup(store,queue,key,{scope:input.scope,offset:input.offset??0});
 if(input.operation==='preview'){
  try{
   const proposal=await previewCareerCleanup(store,{scope:input.scope,...(input.id?{id:input.id}:{})},{queue});
   const effects=[proposal.counts.applications?'Applications are removed from your tracker. Existing employer submissions are not withdrawn; their receipt records stay protected against duplicate submission.':'',proposal.counts.saved?'Saved jobs are removed from your shortlist.':'',proposal.counts.found?`Found jobs are hidden from results and future suggestions for those same postings.${proposal.scope==='all'?'':' Independently saved jobs remain in your shortlist.'}`:''].filter(Boolean).join('\n');
   const blocked=(proposal.blocked||[]).slice(0,4).map(row=>`${compact(row.title,90)||'Application'}: ${compact(row.reason,160)}`).join('\n');
   if(!proposal.canConfirm)return menuCard(store,queue,`${compact(proposal.label,180)||labels[proposal.scope]}\n\n${countsText(proposal.counts)}\n\n${blocked?`Some applications are still processing. Wait for them to finish before resetting this list, or remove other items individually.\n${blocked}`:'There is nothing to remove.'}`,back,key,{binding});
   const flow={token:proposal.token,scope:proposal.scope,status:'preview',expiresAt:proposal.expiresAt,binding};
   await store.put('settings',FLOW,flow);
   return menuCard(store,queue,`${input.id?'Remove this item?':'Reset this list?'}\n${compact(proposal.label,180)||labels[proposal.scope]}\n\n${countsText(proposal.counts)}\n\n${effects}\n\nYour résumé, profile, and saved answers stay available.`,[[[input.id?'Confirm removal':'Confirm reset',action({operation:'confirm',token:proposal.token})],['Cancel',action({operation:'cancel',token:proposal.token})]]],key,{binding,ttl:Math.max(1,proposal.expiresAt-Date.now())});
  }catch(error){return menuCard(store,queue,safeError(error),back,key,{binding});}
 }
 if(!['confirm','cancel'].includes(input.operation))return;
 const flow=await store.get('settings',FLOW);
 if(!flow||flow.token!==input.token||flow.status!=='preview'||flow.expiresAt<=Date.now()||!sameBinding(flow.binding,binding))return menuCard(store,queue,'This removal preview expired or was cancelled. Open a fresh preview.',back,key,{binding});
 const claimed={...flow,status:input.operation==='cancel'?'cancelled':'confirming'};
 if(!await store.compareAndSet('settings',FLOW,flow,claimed))return;
 if(input.operation==='cancel')return showCareerCleanup(store,queue,key,{scope:flow.scope==='all'?undefined:flow.scope,notice:'Cancelled. Nothing was removed.',binding});
 try{
  const result=await performCareerCleanup(store,{token:flow.token});
  await store.compareAndSet('settings',FLOW,claimed,{...claimed,status:'completed'});
  return showCareerCleanup(store,queue,key,{scope:flow.scope==='all'?undefined:flow.scope,notice:`Removed from your lists: ${countsText(result.counts)}.`,binding});
 }catch(error){
  await store.compareAndSet('settings',FLOW,claimed,{...claimed,status:'failed'});
  return menuCard(store,queue,`${safeError(error)}\n\nOpen a fresh preview before trying again.`,back,key,{binding});
 }
}
