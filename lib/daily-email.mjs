import {personalCalendarRevisionMatches} from './personal-calendar.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {TZ,localISO} from './domain.mjs';
import {HttpError,isCornellEmail} from './security.mjs';
import {GMAIL_SEND_SCOPE,identityId} from './auth.mjs';
import {buildDailyBriefing,readDailyBriefingSettings} from './daily-briefing.mjs';
import {readNotificationPreferences,activeDailyTopics,notificationAllowed} from './notification-preferences.mjs';
import {jobPublication} from './job-recency.mjs';
import {jobMatchingFingerprint} from './job-discovery.mjs';
import {renderDailyEmail} from './daily-email-template.mjs';

const WINDOW_MS=2*3600000,BUCKET='dailyEmails',GRANT='dailyEmailGoogle';
const dayFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'});
const day=at=>dayFormatter.format(new Date(at));
function instant(value=Date.now){const raw=typeof value==='function'?value():value;const at=raw instanceof Date?raw.getTime():typeof raw==='number'?raw:Date.parse(raw);if(!Number.isFinite(at))throw new HttpError(400,'Use a valid email delivery time.');return at;}
const iso=at=>new Date(at).toISOString();
const target=(date,time)=>{try{return localISO(date,time);}catch{return null;}};
function requireStore(store){if(!store?.userId||typeof store.compareAndSet!=='function')throw new Error('Daily email requires an atomic student-owned store.');}
function validGrant(store,grant){return !!(grant?.connectionRevision&&typeof grant.subject==='string'&&identityId('google',grant.subject)===store.userId&&isCornellEmail(grant.email)&&String(grant.scope||'').split(/\s+/).includes(GMAIL_SEND_SCOPE)&&(grant.access_token||grant.refresh_token)&&!grant.disconnectedAt);}
const binding=grant=>grant?.connectionRevision||null;
async function replace(store,id,previous,next){return store.compareAndSet(BUCKET,id,previous,next);}
async function eligibility(store,{requested=false}={}){
 const [preference,profile,account,grant,notifications]=await Promise.all([readDailyBriefingSettings(store),store.get('settings','profile'),store.get('settings','account'),store.get('secrets',GRANT),readNotificationPreferences(store)]);
 const reason=account?.deleting?'account-deleting':profile?.paused?'paused':!validGrant(store,grant)?'gmail-not-connected':!requested&&(!preference.enabled||!preference.emailEnabled)?'email-disabled':!requested&&!notifications.enabled?'notifications-disabled':!activeDailyTopics(notifications,{ignoreMaster:requested}).length?'no-daily-topics':null;
 return {preference,profile,grant,notifications,reason};
}
function timeReason(marker,preference,at){if(day(at)!==marker.date)return 'not-current-day';if(marker.requested)return null;if(target(marker.date,preference.time)!==marker.scheduledAt)return 'settings-changed';if(at<Date.parse(marker.scheduledAt))return 'not-due';if(at-Date.parse(marker.scheduledAt)>WINDOW_MS)return 'outside-delivery-window';return null;}

