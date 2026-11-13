import test from 'node:test';
import assert from 'node:assert/strict';
import {identityId,CALENDAR_EDIT_SCOPES} from '../lib/auth.mjs';
import {HttpError} from '../lib/security.mjs';
import {idFor} from '../lib/domain.mjs';
import {syncGoogle,reconcileReminders,googleAccess} from '../lib/integrations.mjs';
import {calendarEventRemoved,withCalendarMutationLock} from '../lib/calendar-mutations.mjs';
import {createCalendarDeletionClient,listDeletionCandidates,createDeletionProposal,confirmDeletion,cancelDeletion,executeDeletion,calendarDeletionStatus} from '../lib/calendar-deletion.mjs';

const NOW=Date.parse('2026-11-12T18:00:00Z'),now=()=>NOW;
const binding={chatId:'123',linkedAt:'2026-11-12T12:00:00Z'};
const LOCAL='local-event',REMOTE=idFor('google',LOCAL);
const event={id:LOCAL,title:'Study with Josh',kind:'event',date:'2026-11-13',start:'2026-11-13T18:00:00Z',end:'2026-11-13T19:00:00Z',status:'approved',googleId:REMOTE};
const raw={id:REMOTE,etag:'"v1"',summary:event.title,start:{dateTime:event.start},end:{dateTime:event.end},organizer:{self:true},extendedProperties:{private:{dabasId:LOCAL}}};
function student(subject='student-a'){
 const records=new Map();return {userId:identityId('google',subject),records,async get(bucket,id){return structuredClone(records.get(`${bucket}:${id}`)||null);},async put(bucket,id,value){records.set(`${bucket}:${id}`,structuredClone(value));return value;},async all(bucket){return [...records].filter(([key])=>key.startsWith(`${bucket}:`)).map(([,value])=>structuredClone(value));},async putIfAbsent(bucket,id,value){const key=`${bucket}:${id}`;if(!records.has(key))records.set(key,structuredClone(value));return structuredClone(records.get(key));},async compareAndSet(bucket,id,before,after){const key=`${bucket}:${id}`;if(JSON.stringify(records.get(key)||null)!==JSON.stringify(before))return false;records.set(key,structuredClone(after));return true;},async delete(bucket,id){records.delete(`${bucket}:${id}`);}};
}
function missing(status=404){const e=new HttpError(502,'Google request failed.');e.providerStatus=status;return e;}
async function setup({personal=false,local=true}={}){
 const store=student(),jobs=[],calls=[];let current=structuredClone(raw);
 await store.put('secrets','telegram',binding);
 if(local){await store.put('events',LOCAL,event);await store.put('secrets','google',{refresh_token:'refresh',access_token:'access',expiresAt:NOW+3600000,calendarId:'brb-calendar'});}
 if(personal){
   await store.put('secrets','campusGoogle',{refresh_token:'read'});
   await store.put('secrets','calendarEditGoogle',{subject:'student-a',email:'student@cornell.edu',refresh_token:'edit-refresh',access_token:'edit-access',expiresAt:NOW+3600000,connectedAt:new Date(NOW).toISOString(),connectionRevision:'a'.repeat(43),scope:CALENDAR_EDIT_SCOPES.join(' ')});
   await store.put('settings','personalCalendar',{enabled:true,revision:7,calendars:[{id:'mine',name:'Personal calendar'}],events:[{id:'personal-snapshot',sourceCalendarId:'mine',remoteId:REMOTE,title:raw.summary,start:event.start,end:event.end}]});
 }
 const client={
   async calendar(_s,_key,id){calls.push(['calendar',id]);return {id,accessRole:'owner'};},
   async get(_s,_key,calendarId,id){calls.push(['get',calendarId,id]);if(!current)throw missing();return structuredClone(current);},
   async list(_s,_key,id){calls.push(['list',id]);return {items:current?[structuredClone(current)]:[],truncated:false};},
   async remove(_s,key,calendarId,id,options){calls.push(['delete',key,calendarId,id,options]);if(!current)return {status:404};if(options.etag!==current.etag)return {status:412};current=null;return {status:204};}
 };
 const queue={async enqueue(userId,type,payload,options){jobs.push({id:'job-'+jobs.length,userId,type,payload,options});return jobs.at(-1);}};
 return {store,jobs,calls,client,queue,setRaw(value){current=structuredClone(value);},getRaw(){return current;},options:{client,now,binding}};
}
async function queued(f,input={localId:LOCAL}){const p=await createDeletionProposal(f.store,input,f.options);const q=await confirmDeletion(f.store,f.queue,{id:p.id,revision:p.revision},f.options);assert.equal(q.status,'queued');return {p,payload:f.jobs.at(-1).payload};}

