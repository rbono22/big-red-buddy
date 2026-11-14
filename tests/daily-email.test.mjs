import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {identityId,GMAIL_SEND_SCOPE} from '../lib/auth.mjs';
import {saveNotificationPreferences} from '../lib/notification-preferences.mjs';
import {scheduleDailyEmail,scheduleDailyEmailPreview,dispatchDailyEmail,dispatchDailyEmailPreview,sendGmailDailyEmail,getDailyEmailStatus,disconnectDailyEmail} from '../lib/daily-email.mjs';

const NOW=Date.parse('2026-11-10T13:05:00Z'),ORIGIN='https://app.bigredbuddy.com',SUBJECT='email-student',USER=identityId('google',SUBJECT);
const grant=(extra={})=>({subject:SUBJECT,email:'student@cornell.edu',connectionRevision:'grant-1',scope:GMAIL_SEND_SCOPE,access_token:'ACCESS_SECRET',refresh_token:'REFRESH_SECRET',expiresAt:NOW+3600000,...extra});
function memory(userId=USER){const data=new Map(),clone=value=>value===undefined?null:structuredClone(value);return {userId,async get(bucket,key){return clone(data.get(`${bucket}:${key}`));},async put(bucket,key,value){data.set(`${bucket}:${key}`,clone(value));},async delete(bucket,key){data.delete(`${bucket}:${key}`);},async all(bucket){return [...data].filter(([key])=>key.startsWith(`${bucket}:`)).map(([,value])=>clone(value));},async compareAndSet(bucket,key,old,value){const name=`${bucket}:${key}`;if(JSON.stringify(data.get(name)??null)!==JSON.stringify(old))return false;data.set(name,clone(value));return true;}};}
function queue(){const jobs=[],keys=new Map();return {jobs,async enqueue(userId,type,payload,options){if(keys.has(options.idempotencyKey))return keys.get(options.idempotencyKey);const job={id:`job-${jobs.length+1}`,userId,type,payload,options};jobs.push(job);keys.set(options.idempotencyKey,job);return job;}};}
async function fixture(store=memory()){await store.put('secrets','dailyEmailGoogle',grant());await store.put('settings','dailyBriefing',{enabled:true,emailEnabled:true,telegramEnabled:false,time:'08:00'});await store.put('settings','notifications',{enabled:true,revision:0,topics:{school:'daily',events:'off',jobs:'off',news:'off',games:'off'}});await store.put('events','class',{id:'class',kind:'class',title:'Finance',status:'approved',date:'2026-11-10',start:'2026-11-10T18:00:00Z',end:'2026-11-10T19:00:00Z',location:'Tata L23'});return {store,queue:queue()};}
async function scheduled(f){await scheduleDailyEmail(f.store,f.queue,{now:NOW});return f.queue.jobs[0].payload;}
const options=extra=>({now:NOW,appOrigin:ORIGIN,...extra});
const email={subject:'BRB · Morning 🌞',text:'Good morning.\nFinance at Tata.',html:'<h1>Good morning.</h1><p>Finance at Tata.</p>'};

test('a found-job removal after email rendering prevents obsolete content from being sent',async()=>{
 const f=await fixture();await saveNotificationPreferences(f.store,{topics:{school:'off',jobs:'daily'}});
 await f.store.put('jobs','removed-role',{id:'removed-role',title:'Role to remove',company:'Fixture',publishedAt:new Date(NOW-3600000).toISOString(),status:'discovered'});
 const payload=await scheduled(f),cas=f.store.compareAndSet.bind(f.store);let changed=false,sends=0;
 f.store.compareAndSet=async(bucket,id,expected,value)=>{
  const result=await cas(bucket,id,expected,value);
  if(result&&bucket==='dailyEmails'&&value.status==='sending'&&!changed){changed=true;await f.store.put('careerRemovals','removed-role',{id:'removed-role',foundRemovedAt:new Date(NOW).toISOString()});}
  return result;
 };
 const result=await dispatchDailyEmail(f.store,payload,options({send:async()=>{sends++;return {id:'must-not-send'};}}));
 assert.equal(changed,true);assert.equal(sends,0);assert.deepEqual(result,{sent:false,reason:'job-removed'});
});
const response=(body,status=200)=>({ok:status<400,status,async json(){return body;}});