async function schedule(store,queue,{now=Date.now,requested=false}={}){
 requireStore(store);const at=instant(now),date=day(at),state=await eligibility(store,{requested});
 if(state.reason)return {scheduled:false,reason:state.reason,date};
 const scheduledAt=requested?iso(at):target(date,state.preference.time);
 if(!scheduledAt)return {scheduled:false,reason:'daylight-saving-gap',date};
 if(!requested&&at<Date.parse(scheduledAt))return {scheduled:false,reason:'not-due',date};
 if(!requested&&at-Date.parse(scheduledAt)>WINDOW_MS)return {scheduled:false,reason:'outside-delivery-window',date};
 const id=`${requested?'preview':'daily'}:${date}`;
 for(let attempt=0;attempt<8;attempt++){
  const previous=await store.get(BUCKET,id);
  // A sending marker is deliberately terminal: Gmail may have accepted it even
  // if the process died before recording the response. Never blindly retry it.
  if(['sending','sent','needs-review','failed'].includes(previous?.status))return {scheduled:false,reason:'already-handled',date,status:previous.status};
  const same=previous?.connectionRevision===binding(state.grant)&&(requested||previous?.scheduledAt===scheduledAt);
  if(same&&['queued','skipped'].includes(previous?.status))return {scheduled:false,reason:'already-scheduled',date};
  const reserved=same&&previous?.status==='reserved'?previous:{id,date,requested,scheduledAt,connectionRevision:binding(state.grant),attemptId:randomUUID(),status:'reserved',createdAt:previous?.createdAt||iso(at),reservedAt:iso(at)};
  if(reserved!==previous&&!await replace(store,id,previous,reserved))continue;
  const payload={id,date,scheduledAt:reserved.scheduledAt,attemptId:reserved.attemptId,connectionRevision:reserved.connectionRevision};
  const job=await queue.enqueue(store.userId,requested?'daily-email-preview':'daily-email',payload,{idempotencyKey:`email:${reserved.attemptId}`,priority:20,retrySafe:false,maxAttempts:1,ttlMs:86400000});
  await replace(store,id,reserved,{...reserved,status:'queued',jobId:job.id,queuedAt:iso(at)});
  return {scheduled:true,date,jobId:job.id,taskId:job.id};
 }
 return {scheduled:false,reason:'concurrent-update',date};
}
export function scheduleDailyEmail(store,queue,options={}){return schedule(store,queue,{...options,requested:false});}
export async function scheduleDailyEmailPreview(store,queue,options={}){
 const result=await schedule(store,queue,{...options,requested:true});
 if(!result.scheduled){const messages={'already-handled':'An email was already attempted today. Check Gmail and delivery status before tomorrow’s preview.','already-scheduled':'Today’s preview email is already queued. Check its delivery status.','gmail-not-connected':'Connect Gmail delivery with your Cornell account first.',paused:'Resume your assistant before sending an email preview.','no-daily-topics':'Choose at least one daily topic before sending an email preview.','account-deleting':'Account deletion is in progress.'};throw new HttpError(409,messages[result.reason]||'Email preview could not be queued. Refresh and try again.',result.reason);}
 return result;
}

function notificationFor(briefing){return {topics:briefing.notificationTopics,revision:briefing.notificationRevision,newsSourceRevision:briefing.newsSourceRevision,personalCalendarRevision:briefing.personalCalendarRevision,...(briefing.emailJobNotification??briefing.jobNotification),...briefing.emailLinkedInNotification};}
async function currentReason(store,marker,notification,{now,assertAccess}={}){
 const at=instant(now),state=await eligibility(store,{requested:marker.requested});
 if(state.reason)return state.reason;
 if(binding(state.grant)!==marker.connectionRevision)return 'gmail-binding-changed';
 const timing=timeReason(marker,state.preference,at);if(timing)return timing;
 if(assertAccess&&!await assertAccess())return 'pilot-access-revoked';
 if(notification.revision!==state.notifications.revision||!Array.isArray(notification.topics)||!notification.topics.length||!notification.topics.every(topic=>notificationAllowed(state.notifications,topic,'daily',{ignoreMaster:marker.requested})))return 'notification-preferences';
 if(notification.requireCurrentMatching&&notification.matchingFingerprint!==await jobMatchingFingerprint(store,{now:at}))return 'job-matching-changed';
 if(notification.requireCurrentPublication){
  if(!Array.isArray(notification.jobs)||!notification.jobs.length||notification.jobs.length>10)return 'job-publication-missing';
  for(const item of notification.jobs){
   if(typeof item?.id!=='string'||item.id.length>200)return 'job-publication-missing';
   if(await (await import('./career-visibility.mjs')).isCareerJobRemoved(store,item.id))return 'job-removed';
   const job=await store.get('jobs',item.id),publication=jobPublication(job,{now:at});
   if(!job||job.closed||job.eligible===false||['closed','removed','cancelled','not-matching','dismissed'].includes(job.status)||!publication.eligible||publication.publishedAt!==item.publishedAt||publication.bucket!==item.bucket)return 'job-publication-changed';
  }
 }
 if(!await personalCalendarRevisionMatches(store,notification.personalCalendarRevision))return 'personal-calendars-changed';
 if(notification.topics.includes('news')&&notification.newsSourceRevision!==((await store.get('settings','news'))?.revision||null))return 'news-sources-changed';
 if(!await (await import('./linkedin-job-delivery.mjs')).linkedInNotificationMatches(store,notification.linkedinJobEmail,{now:()=>at}))return 'linkedin-job-alerts-changed';
 // Repeat inexpensive ownership/consent checks after the potentially slower
 // job reads, and again after token refresh immediately before Gmail's POST.
 const latest=await eligibility(store,{requested:marker.requested});
 if(latest.reason)return latest.reason;
 if(binding(latest.grant)!==marker.connectionRevision)return 'gmail-binding-changed';
 if(latest.notifications.revision!==notification.revision)return 'notification-preferences';
 if(assertAccess&&!await assertAccess())return 'pilot-access-revoked';
 return timeReason(marker,latest.preference,instant(now));
}

