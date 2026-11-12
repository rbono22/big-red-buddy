import {randomBytes} from 'node:crypto';
import {idFor,localISO,TZ} from './domain.mjs';
import {reconcileReminders} from './integrations.mjs';
import {HttpError} from './security.mjs';

const KEY='newEventFlow',TTL=30*60000,FIELDS=['title','date','time','location','duration'];
const clean=(value,max=4000)=>String(value||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,max);
const nonce=()=>randomBytes(16).toString('hex');
const partsFormatter=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const parts=instant=>Object.fromEntries(partsFormatter.formatToParts(new Date(instant)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
const localDate=instant=>{const p=parts(instant);return `${p.year}-${p.month}-${p.day}`;};
const display=instant=>new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(instant));
const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(`${value}T12:00:00Z`))&&new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)===value;
const dayAfter=date=>new Date(Date.parse(`${date}T12:00:00Z`)+86400000).toISOString().slice(0,10);
const control='Edit: /newevent edit title|date|time|location|duration VALUE\nCancel: /newevent cancel';
const dateNotice='Check the actual date before confirming. Today/tomorrow are based on New York time when you pasted the text; an old forwarded message may mean a different day.';
const help=`Send /newevent followed by an event message, or send /newevent then paste it. I will ask for missing details and show the exact date, time, location, and duration before saving.\n${control}\nOnly /newevent confirm TOKEN saves an event. No invitations are sent.`;

