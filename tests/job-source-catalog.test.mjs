import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JOB_SOURCE_LIMIT, listJobSources, resolveJobSearchSources, parseJobBoardURL} from '../lib/job-source-catalog.mjs';

const bad = fn => assert.throws(fn, error => error.status === 400 && error.code === 'invalid_job_sources');

test('starter catalog contains eight verified distinct boards and bounded public metadata', () => {
  const result = listJobSources();
  assert.equal(result.version, '1.0.0');
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
  assert.equal(result.sources.length, 8);
  assert.equal(new Set(result.sources.map(source => `${source.provider}:${source.board}`)).size, 8);
  assert.deepEqual(new Set(result.sources.map(source => source.provider)), new Set(['greenhouse', 'ashby']));
  assert.match(result.coverage, /not a whole-web search/);
  assert.deepEqual(result.sources.map(source => source.name), ['Figma', 'Stripe', 'Datadog', 'Duolingo', 'Notion', 'Ramp', 'Linear', 'Ashby']);
  for (const source of result.sources) {
    assert.deepEqual(Object.keys(source).sort(), ['board', 'careersUrl', 'id', 'name', 'provider', 'verifiedAt'].sort());
    assert.ok(Number.isFinite(Date.parse(source.verifiedAt)));
    assert.equal(parseJobBoardURL(source.careersUrl).board, source.board);
  }
  assert.equal(result.verification, undefined);
  const raw = JSON.parse(readFileSync(new URL('../resources/job-source-catalog.json', import.meta.url), 'utf8'));
  assert.equal(raw.verification.checks.length, 8);
  assert.ok(raw.verification.checks.every(check => check.jobsArray && check.observedPostingCount > 0 && check.endpoint.startsWith('https://')));
});

test('public catalog and resolved sources cannot mutate later callers or the registry', () => {
  const first = listJobSources(); first.sources[0].name = 'Injected'; first.sources.pop();
  const resolved = resolveJobSearchSources(); resolved[0].provider = 'attacker'; resolved.pop();
  assert.equal(listJobSources().sources[0].name, 'Figma');
  assert.equal(resolveJobSearchSources().length, 8);
  assert.equal(resolveJobSearchSources()[0].provider, 'greenhouse');
});

test('empty selection uses starters; explicit registry IDs preserve order and deduplicate', () => {
  assert.deepEqual(resolveJobSearchSources(), listJobSources().sources);
  assert.deepEqual(resolveJobSearchSources({sourceIds:[]}), listJobSources().sources);
  assert.deepEqual(resolveJobSearchSources({sourceIds:['ramp', 'figma', 'ramp']}).map(source => source.id), ['ramp', 'figma']);
});

test('saved own sources are validated, projected, merged and never promoted to verified employers', () => {
  const existingBoards = [
    {provider:'ashby',board:'NOTION',name:'Forged name',careersUrl:'http://127.0.0.1/secrets',token:'private'},
    {provider:'greenhouse',board:'custom_company',name:'Unverified',verifiedAt:'2099-01-01',lastError:'private'},
    {provider:'greenhouse',board:'custom_company'}
  ];
  const result = resolveJobSearchSources({sourceIds:['notion'],existingBoards});
  assert.equal(result.length, 2);
  assert.equal(result[0].name, 'Notion'); assert.equal(result[0].board, 'notion');
  assert.deepEqual(result[1], {provider:'greenhouse',board:'custom_company'});
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(existingBoards[0].board, 'NOTION');
});

test('malformed selections and registry bypass attempts fail closed', () => {
  for (const options of [null, [], 'figma', {sourceIds:null}, {sourceIds:'figma'}, {sourceIds:[{}]}, {sourceIds:[1]}, {sourceIds:['unknown']}, {sourceIds:['__proto__']}, {sourceIds:['constructor']}, {sourceIds:['Figma']}, {sourceIds:['https://example.com']}, {sourceIds:['figma'],provider:'greenhouse'}, {sourceIds:Array(21).fill('figma')}, {existingBoards:null}]) bad(() => resolveJobSearchSources(options));
});