function mime(message,{email,userId,deliveryId,at}){
 if(!isCornellEmail(email)||typeof message?.subject!=='string'||/[\r\n]/.test(message.subject)||message.subject.length>180||typeof message.text!=='string'||typeof message.html!=='string')throw new Error('Invalid daily email content.');
 if(Buffer.byteLength(message.text)+Buffer.byteLength(message.html)>500000)throw new Error('Daily email is too large.');
 const hash=createHash('sha256').update(`${userId}:${deliveryId}`).digest('hex'),boundary=`brb_${hash.slice(0,40)}`;
 const body=value=>(Buffer.from(value,'utf8').toString('base64').match(/.{1,76}/g)||['']).join('\r\n');
 const subjectParts=[''];for(const character of message.subject){if(Buffer.byteLength(subjectParts.at(-1)+character)>30)subjectParts.push('');subjectParts[subjectParts.length-1]+=character;}
 const encodedSubject=subjectParts.map(value=>`=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`).join('\r\n ');
 return Buffer.from([`From: Big Red Buddy <${email}>`,`To: ${email}`,`Date: ${new Date(at).toUTCString()}`,`Message-ID: <${hash}@bigredbuddy.com>`,`Subject: ${encodedSubject}`,'MIME-Version: 1.0',`Content-Type: multipart/alternative; boundary="${boundary}"`,'',`--${boundary}`,'Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',body(message.text),`--${boundary}`,'Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: base64','',body(message.html),`--${boundary}--`,''].join('\r\n')).toString('base64url');
}