// No test connects to Gmail or sends any real message.
test('email schedules independently of Telegram, respects opt-in, and is fenced per student/day',async()=>{
 const f=await fixture();await f.store.delete('settings','dailyBriefing');assert.equal((await scheduleDailyEmail(f.store,f.queue,{now:NOW})).reason,'email-disabled');await f.store.put('settings','dailyBriefing',{emailEnabled:true,time:'08:00'});
 const results=await Promise.all(Array.from({length:8},()=>scheduleDailyEmail(f.store,f.queue,{now:NOW})));assert.ok(results.some(result=>result.scheduled));assert.equal(f.queue.jobs.length,1);assert.equal(f.queue.jobs[0].type,'daily-email');assert.equal(f.queue.jobs[0].options.retrySafe,false);assert.equal(f.queue.jobs[0].options.maxAttempts,1);assert.equal(await f.store.get('secrets','telegram'),null);
 let sends=0;const delivered=await Promise.all(Array.from({length:5},()=>dispatchDailyEmail(f.store,f.queue.jobs[0].payload,options({send:async()=>{sends++;return {id:'gmail-1'};}}))));assert.equal(sends,1);assert.equal(delivered.filter(value=>value.sent).length,1);assert.equal((await scheduleDailyEmail(f.store,f.queue,{now:NOW})).reason,'already-handled');
 const other=await fixture(memory(identityId('google','other')));assert.equal((await scheduleDailyEmail(other.store,other.queue,{now:NOW})).reason,'gmail-not-connected');
});

test('reserved-to-queued bookkeeping racing dispatch still delivers once across competing workers',async()=>{
 const f=await fixture(),get=f.store.get.bind(f.store);
 let releaseWorkers,readReady,reads=0,sends=0,paused=false,workers;
 const released=new Promise(resolve=>releaseWorkers=resolve),ready=new Promise(resolve=>readReady=resolve);
 f.store.get=async(bucket,key)=>{
  const value=await get(bucket,key);
  if(paused&&bucket==='dailyEmails'&&value?.status==='reserved'){
   reads++;if(reads===4){paused=false;readReady();}await released;
  }
  return value;
 };
 const racingQueue={async enqueue(userId,type,payload){
  assert.equal(userId,USER);assert.equal(type,'daily-email');paused=true;
  workers=Array.from({length:4},()=>dispatchDailyEmail(f.store,payload,options({send:async()=>{sends++;return{id:'one-provider-message'};}})));
  await ready;return{id:'racing-queue-job'};
 }};
 const scheduled=await scheduleDailyEmail(f.store,racingQueue,{now:NOW});
 assert.equal(scheduled.scheduled,true);
 assert.equal((await get('dailyEmails','daily:2026-11-10')).status,'queued');
 releaseWorkers();const results=await Promise.all(workers);
 assert.equal(sends,1);assert.equal(results.filter(result=>result.sent).length,1);
 const marker=await get('dailyEmails','daily:2026-11-10');assert.equal(marker.status,'sent');assert.equal(marker.jobId,'racing-queue-job');
 assert.equal((await scheduleDailyEmail(f.store,f.queue,{now:NOW})).reason,'already-handled');
});

test('late scheduler bookkeeping never changes a sending or accepted marker back to queued',async()=>{
 const f=await fixture();let sends=0;
 const immediateQueue={async enqueue(userId,type,payload){
  assert.equal(userId,USER);assert.equal(type,'daily-email');
  const delivered=await dispatchDailyEmail(f.store,payload,options({send:async()=>{
   sends++;assert.equal((await f.store.get('dailyEmails',payload.id)).status,'sending');return{id:'accepted-before-queue-record'};
  }}));
  assert.equal(delivered.sent,true);return{id:'late-queue-record'};
 }};
 assert.equal((await scheduleDailyEmail(f.store,immediateQueue,{now:NOW})).scheduled,true);
 assert.equal((await f.store.get('dailyEmails','daily:2026-11-10')).status,'sent');assert.equal(sends,1);
 assert.equal((await scheduleDailyEmail(f.store,f.queue,{now:NOW})).reason,'already-handled');
});

