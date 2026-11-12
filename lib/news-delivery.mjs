import {listNews,getNewsSummary} from './news.mjs';
import {readNotificationPreferences,notificationAllowed} from './notification-preferences.mjs';
import {sendTelegram} from './integrations.mjs';

const MAX_AGE=72*3600000;
const clean=(value,max)=>String(value||'').replace(/\s+/g,' ').trim().slice(0,max);
const safeURL=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['wsj.com','www.wsj.com','pitchbook.com','www.pitchbook.com'].includes(u.hostname)?`${u.origin}${u.pathname}`:'';}catch{return '';}};
function recent(summary,now){const date=Date.parse(summary?.receivedAt||summary?.date||'');return Number.isFinite(date)&&date<=now+300000&&date>=now-MAX_AGE;}
export function newsAlertText(summary){
 const at=summary.receivedAt||summary.date,label=summary.receivedAt?'Received':'Unverified email date';
 const date=summary.receivedAt&&Number.isFinite(Date.parse(at))?`${new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(at))} · New York`:/^\d{4}-\d{2}-\d{2}$/.test(summary.date||'')?summary.date:'date unavailable';
 return [`${clean(summary.name,80)} · private news summary`,`${label} ${date}`,...(summary.bullets||[]).slice(0,3).map(bullet=>`• ${clean(bullet.text,400)}${safeURL(bullet.url)?`\n${safeURL(bullet.url)}`:''}`),'AI summary of your imported newsletter. Check source links or the original newsletter for full context.','/notifications news daily — morning briefing only\n/notifications news off — stop news messages'].join('\n\n').slice(0,3800);
}
/** A small durable outbox marker prevents retries/queue expiry from repeating an edition. */
export async function queueNewsAlerts(store,queue,{now=Date.now,list=listNews}={}){
 const at=now();if(!notificationAllowed(await readNotificationPreferences(store),'news','alerts')||(await store.get('settings','profile'))?.paused||!(await store.get('secrets','telegram'))?.chatId)return {queued:0};
 const news=await list(store,{now}),selected=new Set(news.settings?.sources||[]);let queued=0;
 for(const summary of (news.summaries||[]).slice(0,2)){
  if(!selected.has(summary.provider)||!recent(summary,at)||await store.get('newsAlerts',summary.id))continue;
  const job=await queue.enqueue(store.userId,'telegram-news-alert',{id:summary.id},{idempotencyKey:`newsletter:${summary.id}`,ttlMs:7*86400000,retrySafe:false,maxAttempts:1});
  await store.putIfAbsent('newsAlerts',summary.id,{id:summary.id,queuedAt:new Date(at).toISOString(),taskId:job.id});queued++;
 }
 for(const row of await store.all('newsAlerts'))if(Date.parse(row.queuedAt)<at-30*86400000)await store.delete('newsAlerts',row.id);
 return {queued};
}
export async function dispatchNewsAlert(store,{id}={}, {now=Date.now,get=getNewsSummary,send=sendTelegram}={}){
 if(typeof id!=='string'||id.length>200)return {accepted:false,reason:'invalid-summary'};
 const selection=await store.get('settings','news');
 const summary=await get(store,id,{now});
 if(!summary||!recent(summary,now()))return {accepted:false,reason:'unavailable-or-stale'};
 // Final shared delivery guard checks source consent as well as the news mode.
 const result=await send(store,newsAlertText(summary),{notification:{channel:'alerts',topic:'news',provider:summary.provider,newsSourceRevision:selection?.revision||null}});
 if(result?.suppressed)return {accepted:false,suppressed:true,reason:result.reason};
 if(!Number.isSafeInteger(result?.result?.message_id)||result.result.message_id<=0)throw new Error('Telegram acceptance is unconfirmed.');
 return {accepted:true};
}
