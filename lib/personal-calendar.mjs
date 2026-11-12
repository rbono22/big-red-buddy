import {createCampusCalendar,withCalendarSourceLock} from './campus-calendar.mjs';
import {HttpError} from './security.mjs';

const KEY='personalCalendar';
export async function personalCalendarStatus(store){
 const c=await store.get('settings',KEY);
 return {enabled:c?.enabled===true,calendars:c?.calendars||[],lastSuccess:c?.lastSuccess||null,lastError:c?.lastError||null,connected:!!(await store.get('secrets','campusGoogle'))?.refresh_token};
}
export async function savePersonalCalendars(store,input,{client=createCampusCalendar(),now=Date.now}={}){
 if(!input||typeof input.enabled!=='boolean'||!Array.isArray(input.calendarIds)||input.calendarIds.length>3||input.calendarIds.some(id=>typeof id!=='string'||!id||id.length>1024)||new Set(input.calendarIds).size!==input.calendarIds.length||Object.keys(input).some(k=>!['enabled','calendarIds'].includes(k)))throw new HttpError(400,'Choose up to three calendars and whether to include them.');
 if(input.enabled&&!input.calendarIds.length)throw new HttpError(400,'Choose at least one calendar.');
 return withCalendarSourceLock(store,now,async()=>{
  const previous=await store.get('settings',KEY);
  const available=input.enabled?await client.listCampusCalendars(store):[];
  if(input.enabled&&input.calendarIds.some(id=>!available.some(c=>c.id===id)))throw new HttpError(403,'Choose calendars available through your Google connection.');
  const next={enabled:input.enabled,calendars:input.enabled?available.filter(c=>input.calendarIds.includes(c.id)).map(c=>({id:c.id,name:c.name})):[],events:[],lastSuccess:null,lastError:null,revision:(previous?.revision||0)+1};
  await store.put('settings',KEY,next);return personalCalendarStatus(store);
 });
}
// Read-only bounded snapshots. Nothing is copied into BRB's writable calendar.
export async function refreshPersonalCalendar(store,{client,now=Date.now}={}){
 const before=await store.get('settings',KEY);
 if(!before?.enabled)return {events:[],enabled:false};
 client||=createCampusCalendar({now,signal:AbortSignal.timeout(20000)});
 if(!(await store.get('secrets','campusGoogle'))?.refresh_token)return {enabled:true,events:[],lastError:'Personal Google Calendar reading is disconnected. Reconnect in Connections.'};
 if(before.lastSuccess&&now()-Date.parse(before.lastSuccess)<5*60000&&!before.lastError)return before;
 try{return await withCalendarSourceLock(store,now,async()=>{
  const current=await store.get('settings',KEY);if(!current?.enabled)return {events:[],enabled:false};
  const events=[];
  for(const calendar of current.calendars)events.push(...await client.readPersonalCalendar(store,calendar.id));
  if(!(await store.get('secrets','campusGoogle'))?.refresh_token)throw new Error('Calendar reading disconnected.');
  const next={...current,events,lastSuccess:new Date(now()).toISOString(),lastError:null};
  if(!await store.compareAndSet('settings',KEY,current,next))return {events:[],enabled:false};
  return next;
 });}catch{
  const next={...before,events:[],lastError:'Personal Google Calendar could not be refreshed. Check Google Calendar and reconnect reading in Connections.'};
  await store.compareAndSet('settings',KEY,before,next);
  return {enabled:true,events:[],lastError:next.lastError};
 }
}
export function uniquePersonalEvents(personal,existing){
 const seen=new Set(),norm=v=>String(v||'').trim().toLowerCase().replace(/\s+/g,' ');
 const time=e=>e.allDay?e.date:Number.isFinite(Date.parse(e.start))?new Date(e.start).toISOString():e.date;
 const keys=e=>[`${norm(e.title)}|${time(e)}`,e.iCalUID?`uid:${e.iCalUID}|${time(e)}`:null,e.remoteId?`remote:${e.remoteId}`:null,e.googleId?`remote:${e.googleId}`:null,e.campusRemoteId?`remote:${e.campusRemoteId}`:null].filter(Boolean);
 for(const e of existing)for(const k of keys(e))seen.add(k);
 return personal.filter(e=>{const k=keys(e);if(k.some(v=>seen.has(v)))return false;for(const v of k)seen.add(v);return true;});
}

export async function personalCalendarRevisionMatches(store,revision){
 if(revision===undefined)return true;
 const config=await store.get('settings',KEY);
 return config?.enabled===true&&config.revision===revision&&!!(await store.get('secrets','campusGoogle'))?.refresh_token;
}
