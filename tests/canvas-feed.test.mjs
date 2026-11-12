import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {canvasFeedURL,parseCanvasFeed,canvasEvent,syncCanvasFeed,connectCanvasFeed,disconnectCanvasFeed,readCanvasStatus,saveCourseAIPolicy} from '../lib/canvas-feed.mjs';
import {reminderSpecs,calendarICS} from '../lib/domain.mjs';
import {calendarDescription} from '../lib/calendar-description.mjs';
import {reminderText} from '../lib/integrations.mjs';

// Synthetic feed in Canvas's export format. Never real student data.
const FEED_URL='https://canvas.cornell.edu/feeds/calendars/user_SyntheticToken0123456789abcdefghij.ics';
const NOW=Date.parse('2026-11-12T13:00:00Z');
const feed=(extra='')=>['BEGIN:VCALENDAR','VERSION:2.0','PRODID:icalendar-ruby','X-WR-CALNAME:Sample Student Calendar (Canvas)',
 'BEGIN:VEVENT','UID:event-assignment-1001','DTSTART;VALUE=DATE:20261113','DTEND;VALUE=DATE:20261113','SUMMARY:HW3: Build It\\, Then Measure It [NBAY6170]',
 'DESCRIPTION:Fit a model on the provided data and report test accuracy.\\nSubmit a two-page memo.','URL;VALUE=URI:https://canvas.cornell.edu/calendar?include_contexts=course_1&month=11&year=2026#assignment_1001','END:VEVENT',
 'BEGIN:VEVENT','UID:event-assignment-override-1002','DTSTART:20261116T134000Z','DTEND:20261116T134000Z','SUMMARY:Quiz: Bias and Ethics  (LEC030) [INFO6410/CS5682]','DESCRIPTION:','END:VEVENT',
 'BEGIN:VEVENT','UID:event-calendar-event-2001','DTSTART:20261113T170000Z','DTEND:20261113T231000Z','SUMMARY:Maker Day 3 [TECH5900]','DESCRIPTION:Build\\, present\\, peer','  feedback','LOCATION:Tata Innovation Center','END:VEVENT',
 'BEGIN:VEVENT','UID:event-assignment-old','DTSTART;VALUE=DATE:20261020','SUMMARY:Past homework [NBAY6170]','END:VEVENT',
 extra,'END:VCALENDAR'].filter(Boolean).join('\r\n');
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'brb-canvas-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true}),store=db.forUser('student');t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});return {db,store};}
const respond=(text,status=200)=>async(url,options)=>{assert.equal(url,FEED_URL);assert.equal(options.redirect,'error');return new Response(text,{status});};

test('only Cornell Canvas calendar feed links are accepted',()=>{
 assert.equal(canvasFeedURL(` ${FEED_URL} `),FEED_URL);
 for(const bad of ['http://canvas.cornell.edu/feeds/calendars/user_SyntheticToken0123456789abcdefghij.ics','https://canvas.cornell.edu.evil.test/feeds/calendars/user_SyntheticToken0123456789abcdefghij.ics','https://canvas.cornell.edu/courses/86989','https://canvas.cornell.edu/feeds/calendars/user_SyntheticToken0123456789abcdefghij.ics?x=1','https://me:pw@canvas.cornell.edu/feeds/calendars/user_SyntheticToken0123456789abcdefghij.ics','https://canvas.cornell.edu:8443/feeds/calendars/user_SyntheticToken0123456789abcdefghij.ics','https://127.0.0.1/feeds/calendars/user_x.ics',null])assert.throws(()=>canvasFeedURL(bad),/Calendar Feed link/);
});

test('the parser reads assignments, quizzes, course events, course codes, and unfolded descriptions',()=>{
 const {items}=parseCanvasFeed(feed()),[hw,quiz,maker]=items;
 assert.equal(items.length,4);assert.equal(hw.type,'assignment');assert.equal(hw.title,'HW3: Build It, Then Measure It');assert.equal(hw.courseCode,'NBAY 6170');assert.deepEqual(hw.start,{allDay:true,date:'2026-11-13'});assert.match(hw.description,/report test accuracy\.\nSubmit a two-page memo/);
 assert.equal(quiz.courseCode,'INFO 6410/CS 5682');assert.equal(maker.type,'calendar');assert.equal(maker.description,'Build, present, peer feedback');
 const due=canvasEvent(hw);assert.equal(due.title,'Due: HW3: Build It, Then Measure It · NBAY 6170');assert.equal(due.allDay,true);assert.equal(due.endDate,'2026-11-14');assert.equal(due.kind,'assignment');assert.equal(due.aiPolicy,'study');
 const q=canvasEvent(quiz);assert.equal(q.kind,'quiz');assert.equal(q.date,'2026-11-16');assert.equal(q.time,'08:40');
 const m=canvasEvent(maker);assert.equal(m.kind,'class');assert.equal(m.time,'12:00');assert.equal(m.end,'2026-11-13T23:10:00.000Z');assert.equal(m.location,'Tata Innovation Center');
 assert.throws(()=>parseCanvasFeed('<html>login</html>'),/did not return a Canvas calendar/);
});

