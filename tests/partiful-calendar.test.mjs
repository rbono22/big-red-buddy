import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {CALENDAR_SCOPE,CAMPUS_CALENDAR_SCOPES} from '../lib/auth.mjs';
import {ingestCampusSnapshot} from '../lib/campus-calendar.mjs';
import {eventApprovalVersion} from '../lib/event-version.mjs';
import {createPartifulCalendar,ingestPartifulSnapshot,addPartifulEvent,savePartifulSettings,savePartifulIntent,disconnectPartifulCalendar,partifulRSVP,PARTIFUL_FRESHNESS_NOTICE} from '../lib/partiful-calendar.mjs';

const NOW=Date.parse('2026-11-10T21:00:00Z'),now=()=>NOW,calendarId='partiful@import.calendar.google.com',link='https://partiful.com/e/TQ9R6V4MN2ZX7aBcDeF1GH';
const credentials={access_token:'synthetic-reader',refresh_token:'synthetic-refresh',expiresAt:NOW+3600000,scope:CAMPUS_CALENDAR_SCOPES.join(' ')};
async function fixture(t,userId='student-a'){const dir=await mkdtemp(path.join(tmpdir(),'brf-partiful-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true}),store=db.forUser(userId);t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});await store.put('secrets','campusGoogle',credentials);await store.put('secrets','google',{refresh_token:'synthetic-writer',scope:CALENDAR_SCOPE});return {db,store};}
const event=(id='gathering',extra={})=>({id,summary:'Alumni gathering',description:`View this event on Partiful at ${link}\nMeet other students.`,location:'Roosevelt Island',start:{dateTime:'2026-11-11T18:00:00-05:00'},end:{dateTime:'2026-11-11T20:00:00-05:00'},htmlLink:'https://calendar.google.com/calendar/event?eid=synthetic',updated:'2026-11-10T20:00:00Z',...extra});
const snapshot=items=>({calendarId,calendarName:'Partiful',items,windowStart:new Date(NOW).toISOString(),windowEnd:new Date(NOW+30*86400000).toISOString(),fetchedAt:new Date(NOW).toISOString(),complete:true});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function provider(getEvents=()=>({items:[event()]})){
 const calls=[];const client=createPartifulCalendar({now,fetchImpl:async(url,options)=>{calls.push({url:String(url),method:options.method});assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer synthetic-reader');const u=new URL(url);assert.equal(u.origin,'https://www.googleapis.com');if(u.pathname==='/calendar/v3/users/me/calendarList')return response({items:[{id:calendarId,summary:'Partiful',accessRole:'reader'}]});if(u.pathname===`/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`)return response({id:calendarId,summary:'Partiful',accessRole:'reader',timeZone:'America/New_York'});if(u.pathname===`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`)return response(await getEvents(u));throw new Error('Unexpected provider path');}});return {client,calls};
}

test('canonical RSVP extraction ignores hostile hosts, credentials and private subscription links',()=>{
 assert.equal(partifulRSVP(`<a href="${link}?ref=calendar&amp;secret=omit">RSVP</a>`),link);assert.equal(partifulRSVP(`See ${link}.`),link);
 for(const value of ['http://partiful.com/e/id','https://partiful.com.evil.test/e/id','https://user:secret@partiful.com/e/id','https://partiful.com/private/feed.ics','https://partiful.com/e/id/extra','https://partiful.com:8443/e/id','https://evil.test/?next='+link])assert.equal(partifulRSVP(value),'');
});

test('explicit Partiful approval is bound to the reviewed candidate under its own source lock',async t=>{
 const {store}=await fixture(t);await ingestPartifulSnapshot(store,snapshot([event()]),{now});const original=(await store.all('partifulEvents'))[0],expectedVersion=eventApprovalVersion(original);
 await store.put('partifulEvents',original.id,{...original,location:'Changed room'});
 await assert.rejects(addPartifulEvent(store,{id:original.id},null,{now,expectedVersion}),{status:409});assert.equal((await store.all('events')).length,0);
 await assert.rejects(savePartifulIntent(store,{id:original.id,intent:'going'},{now,expectedVersion}),{status:409});assert.equal((await store.get('partifulEvents',original.id)).localIntent,null);
 const latest=await store.get('partifulEvents',original.id);assert.equal((await addPartifulEvent(store,{id:original.id},null,{now,expectedVersion:eventApprovalVersion(latest)})).imported,1);
 await savePartifulIntent(store,{id:original.id,intent:'declined'},{now});const declined=await store.get('partifulEvents',original.id);await assert.rejects(addPartifulEvent(store,{id:original.id},null,{now,expectedVersion:eventApprovalVersion(declined)}),{status:400});assert.equal((await store.all('events'))[0].status,'dismissed');
});

test('Partiful auto-add requires both grants before changing settings or calendar selection',async t=>{
 const {store,db}=await fixture(t),{client,calls}=provider();await client.selectPartifulCalendar(store,{calendarId});const original=await store.get('settings','partifulCalendar');
 for(const write of [null,{refresh_token:'writer-without-scope'},{refresh_token:'reader-only',scope:CAMPUS_CALENDAR_SCOPES.join(' ')},{scope:CALENDAR_SCOPE}]){
  if(write)await store.put('secrets','google',write);else await store.delete('secrets','google');
  await assert.rejects(savePartifulSettings(store,{autoAdd:true},{now}),{status:403});const count=calls.length;await assert.rejects(client.selectPartifulCalendar(store,{calendarId,autoAdd:true}),{status:403});assert.equal(calls.length,count);assert.deepEqual(await store.get('settings','partifulCalendar'),original);
 }
 await store.put('secrets','google',{refresh_token:'writer',scope:CALENDAR_SCOPE});await store.put('secrets','campusGoogle',{...credentials,scope:CAMPUS_CALENDAR_SCOPES[0]});await assert.rejects(savePartifulSettings(store,{autoAdd:true},{now}),{status:403});assert.equal((await savePartifulSettings(store,{autoAdd:false},{now})).autoAdd,false);
 const other=db.forUser('other');await assert.rejects(client.selectPartifulCalendar(other,{calendarId,autoAdd:true}),{status:403});assert.equal(await other.get('settings','partifulCalendar'),null);assert.equal((await other.all('partifulEvents')).length,0);assert.equal((await store.get('settings','partifulCalendar')).calendarId,calendarId);
});

test('Partiful automatic import rechecks revoked write access and current validated timing',async t=>{
 const {store}=await fixture(t),{client}=provider();await client.selectPartifulCalendar(store,{calendarId,autoAdd:true});await store.delete('secrets','google');
 const blocked=await client.syncPartifulCalendar(store);assert.equal(blocked.autoAdded,0);assert.equal(blocked.autoAddPending,1);assert.ok(blocked.calendarError);assert.equal((await store.all('events')).length,0);assert.equal((await store.all('reminders')).length,0);
 await store.put('secrets','google',{refresh_token:'writer',scope:CALENDAR_SCOPE});const candidate=(await store.all('partifulEvents'))[0];await store.put('partifulEvents',candidate.id,{...candidate,end:'not-a-date'});await assert.rejects(addPartifulEvent(store,{id:candidate.id},null,{now,automatic:true}),{status:400});assert.equal((await store.all('events')).length,0);
 await store.put('partifulEvents',candidate.id,candidate);assert.equal((await client.syncPartifulCalendar(store)).autoAdded,1);
});

test('uses the shared read grant and keeps selection separate from campus and assistant calendars',async t=>{
 const {db,store}=await fixture(t),{client,calls}=provider();await store.put('settings','campusCalendar',{calendarId:'cornell-campus',continuous:true});await store.put('secrets','google',{refresh_token:'write-only',calendarId:'assistant'});
 assert.equal((await client.listPartifulCalendars(store))[0].name,'Partiful');const selected=await client.selectPartifulCalendar(store,{calendarId});assert.equal(selected.autoAdd,false);assert.equal((await store.get('settings','campusCalendar')).calendarId,'cornell-campus');assert.equal((await store.get('secrets','google')).calendarId,'assistant');assert.ok(calls.every(call=>call.method==='GET'));
 await assert.rejects(client.listPartifulCalendars(db.forUser('other')),{status:403});assert.equal((await db.forUser('other').all('partifulEvents')).length,0);
});

test('ordinary and assistant-owned calendars cannot become a Partiful source or create a copy loop',async t=>{
 const {store}=await fixture(t);await store.put('secrets','google',{calendarId:'assistant@group.calendar.google.com',refresh_token:'write-only'});const calls=[];
 const client=createPartifulCalendar({now,fetchImpl:async(url)=>{calls.push(url);return response({items:[{id:calendarId,summary:'Partiful',accessRole:'reader'},{id:'assistant@group.calendar.google.com',summary:'BRB assistant',accessRole:'owner'},{id:'student@cornell.edu',summary:'Primary',accessRole:'owner'}]});}});
 assert.deepEqual((await client.listPartifulCalendars(store)).map(calendar=>calendar.id),[calendarId]);
 for(const id of ['assistant@group.calendar.google.com','student@cornell.edu','https://partiful.com/private/feed.ics'])await assert.rejects(client.selectPartifulCalendar(store,{calendarId:id,autoAdd:true}),{status:400});
 assert.equal(calls.length,1,'invalid selection is rejected before any provider request');assert.equal(await store.get('settings','partifulCalendar'),null);
 await store.put('secrets','google',{calendarId,refresh_token:'write-only'});assert.deepEqual(await client.listPartifulCalendars(store),[]);await assert.rejects(client.selectPartifulCalendar(store,{calendarId}),{status:400});
});

test('snapshots namespace candidate IDs and preserve campus data even for the same selected calendar',async t=>{
 const {store}=await fixture(t);await ingestCampusSnapshot(store,snapshot([event()]),{now});await ingestPartifulSnapshot(store,snapshot([event()]),{now});
 const [campus]=await store.all('campusEvents'),[partiful]=await store.all('partifulEvents');assert.notEqual(campus.id,partiful.id);assert.equal(partiful.rsvpUrl,link);assert.equal(partiful.sourceUrl,link);assert.equal(partiful.localIntent,null);assert.equal((await store.get('settings','partifulCalendar')).autoAdd,false);assert.equal((await store.all('events')).length,0);assert.match((await store.get('settings','partifulCalendar')).warning,/24 hours/);
});

test('automatic import needs explicit opt-in, complete timing and a validated Partiful event link',async t=>{
 const {store}=await fixture(t),jobs=[],{client}=provider(()=>({items:[event(),event('all-day',{start:{date:'2026-11-12'},end:{date:'2026-11-13'}}),event('wrong-calendar-content',{description:'Ordinary class without Partiful link'}),event('hostile',{description:'https://partiful.com.evil.test/e/private'})]}));
 await client.selectPartifulCalendar(store,{calendarId});await client.syncPartifulCalendar(store);assert.equal((await store.all('events')).length,0);await store.put('secrets','google',{refresh_token:'synthetic-write',scope:CALENDAR_SCOPE});await savePartifulSettings(store,{autoAdd:true},{now});
 const result=await client.syncPartifulCalendar(store,{queue:{async enqueue(owner,type,payload){jobs.push({owner,type,payload});return {id:'job'};}}});assert.equal(result.autoAdded,1);assert.equal(jobs.length,1);assert.equal(jobs[0].type,'google-sync');const [added]=await store.all('events');assert.equal(added.status,'approved');assert.ok(added.partifulCandidateId);assert.equal(added.campusCandidateId,undefined);assert.match(added.approvalMethod,/automatic import/);assert.equal((await store.all('reminders')).filter(r=>r.status==='pending').length,1);
});

test('automatic import is bounded to twenty candidates per refresh and later refreshes drain without duplicates',async t=>{
 const {store}=await fixture(t),{client}=provider(()=>({items:Array.from({length:21},(_,index)=>event(`gathering-${index}`))}));await client.selectPartifulCalendar(store,{calendarId,autoAdd:true});
 const first=await client.syncPartifulCalendar(store);assert.equal(first.autoAdded,20);assert.equal(first.autoAddPending,1);assert.equal((await store.all('events')).length,20);
 const second=await client.syncPartifulCalendar(store);assert.equal(second.autoAdded,1);assert.equal(second.autoAddPending,0);assert.equal((await store.all('events')).length,21);assert.equal((await client.syncPartifulCalendar(store)).autoAdded,0);
});

test('unchanged refresh retains approval, intent and reminders without duplicate imports',async t=>{
 const {store}=await fixture(t),{client}=provider(()=>({items:[event('untitled',{summary:''})]}));await client.selectPartifulCalendar(store,{calendarId,autoAdd:true});const first=await client.syncPartifulCalendar(store);assert.equal(first.autoAdded,1);const [candidate]=await store.all('partifulEvents');await savePartifulIntent(store,{id:candidate.id,intent:'going'},{now});
 const again=await client.syncPartifulCalendar(store);assert.equal(again.changed,0);assert.equal(again.autoAdded,0);assert.equal((await store.all('events')).length,1);assert.equal((await store.all('events'))[0].status,'approved');assert.equal((await store.all('events'))[0].title,'Untitled Partiful event');assert.equal((await store.get('partifulEvents',candidate.id)).localIntent,'going');assert.equal((await store.all('reminders')).filter(r=>r.status==='pending').length,1);
});

test('source changes reopen review and automatic import cannot reapprove changed or declined records',async t=>{
 const {store}=await fixture(t);let items=[event()];const {client}=provider(()=>({items}));await client.selectPartifulCalendar(store,{calendarId,autoAdd:true});await client.syncPartifulCalendar(store);const [candidate]=await store.all('partifulEvents'),[original]=await store.all('events');await store.put('events',original.id,{...original,googleId:'existing-google'});
 items=[event('gathering',{location:'New room'})];const changed=await client.syncPartifulCalendar(store);assert.equal(changed.changed,1);assert.equal(changed.autoAdded,0);assert.equal((await store.get('events',original.id)).status,'review');assert.equal((await store.all('reminders')).filter(r=>r.status==='pending').length,0);
 await addPartifulEvent(store,{id:candidate.id},null,{now});await savePartifulIntent(store,{id:candidate.id,intent:'declined'},{now});assert.equal((await store.get('events',original.id)).status,'dismissed');assert.equal((await store.get('events',original.id)).googleId,'existing-google');assert.equal((await client.syncPartifulCalendar(store)).autoAdded,0);assert.equal((await store.get('partifulEvents',candidate.id)).localIntent,'declined');await assert.rejects(addPartifulEvent(store,{id:candidate.id},null,{now}),{status:400});
 await savePartifulIntent(store,{id:candidate.id,intent:'maybe'},{now});assert.equal((await store.get('events',original.id)).status,'dismissed');await addPartifulEvent(store,{id:candidate.id},null,{now});assert.equal((await store.get('events',original.id)).status,'approved');assert.equal((await store.get('events',original.id)).localIntent,'maybe');
 items=[];const removed=await client.syncPartifulCalendar(store);assert.equal(removed.cancelled,1);assert.equal(removed.autoAdded,0);assert.equal((await store.get('events',original.id)).status,'review');assert.equal((await store.get('events',original.id)).cancelled,true);assert.equal((await store.get('events',original.id)).googleId,'existing-google');assert.equal((await store.all('reminders')).filter(r=>r.status==='pending').length,0);
});

test('a decline before adding survives refresh and prevents automatic addition',async t=>{
 const {store}=await fixture(t),{client}=provider();await client.selectPartifulCalendar(store,{calendarId});await client.syncPartifulCalendar(store);const [candidate]=await store.all('partifulEvents');await savePartifulIntent(store,{id:candidate.id,intent:'declined'},{now});await savePartifulSettings(store,{autoAdd:true},{now});assert.equal((await client.syncPartifulCalendar(store)).autoAdded,0);assert.equal((await store.all('events')).length,0);assert.equal((await store.get('partifulEvents',candidate.id)).localIntent,'declined');
});

test('explicit add is idempotent and local intents cannot read or mutate another student’s event',async t=>{
 const {db,store}=await fixture(t);await ingestPartifulSnapshot(store,snapshot([event()]),{now});const [candidate]=await store.all('partifulEvents');
 const first=await addPartifulEvent(store,{id:candidate.id},null,{now}),second=await addPartifulEvent(store,{id:candidate.id},null,{now});assert.equal(first.imported,1);assert.equal(second.reused,1);assert.equal((await store.all('events')).length,1);assert.equal(first.providerRSVPConfirmed,false);
 const other=db.forUser('other');await other.put('settings','partifulCalendar',{calendarId});await assert.rejects(savePartifulIntent(other,{id:candidate.id,intent:'going'},{now}),{status:404});await assert.rejects(addPartifulEvent(other,{id:candidate.id},null,{now}),{status:404});assert.equal((await other.all('events')).length,0);
});

test('disconnect preserves the shared read grant, campus source and snapshot while disabling Partiful auto-add',async t=>{
 const {store}=await fixture(t),{client}=provider();await store.put('settings','campusCalendar',{calendarId:'cornell',continuous:true});await client.selectPartifulCalendar(store,{calendarId,autoAdd:true});await client.syncPartifulCalendar(store);const disconnected=await disconnectPartifulCalendar(store,{now});assert.equal(disconnected.continuous,false);assert.equal(disconnected.autoAdd,false);assert.equal((await store.get('settings','campusCalendar')).continuous,true);assert.equal((await store.get('secrets','campusGoogle')).refresh_token,'synthetic-refresh');assert.equal((await store.all('partifulEvents')).length,1);await assert.rejects(client.syncPartifulCalendar(store),{status:400});await assert.rejects(savePartifulSettings(store,{autoAdd:true},{now}),{status:403});
});

test('disconnect or source change during fetch prevents a late response from restoring or importing data',async t=>{
 const {store}=await fixture(t),{client}=provider(async()=>{const config=await store.get('settings','partifulCalendar');await store.put('settings','partifulCalendar',{...config,continuous:false,autoAdd:false,connectionRevision:'disconnected'});return {items:[event()]};});await client.selectPartifulCalendar(store,{calendarId});await assert.rejects(client.syncPartifulCalendar(store),{status:409});assert.equal((await store.all('partifulEvents')).length,0);assert.equal((await store.get('settings','partifulCalendar')).continuous,false);assert.ok((await store.get('secrets','campusGoogle')).refresh_token);
});

test('shared token refresh cannot recreate a grant disconnected while a provider request was pending',async t=>{
 const {store}=await fixture(t);await store.put('secrets','campusGoogle',{...credentials,expiresAt:NOW-1});const client=createPartifulCalendar({now,fetchImpl:async(url,options)=>{assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.method,'POST');await store.delete('secrets','campusGoogle');return response({access_token:'new',expires_in:3600,scope:CAMPUS_CALENDAR_SCOPES.join(' ')});}});await assert.rejects(client.listPartifulCalendars(store),{status:409});assert.equal(await store.get('secrets','campusGoogle'),null);
});

test('settings stay bounded, freshness notice does not grow, and private ICS links are not exposed as sources',async t=>{
 const {store}=await fixture(t),{client}=provider(()=>({items:[event('private-link',{description:'No public Partiful link',htmlLink:'https://calendar.google.com/calendar/ical/private/secret/basic.ics'})]}));await client.selectPartifulCalendar(store,{calendarId});for(let i=0;i<6;i++)await savePartifulSettings(store,{autoAdd:false},{now});const config=await store.get('settings','partifulCalendar');assert.equal(config.warning.split(PARTIFUL_FRESHNESS_NOTICE).length-1,1);
 for(const patch of [null,{},[],{autoAdd:'yes'},{autoAdd:true,calendarId:'other'}])await assert.rejects(savePartifulSettings(store,patch,{now}),{status:400});await assert.rejects(client.selectPartifulCalendar(store,null),{status:400});await client.syncPartifulCalendar(store);const [candidate]=await store.all('partifulEvents');assert.equal(candidate.rsvpUrl,'');assert.equal(candidate.sourceUrl,'');
});
