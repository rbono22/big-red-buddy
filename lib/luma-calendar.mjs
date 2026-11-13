import {randomUUID} from 'node:crypto';
import {lumaRSVP} from './event-provider-links.mjs';
import {CALENDAR_SCOPE,CAMPUS_CALENDAR_SCOPES} from './auth.mjs';
import {eventApprovalVersion} from './event-version.mjs';
import {HttpError} from './security.mjs';
import {createCampusCalendar,ingestCampusSnapshot,addCampusEvent,withCalendarSourceLock} from './campus-calendar.mjs';
import {reconcileReminders} from './integrations.mjs';
import {idFor} from './domain.mjs';
import {calendarEventRemoved} from './calendar-mutations.mjs';

// Official source: https://help.luma.com/p/ical-syncing — personal subscriptions
// include hosting and approved/pending/waitlisted registrations; community/city
// feeds can include events the student has never registered for.
export const LUMA_FRESHNESS_NOTICE='Google subscription updates can lag by 12–24 hours. Check Luma for current details. A calendar entry or local preference does not confirm registration, approval, attendance, or a ticket.';
const INTENTS=new Set(['going','maybe','declined']);
const SELECTED='lumaCalendar';
async function requireAutoAddGrants(store){
 const read=await store.get('secrets','campusGoogle'),write=await store.get('secrets','google');
 const scopes=value=>new Set(String(value?.scope||'').split(/\s+/));
 if(!read?.refresh_token||!CAMPUS_CALENDAR_SCOPES.every(scope=>scopes(read).has(scope))||!write?.refresh_token||!scopes(write).has(CALENDAR_SCOPE))throw new HttpError(403,'Connect calendar reading and the BRB Google Calendar before enabling automatic import.');
}
function currentTimedEvent(event,now){const start=Date.parse(event.start),end=Date.parse(event.end);return !event.allDay&&Number.isFinite(start)&&Number.isFinite(end)&&end>start&&end>now();}

