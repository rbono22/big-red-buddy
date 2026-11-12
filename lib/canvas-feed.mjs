import {TZ,localISO,idFor} from './domain.mjs';
import {HttpError} from './security.mjs';

// Canvas calendar feed connector.
// A student pastes the private feed link from Canvas → Calendar → Calendar Feed.
// The link is a bearer credential: it is stored only in the encrypted secrets
// bucket, fetched only from canvas.cornell.edu, and never echoed back to the page.
export const CANVAS_HOST='canvas.cornell.edu';
export const AI_POLICIES=Object.freeze(['study','allowed','none']);
export const DEFAULT_AI_POLICY='study';
const MAX_BYTES=2*1024*1024,MAX_ITEMS=1500,MAX_DESCRIPTION=4000,SOURCE_ID='canvas-feed';
const DEADLINE_KINDS=new Set(['assignment','quiz','exam']);

export function canvasFeedURL(value){
  const invalid=()=>new HttpError(400,'Paste the Calendar Feed link from Cornell Canvas (Calendar → Calendar Feed). It starts with https://canvas.cornell.edu/feeds/calendars/.');
  if(typeof value!=='string'||value.length>500)throw invalid();
  let url;try{url=new URL(value.trim());}catch{throw invalid();}
  if(url.protocol!=='https:'||url.hostname!==CANVAS_HOST||url.port||url.username||url.password||url.search||url.hash||!/^\/feeds\/calendars\/user_[A-Za-z0-9]{20,80}\.ics$/.test(url.pathname))throw invalid();
  return url.href;
}

const unescapeText=value=>value.replace(/\\n/gi,'\n').replace(/\\([,;\\])/g,'$1');
const collapse=value=>value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
const ymd=raw=>`${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
const nextDate=date=>new Date(Date.parse(`${date}T12:00:00Z`)+86400000).toISOString().slice(0,10);
const local=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function localParts(ms){const parts=Object.fromEntries(local.formatToParts(new Date(ms)).map(part=>[part.type,part.value]));return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};}

// "NBAY6170" → "NBAY 6170"; "INFO6410/CS5682" → "INFO 6410/CS 5682".
export const formatCourseCode=value=>String(value||'').replace(/\b([A-Z]{2,6})(\d{4})\b/g,'$1 $2').replace(/\s+/g,' ').trim().slice(0,60);

function parseWhen(property){
  if(!property)return null;
  const value=property.value;
  if(/^\d{8}$/.test(value)||property.params.VALUE==='DATE')return /^\d{8}$/.test(value)?{allDay:true,date:ymd(value)}:null;
  const match=value.match(/^(\d{8})T(\d{2})(\d{2})(\d{2})(Z?)$/);if(!match)return null;
  const [,day,hour,minute,,utc]=match;
  if(utc){const ms=Date.parse(`${ymd(day)}T${hour}:${minute}:00Z`);return Number.isFinite(ms)?{allDay:false,ms}:null;}
  // Floating or TZID times: accept only New York; anything else is ambiguous.
  if(property.params.TZID&&property.params.TZID!==TZ)return null;
  try{return {allDay:false,ms:Date.parse(localISO(ymd(day),`${hour}:${minute}`))};}catch{return null;}
}

/** Parse a Canvas .ics feed into plain items. Never throws on one bad entry. */
export function parseCanvasFeed(text){
  if(typeof text!=='string'||!/BEGIN:VCALENDAR/.test(text))throw new HttpError(422,'That link did not return a Canvas calendar. Copy the Calendar Feed link again.');
  const unfolded=text.replace(/\r\n?/g,'\n').replace(/\n[ \t]/g,'');
  const blocks=unfolded.split('BEGIN:VEVENT').slice(1,MAX_ITEMS+1).map(block=>block.split('END:VEVENT')[0]);
  const items=[],skipped=[];
  for(const block of blocks){
    const props={};
    for(const line of block.split('\n')){
      const match=line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);if(!match||props[match[1]])continue;
      const params=Object.fromEntries(match[2].split(';').filter(Boolean).map(param=>{const [key,...rest]=param.split('=');return [key.toUpperCase(),rest.join('=')];}));
      props[match[1]]={value:match[3],params};
    }
    const uid=props.UID?.value?.trim(),summary=collapse(unescapeText(props.SUMMARY?.value||''));
    const start=parseWhen(props.DTSTART),end=parseWhen(props.DTEND);
    if(!uid||!summary||!start||props.RRULE){skipped.push(summary||uid||'Untitled entry');continue;}
    const course=summary.match(/\s*\[([^\]]{2,80})\]\s*$/);
    const url=(()=>{try{const link=new URL(props.URL?.value||'');return link.protocol==='https:'&&link.hostname===CANVAS_HOST&&!link.username&&!link.password?link.href:'';}catch{return '';}})();
    items.push({
      uid:uid.slice(0,200),
      type:/^event-assignment/.test(uid)?'assignment':'calendar',
      title:collapse(course?summary.slice(0,course.index):summary).slice(0,200),
      courseCode:course?formatCourseCode(course[1]):'',
      start,end,
      description:collapse(unescapeText(props.DESCRIPTION?.value||'')).slice(0,MAX_DESCRIPTION),
      location:collapse(unescapeText(props.LOCATION?.value||'')).slice(0,300),
      url
    });
  }
  return {items,skipped};
}

function deadlineKind(title){return /\b(?:quiz|quizzes)\b/i.test(title)?'quiz':/\b(?:exam|midterm|final)\b/i.test(title)?'exam':'assignment';}

/** Convert a parsed feed item into a BRB schedule record awaiting review. */
export function canvasEvent(item,{aiPolicy=DEFAULT_AI_POLICY}={}){
  const isDeadline=item.type==='assignment',kind=isDeadline?deadlineKind(item.title):'class';
  const course=item.courseCode,label=course?` · ${course}`:'';
  const base={
    id:`canvas-${idFor('canvas',item.uid)}`,canvasUid:item.uid,connector:'canvas',sourceId:SOURCE_ID,
    title:`${isDeadline?'Due: ':''}${item.title}${label}`.slice(0,240),kind,timezone:TZ,
    courseCode:course||null,courseName:course||null,location:item.location,
    evidence:item.description,sourceName:`Canvas${label}`,sourceUrl:item.url||`https://${CANVAS_HOST}/calendar`,
    aiPolicy:AI_POLICIES.includes(aiPolicy)?aiPolicy:DEFAULT_AI_POLICY
  };
  if(item.start.allDay){
    const date=item.start.date;
    return {...base,allDay:true,date,endDate:nextDate(date),time:null,start:null,end:null,
      warning:isDeadline?'Canvas lists this due date without a time. Check Canvas for the exact deadline.':'All-day Canvas calendar entry.'};
  }
  const {date,time}=localParts(item.start.ms),start=new Date(item.start.ms).toISOString();
  let endMs=item.end&&!item.end.allDay?item.end.ms:null;
  if(!Number.isFinite(endMs)||endMs<=item.start.ms)endMs=item.start.ms+(isDeadline?60000:3600000);
  return {...base,allDay:false,date,time,start,end:new Date(endMs).toISOString(),endDate:null,
    warning:!isDeadline&&!(item.end&&item.end.ms>item.start.ms)?'Canvas gives no end time. A one-hour placeholder is used.':''};
}

