import {buildScheduleBrief} from './calendar-agenda.mjs';
import {dispatchDailyEmail,dispatchDailyEmailPreview} from './daily-email.mjs';
import {HttpError} from './security.mjs';
import {processSyllabusUpload} from './syllabus-upload.mjs';
import {prepareSyllabusProposal,syllabusReviewMessage} from './syllabus-telegram.mjs';
import {processInvitationUpload,suggestUploadPurpose} from './invitation-telegram.mjs';
import { pilotWorkAllowed } from './pilot-access.mjs';
import {syncCampusWithImports,runScheduledCampusSync} from './campus-schedule.mjs';
import {syncPartifulCalendar} from './partiful-calendar.mjs';
import {syncLumaCalendar} from './luma-calendar.mjs';
import {refreshAcademicCalendar} from './academic-calendar.mjs';
import {syncCanvasFeed} from './canvas-feed.mjs';
import {createCanvasEmail} from './canvas-email.mjs';
import {syncEventEmail,importEventEmail} from './event-email.mjs';
import {dispatchQueuedTelegram} from './telegram-delivery.mjs';
import {syncNews,importNews} from './news.mjs';
import {queueNewsAlerts,dispatchNewsAlert} from './news-delivery.mjs';
import {syncLinkedInJobEmail} from './linkedin-job-email.mjs';
import {dispatchLinkedInJobAlerts} from './linkedin-job-delivery.mjs';
import {executeCareerJob,executeApplicationDraft} from './career-jobs.mjs';
import {analyzeCareerExperience,readCareerExperience} from './career-experience.mjs';
import {queueExperienceAnalysis} from './career-experience-jobs.mjs';
import {dispatchLinkedInRefresh} from './linkedin-refresh.mjs';
import {dispatchLinkedInLeads} from './linkedin-delivery.mjs';
import {refreshStoredJobMatches,dispatchJobAlerts} from './job-discovery.mjs';
import {dispatchDailyBriefing,buildDailyBriefing,briefingNotification} from './daily-briefing.mjs';
import {prepareEnrollmentProposal,enrollmentReviewMessage} from './enrollment-workflow.mjs';
import {validateEnrollmentUpload} from './enrollment.mjs';
import {downloadTelegramEnrollment} from './telegram-files.mjs';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { idFor } from './domain.mjs';
import { pdfText, extractEvents, persistCandidates, modelJSON } from './ingest.mjs';
import { audit, nowISO, syncGoogle, syncSlack, fetchJobs, assistantReply, sendTelegram, dispatchReminders } from './integrations.mjs';

export const MODEL_TYPES = ['application-inspect','application-answer','application-location','application-submit','canvas-email-sync','telegram-upload-suggest','telegram-invitation','telegram-syllabus','pdf','studio','draft','chat','telegram-chat','slack-sync','enrollment','telegram-enrollment','resume-review','resume-enhance','career-answer','career-experience','telegram-resume','event-email-sync','event-email-import','news-sync','news-import'];
export const REMINDER_TYPES = ['calendar-delete-search','calendar-delete-preview','calendar-delete','reminders','telegram-send','telegram-brief','telegram-daily-preview','telegram-news-alert','telegram-leads','linkedin-refresh-reminder','google-sync','campus-sync','campus-daily-sync','partiful-sync','luma-sync','canvas-sync','daily-briefing','daily-email','daily-email-preview','academic-refresh'];
export const DISCOVERY_TYPES=['jobs-search','job-alerts','linkedin-job-email-sync','linkedin-job-alerts'];
export function validateUpload(payload) {
  if (!['syllabus','resume'].includes(payload.type)) throw new Error('Choose syllabus or resume.');
  if(payload.type==='syllabus'){
    if(payload.term&&!['FA26','SP27'].includes(payload.term))throw new Error('Choose Fall 2026 or Spring 2027.');
    return validateEnrollmentUpload({...payload,mimeType:payload.mimeType||'application/pdf'});
  }
  if (typeof payload.base64!=='string' || payload.base64.length>16*1024*1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.base64)) throw new Error('Upload a PDF smaller than 12 MB.');
  const buffer=Buffer.from(payload.base64,'base64');
  if(buffer.length>12*1024*1024||!buffer.subarray(0,5).equals(Buffer.from('%PDF-'))) throw new Error('Upload a PDF smaller than 12 MB.');
  return buffer;
}
const safeURL = value => {try{const u=new URL(value);return u.protocol==='https:'?u.href:'';}catch{return '';}};
async function metric(store,result,task) {await store.put('metrics',randomBytes(12).toString('hex'),{...result.metrics,task,at:nowISO()});}

