import test from 'node:test';
import assert from 'node:assert/strict';
import {createCourseCatalog, normalizeCatalog, selectionToEvents, CATALOG_URLS} from '../lib/course-catalog.mjs';

const NOW='2026-11-10T18:00:00.000Z';
function fixture(term='FA26') {
  const startDate=term==='FA26'?'10/14/2026':'01/25/2027',endDate=term==='FA26'?'12/04/2026':'05/11/2027';
  return {schemaVersion:term==='FA26'?3:4,roster:term,sourceUpdatedAt:'2026-08-29T19:24:42-04:00',fetchedAt:'2026-08-30T21:25:02.527Z',courses:[{
    id:'NBAY-5300',code:'NBAY 5300',subject:'NBAY',catalogNumber:'5300',name:'Entrepreneurial Finance',description:'Venture valuation and capital',courseUrl:'https://untrusted.example/redirect',sections:[{
      id:'NBAY-5300-18400',classNumber:18400,component:'LEC',componentName:'Lecture',section:'001',sessionCode:term==='FA26'?'7W2':'1',session:'Published session',location:'NYCTECH',locationDescription:'Cornell Tech',instructionMode:'In Person',instructors:[{name:'Faculty Example'}],meetings:['Mon','Wed'].map(day=>({day,start:805,end:880,startDate,endDate,pattern:'MW',room:'Tata Innovation Center L23'}))
    }]
  }]};
}
const section=raw=>raw.courses[0].sections[0];
const normalized=raw=>normalizeCatalog(raw,{term:raw.roster,fetchedAt:NOW});
const selected=raw=>selectionToEvents(normalized(raw),{courseId:'NBAY-5300',sectionId:'NBAY-5300-18400',approvedAt:NOW});
const response=raw=>new Response(JSON.stringify(raw),{headers:{'content-type':'application/json'}});

test('selected section produces stable approved occurrences and retains evidence and source freshness',()=>{
  const raw=fixture(),a=selected(raw),b=selected(raw);
  assert.equal(a.blocked,false);assert.equal(a.events.length,14);
  assert.deepEqual(a.events.map(e=>e.id),b.events.map(e=>e.id));
  assert.equal(a.source.id,b.source.id);
  assert.equal(a.source.snapshotFetchedAt,'2026-08-30T21:25:02.527Z');
  assert.equal(a.source.fetchedAt,NOW);
  for(const e of a.events){assert.equal(e.kind,'class');assert.equal(e.status,'approved');assert.equal(e.evidenceVerified,true);assert.equal(e.approvalMethod,'explicit-section-selection');assert.equal(e.approvedAt,NOW);assert.equal(e.timezone,'America/New_York');assert.match(e.evidence,/Published Cornell no-class exclusions applied/);assert.equal((Date.parse(e.end)-Date.parse(e.start))/60000,75);}
  assert.equal(a.source.url,'https://classes.cornell.edu/browse/roster/FA26/class/NBAY/5300');
  assert.equal(a.events.some(e=>e.date==='2026-11-25'),false);
  assert.ok(a.skipped.some(e=>e.date==='2026-11-25'&&/Thanksgiving/.test(e.reason)));
});

test('fall and spring daylight-saving changes preserve New York classroom time',()=>{
  const fall=selected(fixture()).events;
  assert.equal(fall.find(e=>e.date==='2026-10-28').start,'2026-10-28T17:25:00.000Z');
  assert.equal(fall.find(e=>e.date==='2026-11-02').start,'2026-11-02T18:25:00.000Z');
  const spring=selected(fixture('SP27')).events;
  assert.equal(spring.find(e=>e.date==='2027-03-10').start,'2027-03-10T18:25:00.000Z');
  assert.equal(spring.find(e=>e.date==='2027-03-15').start,'2027-03-15T17:25:00.000Z');
});