test('malformed existing sources never become arbitrary fetch destinations', () => {
  for (const source of [null, 'notion', [], {}, {provider:'lever',board:'company'}, {provider:'greenhouse',board:'../../private'}, {provider:'ashby',board:'evil.test/x'}, {provider:'ashby',board:'a'.repeat(81)}, {provider:'ashby',board:'api'}, {provider:'ashby',board:1}, {provider:'ashby',board:'has space'}]) bad(() => resolveJobSearchSources({sourceIds:['figma'],existingBoards:[source]}));
});

test('combined selection is capped without dropping a requested source', () => {
  const boards = Array.from({length:19}, (_, index) => ({provider:'greenhouse',board:`employer${index}`}));
  assert.equal(resolveJobSearchSources({sourceIds:['figma'],existingBoards:boards}).length, JOB_SOURCE_LIMIT);
  bad(() => resolveJobSearchSources({sourceIds:['figma','notion'],existingBoards:boards}));
  bad(() => resolveJobSearchSources({existingBoards:boards}));
  assert.equal(resolveJobSearchSources({sourceIds:['figma'],existingBoards:[...boards,{provider:'greenhouse',board:'figma'}]}).length, 20);
});

test('hosted board and posting URLs canonicalize without carrying tracking or access tokens', () => {
  const cases = [
    ['https://boards.greenhouse.io/figma/jobs/123?gh_src=tracking#section', 'greenhouse', 'figma'],
    ['https://job-boards.greenhouse.io/custom_company/', 'greenhouse', 'custom_company'],
    ['https://jobs.ashbyhq.com/notion?utm_source=test&token=private', 'ashby', 'notion'],
    ['https://jobs.ashbyhq.com/Notion/1fc309c8-da20-4ff2-84c7-8b863ece2b0a/application#form', 'ashby', 'notion'],
    ['https://jobs.ashbyhq.com:443/CustomBoard', 'ashby', 'CustomBoard']
  ];
  for (const [url, provider, board] of cases) {
    const result = parseJobBoardURL(url);
    assert.equal(result.provider, provider); assert.equal(result.board, board);
    assert.equal(new URL(result.careersUrl).search, ''); assert.equal(new URL(result.careersUrl).hash, '');
    assert.deepEqual(Object.keys(result).sort(), ['board','careersUrl','provider']);
  }
});

test('URL parsing rejects SSRF, credentials, unsupported paths and URL-normalization tricks', () => {
  for (const url of [null, {}, '', 'http://jobs.ashbyhq.com/notion', 'file:///etc/passwd', 'javascript:alert(1)', 'https://127.0.0.1/notion', 'https://jobs.ashbyhq.com.evil.test/notion', 'https://jobs.ashbyhq.com@evil.test/notion', 'https://user:secret@jobs.ashbyhq.com/notion', 'https://jobs.ashbyhq.com:8443/notion', 'https://boards-api.greenhouse.io/v1/boards/figma/jobs', 'https://api.ashbyhq.com/posting-api/job-board/notion', 'https://boards.greenhouse.io/embed/job_board?for=figma', 'https://jobs.ashbyhq.com/notion/private', 'https://jobs.ashbyhq.com/notion/../ramp', 'https://jobs.ashbyhq.com/notion/%2e%2e/ramp', 'https://jobs.ashbyhq.com/%6eotion', 'https://jobs.ashbyhq.com//notion', 'https://jobs.ashbyhq.com/api', 'https:////jobs.ashbyhq.com/notion', 'https:jobs.ashbyhq.com/notion', 'https://jobs.ashbyhq.com\\@evil.test/notion', ' https://jobs.ashbyhq.com/notion', 'https://jobs.ashbyhq.com/notion\n']) bad(() => parseJobBoardURL(url));
});

test('registry selection and URL parsing perform no network reads', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected network request'); };
  try {
    assert.equal(resolveJobSearchSources().length, 8);
    assert.equal(listJobSources().sources.length, 8);
    assert.equal(parseJobBoardURL('https://jobs.ashbyhq.com/notion').board, 'notion');
  } finally { globalThis.fetch = original; }
});