test('BRB deletion needs preview and one confirmation, persists suppression before conditional Google DELETE',async()=>{
 const f=await setup();await f.store.put('reminders','reminder',{id:'reminder',eventId:LOCAL,status:'pending'});
 const p=await createDeletionProposal(f.store,{localId:LOCAL},f.options);
 assert.equal(p.title,event.title);assert.equal(p.calendarName,'Big Red Buddy');assert.equal(f.calls.some(c=>c[0]==='delete'),false);assert.equal(await calendarEventRemoved(f.store,{localId:LOCAL}),false);
 const q=await confirmDeletion(f.store,f.queue,{id:p.id,revision:1},f.options);assert.equal(q.status,'queued');assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].options.retrySafe,false);assert.equal(f.jobs[0].options.maxAttempts,1);
 await confirmDeletion(f.store,f.queue,{id:p.id,revision:1},f.options);assert.equal(f.jobs.length,1);
 const oldRemove=f.client.remove;f.client.remove=async(...args)=>{assert.equal(await calendarEventRemoved(f.store,{localId:LOCAL}),true);assert.equal((await f.store.get('reminders','reminder')).status,'cancelled');return oldRemove(...args);};
 const receipt=await executeDeletion(f.store,f.jobs[0].payload,f.options);assert.equal(receipt.status,'deleted');assert.match(receipt.message,/Removed from Google Calendar/);
 const call=f.calls.find(c=>c[0]==='delete');assert.deepEqual(call.slice(1,4),['google','brb-calendar',REMOTE]);assert.equal(call[4].etag,'"v1"');assert.equal(call[4].sendUpdates,'all');assert.equal(typeof call[4].validate,'function');
 assert.equal((await f.store.get('events',LOCAL)).googleId,null);assert.equal((await f.store.get('events',LOCAL)).status,'dismissed');
 await executeDeletion(f.store,f.jobs[0].payload,f.options);assert.equal(f.calls.filter(c=>c[0]==='delete').length,1);
});

test('only owned proposal IDs work; binding changes, expiry, revoked access and account deletion fail before DELETE',async()=>{
 const f=await setup(),p=await createDeletionProposal(f.store,{localId:LOCAL},f.options),other=student('other');await other.put('secrets','telegram',binding);
 await assert.rejects(confirmDeletion(other,f.queue,{id:p.id,revision:1},f.options),e=>e.status===404);
 await assert.rejects(confirmDeletion(f.store,f.queue,{id:p.id,revision:1},{...f.options,binding:{...binding,chatId:'intruder'}}),e=>e.status===403);
 await assert.rejects(confirmDeletion(f.store,f.queue,{id:p.id,revision:1},{...f.options,now:()=>NOW+16*60000}),/expired/);
 await f.store.put('settings','account',{deleting:true});await assert.rejects(confirmDeletion(f.store,f.queue,{id:p.id,revision:1},f.options),e=>e.status===403);
 assert.equal(f.jobs.length,0);
 const g=await setup(),{payload}=await queued(g);await g.store.put('secrets','telegram',{...binding,linkedAt:'new-link'});
 assert.equal((await executeDeletion(g.store,payload,g.options)).status,'stale');assert.equal(g.calls.some(c=>c[0]==='delete'),false);
 const h=await setup(),job=await queued(h);assert.equal((await executeDeletion(h.store,job.payload,{...h.options,isAllowed:async()=>false})).status,'failed');assert.equal(h.calls.some(c=>c[0]==='delete'),false);
});