test('all verified no-class dates are excluded, including breaks inside an ordinary range',()=>{
  const raw=fixture();section(raw).sessionCode='1';for(const m of section(raw).meetings){m.startDate='08/24/2026';m.endDate='12/07/2026';}
  const fall=selected(raw);
  for(const date of ['2026-09-07','2026-10-12','2026-11-25'])assert.ok(fall.skipped.some(e=>e.date===date));
  assert.ok(fall.events.some(e=>e.date==='2026-12-07'));
  const spring=selected(fixture('SP27'));
  for(const date of ['2027-02-15','2027-03-29','2027-03-31'])assert.ok(spring.skipped.some(e=>e.date===date));
  assert.ok(spring.events.some(e=>e.date==='2027-04-05'));
});

test('an explicitly dated class conflicting with a holiday is blocked instead of silently erased',()=>{
  const raw=fixture();section(raw).meetings=[{...section(raw).meetings[1],startDate:'11/25/2026',endDate:'11/25/2026'}];
  const result=selected(raw);assert.equal(result.blocked,true);assert.deepEqual(result.events,[]);assert.match(result.blockedReason,/conflicts.*no-class/);
});

test('room missing or TBA stays blank without blocking an otherwise complete schedule',()=>{
  for(const room of [undefined,'TBA','TBD','Room not published']){
    const raw=fixture();for(const m of section(raw).meetings)m.room=room;
    const result=selected(raw);assert.equal(result.blocked,false);assert.ok(result.warnings.some(w=>/rooms are not published/.test(w)));
    assert.ok(result.events.every(e=>e.location===''&&/Room not published/.test(e.warning)));
  }
});

test('duplicate meeting evidence creates only one event and conflicting rooms block the section',()=>{
  const raw=fixture(),original=selected(raw);section(raw).meetings.push(structuredClone(section(raw).meetings[0]));
  const duplicate=selected(raw);assert.equal(duplicate.events.length,original.events.length);assert.ok(duplicate.skipped.some(e=>e.reason==='Duplicate meeting occurrence'));
  section(raw).meetings.at(-1).room='Different room';const conflict=selected(raw);assert.equal(conflict.blocked,true);assert.deepEqual(conflict.events,[]);assert.match(conflict.blockedReason,/disagree about the room/);
});

test('selection is exact, with no guessed default or related section',()=>{
  const raw=fixture(),other=structuredClone(section(raw));other.id='NBAY-5300-18401';other.classNumber=18401;other.section='002';other.meetings=[{...other.meetings[0],day:'Tue',pattern:'T'}];raw.courses[0].sections.push(other);
  const catalog=normalized(raw);
  assert.throws(()=>selectionToEvents(catalog,{courseId:'NBAY-5300'}),{status:400});
  assert.throws(()=>selectionToEvents(catalog,{courseId:'UNKNOWN',sectionId:other.id}),{status:400});
  const chosen=selectionToEvents(catalog,{courseId:'NBAY-5300',sectionId:other.id});
  assert.ok(chosen.events.every(e=>e.sectionId===other.id&&new Date(e.start).getUTCDay()===2));
  assert.notEqual(chosen.source.id,selected(raw).source.id);
});

test('cross-listed aliases with the same registrar class retain occurrence and source identity',()=>{
  const raw=fixture(),alias=structuredClone(raw.courses[0]);alias.id='TECH-5300';alias.subject='TECH';alias.code='TECH 5300';alias.sections[0].id='TECH-5300-18400';raw.courses.push(alias);
  const catalog=normalized(raw),a=selectionToEvents(catalog,{courseId:'NBAY-5300',sectionId:'NBAY-5300-18400'}),b=selectionToEvents(catalog,{courseId:alias.id,sectionId:alias.sections[0].id});
  assert.equal(a.source.id,b.source.id);assert.deepEqual(a.events.map(e=>e.id),b.events.map(e=>e.id));
});

