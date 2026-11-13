import {randomBytes} from 'node:crypto';
import {idFor} from './domain.mjs';
import {HttpError,sha256,isCornellEmail} from './security.mjs';
import {identityId,CALENDAR_EDIT_SCOPES} from './auth.mjs';
import {calendarEventRemoved,writeCalendarTombstones,withCalendarMutationLock} from './calendar-mutations.mjs';

const API='https://www.googleapis.com/calendar/v3/', DAY=86400000, TTL=15*60000;
const CANDIDATES='calendarDeletionCandidates', PROPOSALS='calendarDeletionProposals';
const EDIT_SCOPES=CALENDAR_EDIT_SCOPES;
const nonce=()=>randomBytes(16).toString('hex');
const text=(value,max=240)=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
const opaque=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const validRemote=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\s\u0000-\u001f\u007f]/.test(value);
const version=event=>sha256(JSON.stringify([event?.id,event?.title,event?.start,event?.end,event?.date,event?.endDate,event?.allDay,event?.googleId,event?.updatedAt]));
const credentialVersion=cfg=>sha256(JSON.stringify([cfg?.connectionRevision||cfg?.connectedAt||'',cfg?.subject||'',cfg?.email||'',cfg?.refresh_token||'',cfg?.calendarId||'']));
const editConnected=(cfg,userId)=>!!cfg?.refresh_token&&typeof cfg.subject==='string'&&!!cfg.subject&&identityId('google',cfg.subject)===userId&&isCornellEmail(cfg.email)&&/^[\w-]{43}$/.test(cfg.connectionRevision||'')&&Number.isFinite(Date.parse(cfg.connectedAt))&&!cfg.disconnectedAt&&EDIT_SCOPES.every(scope=>String(cfg.scope||'').split(/\s+/).includes(scope));
const target=row=>({...(row.localId?{localId:row.localId}:{}),...(row.calendarId&&row.remoteId?{calendarId:row.calendarId,remoteId:row.remoteId}:{})});
function fail(status,message,code='calendar_deletion_rejected'){return new HttpError(status,message,code);}
function providerError(status){const error=fail(status===401||status===403?401:502,'Google Calendar could not complete this request.','calendar_provider_error');error.providerStatus=status;return error;}

async function allowed(store,{binding,isAllowed}={}){
  if(!store.userId||((await store.get('settings','account'))?.deleting))throw fail(403,'This workspace cannot change calendar events.');
  if(isAllowed&&!await isAllowed(store.userId))throw fail(403,'This account no longer has pilot access.');
  const linked=await store.get('secrets','telegram');
  if(!linked?.chatId)throw fail(403,'Link Telegram before changing calendar events.');
  if(binding&&(String(linked.chatId)!==String(binding.chatId)||String(linked.linkedAt||'')!==String(binding.linkedAt||'')))throw fail(409,'Your Telegram link changed. Open a new calendar menu.');
  return {chatId:String(linked.chatId),linkedAt:String(linked.linkedAt||'')};
}
async function trimExpired(store,bucket,now){
  const rows=(await store.all(bucket)).sort((a,b)=>(b.expiresAt||0)-(a.expiresAt||0));
  const unresolved=bucket===PROPOSALS?new Set((await store.all('calendarDeletionTombstones')).map(row=>row.proposalId)):new Set();
  for(const row of rows){
    if(['queued','deleting'].includes(row.status)||unresolved.has(row.id)&&['failed','stale','reconnect','uncertain'].includes(row.status))continue;
    if((row.expiresAt<now&&['preview',undefined].includes(row.status))||rows.indexOf(row)>=500)await store.delete(bucket,row.id);
  }
}

