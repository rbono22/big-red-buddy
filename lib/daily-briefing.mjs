import {TZ,localISO} from './domain.mjs';
import {HttpError} from './security.mjs';
import {sendTelegram} from './integrations.mjs';
import {aggregateEventHub} from './event-hub.mjs';
import {readNotificationPreferences,activeDailyTopics} from './notification-preferences.mjs';
import {recentJobGroups} from './job-recency.mjs';
import {postedLabel,publicationNotice,WARM_LEAD_TIP} from './job-messages.mjs';
import {jobMatchingFingerprint} from './job-discovery.mjs';

export const DEFAULT_DAILY_BRIEFING_SETTINGS=Object.freeze({enabled:true,time:'08:00',timezone:TZ,telegramEnabled:true,emailEnabled:false});
const WINDOW_MS=2*3600000;
const compact=(value,max=100)=>String(value||'').replace(/<[^>]*>/g,' ').replace(/&[a-zA-Z#0-9]+;/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const excerpt=(value,max)=>{const plain=compact(value,10000);return plain.length<=max?plain:`${plain.slice(0,max-1).replace(/\s+\S*$/,'')}…`;};
function instant(value=Date.now){const raw=typeof value==='function'?value():value;const ms=raw instanceof Date?raw.getTime():typeof raw==='number'?raw:Date.parse(raw);if(!Number.isFinite(ms))throw new HttpError(400,'Use a valid briefing date.');return ms;}
const dayFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'});
const timeFormatter=new Intl.DateTimeFormat('en-US',{timeZone:TZ,hour:'numeric',minute:'2-digit'});
const localDay=ms=>dayFormatter.format(new Date(ms));
const eventDay=event=>Number.isFinite(Date.parse(event.start))?localDay(Date.parse(event.start)):event.date;
const eventTime=event=>event.allDay?'All day':Number.isFinite(Date.parse(event.start))?timeFormatter.format(new Date(event.start)):'Time not published';
const safeLink=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&url.href.length<=500?url.href:'';}catch{return '';}};
const nextDate=date=>new Date(Date.parse(`${date}T12:00:00Z`)+86400000).toISOString().slice(0,10);
function overlapsDay(event,date,dayStart,dayEnd){
  if(event.allDay){
    try{localISO(event.date);const endDate=event.endDate||nextDate(event.date);localISO(endDate);return event.date<=date&&date<endDate;}catch{return false;}
  }
  const start=Date.parse(event.start),end=Date.parse(event.end);
  return Number.isFinite(start)&&Number.isFinite(end)&&end>start?start<dayEnd&&end>dayStart:eventDay(event)===date;
}
function opportunityTime(event,date,dayStart,at){
  const startedEarlier=event.allDay?event.date<date:Date.parse(event.start)<dayStart;
  if(!startedEarlier)return eventTime(event);
  if(event.allDay)return 'Ongoing · all day';
  const end=Date.parse(event.end);if(!Number.isFinite(end))return 'Ongoing · end time not published';
  const when=localDay(end)===date?timeFormatter.format(new Date(end)):new Intl.DateTimeFormat('en-US',{timeZone:TZ,month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(end));
  return end<=at?`Ended today at ${when}`:`Ongoing · ends ${when}`;
}

function settings(raw={}){
  return {enabled:typeof raw.enabled==='boolean'?raw.enabled:true,time:typeof raw.time==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.time)?raw.time:'08:00',timezone:TZ,telegramEnabled:raw.telegramEnabled!==false,emailEnabled:raw.emailEnabled===true,updatedAt:typeof raw.updatedAt==='string'?raw.updatedAt:null};
}
export async function readDailyBriefingSettings(store){return settings((await store.get('settings','dailyBriefing'))||{});}
export async function saveDailyBriefingSettings(store,patch,{expectedPrevious}={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(key=>!['enabled','time','telegramEnabled','emailEnabled'].includes(key)))throw new HttpError(400,'Update daily briefing delivery choices or time only.');
  if(['enabled','telegramEnabled','emailEnabled'].some(key=>key in patch&&typeof patch[key]!=='boolean')||('time'in patch&&(typeof patch.time!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(patch.time))))throw new HttpError(400,'Choose delivery on/off and a New York time in HH:mm format.');
  for(let attempt=0;attempt<8;attempt++){
    const previous=await store.get('settings','dailyBriefing'),next={...settings(previous||{}),...patch,updatedAt:new Date().toISOString(),revision:(previous?.revision||0)+1};
    if(expectedPrevious!==undefined&&JSON.stringify(previous)!==JSON.stringify(expectedPrevious))throw new HttpError(409,'Your briefing choices changed. Review a new proposal.');
    if(store.compareAndSet){if(!await store.compareAndSet('settings','dailyBriefing',previous,next))continue;}else await store.put('settings','dailyBriefing',next);
    return settings(next);
  }
  throw new HttpError(409,'Daily briefing settings changed concurrently. Please retry.');
}

