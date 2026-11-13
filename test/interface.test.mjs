import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import {DEMOGRAPHIC_FIELDS} from '../lib/demographics.mjs';

async function applicationScript(){
 const scripts=await Promise.all(['schedule-groups.js','career-search.js','app.js'].map(name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8')));
 return scripts.join('\n');
}
function designFixture(events = []) {
  return { profile: { name: 'Test student', paused: false }, events, sources: [], jobs: [], applications: [], reminders: [], activity: [], metrics: [], resume: null, now: '2026-11-10T21:00:00Z', connections: { telegram: { configured: false, linked: false, bot: 'test_bot' }, google: { configured: false, connected: false }, slack: { configured: false, channel: '' }, campusgroups: { connected: false } } };
}
async function renderDesignFixture(fixture, routes = {}, runtime = {}) {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8'), script = await applicationScript();
  const { document, window } = parseHTML(html), listeners = {}, location = { hash: '#overview', href: '' }, requests = [], timers = [];
  const dialog=document.querySelector('#detail-dialog');dialog.showModal=()=>{dialog.open=true;dialog.setAttribute('open','');};dialog.close=()=>{dialog.open=false;dialog.removeAttribute('open');dialog.dispatchEvent(new window.Event('close'));};
  const context = { document, window: { addEventListener: (name, fn) => { listeners[name] = fn; }, scrollTo() {} }, location, URL, Intl, Date, console, setTimeout: () => 0, clearTimeout() {}, setInterval: (callback, ms) => timers.push({ callback, ms }), clearInterval() {}, FileReader: class { readAsDataURL(file) { this.result = `data:${file.type};base64,${file.base64 || 'c3ludGhldGlj'}`; this.onload(); } }, FormData: class { constructor(form) { this.fields = [...form.querySelectorAll('[name]')].filter(el => el.getAttribute('type') !== 'checkbox' || (typeof el.checked === 'boolean' ? el.checked : el.hasAttribute('checked'))).map(el => [el.name, el.getAttribute('type') === 'checkbox' ? el.getAttribute('value') ?? 'on' : el.value]); } *[Symbol.iterator]() { yield* this.fields; } }, fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => structuredClone(await (typeof routes[url] === 'function' ? routes[url](options) : routes[url] ?? (url === '/api/session' ? { user: { id: 'fixture', name: 'Test student', email: 'fixture@cornell.edu' }, csrfToken: 'fixture' } : url === '/api/state' ? fixture : url === '/api/enrollment/proposals' ? [] : { model: { connected: false }, mode: 'Test fixture' }))) }; } };
  Object.assign(context,runtime);
  await vm.runInNewContext(`(async()=>{${script}\n})()`, context);
  return { document, window, requests, timers, navigate(page) { location.hash = `#${page}`; listeners.hashchange(); } };
}

test('Every workspace section renders, untrusted source text is escaped, and review exposes the real evidence',async()=>{
 const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
 const script=await applicationScript();
 const {document,window}=parseHTML(html);
 const listeners={};const requests=[];
 const fixture={profile:{name:'Robert',model:'local-model',jobTitles:'Engineer',jobLocation:'NYC',paused:false},events:[{id:'class',title:'NBAY 5300 · <script>bad()</script>',kind:'class',date:'2026-11-11',time:'13:25',start:'2026-11-11T18:25:00Z',end:'2026-11-11T19:40:00Z',status:'review',sourceName:'syllabus.pdf',page:2,evidence:'Class is at 1:25 pm.',location:'Tata L23'},{id:'missing',title:'Milestone 5',kind:'studio',date:'2026-11-13',time:null,start:null,status:'review',sourceName:'Slack',evidence:'Due Friday. No time given.'}],sources:[],jobs:[],applications:[],reminders:[],activity:[],metrics:[],resume:null,now:'2026-11-10T21:00:00Z',connections:{telegram:{configured:false,linked:false,bot:'test_bot'},google:{configured:false,connected:false},slack:{configured:false,channel:'C0BSGSNHM5J'},campusgroups:{connected:false}}};
 const location={hash:'#overview',href:''};
 const fetch=async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>structuredClone(url==='/api/session'?{user:{id:'student1',email:'student1@cornell.edu',name:'Student One'},csrfToken:'test-only'}:url==='/api/state'?fixture:url==='/api/health'?{model:{connected:true,models:['local-model']},mode:'Local development',storage:'sqlite-development'}:{} )};};
 const dialog=document.querySelector('dialog');dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>dialog.removeAttribute('open');
 const context={document,window:{addEventListener:(name,fn)=>listeners[name]=fn,scrollTo:()=>{}},location,fetch,URL,Intl,Date,console,setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0,clearInterval:()=>{},FormData:class{constructor(form){this.fields=[...form.querySelectorAll('[name]')].map(el=>[el.name,el.value]);}*[Symbol.iterator](){yield* this.fields;}},prompt:()=>null};
 await vm.runInNewContext(`(async()=>{${script}\n})()`,context);
 assert.match(document.querySelector('h1').textContent,/Your week/);
 assert.equal(document.querySelector('#main script'),null);
 assert.match(document.querySelector('#main').textContent,/<script>bad\(\)<\/script>/);
 for(const page of ['academics','studio','events','careers','connections','evidence']){location.hash='#'+page;listeners.hashchange();assert.ok(document.querySelector('h1'),page+' has a heading');assert.ok(document.querySelector('#main').textContent.length>200,page+' has content');}
 location.hash='#studio';listeners.hashchange();
 const detailButton=document.querySelector('[data-action="detail"][data-id="missing"]');detailButton.dispatchEvent(new window.Event('click',{bubbles:true}));
 assert.equal(dialog.hasAttribute('open'),true);
 assert.equal(dialog.getAttribute('aria-labelledby'),'detail-title');
 assert.ok(document.querySelector('#detail-title').textContent.trim());
 assert.match(document.querySelector('.evidence-text').textContent,/No time given/);
 assert.ok(document.querySelector('#confirmed-time'));
 assert.equal(document.querySelector('#detail-content [data-action="approve-one"]'),null);
 assert.ok(requests.some(r=>r.url==='/api/health'));
});

test('Signed-out visitors see sign-in without loading student records or displaying developer credential forms',async()=>{
 const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8'),script=await applicationScript();
 const {document}=parseHTML(html),requests=[];
 const context={document,window:{addEventListener:()=>{},scrollTo:()=>{}},location:{hash:'',href:''},fetch:async url=>{requests.push(url);return {ok:true,json:async()=>({user:null,googleConfigured:true,devEnabled:false,devEmails:[]})};},URL,Intl,Date,console,setTimeout:()=>0,clearTimeout:()=>{},setInterval:()=>0,clearInterval:()=>{}};
 await vm.runInNewContext(`(async()=>{${script}\n})()`,context);
 assert.ok(document.body.classList.contains('signed-out'));
 assert.equal(document.querySelector('a[href="/auth/google/start"]').textContent,'Continue with Cornell Google ↗');
 assert.equal(requests.includes('/api/state'),false);
 assert.equal(document.querySelector('[name="clientSecret"]'),null);
 assert.equal(document.querySelector('[name="botToken"]'),null);
 assert.doesNotMatch(document.querySelector('#main').textContent,/Robert Bonovich/);
});

test('overview puts actionable review before summary counts and shows the actual source and missing-time count', async () => {
  const fixture = designFixture([
    { id: 'timed', title: 'Design methods', kind: 'class', date: '2026-11-11', start: '2026-11-11T18:00:00Z', status: 'review', sourceName: 'INFO 6410 syllabus', evidence: 'Class at 1:00 p.m.', location: 'Tata L24' },
    { id: 'missing-1', title: 'First deliverable', kind: 'studio', date: '2026-11-13', start: null, status: 'review', sourceName: 'Studio announcement', evidence: 'Due Friday.' },
    { id: 'missing-2', title: 'Second deliverable', kind: 'studio', date: '2026-11-14', start: null, status: 'review', sourceName: 'Studio announcement', evidence: 'Due Saturday.' },
  ]);
  const { document } = await renderDesignFixture(fixture), main = document.querySelector('#main');
  const content = main.innerHTML;
  assert.ok(content.indexOf('review-focus') < content.indexOf('overview-stats'));
  assert.ok(content.indexOf('review-focus') < content.indexOf('assistant-panel'));
  assert.equal(document.querySelector('.review-total').textContent.trim(), '3');
  assert.match(document.querySelector('.focus-intro').textContent, /2 need confirmed times/);
  assert.equal(document.querySelector('.heading-actions [data-action]').dataset.action, 'detail');
  assert.match(document.querySelector('.agenda-content p').textContent, /INFO 6410 syllabus/);
  assert.doesNotMatch(main.textContent, /NBAY 5300/);
  assert.match(document.querySelector('.delivery-note').textContent, /Telegram is not linked/);
});

test('new-student overview makes uploading the next action without claiming a reviewed schedule', async () => {
  const { document } = await renderDesignFixture(designFixture());
  assert.equal(document.querySelector('.heading-actions [data-action]').dataset.action, 'upload-syllabus');
  assert.match(document.querySelector('#review-heading').textContent, /first week/i);
  assert.doesNotMatch(document.querySelector('.review-focus').textContent, /dates are reviewed|dates are ready to export/i);
  assert.match(document.querySelector('#next-heading').textContent, /will appear here/);
  assert.equal(document.querySelector('.review-total').textContent.trim(), '0');
});

test('historical unreviewed records do not produce a false all-clear or invented missing-time action', async () => {
  const { document } = await renderDesignFixture(designFixture([{ id: 'past', title: 'Past lecture', kind: 'class', date: '2026-10-01', start: '2026-10-01T18:00:00Z', status: 'review', sourceName: 'Past syllabus', evidence: 'Lecture time.', location: 'Tata L24' }]));
  assert.equal(document.querySelector('.review-total').textContent.trim(), '0');
  assert.doesNotMatch(document.querySelector('.review-focus').textContent, /your imported dates are reviewed|reviewed dates are ready to export/i);
  assert.doesNotMatch(document.querySelector('.next-focus').textContent, /resolve any missing times/i);
});

test('mobile-ready schedule markup retains field labels, visible bulk controls, and navigation names', async () => {
  const { document, window, navigate } = await renderDesignFixture(designFixture([{ id: 'class', title: 'Design methods', kind: 'class', date: '2026-11-11', start: '2026-11-11T18:00:00Z', end: '2026-11-11T19:00:00Z', status: 'review', sourceName: 'INFO 6410 syllabus', evidence: 'Class at 1:00 p.m.', location: 'Tata L24' }]));
  for (const anchor of document.querySelectorAll('nav a')) {
    const icon = anchor.querySelector('.nav-icon');
    assert.equal(icon.getAttribute('aria-hidden'), 'true');
    assert.ok(anchor.textContent.replace(icon.textContent, '').trim().length > 3, anchor.getAttribute('href'));
  }
  navigate('academics');
  assert.equal(document.querySelector('[data-page="academics"]').getAttribute('aria-current'), 'page');
  assert.deepEqual([...document.querySelectorAll('tbody tr:first-child td')].map(cell => cell.getAttribute('data-label')), ['Select', 'Item / source', 'New York time', 'Location', 'Status', 'Evidence']);
  assert.ok(document.querySelector('table caption').textContent.trim());
  assert.ok(document.querySelector('.table-wrap[role="region"][aria-label]'));
  assert.ok(document.querySelector('#select-all').closest('.table-actions'));
  assert.equal(document.querySelector('thead input,thead button,thead a'), null);
  assert.equal(document.querySelector('[data-action="approve"]').disabled, true);
  const checkbox = document.querySelector('.event-check'); checkbox.checked = true; checkbox.setAttribute('checked', ''); checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.match(document.querySelector('#selection-count').textContent, /1 date.*selected/);
  assert.equal(document.querySelector('[data-action="approve"]').disabled, false);
});