test('Cancel invalidates the sibling confirm button without deleting or suppressing anything',async()=>{
 const f=await setup(),p=await createDeletionProposal(f.store,{localId:LOCAL},f.options);
 assert.equal((await cancelDeletion(f.store,{id:p.id,revision:1},f.options)).status,'cancelled');
 assert.equal((await confirmDeletion(f.store,f.queue,{id:p.id,revision:1},f.options)).status,'cancelled');
 assert.equal(await calendarEventRemoved(f.store,{localId:LOCAL}),false);assert.equal(f.jobs.length,0);
});

test('personal occurrences require the selected writable calendar and the same credential revision and identity',async()=>{
 const f=await setup({personal:true,local:false}),p=await createDeletionProposal(f.store,{personalEventId:'personal-snapshot'},f.options);
 assert.equal(p.calendarName,'Personal calendar');await confirmDeletion(f.store,f.queue,{id:p.id,revision:1},f.options);
 const cfg=await f.store.get('secrets','calendarEditGoogle');await f.store.put('secrets','calendarEditGoogle',{...cfg,connectionRevision:'b'.repeat(43)});
 assert.equal((await executeDeletion(f.store,f.jobs[0].payload,f.options)).status,'reconnect');assert.equal(f.calls.some(c=>c[0]==='delete'),false);
 const g=await setup({personal:true,local:false}),q=await queued(g,{personalEventId:'personal-snapshot'});
 const personal=await g.store.get('settings','personalCalendar');await g.store.put('settings','personalCalendar',{...personal,revision:8});
 assert.equal((await executeDeletion(g.store,q.payload,g.options)).status,'stale');assert.equal(g.calls.some(c=>c[0]==='delete'),false);
 const grant=await g.store.get('secrets','calendarEditGoogle');await g.store.put('secrets','calendarEditGoogle',{...grant,subject:'another-student'});
 assert.equal((await calendarDeletionStatus(g.store)).personalConnected,false);
 await assert.rejects(createDeletionProposal(g.store,{personalEventId:'personal-snapshot'},g.options),/Enable calendar editing/);
});

test('a personal event is removed only from its selected calendar, then removed from the agenda cache',async()=>{
 const f=await setup({personal:true,local:false}),{payload}=await queued(f,{personalEventId:'personal-snapshot'});
 assert.equal((await executeDeletion(f.store,payload,f.options)).status,'deleted');
 assert.deepEqual(f.calls.find(c=>c[0]==='delete').slice(1,4),['calendarEditGoogle','mine',REMOTE]);
 assert.deepEqual((await f.store.get('settings','personalCalendar')).events,[]);
 assert.equal(await calendarEventRemoved(f.store,{calendarId:'mine',remoteId:REMOTE}),true);
 assert.equal(await calendarEventRemoved(f.store,{calendarId:'other',remoteId:REMOTE}),false);
});

test('read-only calendars, series masters, special events and mismatched remote identities cannot be deleted',async()=>{
 const f=await setup({personal:true,local:false});f.client.calendar=async()=>({id:'mine',accessRole:'reader'});
 await assert.rejects(createDeletionProposal(f.store,{personalEventId:'personal-snapshot'},f.options),/read-only/);
 const g=await setup();g.setRaw({...raw,recurrence:['RRULE:FREQ=WEEKLY']});await assert.rejects(createDeletionProposal(g.store,{localId:LOCAL},g.options),/single occurrence/);
 g.setRaw({...raw,eventType:'birthday'});await assert.rejects(createDeletionProposal(g.store,{localId:LOCAL},g.options),/special event/);
 g.setRaw({...raw,id:'unrelated'});await assert.rejects(createDeletionProposal(g.store,{localId:LOCAL},g.options),/different event/);
 g.setRaw({...raw,extendedProperties:{private:{dabasId:'other-local'}}});await assert.rejects(createDeletionProposal(g.store,{localId:LOCAL},g.options),/not linked/);
 assert.equal(g.calls.some(c=>c[0]==='delete'),false);
});