export async function buildDailyBriefing(store,{now=Date.now,preferences,readNews}={}){
  const at=instant(now),date=localDay(at),dayStart=Date.parse(localISO(date)),dayEnd=Date.parse(localISO(nextDate(date)));
  const notifications=preferences||await readNotificationPreferences(store),topics=activeDailyTopics(notifications,{ignoreMaster:true});
  const schoolOn=topics.includes('school'),eventsOn=topics.includes('events'),jobsOn=topics.includes('jobs'),newsOn=topics.includes('news');
  const matchingFingerprint=jobsOn?await jobMatchingFingerprint(store,{now:at}):null;
  const [events,campus,jobs,sources,campusHealth,jobsHealth,slackHealth,slackConnection,jobBoards,partiful,partifulHealth,luma,lumaHealth]=await Promise.all([
    store.all('events'),store.all('campusEvents'),store.all('jobs'),store.all('sources'),store.get('settings','campusCalendar'),store.get('settings','jobsHealth'),store.get('settings','slackHealth'),store.get('secrets','slack'),store.get('settings','jobBoards'),store.all('partifulEvents'),store.get('settings','partifulCalendar'),store.all('lumaEvents'),store.get('settings','lumaCalendar')
  ]);
  const today=events.filter(event=>!event.cancelled&&eventDay(event)===date),approved=today.filter(event=>event.status==='approved'&&Number.isFinite(Date.parse(event.start))).sort((a,b)=>a.start.localeCompare(b.start));
  const classes=schoolOn?approved.filter(event=>event.kind==='class'):[],deadlines=schoolOn?approved.filter(event=>['assignment','quiz','exam','studio'].includes(event.kind)):[];
  const declinedSocialIds=new Set([...partiful,...luma].filter(event=>event.localIntent==='declined').map(event=>event.addedEventId).filter(Boolean));
  const reviewedEvents=events.filter(event=>!event.cancelled&&!event.academicCandidateId&&event.connector!=='academic'&&!declinedSocialIds.has(event.id)&&event.status==='approved'&&event.kind==='event'&&Number.isFinite(Date.parse(event.start))&&overlapsDay(event,date,dayStart,dayEnd));
  const campusCandidates=campus.filter(event=>campusHealth?.calendarId&&event.status==='available'&&event.sourceCalendarId===campusHealth.calendarId&&overlapsDay(event,date,dayStart,dayEnd));
  const partifulCandidates=partiful.filter(event=>partifulHealth?.calendarId&&event.status==='available'&&event.localIntent!=='declined'&&event.sourceCalendarId===partifulHealth.calendarId&&overlapsDay(event,date,dayStart,dayEnd));
  const lumaCandidates=luma.filter(event=>lumaHealth?.calendarId&&event.status==='available'&&event.localIntent!=='declined'&&event.sourceCalendarId===lumaHealth.calendarId&&overlapsDay(event,date,dayStart,dayEnd)).map(event=>({...event,lumaCandidateId:event.id}));
  const addedIds=new Set(reviewedEvents.map(event=>event.id));
  const needsReview=rows=>rows.map(event=>event.addedEventId&&!addedIds.has(event.addedEventId)?{...event,status:'review'}:event);
  const opportunities=eventsOn?aggregateEventHub({events:reviewedEvents,campus:needsReview(campusCandidates),partiful:needsReview(partifulCandidates),luma:needsReview(lumaCandidates),campusCalendar:campusHealth,partifulCalendar:partifulHealth,lumaCalendar:lumaHealth,now:at}).items.filter(event=>!['cancelled','dismissed'].includes(event.status)).map(event=>({...event,rsvpUrl:event.registrationUrl,lumaCandidateId:event.sources.some(source=>source.kind==='luma')?'luma':null,briefingStatus:event.status==='added'?(event.googleId?'On Google Calendar':'In your BRB schedule'):event.status==='review'?'Added item needs calendar review':'Available; not on your calendar'})):[];
  const academic=schoolOn?(await store.all('academicEvents')).filter(event=>!event.cancelled&&event.status!=='cancelled'&&overlapsDay(event,date,dayStart,dayEnd)).sort((a,b)=>(a.start||a.date||'').localeCompare(b.start||b.date||'')):[];
  const academicHealth=await store.get('settings','academicCalendar'),emailHealth=await store.get('settings','eventEmail');
  const awaiting=today.filter(event=>(event.kind==='event'&&!event.academicCandidateId&&event.connector!=='academic'?eventsOn:schoolOn)&&(event.status==='review'||(event.status==='approved'&&!event.allDay&&!Number.isFinite(Date.parse(event.start)))));
  const jobGroups=recentJobGroups(jobsOn?jobs:[],{now:at}),freshJobs=[...jobGroups.last24Hours,...jobGroups.pastWeek];
  const coverage=[];
  const alertsHealth=jobsOn?await store.get('settings','jobAlertsHealth'):null;
  if(alertsHealth?.pendingAlerts>0)coverage.push(`Job alerts: ${alertsHealth.pendingAlerts} recent matches pending; queued digests process up to ten at a time.`);
  if(['retry-pending','needs_review'].includes(alertsHealth?.alerts))coverage.push('Job alert delivery needs attention; browse recent results in Career Studio.');
  if(jobsOn)coverage.push(`Job selection: only source-dated postings from the past seven days, newest first. Unknown publication dates are excluded. ${WARM_LEAD_TIP}`);
  if(schoolOn&&academicHealth)coverage.push(`Academic dates: Cornell University Registrar; your program may differ. ${academicHealth.lastError||!Number.isFinite(Date.parse(academicHealth.lastSuccess))||at-Date.parse(academicHealth.lastSuccess)>2*86400000?'Refresh is missing or stale; check the official calendar.':'All-day dates have no timed reminder.'}`);
  if(eventsOn&&emailHealth?.labelId)coverage.push(`Email: selected label only; ${!emailHealth.continuous?'saved snapshot; refresh disconnected.':emailHealth.lastError||!Number.isFinite(Date.parse(emailHealth.lastSuccess))||at-Date.parse(emailHealth.lastSuccess)>86400000?'refresh is missing or stale.':'extracted events require review.'}${emailHealth.lastScan?.truncated||emailHealth.lastScan?.backlog?' Some messages remain unprocessed.':''}`);
  if(schoolOn)coverage.push(!sources.length?'Schedule: no source coverage recorded; only imported entries are shown.':'Schedule: imported sources only; later changes may be missing.');
  const campusAge=at-Date.parse(campusHealth?.lastSuccess||'');
  if(eventsOn){if(!campusHealth?.calendarId)coverage.push('Campus: no selected event calendar.');
  else if(!campusHealth.continuous)coverage.push('Campus: saved snapshot; continuous refresh is not connected.');
  else if(!Number.isFinite(campusAge)||campusAge>86400000||campusHealth.lastError)coverage.push('Campus: refresh is missing or stale; check the original calendar.');
  if(campusHealth?.autoAddWarning)coverage.push(`Campus additions: ${compact(campusHealth.autoAddWarning,180)}`);}
  if(eventsOn&&partifulHealth?.calendarId){
    const partifulAge=at-Date.parse(partifulHealth.lastSuccess||'');
    coverage.push(`Partiful: ${!partifulHealth.continuous?'saved snapshot; refresh disconnected.':!Number.isFinite(partifulAge)||partifulAge>86400000||partifulHealth.lastError?'refresh is missing or stale.':'Google subscription may lag about 24 hours.'} RSVP on Partiful.`);
  }
  if(eventsOn&&lumaHealth?.calendarId){
    const lumaAge=at-Date.parse(lumaHealth.lastSuccess||'');
    coverage.push(`Luma: ${!lumaHealth.continuous?'saved snapshot; refresh disconnected.':!Number.isFinite(lumaAge)||lumaAge>86400000||lumaHealth.lastError?'refresh is missing or stale.':'Google subscription may lag 12–24 hours.'} Check registration, approval, and tickets on Luma; feed entries may be pending or waitlisted.`);
  }
  const boards=jobBoards?.boards||jobsHealth?.boards||[];
  if(jobsOn){if(!boards.length&&!jobs.length)coverage.push('Jobs: no employer sources are configured.');
  else{
    const issues=[];
    if(boards.some(board=>board.errorMessage||board.lastStatus==='error'))issues.push('source errors');
    if(boards.some(board=>board.truncated||board.lastStatus==='partial'))issues.push('partial results');
    if(boards.length?boards.some(board=>!Number.isFinite(Date.parse(board.lastSuccess))||at-Date.parse(board.lastSuccess)>86400000):!Number.isFinite(Date.parse(jobsHealth?.lastSuccess))||at-Date.parse(jobsHealth.lastSuccess)>86400000)issues.push('refresh missing or older than 24 hours');
    if(boards.some(board=>board.pendingAlerts>0))issues.push('notifications pending');
    if(issues.length)coverage.push(`Jobs: ${issues.join('; ')}.`);
  }}
  if(schoolOn){if(!slackConnection?.channel)coverage.push('Product Studio: Slack is not connected.');
  else if(!Number.isFinite(Date.parse(slackHealth?.lastSuccess))||at-Date.parse(slackHealth.lastSuccess)>86400000)coverage.push('Product Studio: Slack refresh is missing or stale.');}
  const news=[];let newsSourceRevision=null;
  if(newsOn){
    try{
      // Source consent has its own revision. Delivery checks this snapshot too,
      // so deselecting a publisher cannot leave its queued summary deliverable.
      newsSourceRevision=(await store.get('settings','news'))?.revision||null;
      const cache=await (readNews||((ownedStore)=>import('./news.mjs').then(module=>module.listNews(ownedStore,{now:()=>at}))))(store);
      const selected=(cache.providers||[]).filter(provider=>provider.selected).slice(0,2);
      if(!selected.length)coverage.push('News: no newsletter sources selected. Choose sources before expecting summaries.');
      for(const provider of selected){
        const summary=provider.latest;
        if(!summary){coverage.push(`News · ${compact(provider.name,55)}: no cached summary available yet.`);continue;}
        const sourceAt=Date.parse(summary.receivedAt||summary.date||''),stale=!Number.isFinite(sourceAt)||sourceAt>at||at-sourceAt>48*3600000||provider.freshness==='stale';
        const dated=Number.isFinite(sourceAt)?new Date(sourceAt).toISOString().slice(0,10):null;
        const dateLabel=dated?(summary.receivedAt?`received ${dated}`:`unverified email-header date ${dated}`):(summary.source?.kind==='manual'?'undated manual excerpt':'source date unknown');
        const bullets=(summary.bullets||[]).filter(bullet=>typeof bullet.text==='string'&&compact(bullet.text)).slice(0,3);
        if(!bullets.length){coverage.push(`News · ${compact(provider.name,55)}: cached summary has no usable summary text.`);continue;}
        const missingLinks=bullets.some(bullet=>!safeLink(bullet.url)),header=`${compact(provider.name||summary.name,65)} · ${dateLabel}${stale?' · stale or undated cache; check source':''}`;
        // Keep a supported item from each publisher even on a crowded day.
        // Prefer an item with a direct link; never truncate the URL itself.
        const lead=bullets.find(bullet=>safeLink(bullet.url))||bullets[0],leadLink=safeLink(lead.url);
        news.push({id:summary.id,text:`${header}\n${bullets.map(bullet=>`${compact(bullet.text,250)}${safeLink(bullet.url)?`\n${safeLink(bullet.url)}`:''}`).join('\n\n')}${missingLinks?'\nSome article links are unavailable; open the original newsletter.':''}`,compactText:`${header}\n${excerpt(lead.text,150)}${leadLink?`\n${leadLink}`:'\nArticle link unavailable; open the newsletter.'}\nMore newsletter detail in Big Red Buddy.`});
      }
      if(cache.mailbox?.lastError||cache.mailbox?.continuous&&!cache.mailbox?.lastSuccess)coverage.push('News: mailbox refresh is missing or failed; cached summaries may be incomplete.');
      coverage.push('News summaries paraphrase received or imported newsletters. Received and email-header dates are not publication dates. Sender-domain matching does not authenticate the sender.');
    }catch{coverage.push('News: cached summaries are unavailable. No live generation was started for this briefing.');}
  }
  const item=(event,when=eventTime(event))=>`${when} · ${compact(event.title,88)}\n${compact(event.location,65)||'Location not published'}`;
  const jobItem=job=>`${compact(job.title,75)} · ${compact(job.company,45)}${job.location?` · ${compact(job.location,50)}`:''}\n${postedLabel(job)}\n/apply ${compact(job.id,200)}${safeLink(job.applyUrl||job.url)?`\n${safeLink(job.applyUrl||job.url)}`:''}`;
  const sections=[
    {enabled:schoolOn,title:'Classes today',all:classes,items:classes.slice(0,5).map(event=>item(event)),empty:'No approved timed classes imported for today.'},
    {enabled:schoolOn,title:'Due today',all:deadlines,items:deadlines.slice(0,5).map(event=>item(event)),empty:'No approved timed deadlines imported for today.'},
    {enabled:schoolOn,title:'Holidays and academic dates',all:academic,items:academic.slice(0,3).map(event=>`${opportunityTime(event,date,dayStart,at)} · ${compact(event.title,110)}`),empty:''},
    {enabled:eventsOn,title:'Campus and calendar events',all:opportunities,items:opportunities.slice(0,3).map(event=>`${item(event,opportunityTime(event,date,dayStart,at))} · ${event.briefingStatus}${event.lumaCandidateId?' · Luma registration/ticket not verified':''}${safeLink(event.rsvpUrl||event.sourceUrl)?`\n${safeLink(event.rsvpUrl||event.sourceUrl)}`:''}`),empty:'No event entries available for today.'},
    {enabled:jobsOn,title:'Jobs posted in the past 24 hours',all:jobGroups.last24Hours,sourceJobs:jobGroups.last24Hours,items:jobGroups.last24Hours.slice(0,2).map(jobItem),empty:'No matching roles with confirmed publication times in the past 24 hours.'},
    {enabled:jobsOn,title:'Jobs posted 1–7 days ago',all:jobGroups.pastWeek,sourceJobs:jobGroups.pastWeek,items:jobGroups.pastWeek.slice(0,2).map(jobItem),empty:'No additional matching postings from the past week.'},
    {enabled:newsOn,title:'Selected newsletter summaries',all:news,items:news.map(summary=>summary.text),compactItems:news.map(summary=>summary.compactText),pinned:true,empty:'No cached selected newsletter summaries are available.'},
    {title:'Awaiting your review',all:awaiting,items:awaiting.slice(0,3).map(event=>`${compact(event.title,90)} · ${Number.isFinite(Date.parse(event.start))?eventTime(event):'time needs confirmation'}\n${compact(event.location,65)||'Location not published'}`),empty:''}
  ];
  const emailKeys=['classes','deadlines','academic','events','jobs24h','jobsWeek','news','review'];
  const emailSections=sections.map((section,index)=>({...section,sectionKey:emailKeys[index]})).filter(section=>section.enabled!==false).map(section=>({sectionKey:section.sectionKey,title:section.title,items:[...section.items],empty:section.empty,total:section.all.length}));
  const emailJobs=sections.filter(section=>section.enabled!==false&&section.sourceJobs).flatMap(section=>section.sourceJobs.slice(0,section.items.length));
  const emailJobNotification=emailJobs.length?{...publicationNotice(emailJobs,{now:at}),requireCurrentMatching:true,matchingFingerprint}:null;
  const heading=`Your day · ${date} · New York${!notifications.enabled?'\nProactive delivery is off; this is a requested preview.':''}${!topics.length?'\nNo available daily topics selected. Use /notifications to choose your topics.':''}`;
  let displayedCoverage=coverage,coverageShortened=false;
  const render=()=>[heading,...sections.filter(section=>section.enabled!==false&&(section.all.length||section.items.length||section.empty)).map(section=>`${section.title}\n${section.items.length?section.items.join('\n\n'):section.all.length?'':section.empty}${section.all.length>section.items.length?`${section.items.length?'\n':''}+ ${section.all.length-section.items.length} more in Big Red Buddy.`:''}`),`Coverage${coverageShortened?' excerpts; full status in Big Red Buddy.':''}\n${displayedCoverage.join('\n')}\nCheck original sources for changes. /notifications controls topics. /briefing controls daily delivery.`].join('\n\n');
  let text=render();
  if(text.length>3800){for(const section of sections)if(section.compactItems)section.items=section.compactItems;text=render();}
  // Reduce overrepresented sections first, preserving one entry per section
  // where space permits. Selected publishers remain pinned throughout.
  while(text.length>3800){const section=sections.filter(section=>section.enabled!==false&&!section.pinned&&section.items.length>1).sort((a,b)=>b.items.length-a.items.length||b.items.join('').length-a.items.join('').length)[0];if(!section)break;section.items.pop();text=render();}
  for(const limit of [120,90,65]){if(text.length<=3800)break;displayedCoverage=coverage.map(line=>excerpt(line,limit));coverageShortened=displayedCoverage.some((line,index)=>line!==coverage[index]);text=render();}
  while(text.length>3800){const section=sections.filter(section=>section.enabled!==false&&!section.pinned&&section.items.length).sort((a,b)=>b.items.join('').length-a.items.join('').length)[0];if(!section)break;section.items.pop();text=render();}
  const shownJobs=sections.filter(section=>section.sourceJobs).flatMap(section=>section.sourceJobs.slice(0,section.items.length));
  return {date,timezone:TZ,text,emailSections,emailJobNotification,counts:{classes:classes.length,deadlines:deadlines.length,events:opportunities.length,jobs:freshJobs.length,awaitingReview:awaiting.length,news:news.length},coverage,notificationTopics:topics,notificationRevision:notifications.revision,newsSourceRevision,jobNotification:shownJobs.length?{...publicationNotice(shownJobs,{now:at}),requireCurrentMatching:true,matchingFingerprint}:null};
}

