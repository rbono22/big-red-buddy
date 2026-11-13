import {randomBytes} from 'node:crypto';
import {idFor} from './domain.mjs';
import {menuCard} from './telegram-menu.mjs';
import {agendaWhen} from './calendar-agenda.mjs';
import {listDeletionCandidates,createDeletionProposal,confirmDeletion,cancelDeletion,executeDeletion} from './calendar-deletion.mjs';

const FLOW='calendarDeletionFlow', TTL=15*60000;
const nonce=()=>randomBytes(16).toString('hex');
const action=value=>({calendarDeletion:value});
const home=[[['My calendar',{page:'calendar'}],['Main menu',{page:'home'}]]];
const settings=()=>({url:`${process.env.APP_ORIGIN}/#calendar-edit`});
const compact=(value,max=160)=>String(value||'Untitled event').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
const when=event=>agendaWhen({...event,endDate:event.endDate||(event.allDay?event.end:undefined)});
const bindingOf=linked=>({chatId:String(linked.chatId),linkedAt:linked.linkedAt||''});
const sameBinding=(a,b)=>a?.chatId===b?.chatId&&a?.linkedAt===b?.linkedAt;
const currentBinding=async store=>{const linked=await store.get('secrets','telegram');return linked?.chatId?bindingOf(linked):null;};
const safeError=error=>Number(error?.statusCode||error?.status)>=400&&Number(error?.statusCode||error?.status)<500?error.message:'Google Calendar could not be reached. Try again shortly.';

async function currentFlow(store,id,{now=Date.now}={}){
 const flow=await store.get('settings',FLOW),binding=await currentBinding(store);
 return flow&&flow.id===id&&flow.expiresAt>now()&&sameBinding(flow.binding,binding)&&!['cancelled','confirming','queued'].includes(flow.status)&&!(await store.get('settings','account'))?.deleting?flow:null;
}
async function newFlow(store,status,extra={},key){
 const binding=await currentBinding(store);if(!binding)return null;
 const previous=await store.get('settings',FLOW),requestId=idFor('calendar-deletion-request',status,String(key));
 const proposed={id:nonce(),status,binding,expiresAt:Date.now()+TTL,previousFlowId:previous?.id||null,...extra};
 // The Telegram cursor may replay an update after enqueueing its jobs. Keep its
 // original flow identity, including after a crash between reservation and CAS.
 const flow=await store.putIfAbsent('calendarDeletionRequests',requestId,proposed);
 if(!sameBinding(flow.binding,binding)||flow.expiresAt<=Date.now())return null;
 const current=await store.get('settings',FLOW);
 if(current?.id===flow.id)return current;
 if((current?.id||null)!==flow.previousFlowId)return null;
 return await store.compareAndSet('settings',FLOW,current,flow)?flow:null;
}
async function flowCard(store,queue,flow,text,buttons,key){
 const wrapped={enqueue:(user,type,payload,options)=>queue.enqueue(user,type,{...payload,calendarDeletionFlowId:flow.id},options)};
 return menuCard(store,wrapped,text,buttons,key,{binding:flow.binding});
}
async function enqueueSearch(store,queue,flow,query,offset,key){
 await queue.enqueue(store.userId,'calendar-delete-search',{flowId:flow.id,binding:flow.binding,query,offset},{idempotencyKey:`calendar-delete-search:${key}`,retrySafe:false,maxAttempts:1,ttlMs:TTL});
}
async function enqueuePreview(store,queue,flow,target,key){
 await queue.enqueue(store.userId,'calendar-delete-preview',{flowId:flow.id,binding:flow.binding,target},{idempotencyKey:`calendar-delete-preview:${key}`,retrySafe:false,maxAttempts:1,ttlMs:TTL});
}

export async function leaveCalendarDeletion(store){
 const flow=await store.get('settings',FLOW);
 if(flow&&!['queued','confirming','cancelled'].includes(flow.status))await store.compareAndSet('settings',FLOW,flow,{...flow,status:'cancelled'});
}

export async function showCalendarDeletion(store,queue,key,{query=''}={}){
 const flow=await newFlow(store,'search',{query,offset:0},key);if(!flow||flow.status!=='search')return;
 await flowCard(store,queue,flow,query?`Looking for “${query}” in your calendars…`:'Which event would you like to remove?\n\nI’m loading your events. You can also type an event name, such as “Studying with Josh”. You’ll review one event before confirming.',[[['Cancel',{calendarDeletion:{operation:'cancel',flowId:flow.id}}]]],`${key}:searching`);
 try{await enqueueSearch(store,queue,flow,query,0,key);}catch{await flowCard(store,queue,flow,'The calendar search could not start. Please try again.',[[['Try again',action({operation:'search',query,offset:0,flowId:flow.id})]],...home],`${key}:failed`);}
}

