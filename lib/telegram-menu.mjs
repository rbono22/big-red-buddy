import {liveApplicationSupported} from './application-providers.mjs';
import {calendarEventRemoved} from './calendar-mutations.mjs';
import {refreshPersonalCalendar,uniquePersonalEvents} from './personal-calendar.mjs';
import {buildScheduleBrief,agendaWindow,inAgendaWindow,agendaSort,agendaWhen,googleCalendarEventURL,personalCalendarNotice} from './calendar-agenda.mjs';
import {recentJobGroups} from './job-recency.mjs';
import {eventApprovalVersion} from './event-version.mjs';
import {buildEventHub,eventRegistrationURL} from './event-hub.mjs';
import {setJobSaved} from './job-saves.mjs';
import {listVisibleJobs} from './career-cleanup.mjs';
import {randomBytes} from 'node:crypto';
import {reconcileReminders} from './integrations.mjs';
import {readReminderSettings} from './reminder-settings.mjs';
import {updateStudentReminders} from './reminder-actions.mjs';
import {readNotificationPreferences,saveNotificationPreferences} from './notification-preferences.mjs';
import {publicationNotice} from './job-messages.mjs';
import {assignmentPrompt,calendarLocation} from './calendar-description.mjs';
import {localISO} from './domain.mjs';
import {CALENDAR_SCOPE} from './auth.mjs';
import {readDailyBriefingSettings,saveDailyBriefingSettings} from './daily-briefing.mjs';
import {getDailyEmailStatus} from './daily-email.mjs';
const root=()=>`${process.env.APP_ORIGIN}/`;
const nonce=()=>randomBytes(16).toString('hex');
const categoryLabels={classes:'Classes',events:'Events',deadlines:'Assignments and exams'};
const topicLabels={school:'School',events:'Events',jobs:'Jobs',news:'News'};
const modeLabels={off:'Off',daily:'Morning briefing',alerts:'Separate alerts',both:'Briefing and alerts'};
const duration=m=>{const unit=m%1440===0?'day':m%60===0?'hour':'minute',n=m/(unit==='day'?1440:unit==='hour'?60:1);return `${n} ${unit}${n===1?'':'s'}`;};
const timingLabel=values=>values.length?`${values.map(duration).join(' and ')} before`:'Off';
const dateLabel=value=>Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}).format(new Date(value))+' · New York':'Date not supplied';
export async function pruneMenuActions(store){const rows=(await store.all('menuActions')).sort((a,b)=>b.expiresAt-a.expiresAt);for(const row of rows.filter((r,i)=>r.expiresAt<Date.now()||i>=500))await store.delete('menuActions',row.id);}
export async function menuMarkup(store,actions,{ttl=1800000}={}){
 const linked=await store.get('secrets','telegram');if(!linked?.chatId)return;
 await pruneMenuActions(store);
 const keyboard=[];
 for(const row of actions){const buttons=[];for(const [label,action] of row){if(action.url){buttons.push({text:label,url:action.url});continue;}const id=nonce();await store.put('menuActions',id,{id,action,chatId:String(linked.chatId),linkedAt:linked.linkedAt||'',expiresAt:Date.now()+ttl});buttons.push({text:label,callback_data:`menu:${id}`});}keyboard.push(buttons);}
 return {inline_keyboard:keyboard};
}
export async function menuCard(store,queue,text,actions,key,{notification,binding,ttl}={}){
 const linked=await store.get('secrets','telegram');if(!linked?.chatId)return;
 if(binding&&(String(linked.chatId)!==binding.chatId||(linked.linkedAt||'')!==binding.linkedAt))return;
 const replyMarkup=await menuMarkup(store,actions,ttl?{ttl}:{});
 return queue.enqueue(store.userId,'telegram-send',{text:String(text).slice(0,3800),replyMarkup,...(notification?{notification}:{}),...(binding?.applicationId?{liveApplicationId:binding.applicationId,liveApplicationRevision:binding.revision}:{}),expectedChatId:binding?.chatId||String(linked.chatId),expectedTelegramLinkedAt:binding?.linkedAt??linked.linkedAt??''},{idempotencyKey:`menu:${key}`,retrySafe:false,maxAttempts:1});
}
export function eventActions(e){
 if(e.kind==='class')return [[['My day',{page:'day'}],['Change reminder',{page:'timing'}]]];
 if(['assignment','quiz','exam','studio'].includes(e.kind))return [[['View requirements',{event:e.id,operation:'requirements'}],['Get starter prompt',{event:e.id,operation:'prompt'}]],[['Change reminder',{page:'timing'}]]];
 const actions=[[['Add to calendar',{event:e.id,operation:'add',version:eventApprovalVersion(e)}],['Dismiss',{event:e.id,operation:'dismiss',version:eventApprovalVersion(e)}]]],url=eventRegistrationURL(e.rsvpUrl||e.sourceUrl);
 if(url)actions.push([['Open registration',{url}]]);return actions;
}
const mainButtons=[[['My day',{page:'day'}],['Add something',{page:'add'}]],[['Jobs',{page:'jobs'}],['Events',{page:'events'}]],[['Settings',{page:'settings'}],['Setup checklist',{page:'setup'}]]];
const back=[[['Main menu',{page:'home'}]]];
const backTo=page=>[[['Back',{page}],['Main menu',{page:'home'}]]];
const deliveryLabel=value=>!value.enabled?'Paused':value.telegramEnabled&&value.emailEnabled?'Telegram and email':value.emailEnabled?'Email only':value.telegramEnabled?'Telegram only':'No delivery channel selected';
async function autopilotCard(store,queue,key,notice=''){
 const {getCareerProfile}=await import('./career.mjs'),a=(await getCareerProfile(store)).applicationAutopilot;
 const since=a.authorizedAt?`\nAuthorized ${new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'}).format(new Date(a.authorizedAt))} New York time.`:'';
 return menuCard(store,queue,`Application autopilot${notice?`\n${notice}`:''}\n\nConsent boxes: ${a.consents?'ON':'off'}\nBRB ticks every consent, certification, acknowledgment, and agreement box on employer forms, including legal certifications like “I certify this information is accurate” and privacy notices. You are responsible for what is submitted in your name. Receipts list the boxes accepted for you.\n\nNew questions: ${a.answers?'ON':'off'}\nBRB answers new application questions from your résumé and answers you saved before, and remembers them.${since}`,[[[a.consents?'Turn off consent boxes':'Turn on consent boxes',{autopilot:{key:'consents',value:!a.consents}}]],[[a.answers?'Turn off new answers':'Turn on new answers',{autopilot:{key:'answers',value:!a.answers}}]],[['Settings',{page:'settings'}]]],key);
}
export async function showMenu(store,queue,page,key,{now=Date.now,readPersonal=refreshPersonalCalendar}={}){
 if(page==='remove-event')return (await import('./calendar-deletion-telegram.mjs')).showCalendarDeletion(store,queue,key);
 await (await import('./calendar-deletion-telegram.mjs')).leaveCalendarDeletion(store);
 if(page==='manage-jobs')return (await import('./career-cleanup-telegram.mjs')).showCareerCleanup(store,queue,key);
 if(page==='home')return menuCard(store,queue,'What would you like to do?',mainButtons,key);
 if(page==='delivery'){
  const [daily,email]=await Promise.all([readDailyBriefingSettings(store),getDailyEmailStatus(store)]);
  return menuCard(store,queue,`Your morning briefing\n\nDelivery: ${deliveryLabel(daily)}\nTime: ${daily.time} · New York\n\nChoose Telegram, a formatted email to your own Cornell inbox, or both. Your selected daily topics apply to both. ${email.connected?'Gmail delivery is connected.':'Connect Gmail delivery on the BRB website before choosing email.'}\n\nFor a different time, send /briefing 08:00 (replace the time).`,[[['Telegram only',{proposeDaily:{enabled:true,telegramEnabled:true,emailEnabled:false}}]],[['Email only',{proposeDaily:{enabled:true,telegramEnabled:false,emailEnabled:true}}],['Both',{proposeDaily:{enabled:true,telegramEnabled:true,emailEnabled:true}}]],[['Pause daily briefing',{proposeDaily:{enabled:false}}]],[['Manage Gmail delivery',{url:root()+'#connections'}]],...backTo('settings')],key);
 }
 if(page==='day'||page==='tomorrow'||page==='week'){
  const summary=await buildScheduleBrief(store,page==='week'?7:1,{now,readPersonal,offset:page==='tomorrow'?1:0});
  await menuCard(store,queue,summary.text,[[[page==='tomorrow'?'My day':'Tomorrow',{page:page==='tomorrow'?'day':'tomorrow'}],['My calendar',{page:'calendar'}]],[['Deadlines',{page:'deadlines'}],['Events',{page:'events'}]],...back],key,{notification:summary.notification});return;
 }
 if(page==='add')return menuCard(store,queue,'Add something\n\nSend a photo, screenshot, or PDF here. I’ll suggest what it is and ask you to check the details.\n\nOr choose what you want to add below. Resumes need a PDF: up to 12 MB and 6 pages, including at most 4 scanned pages.',[[['Syllabus',{page:'syllabus-term'}],['Class schedule',{page:'schedule-term'}]],[['Invitation',{command:'/invite'}],['Resume PDF',{command:'/resume_upload'}]],[['Type a plan',{command:'/newevent'}]],...back],key);
 if(['syllabus-term','schedule-term'].includes(page))return menuCard(store,queue,'Before you upload: which term is this for?',[[['Fall 2026',{command:page==='syllabus-term'?'/syllabus FA26':'/enrollment FA26'}],['Spring 2027',{command:page==='syllabus-term'?'/syllabus SP27':'/enrollment SP27'}]],...backTo('add')],key);
 if(page==='autopilot')return autopilotCard(store,queue,key);
 if(page==='settings'){
  const prefs=await readNotificationPreferences(store);
  return menuCard(store,queue,`Notifications\n${prefs.enabled?'Delivery is on.':'Delivery is paused. Your topic choices are saved.'}\n\n${Object.entries(topicLabels).map(([topic,label])=>`${label}: ${modeLabels[prefs.topics[topic]]}`).join('\n')}\n\nChoose a topic or change reminder timing. You can also type “Remind me 30 minutes before classes”.`,[[['School',{topic:'school'}],['Events',{topic:'events'}]],[['Jobs',{topic:'jobs'}],['News',{topic:'news'}]],[['Reminder timing',{page:'timing'}],['Daily delivery',{page:'delivery'}]],[['Application autopilot',{page:'autopilot'}]],[[prefs.enabled?'Pause delivery':'Resume delivery',{proposeNotifications:{enabled:!prefs.enabled}}]],[['Setup checklist',{page:'setup'}]],...back],key);
 }
 if(page==='timing')return menuCard(store,queue,`Reminder timing\n\n${Object.entries(await readReminderSettings(store)).filter(([k])=>categoryLabels[k]).map(([k,v])=>`${categoryLabels[k]}: ${timingLabel(v)}`).join('\n')}\n\nChoose a category. Changes apply to all its reviewed items.`,[[['Classes',{timing:'classes'}],['Events',{timing:'events'}]],[['Assignments and exams',{timing:'deadlines'}]],...backTo('settings')],key);
 if(page==='setup'){
  const [google,resume,events,prefs]=await Promise.all([store.get('secrets','google'),store.get('documents','resume'),store.all('events'),store.get('settings','notifications')]);
  const calendar=!!google?.refresh_token&&String(google.scope||'').split(/\s+/).includes(CALENDAR_SCOPE),classes=events.some(e=>e.kind==='class'&&e.status!=='dismissed'&&!e.cancelled),preferences=!!prefs;
  return menuCard(store,queue,`Your setup · ${2+Number(calendar)+Number(classes)+Number(preferences)} of 5 ready\n\n✓ Cornell sign-in — done\n✓ Private Telegram linked — done\n${calendar?'✓':'○'} Google Calendar — ${calendar?'connected':'connect to sync dates'}\n${classes?'✓':'○'} Classes — ${classes?'imported; check dates in Academics':'add your schedule'}\n${preferences?'✓':'○'} Notification preferences — ${preferences?'chosen':'choose what to receive'}\n\nResume — ${resume?.text?'uploaded':'optional, for job support'}\nChoose any step below. Google authorization opens the BRB website.`,[[[calendar?'Manage Google Calendar':'Connect Google Calendar',{url:root()+'#connections'}]],[['Add classes',{page:'add'}],['Choose notifications',{page:'settings'}]],[['Upload resume (optional)',{command:'/resume_upload'}]],...back],key);
 }
 if(/^linkedin-jobs(?::\d{1,4})?$/.test(page)){
  const {getLinkedInAlertJobs}=await import('./linkedin-job-email.mjs'),{linkedInAlertText,linkedInNotice}=await import('./linkedin-job-delivery.mjs');
  const snapshot=await getLinkedInAlertJobs(store,{limit:300}),offset=Number(page.split(':')[1]||0),jobs=snapshot.jobs.slice(offset,offset+6);
  for(const job of jobs)await menuCard(store,queue,linkedInAlertText(job),[[['Open on LinkedIn',{url:job.url}]],[['Save',{saveJob:job.id}],['Skip',{skipJob:job.id}]],[['Find connections',{command:`/leads ${job.id}`}]]],`${key}:${job.id}`,{notification:{channel:'requested-jobs',...linkedInNotice(snapshot,[job])}});
  return menuCard(store,queue,jobs.length?'These roles came from your LinkedIn job-alert emails.':'No LinkedIn alert jobs available yet. Enable email monitoring in Career Studio.',[...(snapshot.jobs.length>offset+6?[[['More LinkedIn jobs',{page:`linkedin-jobs:${offset+6}`}]]]:[]),[['Manage LinkedIn alerts',{url:root()+'#careers'}]],[['Jobs',{page:'jobs'}]],...back],key);
 }
 if(/^jobs(?::\d{1,4})?$/.test(page)){
  const offset=Number(page.split(':')[1]||0),groups=recentJobGroups(await listVisibleJobs(store),{now:Date.now()}),all=[...groups.last24Hours,...groups.pastWeek],skipped=new Set((await store.all('skippedJobs')).filter(j=>j.hidden!==false).map(j=>j.id)),visible=all.filter(j=>!skipped.has(j.id)),jobs=visible.slice(offset,offset+8);let n=0;
  for(const job of jobs){
   const skip=await store.get('skippedJobs',job.id);if(skip&&skip.hidden!==false)continue;
   const supported=liveApplicationSupported(job),direct=supported?[[['Apply now with saved profile',{quickApply:{jobId:job.id,jobHash:(await import('./live-applications.mjs')).quickApplicationJobFingerprint(job)}}]]]:[];
   await menuCard(store,queue,`${job.title}\n${job.company} · ${job.location||'Location not specified'}\n\nPosted ${dateLabel(job.publishedAt)}\n${supported?'Apply now uses your saved résumé and answers, asks for anything missing here, then submits when complete without a review screen. Required cover letters are tailored automatically. If automatic application cannot finish, I’ll offer a browser handoff to fill supported fields. Choose Review & apply for a final review.':'Prepare a draft application or check for a warm introduction. Preparation does not submit an application.'}`,[[[supported?'Application & autofill options':'Open job link',{command:`/job ${job.id}`}]],...direct,[[supported?'Review & apply':'Prepare application',{command:`/apply ${job.id}`}],['Find connections',{command:`/leads ${job.id}`}]],[['Resume AI Enhancer',{resumeEnhancer:{operation:'show',jobId:job.id}}]],[['Save',{saveJob:job.id}],['Skip',{skipJob:job.id}]]],`${key}:${n++}`,{notification:{channel:'requested-jobs',...publicationNotice([job])}});
  }
  return menuCard(store,queue,n?'Choose a job above. Have a different posting? Send /apply followed by its employer application link.':'No recent matching jobs available. Set your search preferences in Career Studio, or send /apply followed by an employer application link.',[...(visible.length>offset+8?[[['More jobs',{page:`jobs:${offset+8}`}]]]:[]),[['My applications',{command:'/applications'}],['Manage job lists',{page:'manage-jobs'}]],[['Resume AI Enhancer',{resumeEnhancer:{operation:'show'}}]],[['Fresh browser handoff',{command:'/handoff'}]],[['LinkedIn alert jobs',{page:'linkedin-jobs'}]],[['Career Studio',{url:root()+'#careers'}]],...back],key);
 }
 if(/^(events|calendar|discover)(?::\d{1,4})?$/.test(page)){
  const [view,skip]=page.split(':'),offset=Number(skip||0),at=now(),window={...agendaWindow(at,8),end:at+7*86400000};
  const [snapshot,hub,dismissed,saved,google]=await Promise.all([readPersonal(store,{now:()=>at}),buildEventHub(store,{now:at}),store.all('dismissedMenuEvents'),store.all('events'),store.get('secrets','google')]);
  const hidden=new Set(dismissed.filter(e=>e.hidden!==false).map(e=>e.id));
  const personal=uniquePersonalEvents((snapshot.events||[]).filter(e=>inAgendaWindow(e,window,{after:at})),[]).map(e=>({...e,personal:true}));
  const suggestions=uniquePersonalEvents(hub.items.filter(e=>inAgendaWindow(e,window,{after:at})&&!hidden.has(e.id)),personal);
  const items=(view==='calendar'?personal:view==='discover'?suggestions:[...personal,...suggestions]).sort(agendaSort),rows=items.slice(offset,offset+8);
  for(const e of rows){
   let actions,status;
   if(e.personal){actions=[[['Remove from calendar',{calendarDeletion:{operation:'preview',personalEventId:e.id}}]]];status='Already on Google Calendar';const url=googleCalendarEventURL(e);if(url)actions.push([['Open in Google Calendar',{url}]]);}
   else if(e.googleId){
    actions=[];status='Already on Google Calendar';const record=saved.find(row=>row.id===e.action?.id),url=googleCalendarEventURL({remoteId:record?.googleId,sourceCalendarId:google?.calendarId});if(url)actions.push([['Open in Google Calendar',{url}]]);if(record)actions.push([['Remove from calendar',{calendarDeletion:{operation:'preview',localId:record.id}}]]);
   }else {status=e.status==='added'?'In your BRB schedule · Google sync pending':'Suggested event';actions=[[['Add to calendar',{hub:e.id,revision:e.revision}],['Dismiss',{dismissHub:e.id}]]];}
   if(e.registrationUrl)actions.push([['Open registration',{url:e.registrationUrl}]]);
   if(!actions.length)actions=back;
   await menuCard(store,queue,`${e.title}\n\n${agendaWhen(e)} · New York\n${calendarLocation(e.location)||'Location not specified'}\n\n${status}${e.personal?'':`\n${e.sourceLabels.join(', ')}${e.warnings.length?'\n'+e.warnings.join(' '):''}`}`,actions,`${key}:${e.personal?'google:':''}${e.id}`,{notification:e.personal?{channel:'requested-calendar',personalCalendarRevision:snapshot.revision}:undefined});
  }
  const notice=personalCalendarNotice(snapshot);
  return menuCard(store,queue,[rows.length?`Showing ${offset+1}–${offset+rows.length} of ${items.length} upcoming items.`:'No upcoming items found in this view.','Google Calendar: your next 7 days. Existing events are shown without copying them.',notice].filter(Boolean).join('\n\n'),[...(items.length>offset+8?[[['More events',{page:`${view}:${offset+8}`}]]]:[]),[['My calendar',{page:'calendar'}],['Discover events',{page:'discover'}]],[['Remove an event',{page:'remove-event'}],['Calendar settings',{url:root()+'#connections'}]],...back],key);
 }
 if(page==='deadlines'){
  const rows=(await store.all('events')).filter(e=>!e.cancelled&&e.status!=='dismissed'&&Date.parse(e.start)>Date.now()&&(page==='events'?e.kind==='event':['assignment','quiz','exam','studio'].includes(e.kind))).sort((a,b)=>Date.parse(a.start)-Date.parse(b.start)).slice(0,8);
  for(const e of rows){const actions=page==='events'?[[['Add to calendar',{event:e.id,operation:'add',version:eventApprovalVersion(e)}],['Dismiss',{event:e.id,operation:'dismiss',version:eventApprovalVersion(e)}]]]:[[['View requirements',{event:e.id,operation:'requirements'}],['Get starter prompt',{event:e.id,operation:'prompt'}]],[['Change reminder',{page:'timing'}]]];const link=eventRegistrationURL(e.rsvpUrl||e.sourceUrl);if(link)actions.push([['Open registration',{url:link}]]);await menuCard(store,queue,`${e.title}\n${new Date(e.start).toLocaleString('en-US',{timeZone:'America/New_York'})} · New York\n${e.location||'Location not specified'}`,actions,`${key}:${e.id}`);}
  return menuCard(store,queue,rows.length?'Your next items are above.':'No upcoming items found.',back,key);
 }
}
export function parseRoutineRequest(text){
 const reminder=text.match(/^remind me (\d+) (minutes?|hours?|days?) before (classes|events|assignments|deadlines)[.!]?$/i);
 if(reminder){const minutes=Number(reminder[1])*({m:1,h:60,d:1440}[reminder[2][0].toLowerCase()]);if(minutes<1||minutes>40320)return null;return {reminders:{[['assignments','deadlines'].includes(reminder[3].toLowerCase())?'deadlines':reminder[3].toLowerCase()]:[minutes]}};}
 const alerts=text.match(/^turn (off|on) (job|jobs|school|event|events|news) alerts[.!]?$/i);if(alerts)return {notifications:{topics:{[{job:'jobs',event:'events'}[alerts[2].toLowerCase()]||alerts[2].toLowerCase()]:alerts[1].toLowerCase()==='off'?'off':'alerts'}}};
 return null;
}
export async function handleMenuMessage(store,queue,msg,id){
 const text=String(msg.text||'').trim(),pages={'/menu':'home','/start':'home','/help':'home','my day':'day','/today':'day','/tomorrow':'tomorrow','tomorrow':'tomorrow','/week':'week','/events':'events','my calendar':'calendar','add something':'add','jobs':'jobs','events':'events','settings':'settings','menu':'home','/autopilot':'autopilot','autopilot':'autopilot','/managejobs':'manage-jobs','manage jobs':'manage-jobs','manage job lists':'manage-jobs'};
 if(pages[text.toLowerCase()]){await showMenu(store,queue,pages[text.toLowerCase()],id);return true;}
 const proposal=parseRoutineRequest(text);if(proposal){if(proposal.notifications){const prefs=await readNotificationPreferences(store),topic=Object.keys(proposal.notifications.topics)[0],turnOff=/^turn off/i.test(text),current=prefs.topics[topic];proposal.notifications.topics[topic]=turnOff?(current==='both'||current==='daily'?'daily':'off'):(current==='daily'||current==='both'?'both':'alerts');}await menuCard(store,queue,`Proposed change: ${text}\nSave this change?`,[[['Confirm',{...proposal,expected:await store.get('settings',proposal.reminders?'reminders':'notifications')}],['Cancel',{page:'home'}]]],id);return true;}
 const move=text.match(/^move (.+) to (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)[.!]?$/i);
 if(move){const matches=(await store.all('events')).filter(e=>e.kind==='event'&&(!e.connector||e.connector==='telegram-invitation')&&e.status==='approved'&&!e.cancelled&&Date.parse(e.start)>Date.now()&&e.title.toLowerCase().includes(move[1].toLowerCase()));if(matches.length!==1){await menuCard(store,queue,'Use the exact event name so I can identify one upcoming personal event.',back,id);return true;}const e=matches[0],today=new Date().toLocaleDateString('en-CA',{timeZone:'America/New_York'}),d=new Date(today+'T12:00:00Z'),weekday=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(move[2].toLowerCase());d.setUTCDate(d.getUTCDate()+((weekday-d.getUTCDay()+7)%7||7));const date=d.toISOString().slice(0,10),time=new Date(e.start).toLocaleTimeString('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'});await menuCard(store,queue,`Move ${e.title} to ${date} at ${time} New York time? Duration and location stay the same.`,[[['Confirm move',{move:e.id,expected:e,date,time}],['Cancel',{page:'home'}]]],id);return true;}
 return false;
}
export async function handleMenuCallback(database,store,queue,query,id,{route}={}){
 const token=query.data.slice(5),a=await store.get('menuActions',token),linked=await store.get('secrets','telegram');
 if(!a||a.expiresAt<Date.now()||a.chatId!==String(query.message.chat.id)||a.linkedAt!==(linked?.linkedAt||''))return menuCard(store,queue,'This button expired. Open a fresh menu.',back,id);
 if(!await store.compareAndSet('menuActions',token,a,{...a,expiresAt:0}))return;
 const x=a.action;
 if(x.quickApply){
  const expected=x.quickApply,job=await store.get('jobs',expected.jobId);
  const {quickApplicationJobFingerprint,startQuickApplication}=await import('./live-applications.mjs');
  if(!job||quickApplicationJobFingerprint(job)!==expected.jobHash)return menuCard(store,queue,'This job’s details changed. Open a fresh job card before choosing Apply now.',[[['Jobs',{page:'jobs'}]]],id);
  return startQuickApplication(store,queue,job.id,id,{expectedJobHash:expected.jobHash});
 }
 if(x.referral)return (await import('./linkedin-referrals-telegram.mjs')).handleReferralAction(database,store,queue,x.referral,id);
 if(x.resumeEnhancer)return (await import('./resume-enhancer-telegram.mjs')).handleResumeEnhancerAction(store,queue,x.resumeEnhancer,id);
 if(x.careerCleanup)return (await import('./career-cleanup-telegram.mjs')).handleCareerCleanupAction(store,queue,x.careerCleanup,id);
 if(x.calendarDeletion)return (await import('./calendar-deletion-telegram.mjs')).handleCalendarDeletionAction(store,queue,x.calendarDeletion,id);
 if(x.autopilot){
  const {saveApplicationAutopilot}=await import('./career.mjs');
  if(!['consents','answers'].includes(x.autopilot.key)||typeof x.autopilot.value!=='boolean')return autopilotCard(store,queue,id);
  await saveApplicationAutopilot(store,{[x.autopilot.key]:x.autopilot.value});
  return autopilotCard(store,queue,id,x.autopilot.value?'Saved. BRB will use this on your next Apply.':'Turned off. BRB will ask you again.');
 }
 if(x.liveApplication)return (await import('./live-applications.mjs')).handleLiveApplicationAction(store,queue,x.liveApplication,id);
 if(x.proposeDaily){
  const [current,email]=await Promise.all([readDailyBriefingSettings(store),getDailyEmailStatus(store)]);
  if(x.proposeDaily.emailEnabled&&!email.connected)return menuCard(store,queue,'First connect Gmail delivery in BRB → Connections. Google needs your permission to send the briefing to your Cornell inbox.',[[['Connect Gmail delivery',{url:root()+'#connections'}]],...backTo('delivery')],id);
  return menuCard(store,queue,`Daily briefing\n\nCurrent: ${deliveryLabel(current)}\nNew: ${deliveryLabel({...current,...x.proposeDaily})}\nTime: ${current.time} · New York\n\nSave this delivery choice?`,[[['Confirm',{dailySettings:x.proposeDaily,expected:await store.get('settings','dailyBriefing')}],['Cancel',{page:'delivery'}]]],id);
 }
 if(x.dailySettings){
  if(x.dailySettings.emailEnabled&&!(await getDailyEmailStatus(store)).connected)return menuCard(store,queue,'Gmail delivery is disconnected. Connect it before enabling email.',backTo('delivery'),id);
  const saved=await saveDailyBriefingSettings(store,x.dailySettings,{expectedPrevious:x.expected});
  return menuCard(store,queue,`Saved. Daily briefing: ${deliveryLabel(saved)} at ${saved.time} New York time.`,backTo('delivery'),id);
 }
 if(x.page)return showMenu(store,queue,x.page,id);
 if(Object.hasOwn(x,'retrySync')){await queue.enqueue(store.userId,'google-sync',{eventIds:x.retrySync},{idempotencyKey:`menu-retry:${id}`,retrySafe:false,maxAttempts:1});return menuCard(store,queue,'Retry queued. I will report Google’s result.',back,id);}
 if(x.restoreSuggestion){
  const {bucket,itemId,expected}=x.restoreSuggestion;
  if(!['dismissedMenuEvents','skippedJobs'].includes(bucket))return;
  const restored=await store.compareAndSet(bucket,itemId,expected,{...expected,hidden:false,revision:nonce()}),page=bucket==='skippedJobs'?'jobs':'events';
  return menuCard(store,queue,restored?'Restored to your suggestions.':'That choice changed since you dismissed it. Open the latest suggestions.',[[[page==='jobs'?'Jobs':'Events',{page}]],...back],id);
 }
 if(x.dismissHub){const record={id:x.dismissHub,hidden:true,revision:nonce()};await store.put('dismissedMenuEvents',x.dismissHub,record);return menuCard(store,queue,'Hidden from your event suggestions. Existing calendar entries remain unchanged.',[[['Undo',{restoreSuggestion:{bucket:'dismissedMenuEvents',itemId:x.dismissHub,expected:record}}],['Events',{page:'events'}]],...back],id);}
 if(x.hub){const item=(await buildEventHub(store)).items.find(e=>e.id===x.hub);if(!item||item.revision!==x.revision||['cancelled','dismissed'].includes(item.status))return menuCard(store,queue,'This event changed. Open Events and review the latest details.',[[['Events',{page:'events'}]],...back],id);
 const handlers={campus:['./campus-calendar.mjs','addCampusEvent'],partiful:['./partiful-calendar.mjs','addPartifulEvent'],luma:['./luma-calendar.mjs','addLumaEvent']};const adapter=handlers[item.action.kind];
 if(adapter){const module=await import(adapter[0]),wrapped={enqueue:(user,type,payload,options)=>queue.enqueue(user,type,{...payload,telegramReceipt:true},options)};await module[adapter[1]](store,{id:item.action.id},wrapped,{expectedVersion:item.action.version});return menuCard(store,queue,'Saved in BRB. Google sync will report its result when connected.',back,id);}
 if(item.action.kind==='manual'||item.action.kind==='email'){x.event=item.action.id;x.operation='add';x.version=item.action.version;}
 else return menuCard(store,queue,'Review this academic date in Events.',[[['Open Events',{url:root()+'#events'}]],...back],id);
 }
 if(x.command)return route({...query.message,text:x.command,photo:undefined,document:undefined},id);
 if(x.timing){const options=x.timing==='deadlines'?[[1440,240],[60],[240],[1440]]:[[5],[10],[15],[30],[60]],current=(await readReminderSettings(store))[x.timing];return menuCard(store,queue,`${categoryLabels[x.timing]}\nCurrent: ${timingLabel(current)}\n\nChoose a reminder time. You’ll confirm before it changes. For another time, type “Remind me 2 hours before ${x.timing}”.`,options.map(values=>[[timingLabel(values),{proposeReminder:{[x.timing]:values}}]]).concat([[['Turn off',{proposeReminder:{[x.timing]:[]}}]]],backTo('timing')),id);}
 if(x.proposeReminder){const [category,values]=Object.entries(x.proposeReminder)[0],current=(await readReminderSettings(store))[category];return menuCard(store,queue,`${categoryLabels[category]} reminders\n\nCurrent: ${timingLabel(current)}\nNew: ${timingLabel(values)}\n\nSave this change for all reviewed ${category==='deadlines'?'assignments and exams':category}?`,[[['Confirm',{reminders:x.proposeReminder,expected:await store.get('settings','reminders')}],['Cancel',{page:'timing'}]]],id);}
 if(x.topic){const prefs=await readNotificationPreferences(store);return menuCard(store,queue,`${topicLabels[x.topic]} notifications\nCurrent: ${modeLabels[prefs.topics[x.topic]]}\n\nMorning briefing: include updates in your daily summary.\nSeparate alerts: reminders or updates as they become due.\nBriefing and alerts: receive both.\nOff: no proactive messages for this topic.`,['daily','alerts','both','off'].map(mode=>[[modeLabels[mode],{proposeNotifications:{topics:{[x.topic]:mode}}}]]).concat(backTo('settings')),id);}
 if(x.proposeNotifications){const prefs=await readNotificationPreferences(store),[topic,mode]=Object.entries(x.proposeNotifications.topics||{})[0]||[],text=topic?`${topicLabels[topic]} notifications\n\nCurrent: ${modeLabels[prefs.topics[topic]]}\nNew: ${modeLabels[mode]}${!prefs.enabled?'\n\nDelivery is paused. Resume delivery in Settings when you are ready.':''}`:`${x.proposeNotifications.enabled?'Resume':'Pause'} proactive notifications?\n\nYour topic choices stay saved. You can still ask BRB for help while delivery is paused.`;return menuCard(store,queue,text+'\n\nSave this change?',[[['Confirm',{notifications:x.proposeNotifications,expected:await store.get('settings','notifications')}],['Cancel',{page:'settings'}]]],id);}
 if(x.reminders||x.notifications){const bucket=x.reminders?'reminders':'notifications',current=await store.get('settings',bucket);if(Object.hasOwn(x,'expected')&&JSON.stringify(x.expected)!==JSON.stringify(current))return menuCard(store,queue,'Settings changed since this proposal. Please request the change again.',backTo('settings'),id);if(x.reminders)await updateStudentReminders(store,x.reminders,{enqueue:(user,type,payload,options)=>queue.enqueue(user,type,{...payload,telegramReceipt:true},options)},{expectedPrevious:x.expected});else await saveNotificationPreferences(store,x.notifications,{updateId:id,expectedPrevious:x.expected});const detail=x.reminders?Object.entries(x.reminders).map(([category,values])=>`${categoryLabels[category]}: ${timingLabel(values)}`).join('\n'):x.notifications.topics?Object.entries(x.notifications.topics).map(([topic,mode])=>`${topicLabels[topic]}: ${modeLabels[mode]}`).join('\n'):x.notifications.enabled?'Notification delivery resumed.':'Notification delivery paused.';return menuCard(store,queue,`Saved your preferences.\n\n${detail}`,backTo('settings'),id);}
 if(x.saveJob||x.skipJob){const job=await store.get('jobs',x.saveJob||x.skipJob);if(!job)return menuCard(store,queue,'This job is no longer available.',backTo('jobs'),id);if(x.saveJob){await setJobSaved(store,{id:job.id,saved:true});return menuCard(store,queue,`Saved ${job.title||'this role'} in Career Studio.`,[[['Jobs',{page:'jobs'}],['Career Studio',{url:root()+'#careers'}]],...back],id);}const record={id:job.id,hidden:true,revision:nonce()};await store.put('skippedJobs',job.id,record);return menuCard(store,queue,`Skipped ${job.title||'this role'}. It is hidden from job suggestions.`,[[['Undo',{restoreSuggestion:{bucket:'skippedJobs',itemId:job.id,expected:record}}],['Jobs',{page:'jobs'}]],...back],id);}
 if(x.event||x.move){const e=await store.get('events',x.event||x.move);if(!e)return menuCard(store,queue,'This event is no longer available.',back,id);
 if(await calendarEventRemoved(store,{localId:e.id}))return menuCard(store,queue,'This event was removed from your calendar. Open a fresh calendar menu.',[[['My calendar',{page:'calendar'}]],...back],id);
 if(x.operation==='requirements'||x.operation==='prompt')return menuCard(store,queue,x.operation==='prompt'?assignmentPrompt(e):e.evidence||e.description||'No requirements were included in the source.',back,id);
 if(x.version&&eventApprovalVersion(e)!==x.version)return menuCard(store,queue,'The event changed. Open its latest card.',back,id);
 let next={...e};if(x.move){if(JSON.stringify(e)!==JSON.stringify(x.expected))return menuCard(store,queue,'The event changed. Request the move again.',back,id);const start=localISO(x.date,x.time);if(!Number.isFinite(Date.parse(e.end))||Date.parse(e.end)<=Date.parse(e.start))return menuCard(store,queue,'The event needs a confirmed end time first.',back,id);next={...e,date:x.date,time:x.time,start,end:new Date(Date.parse(start)+(Date.parse(e.end)-Date.parse(e.start))).toISOString()};}
 else if(x.operation==='dismiss'){if(e.googleId)return menuCard(store,queue,'This event is already synced. Review its removal in Events.',[[['Open Events',{url:root()+'#events'}]],...back],id);next.status='dismissed';}
 else {if(e.cancelled||!e.start||!e.end)return menuCard(store,queue,'Confirm a complete event date and time in Events first.',back,id);if(e.status!=='approved')return menuCard(store,queue,'This source date needs review before calendar sync.',[[['Review event',{url:root()+'#events'}]],...back],id);next.status='approved';}
 if(!await store.compareAndSet('events',e.id,e,next))return menuCard(store,queue,'The event changed. Open it again.',back,id);await reconcileReminders(store);
 if(next.status==='approved')await queue.enqueue(store.userId,'google-sync',{eventIds:[e.id],telegramReceipt:true},{idempotencyKey:`menu-sync:${id}`,retrySafe:false,maxAttempts:1});return menuCard(store,queue,next.status==='approved'?'Saved in BRB. Calendar update queued.':'Dismissed.',back,id);
 }
}