test('reserved claim retry never crosses a replacement attempt or bypasses a final consent change',async()=>{
 for(const scenario of ['replaced-attempt','disabled-email']){
  const f=await fixture(),cas=f.store.compareAndSet.bind(f.store);let intercepted=false,sends=0;
  f.store.compareAndSet=async(bucket,key,previous,next)=>{
   if(bucket==='dailyEmails'&&previous?.status==='reserved'&&next?.status==='sending'&&!intercepted){
    intercepted=true;
    await f.store.put(bucket,key,{...previous,status:'queued',jobId:'promoted-job',...(scenario==='replaced-attempt'?{attemptId:'new-attempt'}:{})});
    if(scenario==='disabled-email')await f.store.put('settings','dailyBriefing',{enabled:true,emailEnabled:false,time:'08:00'});
    return false;
   }
   return cas(bucket,key,previous,next);
  };
  const queue={async enqueue(_user,_type,payload){
   const result=await dispatchDailyEmail(f.store,payload,options({send:async()=>{sends++;return{id:'must-not-send'};}}));
   assert.equal(result.sent,false);assert.equal(result.reason,scenario==='replaced-attempt'?'concurrent-dispatch':'email-disabled');return{id:'job'};
  }};
  await scheduleDailyEmail(f.store,queue,{now:NOW});assert.equal(sends,0);assert.equal(intercepted,true);
 }
});

test('morning scheduling uses New York daylight time and a two-hour catchup window',async()=>{
 const f=await fixture();assert.equal((await scheduleDailyEmail(f.store,f.queue,{now:Date.parse('2026-11-10T12:59:00Z')})).reason,'not-due');assert.equal((await scheduleDailyEmail(f.store,f.queue,{now:Date.parse('2026-11-10T15:01:00Z')})).reason,'outside-delivery-window');
 const summer=await scheduleDailyEmail(f.store,f.queue,{now:Date.parse('2026-07-10T12:05:00Z')});assert.equal(summer.scheduled,true);assert.equal(Date.parse(f.queue.jobs[0].payload.scheduledAt),Date.parse('2026-07-10T12:00:00Z'));
 await f.store.put('settings','dailyBriefing',{emailEnabled:true,time:'02:30'});assert.equal((await scheduleDailyEmail(f.store,f.queue,{now:Date.parse('2026-03-08T08:00:00Z')})).reason,'daylight-saving-gap');
});

test('queued emails stop after disconnect, rebinding, pause, deletion, or preference/time changes',async()=>{
 for(const [change,expected] of [
  [store=>disconnectDailyEmail(store,{now:NOW}),'gmail-not-connected'],
  [store=>store.put('secrets','dailyEmailGoogle',grant({connectionRevision:'grant-2'})),'gmail-binding-changed'],
  [store=>store.put('settings','profile',{paused:true}),'paused'],
  [store=>store.put('settings','account',{deleting:true}),'account-deleting'],
  [store=>store.put('settings','dailyBriefing',{emailEnabled:false,time:'08:00'}),'email-disabled'],
  [store=>store.put('settings','dailyBriefing',{emailEnabled:true,time:'09:00'}),'settings-changed'],
  [store=>saveNotificationPreferences(store,{enabled:false}),'notifications-disabled']
 ]){const f=await fixture(),payload=await scheduled(f);await change(f.store);let sent=false;const result=await dispatchDailyEmail(f.store,payload,options({send:async()=>{sent=true;return{id:'bad'};}}));assert.equal(result.reason,expected);assert.equal(sent,false);}
});

