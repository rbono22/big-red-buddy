import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {scheduleQuery,scheduleRecords,answerScheduleQuestion,splitAssistantAnswer} from '../lib/assistant-schedule.mjs';
import {assistantReply} from '../lib/integrations.mjs';
import {normalizeEvent} from '../lib/domain.mjs';
import {openDatabase} from '../lib/database.mjs';

const now=Date.parse('2026-11-20T15:00:00Z');
const question1='Which of my deadlines before Dec 5 still has no time set, and does anything land on the same day as Demo Day?';
const question2='What do I have due between now and December 4?';
// The grader's two questions and visible Canvas rows, supplied by the owner.
// Tests use fixed dates and synthetic IDs; no student data or live connectors.
const cases=[
  {id:'hw4-review',title:'HW4: Review all Submissions · NBAY 6170',date:'2026-11-21',kind:'assignment'},
  {id:'final-scoring',title:'FINAL SCORING · NBAY 6170',date:'2026-11-27',kind:'assignment'},
  {id:'homework4',title:'Homework 4 · INFO 6410 / CS 5682',date:'2026-12-04',kind:'assignment'},
  {id:'demo-day',title:'Demo Day · TECH 5900',date:'2026-12-04',time:'08:40',kind:'class'},
  {id:'maker-demo',title:'Maker Day 4: Demo Day · TECH 5900',date:'2026-12-04',time:'17:00',kind:'studio'},
  {id:'past-social',title:'Networking Socials',date:'2026-11-18',time:'19:00',kind:'event'},
  {id:'too-late',title:'After the range',date:'2026-12-05',time:'09:00',kind:'assignment'},
  {id:'ordinary-class',title:'Regular class meeting',date:'2026-11-23',time:'10:00',kind:'class'},
  {id:'social',title:'Optional social',date:'2026-11-24',time:'17:00',kind:'event'},
].map(e=>normalizeEvent({...e,sourceName:'Canvas imported calendar',status:'review'}));
function fixture(events=cases){
  return {userId:'synthetic-student',async all(bucket,{offset=0,limit=2000}={}){assert.equal(bucket,'events');return events.slice(offset,offset+limit);},async put(bucket){assert.equal(bucket,'metrics');}};
}
const failModel=async()=>({value:{answer:'No deadlines. Networking Socials is November 18.',introduction:'Everything is already complete.'},metrics:{}});

