import {readLinkedInConnections,LINKEDIN_REFRESH_DAYS} from './linkedin-connections.mjs';
import {readNotificationPreferences,notificationAllowed} from './notification-preferences.mjs';
import {sendTelegram} from './integrations.mjs';
import {idFor} from './domain.mjs';
const DAY=86400000;
async function eligible(store,now){
 const metadata=await readLinkedInConnections(store,{now}),preferences=await readNotificationPreferences(store);
 if(!metadata.connected||!LINKEDIN_REFRESH_DAYS.includes(metadata.refreshDays)||!metadata.refreshDue)return {reason:'not-due'};
 if(!notificationAllowed(preferences,'jobs','alerts')||(await store.get('settings','profile'))?.paused||!(await store.get('secrets','telegram'))?.chatId)return {reason:'delivery-disabled'};
 const due=Date.parse(metadata.nextRefreshAt);if(!Number.isFinite(due)||now<due)return {reason:'not-due'};
 const period=Math.floor((now-due)/(metadata.refreshDays*DAY)),key=idFor('linkedin-refresh',metadata.version,period);
 return {metadata,period,key};
}
export async function scheduleLinkedInRefresh(store,queue,{now=Date.now()}={}){
 const current=await eligible(store,now);if(current.reason)return {scheduled:false,reason:current.reason};
 const {metadata,period,key}=current,previous=await store.get('settings','linkedinRefreshReminder');
 if(previous?.key===key&&previous.status!=='reserved')return {scheduled:false,reason:'already-handled'};
 const marker=previous?.key===key?previous:{key,status:'reserved',version:metadata.version,sourceVersion:metadata.sourceVersion,period,createdAt:new Date(now).toISOString()};
 if(previous?.key!==key&&!await store.compareAndSet('settings','linkedinRefreshReminder',previous,marker))return {scheduled:false,reason:'concurrent-schedule'};
 const job=await queue.enqueue(store.userId,'linkedin-refresh-reminder',{key,version:metadata.version,sourceVersion:metadata.sourceVersion,period},{idempotencyKey:`linkedin-refresh:${key}`,ttlMs:7*DAY,retrySafe:false,maxAttempts:1,priority:0});
 await store.compareAndSet('settings','linkedinRefreshReminder',marker,{...marker,status:'queued',jobId:job.id});return {scheduled:true};
}
export async function dispatchLinkedInRefresh(store,payload,{now=Date.now(),send=sendTelegram}={}){
 const current=await eligible(store,now),marker=await store.get('settings','linkedinRefreshReminder');
 if(current.reason||!marker||!['reserved','queued'].includes(marker.status)||current.key!==payload.key||marker.key!==payload.key||current.metadata.version!==payload.version||current.metadata.sourceVersion!==payload.sourceVersion)return {sent:false,reason:'not-current'};
 const sending={...marker,status:'sending',at:new Date(now).toISOString()};if(!await store.compareAndSet('settings','linkedinRefreshReminder',marker,sending))return {sent:false,reason:'concurrent-dispatch'};
 try{
  const text=`Your optional LinkedIn export refresh reminder\n\nYour connection list was uploaded on ${current.metadata.importedAt.slice(0,10)}. Download a current archive in LinkedIn’s Data privacy settings, then upload Connections.csv in Career Studio: ${process.env.APP_ORIGIN||'http://127.0.0.1:4318'}/#careers\n\nBRF checks the uploaded company names for possible warm introductions. It does not log in to LinkedIn, download connections automatically, or message contacts. You can change or turn off these reminders in Career Studio.`;
  const result=await send(store,text,{notification:{channel:'alerts',topic:'jobs',linkedinRefreshVersion:current.metadata.version}});
  const suppressed=result?.suppressed;if(!suppressed&&(!Number.isSafeInteger(result?.result?.message_id)||result.result.message_id<=0))throw new Error('Delivery unconfirmed');
  await store.compareAndSet('settings','linkedinRefreshReminder',sending,{...sending,status:suppressed?'suppressed':'sent',at:new Date(now).toISOString()});return {sent:!suppressed};
 }catch{await store.compareAndSet('settings','linkedinRefreshReminder',sending,{...sending,status:'needs-review'});return {sent:false,reason:'delivery-uncertain'};}
}
