import {idFor, localISO, normalizeEvent, TZ} from './domain.mjs';
import {HttpError} from './security.mjs';

const REGISTRAR='https://registrar.cornell.edu/calendars-exams/academic-calendar/2026-2027';
const TECH_CALENDAR='https://studentaffairs.tech.cornell.edu/academics/academic-calendar/';
const TECH_GUIDE='https://studentaffairs.tech.cornell.edu/academics/enrollment-guide/';
export const CATALOG_URLS=Object.freeze({FA26:'https://www.cornelltech.tech/catalogue.json',SP27:'https://www.cornelltech.tech/catalogues/SP27.json'});
// Verified against Cornell Tech's calendar and its documented adoption of University
// instruction dates and holidays on 2026-11-10. Exam periods are deliberately absent.
export const TERM_POLICIES=Object.freeze({
  FA26:Object.freeze({label:'Fall 2026',start:'2026-08-24',end:'2026-12-07',sessions:{'1':['2026-08-24','2026-12-07'],PR1:['2026-08-24','2026-12-07'],'7W1':['2026-08-24','2026-10-09'],'7W2':['2026-10-14','2026-12-04']},breaks:[{start:'2026-09-07',end:'2026-09-07',label:'Labor Day'},{start:'2026-10-10',end:'2026-10-13',label:'Fall Break'},{start:'2026-11-25',end:'2026-11-29',label:'Thanksgiving Break'}]}),
  SP27:Object.freeze({label:'Spring 2027',start:'2027-01-25',end:'2027-05-11',sessions:{'1':['2027-01-25','2027-05-11'],PR1:['2027-01-25','2027-05-11'],'7W1':['2027-01-25','2027-03-16'],'7W2':['2027-03-17','2027-05-11']},breaks:[{start:'2027-02-13',end:'2027-02-16',label:'February Break'},{start:'2027-03-27',end:'2027-04-04',label:'Spring Break'}]})
});
const DAYS=Object.freeze({Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6});
const PATTERN_DAYS=Object.freeze({U:'Sun',M:'Mon',T:'Tue',W:'Wed',R:'Thu',F:'Fri',S:'Sat'});
const MAX_BYTES=5*1024*1024,MAX_COURSES=1000,MAX_SECTIONS=100,MAX_MEETINGS=100,MAX_EVENTS=500;
const text=(value,max=300)=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
const unique=values=>[...new Set(values.filter(Boolean))];
const clock=minute=>`${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}`;
const searchText=value=>String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const termCode=value=>{if(typeof value!=='string'||!Object.hasOwn(CATALOG_URLS,value))throw new HttpError(400,'Only FA26 and SP27 catalogs are supported.');return value;};
function isoDate(value) {
  if(typeof value!=='string')throw new Error('Meeting date is missing.');
  const match=value.match(/^(\d{4})-(\d{2})-(\d{2})$/)||value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)?.map((part,index,array)=>index===0?part:index===1?array[3]:index===2?array[1]:array[2]);
  if(!match)throw new Error('Meeting date format is unsupported.');
  const [,year,month,day]=match,stamp=`${year}-${month}-${day}`,date=new Date(Date.UTC(+year,+month-1,+day));
  if(date.toISOString().slice(0,10)!==stamp)throw new Error('Meeting date is invalid.');return stamp;
}
function timestamp(value){const parsed=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(parsed)?new Date(parsed).toISOString():null;}
function dateRange(start,end){const values=[];for(let time=Date.parse(`${start}T12:00:00Z`),last=Date.parse(`${end}T12:00:00Z`);time<=last;time+=86400000){if(values.length>150)throw new Error('Meeting range exceeds one supported term.');values.push(new Date(time).toISOString().slice(0,10));}return values;}
const holiday=(policy,date)=>policy.breaks.find(item=>date>=item.start&&date<=item.end);
const missingRoom=value=>!value||/\b(?:tba|tbd|to be (?:announced|determined)|room (?:not|to be)|not (?:published|specified))\b/i.test(value);
const isScheduled=value=>value==null||value===''||value==='scheduled'||value==='published';
const localParts=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function strictLocalISO(date,time){
  const result=localISO(date,time),stamp=Date.parse(result);
  // localISO rejects gaps; also reject the repeated hour rather than selecting a fold.
  for(const other of [stamp-3600000,stamp+3600000]){const parts=Object.fromEntries(localParts.formatToParts(new Date(other)).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));if(`${parts.year}-${parts.month}-${parts.day}`===date&&`${parts.hour}:${parts.minute}`===time)throw new Error('Ambiguous daylight-saving time requires manual confirmation.');}
  return result;
}
function normalizeMeeting(raw,policy,sessionBounds) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Meeting evidence is malformed.');
  if(!isScheduled(raw.scheduleStatus)||raw.tentative===true)throw new Error('Tentative, arranged, or unpublished meeting times need manual review.');
  if(!Object.hasOwn(DAYS,raw.day))throw new Error('Meeting weekday is missing or unsupported.');
  if(!Number.isInteger(raw.start)||!Number.isInteger(raw.end)||raw.start<0||raw.end>1439||raw.end<=raw.start)throw new Error('Meeting times are missing, overnight, or invalid.');
  const startDate=isoDate(raw.startDate),endDate=isoDate(raw.endDate);
  if(startDate>endDate)throw new Error('Meeting end date precedes its start.');
  if(startDate<policy.start||endDate>policy.end||startDate<sessionBounds[0]||endDate>sessionBounds[1])throw new Error('Meeting dates fall outside verified instruction/session boundaries; special-calendar exclusions need manual review.');
  const pattern=text(raw.pattern,20).replace(/Su/g,'U');
  if(pattern&&(!/^[MTWRFSU]+$/.test(pattern)||![...pattern].some(letter=>PATTERN_DAYS[letter]===raw.day)))throw new Error('Meeting weekday conflicts with its published pattern.');
  if(raw.exceptions!=null&&(!Array.isArray(raw.exceptions)||raw.exceptions.length))throw new Error('Meeting exceptions have an unsupported format.');
  if(raw.excludedDates!=null&&(!Array.isArray(raw.excludedDates)||raw.excludedDates.length>100))throw new Error('Meeting exclusion dates are invalid.');
  const excludedDates=(raw.excludedDates||[]).map(isoDate);
  if(excludedDates.some(date=>date<startDate||date>endDate))throw new Error('A meeting exclusion falls outside its source date range.');
  const dates=dateRange(startDate,endDate).filter(date=>new Date(`${date}T12:00:00Z`).getUTCDay()===DAYS[raw.day]);
  if(!dates.length)throw new Error('No dates match the published meeting weekday.');
  if(startDate===endDate&&holiday(policy,startDate))throw new Error('An explicitly dated meeting conflicts with a published no-class day; resolve the source conflict first.');
  const rawRoom=text(raw.room,300),location=missingRoom(rawRoom)?'':rawRoom;
  return {day:raw.day,start:raw.start,end:raw.end,startDate,endDate,pattern,topic:text(raw.topic,200),location,rawRoom,excludedDates,sourceMeetingId:text(raw.sourceMeetingId,160)};
}
function normalizeSection(raw,course,term) {
  if(!raw||typeof raw!=='object'||!Array.isArray(raw.meetings)||raw.meetings.length>MAX_MEETINGS)throw new Error('Catalog section structure is unsupported.');
  const id=text(raw.id,120);if(!/^[A-Za-z0-9:_-]{1,120}$/.test(id))throw new Error('Catalog section identifier is invalid.');
  const warnings=[],reasons=[],policy=TERM_POLICIES[term],sessionCode=text(raw.sessionCode,20),bounds=policy.sessions[sessionCode];
  if(raw.location!=='NYCTECH')reasons.push('This section is outside Cornell Tech; its campus-specific break policy has not been verified.');
  if(!bounds)reasons.push('This session type has no verified instruction and break policy.');
  if(!isScheduled(raw.scheduleStatus)||raw.tentative===true||/asynchronous|independent studies/i.test(text(raw.instructionMode)))reasons.push('An unpublished, asynchronous, or independent schedule cannot be expanded automatically.');
  if(!raw.meetings.length)reasons.push('No complete meeting schedule is published for this section.');
  const sourceMeetings=raw.sourceMeetings;
  if(sourceMeetings!=null){
    if(!Array.isArray(sourceMeetings)||sourceMeetings.length>MAX_MEETINGS)reasons.push('Original meeting evidence is malformed.');
    else for(const original of sourceMeetings){
      if(!original||original.scheduleStatus!=='scheduled')reasons.push('Part of this section has unpublished meeting details; importing a partial schedule is blocked.');
      else if(!Array.isArray(original.days)||!original.days.length||original.days.some(day=>!raw.meetings.some(meeting=>meeting.sourceMeetingId===original.id&&meeting.day===day&&meeting.start===original.start&&meeting.end===original.end&&meeting.startDate===original.startDate&&meeting.endDate===original.endDate)))reasons.push('Expanded meetings do not fully match their original source evidence.');
    }
  }
  const meetings=[];
  if(bounds)for(const meeting of raw.meetings){try{meetings.push(normalizeMeeting(meeting,policy,bounds));}catch(error){reasons.push(error.message);}}
  if(meetings.some(meeting=>!meeting.location))warnings.push('One or more rooms are not published. Calendar locations will remain blank; verify before attending.');
  if(raw.restrictionText||raw.notes)warnings.push('Enrollment restrictions may apply. Calendar import does not enroll you or confirm eligibility.');
  if(course.sections.length>1)warnings.push('Only the section you select is imported. Check whether your registration includes other required components.');
  const roomList=unique(meetings.map(meeting=>meeting.location));
  const component=text(raw.component,20),section=text(raw.section,30),classNumber=text(raw.classNumber,30);
  const summary=unique(meetings.map(meeting=>`${meeting.day} ${clock(meeting.start)}–${clock(meeting.end)} · ${meeting.startDate} to ${meeting.endDate}`));
  const blockedReason=unique(reasons).join(' ');
  return {id,label:`${text(raw.componentName,60)||component||'Section'} ${section}${classNumber?` · class ${classNumber}`:''}`,component,section,classNumber,sessionCode,session:text(raw.session,100),instructionMode:text(raw.instructionMode,100),campus:text(raw.locationDescription,150),location:roomList.join(' / '),meetingsSummary:summary.length?`${summary.join('; ')} · America/New_York`:'Meeting schedule not published',warnings:unique(warnings),importable:!blockedReason,blockedReason:blockedReason||null,meetings,instructors:(Array.isArray(raw.instructors)?raw.instructors:[]).slice(0,20).map(instructor=>text(instructor.name,100)).filter(Boolean)};
}