export function parseCalendarDeletionRequest(text){
 const command=text.match(/^\/(?:deleteevent|removeevent)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);if(command)return (command[1]||'').trim();
 if(/^(?:delete|remove) (?:an? )?event[.!]?$/i.test(text))return '';
 const removal=text.match(/^remove (.+?) from (?:my |the )?(?:google )?calendar[.!]?$/i);if(removal)return removal[1].trim();
 const deletion=text.match(/^delete (?:the event )?(.+?)[.!]?$/i);return deletion?deletion[1].trim():null;
}
export async function handleCalendarDeletionMessage(store,queue,msg,key){
 const text=String(msg.text||'').trim();if(!text)return false;
 const query=parseCalendarDeletionRequest(text);
 if(query!==null){if(query.length>200){await menuCard(store,queue,'Use a shorter event name, up to 200 characters.',home,key);return true;}await showCalendarDeletion(store,queue,key,{query});return true;}
 const flow=await store.get('settings',FLOW);
 if(flow?.status==='confirming'&&flow.expiresAt>Date.now()&&sameBinding(flow.binding,await currentBinding(store))&&(!text.startsWith('/')||/^\/cancel$/i.test(text))){
  await menuCard(store,queue,'Your confirmed removal is being processed. I’ll report whether Google Calendar completed it.',home,key,{binding:flow.binding});return true;
 }
 if(!flow||!await currentFlow(store,flow.id))return false;
 if(/^\/?cancel$/i.test(text)){await handleCalendarDeletionAction(store,queue,{operation:'cancel',flowId:flow.id},key);return true;}
 if(['preview','previewing'].includes(flow.status)&&!text.startsWith('/')){
  await flowCard(store,queue,flow,flow.status==='preview'?'Use the Delete this event or Remove from BRB button on the preview to confirm, or tap Cancel. A text reply does not delete anything.':'I’m still checking the event. Wait for its preview before confirming, or tap Cancel.',[[['Cancel',action({operation:'cancel',flowId:flow.id})]]],key);return true;
 }
 if(!['search','results'].includes(flow.status)||text.startsWith('/'))return false;
 if(text.length>200){await flowCard(store,queue,flow,'Type a short event name, or tap Cancel.',[[['Cancel',action({operation:'cancel',flowId:flow.id})]]],key);return true;}
 await showCalendarDeletion(store,queue,key,{query:text});return true;
}

export async function handleCalendarDeletionAction(store,queue,input,key){
 if(!input||typeof input!=='object')return;
 let flow=input.flowId?await currentFlow(store,input.flowId):null;
 if(input.flowId&&!flow)return menuCard(store,queue,'That event selection expired or changed. Start a new removal search.',[[['Remove an event',{page:'remove-event'}]],...home],key);
 if(input.operation==='cancel'){
  if(!flow)return;
  if(flow.proposalId)await cancelDeletion(store,{id:flow.proposalId,revision:flow.proposalRevision},{binding:flow.binding});
  await store.compareAndSet('settings',FLOW,flow,{...flow,status:'cancelled'});
  return menuCard(store,queue,'Cancelled. No event was deleted.',home,key,{binding:flow.binding});
 }
 if(input.operation==='search')return showCalendarDeletion(store,queue,key,{query:String(input.query||'').slice(0,200)});
 if(input.operation==='more'){
  if(!flow||!Number.isInteger(input.offset)||input.offset<0||input.offset>1000)return;
  const next={...flow,status:'search',offset:input.offset};if(!await store.compareAndSet('settings',FLOW,flow,next))return;
  return enqueueSearch(store,queue,next,flow.query||'',input.offset,key);
 }
 if(input.operation==='preview'){
  const target={};for(const field of ['candidateId','localId','personalEventId','retryProposalId'])if(typeof input[field]==='string')target[field]=input[field];
  if(Object.keys(target).length!==1)return;
  flow=await newFlow(store,'previewing',{target},key);if(!flow||flow.status!=='previewing')return;
  await flowCard(store,queue,flow,'Checking the event in Google Calendar before showing your removal preview…',[[['Cancel',action({operation:'cancel',flowId:flow.id})]]],`${key}:checking`);
  return enqueuePreview(store,queue,flow,target,key);
 }
 if(input.operation==='confirm'){
  if(!flow||flow.status!=='preview'||flow.proposalId!==input.id||flow.proposalRevision!==input.revision)return;
  const confirming={...flow,status:'confirming'};if(!await store.compareAndSet('settings',FLOW,flow,confirming))return;
  try{
   const wrapped={enqueue:(user,type,payload,options)=>queue.enqueue(user,type,{...payload,binding:flow.binding},options)};
   const proposal=await confirmDeletion(store,wrapped,{id:input.id,revision:input.revision},{binding:flow.binding});
   await store.compareAndSet('settings',FLOW,confirming,{...confirming,status:'queued'});
   const text=proposal.status==='queued'?'Removal queued. I’ll let you know when Google Calendar confirms it.':proposal.receipt?.message||'This removal is already being processed.';
   return menuCard(store,queue,text,proposal.status==='failed'?[[['Review event again',action({operation:'preview',retryProposalId:input.id})]],...home]:home,`${key}:confirmed`,{binding:flow.binding});
  }catch(error){
   await store.compareAndSet('settings',FLOW,confirming,{...confirming,status:'cancelled'});
   return menuCard(store,queue,`${safeError(error)}\n\nOpen a fresh preview before trying again.`,[[['Review event again',action({operation:'preview',retryProposalId:input.id})]],...home],`${key}:failed`,{binding:flow.binding});
  }
 }
}

