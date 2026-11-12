import {TZ,localISO} from './domain.mjs';
import {calendarLocation} from './calendar-description.mjs';
import {refreshPersonalCalendar,uniquePersonalEvents} from './personal-calendar.mjs';

const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'});
const timeFormat=new Intl.DateTimeFormat('en-US',{timeZone:TZ,hour:'numeric',minute:'2-digit'});
const compact=(value,max=160)=>String(value||'').replace(/\s+/g,' ').trim().slice(0,max);
const shift=(date,days)=>new Date(Date.parse(date+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
export function agendaWindow(now,days=7,offset=0){
 const date=shift(dayFormat.format(new Date(now)),offset),endDate=shift(date,days);
 return {date,endDate,start:Date.parse(localISO(date)),end:Date.parse(localISO(endDate))};
}
export function inAgendaWindow(event,window,{after=window.start}={}){
 if(event.cancelled||['cancelled','dismissed'].includes(event.status))return false;
 if(event.allDay||!Number.isFinite(Date.parse(event.start))){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(event.date||''))return false;
  return event.date<window.endDate&&(event.endDate||shift(event.date,1))>window.date;
 }
 const start=Date.parse(event.start),end=Date.parse(event.end);
 return start<window.end&&(Number.isFinite(end)&&end>start?end>after:start>=after);
}
const sortTime=e=>{if(Number.isFinite(Date.parse(e.start)))return Date.parse(e.start);try{return Date.parse(localISO(e.date));}catch{return Infinity;}};
export const agendaSort=(a,b)=>sortTime(a)-sortTime(b)||String(a.title).localeCompare(String(b.title));
export function agendaWhen(event){
 if(event.allDay){const end=event.endDate?shift(event.endDate,-1):event.date;return `${event.date}${end>event.date?` – ${end}`:''} · All day`;}
 if(!Number.isFinite(Date.parse(event.start)))return `${event.date||'Date not supplied'} · Time needs confirmation`;
 const date=dayFormat.format(new Date(event.start)),endDate=Number.isFinite(Date.parse(event.end))?dayFormat.format(new Date(event.end)):null;
 return `${date} · ${timeFormat.format(new Date(event.start))}${endDate?` – ${endDate!==date?endDate+' · ':''}${timeFormat.format(new Date(event.end))}`:''}`;
}
// Construct links from provider IDs, never from an arbitrary imported URL.
export function googleCalendarEventURL(event){
 if(!event.remoteId||!event.sourceCalendarId)return '';
 const eid=Buffer.from(`${event.remoteId} ${event.sourceCalendarId}`).toString('base64url');
 return eid.length<=2000?`https://calendar.google.com/calendar/event?eid=${eid}`:'';
}
export function personalCalendarNotice(snapshot){
 return snapshot.lastError||(!snapshot.enabled?'Your own Google Calendar is not included yet. Choose calendars in Connections.':'');
}
export async function buildScheduleBrief(store,days=1,{now=Date.now,offset=0,readPersonal=refreshPersonalCalendar}={}){
 const at=now(),window=agendaWindow(at,days,offset);
 const [saved,snapshot]=await Promise.all([store.all('events'),readPersonal(store,{now:()=>at})]);
 const existing=saved.filter(e=>inAgendaWindow(e,window));
 const personal=uniquePersonalEvents((snapshot.events||[]).filter(e=>inAgendaWindow(e,window)),[]);
 const rows=[...personal.map(e=>({...e,personal:true})),...uniquePersonalEvents(existing,personal)].sort(agendaSort);
 const notice=personalCalendarNotice(snapshot),lines=[];let shown=0;
 const heading=`${days===1?(offset===1?'Tomorrow':'My day'):'Your week'} · ${window.date} · New York`;
 for(const e of rows.slice(0,12)){
  const line=`${agendaWhen(e)} · ${compact(e.title)}${e.personal?' [Google Calendar]':e.status!=='approved'?' [review]':''}\n${compact(calendarLocation(e.location),100)||'Location not published'}`;
  if(heading.length+lines.join('\n\n').length+line.length>3000)break;
  lines.push(line);shown++;
 }
 const text=[heading,lines.join('\n\n')||'No items found in your connected sources for this day.',rows.length>shown?`${rows.length-shown} more items. Open Events or Google Calendar for the rest.`:'',notice].filter(Boolean).join('\n\n');
 return {text,notification:personal.length?{channel:'requested-calendar',personalCalendarRevision:snapshot.revision}:undefined};
}
