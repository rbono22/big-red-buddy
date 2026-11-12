import {addLumaEvent,lumaRSVP,saveLumaIntent} from './luma-calendar.mjs';
import {HttpError} from './security.mjs';
import {queueSocialEventCard,socialSavedStatus,reserveSocialMutation} from './social-event-telegram.mjs';

const clean=(value,max=120)=>String(value||'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,max);
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9._:-]{1,200}$/.test(value);
const help='Luma planning:\n/luma — upcoming events from your selected calendar\n/luma going ID\n/luma maybe ID\n/luma decline ID\n/luma add ID — add to your BRB schedule\n\nGoing, maybe, and decline save a local planning preference only. Open Luma to register or RSVP and check approval or tickets. A calendar entry may be waitlisted or pending; adding it does not register you.';
const localDate=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms));
function upcoming(event,now){
 if(event.start&&Number.isFinite(Date.parse(event.start)))return Date.parse(event.end||event.start)>now;
 const today=localDate(now);
 return /^\d{4}-\d{2}-\d{2}$/.test(event.date||'')&&(event.date>=today||(/^\d{4}-\d{2}-\d{2}$/.test(event.endDate||'')&&event.endDate>today));
}
function when(event){
 if(!event.allDay&&event.start&&Number.isFinite(Date.parse(event.start)))return new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',dateStyle:'medium',timeStyle:'short'}).format(new Date(event.start))+' New York time';
 return `${clean(event.date,10)||'Date not published'} · all-day / time not published`;
}

// A durable high-water mark prevents an old command from undoing a later plan
// or approving a subsequently changed event. Interrupted mutations need a fresh
// user command, rather than guessing whether the earlier action completed.

/** Deterministic commands on the caller's linked private chat; no Luma API calls or model access. */
export async function handleLumaMessage(store,queue,msg,updateId,{now=Date.now,expectedVersion}={}){
 const match=String(msg?.text||'').trim().match(/^\/luma(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/i);
 if(!match||!store?.userId||msg.chat?.type!=='private')return false;
 if(match[1]&&match[1].toLowerCase()!==(process.env.TELEGRAM_BOT_USERNAME||'dabas_class_bot').toLowerCase())return false;
 const linked=await store.get('secrets','telegram');
 if(!linked?.chatId||String(linked.chatId)!==String(msg.chat.id))return false;
 if(!Number.isSafeInteger(updateId)||updateId<0)throw new Error('Invalid Telegram update ID');
 const reply=async text=>{await queue.enqueue(store.userId,'telegram-send',{text},{idempotencyKey:`luma-command:${updateId}`,retrySafe:false,maxAttempts:1});return true;};
 const args=(match[2]||'').trim(),parts=args.split(/\s+/),action=parts[0]?.toLowerCase();
 if(action==='help')return reply(help);
 if(args.length>240||(!['','list','going','maybe','decline','add'].includes(action)))return reply(help);
 const settings=await store.get('settings','lumaCalendar');
 if(!settings?.calendarId)return reply('Choose a subscribed Luma calendar in Events first. BRB uses only the calendar you select.\n'+help);
 if(!args||action==='list'){
  if(parts.length>1)return reply(help);
  const events=(await store.all('lumaEvents')).filter(e=>e.sourceCalendarId===settings.calendarId&&e.status==='available'&&validId(e.id)&&upcoming(e,now())).sort((a,b)=>String(a.start||a.date||'').localeCompare(String(b.start||b.date||''))).slice(0,5);
  const lines=['Your Luma events (up to 5). Use the event buttons below. Planning preferences are local. A feed entry may be pending or waitlisted; confirm registration, approval, and tickets on Luma.'];
  if(!events.length)lines.push('No upcoming events are saved from your selected calendar. Check source freshness in Events.');
  for(const event of events){
   const link=lumaRSVP(event.rsvpUrl)||lumaRSVP(event.sourceUrl),intent=['going','maybe','declined'].includes(event.localIntent)?event.localIntent:'not set';
   lines.push(`${clean(event.title,80)||'Untitled event'}\n${when(event)}\n${clean(event.location,80)||'Location not published — check Luma'}\nID: ${event.id}\nLocal preference: ${intent} · ${await socialSavedStatus(store,event)}${link?'\n'+link:'\nLuma link unavailable — open the original invitation.'}`);
  }
  lines.push('Use /luma going ID, /luma maybe ID, or /luma decline ID for your local plan. Use /luma add ID separately for calendar reminders. Neither action registers you, buys a ticket, or confirms admission. Finish on Luma.');
  // Keep complete event IDs and the RSVP distinction; never truncate the final disclosure.
  while(lines.join('\n\n').length>3900&&lines.length>2)lines.splice(lines.length-2,1);
  await reply(lines.join('\n\n'));
  for(const event of events)await queueSocialEventCard(store,queue,'luma',event.id,{idempotencyKey:`luma-card:${updateId}:${event.id}`,now});
  return true;
 }
 if(parts.length!==2||!validId(parts[1]))return reply(help);
 const id=parts[1],event=await store.get('lumaEvents',id);
 if(!event||event.sourceCalendarId!==settings.calendarId||event.status!=='available')throw new HttpError(404,'That Luma event is not available in your selected calendar. Send /luma for your events.');
 const reservation=await reserveSocialMutation(store,'luma',updateId,now);
 if(reservation.replayed)return reply(reservation.uncertain?'This Luma planning command was interrupted or is still being saved; its outcome is uncertain. Check /luma before changing anything. After five minutes, send a fresh command if the change is still needed.':'This Luma planning command was already handled or superseded. Send /luma to check your current plan; use a new command if you want to change it.');
 try{
 const link=lumaRSVP(event.rsvpUrl)||lumaRSVP(event.sourceUrl),finish=link?`Register or RSVP and check approval/tickets on Luma: ${link}`:'A verified Luma event link is unavailable. Open the original invitation to register and check approval/tickets.';
 if(action==='add'){
  const actionQueue={enqueue:(userId,type,payload,options={})=>queue.enqueue(userId,type,payload,{...options,idempotencyKey:`luma-add:${updateId}:${type}`})};
  const result=await addLumaEvent(store,{id},actionQueue,{now,expectedVersion});
  return reply(`Added to your BRB schedule: ${clean(event.title,120)||'Luma event'}.${result.calendarTask?' Google Calendar sync queued.':result.calendarError?'':' Connect Google Calendar in BRB to sync.'}${result.calendarError?'\n'+clean(result.calendarError,300):''}\nAdding to your schedule does not register you or confirm a ticket or admission.\n${finish}`);
 }
 const intent=action==='decline'?'declined':action;
 const saved=await saveLumaIntent(store,{id,intent},{now,expectedVersion});
 const addHelp=intent==='declined'?`To add reminders later, change your local preference to going or maybe, then use /luma add ${id}`:`To add calendar reminders separately: /luma add ${id}`;
 return reply(`Saved your local planning preference: ${intent}.\n${clean(event.title,120)||'Luma event'}\nThis only updates your BRB plan; it does not submit an RSVP or add an event to your schedule.${saved.localIntentNotice?'\n'+clean(saved.localIntentNotice,400):''}\n${finish}\n${addHelp}`);
 }finally{await store.compareAndSet('settings','lumaTelegramMutation',reservation,{...reservation,status:'handled',handledAt:now(),expiresAt:0});}
}
