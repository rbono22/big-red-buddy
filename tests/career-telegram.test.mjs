import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {handleCareerMessage} from '../lib/career-telegram.mjs';

async function setup(t){
  const dir=await mkdtemp(path.join(tmpdir(),'brf-career-telegram-'));
  const db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
  t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
  const queue=await createQueue(db),a=db.forUser('alice'),b=db.forUser('bob'),queuedPayloads=new Map();
  const enqueue=queue.enqueue.bind(queue);queue.enqueue=async(...args)=>{const job=await enqueue(...args);if(!queuedPayloads.has(job.id))queuedPayloads.set(job.id,structuredClone(args[2]));return job;};
  await a.put('secrets','telegram',{chatId:101});await b.put('secrets','telegram',{chatId:202});
  await a.put('jobs','job-a',{id:'job-a',title:'Product Manager',company:'Example Company',url:'https://example.com/job',publishedAt:new Date(Date.now()-3600000).toISOString()});
  await b.put('jobs','job-b',{id:'job-b',title:'Private role',company:'Private company'});
  await a.put('documents','resume',{name:'Resume.pdf',text:'Synthetic student builds software and interviews customers.'});
  let next=1;
  const send=(text,updateId=next++,extra={})=>handleCareerMessage(db,queue,a,{text,chat:{id:101,type:'private'},...extra},updateId);
  const jobs=()=>queue.list('alice');
  const payload=async job=>queuedPayloads.get(job.id);
  return {db,queue,a,b,send,jobs,payload};
}
const pdf={file_id:'telegram-fixture-file',file_size:1024,mime_type:'application/pdf',file_name:'resume.pdf'};

test('job link uses the owned job application URL without a resume or submission',async t=>{
 const s=await setup(t);await s.a.delete('documents','resume');
 await s.a.put('jobs','job-a',{id:'job-a',title:'Analyst',company:'Example',url:'https://example.com/job',applyUrl:'https://job-boards.greenhouse.io/example/jobs/123?gh_src=test'});
 await s.send('/job job-a',1);
 const jobs=await s.jobs();assert.equal(jobs.length,1);assert.equal(jobs[0].type,'telegram-send');
 const message=(await s.payload(jobs[0])).text;assert.match(message,/https:\/\/job-boards.greenhouse.io\/example\/jobs\/123\?gh_src=test/);assert.match(message,/does not submit/);
 await assert.rejects(s.send('/job job-b',2),/workspace/);
 assert.equal((await s.a.all('applicationTracker')).length,0);
});

test('job options offer BRB autofill for the bound application without starting or retrying submission',async t=>{
 const before=process.env.APPLICATION_BROWSER_ENABLED;process.env.APPLICATION_BROWSER_ENABLED='true';t.after(()=>{if(before===undefined)delete process.env.APPLICATION_BROWSER_ENABLED;else process.env.APPLICATION_BROWSER_ENABLED=before;});
 const s=await setup(t),url='https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply';
 await s.a.put('jobs','job-a',{id:'job-a',title:'Analyst',company:'Example',applyUrl:url});
 for(const [i,status] of ['collecting','ready','browser_handoff','uncertain','queued','submitting','submitted','needs_attention'].entries()){
  const application={id:'application-a',jobId:'job-a',url,chatId:'101',linkedAt:'',status,revision:i+1,...(status==='needs_attention'?{}:{form:{fields:[{key:'name',label:'Name',type:'text'}]}}),answers:{name:{value:'Student',reviewed:true}},...(status==='uncertain'?{submitAttemptAt:'2026-11-13T04:14:37Z',error:'Receipt unconfirmed'}:{})};
  await s.a.put('liveApplications',application.id,application);
  await s.send('/job job-a',100+i);await s.send('/job job-a',100+i);
  const messages=await s.jobs();assert.equal(messages.length,i+1);assert.ok(messages.every(j=>j.type==='telegram-send'));
  // Locate by revision because queue metadata need not expose its idempotency key.
  const cards=await Promise.all(messages.map(s.payload)),card=cards.find(p=>p.liveApplicationRevision===i+1),buttons=card.replyMarkup.inline_keyboard.flat();
  const autofill=buttons.find(b=>b.text==='Fill application in my browser');
  assert.equal(!!autofill,['collecting','ready','browser_handoff','uncertain'].includes(status));
  if(autofill)assert.ok(autofill.url.endsWith('/#application-handoff/application-a'));
  assert.equal(buttons.find(b=>b.text==='Open blank employer form').url,url);
  assert.equal(card.expectedChatId,'101');assert.equal(card.liveApplicationId,application.id);
  if(status==='uncertain')assert.match(card.text,/previous submission attempt has no confirmed receipt/i);
  assert.deepEqual(await s.a.get('liveApplications',application.id),application);
 }
 assert.equal((await s.a.all('applicationHandoffs')).length,0);
});

