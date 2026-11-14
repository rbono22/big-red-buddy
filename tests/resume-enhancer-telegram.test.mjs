import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {showMenu,handleMenuCallback} from '../lib/telegram-menu.mjs';
import {handleCareerMessage} from '../lib/career-telegram.mjs';
import {executeResumeEnhancement,getResumeEnhancement} from '../lib/resume-enhancer.mjs';
import {showResumeEnhancer,executeResumeEnhancementJob} from '../lib/resume-enhancer-telegram.mjs';
import {validateTelegramReplyMarkup} from '../lib/telegram-delivery.mjs';

async function setup(t){
 const oldOrigin=process.env.APP_ORIGIN;process.env.APP_ORIGIN='https://app.synthetic.example';
 const dir=await mkdtemp(path.join(tmpdir(),'brb-resume-enhancer-telegram-'));
 const database=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
 t.after(async()=>{await database.close();await rm(dir,{recursive:true,force:true});if(oldOrigin===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=oldOrigin;});
 const store=database.forUser('alice'),sent=[];await store.put('secrets','telegram',{chatId:101,linkedAt:'one'});
 const queue={enqueue:async(user,type,payload,options)=>{const job={id:String(sent.length),userId:user,type,payload,options};sent.push(job);return job;},get:async(user,id)=>sent.some(j=>j.id===id)?{status:'queued'}:null};
 const job={id:'job-a',title:'Growth Analyst',company:'Synthetic Example',description:'Use data analysis to analyze customer data and campaign performance. Work with stakeholders on customer acquisition and reporting.',publishedAt:new Date().toISOString(),applyUrl:'https://example.com/jobs/a'};
 await store.put('jobs',job.id,job);
 await store.put('documents','resume',{name:'Original.pdf',file:Buffer.from('%PDF-1.7\nsynthetic').toString('base64'),updatedAt:'2026-11-14T12:00:00Z',text:'SYNTHETIC STUDENT\nstudent@example.test\nEXPERIENCE\nExample Company\nOperations Analyst | January 2022 - Present\n• Analyzed customer data and campaign performance to improve customer acquisition reporting.\n• Collaborated with stakeholders to develop dashboards and weekly reports.\nEDUCATION\nExample University | Bachelor of Science | 2021'});
 const last=()=>sent.filter(j=>j.type==='telegram-send').at(-1),button=label=>last()?.payload.replyMarkup?.inline_keyboard.flat().find(b=>b.text===label);
 let key=0;const tap=(data,chatId=101)=>handleMenuCallback(database,store,queue,{data,message:{chat:{id:chatId,type:'private'}}},++key);
 const click=label=>{assert.ok(button(label),`Missing ${label}`);return tap(button(label).callback_data);};
 return {database,store,queue,sent,job,last,button,click,tap};
}

test('Telegram Resume AI Enhancer is reachable by job buttons and queues a bound generation without submitting',async t=>{
 const s=await setup(t);await showMenu(s.store,s.queue,'jobs','jobs');assert.ok(s.button('Resume AI Enhancer'));
 await s.click('Resume AI Enhancer');await s.click('Synthetic Example · Growth Analyst');
 assert.ok(s.button('Enhance for this job'));await s.click('Enhance for this job');
 const task=s.sent.find(j=>j.type==='resume-enhance');assert.ok(task);assert.equal(task.payload.jobId,s.job.id);
 assert.equal(task.payload.replyTo,'telegram');assert.deepEqual(task.payload.telegramBinding,{chatId:'101',linkedAt:'one'});
 assert.match(s.last().payload.text,/being prepared/);assert.ok(s.button('Check progress'));
 assert.equal(s.sent.some(j=>j.type.startsWith('application-')),false);
 assert.equal((await s.store.get('documents','resume')).name,'Original.pdf');
 for(const item of s.sent.filter(j=>j.type==='telegram-send')){validateTelegramReplyMarkup(item.payload.replyMarkup);assert.equal(item.payload.expectedChatId,'101');}
});

test('enhancer command only serves the linked private chat and exposes useful missing-job errors',async t=>{
 const s=await setup(t),msg={text:'/resume_enhance job-a',chat:{id:101,type:'private'}};
 assert.equal(await handleCareerMessage(s.database,s.queue,s.store,{...msg,chat:{id:102,type:'private'}},1),false);
 assert.equal(await handleCareerMessage(s.database,s.queue,s.store,{...msg,chat:{id:101,type:'group'}},2),false);
 assert.equal(s.sent.length,0);assert.equal(await handleCareerMessage(s.database,s.queue,s.store,msg,3),true);assert.ok(s.button('Enhance for this job'));
 await showResumeEnhancer(s.store,s.queue,4,{jobId:'not-owned'});assert.equal(s.button('Enhance for this job'),undefined);
});

test('old enhancement buttons and worker notifications cannot cross Telegram relinks',async t=>{
 const s=await setup(t);await showResumeEnhancer(s.store,s.queue,1,{jobId:s.job.id});const old=s.button('Enhance for this job').callback_data;
 await s.store.put('secrets','telegram',{chatId:101,linkedAt:'two'});await s.tap(old);
 assert.equal(s.sent.filter(j=>j.type==='resume-enhance').length,0);
 const count=s.sent.length,task={id:'fake',userId:'alice',payload:{jobId:s.job.id,replyTo:'telegram',telegramBinding:{chatId:'101',linkedAt:'one'}}};
 await executeResumeEnhancementJob(s.database,task,{queue:s.queue,execute:async()=>({status:'ready'})});assert.equal(s.sent.length,count);
 await assert.rejects(()=>executeResumeEnhancementJob(s.database,task,{queue:s.queue,execute:async()=>{throw new Error('private diagnostic must not be sent');}}));assert.equal(s.sent.length,count);
});

test('worker failure offers retry while keeping provider diagnostics private',async t=>{
 const s=await setup(t),task={id:'failed',userId:'alice',payload:{jobId:s.job.id,replyTo:'telegram',telegramBinding:{chatId:'101',linkedAt:'one'}}};
 await assert.rejects(()=>executeResumeEnhancementJob(s.database,task,{queue:s.queue,execute:async()=>{throw new Error('private diagnostic');}}));
 assert.ok(s.button('Try again'));assert.doesNotMatch(s.last().payload.text,/private diagnostic/);assert.equal(s.last().payload.expectedTelegramLinkedAt,'one');
});

test('ready Telegram result previews edits, selects the PDF for the job, and can return to original',async t=>{
 const s=await setup(t);await showResumeEnhancer(s.store,s.queue,1,{jobId:s.job.id});await s.click('Enhance for this job');
 const task=s.sent.find(j=>j.type==='resume-enhance');
 await executeResumeEnhancementJob(s.database,task,{queue:s.queue,execute:(database,job)=>executeResumeEnhancement(database,job,{generate:async()=>({value:{changes:[{id:'line-5',original:'Analyzed customer data and campaign performance to improve customer acquisition reporting.',suggested:'Analyzed customer data for data analysis and campaign performance to improve customer acquisition reporting.',keywords:['data analysis']}]}}),renderPDF:async()=>({file:Buffer.from('%PDF-1.7\nsynthetic enhanced PDF').toString('base64')})})});
 assert.match(s.last().payload.text,/Before: Analyzed/);assert.match(s.last().payload.text,/Keywords: data analysis/);assert.ok(s.button('Use for this job'));
 assert.match(s.button('View all edits & download PDF').url,/#resume-enhancer\/job-a$/);
 await s.click('Use for this job');assert.equal((await getResumeEnhancement(s.store,s.job.id)).selected,true);assert.match(s.last().payload.text,/new applications/);
 await s.click('Use original résumé');assert.equal((await getResumeEnhancement(s.store,s.job.id)).selected,false);assert.equal((await s.store.get('documents','resume')).name,'Original.pdf');
});
