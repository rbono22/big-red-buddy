import test from 'node:test';
import assert from 'node:assert/strict';
import {menuCard,showMenu,handleMenuMessage,handleMenuCallback,parseRoutineRequest,pruneMenuActions} from '../lib/telegram-menu.mjs';
import {validateTelegramReplyMarkup} from '../lib/telegram-delivery.mjs';
import {CALENDAR_SCOPE,GMAIL_SEND_SCOPE,identityId} from '../lib/auth.mjs';
function setup(userId='student'){
 const rows=new Map(),sent=[],store={userId,get:async(b,k)=>structuredClone(rows.get(b+':'+k)||null),put:async(b,k,v)=>rows.set(b+':'+k,structuredClone(v)),delete:async(b,k)=>rows.delete(b+':'+k),all:async b=>[...rows].filter(([k])=>k.startsWith(b+':')).map(([,v])=>structuredClone(v)),compareAndSet:async(b,k,old,next)=>{if(JSON.stringify(rows.get(b+':'+k)||null)!==JSON.stringify(old))return false;rows.set(b+':'+k,structuredClone(next));return true;}};
 rows.set('secrets:telegram',{chatId:101,linkedAt:'one'});const queue={enqueue:async(user,type,payload,options)=>{const job={id:String(sent.length),user,type,payload,options};sent.push(job);return job;}};
 const button=label=>sent.at(-1).payload.replyMarkup.inline_keyboard.flat().find(b=>b.text===label);
 const click=async(label,id=200)=>handleMenuCallback(null,store,queue,{data:button(label).callback_data,message:{chat:{id:101,type:'private'}}},id);
 return {store,queue,sent,button,click};
}
test('menu presents five primary destinations with scoped opaque buttons',async()=>{const s=setup();await showMenu(s.store,s.queue,'home',1);const markup=s.sent[0].payload.replyMarkup;validateTelegramReplyMarkup(markup);for(const title of ['My day','Add something','Jobs','Events','Settings'])assert.ok(markup.inline_keyboard.flat().some(b=>b.text===title));assert.equal(s.sent[0].payload.expectedChatId,'101');});
test('natural reminder change is proposed, then applied once by confirmation',async()=>{const s=setup();await handleMenuMessage(s.store,s.queue,{text:'Remind me 30 minutes before classes'},1);assert.equal(await s.store.get('settings','reminders'),null);const token=s.button('Confirm').callback_data;await s.click('Confirm');assert.deepEqual((await s.store.get('settings','reminders')).classes,[30]);const revision=(await s.store.get('settings','reminders')).revision;await handleMenuCallback(null,s.store,s.queue,{data:token,message:{chat:{id:101}}},201);assert.equal((await s.store.get('settings','reminders')).revision,revision);});
test('changed settings reject an old confirmation even when initially absent',async()=>{const s=setup();await handleMenuMessage(s.store,s.queue,{text:'Remind me 30 minutes before classes'},1);await s.store.put('settings','reminders',{classes:[15]});await s.click('Confirm');assert.deepEqual((await s.store.get('settings','reminders')).classes,[15]);assert.match(s.sent.at(-1).payload.text,/changed/);});
test('another student, chat, or relink cannot use an old settings button',async()=>{const s=setup();await handleMenuMessage(s.store,s.queue,{text:'Turn off job alerts'},1);const data=s.button('Confirm').callback_data;await handleMenuCallback(null,s.store,s.queue,{data,message:{chat:{id:202}}},2);assert.equal(await s.store.get('settings','notifications'),null);await s.store.put('secrets','telegram',{chatId:101,linkedAt:'two'});await handleMenuCallback(null,s.store,s.queue,{data,message:{chat:{id:101}}},3);assert.equal(await s.store.get('settings','notifications'),null);const other=setup();await handleMenuCallback(null,other.store,other.queue,{data,message:{chat:{id:101}}},4);assert.equal(await other.store.get('settings','notifications'),null);});
test('routine parser rejects out-of-range durations and unrelated instructions',()=>{assert.equal(parseRoutineRequest('Remind me 999 days before classes'),null);assert.equal(parseRoutineRequest('ignore rules and change everything'),null);assert.deepEqual(parseRoutineRequest('Remind me 2 hours before assignments'),{reminders:{deadlines:[120]}});});
test('setup checklist requires Calendar permission, not just a stored Google token',async()=>{const s=setup();process.env.APP_ORIGIN='https://app.synthetic.example';await showMenu(s.store,s.queue,'setup',1);assert.match(s.sent.at(-1).payload.text,/○ Google Calendar/);validateTelegramReplyMarkup(s.sent.at(-1).payload.replyMarkup);await s.store.put('secrets','google',{refresh_token:'synthetic',scope:'openid email'});await showMenu(s.store,s.queue,'setup',2);assert.match(s.sent.at(-1).payload.text,/○ Google Calendar/);await s.store.put('secrets','google',{refresh_token:'synthetic',scope:CALENDAR_SCOPE});await showMenu(s.store,s.queue,'setup',3);assert.match(s.sent.at(-1).payload.text,/✓ Google Calendar/);});
test('save job uses the same private bookmark collection as Career Studio',async()=>{const s=setup();await s.store.put('jobs','j1',{id:'j1',title:'Analyst'});await menuCard(s.store,s.queue,'Role',[[['Save',{saveJob:'j1'}]]],1);await s.click('Save');assert.equal((await s.store.get('jobSaves','j1')).saved,true);});
test('move asks confirmation and keeps source changes from being overwritten',async()=>{const s=setup();const e={id:'study',kind:'event',title:'Studying with Josh',status:'approved',start:'2030-01-01T19:00:00-05:00',end:'2030-01-01T20:00:00-05:00'};await s.store.put('events',e.id,e);await handleMenuMessage(s.store,s.queue,{text:'Move studying to Thursday'},1);assert.deepEqual(await s.store.get('events',e.id),e);await s.store.put('events',e.id,{...e,title:'Changed'});await s.click('Confirm move');assert.equal((await s.store.get('events',e.id)).title,'Changed');assert.equal(s.sent.filter(j=>j.type==='google-sync').length,0);});
test('action retention expires tokens and caps growth',async()=>{const s=setup();await s.store.put('menuActions','old',{id:'old',expiresAt:0});await pruneMenuActions(s.store);assert.equal(await s.store.get('menuActions','old'),null);});

