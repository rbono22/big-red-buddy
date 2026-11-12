import {addPartifulEvent,partifulRSVP,savePartifulIntent} from './partiful-calendar.mjs';
import {HttpError} from './security.mjs';
import {queueSocialEventCard,socialSavedStatus,reserveSocialMutation} from './social-event-telegram.mjs';

const clean=(value,max=120)=>String(value||'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,max);
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9._:-]{1,200}$/.test(value);
const help='Partiful planning:\n/partiful — upcoming events from your selected calendar\n/partiful going ID\n/partiful maybe ID\n/partiful decline ID\n/partiful add ID — add to your BRB schedule\n\nGoing, maybe, and decline save a local planning preference only. Open the Partiful link and finish your RSVP there. Adding to your schedule does not RSVP.';
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

/** Deterministic commands on the caller's linked private chat; no Partiful API calls or model access. */
export async function handlePartifulMessage(store,queue,msg,updateId,{now=Date.now,expectedVersion}={}){
 const match=String(msg?.text||'').trim().match(/^\/partiful(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/i);
 if(!match||!store?.userId||msg.chat?.type!=='private')return false;
 if(match[1]&&match[1].toLowerCase()!==(process.env.TELEGRAM_BOT_USERNAME||'dabas_class_bot').toLowerCase())return false;
 const linked=await store.get('secrets','telegram');
 if(!linked?.chatId||String(linked.chatId)!==String(msg.chat.id))return false;
 if(!Number.isSafeInteger(updateId)||updateId<0)throw new Error('Invalid Telegram update ID');
 const reply=async text=>{await queue.enqueue(store.userId,'telegram-send',{text},{idempotencyKey:`partiful-command:${updateId}`,retrySafe:false,maxAttempts:1});return true;};
 const args=(match[2]||'').trim(),parts=args.split(/\s+/),action=parts[0]?.toLowerCase();
 if(action==='help')return reply(help);
 if(args.length>240||(!['','list','going','maybe','decline','add'].includes(action)))return reply(help);
 const settings=await store.get('settings','partifulCalendar');
 if(!settings?.calendarId)return reply('Choose a subscribed Partiful calendar in Campus events first. BRB uses only the calendar you select.\n'+help);
 if(!args||action==='list'){
  if(parts.length>1)return reply(help);
  const events=(await store.all('partifulEvents')).filter(e=>e.sourceCalendarId===settings.calendarId&&e.status==='available'&&validId(e.id)&&upcoming(e,now())).sort((a,b)=>String(a.start||a.date||'').localeCompare(String(b.start||b.date||''))).slice(0,5);
  const lines=['Your Partiful events (up to 5). Use the event buttons below. Planning preferences are local; finish any RSVP on Partiful.'];
  if(!events.length)lines.push('No upcoming events are saved from your selected calendar. Check source freshness in Campus events.');
  for(const event of events){
   const link=partifulRSVP(event.rsvpUrl)||partifulRSVP(event.sourceUrl),intent=['going','maybe','declined'].includes(event.localIntent)?event.localIntent:'not set';
   lines.push(`${clean(event.title,80)||'Untitled event'}\n${when(event)}\n${clean(event.location,80)||'Location not published — check Partiful'}\nID: ${event.id}\nLocal preference: ${intent} · ${await socialSavedStatus(store,event)}${link?'\n'+link:'\nPartiful link unavailable — open the original invitation.'}`);
  }
  lines.push('Use /partiful going ID, /partiful maybe ID, or /partiful decline ID for your local plan. Use /partiful add ID separately for calendar reminders. Neither action submits an RSVP.');
  // Keep complete event IDs and the RSVP distinction; never truncate the final disclosure.
  while(lines.join('\n\n').length>3900&&lines.length>2)lines.splice(lines.length-2,1);
  await reply(lines.join('\n\n'));
  for(const event of events)await queueSocialEventCard(store,queue,'partiful',event.id,{idempotencyKey:`partiful-card:${updateId}:${event.id}`,now});
  return true;
 }
 if(parts.length!==2||!validId(parts[1]))return reply(help);
 const id=parts[1],event=await store.get('partifulEvents',id);
 if(!event||event.sourceCalendarId!==settings.calendarId||event.status!=='available')throw new HttpError(404,'That Partiful event is not available in your selected calendar. Send /partiful for your events.');
 const reservation=await reserveSocialMutation(store,'partiful',updateId,now);
 if(reservation.replayed)return reply(reservation.uncertain?'This Partiful planning command was interrupted or is still being saved; its outcome is uncertain. Check /partiful before changing anything. After five minutes, send a fresh command if the change is still needed.':'This Partiful planning command was already handled or superseded. Send /partiful to check your current plan; use a new command if you want to change it.');
 try{
 const link=partifulRSVP(event.rsvpUrl)||partifulRSVP(event.sourceUrl),finish=link?`Finish your RSVP on Partiful: ${link}`:'A verified Partiful event link is unavailable. Open the original invitation to finish your RSVP.';
 if(action==='add'){
  const actionQueue={enqueue:(userId,type,payload,options={})=>queue.enqueue(userId,type,payload,{...options,idempotencyKey:`partiful-add:${updateId}:${type}`})};
  const result=await addPartifulEvent(store,{id},actionQueue,{now,expectedVersion});
  return reply(`Added to your BRB schedule: ${clean(event.title,120)||'Partiful event'}.${result.calendarTask?' Google Calendar sync queued.':result.calendarError?'':' Connect Google Calendar in BRB to sync.'}${result.calendarError?'\n'+clean(result.calendarError,300):''}\nAdding to your schedule does not RSVP.\n${finish}`);
 }
 const intent=action==='decline'?'declined':action;
 const saved=await savePartifulIntent(store,{id,intent},{now,expectedVersion});
 const addHelp=intent==='declined'?`To add reminders later, change your local preference to going or maybe, then use /partiful add ${id}`:`To add calendar reminders separately: /partiful add ${id}`;
 return reply(`Saved your local planning preference: ${intent}.\n${clean(event.title,120)||'Partiful event'}\nThis only updates your BRB plan; it does not submit an RSVP or add an event to your schedule.${saved.localIntentNotice?'\n'+clean(saved.localIntentNotice,400):''}\n${finish}\n${addHelp}`);
 }finally{await store.compareAndSet('settings','partifulTelegramMutation',reservation,{...reservation,status:'handled',handledAt:now(),expiresAt:0});}
}
