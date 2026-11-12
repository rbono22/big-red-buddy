import {idFor,TZ} from './domain.mjs';
import {lumaRSVP} from './luma-calendar.mjs';
import {eventApprovalVersion} from './event-version.mjs';

const LABELS={campus:'CampusGroups',partiful:'Partiful',luma:'Luma',email:'Email',academic:'Cornell Registrar',manual:'Your plans'};
const REGISTRAR_URL='https://registrar.cornell.edu/calendars-exams/academic-calendar/2026-2027';
const compact=(value,max=240)=>String(value||'').replace(/\s+/g,' ').trim().slice(0,max);
const fold=value=>compact(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const dateFmt=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'});
export function eventRegistrationURL(value){
  try{
    const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port)return '';
    if(['luma.com','lu.ma'].includes(u.hostname))return lumaRSVP(value);
    if(['partiful.com','www.partiful.com'].includes(u.hostname)&&/^\/e\/[\w-]{1,160}\/?$/.test(u.pathname))return `https://partiful.com${u.pathname.replace(/\/$/,'')}`;
    if(u.hostname==='cornelltech.campusgroups.com'&&/^\/rsvp\/?$/.test(u.pathname)&&/^\d{1,20}$/.test(u.searchParams.get('id')||''))return `https://${u.hostname}/rsvp?id=${u.searchParams.get('id')}`;
    return '';
  }catch{return '';}
}
function category(e,kind){
  if(kind==='academic')return ['holiday','break','holidays','breaks'].includes(e.category||e.academicCategory)?'holidays':'academic';
  if(kind==='partiful'||kind==='luma')return 'social';
  if(kind==='campus')return 'campus';
  return kind==='email'?'email':'plans';
}
function normalize(e,kind,scheduled){
  const reg=eventRegistrationURL(e.rsvpUrl||e.registrationUrl||e.sourceUrl), date=e.date||(e.start&&Number.isFinite(Date.parse(e.start))?dateFmt.format(new Date(e.start)):null);
  const originalKind=kind;
  if(kind==='manual')kind=e.connector==='event-email'?'email':e.connector==='academic'||e.academicCandidateId?'academic':e.lumaCandidateId?'luma':e.partifulCandidateId?'partiful':e.campusCandidateId?'campus':'manual';
  const sourceLabel=kind==='email'?(compact(e.sourceName,100)||LABELS.email):e.connector==='telegram-invitation'?'Telegram invitation':LABELS[kind];
  const invitationProvider=(kind==='email'||e.connector==='telegram-invitation')&&reg?(reg.startsWith('https://partiful.com/e/')?'partiful':/^https:\/\/(?:luma\.com|lu\.ma)\//.test(reg)?'luma':null):null;
  const candidateId=e.lumaCandidateId||e.partifulCandidateId||e.campusCandidateId||e.academicCandidateId||e.id;
  const actionId=scheduled?e.id:candidateId;
  const status=e.cancelled||e.status==='cancelled'?'cancelled':e.localIntent==='declined'||e.status==='dismissed'?'dismissed':scheduled?(e.status==='approved'?'added':'review'):(e.status==='review'?'review':e.addedEventId?'added':'available');
  return {id:`${originalKind}:${e.id}`,title:compact(e.title)||'Untitled event',date,start:e.start||null,end:e.end||null,endDate:e.endDate||null,allDay:!!e.allDay,location:compact(e.location,300),category:category(e,kind),holiday:kind==='academic'&&['holiday','break','holidays','breaks'].includes(e.category||e.academicCategory),academicCategory:kind==='academic'?(e.category||e.academicCategory):null,status,localIntent:e.localIntent||null,registrationUrl:reg,
    ...(invitationProvider?{invitationProvider}:{}),sourceLabels:[sourceLabel],sources:[{kind,label:sourceLabel,url:kind==='academic'?REGISTRAR_URL:reg,candidateId}],
    evidence:[{label:sourceLabel,url:kind==='academic'?REGISTRAR_URL:reg,excerpt:compact(e.evidence,1000)}],warnings:[...new Set([...(e.warning?[compact(e.warning,600)]:[]),...(Array.isArray(e.warnings)?e.warnings.map(w=>compact(w,600)):[])])],
    action:{kind:scheduled?(kind==='academic'?'academic':kind==='email'?'email':'manual'):kind,id:scheduled&&kind==='academic'?candidateId:actionId,version:eventApprovalVersion(e)},googleId:!!e.googleId,
    _refs:[`${kind}:${candidateId}`,...(scheduled?[`event:${e.id}`]:[]),...(e.addedEventId?[`event:${e.addedEventId}`]:[])],_scheduled:scheduled};
}
function sameWhen(a,b){
  if(a.allDay!==b.allDay||!a.date||a.date!==b.date)return false;
  if(a.allDay)return (a.endDate||a.date)===(b.endDate||b.date);
  return a.start&&b.start?Date.parse(a.start)===Date.parse(b.start):!a.start&&!b.start;
}
function duplicates(a,b){
  if(a._refs.some(ref=>b._refs.includes(ref)))return true;
  if(!sameWhen(a,b)||a.category==='academic'||b.category==='academic'||a.holiday||b.holiday)return false;
  if(a.registrationUrl&&a.registrationUrl===b.registrationUrl)return true;
  return fold(a.title).length>=8&&fold(a.title)===fold(b.title)&&fold(a.location).length>=3&&fold(a.location)===fold(b.location);
}
function matchKeys(row){
  const keys=row._refs.map(ref=>`ref:${ref}`);
  if(!row.date||row.category==='academic'||row.holiday)return keys;
  const when=JSON.stringify([row.date,row.allDay,row.allDay?row.endDate||row.date:row.start?Date.parse(row.start):null]);
  if(row.registrationUrl)keys.push(`url:${row.registrationUrl}:${when}`);
  const title=fold(row.title),location=fold(row.location);
  if(title.length>=8&&location.length>=3)keys.push(`name:${JSON.stringify([title,location,when])}`);
  return keys;
}
function merge(a,b){
  // An approved schedule entry wins presentation, but never implicitly approves
  // another source. Review disagreements stay explicit and actions target one row.
  const rank=row=>['cancelled','dismissed'].includes(row.status)?0:row._scheduled?(row.status==='added'?320:310):200;
  const preferred=a._scheduled!==b._scheduled?(a._scheduled?a:b):rank(b)>rank(a)?b:a,other=preferred===a?b:a;
  const sources=[...a.sources,...b.sources].filter((s,i,all)=>all.findIndex(t=>t.kind===s.kind&&t.candidateId===s.candidateId)===i);
  const warnings=[...new Set([...a.warnings,...b.warnings])];
  if(!sameWhen(a,b))warnings.push('Sources disagree about the time. Review the original details before adding.');
  if(a.end&&b.end&&Date.parse(a.end)!==Date.parse(b.end))warnings.push('Sources list different end times. Check the organizer before making plans.');
  if(a.location&&b.location&&fold(a.location)!==fold(b.location))warnings.push('Sources list different locations. Check the organizer before making plans.');
  if(other._scheduled&&other.status!==preferred.status)warnings.push('Another saved copy has a different review status. Its approval has not changed.');
  const declinedLink=a._refs.some(ref=>b._refs.includes(ref))&&(a.localIntent==='declined'||b.localIntent==='declined');
  return {...preferred,...(declinedLink?{status:'dismissed',localIntent:'declined'}:{}),registrationUrl:preferred.registrationUrl||other.registrationUrl,sources,sourceLabels:[...new Set(sources.map(s=>s.label))],evidence:[...a.evidence,...b.evidence],warnings,_refs:[...new Set([...a._refs,...b._refs])],_scheduled:a._scheduled||b._scheduled};
}
export function aggregateEventHub({events=[],campus=[],partiful=[],luma=[],academic=[],campusCalendar,partifulCalendar,lumaCalendar,now=Date.now()}={}){
  const academicVersions=new Map(academic.map(e=>[e.id,eventApprovalVersion(e)]));
  const records=[];
  for(const [kind,rows,selection] of [['campus',campus,campusCalendar],['partiful',partiful,partifulCalendar],['luma',luma,lumaCalendar]]){
    for(const e of rows)if(selection?.calendarId&&e.sourceCalendarId===selection.calendarId&&e.status!=='cancelled')records.push(normalize(e,kind,false));
  }
  for(const e of academic)records.push(normalize(e,'academic',false));
  for(const e of events)if(e.kind==='event'||e.connector==='academic'||e.academicCandidateId)records.push(normalize(e,'manual',true));
  // Deterministic source order makes item IDs stable across reads and process restarts.
  records.sort((a,b)=>a.id.localeCompare(b.id));
  const grouped=[],index=new Map();
  for(const row of records){
    const keys=matchKeys(row),possible=[...new Set(keys.flatMap(key=>[...(index.get(key)||[])]))].sort((a,b)=>a-b);
    let i=possible.find(candidate=>duplicates(grouped[candidate],row));
    if(i===undefined){i=grouped.length;grouped.push(row);}else grouped[i]=merge(grouped[i],row);
    for(const key of keys){if(!index.has(key))index.set(key,new Set());index.get(key).add(i);}
  }
  const timesByURL=new Map();for(const row of grouped){if(!row.registrationUrl)continue;const key=JSON.stringify([row.registrationUrl,row.date]);if(!timesByURL.has(key))timesByURL.set(key,new Set());timesByURL.get(key).add(JSON.stringify([row.allDay,row.allDay?row.endDate:row.start?Date.parse(row.start):null]));}
  const items=grouped.map(row=>{
    const related=row.registrationUrl&&(timesByURL.get(JSON.stringify([row.registrationUrl,row.date]))?.size||0)>1;
    const {_refs,_scheduled,...item}=row;
    if(item.action.kind==='academic'&&academicVersions.has(item.action.id))item.action={...item.action,version:academicVersions.get(item.action.id)};
    if(related)item.warnings=[...new Set([...item.warnings,'Another source lists this event at a different time. Kept separate for review.'])];
    return {...item,id:idFor('event-hub',..._refs.slice().sort()),revision:idFor('event-hub-revision',JSON.stringify(item)),duplicateCount:Math.max(0,item.sources.length-1)};
  }).sort((a,b)=>String(a.start||a.date||'9999').localeCompare(String(b.start||b.date||'9999'))||a.title.localeCompare(b.title));
  const today=dateFmt.format(new Date(now));
  return {items,stats:{total:items.length,review:items.filter(e=>e.status==='review').length,upcoming:items.filter(e=>(e.allDay&&e.endDate?e.endDate>today:(e.endDate||e.date)>=today)&&!['cancelled','dismissed'].includes(e.status)).length,sources:new Set(items.flatMap(e=>e.sources.map(s=>s.kind))).size,duplicates:records.length-items.length},timezone:TZ};
}
export async function buildEventHub(store,{now=Date.now()}={}){
  if(!store?.userId)throw new Error('Events require a student-owned store.');
  const [events,campus,partiful,luma,academic,campusCalendar,partifulCalendar,lumaCalendar]=await Promise.all([
    store.all('events'),store.all('campusEvents'),store.all('partifulEvents'),store.all('lumaEvents'),store.all('academicEvents'),store.get('settings','campusCalendar'),store.get('settings','partifulCalendar'),store.get('settings','lumaCalendar')
  ]);
  return aggregateEventHub({events,campus,partiful,luma,academic,campusCalendar,partifulCalendar,lumaCalendar,now});
}