const courseFixture = {
  term: 'FA26', sourceUrl: 'https://cornelltech.tech/', sourceUpdatedAt: '2026-08-30T18:00:00Z', snapshotFetchedAt: '2026-08-30T18:00:00Z', fetchedAt: '2026-11-10T21:00:00Z',
  courses: [{ id: 'NBAY-5300', code: 'NBAY 5300', name: 'Product <script>bad()</script>', sections: [
    { id: 'LEC-001', label: 'Lecture 001', meetingsSummary: 'Monday 1:25–2:40 p.m.', location: '', warnings: ['Room not published', '<img src=x onerror=bad()>'], importable: true },
    { id: 'LEC-002', label: 'Lecture 002', meetingsSummary: 'TBA', location: '', warnings: [], importable: false, blockedReason: 'Meeting dates are not published.' },
  ] }],
};
const settled = () => new Promise(resolve => setImmediate(resolve));
function setInvitationCheck(view,id,checked){const el=view.document.getElementById(id);el.checked=checked;if(checked)el.setAttribute('checked','');else el.removeAttribute('checked');el.dispatchEvent(new view.window.Event('change',{bubbles:true}));}
test('invitation email setup is explicit, requires consent, and submits only selected sources and auto-add',async()=>{
 const fixture=designFixture();fixture.connections.google.connected=true;fixture.eventEmail={connected:true,accountEmail:'fixture@cornell.edu',mode:null,providers:[],continuous:false};
 const view=await renderDesignFixture(fixture,{'/api/event-email/automatic':options=>{const input=JSON.parse(options.body);fixture.eventEmail={...fixture.eventEmail,...input,mode:'automatic',continuous:true};return {taskId:'invitations'};},'/api/tasks':[{id:'invitations',status:'done',result:{imported:1}}]});view.navigate('events');
 clickUI(view,'[data-action="setup-event-email"][data-provider="luma"]');assert.equal(view.document.querySelector('#event-sources').hasAttribute('open'),true);assert.equal(view.requests.some(r=>r.options?.method==='POST'),false);
 const form=view.document.querySelector('#event-email-automatic-form');assert.equal(form.querySelector('button').disabled,true);submitUI(view,'#event-email-automatic-form');await settled();assert.equal(view.requests.some(r=>r.url==='/api/event-email/automatic'),false);
 selectOption(view.document.querySelector('#event-email-auto-add'),'true');view.document.querySelector('#event-email-auto-add').dispatchEvent(new view.window.Event('change',{bubbles:true}));setInvitationCheck(view,'event-email-consent',true);submitUI(view,'#event-email-automatic-form');await settled();
 const request=view.requests.find(r=>r.url==='/api/event-email/automatic');assert.deepEqual(JSON.parse(request.options.body),{providers:['luma'],autoAdd:true});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');assert.equal(view.document.querySelector('#event-email-consent').hasAttribute('checked'),false);
 await view.timers.find(t=>t.ms===1500).callback();await settled();assert.match(view.document.querySelector('#event-email-auto-status').textContent,/monitoring is enabled/);assert.ok(view.document.querySelector('[data-action="stop-event-email"]'));assert.match(view.document.querySelector('.event-source-health').textContent,/Email invitations/);
});
test('invitation email requires a mailbox and Google write access only for automatic additions',async()=>{
 const fixture=designFixture(),view=await renderDesignFixture(fixture,{'/api/event-email/connect':{url:'https://accounts.google.com/fixture'}});view.navigate('events');
 assert.ok(view.document.querySelector('#event-email-automatic [data-action="connect-event-email"]'));assert.equal(view.document.querySelector('#event-email-auto-add option[value="true"]').hasAttribute('disabled'),true);
 setInvitationCheck(view,'event-email-consent',true);submitUI(view,'#event-email-automatic-form');await settled();assert.equal(view.requests.some(r=>r.url==='/api/event-email/automatic'),false);
 clickUI(view,'#event-email-automatic [data-action="connect-event-email"]');await settled();assert.deepEqual(JSON.parse(view.requests.find(r=>r.url==='/api/event-email/connect').options.body),{});
});
test('stopping invitation monitoring preserves shared mailbox connection and is an explicit action',async()=>{
 const fixture=designFixture();fixture.eventEmail={connected:true,mode:'automatic',providers:['partiful'],continuous:true,autoAdd:false};const view=await renderDesignFixture(fixture,{'/api/event-email/stop':()=>{fixture.eventEmail.continuous=false;return fixture.eventEmail;}});view.navigate('events');
 clickUI(view,'[data-action="stop-event-email"]');await settled();assert.deepEqual(JSON.parse(view.requests.find(r=>r.url==='/api/event-email/stop').options.body),{});assert.equal(view.requests.some(r=>r.url==='/api/event-email/disconnect'),false);assert.match(view.document.querySelector('#event-email-auto-status').textContent,/mailbox remains connected/);
});
test('late invitation activation cannot restore private drafts or notices in another student session',async()=>{
 const fixture=designFixture();fixture.eventEmail={connected:true,mode:null};let signedIn=true,resolve;const response=new Promise(r=>resolve=r),view=await renderDesignFixture(fixture,{'/api/event-email/automatic':()=>response,'/api/session':()=>({user:signedIn?{id:'fixture',name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};}});view.navigate('events');
 clickUI(view,'[data-action="setup-event-email"][data-provider="partiful"]');setInvitationCheck(view,'event-email-consent',true);submitUI(view,'#event-email-automatic-form');await settled();view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;clickUI(view,'[data-action="dev-signin"]');await settled();resolve({taskId:'old-private-task'});await settled();view.navigate('events');assert.equal(view.document.querySelector('#event-email-consent').hasAttribute('checked'),false);assert.doesNotMatch(view.document.querySelector('#event-email-auto-status').textContent,/queued|enabled|Updating/);assert.equal(view.timers.some(t=>t.ms===1500),false);
});
function selectOption(element, value) { for (const option of element.querySelectorAll('option')) { if (option.value === value) option.setAttribute('selected', ''); else option.removeAttribute('selected'); } }
async function findFixtureCourse(view) {
  view.navigate('academics'); view.document.querySelector('#course-query').value = 'NBAY';
  view.document.querySelector('#course-search-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true })); await settled();
  selectOption(view.document.querySelector('#course-choice'), 'NBAY-5300');
  view.document.querySelector('#course-choice').dispatchEvent(new view.window.Event('change', { bubbles: true }));
}

test('course picker fetches only an explicit nonempty search and exposes snapshot age without selecting a section', async () => {
  const view = await renderDesignFixture(designFixture(), { '/api/courses?term=FA26&q=NBAY': courseFixture });
  view.navigate('academics');
  assert.equal(view.requests.some(request => request.url.startsWith('/api/courses')), false);
  assert.ok(view.document.querySelector('#main').innerHTML.indexOf('course-picker') < view.document.querySelector('#main').innerHTML.indexOf('course-syllabus-step'));
  view.document.querySelector('#course-search-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true })); await settled();
  assert.equal(view.requests.some(request => request.url.startsWith('/api/courses')), false);
  assert.match(view.document.querySelector('#course-search-status').textContent, /Enter a course code/);
  await findFixtureCourse(view);
  assert.match(view.document.querySelector('.course-freshness').textContent, /Snapshot, not a live schedule/);
  assert.match(view.document.querySelector('.course-freshness').textContent, /August 30, 2026/);
  assert.match(view.document.querySelector('.course-freshness').textContent, /72 days old/);
  assert.match(view.document.querySelector('.course-freshness').textContent, /November 10, 2026/);
  assert.equal(view.document.querySelector('.course-sections input:checked'), null);
  assert.equal(view.document.querySelector('[data-action="import-course"]'), null);
  assert.match(view.document.querySelector('#course-choice').textContent, /<script>bad\(\)<\/script>/);
  assert.equal(view.document.querySelector('#course-picker script'), null);
  assert.match(view.document.querySelector('#course-picker').textContent, /does not enroll you|not monitored automatically/);
});

test('course import sends only the chosen section with CSRF and keeps queued calendar sync distinct from completion', async () => {
  const fixture = designFixture(); fixture.connections.google.connected = true;
  const view = await renderDesignFixture(fixture, { '/api/courses?term=FA26&q=NBAY': courseFixture, '/api/courses/import': { imported: 12, reused: 2, skipped: 1, warnings: ['Check department holidays.'], calendarTask: { taskId: 'calendar-1' } } });
  await findFixtureCourse(view);
  view.document.querySelector('#course-section-0').dispatchEvent(new view.window.Event('change', { bubbles: true }));
  assert.match(view.document.querySelector('.course-confirm').textContent, /Room not published/);
  assert.equal(view.document.querySelector('.course-confirm img'), null);
  assert.equal(view.document.querySelector('[data-action="import-course"]').textContent, 'Add classes to Google Calendar');
  view.document.querySelector('[data-action="import-course"]').dispatchEvent(new view.window.Event('click', { bubbles: true })); await settled();
  const request = view.requests.find(request => request.url === '/api/courses/import');
  assert.deepEqual(JSON.parse(request.options.body), { term: 'FA26', courseId: 'NBAY-5300', sectionId: 'LEC-001' });
  assert.equal(request.options.headers['X-CSRF-Token'], 'fixture');
  assert.match(view.document.querySelector('.course-receipt').textContent, /12 class meetings added · 2 existing meetings reused · 1 excluded occurrences skipped/);
  assert.match(view.document.querySelector('.course-receipt').textContent, /sync is queued.*not completed yet/);
  assert.ok(view.document.querySelector('.course-receipt [data-action="upload-syllabus"]'));
});

test('course picker blocks unpublished schedules and uses local schedule wording without Google', async () => {
  const view = await renderDesignFixture(designFixture(), { '/api/courses?term=FA26&q=NBAY': courseFixture });
  await findFixtureCourse(view);
  view.document.querySelector('#course-section-1').dispatchEvent(new view.window.Event('change', { bubbles: true }));
  assert.equal(view.document.querySelector('[data-action="import-course"]').disabled, true);
  assert.match(view.document.querySelector('#course-picker').textContent, /Meeting dates are not published/);
  view.document.querySelector('[data-action="import-course"]').dispatchEvent(new view.window.Event('click', { bubbles: true })); await settled();
  assert.equal(view.requests.some(request => request.url === '/api/courses/import'), false);
  view.document.querySelector('#course-section-0').dispatchEvent(new view.window.Event('change', { bubbles: true }));
  assert.equal(view.document.querySelector('[data-action="import-course"]').textContent, 'Add classes to my schedule');
  assert.equal(view.document.querySelector('[data-action="import-course"]').disabled, false);
});

const enrollmentProposal = {
  id: 'proposal-1', term: 'FA26', sourceName: 'Enrollment <img src=x onerror=bad()>.pdf', status: 'review', warnings: ['Catalog matching does not verify registration.'], snapshotFetchedAt: '2026-08-30T18:00:00Z',
  candidates: [
    { courseId: 'NBAY-5300', sectionId: 'LEC-001', code: 'NBAY 5300', name: 'Product management', label: 'Lecture 001', meetingsSummary: 'Monday 1:25 p.m.', location: 'Tata L24', matchBasis: 'Exact course and section', enrollmentStatus: 'enrolled', importable: true, warnings: [] },
    { courseId: 'INFO-6410', sectionId: 'LEC-002', code: 'INFO 6410', name: 'Design', label: 'Lecture 002', matchBasis: 'Exact class number', enrollmentStatus: 'unknown', importable: true, warnings: ['Confirm room.'] },
    { courseId: 'CS-5150', sectionId: 'LEC-001', code: 'CS 5150', name: 'Software engineering', label: 'Lecture 001', enrollmentStatus: 'dropped', importable: true, warnings: [] },
    { courseId: 'CS-5999', sectionId: 'TBA', code: 'CS 5999', name: 'Unpublished section', label: 'TBA', importable: false, warnings: [], blockedReason: 'Meeting time missing.' },
  ], unmatched: [{ text: '<script>unmatched()</script>', reason: 'More than one section matched.' }],
};

test('enrollment matches start unchecked and confirmation sends only explicitly chosen enrolled sections', async () => {
  const fixture = designFixture(); fixture.connections.google.connected = true;
  const view = await renderDesignFixture(fixture, { '/api/enrollment/proposals': [enrollmentProposal], '/api/enrollment/confirm': { imported: 14, reused: 0, skipped: 1, warnings: [], calendarTask: { taskId: 'enrollment-calendar' } } });
  view.navigate('academics'); await settled();
  assert.equal(view.document.querySelectorAll('.enrollment-candidates input:checked').length, 0);
  assert.equal(view.document.querySelector('[data-action="confirm-enrollment"]').disabled, true);
  assert.equal(view.document.querySelector('#enrollment-candidate-0-2').disabled, true);
  assert.equal(view.document.querySelector('#enrollment-candidate-0-3').disabled, true);
  assert.equal(view.document.querySelector('#enrollment-import img,#enrollment-import script'), null);
  assert.match(view.document.querySelector('.enrollment-unmatched').textContent, /<script>unmatched\(\)<\/script>.*More than one section matched/);
  assert.match(view.document.querySelector('.enrollment-candidates').textContent, /Enrollment status not readable/);
  assert.match(view.document.querySelector('#enrollment-import').textContent, /catalog match does not verify enrollment/i);
  const enrolled = view.document.querySelector('#enrollment-candidate-0-0'); enrolled.checked = true; enrolled.dispatchEvent(new view.window.Event('change', { bubbles: true }));
  assert.equal(view.document.querySelector('.enrollment-count').textContent, '1 selected');
  view.document.querySelector('[data-action="confirm-enrollment"]').dispatchEvent(new view.window.Event('click', { bubbles: true })); await settled();
  const request = view.requests.find(r => r.url === '/api/enrollment/confirm');
  assert.deepEqual(JSON.parse(request.options.body), { id: 'proposal-1', selections: [{ courseId: 'NBAY-5300', sectionId: 'LEC-001' }] });
  assert.equal(request.options.headers['X-CSRF-Token'], 'fixture');
  assert.match(view.document.querySelector('.enrollment-receipt').textContent, /14 meetings added/);
  assert.match(view.document.querySelector('.enrollment-receipt').textContent, /sync is queued.*not completed yet/);
  assert.ok(view.document.querySelector('.enrollment-receipt [data-action="upload-syllabus"]'));
});

test('enrollment term conflicts remain blocked and upload requires an explicit term with valid bounded media', async () => {
  const view = await renderDesignFixture(designFixture(), { '/api/enrollment/proposals': [{ ...enrollmentProposal, canConfirm: false, blockedReason: 'Document term does not match the chosen term.' }], '/api/enrollment/analyze': { taskId: 'recognize-1' }, '/api/tasks': [{ id: 'recognize-1', status: 'done' }] });
  view.navigate('academics'); await settled();
  assert.equal(view.document.querySelector('#enrollment-term').value, '');
  assert.equal(view.document.querySelector('#enrollment-camera').getAttribute('capture'), 'environment');
  assert.equal(view.document.querySelector('#enrollment-file').getAttribute('accept'), 'application/pdf,image/png,image/jpeg');
  assert.equal(view.document.querySelectorAll('.enrollment-candidates input:not(:disabled)').length, 0);
  view.document.querySelector('[data-action="confirm-enrollment"]').dispatchEvent(new view.window.Event('click', { bubbles: true })); await settled();
  assert.equal(view.requests.some(r => r.url === '/api/enrollment/confirm'), false);
  view.document.querySelector('[data-action="upload-enrollment"]').dispatchEvent(new view.window.Event('click', { bubbles: true }));
  assert.match(view.document.querySelector('#enrollment-status').textContent, /Choose the term/);
  selectOption(view.document.querySelector('#enrollment-term'), 'SP27'); view.document.querySelector('#enrollment-term').dispatchEvent(new view.window.Event('change', { bubbles: true }));
  let input = view.document.querySelector('#enrollment-file'); input.files = [{ name: 'oversize.pdf', type: 'application/pdf', size: 13 * 1024 * 1024 }]; input.dispatchEvent(new view.window.Event('change', { bubbles: true })); await settled();
  assert.match(view.document.querySelector('#enrollment-status').textContent, /no larger than 12 MB/);
  assert.equal(view.requests.some(r => r.url === '/api/enrollment/analyze'), false);
  input = view.document.querySelector('#enrollment-file'); input.files = [{ name: 'synthetic.jpg', type: 'image/jpeg', size: 18, base64: 'c3ludGhldGlj' }]; input.dispatchEvent(new view.window.Event('change', { bubbles: true })); await settled();
  const request = view.requests.find(r => r.url === '/api/enrollment/analyze');
  assert.deepEqual(JSON.parse(request.options.body), { term: 'SP27', mimeType: 'image/jpeg', name: 'synthetic.jpg', base64: 'c3ludGhldGlj' });
  assert.equal(request.options.headers['X-CSRF-Token'], 'fixture');
  assert.match(view.document.querySelector('#enrollment-status').textContent, /Recognition queued/);
  const before = view.requests.filter(r => r.url === '/api/enrollment/proposals').length;
  await view.timers.find(timer => timer.ms === 1500).callback(); await settled();
  assert.equal(view.requests.filter(r => r.url === '/api/enrollment/proposals').length, before + 1);
});

function changeReminderSelect(view, selector, value) {
  const input = view.document.querySelector(selector); assert.ok(input, selector);
  selectOption(input, value); input.dispatchEvent(new view.window.Event('change', { bubbles: true }));
}
function fillReminderAmount(view, key, index, value) {
  const input = view.document.querySelector(`#reminder-${key}-${index}-amount`); assert.ok(input);
  input.value = value; input.dispatchEvent(new view.window.Event('input', { bubbles: true }));
}
function clickReminder(view, action, category, index) {
  const selector = `[data-action="${action}"]${category ? `[data-category="${category}"]` : ''}${index === undefined ? '' : `[data-index="${index}"]`}`;
  const button = view.document.querySelector(selector); assert.ok(button, selector);
  button.dispatchEvent(new view.window.Event('click', { bubbles: true }));
}
async function submitReminderForm(view) {
  view.document.querySelector('#reminder-settings-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true })); await settled();
}
const reminderSaveRoute = options => ({ settings: JSON.parse(options.body), calendarTask: { taskId: 'reminder-calendar' } });

test('reminder presets and custom amounts save minute offsets while showing readable durations', async () => {
  const fixture = designFixture(); fixture.reminderSettings = { classes: [15], events: [], deadlines: [2880, 120] };
  const view = await renderDesignFixture(fixture, { '/api/reminders/settings': reminderSaveRoute });
  view.navigate('academics'); assert.match(view.document.querySelector('.academic-reminder-line').textContent, /Reminders: 15 minutes before classes/); assert.match(view.document.querySelector('.academic-reminder-line').textContent, /2 days and 2 hours before deadlines/);
  view.navigate('connections');
  assert.match(view.document.querySelector('#reminders-events-help').textContent, /Off/);
  assert.equal(view.document.querySelector('#reminder-events-0-preset'), null);
  assert.match(view.document.querySelector('.reminder-bot-help').textContent, /\/reminders deadlines 1d 2h/);
  assert.doesNotMatch(view.document.querySelector('#reminder-settings').textContent, /comma-separated|40,320|MINUTES BEFORE/);
  changeReminderSelect(view, '#reminder-classes-0-preset', '30');
  changeReminderSelect(view, '#reminder-deadlines-0-preset', '1440');
  changeReminderSelect(view, '#reminder-deadlines-1-preset', 'custom');
  fillReminderAmount(view, 'deadlines', 1, '90');
  changeReminderSelect(view, '#reminder-deadlines-1-unit', 'minutes');
  assert.equal(view.requests.some(r => r.url === '/api/reminders/settings'), false, 'choices are drafts until saved');
  await submitReminderForm(view);
  const request = view.requests.find(r => r.url === '/api/reminders/settings'); assert.ok(request);
  assert.deepEqual(JSON.parse(request.options.body), { classes: [30], events: [], deadlines: [1440, 90] }); assert.equal(request.options.headers['X-CSRF-Token'], 'fixture');
  assert.match(view.document.querySelector('#reminder-settings-status').textContent, /sync is queued.*not completed yet/);
  view.navigate('academics'); assert.match(view.document.querySelector('.academic-reminder-line').textContent, /Reminders: 30 minutes before classes/);
});

test('custom reminder units preserve exact existing offsets and reject invalid durations before saving', async () => {
  const fixture = designFixture(); fixture.reminderSettings = { classes: [77], events: [], deadlines: [10081, 90] };
  const view = await renderDesignFixture(fixture, { '/api/reminders/settings': reminderSaveRoute }); view.navigate('connections');
  await submitReminderForm(view);
  assert.deepEqual(JSON.parse(view.requests.find(r => r.url === '/api/reminders/settings').options.body), fixture.reminderSettings);
  changeReminderSelect(view, '#reminder-classes-0-preset', 'custom');
  for (const [amount, unit] of [['0', 'minutes'], ['0.5', 'minutes'], ['29', 'days'], ['', 'hours']]) {
    fillReminderAmount(view, 'classes', 0, amount); changeReminderSelect(view, '#reminder-classes-0-unit', unit);
    const before = view.requests.filter(r => r.url === '/api/reminders/settings').length;
    await submitReminderForm(view);
    assert.equal(view.requests.filter(r => r.url === '/api/reminders/settings').length, before);
    assert.ok(view.document.querySelector('#reminder-settings-status').textContent.trim(), 'invalid amount has a useful error');
  }
  fillReminderAmount(view, 'classes', 0, '1.5'); changeReminderSelect(view, '#reminder-classes-0-unit', 'hours');
  await submitReminderForm(view);
  assert.deepEqual(JSON.parse(view.requests.filter(r => r.url === '/api/reminders/settings').at(-1).options.body).classes, [90]);
});

test('reminder add/remove and off controls are bounded and defaults/discard remain unsaved until Save', async () => {
  const fixture = designFixture(); fixture.reminderSettings = { classes: [15], events: [30], deadlines: [1440, 240] };
  const view = await renderDesignFixture(fixture, { '/api/reminders/settings': reminderSaveRoute }); view.navigate('connections');
  for(let i=0;i<4;i++) clickReminder(view, 'reminder-add', 'classes');
  assert.equal(view.document.querySelectorAll('[id^="reminder-classes-"][id$="-preset"]').length, 5);
  const add = view.document.querySelector('[data-action="reminder-add"][data-category="classes"]'); assert.ok(add.disabled || add.getAttribute('disabled') !== null);
  clickReminder(view, 'reminder-remove', 'classes', 4);
  assert.equal(view.document.querySelectorAll('[id^="reminder-classes-"][id$="-preset"]').length, 4);
  clickReminder(view, 'reminder-toggle', 'classes');
  assert.match(view.document.querySelector('#reminders-classes-help').textContent, /Off/);
  clickReminder(view, 'reminder-remove', 'events', 0);
  assert.match(view.document.querySelector('#reminders-events-help').textContent, /Off/);
  assert.equal(view.requests.some(r => r.url === '/api/reminders/settings'), false);
  clickReminder(view, 'discard-reminder-form');
  assert.equal(view.document.querySelector('#reminder-classes-0-preset').value, '15');
  assert.equal(view.document.querySelector('#reminder-events-0-preset').value, '30');
  clickReminder(view, 'reset-reminder-form');
  assert.equal(view.document.querySelector('#reminder-classes-0-preset').value, '10');
  assert.equal(view.requests.some(r => r.url === '/api/reminders/settings'), false);
  clickReminder(view, 'reminder-toggle', 'events');
  await submitReminderForm(view);
  assert.deepEqual(JSON.parse(view.requests.find(r => r.url === '/api/reminders/settings').options.body), { classes: [10], events: [], deadlines: [1440, 240] });
});

test('duplicate reminder selections save once and do not create duplicate alerts', async () => {
  const fixture = designFixture(); fixture.reminderSettings = { classes: [30, 15], events: [], deadlines: [1440, 240] };
  const view = await renderDesignFixture(fixture, { '/api/reminders/settings': reminderSaveRoute }); view.navigate('connections');
  changeReminderSelect(view, '#reminder-classes-0-preset', '15');
  await submitReminderForm(view);
  assert.deepEqual(JSON.parse(view.requests.find(r => r.url === '/api/reminders/settings').options.body).classes, [15]);
});

test('an older reminder calendar task cannot overwrite a newer save status', async () => {
  const fixture = designFixture(); fixture.reminderSettings = { classes: [10], events: [10], deadlines: [1440, 240] }; let saves = 0;
  const view = await renderDesignFixture(fixture, {
    '/api/reminders/settings': options => { fixture.reminderSettings = JSON.parse(options.body); return { settings: fixture.reminderSettings, calendarTask: { taskId: `calendar-${++saves}` } }; },
    '/api/tasks': [{id:'calendar-1',status:'done'}, {id:'calendar-2',status:'done'}],
  }); view.navigate('connections');
  changeReminderSelect(view, '#reminder-classes-0-preset', '15'); await submitReminderForm(view);
  changeReminderSelect(view, '#reminder-classes-0-preset', '30'); await submitReminderForm(view);
  const polls = view.timers.filter(timer => timer.ms === 1500); assert.equal(polls.length, 2);
  const requests = view.requests.filter(r => r.url === '/api/tasks').length;
  await polls[0].callback(); await settled();
  assert.equal(view.requests.filter(r => r.url === '/api/tasks').length, requests, 'superseded reminder task polling stops');
  assert.match(view.document.querySelector('#reminder-settings-status').textContent, /queued.*not completed yet/);
  await polls[1].callback(); await settled();
  assert.match(view.document.querySelector('#reminder-settings-status').textContent, /sync completed/);
});

test('student-specific enrollment selections and reminder drafts clear on sign-out', async () => {
  let signedIn = true;
  const view = await renderDesignFixture(designFixture(), { '/api/session': () => ({ user: signedIn ? { id: 'fixture', name: 'Test student' } : null, csrfToken: 'fixture', googleConfigured: true, devEnabled: true, devEmails: ['student2@cornell.edu'] }), '/api/enrollment/proposals': () => signedIn ? [enrollmentProposal] : [], '/auth/logout': () => { signedIn = false; return {}; } });
  view.navigate('academics'); await settled();
  const checkbox = view.document.querySelector('#enrollment-candidate-0-0'); checkbox.checked = true; checkbox.dispatchEvent(new view.window.Event('change', { bubbles: true }));
  view.navigate('connections'); changeReminderSelect(view, '#reminder-classes-0-preset', 'custom'); fillReminderAmount(view, 'classes', 0, '77');
  view.document.querySelector('[data-action="logout"]').dispatchEvent(new view.window.Event('click', { bubbles: true })); await settled();
  assert.equal(view.document.querySelector('.enrollment-proposal'), null); assert.equal(view.document.querySelector('#reminder-classes-0-preset'), null);
  signedIn = true; view.document.querySelector('[data-action="dev-signin"]').dispatchEvent(new view.window.Event('click', { bubbles: true })); await settled();
  assert.equal(view.document.querySelector('#reminder-classes-0-preset').value, '10'); view.navigate('academics'); await settled();
  assert.equal(view.document.querySelectorAll('.enrollment-candidates input:checked').length, 0);
});

function careerFixture() {
  const fixture = designFixture();
  fixture.resume = { name: 'Synthetic resume.pdf', updatedAt: '2026-11-10T20:00:00Z' };
  fixture.jobs = [{ id: 'sony-product', company: 'Sony', title: 'Product manager', url: 'https://example.com/sony-role', status: 'open', provider: 'greenhouse', publishedAt: '2026-11-10T20:00:00Z', fetchedAt: '2026-11-10T20:00:00Z' }];
  fixture.careerProfile = {}; fixture.resumeReview = null; fixture.applicationAnswers = [];
  return fixture;
}
function fillCareerQuestion(view, { question = 'Why Sony?', guidance = '' } = {}) {
  selectOption(view.document.querySelector('#career-question-job'), 'sony-product');
  view.document.querySelector('#career-question-job').dispatchEvent(new view.window.Event('change', { bubbles: true }));
  view.document.querySelector('#career-question-text').value = question;
  if (view.document.querySelector('#career-question-guidance')) view.document.querySelector('#career-question-guidance').value = guidance;
}

function templateReviewFixture(){
 const fixture=careerFixture();
 fixture.resumeReviewTemplate={id:'jct-mba',version:'2026-test',name:'JCT MBA resume template',sourceName:'Provided JCT MBA template',note:'Observed layout choices, not a claim about current Cornell requirements.',sectionOrder:['Education','Technical Proficiency (optional)','Professional Experience','Projects','Additional Information'],styleGuide:[{label:'Writing',value:'Use action verbs and supported accomplishments.'},{label:'Observed type',value:'Calibri 12 pt in the supplied template.'}]};
 fixture.resumeReview={id:'review',createdAt:'2026-11-10T21:00:00Z',source:fixture.resume,template:fixture.resumeReviewTemplate,summary:'Strengthen the achievement wording using only supported details.',formatReview:{status:'partial',checks:[{id:'pages',label:'Page count',status:'aligned',observed:'1 page',recommendation:'Keep the content readable.',basis:'measured'},{id:'sections',label:'Section order',status:'suggestion',observed:'Experience appears before Education.',recommendation:'Compare with the template section order.',basis:'text'},{id:'font',label:'Font',status:'check',observed:'No font measurement available.',recommendation:'Compare the original document visually.',basis:'template'}],limitations:['Extracted text cannot confirm every visual alignment.']},suggestions:[{category:'Achievement focus',original:'Built a tool.',suggested:'Built a prototype to support user interviews.',reason:'Adds the purpose already described in the resume.',evidenceVerified:true,needsConfirmation:['What result can you support with evidence?']}],gaps:['Confirm the project dates.'],facts:{fullName:{value:'PRIVATE_PROFILE_FACT',evidence:'Unconfirmed source heading'}}};return fixture;
}

function discoveryFixture(){
 const fixture=careerFixture();fixture.profile.jobTitles='Product manager';fixture.profile.jobLocation='New York';fixture.jobDiscovery={sources:[{id:'example',name:'Example Employer',provider:'greenhouse',board:'example-board',careersUrl:'https://example.com/careers'},{id:'second',name:'Second Employer',provider:'ashby',board:'second',careersUrl:'https://example.org/careers'}],settings:{stretchYears:3}};
 fixture.careerExperience={status:'needs-review',analyzed:true,sourceHash:'resume-hash',source:{name:'Synthetic resume.pdf',updatedAt:fixture.resume.updatedAt},stale:false,asOfMonth:'2026-11',totalMonths:24,totalYears:2,excluded:['intern'],pending:['unknown'],warnings:[],roles:[{id:'full',title:'Product analyst',employer:'Example Employer',employmentType:'full-time',startMonth:'2023-01',endMonth:'2024-12',included:true,provenance:'resume-explicit',reason:'Explicit full-time role with usable month dates.',evidence:'Product analyst · Full-time · Jan 2023–Dec 2024'},{id:'intern',title:'Product intern',employer:'Second Employer',employmentType:'internship',startMonth:'2022-06',endMonth:'2022-08',included:false,provenance:'resume-explicit',reason:'Internship is excluded from the full-time total.',evidence:'Summer internship, June–August 2022'},{id:'unknown',title:'Research assistant',employer:'Campus lab',employmentType:'unknown',startMonth:null,endMonth:null,included:false,provenance:'resume-explicit',reason:'Work type and month dates need confirmation.',evidence:'Research assistant, 2025'}]};return fixture;
}
function linkedinFixture(){const fixture=discoveryFixture();fixture.linkedinConnections={connected:true,count:12,version:'connections-v1',importedAt:'2026-10-01T20:00:00Z',refreshDays:null,refreshDue:false,stale:true,notice:'Employer names come from your own export.'};return fixture;}
function chooseLinkedInFile(view,file){const input=view.document.querySelector('#linkedin-csv-file');Object.defineProperty(input,'files',{value:[file]});input.dispatchEvent(new view.window.Event('change',{bubbles:true}));}

test('job recency defaults to the past week, sorts real posting timestamps newest first, and never uses discovery dates',async()=>{
 const fixture=discoveryFixture(),base=fixture.jobs[0];fixture.jobs=[{...base,id:'old',publishedAt:'2026-11-01T21:00:00Z',firstSeenAt:fixture.now},{...base,id:'week',publishedAt:'2026-11-05T10:00:00-05:00'},{...base,id:'missing',publishedAt:null,firstSeenAt:fixture.now},{...base,id:'recent',publishedAt:'2026-11-10T20:00:00Z'},{...base,id:'boundary',publishedAt:'2026-11-09T21:00:00Z'}];const view=await renderDesignFixture(fixture);view.navigate('careers');const ids=()=>[...view.document.querySelectorAll('#discovered-jobs [data-job-id]')].map(el=>el.dataset.jobId);assert.deepEqual(ids(),['recent','boundary','week']);assert.equal(view.document.querySelector('[data-action="job-recency"][data-value="week"]').getAttribute('aria-pressed'),'true');assert.match(view.document.querySelector('[data-job-id="recent"] .job-posted').textContent,/Posted 1h ago/);assert.equal(view.document.querySelector('[data-job-id="recent"] time').getAttribute('datetime'),'2026-11-10T20:00:00.000Z');assert.match(view.document.querySelector('.career-detail-posted').textContent,/Posted Nov 10, 2026, 3:00 PM.*New York/);const before=view.requests.length;clickUI(view,'[data-action="job-recency"][data-value="24h"]');assert.deepEqual(ids(),['recent','boundary']);clickUI(view,'[data-action="job-recency"][data-value="all"]');assert.deepEqual(ids(),['recent','boundary','week','old','missing']);assert.match(view.document.querySelector('[data-job-id="missing"] .job-posted').textContent,/unavailable.*not classified as recent/);clickUI(view,'[data-action="job-recency"][data-value="undated"]');assert.deepEqual(ids(),['missing']);assert.equal(view.requests.length,before);
});
test('canonical unknown, date-only, invalid, future, and legacy mismatched publication dates cannot look fresh',async()=>{
 const fixture=discoveryFixture(),base=fixture.jobs[0];fixture.jobs=[{...base,id:'canonical-unknown',publication:{publishedAt:null}},{...base,id:'date-only',publishedAt:'2026-11-10'},{...base,id:'no-zone',publishedAt:'2026-11-10T20:00:00'},{...base,id:'future',publishedAt:'2026-11-11T20:00:00Z'},{...base,id:'invalid',publishedAt:'2026-02-30T20:00:00Z'},{...base,id:'unverified',publicationTimeVerified:false},{...base,id:'legacy',rawSource:{first_published:'2026-11-10'}},{...base,id:'canonical',publishedAt:'2026-11-01T00:00:00Z',publication:{publishedAt:'2026-11-10T19:00:00Z'}}];const view=await renderDesignFixture(fixture);view.navigate('careers');assert.deepEqual([...view.document.querySelectorAll('[data-job-id]')].map(el=>el.dataset.jobId),['canonical']);clickUI(view,'[data-action="job-recency"][data-value="undated"]');assert.equal(view.document.querySelectorAll('[data-job-id]').length,7);assert.match(view.document.querySelector('#discovered-jobs').textContent,/Posting date unavailable/);
});
test('LinkedIn CSV selection is bounded and local until explicit import with the captured export version',async()=>{
 const fixture=linkedinFixture(),csv='First Name,Last Name,Company\nSynthetic,Student,Example Employer',view=await renderDesignFixture(fixture,{'/api/career/linkedin/import':()=>{fixture.linkedinConnections={...fixture.linkedinConnections,count:1,version:'connections-v2',stale:false};return{notice:'Import complete.'};}});view.navigate('careers');let read=false;chooseLinkedInFile(view,{name:'too-large.csv',size:8*1024*1024+1,text:async()=>{read=true;return csv;}});await settled();assert.equal(read,false);assert.match(view.document.querySelector('#linkedin-status').textContent,/no larger than 8 MB/);chooseLinkedInFile(view,{name:'Connections.csv',size:csv.length,text:async()=>csv});await settled();assert.equal(view.requests.some(r=>r.url==='/api/career/linkedin/import'),false);assert.match(view.document.querySelector('.linkedin-file-ready').textContent,/Connections.csv/);assert.doesNotMatch(view.document.querySelector('#linkedin-connections').textContent,/Synthetic,Student/);submitUI(view,'#linkedin-import-form');await settled();const request=view.requests.find(r=>r.url==='/api/career/linkedin/import');assert.deepEqual(JSON.parse(request.options.body),{csv,name:'Connections.csv',expectedVersion:'connections-v1'});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');assert.equal(view.document.querySelector('.linkedin-file-ready'),null);assert.match(view.document.querySelector('#linkedin-status').textContent,/Import complete/);
});
test('LinkedIn reminders are off by default, save only explicit intervals, and deleting imports clears cached matches',async()=>{
 const fixture=linkedinFixture(),view=await renderDesignFixture(fixture,{'/api/career/linkedin/settings':options=>{fixture.linkedinConnections.refreshDays=JSON.parse(options.body).refreshDays;return{};},'/api/career/linkedin/matches?jobId=sony-product':{version:'connections-v1',matches:[{name:'PRIVATE_MATCH',company:'Sony',title:'Product researcher',url:'https://linkedin.com/in/synthetic'}]},'/api/career/linkedin/delete':()=>{fixture.linkedinConnections={connected:false,count:0,version:'deleted-version',refreshDays:null};return{};}});view.navigate('careers');assert.equal(view.document.querySelector('#linkedin-refresh-days').value,'off');assert.match(view.document.querySelector('#linkedin-connections').textContent,/Jobs alerts setting/);selectOption(view.document.querySelector('#linkedin-refresh-days'),'14');submitUI(view,'#linkedin-reminder-form');await settled();let request=view.requests.find(r=>r.url==='/api/career/linkedin/settings');assert.deepEqual(JSON.parse(request.options.body),{refreshDays:14});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');assert.deepEqual([...view.document.querySelector('#linkedin-refresh-days').options].map(option=>option.value),['off','14','30','90']);for(const days of [30,90,null]){selectOption(view.document.querySelector('#linkedin-refresh-days'),days===null?'off':String(days));submitUI(view,'#linkedin-reminder-form');await settled();const saved=view.requests.filter(r=>r.url==='/api/career/linkedin/settings').at(-1);assert.deepEqual(JSON.parse(saved.options.body),{refreshDays:days});assert.equal(view.document.querySelector('#linkedin-refresh-days').value,days===null?'off':String(days));}clickUI(view,'[data-action="linkedin-job-matches"]');await settled();assert.match(view.document.querySelector('.job-warm-status').textContent,/PRIVATE_MATCH/);clickUI(view,'[data-action="delete-linkedin"]');await settled();request=view.requests.find(r=>r.url==='/api/career/linkedin/delete');assert.deepEqual(JSON.parse(request.options.body),{});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');assert.doesNotMatch(view.document.querySelector('#main').textContent,/PRIVATE_MATCH/);assert.equal(view.document.querySelector('#linkedin-refresh-days').disabled,true);assert.equal(view.document.querySelector('#linkedin-refresh-days').value,'off');
});
test('warm leads fetch only for the chosen saved job, escape names, strip tracking URLs, and distinguish stale employer evidence',async()=>{
 const fixture=linkedinFixture(),view=await renderDesignFixture(fixture,{'/api/career/linkedin/matches?jobId=sony-product':{version:'connections-v1',company:'Sony',totalMatches:25,truncated:true,stale:true,importedAt:fixture.linkedinConnections.importedAt,notice:'Exported employers may be out of date.',matches:[{name:'Name <img src=x onerror=bad()>',company:'Sony',title:'Product lead',url:'https://linkedin.com/in/synthetic-person?private=TOKEN#profile'},{name:'Second contact',company:'Sony',title:'',url:'https://attacker.example/profile'}]}});view.navigate('careers');assert.equal(view.requests.some(r=>r.url.includes('/linkedin/matches')),false);clickUI(view,'[data-action="linkedin-job-matches"]');await settled();const status=view.document.querySelector('.job-warm-status');assert.equal(status.querySelector('img'),null);assert.match(status.textContent,/Name <img/);assert.ok(status.querySelector('a[href="https://www.linkedin.com/in/synthetic-person"]'));assert.equal(status.querySelector('a[href*="TOKEN"],a[href*="attacker"]'),null);assert.match(status.textContent,/older export/);assert.match(status.textContent,/Showing 2 of 25/);assert.match(status.textContent,/No one has been contacted/);assert.equal(view.requests.filter(r=>r.url.includes('/linkedin/matches')).length,1);
});
test('a changed or deleted export cannot leave an earlier contact-match result visible',async()=>{
 const fixture=linkedinFixture(),view=await renderDesignFixture(fixture,{'/api/career/linkedin/matches?jobId=sony-product':{version:'connections-v1',matches:[{name:'OLD_PRIVATE_CONTACT',company:'Sony',title:'Researcher'}]},'/api/settings':()=>{fixture.linkedinConnections={connected:false,count:0,version:'deleted-in-another-tab'};return{};}});view.navigate('careers');clickUI(view,'[data-action="linkedin-job-matches"]');await settled();assert.match(view.document.querySelector('.job-warm-status').textContent,/OLD_PRIVATE_CONTACT/);clickUI(view,'[data-action="save-job-preferences"]');await settled();assert.doesNotMatch(view.document.querySelector('#main').textContent,/OLD_PRIVATE_CONTACT/);
 const mismatch=await renderDesignFixture(linkedinFixture(),{'/api/career/linkedin/matches?jobId=sony-product':{version:'new-version',matches:[{name:'UNEXPECTED_VERSION_CONTACT'}]}});mismatch.navigate('careers');clickUI(mismatch,'[data-action="linkedin-job-matches"]');await settled();assert.doesNotMatch(mismatch.document.querySelector('#main').textContent,/UNEXPECTED_VERSION_CONTACT/);assert.match(mismatch.document.querySelector('.job-warm-status').textContent,/connections changed/);
});
test('late LinkedIn file reads and match responses cannot appear in a later student workspace',async()=>{
 const fixture=linkedinFixture();let signedIn=true,student='first',releaseFile,releaseMatches;const filePending=new Promise(resolve=>releaseFile=resolve),matchesPending=new Promise(resolve=>releaseMatches=resolve),view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/career/linkedin/matches?jobId=sony-product':()=>matchesPending});view.navigate('careers');clickUI(view,'[data-action="linkedin-job-matches"]');chooseLinkedInFile(view,{name:'PRIVATE_Connections.csv',size:100,text:()=>filePending});await settled();clickUI(view,'[data-action="job-recency"][data-value="all"]');view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';fixture.linkedinConnections={connected:false,count:0,version:null};clickUI(view,'[data-action="dev-signin"]');await settled();releaseFile('PRIVATE_CSV_BODY');releaseMatches({version:'connections-v1',matches:[{name:'PRIVATE_FIRST_CONTACT'}]});await settled();view.navigate('careers');assert.doesNotMatch(view.document.querySelector('#main').textContent,/PRIVATE_/);assert.equal(view.document.querySelector('[data-action="job-recency"][data-value="week"]').getAttribute('aria-pressed'),'true');assert.equal(view.requests.some(r=>r.url==='/api/career/linkedin/import'),false);
});

function setExperienceValue(view,index,field,value){const control=view.document.querySelector(`[data-experience-role]:nth-child(${index+1}) [data-experience-field="${field}"]`);if(control.tagName==='SELECT')selectOption(control,value);else control.value=value;control.dispatchEvent(new view.window.Event('input',{bubbles:true}));}

test('main job discovery needs titles and location rather than provider details, saves explicit stretch, and watches the whole batch',async()=>{
 const fixture=discoveryFixture();let jobs=[{id:'first',status:'done'},{id:'second',status:'running'}];const view=await renderDesignFixture(fixture,{'/api/settings':options=>{Object.assign(fixture.profile,JSON.parse(options.body));return{};},'/api/jobs/discovery/settings':options=>{fixture.jobDiscovery.settings=JSON.parse(options.body);return fixture.jobDiscovery.settings;},'/api/jobs/search':{taskId:'first',taskIds:['first','second'],sources:['Example Employer','Second Employer']},'/api/tasks':()=>jobs});view.navigate('careers');const form=view.document.querySelector('#job-search');assert.equal(form.querySelector('[name="provider"],[name="board"]'),null);assert.equal(view.document.querySelector('#advanced-job-source').hasAttribute('open'),false);assert.match(form.textContent,/Find matching jobs/);assert.match(view.document.querySelector('.discovery-sources').textContent,/Example Employer/);assert.match(view.document.querySelector('.discovery-sources').textContent,/does not search every job/);assert.ok(view.document.querySelector('#main').innerHTML.indexOf('job-discovery-search')<view.document.querySelector('#main').innerHTML.indexOf('resume-review-heading'));selectOption(view.document.querySelector('#job-stretch'),'2');submitUI(view,'#job-search');await settled();const settings=view.requests.find(r=>r.url==='/api/settings'),discovery=view.requests.find(r=>r.url==='/api/jobs/discovery/settings'),search=view.requests.find(r=>r.url==='/api/jobs/search');assert.deepEqual(JSON.parse(settings.options.body),{jobTitles:'Product manager',jobLocation:'New York'});assert.deepEqual(JSON.parse(discovery.options.body),{stretchYears:2});assert.deepEqual(JSON.parse(search.options.body),{});for(const request of [settings,discovery,search])assert.equal(request.options.headers['X-CSRF-Token'],'fixture');const timer=view.timers.find(t=>t.ms===1500);await timer.callback();await settled();assert.match(view.document.querySelector('#job-search-status').textContent,/queued/);jobs=[{id:'first',status:'done'},{id:'second',status:'error',error:'Synthetic unavailable source'}];await timer.callback();await settled();assert.match(view.document.querySelector('#job-search-status').textContent,/1 source task needing attention/);assert.equal(view.document.querySelector('#job-search fieldset').hasAttribute('disabled'),false);
});

test('saving discovery preferences explicitly does not submit or queue an employer search',async()=>{
 const fixture=discoveryFixture(),view=await renderDesignFixture(fixture,{'/api/settings':options=>{Object.assign(fixture.profile,JSON.parse(options.body));return{};},'/api/jobs/discovery/settings':options=>{fixture.jobDiscovery.settings=JSON.parse(options.body);return fixture.jobDiscovery.settings;}});view.navigate('careers');const button=view.document.querySelector('[data-action="save-job-preferences"]');assert.equal(button.getAttribute('type'),'button');view.document.querySelector('#job-titles').value='Research analyst';clickUI(view,'[data-action="save-job-preferences"]');await settled();assert.equal(view.requests.some(r=>r.url==='/api/jobs/search'),false);assert.equal(view.requests.some(r=>r.url==='/api/jobs/discovery/settings'),true);assert.match(view.document.querySelector('#job-search-status').textContent,/Search preferences saved/);assert.equal(view.document.querySelector('#job-titles').value,'Research analyst');
});

test('job discovery accepts a resume without target titles but asks for one source of matching evidence when both are absent',async()=>{
 const fixture=discoveryFixture();fixture.profile.jobTitles='';const view=await renderDesignFixture(fixture,{'/api/jobs/search':{taskId:'resume-only'},'/api/tasks':[{id:'resume-only',status:'done'}]});view.navigate('careers');assert.equal(view.document.querySelector('#job-titles').hasAttribute('required'),false);assert.match(view.document.querySelector('#job-titles-help').textContent,/leave titles blank/i);submitUI(view,'#job-search');await settled();const preferences=view.requests.find(r=>r.url==='/api/settings');assert.equal(JSON.parse(preferences.options.body).jobTitles,'');assert.deepEqual(JSON.parse(view.requests.find(r=>r.url==='/api/jobs/search').options.body),{});
 const empty=discoveryFixture();empty.profile.jobTitles='';empty.resume=null;const blank=await renderDesignFixture(empty);blank.navigate('careers');assert.equal(blank.document.querySelector('#job-titles').hasAttribute('required'),true);submitUI(blank,'#job-search');await settled();assert.equal(blank.requests.some(r=>r.url==='/api/settings'||r.url==='/api/jobs/search'),false);assert.match(blank.document.querySelector('#job-search-status').textContent,/Add target job titles or upload a resume/);
});

test('partial queue and deferred analysis warnings stay visible after queued searches complete and escape source text',async()=>{
 const view=await renderDesignFixture(discoveryFixture(),{'/api/jobs/search':{taskId:'source-one',taskIds:['source-one'],warnings:['Some employer searches could not be queued. Try again later.','Experience analysis deferred <img src=x onerror=bad()>']},'/api/tasks':[{id:'source-one',status:'done'}]});view.navigate('careers');submitUI(view,'#job-search');await settled();let status=view.document.querySelector('#job-search-status');assert.match(status.textContent,/could not be queued/);assert.match(status.textContent,/Experience analysis deferred <img/);assert.equal(status.querySelector('img'),null);assert.equal(status.querySelectorAll('li').length,2);await view.timers.find(t=>t.ms===1500).callback();await settled();status=view.document.querySelector('#job-search-status');assert.match(status.textContent,/Queued employer searches completed/);assert.match(status.textContent,/could not be queued/);assert.match(status.textContent,/Experience analysis deferred/);assert.equal(status.querySelectorAll('li').length,2);
});

test('advanced employer source remains optional and search settings never submit an arbitrary stretch range',async()=>{
 const view=await renderDesignFixture(discoveryFixture(),{'/api/jobs/search':{taskId:'advanced'}});view.navigate('careers');view.document.querySelector('#advanced-job-board').value='explicit-employer';selectOption(view.document.querySelector('#advanced-job-provider'),'ashby');submitUI(view,'#job-advanced-search');await settled();assert.deepEqual(JSON.parse(view.requests.find(r=>r.url==='/api/jobs/search').options.body),{provider:'ashby',board:'explicit-employer'});assert.equal(view.requests.some(r=>r.url==='/api/jobs/discovery/settings'),false);
 const invalid=await renderDesignFixture(discoveryFixture());invalid.navigate('careers');const select=invalid.document.querySelector('#job-stretch'),option=invalid.document.createElement('option');option.value='5';option.textContent='Invalid';select.append(option);selectOption(select,'5');submitUI(invalid,'#job-search');await settled();assert.equal(invalid.requests.some(r=>r.url==='/api/jobs/search'||r.url==='/api/jobs/discovery/settings'),false);assert.match(invalid.document.querySelector('#job-search-status').textContent,/two or three years/);
});

test('experience review exposes included, excluded, and unknown roles without treating unknown work as zero',async()=>{
 const fixture=discoveryFixture();fixture.careerExperience.roles[2].evidence='<img src=x onerror=bad()> Research assistant';const view=await renderDesignFixture(fixture);view.navigate('careers');const panel=view.document.querySelector('#career-experience');assert.match(panel.textContent,/24 months/);assert.match(panel.textContent,/2\.0 years/);assert.match(panel.textContent,/lower bound/);assert.match(panel.textContent,/Unknown experience is not treated as zero/);assert.match(panel.textContent,/Overlapping calendar months count once/);assert.equal(panel.querySelector('img'),null);assert.match(panel.textContent,/<img src=x onerror=bad\(\)>/);assert.match(panel.querySelector('[data-experience-role="intern"]').textContent,/Excluded from full-time total/);assert.match(panel.querySelector('[data-experience-role="unknown"]').textContent,/Needs confirmation/);assert.equal(panel.querySelector('#experience-type-2').value,'unknown');assert.equal(panel.querySelector('#experience-start-2').value,'');assert.equal(panel.querySelector('[name="employer"],[name="title"]'),null);assert.ok(panel.querySelector('label.checkbox-control[for="experience-ongoing-0"] > span'));
});

test('experience corrections send only known role IDs, explicit work types, and month dates with the displayed source hash',async()=>{
 const fixture=discoveryFixture(),view=await renderDesignFixture(fixture,{'/api/career/experience':options=>{const data=JSON.parse(options.body);fixture.careerExperience.totalMonths=30;fixture.careerExperience.roles=fixture.careerExperience.roles.map(role=>({...role,...data.roles.find(row=>row.id===role.id)}));return fixture.careerExperience;}});view.navigate('careers');setExperienceValue(view,2,'employmentType','part-time');setExperienceValue(view,2,'startMonth','2025-09');const ongoing=view.document.querySelector('#experience-ongoing-2');ongoing.checked=true;ongoing.dispatchEvent(new view.window.Event('change',{bubbles:true}));assert.equal(view.document.querySelector('#experience-end-2').disabled,true);assert.match(view.document.querySelector('#career-experience-status').textContent,/Unsaved experience choices/);submitUI(view,'#career-experience-form');await settled();const request=view.requests.find(r=>r.url==='/api/career/experience'),payload=JSON.parse(request.options.body);assert.equal(payload.sourceHash,'resume-hash');assert.deepEqual(payload.roles[2],{id:'unknown',employmentType:'part-time',startMonth:'2025-09',endMonth:'present'});assert.equal(payload.roles[1].employmentType,'internship');assert.deepEqual(Object.keys(payload.roles[0]).sort(),['employmentType','endMonth','id','startMonth']);assert.equal(request.options.headers['X-CSRF-Token'],'fixture');assert.match(view.document.querySelector('#career-experience-status').textContent,/choices saved/);assert.match(view.document.querySelector('.experience-summary').textContent,/30 months/);
});

test('stale resume experience cannot be confirmed and absent analysis does not imply zero years',async()=>{
 const fixture=discoveryFixture();fixture.careerExperience.stale=true;fixture.careerExperience.totalMonths=null;const view=await renderDesignFixture(fixture);view.navigate('careers');assert.equal(view.document.querySelector('#career-experience-form fieldset').hasAttribute('disabled'),true);assert.match(view.document.querySelector('#career-experience').textContent,/resume has changed/);submitUI(view,'#career-experience-form');await settled();assert.equal(view.requests.some(r=>r.url==='/api/career/experience'),false);
 const empty=discoveryFixture();empty.careerExperience={status:'needs-review',analyzed:false,totalMonths:null,totalYears:null,roles:[]};const blank=await renderDesignFixture(empty);blank.navigate('careers');assert.equal(blank.document.querySelector('.experience-summary'),null);assert.match(blank.document.querySelector('#career-experience').textContent,/no full-time experience is assumed/);
});

test('job cards show source-backed experience rationale and excerpts without a qualification percentage',async()=>{
 const fixture=discoveryFixture();fixture.jobs[0].experienceFit={status:'stretch',rationale:'Posting asks for 4 years; the counted full-time estimate is 2 years.',requiredExcerpt:'4+ years of relevant experience <script>bad()</script>',minimumRequired:4};fixture.jobs[0].match=0.5;fixture.jobs[0].stretchSignals=[{kind:'skills',label:'Skills overlap',evidence:'Research <img src=x onerror=bad()>'}];const view=await renderDesignFixture(fixture);view.navigate('careers');const card=view.document.querySelector('.career-job-detail');assert.match(view.document.querySelector('#discovered-jobs .job-card').textContent,/Stretch opportunity/);assert.match(card.textContent,/asks for 4 years/);assert.match(card.textContent,/4\+ years of relevant experience <script>/);assert.equal(card.querySelector('script,img'),null);assert.match(card.textContent,/Transferable evidence to review/);assert.match(card.textContent,/Research <img/);assert.doesNotMatch(card.textContent,/50%|qualified|qualification score/i);assert.match(card.textContent,/not confirmation that you meet every requirement/);
});

test('late job preference saves cannot start searches for a later student and drafts clear on sign-out',async()=>{
 const fixture=discoveryFixture();let signedIn=true,student='first',release;const pending=new Promise(resolve=>release=resolve),view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/settings':()=>pending});view.navigate('careers');view.document.querySelector('#job-titles').value='PRIVATE_FIRST_TARGET';submitUI(view,'#job-search');await settled();view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();const count=view.requests.length;release({});await settled();assert.equal(view.requests.length,count);assert.equal(view.requests.some(r=>r.url==='/api/jobs/search'),false);view.navigate('careers');assert.equal(view.document.querySelector('#job-titles').value,'Product manager');assert.doesNotMatch(view.document.querySelector('#job-search-status').textContent,/saved|queued/);
});

test('experience analysis polling and unsaved role edits stay with the requesting student',async()=>{
 const fixture=discoveryFixture();let signedIn=true;const view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:'fixture',name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/career/experience/analyze':{taskId:'experience-task'},'/api/tasks':[{id:'experience-task',status:'done'}]});view.navigate('careers');setExperienceValue(view,2,'employmentType','contract');view.navigate('overview');view.navigate('careers');assert.equal(view.document.querySelector('#experience-type-2').value,'contract');clickUI(view,'[data-action="analyze-experience"]');await settled();const request=view.requests.find(r=>r.url==='/api/career/experience/analyze');assert.deepEqual(JSON.parse(request.options.body),{});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();const count=view.requests.length;await view.timers.find(t=>t.ms===1500).callback();assert.equal(view.requests.length,count);signedIn=true;clickUI(view,'[data-action="dev-signin"]');await settled();view.navigate('careers');assert.equal(view.document.querySelector('#experience-type-2').value,'unknown');assert.doesNotMatch(view.document.querySelector('#career-experience-status').textContent,/queued|ready/);
});

test('resume template guidance is visible before upload or review without inventing format measurements',async()=>{
 const fixture=templateReviewFixture();fixture.resume=null;fixture.resumeReview=null;fixture.resumeReviewTemplate.styleGuide.push({label:'Unsafe <img src=x>',value:'<script>unsafe()</script>'});const view=await renderDesignFixture(fixture);view.navigate('careers');const panel=view.document.querySelector('#resume-review');assert.match(panel.textContent,/JCT MBA resume template/);assert.match(panel.textContent,/not a claim about current Cornell requirements/);assert.deepEqual([...panel.querySelectorAll('.resume-section-order li')].map(el=>el.textContent),fixture.resumeReviewTemplate.sectionOrder);assert.equal(panel.querySelector('script,img'),null);assert.match(panel.textContent,/<script>unsafe\(\)<\/script>/);assert.equal(panel.querySelector('[data-action="review-resume"]').disabled,true);assert.equal(panel.querySelector('.resume-format-checks'),null);assert.match(panel.textContent,/Upload your resume/);assert.equal(view.requests.some(r=>r.url==='/api/career/resume-review'),false);
});

test('resume review separates measured formatting, text checks, limitations, and factual writing questions',async()=>{
 const fixture=templateReviewFixture();fixture.resumeReview.formatReview.checks[0].observed='<img src=x onerror=bad()> 1 page';fixture.resumeReview.suggestions[0].needsConfirmation.push('<script>bad()</script>');const view=await renderDesignFixture(fixture);view.navigate('careers');const panel=view.document.querySelector('#resume-review');assert.equal(panel.querySelector('img,script'),null);assert.match(panel.querySelector('.resume-format').textContent,/Partial layout check/);assert.deepEqual([...panel.querySelectorAll('.resume-check-basis')].map(el=>el.textContent),['Measured from PDF','From resume text','Template guidance']);assert.match(panel.querySelector('.resume-limitations').textContent,/cannot confirm every visual alignment/);assert.match(panel.querySelector('.resume-comparison').textContent,/Original.*Built a tool\..*Suggested rewrite.*Built a prototype/s);assert.match(panel.querySelector('.resume-reason').textContent,/purpose already described/);assert.match(panel.querySelector('.resume-confirmation').textContent,/What result can you support/);assert.match(panel.querySelector('.resume-gaps').textContent,/questions for you, not facts/);assert.equal(view.document.querySelector('#career-profile-fullName').value,'');assert.doesNotMatch(panel.textContent,/format verified|qualification verified/i);
});

test('copying a resume rewrite is explicit, copies only that rewrite, and never updates the resume or profile',async()=>{
 const fixture=templateReviewFixture(),copied=[],view=await renderDesignFixture(fixture,{}, {navigator:{clipboard:{writeText:async value=>copied.push(value)}}});view.navigate('careers');const before=view.requests.length;assert.equal(copied.length,0);clickUI(view,'[data-action="copy-resume-rewrite"]');await settled();assert.deepEqual(copied,[fixture.resumeReview.suggestions[0].suggested]);assert.doesNotMatch(copied[0],/PRIVATE_PROFILE_FACT|Confirm the project|template/);assert.equal(view.requests.length,before);assert.match(view.document.querySelector('.resume-copy-status').textContent,/Rewrite copied/);assert.equal(view.document.querySelector('#career-profile-fullName').value,'');
});

test('resume rewrite copy has a selectable fallback when clipboard access is unavailable',async()=>{
 const fixture=templateReviewFixture(),view=await renderDesignFixture(fixture);view.navigate('careers');clickUI(view,'[data-action="copy-resume-rewrite"]');await settled();const fallback=view.document.querySelector('.resume-copy-fallback');assert.equal(fallback.hidden,false);assert.equal(fallback.querySelector('textarea').value,fixture.resumeReview.suggestions[0].suggested);assert.equal(fallback.querySelector('textarea').hasAttribute('readonly'),true);assert.match(view.document.querySelector('.resume-copy-status').textContent,/Clipboard access is unavailable/);assert.equal(view.document.querySelector('[data-action="copy-resume-rewrite"]').disabled,false);
});

test('late resume clipboard completion cannot post into another student session',async()=>{
 const fixture=templateReviewFixture();let signedIn=true,student='first',release;const pending=new Promise(resolve=>release=resolve),view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};}},{navigator:{clipboard:{writeText:()=>pending}}});view.navigate('careers');clickUI(view,'[data-action="copy-resume-rewrite"]');await settled();assert.equal(view.document.querySelector('[data-action="copy-resume-rewrite"]').disabled,true);view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';fixture.resumeReview=null;clickUI(view,'[data-action="dev-signin"]');await settled();view.navigate('careers');release();await settled();assert.equal(view.document.querySelector('.resume-copy-status'),null);assert.doesNotMatch(view.document.body.textContent,/Rewrite copied|PRIVATE_PROFILE_FACT/);
});

