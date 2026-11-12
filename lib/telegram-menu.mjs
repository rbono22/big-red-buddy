import {recentJobGroups} from './job-recency.mjs';
import {eventApprovalVersion} from './event-version.mjs';
import {buildEventHub,eventRegistrationURL} from './event-hub.mjs';
import {setJobSaved} from './job-saves.mjs';
import {randomBytes} from 'node:crypto';
import {brief,reconcileReminders} from './integrations.mjs';
import {readReminderSettings} from './reminder-settings.mjs';
import {updateStudentReminders} from './reminder-actions.mjs';
import {readNotificationPreferences,saveNotificationPreferences} from './notification-preferences.mjs';
import {publicationNotice} from './job-messages.mjs';
import {assignmentPrompt} from './calendar-description.mjs';
import {localISO} from './domain.mjs';
const root=()=>`${process.env.APP_ORIGIN}/`;
const nonce=()=>randomBytes(16).toString('hex');
export async function pruneMenuActions(store){const rows=(await store.all('menuActions')).sort((a,b)=>b.expiresAt-a.expiresAt);for(const row of rows.filter((r,i)=>r.expiresAt<Date.now()||i>=500))await store.delete('menuActions',row.id);}
export async function menuMarkup(store,actions){
 const linked=await store.get('secrets','telegram');if(!linked?.chatId)return;
 await pruneMenuActions(store);
 const keyboard=[];
 for(const row of actions){const buttons=[];for(const [label,action] of row){if(action.url){buttons.push({text:label,url:action.url});continue;}const id=nonce();await store.put('menuActions',id,{id,action,chatId:String(linked.chatId),linkedAt:linked.linkedAt||'',expiresAt:Date.now()+1800000});buttons.push({text:label,callback_data:`menu:${id}`});}keyboard.push(buttons);}
 return {inline_keyboard:keyboard};
}
export async function menuCard(store,queue,text,actions,key,{notification}={}){
 const linked=await store.get('secrets','telegram');if(!linked?.chatId)return;
 const replyMarkup=await menuMarkup(store,actions);
 return queue.enqueue(store.userId,'telegram-send',{text:String(text).slice(0,3800),replyMarkup,...(notification?{notification}:{}),expectedChatId:String(linked.chatId),expectedTelegramLinkedAt:linked.linkedAt||''},{idempotencyKey:`menu:${key}`,retrySafe:false,maxAttempts:1});
}
export function eventActions(e){
 if(e.kind==='class')return [[['My day',{page:'day'}],['Change reminder',{page:'timing'}]]];
 if(['assignment','quiz','exam','studio'].includes(e.kind))return [[['View requirements',{event:e.id,operation:'requirements'}],['Get starter prompt',{event:e.id,operation:'prompt'}]],[['Change reminder',{page:'timing'}]]];
 const actions=[[['Add to calendar',{event:e.id,operation:'add',version:eventApprovalVersion(e)}],['Dismiss',{event:e.id,operation:'dismiss',version:eventApprovalVersion(e)}]]],url=eventRegistrationURL(e.rsvpUrl||e.sourceUrl);
 if(url)actions.push([['Open registration',{url}]]);return actions;
}
const mainButtons=[[['My day',{page:'day'}],['Add something',{page:'add'}]],[['Jobs',{page:'jobs'}],['Events',{page:'events'}]],[['Settings',{page:'settings'}],['Setup checklist',{page:'setup'}]]];
const back=[[['Main menu',{page:'home'}]]];
export async function showMenu(store,queue,page,key){
 if(page==='home')return menuCard(store,queue,'What would you like to do?',mainButtons,key);
 if(page==='day'){
  await menuCard(store,queue,await brief(store,1),[[['Deadlines',{page:'deadlines'}],['Events',{page:'events'}]],...back],key);return;
 }
 if(page==='add')return menuCard(store,queue,'Send a PDF or clear photo. Choose its purpose below, or include “syllabus”, “schedule”, “resume”, or “invite” in the caption.',[[['Syllabus',{page:'syllabus-term'}],['Class schedule',{page:'schedule-term'}]],[['Invitation',{command:'/invite'}],['Resume PDF',{command:'/resume_upload'}]],[['Type a plan',{command:'/newevent'}]],...back],key);
 if(['syllabus-term','schedule-term'].includes(page))return menuCard(store,queue,'Which term is this for?',[[['Fall 2026',{command:page==='syllabus-term'?'/syllabus FA26':'/enrollment FA26'}],['Spring 2027',{command:page==='syllabus-term'?'/syllabus SP27':'/enrollment SP27'}]],...back],key);
 if(page==='settings')return menuCard(store,queue,'Tell me “Remind me 30 minutes before classes” or “Turn off job alerts”. I’ll show a confirmation before saving. Choose a topic to change its delivery.',[[['School',{topic:'school'}],['Events',{topic:'events'}]],[['Jobs',{topic:'jobs'}],['News',{topic:'news'}]],[['Reminder timing',{page:'timing'}],['Setup checklist',{page:'setup'}]],...back],key);
 if(page==='timing')return menuCard(store,queue,`Current timing: ${Object.entries(await readReminderSettings(store)).filter(([k])=>k!=='updatedAt').map(([k,v])=>`${k}: ${v.length?v.map(m=>m%1440===0?`${m/1440} day(s)`:m%60===0?`${m/60} hour(s)`:`${m} minutes`).join(' and ')+' before':'off'}`).join('\n')}\nTell me the category and lead time, for example: Remind me 2 hours before deadlines. These settings apply to all items in the chosen category.`,[[['Classes',{timing:'classes'}],['Events',{timing:'events'}]],[['Assignments and exams',{timing:'deadlines'}]],...back],key);
 if(page==='setup'){
  const [google,resume,events,prefs]=await Promise.all([store.get('secrets','google'),store.get('documents','resume'),store.all('events'),store.get('settings','notifications')]);
  return menuCard(store,queue,`Your setup\n✓ Cornell sign-in\n✓ Private Telegram linked\n${google?.refresh_token?'✓':'○'} Google Calendar\n${resume?.text?'✓':'○'} Resume\n${events.some(e=>e.kind==='class')?'✓':'○'} Classes\n${prefs?'✓':'○'} Notification preferences`,[[['Connect / reconnect Google',{url:root()+'#connections'}]],[['Upload resume',{command:'/resume_upload'}],['Add classes',{page:'add'}]],[['Choose notifications',{page:'settings'}]],...back],key);
 }
 if(/^jobs(?::\d{1,4})?$/.test(page)){
  const offset=Number(page.split(':')[1]||0),groups=recentJobGroups(await store.all('jobs'),{now:Date.now()}),all=[...groups.last24Hours,...groups.pastWeek],skipped=new Set((await store.all('skippedJobs')).map(j=>j.id)),visible=all.filter(j=>!skipped.has(j.id)),jobs=visible.slice(offset,offset+8);let n=0;
  for(const job of jobs){if(await store.get('skippedJobs',job.id))continue;await menuCard(store,queue,`${job.title} · ${job.company}\n${job.location||'Location not specified'}\nPosted: ${job.publishedAt}\nPreparation does not submit an application.`,[[['Prepare application',{command:`/apply ${job.id}`}],['Find connections',{command:`/leads ${job.id}`}]],[['Save',{saveJob:job.id}],['Skip',{skipJob:job.id}]]],`${key}:${n++}`,{notification:{channel:'requested-jobs',...publicationNotice([job])}});}
  return menuCard(store,queue,n?'Choose a job above.':'No recent matching jobs available. Set your search preferences in Career Studio.',[...(visible.length>offset+8?[[['More jobs',{page:`jobs:${offset+8}`}]]]:[]),[['Career Studio',{url:root()+'#careers'}]],...back],key);
 }
 if(page==='events'){
  const items=(await buildEventHub(store)).items.filter(e=>!['cancelled','dismissed'].includes(e.status)&&Date.parse(e.start)>Date.now()).slice(0,8);
  let count=0;for(const e of items){if(await store.get('dismissedMenuEvents',e.id))continue;const actions=[[['Add to calendar',{hub:e.id,revision:e.revision}],['Dismiss',{dismissHub:e.id}]]];if(e.registrationUrl)actions.push([['Open registration',{url:e.registrationUrl}]]);await menuCard(store,queue,`${e.title}\n${new Date(e.start).toLocaleString('en-US',{timeZone:'America/New_York'})} · New York\nEnds: ${e.end?new Date(e.end).toLocaleString('en-US',{timeZone:'America/New_York'}):'Not specified'}\n${e.location||'Location not specified'}\n${e.sourceLabels.join(', ')}\n${e.warnings.join(' ')}`,actions,`${key}:${e.id}`);count++;}
  return menuCard(store,queue,count?'Your upcoming events are above.':'No upcoming events available.',back,key);
 }
 if(page==='events'||page==='deadlines'){
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
 const text=String(msg.text||'').trim(),pages={'/menu':'home','/start':'home','/help':'home','my day':'day','add something':'add','jobs':'jobs','events':'events','settings':'settings','menu':'home'};
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
 if(x.page)return showMenu(store,queue,x.page,id);
 if(Object.hasOwn(x,'retrySync')){await queue.enqueue(store.userId,'google-sync',{eventIds:x.retrySync},{idempotencyKey:`menu-retry:${id}`,retrySafe:false,maxAttempts:1});return menuCard(store,queue,'Retry queued. I will report Google’s result.',back,id);}
 if(x.dismissHub){await store.put('dismissedMenuEvents',x.dismissHub,{id:x.dismissHub});return menuCard(store,queue,'Hidden from your event suggestions. Existing calendar entries remain unchanged.',back,id);}
 if(x.hub){const item=(await buildEventHub(store)).items.find(e=>e.id===x.hub);if(!item||item.revision!==x.revision||['cancelled','dismissed'].includes(item.status))return menuCard(store,queue,'This event changed. Open Events and review the latest details.',[[['Events',{page:'events'}]],...back],id);
 const handlers={campus:['./campus-calendar.mjs','addCampusEvent'],partiful:['./partiful-calendar.mjs','addPartifulEvent'],luma:['./luma-calendar.mjs','addLumaEvent']};const adapter=handlers[item.action.kind];
 if(adapter){const module=await import(adapter[0]),wrapped={enqueue:(user,type,payload,options)=>queue.enqueue(user,type,{...payload,telegramReceipt:true},options)};await module[adapter[1]](store,{id:item.action.id},wrapped,{expectedVersion:item.action.version});return menuCard(store,queue,'Saved in BRB. Google sync will report its result when connected.',back,id);}
 if(item.action.kind==='manual'||item.action.kind==='email'){x.event=item.action.id;x.operation='add';x.version=item.action.version;}
 else return menuCard(store,queue,'Review this academic date in Events.',[[['Open Events',{url:root()+'#events'}]],...back],id);
 }
 if(x.command)return route({...query.message,text:x.command,photo:undefined,document:undefined},id);
 if(x.timing){const options=x.timing==='deadlines'?[60,240,1440]:[5,10,15,30,60];return menuCard(store,queue,`Choose when to be reminded for all ${x.timing}.`,options.map(m=>[[m>=60?`${m/60} hours before`:`${m} minutes before`,{proposeReminder:{[x.timing]:[m]}}]]).concat([[['Turn off',{proposeReminder:{[x.timing]:[]}}]]],back),id);}
 if(x.proposeReminder){const [category,values]=Object.entries(x.proposeReminder)[0];return menuCard(store,queue,`Set all ${category} reminders to ${values.length?values.join(', ')+' minutes before':'off'}?`,[[['Confirm',{reminders:x.proposeReminder,expected:await store.get('settings','reminders')}],['Cancel',{page:'settings'}]]],id);}
 if(x.topic)return menuCard(store,queue,`How should ${x.topic} updates arrive?`,[['off','daily','alerts','both'].map(mode=>[mode,{notifications:{topics:{[x.topic]:mode}}}]).slice(0,2),['alerts','both'].map(mode=>[mode,{notifications:{topics:{[x.topic]:mode}}}]),...back],id);
 if(x.reminders||x.notifications){const bucket=x.reminders?'reminders':'notifications',current=await store.get('settings',bucket);if(Object.hasOwn(x,'expected')&&JSON.stringify(x.expected)!==JSON.stringify(current))return menuCard(store,queue,'Settings changed since this proposal. Please request the change again.',back,id);if(x.reminders)await updateStudentReminders(store,x.reminders,{enqueue:(user,type,payload,options)=>queue.enqueue(user,type,{...payload,telegramReceipt:true},options)},{expectedPrevious:x.expected});else await saveNotificationPreferences(store,x.notifications,{updateId:id,expectedPrevious:x.expected});return menuCard(store,queue,'Saved your preferences.',back,id);}
 if(x.saveJob||x.skipJob){const job=await store.get('jobs',x.saveJob||x.skipJob);if(job){if(x.saveJob)await setJobSaved(store,{id:job.id,saved:true});else await store.put('skippedJobs',job.id,{id:job.id});}return menuCard(store,queue,job?'Saved your choice.':'This job is no longer available.',back,id);}
 if(x.event||x.move){const e=await store.get('events',x.event||x.move);if(!e)return menuCard(store,queue,'This event is no longer available.',back,id);
 if(x.operation==='requirements'||x.operation==='prompt')return menuCard(store,queue,x.operation==='prompt'?assignmentPrompt(e):e.evidence||e.description||'No requirements were included in the source.',back,id);
 if(x.version&&eventApprovalVersion(e)!==x.version)return menuCard(store,queue,'The event changed. Open its latest card.',back,id);
 let next={...e};if(x.move){if(JSON.stringify(e)!==JSON.stringify(x.expected))return menuCard(store,queue,'The event changed. Request the move again.',back,id);const start=localISO(x.date,x.time);if(!Number.isFinite(Date.parse(e.end))||Date.parse(e.end)<=Date.parse(e.start))return menuCard(store,queue,'The event needs a confirmed end time first.',back,id);next={...e,date:x.date,time:x.time,start,end:new Date(Date.parse(start)+(Date.parse(e.end)-Date.parse(e.start))).toISOString()};}
 else if(x.operation==='dismiss'){if(e.googleId)return menuCard(store,queue,'This event is already synced. Review its removal in Events.',[[['Open Events',{url:root()+'#events'}]],...back],id);next.status='dismissed';}
 else {if(e.cancelled||!e.start||!e.end)return menuCard(store,queue,'Confirm a complete event date and time in Events first.',back,id);if(e.status!=='approved')return menuCard(store,queue,'This source date needs review before calendar sync.',[[['Review event',{url:root()+'#events'}]],...back],id);next.status='approved';}
 if(!await store.compareAndSet('events',e.id,e,next))return menuCard(store,queue,'The event changed. Open it again.',back,id);await reconcileReminders(store);
 if(next.status==='approved')await queue.enqueue(store.userId,'google-sync',{eventIds:[e.id],telegramReceipt:true},{idempotencyKey:`menu-sync:${id}`,retrySafe:false,maxAttempts:1});return menuCard(store,queue,next.status==='approved'?'Saved in BRB. Calendar update queued.':'Dismissed.',back,id);
 }
}
