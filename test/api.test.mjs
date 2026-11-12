import {ingestCampusSnapshot} from '../lib/campus-calendar.mjs';
import {startApplicationTracking} from '../lib/application-tracker.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '../lib/database.mjs';
import { createQueue } from '../lib/queue.mjs';

const origin = 'http://127.0.0.1:4349';
const announcement = 'Milestone 5 and Maker Day 3 PDF uploads are due Friday November 13. Maker Day 3: upload by 5:00 p.m. on Nov 13.';
async function eventually(fn, timeout = 12000) {
  const until = Date.now() + timeout; let last;
  while (Date.now() < until) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await delay(80); }
  throw last || new Error('Timed out waiting for condition.');
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 11000); timer.unref();
  try { await exited; } finally { clearTimeout(timer); }
}
test('authenticated API isolates students and durable extraction survives worker and web restarts', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dabas-tenant-api-test-')), encryptionKey = randomBytes(32).toString('hex');
  // Never inherit personal provider credentials or database URLs into the fixture processes.
  const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '4349', APP_ORIGIN: origin, ASSISTANT_DATA: dir, DATA_ENCRYPTION_KEY: encryptionKey, SESSION_SECRET: randomBytes(32).toString('base64'), DEV_AUTH_EMAILS: 'student1@cornell.edu,student2@cornell.edu', OLLAMA_URL: 'http://127.0.0.1:1', WORKER_HEARTBEAT_PATH: path.join(dir, 'worker-heartbeat'), WORKER_ROLE: 'model', WORKER_CONCURRENCY: '1' };
  let web, worker, database, queue;
  const children = [];
  function launch(script) {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], { cwd: path.resolve(import.meta.dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.output = ''; child.stdout.on('data', chunk => { child.output += chunk; }); child.stderr.on('data', chunk => { child.output += chunk; }); children.push(child); return child;
  }
  async function startWeb() {
    web = launch('server.mjs');
    try { await eventually(async () => (await fetch(`${origin}/healthz`)).ok); }
    catch { throw new Error(`Test server failed to start: ${web.output}`); }
  }
  async function login(email) {
    const response = await fetch(`${origin}/auth/dev`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const context = await (await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } })).json();
    assert.equal(context.user.email, email); assert.ok(context.csrfToken);
    return { ...context, cookie };
  }
  async function api(user, route, payload, extraHeaders = {}) {
    const response = await fetch(`${origin}${route}`, { method: payload === undefined ? 'GET' : 'POST', headers: { Cookie: user.cookie, ...(payload === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': user.csrfToken }), ...extraHeaders }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const text = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
  }
  try {
    await startWeb();
    assert.equal((await fetch(origin)).status, 200);
    for (const route of ['/api/state', '/api/tasks', '/api/evaluation.json', '/api/calendar.ics', '/api/career/applications', '/api/luma/calendars']) assert.equal((await fetch(`${origin}${route}`)).status, 401);
    const alice = await login('student1@cornell.edu'), bob = await login('student2@cornell.edu');
    assert.notEqual(alice.user.id, bob.user.id);
    assert.equal((await api(alice, '/api/settings', { name: 'forbidden' }, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await api(alice, '/api/settings', { name: 'forbidden' }, { 'X-CSRF-Token': bob.csrfToken })).status, 403);
    assert.equal((await api(alice, '/api/settings', {}, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await api(alice, '/api/state', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await api(alice, '/api/operations')).status, 403);
    database = await openDatabase({ dataDir: dir, databaseUrl: null, encryptionKey, production: false });
    queue = await createQueue(database, { workerDatabaseUrl: null });
    const aStore = database.forUser(alice.user.id), bStore = database.forUser(bob.user.id);
    await aStore.put('documents', 'resume', { name: 'Alice private resume.pdf', text: 'ALICE_PRIVATE_RESUME_TEXT', file: 'ALICE_PRIVATE_PDF_BYTES', updatedAt: new Date().toISOString() });
    await aStore.put('secrets', 'google', { refresh_token: 'ALICE_PRIVATE_REFRESH_TOKEN', access_token: 'ALICE_PRIVATE_ACCESS_TOKEN', calendarId: 'alice-calendar' });
    await aStore.put('secrets', 'slack', { userToken: 'ALICE_PRIVATE_SLACK_TOKEN', userId: 'UALICE', teamId: 'TCORNELL' });
    assert.equal((await api(alice,'/api/daily-briefing/settings',{time:'07:30',enabled:true})).status,200);
    assert.equal((await api(bob,'/api/state')).body.dailyBriefing.time,'08:00');
    assert.equal((await api(alice,'/api/daily-briefing/settings',{time:'25:00'})).status,400);
    assert.equal((await api(alice,'/api/daily-briefing/settings',{time:'08:00'},{'X-CSRF-Token':''})).status,403);
    await ingestCampusSnapshot(aStore,{calendarId:'fixture-campus-a',calendarName:'Fixture Campus',windowStart:'2026-11-10T00:00:00Z',windowEnd:'2027-01-30T00:00:00Z',items:[{id:'campus-one',summary:'Alice campus gathering',start:{dateTime:'2026-11-20T17:00:00-05:00'},end:{dateTime:'2026-11-20T18:00:00-05:00'},description:'Event Details: https://cornelltech.campusgroups.com/rsvp?id=2133121',location:'Sign in to download the location'}]});
    const campusItem=(await aStore.all('campusEvents'))[0];
    assert.equal((await api(alice,'/api/campus/settings',{autoAdd:true},{'X-CSRF-Token':''})).status,403);
    assert.equal((await api(alice,'/api/campus/settings',{autoAdd:'yes'})).status,400);
    assert.equal((await api(alice,'/api/campus/settings',{autoAdd:false})).status,200);
    assert.equal((await api(alice,'/api/campus/settings',{autoAdd:true})).status,403);
    assert.equal((await api(bob,'/api/state')).body.campusCalendar,null);
    assert.equal((await api(bob,'/api/campus/add',{id:campusItem.id})).status,404);
    assert.equal((await api(bob,'/api/state')).body.campusEvents.length,0);
    const campusAdded=await api(alice,'/api/campus/add',{id:campusItem.id});assert.equal(campusAdded.status,200);
    assert.ok((await aStore.all('events')).some(e=>e.kind==='event'&&e.sourceUrl==='https://cornelltech.campusgroups.com/rsvp?id=2133121'));
    assert.equal((await api(alice,'/api/daily-briefing/preview')).status,200);
    const partifulId='f'.repeat(32);
    await aStore.put('settings','partifulCalendar',{calendarId:'fixture-partiful-a',calendarName:'Partiful',autoAdd:false,continuous:false});
    await aStore.put('partifulEvents',partifulId,{id:partifulId,sourceCalendarId:'fixture-partiful-a',sourceCalendarName:'Partiful',remoteId:'party-one',title:'Alice private Partiful gathering',status:'available',date:'2026-11-20',time:'18:00',start:'2026-11-20T23:00:00Z',end:'2026-11-21T01:00:00Z',location:'Event location',rsvpUrl:'https://partiful.com/e/ExampleEvent123',warnings:[]});
    assert.equal((await api(bob,'/api/state')).body.partifulEvents.length,0);
    assert.equal((await api(bob,'/api/partiful/add',{id:partifulId})).status,404);
    assert.equal((await api(bob,'/api/partiful/intent',{id:partifulId,intent:'going'})).status,404);
    assert.equal((await api(alice,'/api/partiful/intent',{id:partifulId,intent:'going'},{'X-CSRF-Token':''})).status,403);
    assert.equal((await api(alice,'/api/partiful/intent',{id:partifulId,intent:'invalid'})).status,400);
    assert.equal((await api(alice,'/api/partiful/intent',{id:partifulId,intent:'maybe'})).status,200);
    assert.equal((await aStore.get('partifulEvents',partifulId)).localIntent,'maybe');
    assert.equal((await api(alice,'/api/partiful/settings',{autoAdd:'yes'})).status,400);
    assert.equal((await api(alice,'/api/partiful/add',{id:partifulId})).status,200);
    assert.equal((await api(bob,'/api/partiful/calendars')).status,403);
    const lumaId='e'.repeat(32);
    await aStore.put('settings','lumaCalendar',{calendarId:'fixture-luma-a',calendarName:'Luma',autoAdd:false,continuous:false});
    await aStore.put('lumaEvents',lumaId,{id:lumaId,sourceCalendarId:'fixture-luma-a',sourceCalendarName:'Luma',remoteId:'luma-one',title:'Alice private Luma event',status:'available',date:'2026-11-20',time:'18:00',start:'2026-11-20T23:00:00Z',end:'2026-11-21T01:00:00Z',location:'Event location',rsvpUrl:'https://luma.com/brf-fixture-event',warnings:[]});
    assert.equal((await api(bob,'/api/state')).body.lumaEvents.length,0);
    assert.equal((await api(bob,'/api/luma/add',{id:lumaId})).status,404);
    assert.equal((await api(bob,'/api/luma/intent',{id:lumaId,intent:'going'})).status,404);
    assert.equal((await api(alice,'/api/luma/intent',{id:lumaId,intent:'going'},{'X-CSRF-Token':''})).status,403);
    assert.equal((await api(alice,'/api/luma/intent',{id:lumaId,intent:'invalid'})).status,400);
    assert.equal((await api(alice,'/api/luma/intent',{id:lumaId,intent:'maybe'})).status,200);
    assert.equal((await aStore.get('lumaEvents',lumaId)).localIntent,'maybe');
    assert.equal((await aStore.get('partifulEvents',partifulId)).localIntent,'maybe');
    assert.equal((await api(alice,'/api/luma/settings',{autoAdd:'yes'})).status,400);
    assert.equal((await api(alice,'/api/luma/settings',{autoAdd:true})).status,403);
    assert.equal((await api(alice,'/api/luma/add',{id:lumaId})).status,200);
    assert.equal((await api(bob,'/api/luma/calendars')).status,403);
    assert.equal((await api(bob,'/api/luma/disconnect',{})).status,200);
    assert.equal((await aStore.get('settings','lumaCalendar')).calendarId,'fixture-luma-a');
    await aStore.put('jobs', 'alice-job', { id: 'alice-job', title: 'Alice role', company: 'Example', match: 1 });
    assert.equal((await api(alice,'/api/career/profile',{fullName:'Alice private applicant',workAuthorizationUS:'yes'})).status,200);
    assert.equal((await api(alice,'/api/career/profile',{veteranStatus:'decline'})).status,400);
    assert.equal((await api(alice,'/api/career/profile',{fullName:'wrong'}, {'X-CSRF-Token':''})).status,403);
    assert.equal((await api(bob,'/api/state')).body.careerProfile.fullName||'','');
    assert.equal((await api(bob,'/api/career/answer-draft',{jobId:'alice-job',question:'Why this company?'})).status,404);
    assert.equal((await api(bob,'/api/career/answer-save',{jobId:'alice-job',question:'Why?',answer:'attack'})).status,404);
    await aStore.put('career','demographics',{values:{disabilityStatus:'yes',gender:'non_binary',race:['asian']},privateMarker:'ALICE_PRIVATE_DEMOGRAPHICS'});
    const careerAnswer=await api(alice,'/api/career/answer-save',{jobId:'alice-job',question:'Why this company?',answer:'ALICE_PRIVATE_CAREER_ANSWER'});
    assert.equal(careerAnswer.status,200);
    assert.equal((await api(bob,'/api/state')).body.applicationAnswers.length,0);
    assert.equal((await api(bob,'/api/career/packet?jobId=alice-job')).status,404);
    const packet=await api(alice,'/api/career/packet?jobId=alice-job');assert.equal(packet.status,200);assert.equal(packet.body.profile.workAuthorizationUS,'yes');assert.equal(packet.body.answers[0].answer,'ALICE_PRIVATE_CAREER_ANSWER');assert.equal(packet.body.status,'prepared-not-submitted');assert.equal(packet.body.profile.disabilityStatus,undefined);assert.equal(packet.body.demographics,undefined);assert.equal(JSON.stringify(packet.body).includes('ALICE_PRIVATE_DEMOGRAPHICS'),false);assert.equal(JSON.stringify((await api(bob,'/api/state')).body).includes('ALICE_PRIVATE_DEMOGRAPHICS'),false);
    assert.equal((await api(bob,'/api/career/answer-save',{id:careerAnswer.body.id,answer:'attack'})).status,404);
    await aStore.put('applications', 'alice-application', { id: 'alice-application', jobId: 'alice-job', title: 'Alice role', company: 'Example', answers: { whyCompany: 'ALICE_PRIVATE_APPLICATION', relevantExperience: 'Example' }, status: 'draft' });
    const tracked=await startApplicationTracking(aStore,await aStore.get('jobs','alice-job'),{source:'telegram',updateId:4321});
    const trackerList=await api(alice,'/api/career/applications');assert.equal(trackerList.status,200);
    assert.ok(trackerList.body.some(row=>row.id===tracked.id&&row.title==='Alice role'));
    assert.equal((await api(bob,'/api/career/applications')).body.length,0);
    assert.equal((await api(bob,'/api/career/application-status',{id:tracked.id,status:'submitted'})).status,404);
    assert.equal((await api(alice,'/api/career/application-status',{id:tracked.id,status:'submitted'},{'X-CSRF-Token':''})).status,403);
    assert.equal((await api(alice,'/api/career/application-status',{id:tracked.id,status:'provider-confirmed'})).status,400);
    const reported=await api(alice,'/api/career/application-status',{id:tracked.id,status:'submitted'});assert.equal(reported.status,200);
    assert.equal(reported.body.status,'submitted');assert.match(reported.body.statusLabel,/student.reported/i);
    assert.equal((await aStore.get('applications','alice-application')).status,'draft');
    assert.equal((await api(alice,'/api/career/application-status',{id:tracked.id,status:'prepared'})).status,200);
    await aStore.put('metrics', 'alice-metric', { task: 'ALICE_PRIVATE_METRIC', ms: 5, at: new Date().toISOString() });
    assert.equal((await api(alice, '/api/events/manual', { title: 'Alice private event', date: '2026-11-20', time: '14:00', location: 'Alice room', userId: bob.user.id })).status, 200);
    assert.equal((await api(bob, '/api/events/manual', { title: 'Bob private event', date: '2026-11-21', time: '15:00', location: 'Bob room', userId: alice.user.id })).status, 200);
    let aState = (await api(alice, '/api/state')).body, bState = (await api(bob, '/api/state')).body;
    const aEvent = aState.events.find(event => event.title === 'Alice private event'), bEvent = bState.events.find(event => event.title === 'Bob private event');
    assert.ok(aEvent); assert.ok(bEvent); assert.equal(bState.events.length, 1);
    assert.equal(aState.resume.name, 'Alice private resume.pdf'); assert.equal(bState.resume, null);
    assert.equal(aState.connections.google.connected, true); assert.equal(bState.connections.google.connected, false);
    assert.equal(aState.connections.slack.configured, true); assert.equal(bState.connections.slack.configured, false);
    assert.equal(bState.applications.length, 0); assert.equal(bState.jobs.length, 0);
    for (const secret of ['ALICE_PRIVATE_RESUME_TEXT', 'ALICE_PRIVATE_PDF_BYTES', 'ALICE_PRIVATE_REFRESH_TOKEN', 'ALICE_PRIVATE_ACCESS_TOKEN', 'ALICE_PRIVATE_SLACK_TOKEN']) assert.equal(JSON.stringify(aState).includes(secret), false);
    assert.equal(JSON.stringify(bState).includes('ALICE_PRIVATE'), false);
    assert.equal((await api(bob, '/api/events/time', { id: aEvent.id, time: '16:00', userId: alice.user.id })).status, 404);
    assert.equal((await api(bob, '/api/events/review', { ids: [bEvent.id, aEvent.id], action: 'approve' })).status, 404);
    assert.equal((await bStore.get('events', bEvent.id)).status, 'review');
    assert.equal((await api(bob, '/api/applications/review', { id: 'alice-application', whyCompany: 'attack' })).status, 404);
    assert.equal((await api(bob, '/api/applications/sandbox-submit', { id: 'alice-application' })).status, 404);
    assert.equal((await api(bob, '/api/jobs/draft', { id: 'alice-job' })).status, 404);
    assert.equal((await api(bob, '/api/disconnect', { service: 'google', userId: alice.user.id })).status, 200);
    assert.equal((await aStore.get('secrets', 'google')).refresh_token, 'ALICE_PRIVATE_REFRESH_TOKEN');
    assert.equal(JSON.stringify((await api(bob, '/api/evaluation.json')).body).includes('ALICE_PRIVATE_METRIC'), false);
    assert.equal((await api(alice, '/api/events/review', { ids: [aEvent.id], action: 'approve' })).status, 200);
    assert.match((await api(alice, '/api/calendar.ics')).body, /Alice private event/);
    assert.doesNotMatch((await api(bob, '/api/calendar.ics')).body, /Alice private event/);
    const pending = await api(alice, '/api/studio/import', { text: announcement, sourceUrl: 'https://cornelltech.slack.com/archives/C0BSGSNHM5J/pfixture1', userId: bob.user.id });
    assert.equal(pending.status, 202);
    assert.equal((await api(alice, '/api/tasks')).body.find(task => task.id === pending.body.taskId).status, 'queued');
    assert.equal((await api(bob, `/api/tasks?id=${pending.body.taskId}`)).body.length, 0);
    worker = launch('worker.mjs');
    await eventually(async () => (await queue.get(alice.user.id, pending.body.taskId))?.status === 'completed');
    aState = (await api(alice, '/api/state')).body;
    const studio = aState.events.filter(event => event.title.startsWith('Product Studio'));
    assert.equal(studio.length, 2); assert.equal((await api(bob, '/api/state')).body.events.length, 1);
    const unresolved = studio.find(event => !event.start), timed = studio.find(event => event.start);
    assert.equal((await api(alice, '/api/events/review', { ids: [unresolved.id], action: 'approve' })).status, 400);
    assert.equal((await api(alice, '/api/events/review', { ids: [timed.id], action: 'approve' })).status, 200);
    assert.match((await api(alice, '/api/calendar.ics')).body, /Product Studio · Maker Day 3/);
    assert.doesNotMatch((await api(alice, '/api/calendar.ics')).body, /SUMMARY:Product Studio · Milestone 5/);
    await stop(worker); worker = null;
    const persisted = await api(alice, '/api/studio/import', { text: announcement, sourceUrl: 'https://cornelltech.slack.com/archives/C0BSGSNHM5J/pfixture2' });
    assert.equal(persisted.status, 202);
    await stop(web); web = null;
    worker = launch('worker.mjs');
    // Complete the queued item while the web process is offline, then reuse persisted sessions.
    await eventually(async () => (await queue.get(alice.user.id, persisted.body.taskId))?.status === 'completed');
    await startWeb();
    assert.equal((await api(alice, '/api/session')).body.user.id, alice.user.id);
    assert.equal((await api(alice, '/api/tasks')).body.find(task => task.id === persisted.body.taskId).status, 'done');
    assert.equal((await api(bob, '/api/tasks')).body.length, 0);
    for (const service of ['google', 'telegram', 'slack']) assert.equal((await api(alice, `/api/${service}/configure`, { token: 'blocked-student-secret' })).status, 404);
    await stop(worker); worker = null;
    await aStore.put('jobs','alice-web-job',{id:'alice-web-job',title:'Website role',company:'Example',location:'New York',description:'Requires 3 years of experience in design.'});
    const webDraft=await api(alice,'/api/jobs/draft',{id:'alice-web-job'});assert.equal(webDraft.status,202);
    const webTracked=(await api(alice,'/api/career/applications')).body.find(row=>row.jobId==='alice-web-job');
    assert.equal(webTracked.source,'web');assert.equal(webTracked.status,'queued');assert.equal(webTracked.taskId,webDraft.body.taskId);
    assert.match(webTracked.experience,/3 years/);
    assert.equal((await api(bob,'/api/career/applications')).body.length,0);
    assert.equal((await api(alice, '/api/delete-data', { confirm: 'DELETE MY DATA' })).status, 200);
    assert.equal((await api(alice, '/api/state')).status, 401);
    for (const bucket of ['documents', 'applications', 'applicationTracker', 'secrets']) await assert.rejects(aStore.all(bucket), /STUDENT_DELETED/);
    assert.equal((await api(bob, '/api/state')).body.events.length, 1);
    if (database.isDeleted) {
      assert.equal(await database.isDeleted(alice.user.id), true);
      const retry = await fetch(`${origin}/auth/dev`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: alice.user.email }) });
      assert.equal(retry.status, 403);
    }
  } finally {
    await Promise.all(children.map(stop));
    await queue?.close(); await database?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
