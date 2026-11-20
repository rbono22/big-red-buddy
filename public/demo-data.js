// Synthetic fixtures only. This module never reads a student workspace or calls a provider.
export const DEMO_TODAY = '2026-11-18';
export const DEMO_TIMEZONE = 'America/New_York';
export function sampleEvents() {
  return [
    {id:'demo-1',title:'Product Studio · team critique',kind:'class',date:'2026-11-18',time:'14:00',status:'approved',source:'Sample Product Studio syllabus · p. 2',quote:'Weekly critique: Wednesday, 2:00–3:00 p.m.',why:'Code expands the syllabus meeting rule. The student reviewed this occurrence.'},
    {id:'demo-2',title:'HCI · prototype reflection',kind:'assignment',date:'2026-11-19',time:'17:00',status:'pending',source:'Sample Canvas assignment · imported Nov 18',quote:'Prototype reflection is due November 19 at 5 p.m. Eastern.',why:'The source states the date and time. Code interprets Eastern time; student review is still required.'},
    {id:'demo-3',title:'Product Studio · milestone 5',kind:'assignment',date:'2026-11-20',time:'',status:'pending',source:'Sample Telegram announcement · Nov 18',quote:'Milestone 5 is due Friday, November 20. We will confirm the submission time.',why:'The source has no time. Code keeps the deadline visible and blocks calendar approval until a time is confirmed.'},
    {id:'demo-4',title:'Data Analytics · problem set',kind:'assignment',date:'2026-11-22',time:'23:59',status:'approved',source:'Sample Data Analytics syllabus · p. 4',quote:'Problem set 4: November 22, 11:59 p.m. Eastern.',why:'The syllabus supplies an explicit deadline. The student approved this date and time.'},
    {id:'demo-5',title:'Design seminar',kind:'event',date:'2026-11-20',time:'16:00',status:'approved',source:'Sample campus event listing · imported Nov 18',quote:'Design seminar, November 20, 4:00 p.m. Eastern.',why:'Code retains the event’s published time. The student reviewed this event.'},
    {id:'demo-6',title:'HCI · usability report',kind:'assignment',date:'2026-11-24',time:'17:00',status:'approved',source:'Sample HCI syllabus · p. 5',quote:'Usability report: November 24, 5:00 p.m. Eastern.',why:'The source supplies an explicit deadline. Re-importing a changed syllabus reopens review.'},
  ];
}
export function eventsInRange(events, from, to, deadlinesOnly = false) {
  return events.filter(e => !e.cancelled && e.date >= from && e.date < to && (!deadlinesOnly || ['assignment','quiz','exam'].includes(e.kind)))
    .sort((a,b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}
export function approveSample(events, id) {
  const event = events.find(e => e.id === id);
  if (!event?.time) return false;
  event.status = 'approved';
  return true;
}
export function changeSampleSource(events) {
  const event = events.find(e => e.id === 'demo-6');
  event.date = '2026-11-25'; event.status = 'pending';
  event.quote = 'Updated syllabus: usability report moved to November 25, 5:00 p.m. Eastern.';
  event.why = 'Re-import detected a changed date (Nov 24 → Nov 25). Previous approval no longer applies; review the revised source.';
}
export function sampleAnswer(events, question) {
  const q = String(question).toLowerCase();
  if (/send|email|write|sync|add.*calendar/.test(q)) return 'Use Review on a sample date to approve it for the calendar preview. This demo does not send messages or write to a real calendar.';
  let from, to, label;
  if (/next week/.test(q)) { from='2026-11-23'; to='2026-11-30'; label='next week (Nov 23–29)'; }
  else if (/tomorrow/.test(q)) { from='2026-11-19'; to='2026-11-20'; label='tomorrow (Nov 19)'; }
  else if (/today/.test(q)) { from=DEMO_TODAY; to='2026-11-19'; label='today (Nov 18)'; }
  else if (/this week/.test(q)) { from='2026-11-16'; to='2026-11-23'; label='this week (Nov 16–22)'; }
  else return 'Try a sample schedule question with “today”, “tomorrow”, “this week”, or “next week”, such as “What deadlines do I have this week?” The sample clock is November 18, 2026.';
  const deadlinesOnly = /due|deadline|assignment/.test(q);
  const found = eventsInRange(events,from,to,deadlinesOnly);
  return `${found.length} ${deadlinesOnly?'deadline':'schedule item'}${found.length===1?'':'s'} in the sample records for ${label}. Times are America/New_York.\n\n${found.map(e=>`${e.date} · ${e.time || 'Time not specified'} — ${e.title}${e.status==='approved'?'':' [Needs review]'}\nSource: ${e.source}`).join('\n\n') || 'No matching sample records. This does not establish completeness of a real student’s schedule.'}`;
}