/** Internal transport. Recipient is always the verified owner of the send grant. */
export async function sendGmailDailyEmail(store,message,{expectedConnectionRevision,deliveryId,now=Date.now,assertCurrent=async()=>null,fetchImpl=fetch}={}){
 requireStore(store);
 let grant=await store.get('secrets',GRANT);
 if(!validGrant(store,grant)||binding(grant)!==expectedConnectionRevision)return {suppressed:true,reason:'gmail-binding-changed'};
 const check=async()=>{const latest=await store.get('secrets',GRANT);if(!validGrant(store,latest)||binding(latest)!==expectedConnectionRevision)return 'gmail-binding-changed';return assertCurrent();};
 let reason=await check();if(reason)return {suppressed:true,reason};
 if(!grant.access_token||!(grant.expiresAt>instant(now)+60000)){
  if(!grant.refresh_token||!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)return {failed:true,reason:'gmail-reconnect-required'};
  let response,tokens;
  try{response=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:grant.refresh_token,client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET}),signal:AbortSignal.timeout(20000)});tokens=await response.json();}catch{return {failed:true,reason:'gmail-refresh-failed'};}
  if(!response.ok||typeof tokens.access_token!=='string'||!tokens.access_token||!Number.isFinite(tokens.expires_in)||tokens.expires_in<=0)return {failed:true,reason:'gmail-reconnect-required'};
  if(tokens.scope&&!String(tokens.scope).split(/\s+/).includes(GMAIL_SEND_SCOPE))return {failed:true,reason:'gmail-reconnect-required'};
  const refreshed={...grant,access_token:tokens.access_token,expiresAt:instant(now)+tokens.expires_in*1000,...(tokens.refresh_token?{refresh_token:tokens.refresh_token}:{}),...(tokens.scope?{scope:tokens.scope}:{})};
  if(await store.compareAndSet('secrets',GRANT,grant,refreshed))grant=refreshed;
  else{grant=await store.get('secrets',GRANT);if(!validGrant(store,grant)||binding(grant)!==expectedConnectionRevision)return {suppressed:true,reason:'gmail-binding-changed'};if(!grant.access_token||!(grant.expiresAt>instant(now)+60000))return {failed:true,reason:'gmail-refresh-conflict'};}
 }
 reason=await check();if(reason)return {suppressed:true,reason};
 // No caller To, From, Reply-To, or raw MIME fields are accepted.
 const raw=mime(message,{email:grant.email,userId:store.userId,deliveryId,at:instant(now)});
 const response=await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',headers:{Authorization:`Bearer ${grant.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({raw}),signal:AbortSignal.timeout(25000)});
 const result=await response.json().catch(()=>({}));
 if(!response.ok){if(response.status>=400&&response.status<500)return {failed:true,reason:[401,403].includes(response.status)?'gmail-reconnect-required':'gmail-rejected'};throw new Error('Gmail acceptance is unconfirmed.');}
 if(typeof result.id!=='string'||!result.id||result.id.length>200)throw new Error('Gmail acceptance is unconfirmed.');
 return {id:result.id,accepted:true};
}