export function briefingNotification(briefing,channel='daily'){return {channel,topics:briefing.notificationTopics,revision:briefing.notificationRevision,newsSourceRevision:briefing.newsSourceRevision,...briefing.jobNotification};}

async function replace(store,date,previous,next){if(store.compareAndSet)return store.compareAndSet('dailyBriefings',date,previous,next);await store.put('dailyBriefings',date,next);return true;}
async function eligible(store){const [preference,profile,telegram,notifications]=await Promise.all([readDailyBriefingSettings(store),store.get('settings','profile'),store.get('secrets','telegram'),readNotificationPreferences(store)]);return {preference,notifications,reason:!preference.enabled?'disabled':!preference.telegramEnabled?'telegram-disabled':profile?.paused?'paused':!telegram?.chatId?'telegram-not-linked':!notifications.enabled?'notifications-disabled':!activeDailyTopics(notifications).length?'no-daily-topics':null};}
function target(date,time){try{return localISO(date,time);}catch{return null;}}

export async function scheduleDailyBriefing(store,queue,{now=Date.now}={}){
  const at=instant(now),date=localDay(at),{preference,reason}=await eligible(store);if(reason)return {scheduled:false,reason,date};
  const scheduledAt=target(date,preference.time);if(!scheduledAt)return {scheduled:false,reason:'daylight-saving-gap',date};
  const lateness=at-Date.parse(scheduledAt);if(lateness<0)return {scheduled:false,reason:'not-due',date};if(lateness>WINDOW_MS)return {scheduled:false,reason:'outside-delivery-window',date};
  if(!store.userId)throw new Error('Daily briefing scheduling requires a student-owned store.');
  for(let attempt=0;attempt<8;attempt++){
    const previous=await store.get('dailyBriefings',date);
    if(['sending','sent','needs-review'].includes(previous?.status))return {scheduled:false,reason:'already-handled',date};
    if(previous?.scheduledAt===scheduledAt&&['queued','skipped'].includes(previous.status))return {scheduled:false,reason:'already-scheduled',date};
    const reserved={id:date,date,scheduledAt,status:'reserved',createdAt:previous?.createdAt||new Date(at).toISOString(),reservedAt:new Date(at).toISOString()};
    if(!await replace(store,date,previous,reserved))continue;
    // Reservation survives queue TTL. Retrying an uncertain enqueue uses the same
    // queue key; delivery itself is fenced by the persistent student/day record.
    const job=await queue.enqueue(store.userId,'daily-briefing',{date,scheduledAt},{idempotencyKey:`daily:${date}:${preference.time}`,priority:20,retrySafe:false,maxAttempts:1,ttlMs:86400000});
    await replace(store,date,reserved,{...reserved,status:'queued',jobId:job.id,queuedAt:new Date(at).toISOString()});
    return {scheduled:true,date,jobId:job.id};
  }
  return {scheduled:false,reason:'concurrent-update',date};
}