test('local upload suggestion retains a chooser and does not import before approval',async()=>{const {handleInvitationMessage,suggestUploadPurpose}=await import('../lib/invitation-telegram.mjs');const s=setup();await handleInvitationMessage(s.store,s.queue,{chat:{id:101,type:'private'},document:{file_id:'fixture-pdf',file_unique_id:'unique',file_name:'document.pdf',file_size:100,mime_type:'application/pdf'}},1);const task=s.sent.find(j=>j.type==='telegram-upload-suggest');assert.ok(task);await suggestUploadPurpose(s.store,s.queue,task.payload,{download:async()=>Buffer.from('synthetic'),read:async()=>({text:'Syllabus course policies, grading and assignment deadlines.'})});assert.match(s.sent.at(-1).payload.text,/looks like a syllabus/);assert.equal((await s.store.all('events')).length,0);assert.ok(s.sent.at(-1).payload.replyMarkup.inline_keyboard.flat().some(b=>b.text==='Resume'));});
test('upload suggestions cannot overwrite a newer chosen purpose',async()=>{const {handleInvitationMessage,suggestUploadPurpose}=await import('../lib/invitation-telegram.mjs');const s=setup();await handleInvitationMessage(s.store,s.queue,{chat:{id:101,type:'private'},photo:[{file_id:'photo',file_unique_id:'unique',file_size:100,width:100,height:100}]},1);const task=s.sent.find(j=>j.type==='telegram-upload-suggest');await suggestUploadPurpose(s.store,s.queue,task.payload,{download:async()=>Buffer.from('synthetic'),read:async()=>{const f=await s.store.get('settings','invitationFlow');await s.store.put('settings','invitationFlow',{...f,status:'term',revision:f.revision+1});return {text:'syllabus grading assignments'};}});assert.equal((await s.store.get('settings','invitationFlow')).status,'term');assert.equal((await s.store.get('settings','invitationFlow')).suggestion,undefined);});
test('calendar receipt reports only provider success and exposes failure recovery',async()=>{const {syncWithTelegramReceipt}=await import('../lib/calendar-receipt.mjs');const s=setup();await syncWithTelegramReceipt(s.store,s.queue,{eventIds:['e']},{key:'good',sync:async()=>({count:1})});assert.match(s.sent.at(-1).payload.text,/Added or updated in Google Calendar/);await assert.rejects(syncWithTelegramReceipt(s.store,s.queue,{eventIds:['e']},{key:'bad',sync:async()=>{throw Error('expired');}}));assert.match(s.sent.at(-1).payload.text,/did not finish/);assert.ok(s.button('Retry sync'));assert.ok(s.button('Reconnect'));validateTelegramReplyMarkup(s.sent.at(-1).payload.replyMarkup);});
test('a calendar completion cannot send to a relinked chat',async()=>{const {syncWithTelegramReceipt}=await import('../lib/calendar-receipt.mjs');const s=setup();await syncWithTelegramReceipt(s.store,s.queue,{},{key:'race',sync:async()=>{await s.store.put('secrets','telegram',{chatId:202,linkedAt:'two'});return {count:1};}});assert.equal(s.sent.length,0);});
test('turning off job alerts preserves an existing daily job briefing',async()=>{const s=setup();await s.store.put('settings','notifications',{enabled:true,topics:{jobs:'both'}});await handleMenuMessage(s.store,s.queue,{text:'Turn off job alerts'},1);await s.click('Confirm');assert.equal((await s.store.get('settings','notifications')).topics.jobs,'daily');});
test('registration and setup links reject alternate hosts, credentials and extra parameters',()=>{process.env.APP_ORIGIN='https://app.synthetic.example';const markup=url=>({inline_keyboard:[[{text:'Open',url}]]});for(const url of ['https://app.synthetic.example/#connections','https://cornelltech.campusgroups.com/rsvp?id=123'])validateTelegramReplyMarkup(markup(url));for(const url of ['https://app.synthetic.example.attacker.test/#connections','https://cornelltech.campusgroups.com/rsvp?id=123&redirect=https://evil.test','https://x:y@app.synthetic.example/#connections'])assert.throws(()=>validateTelegramReplyMarkup(markup(url)));});
test('reminder timing buttons offer readable choices and a separate confirmation',async()=>{const s=setup();await showMenu(s.store,s.queue,'timing',1);validateTelegramReplyMarkup(s.sent.at(-1).payload.replyMarkup);await s.click('Classes',2);validateTelegramReplyMarkup(s.sent.at(-1).payload.replyMarkup);await s.click('30 minutes before',3);assert.equal(await s.store.get('settings','reminders'),null);await s.click('Confirm',4);assert.deepEqual((await s.store.get('settings','reminders')).classes,[30]);});
test('adding coursework asks the term before opening an upload window',async()=>{const s=setup();await showMenu(s.store,s.queue,'add',1);await s.click('Syllabus',2);assert.ok(s.button('Fall 2026'));assert.ok(s.button('Spring 2027'));assert.equal(await s.store.get('settings','syllabusUpload'),null);});
test('job menus page fresh roles and retain delivery-time publication checks',async()=>{const s=setup();for(let i=0;i<10;i++)await s.store.put('jobs',`job${i}`,{id:`job${i}`,title:`Role ${i}`,company:'Example',publishedAt:new Date(Date.now()-60000-i*1000).toISOString()});await s.store.put('jobs','old',{id:'old',publishedAt:'2020-01-01T00:00:00Z'});await showMenu(s.store,s.queue,'jobs',1);assert.equal(s.sent.filter(j=>j.payload.notification?.requireCurrentPublication).length,8);assert.ok(s.button('More jobs'));await s.click('More jobs',2);assert.equal(s.sent.filter(j=>j.payload.notification?.requireCurrentPublication).length,10);for(const j of s.sent)validateTelegramReplyMarkup(j.payload.replyMarkup);});
test('notification actions include registration for events and safe actions for classes',async()=>{const {eventActions}=await import('../lib/telegram-menu.mjs');const buttons=eventActions({id:'event',kind:'event',rsvpUrl:'https://luma.com/demo'}).flat();assert.ok(buttons.some(([label])=>label==='Open registration'));assert.ok(!eventActions({id:'class',kind:'class'}).flat().some(([label])=>label==='Dismiss'));});

