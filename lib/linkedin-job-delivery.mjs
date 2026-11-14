import {randomUUID} from 'node:crypto';
import {getLinkedInAlertJobs} from './linkedin-job-email.mjs';
import {linkedinJobLinks} from './linkedin-job-email-parser.mjs';
import {readNotificationPreferences,notificationAllowed} from './notification-preferences.mjs';
import {sendTelegram} from './integrations.mjs';

const clean=(value,max)=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const stamp=value=>Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value)):'';
export function linkedInAlertText(job){
 return `${clean(job.title,160)}\n${clean(job.company,120)}${job.location?` · ${clean(job.location,140)}`:''}\n\nFrom your LinkedIn job alerts${job.alertName?` · ${clean(job.alertName,160)}`:''}\nReceived ${stamp(job.receivedAt)} · New York\nPosting date not supplied by the email. Open LinkedIn for the full requirements and current availability.`;
}
export function linkedInNotice(snapshot,jobs=snapshot.jobs){
 return {linkedinJobEmail:{revision:snapshot.revision,connectionRevision:snapshot.connectionRevision,delivery:snapshot.delivery,jobs:jobs.map(job=>({id:job.id,url:job.url,receivedAt:job.receivedAt}))}};
}
/** Revalidate source consent and removal state at the final transmission boundary. */
export async function linkedInNotificationMatches(store,notice,{now=Date.now}={}){
 if(notice===undefined)return true;
 if(!notice||!notice.revision||!notice.connectionRevision||!['daily','alerts'].includes(notice.delivery)||!Array.isArray(notice.jobs)||!notice.jobs.length||notice.jobs.length>10)return false;
 const current=await getLinkedInAlertJobs(store,{now,limit:300});
 if(current.revision!==notice.revision||current.connectionRevision!==notice.connectionRevision||current.delivery!==notice.delivery)return false;
 return notice.jobs.every(item=>current.jobs.some(job=>job.id===item?.id&&job.url===item.url&&job.receivedAt===item.receivedAt));
}
export async function linkedInJobButtons(store,job){
 const url=linkedinJobLinks(job.url)[0];if(!url||url!==job.url)throw new Error('Invalid LinkedIn job URL.');
 const {menuMarkup}=await import('./telegram-menu.mjs');
 return menuMarkup(store,[[['Open on LinkedIn',{url}]],[['Save',{saveJob:job.id}],['Skip',{skipJob:job.id}]],[['Find connections',{command:`/leads ${job.id}`}]]],{ttl:7*86400000});
}
/** Per-role markers survive queue expiry. An ambiguous transmission is not repeated. */
export async function dispatchLinkedInJobAlerts(store,{now=Date.now,send=sendTelegram,buttons=linkedInJobButtons}={}){
 const snapshot=await getLinkedInAlertJobs(store,{now,limit:300}),prefs=await readNotificationPreferences(store),binding=await store.get('secrets','telegram');
 if(snapshot.delivery!=='alerts'||!snapshot.revision||!binding?.chatId||!notificationAllowed(prefs,'jobs','alerts'))return {sent:0,reason:'disabled'};
 let sent=0,uncertain=0,handled=0;
 for(const job of snapshot.jobs){
  // Backfill is visible in BRB; proactive alerts only announce recent mail.
  if(Date.parse(job.receivedAt)<now()-86400000||Date.parse(job.receivedAt)>now()+300000)continue;
  const previous=await store.get('linkedinJobDeliveries',job.id);
  if(previous&&previous.status!=='suppressed')continue;
  if(handled>=6)break;
  const replyMarkup=await buttons(store,job),marker={id:job.id,status:'sending',nonce:randomUUID(),startedAt:new Date(now()).toISOString()};
  if(!await store.compareAndSet('linkedinJobDeliveries',job.id,previous,marker))continue;
  handled++;
  try{
   const result=await send(store,linkedInAlertText(job),{replyMarkup,expectedChatId:String(binding.chatId),expectedTelegramLinkedAt:binding.linkedAt||'',notification:{channel:'alerts',topic:'jobs',...linkedInNotice(snapshot,[job])}});
   if(result?.suppressed){await store.compareAndSet('linkedinJobDeliveries',job.id,marker,{...marker,status:'suppressed',reason:result.reason});continue;}
   if(!Number.isSafeInteger(result?.result?.message_id)||result.result.message_id<=0)throw new Error('Telegram acceptance is unconfirmed.');
   await store.compareAndSet('linkedinJobDeliveries',job.id,marker,{...marker,status:'sent',sentAt:new Date(now()).toISOString(),providerId:result.result.message_id});sent++;
  }catch{
   await store.compareAndSet('linkedinJobDeliveries',job.id,marker,{...marker,status:'needs-review'});uncertain++;
  }
 }
 return {sent,uncertain};
}