export async function executeJob(database,job) {
  if (!await pilotWorkAllowed(database, job.userId)) return {skipped: true, reason: 'pilot_access_revoked'};
  // The lease carries the database-owned student ID, never a user-supplied body field.
  const store=database.forUser(job.userId), b=job.payload || {};
  if ((await store.get('settings','account'))?.deleting) throw new Error('Account deletion in progress.');
  switch(job.type) {
    case 'calendar-delete-search': case 'calendar-delete-preview': case 'calendar-delete': {
      const {createQueue}=await import('./queue.mjs'),queue=await createQueue(database,{workerDatabaseUrl:null});
      try{return await (await import('./calendar-deletion-telegram.mjs')).executeCalendarDeletionJob(store,queue,job.type,b,{key:job.id,isAllowed:()=>pilotWorkAllowed(database,job.userId)});}finally{await queue.close();}
    }
    case 'application-inspect': case 'application-answer': case 'application-location': case 'application-submit': {
      const {createQueue}=await import('./queue.mjs'),queue=await createQueue(database,{workerDatabaseUrl:null});
      try{return await (await import('./live-applications.mjs')).executeLiveApplication(database,job,{queue});}finally{await queue.close();}
    }
    case 'telegram-upload-suggest':
    case 'telegram-invitation': {
      const {createQueue}=await import('./queue.mjs'),queue=await createQueue(database,{workerDatabaseUrl:null});
      try{return await (job.type==='telegram-upload-suggest'?suggestUploadPurpose:processInvitationUpload)(store,queue,{...b,jobId:job.id},{assertAccess:()=>pilotWorkAllowed(database,job.userId)});}finally{await queue.close();}
    }
    case 'linkedin-refresh-reminder':return dispatchLinkedInRefresh(store,b);
    case 'telegram-leads':return dispatchLinkedInLeads(store,b);
    case 'linkedin-job-email-sync': {
      const result=await syncLinkedInJobEmail(store);
      return {...result,alerts:await dispatchLinkedInJobAlerts(store)};
    }
    case 'linkedin-job-alerts': return dispatchLinkedInJobAlerts(store);
    case 'job-alerts':{const {createQueue}=await import('./queue.mjs'),queue=await createQueue(database,{workerDatabaseUrl:null});try{return await dispatchJobAlerts(store,{queue});}finally{await queue.close();}}
    case 'career-experience': {
      const current=await readCareerExperience(store);if(b.sourceHash&&b.sourceHash!==current.sourceHash)return {superseded:true};
      const result=await analyzeCareerExperience(store);await refreshStoredJobMatches(store);return {status:result.status,totalMonths:result.totalMonths,pending:result.pending?.length||0};
    }
    case 'news-sync': case 'news-import': {
      const result=job.type==='news-sync'?await syncNews(store):await importNews(store,b);
      const {createQueue}=await import('./queue.mjs'),queue=await createQueue(database,{workerDatabaseUrl:null});
      try{return {...result,alerts:await queueNewsAlerts(store,queue)};}finally{await queue.close();}
    }
    case 'telegram-news-alert': return dispatchNewsAlert(store,b);
    case 'event-email-sync': {
      const {createQueue}=await import('./queue.mjs'),queue=await createQueue(database,{workerDatabaseUrl:null});
      try{return await syncEventEmail(store,queue);}finally{await queue.close();}
    }
    case 'event-email-import': return importEventEmail(store,b);
    case 'academic-refresh': return refreshAcademicCalendar(store);
    case 'canvas-email-sync': {
      const {createQueue}=await import('./queue.mjs'),queue=await createQueue(database,{workerDatabaseUrl:null});
      const watcher=createCanvasEmail({notify:(owned,text)=>sendTelegram(owned,text,{notification:{channel:'alerts',topic:'school'}})});
      try{return await watcher.syncCanvasEmail(store,{queue});}finally{await queue.close();}
    }
    case 'canvas-sync': {
      const {createQueue}=await import('./queue.mjs'),queue=await createQueue(database,{workerDatabaseUrl:null});
      try{return await syncCanvasFeed(store,{queue});}finally{await queue.close();}
    }
    case 'resume-enhance': {
      const {createQueue}=await import('./queue.mjs'),queue=await createQueue(database,{workerDatabaseUrl:null});
      try{return await (await import('./resume-enhancer-telegram.mjs')).executeResumeEnhancementJob(database,job,{queue});}finally{await queue.close();}
    }
    case 'resume-review': case 'career-answer': case 'telegram-resume': return executeCareerJob(database,job);
    case 'enrollment': {
      const buffer=validateEnrollmentUpload(b);
      const proposal=await prepareEnrollmentProposal(store,{buffer,mimeType:b.mimeType,name:b.name,term:b.term},{id:idFor('enrollment-proposal',job.id)});
      return {proposalId:proposal.id,candidates:proposal.candidates.length};
    }
    case 'telegram-syllabus': {
      if(!(await store.get('secrets','telegram'))?.chatId)throw new Error('Telegram is no longer linked.');
      const {createQueue}=await import('./queue.mjs'),queue=await createQueue(database,{workerDatabaseUrl:null});
      try {
        const buffer=await downloadTelegramEnrollment(b.fileId);
        const proposal=await prepareSyllabusProposal(store,{buffer,mimeType:b.mimeType,name:b.name,term:b.term});
        await queue.enqueue(job.userId,'telegram-send',{text:await syllabusReviewMessage(store,proposal)},{idempotencyKey:`syllabus-result:${job.id}`,retrySafe:false,maxAttempts:1});
        return {proposalId:proposal.id,count:proposal.items.length};
      } catch(error) {
        const message=error instanceof HttpError&&error.status<500?error.message:'Your syllabus could not be processed. Send a clearer photo of the dates and deadline rules, or try a shorter PDF. No dates were automatically added to Google Calendar.';
        await queue.enqueue(job.userId,'telegram-send',{text:message},{idempotencyKey:`syllabus-error:${job.id}`,retrySafe:false,maxAttempts:1});
        throw error;
      } finally { await queue.close(); }
    }
    case 'telegram-enrollment': {
      if(!(await store.get('secrets','telegram'))?.chatId)throw new Error('Telegram is no longer linked.');
      const {createQueue}=await import('./queue.mjs');const queue=await createQueue(database,{workerDatabaseUrl:null});
      try{
        const buffer=await downloadTelegramEnrollment(b.fileId);
        validateEnrollmentUpload({base64:buffer.toString('base64'),mimeType:b.mimeType,name:b.name});
        const proposal=await prepareEnrollmentProposal(store,{buffer,mimeType:b.mimeType,name:b.name,term:b.term},{id:idFor('enrollment-proposal',job.id)});
        await queue.enqueue(job.userId,'telegram-send',{text:enrollmentReviewMessage(proposal)},{idempotencyKey:`enrollment-result:${job.id}`,retrySafe:false,maxAttempts:1});
        return {proposalId:proposal.id,candidates:proposal.candidates.length};
      }catch(error){
        const message=error.statusCode&&error.statusCode<500?error.message:'The enrollment image could not be processed. Try a clearer PDF/photo or use the course picker in Academics.';
        await queue.enqueue(job.userId,'telegram-send',{text:message},{idempotencyKey:`enrollment-error:${job.id}`,retrySafe:false,maxAttempts:1});
        throw error;
      }
    }
    case 'pdf': {
      if(b.type==='syllabus'){const result=await processSyllabusUpload(store,b);await metric(store,result,'syllabus extraction');return {count:result.count,method:result.method};}
      const buffer=validateUpload(b), dir=await mkdtemp(path.join(tmpdir(),'dabas-upload-'));
      let text;try {const file=path.join(dir,'upload.pdf');await writeFile(file,buffer,{mode:0o600});text=await pdfText(file);}finally{await rm(dir,{recursive:true,force:true});}
      const name=path.basename(String(b.name||'Document.pdf')).slice(0,200);
      if(b.type==='resume') {await store.put('documents','resume',{name,text,file:buffer.toString('base64'),updatedAt:nowISO()});await store.delete('career','resumeReview');await refreshStoredJobMatches(store);const {createQueue}=await import('./queue.mjs'),queue=await createQueue(database,{workerDatabaseUrl:null});let analysis;try{analysis=await queueExperienceAnalysis(store,queue,{allowDeferred:true});}finally{await queue.close();}await audit(store,'upload','Resume stored with encryption.');return {resume:true,experienceTaskId:analysis?.taskId||null,...(analysis?.warning?{warning:analysis.warning}:{})};}
    }
    case 'studio': {
      const result=await extractEvents(b.text,'studio',process.env.OLLAMA_MODEL);
      await persistCandidates(store,{id:idFor('studio',b.sourceUrl||b.text),name:'Product Studio · pasted announcement',type:'slack-import',url:safeURL(b.sourceUrl),method:result.method,text:b.text.slice(0,20000)},result.events);
      await metric(store,result,'studio extraction');return {count:result.events.length};
    }
    case 'draft': return executeApplicationDraft(database,job);
    case 'chat': return {answer:await assistantReply(store,b.question)};
    case 'telegram-chat': {
      const answer=await assistantReply(store,b.question);
      // Model work never transmits messages. A distinct queue item is handled by the reminders worker.
      const {createQueue}=await import('./queue.mjs');
      const queue=await createQueue(database,{workerDatabaseUrl:null});
      await queue.enqueue(job.userId,'telegram-send',{text:answer},{idempotencyKey:`answer:${job.id}`,retrySafe:false,maxAttempts:1});
      return {prepared:true};
    }
    case 'google-sync': {
      if(!b.telegramReceipt&&!/^(invitation-calendar|new-event-calendar|syllabus-sync|enrollment-sync|menu-retry):/.test(job.idempotencyKey||''))return syncGoogle(store,{eventIds:Array.isArray(b.eventIds)?b.eventIds:null});
      const {syncWithTelegramReceipt}=await import('./calendar-receipt.mjs'),{createQueue}=await import('./queue.mjs'),queue=await createQueue(database,{workerDatabaseUrl:null});
      try{return await syncWithTelegramReceipt(store,queue,b,{key:job.id});}finally{await queue.close();}
    }
    case 'slack-sync': {
      const {createQueue}=await import('./queue.mjs');
      const queue=await createQueue(database,{workerDatabaseUrl:null});
      return syncSlack(store,{queueNotification:({id,hash,text})=>queue.enqueue(job.userId,'telegram-send',{text,notification:{channel:'alerts',topic:'school'}},{idempotencyKey:`slack:${id}:${hash}`,retrySafe:false,maxAttempts:1})});
    }
    case 'campus-sync': case 'campus-daily-sync': {
      const {createQueue}=await import('./queue.mjs');
      const queue=await createQueue(database,{workerDatabaseUrl:null});
      try{return job.type==='campus-daily-sync'?await runScheduledCampusSync(store,b,{queue}):await syncCampusWithImports(store,{queue});}finally{await queue.close();}
    }
    case 'partiful-sync': {
      const {createQueue}=await import('./queue.mjs');
      const queue=await createQueue(database,{workerDatabaseUrl:null});
      try{return await syncPartifulCalendar(store,{queue});}finally{await queue.close();}
    }
    case 'luma-sync': {
      const {createQueue}=await import('./queue.mjs');
      const queue=await createQueue(database,{workerDatabaseUrl:null});
      try{return await syncLumaCalendar(store,{queue});}finally{await queue.close();}
    }
    case 'jobs-search': {
      const {createQueue}=await import('./queue.mjs');
      const queue=await createQueue(database,{workerDatabaseUrl:null});
      try{return await fetchJobs(store,b.board,b.provider,{queue});}finally{await queue.close();}
    }
    case 'reminders': return dispatchReminders(store);
    case 'daily-briefing': return dispatchDailyBriefing(store,b);
    case 'daily-email': return dispatchDailyEmail(store,b,{assertAccess:()=>pilotWorkAllowed(database,job.userId)});
    case 'daily-email-preview': return dispatchDailyEmailPreview(store,b,{assertAccess:()=>pilotWorkAllowed(database,job.userId)});
    case 'telegram-daily-preview': {
      const briefing=await buildDailyBriefing(store);
      if(!briefing.notificationTopics?.length){const result=await sendTelegram(store,'No morning briefing topics are selected. Use /notifications to choose school, events, jobs, or news. Games are not available yet.');if(!Number.isSafeInteger(result?.result?.message_id)||result.result.message_id<=0)throw new Error('Telegram acceptance is unconfirmed.');return {accepted:true};}
      const result=await sendTelegram(store,briefing.text,{notification:briefingNotification(briefing,'requested-daily')});
      if(result?.suppressed)return {accepted:false,suppressed:true,reason:result.reason};
      if(!Number.isSafeInteger(result?.result?.message_id)||result.result.message_id<=0)throw new Error('Telegram acceptance is unconfirmed.');
      return {accepted:true};
    }
    case 'telegram-send': return dispatchQueuedTelegram(store,job,{send:sendTelegram});
    case 'telegram-brief': {const summary=await buildScheduleBrief(store,7);await sendTelegram(store,summary.text,{notification:summary.notification});return {accepted:true};}
    default: throw new Error('Unknown job type.');
  }
}
