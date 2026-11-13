import {randomUUID} from 'node:crypto';
import {partifulRSVP} from './event-provider-links.mjs';
import {CALENDAR_SCOPE,CAMPUS_CALENDAR_SCOPES} from './auth.mjs';
import {eventApprovalVersion} from './event-version.mjs';
import {HttpError} from './security.mjs';
import {createCampusCalendar,ingestCampusSnapshot,addCampusEvent,withCalendarSourceLock} from './campus-calendar.mjs';
import {reconcileReminders} from './integrations.mjs';
import {idFor} from './domain.mjs';
import {calendarEventRemoved} from './calendar-mutations.mjs';

export const PARTIFUL_FRESHNESS_NOTICE='Google subscription updates can lag by about 24 hours. Check Partiful for current details; local preferences do not confirm an RSVP.';
const INTENTS=new Set(['going','maybe','declined']);
const SELECTED='partifulCalendar';
async function requireAutoAddGrants(store){
 const read=await store.get('secrets','campusGoogle'),write=await store.get('secrets','google');
 const scopes=value=>new Set(String(value?.scope||'').split(/\s+/));
 if(!read?.refresh_token||!CAMPUS_CALENDAR_SCOPES.every(scope=>scopes(read).has(scope))||!write?.refresh_token||!scopes(write).has(CALENDAR_SCOPE))throw new HttpError(403,'Connect calendar reading and the BRB Google Calendar before enabling automatic import.');
}
function currentTimedEvent(event,now){const start=Date.parse(event.start),end=Date.parse(event.end);return !event.allDay&&Number.isFinite(start)&&Number.isFinite(end)&&end>start&&end>now();}

