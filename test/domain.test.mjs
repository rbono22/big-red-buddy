import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { localISO, normalizeEvent, parseNBAY, parseStudioExample, reminderSpecs, calendarICS, idFor } from '../lib/domain.mjs';
import { openStore } from '../lib/store.mjs';
import { openDatabase } from '../lib/database.mjs';
import { pdfText, persistCandidates } from '../lib/ingest.mjs';
import { reconcileReminders, dispatchReminders, fetchJobs, pollJobBoards, ingestSlackMessage } from '../lib/integrations.mjs';
test('New York times respect the fall DST transition and invalid dates are rejected', () => {
  assert.equal(localISO('2026-10-28', '13:25'), '2026-10-28T17:25:00.000Z');
  assert.equal(localISO('2026-11-09', '13:25'), '2026-11-09T18:25:00.000Z');
  assert.throws(() => localISO('2026-02-30', '10:00'));
  assert.throws(() => localISO('2026-03-08', '02:30'));
});
const syllabusFixture = process.env.SYLLABUS_PDF_PATH || path.join(homedir(), 'Downloads', 'NBAY 5300 CT Syllabus_Fall2026.pdf');
test('NBAY schedule accepts Markdown table rows without losing paper assignments', () => {
  const text='NBAY 5300 Fall 2026 1:25-2:40 pm\fWeekly Schedule of Topics\n| Week | Class | Date | Topic | Due |\n| --- | --- | --- | --- | --- |\n| 3 | 5 | 10/28/2026 | Venture deals | 1 |\n| 5 | 8 | 11/9/2026 | Valuation | 2 |\n| 6 | 10 | 11/16/2026 | Funding | 3 |\n| 7 | | 11/25/2026 | Thanksgiving Break | |';
  const events=parseNBAY(text);
  assert.deepEqual(events.filter(e=>e.kind==='assignment').map(e=>[e.title,e.date]),[
    ['NBAY 5300 · Problem set 1','2026-10-28'],['NBAY 5300 · Problem set 2','2026-11-09'],['NBAY 5300 · Problem set 3','2026-11-16']
  ]);
  assert.deepEqual(events.filter(e=>e.kind==='class').map(e=>e.title),['NBAY 5300 · Venture deals','NBAY 5300 · Valuation','NBAY 5300 · Funding']);
  assert.match(events[0].evidence,/\| Venture deals \| 1 \|/);
  assert.equal(events.some(e=>e.date==='2026-11-25'),false);
});
test('Supplied syllabus yields exact class dates, three paper problem sets, a quiz, and the separate exam time', {skip:!existsSync(syllabusFixture)}, async () => {
  const text = await pdfText(syllabusFixture);
  const events = parseNBAY(text);
  assert.equal(events.length, 19);
  assert.equal(events.filter(e => e.kind === 'class').length, 14);
  assert.equal(events.some(e => e.date === '2026-11-25'), false);
  assert.deepEqual(events.filter(e => e.kind === 'assignment').map(e => [e.date, e.time]), [['2026-10-28', '13:25'], ['2026-11-09', '13:25'], ['2026-11-16', '13:25']]);
  const exam = events.find(e => e.kind === 'exam');
  assert.equal(exam.start, '2026-12-11T14:00:00.000Z');
  assert.equal(exam.end, '2026-12-11T16:00:00.000Z');
  assert.equal(exam.location, '');
  assert.equal(exam.page, 3);
  const quiz = events.find(e => e.kind === 'quiz');
  assert.equal(quiz.start, '2026-10-19T03:00:00.000Z');
  assert.ok(events.every(e => e.status === 'review'));
});
test('Studio keeps Milestone 5 time unknown and Maker Day 3 explicitly at 5 pm', () => {
  const events = parseStudioExample('Milestone 5 and Maker Day 3 uploads are due Friday November 13. Maker Day 3: Upload slides by 5:00 p.m. on Nov 13.');
  assert.equal(events.length, 2);
  assert.equal(events[0].start, null);
  assert.equal(events[1].start, '2026-11-13T22:00:00.000Z');
  assert.deepEqual(reminderSpecs({
    ...events[0],
    status: 'approved'
  }), []);
});
test('Only approved timed items produce alarms; ICS escapes untrusted content and uses UTC', () => {
  const e = {
    ...normalizeEvent({
      title: 'Class, one; two\nEND:VEVENT',
      date: '2026-11-11',
      time: '13:25',
      kind: 'class',
      location: 'Tata L23'
    }),
    id: 'test',
    sourceName: 'source',
    status: 'approved'
  };
  const output = calendarICS([e, {
    ...e,
    id: 'review',
    status: 'review'
  }, {
    ...e,
    id: 'no-time',
    start: null
  }]);
  assert.equal((output.match(/BEGIN:VEVENT/g) || []).length, 1);
  assert.match(output, /TRIGGER:-PT10M/);
  assert.match(output, /DTSTART:20261111T182500Z/);
  assert.match(output, /Class\\, one\\; two\\nEND:VEVENT/);
  assert.equal(reminderSpecs({
    ...e,
    kind: 'exam'
  }).length, 2);
  for (const line of output.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
});
test('Student records and credentials are encrypted; key is required to read them', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dabas-store-test-'));
  const store = openStore(root);
  try {
    await store.put('secrets', 'test', {
      token: 'PRIVATE-TOKEN-CONTENT'
    });
    assert.equal((await store.get('secrets', 'test')).token, 'PRIVATE-TOKEN-CONTENT');
    const payload = store.db.prepare('SELECT payload FROM records').get().payload;
    assert.ok(!payload.includes('PRIVATE-TOKEN-CONTENT'));
    assert.equal(readFileSync(path.join(root, 'local.key')).length, 32);
  } finally {
    store.close();
    rmSync(root, {
      recursive: true
    });
  }
});
test('Repeated import is idempotent, date changes reopen review, and obsolete reminders are removed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dabas-import-test-'));
  const store = openStore(root);
  try {
    const source = {
      id: 'source',
      name: 'test'
    };
    const e = normalizeEvent({
      title: 'Class',
      kind: 'class',
      date: '2027-01-11',
      time: '13:00'
    });
    await persistCandidates(store, source, [e]);
    const first = (await store.all('events'))[0];
    await store.put('events', first.id, {
      ...first,
      status: 'approved'
    });
    await persistCandidates(store, source, [e]);
    assert.equal((await store.all('events')).length, 1);
    assert.equal((await store.all('events'))[0].status, 'approved');
    await reconcileReminders(store);
    assert.equal((await store.all('reminders')).length, 1);
    await persistCandidates(store, source, [normalizeEvent({
      ...e,
      time: '14:00'
    })]);
    assert.equal((await store.all('events'))[0].status, 'review');
    await reconcileReminders(store);
    assert.equal((await store.all('reminders')).length, 0);
  } finally {
    store.close();
    rmSync(root, {
      recursive: true
    });
  }
});
test('Scheduler does not send when Telegram is unlinked or reminders are paused', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dabas-scheduler-test-'));
  const store = openStore(root);
  try {
    assert.equal((await dispatchReminders(store)).reason, 'telegram-not-linked');
    await store.put('settings', 'profile', {
      paused: true
    });
    assert.equal((await dispatchReminders(store)).reason, 'paused');
  } finally {
    store.close();
    rmSync(root, {
      recursive: true
    });
  }
});
test('Accepted reminders are sent once; uncertain Telegram outcomes are held for review rather than retried', async t => {
  const previousToken=process.env.TELEGRAM_BOT_TOKEN;process.env.TELEGRAM_BOT_TOKEN='TEST_ONLY_FAKE_TOKEN';
  t.after(()=>{if(previousToken===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=previousToken;});
  const root = mkdtempSync(path.join(tmpdir(), 'dabas-delivery-test-'));
  const database=await openDatabase({dataDir:root,databaseUrl:null,production:false}),store=database.forUser('delivery-student');
  let calls = 0,
    fail = false;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (fail) throw new Error('connection lost after sending');
    return {
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          message_id: 123
        }
      })
    };
  });
  try {
    await store.put('secrets', 'telegram', {
      token: 'test-only-token',
      chatId: 123
    });
    await store.put('settings', 'profile', {
      paused: false
    });
    const makeEvent = id => ({
      id,
      title: 'Test reminder',
      kind: 'class',
      date: '2027-01-01',
      start: new Date(Date.now() + 601000).toISOString(),
      end: new Date(Date.now() + 4201000).toISOString(),
      status: 'approved',
      sourceName: 'test',
      location: 'Test room'
    });
    await store.put('events', 'one', makeEvent('one'));
    await reconcileReminders(store);
    let r = (await store.all('reminders'))[0];
    await store.put('reminders', r.id, {
      ...r,
      due: new Date(Date.now() - 100).toISOString()
    });
    assert.equal((await dispatchReminders(store)).sent, 1);
    assert.equal((await dispatchReminders(store)).sent, 0);
    assert.equal(calls, 1);
    await store.put('events', 'two', makeEvent('two'));
    await reconcileReminders(store);
    r = (await store.all('reminders')).find(r => r.eventId === 'two');
    await store.put('reminders', r.id, {
      ...r,
      due: new Date(Date.now() - 100).toISOString()
    });
    fail = true;
    await dispatchReminders(store);
    assert.equal((await store.get('reminders', r.id)).status, 'needs-review');
    await dispatchReminders(store);
    assert.equal(calls, 2);
  } finally {
    await database.close();
    rmSync(root, {
      recursive: true
    });
  }
});
test('Employer refresh registers a six-hour cadence, skips premature polls, and marks removed roles closed', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'dabas-jobs-test-'));
  const database=await openDatabase({dataDir:root,databaseUrl:null,production:false}),store=database.forUser('jobs-student');
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({
        jobs: [{
          id: 'current',
          title: 'AI Engineer',
          location: 'New York',
          descriptionPlain: 'Build useful software.',
          jobUrl: 'https://example.com/jobs/current',
          applyUrl: 'https://example.com/jobs/current'
        }]
      })
    };
  });
  try {
    await store.put('settings', 'profile', {
      jobTitles: 'AI Engineer'
    });
    await store.put('jobs', 'old', {
      id: 'old',
      externalId: 'removed',
      provider: 'ashby',
      board: 'example',
      status: 'discovered'
    });
    assert.equal((await fetchJobs(store, 'example', 'ashby')).count, 1);
    assert.equal((await store.get('jobs', 'old')).status, 'closed');
    assert.ok((await store.get('settings', 'jobBoards')).boards[0].nextRun > Date.now() + 5 * 3600000);
    await pollJobBoards(store);
    assert.equal(calls, 1);
  } finally {
    await database.close();
    rmSync(root, {
      recursive: true
    });
  }
});
test('Non-date Studio announcements are retained with a source link without inventing calendar dates', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dabas-studio-test-'));
  const store = openStore(root);
  try {
    await store.put('secrets', 'slack', {
      channel: 'CEXAMPLE'
    });
    await ingestSlackMessage(store, {
      channel: 'CEXAMPLE',
      ts: '1234.5678',
      user: 'UTEACHER',
      text: 'Important: please read your team feedback in Miro before the next review.'
    });
    assert.equal((await store.all('events')).length, 0);
    assert.equal((await store.all('sources')).length, 1);
    assert.match((await store.all('sources'))[0].url, /CEXAMPLE\/p12345678/);
    await ingestSlackMessage(store, {
      channel: 'COTHER',
      ts: '1.0',
      text: 'Important feedback'
    });
    assert.equal((await store.all('sources')).length, 1);
  } finally {
    store.close();
    rmSync(root, {
      recursive: true
    });
  }
});