/** Parse only observed public schema fields; never run downloaded JavaScript. */
export function normalizeCatalog(raw,{term,fetchedAt=new Date().toISOString()}={}) {
  termCode(term);
  if(!raw||![3,4].includes(raw.schemaVersion)||raw.roster!==term||!Array.isArray(raw.courses)||raw.courses.length>MAX_COURSES)throw new Error('Unexpected course catalog schema or term.');
  const seenCourses=new Map(),seenSections=new Map(),courses=[];
  for(const course of raw.courses){
    if(!course||!Array.isArray(course.sections)||course.sections.length>MAX_SECTIONS)throw new Error('Catalog courses exceed the supported shape.');
    const id=text(course.id,100),subject=text(course.subject,20),number=text(course.catalogNumber??course.catalogNbr,20);
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(id)||!/^\w{2,12}$/.test(subject)||!/^\d{4}[A-Za-z]?$/.test(number))throw new Error('Catalog course identity is invalid.');
    if(seenCourses.has(id)){if(seenCourses.get(id)!==JSON.stringify(course))throw new Error('Duplicate course identities disagree; catalog review is required.');continue;}seenCourses.set(id,JSON.stringify(course));
    const sections=course.sections.map(section=>normalizeSection(section,course,term)).filter(section=>{const key=`${id}:${section.id}`,value=JSON.stringify(section);if(seenSections.has(key)){if(seenSections.get(key)!==value)throw new Error('Duplicate section identities disagree; catalog review is required.');return false;}seenSections.set(key,value);return true;});
    const normalized={id,code:text(course.code,60)||`${subject} ${number}`,name:text(course.name,240),description:text(course.description,1200),subject,catalogNumber:number,courseUrl:`https://classes.cornell.edu/browse/roster/${term}/class/${encodeURIComponent(subject)}/${encodeURIComponent(number)}`,sections};
    normalized.searchable=searchText([normalized.code,normalized.name,normalized.description,...sections.flatMap(section=>[section.label,...section.instructors])].join(' '));courses.push(normalized);
  }
  courses.sort((a,b)=>a.code.localeCompare(b.code));
  return {term,termLabel:TERM_POLICIES[term].label,sourceUrl:CATALOG_URLS[term],sourceName:'Public Cornell Tech course planner snapshot',sourceUpdatedAt:timestamp(raw.sourceUpdatedAt),snapshotFetchedAt:timestamp(raw.fetchedAt),fetchedAt:timestamp(fetchedAt),breakPolicy:{verifiedAt:'2026-11-10',sourceUrls:[TECH_CALENDAR,TECH_GUIDE,REGISTRAR]},warnings:['This is a third-party course snapshot, not live enrollment data. Verify current section details in the Cornell roster.','Import adds class meetings only. It does not enroll you or infer assignments, exams, registration, or unpublished schedule changes.'],courses};
}