test('current consent is rendered and the final guard catches pilot, source, and job changes',async()=>{
 const f=await fixture(),payload=await scheduled(f);await saveNotificationPreferences(f.store,{topics:{school:'off',events:'daily'}});let message;
 const result=await dispatchDailyEmail(f.store,payload,options({send:async(_store,built)=>{message=built;return{id:'current'};}}));assert.equal(result.sent,true);assert.doesNotMatch(message.text,/Finance/);
 const denied=await fixture();assert.equal((await dispatchDailyEmail(denied.store,await scheduled(denied),options({assertAccess:async()=>false,send:async()=>{throw Error('must not send');}}))).reason,'pilot-access-revoked');
 for(const scenario of ['news','job']){
  const x=await fixture();await saveNotificationPreferences(x.store,{topics:{school:'off',[scenario==='news'?'news':'jobs']:'daily'}});
  if(scenario==='news')await x.store.put('settings','news',{sources:['wsj10point'],revision:'news-1'});
  else await x.store.put('jobs','job',{id:'job',title:'Analyst',company:'Acme',status:'matched',publishedAt:new Date(NOW-3600000).toISOString()});
  const p=await scheduled(x);
  const result=await dispatchDailyEmail(x.store,p,options({send:async(store,_message,delivery)=>{if(scenario==='news')await store.put('settings','news',{sources:[],revision:'news-2'});else await store.put('jobs','job',{id:'job',closed:true});return {suppressed:true,reason:await delivery.assertCurrent()};}}));
  assert.equal(result.reason,scenario==='news'?'news-sources-changed':'job-publication-changed');assert.equal(result.sent,false);
 }
});

test('Gmail MIME uses only verified owner as From/To and includes UTF-8 plain and HTML alternatives',async()=>{
 const {store}=await fixture();let call;
 const result=await sendGmailDailyEmail(store,{...email,to:'attacker@example.com',from:'attacker@example.com'}, {expectedConnectionRevision:'grant-1',deliveryId:'delivery-1',now:NOW,fetchImpl:async(url,opts)=>{call={url,opts};return response({id:'gmail-id'});}});
 assert.equal(result.accepted,true);assert.equal(call.url,'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');assert.deepEqual(Object.keys(JSON.parse(call.opts.body)),['raw']);
 const raw=Buffer.from(JSON.parse(call.opts.body).raw,'base64url').toString();assert.match(raw,/From: Big Red Buddy <student@cornell.edu>/);assert.match(raw,/To: student@cornell.edu/);assert.match(raw,/Content-Type: multipart\/alternative/);assert.match(raw,/Content-Type: text\/plain; charset=UTF-8/);assert.match(raw,/Content-Type: text\/html; charset=UTF-8/);assert.doesNotMatch(raw,/attacker|ACCESS_SECRET|REFRESH_SECRET/);assert.ok(raw.includes(Buffer.from(email.text).toString('base64')));
 await store.put('secrets','dailyEmailGoogle',grant({email:'student@cornell.edu\r\nBcc: attacker@example.com'}));let attempted=false;assert.equal((await sendGmailDailyEmail(store,email,{expectedConnectionRevision:'grant-1',now:NOW,fetchImpl:async()=>{attempted=true;}})).suppressed,true);assert.equal(attempted,false);
});

test('readonly mailbox access is never enough to send or report connected',async()=>{
 const f=await fixture();await f.store.put('secrets','dailyEmailGoogle',grant({scope:'https://www.googleapis.com/auth/gmail.readonly'}));assert.equal((await scheduleDailyEmail(f.store,f.queue,{now:NOW})).reason,'gmail-not-connected');assert.equal((await getDailyEmailStatus(f.store)).connected,false);
 let calls=0;assert.equal((await sendGmailDailyEmail(f.store,email,{expectedConnectionRevision:'grant-1',now:NOW,fetchImpl:async()=>{calls++;}})).suppressed,true);assert.equal(calls,0);
});