test('all-day deadlines get one reminder at 9 AM the day before, in Telegram and Google Calendar',()=>{
 const due={...canvasEvent(parseCanvasFeed(feed()).items[0]),status:'approved',sourceName:'Canvas · NBAY 6170'};
 const [spec]=reminderSpecs(due);assert.equal(spec.minutes,900);assert.equal(spec.due,'2026-11-12T14:00:00.000Z');
 assert.match(reminderText(due,900),/^Due tomorrow · Friday, Nov 13\nDue: HW3/);
 assert.deepEqual(reminderSpecs({...due,kind:'class'}),[]);assert.deepEqual(reminderSpecs({...due,status:'review'}),[]);
 const ics=calendarICS([due]).replace(/\r\n /g,'');assert.match(ics,/DTSTART;VALUE=DATE:20261113/);assert.match(ics,/DTEND;VALUE=DATE:20261114/);
 const description=calendarDescription(due);assert.match(description,/Act as my tutor/);assert.match(description,/Fit a model on the provided data/);assert.match(description,/https:\/\/canvas\.cornell\.edu\/calendar/);
});

test('sync imports items for review, keeps the link secret, and leaves past items alone',async t=>{
 const {store}=await fixture(t);assert.equal((await syncCanvasFeed(store,{fetchImpl:respond(feed()),now:NOW})).reason,'not-connected');
 await connectCanvasFeed(store,FEED_URL,{now:NOW});const result=await syncCanvasFeed(store,{fetchImpl:respond(feed()),now:NOW});
 assert.equal(result.added,4);const events=(await store.all('events')).filter(e=>e.connector==='canvas');assert.equal(events.length,4);assert.ok(events.every(e=>e.status==='review'));
 const status=await readCanvasStatus(store);assert.equal(status.connected,true);assert.deepEqual(status.courses,['INFO 6410/CS 5682','NBAY 6170','TECH 5900']);assert.equal(status.policies['NBAY 6170'],'study');
 assert.doesNotMatch(JSON.stringify(status)+JSON.stringify(await store.all('sources'))+JSON.stringify(events),/SyntheticToken/);
 const again=await syncCanvasFeed(store,{fetchImpl:respond(feed()),now:NOW});assert.equal(again.added,0);assert.equal(again.unchanged,4);
});

test('changed items reopen review, removed upcoming items need confirmation, and AI policy follows the course',async t=>{
 const {store}=await fixture(t);await connectCanvasFeed(store,FEED_URL,{now:NOW});await syncCanvasFeed(store,{fetchImpl:respond(feed()),now:NOW});
 for(const e of await store.all('events'))await store.put('events',e.id,{...e,status:'approved'});
 const changed=feed().replace('DTSTART;VALUE=DATE:20261113','DTSTART;VALUE=DATE:20261114').replace(/BEGIN:VEVENT\r\nUID:event-calendar-event-2001[\s\S]*?END:VEVENT\r\n/,'').replace(/BEGIN:VEVENT\r\nUID:event-assignment-old[\s\S]*?END:VEVENT\r\n/,'');
 const result=await syncCanvasFeed(store,{fetchImpl:respond(changed),now:NOW});assert.equal(result.reopened,1);assert.equal(result.removed,1);
 const rows=Object.fromEntries((await store.all('events')).map(e=>[e.canvasUid,e]));
 assert.equal(rows['event-assignment-1001'].status,'review');assert.equal(rows['event-assignment-1001'].date,'2026-11-14');assert.match(rows['event-assignment-1001'].warning,/changed this item since you approved/);
 assert.equal(rows['event-calendar-event-2001'].cancelled,true);assert.equal(rows['event-assignment-old'].cancelled,undefined);
 const saved=await saveCourseAIPolicy(store,{courseCode:'NBAY6170',policy:'none'});assert.equal(saved.courseCode,'NBAY 6170');
 assert.equal((await store.all('events')).find(e=>e.canvasUid==='event-assignment-1001').aiPolicy,'none');
 await syncCanvasFeed(store,{fetchImpl:respond(changed),now:NOW});assert.equal((await store.all('events')).find(e=>e.canvasUid==='event-assignment-1001').aiPolicy,'none');
 await assert.rejects(saveCourseAIPolicy(store,{courseCode:'NBAY 6170',policy:'answers'}),{status:400});
});

test('a rejected feed link reports a fix without touching imported items, and disconnect keeps them',async t=>{
 const {store}=await fixture(t);await connectCanvasFeed(store,FEED_URL,{now:NOW});await syncCanvasFeed(store,{fetchImpl:respond(feed()),now:NOW});
 await assert.rejects(syncCanvasFeed(store,{fetchImpl:respond('nope',401),now:NOW}),/Copy a fresh Calendar Feed link/);
 assert.match((await readCanvasStatus(store)).lastError,/fresh Calendar Feed link/);assert.equal((await store.all('events')).length,4);
 await disconnectCanvasFeed(store);assert.equal(await store.get('secrets','canvasFeed'),null);assert.equal((await readCanvasStatus(store)).connected,false);assert.equal((await store.all('events')).length,4);
});