export function selectionToEvents(catalog,{courseId,sectionId,approvedAt}={}) {
  termCode(catalog?.term);
  if(typeof courseId!=='string'||typeof sectionId!=='string'||!courseId||!sectionId||courseId.length>100||sectionId.length>120)throw new HttpError(400,'Choose an exact course and section before importing.');
  const course=catalog.courses.find(item=>item.id===courseId),section=course?.sections.find(item=>item.id===sectionId);
  if(!course||!section)throw new HttpError(400,'The selected course or section is not in this catalog.');
  const term=catalog.term,policy=TERM_POLICIES[term],events=new Map(),skipped=[],warnings=unique([...catalog.warnings,...section.warnings]);
  const sourceId=idFor('course-catalog',term,section.classNumber||section.id);
  const source={id:sourceId,type:'course-catalog',name:`${course.code} · ${section.label} · ${term}`,url:course.courseUrl,catalogUrl:catalog.sourceUrl,courseId,sectionId,term,sourceUpdatedAt:catalog.sourceUpdatedAt,snapshotFetchedAt:catalog.snapshotFetchedAt,fetchedAt:catalog.fetchedAt,breakPolicy:catalog.breakPolicy,method:'Explicit student section selection; bounded source meeting expansion with published no-class dates'};
  const base={warnings,skipped,source,course:{id:course.id,code:course.code,name:course.name},section:{id:section.id,label:section.label}};
  if(!section.importable)return {...base,events:[],blocked:true,blockedReason:section.blockedReason};
  const approval=approvedAt?timestamp(approvedAt):null;if(approvedAt&&!approval)throw new Error('Approval timestamp is invalid.');
  try {
    for(const meeting of section.meetings){
      for(const date of dateRange(meeting.startDate,meeting.endDate)){
        if(new Date(`${date}T12:00:00Z`).getUTCDay()!==DAYS[meeting.day])continue;
        const closure=holiday(policy,date),excluded=meeting.excludedDates.includes(date);
        if(closure||excluded){skipped.push({date,reason:closure?`${closure.label}: published no-class day`:'Explicit source exclusion',sourceUrl:closure?REGISTRAR:catalog.sourceUrl});continue;}
        const time=clock(meeting.start),endTime=clock(meeting.end),start=strictLocalISO(date,time),end=strictLocalISO(date,endTime);
        if((Date.parse(end)-Date.parse(start))/60000!==meeting.end-meeting.start)throw new Error('A meeting crosses a daylight-saving transition; confirm its duration manually.');
        const id=idFor('course-meeting',term,section.classNumber||section.id,date,time,endTime);
        const evidence=`${course.code} ${course.name}; ${section.label}; ${meeting.day} ${time}-${endTime} America/New_York; source range ${meeting.startDate} through ${meeting.endDate}; room: ${meeting.rawRoom||'not published'}. Source JSON: ${catalog.sourceUrl}. Upstream snapshot: ${catalog.snapshotFetchedAt||'unknown'}; source update: ${catalog.sourceUpdatedAt||'unknown'}. Published Cornell no-class exclusions applied: ${policy.breaks.map(item=>`${item.start}–${item.end} (${item.label})`).join('; ')}. Calendar policy: ${TECH_GUIDE}; ${REGISTRAR}.`;
        const event=normalizeEvent({id,title:`${course.code} · ${course.name}`,kind:'class',date,time,endTime,location:meeting.location,status:'approved',evidence,evidenceVerified:true,sourceId,sourceName:source.name,sourceUrl:course.courseUrl,catalogUrl:catalog.sourceUrl,courseId,sectionId,term,component:section.component,approvalMethod:'explicit-section-selection',...(approval?{approvedAt:approval}:{}),warning:meeting.location?'Third-party catalog snapshot; verify current schedule in the original roster.':'Room not published. Verify the location before attending. Third-party catalog snapshot; verify current schedule.',adapter:'brf-public-course-catalog-v1'});
        const existing=events.get(id);
        if(existing){if(existing.location!==event.location)throw new Error('Duplicate source meetings disagree about the room; resolve the conflict before importing.');skipped.push({date,reason:'Duplicate meeting occurrence',sourceUrl:catalog.sourceUrl});continue;}
        events.set(id,event);if(events.size>MAX_EVENTS)throw new Error('Section expands beyond the supported event limit.');
      }
    }
  }catch(error){return {...base,events:[],blocked:true,blockedReason:error.message};}
  if(!events.size)return {...base,events:[],blocked:true,blockedReason:'No class occurrences remain after the published exclusions.'};
  return {...base,events:[...events.values()].sort((a,b)=>a.start.localeCompare(b.start)||a.id.localeCompare(b.id)),blocked:false,blockedReason:null};
}

