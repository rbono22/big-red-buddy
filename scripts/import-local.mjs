import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { openDatabase } from '../lib/database.mjs';
import { pdfText, extractEvents, persistCandidates } from '../lib/ingest.mjs';
import { idFor } from '../lib/domain.mjs';
import { audit } from '../lib/integrations.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const email=String(process.env.IMPORT_STUDENT_EMAIL||'').trim().toLowerCase();
if(!email)throw new Error('Set IMPORT_STUDENT_EMAIL to the already signed-in student who owns these files.');
const syllabus=process.env.SYLLABUS_PDF_PATH, resume=process.env.RESUME_PDF_PATH;
if(!syllabus||!resume)throw new Error('Set SYLLABUS_PDF_PATH and RESUME_PDF_PATH privately for the intended student.');
const database=await openDatabase({dataDir:process.env.ASSISTANT_DATA||path.join(root,'data')});
try {
  const matches=(await database.auth.all('users')).filter(user=>String(user.email||'').toLowerCase()===email);
  const verified=matches.filter(user=>user.provider==='google'),development=matches.filter(user=>user.provider==='dev');
  const user=verified.length===1?verified[0]:verified.length===0&&development.length===1?development[0]:null;
  if(!user||await database.isDeleted(user.id))throw new Error('Sign in first as the intended active owner; an unambiguous Google or development identity is required.');
  const store=database.forUser(user.id);
  if (!(await store.get('settings', 'profile'))) await store.put('settings', 'profile', {
    name: user.name || 'Student',
    email: user.email,
    model: process.env.OLLAMA_MODEL || 'qwen3.5:9b-q4_K_M',
    jobTitles: '',
    jobLocation: '',
    paused: true
  });
  const text = await pdfText(syllabus),
    result = await extractEvents(text);
  await persistCandidates(store, {
    id: idFor('syllabus', path.basename(syllabus)),
    name: path.basename(syllabus),
    type: 'syllabus',
    hash: idFor(text),
    method: result.method
  }, result.events);
  const resumeText = await pdfText(resume);
  await store.put('documents', 'resume', {
    name: path.basename(resume),
    text: resumeText,
    file: (await readFile(resume)).toString('base64'),
    updatedAt: new Date().toISOString()
  });
  await audit(store, 'setup', `${result.events.length} syllabus records imported. Resume encrypted in student storage.`);
  console.log(JSON.stringify({
    syllabusCandidates: result.events.length,
    resumeLoaded: true,
    allRequireReview: true
  }));
} finally {
  await database.close();
}