test('single occurrence preview explains notifications and deletes only the instance',async()=>{
 const f=await setup();f.setRaw({...raw,recurringEventId:'master',originalStartTime:raw.start,attendees:[{self:true},{email:'guest@example.test'}]});
 const {p,payload}=await queued(f);assert.equal(p.recurring,true);assert.match(p.impact,/only this occurrence/);assert.match(p.impact,/notify invited guests/);assert.doesNotMatch(JSON.stringify(p),/guest@example|master/);
 assert.equal((await executeDeletion(f.store,payload,f.options)).status,'deleted');assert.equal(f.calls.find(c=>c[0]==='delete')[3],REMOTE);
});

test('ETag or local schedule changes require a fresh preview; If-Match 412 never reports success',async()=>{
 const f=await setup(),{payload}=await queued(f);f.setRaw({...raw,etag:'"v2"',summary:'Moved meeting'});
 const stale=await executeDeletion(f.store,payload,f.options);assert.equal(stale.status,'stale');assert.equal(f.calls.some(c=>c[0]==='delete'),false);
 const preview=await createDeletionProposal(f.store,stale.retry,f.options);assert.equal(preview.title,'Moved meeting');
 const g=await setup(),q=await queued(g);g.client.remove=async()=>({status:412});assert.equal((await executeDeletion(g.store,q.payload,g.options)).status,'stale');
 const h=await setup(),p=await createDeletionProposal(h.store,{localId:LOCAL},h.options);await h.store.put('events',LOCAL,{...event,start:'2026-11-15T18:00:00Z'});await assert.rejects(confirmDeletion(h.store,h.queue,{id:p.id,revision:1},h.options),/changed/);
});

test('404 is success only after absence and continued calendar access are verified',async()=>{
 const f=await setup(),{payload}=await queued(f);f.setRaw(null);assert.equal((await executeDeletion(f.store,payload,f.options)).status,'already-deleted');assert.equal(f.calls.some(c=>c[0]==='delete'),false);
 const g=await setup(),q=await queued(g);g.setRaw(null);g.client.list=async()=>{throw missing(403);};assert.equal((await executeDeletion(g.store,q.payload,g.options)).status,'failed');
 const h=await setup(),r=await queued(h);h.client.remove=async()=>({status:404});assert.equal((await executeDeletion(h.store,r.payload,h.options)).status,'failed');
});

test('timeouts reconcile observed absence but never retry an uncertain DELETE automatically',async()=>{
 const f=await setup(),{payload}=await queued(f);let attempts=0;
 f.client.remove=async()=>{attempts++;const e=Error('timeout');e.uncertain=true;throw e;};
 const first=await executeDeletion(f.store,payload,f.options);assert.equal(first.status,'uncertain');assert.ok(first.retry);
 assert.equal((await executeDeletion(f.store,payload,f.options)).status,'uncertain');assert.equal(attempts,1);
 const g=await setup(),q=await queued(g);g.client.remove=async()=>{g.setRaw(null);const e=Error('timeout');e.uncertain=true;throw e;};assert.equal((await executeDeletion(g.store,q.payload,g.options)).status,'deleted');
});

test('unsynced local items can be removed, including when a BRB calendar already exists',async()=>{
 const f=await setup();await f.store.delete('secrets','google');await f.store.put('events',LOCAL,{...event,googleId:undefined});
 const {p,payload}=await queued(f);assert.equal(p.localOnly,true);assert.equal((await executeDeletion(f.store,payload,f.options)).status,'local-only');assert.equal(f.calls.length,0);
 const g=await setup();await g.store.put('events',LOCAL,{...event,googleId:undefined});g.setRaw(null);const q=await queued(g);assert.equal((await executeDeletion(g.store,q.payload,g.options)).status,'local-only');assert.equal(g.calls.some(c=>c[0]==='delete'),false);
});