const subscribedID=value=>typeof value==='string'&&/^[^\s@]{1,900}@import\.calendar\.google\.com$/.test(value);
async function requireSubscribedSource(store,calendarId){if(!subscribedID(calendarId)||calendarId===(await store.get('secrets','google'))?.calendarId)throw new HttpError(400,'Choose the subscribed Partiful calendar imported into Google. The assistant calendar cannot be used as a source.');}
export {partifulRSVP};
const SOURCE=Object.freeze({candidatePrefix:'partiful-calendar',eventPrefix:'partiful-added',sourcePrefix:'partiful-source',untitled:'Untitled Partiful event',rsvp:partifulRSVP,sourceUrl:(url,rsvp)=>rsvp||safeSourcePage(url)});
function requireStore(store){if(!store?.userId||!store.get||!store.put||!store.compareAndSet||!store.putIfAbsent)throw new Error('A student-scoped atomic store is required.');}
function mapKey(bucket,id){return {bucket:bucket==='campusEvents'?'partifulEvents':bucket,id:bucket==='settings'&&id==='campusCalendar'?SELECTED:bucket==='settings'&&id==='campusCalendarLock'?'partifulCalendarLock':id};}
function internalEvent(value){return value?.partifulCandidateId?{...value,campusCandidateId:value.partifulCandidateId,campusCalendarId:value.partifulCalendarId,campusRemoteId:value.partifulRemoteId}:value;}
function storedEvent(value){
  if(!value?.campusCandidateId)return value;
  const {campusCandidateId,campusCalendarId,campusRemoteId,...other}=value;
  return {...other,partifulCandidateId:campusCandidateId,partifulCalendarId:campusCalendarId,partifulRemoteId:campusRemoteId,connector:'partiful'};
}
function selectedSettings(value){
  if(!value)return value;
  const warning=String(value.warning||'').replaceAll(PARTIFUL_FRESHNESS_NOTICE,'').replace(/campus calendar/gi,'Partiful calendar').trim();
  return {...value,autoAdd:value.autoAdd===true,warning:[warning,PARTIFUL_FRESHNESS_NOTICE].filter(Boolean).join(' '),freshnessNotice:PARTIFUL_FRESHNESS_NOTICE};
}
function safeSourcePage(value){try{if(typeof value!=='string'||value.length>2048)return '';const url=new URL(value),eid=url.searchParams.get('eid');return url.protocol==='https:'&&!url.username&&!url.password&&['calendar.google.com','www.google.com'].includes(url.hostname)&&url.pathname==='/calendar/event'&&eid?`${url.origin}/calendar/event?${new URLSearchParams({eid})}`:'';}catch{return '';}}
function scoped(store){
  requireStore(store);
  return {userId:store.userId,calendarSource:SOURCE,
    async get(bucket,id){const key=mapKey(bucket,id),value=await store.get(key.bucket,key.id);return bucket==='events'?internalEvent(value):value;},
    async all(bucket,...args){const rows=await store.all(mapKey(bucket).bucket,...args);return bucket==='events'?rows.map(internalEvent):rows;},
    async put(bucket,id,value){
      const key=mapKey(bucket,id);
      if(bucket==='campusEvents'){
        const old=await store.get(key.bucket,key.id);
        value={...value,sourceUrl:partifulRSVP(value.rsvpUrl)||safeSourcePage(value.sourceUrl),connector:'partiful',localIntent:old?.localIntent||null,localIntentUpdatedAt:old?.localIntentUpdatedAt||null,localIntentSource:old?.localIntentSource||null,localIntentNotice:old?.localIntentNotice||'No Partiful RSVP has been sent or confirmed.',...(old?.addedAt?{addedAt:old.addedAt}:{})};
        if(value.title==='Untitled campus event')value.title='Untitled Partiful event';
      }else if(bucket==='events'){
        value=storedEvent(value);
        if(value.partifulCandidateId){const source=await store.get('partifulEvents',value.partifulCandidateId);value={...value,localIntent:source?.localIntent||null};}
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
  if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))throw new HttpError(400,'Choose a Partiful event.');
  const config=await store.get('settings',SELECTED),event=await store.get('partifulEvents',id);
  if(!config?.calendarId||!event||event.sourceCalendarId!==config.calendarId||event.status!=='available')throw new HttpError(404,'This Partiful event is not available in your selected calendar.');
  return event;
}
async function saveSettings(store,{autoAdd},{now=Date.now,expectedCalendarId}={}){
  if(typeof autoAdd!=='boolean')throw new HttpError(400,'Choose autoAdd true or false.');
  return withCalendarSourceLock(scoped(store),now,async()=>{
    const current=await store.get('settings',SELECTED);
    if(!current?.calendarId)throw new HttpError(400,'Select your subscribed Partiful calendar first.');
    if(expectedCalendarId&&current.calendarId!==expectedCalendarId)throw new HttpError(409,'Your selected Partiful calendar changed. Retry.');
    if(autoAdd){if(!current.continuous)throw new HttpError(403,'Connect calendar reading and select the Partiful calendar before enabling automatic import.');await requireAutoAddGrants(store);}
    const next=selectedSettings({...current,autoAdd,autoAddUpdatedAt:new Date(now()).toISOString()});await store.put('settings',SELECTED,next);return next;
  });
}
export async function savePartifulSettings(store,patch,options){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).length!==1||!Object.hasOwn(patch,'autoAdd'))throw new HttpError(400,'Update only the Partiful autoAdd setting.');
  return saveSettings(store,patch,options);
}
export async function savePartifulIntent(store,{id,intent}={}, {now=Date.now,expectedVersion}={}){
  if(!INTENTS.has(intent))throw new HttpError(400,'Choose going, maybe, or declined as a local preference.');
  return withCalendarSourceLock(scoped(store),now,async()=>{
    const event=await candidate(store,id),at=new Date(now()).toISOString();
    if(expectedVersion!==undefined&&eventApprovalVersion(event)!==expectedVersion)throw new HttpError(409,'This Partiful event changed. Review its latest details before saving your preference.');
    const localIntentNotice=intent==='declined'?'Local preference saved. Reminders for this added event are off. Any Google Calendar copy remains. BRB did not send or change your Partiful RSVP.':'Local preference saved only. This does not submit or confirm a Partiful RSVP. Calendar changes still require Add or your automatic-import setting.';
    const next={...event,localIntent:intent,localIntentUpdatedAt:at,localIntentSource:'student-local',localIntentNotice};await store.put('partifulEvents',id,next);
    if(intent==='declined'&&event.addedEventId){const added=await store.get('events',event.addedEventId);if(added?.partifulCandidateId===event.id&&added.partifulCalendarId===event.sourceCalendarId)await store.put('events',added.id,{...added,status:'dismissed',localIntent:'declined',updatedAt:at,warning:localIntentNotice});await reconcileReminders(store,{now});}
    return next;
  });
}
export async function disconnectPartifulCalendar(store,{now=Date.now}={}){
  return withCalendarSourceLock(scoped(store),now,async()=>{
    const current=await store.get('settings',SELECTED);if(!current)return {connected:false,continuous:false,autoAdd:false};
    const next=selectedSettings({...current,continuous:false,autoAdd:false,connectionRevision:randomUUID(),disconnectedAt:new Date(now()).toISOString(),warning:'Partiful refresh disconnected; retained events are a snapshot. Shared Google calendar reading remains available to other sources.'});
    await store.put('settings',SELECTED,next);return next;
  });
}