test('refresh cannot overwrite a disconnect or rebind; final consent runs after refresh',async t=>{
 const original={id:process.env.GOOGLE_CLIENT_ID,secret:process.env.GOOGLE_CLIENT_SECRET};process.env.GOOGLE_CLIENT_ID='test-client';process.env.GOOGLE_CLIENT_SECRET='test-secret';t.after(()=>{for(const [key,value] of [['GOOGLE_CLIENT_ID',original.id],['GOOGLE_CLIENT_SECRET',original.secret]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 for(const change of ['disconnect','rebind','preferences']){
  const {store}=await fixture();await store.put('secrets','dailyEmailGoogle',grant({expiresAt:NOW-1}));let calls=0,blocked=false;
  const result=await sendGmailDailyEmail(store,email,{expectedConnectionRevision:'grant-1',deliveryId:'test',now:NOW,assertCurrent:async()=>blocked?'notification-preferences':null,fetchImpl:async(url)=>{calls++;assert.equal(url,'https://oauth2.googleapis.com/token');if(change==='disconnect')await disconnectDailyEmail(store,{now:NOW});else if(change==='rebind')await store.put('secrets','dailyEmailGoogle',grant({connectionRevision:'new-binding',access_token:'NEW_ACCOUNT_TOKEN'}));else blocked=true;return response({access_token:'STALE_REFRESH_TOKEN',expires_in:3600,scope:GMAIL_SEND_SCOPE});}});
  assert.equal(result.suppressed,true);assert.equal(calls,1);if(change!=='preferences')assert.notEqual((await store.get('secrets','dailyEmailGoogle')).access_token,'STALE_REFRESH_TOKEN');
 }
});

test('network uncertainty never resends, and provider acceptance survives a persistence failure',async()=>{
 const f=await fixture(),payload=await scheduled(f);let sends=0;
 let result=await dispatchDailyEmail(f.store,payload,options({send:async()=>{sends++;throw new Error('response lost');}}));assert.equal(result.reason,'delivery-uncertain');assert.equal((await getDailyEmailStatus(f.store)).lastStatus,'needs-review');await dispatchDailyEmail(f.store,payload,options({send:async()=>{sends++;return{id:'oops'};}}));assert.equal(sends,1);assert.equal((await scheduleDailyEmail(f.store,f.queue,{now:NOW})).reason,'already-handled');
 const accepted=await fixture(),p=await scheduled(accepted),originalCAS=accepted.store.compareAndSet;accepted.store.compareAndSet=async(bucket,key,old,next)=>{if(bucket==='dailyEmails'&&next.status==='sent')throw new Error('database unavailable');return originalCAS(bucket,key,old,next);};
 result=await dispatchDailyEmail(accepted.store,p,options({send:async()=>({id:'gmail-confirmed'})}));assert.equal(result.sent,true);assert.equal(result.accepted,true);assert.equal(result.recorded,false);assert.equal((await scheduleDailyEmail(accepted.store,accepted.queue,{now:NOW})).reason,'already-handled');
});

test('manual previews are explicit, independent of automatic toggles, limited durably to one per day',async()=>{
 const f=await fixture();await f.store.put('settings','dailyBriefing',{enabled:false,emailEnabled:false});await saveNotificationPreferences(f.store,{enabled:false});
 const queued=await scheduleDailyEmailPreview(f.store,f.queue,{now:NOW});assert.equal(queued.taskId,'job-1');assert.equal(f.queue.jobs[0].type,'daily-email-preview');await assert.rejects(scheduleDailyEmailPreview(f.store,f.queue,{now:NOW}),{status:409});
 const result=await dispatchDailyEmailPreview(f.store,f.queue.jobs[0].payload,options({send:async()=>({id:'preview'})}));assert.equal(result.sent,true);await assert.rejects(scheduleDailyEmailPreview(f.store,f.queue,{now:NOW}),{status:409});
 const status=await getDailyEmailStatus(f.store);assert.equal(status.lastStatus,'sent');assert.equal(status.accountEmail,'student@cornell.edu');assert.doesNotMatch(JSON.stringify(status),/SECRET|gmail-confirmed|preview|connectionRevision|subject/);
 await disconnectDailyEmail(f.store,{now:NOW});assert.deepEqual(await f.store.get('secrets','dailyEmailGoogle'),{connectionRevision:(await f.store.get('secrets','dailyEmailGoogle')).connectionRevision,disconnectedAt:new Date(NOW).toISOString()});assert.equal((await getDailyEmailStatus(f.store)).accountEmail,null);
});

test('per-day sending fence survives database close/reopen and queue loss',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brb-daily-email-'));let db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 const f=await fixture(db.forUser(USER)),payload=await scheduled(f);await dispatchDailyEmail(f.store,payload,options({send:async()=>{throw Error('ambiguous timeout');}}));await db.close();db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
 const store=db.forUser(USER),newQueue=queue();assert.equal((await scheduleDailyEmail(store,newQueue,{now:NOW})).reason,'already-handled');assert.equal(newQueue.jobs.length,0);assert.equal((await getDailyEmailStatus(store)).lastStatus,'needs-review');assert.equal((await getDailyEmailStatus(db.forUser(identityId('google','other')))).connected,false);
});

test('successful refresh uses only the refreshed token, Gmail rejects distinctly from ambiguous server failures',async t=>{
 const original={id:process.env.GOOGLE_CLIENT_ID,secret:process.env.GOOGLE_CLIENT_SECRET};process.env.GOOGLE_CLIENT_ID='test-client';process.env.GOOGLE_CLIENT_SECRET='test-secret';t.after(()=>{for(const [key,value] of [['GOOGLE_CLIENT_ID',original.id],['GOOGLE_CLIENT_SECRET',original.secret]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 const {store}=await fixture();await store.put('secrets','dailyEmailGoogle',grant({expiresAt:NOW-1}));let calls=0;
 const accepted=await sendGmailDailyEmail(store,email,{expectedConnectionRevision:'grant-1',deliveryId:'refresh',now:NOW,fetchImpl:async(url,request)=>{calls++;if(url.includes('/token'))return response({access_token:'UPDATED_TOKEN',expires_in:3600});assert.equal(request.headers.Authorization,'Bearer UPDATED_TOKEN');return response({id:'accepted-after-refresh'});}});assert.equal(accepted.accepted,true);assert.equal(calls,2);assert.equal((await store.get('secrets','dailyEmailGoogle')).connectionRevision,'grant-1');
 const rejected=await sendGmailDailyEmail(store,email,{expectedConnectionRevision:'grant-1',deliveryId:'denied',now:NOW,fetchImpl:async()=>response({error:'PRIVATE_PROVIDER_DETAILS'},403)});assert.deepEqual(rejected,{failed:true,reason:'gmail-reconnect-required'});
 await assert.rejects(sendGmailDailyEmail(store,email,{expectedConnectionRevision:'grant-1',deliveryId:'uncertain',now:NOW,fetchImpl:async()=>response({},503)}),/unconfirmed/);
 await assert.rejects(sendGmailDailyEmail(store,email,{expectedConnectionRevision:'grant-1',deliveryId:'missing-confirmation',now:NOW,fetchImpl:async()=>response({})}),/unconfirmed/);
});

test('job matching changes and expired queued jobs are checked immediately before sending',async()=>{
 const f=await fixture();await saveNotificationPreferences(f.store,{topics:{school:'off',jobs:'daily'}});await f.store.put('jobs','role',{id:'role',title:'Analyst',publishedAt:new Date(NOW-1000).toISOString()});const payload=await scheduled(f);
 const result=await dispatchDailyEmail(f.store,payload,options({send:async(store,_message,delivery)=>{await store.put('settings','profile',{jobTitles:'Changed target role'});return {suppressed:true,reason:await delivery.assertCurrent()};}}));assert.equal(result.reason,'job-matching-changed');
 const late=await fixture(),p=await scheduled(late);const expired=await dispatchDailyEmail(late.store,p,options({now:NOW+3*3600000,send:async()=>{throw Error('should never send');}}));assert.equal(expired.reason,'outside-delivery-window');
});
