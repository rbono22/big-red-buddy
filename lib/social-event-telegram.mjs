import {createHash,randomBytes} from 'node:crypto';
import {HttpError} from './security.mjs';
import {eventApprovalVersion} from './event-version.mjs';
import {partifulRSVP} from './partiful-calendar.mjs';
import {lumaRSVP} from './luma-calendar.mjs';
import {validateTelegramReplyMarkup} from './telegram-delivery.mjs';
import {CALENDAR_SCOPE} from './auth.mjs';

const PROVIDERS={partiful:{name:'Partiful',url:partifulRSVP,register:'RSVP on Partiful'},luma:{name:'Luma',url:lumaRSVP,register:'Register on Luma'}};
const BUCKET='socialTelegramActions',DAY=86400000;
const clean=(value,max=160)=>String(value||'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,max);
export const socialTelegramBinding=cfg=>createHash('sha256').update(JSON.stringify([String(cfg?.chatId||''),cfg?.linkedAt||null])).digest('hex');

export async function socialSavedStatus(store,event){
  const saved=event.addedEventId?await store.get('events',event.addedEventId):null;
  return saved?.cancelled?'Source removed':saved?.status==='approved'?'Added to BRB schedule':saved?.status==='dismissed'?'Reminders off':saved?'Updated details need review':'Not added to BRB schedule';
}

/** A durable per-provider fence covers both text commands and button mutations. */
export async function reserveSocialMutation(store,provider,updateId,now){
  if(!PROVIDERS[provider]||typeof store.compareAndSet!=='function')throw new Error('Social planning requires a student-scoped CAS store.');
  for(let attempt=0;attempt<8;attempt++){
    const previous=await store.get('settings',`${provider}TelegramMutation`);
    const at=now(),previousAt=previous?.handledAt??previous?.reservedAt??(previous?.expiresAt?previous.expiresAt-5*60000:0);
    if(previous?.updateId>=updateId&&at>=previousAt&&at-previousAt<7*DAY)return {replayed:true,uncertain:previous.updateId===updateId&&previous.status==='handling'};
    if(previous?.status==='handling'&&previous.expiresAt>at)throw new HttpError(409,`A ${PROVIDERS[provider].name} plan is being saved. Check /${provider} and retry shortly.`);
    const next={updateId,status:'handling',reservedAt:at,expiresAt:at+5*60000};
    if(await store.compareAndSet('settings',`${provider}TelegramMutation`,previous,next))return next;
  }
  throw new HttpError(409,`Your plan changed concurrently. Check /${provider} and retry.`);
}

async function pruneActions(store,now){
  const rows=await store.all(BUCKET),live=rows.filter(row=>row.expiresAt>now).sort((a,b)=>b.createdAt-a.createdAt);
  for(const row of rows.filter(row=>row.expiresAt<=now).concat(live.slice(180)))await store.delete(BUCKET,row.id);
}

/** Read only the linked student's selected candidate; never expose action tokens to the web caller. */
export async function queueSocialEventCard(store,queue,provider,id,{idempotencyKey,now=Date.now}={}){
  const config=PROVIDERS[provider];
  if(!config||!store?.userId||typeof id!=='string'||!id||id.length>200)throw new HttpError(400,'Choose a Partiful or Luma event.');
  const linked=await store.get('secrets','telegram');
  if(!Number.isSafeInteger(Number(linked?.chatId))||Number(linked.chatId)<=0)throw new HttpError(400,'Link your private Telegram chat in Connections first.');
  const selection=await store.get('settings',`${provider}Calendar`),event=await store.get(`${provider}Events`,id);
  if(!selection?.calendarId||!event||event.sourceCalendarId!==selection.calendarId||event.status!=='available')throw new HttpError(404,'That event is not available in your selected calendar.');
  const instant=now(),validStart=Number.isFinite(Date.parse(event.start)),validEnd=Number.isFinite(Date.parse(event.end));
  if(validEnd&&Date.parse(event.end)<=instant)throw new HttpError(400,'This event has ended. Choose an upcoming event.');
  await pruneActions(store,instant);
  const link=config.url(event.rsvpUrl)||config.url(event.sourceUrl),keyboard=[];
  if(link)keyboard.push([{text:config.register,url:link}]);
  const status=await socialSavedStatus(store,event),canAdd=!event.allDay&&validStart&&validEnd&&Date.parse(event.end)>Date.parse(event.start)&&event.localIntent!=='declined'&&status!=='Added to BRB schedule';
  const writeGrant=await store.get('secrets','google'),canSync=!!writeGrant?.refresh_token&&String(writeGrant.scope||'').split(/\s+/).includes(CALENDAR_SCOPE);
  const button=async(action,label)=>{
    const nonce=randomBytes(16).toString('hex');
    await store.put(BUCKET,nonce,{id:nonce,provider,eventId:id,action,version:eventApprovalVersion(event),calendarId:selection.calendarId,chatId:String(linked.chatId),binding:socialTelegramBinding(linked),createdAt:instant,expiresAt:instant+DAY,status:'ready'});
    return {text:label,callback_data:`social:${nonce}`};
  };
  if(/^[a-f0-9]{32}$/.test(id)){
    if(canAdd)keyboard.push([await button('add',canSync?'Add to Google Calendar':'Save to BRB schedule')]);
    keyboard.push([await button('maybe','Maybe · local plan'),await button('decline','Decline · local plan')]);
  }
  const when=validStart&&!event.allDay?new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'}).format(new Date(event.start))+' New York time':`${clean(event.date,10)||'Date not published'} · all-day / time not published`;
  const text=[clean(event.title,180)||`${config.name} event`,when,clean(event.location,160)||`Location not published — check ${config.name}`,status,`Local plan: ${['going','maybe','declined'].includes(event.localIntent)?event.localIntent:'not set'}`,provider==='luma'?'Calendar and local-plan buttons do not register you, buy a ticket, or confirm admission. Register on Luma.':'Calendar and local-plan buttons do not submit an RSVP. RSVP on Partiful.','Buttons expire after 24 hours.'].join('\n');
  const replyMarkup=keyboard.length?validateTelegramReplyMarkup({inline_keyboard:keyboard}):undefined;
  const key=`social-card:${createHash('sha256').update(String(idempotencyKey||`${provider}:${randomBytes(16).toString('hex')}`)).digest('hex')}`;
  const result=await queue.enqueue(store.userId,'telegram-send',{text,expectedChatId:String(linked.chatId),...(replyMarkup?{replyMarkup}:{})},{idempotencyKey:key,retrySafe:false,maxAttempts:1});
  return {taskId:result.id};
}

/** Authenticate the private callback in the router before calling this function. */
export async function claimSocialEventAction(store,data,chatId,{now=Date.now}={}){
  if(typeof data!=='string'||!/^social:[a-f0-9]{32}$/.test(data))throw new HttpError(400,'This event button is invalid. Open a fresh event list.');
  const id=data.slice(7),row=await store.get(BUCKET,id),linked=await store.get('secrets','telegram');
  if(!row||row.expiresAt<=now()||row.chatId!==String(chatId)||row.binding!==socialTelegramBinding(linked))throw new HttpError(400,'This event button expired or your Telegram link changed. Send /partiful or /luma for fresh buttons.');
  if(row.status!=='ready')throw new HttpError(409,'This button was already used or its result is uncertain. Send a fresh event list to check your plan.');
  if(!PROVIDERS[row.provider]||!['add','maybe','decline'].includes(row.action))throw new HttpError(400,'Invalid event action.');
  const selection=await store.get('settings',`${row.provider}Calendar`),event=await store.get(`${row.provider}Events`,row.eventId);
  if(!event||event.status!=='available'||event.sourceCalendarId!==selection?.calendarId||selection.calendarId!==row.calendarId||eventApprovalVersion(event)!==row.version)throw new HttpError(409,`Event details or your plan changed. Send /${row.provider} and review a fresh card.`);
  if(event.end&&Date.parse(event.end)<=now())throw new HttpError(400,'This event has ended. Choose an upcoming event.');
  const next={...row,status:'handling',claimedAt:now()};
  if(!await store.compareAndSet(BUCKET,id,row,next))throw new HttpError(409,'This event button is already being handled. Check your event list.');
  return next;
}
export async function finishSocialEventAction(store,claim,{now=Date.now}={}){await store.compareAndSet(BUCKET,claim.id,claim,{...claim,status:'handled',handledAt:now()});}