test('Sunday Su and Saturday S are distinct, including the combined SSu pattern',()=>{
  const raw=fixture();section(raw).meetings=['Sat','Sun'].map(day=>({day,start:600,end:660,startDate:'10/17/2026',endDate:'10/18/2026',pattern:'SSu',room:'Tata L23'}));
  const result=selected(raw);assert.equal(result.blocked,false);assert.deepEqual(result.events.map(e=>e.date),['2026-10-17','2026-10-18']);
  section(raw).meetings=[{...section(raw).meetings[1],pattern:'Su'}];assert.equal(selected(raw).events.length,1);
  section(raw).meetings[0].pattern='S';assert.match(selected(raw).blockedReason,/weekday conflicts/);
});

test('missing, invalid, tentative and unsupported meeting evidence blocks all section events',()=>{
  const mutations=[
    s=>{s.meetings[0].start=null;},s=>{s.meetings[0].end=null;},s=>{s.meetings[0].day='TBA';},s=>{s.meetings[0].end=805;},
    s=>{s.meetings[0].startDate='02/30/2026';},s=>{s.meetings[0].startDate='2026-10-99';},s=>{s.meetings[0].tentative=true;},
    s=>{s.meetings[0].scheduleStatus='unpublished';},s=>{s.meetings[0].exceptions=['unknown'];},s=>{s.meetings=[];},
    s=>{s.location='AAPNYC';},s=>{s.sessionCode='UNVERIFIED';},s=>{s.instructionMode='Distance Learning-Asynchronous';},
    s=>{s.meetings[0].endDate='12/08/2026';},s=>{s.meetings[0].endDate='12/07/2026';}
  ];
  for(const change of mutations){const raw=fixture();change(section(raw));const result=selected(raw);assert.equal(result.blocked,true,String(change));assert.deepEqual(result.events,[]);assert.ok(result.blockedReason);}
});

test('original SP27 meeting evidence must be fully scheduled and represented',()=>{
  const raw=fixture('SP27'),s=section(raw);
  s.sourceMeetings=[{id:'source:1',scheduleStatus:'scheduled',days:['Mon','Wed'],start:805,end:880,startDate:'01/25/2027',endDate:'05/11/2027'}];
  for(const m of s.meetings)m.sourceMeetingId='source:1';
  assert.equal(selected(raw).blocked,false);
  s.meetings.pop();assert.match(selected(raw).blockedReason,/fully match/);
  s.sourceMeetings[0].scheduleStatus='unpublished';assert.match(selected(raw).blockedReason,/unpublished/);
  s.sourceMeetings=[null];assert.match(selected(raw).blockedReason,/unpublished/);
});

test('explicit supported exclusions are observed and retain their source',()=>{
  const raw=fixture();section(raw).meetings[0].excludedDates=['11/02/2026'];const result=selected(raw);
  assert.equal(result.events.some(e=>e.date==='2026-11-02'),false);
  assert.ok(result.skipped.some(e=>e.date==='2026-11-02'&&e.reason==='Explicit source exclusion'&&e.sourceUrl===CATALOG_URLS.FA26));
  section(raw).meetings[0].excludedDates=['01/01/2027'];assert.equal(selected(raw).blocked,true);
});

test('DST folds, gaps and cross-transition durations require manual confirmation',()=>{
  for(const [term,date,start,end] of [['FA26','11/01/2026',90,150],['SP27','03/14/2027',150,210],['SP27','03/14/2027',90,210]]){
    const raw=fixture(term);section(raw).sessionCode='1';section(raw).meetings=[{day:'Sun',start,end,startDate:date,endDate:date,pattern:'Su'}];
    const result=selected(raw);assert.equal(result.blocked,true);assert.deepEqual(result.events,[]);assert.match(result.blockedReason,/daylight-saving/i);
  }
});

test('catalog identity collisions cannot silently choose one conflicting schedule',()=>{
  const raw=fixture();raw.courses.push(structuredClone(raw.courses[0]));assert.equal(normalized(raw).courses.length,1);
  raw.courses[1].name='Conflicting course';assert.throws(()=>normalized(raw),/identities disagree/);
  const sections=fixture();sections.courses[0].sections.push(structuredClone(section(sections)));assert.equal(normalized(sections).courses[0].sections.length,1);
  sections.courses[0].sections[1].meetings[0].start=800;assert.throws(()=>normalized(sections),/identities disagree/);
});

