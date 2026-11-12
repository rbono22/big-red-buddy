import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {CALENDAR_SCOPE,CAMPUS_CALENDAR_SCOPES} from '../lib/auth.mjs';
import {ingestCampusSnapshot} from '../lib/campus-calendar.mjs';
import {ingestPartifulSnapshot} from '../lib/partiful-calendar.mjs';
import {eventApprovalVersion} from '../lib/event-version.mjs';
import {createLumaCalendar,ingestLumaSnapshot,addLumaEvent,saveLumaSettings,saveLumaIntent,disconnectLumaCalendar,lumaRSVP,LUMA_FRESHNESS_NOTICE} from '../lib/luma-calendar.mjs';

const NOW=Date.parse('2026-11-10T21:00:00Z'),now=()=>NOW,calendarId='luma@import.calendar.google.com',link='https://luma.com/TQ9R6V4MN2ZX7aBcDeF1GH';
const credentials={access_token:'synthetic-reader',refresh_token:'synthetic-refresh',expiresAt:NOW+3600000,scope:CAMPUS_CALENDAR_SCOPES.join(' ')};
async function fixture(t,userId='student-a'){const dir=await mkdtemp(path.join(tmpdir(),'brf-luma-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true}),store=db.forUser(userId);t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});await store.put('secrets','campusGoogle',credentials);await store.put('secrets','google',{refresh_token:'synthetic-writer',scope:CALENDAR_SCOPE});return {db,store};}
const event=(id='gathering',extra={})=>({id,summary:'Alumni gathering',description:`View this event on Luma at ${link}\nMeet other students.`,location:'Roosevelt Island',start:{dateTime:'2026-11-11T18:00:00-05:00'},end:{dateTime:'2026-11-11T20:00:00-05:00'},htmlLink:'https://calendar.google.com/calendar/event?eid=synthetic',updated:'2026-11-10T20:00:00Z',...extra});
const snapshot=items=>({calendarId,calendarName:'Luma',items,windowStart:new Date(NOW).toISOString(),windowEnd:new Date(NOW+30*86400000).toISOString(),fetchedAt:new Date(NOW).toISOString(),complete:true});
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function provider(getEvents=()=>({items:[event()]})){
 const calls=[];const client=createLumaCalendar({now,fetchImpl:async(url,options)=>{calls.push({url:String(url),method:options.method});assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,'Bearer synthetic-reader');const u=new URL(url);assert.equal(u.origin,'https://www.googleapis.com');if(u.pathname==='/calendar/v3/users/me/calendarList')return response({items:[{id:calendarId,summary:'Luma',accessRole:'reader'}]});if(u.pathname===`/calendar/v3/users/me/calendarList/${encodeURIComponent(calendarId)}`)return response({id:calendarId,summary:'Luma',accessRole:'reader',timeZone:'America/New_York'});if(u.pathname===`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`)return response(await getEvents(u));throw new Error('Unexpected provider path');}});return {client,calls};
}

test('canonical RSVP extraction ignores hostile hosts, credentials and private subscription links',()=>{
 assert.equal(lumaRSVP(`<a href="${link}?ref=calendar&amp;secret=omit">RSVP</a>`),link);assert.equal(lumaRSVP(`See ${link}.`),link);
 assert.equal(lumaRSVP('https://lu.ma/alumni-study-night?invite=private-secret#ticket'),'https://lu.ma/alumni-study-night');
 assert.equal(lumaRSVP('https://luma.com/Product_Night/'),'https://luma.com/Product_Night');
 for(const value of ['http://luma.com/event-id','https://luma.com.evil.test/event-id','https://user:secret@luma.com/event-id','https://luma.com/private/feed.ics','https://luma.com/event-id/extra','https://luma.com:8443/event-id','https://evil.test/?next='+link,'https://api.luma.com/ics/get?token=private','https://api.lu.ma/ics/get?token=private','https://luma.com/settings','https://lu.ma/SETTINGS','https://luma.com/api','https://lu.ma/ics','https://luma.com/calendar','https://luma.com/discover','https://lu.ma/sf','https://luma.com/%73ettings','https://lu.ma/private','https://luma.com/checkout','https://luma.com/auth?token=secret'])assert.equal(lumaRSVP(value),'',value);
});

test('explicit Luma approval is bound to the reviewed candidate while connector metadata stays irrelevant',async t=>{
 const {store}=await fixture(t);await ingestLumaSnapshot(store,snapshot([event()]),{now});const original=(await store.all('lumaEvents'))[0],expectedVersion=eventApprovalVersion(original);
 await store.put('lumaEvents',original.id,{...original,rsvpUrl:'https://luma.com/changed-event'});
 await assert.rejects(addLumaEvent(store,{id:original.id},null,{now,expectedVersion}),{status:409});assert.equal((await store.all('events')).length,0);
 await assert.rejects(saveLumaIntent(store,{id:original.id,intent:'going'},{now,expectedVersion}),{status:409});assert.equal((await store.get('lumaEvents',original.id)).localIntent,null);
 const latest=await store.get('lumaEvents',original.id);await store.put('lumaEvents',latest.id,{...latest,fetchedAt:'2026-11-10T22:00:00Z',localIntentNotice:'Reminder of local planning only'});assert.equal((await addLumaEvent(store,{id:latest.id},null,{now,expectedVersion:eventApprovalVersion(latest)})).imported,1);
 await saveLumaIntent(store,{id:original.id,intent:'declined'},{now});const declined=await store.get('lumaEvents',original.id);await assert.rejects(addLumaEvent(store,{id:original.id},null,{now,expectedVersion:eventApprovalVersion(declined)}),{status:400});assert.equal((await store.all('events'))[0].status,'dismissed');
});

test('uses the shared read grant and keeps selection separate from campus and assistant calendars',async t=>{
 const {db,store}=await fixture(t),{client,calls}=provider();await store.put('settings','campusCalendar',{calendarId:'cornell-campus',continuous:true});await store.put('secrets','google',{refresh_token:'write-only',calendarId:'assistant'});
 assert.equal((await client.listLumaCalendars(store))[0].name,'Luma');const selected=await client.selectLumaCalendar(store,{calendarId});assert.equal(selected.autoAdd,false);assert.equal((await store.get('settings','campusCalendar')).calendarId,'cornell-campus');assert.equal((await store.get('secrets','google')).calendarId,'assistant');assert.ok(calls.every(call=>call.method==='GET'));
 await assert.rejects(client.listLumaCalendars(db.forUser('other')),{status:403});assert.equal((await db.forUser('other').all('lumaEvents')).length,0);
});

test('ordinary and assistant-owned calendars cannot become a Luma source or create a copy loop',async t=>{
 const {store}=await fixture(t);await store.put('secrets','google',{calendarId:'assistant@group.calendar.google.com',refresh_token:'write-only'});const calls=[];
 const client=createLumaCalendar({now,fetchImpl:async(url)=>{calls.push(url);return response({items:[{id:calendarId,summary:'Luma',accessRole:'reader'},{id:'assistant@group.calendar.google.com',summary:'BRB assistant',accessRole:'owner'},{id:'student@cornell.edu',summary:'Primary',accessRole:'owner'}]});}});
 assert.deepEqual((await client.listLumaCalendars(store)).map(calendar=>calendar.id),[calendarId]);
 for(const id of ['assistant@group.calendar.google.com','student@cornell.edu','https://luma.com/private/feed.ics'])await assert.rejects(client.selectLumaCalendar(store,{calendarId:id,autoAdd:true}),{status:400});
 assert.equal(calls.length,1,'invalid selection is rejected before any provider request');assert.equal(await store.get('settings','lumaCalendar'),null);
 await store.put('secrets','google',{calendarId,refresh_token:'write-only'});assert.deepEqual(await client.listLumaCalendars(store),[]);await assert.rejects(client.selectLumaCalendar(store,{calendarId}),{status:400});
});

test('snapshots namespace candidate IDs and preserve campus data even for the same selected calendar',async t=>{
 const {store}=await fixture(t);await ingestCampusSnapshot(store,snapshot([event()]),{now});await ingestPartifulSnapshot(store,snapshot([event()]),{now});await ingestLumaSnapshot(store,snapshot([event()]),{now});
 const [campus]=await store.all('campusEvents'),[partiful]=await store.all('partifulEvents'),[luma]=await store.all('lumaEvents');assert.equal(new Set([campus.id,partiful.id,luma.id]).size,3);assert.equal(luma.rsvpUrl,link);assert.equal(luma.sourceUrl,link);assert.equal(luma.localIntent,null);assert.equal(luma.connector,'luma');assert.equal((await store.get('settings','lumaCalendar')).autoAdd,false);assert.equal((await store.all('events')).length,0);assert.match((await store.get('settings','lumaCalendar')).warning,/12–24 hours/);
 assert.match(luma.localIntentNotice,/does not confirm Luma registration/);assert.equal((await store.get('settings','partifulCalendar')).calendarId,calendarId);
});

test('automatic import needs explicit opt-in, complete timing and a validated Luma event link',async t=>{
 const {store}=await fixture(t),jobs=[],{client}=provider(()=>({items:[event(),event('all-day',{start:{date:'2026-11-12'},end:{date:'2026-11-13'}}),event('wrong-calendar-content',{description:'Ordinary class without Luma link'}),event('hostile',{description:'https://luma.com.evil.test/e/private'})]}));
 await client.selectLumaCalendar(store,{calendarId});await client.syncLumaCalendar(store);assert.equal((await store.all('events')).length,0);await store.put('secrets','google',{refresh_token:'synthetic-write',scope:CALENDAR_SCOPE});await saveLumaSettings(store,{autoAdd:true},{now});
 const result=await client.syncLumaCalendar(store,{queue:{async enqueue(owner,type,payload){jobs.push({owner,type,payload});return {id:'job'};}}});assert.equal(result.autoAdded,1);assert.equal(jobs.length,1);assert.equal(jobs[0].type,'google-sync');const [added]=await store.all('events');assert.equal(added.status,'approved');assert.ok(added.lumaCandidateId);assert.equal(added.campusCandidateId,undefined);assert.match(added.approvalMethod,/automatic import/);assert.equal((await store.all('reminders')).filter(r=>r.status==='pending').length,1);
});

test('automatic import is bounded to twenty candidates per refresh and later refreshes drain without duplicates',async t=>{
 const {store}=await fixture(t),{client}=provider(()=>({items:Array.from({length:21},(_,index)=>event(`gathering-${index}`))}));await client.selectLumaCalendar(store,{calendarId,autoAdd:true});
 const first=await client.syncLumaCalendar(store);assert.equal(first.autoAdded,20);assert.equal(first.autoAddPending,1);assert.equal((await store.all('events')).length,20);
 const second=await client.syncLumaCalendar(store);assert.equal(second.autoAdded,1);assert.equal(second.autoAddPending,0);assert.equal((await store.all('events')).length,21);assert.equal((await client.syncLumaCalendar(store)).autoAdded,0);
});

test('unchanged refresh retains approval, intent and reminders without duplicate imports',async t=>{
 const {store}=await fixture(t),{client}=provider(()=>({items:[event('untitled',{summary:''})]}));await client.selectLumaCalendar(store,{calendarId,autoAdd:true});const first=await client.syncLumaCalendar(store);assert.equal(first.autoAdded,1);const [candidate]=await store.all('lumaEvents');await saveLumaIntent(store,{id:candidate.id,intent:'going'},{now});
 const again=await client.syncLumaCalendar(store);assert.equal(again.changed,0);assert.equal(again.autoAdded,0);assert.equal((await store.all('events')).length,1);assert.equal((await store.all('events'))[0].status,'approved');assert.equal((await store.all('events'))[0].title,'Untitled Luma event');assert.equal((await store.get('lumaEvents',candidate.id)).localIntent,'going');assert.equal((await store.all('reminders')).filter(r=>r.status==='pending').length,1);
});

test('source changes reopen review and automatic import cannot reapprove changed or declined records',async t=>{
 const {store}=await fixture(t);let items=[event()];const {client}=provider(()=>({items}));await client.selectLumaCalendar(store,{calendarId,autoAdd:true});await client.syncLumaCalendar(store);const [candidate]=await store.all('lumaEvents'),[original]=await store.all('events');await store.put('events',original.id,{...original,googleId:'existing-google'});
 items=[event('gathering',{location:'New room'})];const changed=await client.syncLumaCalendar(store);assert.equal(changed.changed,1);assert.equal(changed.autoAdded,0);assert.equal((await store.get('events',original.id)).status,'review');assert.equal((await store.all('reminders')).filter(r=>r.status==='pending').length,0);
 await addLumaEvent(store,{id:candidate.id},null,{now});await saveLumaIntent(store,{id:candidate.id,intent:'declined'},{now});assert.equal((await store.get('events',original.id)).status,'dismissed');assert.equal((await store.get('events',original.id)).googleId,'existing-google');assert.equal((await client.syncLumaCalendar(store)).autoAdded,0);assert.equal((await store.get('lumaEvents',candidate.id)).localIntent,'declined');await assert.rejects(addLumaEvent(store,{id:candidate.id},null,{now}),{status:400});
 await saveLumaIntent(store,{id:candidate.id,intent:'maybe'},{now});assert.equal((await store.get('events',original.id)).status,'dismissed');await addLumaEvent(store,{id:candidate.id},null,{now});assert.equal((await store.get('events',original.id)).status,'approved');assert.equal((await store.get('events',original.id)).localIntent,'maybe');
 items=[];const removed=await client.syncLumaCalendar(store);assert.equal(removed.cancelled,1);assert.equal(removed.autoAdded,0);assert.equal((await store.get('events',original.id)).status,'review');assert.equal((await store.get('events',original.id)).cancelled,true);assert.equal((await store.get('events',original.id)).googleId,'existing-google');assert.equal((await store.all('reminders')).filter(r=>r.status==='pending').length,0);
});

test('a decline before adding survives refresh and prevents automatic addition',async t=>{
 const {store}=await fixture(t),{client}=provider();await client.selectLumaCalendar(store,{calendarId});await client.syncLumaCalendar(store);const [candidate]=await store.all('lumaEvents');await saveLumaIntent(store,{id:candidate.id,intent:'declined'},{now});await saveLumaSettings(store,{autoAdd:true},{now});assert.equal((await client.syncLumaCalendar(store)).autoAdded,0);assert.equal((await store.all('events')).length,0);assert.equal((await store.get('lumaEvents',candidate.id)).localIntent,'declined');
});

test('explicit add is idempotent and local intents cannot read or mutate another student’s event',async t=>{
 const {db,store}=await fixture(t);await ingestLumaSnapshot(store,snapshot([event()]),{now});const [candidate]=await store.all('lumaEvents');
 const first=await addLumaEvent(store,{id:candidate.id},null,{now}),second=await addLumaEvent(store,{id:candidate.id},null,{now});assert.equal(first.imported,1);assert.equal(second.reused,1);assert.equal((await store.all('events')).length,1);assert.equal(first.providerRSVPConfirmed,false);assert.equal(first.providerRegistrationConfirmed,false);assert.ok((await store.all('events'))[0].lumaCandidateId);assert.equal((await store.all('events'))[0].partifulCandidateId,undefined);
 const other=db.forUser('other');await other.put('settings','lumaCalendar',{calendarId});await assert.rejects(saveLumaIntent(other,{id:candidate.id,intent:'going'},{now}),{status:404});await assert.rejects(addLumaEvent(other,{id:candidate.id},null,{now}),{status:404});assert.equal((await other.all('events')).length,0);
});

test('disconnect preserves the shared read grant, campus source and snapshot while disabling Luma auto-add',async t=>{
 const {store}=await fixture(t),{client}=provider();await store.put('settings','campusCalendar',{calendarId:'cornell',continuous:true});await store.put('settings','partifulCalendar',{calendarId:'partiful-source',continuous:true,autoAdd:true});await client.selectLumaCalendar(store,{calendarId,autoAdd:true});await client.syncLumaCalendar(store);const disconnected=await disconnectLumaCalendar(store,{now});assert.equal(disconnected.continuous,false);assert.equal(disconnected.autoAdd,false);assert.equal((await store.get('settings','campusCalendar')).continuous,true);assert.equal((await store.get('settings','partifulCalendar')).autoAdd,true);assert.equal((await store.get('secrets','campusGoogle')).refresh_token,'synthetic-refresh');assert.equal((await store.all('lumaEvents')).length,1);await assert.rejects(client.syncLumaCalendar(store),{status:400});await assert.rejects(saveLumaSettings(store,{autoAdd:true},{now}),{status:403});
});

test('failed pages and malformed successful listings preserve prior events and reminders',async t=>{
 const {store}=await fixture(t);let mode='valid';const {client,calls}=provider(u=>{
  assert.equal(Date.parse(u.searchParams.get('timeMax'))-Date.parse(u.searchParams.get('timeMin')),90*86400000);assert.equal(u.searchParams.get('singleEvents'),'true');
  if(mode==='bad-page'){if(u.searchParams.get('pageToken'))return {};return {items:[],nextPageToken:'page-two'};}
  return mode==='invalid'?{}:{items:[event()]};
 });
 await client.selectLumaCalendar(store,{calendarId,autoAdd:true});await client.syncLumaCalendar(store);const [added]=await store.all('events');
 mode='bad-page';await assert.rejects(client.syncLumaCalendar(store),/invalid paging data/);assert.equal((await store.get('events',added.id)).status,'approved');assert.equal((await store.all('reminders')).filter(r=>r.status==='pending').length,1);
 mode='invalid';await assert.rejects(client.syncLumaCalendar(store),/invalid paging data/);assert.equal((await store.get('events',added.id)).status,'approved');assert.ok(calls.every(call=>call.method==='GET'));
});

test('pending and waitlisted personal subscription entries remain planning records, never registration confirmation',async t=>{
 const {store}=await fixture(t),{client}=provider(()=>({items:[event('pending',{description:`Registration pending approval. ${link}`,attendees:[{self:true,responseStatus:'needsAction'}]}),event('waitlisted',{description:`You are on the waitlist. https://lu.ma/waitlisted-example`})]}));
 await client.selectLumaCalendar(store,{calendarId});await client.syncLumaCalendar(store);const candidates=await store.all('lumaEvents');assert.equal(candidates.length,2);assert.equal((await store.all('events')).length,0);
 for(const event of candidates){assert.equal(event.localIntent,null);assert.equal(event.registrationConfirmed,undefined);assert.match(event.localIntentNotice,/does not confirm/);}
 const local=await saveLumaIntent(store,{id:candidates[0].id,intent:'going'},{now});assert.match(local.localIntentNotice,/does not register you/);assert.equal((await store.all('events')).length,0);
 const result=await addLumaEvent(store,{id:candidates[0].id},null,{now});assert.equal(result.providerRegistrationConfirmed,false);assert.ok(result.warnings.some(warning=>warning.includes('does not confirm registration')));
});

test('disconnect or source change during fetch prevents a late response from restoring or importing data',async t=>{
 const {store}=await fixture(t),{client}=provider(async()=>{const config=await store.get('settings','lumaCalendar');await store.put('settings','lumaCalendar',{...config,continuous:false,autoAdd:false,connectionRevision:'disconnected'});return {items:[event()]};});await client.selectLumaCalendar(store,{calendarId});await assert.rejects(client.syncLumaCalendar(store),{status:409});assert.equal((await store.all('lumaEvents')).length,0);assert.equal((await store.get('settings','lumaCalendar')).continuous,false);assert.ok((await store.get('secrets','campusGoogle')).refresh_token);
});

test('shared token refresh cannot recreate a grant disconnected while a provider request was pending',async t=>{
 const {store}=await fixture(t);await store.put('secrets','campusGoogle',{...credentials,expiresAt:NOW-1});const client=createLumaCalendar({now,fetchImpl:async(url,options)=>{assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.method,'POST');await store.delete('secrets','campusGoogle');return response({access_token:'new',expires_in:3600,scope:CAMPUS_CALENDAR_SCOPES.join(' ')});}});await assert.rejects(client.listLumaCalendars(store),{status:409});assert.equal(await store.get('secrets','campusGoogle'),null);
});

test('settings stay bounded, freshness notice does not grow, and private ICS links are not exposed as sources',async t=>{
 const {store}=await fixture(t),{client}=provider(()=>({items:[event('private-link',{description:'No public Luma link',htmlLink:'https://calendar.google.com/calendar/ical/private/secret/basic.ics'})]}));await client.selectLumaCalendar(store,{calendarId});for(let i=0;i<6;i++)await saveLumaSettings(store,{autoAdd:false},{now});const config=await store.get('settings','lumaCalendar');assert.equal(config.warning.split(LUMA_FRESHNESS_NOTICE).length-1,1);
 for(const patch of [null,{},[],{autoAdd:'yes'},{autoAdd:true,calendarId:'other'}])await assert.rejects(saveLumaSettings(store,patch,{now}),{status:400});await assert.rejects(client.selectLumaCalendar(store,null),{status:400});await client.syncLumaCalendar(store);const [candidate]=await store.all('lumaEvents');assert.equal(candidate.rsvpUrl,'');assert.equal(candidate.sourceUrl,'');
});

test('Luma auto-add requires both grants before changing settings or calendar selection',async t=>{
 const {store,db}=await fixture(t),{client,calls}=provider();await client.selectLumaCalendar(store,{calendarId});const original=await store.get('settings','lumaCalendar');
 for(const write of [null,{refresh_token:'writer-without-scope'},{refresh_token:'reader-only',scope:CAMPUS_CALENDAR_SCOPES.join(' ')},{scope:CALENDAR_SCOPE}]){
  if(write)await store.put('secrets','google',write);else await store.delete('secrets','google');
  await assert.rejects(saveLumaSettings(store,{autoAdd:true},{now}),{status:403});const count=calls.length;await assert.rejects(client.selectLumaCalendar(store,{calendarId,autoAdd:true}),{status:403});assert.equal(calls.length,count);assert.deepEqual(await store.get('settings','lumaCalendar'),original);
 }
 await store.put('secrets','google',{refresh_token:'writer',scope:CALENDAR_SCOPE});await store.put('secrets','campusGoogle',{...credentials,scope:CAMPUS_CALENDAR_SCOPES[0]});await assert.rejects(saveLumaSettings(store,{autoAdd:true},{now}),{status:403});assert.equal((await saveLumaSettings(store,{autoAdd:false},{now})).autoAdd,false);
 const other=db.forUser('other');await assert.rejects(client.selectLumaCalendar(other,{calendarId,autoAdd:true}),{status:403});assert.equal(await other.get('settings','lumaCalendar'),null);assert.equal((await other.all('lumaEvents')).length,0);assert.equal((await store.get('settings','lumaCalendar')).calendarId,calendarId);
});

test('Luma automatic import rechecks revoked write access and current validated timing',async t=>{
 const {store}=await fixture(t),{client}=provider();await client.selectLumaCalendar(store,{calendarId,autoAdd:true});await store.delete('secrets','google');
 const blocked=await client.syncLumaCalendar(store);assert.equal(blocked.autoAdded,0);assert.equal(blocked.autoAddPending,1);assert.ok(blocked.calendarError);assert.equal((await store.all('events')).length,0);assert.equal((await store.all('reminders')).length,0);
 await store.put('secrets','google',{refresh_token:'writer',scope:CALENDAR_SCOPE});const candidate=(await store.all('lumaEvents'))[0];await store.put('lumaEvents',candidate.id,{...candidate,end:'not-a-date'});await assert.rejects(addLumaEvent(store,{id:candidate.id},null,{now,automatic:true}),{status:400});assert.equal((await store.all('events')).length,0);
 await store.put('lumaEvents',candidate.id,candidate);assert.equal((await client.syncLumaCalendar(store)).autoAdded,1);
});
