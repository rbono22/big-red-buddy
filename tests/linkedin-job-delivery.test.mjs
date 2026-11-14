import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {dispatchLinkedInJobAlerts,linkedInNotice,linkedInNotificationMatches} from '../lib/linkedin-job-delivery.mjs';
import {getLinkedInAlertJobs} from '../lib/linkedin-job-email.mjs';
import {buildDailyBriefing,briefingNotification} from '../lib/daily-briefing.mjs';
import {sendTelegram} from '../lib/integrations.mjs';
import {validateTelegramReplyMarkup} from '../lib/telegram-delivery.mjs';
import {saveNotificationPreferences} from '../lib/notification-preferences.mjs';
import {refreshStoredJobMatches} from '../lib/job-discovery.mjs';

async function fixture(t){
 const dir=await mkdtemp(path.join(tmpdir(),'brb-linkedin-delivery-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false}),store=db.forUser('student'),at=Date.now(),now=()=>at;
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 const mailboxKey=createHash('sha256').update('subject').digest('hex'),config={continuous:true,revision:'consent1',connectionRevision:'mailbox1',mailboxKey,delivery:'alerts'};
 await store.put('secrets','telegram',{chatId:123,linkedAt:'linked'});
 await store.put('secrets','eventEmailGoogle',{subject:'subject',connectionRevision:'mailbox1',refresh_token:'synthetic',scope:'https://www.googleapis.com/auth/gmail.readonly'});
 await store.put('settings','linkedinJobEmail',config);await saveNotificationPreferences(store,{topics:{school:'off',events:'off',jobs:'both',news:'off'}});
 const job={id:'linkedin-123456',externalId:'123456',provider:'linkedin-email',sourceLabel:'LinkedIn alert',title:'Analyst',company:'Example',location:'New York',url:'https://www.linkedin.com/jobs/view/123456',publishedAt:null,eligible:true,status:'discovered',receivedAt:new Date(at-60000).toISOString(),linkedinEmail:{mailboxKey,connectionRevision:'mailbox1',receivedAt:new Date(at-60000).toISOString(),messageId:'mail1',alertName:'Analyst in New York'}};
 await store.put('jobs',job.id,job);return {db,store,job,config,at,now};
}
test('LinkedIn alerts are accepted once across retries and concurrent dispatch, with canonical actionable buttons',async t=>{
 const {store,now}=await fixture(t),calls=[];
 const send=async(s,text,options)=>{calls.push({text,options});assert.equal(await linkedInNotificationMatches(s,options.notification.linkedinJobEmail,{now}),true);validateTelegramReplyMarkup(options.replyMarkup);return {result:{message_id:calls.length}};};
 await Promise.all([dispatchLinkedInJobAlerts(store,{now,send}),dispatchLinkedInJobAlerts(store,{now,send})]);
 assert.equal(calls.length,1);assert.match(calls[0].text,/Received/);assert.doesNotMatch(calls[0].text,/Posted/);
 assert.equal(calls[0].options.expectedChatId,'123');assert.equal(calls[0].options.replyMarkup.inline_keyboard[0][0].url,'https://www.linkedin.com/jobs/view/123456');
 assert.equal((await dispatchLinkedInJobAlerts(store,{now,send})).sent,0);
});
test('unknown transmission outcomes never produce duplicate automatic alerts',async t=>{
 const {store,now,job}=await fixture(t);let calls=0;const send=async()=>{calls++;throw new Error('connection reset');};
 assert.equal((await dispatchLinkedInJobAlerts(store,{now,send})).uncertain,1);await dispatchLinkedInJobAlerts(store,{now,send});assert.equal(calls,1);assert.equal((await store.get('linkedinJobDeliveries',job.id)).status,'needs-review');
});
test('source opt-out, mailbox replacement, job removals, pause, and topic mute suppress delivery',async t=>{
 const {store,config,job,now}=await fixture(t),original=await getLinkedInAlertJobs(store,{now}),notice=linkedInNotice(original).linkedinJobEmail;
 assert.equal(original.jobs.length,1);
 for(const [bucket,id,value]of [['settings','linkedinJobEmail',{...config,continuous:false}],['settings','linkedinJobEmail',{...config,revision:'changed'}],['settings','profile',{paused:true}],['settings','account',{deleting:true}],['careerRemovals',job.id,{id:job.id,foundRemovedAt:new Date().toISOString()}],['skippedJobs',job.id,{id:job.id,hidden:true}],['secrets','eventEmailGoogle',{subject:'subject',connectionRevision:'different',refresh_token:'synthetic',scope:'https://www.googleapis.com/auth/gmail.readonly'}]]){
  const old=await store.get(bucket,id);await store.put(bucket,id,value);assert.equal(await linkedInNotificationMatches(store,notice,{now}),false,`${bucket}/${id}`);if(old===null)await store.delete(bucket,id);else await store.put(bucket,id,old);
 }
 await saveNotificationPreferences(store,{topics:{jobs:'off'}});let calls=0;await dispatchLinkedInJobAlerts(store,{now,send:async()=>{calls++;}});assert.equal(calls,0);
});
test('delivery guard catches consent changes after card creation, and rejects noncanonical links',async t=>{
 const {store,config,now}=await fixture(t),snapshot=await getLinkedInAlertJobs(store,{now});
 await store.put('settings','linkedinJobEmail',{...config,continuous:false});
 assert.deepEqual(await sendTelegram(store,'Synthetic card',{notification:{channel:'requested-jobs',...linkedInNotice(snapshot)}}),{suppressed:true,reason:'linkedin-job-alerts-changed'});
 assert.throws(()=>validateTelegramReplyMarkup({inline_keyboard:[[{text:'Open',url:'https://www.linkedin.com/jobs/view/123456?otpToken=private'}]]}));
 assert.throws(()=>validateTelegramReplyMarkup({inline_keyboard:[[{text:'Open',url:'https://www.linkedin.com.evil.test/jobs/view/123456'}]]}));
});
test('daily briefing labels LinkedIn separately and fences both Telegram and email source snapshots',async t=>{
 const {store,config,job,now}=await fixture(t);await store.put('settings','linkedinJobEmail',{...config,delivery:'daily'});
 const briefing=await buildDailyBriefing(store,{now});assert.match(briefing.text,/From your LinkedIn alerts/);assert.match(briefing.text,/Received/);assert.equal(briefing.counts.jobs,0);
 assert.ok(briefing.emailSections.find(section=>section.sectionKey==='linkedinAlerts').items.some(text=>text.includes('Analyst')));
 assert.equal(await linkedInNotificationMatches(store,briefingNotification(briefing).linkedinJobEmail,{now}),true);
 await store.put('careerRemovals',job.id,{id:job.id,foundRemovedAt:new Date().toISOString()});
 assert.equal(await linkedInNotificationMatches(store,briefing.emailLinkedInNotification.linkedinJobEmail,{now}),false);
});
test('old mail is backfilled without proactive alerts, other tenants cannot receive it, and résumé rescoring preserves subscribed jobs',async t=>{
 const {db,store,job,at,now}=await fixture(t);await refreshStoredJobMatches(store);assert.equal((await store.get('jobs',job.id)).eligible,true);
 await store.put('jobs',job.id,{...job,receivedAt:new Date(at-3*86400000).toISOString(),linkedinEmail:{...job.linkedinEmail,receivedAt:new Date(at-3*86400000).toISOString()}});
 let calls=0;await dispatchLinkedInJobAlerts(store,{now,send:async()=>{calls++;}});assert.equal(calls,0);
 assert.deepEqual((await getLinkedInAlertJobs(db.forUser('other'),{now})).jobs,[]);
});
