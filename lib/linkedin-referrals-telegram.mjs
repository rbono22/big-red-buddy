import {matchLinkedInConnections,readLinkedInConnections} from './linkedin-connections.mjs';
import {menuCard} from './telegram-menu.mjs';
import {liveApplicationSupported} from './application-providers.mjs';

const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9._:-]{1,200}$/.test(value);
const available=job=>job&&!job.closed&&job.status!=='closed'&&job.eligible!==false;

/** The durable request contains identifiers only; resolve names and draft text at delivery. */
export async function queueLinkedInReply(store,queue,request,key){
 const linked=await store.get('secrets','telegram');if(!linked?.chatId)return false;
 await queue.enqueue(store.userId,'telegram-leads',{...request,expectedChatId:String(linked.chatId),expectedTelegramLinkedAt:linked.linkedAt||''},{idempotencyKey:`linkedin-leads:${key}`,retrySafe:false,maxAttempts:1});
 return true;
}

export async function offerReferralBeforeApplication(store,queue,job,key){
 if(!available(job)||!job.company||job.titlePending)return false;
 const result=await matchLinkedInConnections(store,job.company);
 if(!result.matches.length)return false;
 return queueLinkedInReply(store,queue,{jobId:job.id,sourceVersion:result.sourceVersion,mode:'offer'},`offer:${key}`);
}

/** Menu tokens have already been checked against the caller's private Telegram binding. */
export async function handleReferralAction(database,store,queue,action,key){
 if(!action||!['list','draft','continue'].includes(action.op)||!validId(action.jobId)||typeof action.sourceVersion!=='string')return false;
 const job=await store.get('jobs',action.jobId),metadata=await readLinkedInConnections(store);
 if(!available(job))return menuCard(store,queue,'This job is no longer available. Choose another role.',[[['Jobs',{page:'jobs'}]]],`referral-unavailable:${key}`);
 if(!metadata.connected||metadata.sourceVersion!==action.sourceVersion)return menuCard(store,queue,'Your imported connections changed. Open this job again to use your current list.',[[['Return to application',{command:`/apply ${job.id}`}],['Jobs',{page:'jobs'}]]],`referral-changed:${key}`);
 if(action.op==='continue'){
  if(liveApplicationSupported(job))return (await import('./live-applications.mjs')).startLiveApplication(store,queue,job.id,key,{skipReferral:true});
  const linked=await store.get('secrets','telegram');if(!linked?.chatId)return false;
  return (await import('./career-telegram.mjs')).handleCareerMessage(database,queue,store,{text:`/apply ${job.id}`,chat:{id:linked.chatId,type:'private'}},key,{skipReferral:true});
 }
 const request={jobId:job.id,sourceVersion:metadata.sourceVersion,mode:action.op};
 if(action.op==='draft'){
  if(!validId(action.contactId))return false;
  const result=await matchLinkedInConnections(store,job.company);
  if(result.sourceVersion!==metadata.sourceVersion||!result.matches.some(person=>person.id===action.contactId))return menuCard(store,queue,'That connection no longer matches this employer. Check your current list.',[[['Find connections',{command:`/leads ${job.id}`}]]],`referral-contact-changed:${key}`);
  request.contactId=action.contactId;
 }else if(action.offset!==undefined){
  if(!Number.isInteger(action.offset)||action.offset<0||action.offset>15||action.offset%5)return false;
  request.offset=action.offset;
 }
 return queueLinkedInReply(store,queue,request,key);
}