function exactTime(value){
 const text=String(value||'').trim().toLowerCase().replace(/^at\s+/,'').replace(/\s+(?:et|new york(?: time)?)$/,'');
 if(text==='noon')return '12:00';if(text==='midnight')return '00:00';
 let m=text.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/);
 if(m){const h=Number(m[1]),minute=Number(m[2]||0);if(h<1||h>12||minute>59)return null;return `${String(h%12+(m[3]==='p'?12:0)).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;}
 m=text.match(/^(\d{2}):(\d{2})(?:\s*(24h))?$/);
 if(m&&Number(m[1])<=23&&Number(m[2])<=59&&(m[1].startsWith('0')||Number(m[1])>12||m[3]))return `${m[1]}:${m[2]}`;
 return null;
}
function duration(value){
 const m=String(value||'').trim().toLowerCase().match(/^(\d{1,4})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/);
 if(!m)return null;const minutes=Number(m[1])*(m[2]?.startsWith('h')?60:1);
 return Number.isInteger(minutes)&&minutes>=1&&minutes<=1440?minutes:null;
}
function strictInstant(date,time){
 const result=localISO(date,time),stamp=Date.parse(result);
 for(const offset of [-3600000,3600000]){const p=parts(stamp+offset);if(`${p.year}-${p.month}-${p.day}`===date&&`${p.hour}:${p.minute}`===time)throw new Error('That time occurs twice when New York clocks move back. Choose an unambiguous New York start time.');}
 return result;
}
function fieldValue(field,value,anchorDate){
 const text=clean(value,4000);
 if(field==='date'){
  const lower=text.toLowerCase(),date=lower==='today'||lower==='tonight'?anchorDate:lower==='tomorrow'?dayAfter(anchorDate):text;
  return validDate(date)?date:null;
 }
 if(field==='time')return exactTime(text);
 if(field==='duration')return duration(text);
 if(field==='title')return text.length>=2&&text.length<=240&&!/^(?:yes|no|ok|okay|sure|idk|tbd|unknown)$/i.test(text)?text.replace(/\s+/g,' '):null;
 if(field==='location')return text.length>=2&&text.length<=300&&!/^(?:yes|no|ok|okay|sure|idk|tba|tbd|unknown|not sure|somewhere|there|campus|school|the usual place)$/i.test(text)?text.replace(/\s+/g,' '):null;
 return null;
}

/** Suggestions only: ambiguous dates/times remain absent and require a student answer. */
export function parseNewEventText(value,{now=Date.now}={}){
 const text=clean(value),anchorDate=localDate(now()),fields=Object.fromEntries(FIELDS.map(f=>[f,null])),labels=new Map();
 for(const match of text.matchAll(/(?:^|[\n;])\s*(title|date|time|location|duration)\s*:\s*([^;\n]+)/gi)){const field=match[1].toLowerCase();labels.set(field,[...(labels.get(field)||[]),match[2].trim()]);}
 for(const [field,values]of labels){const parsed=[...new Set(values.map(value=>fieldValue(field,value,anchorDate)))];fields[field]=parsed.length===1?parsed[0]:null;}
 if(!labels.has('title')){
  const activities=[[/\bstud(?:y|ying)\b/i,'Study session'],[/\blunch\b/i,'Lunch'],[/\bdinner\b/i,'Dinner'],[/\bcoffee\b/i,'Coffee'],[/\bworkout\b/i,'Workout'],[/\bmeeting\b/i,'Meeting']].filter(([pattern])=>pattern.test(text));
  if(activities.length===1)fields.title=activities[0][1];
 }
 if(!labels.has('date')){
  const dates=[...new Set([...text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(m=>m[0]))],relative=[...new Set([...text.matchAll(/\b(today|tonight|tomorrow)\b/gi)].map(m=>m[1].toLowerCase()==='tomorrow'?dayAfter(anchorDate):anchorDate))];
  const candidates=[...new Set([...dates,...relative])];if(candidates.length===1&&validDate(candidates[0]))fields.date=candidates[0];
 }
 if(!labels.has('time')){
  const times=[...text.matchAll(/\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\b|\b\d{1,2}:\d{2}\b|\b(?:noon|midnight)\b/gi)].map(m=>exactTime(m[0]));
  if(times.length&&times.every(Boolean)&&new Set(times).size===1)fields.time=times[0];
 }
 const timeRange=/\b\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s*(?:[-–—]|to|until)\s*\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\b|\b\d{1,2}:\d{2}\s*(?:[-–—]|to|until)\s*\d{1,2}:\d{2}\b|\bbetween\s+\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s+and\s+\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\b/i;
 const zoneNames=[...text.matchAll(/\b(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Za-z_]+(?:\/[A-Za-z_]+)?/g)].map(m=>m[0]);
 const clockSuffixes=[...text.matchAll(/(?:\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?|\d{1,2}:\d{2})[ \t]+([A-Za-z]{2,6})\b(?!:)/gi)].map(m=>m[1].toLowerCase());
 if(timeRange.test(text)||/\b(?:PST|PDT|Pacific|CST|CDT|MST|MDT|UTC|GMT|CET|CEST|BST|IST|JST|HKT|AEST|AEDT|NZST|NZDT)\b/i.test(text)||/[+-]\d{2}:?\d{2}\b/.test(text)||zoneNames.some(zone=>zone!==TZ)||clockSuffixes.some(zone=>!['am','pm','et','est','edt','at','in','on','for','and','to','until','new'].includes(zone)))fields.time=null;
 if(!labels.has('location')){
  const m=text.match(/\b(?:at|in)\s+((?:Tata|Bloomberg|Zoom|Google Meet|Microsoft Teams)\b[^\n;,]*)/i);
  if(m)fields.location=fieldValue('location',m[1].replace(/\s+(?:at|on|today|tomorrow|tonight|for|from|between)\b.*$/i,''),anchorDate);
 }
 if(!labels.has('duration')){const m=text.match(/\bfor\s+(\d{1,4}\s*(?:minutes?|mins?|hours?|hrs?))\b/i);if(m)fields.duration=duration(m[1]);}
 return {anchorDate,fields};
}

function ready(flow,now){
 if(flow.question==='paste'&&!flow.sourceText)return '';
 let note='';
 if(flow.fields.date&&flow.fields.date<localDate(now())){flow.fields.date=null;note='That date is in the past. Please give the intended future date.';}
 if(flow.fields.date&&flow.fields.time){
  try{flow.start=strictInstant(flow.fields.date,flow.fields.time);if(Date.parse(flow.start)<=now()){flow.fields.time=null;flow.start=null;note='That start time has already passed. Enter a future time, or edit the date.';}}
  catch(error){flow.fields.time=null;flow.start=null;note=/occurs twice/.test(error.message)?error.message:'That New York time does not exist during the daylight-saving change. Choose another time.';}
 }
 flow.question=FIELDS.find(field=>!flow.fields[field])||'confirm';
 if(flow.question==='confirm'){flow.end=new Date(Date.parse(flow.start)+flow.fields.duration*60000).toISOString();flow.confirmToken=flow.confirmToken||nonce();}
 else{flow.confirmToken=null;flow.end=null;}
 return note;
}
function prompt(flow,note=''){
 if(flow.question==='paste')return `${note?note+'\n\n':''}Paste the event message here. I will ask for any missing details, then show a confirmation. This draft expires in 30 minutes.\n${control}`;
 const f=flow.fields,lines=[note||'Let’s make the plan concrete.',`Activity: ${f.title||'still needed'}`,`Date: ${f.date||'still needed'} · New York`,`Start time: ${f.time||'still needed'}`,`Location: ${f.location||'still needed'}`,`Duration: ${f.duration?f.duration+' minutes':'still needed'}`];
 if(flow.question==='confirm')return `Review before saving:\n${f.title}\nStart: ${display(flow.start)}\nEnd: ${display(flow.end)}\nLocation: ${f.location}\nDuration: ${f.duration} minutes\n\n${dateNotice}\nReminders use your saved event settings. No invitations are sent.\n\nSave: /newevent confirm ${flow.confirmToken}\n${control}\nExpires: ${display(flow.expiresAt)}`;
 const questions={title:'What should the event be called?',date:'What is the exact date? Reply YYYY-MM-DD, including the year.',time:'What exact start time in New York? Include AM or PM, such as 7 pm, or use 19:00. “Tomorrow night” alone is not a time.',location:'Where will you meet? Give a room, venue, or online meeting location.',duration:'How long should it last? Reply with minutes, such as 60, or an explicit duration such as 2 hours.'};
 lines.push(questions[flow.question],dateNotice,control);return lines.join('\n\n');
}
const compact=(flow,status,extra={})=>({version:1,id:flow.id,status,revision:flow.revision+1,lastUpdateId:flow.lastUpdateId,createdAt:flow.createdAt,expiresAt:flow.expiresAt,...extra});

/** Drop expired unconfirmed source text; may also be called by the reminder worker's maintenance pass. */
export async function pruneExpiredNewEventFlow(store,{now=Date.now}={}){
 const flow=await store.get('settings',KEY);
 if(flow?.status==='draft'&&flow.expiresAt<=now())return store.compareAndSet('settings',KEY,flow,compact(flow,'expired',{lastReply:'Your event draft expired. Send /newevent to start again.'}));
 return false;
}

async function finishConfirmation(store,queue,flow,now){
 const at=new Date(flow.confirmedAt).toISOString(),eventId=idFor('telegram-new-event',store.userId,flow.id),f=flow.fields;
 const event={id:eventId,title:f.title,kind:'event',date:f.date,time:f.time,start:flow.start,end:flow.end,timezone:TZ,location:f.location,status:'approved',cancelled:false,evidence:`Student-pasted message (${new Date(flow.pastedAt).toISOString()}):\n${flow.sourceText}\n\nStudent-confirmed details: ${f.title}; ${flow.start} to ${flow.end}; ${f.location}; ${f.duration} minutes.`,evidenceVerified:false,sourceId:idFor('telegram-new-event-source',flow.id),sourceName:'Your Telegram event request',sourceType:'student-message',approvalMethod:'Student confirmed the complete event with a one-time Telegram draft token',reviewedAt:at,createdAt:at,updatedAt:at,warning:''};
 await store.putIfAbsent('events',eventId,event);
 await reconcileReminders(store,{now});
 let calendarTask=null,calendarError=null;
 if((await store.get('secrets','google'))?.refresh_token){
  try{const task=await queue.enqueue(store.userId,'google-sync',{eventIds:[eventId]},{idempotencyKey:`new-event-calendar:${eventId}`,retrySafe:false,maxAttempts:1});calendarTask={taskId:task.id};}
  catch{calendarError='The event is saved, but Google Calendar sync could not be queued. Retry sync from Connections.';}
 }
 const reply=`Saved to your BRB schedule: ${f.title}.\n${display(flow.start)} · ${f.location}\n${calendarTask?'Google Calendar sync queued.':calendarError||'Connect Google Calendar in BRB to sync.'}\nReminders follow your saved event settings. No invitations were sent.`;
 const completed=compact(flow,'complete',{eventId,confirmedTokenHash:idFor(flow.confirmToken),calendarTask,calendarError,lastReply:reply,completedAt:now()});
 await store.compareAndSet('settings',KEY,flow,completed);
 return reply;
}

/** Private-chat guided drafting. Source text is data; only an explicit current confirmation token can execute. */
export async function handleNewEventMessage(store,queue,msg,updateId,{now=Date.now}={}){
 if(!store?.userId||msg?.chat?.type!=='private'||typeof msg.text!=='string')return false;
 const text=msg.text.trim(),command=text.match(/^\/newevent(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/i);
 if(text.startsWith('/')&&!command)return false;
 if(command?.[1]&&command[1].toLowerCase()!==(process.env.TELEGRAM_BOT_USERNAME||'dabas_class_bot').toLowerCase())return false;
 const linked=await store.get('secrets','telegram');if(!linked?.chatId||String(linked.chatId)!==String(msg.chat.id))return false;
 if(!Number.isSafeInteger(updateId)||updateId<0)throw new Error('Invalid Telegram update ID');
 const args=(command?.[2]||'').trim();
 const demographics=await store.get('career','demographics');
 if(demographics?.questionnaire?.active&&!(command&&/^cancel\s*$/i.test(args))){
  if(!command)return false;
  await queue.enqueue(store.userId,'telegram-send',{text:'Finish or stop the optional questionnaire before starting an event draft. Use /demographics to resume or /demographics skip to stop it; then send /newevent.'},{idempotencyKey:`new-event-reply:${updateId}`,retrySafe:false,maxAttempts:1});return true;
 }
 const reply=async value=>{await queue.enqueue(store.userId,'telegram-send',{text:value},{idempotencyKey:`new-event-reply:${updateId}`,retrySafe:false,maxAttempts:1});return true;};
 if(command&&args==='help')return reply(help);
 for(let attempt=0;attempt<12;attempt++){
  const previous=await store.get('settings',KEY);
  if(previous?.status==='committing')return reply(await finishConfirmation(store,queue,previous,now));
  if(previous&&updateId<=previous.lastUpdateId)return reply(updateId===previous.lastUpdateId?previous.lastReply||'That event message was already handled. Send /newevent to see its status.':'That event message was already handled. Send /newevent to see its status.');
  if(!command&&previous?.status!=='draft')return false;
  if(previous?.status==='draft'&&previous.expiresAt<=now()){
   const expired=compact(previous,'expired',{lastUpdateId:updateId,lastReply:'Your event draft expired. Send /newevent to start again. The unconfirmed pasted text was removed.'});
   if(await store.compareAndSet('settings',KEY,previous,expired))return reply(expired.lastReply);continue;
  }
  let flow=previous?.status==='draft'?structuredClone(previous):null,message;
  if(command&&/^cancel\s*$/i.test(args)){
   if(!flow)return reply('There is no active event draft to cancel. Send /newevent to start one.');
   const cancelled=compact(flow,'cancelled',{lastUpdateId:updateId,lastReply:'Event draft cancelled. Its pasted text was removed; nothing was added to your calendar.'});
   if(await store.compareAndSet('settings',KEY,previous,cancelled))return reply(cancelled.lastReply);continue;
  }
  if(command&&/^confirm(?:\s|$)/i.test(args)){
   const token=args.split(/\s+/)[1];
   if(previous?.status==='complete'&&token&&idFor(token)===previous.confirmedTokenHash)return reply(previous.lastReply);
   if(!flow)return reply('No active event is ready to confirm. Send /newevent to start a draft.');
   const note=ready(flow,now);
   if(args.split(/\s+/).length!==2||flow.question!=='confirm'||token!==flow.confirmToken)message=prompt(flow,note||'Use the current confirmation command after reviewing every field.');
   else{
    flow={...flow,status:'committing',confirmedAt:now(),lastUpdateId:updateId,revision:flow.revision+1};
    if(await store.compareAndSet('settings',KEY,previous,flow))return reply(await finishConfirmation(store,queue,flow,now));continue;
   }
  }else if(command&&/^edit(?:\s|$)/i.test(args)){
   if(!flow)return reply('Start an event draft with /newevent before editing its details.');
   const edit=args.match(/^edit\s+(title|date|time|location|duration)\s+([\s\S]+)$/i);
   if(!edit)return reply(control);
   if(flow.question==='paste')return reply('Paste the event message first, then edit its proposed details.');
   const field=edit[1].toLowerCase();flow.fields[field]=fieldValue(field,edit[2],flow.anchorDate);flow.confirmToken=null;
   message=prompt(flow,ready(flow,now)||(!flow.fields[field]?`I need a clear ${field} before saving.`:''));
  }else if(!flow){
   if(!command)return false;
   flow={version:1,id:nonce(),status:'draft',revision:(previous?.revision||0)+1,createdAt:now(),expiresAt:now()+TTL,lastUpdateId:updateId,question:'paste',fields:Object.fromEntries(FIELDS.map(f=>[f,null])),sourceText:null,confirmToken:null};
   if(args){if(args.length>4000)return reply('Please paste an event message of 4,000 characters or fewer.');const parsed=parseNewEventText(args,{now});Object.assign(flow,parsed,{sourceText:clean(args),pastedAt:now()});message=prompt(flow,ready(flow,now));}else message=prompt(flow);
  }else if(command&&!args)message=prompt(flow,ready(flow,now));
  else if(flow.question==='paste'){
   const pasted=command?args:text;if(pasted.length>4000)return reply('Please paste an event message of 4,000 characters or fewer.');
   const parsed=parseNewEventText(pasted,{now});Object.assign(flow,parsed,{sourceText:clean(pasted),pastedAt:now()});message=prompt(flow,ready(flow,now));
  }else if(command)message=prompt(flow,'You already have an event draft. Edit it, or cancel before starting another.');
  else if(flow.question==='confirm')message=prompt(flow,ready(flow,now));
  else{
   const field=flow.question;flow.fields[field]=fieldValue(field,text,flow.anchorDate);flow.confirmToken=null;
   message=prompt(flow,ready(flow,now)||(!flow.fields[field]?`I need a clear ${field} before saving.`:''));
  }
  flow.lastUpdateId=updateId;flow.revision++;flow.lastReply=message;
  if(await store.compareAndSet('settings',KEY,previous,flow))return reply(message);
 }
 throw new HttpError(409,'Your event draft changed concurrently. Send /newevent to resume the current draft.');
}
