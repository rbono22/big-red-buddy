import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, mkdtemp, rm, writeFile, symlink, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readLocalDocumentText, ENROLLMENT_LIMITS} from '../lib/enrollment.mjs';
import {MARKITDOWN_SCRIPT, resolveMarkItDownPython} from '../lib/markitdown.mjs';

const exec = promisify(execFile);
const fixtures = fileURLToPath(new URL('./fixtures/documents/', import.meta.url));
const required = process.env.REQUIRE_MARKITDOWN_TESTS === '1';
const toolOptions = {timeout: 30000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL'};

async function fixture(name) {
  return {buffer: await readFile(path.join(fixtures, name)), mimeType: name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.png') ? 'image/png' : 'application/pdf', name};
}

// Checked-in fixtures are synthetic. Regeneration is optional and does not add
// ReportLab/Pillow to the application or CI runtime requirements.
test('installed MarkItDown and local OCR preserve actual PDF/photo content and bounds', {timeout: 180000}, async t => {
  const python = await resolveMarkItDownPython({env: {MARKITDOWN_PYTHON: process.env.MARKITDOWN_PYTHON}});
  let unavailable;
  try {
    if (!python) throw new Error('MarkItDown Python is unavailable');
    const check = JSON.parse((await exec(python, ['-I', MARKITDOWN_SCRIPT, '--check'], toolOptions)).stdout);
    assert.equal(check.available, true);
    for (const [program, args] of [['pdfinfo', ['-v']], ['pdftotext', ['-v']], ['pdfimages', ['-v']], ['pdftoppm', ['-v']], ['tesseract', ['--version']]]) await exec(program, args, toolOptions);
  } catch { unavailable = 'Install requirements-markitdown.txt in .venv-markitdown plus Poppler and Tesseract to run actual document tests.'; }
  if (unavailable) {
    if (required) assert.fail(unavailable);
    t.skip(unavailable);
    return;
  }

  const dependencies = {resolveMarkdown: async () => python, resolveOCR: async () => ({kind: 'tesseract', program: 'tesseract'})};
  const checkParser = result => {
    assert.match(result.method, /MarkItDown PDF text/);
    assert.equal(result.extractionMetrics.pdfParser, 'markitdown');
    assert.equal(result.extractionMetrics.markitdownVersion, '0.1.9');
    assert.equal(result.extractionMetrics.pdfParserFallback, undefined, 'The actual parser must run, not silently fall back');
  };

  await t.test('selectable PDF keeps exact deadlines and separate pages without OCR', async () => {
    const result = await readLocalDocumentText(await fixture('searchable.pdf'), dependencies);
    checkParser(result);
    assert.equal(result.extractionMetrics.ocrPages, 0);
    const pages = result.text.split('\f');
    assert.equal(pages.length, 2);
    assert.match(pages[0], /PAGE ONE/);
    assert.match(pages[0], /December 1, 2026 at 5 PM/);
    assert.match(pages[0], /December 8, 2026 at 11 AM/);
    assert.match(pages[0], /https:\/\/example\.invalid\/never-fetch-this/);
    assert.match(pages[1], /PAGE TWO/);
    assert.match(pages[1], /December 15, 2026 at 2 PM/);
    assert.doesNotMatch(pages[0], /December 15/);
    t.diagnostic(`Selectable PDF: ${result.extractionMetrics.ms}ms, ${result.extractionMetrics.processes} processes`);
  });

  await t.test('scanned PDF reads visible invitation dates through local OCR', async () => {
    const result = await readLocalDocumentText(await fixture('scanned.pdf'), dependencies);
    checkParser(result);
    assert.match(result.method, /Tesseract OCR/);
    assert.equal(result.extractionMetrics.ocrPages, 1);
    assert.match(result.text, /November 30, 2026 at 5:30 PM/);
    assert.match(result.text, /November 28, 2026/);
    assert.match(result.text, /Room 401, Example Campus/);
    t.diagnostic(`Scanned PDF: ${result.extractionMetrics.ms}ms`);
  });

  await t.test('PDF tables preserve milestone, date and time relationships in Markdown', async () => {
    const result = await readLocalDocumentText(await fixture('table.pdf'), dependencies);
    checkParser(result);
    assert.equal(result.extractionMetrics.ocrPages, 0);
    assert.match(result.text, /\|\s*Milestone\s*\|\s*Due date\s*\|\s*Time\s*\|/);
    assert.match(result.text, /\|\s*Research draft\s*\|\s*December 2, 2026\s*\|\s*4 PM\s*\|/);
    assert.match(result.text, /\|\s*Final presentation\s*\|\s*December 9, 2026\s*\|\s*3 PM\s*\|/);
  });

  await t.test('mixed PDF retains native and embedded-image requirements in page order', async () => {
    const result = await readLocalDocumentText(await fixture('mixed.pdf'), dependencies);
    checkParser(result);
    assert.equal(result.extractionMetrics.ocrPages, 2);
    const pages = result.text.split('\f');
    assert.equal(pages.length, 2);
    assert.match(pages[0], /Native requirement: draft due December 2, 2026 at 4 PM/);
    assert.match(pages[0], /Workshop on December 9, 2026 at 3 PM/);
    assert.match(pages[1], /November 30, 2026 at 5:30 PM/);
    assert.doesNotMatch(pages[0], /November 30/);
    assert.doesNotMatch(pages[1], /December 2/);
    t.diagnostic(`Mixed PDF: ${result.extractionMetrics.ms}ms, ${result.extractionMetrics.ocrPages} OCR pages`);
  });

  for (const name of ['invitation.png', 'invitation-exif.jpg']) await t.test(`${name} reads visible text without promoting EXIF dates or GPS`, async () => {
    const input = await fixture(name);
    if (name.endsWith('.jpg')) assert.ok(input.buffer.includes(Buffer.from('PRIVATE_METADATA_ONLY')), 'Fixture must really carry EXIF metadata');
    const result = await readLocalDocumentText(input, {...dependencies, resolveMarkdown: async () => assert.fail('Photos must remain local OCR')});
    assert.match(result.method, /Tesseract OCR/);
    assert.equal(result.extractionMetrics.ocrPages, 1);
    assert.match(result.text, /November 30, 2026 at 5:30 PM/);
    assert.match(result.text, /November 28, 2026/);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_METADATA_ONLY|1999|GPS|Latitude|Longitude/);
    t.diagnostic(`${name}: ${result.extractionMetrics.ms}ms`);
  });

  await t.test('native fallback still extracts the same dates when explicitly selected', async () => {
    const result = await readLocalDocumentText(await fixture('searchable.pdf'), {...dependencies, resolveMarkdown: async () => null});
    assert.equal(result.extractionMetrics.pdfParser, 'poppler');
    assert.match(result.text, /December 1, 2026 at 5 PM/);
    assert.match(result.text, /December 15, 2026 at 2 PM/);
    t.diagnostic(`Poppler comparison: ${result.extractionMetrics.ms}ms`);
  });

  await t.test('malformed, encrypted, oversized and excessive-page files fail before rendering', async () => {
    for (const name of ['malformed.pdf', 'encrypted.pdf', 'seven-pages.pdf', 'five-scanned-pages.pdf']) {
      const calls = [], directories = new Set();
      const observed = {...dependencies, runCommand: async (program, args, settings) => {
        calls.push(program);
        directories.add(settings.env.TMPDIR);
        return exec(program, args, settings);
      }};
      await assert.rejects(readLocalDocumentText(await fixture(name), observed), error => error.status === 400 && !error.message.includes(fixtures));
      assert.ok(!calls.includes('pdftoppm'), `${name} must fail before rendering`);
      assert.ok(!calls.includes('tesseract'), `${name} must fail before OCR`);
      for (const directory of directories) await assert.rejects(access(directory), {code: 'ENOENT'});
    }
    const oversized = Buffer.alloc(ENROLLMENT_LIMITS.bytes + 1);
    oversized.write('%PDF-1.7');
    await assert.rejects(readLocalDocumentText({buffer: oversized, mimeType: 'application/pdf'}, {...dependencies, runCommand: () => assert.fail('Oversized files must fail before spawning a tool')}), /12 MB/);
  });

  await t.test('bridge rejects URLs, non-PDFs, symlinks, FIFOs, encryption and page mismatches', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'brb-markitdown-bridge-test-'));
    const rejectBridge = async (filename, pages, code) => {
      let response;
      try { await exec(python, ['-I', MARKITDOWN_SCRIPT, filename, '--pages', String(pages)], toolOptions); assert.fail('Unsafe bridge input succeeded'); }
      catch (error) {
        assert.equal(error.code, 1);
        assert.equal(error.stderr, '');
        response = JSON.parse(error.stdout);
      }
      assert.equal(response.available, false);
      assert.equal(response.error, code);
      assert.equal(response.pages, undefined);
      assert.doesNotMatch(JSON.stringify(response), /synthetic-user-password|PRIVATE_METADATA_ONLY|brb-markitdown-bridge-test/);
    };
    try {
      await writeFile(path.join(directory, 'not.pdf'), 'synthetic non-PDF document');
      await symlink(path.join(fixtures, 'searchable.pdf'), path.join(directory, 'linked.pdf'));
      await exec('mkfifo', [path.join(directory, 'pipe.pdf')], toolOptions);
      await rejectBridge('https://example.invalid/private.pdf', 1, 'invalid_input');
      await rejectBridge(path.join(directory, 'not.pdf'), 1, 'invalid_pdf');
      await rejectBridge(path.join(directory, 'linked.pdf'), 2, 'invalid_input');
      await rejectBridge(path.join(directory, 'pipe.pdf'), 1, 'invalid_input');
      await rejectBridge(path.join(fixtures, 'encrypted.pdf'), 2, 'encrypted_pdf');
      await rejectBridge(path.join(fixtures, 'seven-pages.pdf'), 7, 'page_limit');
      await rejectBridge(path.join(fixtures, 'searchable.pdf'), 1, 'page_count_mismatch');
      await rejectBridge(path.join(fixtures, 'malformed.pdf'), 1, 'invalid_pdf');
    } finally { await rm(directory, {recursive: true, force: true}); }
  });

  await t.test('bridge explicitly denies network sockets and child processes', async () => {
    const code = [
      'import runpy, socket, subprocess, sys',
      'module = runpy.run_path(sys.argv[1])',
      'sys.addaudithook(module["deny_external_access"])',
      'for action in (lambda: socket.socket(), lambda: subprocess.run([sys.executable, "--version"])):',
      '    try: action()',
      '    except PermissionError: pass',
      '    else: raise AssertionError("External access was allowed")',
      'print("external-access-denied")',
    ].join('\n');
    const result = await exec(python, ['-I', '-c', code, MARKITDOWN_SCRIPT], toolOptions);
    assert.equal(result.stdout.trim(), 'external-access-denied');
    assert.equal(result.stderr, '');
  });
});
