import {HttpError} from './security.mjs';
import {idFor,normalizeEvent} from './domain.mjs';
import {readLocalDocumentText} from './enrollment.mjs';
import {extractEvents,persistCandidates} from './ingest.mjs';
import {enrollmentAttachment} from './telegram-files.mjs';
import {reconcileReminders} from './integrations.mjs';

const PAGE_SIZE=6, TTL=15*60000, terms={FA26:'Fall 2026',SP27:'Spring 2027'};
const fail=message=>{throw new HttpError(400,message);};
const revision=e=>idFor(JSON.stringify([e.title,e.kind,e.date,e.start,e.end,e.location,e.evidence,e.evidenceVerified,e.warning,e.cancelled]));
const website=()=>`${process.env.APP_ORIGIN}/#academics`;

export async function prepareSyllabusProposal(store,input,{read=readLocalDocumentText,extract=extractEvents,now=Date.now}={}){
 if(!terms[input.term])fail('Choose /syllabus FA26 or /syllabus SP27.');
 const id=idFor('telegram-syllabus',input.buffer.toString('base64'),input.term),previous=await store.get('syllabusProposals',id);
 if(previous&&previous.expiresAt>now())return previous;
 const document=await read(input);
 if(document.text.length>55000)fail('This syllabus is too long for one extraction. Send fewer pages.');
 const result=await extract(document.text,'syllabus',undefined,{deadlinesOnly:true,academicTerm:terms[input.term]});
 const candidates=(result.events||[]).filter(e=>['assignment','quiz','exam','studio'].includes(e.kind)).slice(0,150);
 if(!candidates.length)fail('No dated assignments, quizzes, or exams were found. Send the pages containing deadlines; use /enrollment for class schedules.');
 const source={id,name:input.name||'Telegram syllabus',type:'syllabus',hash:id,method:`${document.method}; ${result.method}`};
 await persistCandidates(store,source,candidates);
 if(result.metrics)await store.put('metrics',idFor('syllabus-metrics',id),{...result.metrics,task:'Telegram syllabus extraction',at:new Date(now()).toISOString()});
 const items=[];
 for(const c of candidates){const event=await store.get('events',idFor(id,c.kind,c.title,c.date));if(!items.some(i=>i.id===event.id))items.push({id:event.id,revision:revision(event)});}
 const proposal={id,term:input.term,items,status:'review',createdAt:now(),expiresAt:now()+24*3600000};
 await store.put('syllabusProposals',id,proposal);
 return proposal;
}
export async function syllabusReviewMessage(store,proposal,page=1){
 const pages=Math.ceil(proposal.items.length/PAGE_SIZE);
 if(!Number.isInteger(page)||page<1||page>pages)fail(`Choose a review page from 1 to ${pages}.`);
 const code=proposal.id.slice(0,8),lines=[`Syllabus deadlines · ${terms[proposal.term]} · New York time`,`Page ${page}/${pages}. Check each date against your syllabus. Nothing is added to Google until you confirm.`];
 for(let index=(page-1)*PAGE_SIZE;index<Math.min(page*PAGE_SIZE,proposal.items.length);index++){
  const e=await store.get('events',proposal.items[index].id);
  if(!e){lines.push(`${index+1}. Removed; upload again.`);continue;}
  lines.push(`${index+1}. ${e.title.slice(0,130)}\n${e.date} ${e.time||'TIME NEEDED'}${e.kind==='exam'&&e.end?' · exam end '+new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit'}).format(new Date(e.end)):''}\n${(e.location||'Location not specified').slice(0,80)}\nSource: ${e.evidence.replace(/\s+/g,' ').slice(0,100)}${e.evidenceVerified===false?'\nEvidence needs review in Academics.':''}${e.warning?'\n'+e.warning.slice(0,120):''}`);
 }
 if(page<pages)lines.push(`Next page: /syllabus_review ${code} ${page+1}`);
 lines.push(`Confirm selected numbers: /syllabus_confirm ${code} 1 2\nSet/correct a time: /syllabus_time ${code} 1 17:00\nFor an exam include its end: /syllabus_time ${code} 1 09:00 11:00\nFull source review and date corrections: ${website()}`);
 return lines.join('\n\n');
}
async function proposalByCode(store,code){
 if(!/^[a-f0-9]{8}$/.test(code||''))fail('Use the eight-character review code shown by the bot.');
 const matches=(await store.all('syllabusProposals')).filter(p=>p.id.startsWith(code)&&p.expiresAt>Date.now());
 if(matches.length!==1)fail('That syllabus review expired or was not found in your account. Upload again.');
 return matches[0];
}
export async function confirmSyllabus(store,proposal,numbers,queue){
 if(!numbers.length||numbers.length>150||new Set(numbers).size!==numbers.length||numbers.some(n=>!Number.isInteger(n)||n<1||n>proposal.items.length))fail('Choose valid, distinct numbers from your syllabus review.');
 const key=[...numbers].sort((a,b)=>a-b).join(',');
 if(proposal.status==='confirmed'){
  if(proposal.selectionKey!==key)fail('This upload was already confirmed. Review remaining items in Academics.');
  return proposal.result;
 }
 if(proposal.status!=='review')fail('This review is already processing. Check Academics before retrying.');
 const events=[];
 for(const n of numbers){const item=proposal.items[n-1],e=await store.get('events',item.id);
  if(!e||revision(e)!==item.revision)fail('A date changed after this review. Check Academics or upload again before confirming.');
  if(!e.start||!e.end||e.evidenceVerified!==true||e.cancelled)fail(`Item ${n} needs a time or source review. Use /syllabus_time for missing times, or review the source in Academics.`);
  events.push(e);
 }
 const processing={...proposal,status:'processing',selectionKey:key};
 if(!await store.compareAndSet('syllabusProposals',proposal.id,proposal,processing))fail('This review changed. Ask for the review again.');
 try{
  for(const e of events){if(!await store.compareAndSet('events',e.id,e,{...e,status:'approved',reviewedAt:new Date().toISOString()}))fail('A date changed during confirmation. Check Academics.');}
  await reconcileReminders(store);
  let calendarQueued=false;
  if((await store.get('secrets','google'))?.refresh_token){await queue.enqueue(store.userId,'google-sync',{eventIds:events.map(e=>e.id)},{idempotencyKey:`syllabus-sync:${proposal.id}:${key}`,retrySafe:false,maxAttempts:1});calendarQueued=true;}
  const result={count:events.length,calendarQueued};
  await store.put('syllabusProposals',proposal.id,{...processing,status:'confirmed',result});return result;
 }catch(error){await store.compareAndSet('syllabusProposals',proposal.id,processing,proposal);throw error;}
}

