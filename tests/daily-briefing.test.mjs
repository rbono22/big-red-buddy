import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase,databaseInternals} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {readDailyBriefingSettings,saveDailyBriefingSettings,buildDailyBriefing,scheduleDailyBriefing,dispatchDailyBriefing} from '../lib/daily-briefing.mjs';
import {saveNotificationPreferences,FRESH_NOTIFICATION_PREFERENCES} from '../lib/notification-preferences.mjs';

const NOW=Date.parse('2026-11-10T13:05:00Z');
async function fixture(t,userId='student'){
  const dir=await mkdtemp(path.join(tmpdir(),'brf-briefing-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true}),queue=await createQueue(db,{workerDatabaseUrl:null}),store=db.forUser(userId);
  t.after(async()=>{await queue.close();await db.close();await rm(dir,{recursive:true,force:true});});await store.put('secrets','telegram',{chatId:123});return {db,queue,store};
}
const event=(id,kind,extra={})=>({id,kind,title:`${kind} ${id}`,status:'approved',date:'2026-11-10',start:'2026-11-10T18:00:00Z',end:'2026-11-10T19:00:00Z',location:'Tata L23',...extra});

test('briefing content and coverage include only opted-in daily topics, including review items',async t=>{
 const {store}=await fixture(t);await store.put('events','class',event('class','class',{title:'School-only class'}));await store.put('events','school-review',event('school-review','assignment',{title:'School review item',status:'review'}));await store.put('events','event-review',event('event-review','event',{title:'Private event review',status:'review'}));await store.put('events','party',event('party','event',{title:'Private event title'}));await store.put('jobs','role',{id:'role',title:'Private job title',publishedAt:new Date(NOW).toISOString(),firstSeenAt:new Date(NOW).toISOString()});
 await store.put('settings','partifulCalendar',{calendarId:'partiful'});await store.put('settings','eventEmail',{labelId:'label',continuous:false});await store.put('academicEvents','holiday',{id:'holiday',title:'School holiday',date:'2026-11-10',endDate:'2026-11-11',allDay:true,status:'available'});await store.put('settings','academicCalendar',{lastSuccess:new Date(NOW).toISOString()});
 await saveNotificationPreferences(store,{topics:{school:'daily',events:'off',jobs:'alerts'}});let result=await buildDailyBriefing(store,{now:NOW});
 assert.deepEqual(result.notificationTopics,['school']);assert.match(result.text,/School-only class/);assert.match(result.text,/School review item/);assert.match(result.text,/School holiday/);assert.match(result.text,/Product Studio/);
 for(const hidden of ['Private event','Private job','Campus:','Partiful:','Email:','Jobs:'])assert.equal(result.text.includes(hidden),false,hidden);
 await saveNotificationPreferences(store,{topics:{school:'off',events:'daily'}});result=await buildDailyBriefing(store,{now:NOW});assert.match(result.text,/Private event title/);assert.match(result.text,/Private event review/);
 for(const hidden of ['School-only class','School review item','School holiday','Schedule:','Product Studio:','Academic dates:'])assert.equal(result.text.includes(hidden),false,hidden);
});

test('master off permits selected-topic previews but stops scheduled delivery; alerts-only and future games do not schedule',async t=>{
 const {store,queue}=await fixture(t);await store.put('events','class',event('class','class',{title:'Explicit preview class'}));await saveNotificationPreferences(store,{enabled:false,topics:{school:'daily',events:'off',jobs:'off'}});
 const preview=await buildDailyBriefing(store,{now:NOW});assert.match(preview.text,/Explicit preview class/);assert.match(preview.text,/requested preview/);assert.deepEqual(preview.notificationTopics,['school']);assert.equal((await scheduleDailyBriefing(store,queue,{now:NOW})).reason,'notifications-disabled');
 await saveNotificationPreferences(store,{...FRESH_NOTIFICATION_PREFERENCES,topics:{...FRESH_NOTIFICATION_PREFERENCES.topics,school:'alerts',games:'both'}});assert.equal((await scheduleDailyBriefing(store,queue,{now:NOW})).reason,'no-daily-topics');
 const empty=await buildDailyBriefing(store,{now:NOW});assert.deepEqual(empty.notificationTopics,[]);assert.match(empty.text,/No available daily topics selected/);assert.equal((await queue.list(store.userId)).length,0);
});

test('news briefing uses selected cached summaries and source dates, never processing time or unselected content',async t=>{
 const {store}=await fixture(t);await saveNotificationPreferences(store,{...FRESH_NOTIFICATION_PREFERENCES,topics:{...FRESH_NOTIFICATION_PREFERENCES.topics,news:'daily'}});let reads=0;
 const result=await buildDailyBriefing(store,{now:NOW,readNews:async owned=>{assert.equal(owned.userId,store.userId);reads++;return {providers:[{id:'wsj10point',name:'WSJ 10-Point',selected:true,freshness:'unknown',latest:{id:'saved',date:null,receivedAt:null,createdAt:new Date(NOW).toISOString(),bullets:[{text:'Source-supported saved summary.',url:'https://www.wsj.com/example'},{text:'Unsafe URL not shown',url:'javascript:alert(1)'}]}},{id:'dailypitch',name:'Daily Pitch',selected:false,latest:{id:'excluded',bullets:[{text:'UNSELECTED_NEWS',url:'https://pitchbook.com/example'}]}}],mailbox:{}};}});
 assert.equal(reads,1);assert.equal(result.counts.news,1);assert.deepEqual(result.notificationTopics,['news']);assert.match(result.text,/source date unknown/);assert.match(result.text,/stale or undated cache/);assert.match(result.text,/https:\/\/www.wsj.com\/example/);assert.match(result.text,/does not authenticate/);assert.match(result.text,/Some article links are unavailable/);assert.doesNotMatch(result.text,/UNSELECTED_NEWS|javascript:|source date 2026-11-10/);
 await saveNotificationPreferences(store,{topics:{news:'alerts'}});await buildDailyBriefing(store,{now:NOW,readNews:async()=>{throw new Error('Disabled news must not read cache');}});assert.equal(reads,1);
});

test('real newsletter cache keeps linkless summaries and labels received, header-only, and undated manual dates',async t=>{
 const {store}=await fixture(t);await saveNotificationPreferences(store,{...FRESH_NOTIFICATION_PREFERENCES,topics:{...FRESH_NOTIFICATION_PREFERENCES.topics,news:'daily'}});await store.put('settings','news',{sources:['wsj10point','dailypitch']});
 await store.put('newsSummaries','received',{id:'received',provider:'wsj10point',name:'WSJ 10-Point',receivedAt:new Date(NOW-3600000).toISOString(),date:'2026-11-10',createdAt:new Date(NOW).toISOString(),bullets:[{text:'Cached linkless received item.',url:''}],source:{kind:'gmail',dateKind:'mailbox-received'}});
 await store.put('newsSummaries','header',{id:'header',provider:'dailypitch',name:'Daily Pitch',receivedAt:null,date:'2026-11-09',createdAt:new Date(NOW).toISOString(),bullets:[{text:'Cached header-only item.',url:''}],source:{kind:'manual',dateKind:'email-header-unverified'}});
 let result=await buildDailyBriefing(store,{now:NOW});assert.equal(result.counts.news,2);assert.match(result.text,/received 2026-11-10/);assert.match(result.text,/unverified email-header date 2026-11-09/);assert.match(result.text,/Cached linkless received item/);assert.match(result.text,/not publication dates/);
 await store.put('newsSummaries','header',{id:'header',provider:'dailypitch',name:'Daily Pitch',receivedAt:null,date:null,createdAt:new Date(NOW).toISOString(),bullets:[{text:'Cached undated item.',url:''}],source:{kind:'manual',dateKind:'not-provided'}});
 result=await buildDailyBriefing(store,{now:NOW});assert.match(result.text,/undated manual excerpt/);assert.match(result.text,/stale or undated cache/);assert.match(result.text,/Cached undated item/);
});

test('queued briefing drops topics disabled before dispatch and passes current preference metadata',async t=>{
 const {store,queue}=await fixture(t);await store.put('events','class',event('class','class',{title:'Allowed school'}));await store.put('events','party',event('party','event',{title:'Opted-out event'}));await scheduleDailyBriefing(store,queue,{now:NOW});const job=await queuedPayload(queue);
 const prefs=await saveNotificationPreferences(store,{topics:{events:'off',jobs:'off'}});let sent;
 const result=await dispatchDailyBriefing(store,job.payload,{now:NOW,send:async(_store,text,options)=>{sent={text,options};return {result:{message_id:1}};}});assert.equal(result.sent,true);assert.match(sent.text,/Allowed school/);assert.doesNotMatch(sent.text,/Opted-out event/);assert.deepEqual(sent.options.notification,{channel:'daily',topics:['school'],revision:prefs.revision,newsSourceRevision:null});
});

test('a preference change during briefing preparation triggers a fresh render before transmission',async t=>{
 const {store,queue}=await fixture(t);await store.put('events','party',event('party','event',{title:'Removed during preparation'}));await scheduleDailyBriefing(store,queue,{now:NOW});const job=await queuedPayload(queue);let changed=false,sent;
 const raced=new Proxy(store,{get(target,key){if(key==='get')return async(bucket,id)=>{if(!changed&&bucket==='settings'&&id==='campusCalendar'){changed=true;await saveNotificationPreferences(store,{topics:{events:'off'}});}return target.get(bucket,id);};return Reflect.get(target,key);}});
 const result=await dispatchDailyBriefing(raced,job.payload,{now:NOW,send:async(_store,text,options)=>{sent={text,options};return {result:{message_id:2}};}});assert.equal(result.sent,true);assert.equal(changed,true);assert.doesNotMatch(sent.text,/Removed during preparation/);assert.deepEqual(sent.options.notification.topics,['school','jobs']);assert.equal(sent.options.notification.revision,1);
});

test('a final delivery preference guard suppresses cleanly without reporting uncertain delivery',async t=>{
 const {store,queue}=await fixture(t);await scheduleDailyBriefing(store,queue,{now:NOW});const job=await queuedPayload(queue);
 const result=await dispatchDailyBriefing(store,job.payload,{now:NOW,send:async()=>({suppressed:true,reason:'notification-preferences'})});assert.equal(result.sent,false);assert.equal(result.reason,'notification-preferences');assert.equal((await store.get('dailyBriefings','2026-11-10')).status,'skipped');
});

test('newsletter source consent revision is captured before cache reads and carried to the final delivery guard',async t=>{
 const {store,queue}=await fixture(t);await saveNotificationPreferences(store,{...FRESH_NOTIFICATION_PREFERENCES,topics:{...FRESH_NOTIFICATION_PREFERENCES.topics,news:'daily'}});await store.put('settings','news',{sources:['wsj10point'],revision:'source-v1'});
 const built=await buildDailyBriefing(store,{now:NOW,readNews:async()=>{await store.put('settings','news',{sources:[],revision:'source-v2'});return {providers:[],mailbox:{}};}});assert.equal(built.newsSourceRevision,'source-v1');
 await scheduleDailyBriefing(store,queue,{now:NOW});const job=await queuedPayload(queue);let metadata;
 await dispatchDailyBriefing(store,job.payload,{now:NOW,send:async(_store,_text,options)=>{metadata=options.notification;return {result:{message_id:11}};}});assert.equal(metadata.newsSourceRevision,'source-v2');assert.deepEqual(metadata.topics,['news']);
});
test('unified briefing deduplicates matching social listings and shows ongoing registrar breaks',async t=>{
 const {store}=await fixture(t);
 await store.put('settings','campusCalendar',{calendarId:'campus'});await store.put('settings','lumaCalendar',{calendarId:'luma'});await store.put('settings','academicCalendar',{lastSuccess:new Date(NOW).toISOString()});
 const row=event('campus-social','event',{title:'Friends and founders',status:'available',rsvpUrl:'https://lu.ma/briefing-fixture',sourceCalendarId:'campus'});await store.put('campusEvents',row.id,row);await store.put('lumaEvents','luma-social',{...row,id:'luma-social',sourceCalendarId:'luma'});
 await store.put('academicEvents','break',{id:'break',title:'Official multiday break',category:'break',date:'2026-11-09',endDate:'2026-11-12',allDay:true,status:'available'});
 const result=await buildDailyBriefing(store,{now:NOW});assert.equal(result.counts.events,1);assert.equal((listings(result).match(/Friends and founders/g)||[]).length,1);assert.match(result.headline,/Next up: 1:00 PM · Friends and founders/);assert.match(result.text,/Official multiday break/);assert.match(result.text,/Ongoing · all day/);assert.match(result.text,/your program may differ/);
 const end=await buildDailyBriefing(store,{now:Date.parse('2026-11-12T13:05:00Z')});assert.doesNotMatch(end.text,/Official multiday break/);
});
test('approved all-day dates do not request a time and changed source copies remain in review',async t=>{
 const {store}=await fixture(t);await store.put('events','holiday',event('holiday','event',{academicCandidateId:'official',allDay:true,start:null,end:null,endDate:'2026-11-11',title:'Official holiday'}));
 await store.put('settings','campusCalendar',{calendarId:'campus'});await store.put('campusEvents','changed-source',{...event('changed-source','event',{title:'Changed event',status:'available'}),addedEventId:'copy',sourceCalendarId:'campus'});
 await store.put('events','copy',event('copy','event',{title:'Changed event',status:'review',campusCandidateId:'changed-source'}));
 const result=await buildDailyBriefing(store,{now:NOW});assert.equal(result.counts.awaitingReview,1);assert.match(result.text,/Added item needs calendar review/);assert.doesNotMatch(result.text,/Official holiday · time needs confirmation/);
});
const listings=result=>result.text.replace(result.headline,'');
async function queuedPayload(queue){const job=await queue.claim('test-worker',{types:['daily-briefing']});assert.ok(job);return job;}

test('settings default to enabled 08:00 New York, validate edits and stay tenant-owned',async t=>{
  const {db,store}=await fixture(t);assert.deepEqual(await readDailyBriefingSettings(store),{enabled:true,time:'08:00',timezone:'America/New_York',telegramEnabled:true,emailEnabled:false,updatedAt:null});
  await Promise.all([saveDailyBriefingSettings(store,{enabled:false}),saveDailyBriefingSettings(store,{time:'09:15'})]);assert.equal((await readDailyBriefingSettings(store)).enabled,false);assert.equal((await readDailyBriefingSettings(store)).time,'09:15');assert.equal((await readDailyBriefingSettings(db.forUser('other'))).time,'08:00');
  for(const patch of [{time:'24:00'},{time:'8:00'},{time:'08:60'},{enabled:'true'},{emailEnabled:'true'},{telegramEnabled:0},{timezone:'UTC'},{},null])await assert.rejects(saveDailyBriefingSettings(store,patch),{status:400});
});

test('daily content separates approved schedule, optional campus events and review items without deadline descriptions',async t=>{
  const {store}=await fixture(t);
  await store.put('events','class',event('class','class'));await store.put('events','due',event('due','assignment',{description:'DO_NOT_INCLUDE_DEADLINE_DESCRIPTION',evidence:'DO_NOT_INCLUDE_DEADLINE_EVIDENCE'}));
  await store.put('events','exam',event('exam','exam',{location:''}));await store.put('events','review',event('review','studio',{status:'review',start:null,time:null}));await store.put('events','dismissed',event('dismissed','quiz',{status:'dismissed'}));
  await store.put('events','added',event('added','event',{title:'Added campus event'}));
  await store.put('settings','campusCalendar',{calendarId:'campus',continuous:false,lastSuccess:new Date(NOW).toISOString()});
  for(const row of [{id:'added-source',title:'Added campus event',addedEventId:'added'},{id:'available',title:'Available campus event'},{id:'wrong-calendar',title:'Wrong calendar event',sourceCalendarId:'other'}])await store.put('campusEvents',row.id,{...event(row.id,'event'),status:'available',sourceCalendarId:'campus',...row});
  await store.put('documents','resume',{text:'PRIVATE_RESUME'});await store.put('career','demographics',{gender:'PRIVATE_DEMOGRAPHICS'});
  const result=await buildDailyBriefing(store,{now:NOW});assert.deepEqual(result.counts,{classes:1,deadlines:2,upcoming:0,events:2,jobs:0,newJobs:0,awaitingReview:1,news:0});
  assert.match(result.text,/1:00 PM/);assert.match(result.text,/Location not published/);assert.match(result.text,/Available; not on your calendar/);assert.match(result.text,/Awaiting your review/);assert.match(result.text,/snapshot/);
  for(const privateText of ['DO_NOT_INCLUDE_DEADLINE_DESCRIPTION','DO_NOT_INCLUDE_DEADLINE_EVIDENCE','PRIVATE_RESUME','PRIVATE_DEMOGRAPHICS','Wrong calendar event','quiz dismissed'])assert.equal(result.text.includes(privateText),false);
  assert.equal((result.text.match(/Added campus event/g)||[]).length,1);
});

test('recent jobs exclude closed, ineligible, stale and merely refreshed older postings',async t=>{
  const {store}=await fixture(t),fresh=new Date(NOW-3600000).toISOString(),old=new Date(NOW-8*86400000).toISOString();
  const jobs=[{id:'fresh',title:'Relevant role',publishedAt:fresh,firstSeenAt:fresh,eligible:true,url:'https://example.com/job',description:'Use Python for forecasting.'},{id:'week',title:'Earlier this week',publishedAt:new Date(NOW-3*86400000).toISOString()},{id:'unknown',title:'UNDATED_ONLY_JOB',firstSeenAt:fresh},{id:'old',title:'Old refreshed role',publishedAt:old,firstSeenAt:fresh,fetchedAt:fresh},{id:'closed',title:'Closed role',status:'closed',publishedAt:fresh},{id:'bad',title:'No longer matching',eligible:false,publishedAt:fresh},{id:'bad-status',title:'Not matching status',status:'not-matching',publishedAt:fresh}];
  for(const job of jobs)await store.put('jobs',job.id,{company:'Example',...job});const result=await buildDailyBriefing(store,{now:NOW});
  assert.equal(result.counts.jobs,2);assert.match(result.text,/Relevant role/);assert.match(result.text,/https:\/\/example.com\/job/);assert.equal(result.text.includes('Old refreshed role'),false);assert.equal(result.text.includes('UNDATED_ONLY_JOB'),false);assert.equal(result.text.includes('qualification score'),false);assert.ok(result.text.indexOf('Relevant role')<result.text.indexOf('Earlier this week'));assert.match(result.text,/Jobs posted in the past 24 hours/);assert.match(result.text,/Jobs posted 1–7 days ago/);assert.match(result.text,/\/apply fresh/);assert.equal(result.jobNotification.jobs.length,2);
});

test('Partiful joins the daily briefing once per event, excludes local declines, and discloses subscription lag',async t=>{
  const {db,store}=await fixture(t);
  await store.put('settings','partifulCalendar',{calendarId:'partiful',continuous:true,lastSuccess:new Date(NOW).toISOString()});
  await store.put('events','added-party',event('added-party','event',{title:'Already added party'}));
  const rows=[{id:'party',title:'Partiful gathering',rsvpUrl:'https://partiful.com/e/example',description:'PRIVATE_PARTY_DESCRIPTION'},{id:'added',title:'Already added party',addedEventId:'added-party'},{id:'declined',title:'Declined party',localIntent:'declined'},{id:'wrong',title:'Unselected party',sourceCalendarId:'other'}];
  for(const row of rows)await store.put('partifulEvents',row.id,{...event(row.id,'event'),status:'available',sourceCalendarId:'partiful',...row});
  const result=await buildDailyBriefing(store,{now:NOW});assert.equal(result.counts.events,2);
  assert.match(result.text,/Partiful gathering/);assert.match(result.text,/https:\/\/partiful.com\/e\/example/);assert.match(result.text,/24 hours/);assert.match(result.text,/RSVP on Partiful/);
  assert.equal((listings(result).match(/Already added party/g)||[]).length,1);
  for(const hidden of ['Declined party','Unselected party','PRIVATE_PARTY_DESCRIPTION'])assert.equal(result.text.includes(hidden),false);
  assert.equal((await buildDailyBriefing(db.forUser('other'),{now:NOW})).counts.events,0);
});

test('multi-day campus and approved calendar events overlap today, with exclusive all-day ends',async t=>{
  const {store}=await fixture(t);await store.put('settings','campusCalendar',{calendarId:'campus',continuous:false});
  const span={date:'2026-11-02',start:'2026-11-02T15:00:00Z',end:'2026-11-13T22:00:00Z',location:'Campus'};
  await store.put('events','ongoing',event('ongoing','event',{...span,title:'Two-week campus program'}));
  await store.put('events','old-class',event('old-class','class',{...span,title:'Class on an earlier date'}));await store.put('events','old-deadline',event('old-deadline','assignment',{...span,title:'Deadline on an earlier date'}));
  const rows=[{id:'added',...span,title:'Two-week campus program',addedEventId:'ongoing',rsvpUrl:'https://example.com/rsvp'},{id:'all-day',title:'Ongoing all-day program',allDay:true,date:'2026-11-02',endDate:'2026-11-13',start:null,end:null},{id:'exclusive-end',title:'Already-ended all-day item',allDay:true,date:'2026-11-02',endDate:'2026-11-11',start:null,end:null},{id:'midnight-end',title:'Ended exactly at midnight',...span,end:'2026-11-11T05:00:00Z'},{id:'today',title:'Today all-day',allDay:true,date:'2026-11-11',endDate:'2026-11-12',start:null,end:null}];
  for(const row of rows)await store.put('campusEvents',row.id,{sourceCalendarId:'campus',status:'available',...row});
  const briefing=await buildDailyBriefing(store,{now:'2026-11-11T13:00:00Z'});assert.equal(briefing.counts.events,3);assert.equal(briefing.counts.classes,0);assert.equal(briefing.counts.deadlines,0);assert.match(briefing.text,/Ongoing · ends Nov 13/);assert.match(briefing.text,/Ongoing · all day/);assert.match(briefing.text,/All day · Today all-day/);assert.equal((briefing.text.match(/Two-week campus program/g)||[]).length,1);assert.equal(briefing.text.includes('Already-ended all-day item'),false);assert.equal(briefing.text.includes('Ended exactly at midnight'),false);assert.equal(briefing.text.includes('10:00 AM · Two-week campus program'),false);
  const endDay=await buildDailyBriefing(store,{now:'2026-11-13T13:00:00Z'});assert.equal(endDay.counts.events,1);assert.equal(endDay.text.includes('Ongoing all-day program'),false);
});

test('Luma appears once in briefings, hides declined and foreign-source items, and never confirms admission',async t=>{
 const {db,store}=await fixture(t);
 await store.put('settings','lumaCalendar',{calendarId:'luma',continuous:true,lastSuccess:new Date(NOW).toISOString()});
 await store.put('events','luma-added',event('luma-added','event',{title:'Added Luma workshop',lumaCandidateId:'added'}));
 await store.put('events','luma-declined',event('luma-declined','event',{title:'Locally declined Luma',lumaCandidateId:'declined'}));
 for(const row of [{id:'available',title:'Available Luma workshop',rsvpUrl:'https://lu.ma/example',description:'PRIVATE_LUMA_DESCRIPTION'},{id:'added',title:'Added Luma workshop',addedEventId:'luma-added'},{id:'declined',title:'Locally declined Luma',localIntent:'declined',addedEventId:'luma-declined'},{id:'wrong',title:'Wrong Luma source',sourceCalendarId:'other'},{id:'cancelled',title:'Cancelled Luma',status:'cancelled'}])await store.put('lumaEvents',row.id,{...event(row.id,'event'),status:'available',sourceCalendarId:'luma',...row});
 const result=await buildDailyBriefing(store,{now:NOW});assert.equal(result.counts.events,2);assert.equal((listings(result).match(/Added Luma workshop/g)||[]).length,1);
 assert.match(result.text,/Available Luma workshop/);assert.match(result.text,/Available; not on your calendar/);assert.match(result.text,/https:\/\/lu\.ma\/example/);assert.match(result.text,/12–24 hours/);assert.match(result.text,/Luma registration\/ticket not verified/);assert.match(result.text,/pending or waitlisted/);
 for(const hidden of ['Locally declined Luma','Wrong Luma source','Cancelled Luma','PRIVATE_LUMA_DESCRIPTION'])assert.equal(result.text.includes(hidden),false);
 assert.equal((await buildDailyBriefing(db.forUser('another'),{now:NOW})).counts.events,0);assert.ok(result.text.length<=3800);
 await store.put('settings','lumaCalendar',{calendarId:'luma',continuous:false});assert.match((await buildDailyBriefing(store,{now:NOW})).text,/Luma: saved snapshot; refresh disconnected/);
});

test('briefings use New York day boundaries and remain below Telegram message limits',async t=>{
  const {store}=await fixture(t);for(let i=0;i<35;i++){await store.put('events',String(i),event(String(i),i%2?'class':'exam',{title:`A long item ${'x'.repeat(240)}`}));await store.put('jobs',String(i),{id:String(i),title:'Role '+'x'.repeat(200),company:'Company',description:'x'.repeat(1000),url:'https://example.com/'+('x'.repeat(450)),publishedAt:new Date(NOW).toISOString(),firstSeenAt:new Date(NOW).toISOString()});}
  const result=await buildDailyBriefing(store,{now:'2026-11-11T01:00:00Z'});assert.equal(result.date,'2026-11-10');assert.equal(result.counts.classes+result.counts.deadlines,35);assert.ok(result.text.length<=3800);assert.match(result.text,/more in Big Red Buddy/);assert.match(result.text,/Coverage/);assert.ok(result.text.endsWith('/briefing controls daily delivery.'));
});

test('a full multi-topic briefing preserves a supported linked item from each selected newsletter under the message limit',async t=>{
 const {store}=await fixture(t);await saveNotificationPreferences(store,{topics:{school:'both',events:'both',jobs:'both',news:'daily'}});await store.put('settings','news',{sources:['wsj10point','dailypitch'],revision:'all-topics-news'});
 const links={wsj10point:`https://www.wsj.com/business/${'w'.repeat(430)}`,dailypitch:`https://pitchbook.com/news/articles/${'p'.repeat(420)}`};
 for(const provider of ['wsj10point','dailypitch'])await store.put('newsSummaries',provider,{id:provider,provider,receivedAt:new Date(NOW-3600000).toISOString(),createdAt:new Date(NOW).toISOString(),source:{kind:'gmail'},bullets:[{text:`${provider==='wsj10point'?'WSJ supported lead':'Pitch supported lead'} ${'sourceword '.repeat(30)}`,url:links[provider]},{text:`Second supported item ${'sourceword '.repeat(30)}`,url:links[provider]},{text:`Third supported item ${'sourceword '.repeat(30)}`,url:links[provider]}]});
 for(let i=0;i<30;i++){
  await store.put('events',`class-${i}`,event(`class-${i}`,'class',{title:`Imported class ${i} ${'c'.repeat(250)}`,location:'Room '+ 'r'.repeat(150)}));await store.put('events',`due-${i}`,event(`due-${i}`,'assignment',{title:`Imported deadline ${i} ${'d'.repeat(250)}`}));await store.put('events',`event-${i}`,event(`event-${i}`,'event',{title:`Imported event ${i} ${'e'.repeat(250)}`,sourceUrl:`https://example.com/${'e'.repeat(450)}`}));await store.put('events',`review-${i}`,event(`review-${i}`,'quiz',{status:'review',title:`Review item ${i} ${'q'.repeat(250)}`}));await store.put('academicEvents',`academic-${i}`,{id:`academic-${i}`,title:`Official academic date ${i} ${'a'.repeat(150)}`,date:'2026-11-10',endDate:'2026-11-11',allDay:true,status:'available'});await store.put('jobs',`job-${i}`,{id:`job-${i}`,title:`Matching role ${i} ${'j'.repeat(100)}`,company:'Company '.repeat(10),location:'City '.repeat(20),publishedAt:new Date(NOW).toISOString(),firstSeenAt:new Date(NOW).toISOString(),url:`https://example.com/${'j'.repeat(450)}`});
 }
 await store.put('settings','academicCalendar',{lastError:'Unavailable'});await store.put('settings','campusCalendar',{calendarId:'campus',continuous:true,autoAddWarning:'Warning '.repeat(50)});await store.put('settings','partifulCalendar',{calendarId:'partiful',continuous:true});await store.put('settings','lumaCalendar',{calendarId:'luma',continuous:true});await store.put('settings','eventEmail',{labelId:'selected',continuous:true,lastScan:{truncated:true}});await store.put('settings','jobBoards',{boards:[{lastStatus:'error',truncated:true,pendingAlerts:10}]});
 const result=await buildDailyBriefing(store,{now:NOW});assert.ok(result.text.length<=3800,`length=${result.text.length}`);assert.match(result.text,/WSJ · The 10-Point/);assert.match(result.text,/PitchBook · The Daily Pitch/);assert.match(result.text,/WSJ supported lead/);assert.match(result.text,/Pitch supported lead/);for(const link of Object.values(links))assert.ok(result.text.includes(link));assert.match(result.text,/More newsletter detail in Big Red Buddy/);assert.equal(result.counts.news,2);assert.equal(result.counts.classes,30);assert.equal(result.newsSourceRevision,'all-topics-news');
 // Email retains its complete, separately bounded sections before Telegram
 // shrinks its message. News never silently loses its second/third item there.
 const emailSections=Object.fromEntries(result.emailSections.map(section=>[section.sectionKey,section]));
 assert.equal(emailSections.classes.items.length,5);assert.equal(emailSections.classes.total,30);assert.equal(emailSections.deadlines.items.length,5);
 assert.equal(emailSections.news.items.length,2);for(const item of emailSections.news.items){assert.match(item,/Second supported item/);assert.match(item,/Third supported item/);}assert.doesNotMatch(result.text,/Second supported item|Third supported item/);
 const emailJobs=result.emailSections.filter(section=>['jobs24h','jobsWeek'].includes(section.sectionKey)).flatMap(section=>section.items);
 assert.equal(result.emailJobNotification.jobs.length,emailJobs.length);assert.equal(result.emailJobNotification.jobs.length,2);assert.ok(result.emailJobNotification.requireCurrentMatching);assert.equal(result.emailJobNotification.requireCurrentPublication,true);
 for(const misleading of ['No approved timed classes imported','No approved timed deadlines imported','No event entries available','No recently discovered matching roles','No cached selected newsletter summaries'])assert.equal(result.text.includes(misleading),false,misleading);
});

test('one fresh job source cannot hide another source’s errors, partial results or stale coverage',async t=>{
  const {store}=await fixture(t);await store.put('settings','jobsHealth',{lastSuccess:new Date(NOW).toISOString()});
  await store.put('settings','jobBoards',{boards:[{key:'fresh',lastSuccess:new Date(NOW).toISOString()},{key:'stale',lastStatus:'error',errorMessage:'Source unavailable',truncated:true,pendingAlerts:3,lastSuccess:new Date(NOW-2*86400000).toISOString()}]});
  const result=await buildDailyBriefing(store,{now:NOW});const coverage=result.coverage.find(line=>line.startsWith('Jobs:'));assert.match(coverage,/source errors/);assert.match(coverage,/partial results/);assert.match(coverage,/older than 24 hours/);assert.match(coverage,/notifications pending/);
});

test('once-per-day queue scheduling remains durable after delivery, queue expiry, and another scheduler',async t=>{
  const {db,queue,store}=await fixture(t);const scheduled=await Promise.all([scheduleDailyBriefing(store,queue,{now:NOW}),scheduleDailyBriefing(store,queue,{now:NOW})]);assert.ok(scheduled.some(result=>result.scheduled));assert.equal((await queue.list(store.userId)).length,1);
  const job=await queuedPayload(queue);assert.equal(job.maxAttempts,1);assert.equal(job.retrySafe,false);assert.deepEqual(Object.keys(job.payload).sort(),['date','scheduledAt']);let calls=0;
  const result=await dispatchDailyBriefing(store,job.payload,{now:NOW,send:async()=>{calls++;return {result:{message_id:123}};}});assert.equal(result.sent,true);await queue.complete(job,result);
  databaseInternals(db).sqlite.prepare('DELETE FROM jobs WHERE user_id=?').run(store.userId);
  assert.equal((await scheduleDailyBriefing(db.forUser(store.userId),queue,{now:NOW+60000})).scheduled,false);assert.equal((await dispatchDailyBriefing(store,job.payload,{now:NOW+60000,send:async()=>{calls++;}})).sent,false);assert.equal(calls,1);assert.equal((await store.get('dailyBriefings','2026-11-10')).status,'sent');
});

test('daylight saving changes preserve 08:00 New York; nonexistent local times are skipped',async t=>{
  const {queue,store}=await fixture(t);
  await scheduleDailyBriefing(store,queue,{now:'2026-10-31T12:05:00Z'});assert.equal((await store.get('dailyBriefings','2026-10-31')).scheduledAt,'2026-10-31T12:00:00.000Z');
  await scheduleDailyBriefing(store,queue,{now:'2026-11-01T13:05:00Z'});assert.equal((await store.get('dailyBriefings','2026-11-01')).scheduledAt,'2026-11-01T13:00:00.000Z');
  await scheduleDailyBriefing(store,queue,{now:'2027-03-14T12:05:00Z'});assert.equal((await store.get('dailyBriefings','2027-03-14')).scheduledAt,'2027-03-14T12:00:00.000Z');
  await saveDailyBriefingSettings(store,{time:'02:30'});assert.equal((await scheduleDailyBriefing(store,queue,{now:'2027-03-14T07:45:00Z'})).reason,'daylight-saving-gap');
});

test('unlinked, paused, disabled, early and more-than-two-hour-late students are not queued',async t=>{
  const {queue,store}=await fixture(t);assert.equal((await scheduleDailyBriefing(store,queue,{now:NOW-10*60000})).reason,'not-due');assert.equal((await scheduleDailyBriefing(store,queue,{now:NOW+2*3600000})).reason,'outside-delivery-window');
  await saveDailyBriefingSettings(store,{enabled:false});assert.equal((await scheduleDailyBriefing(store,queue,{now:NOW})).reason,'disabled');await saveDailyBriefingSettings(store,{enabled:true});await store.put('settings','profile',{paused:true});assert.equal((await scheduleDailyBriefing(store,queue,{now:NOW})).reason,'paused');
  await store.put('settings','profile',{paused:false});await store.delete('secrets','telegram');assert.equal((await scheduleDailyBriefing(store,queue,{now:NOW})).reason,'telegram-not-linked');assert.equal((await queue.list(store.userId)).length,0);
});

test('fresh content is built at dispatch and queued settings changes are respected',async t=>{
  const {queue,store}=await fixture(t);await scheduleDailyBriefing(store,queue,{now:NOW});const job=await queuedPayload(queue);await store.put('events','new',event('new','class',{title:'Added after scheduling'}));let sent;
  await dispatchDailyBriefing(store,job.payload,{now:NOW,send:async(_store,text)=>{sent=text;return {result:{message_id:1}};}});assert.match(sent,/Added after scheduling/);
  const other=(await fixture(t,'paused')).store;await other.put('dailyBriefings','2026-11-10',{id:'2026-11-10',date:'2026-11-10',scheduledAt:job.payload.scheduledAt,status:'queued'});await saveDailyBriefingSettings(other,{enabled:false});let calls=0;assert.equal((await dispatchDailyBriefing(other,job.payload,{now:NOW,send:async()=>{calls++;}})).reason,'disabled');assert.equal(calls,0);
});

test('an explicitly changed time can replace an unsent briefing but cannot send twice on the same day',async t=>{
  const {queue,store}=await fixture(t);await scheduleDailyBriefing(store,queue,{now:NOW});const first=await queuedPayload(queue);await saveDailyBriefingSettings(store,{time:'09:00'});let sends=0;
  assert.equal((await dispatchDailyBriefing(store,first.payload,{now:NOW,send:async()=>{sends++;}})).reason,'settings-changed');await queue.complete(first,{});
  await scheduleDailyBriefing(store,queue,{now:NOW+3600000});const second=await queuedPayload(queue);assert.equal((await dispatchDailyBriefing(store,second.payload,{now:NOW+3600000,send:async()=>{sends++;return {result:{message_id:2}};}})).sent,true);
  await saveDailyBriefingSettings(store,{time:'10:00'});assert.equal((await scheduleDailyBriefing(store,queue,{now:NOW+7200000})).reason,'already-handled');assert.equal(sends,1);
});

test('uncertain Telegram outcomes cannot be retried, including concurrent dispatches',async t=>{
  const {queue,store}=await fixture(t);await scheduleDailyBriefing(store,queue,{now:NOW});const job=await queuedPayload(queue);let calls=0;
  const send=async()=>{calls++;throw new Error('Unknown provider outcome');};const outcomes=await Promise.all([dispatchDailyBriefing(store,job.payload,{now:NOW,send}),dispatchDailyBriefing(store,job.payload,{now:NOW,send})]);
  assert.equal(calls,1);assert.ok(outcomes.some(result=>result.reason==='delivery-uncertain'));assert.equal((await store.get('dailyBriefings','2026-11-10')).status,'needs-review');assert.equal((await scheduleDailyBriefing(store,queue,{now:NOW+60000})).scheduled,false);
});

test('an uncertain enqueue recovers using its original idempotency key without duplicate queue records',async t=>{
  const {queue,store}=await fixture(t);let first=true;const uncertain={enqueue:async(...args)=>{const job=await queue.enqueue(...args);if(first){first=false;throw new Error('Lost enqueue response');}return job;}};
  await assert.rejects(scheduleDailyBriefing(store,uncertain,{now:NOW}));assert.equal((await store.get('dailyBriefings','2026-11-10')).status,'reserved');
  await scheduleDailyBriefing(store,uncertain,{now:NOW+1000});assert.equal((await queue.list(store.userId)).length,1);assert.equal((await store.get('dailyBriefings','2026-11-10')).status,'queued');
});

test('late preparation and unconfirmed provider responses never report a successful briefing',async t=>{
  const {queue,store}=await fixture(t);await scheduleDailyBriefing(store,queue,{now:NOW});const job=await queuedPayload(queue);let reads=0,calls=0;
  const late=await dispatchDailyBriefing(store,job.payload,{now:()=>++reads<3?NOW:NOW+3*3600000,send:async()=>{calls++;return {result:{message_id:1}};}});assert.equal(late.sent,false);assert.equal(late.reason,'outside-delivery-window');assert.equal(calls,0);
  const other=await fixture(t,'unknown-response');await scheduleDailyBriefing(other.store,other.queue,{now:NOW});const second=await queuedPayload(other.queue);
  const uncertain=await dispatchDailyBriefing(other.store,second.payload,{now:NOW,send:async()=>({ok:true})});assert.equal(uncertain.reason,'delivery-uncertain');assert.equal((await other.store.get('dailyBriefings','2026-11-10')).status,'needs-review');
});

test('a stale queued day is discarded and each student receives only their own content',async t=>{
  const {db,queue,store:a}=await fixture(t,'a'),b=db.forUser('b');await b.put('secrets','telegram',{chatId:456});await a.put('events','private',event('private','class',{title:'Student A only'}));await b.put('events','private',event('private','class',{title:'Student B only'}));
  assert.equal((await buildDailyBriefing(a,{now:NOW})).text.includes('Student B only'),false);assert.equal((await buildDailyBriefing(b,{now:NOW})).text.includes('Student A only'),false);
  await scheduleDailyBriefing(a,queue,{now:NOW});const job=await queuedPayload(queue);let calls=0;assert.equal((await dispatchDailyBriefing(a,job.payload,{now:NOW+86400000,send:async()=>{calls++;}})).reason,'not-current-day');assert.equal(calls,0);
});

test('email-only preferences suppress Telegram while legacy settings retain Telegram delivery',async t=>{
 const legacy=await fixture(t,'legacy-channels');await legacy.store.put('settings','dailyBriefing',{enabled:true,time:'08:00'});
 const legacySettings=await readDailyBriefingSettings(legacy.store);assert.equal(legacySettings.telegramEnabled,true);assert.equal(legacySettings.emailEnabled,false);
 assert.equal((await scheduleDailyBriefing(legacy.store,legacy.queue,{now:NOW})).scheduled,true);const job=await queuedPayload(legacy.queue);
 await saveDailyBriefingSettings(legacy.store,{telegramEnabled:false,emailEnabled:true});let sent=0;const result=await dispatchDailyBriefing(legacy.store,job.payload,{now:NOW,send:async()=>{sent++;return {result:{message_id:42}};}});assert.equal(result.reason,'telegram-disabled');assert.equal(sent,0);
 const onlyEmail=await fixture(t,'email-only');await saveDailyBriefingSettings(onlyEmail.store,{telegramEnabled:false,emailEnabled:true});assert.equal((await scheduleDailyBriefing(onlyEmail.store,onlyEmail.queue,{now:NOW})).reason,'telegram-disabled');assert.equal((await onlyEmail.queue.list(onlyEmail.store.userId)).length,0);
});

test('email sections exclude disabled topics and retain only the chosen review category',async t=>{
 const {store}=await fixture(t);await store.put('events','class',event('class','class',{title:'PRIVATE SCHOOL'}));await store.put('events','school-review',event('school-review','assignment',{title:'PRIVATE SCHOOL REVIEW',status:'review'}));await store.put('events','party',event('party','event',{title:'ALLOWED EVENT'}));await store.put('events','event-review',event('event-review','event',{title:'ALLOWED EVENT REVIEW',status:'review'}));await store.put('jobs','role',{id:'role',title:'PRIVATE JOB',publishedAt:new Date(NOW).toISOString()});
 await saveNotificationPreferences(store,{topics:{school:'off',events:'daily',jobs:'alerts',news:'off'}});
 let result=await buildDailyBriefing(store,{now:NOW});assert.deepEqual(result.emailSections.map(section=>section.sectionKey),['events','review']);assert.match(JSON.stringify(result.emailSections),/ALLOWED EVENT REVIEW/);assert.match(JSON.stringify(result.emailSections),/ALLOWED EVENT/);assert.doesNotMatch(JSON.stringify(result.emailSections),/PRIVATE SCHOOL|PRIVATE JOB/);assert.equal(result.emailJobNotification,null);
 await saveNotificationPreferences(store,{topics:{events:'off',school:'daily'}});result=await buildDailyBriefing(store,{now:NOW});assert.deepEqual(result.emailSections.map(section=>section.sectionKey),['classes','deadlines','upcoming','academic','review']);assert.match(JSON.stringify(result.emailSections),/PRIVATE SCHOOL REVIEW/);assert.doesNotMatch(JSON.stringify(result.emailSections),/ALLOWED EVENT|PRIVATE JOB/);
});

test('stale daily delivery settings proposals cannot overwrite another change',async t=>{
 const {store}=await fixture(t),initial=await store.get('settings','dailyBriefing');assert.equal(initial,null);
 await saveDailyBriefingSettings(store,{time:'09:30',telegramEnabled:false},{expectedPrevious:initial});const current=await store.get('settings','dailyBriefing');
 await assert.rejects(saveDailyBriefingSettings(store,{time:'08:00',emailEnabled:true},{expectedPrevious:initial}),{status:409});assert.deepEqual(await store.get('settings','dailyBriefing'),current);
 const saved=await saveDailyBriefingSettings(store,{emailEnabled:true},{expectedPrevious:current});assert.equal(saved.emailEnabled,true);assert.equal(saved.telegramEnabled,false);assert.equal(saved.time,'09:30');assert.equal((await store.get('settings','dailyBriefing')).revision,current.revision+1);
});

test('an empty school day collapses to one line, looks ahead a week, and leads with a plain summary',async t=>{
 const {store}=await fixture(t);
 await store.put('events','due-thu',event('due-thu','assignment',{title:'Finance problem set',date:'2026-11-12',start:'2026-11-12T22:00:00Z',end:'2026-11-12T22:00:00Z'}));
 await store.put('events','due-later',event('due-later','exam',{title:'Too far away',date:'2026-11-20',start:'2026-11-20T15:00:00Z',end:'2026-11-20T17:00:00Z'}));
 await store.put('events','unapproved',event('unapproved','quiz',{title:'Unapproved quiz',status:'review',date:'2026-11-11',start:'2026-11-11T15:00:00Z'}));
 const result=await buildDailyBriefing(store,{now:NOW});
 assert.match(result.text,/^Your day · 2026-11-10 · New York\nNo classes or deadlines today\. Next deadline: Finance problem set, Thu, Nov 12\./);
 assert.match(result.text,/Today\nNo classes or deadlines on your schedule today\./);assert.doesNotMatch(result.text,/Due today\n|Nothing due today|No approved timed/);
 assert.match(result.text,/Due in the next 7 days\nThu, Nov 12, 5:00 PM · Finance problem set/);assert.doesNotMatch(result.text,/Too far away|Unapproved quiz ·.*\n.*Due in/);
 assert.equal(result.counts.upcoming,1);
});

test('registrar dates for other cohorts are left out while graduate dates and holidays stay',async t=>{
 const {store}=await fixture(t);await store.put('settings','academicCalendar',{lastSuccess:new Date(NOW).toISOString()});
 const day={date:'2026-11-10',endDate:'2026-11-11',allDay:true,status:'available'};
 for(const [id,title] of [['grad','Spring 2027: Enrollment begins for Graduate/Professional/Cornell Tech'],['seniors','Spring 2027: Enrollment begins for Seniors and Vet Med fourth-years'],['first','Spring 2027: Enrollment begins for First-Years and Vet Med first-years'],['break','Thanksgiving Break/No classes']])await store.put('academicEvents',id,{id,title,...day});
 const result=await buildDailyBriefing(store,{now:NOW});
 assert.match(result.text,/Graduate\/Professional\/Cornell Tech/);assert.match(result.text,/Thanksgiving Break/);assert.doesNotMatch(result.text,/Seniors|First-Years/);
});

test('the warm-introduction tip sits with each job, uses imported connections, and never truncates in coverage',async t=>{
 const {store}=await fixture(t);const {importLinkedInConnections}=await import('../lib/linkedin-connections.mjs');
 await store.put('jobs','known',{id:'known',title:'Data Analyst',company:'Example Company',publishedAt:new Date(NOW-3*86400000).toISOString(),firstSeenAt:new Date(NOW-3*86400000).toISOString()});
 await store.put('jobs','unknown',{id:'unknown',title:'Strategy Associate',company:'Other Co',publishedAt:new Date(NOW-2*86400000).toISOString(),firstSeenAt:new Date(NOW-2*86400000).toISOString()});
 await importLinkedInConnections(store,{csv:'First Name,Last Name,URL,Email Address,Company,Position,Connected On\nAlex,Example,https://www.linkedin.com/in/alex-example,private@example.com,Example Company,Manager,01 Jan 2025\n'});
 const result=await buildDailyBriefing(store,{now:NOW});
 assert.match(result.text,/Data Analyst · Example Company\nPosted [^\n]+\nYou have 1 LinkedIn connection at Example Company\. Ask one for context or a warm intro\./);
 assert.match(result.text,/Strategy Associate · Other Co\nPosted [^\n]+\nBefore applying, check your LinkedIn 1st-degree connections/);
 assert.doesNotMatch(result.text,/Alex|private@example\.com/);assert.equal(result.coverage.some(line=>/LinkedIn/.test(line)),false);
 assert.doesNotMatch(result.text,/Jobs posted in the past 24 hours\nNo matching roles/);assert.equal(result.counts.newJobs,0);assert.equal(result.counts.jobs,2);
});