test('grader regression: missing times before Dec 5 and Demo Day same-date matches',async()=>{
  const answer=await assistantReply(fixture(),question1,{now,generate:failModel});
  for(const e of cases.slice(0,5)){assert.ok(answer.includes(e.title));assert.ok(answer.includes(e.date));}
  assert.match(answer,/No time set/);assert.match(answer,/Time needs confirmation/);
  assert.match(answer,/Same-day matches for demo day: 2026-12-04:.*Homework 4.*Demo Day/);
  assert.match(answer,/8:40 AM/);assert.match(answer,/5:00 PM/);assert.match(answer,/Awaiting your review/);
  assert.doesNotMatch(answer,/Networking Socials|After the range|Regular class meeting|Optional social|Everything is already complete/);
});
test('grader regression: now through December 4 includes all five Canvas rows and excludes past Telegram social',async()=>{
  let sent;
  const answer=await assistantReply(fixture(),question2,{now,generate:async(prompt)=>{sent=prompt;return failModel();}});
  assert.match(answer,/2026-11-20 through 2026-12-04/);
  for(const e of cases.slice(0,5)){assert.ok(answer.includes(e.title));assert.ok(sent.includes(e.id));}
  assert.doesNotMatch(answer,/Networking Socials|After the range|Regular class meeting|Optional social|No deadlines/);
  assert.match(answer,/Source: Canvas imported calendar/);
  assert.match(answer,/Scheduled milestone \(not a submission deadline\)/);
});
test('date range arithmetic is New York local, with inclusive requested dates and calendar weeks',()=>{
  const window=q=>scheduleQuery(q,{now});
  assert.equal(window('What is due this week?').date,'2026-11-16');
  assert.equal(window('What is due this week?').endDate,'2026-11-23');
  assert.equal(window('What is due next week?').date,'2026-11-23');
  assert.equal(window('What is due next week?').endDate,'2026-11-30');
  assert.equal(window('What is due in the next 7 days?').endDate,'2026-11-27');
  assert.equal(window('What is due before Thanksgiving?').endDate,'2026-11-26');
  assert.equal(window("What's on Dec 4?").date,'2026-12-04');
  assert.equal(window("What's on Dec 4?").endDate,'2026-12-05');
  assert.equal(window('What is due November 20 through 27?').endDate,'2026-11-28');
  assert.equal(window('What is due 2026-11-20 through 2026-12-04?').endDate,'2026-12-05');
  const late=scheduleQuery('What is due today?',{now:Date.parse('2026-11-21T02:00:00Z')});assert.equal(late.date,'2026-11-20');
  const dst=scheduleQuery('What is due today?',{now:Date.parse('2026-03-08T12:00:00Z')});assert.equal(dst.end-dst.start,23*3600000);
  assert.ok(window('What is due 2026-02-30?').clarification);
  assert.ok(window('What is due sometime soon?').clarification);
});
test('event retrieval spans DB pages and never drops a late-ID deadline behind long evidence',async()=>{
  const events=Array.from({length:2001},(_,i)=>({...cases[0],id:`row-${i}`,date:'2020-01-01',evidence:'x'.repeat(100)}));
  events.push(cases[2]);
  const rows=await scheduleRecords(fixture(events),scheduleQuery(question2,{now}));
  assert.deepEqual(rows.map(e=>e.id),['homework4']);
});
test('no model truncation/omission: all selected records rendered and model outage falls back to saved facts',async()=>{
  const rows=Array.from({length:41},(_,i)=>({...cases[0],id:`e${i}`,title:`Deadline ${i}`}));
  let batches=0;
  const answer=await answerScheduleQuestion(fixture(rows),question2,{now,generate:async(prompt)=>{batches++;JSON.parse(prompt.split('\nRECORDS: ')[1]);return {value:{introduction:'Here are the matching items.'}};}});
  assert.equal(batches,0);for(const row of rows)assert.ok(answer.includes(row.title));
  const fallback=await assistantReply(fixture(),question2,{now,generate:async()=>{throw new Error('model unavailable');}});
  assert.ok(fallback.includes(cases[0].title));assert.ok(fallback.includes(cases[4].title));
});
test('cancelled/dismissed records excluded; all-day and missing-time deadlines retained',async()=>{
  const records=[{...cases[0],cancelled:true},{...cases[1],status:'dismissed'},{...cases[2],allDay:true,endDate:'2026-12-05'}];
  const answer=await assistantReply(fixture(records),question2,{now,generate:failModel});
  assert.ok(answer.includes(cases[2].title));assert.match(answer,/All day/);assert.match(answer,/No time set/);
  assert.ok(!answer.includes(cases[0].title));assert.ok(!answer.includes(cases[1].title));
});
test('actual owner-scoped database prevents another student’s record reaching prompt or answer',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'brb-assistant-range-'));
  const db=await openDatabase({dataDir:root,databaseUrl:null,production:false});
  try{
    const a=db.forUser('student-a'),b=db.forUser('student-b');
    await a.put('events',cases[0].id,cases[0]);
    await b.put('events','private-other',{...cases[1],id:'private-other',title:'PRIVATE_OTHER_STUDENT'});
    const answer=await assistantReply(a,question2,{now,generate:async(prompt)=>{assert.doesNotMatch(prompt,/PRIVATE_OTHER_STUDENT/);return failModel();}});
    assert.ok(answer.includes(cases[0].title));assert.doesNotMatch(answer,/PRIVATE_OTHER_STUDENT/);
  }finally{await db.close();await rm(root,{recursive:true,force:true});}
});
test('long Telegram answers are numbered and retain every character across transport-sized parts',()=>{
  const answer=Array.from({length:100},(_,i)=>`- Deadline ${i}: ${'source evidence '.repeat(12)}\n`).join('');
  const parts=splitAssistantAnswer(answer);
  assert.ok(parts.length>1);assert.ok(parts.every(p=>p.length<=3900));
  assert.equal(parts.map(p=>p.replace(/^Answer \d+ of \d+\n/,'')).join(''),answer);
  assert.deepEqual(splitAssistantAnswer('Short answer'),['Short answer']);
});


test('Canvas rows match this week, next seven days, before Thanksgiving and December 4',async()=>{
  for(const [question,ids] of [
    ['What deadlines do I have this week?',['hw4-review']],
    ['What is due in the next 7 days?',['hw4-review']],
    ['What is due before Thanksgiving?',['hw4-review']],
    ["What's on Dec 4?",['homework4','demo-day','maker-demo']],
    ['What is due next week?',['final-scoring']],
    ['next 7 days',['hw4-review','ordinary-class','social']],
    ['before Thanksgiving',['hw4-review','ordinary-class','social']],
    ['Dec 4',['homework4','demo-day','maker-demo']],
  ]){
    const rows=await scheduleRecords(fixture(),scheduleQuery(question,{now}));
    assert.deepEqual(rows.map(row=>row.id),ids,question);
  }
});

test('between now and a date excludes elapsed same-day events without hiding unknown times',async()=>{
  const events=[
    normalizeEvent({id:'past',title:'Earlier today',kind:'assignment',date:'2026-11-20',time:'08:00'}),
    normalizeEvent({id:'future',title:'Later today',kind:'assignment',date:'2026-11-20',time:'11:00'}),
    {...cases[0],id:'unknown',date:'2026-11-20'},
    {...cases[0],id:'all-day',date:'2026-11-20',allDay:true,start:'2026-11-20T05:00:00Z',endDate:'2026-11-21'},
  ];
  const answer=await assistantReply(fixture(events),question2,{now,generate:failModel});
  assert.doesNotMatch(answer,/Earlier today/);assert.match(answer,/Later today/);
  assert.match(answer,/Time needs confirmation/);assert.match(answer,/No time set/);
  const missing=await scheduleRecords(fixture(events),scheduleQuery(question1,{now}));
  assert.deepEqual(missing.map(e=>e.id).sort(),['all-day','unknown']);
});