test('search is normalized, bounded and excludes internal schedule arrays',async()=>{
  const calls=[],catalog=createCourseCatalog({fetchImpl:async(url,options)=>{calls.push({url,options});return response(fixture());},now:()=>Date.parse(NOW)});
  for(const q of ['NBAY 5300','entrepreneurial finance','faculty example','venture']){
    const result=await catalog.search({q});assert.equal(result.total,1);assert.equal(result.courses.length,1);assert.equal(typeof result.courses[0].sections[0].meetingsSummary,'string');assert.equal(result.courses[0].sections[0].meetings,undefined);assert.equal(result.courses[0].searchable,undefined);
  }
  assert.equal(calls.length,1);assert.equal(calls[0].url,CATALOG_URLS.FA26);assert.equal(calls[0].options.redirect,'error');assert.ok(calls[0].options.signal);
  assert.equal((await catalog.search({q:'not present'})).courses.length,0);
  for(const args of [{term:'https://localhost/private'},{q:'x'.repeat(161)},{q:[]},{limit:0},{limit:101}])await assert.rejects(catalog.search(args),{status:400});
  assert.equal(calls.length,1);
});

test('cache deduplicates concurrent requests, protects cached objects, then expires',async()=>{
  let now=Date.parse(NOW),calls=0,release;const gate=new Promise(resolve=>{release=resolve;});
  const catalog=createCourseCatalog({now:()=>now,cacheTtlMs:1000,fetchImpl:async()=>{calls++;await gate;return response(fixture());}});
  const first=catalog.get('FA26'),second=catalog.get('FA26');release();const [a,b]=await Promise.all([first,second]);assert.equal(calls,1);
  a.courses[0].name='Mutated';assert.notEqual(b.courses[0].name,'Mutated');assert.notEqual((await catalog.get('FA26')).courses[0].name,'Mutated');
  now+=1001;await catalog.get('FA26');assert.equal(calls,2);
});

test('failed or synchronously throwing fetches are not cached or exposed as internal errors',async()=>{
  let calls=0;const catalog=createCourseCatalog({fetchImpl:()=>{if(++calls===1)throw new Error('sensitive upstream failure');return Promise.resolve(response(fixture()));}});
  await assert.rejects(catalog.get('FA26'),error=>error.status===502&&!error.message.includes('sensitive'));
  assert.equal((await catalog.get('FA26')).courses.length,1);assert.equal(calls,2);
});

test('redirects, oversized bodies, unexpected schemas and HTML cannot enter the cache',async()=>{
  const redirected=response(fixture());Object.defineProperty(redirected,'redirected',{value:true});
  const cases=[redirected,new Response('{}',{status:503,headers:{'content-type':'application/json'}}),new Response('{}',{headers:{'content-type':'text/html'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':String(6*1024*1024)}}),new Response('x'.repeat(5*1024*1024+1),{headers:{'content-type':'application/json'}}),response({...fixture(),roster:'SP27'}),response({...fixture(),schemaVersion:999}),new Response('{',{headers:{'content-type':'application/json'}})];
  for(const bad of cases){const catalog=createCourseCatalog({fetchImpl:async()=>bad});await assert.rejects(catalog.get('FA26'),{status:502});}
});

test('no stale cache fallback hides an upstream outage and terms never share data',async()=>{
  let now=Date.parse(NOW),fail=false;const urls=[];
  const catalog=createCourseCatalog({now:()=>now,cacheTtlMs:1000,fetchImpl:async url=>{urls.push(url);if(fail)throw new Error('offline');return response(fixture(url===CATALOG_URLS.FA26?'FA26':'SP27'));}});
  assert.equal((await catalog.get('FA26')).term,'FA26');assert.equal((await catalog.get('SP27')).term,'SP27');assert.equal(urls.length,2);
  now+=1001;fail=true;await assert.rejects(catalog.get('FA26'),{status:502});
});
