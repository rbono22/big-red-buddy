import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {sendTelegram} from '../lib/integrations.mjs';
import {saveNotificationPreferences} from '../lib/notification-preferences.mjs';
import {careerJobList,publicationNotice} from '../lib/job-messages.mjs';
import {buildDailyBriefing,briefingNotification} from '../lib/daily-briefing.mjs';
import {importLinkedInConnections,deleteLinkedInConnections,readLinkedInConnections} from '../lib/linkedin-connections.mjs';
import {dispatchLinkedInLeads} from '../lib/linkedin-delivery.mjs';
import {handleCareerMessage} from '../lib/career-telegram.mjs';
const HOUR=3600000,DAY=24*HOUR;
const csv='First Name,Last Name,URL,Email Address,Company,Position,Connected On\nAlex,Example,https://www.linkedin.com/in/alex-example,private@example.com,Example Company,Manager,01 Jan 2025\n';
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'brf-job-message-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false}),store=db.forUser('student'),calls=[],oldFetch=globalThis.fetch,oldToken=process.env.TELEGRAM_BOT_TOKEN;process.env.TELEGRAM_BOT_TOKEN='synthetic-message-token';globalThis.fetch=async(url,options)=>{assert.equal(String(url),'https://api.telegram.org/botsynthetic-message-token/sendMessage');calls.push(JSON.parse(options.body));return new Response(JSON.stringify({ok:true,result:{message_id:calls.length}}));};await store.put('secrets','telegram',{chatId:123});await store.put('settings','profile',{jobTitles:'Product Manager'});await saveNotificationPreferences(store,{topics:{jobs:'both',school:'off',events:'off'}});t.after(async()=>{globalThis.fetch=oldFetch;if(oldToken===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=oldToken;await db.close();await rm(dir,{recursive:true,force:true});});return {db,store,calls};}
const row=(id,age,now=Date.now())=>({id,title:`Role ${id}`,company:'Example Company',eligible:true,publishedAt:new Date(now-age).toISOString()});
test('requested job lists are globally chronological, disjoint, bounded and copyable without first-seen fallbacks',()=>{
 const now=Date.now(),jobs=[row('older',3*DAY,now),row('newest',HOUR,now),row('middle',6*HOUR,now),row('old',8*DAY,now),row('future',-HOUR,now),{id:'unknown',firstSeenAt:new Date(now).toISOString()}];
 const list=careerJobList(jobs,{now});assert.deepEqual(list.listed.map(j=>j.id),['newest','middle','older']);assert.ok(list.text.indexOf('Role newest')<list.text.indexOf('Role middle'));assert.ok(list.text.indexOf('Role middle')<list.text.indexOf('Role older'));assert.match(list.text,/LinkedIn 1st-degree/);assert.match(list.text,/\/apply newest/);assert.equal(list.jobs[0].bucket,'last24Hours');assert.equal(list.jobs[2].bucket,'pastWeek');assert.equal(careerJobList(jobs,{now,window:'24h'}).total,2);
 const huge=careerJobList(Array.from({length:20},(_,i)=>({...row('id'+i,i*HOUR,now),title:'X'.repeat(300),company:'Y'.repeat(300),location:'Z'.repeat(300)})),{now});assert.ok(huge.text.length<3900);assert.ok(huge.listed.length<=8);for(const job of huge.listed)assert.ok(huge.text.includes(`/apply ${job.id}`));
});
test('the final Telegram boundary blocks aged, changed, foreign, closed and date-less postings; requested replies work while muted',async t=>{
 const {db,store,calls}=await fixture(t),job=row('current',HOUR);await store.put('jobs',job.id,job);const metadata={channel:'requested-jobs',...publicationNotice([job])};await saveNotificationPreferences(store,{enabled:false});await sendTelegram(store,'Requested current role',{notification:metadata});assert.equal(calls.length,1);
 for(const changed of [{...job,publishedAt:new Date(Date.now()-25*HOUR).toISOString()},{...job,publishedAt:new Date(Date.now()-8*DAY).toISOString()},{...job,publishedAt:null,firstSeenAt:new Date().toISOString()},{...job,publishedAt:new Date(Date.now()+HOUR).toISOString()},{...job,status:'closed'},{...job,eligible:false}]){await store.put('jobs',job.id,changed);assert.equal((await sendTelegram(store,'Obsolete message',{notification:metadata})).suppressed,true);}
 await store.delete('jobs',job.id);await db.forUser('other').put('jobs',job.id,job);assert.equal((await sendTelegram(store,'Foreign role',{notification:metadata})).suppressed,true);assert.equal(calls.length,1);
});
test('daily briefing publication metadata reaches the same final boundary',async t=>{
 const {store,calls}=await fixture(t),job=row('brief',HOUR);await store.put('jobs',job.id,job);const briefing=await buildDailyBriefing(store),metadata=briefingNotification(briefing);assert.equal(metadata.jobs[0].id,job.id);await store.put('jobs',job.id,{...job,closed:true});const result=await sendTelegram(store,briefing.text,{notification:metadata});assert.equal(result.suppressed,true);assert.equal(calls.length,0);
});
test('warm lead replies resolve at delivery with no people copied into durable queue payloads',async t=>{
 const {db,store,calls}=await fixture(t),job=row('job-a',HOUR);await store.put('jobs',job.id,job);await importLinkedInConnections(store,{csv});const queued=[];
 await handleCareerMessage(db,{enqueue:async(userId,type,payload,options)=>{queued.push({userId,type,payload,...options});return {id:'queued'};}},store,{text:'/leads job-a',chat:{id:123,type:'private'}},1);
 assert.equal(queued[0].type,'telegram-leads');assert.deepEqual(Object.keys(queued[0].payload).sort(),['jobId','sourceVersion']);assert.doesNotMatch(JSON.stringify(queued),/Alex|private@example/);
 const delivered=await dispatchLinkedInLeads(store,queued[0].payload);assert.equal(delivered.accepted,true);assert.match(calls[0].text,/Alex Example/);assert.doesNotMatch(calls[0].text,/private@example/);assert.match(calls[0].text,/may have changed/);
 await deleteLinkedInConnections(store);assert.equal((await dispatchLinkedInLeads(store,queued[0].payload)).accepted,false);assert.equal(calls.length,1);
});
test('deleting an export during lead rendering prevents the names from being transmitted',async t=>{
 const {store,calls}=await fixture(t),job=row('job-a',HOUR);await store.put('jobs',job.id,job);await importLinkedInConnections(store,{csv});const meta=await readLinkedInConnections(store);
 const result=await dispatchLinkedInLeads(store,{jobId:job.id,sourceVersion:meta.sourceVersion},{send:async(owned,text,options)=>{await deleteLinkedInConnections(owned);return sendTelegram(owned,text,options);}});assert.equal(result.accepted,false);assert.equal(calls.length,0);
});