export async function handleSyllabusMessage(store,queue,msg,updateId){
 if(msg?.chat?.type!=='private'||String((await store.get('secrets','telegram'))?.chatId)!==String(msg.chat.id))return false;
 const text=String(msg.text||msg.caption||'').trim(),match=text.match(/^(\/\w+)(?:@([a-zA-Z0-9_]+))?(?:\s+(.*))?$/);
 if(match?.[2]&&match[2].toLowerCase()!==(process.env.TELEGRAM_BOT_USERNAME||'dabas_class_bot').toLowerCase())return false;
 const cmd=match?.[1]?.toLowerCase(),args=(match?.[3]||'').trim().split(/\s+/),hasFile=Boolean(msg.photo||msg.document);
 const reply=async text=>{await queue.enqueue(store.userId,'telegram-send',{text},{idempotencyKey:`syllabus-reply:${updateId}`,retrySafe:false,maxAttempts:1});return true;};
 // Explicit workflow changes prevent a pending resume/syllabus window from
 // silently classifying the next file under the wrong purpose.
 if(['/enrollment','/resume_upload'].includes(cmd)) {await store.delete('settings','syllabusUpload');if(cmd==='/enrollment')await store.delete('settings','careerUpload');return false;}
 let mode=await store.get('settings','syllabusUpload');
 if(cmd==='/syllabus'){
  if(args.length!==1||!terms[args[0]?.toUpperCase()])return reply('Send /syllabus FA26 for Fall 2026 or /syllabus SP27 for Spring 2027, then a clear photo or PDF of the pages containing assignments and due dates.');
  mode={term:args[0].toUpperCase(),expiresAt:Date.now()+TTL};await store.put('settings','syllabusUpload',mode);await store.delete('settings','careerUpload');
  if(!hasFile)return reply('Send your syllabus PDF or a clear JPEG/PNG photo within 15 minutes. Include the dates and deadline rules. Send one file at a time; more pages can follow. I will show assignments, quizzes, and exams for confirmation before adding them to Google Calendar. Telegram also processes the files you send.');
 }
 if(cmd==='/syllabus_review')return reply(await syllabusReviewMessage(store,await proposalByCode(store,args[0]),Number(args[1]||1)));
 if(cmd==='/syllabus_confirm'){
  const p=await proposalByCode(store,args[0]);const result=await confirmSyllabus(store,p,args.slice(1).map(Number),queue);
  return reply(`${result.count} deadline(s) approved. ${result.calendarQueued?'Google Calendar sync queued.':'Connect Google Calendar in BRB, then sync reviewed items.'} Reminders use your saved timing and notification preferences. Remaining items can be reviewed in Academics.`);
 }
 if(cmd==='/syllabus_time'){
  const p=await proposalByCode(store,args[0]),n=Number(args[1]),time=args[2],endTime=args[3];
  if(p.status!=='review'||!Number.isInteger(n)||!p.items[n-1]||args.length<3||args.length>4||!/^\d{2}:\d{2}$/.test(time||'')||(endTime&&!/^\d{2}:\d{2}$/.test(endTime)))fail('Use /syllabus_time CODE NUMBER HH:MM, optionally followed by an end time. Times are New York time.');
  const e=await store.get('events',p.items[n-1].id);if(!e||revision(e)!==p.items[n-1].revision||e.evidenceVerified!==true||e.status!=='review')fail('This source needs review in Academics before changing its time.');
  if(e.kind==='exam'&&!endTime)fail('Include the exam end time: /syllabus_time CODE NUMBER 09:00 11:00');
  let changed;try{changed=normalizeEvent({...e,time,endTime:endTime||null,status:'review',warning:'Time supplied by the student in Telegram; check it before confirming.'});}catch{fail('Use a valid New York time and an end later than the start.');}
  if(!await store.compareAndSet('events',e.id,e,changed))fail('The date changed. Review it in Academics.');
  const items=p.items.map((item,i)=>i===n-1?{...item,revision:revision(changed)}:item);
  if(!await store.compareAndSet('syllabusProposals',p.id,p,{...p,items}))fail('The review changed. Check the updated time in Academics.');
  return reply(await syllabusReviewMessage(store,{...p,items},Math.floor((n-1)/PAGE_SIZE)+1));
 }
 if(!hasFile||!mode)return false;
 if(mode.expiresAt<=Date.now()&&mode.uploadUpdateId!==updateId)return reply('Your syllabus upload window expired. Send /syllabus FA26 or /syllabus SP27 before the next file.');
 const file=enrollmentAttachment(msg);if(!file)return false;
 if(msg.photo)file.name='Telegram syllabus photo.jpg';
 await queue.enqueue(store.userId,'telegram-syllabus',{...file,term:mode.term},{idempotencyKey:`syllabus-upload:${updateId}`,retrySafe:false,maxAttempts:1});
 await store.put('settings','syllabusUpload',{...mode,uploadUpdateId:updateId});
 return reply(`Reading your syllabus for ${terms[mode.term]}. I will send a numbered deadline review. Keep any other pages in syllabus mode; use /enrollment ${mode.term} to switch to class schedules.`);
}
