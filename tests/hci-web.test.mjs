import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

function fixture() {
  return {
    profile: { name: 'Test student', paused: false }, events: [], sources: [], jobs: [], applications: [],
    reminders: [], activity: [], metrics: [], resume: null, now: '2026-11-12T14:00:00Z',
    connections: {
      telegram: { configured: false, linked: false, bot: 'test_bot' }, google: { configured: false, connected: false },
      slack: { configured: false, channel: '' }, campusgroups: { connected: false },
    },
  };
}

async function app(routes = {}) {
  const [html, ...scripts] = await Promise.all([
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    ...['schedule-groups.js', 'career-search.js', 'app.js'].map(name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')),
  ]);
  const { document, window } = parseHTML(html), listeners = {}, requests = [], intervals = new Map(), timeouts = new Map();
  let activeElement = document.body, timerId = 0;
  Object.defineProperty(document, 'activeElement', { get: () => activeElement });
  window.HTMLElement.prototype.focus = function () { activeElement = this; };
  const location = { hash: '#overview', href: '' };
  const context = {
    document, location, URL, Intl, Date, console, Map, Set,
    window: { addEventListener(name, fn) { listeners[name] = fn; }, scrollTo() {} },
    setTimeout(fn, delay) { const id = ++timerId; timeouts.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, delay) { const id = ++timerId; intervals.set(id, { fn, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const value = typeof routes[url] === 'function' ? await routes[url](options) : routes[url];
      return { ok: true, json: async () => value ?? (url === '/api/session'
        ? { user: { id: 'student-a', name: 'Test student', email: 'test@cornell.edu' }, csrfToken: 'synthetic' }
        : url === '/api/state' ? fixture() : url === '/api/enrollment/proposals' ? [] : { model: { connected: false }, mode: 'Test' }) };
    },
  };
  await vm.runInNewContext(`(async()=>{${scripts.join('\n')}\nreturn {render,toast,action,runTask,clearActivity,setNavigation,replaceSession(value){session=value;}};})()`, context).then(api => { context.api = api; });
  return {
    ...context.api, document, window, requests, intervals, timeouts,
    navigate(page) { location.hash = '#' + page; listeners.hashchange(); },
  };
}

test('route navigation names the page, closes the mobile menu and moves focus into new content', async () => {
  const ui = await app();
  ui.setNavigation(true);
  assert.equal(ui.document.querySelector('#nav-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(ui.document.activeElement.getAttribute('data-page'), 'overview');
  ui.navigate('connections');
  assert.equal(ui.document.title, 'Connections · Big Red Buddy');
  assert.equal(ui.document.activeElement.id, 'main');
  assert.equal(ui.document.querySelector('#nav-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(ui.document.body.classList.contains('navigation-open'), false);
  assert.equal(ui.document.querySelector('[data-page="connections"]').getAttribute('aria-current'), 'page');
});

test('same-page refresh restores the focused control instead of sending keyboard users back to the document start', async () => {
  const ui = await app();
  const oldButton = ui.document.querySelector('[data-action="upload-syllabus"]');
  oldButton.focus();
  ui.render();
  const replacement = ui.document.querySelector('[data-action="upload-syllabus"]');
  assert.notEqual(oldButton, replacement);
  assert.equal(ui.document.activeElement, replacement);
});

test('errors remain announced and dismissible; ordinary status messages retain polite timed feedback', async () => {
  const ui = await app();
  ui.toast('Could not connect. Check Connections before retrying.', true);
  const message = ui.document.querySelector('#toast-message');
  assert.equal(message.getAttribute('role'), 'alert');
  assert.equal(message.getAttribute('aria-live'), 'assertive');
  assert.equal(ui.timeouts.size, 0, 'an error must not disappear on a timer');
  ui.document.querySelector('#close-toast').dispatchEvent(new ui.window.Event('click', { bubbles: true }));
  assert.equal(message.textContent, '');
  assert.equal(ui.document.querySelector('#toast').classList.contains('visible'), false);
  ui.toast('Preferences saved.');
  assert.equal(message.getAttribute('role'), 'status');
  assert.equal(message.getAttribute('aria-live'), 'polite');
  assert.equal(ui.timeouts.size, 1);
});

test('pending actions show progress, prevent duplicate execution and restore their initiating control', async () => {
  const ui = await app();
  const button = ui.document.querySelector('[data-action="upload-syllabus"]');
  let finish, duplicateRan = false;
  const pending = ui.action(() => new Promise(resolve => { finish = resolve; }), button);
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(ui.document.querySelector('#activity-status').hidden, false);
  assert.match(ui.document.querySelector('#activity-message').textContent, /Working/);
  await ui.action(() => { duplicateRan = true; }, button);
  assert.equal(duplicateRan, false);
  assert.match(ui.document.querySelector('#toast-message').textContent, /wait/);
  finish();
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute('aria-busy'), false);
  assert.equal(ui.document.querySelector('#activity-status').hidden, true);
});

test('a task stays visibly pending until its worker reports completion, then gives task-specific feedback', async () => {
  let callbackResult;
  const ui = await app({ '/api/chat': { taskId: 'synthetic-chat' }, '/api/tasks': [{ id: 'synthetic-chat', status: 'done', result: { answer: 'Synthetic answer' } }] });
  await ui.runTask('/api/chat', { question: 'Synthetic question' }, value => { callbackResult = value; });
  assert.match(ui.document.querySelector('#activity-message').textContent, /Preparing your answer/);
  assert.match(ui.document.querySelector('#toast-message').textContent, /queued/);
  assert.equal(callbackResult, undefined);
  const poll = [...ui.intervals.values()].find(timer => timer.delay === 1500);
  await poll.fn();
  assert.equal(callbackResult.answer, 'Synthetic answer');
  assert.equal(ui.document.querySelector('#toast-message').textContent, 'Your answer is ready.');
  assert.equal(ui.document.querySelector('#activity-status').hidden, true);
});

test('an in-flight task response from a previous session cannot show completion or invoke its callback', async () => {
  let finishResponse, callbackRan = false;
  const ui = await app({ '/api/chat': { taskId: 'old-session-task' }, '/api/tasks': () => new Promise(resolve => { finishResponse = resolve; }) });
  await ui.runTask('/api/chat', { question: 'Synthetic question' }, () => { callbackRan = true; });
  const [pollId, poll] = [...ui.intervals.entries()].find(([, timer]) => timer.delay === 1500);
  const pending = poll.fn();
  ui.replaceSession({ user: { id: 'student-b' }, csrfToken: 'other-synthetic' });
  const before = ui.requests.filter(request => request.url === '/api/state').length;
  finishResponse([{ id: 'old-session-task', status: 'done', result: { answer: 'Previous student response' } }]);
  await pending;
  assert.equal(callbackRan, false);
  assert.equal(ui.intervals.has(pollId), false);
  assert.equal(ui.requests.filter(request => request.url === '/api/state').length, before);
  assert.doesNotMatch(ui.document.querySelector('#toast-message').textContent, /ready|Previous student/);
  assert.equal(ui.document.querySelector('#activity-status').hidden, true);
});

for (const result of [{ suppressed: true }, { accepted: false }]) {
  test(`Telegram completion does not claim delivery when the worker reports ${JSON.stringify(result)}`, async () => {
    const ui = await app({ '/api/telegram/test': { taskId: 'synthetic-message' }, '/api/tasks': [{ id: 'synthetic-message', status: 'done', result }] });
    await ui.runTask('/api/telegram/test', {});
    const poll = [...ui.intervals.values()].find(timer => timer.delay === 1500);
    await poll.fn();
    const message = ui.document.querySelector('#toast-message');
    assert.match(message.textContent, /Message was not sent/);
    assert.match(message.textContent, /Check Connections/);
    assert.doesNotMatch(message.textContent, /Telegram accepted/);
    assert.equal(message.getAttribute('role'), 'alert');
    assert.equal(ui.timeouts.size, 0);
    assert.equal(ui.document.querySelector('#activity-status').hidden, true);
  });
}

for (const [result,expected,error] of [
  [{sent:true,accepted:true},/Gmail accepted/,false],
  [{sent:false,reason:'delivery-uncertain'},/delivery is unconfirmed/,true],
  [{sent:false,reason:'gmail-reconnect-required'},/Reconnect Gmail delivery/,true],
  [{sent:false,reason:'email-disabled'},/Email was not sent/,true],
  [{},/delivery is unconfirmed/,true],
]) {
  test(`email completion accurately distinguishes acceptance, rejection and uncertainty: ${JSON.stringify(result)}`,async()=>{
    const ui=await app({'/api/daily-email/send':{taskId:'synthetic-email'},'/api/tasks':[{id:'synthetic-email',status:'done',result}]});
    await ui.runTask('/api/daily-email/send',{});
    await [...ui.intervals.values()].find(timer=>timer.delay===1500).fn();
    const message=ui.document.querySelector('#toast-message');
    assert.match(message.textContent,expected);
    assert.equal(message.getAttribute('role'),error?'alert':'status');
    if(error)assert.doesNotMatch(message.textContent,/Gmail accepted/);
    if(result.reason==='delivery-uncertain')assert.doesNotMatch(message.textContent,/not sent/);
  });
}
