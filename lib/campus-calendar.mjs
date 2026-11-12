import { randomUUID } from 'node:crypto';
import { CAMPUS_CALENDAR_SCOPES, CALENDAR_SCOPE } from './auth.mjs';
import { idFor, localISO, TZ } from './domain.mjs';
import { HttpError } from './security.mjs';
import { reconcileReminders } from './integrations.mjs';
import { eventApprovalVersion } from './event-version.mjs';

const DAY=86400000, MAX_DAYS=90, MAX_ITEMS=5000, MAX_PAGES=10, MAX_BYTES=2*1024*1024;
const API='https://www.googleapis.com/calendar/v3/';
const text=(value,max=4000)=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim().slice(0,max):'';
const validID=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\u0000-\u0020\u007f]/.test(value);
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&iso(`${value}T12:00:00Z`)?.slice(0,10)===value;
const hasScopes=cfg=>CAMPUS_CALENDAR_SCOPES.every(scope=>String(cfg?.scope||'').split(/\s+/).includes(scope));
function requireStore(store){if(!store?.userId||typeof store.get!=='function'||typeof store.put!=='function')throw new Error('A student-scoped store is required.');}
function decodeEntities(value){return value.replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi,entity=>{const named={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' '};if(named[entity.toLowerCase()])return named[entity.toLowerCase()];const n=parseInt(entity.slice(2,-1).replace(/^x/i,''),/^&#x/i.test(entity)?16:10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';});}
function plain(value){return text(decodeEntities(text(value,12000).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<\/?(?:p|div|br|li|h[1-6])\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,'')),6000);}
function httpsLink(value){try{const url=new URL(text(value,2048));return url.protocol==='https:'&&!url.username&&!url.password?url.href:'';}catch{return '';}}
export function campusRSVP(value){
 const source=decodeEntities(text(value,12000));
 const match=source.match(/https:\/\/cornelltech\.campusgroups\.com\/rsvp\s*\?\s*id\s*=\s*(\d{1,20})(?=$|[&#\s"'<>])/i);
 return match?`https://cornelltech.campusgroups.com/rsvp?id=${match[1]}`:'';
}
function campusLocation(value){const location=plain(value).slice(0,300);return /^(?:sign|log)\s*in\b.*\b(?:location|download)\b/i.test(location)||/^(?:location\s+(?:not published|hidden|unavailable)|tba|tbd)$/i.test(location)?'':location;}
function timeParts(value){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};}
function inWindow(event,start,end){const nextDay=validDate(event.date)?new Date(Date.parse(`${event.date}T12:00:00Z`)+DAY).toISOString().slice(0,10):null;const finish=event.end?Date.parse(event.end):nextDay?Date.parse(localISO(event.endDate||nextDay)):NaN;const begin=event.start?Date.parse(event.start):validDate(event.date)?Date.parse(localISO(event.date)):NaN;return Number.isFinite(begin)&&Number.isFinite(finish)&&finish>start&&begin<end;}
function material(event){return JSON.stringify([event.title,event.description,event.start,event.end,event.date,event.location,event.rsvpUrl,event.sourceUrl,event.status,event.allDay]);}
function candidateFromGoogle(raw,{calendarId,calendarName,fetchedAt,source}){
 if(!raw||!validID(raw.id))throw new HttpError(502,'The campus calendar returned an invalid event identifier.');
 const id=idFor(source?.candidatePrefix||'campus-calendar',calendarId,raw.id);
 if(raw.status==='cancelled')return {id,sourceCalendarId:calendarId,remoteId:raw.id,status:'cancelled',sourceUpdatedAt:iso(raw.updated)||fetchedAt,updatedAt:fetchedAt};
 const allDay=validDate(raw.start?.date),warnings=[];
 const startRaw=raw.start?.dateTime,endRaw=raw.end?.dateTime;
 const start=typeof startRaw==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/i.test(startRaw)?iso(startRaw):null;
 const end=typeof endRaw==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/i.test(endRaw)?iso(endRaw):null;
 if(start&&end&&Date.parse(end)<=Date.parse(start))throw new HttpError(502,'The campus calendar returned an invalid event duration.');
 const date=allDay?raw.start.date:start?timeParts(start).date:validDate(String(startRaw||'').slice(0,10))?startRaw.slice(0,10):null;
 if(!date)throw new HttpError(502,'The campus calendar returned an event without a usable date.');
 const title=plain(raw.summary).slice(0,240)||source?.untitled||'Untitled campus event';
 const rsvp=source?.rsvp||campusRSVP;
 const description=plain(raw.description),location=campusLocation(raw.location),rsvpUrl=rsvp(raw.description)||rsvp(raw.source?.url)||rsvp(raw.htmlLink);
 const sourceUrl=source?.sourceUrl?source.sourceUrl(raw.htmlLink,rsvpUrl):httpsLink(raw.htmlLink)||rsvpUrl;
 if(!location)warnings.push('Room is not published. Check the event source before attending.');
 if(allDay||!start||!end)warnings.push('A confirmed start and end time are required before adding reminders or syncing this event.');
 return {id,sourceCalendarId:calendarId,sourceCalendarName:calendarName,remoteId:raw.id,title,description,start:allDay?null:start,end:allDay?null:end,date,time:allDay||!start?null:timeParts(start).time,endDate:allDay&&validDate(raw.end?.date)?raw.end.date:null,timezone:TZ,location,rsvpUrl,sourceUrl,allDay,status:'available',warnings,sourceUpdatedAt:iso(raw.updated)||fetchedAt,updatedAt:fetchedAt};
}
async function withLock(store,now,operation){
 requireStore(store);const key='campusCalendarLock',lock={owner:randomUUID(),expiresAt:now()+5*60000};
 const existing=await store.putIfAbsent('settings',key,lock);
 if(existing.owner!==lock.owner){if(existing.expiresAt>now()||!await store.compareAndSet('settings',key,existing,lock))throw new HttpError(409,'Campus calendar work is already running. Retry shortly.');}
 try{return await operation();}finally{await store.compareAndSet('settings',key,lock,{owner:lock.owner,expiresAt:0});}
}
export const withCalendarSourceLock=withLock;
export async function saveCampusSettings(store,patch,{now=Date.now}={}){
 if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).length!==1||typeof patch.autoAdd!=='boolean')throw new HttpError(400,'Update only the campus autoAdd setting with true or false.');
 return withLock(store,now,async()=>{
  const config=await store.get('settings','campusCalendar');if(!config?.calendarId)throw new HttpError(400,'Select the Cornell campus calendar first.');
  const read=await store.get('secrets','campusGoogle'),write=await store.get('secrets','google');
  if(patch.autoAdd&&(!config.continuous||!read?.refresh_token||!hasScopes(read)||!write?.refresh_token||!String(write.scope||'').split(/\s+/).includes(CALENDAR_SCOPE)))throw new HttpError(403,'Connect campus calendar reading and the BRB Google Calendar before enabling automatic additions.');
  if(patch.autoAdd&&config.calendarId===write?.calendarId)throw new HttpError(400,'The BRB output calendar cannot also be its campus event source.');
  const next={...config,autoAdd:patch.autoAdd,autoAddUpdatedAt:new Date(now()).toISOString(),dailySyncTime:'05:00',dailySyncTimezone:TZ};await store.put('settings','campusCalendar',next);return next;
 });
}
async function updateAddedEvent(store,candidate,previous,at){
 const eventId=previous?.addedEventId;if(!eventId)return;
 const event=await store.get('events',eventId);if(!event||event.campusCandidateId!==candidate.id||event.campusCalendarId!==candidate.sourceCalendarId)return;
 if(material(candidate)===material(previous))return;
 const cancelled=candidate.status==='cancelled';
 const updated={...event,...(!cancelled?{title:candidate.title,date:candidate.date,time:candidate.time,start:candidate.start,end:candidate.end,location:candidate.location,sourceUrl:candidate.rsvpUrl||candidate.sourceUrl,evidence:evidenceFor(candidate)}:{}),status:'review',cancelled,updatedAt:at,warning:cancelled?'The source event was removed or cancelled. Review before removing an existing Google Calendar copy.':'The campus event changed. Review its updated details before reminders or calendar changes.',reviewedAt:null,previousSource:{title:event.title,start:event.start,end:event.end,location:event.location,sourceUrl:event.sourceUrl}};
 await store.put('events',eventId,updated);
}
function evidenceFor(candidate){return [candidate.description,`Published meeting: ${candidate.start||candidate.date}${candidate.end?' to '+candidate.end:''}.`,`Location: ${candidate.location||'not published'}.`,candidate.rsvpUrl?`RSVP: ${candidate.rsvpUrl}`:'',candidate.sourceUrl?`Calendar source: ${candidate.sourceUrl}`:''].filter(Boolean).join('\n\n').slice(0,12000);}

/** Only call this with an explicitly selected student's authorized source snapshot. */
async function ingestSnapshotUnlocked(store,{calendarId,calendarName,items,windowStart,windowEnd,fetchedAt,continuous=false,complete=false},now){
 if(!validID(calendarId)||!Array.isArray(items)||items.length>MAX_ITEMS)throw new HttpError(400,'Provide a bounded campus calendar snapshot.');
 const from=iso(windowStart),to=iso(windowEnd),at=iso(fetchedAt)||new Date(now()).toISOString();
 if(!from||!to||Date.parse(to)<=Date.parse(from)||Date.parse(to)-Date.parse(from)>MAX_DAYS*DAY+1000)throw new HttpError(400,'Campus calendar snapshots must cover no more than 90 days.');
 const existingSettings=await store.get('settings','campusCalendar');
 if(existingSettings?.calendarId&&existingSettings.calendarId!==calendarId)throw new HttpError(409,'The selected campus calendar changed. Refresh that calendar before importing.');
 const name=plain(calendarName).slice(0,240)||existingSettings?.calendarName||'Selected campus calendar';
 const normalized=new Map();
 for(const raw of items){const candidate=candidateFromGoogle(raw,{calendarId,calendarName:name,fetchedAt:at,source:store.calendarSource});const old=normalized.get(candidate.id);if(old&&JSON.stringify(old)!==JSON.stringify(candidate))throw new HttpError(502,'Duplicate campus events disagree. Refresh before applying changes.');normalized.set(candidate.id,candidate);}
 const existing=(await store.all('campusEvents')).filter(e=>e.sourceCalendarId===calendarId),byId=new Map(existing.map(e=>[e.id,e]));
 let created=0,changed=0,cancelled=0;
 for(const [id,candidate] of normalized){
  const previous=byId.get(id);if(candidate.status==='cancelled'&&!previous)continue;
  if(candidate.status!=='cancelled'&&!inWindow(candidate,Date.parse(from),Date.parse(to)))continue;
  const next={...(candidate.status==='cancelled'?previous:{}),...candidate,...(previous?.addedEventId?{addedEventId:previous.addedEventId}:{}),firstSeenAt:previous?.firstSeenAt||at};
  if(candidate.status==='cancelled'){if(previous.status!=='cancelled')cancelled++;}else if(!previous)created++;else if(material(previous)!==material(next))changed++;
  await store.put('campusEvents',id,next);await updateAddedEvent(store,next,previous,at);
 }
 // Absence is meaningful only after the entire bounded provider listing succeeded.
 if(complete)for(const previous of existing){if(previous.status!=='available'||normalized.has(previous.id)||!inWindow(previous,Date.parse(from),Date.parse(to)))continue;const next={...previous,status:'cancelled',updatedAt:at,missingFromCompleteSnapshot:true};await store.put('campusEvents',next.id,next);await updateAddedEvent(store,next,previous,at);cancelled++;}
 await reconcileReminders(store,{now});
 const warning=!continuous?'Imported snapshot only. Connect campus calendar read access to enable refreshes.':!complete?'Calendar coverage is incomplete; existing events were not removed.':null;
 await store.put('settings','campusCalendar',{...existingSettings,calendarId,calendarName:name,timezone:TZ,selectedAt:existingSettings?.selectedAt||at,lastSuccess:at,lastError:null,windowStart:from,windowEnd:to,continuous:Boolean(continuous),complete:Boolean(complete),warning});
 return {count:[...normalized.values()].filter(e=>e.status==='available'&&inWindow(e,Date.parse(from),Date.parse(to))).length,created,changed,cancelled,complete:Boolean(complete),continuous:Boolean(continuous),warnings:warning?[warning]:[]};
}
export function ingestCampusSnapshot(store,input,{now=Date.now}={}){return withLock(store,now,()=>ingestSnapshotUnlocked(store,input,now));}

async function boundedJSON(response){
 if(!response.ok)throw new HttpError(502,`Google campus calendar returned HTTP ${response.status}. Check connection access and retry.`);
 if(Number(response.headers.get('content-length'))>MAX_BYTES)throw new HttpError(502,'The campus calendar response exceeded the size limit.');
 const reader=response.body?.getReader();let data='';
 if(reader){let size=0;const decoder=new TextDecoder();try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw new HttpError(502,'The campus calendar response exceeded the size limit.');}data+=decoder.decode(value,{stream:true});}data+=decoder.decode();}finally{reader.releaseLock();}}
 else {data=await response.text();if(Buffer.byteLength(data)>MAX_BYTES)throw new HttpError(502,'The campus calendar response exceeded the size limit.');}
 try{return JSON.parse(data);}catch{throw new HttpError(502,'The campus calendar returned an unreadable response.');}
}
export function createCampusCalendar({fetchImpl=globalThis.fetch,now=Date.now}={}){
 async function fetchJSON(url,options={}){try{return await boundedJSON(await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)}));}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(502,'Campus calendar connection failed or timed out. Retry shortly.');}}
 async function access(store){requireStore(store);const cfg=await store.get('secrets','campusGoogle');if(!cfg?.refresh_token||!hasScopes(cfg))throw new HttpError(403,'Connect campus calendar read access first.');if(cfg.access_token&&cfg.expiresAt>now()+60000)return cfg.access_token;
  const result=await fetchJSON('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID||'',client_secret:process.env.GOOGLE_CLIENT_SECRET||'',refresh_token:cfg.refresh_token,grant_type:'refresh_token'})});
  if(typeof result.access_token!=='string'||!result.access_token||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw new HttpError(502,'Google did not return usable campus calendar access. Reconnect.');
  const next={...cfg,access_token:result.access_token,expiresAt:now()+result.expires_in*1000,...(result.scope?{scope:result.scope}:{})};if(!hasScopes(next))throw new HttpError(403,'Campus calendar read permissions are missing. Reconnect.');if(!await store.compareAndSet('secrets','campusGoogle',cfg,next))throw new HttpError(409,'The campus connection changed. Retry with the current connection.');return next.access_token;
 }
 async function request(store,path){const token=await access(store);return fetchJSON(API+path,{method:'GET',headers:{Authorization:`Bearer ${token}`}});}
 async function pages(store,path,params,{limit=MAX_ITEMS}={}){const all=[],seen=new Set();let pageToken;for(let page=0;page<MAX_PAGES;page++){const query=new URLSearchParams(params);if(pageToken)query.set('pageToken',pageToken);const result=await request(store,`${path}?${query}`),expectedKind=path==='users/me/calendarList'?'calendar#calendarList':'calendar#events';if(!result||typeof result!=='object'||Array.isArray(result)||result.error||(result.kind&&result.kind!==expectedKind)||(!Array.isArray(result.items)&&!(result.items===undefined&&result.kind===expectedKind)))throw new HttpError(502,'The campus calendar returned invalid paging data.');all.push(...(result.items||[]));if(all.length>limit)throw new HttpError(502,'Campus calendar results exceed the bounded import limit.');if(!result.nextPageToken)return all;pageToken=result.nextPageToken;if(typeof pageToken!=='string'||pageToken.length>2048||seen.has(pageToken))throw new HttpError(502,'Campus calendar pagination could not be completed.');seen.add(pageToken);}throw new HttpError(502,'Campus calendar pagination exceeded its limit. Existing records were preserved.');}
 async function listCampusCalendars(store){const items=await pages(store,'users/me/calendarList',{maxResults:'100',minAccessRole:'reader',showHidden:'true'},{limit:1000}),output=(await store.get('secrets','google'))?.calendarId;return items.filter(c=>c.id!==output&&validID(c.id)&&!c.deleted&&['reader','writer','owner','writerWithoutPrivateAccess'].includes(c.accessRole)).map(c=>({id:c.id,name:plain(c.summaryOverride||c.summary).slice(0,240)||'Unnamed calendar',timezone:text(c.timeZone,100)||TZ,primary:!!c.primary}));}
 async function selectedMetadata(store,calendarId){if(!validID(calendarId))throw new HttpError(400,'Choose a subscribed calendar.');const c=await request(store,`users/me/calendarList/${encodeURIComponent(calendarId)}`);if(c.id!==calendarId||c.deleted||!['reader','writer','owner','writerWithoutPrivateAccess'].includes(c.accessRole))throw new HttpError(403,'This calendar is not readable through your subscription.');return {id:c.id,name:plain(c.summaryOverride||c.summary).slice(0,240)||'Selected campus calendar',timezone:text(c.timeZone,100)||TZ};}
 async function selectCampusCalendar(store,{calendarId}){return withLock(store,now,async()=>{if(calendarId===(await store.get('secrets','google'))?.calendarId)throw new HttpError(400,'The BRB output calendar cannot also be its event source.');const c=await selectedMetadata(store,calendarId),previous=await store.get('settings','campusCalendar'),at=new Date(now()).toISOString();const grant=await store.get('secrets','campusGoogle');if(!grant?.refresh_token||!hasScopes(grant))throw new HttpError(409,'The campus connection was disconnected. Connect it again before selecting a calendar.');const same=previous?.calendarId===calendarId,settings={...(same?previous:{}),calendarId,calendarName:c.name,timezone:c.timezone,selectedAt:at,connectionRevision:same&&previous.connectionRevision?previous.connectionRevision:randomUUID(),autoAdd:same&&previous.autoAdd===true,continuous:true,lastError:null,warning:'Refresh the selected calendar to load its upcoming events.'};await store.put('settings','campusCalendar',settings);return settings;});}
 async function syncCampusCalendar(store){return withLock(store,now,async()=>{const config=await store.get('settings','campusCalendar');if(!config?.calendarId)throw new HttpError(400,'Select your campus calendar first.');try{const metadata=await selectedMetadata(store,config.calendarId),windowStart=new Date(now()).toISOString(),windowEnd=new Date(now()+MAX_DAYS*DAY).toISOString();const items=await pages(store,`calendars/${encodeURIComponent(config.calendarId)}/events`,{timeMin:windowStart,timeMax:windowEnd,timeZone:TZ,singleEvents:'true',showDeleted:'true',maxResults:'500',eventTypes:'default'});const current=await store.get('settings','campusCalendar'),grant=await store.get('secrets','campusGoogle');if(current?.calendarId!==config.calendarId||current?.selectedAt!==config.selectedAt||current?.connectionRevision!==config.connectionRevision||(config.continuous===true&&current.continuous===false)||!grant?.refresh_token||!hasScopes(grant))throw new HttpError(409,'The campus calendar connection changed during refresh. Start again with the current connection.');return await ingestSnapshotUnlocked(store,{calendarId:config.calendarId,calendarName:metadata.name,items,windowStart,windowEnd,fetchedAt:new Date(now()).toISOString(),continuous:true,complete:true},now);}catch(error){const current=await store.get('settings','campusCalendar');if(current?.calendarId===config.calendarId&&current?.selectedAt===config.selectedAt&&current?.connectionRevision===config.connectionRevision)await store.compareAndSet('settings','campusCalendar',current,{...current,lastError:text(error.message,300),lastAttemptAt:new Date(now()).toISOString()});throw error;}});}
 return {listCampusCalendars,selectCampusCalendar,syncCampusCalendar};
}
export const listCampusCalendars=(store,options)=>createCampusCalendar(options).listCampusCalendars(store);
export const selectCampusCalendar=(store,input,options)=>createCampusCalendar(options).selectCampusCalendar(store,input);
export const syncCampusCalendar=(store,options)=>createCampusCalendar(options).syncCampusCalendar(store);

/** Add is explicit approval of precisely these current, selected-source candidates. */
export async function addCampusEvent(store,{id,ids},queue,{now=Date.now,validateCandidates,approvalMethod,expectedVersion}={}){
 return withLock(store,now,async()=>{
  const selected=ids??(id?[id]:[]);if(!Array.isArray(selected)||!selected.length||selected.length>20||selected.some(value=>typeof value!=='string'||!/^[a-f0-9]{32}$/.test(value))||new Set(selected).size!==selected.length)throw new HttpError(400,'Select 1 to 20 distinct campus events.');
  const config=await store.get('settings','campusCalendar');if(!config?.calendarId)throw new HttpError(400,'Select a campus calendar first.');
  const candidates=await Promise.all(selected.map(value=>store.get('campusEvents',value)));
  if(candidates.some(c=>!c||c.sourceCalendarId!==config.calendarId))throw new HttpError(404,'A selected event is not available in your campus calendar.');
  if(expectedVersion!==undefined&&(typeof expectedVersion!=='string'||candidates.length!==1||eventApprovalVersion(candidates[0])!==expectedVersion))throw new HttpError(409,'The event changed since you reviewed it. Refresh and check its latest details before adding.');
  if(candidates.some(c=>c.status!=='available'||!c.start||!c.end||c.allDay))throw new HttpError(400,'Select available events with confirmed start and end times. All-day events need a specific time first.');
  if(validateCandidates)await validateCandidates(candidates,config);
  const at=new Date(now()).toISOString(),eventIds=[],warnings=[];let imported=0,reused=0;
  for(const candidate of candidates){const eventId=idFor(store.calendarSource?.eventPrefix||'campus-added',candidate.id),old=await store.get('events',eventId);const event={...old,id:eventId,title:candidate.title,kind:'event',date:candidate.date,time:candidate.time,start:candidate.start,end:candidate.end,timezone:TZ,location:candidate.location,evidence:evidenceFor(candidate),evidenceVerified:true,sourceId:idFor(store.calendarSource?.sourcePrefix||'campus-source',candidate.sourceCalendarId),sourceName:candidate.sourceCalendarName||config.calendarName,sourceUrl:candidate.rsvpUrl||candidate.sourceUrl,rsvpUrl:candidate.rsvpUrl,campusCandidateId:candidate.id,campusCalendarId:candidate.sourceCalendarId,campusRemoteId:candidate.remoteId,status:'approved',cancelled:false,reviewedAt:at,updatedAt:at,warning:candidate.warnings.join(' '),approvalMethod:approvalMethod||'Student selected this campus event and requested calendar import'};await store.put('events',eventId,event);await store.put('campusEvents',candidate.id,{...candidate,addedEventId:eventId,addedAt:at});eventIds.push(eventId);old?reused++:imported++;warnings.push(...candidate.warnings);}
  await reconcileReminders(store,{now});let calendarTask=null,calendarError=null;
  if(queue&&(await store.get('secrets','google'))?.refresh_token){try{const task=await queue.enqueue(store.userId,'google-sync',{eventIds},{retrySafe:false,maxAttempts:1});calendarTask={taskId:task.id};}catch{calendarError='Events saved; calendar sync could not be queued. Retry sync from Connections.';}}
  return {imported,reused,warnings:[...new Set(warnings)],eventIds,calendarTask,calendarError};
 });
}
