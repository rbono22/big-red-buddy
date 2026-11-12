import {createHash,randomBytes} from 'node:crypto';
import {idFor,localISO,TZ} from './domain.mjs';
import {HttpError} from './security.mjs';
import {CALENDAR_SCOPE} from './auth.mjs';
import {enrollmentAttachment,downloadTelegramEnrollment} from './telegram-files.mjs';
import {partifulRSVP,lumaRSVP} from './event-provider-links.mjs';
import {reconcileReminders} from './integrations.mjs';

const KEY='invitationFlow',ACTIONS='invitationActions',UPLOAD_TTL=15*60000,DRAFT_TTL=30*60000,COMMIT_TTL=24*60*60000;
const FIELDS=['title','date','time','location','duration'];
const nonce=()=>randomBytes(16).toString('hex');
const clean=(value,max=4000)=>String(value||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').trim().slice(0,max);
const fail=message=>{throw new HttpError(400,message);};
const emptyFields=()=>Object.fromEntries(FIELDS.map(field=>[field,null]));
const sameBinding=(flow,linked)=>String(flow?.chatId)===String(linked?.chatId)&&String(flow?.linkedAt||'')===String(linked?.linkedAt||'');
const finalStatus=status=>['complete','cancelled','expired','failed','routed'].includes(status);
const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const parts=value=>Object.fromEntries(formatter.formatToParts(new Date(value)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
const dateAt=value=>{const p=parts(value);return `${p.year}-${p.month}-${p.day}`;};
const display=value=>new Intl.DateTimeFormat('en-US',{timeZone:TZ,dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(`${value}T12:00:00Z`))&&new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)===value;
const eventLink=value=>{const link=partifulRSVP(value)||lumaRSVP(value);return link.replace('https://lu.ma/','https://luma.com/');};
const bot=()=>String(process.env.TELEGRAM_BOT_USERNAME||'dabas_class_bot').toLowerCase();
const website=()=>`${process.env.APP_ORIGIN||''}/#events`;

function fieldValue(field,value,{extracted=false}={}){
 const text=clean(value,4000);
 if(field==='title')return text.length>=2&&text.length<=240&&!/^(?:yes|no|ok|okay|sure|unknown|tbd)$/i.test(text)?text.replace(/\s+/g,' '):null;
 if(field==='location')return text.length>=2&&text.length<=300&&!/^(?:yes|no|ok|okay|sure|unknown|tbd|tba|there|campus|school)$/i.test(text)?text.replace(/\s+/g,' '):null;
 if(field==='date'){
  if(validDate(text))return text;
  const match=text.match(/^(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})$/i);
  if(!match)return null;
  const month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match[1].slice(0,3).toLowerCase())+1;
  const date=`${match[3]}-${String(month).padStart(2,'0')}-${match[2].padStart(2,'0')}`;
  return validDate(date)?date:null;
 }
 if(field==='time'){
  let match=text.toLowerCase().replace(/\s+(?:et|new york(?: time)?)$/,'').match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/);
  if(match){const hour=Number(match[1]),minute=Number(match[2]||0);if(hour<1||hour>12||minute>59)return null;return `${String(hour%12+(match[3]==='p'?12:0)).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;}
  if(/^noon$/i.test(text))return '12:00';
  if(/^midnight$/i.test(text))return '00:00';
  match=text.match(/^(\d{2}):(\d{2})(?:\s*(24h))?$/);
  return match&&Number(match[1])<24&&Number(match[2])<60&&(extracted||Number(match[1])>12||match[1][0]==='0'||match[3])?`${match[1]}:${match[2]}`:null;
 }
 if(field==='duration'){
  const match=text.toLowerCase().match(/^(\d{1,4})\s*(m|min|mins|minutes?|h|hr|hrs|hours?)?$/);
  if(!match)return null;const minutes=Number(match[1])*(match[2]?.startsWith('h')?60:1);
  return Number.isInteger(minutes)&&minutes>0&&minutes<=1440?minutes:null;
 }
 return null;
}

function updateQuestion(flow,now){
 let note='';flow.start=null;flow.end=null;
 if(flow.fields.date&&flow.fields.date<dateAt(now())){flow.fields.date=null;note='That date has passed. What future date should I use?';}
 if(flow.fields.date&&flow.fields.time){
  try{
   const start=localISO(flow.fields.date,flow.fields.time),stamp=Date.parse(start);
   for(const offset of [-3600000,3600000]){const p=parts(stamp+offset);if(`${p.year}-${p.month}-${p.day}`===flow.fields.date&&`${p.hour}:${p.minute}`===flow.fields.time)throw new Error('ambiguous');}
   if(stamp<=now()){flow.fields.time=null;note='That start time has passed. Enter the intended future time or edit the date.';}
   else flow.start=start;
  }catch(error){flow.fields.time=null;note=error.message==='ambiguous'?'That New York time occurs twice when daylight saving ends. Choose an unambiguous start time.':'That New York time does not exist during the daylight-saving change. Choose another time.';}
 }
 flow.question=FIELDS.find(field=>!flow.fields[field])||'confirm';
 if(flow.question==='confirm')flow.end=new Date(Date.parse(flow.start)+flow.fields.duration*60000).toISOString();
 return note;
}
const compact=(flow,status,extra={})=>({version:1,id:flow.id,revision:flow.revision+1,status,chatId:flow.chatId,linkedAt:flow.linkedAt,createdAt:flow.createdAt,expiresAt:flow.expiresAt,lastUpdateId:flow.lastUpdateId,fileFingerprint:flow.fileFingerprint,...extra});
async function activeBinding(store,flow){
 const [linked,account]=await Promise.all([store.get('secrets','telegram'),store.get('settings','account')]);
 return !!linked?.chatId&&sameBinding(flow,linked)&&!account?.deleting;
}
async function currentFlow(store,flow,{now=Date.now,allowFinal=false}={}){
 const current=await store.get('settings',KEY);
 return current?.id===flow.id&&current.revision===flow.revision&&(allowFinal||current.expiresAt>now())&&await activeBinding(store,current)?current:null;
}
async function pruneActions(store,now){
 const rows=await store.all(ACTIONS),live=rows.filter(row=>row.expiresAt>now).sort((a,b)=>b.createdAt-a.createdAt);
 for(const row of rows.filter(row=>row.expiresAt<=now).concat(live.slice(100)))await store.delete(ACTIONS,row.id);
}
export async function pruneExpiredInvitationFlow(store,{now=Date.now}={}){
 const flow=await store.get('settings',KEY);let changed=false;
 if(flow?.status==='committing'){
  const started=Number.isFinite(flow.confirmedAt)?flow.confirmedAt:Number.isFinite(flow.createdAt)?flow.createdAt:0;
  if(started+COMMIT_TTL<=now()){
   const candidate=flow.eventId||idFor('telegram-invitation',store.userId,flow.imageHash||flow.fileFingerprint||flow.id),saved=await store.get('events',candidate);
   changed=await store.compareAndSet('settings',KEY,flow,compact(flow,'failed',{...(saved?.id||flow.eventId?{eventId:saved?.id||flow.eventId}:{}),lastReply:'Saving was interrupted. Check your Events and Google Calendar sync before retrying; part of the save may already have completed.'}));
   if(changed)for(const action of await store.all(ACTIONS))if(action.flowId===flow.id)await store.delete(ACTIONS,action.id);
  }
 }else if(flow&&!finalStatus(flow.status)&&flow.expiresAt<=now())changed=await store.compareAndSet('settings',KEY,flow,compact(flow,'expired',{lastReply:'That invitation draft expired. Send the screenshot again or use /invite.'}));
 await pruneActions(store,now());return changed;
}
async function send(store,queue,flow,text,key,replyMarkup){
 if(!await activeBinding(store,flow))return false;
 await queue.enqueue(store.userId,'telegram-send',{text:clean(text,3800),expectedChatId:String(flow.chatId),expectedTelegramLinkedAt:String(flow.linkedAt||''),invitationFlowId:flow.id,invitationRevision:flow.revision,...(replyMarkup?{replyMarkup}:{})},{idempotencyKey:`invitation-reply:${key}`,retrySafe:false,maxAttempts:1});
 return true;
}
async function card(store,queue,flow,key,{now=Date.now,note=''}={}){
 if(!await currentFlow(store,flow,{now,allowFinal:finalStatus(flow.status)}))return true;
 await pruneActions(store,now());const keyboard=[];
 const button=async(action,text)=>{
  const id=nonce();await store.put(ACTIONS,id,{id,flowId:flow.id,revision:flow.revision,action,chatId:flow.chatId,linkedAt:flow.linkedAt,createdAt:now(),expiresAt:flow.expiresAt,status:'ready'});
  return {text,callback_data:`invite:${id}`};
 };
 let text=note;
 if(flow.status==='choosing'){
  text='What is this screenshot? Choose one so I read it the right way.';
  keyboard.push([await button('invitation','Event invitation')],[await button('enrollment','Class schedule'),await button('syllabus','Syllabus')]);
 }else if(flow.status==='term'){
  text=`Which term is this ${flow.route==='syllabus'?'syllabus':'class schedule'} for?`;
  keyboard.push([await button('term:FA26','Fall 2026'),await button('term:SP27','Spring 2027')]);
 }else if(flow.status==='awaiting-file')text='Send a clear screenshot or photo of the invitation. Include its name, date, time, location, and a readable Partiful or Luma URL if available. I’ll ask for missing details, then you can tap Add to Google Calendar. Send one event at a time. Telegram also processes the image you send.';
 else if(flow.status==='processing')text=note||'Reading your invitation. I’ll send the details to review before adding anything.';
 else if(flow.status==='draft'){
  const f=flow.fields,labels={title:'Event',date:'Date',time:'Start',location:'Location',duration:'Length'};
  const details=FIELDS.map(field=>`${labels[field]}: ${f[field]||'Needed'}${field==='time'?' · New York':field==='duration'&&f[field]?' minutes':''}`).join('\n');
  const questions={title:'What is the event called?',date:'What is the full date? For example, Nov 13 2026 or 2026-11-13.',time:'What time does it start in New York? For example, 7 pm or 19:00.',location:'Where is it? Reply with the venue, room, or meeting location.',duration:'How long should I put it on your calendar? Reply 60 minutes or 2 hours.'};
  text=[note,flow.question==='confirm'?'Ready to add? Check the details below.':'Let’s fill in the missing details.',details,flow.question==='confirm'?`Ends: ${display(flow.end)} · New York`:questions[flow.question],...(flow.warnings||[]).slice(0,2),flow.rsvpUrl?'Adding to your calendar does not register you. Use the RSVP link to finish registration.':'A screenshot cannot reveal a hidden link behind “RSVP”. Send /invite followed by the copied event URL, for example /invite https://luma.com/your-event, to attach it.'].filter(Boolean).join('\n\n');
  if(flow.question==='confirm'){
   const grant=await store.get('secrets','google'),canSync=!!grant?.refresh_token&&String(grant.scope||'').split(/\s+/).includes(CALENDAR_SCOPE);
   keyboard.push([await button('confirm',canSync?'Add to Google Calendar':'Save to BRB schedule')]);
  }else if(flow.question==='duration')keyboard.push([await button('value:duration:60','1 hour'),await button('value:duration:120','2 hours')]);
  else if(flow.question==='location')keyboard.push([await button('value:location:Not specified','Location not provided')]);
  keyboard.push([await button('edit:title','Edit name'),await button('edit:date','Edit date'),await button('edit:time','Edit time')],[await button('edit:location','Edit location'),await button('edit:duration','Edit length')]);
  if(flow.rsvpUrl)keyboard.push([{text:flow.provider==='partiful'?'RSVP on Partiful':'Open event / register',url:flow.rsvpUrl}]);
 }else text=flow.lastReply||note||'Send /invite to add another invitation.';
 if(!finalStatus(flow.status)&&flow.status!=='committing')keyboard.push([await button('cancel','Cancel')]);
 return send(store,queue,flow,text,key,keyboard.length?{inline_keyboard:keyboard}:undefined);
}

async function cancelFlow(store,flow,updateId,status='cancelled'){
 const next=compact(flow,status,{lastUpdateId:Math.max(flow.lastUpdateId||0,updateId),lastReply:status==='expired'?'That invitation draft expired. Send the screenshot again.':'Cancelled. The unconfirmed screenshot details were removed; no new calendar event was added.'});
 return await store.compareAndSet('settings',KEY,flow,next)?next:null;
}
async function clearOtherUploads(store){for(const key of ['syllabusUpload','careerUpload','enrollmentUpload'])await store.delete('settings',key);}
async function clearTypedEventDraft(store){
 const flow=await store.get('settings','newEventFlow');
 if(flow?.status==='committing')fail('Your earlier event is being saved. Wait briefly, then send this invitation.');
 if(flow&&!finalStatus(flow.status))await store.compareAndSet('settings','newEventFlow',flow,{id:flow.id,revision:(flow.revision||0)+1,status:'cancelled',lastUpdateId:flow.lastUpdateId,createdAt:flow.createdAt,expiresAt:flow.expiresAt,lastReply:'Switched to an invitation screenshot. The previous unconfirmed draft was removed.'});
}
function attachment(msg){
 let file;try{file=enrollmentAttachment(msg);}catch{throw new HttpError(400,'Send the invitation as a JPEG, PNG, or PDF smaller than 12 MB.');}if(!file)return null;
 return {...file,name:msg.photo?'Telegram invitation screenshot.jpg':file.name,fileFingerprint:idFor('telegram-file',msg.document?.file_unique_id||msg.photo?.find(photo=>photo.file_id===file.fileId)?.file_unique_id||file.fileId)};
}
async function queueUpload(store,queue,flow,key,{now=Date.now}={}){
 if(!flow.file)return card(store,queue,flow,key,{now});
 if(!await currentFlow(store,flow,{now}))return true;
 const payload={flowId:flow.id,revision:flow.revision,expectedChatId:String(flow.chatId),expectedTelegramLinkedAt:String(flow.linkedAt||''),fileId:flow.file.fileId,mimeType:flow.file.mimeType,name:flow.file.name,caption:flow.caption||''};
 try{await queue.enqueue(store.userId,'telegram-invitation',payload,{idempotencyKey:`invitation-upload:${flow.id}`,retrySafe:false,maxAttempts:1});}
 catch{throw new HttpError(429,'The processing queue is busy. Send the same screenshot again in a moment to retry.');}
 return card(store,queue,flow,key,{now});
}
async function newFlow(store,queue,linked,file,caption,updateId,status,{now=Date.now}={}){
 for(let attempt=0;attempt<10;attempt++){
  const previous=await store.get('settings',KEY);
  if(previous&&updateId<=previous.lastUpdateId)return true;
  if(previous?.status==='committing')fail('Your earlier event is being saved. Wait briefly, then send the next screenshot.');
  if(file&&previous?.fileFingerprint===file.fileFingerprint&&sameBinding(previous,linked)&&previous.expiresAt>now()&&!['cancelled','expired','failed','routed'].includes(previous.status))return previous.status==='processing'?queueUpload(store,queue,previous,`repeat:${updateId}`,{now}):card(store,queue,previous,`repeat:${updateId}`,{now,note:'This screenshot is already being handled.'});
  const flow={version:1,id:nonce(),revision:(previous?.revision||0)+1,status,chatId:String(linked.chatId),linkedAt:String(linked.linkedAt||''),createdAt:now(),expiresAt:now()+UPLOAD_TTL,lastUpdateId:updateId,...(file?{file:{fileId:file.fileId,mimeType:file.mimeType,name:file.name},fileFingerprint:file.fileFingerprint,caption:clean(caption,1500)}:{})};
  if(await store.compareAndSet('settings',KEY,previous,flow))return status==='processing'?queueUpload(store,queue,flow,`start:${updateId}`,{now}):card(store,queue,flow,`start:${updateId}`,{now});
 }
 throw new HttpError(409,'Your upload changed while I was reading it. Send /invite to see the latest draft.');
}

/** Runs before the academic/resume file handlers; explicit commands retain priority. */
export async function handleInvitationMessage(store,queue,msg,updateId,{now=Date.now}={}){
 if(!store?.userId||msg?.chat?.type!=='private')return false;
 const linked=await store.get('secrets','telegram');if(!linked?.chatId||String(linked.chatId)!==String(msg.chat.id)||(await store.get('settings','account'))?.deleting)return false;
 if(!Number.isSafeInteger(updateId)||updateId<0)throw new Error('Invalid Telegram update ID');
 const text=String(msg.text||msg.caption||'').trim(),command=text.match(/^\/(\w+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/),cmd=command?.[1]?.toLowerCase(),args=(command?.[3]||'').trim(),hasFile=!!(msg.photo?.length||msg.document);
 if(command?.[2]&&command[2].toLowerCase()!==bot())return false;
 let flow=await store.get('settings',KEY);
 if(command&&cmd!=='invite'){
  if(['syllabus','enrollment','resume_upload','newevent'].includes(cmd)&&flow&&!finalStatus(flow.status)&&flow.status!=='committing')await cancelFlow(store,flow,updateId);
  return false;
 }
 const demographics=await store.get('career','demographics');
 if(demographics?.questionnaire?.active||demographics?.questionnaire?.telegramSessionActive){
  if(cmd!=='invite'&&!hasFile)return false;
  const context=flow&&sameBinding(flow,linked)?flow:{id:'demographics',revision:0,chatId:String(linked.chatId),linkedAt:String(linked.linkedAt||'')};
  await send(store,queue,context,'Finish or close the optional demographics setup before sending an event screenshot. Use /demographics to return to those choices.',`demographics:${updateId}`);return true;
 }
 if(flow&&!sameBinding(flow,linked))flow=null;
 if(flow&&!finalStatus(flow.status)&&flow.status!=='committing'&&flow.expiresAt<=now()){
  const expired=await cancelFlow(store,flow,updateId,'expired');if(expired)flow=expired;
 }
 if(cmd==='invite'&&/^cancel$/i.test(args)){
  if(flow&&flow.status!=='committing'){const cancelled=await cancelFlow(store,flow,updateId);if(cancelled)return card(store,queue,cancelled,`cancel:${updateId}`,{now});}
  return true;
 }
 const captionInvite=hasFile&&!command&&/^(?:invite|invitation|event|luma|partiful)\b/i.test(text);
 if(cmd==='invite'||captionInvite){
  if(flow&&updateId<=flow.lastUpdateId)return true;
  await clearTypedEventDraft(store);
  await clearOtherUploads(store);
  if(!hasFile&&flow?.status==='draft'){
   const url=eventLink(args);
   if(url){const next={...flow,rsvpUrl:url,provider:url.includes('partiful.com')?'partiful':'luma',revision:flow.revision+1,lastUpdateId:updateId};if(await store.compareAndSet('settings',KEY,flow,next))return card(store,queue,next,`link:${updateId}`,{now});return true;}
   return card(store,queue,flow,`status:${updateId}`,{now});
  }
  return newFlow(store,queue,linked,hasFile?attachment(msg):null,command?args:text,updateId,hasFile?'processing':'awaiting-file',{now});
 }
 if(hasFile){
  const other=await Promise.all(['syllabusUpload','careerUpload','enrollmentUpload'].map(key=>store.get('settings',key)));
  if(other.some((mode,index)=>mode?.expiresAt>now()||mode?.uploadUpdateId===updateId||(index<2&&mode?.expiresAt&&mode.expiresAt<=now()))||/\b(?:FA26|SP27)\b/i.test(text))return false;
  const isImage=!!msg.photo?.length||['image/jpeg','image/png'].includes(msg.document?.mime_type);
  if(flow?.status==='awaiting-file'||flow?.status==='draft'||flow?.status==='processing')return newFlow(store,queue,linked,attachment(msg),text,updateId,'processing',{now});
  if(isImage)return newFlow(store,queue,linked,attachment(msg),text,updateId,'choosing',{now});
  return false;
 }
 if(!flow)return false;
 if(updateId<=flow.lastUpdateId)return true;
 if(flow.status==='committing')return finishConfirmation(store,queue,flow,`resume:${updateId}`,{now});
 if(finalStatus(flow.status))return false;
 if(flow.status!=='draft')return card(store,queue,flow,`status:${updateId}`,{now});
 if(flow.question==='confirm')return card(store,queue,flow,`confirm-prompt:${updateId}`,{now,note:'Tap the Add / Save button after checking the details.'});
 const next=structuredClone(flow),field=next.question;next.fields[field]=fieldValue(field,text);next.lastUpdateId=updateId;next.revision++;
 const note=updateQuestion(next,now)||(!next.fields[field]?`I couldn’t use that ${field}. Please try again.`:'');
 if(await store.compareAndSet('settings',KEY,flow,next))return card(store,queue,next,`answer:${updateId}`,{now,note});
 throw new HttpError(409,'Your invitation changed. Send /invite to see the current details.');
}

async function finishConfirmation(store,queue,flow,key,{now=Date.now}={}){
 if(!await currentFlow(store,flow,{now,allowFinal:true}))return true;
 const f=flow.fields,existing=flow.rsvpUrl?(await store.all('events')).find(event=>[event.rsvpUrl,event.sourceUrl,event.url].some(url=>eventLink(url||'')===flow.rsvpUrl)):null;
 const eventId=existing?.id||idFor('telegram-invitation',store.userId,flow.imageHash||flow.fileFingerprint||flow.id);
 let saved=existing||await store.get('events',eventId),calendarTask=null,calendarError=null;
 if(saved&&(saved.status!=='approved'||saved.cancelled||saved.localIntent==='declined')){
  const completed=compact(flow,'complete',{eventId,lastReply:`This event already exists in BRB and needs review. I have not re-added or changed it. Open Events to review it: ${website()}`});
  if(await store.compareAndSet('settings',KEY,flow,completed))return card(store,queue,completed,key,{now});return true;
 }
 if(!saved){
  if(!await currentFlow(store,flow,{now,allowFinal:true}))return true;
  const at=new Date(now()).toISOString(),event={id:eventId,title:f.title,kind:'event',date:f.date,time:f.time,start:flow.start,end:flow.end,timezone:TZ,location:f.location==='Not specified'?'':f.location,status:'approved',cancelled:false,evidence:clean(`Screenshot details: ${flow.sourceText||'Details supplied by the student.'}\nStudent-confirmed: ${f.title}; ${flow.start} to ${flow.end}; ${f.location}; ${f.duration} minutes.`,4300),evidenceVerified:false,sourceId:idFor('telegram-invitation-source',flow.imageHash||flow.id),sourceName:'Telegram invitation screenshot',sourceType:'invitation-screenshot',connector:'telegram-invitation',sourceProvider:flow.provider||'telegram',rsvpUrl:flow.rsvpUrl||'',sourceUrl:flow.rsvpUrl||'',approvalMethod:'Student confirmed the complete invitation using a bound Telegram button',reviewedAt:at,createdAt:at,updatedAt:at,warning:'Calendar entry only; complete any RSVP or registration on the event website.'};
  await store.putIfAbsent('events',eventId,event);saved=await store.get('events',eventId);
 }
 if(!await currentFlow(store,flow,{now,allowFinal:true}))return true;
 await reconcileReminders(store,{now});
 if(!await currentFlow(store,flow,{now,allowFinal:true}))return true;
 const grant=await store.get('secrets','google');
 if(!await currentFlow(store,flow,{now,allowFinal:true}))return true;
 if(grant?.refresh_token&&String(grant.scope||'').split(/\s+/).includes(CALENDAR_SCOPE)){
  try{const task=await queue.enqueue(store.userId,'google-sync',{eventIds:[eventId]},{idempotencyKey:`invitation-calendar:${eventId}`,retrySafe:false,maxAttempts:1});calendarTask={taskId:task.id};}
  catch{calendarError='Saved in BRB, but Google sync could not be queued. Retry from Connections.';}
 }
 const reply=[existing?'This event is already in your BRB schedule; I kept its saved details.':`Saved to your BRB schedule: ${saved.title}`,Number.isFinite(Date.parse(saved.start))?`${display(saved.start)} · New York`:'Check its saved date in Events.',saved.location||'Location not specified',calendarTask?'Google Calendar sync queued.':calendarError||'Connect Google Calendar in BRB, then sync reviewed items.','Reminders use your event settings. You still need to RSVP or register with the host.',flow.rsvpUrl||''].filter(Boolean).join('\n');
 const completed=compact(flow,'complete',{eventId,calendarTask,calendarError,lastReply:reply,completedAt:now()});
 if(await store.compareAndSet('settings',KEY,flow,completed))return card(store,queue,completed,key,{now});return true;
}

/** The global router also authenticates the private sender and current pilot membership. */
export async function handleInvitationCallback(store,queue,query,updateId,{now=Date.now}={}){
 if(typeof query?.data!=='string'||!/^invite:[a-f0-9]{32}$/.test(query.data))return false;
 if(!Number.isSafeInteger(updateId)||updateId<0)throw new Error('Invalid Telegram update ID');
 const chat=query.message?.chat,linked=await store.get('secrets','telegram');
 if(chat?.type!=='private'||query.from?.is_bot||String(query.from?.id)!==String(chat.id)||!linked?.chatId||String(linked.chatId)!==String(chat.id))return false;
 const action=await store.get(ACTIONS,query.data.slice(7)),flow=await store.get('settings',KEY);
 if(!action||!flow||action.flowId!==flow.id||!sameBinding(action,linked)||!sameBinding(flow,linked)||!await activeBinding(store,flow)||action.expiresAt<=now())fail('That invitation button expired or your Telegram link changed. Send /invite or the screenshot again.');
 if(['handling','handled'].includes(action.status)&&action.updateId===updateId&&action.action==='confirm'&&flow.status==='committing'&&flow.confirmationActionId===action.id)return finishConfirmation(store,queue,flow,`callback:${updateId}`,{now});
 if(action.status!=='ready'||action.revision!==flow.revision||updateId<=flow.lastUpdateId)fail('Those invitation details changed or that button was already used. Send /invite for the current review.');
 if(flow.expiresAt<=now()){await pruneExpiredInvitationFlow(store,{now});fail('Your invitation draft expired. Send the screenshot again.');}
 const claimed={...action,status:'handling',updateId};if(!await store.compareAndSet(ACTIONS,action.id,action,claimed))fail('That invitation action is already being handled.');
 try{
  if(action.action==='cancel'){const next=await cancelFlow(store,flow,updateId);if(next)return card(store,queue,next,`callback:${updateId}`,{now});fail('Your invitation changed. Send /invite.');}
  const next=structuredClone(flow);next.revision++;next.lastUpdateId=updateId;
  if(action.action==='invitation'&&flow.status==='choosing'){
   await clearTypedEventDraft(store);
   next.status='processing';if(!await store.compareAndSet('settings',KEY,flow,next))fail('Your upload changed. Send the screenshot again.');
   await clearOtherUploads(store);return queueUpload(store,queue,next,`callback:${updateId}`,{now});
  }
  if(['enrollment','syllabus'].includes(action.action)&&flow.status==='choosing'){
   next.status='term';next.route=action.action;if(!await store.compareAndSet('settings',KEY,flow,next))fail('Your upload changed. Send it again.');return card(store,queue,next,`callback:${updateId}`,{now});
  }
  if(/^term:(FA26|SP27)$/.test(action.action)&&flow.status==='term'){
   const term=action.action.slice(5),route=flow.route;
   if(!['enrollment','syllabus'].includes(route)||!flow.file)fail('Upload the document again.');
   const routed=compact(next,'routed',{lastReply:`Reading your ${route==='syllabus'?'syllabus deadlines':'class schedule'} for ${term}. I’ll send the results for review.`});
   if(!await store.compareAndSet('settings',KEY,flow,routed))fail('Your document changed. Upload again.');
   await clearOtherUploads(store);
   await store.put('settings',route==='syllabus'?'syllabusUpload':'enrollmentUpload',{term,expiresAt:now()+UPLOAD_TTL});
   if(route==='enrollment')await store.put('settings','enrollmentTerm',{term});
   await queue.enqueue(store.userId,route==='syllabus'?'telegram-syllabus':'telegram-enrollment',{...flow.file,term,expectedChatId:String(flow.chatId),expectedTelegramLinkedAt:String(flow.linkedAt||'')},{idempotencyKey:`invitation-document:${flow.id}`,retrySafe:false,maxAttempts:1});
   return card(store,queue,routed,`callback:${updateId}`,{now});
  }
  if(flow.status!=='draft')fail('That action is not available for this upload. Send /invite to continue.');
  if(action.action==='confirm'){
   const note=updateQuestion(next,now);
   if(next.question!=='confirm'){if(!await store.compareAndSet('settings',KEY,flow,next))fail('The invitation changed. Send /invite.');return card(store,queue,next,`callback:${updateId}`,{now,note});}
   next.status='committing';next.confirmedAt=now();next.confirmationActionId=action.id;
   if(!await store.compareAndSet('settings',KEY,flow,next))fail('The invitation changed. Review it again.');return finishConfirmation(store,queue,next,`callback:${updateId}`,{now});
  }
  if(action.action.startsWith('edit:')&&FIELDS.includes(action.action.slice(5))){next.question=action.action.slice(5);next.fields[next.question]=null;next.start=null;next.end=null;}
  else if(action.action==='value:duration:60'||action.action==='value:duration:120'){next.fields.duration=Number(action.action.split(':')[2]);updateQuestion(next,now);}
  else if(action.action==='value:location:Not specified'){next.fields.location='Not specified';updateQuestion(next,now);}
  else fail('That invitation action is unavailable.');
  if(!await store.compareAndSet('settings',KEY,flow,next))fail('The invitation changed. Review it again.');return card(store,queue,next,`callback:${updateId}`,{now});
 }finally{await store.compareAndSet(ACTIONS,action.id,claimed,{...claimed,status:'handled',handledAt:now()});}
}

/** Worker-bound OCR; no screenshot bytes are stored in student records or sent to a hosted model. */
export async function processInvitationUpload(store,queue,payload,{download=downloadTelegramEnrollment,extract=async(input,options)=>(await import('./invitation-extraction.mjs')).extractInvitationScreenshot(input,options),now=Date.now,assertAccess=async()=>true}={}){
 const flow=await store.get('settings',KEY);
 if(!flow||flow.status!=='processing'||flow.id!==payload?.flowId||flow.revision!==payload.revision||String(flow.chatId)!==String(payload.expectedChatId)||String(flow.linkedAt||'')!==String(payload.expectedTelegramLinkedAt||'')||flow.file?.fileId!==payload.fileId||!await currentFlow(store,flow,{now})||!await assertAccess())return {superseded:true};
 try{
  const buffer=await download(flow.file.fileId);
  if(!await currentFlow(store,flow,{now})||!await assertAccess())return {superseded:true};
  const imageHash=createHash('sha256').update(buffer).digest('hex');
  const result=await extract({buffer,mimeType:flow.file.mimeType,name:flow.file.name,caption:flow.caption||''},{now});
  if(!await currentFlow(store,flow,{now})||!await assertAccess())return {superseded:true};
  const fields=Object.fromEntries(FIELDS.map(field=>[field,fieldValue(field,result?.fields?.[field],{extracted:true})]));
  const rsvpUrl=eventLink(result?.rsvpUrl||''),next={version:1,id:flow.id,revision:flow.revision+1,status:'draft',chatId:flow.chatId,linkedAt:flow.linkedAt,createdAt:flow.createdAt,expiresAt:now()+DRAFT_TTL,lastUpdateId:flow.lastUpdateId,fileFingerprint:flow.fileFingerprint,imageHash,fields,rsvpUrl,provider:rsvpUrl.includes('partiful.com')?'partiful':rsvpUrl?'luma':null,sourceText:clean(result?.sourceText,4000),method:clean(result?.method,120),warnings:Array.isArray(result?.warnings)?result.warnings.slice(0,3).map(w=>clean(w,220)):[]};
  const note=updateQuestion(next,now);
  if(!await assertAccess())return {superseded:true};
  if(!await store.compareAndSet('settings',KEY,flow,next))return {superseded:true};
  if(!await assertAccess())return {superseded:true};
  await card(store,queue,next,`extracted:${flow.id}`,{now,note});return {ready:true,missing:FIELDS.filter(field=>!fields[field])};
 }catch(error){
  if(!await currentFlow(store,flow,{now})||!await assertAccess())return {superseded:true};
  const failed=compact(flow,'failed',{lastReply:'I couldn’t read that invitation. Send a clearer screenshot with the event details, or use /newevent to type them. Nothing was added to your calendar.'});
  if(await store.compareAndSet('settings',KEY,flow,failed))await card(store,queue,failed,`error:${flow.id}`,{now});
  throw new HttpError(400,'Invitation screenshot processing failed. Send a clearer image.');
 }
}
