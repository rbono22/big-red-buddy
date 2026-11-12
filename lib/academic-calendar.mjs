import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {idFor,localISO,TZ} from './domain.mjs';
import {HttpError} from './security.mjs';
import {reconcileReminders} from './integrations.mjs';
import {eventApprovalVersion} from './event-version.mjs';

export const ACADEMIC_YEAR='2026-2027';
export const ACADEMIC_SOURCE_URL='https://registrar.cornell.edu/calendars-exams/academic-calendar/2026-2027';
export const TECH_ACADEMIC_URL='https://studentaffairs.tech.cornell.edu/academics/academic-calendar/';
export const ACADEMIC_APPLICABILITY='University Registrar dates include other programs and student groups. Cornell Tech follows university class dates, deadlines, and holidays, but publishes program-specific details separately. Check your program and course schedule. These entries never cancel your classes automatically.';
export const ACADEMIC_CATEGORIES=['holidays','breaks','exams','termdates','enrollment','other'];
const LABEL='Cornell University Registrar',MAX_BYTES=2*1024*1024,MAX_ROWS=500,CACHE_MS=5*60000;
const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
const hash=value=>createHash('sha256').update(value).digest('hex');
function plain(value){return String(value||'').replace(/<[^>]*>/g,' ').replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|\d+);/gi,entity=>{const named={'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' '};if(named[entity.toLowerCase()])return named[entity.toLowerCase()];const n=parseInt(entity.slice(2,-1).replace(/^x/i,''),/^&#x/i.test(entity)?16:10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}).replace(/\s+/g,' ').trim();}
function dateValue(year,month,day){const date=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;if(new Date(`${date}T12:00:00Z`).toISOString().slice(0,10)!==date)throw new HttpError(502,'Registrar published an invalid calendar date.');return date;}
const nextDate=date=>new Date(Date.parse(`${date}T12:00:00Z`)+86400000).toISOString().slice(0,10);
const monthNumber=value=>months.findIndex(month=>month.toLowerCase().startsWith(value.toLowerCase()))+1;
function category(title){return /\bbreak\b/i.test(title)?'breaks':/holiday|no classes/i.test(title)?'holidays':/exam|study (?:days|period)/i.test(title)?'exams':/enrollment|add\/drop|add classes|drop class|change credits|grading basis|internal transfer/i.test(title)?'enrollment':/term (?:begins|start|and|ends)|instruction|degree date/i.test(title)?'termdates':'other';}
function clock(value){const match=value.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);if(!match||+match[1]<1||+match[1]>12||+match[2]>59)throw new HttpError(502,'Registrar published an unsupported clock time.');return `${String(+match[1]%12+(/pm/i.test(match[3])?12:0)).padStart(2,'0')}:${match[2]}`;}
const span=(row,name)=>{const m=[...row.matchAll(/<span\b[^>]*class=["']([^"']*)["'][^>]*>([\s\S]*?)<\/span>/gi)].find(item=>item[1].split(/\s+/).includes(name));if(!m)throw new HttpError(502,'Registrar calendar markup changed; previous dates were preserved.');return plain(m[2]);};

/** Parse every source row, rejecting a partially parsed or ambiguous calendar. */
export function parseAcademicCalendar(html,{fetchedAt=new Date().toISOString(),minimumEntries=1}={}){
 if(typeof html!=='string'||Buffer.byteLength(html)>MAX_BYTES||!Number.isFinite(Date.parse(fetchedAt)))throw new HttpError(502,'Registrar calendar response is invalid or too large.');
 const source=html.replace(/<!--[\s\S]*?-->/g,''),tokens=[...source.matchAll(/<h3\b[^>]*>[\s\S]*?<\/h3>|<div\b[^>]*class=["'][^"']*\bcalendar-row-item\b[^"']*["'][^>]*>/gi)];
 let year,month;const events=[],identities=new Map(),headings=new Set();
 for(let i=0;i<tokens.length;i++){
  const token=tokens[i];
  if(/^<h3/i.test(token[0])){const m=plain(token[0]).match(/^([A-Za-z]+)\s+(20\d{2})$/);if(m&&monthNumber(m[1])){month=monthNumber(m[1]);year=+m[2];headings.add(`${year}-${month}`);}else{year=null;month=null;}continue;}
  if(!year||!month)throw new HttpError(502,'Registrar event has no year/month context.');
  const row=source.slice(token.index,tokens[i+1]?.index??source.length),title=span(row,'calendar-date-title'),dateLabel=span(row,'calendar-date'),timeLabel=span(row,'calendar-time');
  if(!title||title.length>500||dateLabel.length>100||timeLabel.length>160)throw new HttpError(502,'Registrar calendar entry exceeds supported bounds.');
  const dates=dateLabel.match(/^([A-Za-z]+)\s+(\d{1,2})(?:\s*[–—-]\s*([A-Za-z]+)\s+(\d{1,2}))?$/);
  if(!dates||monthNumber(dates[1])!==month)throw new HttpError(502,'Registrar date range could not be verified.');
  const date=dateValue(year,month,+dates[2]),endMonth=dates[3]?monthNumber(dates[3]):month;
  if(!endMonth)throw new HttpError(502,'Registrar end month is unknown.');
  const inclusiveEndDate=dateValue(year+(endMonth<month?1:0),endMonth,+(dates[4]||dates[2]));
  if(date<'2026-08-01'||inclusiveEndDate>'2027-08-31'||inclusiveEndDate<date)throw new HttpError(502,'Registrar dates fall outside the selected academic year.');
  let allDay=/^All Day$/i.test(timeLabel),start=null,end=null,time=null,timeKind='all-day',durationIsDisplayOnly=false;
  if(!allDay){
   const point=timeLabel.match(/^(DEADLINE|Begins at)\s+(\d{1,2}:\d{2}\s*[AP]M)$/i);
   const range=timeLabel.match(/^(?:([A-Za-z]+)\s+(\d{1,2})\s+)?(\d{1,2}:\d{2}\s*[AP]M)\s*[–—-]\s*(?:([A-Za-z]+)\s+(\d{1,2})\s+)?(\d{1,2}:\d{2}\s*[AP]M)$/i);
   if(point){time=clock(point[2]);start=localISO(date,time);end=new Date(Date.parse(start)+60000).toISOString();timeKind=/deadline/i.test(point[1])?'deadline':'opens';durationIsDisplayOnly=true;}
   else if(range){if(range[1]&&(monthNumber(range[1])!==month||+range[2]!==+dates[2])||range[4]&&(monthNumber(range[4])!==endMonth||+range[5]!==+(dates[4]||dates[2])))throw new HttpError(502,'Registrar date and time labels disagree.');const first=clock(range[3]),last=clock(range[6]);if(first==='00:00'&&last==='23:59'){allDay=true;}else{time=first;start=localISO(date,first);end=localISO(inclusiveEndDate,last);timeKind='range';if(end<=start)throw new HttpError(502,'Registrar event end precedes its start.');}}
   else throw new HttpError(502,'Registrar time format changed; previous dates were preserved.');
  }
  const identity=title.toLowerCase().replace(/\s+/g,' ').trim(),id=idFor('registrar-academic',ACADEMIC_YEAR,identity);
  const warnings=[ACADEMIC_APPLICABILITY,...(durationIsDisplayOnly?['A one-minute calendar marker represents the published opening or deadline time; it is not an activity duration.']:[])];
  const event={id,title,category:category(title),academicYear:ACADEMIC_YEAR,date,inclusiveEndDate,endDate:nextDate(inclusiveEndDate),allDay,start,end,time,timeKind,durationIsDisplayOnly,timeLabel,dateLabel,timezone:TZ,location:'',noClasses:/no\s+classes/i.test(title),status:'available',sourceLabel:LABEL,sourceUrl:ACADEMIC_SOURCE_URL,sourceUpdatedAt:null,fetchedAt,evidence:`${title}\nPublished date: ${dateLabel} (${year}).\nPublished time: ${timeLabel}.\nSource: ${ACADEMIC_SOURCE_URL}`,warnings};
  if(identities.has(id)){if(JSON.stringify(identities.get(id))!==JSON.stringify(event))throw new HttpError(502,'Registrar has conflicting entries with the same title.');continue;}
  identities.set(id,event);events.push(event);
 }
 const sourceRows=(source.match(/<span\b[^>]*class=["'][^"']*\bcalendar-date-title\b[^"']*["']/gi)||[]).length;
 if(events.length<minimumEntries||events.length>MAX_ROWS||identities.size!==sourceRows)throw new HttpError(502,'Registrar calendar was incomplete or could not be parsed fully.');
 if(minimumEntries>1&&(!headings.has('2026-8')||!headings.has('2027-8')||!/<\/html\s*>/i.test(source)))throw new HttpError(502,'Registrar calendar response is incomplete.');
 events.sort((a,b)=>a.date.localeCompare(b.date)||String(a.start||'').localeCompare(String(b.start||''))||a.id.localeCompare(b.id));
 const contentHash=hash(JSON.stringify(events.map(({fetchedAt,...event})=>event)));
 return {version:1,academicYear:ACADEMIC_YEAR,sourceUrl:ACADEMIC_SOURCE_URL,sourceLabel:LABEL,techCalendarUrl:TECH_ACADEMIC_URL,fetchedAt,sourceHash:hash(html),contentHash,count:events.length,events};
}

function requireStore(store){if(!store?.userId||!store.compareAndSet||!store.putIfAbsent)throw new Error('A student-owned CAS store is required.');}
async function locked(store,operation){requireStore(store);const key='academicCalendarLock',lock={owner:randomUUID(),expiresAt:Date.now()+300000},old=await store.putIfAbsent('settings',key,lock);if(old.owner!==lock.owner&&(old.expiresAt>Date.now()||!await store.compareAndSet('settings',key,old,lock)))throw new HttpError(409,'Academic calendar work is already running. Retry shortly.');try{return await operation();}finally{await store.compareAndSet('settings',key,lock,{...lock,expiresAt:0});}}
const material=event=>JSON.stringify([event.title,event.date,event.endDate,event.allDay,event.start,event.end,event.timeLabel,event.status]);
async function storedCalendar(store,settings){return {events:(await store.all('academicEvents')).filter(e=>e.academicYear===ACADEMIC_YEAR).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id)),settings};}
function eventFields(candidate){return {title:candidate.title,kind:'event',date:candidate.date,endDate:candidate.endDate,inclusiveEndDate:candidate.inclusiveEndDate,allDay:candidate.allDay,start:candidate.start,end:candidate.end,time:candidate.time,timeLabel:candidate.timeLabel,timeKind:candidate.timeKind,durationIsDisplayOnly:candidate.durationIsDisplayOnly,timezone:TZ,location:'',academicCategory:candidate.category,academicYear:ACADEMIC_YEAR,academicCandidateId:candidate.id,academicSourceVersion:material(candidate),sourceId:idFor('academic-registrar',ACADEMIC_YEAR),sourceName:LABEL,sourceUrl:ACADEMIC_SOURCE_URL,evidence:candidate.evidence,evidenceVerified:true,warning:candidate.warnings.join(' ')};}
async function reconcileSavedCopy(store,candidate,now){
 const eventId=candidate.addedEventId||idFor('academic-added',candidate.id),event=await store.get('events',eventId);
 if(event?.academicCandidateId!==candidate.id)return null;
 const version=material(candidate),savedVersion=event.academicSourceVersion||material({...event,status:event.cancelled?'cancelled':'available'});
 if(savedVersion!==version){const cancelled=candidate.status==='cancelled';await store.put('events',event.id,{...event,...(!cancelled?eventFields(candidate):{academicSourceVersion:version}),status:'review',cancelled,reviewedAt:null,previousSource:{title:event.title,date:event.date,endDate:event.endDate,start:event.start,end:event.end},warning:cancelled?'This entry is no longer published in the complete Registrar calendar. Review before removing a Google Calendar copy.':'The Registrar entry changed. Review before changing your saved calendar.',updatedAt:new Date(now()).toISOString()});}
 return {addedEventId:event.id,addedAt:candidate.addedAt||event.reviewedAt||event.updatedAt};
}
async function reconcile(store,snapshot,{now=Date.now}={}){return locked(store,async()=>{
 const oldSettings=await store.get('settings','academicCalendar');
 // Web and worker processes have independent public caches. A cached snapshot
 // may never roll back a newer persisted source or clear a later failure notice.
 if(oldSettings&&Date.parse(oldSettings.lastSuccess)>=Date.parse(snapshot.fetchedAt))return storedCalendar(store,oldSettings);
 if(oldSettings?.contentHash!==snapshot.contentHash){
  const previous=await store.all('academicEvents'),currentIds=new Set(snapshot.events.map(e=>e.id));
  for(const candidate of snapshot.events){const old=await store.get('academicEvents',candidate.id),next={...candidate,...(old?.addedEventId?{addedEventId:old.addedEventId,addedAt:old.addedAt}:{})};const linked=await reconcileSavedCopy(store,next,now);await store.put('academicEvents',candidate.id,{...next,...linked});}
  // Already-cancelled candidate rows are included: a prior process may have
  // stopped between source persistence and updating its saved schedule copy.
  for(const old of previous.filter(e=>e.academicYear===ACADEMIC_YEAR&&!currentIds.has(e.id))){const next={...old,status:'cancelled',fetchedAt:snapshot.fetchedAt},linked=await reconcileSavedCopy(store,next,now);await store.put('academicEvents',old.id,{...next,...linked});}
  await reconcileReminders(store,{now});
 }
 const settings={academicYear:ACADEMIC_YEAR,sourceUrl:ACADEMIC_SOURCE_URL,sourceLabel:LABEL,techCalendarUrl:TECH_ACADEMIC_URL,lastSuccess:snapshot.fetchedAt,lastCheckedAt:new Date(now()).toISOString(),contentHash:snapshot.contentHash,sourceHash:snapshot.sourceHash,count:snapshot.events.length,warning:ACADEMIC_APPLICABILITY,lastError:null};await store.put('settings','academicCalendar',settings);
 return storedCalendar(store,settings);
});}

async function boundedHTML(response){if(!response.ok)throw new HttpError(502,'The Registrar calendar is unavailable. Your saved dates were preserved.');if(Number(response.headers?.get('content-length'))>MAX_BYTES)throw new HttpError(502,'Registrar response exceeds the size limit.');const reader=response.body?.getReader();if(!reader){const text=await response.text();if(Buffer.byteLength(text)>MAX_BYTES)throw new HttpError(502,'Registrar response exceeds the size limit.');return text;}const chunks=[];let bytes=0;try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES)throw new HttpError(502,'Registrar response exceeds the size limit.');chunks.push(Buffer.from(value));}return Buffer.concat(chunks).toString('utf8');}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}

export function createAcademicCalendar({fetchImpl=globalThis.fetch,now=Date.now,snapshot:providedSnapshot}={}){
 let cache=providedSnapshot||null,inflight=null,lastFetch=0;
 async function snapshot(){if(!cache)cache=JSON.parse(await readFile(new URL('../resources/academic-calendar-2026-2027.json',import.meta.url),'utf8'));return cache;}
 async function refresh(){if(cache&&now()-lastFetch<CACHE_MS)return cache;if(inflight)return inflight;inflight=(async()=>{const response=await fetchImpl(ACADEMIC_SOURCE_URL,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'text/html'}});const parsed=parseAcademicCalendar(await boundedHTML(response),{fetchedAt:new Date(now()).toISOString(),minimumEntries:50});cache=parsed;lastFetch=now();return parsed;})();try{return await inflight;}finally{inflight=null;}}
 return {
  async listAcademicCalendar(store){requireStore(store);const settings=await store.get('settings','academicCalendar');return settings?storedCalendar(store,settings):reconcile(store,await snapshot(),{now});},
  async refreshAcademicCalendar(store){requireStore(store);try{return await reconcile(store,await refresh(),{now});}catch(error){const previous=await store.get('settings','academicCalendar');if(previous)await store.compareAndSet('settings','academicCalendar',previous,{...previous,lastError:'Registrar refresh failed; previously saved dates remain.',lastAttemptAt:new Date(now()).toISOString()});if(error instanceof HttpError)throw error;throw new HttpError(502,'Registrar refresh failed; previously saved dates remain.');}}
 };
}
const service=createAcademicCalendar();
export const listAcademicCalendar=store=>service.listAcademicCalendar(store);
export const refreshAcademicCalendar=store=>service.refreshAcademicCalendar(store);
export async function addAcademicCalendarEvents(store,{ids}={},queue,{now=Date.now,expectedVersion}={}){return locked(store,async()=>{
 if(!Array.isArray(ids)||!ids.length||ids.length>MAX_ROWS||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)))throw new HttpError(400,'Choose 1 to 500 distinct academic calendar entries.');
 if(expectedVersion!==undefined&&(ids.length!==1||typeof expectedVersion!=='string'||!/^[a-f0-9]{64}$/.test(expectedVersion)))throw new HttpError(400,'A reviewed source version requires one academic calendar entry.');
 const candidates=await Promise.all(ids.map(id=>store.get('academicEvents',id)));if(candidates.some(e=>!e||e.academicYear!==ACADEMIC_YEAR||e.status!=='available'))throw new HttpError(404,'An academic date is unavailable in your workspace. Refresh the Registrar calendar.');
 if(expectedVersion!==undefined&&eventApprovalVersion(candidates[0])!==expectedVersion)throw new HttpError(409,'The academic entry changed. Review its latest details before adding.');
 const eventIds=[],at=new Date(now()).toISOString();let imported=0,reused=0;
 for(const candidate of candidates){const id=idFor('academic-added',candidate.id),old=await store.get('events',id);await store.put('events',id,{...old,id,...eventFields(candidate),status:'approved',cancelled:false,reviewedAt:at,updatedAt:at,approvalMethod:'Student selected this published Registrar entry for calendar import'});await store.put('academicEvents',candidate.id,{...candidate,addedEventId:id,addedAt:at});eventIds.push(id);old?reused++:imported++;}
 await reconcileReminders(store,{now});let calendarTask=null,calendarError=null;
 if(queue&&(await store.get('secrets','google'))?.refresh_token){try{const task=await queue.enqueue(store.userId,'google-sync',{eventIds},{retrySafe:false,maxAttempts:1});calendarTask={taskId:task.id};}catch{calendarError='Academic dates were saved; Google Calendar sync could not be queued. Retry from Connections.';}}
 return {imported,reused,eventIds,calendarTask,calendarError,warnings:[ACADEMIC_APPLICABILITY]};
});}