test('queue failure keeps suppression durable and offers a fresh explicit preview',async()=>{
 const f=await setup(),p=await createDeletionProposal(f.store,{localId:LOCAL},f.options);f.queue.enqueue=async()=>{throw Error('queue full');};
 const result=await confirmDeletion(f.store,f.queue,{id:p.id,revision:1},f.options);assert.equal(result.status,'failed');assert.equal(await calendarEventRemoved(f.store,{localId:LOCAL}),true);assert.match(result.receipt.message,/not confirmed deleted/);
 assert.equal((await createDeletionProposal(f.store,{retryProposalId:p.id},f.options)).status,'preview');
});

test('search is bounded, paginated, owned and upcoming-first; search candidates expire and bind to Telegram',async()=>{
 const f=await setup();await f.store.put('events','past',{...event,id:'past',title:'Yesterday',start:'2026-11-11T18:00:00Z'});
 for(let i=0;i<10;i++)await f.store.put('events',`row${i}`,{...event,id:`row${i}`,title:`Office hours ${i}`,start:`2026-11-${String(14+i).padStart(2,'0')}T18:00:00Z`});
 const first=await listDeletionCandidates(f.store,{},f.options);assert.equal(first.items.length,8);assert.equal(first.hasMore,true);assert.equal(first.items[0].title,event.title);assert.match(first.notice,/30 days/);assert.doesNotMatch(JSON.stringify(first),/refresh|access_token|remoteId|credentialVersion/);
 const second=await listDeletionCandidates(f.store,{offset:8},f.options);assert.equal(second.items.at(-1).title,'Yesterday');
 const query=await listDeletionCandidates(f.store,{query:'study'},f.options);assert.equal(query.items.length,1);
 await assert.rejects(createDeletionProposal(f.store,{candidateId:query.items[0].id},{...f.options,now:()=>NOW+16*60000}),/expired/);
 await f.store.put('secrets','telegram',{...binding,linkedAt:'new'});await assert.rejects(createDeletionProposal(f.store,{candidateId:query.items[0].id},{...f.options,binding:{...binding,linkedAt:'new'}}),/earlier Telegram/);
});

test('sync and deletion share a durable lock; deleted source rows cannot recreate Google events or reminders',async()=>{
 const f=await setup(),{payload}=await queued(f);await executeDeletion(f.store,payload,f.options);
 await f.store.put('events',LOCAL,event); // Simulate a stale importer overwriting the source row.
 await reconcileReminders(f.store,{now});assert.equal((await f.store.all('reminders')).length,0);
 const original=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Must not write a removed event');};
 try{assert.equal((await syncGoogle(f.store)).count,0);}finally{globalThis.fetch=original;}
 await withCalendarMutationLock(f.store,async()=>{await assert.rejects(syncGoogle(f.store),/Another calendar update/);});
});

test('Google adapter sends conditional DELETE only to fixed Google path and rejects a copied personal grant',async()=>{
 const f=await setup({personal:true}),calls=[];
 const client=createCalendarDeletionClient({now,fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(null,{status:204});}});
 assert.deepEqual(await client.remove(f.store,'calendarEditGoogle','mine',REMOTE,{etag:'"v1"',sendUpdates:'all'}),{status:204});
 assert.equal(calls[0].options.method,'DELETE');assert.equal(calls[0].options.headers['If-Match'],'"v1"');assert.equal(calls[0].options.redirect,'error');assert.equal(new URL(calls[0].url).origin,'https://www.googleapis.com');assert.equal(new URL(calls[0].url).searchParams.get('sendUpdates'),'all');
 const grant=await f.store.get('secrets','calendarEditGoogle');await f.store.put('secrets','calendarEditGoogle',{...grant,subject:'another'});await assert.rejects(client.remove(f.store,'calendarEditGoogle','mine',REMOTE,{etag:'"v1"',sendUpdates:'all'}),/Reconnect/);assert.equal(calls.length,1);
});