// This adapter only uses fixed Google endpoints. Credentials never reach cards,
// callbacks, queue payloads or error messages.
export function createCalendarDeletionClient({fetchImpl=fetch,now=Date.now}={}){
  async function request(store,key,path,{method='GET',etag,sendUpdates,expectedCredentialVersion,validate}={}){
    let cfg=await store.get('secrets',key);
    if(!cfg?.refresh_token||key==='calendarEditGoogle'&&!editConnected(cfg,store.userId))throw fail(401,'Reconnect Google Calendar to delete this event.','calendar_reconnect');
    if(expectedCredentialVersion&&credentialVersion(cfg)!==expectedCredentialVersion)throw fail(409,'The Google connection changed. Review this event again.','calendar_reconnect');
    if(!cfg.access_token||cfg.expiresAt<=now()+60000){
      let response;
      try{response=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID||'',client_secret:process.env.GOOGLE_CLIENT_SECRET||'',refresh_token:cfg.refresh_token,grant_type:'refresh_token'})});}catch{throw fail(502,'Google authorization could not be refreshed. Retry shortly.');}
      if(!response.ok)throw providerError(response.status);
      const payload=await boundedJSON(response);
      if(typeof payload.access_token!=='string'||!Number.isFinite(payload.expires_in))throw fail(502,'Google returned an invalid authorization response.');
      const next={...cfg,access_token:payload.access_token,expiresAt:now()+payload.expires_in*1000};
      if(!await store.compareAndSet('secrets',key,cfg,next))throw fail(409,'The Google connection changed. Open a new calendar menu.');
      cfg=next;
    }
    if(method==='DELETE'){
      const current=await store.get('secrets',key);
      if(!current?.refresh_token||credentialVersion(current)!==credentialVersion(cfg))throw fail(409,'The Google connection changed. Review this event again.','calendar_reconnect');
      if(validate)await validate();
    }
    const url=new URL(path,API);if(sendUpdates)url.searchParams.set('sendUpdates',sendUpdates);
    let response;
    try{response=await fetchImpl(url.href,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${cfg.access_token}`,Accept:'application/json',...(etag?{'If-Match':etag}:{})}});}catch{const error=fail(502,'Google did not confirm the calendar change.','calendar_network_uncertain');error.uncertain=method==='DELETE';throw error;}
    if(method==='DELETE')return {status:response.status};
    if(!response.ok)throw providerError(response.status);
    return boundedJSON(response);
  }
  async function boundedJSON(response){
    if(Number(response.headers.get('content-length'))>2*1024*1024)throw fail(502,'Google returned too much calendar data.');
    const reader=response.body?.getReader();if(!reader)throw fail(502,'Google returned an empty calendar response.');
    let total=0;const chunks=[];
    try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>2*1024*1024)throw fail(502,'Google returned too much calendar data.');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(502,'Google returned invalid calendar data.');}
  }
  const path=(calendarId,eventId)=>`calendars/${encodeURIComponent(calendarId)}/events${eventId?`/${encodeURIComponent(eventId)}`:''}`;
  return {
    async calendar(store,key,calendarId){return request(store,key,`users/me/calendarList/${encodeURIComponent(calendarId)}`);},
    async get(store,key,calendarId,eventId){return request(store,key,path(calendarId,eventId));},
    async list(store,key,calendarId){
      const rows=[];let pageToken='';
      for(let page=0;page<3;page++){
        const params=new URLSearchParams({singleEvents:'true',showDeleted:'false',maxResults:'250',timeMin:new Date(now()-30*DAY).toISOString(),timeMax:new Date(now()+90*DAY).toISOString(),orderBy:'startTime'});if(pageToken)params.set('pageToken',pageToken);
        const body=await request(store,key,`${path(calendarId)}?${params}`);
        if(!Array.isArray(body.items))throw fail(502,'Google returned invalid calendar events.');
        rows.push(...body.items);if(!body.nextPageToken)return {items:rows,truncated:false};pageToken=body.nextPageToken;
      }
      return {items:rows,truncated:true};
    },
    async remove(store,key,calendarId,eventId,{etag,sendUpdates,expectedCredentialVersion,validate}){return request(store,key,path(calendarId,eventId),{method:'DELETE',etag,sendUpdates,expectedCredentialVersion,validate});}
  };
}

function publicEvent(raw,calendarName){
  const start=raw.start?.dateTime||raw.start?.date,end=raw.end?.dateTime||raw.end?.date;
  if(!validRemote(raw.id)||!start||!end||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end)))throw fail(422,'This event does not have a supported date and time.');
  if(raw.recurrence?.length)throw fail(422,'Choose a single occurrence. Deleting a recurring series is not supported.');
  if(raw.eventType&&raw.eventType!=='default')throw fail(422,'Open Google Calendar to remove this special event type.');
  return {title:text(raw.summary)||'Untitled event',start,end,date:start.slice(0,10),endDate:raw.end.date||null,allDay:!!raw.start.date,calendarName:text(calendarName),recurring:!!raw.recurringEventId,occurrence:raw.originalStartTime||null};
}
async function validateScope(store,row){
  const cfg=await store.get('secrets',row.credentialKey);
  if(row.localId){const e=await store.get('events',row.localId);if(!e||version(e)!==row.localVersion)throw fail(409,'This event changed. Review a fresh removal preview.','calendar_stale');}
  if(row.localOnly){
    if(cfg?.calendarId||cfg?.creationPending)throw fail(409,'This event may have synced to Google. Review it again.');
    return null;
  }
  if(!cfg?.refresh_token||credentialVersion(cfg)!==row.credentialVersion)throw fail(409,'The Google connection changed. Reconnect and review this event again.','calendar_reconnect');
  if(row.credentialKey==='calendarEditGoogle'){
    if(!editConnected(cfg,store.userId))throw fail(401,'Enable calendar editing to remove this event.','calendar_reconnect');
    const personal=await store.get('settings','personalCalendar');
    if(!personal?.enabled||personal.revision!==row.selectionRevision||!personal.calendars?.some(c=>c.id===row.calendarId)||!(await store.get('secrets','campusGoogle'))?.refresh_token)throw fail(409,'Your selected calendars changed. Open a new calendar menu.');
  }else if(cfg.calendarId!==row.calendarId)throw fail(409,'The BRB calendar changed. Open a new calendar menu.');
  return cfg;
}
async function calendarWritable(store,row,client){
  if(row.credentialKey==='google')return; // app-created scope has no calendarList access.
  const metadata=await client.calendar(store,row.credentialKey,row.calendarId);
  if(metadata.id!==row.calendarId||!['owner','writer'].includes(metadata.accessRole))throw fail(403,'This calendar is read-only. Open Google Calendar to manage it.');
}

export async function calendarDeletionStatus(store){
  return {brbConnected:!!(await store.get('secrets','google'))?.refresh_token,personalConnected:editConnected(await store.get('secrets','calendarEditGoogle'),store.userId)};
}
async function storeCandidate(store,row,now){const id=nonce();const candidate={...row,id,expiresAt:now()+TTL};await store.put(CANDIDATES,id,candidate);return candidate;}
function visible(row){return {id:row.id,title:row.title,start:row.start,end:row.end,date:row.date,endDate:row.endDate||(row.allDay?row.end:null),allDay:row.allDay,calendarName:row.calendarName,recurring:row.recurring||false,localOnly:row.localOnly||false,...(row.needsReview?{needsReview:true}:{})};}

export async function listDeletionCandidates(store,{query='',offset=0}={},options={}){
  const {client=createCalendarDeletionClient(options),now=Date.now}=options;
  const binding=await allowed(store,options);
  if(typeof query!=='string'||query.length>200||!Number.isInteger(offset)||offset<0||offset>1000)throw fail(400,'Use a short event search.');
  const cfg=await store.get('secrets','google'),personal=await store.get('settings','personalCalendar'),edit=await store.get('secrets','calendarEditGoogle');
  const rows=[];let truncated=false,notice='Choose one event to review before removing it. Search covers 30 days ago through 90 days ahead.',needsPermission=false;
  for(const e of await store.all('events')){
    const at=Date.parse(e.start||e.date);if(!Number.isFinite(at)||at<now()-30*DAY||at>now()+90*DAY||e.cancelled||e.status==='dismissed'||await calendarEventRemoved(store,{localId:e.id}))continue;
    rows.push({localId:e.id,localVersion:version(e),credentialKey:'google',credentialVersion:credentialVersion(cfg),calendarId:cfg?.calendarId,remoteId:e.googleId||(cfg?.calendarId?idFor('google',e.id):null),title:e.title,start:e.start,end:e.end,date:e.date,allDay:!!e.allDay,calendarName:'Big Red Buddy',localOnly:!cfg?.calendarId&&!e.googleId});
  }
  if(personal?.enabled&&personal.calendars?.length){
    needsPermission=!editConnected(edit,store.userId);
    if(needsPermission)notice+=' Enable calendar editing to remove events from your other selected calendars.';
    else for(const calendar of personal.calendars.slice(0,3)){
      if(calendar.id===cfg?.calendarId)continue;
      const base={credentialKey:'calendarEditGoogle',credentialVersion:credentialVersion(edit),selectionRevision:personal.revision,calendarId:calendar.id};
      try{
        await calendarWritable(store,base,client);const response=await client.list(store,base.credentialKey,calendar.id);truncated||=response.truncated;
        for(const raw of response.items){
          if(raw.status==='cancelled'||await calendarEventRemoved(store,{calendarId:calendar.id,remoteId:raw.id}))continue;
          try{rows.push({...base,remoteId:raw.id,...publicEvent(raw,calendar.name)});}catch{}
        }
      }catch{notice+=' Some selected calendars could not be searched or are read-only. Reconnect Google Calendar if access expired.';}
    }
  }
  // A failed removal remains discoverable after its original Telegram buttons
  // expire. The tombstone points to the most recent confirmed attempt; active
  // and completed deletions are never offered as retries.
  const unresolvedIds=new Set((await store.all('calendarDeletionTombstones')).map(row=>row.proposalId).filter(Boolean));
  let unresolved=0;
  for(const id of unresolvedIds){
    const proposal=await store.get(PROPOSALS,id);
    if(!proposal||!['failed','stale','reconnect','uncertain'].includes(proposal.status))continue;
    try{
      const retry=await resolveCandidate(store,{retryProposalId:id},now);
      rows.push({...retry,title:retry.title||proposal.title,start:retry.start||proposal.start,end:retry.end||proposal.end,date:retry.date||proposal.date,endDate:retry.endDate||proposal.endDate,allDay:retry.allDay??proposal.allDay,needsReview:true});unresolved++;
    }catch{}
  }
  if(unresolved)notice+=' Items marked “Removal needs review” require a fresh preview and confirmation. Their BRB reminders remain paused.';
  const filtered=rows.filter(row=>!query||`${row.title} ${row.calendarName}`.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>{
    const aTime=Date.parse(a.start||a.date),bTime=Date.parse(b.start||b.date),aPast=aTime<now(),bPast=bTime<now();
    return aPast!==bPast?Number(aPast)-Number(bPast):aPast?bTime-aTime:aTime-bTime;
  });
  await trimExpired(store,CANDIDATES,now());
  const items=[];for(const row of filtered.slice(offset,offset+8))items.push(visible(await storeCandidate(store,{...row,binding},now)));
  return {items,hasMore:filtered.length>offset+8,notice:truncated?`${notice} Search covers the first 750 events per calendar, from 30 days ago through 90 days ahead.`:notice,needsPermission};
}

async function resolveCandidate(store,input,now){
  if(input.retryProposalId){
    if(!opaque(input.retryProposalId))throw fail(404,'The previous removal could not be found.');
    const previous=await store.get(PROPOSALS,input.retryProposalId);
    if(!previous||!['preview','stale','reconnect','failed','uncertain'].includes(previous.status))throw fail(409,'This removal is already complete or still running.');
    if(previous.status==='preview'&&!await store.compareAndSet(PROPOSALS,previous.id,previous,{...previous,status:'superseded'}))throw fail(409,'This removal is already being processed.');
    if(previous.localId)return resolveCandidate(store,{localId:previous.localId},now);
    const personal=await store.get('settings','personalCalendar'),cfg=await store.get('secrets','calendarEditGoogle');
    if(!personal?.enabled||!personal.calendars?.some(c=>c.id===previous.calendarId))throw fail(409,'Select this calendar again before removing the event.');
    return {...previous,id:undefined,status:undefined,receipt:undefined,binding:undefined,credentialVersion:credentialVersion(cfg),selectionRevision:personal.revision};
  }
  if(input.candidateId){if(!opaque(input.candidateId))throw fail(404,'This event choice expired.');const row=await store.get(CANDIDATES,input.candidateId);if(!row||row.expiresAt<now())throw fail(404,'This event choice expired. Open a fresh calendar menu.');return row;}
  if(input.localId){
    const e=await store.get('events',input.localId);if(!e)throw fail(404,'This event is no longer in your workspace.');
    const cfg=await store.get('secrets','google');
    if(e.googleId&&!cfg?.calendarId)throw fail(401,'Reconnect the Google account used to add this event.','calendar_reconnect');
    if(cfg?.creationPending)throw fail(409,'The BRB calendar is still being created. Try again after synchronization finishes.');
    return {localId:e.id,localVersion:version(e),credentialKey:'google',credentialVersion:credentialVersion(cfg),calendarId:cfg?.calendarId,remoteId:e.googleId||(cfg?.calendarId?idFor('google',e.id):null),title:e.title,start:e.start,end:e.end,date:e.date,allDay:!!e.allDay,calendarName:'Big Red Buddy',localOnly:!cfg?.calendarId&&!e.googleId};
  }
  if(input.personalEventId){
    const selected=await store.get('settings','personalCalendar'),e=selected?.events?.find(row=>row.id===input.personalEventId),cfg=await store.get('secrets','calendarEditGoogle');
    if(!e||!selected.enabled||!selected.calendars?.some(c=>c.id===e.sourceCalendarId))throw fail(404,'This event is no longer on a selected calendar.');
    if(!editConnected(cfg,store.userId))throw fail(401,'Enable calendar editing to remove this event.','calendar_reconnect');
    return {credentialKey:'calendarEditGoogle',credentialVersion:credentialVersion(cfg),selectionRevision:selected.revision,calendarId:e.sourceCalendarId,remoteId:e.remoteId,calendarName:selected.calendars.find(c=>c.id===e.sourceCalendarId)?.name};
  }
  throw fail(400,'Choose an event from your calendar menu.');
}

export async function createDeletionProposal(store,input,options={}){
  const {client=createCalendarDeletionClient(options),now=Date.now}=options,binding=await allowed(store,options);
  const row=await resolveCandidate(store,input,now);await validateScope(store,row);
  if(row.binding&&(row.binding.chatId!==binding.chatId||row.binding.linkedAt!==binding.linkedAt))throw fail(409,'This event choice belongs to an earlier Telegram link.');
  let details=visible(row),etag=null,impact='Remove this event from BRB and stop its reminders.',sendUpdates='all';
  if(!row.localOnly){
    if(!validRemote(row.calendarId)||!validRemote(row.remoteId))throw fail(409,'Reconnect Google Calendar and synchronize this event first.');
    await calendarWritable(store,row,client);
    let raw;
    try{raw=await client.get(store,row.credentialKey,row.calendarId,row.remoteId);}catch(error){
      if(row.localId&&[404,410].includes(error.providerStatus)&&await absenceVerified(store,row,client)){
        row.remoteAbsent=true;impact='Remove this item from BRB and stop its reminders. Google Calendar confirms it is not on the BRB calendar.';
      }else throw error;
    }
    if(raw){
    if(raw.id!==row.remoteId)throw fail(502,'Google returned a different event. Open a fresh calendar menu.');
    if(raw.status==='cancelled')throw fail(409,'This event has already been removed from Google Calendar.');
    if(typeof raw.etag!=='string'||!raw.etag.length||raw.etag.length>512||/[\r\n]/.test(raw.etag))throw fail(502,'Google did not supply an event version. Open Google Calendar to remove it.');
    if(row.localId&&raw.extendedProperties?.private?.dabasId!==row.localId)throw fail(409,'This Google event is not linked to the selected BRB record.');
    details=publicEvent(raw,row.calendarName);etag=raw.etag;
    const guests=Array.isArray(raw.attendees)?raw.attendees.filter(a=>!a.self).length:0;
    impact=details.recurring?'Delete only this occurrence from Google Calendar; other dates remain.':'Delete this event from Google Calendar.';
    if(raw.organizer?.self&&(guests||raw.attendeesOmitted))impact+=' Google will notify invited guests about the cancellation.';
    else if(raw.organizer&&!raw.organizer.self)impact+=' This removes your copy; Google may notify the organizer about your response.';
    else if(guests||raw.attendeesOmitted)impact+=' Google may notify invited guests about this removal.';
    if(row.localId)impact+=' BRB reminders for it will stop.';
    }
  }
  const proposal={...row,...details,id:nonce(),revision:1,status:'preview',etag,sendUpdates,binding,impact,createdAt:now(),expiresAt:now()+TTL};
  // Retain source identifiers in encrypted storage, but return only UI fields.
  await trimExpired(store,PROPOSALS,now());await store.put(PROPOSALS,proposal.id,proposal);
  return proposalView(proposal);
}
function proposalView(row){return {...visible(row),revision:row.revision,status:row.status,impact:row.impact,expiresAt:row.expiresAt,...(row.receipt?{receipt:row.receipt}:{})};}
export async function getDeletionProposal(store,id){if(!opaque(id))return null;const row=await store.get(PROPOSALS,id);return row?proposalView(row):null;}
export async function cancelDeletion(store,{id,revision},options={}){
  if(!opaque(id)||revision!==1)throw fail(400,'This confirmation is not valid.');
  const row=await store.get(PROPOSALS,id);if(!row||row.revision!==revision)throw fail(404,'This removal preview expired.');
  await allowed(store,{...options,binding:row.binding});
  if(options.binding&&(String(options.binding.chatId)!==row.binding.chatId||String(options.binding.linkedAt||'')!==row.binding.linkedAt))throw fail(403,'This confirmation belongs to a different Telegram link.');
  if(row.status==='cancelled')return proposalView(row);
  if(row.status!=='preview')throw fail(409,'The removal is already queued or completed.');
  const cancelled={...row,status:'cancelled'};
  if(!await store.compareAndSet(PROPOSALS,id,row,cancelled))throw fail(409,'This removal is already being processed.');
  return proposalView(cancelled);
}

async function suppressLocal(store,row,now){
  await writeCalendarTombstones(store,target(row),{proposalId:row.id,status:'pending',at:new Date(now()).toISOString()});
  if(row.localId){
    const event=await store.get('events',row.localId);
    if(event){const updated={...event,status:'dismissed',cancelled:true,calendarDeletionId:row.id,calendarRemovalPending:true};if(!await store.compareAndSet('events',row.localId,event,updated))throw fail(409,'This event changed. Review it again.');}
    for(const reminder of await store.all('reminders'))if(reminder.eventId===row.localId&&['pending','sending'].includes(reminder.status))await store.compareAndSet('reminders',reminder.id,reminder,{...reminder,status:'cancelled',cancelReason:'calendar-removal',cancelledAt:new Date(now()).toISOString()});
  }
}

export async function confirmDeletion(store,queue,{id,revision},options={}){
  const {now=Date.now}=options;if(!opaque(id)||revision!==1)throw fail(400,'This confirmation is not valid.');
  return withCalendarMutationLock(store,async()=>{
    let row=await store.get(PROPOSALS,id);if(!row||row.revision!==revision)throw fail(404,'This removal preview expired.');
    await allowed(store,{...options,binding:row.binding});
    if(options.binding&&(String(options.binding.chatId)!==row.binding.chatId||String(options.binding.linkedAt||'')!==row.binding.linkedAt))throw fail(403,'This confirmation belongs to a different Telegram link.');
    const recoveringEnqueue=row.status==='queued'&&!row.taskId;
    if(row.status!=='preview'&&!recoveringEnqueue)return proposalView(row);
    if(row.expiresAt<now())throw fail(409,'This removal preview expired. Review the event again.');
    await validateScope(store,row);
    const next={...row,status:'queued',confirmedAt:row.confirmedAt||now()};
    if(!await store.compareAndSet(PROPOSALS,id,row,next))throw fail(409,'This removal is already being processed.');
    row=next;
    try{
      await suppressLocal(store,row,now);
      const job=await queue.enqueue(store.userId,'calendar-delete',{proposalId:id,revision},{idempotencyKey:`calendar-delete:${id}:${revision}`,retrySafe:false,maxAttempts:1,ttlMs:TTL});
      const current=await store.get(PROPOSALS,id);await store.compareAndSet(PROPOSALS,id,current,{...current,taskId:job.id});
      return {...proposalView(row),taskId:job.id};
    }catch{
      const receipt={status:'failed',message:'Removal could not be queued. The event was not confirmed deleted from Google Calendar. BRB reminders are paused; review the event and try again.',proposalId:id,retry:{retryProposalId:id}};
      const current=await store.get(PROPOSALS,id);await store.compareAndSet(PROPOSALS,id,current,{...current,status:'failed',receipt});return {...proposalView(row),status:'failed',receipt};
    }
  },{now});
}

async function absenceVerified(store,row,client){
  try{const raw=await client.get(store,row.credentialKey,row.calendarId,row.remoteId);return raw.id===row.remoteId&&raw.status==='cancelled';}
  catch(error){
    if(![404,410].includes(error.providerStatus))return false;
    // 404 may hide lost permission. A known writable calendar distinguishes it
    // for personal calendars. For app-created calendars use a bounded event list.
    try{if(row.credentialKey==='calendarEditGoogle')await calendarWritable(store,row,client);else await client.list(store,row.credentialKey,row.calendarId);return true;}catch{return false;}
  }
}
async function complete(store,row,status,message,now){
  const success=['deleted','already-deleted','local-only'].includes(status);
  const receipt={status,message:!success&&row.localId?`${message} BRB reminders for this item remain paused until the removal is resolved.`:message,proposalId:row.id,title:row.title,calendarName:row.calendarName,...(!success?{retry:{retryProposalId:row.id}}:{})};
  const current=await store.get(PROPOSALS,row.id);await store.compareAndSet(PROPOSALS,row.id,current,{...current,status,receipt,completedAt:now()});
  if(['deleted','already-deleted','local-only'].includes(status)){
    await writeCalendarTombstones(store,target(row),{proposalId:row.id,status:'deleted',at:new Date(now()).toISOString()});
    if(row.localId){const event=await store.get('events',row.localId);if(event)await store.compareAndSet('events',row.localId,event,{...event,status:'dismissed',cancelled:true,googleId:null,googleLink:null,calendarRemovalPending:false,removedFromGoogleAt:new Date(now()).toISOString()});}
    const personal=await store.get('settings','personalCalendar');
    if(personal?.events?.length)await store.compareAndSet('settings','personalCalendar',personal,{...personal,events:personal.events.filter(e=>e.sourceCalendarId!==row.calendarId||e.remoteId!==row.remoteId)});
  }
  return receipt;
}

export async function executeDeletion(store,{proposalId,revision},options={}){
  const {client=createCalendarDeletionClient(options),now=Date.now}=options;
  if(!opaque(proposalId)||revision!==1)throw fail(400,'This calendar task is invalid.');
  return withCalendarMutationLock(store,async renew=>{
    const row=await store.get(PROPOSALS,proposalId);if(!row||row.revision!==revision)throw fail(404,'This calendar task was not found.');
    if(row.receipt)return row.receipt;
    if(row.status==='deleting')return complete(store,row,'uncertain','Google has not confirmed the earlier removal. Check Google Calendar, then request a fresh removal preview if the event remains.',now);
    if(row.status!=='queued')throw fail(409,'Review and confirm this event before removing it.');
    try{
      await allowed(store,{...options,binding:row.binding});await validateScope(store,row);
      if(row.expiresAt<now())return complete(store,row,'stale','The removal preview expired before it ran. Review the event again.',now);
      await renew();
      if(row.localOnly)return complete(store,row,'local-only','Removed from BRB and stopped its reminders. This event had not been added to Google Calendar.',now);
      await calendarWritable(store,row,client);
      let raw;
      try{raw=await client.get(store,row.credentialKey,row.calendarId,row.remoteId);}catch(error){if([404,410].includes(error.providerStatus)&&await absenceVerified(store,row,client))return complete(store,row,row.remoteAbsent?'local-only':'already-deleted',row.remoteAbsent?'Removed from BRB and stopped its reminders. Google Calendar confirms the event is absent.':'Google Calendar confirms this event is already removed.',now);throw error;}
      if(raw.id!==row.remoteId)throw fail(502,'Google returned a different event. Open a fresh calendar menu.');
      if(raw.status==='cancelled')return complete(store,row,'already-deleted','Google Calendar confirms this event is already removed.',now);
      const details=publicEvent(raw,row.calendarName);
      if(raw.etag!==row.etag||details.title!==row.title||details.start!==row.start||details.end!==row.end||details.recurring!==row.recurring)return complete(store,row,'stale','This event changed after your preview. Nothing was deleted. Review the updated event before removing it.',now);
      await allowed(store,{...options,binding:row.binding});await validateScope(store,row);await renew();
      const current=await store.get(PROPOSALS,row.id),deleting={...current,status:'deleting',startedAt:now()};
      if(current.status!=='queued'||!await store.compareAndSet(PROPOSALS,row.id,current,deleting))throw fail(409,'This removal is already being processed.');
      let result;
      try{result=await client.remove(store,row.credentialKey,row.calendarId,row.remoteId,{etag:row.etag,sendUpdates:row.sendUpdates,expectedCredentialVersion:row.credentialVersion,validate:async()=>{await allowed(store,{...options,binding:row.binding});await validateScope(store,row);await renew();}});}
      catch(error){
        if(error.uncertain&&await absenceVerified(store,row,client))return complete(store,row,'deleted','Removed from Google Calendar. BRB reminders for this event are stopped.',now);
        const status=error.uncertain?'uncertain':error.code==='calendar_reconnect'||error.status===401?'reconnect':error.status===409?'stale':'failed';
        return complete(store,row,status,status==='reconnect'?'The Google connection changed. Reconnect and review this event again.':'Google did not confirm deletion. Check the event and review a fresh removal preview before trying again.',now);
      }
      if(result.status===204)return complete(store,row,'deleted','Removed from Google Calendar. BRB reminders for this event are stopped.',now);
      if([404,410].includes(result.status)&&await absenceVerified(store,row,client))return complete(store,row,'already-deleted','Google Calendar confirms this event is already removed.',now);
      if(result.status===412)return complete(store,row,'stale','This event changed after your preview. Nothing was deleted. Review the updated event before removing it.',now);
      if([401,403].includes(result.status))return complete(store,row,'reconnect','Google did not allow deletion. Reconnect calendar editing and review the event again.',now);
      return complete(store,row,'failed','Google did not confirm deletion. The event may still be on your calendar. Review it before trying again.',now);
    }catch(error){return complete(store,row,error.code==='calendar_reconnect'||error.status===401?'reconnect':error.status===409?'stale':'failed',error instanceof HttpError?error.message:'The calendar removal could not be completed. Open a fresh removal preview to retry.',now);}
  },{now});
}