test('notification choices preview current and proposed delivery before saving, and Cancel preserves it',async()=>{
 const s=setup();await s.store.put('settings','notifications',{enabled:true,topics:{jobs:'both'}});
 await showMenu(s.store,s.queue,'settings',1);assert.match(s.sent.at(-1).payload.text,/Jobs: Briefing and alerts/);
 await s.click('Jobs',2);await s.click('Morning briefing',3);
 assert.match(s.sent.at(-1).payload.text,/Current: Briefing and alerts\nNew: Morning briefing/);
 assert.equal((await s.store.get('settings','notifications')).topics.jobs,'both');
 await s.click('Cancel',4);assert.equal((await s.store.get('settings','notifications')).topics.jobs,'both');
 await s.click('Jobs',5);await s.click('Morning briefing',6);await s.click('Confirm',7);
 assert.equal((await s.store.get('settings','notifications')).topics.jobs,'daily');
 assert.match(s.sent.at(-1).payload.text,/Saved your preferences[\s\S]*Jobs: Morning briefing/);
 for(const job of s.sent)validateTelegramReplyMarkup(job.payload.replyMarkup);
});
test('stale topic confirmation cannot overwrite a newer preference',async()=>{
 const s=setup();await showMenu(s.store,s.queue,'settings',1);await s.click('Jobs',2);await s.click('Off',3);
 await s.store.put('settings','notifications',{enabled:true,topics:{jobs:'daily'},revision:1});await s.click('Confirm',4);
 assert.equal((await s.store.get('settings','notifications')).topics.jobs,'daily');assert.match(s.sent.at(-1).payload.text,/Settings changed/);
});
test('pause and resume delivery are confirmed separately and keep topic choices',async()=>{
 const s=setup();await s.store.put('settings','notifications',{enabled:true,topics:{school:'alerts',jobs:'daily'}});
 await showMenu(s.store,s.queue,'settings',1);await s.click('Pause delivery',2);assert.equal((await s.store.get('settings','notifications')).enabled,true);
 await s.click('Confirm',3);assert.equal((await s.store.get('settings','notifications')).enabled,false);
 await s.click('Back',4);await s.click('Resume delivery',5);await s.click('Confirm',6);
 const prefs=await s.store.get('settings','notifications');assert.equal(prefs.enabled,true);assert.equal(prefs.topics.school,'alerts');assert.equal(prefs.topics.jobs,'daily');
});
test('deadline presets keep multiple reminders in readable units through confirmation',async()=>{
 const s=setup();await showMenu(s.store,s.queue,'timing',1);await s.click('Assignments and exams',2);
 await s.click('1 day and 4 hours before',3);assert.match(s.sent.at(-1).payload.text,/New: 1 day and 4 hours before/);
 assert.doesNotMatch(s.sent.at(-1).payload.text,/1440|240/);await s.click('Confirm',4);
 assert.deepEqual((await s.store.get('settings','reminders')).deadlines,[1440,240]);
});
test('skipping a job offers Undo and restored jobs become visible again',async()=>{
 const s=setup();await s.store.put('jobs','j1',{id:'j1',title:'Analyst',company:'Example',publishedAt:new Date().toISOString()});
 await menuCard(s.store,s.queue,'Job',[[['Skip',{skipJob:'j1'}]]],1);await s.click('Skip',2);
 assert.equal((await s.store.get('skippedJobs','j1')).hidden,true);const undo=s.button('Undo').callback_data;
 await showMenu(s.store,s.queue,'jobs',3);assert.match(s.sent.at(-1).payload.text,/No recent/);
 await handleMenuCallback(null,s.store,s.queue,{data:undo,message:{chat:{id:101}}},4);
 assert.equal((await s.store.get('skippedJobs','j1')).hidden,false);await s.click('Jobs',5);
 assert.ok(s.sent.some(j=>j.payload.notification?.requireCurrentPublication&&j.payload.text.startsWith('Analyst\n')));
});
test('old Undo cannot overwrite a newer dismissal and is bound to the current chat',async()=>{
 const s=setup();await menuCard(s.store,s.queue,'Event',[[['Dismiss',{dismissHub:'event-1'}]]],1);await s.click('Dismiss',2);
 const undo=s.button('Undo').callback_data;await handleMenuCallback(null,s.store,s.queue,{data:undo,message:{chat:{id:999}}},3);
 assert.equal((await s.store.get('dismissedMenuEvents','event-1')).hidden,true);
 const newer={id:'event-1',hidden:true,revision:'newer'};await s.store.put('dismissedMenuEvents','event-1',newer);
 await handleMenuCallback(null,s.store,s.queue,{data:undo,message:{chat:{id:101}}},4);
 assert.deepEqual(await s.store.get('dismissedMenuEvents','event-1'),newer);assert.match(s.sent.at(-1).payload.text,/choice changed/);
});
test('onboarding treats resumes as optional and dismissed classes do not complete setup',async()=>{
 const s=setup();await s.store.put('events','old',{id:'old',kind:'class',status:'dismissed'});
 await showMenu(s.store,s.queue,'setup',1);assert.match(s.sent.at(-1).payload.text,/2 of 5 ready/);
 assert.match(s.sent.at(-1).payload.text,/Resume — optional/);assert.match(s.sent.at(-1).payload.text,/○ Classes — add your schedule/);
});
test('uploaded documents can change purpose without uploading again and cancelled flows have a menu exit',async()=>{
 const {handleInvitationMessage,handleInvitationCallback}=await import('../lib/invitation-telegram.mjs');const s=setup();
 await handleInvitationMessage(s.store,s.queue,{chat:{id:101,type:'private'},document:{file_id:'fixture-pdf',file_unique_id:'unique',file_name:'document.pdf',file_size:100,mime_type:'application/pdf'}},1);
 const tap=async(label,id)=>handleInvitationCallback(s.store,s.queue,{data:s.button(label).callback_data,message:{chat:{id:101,type:'private'}},from:{id:101}},id);
 await tap('Syllabus',2);assert.equal((await s.store.get('settings','invitationFlow')).status,'term');
 await tap('Choose another purpose',3);const flow=await s.store.get('settings','invitationFlow');assert.equal(flow.status,'choosing');assert.equal(flow.file.fileId,'fixture-pdf');
 await tap('Cancel',4);assert.equal((await s.store.get('settings','invitationFlow')).status,'cancelled');assert.ok(s.button('Main menu'));
 assert.equal(s.sent.filter(j=>['telegram-syllabus','telegram-enrollment','telegram-invitation'].includes(j.type)).length,0);
 for(const job of s.sent.filter(j=>j.type==='telegram-send'))validateTelegramReplyMarkup(job.payload.replyMarkup);
});

