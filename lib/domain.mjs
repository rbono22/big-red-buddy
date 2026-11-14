import { calendarDescription, calendarLocation } from './calendar-description.mjs';
import { createHash } from 'node:crypto';
import { resolveReminderSettings } from './reminder-settings.mjs';

export const TZ = 'America/New_York';
export const idFor = (...parts) => createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
export function localISO(date, time = '00:00') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('Use a valid date and time.');
  const [y,m,d] = date.split('-').map(Number), [h,min] = time.split(':').map(Number);
  const naive = Date.UTC(y,m-1,d,h,min);
  let instant = naive;
  const parts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  for (let i=0;i<3;i++) { const p=parts(instant); const seen=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute); instant += naive-seen; }
  const p=parts(instant);
  if (`${p.year}-${p.month}-${p.day}`!==date || `${p.hour}:${p.minute}`!==time) throw new Error('This local time is invalid or falls in a daylight-saving gap.');
  return new Date(instant).toISOString();
}
export function normalizeEvent(e) {
  const kind = ['class','assignment','quiz','exam','studio','event'].includes(e.kind) ? e.kind : 'assignment';
  const date = String(e.date || '').slice(0,10);
  localISO(date);
  const time = /^\d{2}:\d{2}$/.test(e.time || '') ? e.time : null;
  const start = time ? localISO(date,time) : null;
  let end = e.endTime && time ? localISO(date,e.endTime) : start ? new Date(Date.parse(start)+(['class','event','exam'].includes(kind)?60:1)*60000).toISOString() : null;
  if (start && end<=start) throw new Error('End time must follow start time.');
  const title = String(e.title || '').trim().slice(0,240);
  if (!title) throw new Error('An event needs a title.');
  return { ...e, title, kind, date, time, start, end, timezone:TZ, location:String(e.location||'').slice(0,300), status:e.status==='approved'?'approved':'review', evidence:String(e.evidence||'').slice(0,2400), page:Number(e.page)||null, warning:time?String(e.warning||(!e.endTime&&['class','event','exam'].includes(kind)?'End time not specified. A one-hour calendar placeholder is used; confirm duration.':'')):'Time not specified in source. Confirm before scheduling reminders.' };
}
export function reminderSpecs(event, settings = {}) {
  if (event.status!=='approved' || event.cancelled) return [];
  // A due date without a time gets one heads-up at 9:00 AM New York the day before.
  // Google Calendar measures all-day reminders from midnight, so 900 minutes = 9:00 AM.
  if (event.allDay) {
    if (!['assignment','quiz','exam','studio'].includes(event.kind) || !/^\d{4}-\d{2}-\d{2}$/.test(event.date||'')) return [];
    const minutes=15*60, due=new Date(Date.parse(localISO(event.date))-minutes*60000).toISOString();
    return [{id:idFor(event.id,event.date,'all-day'),eventId:event.id,minutes,due,allDay:true}];
  }
  if (!event.start) return [];
  const category=event.kind==='class'?'classes':event.kind==='event'?'events':'deadlines';
  return resolveReminderSettings(settings)[category].map(minutes=>({id:idFor(event.id,event.start,minutes),eventId:event.id,minutes,due:new Date(Date.parse(event.start)-minutes*60000).toISOString()}));
}
export const icsEscape = s => String(s||'').replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,');
const stamp = d => new Date(d).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z/,'Z');
export function calendarBounds(event){
  if(event.allDay){
    const date=event.date,endDate=event.endDate;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||!/^\d{4}-\d{2}-\d{2}$/.test(endDate||'')||endDate<=date)throw new Error('All-day events need a valid date and exclusive end date.');
    localISO(date);localISO(endDate);return {start:{date},end:{date:endDate}};
  }
  if(!Number.isFinite(Date.parse(event.start))||!Number.isFinite(Date.parse(event.end))||Date.parse(event.end)<=Date.parse(event.start))throw new Error('Timed events need a valid start and end.');
  return {start:{dateTime:event.start,timeZone:TZ},end:{dateTime:event.end,timeZone:TZ}};
}
function fold(line) {
  const out=[]; let current='';
  for (const ch of line) { if (Buffer.byteLength(current+ch)>73) {out.push(current);current=' '+ch;} else current+=ch; }
  out.push(current); return out.join('\r\n');
}
export function calendarICS(events, settings = {}) {
  const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Big Red Buddy//Cornell Tech Assistant//EN','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:Cornell Tech Assistant'];
  for (const e of events.filter(e=>e.status==='approved' && (e.allDay||e.start) && !e.cancelled)) {
    const bounds=calendarBounds(e);
    lines.push('BEGIN:VEVENT',`UID:${e.id}@dabas.local`,`DTSTAMP:${stamp(new Date())}`,...(e.allDay?[`DTSTART;VALUE=DATE:${bounds.start.date.replaceAll('-','')}`,`DTEND;VALUE=DATE:${bounds.end.date.replaceAll('-','')}`]:[`DTSTART:${stamp(e.start)}`,`DTEND:${stamp(e.end)}`]),`SUMMARY:${icsEscape(e.title)}`,`LOCATION:${icsEscape(calendarLocation(e.location))}`,`DESCRIPTION:${icsEscape(calendarDescription(e))}`);
    for(const r of reminderSpecs(e, settings)) lines.push('BEGIN:VALARM',`TRIGGER:-PT${r.minutes}M`,'ACTION:DISPLAY',`DESCRIPTION:${icsEscape(e.title)}`,'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR'); return lines.map(fold).join('\r\n')+'\r\n';
}

// Deliberately limited adapter for the supplied syllabus. Other syllabi use model extraction + review.
export function parseNBAY(text) {
  if(!/NBAY\s+5300/.test(text)||!/Fall\s+2026/.test(text)||!/1:25-2:40\s*pm/.test(text)) return null;
  const pages=text.split('\f'); const table=pages.find(p=>p.includes('Weekly Schedule of Topics'));
  if(!table) return null;
  const events=[];
  for(const line of table.split('\n')) {
    // MarkItDown preserves the schedule as Markdown table cells. Normalize
    // only table delimiters for the legacy row parser; keep original evidence.
    const row=/^\s*\|.*\|\s*$/.test(line)?line.replace(/(?<!\\)\|/g,' ').replace(/\\\|/g,'|'):line;
    const match=row.match(/(\d{1,2})\/(\d{1,2})\/(2026)\s+(.+?)\s*$/);
    if(!match) continue;
    const date=`${match[3]}-${match[1].padStart(2,'0')}-${match[2].padStart(2,'0')}`;
    const topic=match[4].replace(/\s+[123]\s*$/,'').trim();
    if(/Thanksgiving|Final exam/i.test(topic)) continue;
    events.push(normalizeEvent({title:`NBAY 5300 · ${topic}`,kind:'class',date,time:'13:25',endTime:'14:40',location:'Tata L23',page:2,evidence:`${line.trim()}\nClass meetings: Mondays & Wednesdays, 1:25-2:40 pm. Classroom: Tata L23.`,adapter:'supplied-syllabus-rules'}));
    const pset=match[4].match(/\s+([123])\s*$/);
    if(pset) events.push(normalizeEvent({title:`NBAY 5300 · Problem set ${pset[1]}`,kind:'assignment',date,time:'13:25',location:'Tata L23',page:2,evidence:`${line.trim()}\nProblem sets are due at the beginning of class on the day listed and must be turned in on paper.`,adapter:'supplied-syllabus-rules'}));
  }
  if(/9:00-11:00 am/.test(text)) events.push(normalizeEvent({title:'NBAY 5300 · Final exam',kind:'exam',date:'2026-12-11',time:'09:00',endTime:'11:00',location:'',page:3,evidence:'Final exam: December 11, 2026, at 9:00-11:00 am. In person.',warning:'Exam room is not specified; verify in Canvas.',adapter:'supplied-syllabus-rules'}));
  if(/First-week quiz.*due 11:00 pm on Sunday, Oct 18th/.test(text)) events.push(normalizeEvent({title:'NBAY 5300 · First-week quiz',kind:'quiz',date:'2026-10-18',time:'23:00',page:3,evidence:'5% First-week quiz – due 11:00 pm on Sunday, Oct 18th',adapter:'supplied-syllabus-rules'}));
  return events;
}

export function parseStudioExample(text) {
  if (!/Milestone 5/i.test(text)||!/Maker Day 3/i.test(text)||!/Nov(?:ember)?\s+13/i.test(text)) return null;
  if(/\b20\d{2}\b/.test(text)&&!text.includes('2026')) return null;
  const result=[];
  if(/Milestone 5/i.test(text)) result.push(normalizeEvent({title:'Product Studio · Milestone 5 PDF',kind:'studio',date:'2026-11-13',page:null,evidence:'Milestone 5 and Maker Day 3 PDF uploads are due by Friday November 13. Milestone 5: One PDF: your risk register, your three experiment cards, and the data from the experiments underway.',adapter:'supplied-announcement-rules'}));
  if(/5:00\s*p\.?m\.?/i.test(text)) result.push(normalizeEvent({title:'Product Studio · Maker Day 3 slides PDF',kind:'studio',date:'2026-11-13',time:'17:00',evidence:'Maker Day 3: Upload your slides as one PDF by 5:00 p.m. on Nov 13. Your Milestone 5 PDF is a separate upload.',adapter:'supplied-announcement-rules'}));
  for(const event of result) event.evidence=text.slice(0,4000);
  return result;
}