export async function executeCalendarDeletionJob(store,queue,type,payload,{key=nonce(),list=listDeletionCandidates,preview=createDeletionProposal,remove=executeDeletion,isAllowed}={}){
 const binding=payload.binding;
 if(!binding||!sameBinding(binding,await currentBinding(store))||(await store.get('settings','account'))?.deleting||isAllowed&&!await isAllowed())return {skipped:true};
 if(type==='calendar-delete'){
  let receipt;
  try{receipt=await remove(store,payload,{binding,isAllowed});}
  catch(error){receipt={status:'failed',message:`${safeError(error)} No completed deletion was confirmed.`,proposalId:payload.proposalId,retry:{retryProposalId:payload.proposalId}};}
  const buttons=[];
  if(!['deleted','already-deleted','local-only'].includes(receipt.status))buttons.push([['Check event / Retry',action({operation:'preview',retryProposalId:receipt.proposalId})]]);
  if(receipt.status==='reconnect')buttons.push([['Calendar permissions',settings()]]);
  await menuCard(store,queue,[receipt.title,receipt.message].filter(Boolean).join('\n\n'),[...buttons,...home],`${key}:receipt`,{binding});
  return {status:receipt.status,proposalId:receipt.proposalId};
 }
 const flow=await currentFlow(store,payload.flowId);if(!flow||!sameBinding(binding,flow.binding))return {skipped:true};
 try{
  if(type==='calendar-delete-search'){
   const result=await list(store,{query:payload.query||'',offset:payload.offset||0},{binding,isAllowed});
   if(!await currentFlow(store,flow.id))return {skipped:true};
   const next={...flow,status:'results'};if(!await store.compareAndSet('settings',FLOW,flow,next))return {skipped:true};
   const items=result.items||[];
   const lines=items.map((item,index)=>`${index+1}. ${compact(item.title)}\n${when(item)} · ${compact(item.calendarName,90)}${item.recurring?' · One occurrence':''}${item.needsReview?'\nRemoval needs review':''}`);
   const buttons=items.map((item,index)=>[[`Review ${index+1} · ${compact(item.title,44)}`,action({operation:'preview',candidateId:item.id,flowId:flow.id})]]);
   if(result.hasMore)buttons.push([['More events',action({operation:'more',flowId:flow.id,offset:(payload.offset||0)+items.length})]]);
   if(result.needsPermission)buttons.push([['Enable calendar editing',settings()]]);
   buttons.push([['Cancel',action({operation:'cancel',flowId:flow.id})]]);
   await flowCard(store,queue,next,[(items.length?'Choose an event to review.':'No matching events found.'),...lines,result.notice,'Times shown in New York time. Type another event name to search.'].filter(Boolean).join('\n\n'),buttons,`${key}:results`);
   return {count:items.length};
  }
  if(type==='calendar-delete-preview'){
   const proposal=await preview(store,payload.target,{binding,isAllowed});
   if(!await currentFlow(store,flow.id))return {skipped:true};
   const next={...flow,status:'preview',proposalId:proposal.id,proposalRevision:proposal.revision};if(!await store.compareAndSet('settings',FLOW,flow,next))return {skipped:true};
   await flowCard(store,queue,next,`Remove this event?\n\n${compact(proposal.title,240)}\n${when(proposal)} · New York\nCalendar: ${compact(proposal.calendarName,120)}\n\n${proposal.impact}\n\n${proposal.localOnly?'Remove it from your BRB schedule?':'Confirm deletion of this one event?'}`,[[[proposal.localOnly?'Remove from BRB':'Delete this event',action({operation:'confirm',flowId:flow.id,id:proposal.id,revision:proposal.revision})],['Cancel',action({operation:'cancel',flowId:flow.id})]]],`${key}:preview`);
   return {proposalId:proposal.id};
  }
 }catch(error){
  if(!await currentFlow(store,flow.id))return {skipped:true};
  const reconnect=error?.code==='calendar_reconnect'||Number(error?.status||error?.statusCode)===401;
  const retry=type==='calendar-delete-preview'?{operation:'preview',...payload.target,flowId:flow.id}:{operation:'search',query:payload.query||'',flowId:flow.id};
  await flowCard(store,queue,flow,`${safeError(error)}\n\nNo event was deleted.`,[...(reconnect?[[['Calendar permissions',settings()]]]:[]),[['Try again',action(retry)],['Cancel',action({operation:'cancel',flowId:flow.id})]]],`${key}:failed`);
  return {status:reconnect?'reconnect':'failed'};
 }
 return {skipped:true};
}