const subscribedID=value=>typeof value==='string'&&/^[^\s@]{1,900}@import\.calendar\.google\.com$/.test(value);
async function requireSubscribedSource(store,calendarId){if(!subscribedID(calendarId)||calendarId===(await store.get('secrets','google'))?.calendarId)throw new HttpError(400,'Choose the subscribed Luma calendar imported into Google. The assistant calendar cannot be used as a source.');}
export {lumaRSVP};
const SOURCE=Object.freeze({candidatePrefix:'luma-calendar',eventPrefix:'luma-added',sourcePrefix:'luma-source',untitled:'Untitled Luma event',rsvp:lumaRSVP,sourceUrl:(url,rsvp)=>rsvp||safeSourcePage(url)});
function requireStore(store){if(!store?.userId||!store.get||!store.put||!store.compareAndSet||!store.putIfAbsent)throw new Error('A student-scoped atomic store is required.');}
function mapKey(bucket,id){return {bucket:bucket==='campusEvents'?'lumaEvents':bucket,id:bucket==='settings'&&id==='campusCalendar'?SELECTED:bucket==='settings'&&id==='campusCalendarLock'?'lumaCalendarLock':id};}
function internalEvent(value){return value?.lumaCandidateId?{...value,campusCandidateId:value.lumaCandidateId,campusCalendarId:value.lumaCalendarId,campusRemoteId:value.lumaRemoteId}:value;}
function storedEvent(value){
  if(!value?.campusCandidateId)return value;
  const {campusCandidateId,campusCalendarId,campusRemoteId,...other}=value;
  return {...other,lumaCandidateId:campusCandidateId,lumaCalendarId:campusCalendarId,lumaRemoteId:campusRemoteId,connector:'luma'};
}
function selectedSettings(value){
  if(!value)return value;
  const warning=String(value.warning||'').replaceAll(LUMA_FRESHNESS_NOTICE,'').replace(/campus calendar/gi,'Luma calendar').trim();
  return {...value,autoAdd:value.autoAdd===true,warning:[warning,LUMA_FRESHNESS_NOTICE].filter(Boolean).join(' '),freshnessNotice:LUMA_FRESHNESS_NOTICE};
}
function safeSourcePage(value){try{if(typeof value!=='string'||value.length>2048)return '';const url=new URL(value),eid=url.searchParams.get('eid');return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&['calendar.google.com','www.google.com'].includes(url.hostname)&&url.pathname==='/calendar/event'&&eid?`${url.origin}/calendar/event?${new URLSearchParams({eid})}`:'';}catch{return '';}}
function scoped(store){
  requireStore(store);
  return {userId:store.userId,calendarSource:SOURCE,
    async get(bucket,id){const key=mapKey(bucket,id),value=await store.get(key.bucket,key.id);return bucket==='events'?internalEvent(value):value;},
    async all(bucket,...args){const rows=await store.all(mapKey(bucket).bucket,...args);return bucket==='events'?rows.map(internalEvent):rows;},
    async put(bucket,id,value){
      const key=mapKey(bucket,id);
      if(bucket==='campusEvents'){
        const old=await store.get(key.bucket,key.id);
        value={...value,sourceUrl:lumaRSVP(value.rsvpUrl)||safeSourcePage(value.sourceUrl),connector:'luma',localIntent:old?.localIntent||null,localIntentUpdatedAt:old?.localIntentUpdatedAt||null,localIntentSource:old?.localIntentSource||null,localIntentNotice:old?.localIntentNotice||'Importing this calendar entry does not confirm Luma registration, approval, attendance, or a ticket.',...(old?.addedAt?{addedAt:old.addedAt}:{})};
        if(value.title==='Untitled campus event')value.title='Untitled Luma event';
      }else if(bucket==='events'){
        value=storedEvent(value);
        if(value.lumaCandidateId){const source=await store.get('lumaEvents',value.lumaCandidateId);value={...value,localIntent:source?.localIntent||null};}
      }
      else if(bucket==='settings'&&id==='campusCalendar')value=selectedSettings(value);
      await store.put(key.bucket,key.id,value);return bucket==='events'?internalEvent(value):value;
    },
    async delete(bucket,id){const key=mapKey(bucket,id);return store.delete(key.bucket,key.id);},
    async putIfAbsent(bucket,id,value){const key=mapKey(bucket,id);return store.putIfAbsent(key.bucket,key.id,value);},
    async compareAndSet(bucket,id,previous,next){const key=mapKey(bucket,id);return store.compareAndSet(key.bucket,key.id,previous,next);}
  };
}
async function candidate(store,id){
  if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))throw new HttpError(400,'Choose a Luma event.');
  const config=await store.get('settings',SELECTED),event=await store.get('lumaEvents',id);
  if(!config?.calendarId||!event||event.sourceCalendarId!==config.calendarId||event.status!=='available')throw new HttpError(404,'This Luma event is not available in your selected calendar.');
  return event;
}
async function saveSettings(store,{autoAdd},{now=Date.now,expectedCalendarId}={}){
  if(typeof autoAdd!=='boolean')throw new HttpError(400,'Choose autoAdd true or false.');
  return withCalendarSourceLock(scoped(store),now,async()=>{
    const current=await store.get('settings',SELECTED);
    if(!current?.calendarId)throw new HttpError(400,'Select your subscribed Luma calendar first.');
    if(expectedCalendarId&&current.calendarId!==expectedCalendarId)throw new HttpError(409,'Your selected Luma calendar changed. Retry.');
    if(autoAdd){if(!current.continuous)throw new HttpError(403,'Connect calendar reading and select the Luma calendar before enabling automatic import.');await requireAutoAddGrants(store);}
    const next=selectedSettings({...current,autoAdd,autoAddUpdatedAt:new Date(now()).toISOString()});await store.put('settings',SELECTED,next);return next;
  });
}
export async function saveLumaSettings(store,patch,options){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).length!==1||!Object.hasOwn(patch,'autoAdd'))throw new HttpError(400,'Update only the Luma autoAdd setting.');
  return saveSettings(store,patch,options);
}
export async function saveLumaIntent(store,{id,intent}={}, {now=Date.now,expectedVersion}={}){
  if(!INTENTS.has(intent))throw new HttpError(400,'Choose going, maybe, or declined as a local preference.');
  return withCalendarSourceLock(scoped(store),now,async()=>{
    const event=await candidate(store,id),at=new Date(now()).toISOString();
    if(expectedVersion!==undefined&&eventApprovalVersion(event)!==expectedVersion)throw new HttpError(409,'This Luma event changed. Review its latest details before saving your preference.');
    const localIntentNotice=intent==='declined'?'Local preference saved. Reminders for this added event are off. Any Google Calendar copy remains. BRB did not change your Luma registration or ticket.':'Local preference saved only. This does not register you, join a waitlist, confirm approval, or obtain a Luma ticket. Calendar changes still require Add or your automatic-import setting.';
    const next={...event,localIntent:intent,localIntentUpdatedAt:at,localIntentSource:'student-local',localIntentNotice};await store.put('lumaEvents',id,next);
    if(intent==='declined'&&event.addedEventId){const added=await store.get('events',event.addedEventId);if(added?.lumaCandidateId===event.id&&added.lumaCalendarId===event.sourceCalendarId)await store.put('events',added.id,{...added,status:'dismissed',localIntent:'declined',updatedAt:at,warning:localIntentNotice});await reconcileReminders(store,{now});}
    return next;
  });
}
export async function disconnectLumaCalendar(store,{now=Date.now}={}){
  return withCalendarSourceLock(scoped(store),now,async()=>{
    const current=await store.get('settings',SELECTED);if(!current)return {connected:false,continuous:false,autoAdd:false};
    const next=selectedSettings({...current,continuous:false,autoAdd:false,connectionRevision:randomUUID(),disconnectedAt:new Date(now()).toISOString(),warning:'Luma refresh disconnected; retained events are a snapshot. Shared Google calendar reading remains available to other sources.'});
    await store.put('settings',SELECTED,next);return next;
  });
}