async function add(store,{id,ids},queue,{now=Date.now,automatic=false,expectedVersion}={}){
  const result=await addCampusEvent(scoped(store),{id,ids},queue,{now,expectedVersion,approvalMethod:automatic?'Student enabled automatic import from this selected Partiful calendar':'Student selected this Partiful event and requested calendar import',validateCandidates:async(events,config)=>{
    if(events.some(event=>event.localIntent==='declined'))throw new HttpError(400,'This event is locally declined. Change your preference before adding it.');
    if(automatic){
      if(!config.autoAdd||!config.continuous)throw new HttpError(409,'Partiful automatic import is no longer enabled.');
      await requireAutoAddGrants(store);
      if(events.some(event=>!currentTimedEvent(event,now)))throw new HttpError(400,'Automatic import requires a current event with confirmed start and end times.');
      if(events.some(event=>event.addedEventId))throw new HttpError(409,'An already-added Partiful event requires explicit review before changes are approved.');
      if(events.some(event=>!partifulRSVP(event.rsvpUrl)))throw new HttpError(400,'Automatic import requires a validated Partiful event link.');
    }
  }});
  return {...result,warnings:[...new Set([...result.warnings,PARTIFUL_FRESHNESS_NOTICE])],providerRSVPConfirmed:false};
}
export const addPartifulEvent=(store,input,queue,options)=>add(store,input,queue,options);
export async function ingestPartifulSnapshot(store,input,options){requireStore(store);await requireSubscribedSource(store,input?.calendarId);return ingestCampusSnapshot(scoped(store),input,options);}

export function createPartifulCalendar({fetchImpl=globalThis.fetch,now=Date.now}={}){
  const client=createCampusCalendar({fetchImpl,now});
  async function listPartifulCalendars(store){const assistant=(await store.get('secrets','google'))?.calendarId;return (await client.listCampusCalendars(scoped(store))).filter(calendar=>subscribedID(calendar.id)&&calendar.id!==assistant);}
  async function selectPartifulCalendar(store,input={}){
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['calendarId','autoAdd'].includes(key))||('autoAdd'in input&&typeof input.autoAdd!=='boolean'))throw new HttpError(400,'Select a subscribed calendar and optional automatic-import setting.');
    await requireSubscribedSource(store,input.calendarId);
    if(input.autoAdd===true)await requireAutoAddGrants(store);
    const selected=await client.selectCampusCalendar(scoped(store),{calendarId:input.calendarId});
    if('autoAdd'in input)return saveSettings(store,{autoAdd:input.autoAdd},{now,expectedCalendarId:input.calendarId});
    return (await store.get('settings',SELECTED))||selected;
  }
  async function syncPartifulCalendar(store,{queue}={}){
    const config=await store.get('settings',SELECTED);if(!config?.calendarId||!config.continuous)throw new HttpError(400,'Connect and select your subscribed Partiful calendar before refreshing.');
    await requireSubscribedSource(store,config.calendarId);
    const result=await client.syncCampusCalendar(scoped(store)),current=await store.get('settings',SELECTED);
    let autoAdded=0,autoAddPending=0,calendarTask=null,calendarError=null;
    if(current?.calendarId===config.calendarId&&current.autoAdd&&current.continuous){
      const candidates=(await store.all('partifulEvents')).filter(event=>event.sourceCalendarId===current.calendarId&&event.status==='available'&&event.localIntent!=='declined'&&!event.addedEventId&&currentTimedEvent(event,now)&&partifulRSVP(event.rsvpUrl));
      const removed=await Promise.all(candidates.map(event=>calendarEventRemoved(store,{localId:idFor('partiful-added',event.id),calendarId:event.sourceCalendarId,remoteId:event.remoteId}))),eligible=candidates.filter((event,index)=>!removed[index]);
      autoAddPending=Math.max(0,eligible.length-20);
      if(eligible.length){try{const added=await add(store,{ids:eligible.slice(0,20).map(event=>event.id)},queue,{now,automatic:true});autoAdded=added.imported;calendarTask=added.calendarTask;calendarError=added.calendarError;}catch(error){if(!(error instanceof HttpError)||![400,403,404,409].includes(error.status))throw error;calendarError='The source refreshed, but automatic import changed or requires review. No additional events were approved.';autoAddPending=eligible.length;}}
    }
    return {...result,autoAdded,autoAddPending,calendarTask,calendarError,warnings:[...new Set([...result.warnings,PARTIFUL_FRESHNESS_NOTICE])]};
  }
  return {listPartifulCalendars,selectPartifulCalendar,syncPartifulCalendar};
}
export const listPartifulCalendars=(store,options)=>createPartifulCalendar(options).listPartifulCalendars(store);
export const selectPartifulCalendar=(store,input,options)=>createPartifulCalendar(options).selectPartifulCalendar(store,input);
export const syncPartifulCalendar=(store,options={})=>createPartifulCalendar(options).syncPartifulCalendar(store,options);
