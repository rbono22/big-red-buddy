import {liveApplicationSupported} from './ashby-browser.mjs';
import {startLiveApplication,showLiveApplication} from './live-applications.mjs';
import {saveCareerAnswer} from './career.mjs';
import {HttpError} from './security.mjs';
import {handleDemographicsMessage} from './demographics-telegram.mjs';
import {listApplicationTracker,reportApplicationSubmitted,startApplicationTracking,updateApplicationTracking} from './application-tracker.mjs';
import {careerJobList,WARM_LEAD_TIP,jobApplicationLink} from './job-messages.mjs';
import {readLinkedInConnections} from './linkedin-connections.mjs';

const TTL=15*60*1000, MAX_PDF=12*1024*1024;
const commands=new Set(['/resume_upload','/resume_review','/job','/jobs','/leads','/apply','/applications','/application','/applied','/career_profile','/answer','/generate','/write','/save_answer']);
const clean=(value,max=160)=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9._:-]{1,200}$/.test(value);
const fail=message=>{throw new HttpError(400,message);};
const website=()=>`${process.env.APP_ORIGIN||'http://127.0.0.1:4318'}/#careers`;

/** Only operates on the caller's already-bound tenant; all replies use durable jobs. */
export async function handleCareerMessage(database,queue,store,msg,updateId){
  if(!store?.userId||msg?.chat?.type!=='private')return false;
  const linked=await store.get('secrets','telegram');
  if(!linked?.chatId||String(linked.chatId)!==String(msg.chat.id))return false;
  if(!Number.isSafeInteger(updateId)||updateId<0)throw new Error('Invalid Telegram update ID');
  if(await handleDemographicsMessage(database,queue,store,msg,updateId))return true;
  const text=String(msg.text||'').trim(),match=text.match(/^(\/\w+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/);
  if(match?.[2]&&match[2].toLowerCase()!==(process.env.TELEGRAM_BOT_USERNAME||'dabas_class_bot').toLowerCase())return false;
  const command=match?.[1]?.toLowerCase(),args=(match?.[3]||'').trim();
  const reply=async (message,notification)=>{await queue.enqueue(store.userId,'telegram-send',{text:message.slice(0,3900),...(notification?{notification}:{})},{idempotencyKey:`career-reply:${updateId}`,retrySafe:false,maxAttempts:1});return true;};
  const enqueue=async(type,payload)=>queue.enqueue(store.userId,type,{...payload,replyTo:'telegram'},{idempotencyKey:`career:${updateId}`,retrySafe:true,maxAttempts:2});
  const ownedJob=async id=>{
    if(!validId(id))fail('Use the complete job ID shown by /jobs.');
    const job=await store.get('jobs',id);
    if(!job||job.closed||job.status==='closed'||job.eligible===false)fail('That job is not available in your workspace. Send /jobs for your saved jobs.');
    return job;
  };
  const upload=msg.document||msg.photo?await store.get('settings','careerUpload'):null;
  if(upload?.expiredUpdateId===updateId)return reply('Your resume upload window expired. Send /resume_upload, then attach the PDF again.');
  if(upload&&(upload.expiresAt>Date.now()||upload.uploadUpdateId===updateId)){
    const d=msg.document;
    if(!d||d.mime_type!=='application/pdf')return reply('Send your resume as a PDF: up to 12 MB and 6 pages, including at most 4 scanned pages. This resume upload window is still open.');
    if(!d.file_id||String(d.file_id).length>512||!Number.isSafeInteger(d.file_size)||d.file_size<1||d.file_size>MAX_PDF)fail('Send a PDF resume up to 12 MB with a valid file size.');
    const name=clean(String(d.file_name||'Resume.pdf').split(/[\\/]/).at(-1),160)||'Resume.pdf';
    await enqueue('telegram-resume',{fileId:d.file_id,mimeType:'application/pdf',name});
    // Keep this update marker so a polling replay cannot route the same PDF as enrollment.
    await store.put('settings','careerUpload',{expiresAt:0,uploadUpdateId:updateId});
    return reply('Your resume upload is queued. After it is saved, send /resume_review for suggestions. No application will be submitted.');
  }
  if(upload?.expiresAt&&upload.expiresAt<=Date.now()){
    await store.put('settings','careerUpload',{expiresAt:0,expiredUpdateId:updateId});
    return reply('Your resume upload window expired. Send /resume_upload, then attach the PDF again.');
  }
  if(!commands.has(command))return false;
  if(text.length>8500)fail('That message is too long. Keep answers under 8,000 characters.');
  if(command==='/resume_upload'){
    await store.put('settings','careerUpload',{expiresAt:Date.now()+TTL});
    return reply('Send your resume as a PDF within 15 minutes: up to 12 MB and 6 pages, including at most 4 scanned pages. It will replace the resume in your own BRB workspace. Telegram also processes files sent through this chat.');
  }
  if(command==='/career_profile')return reply(`Enter and review your own application facts in Career Studio: ${website()}\nWork authorization, sponsorship, availability, and other personal declarations must come from you.`);
  if(command==='/job'){
    const job=await ownedJob(args);
    return reply(`${clean(job.title,120)} — ${clean(job.company,100)}\n${clean(job.location,160)||'Location not specified'}\n\n${jobApplicationLink(job)}\n\nOpening this link does not submit an application. ${liveApplicationSupported(job)?`/apply ${job.id} starts the real Telegram application review, followed by a Submit button.`:`/apply ${job.id} prepares answers; /applied ${job.id} records your report after you submit.`}`);
  }
  if(command==='/jobs'){
    if(args&&!['24h','week'].includes(args.toLowerCase()))return reply('Use /jobs 24h for postings from the past 24 hours or /jobs week for the past seven days. Both show newest first.');
    const listing=careerJobList(await store.all('jobs'),{window:args.toLowerCase()||'week'});
    return reply(listing.text,listing.listed.length?{channel:'requested-jobs',requireCurrentPublication:true,jobs:listing.jobs}:undefined);
  }
  if(command==='/leads'){
    const job=await ownedJob(args),metadata=await readLinkedInConnections(store);
    if(!metadata.connected)return reply(`${WARM_LEAD_TIP}\nUpload your own Connections.csv in Career Studio to check for potential contacts at ${clean(job.company,80)}: ${website()}`);
    await queue.enqueue(store.userId,'telegram-leads',{jobId:job.id,sourceVersion:metadata.sourceVersion},{idempotencyKey:`linkedin-leads:${updateId}`,retrySafe:false,maxAttempts:1});return true;
  }
  if(command==='/applications'){
    const rows=await listApplicationTracker(store,{queue});
    if(!rows.length)return reply('No applications are tracked yet. Send /jobs, then /apply JOB_ID to prepare materials. Use /applied JOB_ID only after you submit outside BRB.');
    const lines=['Your applications — preparation is separate from submission.'];
    for(const row of rows.slice(0,8))lines.push(`${clean(row.title,80)} — ${clean(row.company,60)}\n${clean(row.location,80)||'Not specified'}\nExperience: ${clean(row.experienceEvidence?row.experience:'Not specified',180)}\n${row.statusLabel} · ${row.sourceLabel}\nJob ID: ${clean(row.jobId,200)}`);
    lines.push(`Showing up to 8 of ${rows.length}. Full tracker: ${website()}\nUse /applied JOB_ID only when you have submitted on the employer’s site. Student-reported submissions remain separate from employer-confirmed receipts.`);
    while(lines.join('\n\n').length>3900&&lines.length>2)lines.splice(lines.length-2,1);
    return reply(lines.join('\n\n'));
  }
  if(command==='/applied'){
    if(!validId(args))fail('Use /applied followed by the complete job ID. This records your own report of submission outside BRB.');
    await listApplicationTracker(store,{queue});
    const tracked=await reportApplicationSubmitted(store,{jobId:args,source:'telegram'});
    return reply(`Recorded as submitted (student-reported): ${clean(tracked.title,100)} at ${clean(tracked.company,80)}.\nBRF did not submit this application and has not verified employer receipt. See /applications; correct the status in Career Studio if needed.`);
  }
  if(command==='/resume_review'){
    if(!(await store.get('documents','resume'))?.text)fail('Upload a readable PDF resume first with /resume_upload.');
    await enqueue('resume-review',{});
    return reply('Your resume review is queued. Suggestions will be sent here for your review.');
  }
  if(command==='/application'){
    const flow=await store.get('settings','liveApplicationFlow'),application=flow?.id&&await store.get('liveApplications',flow.id);
    if(!application)return reply('Choose Apply via Telegram on a supported job to begin.');
    await showLiveApplication(store,queue,application,updateId);return true;
  }
  if(command==='/apply'){
    const job=await ownedJob(args);
    if(liveApplicationSupported(job)){await startLiveApplication(store,queue,job.id,updateId);return true;}
    if(!String((await store.get('documents','resume'))?.text||'').trim())fail('Upload your PDF resume first with /resume_upload.');
    const tracked=await startApplicationTracking(store,job,{source:'telegram',updateId});
    if(tracked.staleRequest)return reply('This preparation request was already handled. Use /applications to see the current record.');
    let task;
    try{task=await enqueue('draft',{id:job.id,trackerId:tracked.id,trackerRequestId:tracked.requestId});}
    catch{
      await updateApplicationTracking(store,{id:tracked.id,requestId:tracked.requestId,status:'needs_attention',errorCode:'ENQUEUE_FAILED'});
      return reply('Your application tracker is saved, but preparation could not be queued. Check /applications and retry /apply after the current processing finishes. No employer submission was attempted.');
    }
    await updateApplicationTracking(store,{id:tracked.id,requestId:tracked.requestId,status:'queued',taskId:task.id});
    return reply(`Preparation queued for ${clean(job.title,90)} at ${clean(job.company,65)} using your current saved resume. This prepares a draft only; you review and submit on the employer's site. Track progress with /applications.\n\n${WARM_LEAD_TIP}\n/leads ${job.id}\nFor an employer question: /answer ${job.id} | question | optional guidance, then /generate for AI help or /write your own answer.`);
  }
  if(command==='/answer'){
    const parts=args.split('|').map(v=>v.trim());
    if(parts.length<2||parts.length>3)fail('Use /answer <job ID> | application question | optional guidance.');
    const [jobId,question,guidance='']=parts;await ownedJob(jobId);
    if(question.length<3||question.length>2000||guidance.length>2000)fail('Use a question of 3–2,000 characters and guidance up to 2,000 characters.');
    await store.put('settings','pendingCareerQuestion',{jobId,question,guidance,expiresAt:Date.now()+TTL});
    return reply('Question saved for 15 minutes. Send /generate for a resume-grounded draft, or /write followed by your own answer. Personal declarations require your own answer. Nothing will be submitted.');
  }
  if(command==='/save_answer'){
    if(!validId(args))fail('Use /save_answer followed by the complete answer ID.');
    const answer=await store.get('applicationAnswers',args);
    if(!answer||!answer.answer?.trim()||answer.needsManual)fail('This answer is unavailable or requires your own text. Use /answer then /write, or edit it in Career Studio.');
    const saved=await saveCareerAnswer(store,{id:args,answer:answer.answer});
    return reply(`Answer ${saved.id} is marked reviewed by you. No application was submitted.`);
  }
  const pending=await store.get('settings','pendingCareerQuestion');
  if(!pending||pending.expiresAt<=Date.now()||(pending.completedUpdateId!==undefined&&pending.completedUpdateId!==updateId))fail('Start a question with /answer <job ID> | question, then use /generate or /write within 15 minutes.');
  await ownedJob(pending.jobId);
  if(command==='/generate'){
    if(pending.generationUpdateId!==undefined&&pending.generationUpdateId!==updateId)return reply('A draft for this question is already queued. Use /write with your own answer, or start another question with /answer.');
    await enqueue('career-answer',{jobId:pending.jobId,question:pending.question,guidance:pending.guidance});
    await store.put('settings','pendingCareerQuestion',{...pending,generationUpdateId:updateId});
    return reply('Your answer draft is queued. Review the result before using /save_answer. No application will be submitted.');
  }
  if(!args||args.length>8000)fail('Use /write followed by your answer, up to 8,000 characters.');
  const saved=await saveCareerAnswer(store,{jobId:pending.jobId,question:pending.question,answer:args});
  await store.put('settings','pendingCareerQuestion',{...pending,completedUpdateId:updateId});
  return reply(`Your answer is saved as student-written and reviewed. Answer ID: ${saved.id}. No application was submitted.`);
}
