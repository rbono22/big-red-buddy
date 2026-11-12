import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,truncate,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pdfText} from '../lib/ingest.mjs';
import {ENROLLMENT_LIMITS} from '../lib/enrollment.mjs';

async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'brb-pdf-text-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'resume.pdf');await writeFile(file,'%PDF-1.4\nSynthetic fixture',{mode:0o600});return {dir,file};}
test('resume and legacy PDF imports use the shared bounded OCR parser',async t=>{
 const {file}=await fixture(t);let calls=0;
 const text='Synthetic resume with enough readable professional text to support a grounded document review.';
 assert.equal(await pdfText(file,{readDocument:async input=>{calls++;assert.equal(input.mimeType,'application/pdf');assert.equal(input.buffer.toString(),'%PDF-1.4\nSynthetic fixture');return {text,method:'local OCR'};}}),text);
 assert.equal(calls,1);
});
test('oversized PDFs and nonfiles are rejected before loading or parsing',async t=>{
 const {dir,file}=await fixture(t);await truncate(file,ENROLLMENT_LIMITS.bytes+1);
 const readDocument=()=>{throw new Error('parser must not run');};
 for(const input of [file,dir])await assert.rejects(pdfText(input,{readDocument}),e=>e.status===413);
});
test('shared parser errors and unreadable output never become successful resume text',async t=>{
 const {file}=await fixture(t);
 const failure=Object.assign(new Error('Upload an unlocked PDF.'),{status:400});
 await assert.rejects(pdfText(file,{readDocument:async()=>{throw failure;}}),e=>e===failure);
 for(const text of ['',null,'too short'])await assert.rejects(pdfText(file,{readDocument:async()=>({text})}),e=>e.status===400&&/clear, unlocked/.test(e.message));
});