test('job autofill options do not expose stale chat, changed URL or another tenant application',async t=>{
 const before=process.env.APPLICATION_BROWSER_ENABLED;process.env.APPLICATION_BROWSER_ENABLED='true';t.after(()=>{if(before===undefined)delete process.env.APPLICATION_BROWSER_ENABLED;else process.env.APPLICATION_BROWSER_ENABLED=before;});
 const s=await setup(t),url='https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply';
 await s.a.put('jobs','job-a',{id:'job-a',title:'Analyst',company:'Example',applyUrl:url});
 const application={id:'private-application',jobId:'job-a',url,chatId:'101',linkedAt:'',status:'ready',revision:1};
 await s.b.put('liveApplications',application.id,application);
 for(const [i,patch] of [{chatId:'202'},{linkedAt:'another-link'},{url:url.replace('/example/','/other/')}].entries()){
  await s.a.put('liveApplications',application.id,{...application,...patch});await s.send('/job job-a',200+i);
 }
 for(const message of await s.jobs()){
  const card=await s.payload(message);assert.equal(card.liveApplicationId,undefined);
  assert.ok(card.replyMarkup.inline_keyboard.flat().some(b=>b.text==='Set up application autofill'));
  assert.ok(card.replyMarkup.inline_keyboard.flat().every(b=>!String(b.url||'').includes('application-handoff')));
 }
});

test('career commands require the linked private chat and preserve existing /resume and ordinary attachments',async t=>{
  const s=await setup(t);
  assert.equal(await s.send('/resume'),false);
  assert.equal(await s.send('',2,{document:pdf}),false);
  assert.equal(await s.send('/jobs',3,{chat:{id:202,type:'private'}}),false);
  assert.equal(await s.send('/jobs',4,{chat:{id:101,type:'group'}}),false);
  assert.equal(await s.send('/jobs@different_bot',5),false);
  assert.equal((await s.jobs()).length,0);
  assert.equal(await s.send('/jobs',6),true);
  const message=(await s.payload((await s.jobs())[0])).text;
  assert.match(message,/job-a/);assert.doesNotMatch(message,/job-b|Private company/);
});

test('resume PDF mode queues only bounded metadata and replay cannot become enrollment',async t=>{
  const s=await setup(t);await s.send('/resume_upload',10);
  await s.send('',11,{document:pdf});await s.send('',11,{document:pdf});
  const jobs=(await s.jobs()).filter(j=>j.type==='telegram-resume');assert.equal(jobs.length,1);
  assert.deepEqual(await s.payload(jobs[0]),{fileId:pdf.file_id,mimeType:'application/pdf',name:'resume.pdf',replyTo:'telegram'});
  assert.equal((await s.a.get('settings','careerUpload')).expiresAt,0);
  assert.equal(await s.b.get('settings','careerUpload'),null);
  assert.equal(await s.send('',12,{document:pdf}),false);
});

test('expired and oversized resume uploads do not queue extraction, including expired replay',async t=>{
  const s=await setup(t);await s.a.put('settings','careerUpload',{expiresAt:Date.now()-100});
  assert.equal(await s.send('',10,{document:pdf}),true);assert.equal(await s.send('',10,{document:pdf}),true);
  assert.equal((await s.jobs()).filter(j=>j.type==='telegram-resume').length,0);
  await s.send('/resume_upload',11);
  await assert.rejects(s.send('',12,{document:{...pdf,file_size:13*1024*1024}}),/12 MB/);
  assert.equal(await s.send('',13,{photo:[{file_id:'photo'}]}),true);
  assert.equal((await s.jobs()).filter(j=>j.type==='telegram-resume').length,0);
});

