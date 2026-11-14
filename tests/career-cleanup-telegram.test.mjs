import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {showMenu,handleMenuCallback,handleMenuMessage} from '../lib/telegram-menu.mjs';
import {handleCareerMessage} from '../lib/career-telegram.mjs';
import {showCareerCleanup} from '../lib/career-cleanup-telegram.mjs';
import {listApplicationTracker} from '../lib/application-tracker.mjs';
import {listCareerJobs,setJobSaved} from '../lib/job-saves.mjs';
import {validateTelegramReplyMarkup} from '../lib/telegram-delivery.mjs';

async function setup(t){
 const previousOrigin=process.env.APP_ORIGIN;process.env.APP_ORIGIN='https://app.synthetic.example';t.after(()=>{if(previousOrigin===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=previousOrigin;});
 const dir=await mkdtemp(path.join(tmpdir(),'brb-career-cleanup-telegram-'));
 const database=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
 t.after(async()=>{await database.close();await rm(dir,{recursive:true,force:true});});
 const store=database.forUser('alice'),other=database.forUser('bob'),sent=[];
 await store.put('secrets','telegram',{chatId:101,linkedAt:'one'});await other.put('secrets','telegram',{chatId:202,linkedAt:'two'});
 const queue={enqueue:async(user,type,payload,options)=>{const job={id:String(sent.length),user,type,payload,options};sent.push(job);return job;},listDraftOrigins:async()=>[],get:async()=>null};
 const button=label=>sent.at(-1)?.payload.replyMarkup?.inline_keyboard.flat().find(b=>b.text===label);
 let key=0;
 const tapData=(data,options={})=>handleMenuCallback(null,options.store||store,queue,{data,message:{chat:{id:options.chatId??101,type:'private'}}},++key);
 const click=label=>{assert.ok(button(label),`Missing button ${label}`);return tapData(button(label).callback_data);};
 const job={id:'job-a',title:'Product Manager',company:'Example',publishedAt:new Date().toISOString(),applyUrl:'https://example.com/jobs/a'};
 await store.put('jobs',job.id,job);await other.put('jobs',job.id,job);await setJobSaved(store,{id:job.id,saved:true});await setJobSaved(other,{id:job.id,saved:true});
 await store.put('documents','resume',{text:'Synthetic résumé',name:'Resume.pdf'});await store.put('career','profile',{fullName:'Synthetic student'});
 const validate=()=>{for(const message of sent){assert.equal(message.type,'telegram-send');validateTelegramReplyMarkup(message.payload.replyMarkup);assert.equal(message.payload.expectedChatId,'101');}};
 return {database,store,other,queue,sent,button,click,tapData,job,validate};
}

test('job lists are reachable through buttons and cancellation invalidates the old confirmation',async t=>{
 const s=await setup(t);await showMenu(s.store,s.queue,'jobs','jobs');assert.ok(s.button('Manage job lists'));assert.ok(s.button('My applications'));
 await s.click('Manage job lists');await s.click('Saved jobs · 1');await s.click('Remove 1: Product Manager');
 const confirm=s.button('Confirm removal').callback_data;
 assert.equal((await s.store.get('jobSaves','job-a')).saved,true);assert.match(s.sent.at(-1).payload.text,/Your résumé, profile, and saved answers stay available/);
 await s.click('Cancel');assert.match(s.sent.at(-1).payload.text,/Cancelled. Nothing was removed/);
 await s.tapData(confirm);assert.match(s.sent.at(-1).payload.text,/expired or was cancelled/);assert.equal((await s.store.get('jobSaves','job-a')).saved,true);
 s.validate();
});

test('confirmed bookmark removal is tenant scoped and an old button cannot remove a later save',async t=>{
 const s=await setup(t);await showCareerCleanup(s.store,s.queue,'saved',{scope:'saved'});await s.click('Remove 1: Product Manager');const confirm=s.button('Confirm removal').callback_data;
 await s.click('Confirm removal');assert.match(s.sent.at(-1).payload.text,/Removed from your lists: 0 applications · 1 saved job · 0 found jobs/);
 assert.equal((await listCareerJobs(s.store))[0].saved,false);assert.equal((await s.other.get('jobSaves','job-a')).saved,true);assert.ok(await s.store.get('documents','resume'));
 await setJobSaved(s.store,{id:'job-a',saved:true});await s.tapData(confirm);assert.equal((await s.store.get('jobSaves','job-a')).saved,true);s.validate();
});

test('confirmation is rejected for a different chat, tenant, or relinked account',async t=>{
 const s=await setup(t);await showCareerCleanup(s.store,s.queue,'saved',{scope:'saved'});await s.click('Reset saved jobs');const data=s.button('Confirm reset').callback_data;
 await s.tapData(data,{chatId:202});assert.equal((await s.store.get('jobSaves','job-a')).saved,true);
 await s.tapData(data,{chatId:202,store:s.other});assert.equal((await s.other.get('jobSaves','job-a')).saved,true);
 await s.store.put('secrets','telegram',{chatId:101,linkedAt:'relinked'});await s.tapData(data);assert.equal((await s.store.get('jobSaves','job-a')).saved,true);assert.match(s.sent.at(-1).payload.text,/button expired/);
});

test('submitted applications can leave the tracker while preserving the employer receipt',async t=>{
 const s=await setup(t),receipt={confirmation:'Synthetic employer receipt',confirmedAt:new Date().toISOString()};
 await s.store.put('liveApplications','live-a',{id:'live-a',jobId:'job-a',title:'Product Manager',company:'Example',status:'submitted',revision:1,receipt,submitAttemptAt:new Date().toISOString()});
 await handleCareerMessage(s.database,s.queue,s.store,{text:'/applications',chat:{id:101,type:'private'}},101);
 assert.ok(s.button('Remove or reset applications'));await s.click('Remove or reset applications');await s.click('Remove 1: Product Manager');
 assert.match(s.sent.at(-1).payload.text,/does not withdraw|not withdrawn/);await s.click('Confirm removal');
 assert.equal((await listApplicationTracker(s.store,{queue:s.queue})).length,0);assert.deepEqual((await s.store.get('liveApplications','live-a')).receipt,receipt);s.validate();
});

test('processing applications explain why reset is blocked without offering a confirmation',async t=>{
 const s=await setup(t);await s.store.put('liveApplications','live-a',{id:'live-a',jobId:'job-a',title:'Product Manager',company:'Example',status:'submitting',revision:1,submitAttemptAt:new Date().toISOString()});
 await showCareerCleanup(s.store,s.queue,'applications',{scope:'applications'});await s.click('Reset applications');assert.equal(s.button('Confirm reset'),undefined);assert.match(s.sent.at(-1).payload.text,/still processing/);assert.equal((await s.store.get('liveApplications','live-a')).status,'submitting');
});

test('found-job reset removes those postings from later Telegram suggestions and /jobs',async t=>{
 const s=await setup(t);await showCareerCleanup(s.store,s.queue,'found',{scope:'found'});await s.click('Reset found jobs');await s.click('Confirm reset');
 await showMenu(s.store,s.queue,'jobs','fresh-jobs');assert.match(s.sent.at(-1).payload.text,/No recent matching jobs available/);
 await handleCareerMessage(s.database,s.queue,s.store,{text:'/jobs',chat:{id:101,type:'private'}},103);
 assert.doesNotMatch(s.sent.at(-1).payload.text,/Product Manager/);assert.equal((await s.store.get('jobSaves','job-a')).saved,true);
});

test('reset-all and list pagination keep profile data while exposing each individual item',async t=>{
 const s=await setup(t);
 for(let i=0;i<7;i++)await s.store.put('jobs',`extra-${i}`,{...s.job,id:`extra-${i}`,title:`Role ${i}`});
 assert.equal(await handleMenuMessage(s.store,s.queue,{text:'/managejobs'},104),true);await s.click('Found jobs · 8');assert.ok(s.button('Next'));await s.click('Next');assert.ok(s.button('Previous'));
 await s.click('Manage job lists');await s.click('Reset all three lists');assert.match(s.sent.at(-1).payload.text,/1 saved job · 8 found jobs/);await s.click('Confirm reset');
 assert.ok(s.button('Saved jobs · 0'));assert.ok(s.button('Found jobs · 0'));assert.deepEqual(await s.store.get('career','profile'),{fullName:'Synthetic student'});assert.ok(await s.store.get('documents','resume'));s.validate();
});