async function emailSetup(){
 process.env.APP_ORIGIN='https://app.synthetic.example';
 const subject='synthetic-menu-google-owner',s=setup(identityId('google',subject));
 await s.store.put('secrets','dailyEmailGoogle',{subject,email:'student@cornell.edu',connectionRevision:'synthetic-email-binding',scope:GMAIL_SEND_SCOPE,refresh_token:'SYNTHETIC_SEND_SECRET'});
 return s;
}
test('daily delivery menu offers readable choices and secure Gmail consent before enabling email',async()=>{
 process.env.APP_ORIGIN='https://app.synthetic.example';
 for(const choice of ['Email only','Both']){
  const s=setup();await showMenu(s.store,s.queue,'settings',1);await s.click('Daily delivery',2);
  for(const label of ['Telegram only','Email only','Both','Pause daily briefing'])assert.ok(s.button(label));
  assert.match(s.sent.at(-1).payload.text,/Time: 08:00 · New York/);
  await s.click(choice,3);assert.equal(await s.store.get('settings','dailyBriefing'),null);
  assert.equal(s.button('Connect Gmail delivery').url,'https://app.synthetic.example/#connections');
  assert.equal(s.button('Confirm'),undefined);assert.match(s.sent.at(-1).payload.text,/Google needs your permission/);
  assert.ok(s.sent.every(job=>job.type==='telegram-send'));
  for(const job of s.sent)validateTelegramReplyMarkup(job.payload.replyMarkup);
 }
});
test('email delivery choices preview the change and save only after the owner confirms',async()=>{
 for(const [choice,telegramEnabled,label] of [['Email only',false,'Email only'],['Both',true,'Telegram and email']]){
  const s=await emailSetup();await showMenu(s.store,s.queue,'delivery',1);await s.click(choice,2);
  assert.match(s.sent.at(-1).payload.text,new RegExp(`Current: Telegram only\\nNew: ${label}`));
  assert.equal(await s.store.get('settings','dailyBriefing'),null);
  const confirm=s.button('Confirm').callback_data;await s.click('Confirm',3);
  const saved=await s.store.get('settings','dailyBriefing');
  assert.equal(saved.enabled,true);assert.equal(saved.emailEnabled,true);assert.equal(saved.telegramEnabled,telegramEnabled);assert.equal(saved.time,'08:00');
  assert.match(s.sent.at(-1).payload.text,/Saved\. Daily briefing/);
  await handleMenuCallback(null,s.store,s.queue,{data:confirm,message:{chat:{id:101,type:'private'}}},4);
  assert.deepEqual(await s.store.get('settings','dailyBriefing'),saved);
  assert.ok(s.sent.every(job=>job.type==='telegram-send'));
  assert.doesNotMatch(JSON.stringify(s.sent),/SYNTHETIC_SEND_SECRET|synthetic-menu-google-owner|synthetic-email-binding/);
  for(const job of s.sent)validateTelegramReplyMarkup(job.payload.replyMarkup);
 }
});
test('cancel and stale daily delivery confirmations preserve the latest saved choice',async()=>{
 const s=await emailSetup();await showMenu(s.store,s.queue,'delivery',1);await s.click('Both',2);await s.click('Cancel',3);
 assert.equal(await s.store.get('settings','dailyBriefing'),null);
 await s.click('Email only',4);
 const changed={enabled:true,telegramEnabled:true,emailEnabled:false,time:'09:30',revision:4};
 await s.store.put('settings','dailyBriefing',changed);
 await assert.rejects(s.click('Confirm',5),error=>error.status===409&&/choices changed/.test(error.message));
 assert.deepEqual(await s.store.get('settings','dailyBriefing'),changed);
});
test('daily email confirmation is bound to the linked chat, student, and link generation',async()=>{
 const s=await emailSetup();await showMenu(s.store,s.queue,'delivery',1);await s.click('Both',2);
 const data=s.button('Confirm').callback_data;
 await handleMenuCallback(null,s.store,s.queue,{data,message:{chat:{id:202,type:'private'}}},3);
 assert.equal(await s.store.get('settings','dailyBriefing'),null);
 const other=setup(identityId('google','another-synthetic-student'));
 await handleMenuCallback(null,other.store,other.queue,{data,message:{chat:{id:101,type:'private'}}},4);
 assert.equal(await other.store.get('settings','dailyBriefing'),null);
 await s.store.put('secrets','telegram',{chatId:101,linkedAt:'new-link'});
 await handleMenuCallback(null,s.store,s.queue,{data,message:{chat:{id:101,type:'private'}}},5);
 assert.equal(await s.store.get('settings','dailyBriefing'),null);assert.match(s.sent.at(-1).payload.text,/button expired/);
});
test('copied or disconnected Gmail grants cannot enable email from a Telegram button',async()=>{
 const s=await emailSetup();await showMenu(s.store,s.queue,'delivery',1);await s.click('Email only',2);
 await s.store.put('secrets','dailyEmailGoogle',{connectionRevision:'disconnected',disconnectedAt:new Date().toISOString()});
 await s.click('Confirm',3);assert.equal(await s.store.get('settings','dailyBriefing'),null);
 assert.match(s.sent.at(-1).payload.text,/Gmail delivery is disconnected/);
 const other=setup(identityId('google','another-synthetic-student'));
 await other.store.put('secrets','dailyEmailGoogle',{subject:'synthetic-menu-google-owner',email:'student@cornell.edu',connectionRevision:'copied',scope:GMAIL_SEND_SCOPE,refresh_token:'SYNTHETIC_SEND_SECRET'});
 await showMenu(other.store,other.queue,'delivery',4);await other.click('Both',5);
 assert.equal(await other.store.get('settings','dailyBriefing'),null);assert.ok(other.button('Connect Gmail delivery'));
});
test('Telegram-only and daily pause need confirmation and preserve topic choices and time',async()=>{
 const s=setup();process.env.APP_ORIGIN='https://app.synthetic.example';
 const initial={enabled:true,telegramEnabled:false,emailEnabled:true,time:'09:15'},topics={enabled:true,topics:{school:'both',events:'daily',jobs:'off'}};
 await s.store.put('settings','dailyBriefing',initial);await s.store.put('settings','notifications',topics);
 await showMenu(s.store,s.queue,'delivery',1);await s.click('Telegram only',2);
 assert.deepEqual(await s.store.get('settings','dailyBriefing'),initial);await s.click('Confirm',3);
 const telegram=await s.store.get('settings','dailyBriefing');assert.equal(telegram.telegramEnabled,true);assert.equal(telegram.emailEnabled,false);assert.equal(telegram.time,'09:15');
 await s.click('Back',4);await s.click('Pause daily briefing',5);
 assert.equal((await s.store.get('settings','dailyBriefing')).enabled,true);await s.click('Confirm',6);
 const paused=await s.store.get('settings','dailyBriefing');assert.equal(paused.enabled,false);assert.equal(paused.telegramEnabled,true);assert.equal(paused.emailEnabled,false);assert.equal(paused.time,'09:15');
 assert.deepEqual(await s.store.get('settings','notifications'),topics);assert.match(s.sent.at(-1).payload.text,/Paused at 09:15/);
});