export async function dispatchDailyBriefing(store,{date,scheduledAt}={}, {now=Date.now,send=sendTelegram}={}){
  const at=instant(now);if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(scheduledAt)))throw new HttpError(400,'Invalid daily briefing schedule.');
  const marker=await store.get('dailyBriefings',date);
  if(!marker||marker.scheduledAt!==scheduledAt||!['reserved','queued'].includes(marker.status))return {sent:false,reason:'already-handled-or-superseded'};
  const {preference,notifications,reason}=await eligible(store),currentTarget=target(date,preference.time);
  if(currentTarget!==scheduledAt){await replace(store,date,marker,{...marker,status:'superseded'});return {sent:false,reason:'settings-changed'};}
  const blocked=localDay(at)!==date?'not-current-day':at<Date.parse(scheduledAt)?'not-due':at-Date.parse(scheduledAt)>WINDOW_MS?'outside-delivery-window':null;
  if(reason||blocked){await replace(store,date,marker,{...marker,status:'skipped',reason:reason||blocked,finishedAt:new Date(at).toISOString()});return {sent:false,reason:reason||blocked};}
  let briefing=await buildDailyBriefing(store,{now:at,preferences:notifications});
  // Mark before transmission. A crash or uncertain Telegram response must never
  // automatically repeat a message, even after the queue row expires.
  const sending={...marker,status:'sending',sendingAt:new Date(instant(now)).toISOString()};if(!await replace(store,date,marker,sending))return {sent:false,reason:'concurrent-dispatch'};
  for(let attempt=0;attempt<3;attempt++){
    const latest=await eligible(store);if(latest.reason||target(date,latest.preference.time)!==scheduledAt){await replace(store,date,sending,{...sending,status:'skipped',reason:latest.reason||'settings-changed'});return {sent:false,reason:latest.reason||'settings-changed'};}
    if(latest.notifications.revision!==briefing.notificationRevision){briefing=await buildDailyBriefing(store,{now:instant(now),preferences:latest.notifications});continue;}
    const sendAt=instant(now);if(localDay(sendAt)!==date||sendAt-Date.parse(scheduledAt)>WINDOW_MS){await replace(store,date,sending,{...sending,status:'skipped',reason:'outside-delivery-window'});return {sent:false,reason:'outside-delivery-window'};}
    try{
      const {menuMarkup}=await import('./telegram-menu.mjs');
      const replyMarkup=await menuMarkup(store,[[['My day',{page:'day'}],['Jobs',{page:'jobs'}]],[['Events',{page:'events'}],['Settings',{page:'settings'}]]]);
      const result=await send(store,briefing.text,{notification:briefingNotification(briefing),replyMarkup});
      if(result?.suppressed){await replace(store,date,sending,{...sending,status:'skipped',reason:result.reason||'notification-preferences',finishedAt:new Date(instant(now)).toISOString()});return {sent:false,reason:result.reason||'notification-preferences'};}
      if(!Number.isSafeInteger(result?.result?.message_id)||result.result.message_id<=0)throw new Error('Telegram acceptance is unconfirmed.');await replace(store,date,sending,{...sending,status:'sent',sentAt:new Date(instant(now)).toISOString(),providerId:result.result.message_id,counts:briefing.counts,notificationRevision:briefing.notificationRevision});return {sent:true,date,counts:briefing.counts};
    }catch{
      await replace(store,date,sending,{...sending,status:'needs-review',failedAt:new Date(instant(now)).toISOString()});return {sent:false,reason:'delivery-uncertain'};
    }
  }
  await replace(store,date,sending,{...sending,status:'skipped',reason:'preferences-changing',finishedAt:new Date(instant(now)).toISOString()});return {sent:false,reason:'preferences-changing'};
}