test('older resume reviews retain suggestions and explain missing format checks and changed uploads',async()=>{
 const fixture=templateReviewFixture();delete fixture.resumeReview.template;delete fixture.resumeReview.formatReview;delete fixture.resumeReview.suggestions[0].needsConfirmation;fixture.resume={...fixture.resume,updatedAt:'2026-11-11T20:00:00Z'};const view=await renderDesignFixture(fixture);view.navigate('careers');const panel=view.document.querySelector('#resume-review');assert.match(panel.textContent,/earlier resume/);assert.match(panel.querySelector('.resume-format').textContent,/predates the template format check/);assert.match(panel.querySelector('.resume-suggestion').textContent,/Built a tool/);assert.match(panel.querySelector('.resume-template').textContent,/JCT MBA resume template/);assert.equal(panel.querySelector('.resume-confirmation'),null);
});

test('career profile saves explicit facts only and keeps optional demographics separate from work eligibility', async () => {
  const fixture = careerFixture(); fixture.profile.name = 'Name from a different purpose';
  const view = await renderDesignFixture(fixture, { '/api/career/profile': options => { fixture.careerProfile = JSON.parse(options.body); return { profile: fixture.careerProfile }; } });
  view.navigate('careers');
  assert.equal(view.document.querySelector('#career-profile-fullName').value, '');
  for (const key of ['workAuthorizationUS', 'sponsorship']) assert.equal(view.document.querySelector(`#career-profile-${key}`).value, 'unanswered');
  assert.equal(view.document.querySelector('#career-profile-veteranStatus'),null);
  view.document.querySelector('#career-profile-fullName').value = 'Explicit Student';
  view.document.querySelector('#career-profile-email').value = 'chosen@cornell.edu';
  view.document.querySelector('#career-profile-plannedWorkLocation').value='New York City, New York, United States';
  selectOption(view.document.querySelector('#career-profile-officeThreeDays'),'local_nyc_sf');
  selectOption(view.document.querySelector('#career-profile-recruitingSMS'),'no');
  selectOption(view.document.querySelector('#career-profile-recruitingWhatsApp'),'yes');
  selectOption(view.document.querySelector('#career-profile-workAuthorizationUS'), 'yes');
  view.document.querySelector('#career-profile-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true })); await settled();
  const request = view.requests.find(r => r.url === '/api/career/profile'), data = JSON.parse(request.options.body);
  assert.equal(data.fullName, 'Explicit Student'); assert.equal(data.email, 'chosen@cornell.edu'); assert.equal(data.workAuthorizationUS, 'yes');
  assert.equal(data.sponsorship, 'unanswered'); assert.equal(data.veteranStatus, undefined); assert.equal(Object.keys(data).length, 15);
  assert.equal(data.plannedWorkLocation,'New York City, New York, United States');assert.equal(data.officeThreeDays,'local_nyc_sf');assert.equal(data.recruitingSMS,'no');assert.equal(data.recruitingWhatsApp,'yes');
  assert.equal(request.options.headers['X-CSRF-Token'], 'fixture');
  assert.match(view.document.querySelector('.career-profile').textContent, /Nothing was sent to an employer/);
});

test('resume review renders source-backed suggestions as unconfirmed and does not populate profile fields', async () => {
  const fixture = careerFixture();
  const view = await renderDesignFixture(fixture, { '/api/career/resume-review': () => { fixture.resumeReview = { id: 'resumeReview', summary: 'Review <img src=x onerror=bad()>', source: fixture.resume, createdAt: '2026-11-10T21:00:00Z', suggestions: [{ original: 'Built a tool.', suggested: '<script>bad()</script> Describe the users.', reason: 'More specific evidence.', evidenceVerified: true }], facts: { fullName: { value: 'Unconfirmed Name', evidence: 'Resume heading', status: 'unconfirmed' } }, gaps: ['Confirm any proposed metric.'] }; return { taskId: 'resume-review-1' }; }, '/api/tasks': [{ id: 'resume-review-1', status: 'done' }] });
  view.navigate('careers');
  view.document.querySelector('[data-action="review-resume"]').dispatchEvent(new view.window.Event('click', { bubbles: true })); await settled();
  assert.match(view.document.querySelector('#career-tools').textContent, /review is queued/);
  await view.timers.find(t => t.ms === 1500).callback(); await settled();
  assert.equal(view.document.querySelector('#career-tools img,#career-tools script'), null);
  assert.match(view.document.querySelector('.resume-suggestion').textContent, /<script>bad\(\)<\/script>/);
  assert.match(view.document.querySelector('.resume-facts').textContent, /Unconfirmed Name/);
  assert.equal(view.document.querySelector('#career-profile-fullName').value, '');
});

test('guided answers send only the selected job question and guidance, then require a separate reviewed save', async () => {
  const fixture = careerFixture(); fixture.careerProfile = { veteranStatus: 'veteran', phone: 'private-profile-value' };
  const view = await renderDesignFixture(fixture, { '/api/career/answer-draft': () => { fixture.applicationAnswers = [{ id: 'answer-1', jobId: 'sony-product', question: 'Why Sony?', guidance: 'Focus on my real project.', answer: 'My project taught me to listen to users.', status: 'draft', evidence: [{ source: 'Resume', quote: 'Built a prototype.', verified: true }], gaps: ['Add your own reason for choosing Sony.'] }]; return { taskId: 'answer-draft-1' }; }, '/api/tasks': [{ id: 'answer-draft-1', status: 'done' }], '/api/career/answer-save': options => { const data = JSON.parse(options.body); fixture.applicationAnswers[0] = { ...fixture.applicationAnswers[0], answer: data.answer, status: 'reviewed' }; return fixture.applicationAnswers[0]; } });
  view.navigate('careers'); fillCareerQuestion(view, { guidance: 'Focus on my real project.' });
  assert.equal(view.document.querySelector('a[href="/api/career/packet?jobId=sony-product"]').textContent, 'Download reviewed application packet');
  view.document.querySelector('#career-question-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true })); await settled();
  const draft = view.requests.find(r => r.url === '/api/career/answer-draft');
  assert.deepEqual(JSON.parse(draft.options.body), { jobId: 'sony-product', question: 'Why Sony?', guidance: 'Focus on my real project.' });
  assert.doesNotMatch(draft.options.body, /private-profile-value|veteran/); assert.equal(draft.options.headers['X-CSRF-Token'], 'fixture');
  await view.timers.find(t => t.ms === 1500).callback(); await settled();
  assert.match(view.document.querySelector('.career-answer-heading .tag').textContent, /Needs your review/);
  assert.match(view.document.querySelector('.answer-evidence').textContent, /Built a prototype/);
  const answer = view.document.querySelector('.career-answer-form textarea'); answer.value = 'My own checked answer.'; answer.dispatchEvent(new view.window.Event('input', { bubbles: true }));
  assert.equal(view.document.querySelector('.career-answer-heading .tag').textContent, 'Unsaved edits');
  view.document.querySelector('.career-answer-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true })); await settled();
  const save = view.requests.find(r => r.url === '/api/career/answer-save'); assert.deepEqual(JSON.parse(save.options.body), { id: 'answer-1', answer: 'My own checked answer.' });
  assert.equal(view.document.querySelector('.career-answer-heading .tag').textContent, 'Reviewed by you');
  assert.match(view.document.querySelector('.career-answer').textContent, /No employer has received this answer/);
});

test('manual answers work without a resume and protected questions remain blank until the student writes a response', async () => {
  const fixture = careerFixture(); fixture.resume = null;
  fixture.applicationAnswers = [{ id: 'manual-needed', jobId: 'sony-product', question: 'Will you need sponsorship?', answer: '', status: 'draft', needsManual: true, gaps: ['Answer this yourself.'], evidence: [] }];
  const view = await renderDesignFixture(fixture, { '/api/career/answer-save': options => { const data = JSON.parse(options.body); fixture.applicationAnswers.push({ ...data, id: 'own-answer', status: 'reviewed', evidence: [] }); return { id: 'own-answer' }; } });
  view.navigate('careers'); assert.equal(view.document.querySelector('#career-question-form button').disabled, true);
  assert.equal(view.document.querySelector('.career-answer-form textarea').value, ''); assert.match(view.document.querySelector('.career-answer .notice').textContent, /needs your own response/);
  view.document.querySelector('[data-action="career-mode-manual"]').dispatchEvent(new view.window.Event('click', { bubbles: true }));
  fillCareerQuestion(view); view.document.querySelector('#career-question-answer').value = 'My own motivation and experience.';
  view.document.querySelector('#career-question-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true })); await settled();
  const request = view.requests.find(r => r.url === '/api/career/answer-save'); assert.deepEqual(JSON.parse(request.options.body), { jobId: 'sony-product', question: 'Why Sony?', answer: 'My own motivation and experience.' });
  assert.equal(view.requests.some(r => r.url === '/api/career/answer-draft'), false);
});

test('career drafts and queued callbacks cannot cross a sign-out boundary', async () => {
  const fixture = careerFixture(); let signedIn = true;
  const view = await renderDesignFixture(fixture, { '/api/session': () => ({ user: signedIn ? { id: 'fixture', name: 'Test student' } : null, csrfToken: 'fixture', googleConfigured: true, devEnabled: true, devEmails: ['student2@cornell.edu'] }), '/auth/logout': () => { signedIn = false; return {}; }, '/api/career/answer-draft': { taskId: 'pending-draft' }, '/api/tasks': [{ id: 'pending-draft', status: 'done' }] });
  view.navigate('careers'); fillCareerQuestion(view); view.document.querySelector('#career-question-form').dispatchEvent(new view.window.Event('submit', { bubbles: true, cancelable: true })); await settled();
  const profile = view.document.querySelector('#career-profile-fullName'); profile.value = 'Unsaved private name'; profile.dispatchEvent(new view.window.Event('input', { bubbles: true }));
  view.navigate('connections'); view.document.querySelector('[data-action="logout"]').dispatchEvent(new view.window.Event('click', { bubbles: true })); await settled();
  const before = view.requests.length; await view.timers.find(t => t.ms === 1500).callback(); assert.equal(view.requests.length, before);
  signedIn = true; view.document.querySelector('[data-action="dev-signin"]').dispatchEvent(new view.window.Event('click', { bubbles: true })); await settled(); view.navigate('careers');
  assert.equal(view.document.querySelector('#career-profile-fullName').value, ''); assert.equal(view.document.querySelector('#career-question-text').value, '');
});

function campusFixture(){
  const fixture=designFixture();fixture.campusConnected=true;fixture.campusCalendar={calendarId:'campus-source',calendarName:'Cornell Tech events',continuous:true,lastSuccess:'2026-11-10T20:00:00Z'};
  fixture.campusEvents=[{id:'campus-owned-id',sourceCalendarId:'campus-source',title:'Alumni panel <img src=x onerror=bad()>',date:'2026-11-12',start:'2026-11-12T22:00:00Z',end:'2026-11-12T23:00:00Z',location:'',rsvpUrl:'https://cornelltech.campusgroups.com/rsvp?id=2133121',status:'available',allDay:false,warnings:['Room not published.']},{id:'all-day-owned',sourceCalendarId:'campus-source',title:'All-day workshop',date:'2026-11-13',start:null,end:null,location:'',rsvpUrl:'javascript:bad()',status:'available',allDay:true,warnings:[]},{id:'other-calendar-item',sourceCalendarId:'another-source',title:'Unselected calendar event',date:'2026-11-13',start:'2026-11-13T22:00:00Z',end:'2026-11-13T23:00:00Z',status:'available'}];
  fixture.dailyBriefing={enabled:true,time:'08:00',timezone:'America/New_York'};return fixture;
}
test('campus cards preserve the safe RSVP link, show unknown locations, and add only the explicit candidate id',async()=>{
  const fixture=campusFixture();fixture.campusEvents.push({id:'past-all-day',sourceCalendarId:'campus-source',title:'Historical all-day item',date:'2026-10-01',endDate:'2026-10-02',start:null,end:null,allDay:true,status:'available'});const view=await renderDesignFixture(fixture,{'/api/campus/add':{imported:1,calendarTask:{taskId:'campus-sync'}}});view.navigate('events');
  const main=view.document.querySelector('#main');assert.equal(main.querySelector('img,script'),null);assert.match(main.textContent,/<img src=x onerror=bad\(\)>/);assert.doesNotMatch(main.textContent,/Unselected calendar event|Historical all-day item/);
  const rsvp=main.querySelector('a[href="https://cornelltech.campusgroups.com/rsvp?id=2133121"]');assert.ok(rsvp);assert.equal(rsvp.getAttribute('rel'),'noreferrer');assert.equal(rsvp.getAttribute('target'),'_blank');assert.equal(main.querySelector('a[href^="javascript:"]'),null);
  assert.match(main.textContent,/Location not available — check the signup page/);assert.equal(main.querySelector('[data-action="add-campus"][data-id="all-day-owned"]').disabled,true);assert.match(main.textContent,/Adding an event does not register you/);
  main.querySelector('[data-action="add-campus"][data-id="campus-owned-id"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();
  const request=view.requests.find(r=>r.url==='/api/campus/add');assert.deepEqual(JSON.parse(request.options.body),{id:'campus-owned-id'});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');assert.match(view.document.querySelector('#toast').textContent,/sync queued/);
});
test('morning briefing defaults to 8 a.m., saves explicit enablement, and previews concise text without sending messages',async()=>{
  const fixture=campusFixture();fixture.events=[{id:'assignment',title:'Assignment',kind:'assignment',date:'2026-11-12',start:'2026-11-12T22:00:00Z',status:'approved',evidence:'PRIVATE_DESCRIPTION_MARKER',sourceName:'Syllabus'}];
  const preview='Today · Nov 10\nClass: 1:25 p.m. · Tata L24\nCampus event: 5:00 p.m. · room not published\n<script>escaped-preview()</script>';
  const view=await renderDesignFixture(fixture,{'/api/daily-briefing/settings':options=>{fixture.dailyBriefing=JSON.parse(options.body);return fixture.dailyBriefing;},'/api/daily-briefing/preview':{text:preview}});view.navigate('connections');
  assert.equal(view.document.querySelector('#briefing-time').value,'08:00');assert.equal(view.document.querySelector('#briefing-enabled').hasAttribute('checked'),true);assert.equal(view.document.querySelector('[data-action="send-briefing"]').disabled,true);
  view.document.querySelector('#briefing-time').value='08:30';view.document.querySelector('#briefing-enabled').checked=false;view.document.querySelector('#daily-briefing-form').dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();
  const request=view.requests.find(r=>r.url==='/api/daily-briefing/settings');assert.deepEqual(JSON.parse(request.options.body),{time:'08:30',enabled:false,telegramEnabled:true,emailEnabled:false});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');
  view.document.querySelector('[data-action="preview-briefing"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();assert.equal(view.document.querySelector('.briefing-preview').textContent,preview);assert.equal(view.document.querySelector('.briefing-preview script'),null);assert.doesNotMatch(view.document.querySelector('#main').textContent,/PRIVATE_DESCRIPTION_MARKER/);assert.equal(view.requests.some(r=>r.url==='/api/daily-briefing/send'),false);
});
test('job coverage shows source gaps and escapes board and provider errors',async()=>{
  const fixture=careerFixture();fixture.jobBoards=[{board:'example <script>board()</script>',provider:'greenhouse',lastSuccess:null,lastError:'<img src=x onerror=bad()>',truncated:true}];const view=await renderDesignFixture(fixture);view.navigate('careers');
  const coverage=[...view.document.querySelectorAll('section')].find(el=>el.querySelector('h2')?.textContent==='Job alert coverage');assert.ok(coverage);assert.equal(coverage.querySelector('script,img'),null);assert.match(coverage.textContent,/last success none/);assert.match(coverage.textContent,/coverage is incomplete/);assert.match(coverage.textContent,/not an all-internet job search/);
});
test('job alert coverage states the source-date policy and distinguishes pending retries from uncertain delivery',async()=>{
 for(const [status,label] of [['retry-pending','Retry pending'],['needs_review','Delivery needs review']]){
  const fixture=careerFixture();fixture.jobAlertsHealth={lastRun:'2026-11-10T20:00:00Z',alertQueued:3,pendingAlerts:7,alerts:status,coverage:'Fetched sources only <img src=x onerror=bad()>'};const view=await renderDesignFixture(fixture);view.navigate('careers');const coverage=view.document.querySelector('#job-source-coverage');assert.match(coverage.textContent,/source posting timestamp in the past seven days/);assert.match(coverage.textContent,/last 24 hours and 1–7 days/);assert.match(coverage.textContent,/newest first across currently fetched/);assert.match(coverage.textContent,/Older roles stay in All dates.*Unknown date.*Saved contains only the roles you bookmark/);assert.ok(coverage.textContent.includes(label));assert.match(coverage.textContent,/7 roles pending/);assert.match(coverage.textContent,/3 queued in the last check/);assert.match(coverage.textContent,/Queued does not mean delivered/);assert.match(coverage.textContent,/Nov 10, 2026, 3:00 PM/);assert.equal(coverage.querySelector('img'),null);if(status==='needs_review')assert.match(coverage.textContent,/not confirmed as sent/);else assert.match(coverage.textContent,/waiting for a retry/);
 }
});
test('subscribed calendar options and morning briefing preview clear when the student signs out',async()=>{
  let signedIn=true;const fixture=campusFixture();const view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:'fixture',name:'Test student'}:null,csrfToken:'fixture',googleConfigured:true,devEnabled:true,devEmails:['student2@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/campus/calendars':[{id:'campus-source',name:'Own subscribed calendar <img src=x>'}],'/api/daily-briefing/preview':{text:'Private concise preview'}});
  view.navigate('events');view.document.querySelector('[data-action="list-campus"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();assert.ok(view.document.querySelector('#campus-calendar'));assert.match(view.document.querySelector('#campus-calendar').textContent,/Own subscribed calendar/);assert.equal(view.document.querySelector('#campus-calendar img'),null);
  selectOption(view.document.querySelector('#campus-calendar'),'campus-source');view.document.querySelector('#campus-calendar-form').dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();const selected=view.requests.find(r=>r.url==='/api/campus/select');assert.deepEqual(JSON.parse(selected.options.body),{calendarId:'campus-source'});
  view.navigate('connections');view.document.querySelector('[data-action="preview-briefing"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();assert.ok(view.document.querySelector('.briefing-preview'));
  view.document.querySelector('[data-action="logout"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();signedIn=true;view.document.querySelector('[data-action="dev-signin"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();assert.equal(view.document.querySelector('.briefing-preview'),null);view.navigate('events');assert.equal(view.document.querySelector('#campus-calendar'),null);
});

function partifulFixture(){
 const fixture=campusFixture();fixture.partifulConnected=true;fixture.partifulCalendar={calendarId:'partiful-source',calendarName:'My Partiful <img src=x>',continuous:true,autoAdd:false,lastSuccess:'2026-11-10T20:00:00Z'};
 fixture.partifulEvents=[{id:'partiful-owned',sourceCalendarId:'partiful-source',title:'Game night <script>unsafe()</script>',date:'2026-11-12',start:'2026-11-12T23:00:00Z',end:'2026-11-13T01:00:00Z',location:'',rsvpUrl:'https://partiful.com/e/example-invite',status:'available',localIntent:'maybe',warnings:['Location <img src=x> not published.']},{id:'partiful-all-day',sourceCalendarId:'partiful-source',title:'Untimed invitation',date:'2026-11-13',start:null,end:null,allDay:true,rsvpUrl:'javascript:unsafe()',status:'available'},{id:'foreign-calendar',sourceCalendarId:'not-selected',title:'Another calendar private invitation',date:'2026-11-13',status:'available'},{id:'fake-partiful',sourceCalendarId:'partiful-source',title:'Unsupported RSVP host',date:'2026-11-14',allDay:true,rsvpUrl:'https://partiful.com.attacker.example/invite',status:'available'}];return fixture;
}
test('Partiful stays separate from campus events, escapes source content, and records only explicit local choices',async()=>{
 const fixture=partifulFixture(),view=await renderDesignFixture(fixture,{'/api/partiful/add':{calendarTask:{taskId:'sync'}},'/api/partiful/intent':{saved:true}});view.navigate('events');
 const main=view.document.querySelector('#main'),section=main.querySelector('#partiful-subscription'),cards=main.querySelector('#partiful-events');
 assert.ok(section);assert.equal(section.querySelector('script,img'),null);assert.equal(cards.querySelector('script,img'),null);assert.match(cards.textContent,/<script>unsafe\(\)<\/script>/);assert.doesNotMatch(cards.textContent,/Alumni panel|Another calendar private invitation/);
 assert.match(section.textContent,/roughly 24 hours/);assert.match(section.textContent,/every 15 minutes/);assert.match(section.textContent,/\/partiful/);assert.match(section.textContent,/does not RSVP/);
 assert.ok(cards.querySelector('a[href="https://partiful.com/e/example-invite"]'));assert.equal(cards.querySelector('a[href^="javascript:"]'),null);assert.equal(cards.querySelector('a[href*="attacker.example"]'),null);assert.match(cards.textContent,/Location not available — check Partiful/);assert.equal(cards.querySelector('[data-action="add-partiful"][data-id="partiful-all-day"]').disabled,true);
 cards.querySelector('[data-action="add-partiful"][data-id="partiful-owned"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();
 const add=view.requests.find(r=>r.url==='/api/partiful/add');assert.deepEqual(JSON.parse(add.options.body),{id:'partiful-owned'});assert.equal(add.options.headers['X-CSRF-Token'],'fixture');assert.match(view.document.querySelector('#toast').textContent,/RSVP separately/);
 const form=view.document.querySelector('.partiful-intent-form[data-id="partiful-owned"]');selectOption(form.querySelector('select'),'going');form.dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();
 const intent=view.requests.find(r=>r.url==='/api/partiful/intent');assert.deepEqual(JSON.parse(intent.options.body),{id:'partiful-owned',intent:'going'});assert.match(view.document.querySelector('#toast').textContent,/RSVP has not changed/);
});
test('Partiful picker and auto-add controls stay separate and submit explicit booleans',async()=>{
 const fixture=partifulFixture(),view=await renderDesignFixture(fixture,{'/api/campus/calendars':[{id:'campus-option',name:'Campus choice'}],'/api/partiful/calendars':{calendars:[{id:'partiful-option',name:'Partiful choice <img src=x>'}]},'/api/partiful/select':{taskId:'partiful-selection'},'/api/partiful/settings':options=>{fixture.partifulCalendar.autoAdd=JSON.parse(options.body).autoAdd;return{};}});view.navigate('events');
 view.document.querySelector('[data-action="list-campus"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();view.document.querySelector('[data-action="list-partiful"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();
 assert.match(view.document.querySelector('#campus-calendar').textContent,/Campus choice/);assert.doesNotMatch(view.document.querySelector('#campus-calendar').textContent,/Partiful choice/);assert.match(view.document.querySelector('#partiful-calendar').textContent,/Partiful choice/);assert.equal(view.document.querySelector('#partiful-calendar img'),null);
 assert.equal(view.document.querySelector('#partiful-select-auto-add').hasAttribute('checked'),false);selectOption(view.document.querySelector('#partiful-calendar'),'partiful-option');view.document.querySelector('#partiful-calendar-form').dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();
 const select=view.requests.find(r=>r.url==='/api/partiful/select');assert.deepEqual(JSON.parse(select.options.body),{calendarId:'partiful-option',autoAdd:false});assert.equal(select.options.headers['X-CSRF-Token'],'fixture');
 view.document.querySelector('#partiful-auto-add').checked=true;view.document.querySelector('#partiful-settings-form').dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();
 const settings=view.requests.filter(r=>r.url==='/api/partiful/settings');assert.deepEqual(JSON.parse(settings[0].options.body),{autoAdd:true});
 view.document.querySelector('#partiful-auto-add').checked=false;view.document.querySelector('#partiful-settings-form').dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();assert.deepEqual(JSON.parse(view.requests.filter(r=>r.url==='/api/partiful/settings').at(-1).options.body),{autoAdd:false});
});
test('Partiful refresh polling stops at sign-out and cannot poll a later student session',async()=>{
 let signedIn=true,student='first';const fixture=partifulFixture(),view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:student,name:'Test student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['student2@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/partiful/sync':{taskId:'old-student-task'}});view.navigate('events');
 view.document.querySelector('[data-action="sync-partiful"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();const timer=view.timers.find(t=>t.ms===1500);assert.ok(timer);
 view.navigate('connections');view.document.querySelector('[data-action="logout"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();signedIn=true;student='second';view.document.querySelector('[data-action="dev-signin"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();
 const count=view.requests.length;await timer.callback();assert.equal(view.requests.length,count);
});
test('Partiful refresh exposes held jobs and calendar enqueue failures instead of reporting complete import',async()=>{
 for(const task of [{id:'refresh',status:'needs_review'},{id:'refresh',status:'completed',result:{calendarError:'Events saved; Google sync could not be queued.'}}]){
  const view=await renderDesignFixture(partifulFixture(),{'/api/partiful/sync':{taskId:'refresh'},'/api/tasks':[task]});view.navigate('events');
  view.document.querySelector('[data-action="sync-partiful"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();
  await view.timers.find(timer=>timer.ms===1500).callback();await settled();
  assert.match(view.document.querySelector('#toast').textContent,task.status==='needs_review'?/needs attention/:/could not be queued/);
 }
});
test('a late Partiful calendar-list response is discarded after sign-out and another sign-in',async()=>{
 let signedIn=true,student='first',release;const delayed=new Promise(resolve=>{release=resolve;}),fixture=partifulFixture();
 const view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:student,name:'Test student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['student2@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/partiful/calendars':()=>delayed});view.navigate('events');
 view.document.querySelector('[data-action="list-partiful"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();view.navigate('connections');view.document.querySelector('[data-action="logout"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();signedIn=true;student='second';view.document.querySelector('[data-action="dev-signin"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();
 release([{id:'old-private-calendar',name:'OLD_PRIVATE_PARTIFUL_NAME'}]);await settled();view.navigate('events');assert.equal(view.document.querySelector('#partiful-calendar'),null);assert.doesNotMatch(view.document.querySelector('#main').textContent,/OLD_PRIVATE_PARTIFUL_NAME/);
});
test('disconnecting Partiful labels retained events as a snapshot and leaves campus reading connected',async()=>{
 const fixture=partifulFixture(),view=await renderDesignFixture(fixture,{'/api/partiful/disconnect':()=>{fixture.partifulCalendar.continuous=false;fixture.partifulCalendar.autoAdd=false;return{};}});view.navigate('events');
 view.document.querySelector('[data-action="disconnect-partiful"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();
 const request=view.requests.find(r=>r.url==='/api/partiful/disconnect');assert.deepEqual(JSON.parse(request.options.body),{});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');
 assert.match(view.document.querySelector('#partiful-subscription').textContent,/SAVED SNAPSHOT/);assert.match(view.document.querySelector('#partiful-subscription').textContent,/Automatic refresh is stopped/);assert.equal(view.document.querySelector('[data-action="sync-partiful"]').disabled,true);assert.equal(view.document.querySelector('#partiful-settings-form'),null);
 assert.ok(view.document.querySelector('[data-action="sync-campus"]'));assert.equal(view.requests.some(r=>r.url==='/api/disconnect'),false);assert.match(view.document.querySelector('#toast').textContent,/Campus calendar reading remains connected/);
});
test('declined Partiful plans disable adding and display the backend reminder notice without changing RSVP',async()=>{
 const fixture=partifulFixture(),notice='BRB reminders are suppressed. The existing Google copy and Partiful RSVP are unchanged.';
 const view=await renderDesignFixture(fixture,{'/api/partiful/intent':options=>{const input=JSON.parse(options.body),event=fixture.partifulEvents.find(item=>item.id===input.id);event.localIntent=input.intent;event.localIntentNotice=notice;return{localIntentNotice:notice};}});view.navigate('events');
 const form=view.document.querySelector('.partiful-intent-form[data-id="partiful-owned"]');selectOption(form.querySelector('select'),'declined');form.dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();
 assert.equal(view.document.querySelector('#toast-message').textContent,notice);const button=view.document.querySelector('[data-action="add-partiful"][data-id="partiful-owned"]');assert.equal(button.disabled,true);assert.equal(button.textContent,'Declined locally');assert.match(button.closest('article').textContent,/Change your local plan to going or maybe/);assert.match(button.closest('article').textContent,/Google copy and Partiful RSVP are unchanged/);assert.equal(view.requests.some(request=>request.url==='/api/partiful/add'),false);
});
test('campus daily auto-add is opt-in, uses explicit boolean writes with CSRF, and preserves the checkbox hit target',async()=>{
 const fixture=campusFixture();fixture.connections.google.connected=true;fixture.campusCalendar.autoAdd=false;fixture.campusCalendar.dailyLastAttemptAt='2026-11-10T10:00:00Z';fixture.campusCalendar.dailyLastSuccessAt='2026-11-10T10:01:00Z';
 const view=await renderDesignFixture(fixture,{'/api/campus/settings':options=>{fixture.campusCalendar.autoAdd=JSON.parse(options.body).autoAdd;return fixture.campusCalendar;}});view.navigate('events');
 const section=view.document.querySelector('#campus-subscription');assert.match(section.textContent,/daily at 5:00 a.m. America\/New_York/);assert.match(section.textContent,/daylight saving time/);assert.match(section.textContent,/until 11:00 a.m./);assert.doesNotMatch(section.textContent,/every 15 minutes/);assert.match(section.textContent,/Last scheduled attempt/);
 const checkbox=section.querySelector('#campus-auto-add');assert.equal(checkbox.hasAttribute('checked'),false);assert.equal(checkbox.disabled,false);assert.ok(checkbox.closest('.checkbox-control'));assert.ok(checkbox.nextElementSibling?.tagName==='SPAN');assert.equal(checkbox.hasAttribute('style'),false);
 checkbox.checked=true;section.querySelector('#campus-settings-form').dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();const first=view.requests.find(r=>r.url==='/api/campus/settings');assert.deepEqual(JSON.parse(first.options.body),{autoAdd:true});assert.equal(first.options.headers['X-CSRF-Token'],'fixture');
 view.document.querySelector('#campus-auto-add').checked=false;view.document.querySelector('#campus-settings-form').dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();assert.deepEqual(JSON.parse(view.requests.filter(r=>r.url==='/api/campus/settings').at(-1).options.body),{autoAdd:false});
 assert.match(view.document.querySelector('#campus-subscription').textContent,/Modified and cancelled events reopen review/);assert.match(view.document.querySelector('#telegram-new-event-guide').textContent,/\/newevent/);assert.match(view.document.querySelector('#telegram-new-event-guide').textContent,/\/invite/);assert.match(view.document.querySelector('#telegram-new-event-guide').textContent,/missing details such as the time and location/);assert.match(view.document.querySelector('#telegram-new-event-guide').textContent,/Add to Google Calendar/);
});
test('campus calendar reading alone cannot enable auto-add; manual additions remain available and disabling remains possible',async()=>{
 const fixture=campusFixture(),view=await renderDesignFixture(fixture,{'/api/campus/settings':{autoAdd:false}});view.navigate('events');
 assert.equal(view.document.querySelector('#campus-auto-add').disabled,true);assert.match(view.document.querySelector('#campus-subscription').textContent,/Connect Google Calendar writing/);assert.equal(view.document.querySelector('[data-action="add-campus"][data-id="campus-owned-id"]').disabled,false);
 view.document.querySelector('#campus-auto-add').checked=true;view.document.querySelector('#campus-settings-form').dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();assert.equal(view.requests.some(r=>r.url==='/api/campus/settings'),false);assert.match(view.document.querySelector('#toast').textContent,/before enabling auto-add/);
 fixture.campusCalendar.autoAdd=true;view.document.querySelector('[data-action="list-campus"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();assert.equal(view.document.querySelector('#campus-auto-add').disabled,false);view.document.querySelector('#campus-auto-add').checked=false;view.document.querySelector('#campus-settings-form').dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();assert.deepEqual(JSON.parse(view.requests.find(r=>r.url==='/api/campus/settings').options.body),{autoAdd:false});
});
test('campus freshness uses the daily cadence plus morning catch-up and keeps snapshot labels distinct',async()=>{
 const fixture=campusFixture();fixture.campusCalendar.lastSuccess='2026-11-09T16:00:00Z';fixture.campusCalendar.dailyStatus='<img src=x onerror=bad()>';fixture.campusCalendar.dailyLastAttemptAt='2026-11-10T10:00:00Z';
 const view=await renderDesignFixture(fixture);view.navigate('events');let section=view.document.querySelector('#campus-subscription');assert.equal(section.querySelector('.tag').textContent,'DAILY · 05:00');assert.equal(section.querySelector('img'),null);
 fixture.campusCalendar.lastSuccess='2026-11-09T14:00:00Z';view.document.querySelector('[data-action="list-campus"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();section=view.document.querySelector('#campus-subscription');assert.equal(section.querySelector('.tag').textContent,'READ DELAYED');assert.match(section.textContent,/more than 30 hours old/);
 fixture.campusCalendar.continuous=false;view.document.querySelector('[data-action="list-campus"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();section=view.document.querySelector('#campus-subscription');assert.equal(section.querySelector('.tag').textContent,'SNAPSHOT / SETUP');assert.match(section.textContent,/Imported snapshots do not refresh automatically/);assert.equal(section.querySelector('#campus-auto-add').disabled,true);
});
test('campus source selection explains opt-in reset and an unsaved choice cannot follow another student',async()=>{
 let signedIn=true,student='first';const fixture=campusFixture();fixture.connections.google.connected=true;fixture.campusCalendar.autoAdd=false;
 const view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:student,name:'Test student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['student2@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/campus/calendars':[{id:'other-source',name:'Another subscribed calendar'}]});view.navigate('events');
 view.document.querySelector('[data-action="list-campus"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();assert.match(view.document.querySelector('#campus-calendar-form').textContent,/Changing the calendar source turns auto-add off/);view.document.querySelector('#campus-auto-add').checked=true;
 view.navigate('connections');view.document.querySelector('[data-action="logout"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();signedIn=true;student='second';view.document.querySelector('[data-action="dev-signin"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();view.navigate('events');assert.equal(view.document.querySelector('#campus-calendar'),null);assert.equal(view.document.querySelector('#campus-auto-add').hasAttribute('checked'),false);assert.equal(view.requests.some(r=>r.url==='/api/campus/settings'),false);
});

function applicationTrackerFixture(){
 const fixture=careerFixture();fixture.applicationTracker=[
  {id:'tracker-queued',jobId:'job-queued',title:'Product Manager <img src=x>',company:'Example Company',location:'New York',experience:'3+ years',experienceEvidence:'At least 3 years of product experience <script>bad()</script>.',applyUrl:'https://example.com/product',source:'telegram',sources:['telegram'],startedAt:'2026-11-10T15:00:00Z',status:'queued'},
  {id:'tracker-prepared',jobId:'job-prepared',title:'Senior Software Engineer',company:'Another Company',location:'',experience:'10 years',experienceEvidence:'',applyUrl:'javascript:bad()',source:'web',startedAt:'2026-11-09T15:00:00Z',status:'prepared'},
  {id:'tracker-attention',title:'Previous analyst draft',company:'Previous Company',location:'Boston',experience:'Not specified',applyUrl:'https://example.com/analyst',source:'legacy',startedAt:'2026-11-08T15:00:00Z',status:'needs_attention',statusNote:'Preparation needs attention <img src=x>.'},
  {id:'tracker-submitted',title:'Design Lead',company:'Design Company',location:'Remote',experience:'5 years',experienceEvidence:'Five years of design experience required.',applyUrl:'https://example.com/design',source:'web',sources:['web','telegram'],startedAt:'2026-11-07T15:00:00Z',status:'submitted',submissionReportedAt:'2026-11-10T17:00:00Z'}
 ];return fixture;
}
test('application tracker displays every account record in its own tab with explicit experience evidence and safe links',async()=>{
 const fixture=applicationTrackerFixture(),view=await renderDesignFixture(fixture);view.navigate('careers');const tracker=view.document.querySelector('#application-tracker'),main=view.document.querySelector('#main');
 assert.equal(tracker.querySelectorAll('tbody tr').length,4);clickUI(view,'[data-action="career-tab"][data-tab="applications"]');assert.equal(view.document.querySelector('#career-panel-applications').hasAttribute('hidden'),false);assert.equal(view.document.querySelector('#career-panel-jobs').hasAttribute('hidden'),true);assert.equal(tracker.querySelector('img,script'),null);assert.match(tracker.textContent,/<img src=x>/);assert.equal(tracker.querySelector('a[href^="javascript:"]'),null);assert.equal(tracker.querySelector('a[href="https://example.com/product"]').getAttribute('rel'),'noreferrer');
 const queued=tracker.querySelector('[data-tracker-id="tracker-queued"]');assert.match(queued.textContent,/3\+ years/);assert.match(queued.textContent,/Telegram/);assert.match(queued.textContent,/Preparing/);assert.match(queued.textContent,/Nov 10, 2026/);
 const prepared=tracker.querySelector('[data-tracker-id="tracker-prepared"]');assert.doesNotMatch(prepared.textContent,/10 years/);assert.match(prepared.textContent,/Not specified/);assert.match(tracker.textContent,/Previous draft/);assert.match(tracker.textContent,/Submitted \(student-reported\)/);assert.match(tracker.textContent,/Employer-confirmed receipts are labeled separately/);assert.ok(tracker.querySelector('caption'));assert.equal(tracker.querySelectorAll('th[scope="col"]').length,6);
});
test('application submission report and correction send only the owned tracker ID and explicit status',async()=>{
 const fixture=applicationTrackerFixture(),view=await renderDesignFixture(fixture,{'/api/career/application-status':options=>{const data=JSON.parse(options.body),row=fixture.applicationTracker.find(item=>item.id===data.id);row.status=data.status;row.submissionReportedAt='2026-11-10T18:00:00Z';return row;}});view.navigate('careers');
 view.document.querySelector('[data-action="application-tracker-status"][data-id="tracker-prepared"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();
 let request=view.requests.find(r=>r.url==='/api/career/application-status');assert.deepEqual(JSON.parse(request.options.body),{id:'tracker-prepared',status:'submitted'});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');assert.match(view.document.querySelector('#application-tracker').textContent,/Recorded as submitted by you/);
 const corrected=view.document.querySelector('[data-action="application-tracker-status"][data-id="tracker-prepared"]');assert.equal(corrected.textContent,'Correct to prepared');corrected.dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();
 request=view.requests.filter(r=>r.url==='/api/career/application-status').at(-1);assert.deepEqual(JSON.parse(request.options.body),{id:'tracker-prepared',status:'prepared'});assert.match(view.document.querySelector('#application-tracker').textContent,/No employer application was changed/);assert.equal(view.requests.some(r=>r.url.startsWith('https://example.com')),false);
});
test('application tracker filters only account records without changing the workbench or making mutation calls',async()=>{
 const fixture=applicationTrackerFixture(),view=await renderDesignFixture(fixture);view.navigate('careers');
 view.document.querySelector('#application-tracker-search').value='New York';view.document.querySelector('#application-tracker-filters').dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();assert.equal(view.document.querySelectorAll('#application-tracker tbody tr').length,1);assert.equal(view.document.querySelector('#application-tracker tbody tr').dataset.trackerId,'tracker-queued');
 view.document.querySelector('#application-tracker-search').value='';selectOption(view.document.querySelector('#application-tracker-status'),'submitted');view.document.querySelector('#application-tracker-filters').dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();assert.equal(view.document.querySelector('#application-tracker tbody tr').dataset.trackerId,'tracker-submitted');
 view.document.querySelector('[data-action="clear-application-tracker"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();assert.equal(view.document.querySelectorAll('#application-tracker tbody tr').length,4);assert.ok(view.document.querySelector('#career-tools'));assert.match(view.document.querySelector('#main').textContent,/APPLICATION WORKBENCH/);assert.equal(view.requests.some(r=>r.url==='/api/career/application-status'),false);
});
test('application tracker empty state gives real Telegram instructions without seeded applications',async()=>{
 const view=await renderDesignFixture(careerFixture());view.navigate('careers');const tracker=view.document.querySelector('#application-tracker');assert.equal(tracker.querySelector('tbody'),null);assert.match(tracker.textContent,/No applications started yet/);assert.match(tracker.textContent,/\/jobs/);assert.match(tracker.textContent,/\/apply <job ID>/);assert.doesNotMatch(tracker.textContent,/Example Company|Design Company/);
});
test('pending application status replies and tracker filter state cannot cross a student sign-out boundary',async()=>{
 let signedIn=true,student='first',release;const pending=new Promise(resolve=>{release=resolve;}),fixture=applicationTrackerFixture();
 const view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:student,name:'Test student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['student2@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/career/application-status':()=>pending});view.navigate('careers');
 view.document.querySelector('#application-tracker-search').value='Example Company';view.document.querySelector('#application-tracker-filters').dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));await settled();view.document.querySelector('[data-action="application-tracker-status"][data-id="tracker-queued"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();
 view.navigate('connections');view.document.querySelector('[data-action="logout"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();signedIn=true;student='second';fixture.applicationTracker=[{id:'second-user',title:'Second student role',company:'Other student company',status:'prepared',source:'web'}];view.document.querySelector('[data-action="dev-signin"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();view.navigate('careers');const requestsBefore=view.requests.length;release({status:'submitted',statusNote:'PRIVATE_OLD_RESPONSE'});await settled();
 assert.equal(view.requests.length,requestsBefore);assert.equal(view.document.querySelector('#application-tracker-search').value,'');assert.equal(view.document.querySelectorAll('#application-tracker tbody tr').length,1);assert.equal(view.document.querySelector('#application-tracker tbody tr').dataset.trackerId,'second-user');assert.doesNotMatch(view.document.querySelector('#application-tracker').textContent,/PRIVATE_OLD_RESPONSE|Example Company|Recorded as submitted by you/);
});

function lumaFixture(){const fixture=partifulFixture();fixture.connections.google.connected=true;fixture.lumaConnected=true;fixture.lumaCalendar={calendarId:'luma-source',calendarName:'Luma <img src=x>',continuous:true,autoAdd:false,lastSuccess:'2026-11-10T20:55:00Z'};fixture.lumaEvents=[{id:'luma-owned',sourceCalendarId:'luma-source',title:'Founder night <script>bad()</script>',date:'2026-11-12',start:'2026-11-12T23:00:00Z',end:'2026-11-13T01:00:00Z',rsvpUrl:'https://lu.ma/founder-night',location:'',status:'available',localIntent:'maybe',warnings:['Waitlist <img src=x>']},{id:'luma-untimed',sourceCalendarId:'luma-source',title:'City festival',date:'2026-11-13',allDay:true,rsvpUrl:'https://luma.com.attacker.test/private',status:'available'},{id:'other-luma',sourceCalendarId:'different-calendar',title:'OTHER_PRIVATE_LUMA_EVENT',date:'2026-11-13',status:'available'}];return fixture;}
const clickUI=(view,selector)=>view.document.querySelector(selector).dispatchEvent(new view.window.Event('click',{bubbles:true}));
const submitUI=(view,selector)=>view.document.querySelector(selector).dispatchEvent(new view.window.Event('submit',{bubbles:true,cancelable:true}));
test('Luma remains a separate selected-calendar source with truthful setup, lag, waitlist, and calendar-copy wording',async()=>{
 const view=await renderDesignFixture(lumaFixture(),{'/api/luma/add':{calendarTask:{taskId:'google-write'}}});view.navigate('events');const panel=view.document.querySelector('#luma-subscription'),cards=view.document.querySelector('#luma-events');
 assert.ok(view.document.querySelector('#partiful-subscription'));assert.ok(view.document.querySelector('#campus-subscription'));assert.equal(view.document.querySelector('#breadcrumb').textContent,'Events');assert.match(panel.textContent,/12–24 hours/);assert.match(panel.textContent,/every 15 minutes/);assert.match(panel.textContent,/waitlisted or pending-approval/);assert.match(panel.textContent,/both copies may appear/);assert.ok(panel.querySelector('a[href="https://help.luma.com/p/ical-syncing"]'));
 assert.equal(cards.querySelector('img,script,a[href*="attacker"]'),null);assert.match(cards.textContent,/<script>bad\(\)<\/script>/);assert.doesNotMatch(cards.textContent,/OTHER_PRIVATE/);assert.ok(cards.querySelector('a[href="https://lu.ma/founder-night"]'));assert.equal(cards.querySelector('[data-action="add-luma"][data-id="luma-untimed"]').disabled,true);
 clickUI(view,'[data-action="add-luma"][data-id="luma-owned"]');await settled();const r=view.requests.find(r=>r.url==='/api/luma/add');assert.deepEqual(JSON.parse(r.options.body),{id:'luma-owned'});assert.equal(r.options.headers['X-CSRF-Token'],'fixture');assert.match(view.document.querySelector('#luma-subscription').textContent,/sync queued/);
});
test('Luma calendar selection and auto-add are isolated opt-ins with explicit boolean CSRF writes',async()=>{
 const fixture=lumaFixture(),view=await renderDesignFixture(fixture,{'/api/luma/calendars':{calendars:[{id:'luma-option',summary:'Luma calendar <img src=x>'}]},'/api/partiful/calendars':[{id:'partiful-option',name:'Partiful choice'}],'/api/luma/select':{},'/api/luma/settings':options=>{fixture.lumaCalendar.autoAdd=JSON.parse(options.body).autoAdd;return{};}});view.navigate('events');clickUI(view,'[data-action="list-luma"]');await settled();clickUI(view,'[data-action="list-partiful"]');await settled();
 assert.match(view.document.querySelector('#luma-calendar').textContent,/Luma calendar/);assert.doesNotMatch(view.document.querySelector('#luma-calendar').textContent,/Partiful choice/);assert.match(view.document.querySelector('#partiful-calendar').textContent,/Partiful choice/);assert.equal(view.document.querySelector('#luma-select-auto-add').hasAttribute('checked'),false);assert.ok(view.document.querySelector('label.checkbox-control[for="luma-auto-add"] > span'));
 selectOption(view.document.querySelector('#luma-calendar'),'luma-option');submitUI(view,'#luma-calendar-form');await settled();assert.deepEqual(JSON.parse(view.requests.find(r=>r.url==='/api/luma/select').options.body),{calendarId:'luma-option',autoAdd:false});
 for(const value of [true,false]){view.document.querySelector('#luma-auto-add').checked=value;submitUI(view,'#luma-settings-form');await settled();const r=view.requests.filter(r=>r.url==='/api/luma/settings').at(-1);assert.deepEqual(JSON.parse(r.options.body),{autoAdd:value});assert.equal(r.options.headers['X-CSRF-Token'],'fixture');}
 fixture.connections.google.connected=false;const readonly=await renderDesignFixture(fixture);readonly.navigate('events');assert.equal(readonly.document.querySelector('#luma-auto-add').disabled,true);
});
test('Luma decline suppresses adding locally and disconnect keeps other subscribed sources intact',async()=>{
 const fixture=lumaFixture(),notice='BRB reminders are suppressed; Luma registration and the Google copy are unchanged.',view=await renderDesignFixture(fixture,{'/api/luma/intent':options=>{const input=JSON.parse(options.body);fixture.lumaEvents[0].localIntent=input.intent;fixture.lumaEvents[0].localIntentNotice=notice;return{localIntentNotice:notice};},'/api/luma/disconnect':()=>{fixture.lumaCalendar.continuous=false;fixture.lumaCalendar.autoAdd=false;return{};}});view.navigate('events');selectOption(view.document.querySelector('.luma-intent-form select'),'declined');submitUI(view,'.luma-intent-form');await settled();assert.equal(view.document.querySelector('[data-action="add-luma"][data-id="luma-owned"]').disabled,true);assert.match(view.document.querySelector('#luma-events').textContent,/Google copy are unchanged/);assert.deepEqual(JSON.parse(view.requests.find(r=>r.url==='/api/luma/intent').options.body),{id:'luma-owned',intent:'declined'});
 clickUI(view,'[data-action="disconnect-luma"]');await settled();assert.match(view.document.querySelector('#luma-subscription').textContent,/SAVED SNAPSHOT/);assert.equal(view.document.querySelector('[data-action="sync-luma"]').disabled,true);assert.ok(view.document.querySelector('[data-action="disconnect-partiful"]'));assert.ok(view.document.querySelector('[data-action="sync-campus"]'));assert.equal(view.requests.some(r=>/partiful|campus/.test(r.url)),false);
});
test('Luma polling exposes held jobs and calendar errors, and stops after sign-out',async()=>{
 for(const task of [{id:'refresh',status:'needs_review'},{id:'refresh',status:'completed',result:{calendarError:'Google write could not be queued.'}}]){const view=await renderDesignFixture(lumaFixture(),{'/api/luma/sync':{taskId:'refresh'},'/api/tasks':[task]});view.navigate('events');clickUI(view,'[data-action="sync-luma"]');await settled();assert.equal(view.document.querySelector('[data-action="sync-luma"]').disabled,true);await view.timers.find(t=>t.ms===1500).callback();await settled();assert.match(view.document.querySelector('#luma-subscription').textContent,task.status==='needs_review'?/needs attention/:/could not be queued/);}
 let signedIn=true,student='first';const view=await renderDesignFixture(lumaFixture(),{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['student2@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/luma/sync':{taskId:'private-task'}});view.navigate('events');clickUI(view,'[data-action="sync-luma"]');await settled();const timer=view.timers.find(t=>t.ms===1500);view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();const count=view.requests.length;await timer.callback();assert.equal(view.requests.length,count);
});
test('late Luma picker responses cannot expose calendars or notices to a later student',async()=>{
 let signedIn=true,student='first',release;const delayed=new Promise(resolve=>release=resolve),view=await renderDesignFixture(lumaFixture(),{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['student2@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/luma/calendars':()=>delayed});view.navigate('events');clickUI(view,'[data-action="list-luma"]');await settled();view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();release([{id:'secret-id',name:'OLD_PRIVATE_CALENDAR'}]);await settled();view.navigate('events');assert.equal(view.document.querySelector('#luma-calendar'),null);assert.doesNotMatch(view.document.querySelector('#main').textContent,/OLD_PRIVATE_CALENDAR|Processing your Luma/);
});
test('event sharing previews only bounded invitation fields and canonical links before explicit clipboard copying',async()=>{
 const fixture=lumaFixture(),copied=[];for(const source of ['campus','partiful','luma'])Object.assign(fixture[`${source}Events`][0],{description:'PRIVATE_DESCRIPTION',sourceName:'PRIVATE_ACCOUNT',evidence:'PRIVATE_EVIDENCE',localIntent:'going',sourceUrl:'https://calendar.google.com/private-feed.ics?secret=PRIVATE_TOKEN'});fixture.campusEvents[0].rsvpUrl+='&private=PRIVATE_TOKEN#tracking';fixture.partifulEvents[0].rsvpUrl+='?secret=PRIVATE_TOKEN#tracking';fixture.lumaEvents[0].rsvpUrl+='?private=PRIVATE_TOKEN#tracking';
 const view=await renderDesignFixture(fixture,{}, {navigator:{clipboard:{writeText:async text=>copied.push(text)}}});view.navigate('events');const count=view.requests.length;
 for(const [source,id,link] of [['campus','campus-owned-id','https://cornelltech.campusgroups.com/rsvp?id=2133121'],['partiful','partiful-owned','https://partiful.com/e/example-invite'],['luma','luma-owned','https://lu.ma/founder-night']]){clickUI(view,`[data-action="share-event"][data-source="${source}"][data-id="${id}"]`);assert.equal(view.document.querySelector('#detail-dialog').open,true);const preview=view.document.querySelector('#event-share-preview');assert.match(preview.value,/New York time/);assert.ok(preview.value.includes(link));assert.doesNotMatch(preview.value,/PRIVATE_|going|tracking|calendar.google/);assert.equal(view.document.querySelector('#detail-content script,img'),null);const note=view.document.querySelector('#event-share-note');note.value='Want to go together?';note.dispatchEvent(new view.window.Event('input',{bubbles:true}));assert.match(preview.value,/Want to go together/);const before=copied.length;clickUI(view,'[data-action="copy-event-invitation"]');await settled();assert.equal(copied.length,before+1);assert.equal(copied.at(-1),preview.value);view.document.querySelector('#detail-dialog').close();}
 assert.equal(view.requests.length,count);
});
test('share preview omits subscription URLs, has a manual copy fallback, and clears private note on sign-out',async()=>{
 let signedIn=true;const fixture=lumaFixture();fixture.lumaEvents[0].rsvpUrl='https://calendar.google.com/calendar/ical/private-secret/basic.ics';const view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:'first',name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};}});view.navigate('events');clickUI(view,'[data-action="share-event"][data-id="luma-owned"]');assert.doesNotMatch(view.document.querySelector('#event-share-preview').value,/private-secret|ical/);assert.match(view.document.querySelector('#detail-content').textContent,/registration link was not available/);clickUI(view,'[data-action="copy-event-invitation"]');await settled();assert.match(view.document.querySelector('#event-share-status').textContent,/Select and copy/);
 view.document.querySelector('#event-share-note').value='PRIVATE_NOTE';view.document.querySelector('#event-share-note').dispatchEvent(new view.window.Event('input',{bubbles:true}));view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();assert.equal(view.document.querySelector('#detail-dialog').open,false);assert.equal(view.document.querySelector('#detail-content').textContent,'');assert.doesNotMatch(view.document.body.textContent,/PRIVATE_NOTE/);
});
test('Luma outbound links strip private query tokens and reject account, payment, and feed routes',async()=>{
 for(const path of ['private','auth','checkout','tickets','subscriptions','calendar','nyc']){const fixture=lumaFixture();fixture.lumaEvents[0].rsvpUrl=`https://luma.com/${path}?token=PRIVATE_LINK_TOKEN#secret`;const view=await renderDesignFixture(fixture);view.navigate('events');assert.equal(view.document.querySelector('#luma-events a[href*="luma.com/"]'),null);clickUI(view,'[data-action="share-event"][data-id="luma-owned"]');assert.doesNotMatch(view.document.querySelector('#event-share-preview').value,/luma.com|PRIVATE_LINK_TOKEN/);}
 const fixture=lumaFixture();fixture.lumaEvents[0].rsvpUrl='https://lu.ma/founder-night?invite=PRIVATE_LINK_TOKEN#ticket';const view=await renderDesignFixture(fixture);view.navigate('events');assert.ok(view.document.querySelector('#luma-events a[href="https://lu.ma/founder-night"]'));assert.equal(view.document.querySelector('#luma-events a[href*="PRIVATE_LINK_TOKEN"]'),null);
});
test('clipboard completion from a previous student cannot restore the preview or post a success notice',async()=>{
 let signedIn=true,student='first',release;const delayed=new Promise(resolve=>release=resolve),view=await renderDesignFixture(lumaFixture(),{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};}},{navigator:{clipboard:{writeText:()=>delayed}}});view.navigate('events');clickUI(view,'[data-action="share-event"][data-id="luma-owned"]');clickUI(view,'[data-action="copy-event-invitation"]');await settled();assert.equal(view.document.querySelector('[data-action="copy-event-invitation"]').disabled,true);view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();release();await settled();assert.equal(view.document.querySelector('#detail-content').textContent,'');assert.equal(view.document.querySelector('#detail-dialog').open,false);assert.doesNotMatch(view.document.body.textContent,/Invitation copied/);
});

function eventHubFixture(){const fixture=lumaFixture();fixture.eventHub={items:[
{id:'hub-merged',title:'Founder conversations <img src=x>',date:'2026-11-12',start:'2026-11-12T23:00:00Z',end:'2026-11-13T01:00:00Z',location:'Tata L24',category:'networking',sourceLabels:['CampusGroups','Luma'],sources:[{kind:'campus',label:'CampusGroups',candidateId:'campus-owned-id',url:'https://cornelltech.campusgroups.com/rsvp?id=2133121'},{kind:'luma',label:'Luma',candidateId:'luma-owned',url:'https://lu.ma/founder-night'}],status:'available',registrationUrl:'https://lu.ma/founder-night?token=PRIVATE_TOKEN',action:{kind:'campus',id:'campus-owned-id'},warnings:[]},
{id:'hub-email',title:'Design night from Cornell email',date:'2026-11-10',start:'2026-11-10T23:00:00Z',end:'2026-11-11T00:00:00Z',location:'Tata L23',category:'social',sourceLabels:['Cornell email'],sources:[{kind:'email',label:'Cornell email',candidateId:'email-event'}],status:'review',registrationUrl:'https://partiful.com/e/design-night',action:{kind:'email',id:'email-event'},warnings:['Confirm this email suggestion.'],evidence:[{label:'Invitation excerpt',excerpt:'PRIVATE_EVIDENCE <script>bad()</script>'}]},
{id:'hub-holiday',title:'Thanksgiving break',date:'2026-11-25',endDate:'2026-11-30',allDay:true,category:'breaks',holiday:true,sourceLabels:['Cornell Registrar'],sources:[{kind:'academic',label:'Cornell Registrar',url:'https://registrar.cornell.edu/academic-calendar'}],status:'available',action:{kind:'academic',id:'academic-break'},warnings:['Check Cornell Tech applicability.']},
{id:'hub-old',title:'Previous community event',date:'2026-10-01',allDay:true,category:'social',sourceLabels:['My events'],sources:[{kind:'manual',label:'My events'}],status:'added',action:{kind:'manual',id:'old-event'}},
{id:'hub-spanning',title:'Current multi-day festival',date:'2026-11-09',endDate:'2026-11-12',allDay:true,category:'social',sourceLabels:['Partiful'],sources:[{kind:'partiful',label:'Partiful'}],status:'available',action:{kind:'partiful',id:'partiful-all-day'}}],stats:{total:5}};fixture.eventHub.items.forEach((item,index)=>item.revision=String(index+1).repeat(64));fixture.events.push({id:'email-event',title:'Design night from Cornell email',kind:'event',date:'2026-11-10',start:'2026-11-10T23:00:00Z',end:'2026-11-11T00:00:00Z',status:'review',evidenceVerified:true,evidence:'PRIVATE_EVIDENCE',sourceName:'Cornell email'});fixture.eventEmail={connected:true,accountEmail:'own-mailbox@example.com',labelId:'label-own',labelName:'BRB events',continuous:true,lastSuccess:'2026-11-10T20:00:00Z',outlookConnected:false};fixture.academicCalendar={academicYear:'2026-2027',lastSuccess:'2026-11-10T19:00:00Z',warning:'Cornell Tech programs may use different dates.'};return fixture;}
test('unified Events shows one merged listing per hub item, official break strip, and collapsed source management',async()=>{
 const view=await renderDesignFixture(eventHubFixture());view.navigate('events');const hub=view.document.querySelector('#event-hub');assert.equal(hub.querySelectorAll('[data-event-id="hub-merged"]').length,1);assert.equal(hub.querySelectorAll('.event-hub-card').length,3);assert.match(hub.textContent,/Combined listing/);assert.match(hub.textContent,/CampusGroups/);assert.match(hub.textContent,/Luma/);assert.equal(hub.querySelector('img,script'),null);assert.match(hub.textContent,/Founder conversations <img src=x>/);assert.ok(hub.querySelector('.event-holiday[data-id="hub-holiday"]'));assert.equal(view.document.querySelector('#event-sources').hasAttribute('open'),false);assert.ok(view.document.querySelector('#event-sources #partiful-subscription'));assert.ok(view.document.querySelector('#event-sources #email-event-source'));assert.doesNotMatch(hub.textContent,/PRIVATE_EVIDENCE|PRIVATE_TOKEN|Previous community event/);
});
test('event agenda filters by date overlap, source, category, and search without fetching or changing event records',async()=>{
 const view=await renderDesignFixture(eventHubFixture());view.navigate('events');const before=view.requests.length;clickUI(view,'[data-action="hub-range"][data-value="today"]');assert.equal(view.document.querySelectorAll('#event-hub .event-hub-card').length,2);clickUI(view,'[data-action="hub-source"][data-value="email"]');assert.equal(view.document.querySelectorAll('#event-hub .event-hub-card').length,1);assert.ok(view.document.querySelector('[data-event-id="hub-email"]'));clickUI(view,'[data-action="hub-category"][data-value="networking"]');assert.equal(view.document.querySelectorAll('#event-hub .event-hub-card').length,0);clickUI(view,'[data-action="hub-reset"]');assert.equal(view.requests.length,before);
});
test('event search and all-date category controls preserve normalized cards and permit an empty filter result',async()=>{
 const view=await renderDesignFixture(eventHubFixture());view.navigate('events');clickUI(view,'[data-action="hub-range"][data-value="all"]');assert.equal(view.document.querySelectorAll('#event-hub .event-hub-card').length,5);clickUI(view,'[data-action="hub-category"][data-value="breaks"]');assert.equal(view.document.querySelectorAll('#event-hub .event-hub-card').length,1);view.document.querySelector('#event-hub-query').value='No matching event';submitUI(view,'#event-hub-search');assert.equal(view.document.querySelectorAll('#event-hub .event-hub-card').length,0);clickUI(view,'[data-action="hub-reset"]');assert.equal(view.document.querySelectorAll('#event-hub .event-hub-card').length,5);
});
test('email event review exposes escaped evidence and requires a second explicit approval before hub addition',async()=>{
 const view=await renderDesignFixture(eventHubFixture(),{'/api/event-hub/add':{calendarTask:{taskId:'sync'}}});view.navigate('events');clickUI(view,'[data-event-id="hub-email"] [data-action="hub-details"]');assert.equal(view.requests.some(r=>r.url==='/api/event-hub/add'),false);assert.match(view.document.querySelector('#detail-content').textContent,/PRIVATE_EVIDENCE <script>bad\(\)<\/script>/);assert.equal(view.document.querySelector('#detail-content script'),null);assert.equal(view.document.querySelector('#detail-content [data-action="hub-add"]').textContent,'Approve and add');clickUI(view,'#detail-content [data-action="hub-add"]');await settled();const r=view.requests.find(r=>r.url==='/api/event-hub/add');assert.deepEqual(JSON.parse(r.options.body),{id:'hub-email',revision:'2'.repeat(64)});assert.equal(r.options.headers['X-CSRF-Token'],'fixture');assert.equal(view.document.querySelector('#detail-dialog').open,false);
});
test('hub invitations omit evidence, account identity, and private link parameters',async()=>{
 const copied=[],view=await renderDesignFixture(eventHubFixture(),{}, {navigator:{clipboard:{writeText:async text=>copied.push(text)}}});view.navigate('events');clickUI(view,'[data-action="share-event"][data-source="hub"][data-id="hub-merged"]');const preview=view.document.querySelector('#event-share-preview').value;assert.match(preview,/Founder conversations/);assert.match(preview,/https:\/\/lu.ma\/founder-night/);assert.doesNotMatch(preview,/PRIVATE_|own-mailbox|Cornell email|sourceCalendar/);assert.equal(copied.length,0);clickUI(view,'[data-action="copy-event-invitation"]');await settled();assert.deepEqual(copied,[preview]);
});
test('email paste and custom-label selection use exact scoped API payloads while Outlook remains explicitly unsupported',async()=>{
 const view=await renderDesignFixture(eventHubFixture(),{'/api/event-email/import':{taskId:'email-import'},'/api/event-email/labels':[{id:'label-choice',name:'Invites <img src=x>'}],'/api/event-email/select':{},'/api/tasks':[{id:'email-import',status:'done'}]});view.navigate('events');assert.match(view.document.querySelector('#email-event-source').textContent,/Direct Outlook connection is not available/);assert.match(view.document.querySelector('#email-event-source').textContent,/mailbox-wide read-only/);view.document.querySelector('#email-event-source-name').value='Outlook invitation';view.document.querySelector('#email-event-text').value='Event: Product night\nDate: November 12 2026 at 6 pm\nLocation: Tata';selectOption(view.document.querySelector('#email-event-format'),'eml');submitUI(view,'#email-event-import-form');await settled();const r=view.requests.find(r=>r.url==='/api/event-email/import');assert.deepEqual(JSON.parse(r.options.body),{name:'Outlook invitation',text:'Event: Product night\nDate: November 12 2026 at 6 pm\nLocation: Tata',format:'eml'});assert.equal(r.options.headers['X-CSRF-Token'],'fixture');assert.equal(view.requests.some(r=>r.url==='/api/event-hub/add'),false);await view.timers.find(t=>t.ms===1500).callback();await settled();assert.equal(view.document.querySelector('#email-event-text').value,'');clickUI(view,'[data-action="list-event-email"]');await settled();assert.equal(view.document.querySelector('#event-email-label img'),null);selectOption(view.document.querySelector('#event-email-label'),'label-choice');submitUI(view,'#event-email-label-form');await settled();assert.deepEqual(JSON.parse(view.requests.find(r=>r.url==='/api/event-email/select').options.body),{labelId:'label-choice'});
});
test('late email label responses and queued imports cannot restore prior-student source state',async()=>{
 let signedIn=true,student='first',release;const delay=new Promise(resolve=>release=resolve),view=await renderDesignFixture(eventHubFixture(),{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/event-email/labels':()=>delay});view.navigate('events');view.document.querySelector('#email-event-text').value='PRIVATE_EMAIL_DRAFT';view.document.querySelector('#email-event-text').dispatchEvent(new view.window.Event('input',{bubbles:true}));clickUI(view,'[data-action="list-event-email"]');await settled();view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();release([{id:'private-label',name:'OLD_PRIVATE_LABEL'}]);await settled();view.navigate('events');assert.equal(view.document.querySelector('#event-email-label'),null);assert.equal(view.document.querySelector('#email-event-text').value,'');assert.doesNotMatch(view.document.querySelector('#main').textContent,/OLD_PRIVATE_LABEL|PRIVATE_EMAIL_DRAFT/);
});
test('undated email suggestions stay visible while cancelled plans leave the upcoming view and holiday ranges use inclusive dates',async()=>{
 const fixture=eventHubFixture();fixture.eventHub.items.push({id:'undated-email',title:'Invitation missing a date',date:null,start:null,category:'email',sourceLabels:['Email'],sources:[{kind:'email',label:'Email'}],status:'review',action:{kind:'email',id:'undated-record'}});fixture.events.push({id:'undated-record',title:'Invitation missing a date',date:null,start:null,kind:'event',status:'review'});fixture.eventHub.items.push({...fixture.eventHub.items[0],id:'cancelled-plan',title:'Cancelled plan',status:'cancelled'});const view=await renderDesignFixture(fixture);view.navigate('events');assert.ok(view.document.querySelector('[data-event-id="undated-email"]'));assert.equal(view.document.querySelector('[data-event-id="cancelled-plan"]'),null);assert.match(view.document.querySelector('#event-hub').textContent,/Needs a date/);clickUI(view,'[data-event-id="undated-email"] [data-action="hub-details"]');assert.equal(view.document.querySelector('#detail-content [data-action="hub-add"]'),null);view.document.querySelector('#detail-dialog').close();clickUI(view,'[data-action="hub-range"][data-value="all"]');assert.match(view.document.querySelector('[data-event-id="hub-holiday"]').textContent,/Nov 25 – Nov 29 · All day/);assert.doesNotMatch(view.document.querySelector('[data-event-id="hub-holiday"]').textContent,/Ends before/);assert.ok(view.document.querySelector('[data-event-id="cancelled-plan"]'));
});
test('an email with no end time requires a student-entered duration before approval',async()=>{
 const fixture=eventHubFixture();fixture.events.find(e=>e.id==='email-event').end=null;fixture.eventHub.items.find(e=>e.id==='hub-email').end=null;const view=await renderDesignFixture(fixture,{'/api/event-hub/add':{imported:1}});view.navigate('events');clickUI(view,'[data-event-id="hub-email"] [data-action="hub-details"]');assert.equal(view.document.querySelector('#hub-event-duration').value,'');clickUI(view,'#detail-content [data-action="hub-add"]');await settled();assert.equal(view.requests.some(r=>r.url==='/api/event-hub/add'),false);assert.match(view.document.querySelector('#hub-duration-error').textContent,/Enter a duration/);view.document.querySelector('#hub-event-duration').value='75';clickUI(view,'#detail-content [data-action="hub-add"]');await settled();assert.deepEqual(JSON.parse(view.requests.find(r=>r.url==='/api/event-hub/add').options.body),{id:'hub-email',revision:'2'.repeat(64),durationMinutes:75});
});
test('academic source refresh and queued event imports remain scoped across sign-out',async()=>{
 let signedIn=true,student='first';const fixture=eventHubFixture(),view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/academic/refresh':{taskId:'old-academic-job'}});view.navigate('events');clickUI(view,'[data-action="academic-refresh"]');await settled();assert.deepEqual(JSON.parse(view.requests.find(r=>r.url==='/api/academic/refresh').options.body),{});const timer=view.timers.find(t=>t.ms===1500);assert.ok(timer);view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();const count=view.requests.length;await timer.callback();assert.equal(view.requests.length,count);view.navigate('events');assert.doesNotMatch(view.document.querySelector('#event-hub').textContent,/Updating your event workspace/);
});
test('approval sends the revision shown in the review dialog even if a background refresh changes the event',async()=>{
 const fixture=eventHubFixture(),view=await renderDesignFixture(fixture,{'/api/luma/sync':{taskId:'background-read'},'/api/tasks':[{id:'background-read',status:'completed',result:{}}],'/api/event-hub/add':{imported:1}});view.navigate('events');clickUI(view,'[data-action="sync-luma"]');await settled();clickUI(view,'[data-event-id="hub-email"] [data-action="hub-details"]');assert.equal(view.document.querySelector('#detail-content [data-action="hub-add"]').dataset.revision,'2'.repeat(64));fixture.eventHub.items.find(item=>item.id==='hub-email').revision='f'.repeat(64);await view.timers.find(t=>t.ms===1500).callback();await settled();clickUI(view,'#detail-content [data-action="hub-add"]');await settled();const request=view.requests.find(r=>r.url==='/api/event-hub/add');assert.deepEqual(JSON.parse(request.options.body),{id:'hub-email',revision:'2'.repeat(64)});
});

function newsFixture(){const fixture=eventHubFixture();fixture.notifications={enabled:true,topics:{school:'both',events:'daily',jobs:'alerts',news:'off',games:'off'},available:{school:true,events:true,jobs:true,news:true,games:false},revision:1};fixture.news={settings:{sources:['wsj10point']},mailbox:{connected:true,accountEmail:'private-news@example.com',labelId:'news-own',labelName:'My newsletters',continuous:true,lastSuccess:'2026-11-10T18:00:00Z'},providers:[{id:'wsj10point',name:'WSJ',selected:true,latest:{id:'news-one',provider:'wsj10point',subject:'Tuesday briefing <script>bad()</script>',date:'2026-11-10T12:00:00Z',createdAt:'2026-11-10T19:00:00Z',bullets:[{text:'Synthetic market summary <img src=x>.',url:'https://wsj.com/business/example-story?tracking=PRIVATE_TRACKING#section'},{text:'A second synthetic point.',url:'https://wsj.com/account/settings?token=PRIVATE_TOKEN'},{text:'Unsupported third-party link.',url:'https://attacker.example/article'}],source:{kind:'gmail',senderDomainMatched:true},warnings:['Check context <img src=x>.']}},{id:'dailypitch',name:'PitchBook',selected:false,latest:null}],summaries:[],warnings:[]};return fixture;}
function setCheckbox(view,id,value){const input=view.document.querySelector('#'+id);input.checked=value;input.dispatchEvent(new view.window.Event('change',{bubbles:true}));}
test('News renders only private cached summaries with safe publisher links, freshness, and honest empty states',async()=>{
 const view=await renderDesignFixture(newsFixture());view.navigate('news');assert.equal(view.document.querySelector('[data-page="news"]').getAttribute('aria-current'),'page');assert.equal(view.document.querySelector('#breadcrumb').textContent,'News');const main=view.document.querySelector('#main');assert.equal(main.querySelector('script,img'),null);assert.match(main.textContent,/Tuesday briefing <script>bad\(\)<\/script>/);assert.ok(main.querySelector('a[href="https://www.wsj.com/business/example-story"]'));assert.equal(main.querySelector('a[href*="PRIVATE_"],a[href*="attacker.example"],a[href*="/account/"]'),null);assert.match(main.textContent,/No sample headlines/);assert.match(main.textContent,/not an authenticity guarantee/);assert.match(main.textContent,/not a live news feed/);assert.match(main.textContent,/publisher subscription/);assert.equal(main.querySelector('[data-action="share-event"]'),null);assert.match(main.textContent,/Automatic News delivery: Off/);
});
test('notification choices preserve backend legacy modes and start fresh students with all topics off',async()=>{
 const old=await renderDesignFixture(newsFixture());old.navigate('connections');assert.equal(old.document.querySelector('#notification-school-daily').hasAttribute('checked'),true);assert.equal(old.document.querySelector('#notification-school-alerts').hasAttribute('checked'),true);assert.equal(old.document.querySelector('#notification-events-alerts').hasAttribute('checked'),false);assert.equal(old.document.querySelector('#notification-jobs-alerts').hasAttribute('checked'),true);assert.equal(old.document.querySelector('#notification-news-daily').hasAttribute('checked'),false);assert.ok(old.document.querySelector('label.checkbox-control[for="notification-games-daily"] > span'));assert.match(old.document.querySelector('#notification-games-help').textContent,/not available yet/);assert.equal(old.document.querySelector('#notification-games-daily').disabled,false);
 const fresh=newsFixture();fresh.notifications.topics=Object.fromEntries(['school','events','jobs','news','games'].map(key=>[key,'off']));const view=await renderDesignFixture(fresh);view.navigate('connections');assert.equal(view.document.querySelectorAll('.notification-table input[checked]').length,0);assert.equal(view.requests.some(r=>r.url==='/api/notifications/settings'),false);
});
test('notification checkboxes save exact daily/alerts modes, future games preference, master switch, and CSRF',async()=>{
 const fixture=newsFixture(),view=await renderDesignFixture(fixture,{'/api/notifications/settings':options=>{const data=JSON.parse(options.body);fixture.notifications={...fixture.notifications,...data};return fixture.notifications;}});view.navigate('connections');setCheckbox(view,'notification-news-daily',true);setCheckbox(view,'notification-games-alerts',true);setCheckbox(view,'notification-school-alerts',false);setCheckbox(view,'notifications-enabled',false);submitUI(view,'#notification-settings-form');await settled();const request=view.requests.find(r=>r.url==='/api/notifications/settings');assert.deepEqual(JSON.parse(request.options.body),{enabled:false,topics:{school:'daily',events:'daily',jobs:'alerts',news:'daily',games:'alerts'}});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');assert.match(view.document.querySelector('#notification-settings-status').textContent,/saved/);assert.match(view.document.querySelector('#notification-draft-help').textContent,/delivery is off/);assert.match(view.document.querySelector('#notification-games-help').textContent,/does not enable any game/);
});
test('unsaved notification choices survive navigation and failed saves without changing stored settings',async()=>{
 const fixture=newsFixture(),view=await renderDesignFixture(fixture,{'/api/notifications/settings':()=>{throw new Error('Settings service unavailable');}});view.navigate('connections');setCheckbox(view,'notification-news-alerts',true);assert.match(view.document.querySelector('#notification-settings-status').textContent,/Unsaved/);view.navigate('news');view.navigate('connections');assert.equal(view.document.querySelector('#notification-news-alerts').hasAttribute('checked'),true);submitUI(view,'#notification-settings-form');await settled();assert.match(view.document.querySelector('#notification-settings-status').textContent,/Settings service unavailable/);assert.equal(view.document.querySelector('#notification-news-alerts').hasAttribute('checked'),true);assert.equal(fixture.notifications.topics.news,'off');clickUI(view,'[data-action="reset-notifications"]');assert.equal(view.document.querySelector('#notification-news-alerts').hasAttribute('checked'),false);
});
test('manual newsletter import and source opt-in stay separate from notification delivery',async()=>{
 const fixture=newsFixture(),view=await renderDesignFixture(fixture,{'/api/news/import':{taskId:'import-news'},'/api/tasks':[{id:'import-news',status:'completed'}],'/api/news/automatic':options=>{fixture.news.settings=JSON.parse(options.body);return fixture.news.settings;}});view.navigate('news');selectOption(view.document.querySelector('#news-import-provider'),'dailypitch');view.document.querySelector('#news-import-name').value='Exported Daily Pitch';view.document.querySelector('#news-import-text').value='Synthetic newsletter text for an explicit private import.';selectOption(view.document.querySelector('#news-import-format'),'eml');submitUI(view,'#news-import-form');await settled();const r=view.requests.find(r=>r.url==='/api/news/import');assert.deepEqual(JSON.parse(r.options.body),{provider:'dailypitch',name:'Exported Daily Pitch',text:'Synthetic newsletter text for an explicit private import.',format:'eml'});assert.equal(r.options.headers['X-CSRF-Token'],'fixture');await view.timers.find(t=>t.ms===1500).callback();await settled();setCheckbox(view,'news-source-dailypitch',true);submitUI(view,'#news-source-form');await settled();assert.deepEqual(JSON.parse(view.requests.find(r=>r.url==='/api/news/automatic').options.body),{sources:['wsj10point','dailypitch']});assert.equal(view.requests.some(r=>r.url==='/api/notifications/settings'),false);assert.equal(fixture.notifications.topics.news,'off');
});
test('news .eml file loading is explicit, bounded, and waits for a separate summarize action',async()=>{
 const view=await renderDesignFixture(newsFixture());view.navigate('news');let input=view.document.querySelector('#news-eml-file');Object.defineProperty(input,'files',{value:[{name:'Daily Pitch.eml',size:80,text:async()=> 'Subject: Example newsletter\n\nSynthetic body only.'}]});input.dispatchEvent(new view.window.Event('change',{bubbles:true}));await settled();assert.equal(view.document.querySelector('#news-import-format').value,'eml');assert.equal(view.document.querySelector('#news-import-name').value,'Daily Pitch.eml');assert.match(view.document.querySelector('#news-import-text').value,/Synthetic body/);assert.equal(view.requests.some(r=>r.url==='/api/news/import'),false);input=view.document.querySelector('#news-eml-file');Object.defineProperty(input,'files',{value:[{name:'too-large.eml',size:100001,text:async()=>{throw new Error('Must not read');}}]});input.dispatchEvent(new view.window.Event('change',{bubbles:true}));await settled();assert.match(view.document.querySelector('.news-status').textContent,/no larger than 100 KB/);
});
test('newsletter errors do not claim success and polling cannot continue for a later student',async()=>{
 const first=await renderDesignFixture(newsFixture(),{'/api/news/sync':{taskId:'news-failed'},'/api/tasks':[{id:'news-failed',status:'needs_review'}]});first.navigate('news');clickUI(first,'[data-action="sync-news"]');await settled();await first.timers.find(t=>t.ms===1500).callback();await settled();assert.match(first.document.querySelector('.news-status').textContent,/needs attention/);
 let signedIn=true,student='first';const view=await renderDesignFixture(newsFixture(),{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/news/sync':{taskId:'old-news-job'}});view.navigate('news');clickUI(view,'[data-action="sync-news"]');await settled();const timer=view.timers.find(t=>t.ms===1500);view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();const count=view.requests.length;await timer.callback();assert.equal(view.requests.length,count);
});
test('delayed news labels, imported-text drafts, and notification responses stay with the original student',async()=>{
 let signedIn=true,student='first',release;const pending=new Promise(resolve=>release=resolve),view=await renderDesignFixture(newsFixture(),{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/news/labels':()=>pending});view.navigate('news');view.document.querySelector('#news-import-text').value='PRIVATE_FIRST_STUDENT_NEWS';view.document.querySelector('#news-import-text').dispatchEvent(new view.window.Event('input',{bubbles:true}));clickUI(view,'[data-action="list-news-labels"]');await settled();view.navigate('connections');setCheckbox(view,'notification-news-daily',true);clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();release([{id:'old-label',name:'PRIVATE_FIRST_STUDENT_LABEL'}]);await settled();view.navigate('news');assert.equal(view.document.querySelector('#news-label'),null);assert.equal(view.document.querySelector('#news-import-text').value,'');assert.doesNotMatch(view.document.querySelector('#main').textContent,/PRIVATE_FIRST/);view.navigate('connections');assert.equal(view.document.querySelector('#notification-news-daily').hasAttribute('checked'),false);
});
test('a notification save response from an earlier session cannot reload or change the later student workspace',async()=>{
 let signedIn=true,student='first',release;const pending=new Promise(resolve=>release=resolve),view=await renderDesignFixture(newsFixture(),{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/notifications/settings':()=>pending});view.navigate('connections');setCheckbox(view,'notification-news-daily',true);submitUI(view,'#notification-settings-form');await settled();assert.equal(view.document.querySelector('#notifications-enabled').disabled,true);clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();const count=view.requests.length;release({enabled:true,topics:{news:'daily'}});await settled();assert.equal(view.requests.length,count);assert.equal(view.document.querySelector('#notification-news-daily').hasAttribute('checked'),false);assert.doesNotMatch(view.document.querySelector('#notification-settings-status').textContent,/saved/);
});

test('only the operator sees private sheet setup and sync failures are escaped',async()=>{
 const student=await renderDesignFixture(designFixture());student.navigate('connections');assert.equal(student.document.querySelector('#pilot-access'),null);assert.equal(student.requests.some(r=>r.url==='/api/pilot-access'),false);
 const operator=await renderDesignFixture(designFixture(),{'/api/session':{user:{id:'owner',email:'owner@cornell.edu'},csrfToken:'synthetic',pilotAccessAdmin:true},'/api/pilot-access':{configured:true,active:false,connected:false,error:'<script>secret()</script>',sheetURL:'https://docs.google.com/spreadsheets/d/test/edit'}});operator.navigate('connections');
 assert.ok(operator.document.querySelector('[data-action="connect-pilot-sheet"]'));assert.equal(operator.document.querySelector('#pilot-access script'),null);assert.match(operator.document.querySelector('#pilot-access').textContent,/existing pilot list stays active/);assert.match(operator.document.querySelector('#pilot-access').textContent,/read access to all your spreadsheets/);
});

function chooseSyllabusFile(view,file,selector='#syllabus-file'){
 const input=view.document.querySelector(selector);Object.defineProperty(input,'files',{value:[file],configurable:true});input.dispatchEvent(new view.window.Event('change',{bubbles:true}));
}
test('syllabus upload provides photo capture, readable accepted formats and an explicit academic term',async()=>{
 const view=await renderDesignFixture(designFixture());view.navigate('academics');
 assert.equal(view.document.querySelector('#syllabus-file').getAttribute('accept'),'application/pdf,image/jpeg,image/png');
 const camera=view.document.querySelector('#syllabus-camera');assert.equal(camera.getAttribute('accept'),'image/jpeg,image/png');assert.equal(camera.getAttribute('capture'),'environment');
 assert.equal(view.document.querySelector('#resume-file').getAttribute('accept'),'application/pdf');
 assert.ok(view.document.querySelector('[data-action="camera-syllabus"]'));assert.ok(view.document.querySelector('label[for="syllabus-term"]'));
 assert.deepEqual([...view.document.querySelectorAll('#syllabus-term option')].map(option=>option.value),['FA26','SP27']);
 assert.match(view.document.querySelector('#syllabus-upload-area').textContent,/JPG\/PNG|JPG.*PNG/);assert.equal(view.document.querySelector('#syllabus-upload-status').getAttribute('role'),'status');
});

test('a syllabus photo queues its MIME and selected term, with visible progress and review on completion',async()=>{
 const view=await renderDesignFixture(designFixture(),{'/api/upload':{taskId:'syllabus-photo'},'/api/tasks':[{id:'syllabus-photo',status:'done',result:{count:2}}]});view.navigate('academics');
 selectOption(view.document.querySelector('#syllabus-term'),'SP27');view.document.querySelector('#syllabus-term').dispatchEvent(new view.window.Event('change',{bubbles:true}));
 chooseSyllabusFile(view,{name:'synthetic-syllabus.png',type:'image/png',size:100,base64:'c3ludGhldGlj'});await settled();
 const request=view.requests.find(r=>r.url==='/api/upload');assert.ok(request);assert.deepEqual(JSON.parse(request.options.body),{type:'syllabus',name:'synthetic-syllabus.png',base64:'c3ludGhldGlj',mimeType:'image/png',term:'SP27'});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');
 assert.match(view.document.querySelector('#syllabus-upload-status').textContent,/Reading|Processing|Queued/i);assert.equal(view.document.querySelector('#syllabus-term').disabled,true);
 chooseSyllabusFile(view,{name:'second.png',type:'image/png',size:100});await settled();assert.equal(view.requests.filter(r=>r.url==='/api/upload').length,1,'pending upload blocks duplicate queueing');
 await view.timers.find(timer=>timer.ms===1500).callback();await settled();assert.match(view.document.querySelector('#syllabus-upload-status').textContent,/review/i);assert.equal(view.document.querySelector('#syllabus-term').disabled,false);
 assert.equal(view.requests.some(r=>r.url==='/api/google/sync'||r.url==='/api/events/review'),false);
});

test('camera uploads infer missing JPEG MIME while HEIC, misleading MIME and oversized photos fail before sending',async()=>{
 const view=await renderDesignFixture(designFixture(),{'/api/upload':{taskId:'camera-photo'}});view.navigate('academics');
 for(const file of [{name:'syllabus.heic',type:'image/heic',size:100},{name:'pretend.jpg',type:'image/heic',size:100},{name:'large.png',type:'image/png',size:12*1024*1024+1}]){
  chooseSyllabusFile(view,file);await settled();assert.equal(view.requests.some(r=>r.url==='/api/upload'),false);assert.ok(view.document.querySelector('#syllabus-upload-status').textContent.trim());
 }
 chooseSyllabusFile(view,{name:'camera.JPG',type:'',size:100,base64:'c3ludGhldGlj'},'#syllabus-camera');await settled();
 assert.equal(JSON.parse(view.requests.find(r=>r.url==='/api/upload').options.body).mimeType,'image/jpeg');
});

test('a failed syllabus extraction stays visible next to the upload controls and safely escapes its message',async()=>{
 const view=await renderDesignFixture(designFixture(),{'/api/upload':{taskId:'photo-error'},'/api/tasks':[{id:'photo-error',status:'error',error:'Send a clearer photo <img src=x onerror=bad()>.'}]});view.navigate('academics');
 chooseSyllabusFile(view,{name:'syllabus.png',type:'image/png',size:100});await settled();await view.timers.find(timer=>timer.ms===1500).callback();await settled();
 const status=view.document.querySelector('#syllabus-upload-status');assert.match(status.textContent,/clearer photo/);assert.equal(status.querySelector('img'),null);assert.equal(view.document.querySelector('#syllabus-term').disabled,false);
});

test('a delayed syllabus file read cannot upload the original student photo after sign-out',async()=>{
 let signedIn=true,student='first',reader;
 const view=await renderDesignFixture(designFixture(),{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};}},{FileReader:class{readAsDataURL(){reader=this;}}});
 view.navigate('academics');chooseSyllabusFile(view,{name:'PRIVATE_FIRST_PHOTO.png',type:'image/png',size:100});await settled();assert.ok(reader);
 view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();const count=view.requests.length;
 reader.result='data:image/png;base64,cHJpdmF0ZQ==';reader.onload();await settled();assert.equal(view.requests.length,count);assert.equal(view.requests.some(r=>r.url==='/api/upload'),false);view.navigate('academics');assert.doesNotMatch(view.document.querySelector('#syllabus-upload-status').textContent,/PRIVATE_FIRST/);
});

function classMeeting(id,date,extra={}){
 return {id,title:'NBAY 5300 · Synthetic finance',kind:'class',date,time:'13:25',start:`${date}T18:25:00Z`,end:`${date}T19:40:00Z`,status:'review',sourceId:'finance-source',sourceName:'Finance syllabus <img src=x onerror=bad()>',courseId:'NBAY-5300',sectionId:'LEC-001',term:'FA26',evidence:'Published individual meeting date.',evidenceVerified:true,location:'Tata L23',...extra};
}
function classScheduleFixture(){return designFixture([
 classMeeting('past-meeting','2026-11-04'),classMeeting('first-meeting','2026-11-11'),classMeeting('second-meeting','2026-11-18'),classMeeting('later-meeting','2026-12-02'),
 classMeeting('changed-room','2026-11-20',{time:'15:00',start:'2026-11-20T20:00:00Z',end:'2026-11-20T21:15:00Z',location:'Tata L24'}),
 classMeeting('already-reviewed','2026-11-16',{status:'approved'}),classMeeting('missing-time','2026-11-23',{time:null,start:null,end:null}),
 classMeeting('invalid-end','2026-11-25',{end:'not-a-date'}),classMeeting('unverified','2026-11-27',{evidenceVerified:false}),classMeeting('cancelled','2026-11-30',{cancelled:true}),
 {id:'separate-deadline',title:'Finance deck',kind:'assignment',date:'2026-12-03',start:'2026-12-03T22:00:00Z',end:'2026-12-03T22:01:00Z',status:'review',evidenceVerified:true,sourceName:'Syllabus',evidence:'Deck due December 3 at 5 PM.'}
]);}
function toggleScheduleCheckbox(view,checkbox,checked=true){
 // Linkedom has no native checked-state reflection for programmatic group
 // selections; keep :checked queries consistent with the browser's live state.
 for(const input of view.document.querySelectorAll('.event-check,.class-schedule-check,#select-all')){
  if(Object.getOwnPropertyDescriptor(input,'checked')?.get)continue;
  const selected=typeof input.checked==='boolean'?input.checked:input.hasAttribute('checked');
  Object.defineProperty(input,'checked',{configurable:true,get(){return this.hasAttribute('checked');},set(value){if(value)this.setAttribute('checked','');else this.removeAttribute('checked');}});input.checked=selected;
 }
 checkbox.checked=checked;checkbox.dispatchEvent(new view.window.Event('change',{bubbles:true}));
}
function selectedScheduleDates(view){return [...view.document.querySelectorAll('.event-check')].filter(checkbox=>checkbox.checked).map(checkbox=>checkbox.value).sort();}

test('recurring classes share an expandable schedule without hiding irregular or unresolved imported meetings',async()=>{
 const view=await renderDesignFixture(classScheduleFixture());view.navigate('academics');
 const panel=view.document.querySelector('.academic-schedule'),cards=panel.querySelectorAll('.class-schedule-card');assert.equal(cards.length,1);
 const card=cards[0];assert.ok(card.querySelector('details'));assert.ok(card.querySelector('.schedule-pattern').textContent.trim());assert.ok(card.querySelector('.schedule-exceptions').textContent.trim());
 assert.equal(card.querySelector('img'),null);assert.match(card.textContent,/<img src=x onerror=bad\(\)>/);
 assert.ok(card.querySelector('.event-check[value="changed-room"]'));assert.match(card.textContent,/Tata L24/);
 assert.equal(card.querySelector('.event-check[value="already-reviewed"]').disabled,true);assert.equal(card.querySelector('.event-check[value="missing-time"]').disabled,true);assert.equal(card.querySelector('.event-check[value="invalid-end"]').disabled,true);assert.equal(card.querySelector('.event-check[value="unverified"]').disabled,true);
 assert.equal(card.querySelector('.event-check[value="past-meeting"]'),null);assert.equal(card.querySelector('.event-check[value="cancelled"]'),null);
 assert.equal(card.querySelector('.event-check[value="separate-deadline"]'),null);assert.ok(panel.querySelector('.event-check[value="separate-deadline"]'));
 assert.deepEqual(selectedScheduleDates(view),[]);assert.equal(view.requests.some(request=>request.url==='/api/events/review'),false);
});

test('selecting one class schedule approves exactly its visible eligible occurrence IDs and leaves deadlines untouched',async()=>{
 const view=await renderDesignFixture(classScheduleFixture(),{'/api/events/review':{count:4}});view.navigate('academics');
 toggleScheduleCheckbox(view,view.document.querySelector('.event-check[value="first-meeting"]'));assert.equal(view.document.querySelector('.class-schedule-check').indeterminate,true);assert.equal(view.document.querySelector('.class-schedule-check').checked,false);
 toggleScheduleCheckbox(view,view.document.querySelector('.class-schedule-check'));
 const expected=['changed-room','first-meeting','later-meeting','second-meeting'].sort();assert.deepEqual(selectedScheduleDates(view),expected);
 assert.match(view.document.querySelector('#selection-count').textContent,/4 dates.*selected/);assert.equal(view.document.querySelector('.event-check[value="separate-deadline"]').checked||false,false);
 assert.equal(view.requests.some(request=>request.url==='/api/events/review'),false);
 clickUI(view,'[data-action="approve"]');await settled();const request=view.requests.find(request=>request.url==='/api/events/review');assert.ok(request);const payload=JSON.parse(request.options.body);assert.equal(payload.action,'approve');assert.deepEqual(payload.ids.sort(),expected);assert.equal(request.options.headers['X-CSRF-Token'],'fixture');
 assert.deepEqual(payload.expected.map(event=>event.id).sort(),expected);assert.equal(payload.expected.find(event=>event.id==='changed-room').location,'Tata L24');assert.equal(payload.expected.find(event=>event.id==='first-meeting').end,'2026-11-11T19:40:00Z');assert.equal(payload.expected.find(event=>event.id==='first-meeting').updatedAt,null);
 assert.equal(payload.ids.some(id=>['already-reviewed','missing-time','invalid-end','unverified','cancelled','past-meeting','separate-deadline'].includes(id)),false);
});

test('schedule filters rebuild selection from visible dates and all-imported retains reviewed, past and cancelled records',async()=>{
 const view=await renderDesignFixture(classScheduleFixture(),{'/api/events/review':{count:5}});view.navigate('academics');toggleScheduleCheckbox(view,view.document.querySelector('.class-schedule-check'));
 view.document.querySelector('[data-filter="all"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));
 assert.deepEqual(selectedScheduleDates(view),[]);assert.ok(view.document.querySelector('.event-check[value="past-meeting"]'));assert.ok(view.document.querySelector('.event-check[value="cancelled"]'));assert.ok(view.document.querySelector('.event-check[value="already-reviewed"]'));
 assert.equal(view.document.querySelector('.event-check[value="cancelled"]').disabled,true);assert.equal(view.document.querySelector('.event-check[value="already-reviewed"]').disabled,true);
 toggleScheduleCheckbox(view,view.document.querySelector('.class-schedule-check'));assert.deepEqual(selectedScheduleDates(view),['changed-room','first-meeting','later-meeting','past-meeting','second-meeting'].sort());
 view.document.querySelector('[data-filter="review"]').dispatchEvent(new view.window.Event('click',{bubbles:true}));assert.deepEqual(selectedScheduleDates(view),[]);assert.equal(view.document.querySelector('.event-check[value="already-reviewed"]'),null);assert.ok(view.document.querySelector('.event-check[value="past-meeting"]'));assert.ok(view.document.querySelector('.event-check[value="missing-time"]'));
 toggleScheduleCheckbox(view,view.document.querySelector('.class-schedule-check'));clickUI(view,'[data-action="approve"]');await settled();const payload=JSON.parse(view.requests.find(request=>request.url==='/api/events/review').options.body);assert.deepEqual(payload.ids.sort(),['changed-room','first-meeting','later-meeting','past-meeting','second-meeting'].sort());
});

test('select all does not silently truncate a schedule that exceeds the 200-date review limit',async()=>{
 const events=Array.from({length:201},(_,index)=>{const date=new Date(Date.UTC(2026,10,11+index)).toISOString().slice(0,10);return classMeeting(`meeting-${index}`,date);}),view=await renderDesignFixture(designFixture(events));view.navigate('academics');
 toggleScheduleCheckbox(view,view.document.querySelector('#select-all'));const selected=selectedScheduleDates(view);assert.notEqual(selected.length,200,'oversized selection must never silently discard the last meeting');assert.ok(selected.length===0||selected.length===201);assert.equal(view.document.querySelector('[data-action="approve"]').disabled,true);assert.match(view.document.querySelector('#main').textContent,/200/);assert.equal(view.requests.some(request=>request.url==='/api/events/review'),false);
});

test('events precede collapsed connector setup, which distinguishes stopped reads from active auto-add',async()=>{
 const fixture=lumaFixture();fixture.partifulCalendar.continuous=false;fixture.lumaConnected=false;fixture.lumaCalendar=null;const view=await renderDesignFixture(fixture);view.navigate('events');const setup=view.document.querySelector('#social-connectors-setup'),partiful=setup.querySelector('[data-provider="partiful"]'),luma=setup.querySelector('[data-provider="luma"]');assert.ok(setup);assert.equal(setup.closest('details').id,'event-sources');assert.ok(view.document.querySelector('#main').innerHTML.indexOf('id="event-hub"')<view.document.querySelector('#main').innerHTML.indexOf('id="event-sources"'));assert.equal(view.document.querySelector('#event-sources').hasAttribute('open'),false);assert.match(partiful.querySelector('.tag').textContent,/Refresh stopped/);assert.match(luma.querySelector('.tag').textContent,/Not connected/);assert.equal(setup.querySelectorAll('ol li').length,6);assert.match(setup.textContent,/do not submit an RSVP or buy tickets/);assert.ok(setup.querySelector('a[href="#connections"]'));assert.equal(setup.querySelector('img,script'),null);
});
test('social connector shortcuts reveal the chosen calendar picker without a write or a Telegram send',async()=>{
 const view=await renderDesignFixture(lumaFixture(),{'/api/partiful/calendars':[{id:'p-choice',name:'Partiful <img src=x>'}],'/api/luma/calendars':[{id:'l-choice',summary:'Luma <img src=x>'}]});view.navigate('events');for(const provider of ['partiful','luma']){clickUI(view,'#social-connectors-setup [data-action="setup-social"][data-provider="'+provider+'"]');await settled();assert.equal(view.document.querySelector('#event-sources').hasAttribute('open'),true);assert.ok(view.document.querySelector('#'+provider+'-calendar'));assert.equal(view.document.querySelector('#'+provider+'-calendar img'),null);}assert.equal(view.requests.some(r=>/\/(?:settings|telegram|select)$/.test(r.url)),false);
});
test('social auto-add requires Google writing and changing it posts an explicit provider-scoped opt-in',async()=>{
 const fixture=lumaFixture();fixture.connections.google.connected=false;fixture.lumaCalendar.autoAdd=true;let view=await renderDesignFixture(fixture);view.navigate('events');assert.equal(view.document.querySelector('#social-connectors-setup [data-action="social-auto-add"]'),null);assert.doesNotMatch(view.document.querySelector('.social-connector-card[data-provider="luma"] .tag').textContent,/Auto-add on/);assert.match(view.document.querySelector('#social-connectors-setup').textContent,/Connect Google Calendar in Connections/);
 fixture.connections.google.connected=true;fixture.lumaCalendar.autoAdd=false;view=await renderDesignFixture(fixture,{'/api/luma/settings':options=>{fixture.lumaCalendar.autoAdd=JSON.parse(options.body).autoAdd;return{};}});view.navigate('events');clickUI(view,'#social-connectors-setup [data-action="social-auto-add"][data-provider="luma"]');await settled();const request=view.requests.find(r=>r.url==='/api/luma/settings');assert.deepEqual(JSON.parse(request.options.body),{autoAdd:true});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');assert.match(view.document.querySelector('.social-connector-card[data-provider="luma"] .tag').textContent,/Auto-add on/);assert.equal(view.requests.some(r=>r.url==='/api/partiful/settings'),false);
});
test('social event Telegram sends require a linked chat and preserve the selected provider and event ID',async()=>{
 const fixture=lumaFixture();let view=await renderDesignFixture(fixture);view.navigate('events');let button=view.document.querySelector('#luma-events [data-action="send-social-event"][data-id="luma-owned"]');assert.equal(button.disabled,true);button.disabled=false;button.dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();assert.equal(view.requests.some(r=>r.url.endsWith('/telegram')),false);assert.match(view.document.querySelector('#social-connector-status').textContent,/Link Telegram/);
 fixture.connections.telegram.linked=true;view=await renderDesignFixture(fixture,{'/api/partiful/telegram':{queued:true},'/api/luma/telegram':{queued:true}});view.navigate('events');for(const provider of ['partiful','luma']){clickUI(view,'#'+provider+'-events [data-action="send-social-event"][data-id="'+provider+'-owned"]');await settled();const request=view.requests.find(r=>r.url==='/api/'+provider+'/telegram');assert.deepEqual(JSON.parse(request.options.body),{id:provider+'-owned'});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');}assert.match(view.document.querySelector('#toast').textContent,/queued for your linked Telegram/);assert.equal(view.requests.some(r=>/\/(?:add|intent)$/.test(r.url)),false);assert.match(view.document.querySelector('#luma-events a[href="https://lu.ma/founder-night"]').textContent,/Register on Luma/);
});
test('late social Telegram replies cannot show another student a previous student success or error',async()=>{
 for(const failure of [false,true]){let signedIn=true,student='first',release;const pending=new Promise((resolve,reject)=>{release=()=>failure?reject(new Error('OLD_PRIVATE_SEND_ERROR')):resolve({queued:true});}),fixture=lumaFixture();fixture.connections.telegram.linked=true;const view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/luma/telegram':()=>pending});view.navigate('events');clickUI(view,'#luma-events [data-action="send-social-event"][data-id="luma-owned"]');await settled();view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();view.navigate('events');const previousToast=view.document.querySelector('#toast').textContent;release();await settled();assert.equal(view.document.querySelector('#toast').textContent,previousToast);assert.doesNotMatch(view.document.querySelector('#social-connector-status').textContent,/OLD_PRIVATE_SEND_ERROR|queued for your linked/);}
});

test('automatic newsletter setup uses the connected inbox without requiring a Gmail label',async()=>{
 const fixture=newsFixture();fixture.news.settings.sources=[];Object.assign(fixture.news.mailbox,{labelId:null,labelName:null,continuous:false,lastSuccess:null});const view=await renderDesignFixture(fixture,{'/api/news/automatic':options=>{fixture.news.settings=JSON.parse(options.body);Object.assign(fixture.news.mailbox,{mode:'automatic',automatic:true,continuous:true});return {taskId:'automatic-news'};},'/api/tasks':[{id:'automatic-news',status:'completed',result:{matched:1,processed:1}}]});view.navigate('news');assert.equal(view.document.querySelector('#news-advanced').hasAttribute('open'),false);assert.match(view.document.querySelector('#news-source-settings').textContent,/no Gmail label needed/);assert.ok(view.document.querySelector('#news-workspace').innerHTML.indexOf('news-grid')<view.document.querySelector('#news-workspace').innerHTML.indexOf('news-source-settings'));assert.equal(view.document.querySelector('#news-source-form button').disabled,true);setCheckbox(view,'news-source-wsj10point',true);setCheckbox(view,'news-source-dailypitch',true);submitUI(view,'#news-source-form');await settled();const request=view.requests.find(r=>r.url==='/api/news/automatic');assert.deepEqual(JSON.parse(request.options.body),{sources:['wsj10point','dailypitch']});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');assert.equal(view.document.querySelector('#news-source-form fieldset').hasAttribute('disabled'),true);await view.timers.find(t=>t.ms===1500).callback();await settled();assert.match(view.document.querySelector('#news-source-settings .tag').textContent,/Automatic reading on/);assert.match(view.document.querySelector('.news-status').textContent,/briefings are ready/);assert.equal(view.requests.some(r=>['/api/news/labels','/api/news/select','/api/notifications/settings'].includes(r.url)),false);
});
test('automatic news shows source-specific missing-email guidance and a subscription link without inventing a briefing',async()=>{
 const fixture=newsFixture();fixture.news.settings.sources=['wsj10point','dailypitch'];Object.assign(fixture.news.mailbox,{mode:'automatic',automatic:true,labelId:null,continuous:true,lastScan:{matched:1,matchedSources:['wsj10point'],missingSources:['dailypitch'],truncated:false}});const view=await renderDesignFixture(fixture);view.navigate('news');const missing=view.document.querySelector('.news-dailypitch');assert.match(missing.textContent,/No matching Daily Pitch email/);assert.ok(missing.querySelector('a[href="https://pitchbook.com/subscribe"]'));assert.equal(missing.querySelector('.news-bullets'),null);assert.match(view.document.querySelector('.news-wsj10point').textContent,/Synthetic market summary/);assert.equal(view.document.querySelector('#news-advanced').hasAttribute('open'),false);
});
test('automatic news distinguishes no matches, limited search, and assistant pause',async()=>{
 const fixture=newsFixture();fixture.news.mailbox.lastScan={matched:0,missingSources:['dailypitch'],truncated:true};let view=await renderDesignFixture(fixture,{'/api/news/automatic':{taskId:'none'},'/api/tasks':[{id:'none',status:'completed',result:{matched:0,processed:0,truncated:true}}]});view.navigate('news');assert.match(view.document.querySelector('.news-search-result').textContent,/search was limited/);submitUI(view,'#news-source-form');await settled();await view.timers.find(t=>t.ms===1500).callback();await settled();assert.match(view.document.querySelector('.news-status').textContent,/No matching newsletters/);assert.doesNotMatch(view.document.querySelector('.news-status').textContent,/briefings are ready/);
 fixture.profile.paused=true;view=await renderDesignFixture(fixture);view.navigate('news');assert.match(view.document.querySelector('#news-source-settings .tag').textContent,/Paused/);assert.equal(view.document.querySelector('#news-source-form button').disabled,true);submitUI(view,'#news-source-form');await settled();assert.equal(view.requests.some(r=>r.url==='/api/news/automatic'),false);
});
test('news without a mailbox connects first and never starts an inbox search implicitly',async()=>{
 const fixture=newsFixture();fixture.news.mailbox={connected:false};const view=await renderDesignFixture(fixture,{'/api/news/connect':{url:'https://example.invalid/oauth'}});view.navigate('news');assert.ok(view.document.querySelector('#news-source-form [data-action="connect-news"]'));assert.equal(view.document.querySelector('#news-source-form fieldset').hasAttribute('disabled'),true);assert.equal(view.requests.some(r=>r.url==='/api/news/automatic'),false);clickUI(view,'#news-source-form [data-action="connect-news"]');await settled();assert.deepEqual(JSON.parse(view.requests.find(r=>r.url==='/api/news/connect').options.body),{});assert.equal(view.requests.some(r=>r.url==='/api/news/automatic'),false);
});
test('automatic newsletter activation replies cannot populate a later student workspace',async()=>{
 let signedIn=true,student='first',release;const pending=new Promise(resolve=>release=resolve),view=await renderDesignFixture(newsFixture(),{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/news/automatic':()=>pending});view.navigate('news');submitUI(view,'#news-source-form');await settled();view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();view.navigate('news');const before=view.requests.length;release({taskId:'old-private-news'});await settled();assert.equal(view.requests.length,before);assert.equal(view.timers.some(timer=>timer.ms===1500),false);assert.doesNotMatch(view.document.querySelector('.news-status').textContent,/queued|ready|old-private/);
});

function careerBrowserFixture(){
 const fixture=discoveryFixture();fixture.jobs=[
  {id:'sony-remote',company:'Sony',title:'Product Manager',description:'Lead research and product delivery.',location:'New York',workplaceType:'remote',employmentType:'full-time',salary:'$120,000–$150,000',experienceFit:{status:'within-range'},provider:'greenhouse',publishedAt:'2026-11-10T20:00:00Z',url:'https://example.com/sony',status:'open',saved:false},
  {id:'adobe-analyst',company:'Adobe',title:'Data Analyst',description:'Evaluate product experiments.',location:'Boston',workplaceType:'hybrid',employmentType:'contract',experienceFit:{status:'stretch'},provider:'greenhouse',publishedAt:'2026-11-10T19:00:00Z',url:'https://example.com/adobe',status:'open',saved:true},
  {id:'unknown-details',company:'Example <img src=x>',title:'Researcher <script>bad()</script>',description:'Role details are incomplete.',location:'Remote / New York',provider:'greenhouse',publishedAt:'2026-11-09T22:00:00Z',url:'javascript:bad()',status:'open',saved:false},
 ];return fixture;
}
const careerVisibleIds=view=>[...view.document.querySelectorAll('.career-job-list .job-card[data-job-id]')].map(row=>row.dataset.jobId);

test('career tabs separate finding, saved roles, applications and profile without inventing records',async()=>{
 const fixture=careerBrowserFixture(),view=await renderDesignFixture(fixture);view.navigate('careers');
 assert.equal(view.document.querySelector('#career-tabs').getAttribute('role'),'tablist');
 const tabs=[...view.document.querySelectorAll('#career-tabs [data-action="career-tab"]')];assert.deepEqual(tabs.map(tab=>tab.dataset.tab),['find','saved','applications','profile']);
 assert.equal(tabs[0].getAttribute('aria-selected'),'true');assert.equal(view.document.querySelector('#career-panel-jobs').hasAttribute('hidden'),false);
 assert.equal(view.document.querySelector('#career-panel-applications').hasAttribute('hidden'),true);assert.equal(view.document.querySelector('#career-panel-profile').hasAttribute('hidden'),true);
 assert.deepEqual(careerVisibleIds(view),['sony-remote','adobe-analyst','unknown-details']);
 clickUI(view,'[data-action="career-tab"][data-tab="saved"]');assert.deepEqual(careerVisibleIds(view),['adobe-analyst']);
 assert.equal(view.document.querySelector('[data-tab="saved"]').getAttribute('aria-selected'),'true');
 clickUI(view,'[data-action="career-tab"][data-tab="applications"]');assert.equal(view.document.querySelector('#career-panel-jobs').hasAttribute('hidden'),true);assert.equal(view.document.querySelector('#career-panel-applications').hasAttribute('hidden'),false);assert.match(view.document.querySelector('#application-tracker').textContent,/No applications started yet/);
 clickUI(view,'[data-action="career-tab"][data-tab="profile"]');assert.equal(view.document.querySelector('#career-panel-profile').hasAttribute('hidden'),false);assert.equal(view.document.querySelector('#career-panel-applications').hasAttribute('hidden'),true);assert.ok(view.document.querySelector('#resume-file'));
 assert.equal(view.requests.some(request=>request.url==='/api/jobs/save'),false);
});

test('career search and explicit workplace filters narrow actual jobs without treating unknown facts as matches',async()=>{
 const view=await renderDesignFixture(careerBrowserFixture());view.navigate('careers');
 view.document.querySelector('#career-job-query').value='Adobe';view.document.querySelector('#career-job-query').dispatchEvent(new view.window.Event('input',{bubbles:true}));submitUI(view,'#career-job-filter-form');await settled();assert.deepEqual(careerVisibleIds(view),['adobe-analyst']);
 view.document.querySelector('#career-job-query').value='';view.document.querySelector('#career-job-query').dispatchEvent(new view.window.Event('input',{bubbles:true}));submitUI(view,'#career-job-filter-form');selectOption(view.document.querySelector('#career-filter-workplace'),'remote');view.document.querySelector('#career-filter-workplace').dispatchEvent(new view.window.Event('change',{bubbles:true}));await settled();assert.deepEqual(careerVisibleIds(view),['sony-remote']);
 selectOption(view.document.querySelector('#career-filter-workplace'),'unknown');view.document.querySelector('#career-filter-workplace').dispatchEvent(new view.window.Event('change',{bubbles:true}));await settled();assert.deepEqual(careerVisibleIds(view),['unknown-details']);
 assert.equal(view.document.querySelector('.career-job-list img,.career-job-list script,.career-job-detail img,.career-job-detail script'),null);
 assert.equal(view.document.querySelector('.career-job-detail a[href^="javascript:"]'),null);
 assert.match(view.document.querySelector('.career-job-detail').textContent,/Not (?:published|specified|provided)|Unknown/i);
 assert.equal(view.requests.some(request=>request.url==='/api/jobs/search'),false,'display filters do not trigger another source search');
});

test('career result selection updates detail and saving persists only the chosen role with CSRF',async()=>{
 const fixture=careerBrowserFixture(),view=await renderDesignFixture(fixture,{'/api/jobs/save':options=>{const {id,saved}=JSON.parse(options.body);const job=fixture.jobs.find(row=>row.id===id);job.saved=saved;return job;}});view.navigate('careers');
 clickUI(view,'.job-card[data-job-id="sony-remote"] [data-action="career-select-job"]');assert.match(view.document.querySelector('#career-detail-heading').textContent,/Product Manager/);
 clickUI(view,'.career-job-detail [data-action="career-save-job"]');await settled();
 const request=view.requests.find(row=>row.url==='/api/jobs/save');assert.ok(request);assert.deepEqual(JSON.parse(request.options.body),{id:'sony-remote',saved:true});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');
 clickUI(view,'[data-action="career-tab"][data-tab="saved"]');assert.deepEqual(careerVisibleIds(view),['sony-remote','adobe-analyst']);
 assert.equal(view.requests.some(request=>/^https:/.test(request.url)),false);
});

test('a pending career save preserves newly entered filters and cannot populate another student session',async()=>{
 const fixture=careerBrowserFixture();let signedIn=true,student='first',release;
 const pending=new Promise(resolve=>release=resolve),view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/jobs/save':()=>pending});view.navigate('careers');
 clickUI(view,'.job-card[data-job-id="sony-remote"] [data-action="career-select-job"]');clickUI(view,'.career-job-detail [data-action="career-save-job"]');await settled();
 view.document.querySelector('#career-job-query').value='Adobe';view.document.querySelector('#career-job-query').dispatchEvent(new view.window.Event('input',{bubbles:true}));submitUI(view,'#career-job-filter-form');await settled();assert.equal(view.document.querySelector('#career-job-query').value,'Adobe');
 view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';fixture.jobs=[{id:'second-role',company:'Second Company',title:'Second role',publishedAt:fixture.now,status:'open'}];
 clickUI(view,'[data-action="dev-signin"]');await settled();view.navigate('careers');const before=view.requests.length;release({id:'sony-remote',saved:true,title:'PRIVATE_FIRST_ROLE'});await settled();
 assert.equal(view.requests.length,before);assert.equal(view.document.querySelector('#career-job-query').value,'');assert.deepEqual(careerVisibleIds(view),['second-role']);assert.doesNotMatch(view.document.querySelector('#main').textContent,/PRIVATE_FIRST_ROLE|Sony|Adobe/);
});

test('an in-flight save preserves result search and location text typed before the fields blur',async()=>{
 const fixture=careerBrowserFixture();let release;const pending=new Promise(resolve=>release=resolve),view=await renderDesignFixture(fixture,{'/api/jobs/save':()=>pending});view.navigate('careers');
 clickUI(view,'.career-job-detail [data-action="career-save-job"]');await settled();
 const query=view.document.querySelector('#career-job-query'),location=view.document.querySelector('#career-filter-location');query.value='Adobe';query.dispatchEvent(new view.window.Event('input',{bubbles:true}));location.value='Boston';location.dispatchEvent(new view.window.Event('input',{bubbles:true}));
 release({id:'sony-remote',saved:true});await settled();
 assert.equal(view.document.querySelector('#career-job-query').value,'Adobe');assert.equal(view.document.querySelector('#career-filter-location').value,'Boston');assert.deepEqual(careerVisibleIds(view),['adobe-analyst']);assert.equal(view.requests.filter(r=>r.url==='/api/jobs/save').length,1);
});

test('career lists expand in bounded pages and preserve saved closed roles without allowing preparation',async()=>{
 const fixture=careerBrowserFixture(),base=fixture.jobs[0];fixture.jobs=Array.from({length:85},(_,i)=>({...base,id:'job-'+i,title:'Role '+i,publishedAt:new Date(Date.parse(fixture.now)-i*60000).toISOString(),status:i===0?'removed':'open',saved:i===0}));const view=await renderDesignFixture(fixture);view.navigate('careers');
 assert.equal(careerVisibleIds(view).length,40);assert.match(view.document.querySelector('.career-load-more').textContent,/Showing 40 of 84/);clickUI(view,'[data-action="career-more-jobs"]');assert.equal(careerVisibleIds(view).length,80);clickUI(view,'[data-action="career-more-jobs"]');assert.equal(careerVisibleIds(view).length,84);assert.equal(view.document.querySelector('[data-action="career-more-jobs"]'),null);
 clickUI(view,'[data-action="career-tab"][data-tab="saved"]');assert.deepEqual(careerVisibleIds(view),['job-0']);const prepare=view.document.querySelector('.career-job-detail [data-action="draft-job"]');assert.equal(prepare.hasAttribute('disabled'),true);clickUI(view,'.career-job-detail [data-action="draft-job"]');await settled();assert.equal(view.requests.some(r=>r.url==='/api/jobs/draft'),false);
});

test('application preparation opens its own tab and keeps queued drafts distinct from submitted jobs',async()=>{
 const fixture=careerBrowserFixture(),view=await renderDesignFixture(fixture,{'/api/jobs/draft':{taskId:'prepare-one'},'/api/tasks':[{id:'prepare-one',status:'done'}]});view.navigate('careers');clickUI(view,'.career-job-detail [data-action="draft-job"]');await settled();
 const request=view.requests.find(r=>r.url==='/api/jobs/draft');assert.deepEqual(JSON.parse(request.options.body),{id:'sony-remote'});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');assert.equal(view.document.querySelector('#career-tab-applications').getAttribute('aria-selected'),'true');assert.equal(view.document.querySelector('#career-workbench').hasAttribute('open'),true);assert.match(view.document.querySelector('#career-application-status').textContent,/Preparing a draft.*Nothing is sent/);
 fixture.applications=[{id:'application-one',title:'Product Manager',company:'Sony',status:'draft',answers:{whyCompany:'Draft answer',relevantExperience:'Draft experience'}}];await view.timers.find(t=>t.ms===1500).callback();await settled();assert.match(view.document.querySelector('#career-application-status').textContent,/draft is ready/);assert.match(view.document.querySelector('#career-workbench').textContent,/Live employer submission is not implemented/);assert.equal(view.requests.some(r=>r.url.includes('sandbox')),false);
});

test('application answer drafts survive tab and save refreshes and require review again before a sandbox submission',async()=>{
 const fixture=careerBrowserFixture();fixture.applications=[{id:'application-one',title:'Product Manager',company:'Sony',status:'reviewed',answers:{whyCompany:'Reviewed answer',relevantExperience:'Reviewed experience'}}];let signedIn=true,student='first';const view=await renderDesignFixture(fixture,{'/api/jobs/save':{id:'sony-remote',saved:true},'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};}});view.navigate('careers');clickUI(view,'[data-action="career-tab"][data-tab="applications"]');
 let answer=view.document.querySelector('.application-form [name="whyCompany"]');answer.value='UNSAVED_PRIVATE_ANSWER';answer.dispatchEvent(new view.window.Event('input',{bubbles:true}));assert.equal(view.document.querySelector('[data-action="sandbox-submit"]').disabled,true);clickUI(view,'[data-action="career-tab"][data-tab="find"]');clickUI(view,'.career-job-detail [data-action="career-save-job"]');await settled();clickUI(view,'[data-action="career-tab"][data-tab="applications"]');answer=view.document.querySelector('.application-form [name="whyCompany"]');assert.equal(answer.value,'UNSAVED_PRIVATE_ANSWER');assert.equal(view.document.querySelector('[data-action="sandbox-submit"]').hasAttribute('disabled'),true);assert.equal(view.requests.some(r=>r.url.includes('sandbox')),false);view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';fixture.applications=[{id:'application-one',title:'Second student role',company:'Second Company',status:'draft',answers:{whyCompany:'Second student answer',relevantExperience:'Second student experience'}}];clickUI(view,'[data-action="dev-signin"]');await settled();view.navigate('careers');clickUI(view,'[data-action="career-tab"][data-tab="applications"]');assert.equal(view.document.querySelector('.application-form [name="whyCompany"]').value,'Second student answer');assert.doesNotMatch(view.document.querySelector('#career-workbench').textContent,/UNSAVED_PRIVATE_ANSWER/);
});

function demographicFixture(values={}){return {fields:DEMOGRAPHIC_FIELDS,revision:'r0.p0',values:{veteranStatus:'unanswered',protectedVeteranStatus:'unanswered',disabilityStatus:'unanswered',ethnicity:'unanswered',race:['unanswered'],gender:'unanswered',...values}};}
function demographicSelect(view,field,value){const input=view.document.querySelector('#demographic-'+field);selectOption(input,value);input.dispatchEvent(new view.window.Event('change',{bubbles:true}));}
function demographicRace(view,value,checked){const input=view.document.querySelector(`#demographics-form [name="race"][value="${value}"]`);input.checked=checked;input.dispatchEvent(new view.window.Event('change',{bubbles:true}));}

test('all-at-once demographic form loads only on profile, requires consent, and saves explicit bounded choices',async()=>{
 let saved=demographicFixture();const view=await renderDesignFixture(careerFixture(),{'/api/career/demographics':options=>{if(options.method==='POST'){const data=JSON.parse(options.body);saved={...saved,values:data.values,revision:'r1.p1'};}return saved;}});
 view.navigate('careers');assert.equal(view.requests.some(request=>request.url==='/api/career/demographics'),false);clickUI(view,'#career-tab-profile');await settled();assert.equal(view.document.querySelectorAll('#demographics-form select').length,5);assert.equal(view.document.querySelectorAll('#demographics-form [name="race"]').length,9);
 submitUI(view,'#demographics-form');await settled();assert.equal(view.requests.some(request=>request.url==='/api/career/demographics'&&request.options.method==='POST'),false);assert.match(view.document.querySelector('#demographics-status').textContent,/consent/i);
 demographicSelect(view,'veteranStatus','non_veteran');demographicSelect(view,'disabilityStatus','decline');demographicRace(view,'asian',true);demographicRace(view,'white',true);assert.equal(view.document.querySelector('#demographics-form [value="unanswered"][name="race"]').checked,false);
 demographicRace(view,'decline',true);assert.equal(view.document.querySelector('#demographics-form [value="asian"][name="race"]').checked,false);demographicRace(view,'asian',true);demographicRace(view,'white',true);
 setCheckbox(view,'demographics-consent',true);demographicSelect(view,'gender','non_binary');assert.equal(view.document.querySelector('#demographics-consent').checked,false);setCheckbox(view,'demographics-consent',true);submitUI(view,'#demographics-form');await settled();
 const request=view.requests.find(request=>request.url==='/api/career/demographics'&&request.options.method==='POST');assert.deepEqual(JSON.parse(request.options.body),{values:{veteranStatus:'non_veteran',protectedVeteranStatus:'unanswered',disabilityStatus:'decline',ethnicity:'unanswered',race:['asian','white'],gender:'non_binary'},expectedRevision:'r0.p0'});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');assert.match(view.document.querySelector('#demographics-status').textContent,/Choices saved/);assert.equal(view.document.querySelector('#demographics-consent').hasAttribute('checked'),false);
});

test('demographic deep link opens the full form and stale save keeps edits until explicit reload',async()=>{
 let saved=demographicFixture();const view=await renderDesignFixture(careerFixture(),{'/api/career/demographics':options=>{if(options.method==='POST')throw Object.assign(new Error('Changed concurrently'),{status:409});return saved;}});view.navigate('demographics');await settled();assert.equal(view.document.querySelector('#career-tab-profile').getAttribute('aria-selected'),'true');assert.equal(view.document.querySelector('#career-panel-profile').hasAttribute('hidden'),false);
 demographicSelect(view,'gender','non_binary');setCheckbox(view,'demographics-consent',true);submitUI(view,'#demographics-form');await settled();assert.equal(view.document.querySelector('#demographic-gender').value,'non_binary');assert.match(view.document.querySelector('#demographics-status').textContent,/changed in Telegram or another tab/);assert.equal(view.document.querySelector('#demographics-form button').hasAttribute('disabled'),true);
 saved=demographicFixture({gender:'decline'});saved.revision='r2.p0';clickUI(view,'[data-action="demographics-reload"]');await settled();assert.equal(view.document.querySelector('#demographic-gender').value,'decline');assert.equal(view.document.querySelector('#demographics-consent').hasAttribute('checked'),false);assert.equal(view.document.querySelector('#demographics-form button').hasAttribute('disabled'),false);
});

for(const pendingKind of ['read','save'])test(`late demographic ${pendingKind} responses cannot populate a later student's form`,async()=>{
 const fixture=careerFixture();let signedIn=true,student='first',release;const pending=new Promise(resolve=>release=resolve),first=demographicFixture({gender:'non_binary'}),second=demographicFixture({gender:'decline'});
 const view=await renderDesignFixture(fixture,{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};},'/api/career/demographics':options=>{if(student==='second')return second;return pendingKind==='read'||options.method==='POST'?pending:first;}});
 view.navigate('demographics');await settled();if(pendingKind==='save'){demographicSelect(view,'gender','female');setCheckbox(view,'demographics-consent',true);submitUI(view,'#demographics-form');await settled();}
 view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();view.navigate('demographics');await settled();assert.equal(view.document.querySelector('#demographic-gender').value,'decline');release({...first,values:{...first.values,gender:'female'},revision:'r99.p0'});await settled();assert.equal(view.document.querySelector('#demographic-gender').value,'decline');assert.doesNotMatch(view.document.querySelector('#demographics-status').textContent,/Choices saved/);
});

const miniCalendarDay=(view,date)=>view.document.querySelector(`#event-mini-calendar [data-action="hub-calendar-day"][data-date="${date}"]`);
test('mini event calendar appears below sources, uses New York today, and shows merged listings once without writes',async()=>{
 const fixture=eventHubFixture();fixture.now='2026-11-11T02:30:00Z';
 const view=await renderDesignFixture(fixture);view.navigate('events');const before=view.requests.length,calendar=view.document.querySelector('#event-mini-calendar');
 assert.equal(view.document.querySelector('.event-source-health').nextElementSibling,calendar);
 assert.match(calendar.querySelector('#event-calendar-month').textContent,/November 2026/);
 assert.equal(miniCalendarDay(view,'2026-11-10').getAttribute('aria-pressed'),'true');
 assert.equal(miniCalendarDay(view,'2026-11-10').dataset.count,'2');
 assert.equal(miniCalendarDay(view,'2026-11-12').dataset.count,'1');
 clickUI(view,'[data-action="hub-calendar-day"][data-date="2026-11-12"]');
 const preview=view.document.querySelector('#event-calendar-day-list');assert.equal(preview.querySelectorAll('[data-action="hub-details"][data-id="hub-merged"]').length,1);
 assert.match(preview.textContent,/Founder conversations <img src=x>/);assert.equal(calendar.querySelector('img,script'),null);assert.equal(preview.querySelector('img,script'),null);
 assert.equal(view.document.querySelector('[data-action="hub-range"][data-value="week"]').getAttribute('aria-pressed'),'true');
 clickUI(view,'#event-calendar-day-list [data-action="hub-details"][data-id="hub-merged"]');
 assert.equal(view.document.querySelector('#detail-dialog').open,true);assert.match(view.document.querySelector('#detail-title').textContent,/Founder conversations/);
 assert.equal(view.requests.length,before);assert.equal(view.requests.some(r=>r.options?.method==='POST'),false);
});

test('mini event calendar navigates across years, returns to today, and opens the chosen day agenda',async()=>{
 const view=await renderDesignFixture(eventHubFixture());view.navigate('events');const before=view.requests.length;
 clickUI(view,'[data-action="hub-calendar-month"][data-offset="1"]');assert.match(view.document.querySelector('#event-calendar-month').textContent,/December 2026/);assert.equal(miniCalendarDay(view,'2026-12-01').getAttribute('aria-pressed'),'true');
 clickUI(view,'[data-action="hub-calendar-month"][data-offset="1"]');assert.match(view.document.querySelector('#event-calendar-month').textContent,/January 2027/);assert.equal(miniCalendarDay(view,'2027-01-01').getAttribute('aria-pressed'),'true');
 clickUI(view,'[data-action="hub-calendar-month"][data-offset="-1"]');assert.match(view.document.querySelector('#event-calendar-month').textContent,/December 2026/);
 clickUI(view,'[data-action="hub-calendar-today"]');assert.match(view.document.querySelector('#event-calendar-month').textContent,/November 2026/);assert.equal(miniCalendarDay(view,'2026-11-10').getAttribute('aria-pressed'),'true');
 clickUI(view,'[data-action="hub-calendar-day"][data-date="2026-11-12"]');clickUI(view,'[data-action="hub-calendar-agenda"]');
 assert.equal(view.document.querySelectorAll('.event-agenda .event-hub-card').length,1);assert.ok(view.document.querySelector('.event-agenda [data-event-id="hub-merged"]'));
 assert.equal(view.requests.length,before);
});

test('mini event calendar counts every holiday date with exclusive end and ignores unavailable or invalid plans',async()=>{
 const fixture=eventHubFixture(),base=fixture.eventHub.items[1];fixture.eventHub.items.push(
 {...base,id:'cancelled-calendar-plan',title:'Cancelled calendar plan',status:'cancelled'},
 {...base,id:'dismissed-calendar-plan',title:'Dismissed calendar plan',status:'dismissed'},
 {...base,id:'declined-calendar-plan',title:'Declined calendar plan',status:'available',localIntent:'declined'},
 {...base,id:'undated-calendar-plan',title:'Undated calendar plan',date:null,start:null,end:null},
 {...base,id:'invalid-calendar-plan',title:'Invalid calendar plan',date:'2026-02-30',start:null,end:null}
 );const view=await renderDesignFixture(fixture);view.navigate('events');
 assert.equal(miniCalendarDay(view,'2026-11-10').dataset.count,'2');
 for(const date of ['2026-11-25','2026-11-26','2026-11-27','2026-11-28','2026-11-29']){assert.equal(miniCalendarDay(view,date).dataset.count,'1');clickUI(view,`[data-action="hub-calendar-day"][data-date="${date}"]`);assert.match(view.document.querySelector('#event-calendar-day-list').textContent,/Thanksgiving break/);}
 assert.equal(miniCalendarDay(view,'2026-11-30').dataset.count,'0');clickUI(view,'[data-action="hub-calendar-day"][data-date="2026-11-30"]');assert.doesNotMatch(view.document.querySelector('#event-calendar-day-list').textContent,/Thanksgiving break|calendar plan/);
 assert.equal(miniCalendarDay(view,'2026-11-11').dataset.count,'1');assert.equal(miniCalendarDay(view,'2026-11-12').dataset.count,'1');
});

test('mini event calendar honors source, category, and search while keeping its month independent of agenda date range',async()=>{
 const view=await renderDesignFixture(eventHubFixture());view.navigate('events');const before=view.requests.length;
 clickUI(view,'[data-action="hub-range"][data-value="today"]');assert.equal(miniCalendarDay(view,'2026-11-25').dataset.count,'1');
 clickUI(view,'[data-action="hub-source"][data-value="luma"]');assert.equal(miniCalendarDay(view,'2026-11-10').dataset.count,'0');assert.equal(miniCalendarDay(view,'2026-11-12').dataset.count,'1');assert.equal(miniCalendarDay(view,'2026-11-25').dataset.count,'0');
 clickUI(view,'[data-action="hub-source"][data-value="all"]');clickUI(view,'[data-action="hub-category"][data-value="breaks"]');assert.equal(miniCalendarDay(view,'2026-11-12').dataset.count,'0');assert.equal(miniCalendarDay(view,'2026-11-25').dataset.count,'1');
 clickUI(view,'[data-action="hub-category"][data-value="all"]');view.document.querySelector('#event-hub-query').value='Founder';submitUI(view,'#event-hub-search');assert.equal(miniCalendarDay(view,'2026-11-12').dataset.count,'1');assert.equal(miniCalendarDay(view,'2026-11-25').dataset.count,'0');
 assert.equal(view.requests.length,before);
});

test('mini event calendar selected month and day reset when a different student signs in',async()=>{
 let signedIn=true,student='first';const view=await renderDesignFixture(eventHubFixture(),{'/api/session':()=>({user:signedIn?{id:student,name:'Student'}:null,csrfToken:'fixture',devEnabled:true,devEmails:['second@cornell.edu']}),'/auth/logout':()=>{signedIn=false;return{};}});
 view.navigate('events');clickUI(view,'[data-action="hub-calendar-month"][data-offset="1"]');clickUI(view,'[data-action="hub-calendar-day"][data-date="2026-12-20"]');
 view.navigate('connections');clickUI(view,'[data-action="logout"]');await settled();signedIn=true;student='second';clickUI(view,'[data-action="dev-signin"]');await settled();view.navigate('events');
 assert.match(view.document.querySelector('#event-calendar-month').textContent,/November 2026/);assert.equal(miniCalendarDay(view,'2026-11-10').getAttribute('aria-pressed'),'true');
});

test('mini event calendar places overnight events on New York dates and treats midnight as an exclusive end',async()=>{
 const fixture=eventHubFixture(),base=fixture.eventHub.items[0];fixture.eventHub.items=[
 {...base,id:'ends-midnight',title:'Evening until midnight',date:'2026-11-10',start:'2026-11-11T03:00:00Z',end:'2026-11-11T05:00:00Z'},
 {...base,id:'overnight',title:'Overnight meetup',date:'2026-11-10',start:'2026-11-11T04:00:00Z',end:'2026-11-11T06:00:00Z'},
 ];const view=await renderDesignFixture(fixture);view.navigate('events');assert.equal(miniCalendarDay(view,'2026-11-10').dataset.count,'2');assert.equal(miniCalendarDay(view,'2026-11-11').dataset.count,'1');assert.equal(miniCalendarDay(view,'2026-11-12').dataset.count,'0');
 clickUI(view,'[data-action="hub-calendar-day"][data-date="2026-11-11"]');assert.match(view.document.querySelector('#event-calendar-day-list').textContent,/Overnight meetup/);assert.doesNotMatch(view.document.querySelector('#event-calendar-day-list').textContent,/Evening until midnight/);
});

test('Academics leads with what needs attention, keeps reviewed classes compact, and the badge counts only actions',async()=>{
 const reviewed=['2026-11-11','2026-11-13','2026-11-18'].map((date,i)=>classMeeting(`done-${i}`,date,{status:'approved'}));
 const due={id:'hw',title:'Due: Problem set 4 · NBAY 5300',kind:'assignment',date:'2026-11-12',allDay:true,endDate:'2026-11-13',status:'approved',sourceName:'Canvas · NBAY 5300'};
 let view=await renderDesignFixture(designFixture([...reviewed,due]));view.navigate('academics');await settled();
 const doc=view.document;assert.equal(doc.querySelector('#academic-count').hidden,true);assert.match(doc.querySelector('.academic-allclear').textContent,/all caught up/);
 assert.match(doc.querySelector('.academic-week').textContent,/Tomorrow[\s\S]*1:25 PM[\s\S]*NBAY 5300 · Synthetic finance/);assert.match(doc.querySelector('.academic-due').textContent,/Problem set 4/);assert.doesNotMatch(doc.querySelector('.academic-due').textContent,/Due: Problem/);
 assert.equal(doc.querySelectorAll('.class-list li').length,1);assert.match(doc.querySelector('.class-list').textContent,/3 meetings/);
 assert.equal(doc.querySelector('#academic-review').hasAttribute('open'),false);assert.equal(doc.querySelector('#academic-setup').hasAttribute('open'),false);assert.ok(doc.querySelector('#academic-review #select-all'),'review tools stay available');
 view=await renderDesignFixture(designFixture([...reviewed,classMeeting('new','2026-11-20')]));view.navigate('academics');await settled();
 assert.equal(view.document.querySelector('#academic-count').textContent,'1');assert.match(view.document.querySelector('.attention-bar').textContent,/1 date to review/);assert.equal(view.document.querySelector('#academic-review').hasAttribute('open'),true);
});

test('an upload with no matching classes is one short card that can be dismissed',async()=>{
 const empty={...enrollmentProposal,id:'a'.repeat(32),sourceName:'Syllabus INFO6410.pdf',candidates:[],warnings:['Page 2 has searchable text but no readable course identifiers.']};
 const view=await renderDesignFixture(designFixture([classMeeting('done','2026-11-11',{status:'approved'})]),{'/api/enrollment/proposals':[empty],'/api/enrollment/dismiss':{dismissed:true}});view.navigate('academics');await settled();
 const card=view.document.querySelector('.enrollment-empty');assert.ok(card);assert.match(card.textContent,/No enrolled classes were found/);assert.equal(card.querySelector('details').hasAttribute('open'),false);assert.match(card.querySelector('details').textContent,/no readable course identifiers/);
 assert.equal(view.document.querySelector('#academic-setup').hasAttribute('open'),true);assert.match(view.document.querySelector('.attention-bar').textContent,/1 upload needs a look/);
 clickUI(view,'[data-action="dismiss-enrollment"]');await settled();
 assert.deepEqual(JSON.parse(view.requests.find(r=>r.url==='/api/enrollment/dismiss').options.body),{id:'a'.repeat(32)});assert.equal(view.document.querySelector('.enrollment-empty'),null);
});


test('supported jobs start real Telegram review and employer receipts cannot be edited into self-reported status',async()=>{
 const fixture=applicationTrackerFixture();fixture.resume={name:'Example.pdf'};fixture.jobs=[{id:'ramp',title:'Product Manager',company:'Ramp',applyUrl:'https://jobs.ashbyhq.com/ramp/a84ae1e2-8c88-4e05-9cb6-fa3e11b55aeb/application',telegramApplication:true,publishedAt:'2026-11-10T20:00:00Z'}];
 fixture.applicationTracker.push({id:'live',jobId:'ramp',title:'Product Manager',company:'Ramp',liveApplicationId:'abc',status:'submitted',statusLabel:'Submitted (employer confirmed)',submissionSource:'employer-confirmed',statusNote:'Application submitted!',source:'telegram'});
 const view=await renderDesignFixture(fixture,{'/api/career/live-application':{started:true}});view.navigate('careers');
 const button=view.document.querySelector('[data-action="live-job"]');assert.ok(button);assert.equal(button.textContent,'Apply via Telegram');button.dispatchEvent(new view.window.Event('click',{bubbles:true}));await settled();
 const request=view.requests.find(r=>r.url==='/api/career/live-application');assert.deepEqual(JSON.parse(request.options.body),{id:'ramp'});assert.equal(request.options.headers['X-CSRF-Token'],'fixture');
 const row=view.document.querySelector('[data-tracker-id="live"]');assert.match(row.textContent,/Submitted \(employer confirmed\)/);assert.equal(row.querySelector('[data-action="application-tracker-status"]'),null);
});

test('Telegram profile link opens the reusable application fields directly',async()=>{const view=await renderDesignFixture(careerFixture());view.navigate('career-profile');assert.equal(view.document.querySelector('#career-panel-profile').hasAttribute('hidden'),false);assert.equal(view.document.querySelector('#career-profile-details').hasAttribute('open'),true);assert.ok(view.document.querySelector('#career-profile-recruitingSMS'));});