test('apply and review use scoped durable preparation jobs with no employer submission',async t=>{
  const s=await setup(t);
  await assert.rejects(s.send('/apply job-b',10),/workspace/);
  await s.send('/apply job-a',11);await s.send('/apply job-a',11);await s.send('/resume_review',12);
  const jobs=await s.jobs();assert.equal(jobs.filter(j=>j.type==='draft').length,1);
  const draftPayload=await s.payload(jobs.find(j=>j.type==='draft')),tracker=(await s.a.all('applicationTracker'))[0];
  assert.deepEqual(draftPayload,{id:'job-a',replyTo:'telegram',trackerId:tracker.id,trackerRequestId:tracker.requestId});
  assert.equal(jobs.filter(j=>j.type==='resume-review').length,1);
  const texts=await Promise.all(jobs.filter(j=>j.type==='telegram-send').map(s.payload));
  assert.match(texts.map(p=>p.text).join('\n'),/draft only/);
  await s.a.delete('documents','resume');await assert.rejects(s.send('/resume_review',13),/resume first/);
});
test('applynow is an explicit private-chat command that starts direct inspection without drafting or referrals',async t=>{
 const s=await setup(t),before=process.env.APPLICATION_BROWSER_ENABLED;process.env.APPLICATION_BROWSER_ENABLED='true';t.after(()=>{if(before===undefined)delete process.env.APPLICATION_BROWSER_ENABLED;else process.env.APPLICATION_BROWSER_ENABLED=before;});
 await s.a.put('jobs','direct',{id:'direct',title:'Analyst',company:'Example',applyUrl:'https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply'});
 await s.a.put('documents','resume',{name:'Resume.pdf',file:Buffer.from('%PDF-1.7 synthetic').toString('base64'),text:'Synthetic resume'});
 assert.equal(await s.send('/applynow direct',20,{chat:{id:202,type:'private'}}),false);
 await assert.rejects(s.send('/applynow job-b',21),/workspace/);
 await s.send('/applynow direct',22);await s.send('/applynow direct',22);
 const jobs=await s.jobs();assert.equal(jobs.filter(j=>j.type==='application-inspect').length,1);assert.equal(jobs.some(j=>j.type==='draft'||j.type==='telegram-leads'||j.type==='application-submit'),false);
 assert.equal((await s.a.all('liveApplications'))[0].mode,'quick');
});

test('question workflow validates ownership, accepts short real questions, and deduplicates generation',async t=>{
  const s=await setup(t);
  await assert.rejects(s.send('/answer job-b | Why this company?',10),/workspace/);
  await assert.rejects(s.send('/answer job-a | ?',11),/3–2,000/);
  await s.send('/answer job-a | Why Sony? | Focus on product work',12);
  await s.send('/generate',13);await s.send('/generate',13);await s.send('/generate',14);
  const jobs=(await s.jobs()).filter(j=>j.type==='career-answer');assert.equal(jobs.length,1);
  assert.deepEqual(await s.payload(jobs[0]),{jobId:'job-a',question:'Why Sony?',guidance:'Focus on product work',replyTo:'telegram'});
  assert.equal(await s.b.get('settings','pendingCareerQuestion'),null);
  await s.send('/write I enjoy developing useful products and would like to learn about the role.',15);
  await s.send('/write I enjoy developing useful products and would like to learn about the role.',15);
  const answers=await s.a.all('applicationAnswers');assert.equal(answers.length,1);assert.equal(answers[0].status,'reviewed');
  await assert.rejects(s.send('/write another answer',16),/Start a question/);
});

test('manual personal declarations skip model generation and reviewed-answer IDs remain tenant-scoped',async t=>{
  const s=await setup(t);
  await s.send('/answer job-a | Do you require sponsorship?',10);await s.send('/write I will enter my own accurate declaration.',11);
  assert.equal((await s.jobs()).some(j=>j.type==='career-answer'),false);
  const [manual]=await s.a.all('applicationAnswers');assert.equal(manual.method,'student-written');
  await s.b.put('applicationAnswers','foreign',{id:'foreign',jobId:'job-b',answer:'private answer'});
  await assert.rejects(s.send('/save_answer foreign',12),/unavailable/);
  await s.a.put('applicationAnswers','generated',{id:'generated',jobId:'job-a',question:'Why this role?',answer:'I enjoy building useful products.',draft:'I enjoy building useful products.',status:'draft',needsManual:false,evidence:[]});
  await s.send('/save_answer generated',13);assert.equal((await s.a.get('applicationAnswers','generated')).status,'reviewed');
  await s.a.put('settings','pendingCareerQuestion',{jobId:'job-a',question:'Why this role?',expiresAt:0});
  await assert.rejects(s.send('/write expired answer',14),/Start a question/);
  await s.send('/career_profile',15);
  const replies=await Promise.all((await s.jobs()).filter(j=>j.type==='telegram-send').map(s.payload));
  assert.ok(replies.some(p=>p.text.includes(`Answer ID: ${manual.id}`)));
  assert.ok(replies.some(p=>p.text.includes('/#careers')));
});
