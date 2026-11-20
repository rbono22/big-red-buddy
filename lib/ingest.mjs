import {readFile,stat} from 'node:fs/promises';
import {readLocalDocumentText,ENROLLMENT_LIMITS} from './enrollment.mjs';
import {HttpError} from './security.mjs';
import { idFor, normalizeEvent, parseNBAY, parseStudioExample } from './domain.mjs';
import {calendarEventRemoved} from './calendar-mutations.mjs';
export async function pdfText(file,{readDocument=readLocalDocumentText}={}) {
  const info=await stat(file);
  if(!info.isFile()||info.size>ENROLLMENT_LIMITS.bytes)throw new HttpError(413,'Upload a PDF no larger than 12 MB.');
  // Resumes and local imports share the bounded parser used by syllabus photos,
  // including local OCR and page limits, instead of an unbounded native-text pass.
  const {text}=await readDocument({buffer:await readFile(file),mimeType:'application/pdf'});
  if(typeof text!=='string'||text.trim().length<60)throw new HttpError(400,'This PDF has too little readable text. Upload a clear, unlocked PDF of up to 6 pages (up to 4 scanned pages).');
  return text;
}
export {modelJSON} from './model-client.mjs';
import {modelJSON} from './model-client.mjs';
export async function extractEvents(text, type = 'syllabus', model, {deadlinesOnly = false, academicTerm = 'Fall 2026'} = {}) {
  const known = deadlinesOnly ? null : type === 'studio' ? parseStudioExample(text) : parseNBAY(text);
  if (known) return {
    events: known,
    metrics: {
      model: 'source-specific deterministic adapter',
      ms: 0
    },
    method: 'Source-specific adapter; dates still require review'
  };
  const result = await modelJSON(`Extract calendar candidates from this ${type}. Selected academic term is ${academicTerm}. ${deadlinesOnly ? 'Extract ONLY assignments, quizzes, exams, and studio deliverables. Do not extract class meetings. Do not treat a lecture topic as an assignment. Include the course name/code in titles when present in the source. Do not assume deadlines are at class time or midnight.' : ''} Return {"events":[{"title":"...","kind":"class|assignment|quiz|exam|studio|event","date":"YYYY-MM-DD","time":null,"endTime":null,"location":"","page":1,"evidence":"exact supporting source text","warning":"ambiguities"}]}. For each event, copy any explicitly stated deadline time into time as a 24-hour HH:MM string in America/New_York, converting AM/PM (for example 5 pm becomes 17:00). Set endTime similarly only for an explicit end time. The nulls in the example are placeholders: use null only when the source omits or ambiguously states the time, never when it gives a clear deadline time. Do not infer deadlines from nearby unrelated sentences. Include separate deliverables separately. Use explicit class schedule dates and holiday exclusions. Page breaks are form feeds. If class dates are not bounded, flag uncertainty instead of inventing semester dates. No events without an explicit date or supporting evidence. SOURCE:\n${text.slice(0, 55000)}`, {
    model
  });
  const events = [];
  for (const item of (result.value.events || []).slice(0, 150)) {
    try {
      if (deadlinesOnly && !['assignment','quiz','exam','studio'].includes(item.kind)) continue;
      const e = normalizeEvent(item);
      const needle = e.evidence.replace(/\s+/g, ' ').trim();
      if (!needle || !text.replace(/\s+/g, ' ').includes(needle)) {
        e.warning = `Evidence could not be matched exactly. ${e.warning || ''}`;
        e.evidenceVerified = false;
      } else e.evidenceVerified = true;
      events.push(e);
    } catch {/* Invalid candidates never become scheduled actions. */}
  }
  if (!events.length) throw new Error('No valid date candidates were extracted. Check the source or try a clearer document.');
  return {
    events,
    metrics: result.metrics,
    method: 'Local Ollama extraction; student review required'
  };
}
export async function persistCandidates(store, source, events, {reconcileKinds = null} = {}) {
  const previousSource = await store.get('sources', source.id);
  const sourceChanged = Boolean(previousSource?.hash && source.hash && previousSource.hash !== source.hash);
  const checkedAt = new Date().toISOString();
  const previous = (await store.all('events')).filter(e => e.sourceId === source.id && (!reconcileKinds || reconcileKinds.includes(e.kind)));
  const ids = new Set();
  for (const candidate of events) {
    const id = idFor(source.id, candidate.kind, candidate.title, candidate.date);
    ids.add(id);
    if (await calendarEventRemoved(store,{localId:id})) continue;
    const old = await store.get('events', id);
    const e = {
      ...candidate,
      id,
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: source.url || '',
      updatedAt: new Date().toISOString(),
      status: 'review'
    };
    if (old && !sourceChanged && ['title', 'date', 'start', 'end', 'location', 'evidence'].every(k => old[k] === e[k])) e.status = old.status;
    if (sourceChanged) e.warning = ['Source changed on re-import. Review this date against the latest version.', e.warning].filter(Boolean).join(' ');
    if (old?.googleId) e.googleId = old.googleId;
    await store.put('events', id, e);
    if (old && old.start !== e.start) for (const r of (await store.all('reminders')).filter(r => r.eventId === id && r.status === 'pending')) await store.delete('reminders', r.id);
  }
  for (const old of previous.filter(e => !ids.has(e.id))) {
    if (await calendarEventRemoved(store,{localId:old.id})) continue;
    await store.put('events', old.id, {
    ...old,
    cancelled: true,
    status: 'review',
    warning: 'Removed from the latest source version. Review cancellation.'
    });
  }
  await store.put('sources', source.id, {
    ...source,
    lastCheckedAt: checkedAt,
    lastChangedAt: sourceChanged ? checkedAt : previousSource?.lastChangedAt || null,
    previousHash: sourceChanged ? previousSource.hash : previousSource?.previousHash || null,
    warning: sourceChanged ? ['Source changed on re-import. Its dates need review again.', source.warning].filter(Boolean).join(' ') : source.warning || '',
    count: events.length,
    updatedAt: new Date().toISOString()
  });
  return events.length;
}