async function dispatch(store,payload,{now=Date.now,send=sendGmailDailyEmail,assertAccess,appOrigin=process.env.APP_ORIGIN,requested=false}={}){
 requireStore(store);const at=instant(now),{id,date,scheduledAt,attemptId,connectionRevision}=payload||{};
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||id!==`${requested?'preview':'daily'}:${date}`||!Number.isFinite(Date.parse(scheduledAt))||typeof attemptId!=='string'||typeof connectionRevision!=='string')throw new HttpError(400,'Invalid daily email schedule.');
 const marker=await store.get(BUCKET,id);
 if(!marker||marker.attemptId!==attemptId||marker.scheduledAt!==scheduledAt||marker.connectionRevision!==connectionRevision||marker.requested!==requested||!['reserved','queued'].includes(marker.status))return {sent:false,reason:'already-handled-or-superseded'};
 const state=await eligibility(store,{requested}),blocked=state.reason||binding(state.grant)!==connectionRevision&&'gmail-binding-changed'||timeReason(marker,state.preference,at);
 if(blocked){await replace(store,id,marker,{...marker,status:'skipped',reason:blocked,finishedAt:iso(at)});return {sent:false,reason:blocked};}
 let briefing=await buildDailyBriefing(store,{now:at,preferences:state.notifications});
 // Rebuild when a preference changes during extraction. Source-specific changes
 // are suppressed by the final guard instead of emitting an obsolete summary.
 for(let attempt=0;attempt<2;attempt++){const prefs=await readNotificationPreferences(store);if(prefs.revision===briefing.notificationRevision)break;briefing=await buildDailyBriefing(store,{now:instant(now),preferences:prefs});}
 const notification=notificationFor(briefing),guard=()=>currentReason(store,marker,notification,{now,assertAccess});
 const reason=await guard();if(reason){await replace(store,id,marker,{...marker,status:'skipped',reason,finishedAt:iso(instant(now))});return {sent:false,reason};}
 const message=renderDailyEmail(briefing,{name:state.profile?.name,appOrigin});
 let sending={...marker,status:'sending',sendingAt:iso(instant(now))};
 if(!await replace(store,id,marker,sending)){
  // The queue exposes a reserved attempt before its scheduler records queued.
  // That bookkeeping transition must not make the only worker lose the email.
  // Retry only this exact attempt's reserved -> queued transition; a competing
  // sender, changed binding, or replacement attempt must keep the send fence.
  const current=await store.get(BUCKET,id);
  const promoted=marker.status==='reserved'&&current?.status==='queued'&&['id','date','requested','scheduledAt','attemptId','connectionRevision'].every(key=>current[key]===marker[key]);
  if(!promoted)return {sent:false,reason:'concurrent-dispatch'};
  sending={...current,status:'sending',sendingAt:iso(instant(now))};
  if(!await replace(store,id,current,sending))return {sent:false,reason:'concurrent-dispatch'};
 }
 let result;
 try{
  const finalReason=await guard();
  result=finalReason?{suppressed:true,reason:finalReason}:await send(store,message,{expectedConnectionRevision:connectionRevision,deliveryId:marker.attemptId,now,assertCurrent:guard,notification});
 }catch{
  await replace(store,id,sending,{...sending,status:'needs-review',reason:'delivery-uncertain',failedAt:iso(instant(now))}).catch(()=>{});
  return {sent:false,reason:'delivery-uncertain'};
 }
 if(result?.suppressed||result?.failed){await replace(store,id,sending,{...sending,status:result.suppressed?'skipped':'failed',reason:result.reason||'gmail-rejected',finishedAt:iso(instant(now))});return {sent:false,reason:result.reason||'gmail-rejected'};}
 if(typeof result?.id!=='string'||!result.id){await replace(store,id,sending,{...sending,status:'needs-review',reason:'delivery-uncertain',failedAt:iso(instant(now))});return {sent:false,reason:'delivery-uncertain'};}
 // Provider acceptance is authoritative. Persistence errors after this point
 // cannot turn acceptance into a transport failure or trigger another send.
 const accepted={...sending,status:'sent',sentAt:iso(instant(now)),providerId:result.id,counts:briefing.counts,notificationRevision:briefing.notificationRevision};
 let recorded=false;for(let attempt=0;attempt<3&&!recorded;attempt++){try{recorded=await replace(store,id,sending,accepted);if(!recorded){const current=await store.get(BUCKET,id);recorded=current?.status==='sent'&&current.providerId===result.id;if(!recorded&&current?.attemptId!==attemptId)break;}}catch{}}
 return {sent:true,accepted:true,date,counts:briefing.counts,recorded};
}
export function dispatchDailyEmail(store,payload,options={}){return dispatch(store,payload,{...options,requested:false});}
export function dispatchDailyEmailPreview(store,payload,options={}){return dispatch(store,payload,{...options,requested:true});}

export async function getDailyEmailStatus(store){
 requireStore(store);const [grant,rows]=await Promise.all([store.get('secrets',GRANT),store.all(BUCKET)]),connected=validGrant(store,grant);
 const owned=rows.filter(row=>row.connectionRevision===binding(grant)),lastSentAt=owned.filter(row=>row.status==='sent'&&row.sentAt).map(row=>row.sentAt).sort().at(-1)||null;
 const latest=owned.sort((a,b)=>String(b.sentAt||b.sendingAt||b.queuedAt||b.reservedAt||'').localeCompare(String(a.sentAt||a.sendingAt||a.queuedAt||a.reservedAt||'')))[0];
 return {connected,accountEmail:connected?grant.email:null,lastStatus:latest?.status==='sending'?'needs-review':latest?.status||null,lastSentAt,lastDate:latest?.date||null,lastReason:latest?.status==='sending'?'delivery-uncertain':latest?.reason||null,lastError:['failed','needs-review','sending'].includes(latest?.status)?'Email delivery needs attention. Check Gmail before requesting another send.':null};
}
export async function disconnectDailyEmail(store,{now=Date.now}={}){
 requireStore(store);for(let attempt=0;attempt<12;attempt++){const previous=await store.get('secrets',GRANT),tombstone={connectionRevision:randomUUID(),disconnectedAt:iso(instant(now))};if(await store.compareAndSet('secrets',GRANT,previous,tombstone))return {connected:false};}
 throw new HttpError(409,'Gmail delivery changed concurrently. Try disconnecting again.');
}