test('unresolved removals are searchable after old buttons expire and require a new live preview',async()=>{
 const f=await setup(),{payload}=await queued(f);f.setRaw({...raw,etag:'"v2"',summary:'Study tomorrow'});
 const result=await executeDeletion(f.store,payload,f.options);assert.equal(result.status,'stale');assert.match(result.message,/reminders.*remain paused/);
 const later={...f.options,now:()=>NOW+20*60000};
 const search=await listDeletionCandidates(f.store,{query:'study'},later);assert.equal(search.items.length,1);assert.equal(search.items[0].needsReview,true);assert.match(search.notice,/Removal needs review/);
 const fresh=await createDeletionProposal(f.store,{candidateId:search.items[0].id},later);assert.equal(fresh.title,'Study tomorrow');assert.equal(fresh.status,'preview');assert.equal(f.calls.some(c=>c[0]==='delete'),false);
 await confirmDeletion(f.store,f.queue,{id:fresh.id,revision:1},later);
 assert.equal((await listDeletionCandidates(f.store,{},later)).items.length,0);
 assert.equal((await executeDeletion(f.store,f.jobs.at(-1).payload,later)).status,'deleted');
 assert.equal((await listDeletionCandidates(f.store,{},later)).items.length,0);
});

test('all-day preview preserves the exclusive end date, and refreshing a preview supersedes its old Delete button',async()=>{
 const f=await setup();f.setRaw({...raw,start:{date:'2026-11-13'},end:{date:'2026-11-15'}});
 const p=await createDeletionProposal(f.store,{localId:LOCAL},f.options);assert.equal(p.allDay,true);assert.equal(p.endDate,'2026-11-15');
 const fresh=await createDeletionProposal(f.store,{retryProposalId:p.id},f.options);assert.notEqual(fresh.id,p.id);
 assert.equal((await confirmDeletion(f.store,f.queue,{id:p.id,revision:1},f.options)).status,'superseded');assert.equal(f.jobs.length,0);
});

test('OAuth refresh racing reconnection cannot send DELETE with an old confirmation',async()=>{
 const f=await setup({personal:true}),cfg=await f.store.get('secrets','calendarEditGoogle');await f.store.put('secrets','calendarEditGoogle',{...cfg,expiresAt:0});let deletes=0;
 const client=createCalendarDeletionClient({now,fetchImpl:async(url,options)=>{
   if(options.method==='DELETE'){deletes++;return new Response(null,{status:204});}
   assert.equal(String(url),'https://oauth2.googleapis.com/token');
   const current=await f.store.get('secrets','calendarEditGoogle');await f.store.put('secrets','calendarEditGoogle',{...current,connectionRevision:'z'.repeat(43)});
   return new Response(JSON.stringify({access_token:'new-access',expires_in:3600}),{headers:{'content-type':'application/json'}});
 }});
 await assert.rejects(client.remove(f.store,'calendarEditGoogle','mine',REMOTE,{etag:'"v1"',sendUpdates:'all'}),/connection changed/);assert.equal(deletes,0);
});

test('a concurrent BRB sync token refresh cannot restore disconnected Google credentials',async()=>{
 const f=await setup(),cfg=await f.store.get('secrets','google');await f.store.put('secrets','google',{...cfg,expiresAt:0});
 const original=globalThis.fetch;globalThis.fetch=async()=>{await f.store.delete('secrets','google');return new Response(JSON.stringify({access_token:'refreshed',expires_in:3600}),{headers:{'content-type':'application/json'}});};
 try{await assert.rejects(googleAccess(f.store),/connection changed/);}finally{globalThis.fetch=original;}
 assert.equal(await f.store.get('secrets','google'),null);
});
