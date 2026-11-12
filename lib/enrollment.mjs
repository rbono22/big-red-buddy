import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCourseCatalog, TERM_POLICIES } from './course-catalog.mjs';
import { HttpError } from './security.mjs';
import { idFor } from './domain.mjs';

const exec = promisify(execFile);
export const ENROLLMENT_LIMITS = Object.freeze({ bytes: 12 * 1024 * 1024, pages: 6, ocrPages: 4, ocrConcurrency: 2, pixels: 24000000, dimension: 12000, textCharacters: 200000, references: 60, totalMs: 120000 });
const MIME = new Set(['application/pdf', 'image/png', 'image/jpeg']);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const normalizeMime = value => String(value || '').toLowerCase() === 'image/jpg' ? 'image/jpeg' : String(value || '').toLowerCase();
const safeName = value => path.basename(String(value || 'Enrollment upload').replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) || 'Enrollment upload';
const coursePattern = () => /\b([A-Z]{2,10})[ \t]*([1-9]\d{3}[A-Z]?)(?:[ \t]*[-–—][ \t]*(\d{2,4}))?\b/g;
const unique = values => [...new Set(values.filter(Boolean))];
const fail = (message, code = 'invalid_enrollment_upload', status = 400) => new HttpError(status, message, code);

function imageDimensions(buffer, mimeType) {
  if (mimeType === 'image/png') {
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG) || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') throw fail('Upload a valid PNG, JPEG, or PDF.');
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length < 12 || buffer[0] !== 0xff || buffer[1] !== 0xd8) throw fail('Upload a valid PNG, JPEG, or PDF.');
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset++] !== 0xff) throw fail('The JPEG header is malformed.');
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if ([0xd8, 0x01].includes(marker) || marker >= 0xd0 && marker <= 0xd7) continue;
    if ([0xd9, 0xda].includes(marker) || offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw fail('The JPEG header is malformed.');
    if (frames.has(marker)) {
      if (length < 8) throw fail('The JPEG dimensions are missing.');
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  throw fail('The JPEG dimensions could not be verified.');
}
function validateBuffer(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > ENROLLMENT_LIMITS.bytes) throw fail('Document uploads must be nonempty and no larger than 12 MB.');
  if (!MIME.has(mimeType)) throw fail('Use a PDF, JPEG, or PNG. Export HEIC photos as JPEG first.', 'unsupported_enrollment_type', 415);
  if (mimeType === 'application/pdf') {
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw fail('The declared PDF does not have a PDF header.');
  } else {
    const { width, height } = imageDimensions(buffer, mimeType);
    if (!width || !height || width > ENROLLMENT_LIMITS.dimension || height > ENROLLMENT_LIMITS.dimension || width * height > ENROLLMENT_LIMITS.pixels) throw fail('Photos must be at most 24 megapixels and 12,000 pixels per side.');
  }
  return buffer;
}
export function validateEnrollmentUpload({ base64, mimeType, name } = {}) {
  if (typeof name !== 'undefined' && typeof name !== 'string') throw fail('Provide a filename.');
  if (typeof base64 !== 'string' || !base64.length || base64.length > Math.ceil(ENROLLMENT_LIMITS.bytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw fail('Provide a valid base64 upload no larger than 12 MB.');
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.toString('base64') !== base64) throw fail('The upload encoding is invalid.');
  return validateBuffer(buffer, normalizeMime(mimeType));
}

/** Parse identifiers and explicit context only. Names, student IDs, and source prose are discarded. */
export function parseEnrollmentText(raw) {
  if (typeof raw !== 'string' || raw.length > ENROLLMENT_LIMITS.textCharacters) throw fail('The enrollment document contains too much text. Upload fewer pages.');
  const text = raw.replace(/\r/g, '').replace(/[\u2010-\u2014\u2212]/g, '-').split('\n').filter(line => !/^\s*(?:https?:\/\/|www\.)/i.test(line)).join('\n');
  const detectedTerms = unique([...text.matchAll(/\b(Fall|Spring)[ \t]+(20\d{2})\b/gi)].map(match => `${match[1].toLowerCase() === 'fall' ? 'FA' : 'SP'}${match[2].slice(-2)}`));
  const contexts = []; let offset = 0, context = 'unknown';
  for (const line of text.split('\n')) {
    if (/\bShopping\s*Cart\b/i.test(line) || /^\s*Add to Cart\s*$/i.test(line)) context = 'cart';
    else if (/^\s*(?:My\s+)?(?:(?:Fall|Spring)\s+20\d{2}\s+)?Class\s+Schedule\s*$/i.test(line)) context = 'class-schedule';
    contexts.push({ offset, context }); offset += line.length + 1;
  }
  const contextAt = index => { let value = 'unknown'; for (const item of contexts) { if (item.offset > index) break; value = item.context; } return value; };
  const matches = [...text.matchAll(coursePattern())];
  if (matches.length > ENROLLMENT_LIMITS.references) throw fail('The document contains too many course references. Upload a shorter class schedule.');
  const references = matches.map((match, index) => {
    const end = Math.min(matches[index + 1]?.index ?? text.length, match.index + 900);
    const block = text.slice(match.index, end).split('\n').slice(0, 6).join('\n');
    const classNumbers = unique([...block.matchAll(/\((\d{4,6})\)|\bClass\s*(?:Nbr|Number|No\.?|#)\s*[:#]?\s*(\d{4,6})\b/gi)].map(item => item[1] || item[2]));
    const statusValues = unique([...block.matchAll(/\bStatus\s*:\s*(Enrolled|Registered|Dropped|Wait\s*Listed)\b/gi)].map(item => item[1].toLowerCase().replace(/\s/g, '')));
    const sourceSection = contextAt(match.index);
    const enrollmentStatus = sourceSection === 'cart' ? 'cart' : statusValues.length === 1 ? ({ registered: 'enrolled', enrolled: 'enrolled', dropped: 'dropped', waitlisted: 'waitlisted' }[statusValues[0]]) : 'unknown';
    const componentName = block.match(/\((Lecture|Discussion|Laboratory|Lab|Studio|Seminar|Field)\)/i)?.[1]?.toLowerCase();
    return { code: `${match[1]} ${match[2]}`, section: match[3] || null, classNumbers, component: ({ lecture: 'LEC', discussion: 'DIS', laboratory: 'LAB', lab: 'LAB', studio: 'STU', seminar: 'SEM', field: 'FLD' })[componentName] || null, enrollmentStatus, sourceSection };
  });
  return { detectedTerms, references };
}

export function matchEnrollmentText(text, { term, sourceName = 'Enrollment upload', snapshot, method = 'PDF text', warnings = [] } = {}) {
  const parsed = parseEnrollmentText(text);
  if (parsed.detectedTerms.length > 1) throw fail('The upload refers to multiple academic terms. Upload one term at a time.', 'enrollment_term_conflict');
  const detectedTerm = parsed.detectedTerms[0] || null;
  term ||= detectedTerm;
  if (!Object.hasOwn(TERM_POLICIES, term || '')) throw fail('Choose FA26 or SP27 for this upload.', 'enrollment_term_required');
  if (detectedTerm && term !== detectedTerm) throw fail(`The document names ${detectedTerm}, but ${term} was selected. Choose the document’s term.`, 'enrollment_term_conflict');
  if (!snapshot || snapshot.term !== term || !Array.isArray(snapshot.courses)) throw fail('A matching course catalog is required.', 'catalog_unavailable', 502);
  const proposalWarnings = [
    ...warnings,
    'No calendar changes have been made. Select only classes you intend to include, then confirm once.',
    'A class-schedule heading does not verify enrollment. Enrolled/dropped/waitlist icons may be absent from text or OCR; check the original status column for each class.',
    'Dates and meeting locations come from the public catalog snapshot, not the enrollment upload. Confirm current details in Cornell Student Center.',
    ...(snapshot.warnings || []),
    ...(!detectedTerm ? [`The document’s term could not be read. Confirm that ${term} is correct before selecting classes.`] : []),
  ];
  const candidates = [], unmatched = [], seen = new Map();
  for (const reference of parsed.references) {
    const identifier = `${reference.code}${reference.section ? `-${reference.section}` : ''}${reference.classNumbers.length ? ` (${reference.classNumbers.join(', ')})` : ''}`;
    if (['cart', 'dropped', 'waitlisted'].includes(reference.enrollmentStatus)) {
      unmatched.push({ text: identifier, reason: reference.enrollmentStatus === 'cart' ? 'Shopping-cart entry excluded; it is not proof of registration.' : `${reference.enrollmentStatus === 'dropped' ? 'Dropped' : 'Waitlisted'} entry excluded from the proposed class schedule.` }); continue;
    }
    if (parsed.references.some(other => ['dropped', 'waitlisted'].includes(other.enrollmentStatus) && other.code === reference.code && ((other.classNumbers.length === 1 && reference.classNumbers.includes(other.classNumbers[0])) || other.section && other.section === reference.section))) {
      unmatched.push({ text: identifier, reason: 'Another row marks this same section dropped or waitlisted. Resolve the conflicting document status manually.' }); continue;
    }
    const courses = snapshot.courses.filter(course => `${course.subject} ${course.catalogNumber}`.toUpperCase() === reference.code.toUpperCase() || course.code?.toUpperCase() === reference.code.toUpperCase());
    if (!courses.length) { unmatched.push({ text: identifier, reason: `No exact course code exists in the ${term} snapshot.` }); continue; }
    if (reference.classNumbers.length > 1) { unmatched.push({ text: identifier, reason: 'Several class numbers are associated with this course; choose its exact section manually.' }); continue; }
    if (!reference.classNumbers.length && !reference.section) { unmatched.push({ text: identifier, reason: 'Course code found without an exact section or class number. No section was guessed.' }); continue; }
    let options = courses.flatMap(course => course.sections.map(section => ({ course, section })));
    if (reference.classNumbers.length) options = options.filter(({ section }) => String(section.classNumber) === reference.classNumbers[0]);
    if (reference.section) options = options.filter(({ section }) => String(section.section) === reference.section);
    if (reference.component) options = options.filter(({ section }) => section.component?.toUpperCase() === reference.component);
    if (options.length !== 1) { unmatched.push({ text: identifier, reason: options.length ? 'The identifiers match multiple sections; select the intended section manually.' : 'The course, section, and class number do not agree with an exact catalog section. No fallback section was selected.' }); continue; }
    const { course, section } = options[0], key = `${course.id}:${section.id}`;
    if (seen.has(key)) {
      const previous = seen.get(key);
      if (previous.enrollmentStatus !== reference.enrollmentStatus) { previous.enrollmentStatus = 'unknown'; previous.warnings.push('Duplicate document rows disagree about enrollment status. Check the original.'); }
      continue;
    }
    const candidate = {
      rowId: idFor('enrollment-row', term, course.id, section.id), courseId: course.id, sectionId: section.id,
      code: course.code, name: course.name, label: section.label, classNumber: section.classNumber, section: section.section,
      matchBasis: reference.classNumbers.length ? 'exact-course-and-class-number' : 'exact-course-and-section',
      enrollmentStatus: reference.enrollmentStatus, enrollmentVerified: false, sourceSection: reference.sourceSection,
      importable: section.importable === true, blockedReason: section.blockedReason || null,
      warnings: unique([...(section.warnings || []), reference.enrollmentStatus === 'unknown' ? 'Enrollment status is unreadable or ambiguous. Verify this row is not dropped or waitlisted before selecting it.' : 'Textual enrollment status was read from the upload; it has not been verified with Cornell.', ...(section.importable ? [] : ['This catalog section cannot be imported automatically; use its published blocked reason.'])]),
      meetingsSummary: section.meetingsSummary, location: section.location, sourceUrl: course.courseUrl,
      catalogUrl: snapshot.sourceUrl, snapshotFetchedAt: snapshot.snapshotFetchedAt, sourceUpdatedAt: snapshot.sourceUpdatedAt,
    };
    seen.set(key, candidate); candidates.push(candidate);
  }
  if (!parsed.references.length) proposalWarnings.push('No exact course identifiers were readable. Try a sharper, uncropped photo or a searchable class-schedule PDF.');
  return { id: randomUUID(), term, detectedTerm, sourceName: safeName(sourceName), method, requiresConfirmation: true, defaultSelection: [], candidates, unmatched: unmatched.slice(0, ENROLLMENT_LIMITS.references), warnings: unique(proposalWarnings), sourceUrl: snapshot.sourceUrl, snapshotFetchedAt: snapshot.snapshotFetchedAt, sourceUpdatedAt: snapshot.sourceUpdatedAt, rawTextRetained: false };
}

export async function analyzeEnrollment(input, catalog = createCourseCatalog(), dependencies = {}) { return processDocument(input, {...dependencies, catalog, purpose: 'enrollment'}); }
export async function readLocalDocumentText(input, dependencies = {}) { return processDocument(input, {...dependencies, purpose: 'syllabus'}); }
function onlySmallIllustrations(imageList) {
  const rows=imageList.split('\n').filter(line=>/^\s*\d+\s+\d+\s+(?:image|mask|smask)\b/.test(line));
  if(!rows.length)return false;
  let totalSquareInches=0;
  return rows.every(line=>{
    const fields=line.trim().split(/\s+/),width=Number(fields[3]),height=Number(fields[4]);
    // Poppler ends each image row with x-ppi, y-ppi, size, ratio. Read
    // from that end because inline images have a different object-ID field.
    const xPpi=Number(fields.at(-4)),yPpi=Number(fields.at(-3));
    if(![width,height,xPpi,yPpi].every(value=>Number.isFinite(value)&&value>0))return false;
    const inchesWide=width/xPpi,inchesHigh=height/yPpi;
    // Skip only small physical illustrations on pages already containing
    // searchable text. A header above a scan/table still needs page OCR.
    totalSquareInches+=inchesWide*inchesHigh;
    return inchesWide<=2&&inchesHigh<=2&&totalSquareInches<=1;
  });
}
async function findOCREngine() {
  for (const directory of String(process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const program = path.join(directory, 'tesseract');
    try { await access(program, constants.X_OK); return {kind:'tesseract', program}; } catch {}
  }
  if (process.platform === 'darwin') return {kind:'vision', program:'/usr/bin/swift'};
  throw fail('Local image OCR is unavailable. The operator must install Tesseract before photos or scanned PDFs can be read.', 'enrollment_tools_unavailable', 503);
}
function imageRowsByPage(list, pages) {
  const rows = Array.from({length:pages},()=>[]);
  for (const line of list.split('\n')) {
    const match=line.match(/^\s*(\d+)\s+\d+\s+(?:image|mask|smask)\b/);
    if (match && Number(match[1]) >= 1 && Number(match[1]) <= pages) rows[Number(match[1])-1].push(line);
  }
  return rows;
}
// A scanned table can coexist with a searchable heading. Retain both evidence
// sources rather than replacing accurate native text with an OCR approximation.
function combinePageText(native, recognized) {
  if (!recognized.trim()) return native;
  if (!native.trim()) return recognized;
  const compact=value=>value.replace(/\s+/g,' ').trim();
  return compact(recognized).includes(compact(native)) ? recognized : `${native.trim()}\n${recognized.trim()}`;
}
async function processDocument({ buffer, mimeType, name, term } = {}, {catalog, purpose, runCommand = exec, resolveOCR = findOCREngine}) {
  mimeType = normalizeMime(mimeType); validateBuffer(buffer, mimeType);
  if (term && !Object.hasOwn(TERM_POLICIES, term)) throw fail('Choose FA26 or SP27 for this upload.');
  const directory = await mkdtemp(path.join(tmpdir(), 'brf-enrollment-'));
  const startedAt=Date.now(),deadline = startedAt + ENROLLMENT_LIMITS.totalMs, warnings = [], methods = new Set(), abort = new AbortController();
  const metrics={pages:1,ocrPages:0,processes:0,pdfImageInspections:0,ocrConcurrency:0};
  const extractionMetrics=()=>({...metrics,ms:Date.now()-startedAt});
  const remaining = max => { const time = Math.min(max, deadline - Date.now()); if (time < 1) throw fail('Document analysis exceeded its time limit. Upload fewer pages.', 'enrollment_timeout', 408); return time; };
  async function command(program, args, timeout = 20000, extraEnv = {}) {
    const environment = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: homedir(), LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TMPDIR: directory, ...extraEnv };
    for (const key of ['SDKROOT', 'DEVELOPER_DIR']) if (process.env[key]) environment[key] = process.env[key];
    try {
      const limit=remaining(timeout); if(abort.signal.aborted)throw fail('Document processing was stopped.', 'enrollment_processing_failed');
      metrics.processes++;
      return (await runCommand(program, args, { timeout: limit, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, encoding: 'utf8', env: environment, signal:abort.signal })).stdout;
    }
    catch (error) {
      if (error instanceof HttpError) throw error;
      if (error.code === 'ENOENT') throw fail('Local OCR or PDF tools are unavailable on this host. The operator must install Poppler and an image OCR engine.', 'enrollment_tools_unavailable', 503);
      if (error.killed) throw fail('Local document processing timed out. Try fewer pages or a smaller photo.', 'enrollment_timeout', 408);
      throw fail('The document could not be read locally. Try a searchable PDF or a clear JPEG/PNG.', 'enrollment_processing_failed');
    }
  }
  let enginePromise;
  const getEngine=()=>enginePromise ||= resolveOCR();
  async function ocr(file) {
    const warning=purpose === 'syllabus' ? 'OCR can misread dates, times, and requirements. Review the original before confirming.' : 'OCR can misread identifiers and status icons. Review each exact catalog match against the original photo.';
    if(!warnings.includes(warning))warnings.push(warning);
    const engine=await getEngine();
    if (engine.kind === 'tesseract') {
      methods.add('local Tesseract OCR');
      return command(engine.program, [file, 'stdout', '-l', 'eng', '--psm', '3'], 30000, { OMP_THREAD_LIMIT: '1' });
    }
    if (engine.kind === 'vision') {
      methods.add('local Apple Vision OCR');
      const cache = path.join(directory, 'swift-cache'); await mkdir(cache, { recursive: true, mode: 0o700 });
      const result = await command(engine.program, ['-module-cache-path', cache, fileURLToPath(new URL('../scripts/ocr-image.swift', import.meta.url)), file], 45000);
      let value; try { value = JSON.parse(result); } catch { throw fail('Local image OCR returned an invalid response.'); }
      if (!Array.isArray(value.lines) || value.lines.length > 3000 || value.lines.some(line => typeof line.text !== 'string')) throw fail('Local image OCR returned unsupported text.');
      return value.lines.map(line => line.text).join('\n');
    }
    throw fail('Local image OCR is unavailable. The operator must install Tesseract before photos or scanned PDFs can be read.', 'enrollment_tools_unavailable', 503);
  }
  try {
    const file = path.join(directory, mimeType === 'application/pdf' ? 'upload.pdf' : mimeType === 'image/png' ? 'upload.png' : 'upload.jpg');
    await writeFile(file, buffer, { mode: 0o600 });
    let text;
    if (mimeType !== 'application/pdf') {metrics.ocrPages=1;metrics.ocrConcurrency=1;text = await ocr(file);}
    else {
      const info = await command('pdfinfo', [file], 10000);
      const pages = Number(info.match(/^Pages:\s+(\d+)$/m)?.[1]);
      if (!Number.isInteger(pages) || pages < 1 || pages > ENROLLMENT_LIMITS.pages) throw fail('Document PDFs must contain no more than 6 pages.');
      if (/^Encrypted:\s+yes/m.test(info)) throw fail('Upload an unlocked copy of your PDF.');
      const pagesText = (await command('pdftotext', ['-layout', '-f', '1', '-l', String(pages), file, '-'], 20000)).split('\f').slice(0, pages);
      if (pagesText.join('').length > ENROLLMENT_LIMITS.textCharacters) throw fail('This PDF contains too much text. Upload fewer pages.');
      metrics.pages=pages;
      methods.add('PDF text');
      // Inspect the PDF's image index once. Re-running pdfimages per page
      // repeatedly parses the whole file and adds avoidable process launches.
      metrics.pdfImageInspections++;
      const imagesByPage=imageRowsByPage(await command('pdfimages', ['-f','1','-l',String(pages),'-list',file],10000),pages), scan=[];
      for (let index=0;index<pages;index++) {
        const current=pagesText[index]||'',imageRows=imagesByPage[index];
        if(current.trim().length>=40 || purpose==='enrollment'&&coursePattern().test(current)) {
          if(!imageRows.length) {
            if(purpose==='enrollment'&&!coursePattern().test(current))warnings.push(`Page ${index+1} has searchable text but no readable course identifiers or embedded images. Check the original for coverage; no image OCR was attempted on that page.`);
            continue;
          }
          if(onlySmallIllustrations(imageRows.join('\n'))) {
            warnings.push(`Page ${index+1} used its searchable text. Small embedded illustrations were not OCRed; upload a close-up if one contains ${purpose==='syllabus'?'deadline':'schedule'} information.`);
            continue;
          }
        }
        scan.push(index);
      }
      // Reject excess scans before rendering any page, so hostile or oversized
      // documents cannot consume the full OCR allowance before failing.
      if(scan.length>ENROLLMENT_LIMITS.ocrPages)throw fail('Too many PDF pages require OCR. Upload at most 4 scanned pages at a time.');
      metrics.ocrPages=scan.length;
      if(scan.length) {
        const engine=await getEngine(),lanes=Math.min(scan.length,engine.kind==='tesseract'?ENROLLMENT_LIMITS.ocrConcurrency:1);
        metrics.ocrConcurrency=lanes;
        let cursor=0,failure;
        const recognize=async()=>{
          while(cursor<scan.length&&!failure) {
            const index=scan[cursor++],prefix=path.join(directory,`page-${index+1}`);
            try {
              await command('pdftoppm',['-f',String(index+1),'-singlefile','-scale-to','2400','-png',file,prefix],20000);
              const recognized=await ocr(`${prefix}.png`);
              if(!recognized.trim())warnings.push(`Page ${index+1} returned no OCR text. Check the original page for missing information.`);
              pagesText[index]=combinePageText(pagesText[index]||'',recognized);
            } catch(error) {if(!failure){failure=error;abort.abort();}}
          }
        };
        // Join every lane before the private temporary directory is removed.
        await Promise.all(Array.from({length:lanes},recognize));
        if(failure)throw failure;
      }
      text = pagesText.join('\n\f\n');
    }
    if (purpose === 'syllabus') {
      if (text.trim().length < 40 || text.length > ENROLLMENT_LIMITS.textCharacters) throw fail('No usable syllabus text was read. Send a sharper photo or fewer pages.');
      return {text, method: [...methods].join(' + '), warnings, extractionMetrics:extractionMetrics()};
    }
    const parsed = parseEnrollmentText(text), detected = parsed.detectedTerms;
    if (detected.length > 1 || detected.length === 1 && term && detected[0] !== term) throw fail('The document’s academic term does not match the selected term. Upload one term and select it explicitly.', 'enrollment_term_conflict');
    const target = term || detected[0];
    if (!Object.hasOwn(TERM_POLICIES, target || '')) throw fail('The term was unreadable. Select FA26 or SP27 before uploading.', 'enrollment_term_required');
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(fail('Catalog lookup timed out. Try again.', 'enrollment_timeout', 408)), remaining(15000)); });
    let snapshot; try { snapshot = await Promise.race([catalog.get(target), timeout]); } finally { clearTimeout(timer); }
    return {...matchEnrollmentText(text, { term: target, sourceName: name, snapshot, method: [...methods].join(' + '), warnings }),extractionMetrics:extractionMetrics()};
  } finally { await rm(directory, { recursive: true, force: true }); }
}