const SIGNATURE_KEYS=['title','kind','date','time','allDay','endDate','start','end','location','evidence'];
const signature=event=>JSON.stringify(SIGNATURE_KEYS.map(key=>event[key]??null));

async function readPolicies(store){const row=await store.get('settings','courseAIPolicies');return row&&typeof row.byCourse==='object'?row.byCourse:{};}

/** Fetch the feed and reconcile it with stored Canvas items. */
export async function syncCanvasFeed(store,{fetchImpl=fetch,now=Date.now,queue=null}={}){
  const secret=await store.get('secrets','canvasFeed');
  if(!secret?.url)return {skipped:true,reason:'not-connected'};
  const at=typeof now==='function'?now():now,stamp=new Date(at).toISOString(),previous=await store.get('settings','canvasFeed')||{};
  const fail=async message=>{await store.put('settings','canvasFeed',{...previous,connected:true,lastAttempt:stamp,lastError:message});throw new HttpError(502,message);};
  let text;
  try{
    const response=await fetchImpl(canvasFeedURL(secret.url),{redirect:'error',headers:{Accept:'text/calendar'},signal:AbortSignal.timeout(20000)});
    if(response.status===401||response.status===403||response.status===404)return fail('Canvas no longer accepts this feed link. Copy a fresh Calendar Feed link from Canvas.');
    if(!response.ok)return fail('Canvas did not respond. BRB will try again later.');
    const buffer=Buffer.from(await response.arrayBuffer());
    if(buffer.length>MAX_BYTES)return fail('The Canvas feed is larger than BRB can read safely.');
    text=buffer.toString('utf8');
  }catch(error){if(error instanceof HttpError)throw error;return fail('Could not reach Canvas. BRB will try again later.');}
  const {items,skipped}=parseCanvasFeed(text),policies=await readPolicies(store);
  const existing=new Map((await store.all('events')).filter(event=>event.connector==='canvas').map(event=>[event.id,event]));
  const seen=new Set(),resync=[],today=localParts(at).date,counts={added:0,updated:0,reopened:0,removed:0,unchanged:0};
  for(const item of items){
    const next=canvasEvent(item,{aiPolicy:policies[item.courseCode]});seen.add(next.id);
    const prior=existing.get(next.id);
    if(!prior){await store.put('events',next.id,{...next,status:'review',importedAt:stamp,updatedAt:stamp});counts.added++;continue;}
    // An email-reported move stands until Canvas itself shows a different date.
    const emailHold=prior.emailChange&&next.date===prior.emailChange.from.date&&(next.time||null)===(prior.emailChange.from.time||null)&&!!next.allDay===!!prior.emailChange.from.allDay;
    if(emailHold&&!prior.cancelled){counts.unchanged++;continue;}
    if(prior.emailChange&&!emailHold)delete prior.emailChange;
    if(signature(prior)===signature(next)&&!prior.cancelled){if(prior.aiPolicy!==next.aiPolicy){await store.put('events',next.id,{...prior,aiPolicy:next.aiPolicy});if(prior.status==='approved')resync.push(next.id);}counts.unchanged++;continue;}
    // A changed item never silently rewrites an approved calendar entry.
    const reopen=prior.status==='approved';
    await store.put('events',next.id,{...prior,...next,cancelled:false,status:reopen?'review':prior.status==='dismissed'?'dismissed':'review',updatedAt:stamp,...(reopen?{warning:`Canvas changed this item since you approved it. ${next.warning||''}`.trim()}:{})});
    if(reopen)resync.push(next.id);
    counts[reopen?'reopened':'updated']++;
  }
  // Canvas feeds cover a rolling window, so only upcoming items can count as removed.
  for(const [id,prior] of existing){
    if(seen.has(id)||prior.date<today||prior.cancelled)continue;
    if(prior.status==='approved')await store.put('events',id,{...prior,cancelled:true,warning:'Canvas no longer lists this item. Confirm before it is removed from your calendar.',updatedAt:stamp});
    else await store.delete('events',id);
    counts.removed++;
  }
  const courses=[...new Set(items.map(item=>item.courseCode).filter(Boolean))].sort();
  await store.put('sources',SOURCE_ID,{id:SOURCE_ID,type:'canvas',name:'Canvas calendar feed',method:'Canvas calendar feed · refreshed every few hours',count:items.length,url:`https://${CANVAS_HOST}/calendar`,updatedAt:stamp,...(skipped.length?{warning:`${skipped.length} entr${skipped.length===1?'y':'ies'} could not be read (recurring or missing a date).`}:{})});
  await store.put('settings','canvasFeed',{connected:true,connectedAt:previous.connectedAt||secret.connectedAt||stamp,lastAttempt:stamp,lastSuccess:stamp,lastError:null,courses,counts,total:items.length,skipped:skipped.length});
  const {reconcileReminders}=await import('./integrations.mjs');await reconcileReminders(store);
  let calendarTask=null;
  if(queue&&resync.length&&(await store.get('secrets','google'))?.refresh_token){try{calendarTask={taskId:(await queue.enqueue(store.userId,'google-sync',{eventIds:resync},{retrySafe:false,maxAttempts:1})).id};}catch{}}
  return {...counts,total:items.length,skipped:skipped.length,courses,calendarTask};
}

