import {randomBytes} from 'node:crypto';
import {idFor} from './domain.mjs';
import {HttpError} from './security.mjs';
import {createCourseCatalog} from './course-catalog.mjs';
import {importCourseSelection} from './course-import.mjs';
import {analyzeEnrollment} from './enrollment.mjs';
const catalogClient=createCourseCatalog();
const digest=selection=>idFor(JSON.stringify(selection.events.map(e=>[e.id,e.title,e.start,e.end,e.location,e.evidence])));
const terminalStatus=status=>['dropped','cart','waitlisted','wait-listed','wait listed','withdrawn'].includes(String(status).toLowerCase());
export async function prepareEnrollmentProposal(store,input,{catalog=catalogClient,analyzer=analyzeEnrollment,id=randomBytes(16).toString('hex'),now=Date.now}={}){
  const old=await store.get('enrollmentProposals',id); if(old)return old;
  const result=await analyzer(input,catalog);
  if(!Array.isArray(result.candidates)||result.candidates.length>40)throw new HttpError(400,'The enrollment image contains too many matches. Split it into smaller documents.');
  const candidates=[];
  for(const candidate of result.candidates){
    const item={...candidate};
    if(item.importable&&!terminalStatus(item.enrollmentStatus)){
      const selection=await catalog.select({term:result.term,courseId:item.courseId,sectionId:item.sectionId});
      if(selection.blocked){item.importable=false;item.warnings=[...(item.warnings||[]),selection.blockedReason];}
      else item.scheduleDigest=digest(selection);
    }
    candidates.push(item);
  }
  const proposal={...result,id,candidates,status:'review',createdAt:new Date(now()).toISOString(),expiresAt:now()+24*3600000};
  await store.putIfAbsent('enrollmentProposals',id,proposal);
  return await store.get('enrollmentProposals',id);
}
export async function confirmEnrollmentProposal(store,{id,selections},{catalog=catalogClient,queue,now=Date.now}={}){
  if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)||!Array.isArray(selections)||!selections.length||selections.length>20)throw new HttpError(400,'Choose the enrolled classes to confirm (up to 20).');
  const proposal=await store.get('enrollmentProposals',id);
  if(!proposal)throw new HttpError(404,'Enrollment proposal not found.');
  if(proposal.expiresAt<now())throw new HttpError(400,'This review expired. Upload the enrollment image again.');
  const keys=selections.map(s=>`${s?.courseId}:${s?.sectionId}`), unique=new Set(keys);
  if(unique.size!==keys.length)throw new HttpError(400,'Select each class only once.');
  const selectionKey=[...keys].sort().join('|');
  if(proposal.status==='confirmed'){
    if(proposal.selectionKey!==selectionKey)throw new HttpError(409,'This proposal was already confirmed with a different selection. Upload again to add other classes.');
    return proposal.result;
  }
  if(proposal.status!=='review')throw new HttpError(409,'This enrollment confirmation is already being processed.');
  const accepted=selections.map(s=>proposal.candidates.find(c=>c.courseId===s.courseId&&c.sectionId===s.sectionId));
  if(accepted.some(c=>!c||!c.importable||terminalStatus(c.enrollmentStatus)))throw new HttpError(400,'Choose only supported matched classes that you are enrolled in.');
  const expanded=[];let count=0;
  for(const candidate of accepted){
    const selection=await catalog.select({term:proposal.term,courseId:candidate.courseId,sectionId:candidate.sectionId});
    if(selection.blocked||!candidate.scheduleDigest||digest(selection)!==candidate.scheduleDigest)throw new HttpError(409,'The course schedule changed or is incomplete. Upload again and review the updated matches.');
    count+=selection.events.length;if(count>500)throw new HttpError(400,'Select fewer classes per confirmation (maximum 500 meetings).');expanded.push(selection);
  }
  const processing={...proposal,status:'processing',selectionKey};
  if(!await store.compareAndSet('enrollmentProposals',id,proposal,processing))throw new HttpError(409,'This review changed. Refresh and try again.');
  try{
    const result={imported:0,reused:0,skipped:0,warnings:[],calendarTask:null,calendarError:null},eventIds=[];
    for(const selection of expanded){const imported=await importCourseSelection(store,selection);for(const key of ['imported','reused','skipped'])result[key]+=imported[key]||0;result.warnings.push(...imported.warnings);eventIds.push(...imported.eventIds);}
    result.warnings=[...new Set(result.warnings)];
    if((await store.get('secrets','google'))?.refresh_token&&queue){try{const job=await queue.enqueue(store.userId,'google-sync',{eventIds:[...new Set(eventIds)]},{idempotencyKey:`enrollment-sync:${id}`,retrySafe:false,maxAttempts:1});result.calendarTask={taskId:job.id};}catch{result.calendarError='Classes saved; calendar sync could not be queued. Retry sync from Connections.';}}
    await store.put('enrollmentProposals',id,{...processing,status:'confirmed',confirmedAt:new Date(now()).toISOString(),result});return result;
  }catch(error){await store.compareAndSet('enrollmentProposals',id,processing,{...proposal,lastAttemptAt:new Date(now()).toISOString()});throw error;}
}
export function enrollmentReviewMessage(proposal){
  if(!proposal.candidates.length)return `BRB could not match any supported sections for ${proposal.term}. Try a clearer enrollment image or use the course picker in Academics: ${process.env.APP_ORIGIN}/#academics`;
  const lines=[`BRB matched ${proposal.candidates.length} course sections for ${proposal.term}.`,`Check enrollment status: a catalog match does not prove a class is enrolled. Do not select dropped or waitlisted classes.`];
  const snapshot=proposal.candidates.find(c=>c.sourceUpdatedAt)?.sourceUpdatedAt;
  if(snapshot)lines.push(`Catalog snapshot: ${snapshot}. Check the published schedule; changes are not monitored automatically.`);
  proposal.candidates.forEach((c,i)=>lines.push(`${i+1}. ${c.code} · ${c.label}${c.importable?'':' — schedule unavailable'}\n${c.meetingsSummary||''}\n${c.location||'Room not published'}${c.enrollmentStatus==='unknown'?'\nEnrollment status unreadable: check your original.':''}`));
  if(proposal.unmatched?.length)lines.push(`${proposal.unmatched.length} rows were excluded or could not be matched. Review them in Academics.`);
  lines.push(`To add only the enrolled classes you select, reply /confirm ${proposal.id.slice(0,8)} followed by their numbers. Example: /confirm ${proposal.id.slice(0,8)} 1 3`);
  const text=lines.join('\n\n');
  if(text.length>3700)return `BRB matched ${proposal.candidates.length} sections for ${proposal.term}. The list is too long for one message. Open Academics to select your enrolled classes and confirm: ${process.env.APP_ORIGIN}/#academics\nCatalog matches do not verify enrollment. Dropped and waitlisted classes must be excluded.`;
  return text;
}