async function add(store,{id,ids},queue,{now=Date.now,automatic=false,expectedVersion}={}){
  const result=await addCampusEvent(scoped(store),{id,ids},queue,{now,expectedVersion,approvalMethod:automatic?'Student enabled automatic import from this selected Luma calendar':'Student selected this Luma event and requested calendar import',validateCandidates:async(events,config)=>{
    if(events.some(event=>event.localIntent==='declined'))throw new HttpError(400,'This event is locally declined. Change your preference before adding it.');
    if(automatic){
      if(!config.autoAdd||!config.continuous)throw new HttpError(409,'Luma automatic import is no longer enabled.');
      await requireAutoAddGrants(store);
      if(events.some(event=>!currentTimedEvent(event,now)))throw new HttpError(400,'Automatic import requires a current event with confirmed start and end times.');
      if(events.some(event=>event.addedEventId))throw new HttpError(409,'An already-added Luma event requires explicit review before changes are approved.');
      if(events.some(event=>!lumaRSVP(event.rsvpUrl)))throw new HttpError(400,'Automatic import requires a validated Luma event link.');
    }
  }});
  return {...result,warnings:[...new Set([...result.warnings,LUMA_FRESHNESS_NOTICE])],providerRSVPConfirmed:false,providerRegistrationConfirmed:false};
}
export const addLumaEvent=(store,input,queue,options)=>add(store,input,queue,options);
export async function ingestLumaSnapshot(store,input,options){requireStore(store);await requireSubscribedSource(store,input?.calendarId);return ingestCampusSnapshot(scoped(store),input,options);}

export function createLumaCalendar({fetchImpl=globalThis.fetch,now=Date.now}={}){
  const client=createCampusCalendar({fetchImpl,now});
  async function listLumaCalendars(store){const assistant=(await store.get('secrets','google'))?.calendarId;return (await client.listCampusCalendars(scoped(store))).filter(calendar=>subscribedID(calendar.id)&&calendar.id!==assistant);}
  async function selectLumaCalendar(store,input={}){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['calendarId','autoAdd'].includes(key))||('autoAdd'in input&&typeof input.autoAdd!=='boolean'))throw new HttpError(400,'Select a subscribed calendar and optional automatic-import setting.');
    await requireSubscribedSource(store,input.calendarId);
    if(input.autoAdd===true)await requireAutoAddGrants(store);
    const selected=await client.selectCampusCalendar(scoped(store),{calendarId:input.calendarId});
    if('autoAdd'in input)return saveSettings(store,{autoAdd:input.autoAdd},{now,expectedCalendarId:input.calendarId});
    return (await store.get('settings',SELECTED))||selected;
  }
  async function syncLumaCalendar(store,{queue}={}){
    const config=await store.get('settings',SELECTED);if(!config?.calendarId||!config.continuous)throw new HttpError(400,'Connect and select your subscribed Luma calendar before refreshing.');
    await requireSubscribedSource(store,config.calendarId);
    const result=await client.syncCampusCalendar(scoped(store)),current=await store.get('settings',SELECTED);
    let autoAdded=0,autoAddPending=0,calendarTask=null,calendarError=null;
    if(current?.calendarId===config.calendarId&&current.autoAdd&&current.continuous){
      const candidates=(await store.all('lumaEvents')).filter(event=>event.sourceCalendarId===current.calendarId&&event.status==='available'&&event.localIntent!=='declined'&&!event.addedEventId&&currentTimedEvent(event,now)&&lumaRSVP(event.rsvpUrl));
      const removed=await Promise.all(candidates.map(event=>calendarEventRemoved(store,{localId:idFor('luma-added',event.id),calendarId:event.sourceCalendarId,remoteId:event.remoteId}))),eligible=candidates.filter((event,index)=>!removed[index]);
      autoAddPending=Math.max(0,eligible.length-20);
      if(eligible.length){try{const added=await add(store,{ids:eligible.slice(0,20).map(event=>event.id)},queue,{now,automatic:true});autoAdded=added.imported;calendarTask=added.calendarTask;calendarError=added.calendarError;}catch(error){if(!(error instanceof HttpError)||![400,403,404,409].includes(error.status))throw error;calendarError='The source refreshed, but automatic import changed or requires review. No additional events were approved.';autoAddPending=eligible.length;}}
    }
    return {...result,autoAdded,autoAddPending,calendarTask,calendarError,warnings:[...new Set([...result.warnings,LUMA_FRESHNESS_NOTICE])]};
  }
  return {listLumaCalendars,selectLumaCalendar,syncLumaCalendar};
}
export const listLumaCalendars=(store,options)=>createLumaCalendar(options).listLumaCalendars(store);
export const selectLumaCalendar=(store,input,options)=>createLumaCalendar(options).selectLumaCalendar(store,input);
export const syncLumaCalendar=(store,options={})=>createLumaCalendar(options).syncLumaCalendar(store,options);