export async function connectCanvasFeed(store,value,{now=Date.now}={}){
  const url=canvasFeedURL(value),stamp=new Date(typeof now==='function'?now():now).toISOString();
  await store.put('secrets','canvasFeed',{url,connectedAt:stamp});
  const previous=await store.get('settings','canvasFeed')||{};
  await store.put('settings','canvasFeed',{...previous,connected:true,connectedAt:stamp,lastError:null});
  return {connected:true};
}

/** Stop reading Canvas. Imported items stay in the student's schedule. */
export async function disconnectCanvasFeed(store){
  await store.delete('secrets','canvasFeed');
  const previous=await store.get('settings','canvasFeed')||{};
  await store.put('settings','canvasFeed',{...previous,connected:false,disconnectedAt:new Date().toISOString()});
  return {connected:false};
}

/** Public status for the page. Never includes the feed link. */
export async function readCanvasStatus(store){
  const [settings,policies]=await Promise.all([store.get('settings','canvasFeed'),readPolicies(store)]);
  const {connected=false,lastSuccess=null,lastError=null,courses=[],counts=null,total=0,skipped=0}=settings||{};
  return {connected,lastSuccess,lastError,courses,counts,total,skipped,policies:Object.fromEntries(courses.map(code=>[code,AI_POLICIES.includes(policies[code])?policies[code]:DEFAULT_AI_POLICY]))};
}

/** Set a course's AI-help level and apply it to that course's stored items. */
export async function saveCourseAIPolicy(store,{courseCode,policy}={},{queue=null}={}){
  const code=formatCourseCode(courseCode);
  if(!code||!AI_POLICIES.includes(policy))throw new HttpError(400,'Choose a course and an AI help level.');
  const row=await store.get('settings','courseAIPolicies')||{},byCourse={...(row.byCourse||{}),[code]:policy};
  await store.put('settings','courseAIPolicies',{byCourse,updatedAt:new Date().toISOString()});
  const changed=[];
  for(const event of await store.all('events'))if(event.courseCode===code&&DEADLINE_KINDS.has(event.kind)&&event.aiPolicy!==policy){await store.put('events',event.id,{...event,aiPolicy:policy});if(event.status==='approved'&&!event.cancelled)changed.push(event.id);}
  let calendarTask=null;
  if(queue&&changed.length&&(await store.get('secrets','google'))?.refresh_token){try{calendarTask={taskId:(await queue.enqueue(store.userId,'google-sync',{eventIds:changed},{retrySafe:false,maxAttempts:1})).id};}catch{}}
  return {courseCode:code,policy,updated:changed.length,calendarTask};
}