async function boundedJSON(response){
  if(!response.ok||response.redirected)throw new Error('The public course catalog could not be fetched safely.');
  const length=Number(response.headers.get('content-length')||0);if(length>MAX_BYTES)throw new Error('The course catalog exceeds the size limit.');
  if(!/application\/json|text\/plain/i.test(response.headers.get('content-type')||''))throw new Error('The course catalog returned an unsupported content type.');
  const reader=response.body?.getReader();if(!reader)throw new Error('The course catalog response is empty.');
  const chunks=[];let bytes=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES)throw new Error('The course catalog exceeds the size limit.');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('The course catalog returned invalid JSON.');}
}

export function createCourseCatalog({fetchImpl=globalThis.fetch,now=Date.now,cacheTtlMs=15*60000}={}) {
  if(!Number.isInteger(cacheTtlMs)||cacheTtlMs<1000||cacheTtlMs>3600000)throw new Error('Catalog cache duration is out of bounds.');
  const cache=new Map(),pending=new Map();
  async function get(term){
    termCode(term);const existing=cache.get(term);if(existing&&now()-existing.at<cacheTtlMs)return structuredClone(existing.catalog);
    if(!pending.has(term))pending.set(term,Promise.resolve().then(async()=>{try{const response=await fetchImpl(CATALOG_URLS[term],{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json'}});const raw=await boundedJSON(response);const catalog=normalizeCatalog(raw,{term,fetchedAt:new Date(now()).toISOString()});cache.set(term,{at:now(),catalog});return catalog;}catch{throw new HttpError(502,'The public course catalog is unavailable or contains unsupported data. Please retry later.','catalog_unavailable');}finally{pending.delete(term);}}));
    return structuredClone(await pending.get(term));
  }
  return {get,
    async search({term='FA26',q='',limit=40}={}){
      if(typeof q!=='string'||q.length>160||!Number.isInteger(limit)||limit<1||limit>100)throw new HttpError(400,'Catalog search is out of bounds.');
      const catalog=await get(term),tokens=searchText(q).split(' ').filter(Boolean),matches=catalog.courses.filter(course=>tokens.every(token=>course.searchable.includes(token)));
      return {...catalog,total:matches.length,limit,courses:matches.slice(0,limit).map(({searchable,...course})=>({...course,sections:course.sections.map(({meetings,...section})=>section)}))};
    },
    async select({term='FA26',courseId,sectionId}={}){const catalog=await get(term);return selectionToEvents(catalog,{courseId,sectionId,approvedAt:new Date(now()).toISOString()});}
  };
}
