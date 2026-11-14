import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { validateEnrollmentUpload, parseEnrollmentText, matchEnrollmentText, analyzeEnrollment, readLocalDocumentText, ENROLLMENT_LIMITS } from '../lib/enrollment.mjs';

const snapshot = () => ({ term:'FA26', sourceUrl:'https://catalog.invalid/FA26.json', snapshotFetchedAt:'2026-11-10T00:00:00Z', sourceUpdatedAt:null, warnings:[], courses:[
  {id:'NBAY5300',subject:'NBAY',catalogNumber:'5300',code:'NBAY 5300',name:'Synthetic Finance',courseUrl:'https://catalog.invalid/NBAY5300',sections:[{id:'finance-001',section:'001',classNumber:'18400',component:'LEC',label:'Lecture 001',importable:true,blockedReason:null,warnings:[],location:'Synthetic room',meetingsSummary:'Mon 13:25-14:40'}]},
  {id:'INFO6410',subject:'INFO',catalogNumber:'6410',code:'INFO 6410',name:'Synthetic Design',courseUrl:'https://catalog.invalid/INFO6410',sections:[{id:'design-030',section:'030',classNumber:'16714',component:'LEC',label:'Lecture 030',importable:true,blockedReason:null,warnings:[],location:'Synthetic room',meetingsSummary:'Wed 08:40-09:55'}]},
  {id:'NBAY5695',subject:'NBAY',catalogNumber:'5695',code:'NBAY 5695',name:'Synthetic Cart',courseUrl:'https://catalog.invalid/NBAY5695',sections:[{id:'cart-002',section:'002',classNumber:'2859',component:'LEC',label:'Lecture 002',importable:true,warnings:[],location:'Synthetic room',meetingsSummary:'Wed 10:10-12:55'}]},
] });
const match = (text, options={}) => matchEnrollmentText(text,{term:'FA26',snapshot:snapshot(),...options});

function pdf(objects) {
  const chunks=[Buffer.from('%PDF-1.4\n')], offsets=[0];let length=chunks[0].length;
  objects.forEach((object,index)=>{offsets.push(length);const body=Buffer.concat([Buffer.from(`${index+1} 0 obj\n`),Buffer.isBuffer(object)?object:Buffer.from(object),Buffer.from('\nendobj\n')]);chunks.push(body);length+=body.length;});
  chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(value=>`${String(value).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
const textPDF = (lines,pages=1) => {
  const fontId=pages+3,streamId=pages+4;
  const stream=`BT /F1 22 Tf 40 700 Td ${lines.map((line,index)=>`${index?'0 -70 Td ':''}(${line.replace(/[\\()]/g,'\\$&')}) Tj`).join(' ')} ET`;
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${Array.from({length:pages},(_,i)=>`${i+3} 0 R`).join(' ')}] /Count ${pages} >>`,...Array.from({length:pages},()=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`),'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]);
};
function illustratedPDF({lines,pages=1,image,width,height,filter='FlateDecode',displayWidth=36,displayHeight=36}) {
  const fontId=pages+3,imageId=pages+4,streamId=pages+5;
  const stream=`BT /F1 15 Tf 40 740 Td ${lines.map((line,index)=>`${index?'0 -25 Td ':''}(${line.replace(/[\\()]/g,'\\$&')}) Tj`).join(' ')} ET q ${displayWidth} 0 0 ${displayHeight} 40 40 cm /Im1 Do Q`;
  return pdf(['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${Array.from({length:pages},(_,i)=>`${i+3} 0 R`).join(' ')}] /Count ${pages} >>`,...Array.from({length:pages},()=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> /XObject << /Im1 ${imageId} 0 R >> >> /Contents ${streamId} 0 R >>`),'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${filter} /Length ${image.length} >>\nstream\n`),image,Buffer.from('\nendstream')]),`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]);
}
const hasPoppler = spawnSync('pdfinfo',['-v'],{stdio:'ignore'}).status===0;

test('enrollment upload validates declared format, base64, size, and image pixel limits',()=>{
  const buffer=textPDF(['My Fall 2026 Class Schedule','NBAY 5300-001 (18400)']);
  assert.deepEqual(validateEnrollmentUpload({base64:buffer.toString('base64'),mimeType:'application/pdf',name:'schedule.pdf'}),buffer);
  assert.throws(()=>validateEnrollmentUpload({base64:buffer.toString('base64'),mimeType:'image/jpeg'}));
  assert.throws(()=>validateEnrollmentUpload({base64:'not base64',mimeType:'application/pdf'}));
  assert.throws(()=>validateEnrollmentUpload({base64:Buffer.alloc(ENROLLMENT_LIMITS.bytes+1).toString('base64'),mimeType:'application/pdf'}));
  const png=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(12000,16);png.writeUInt32BE(12000,20);
  assert.throws(()=>validateEnrollmentUpload({base64:png.toString('base64'),mimeType:'image/png'}),/24 megapixels/);
});

test('cart entries are excluded and heading/status legend never establishes per-row enrollment',()=>{
  const text='Example Student\nhttps://student.invalid/?EMPLID=9999999\nFall 2026 Shopping Cart\nNBAY 5695-002\n(2859)\nMy Fall 2026 Class Schedule\nEnrolled Dropped Wait Listed\nNBAY 5300-001 Synthetic Finance (Lecture)\n(18400)\nINFO 6410-030 (16714)';
  const proposal=match(text,{sourceName:'/private/student/upload.pdf'});
  assert.equal(proposal.candidates.length,2);assert.equal(proposal.unmatched.length,1);assert.match(proposal.unmatched[0].reason,/Shopping-cart/);
  assert.ok(proposal.candidates.every(row=>row.enrollmentStatus==='unknown'&&!row.enrollmentVerified));
  assert.deepEqual(proposal.defaultSelection,[]);assert.equal(proposal.requiresConfirmation,true);assert.equal(proposal.sourceName,'upload.pdf');
  assert.doesNotMatch(JSON.stringify(proposal),/Example Student|9999999|EMPLID|\/private\//);assert.equal(proposal.rawTextRetained,false);
});

test('class number and section must both agree; a nearest or first section is never selected',()=>{
  assert.equal(match('Fall 2026\nNBAY 5300-001 (99999)').candidates.length,0);
  assert.equal(match('Fall 2026\nNBAY 5300-999 (18400)').candidates.length,0);
  assert.equal(match('Fall 2026\nNBAY 5300').candidates.length,0);
  const catalog=snapshot();catalog.courses[0].sections.push({...catalog.courses[0].sections[0],id:'duplicate-section',classNumber:'18401'});
  const ambiguous=match('Fall 2026\nNBAY 5300-001',{snapshot:catalog});
  assert.equal(ambiguous.candidates.length,0);assert.match(ambiguous.unmatched[0].reason,/multiple sections/);
});

test('explicit dropped or waitlisted rows and conflicting duplicate statuses remain excluded',()=>{
  const result=match('Fall 2026\nNBAY 5300-001 (18400) Status: Dropped\nINFO 6410-030 (16714) Status: Wait Listed');
  assert.equal(result.candidates.length,0);assert.equal(result.unmatched.length,2);
  assert.equal(match('Fall 2026\nNBAY 5300-001 (18400) Status: Enrolled\nNBAY 5300-001 (18400) Status: Dropped').candidates.length,0);
});

test('term mismatch or mixed terms are rejected; unreadable term requires explicit review',()=>{
  assert.throws(()=>match('Spring 2027\nNBAY 5300-001 (18400)'),/SP27/);
  assert.throws(()=>match('Fall 2026\nSpring 2027\nNBAY 5300-001 (18400)'),/multiple academic terms/);
  const proposal=match('NBAY 5300-001 (18400)');assert.equal(proposal.detectedTerm,null);assert.ok(proposal.warnings.some(value=>value.includes('term could not be read')));
});

test('catalog block reasons, dates provenance, and stable row IDs survive review matching',()=>{
  const catalog=snapshot();catalog.courses[0].sections[0].importable=false;catalog.courses[0].sections[0].blockedReason='Special dates need review.';
  const proposal=match('Fall 2026\nNBAY 5300-001 (18400)',{snapshot:catalog});
  assert.equal(proposal.candidates[0].importable,false);assert.equal(proposal.candidates[0].blockedReason,'Special dates need review.');assert.equal(proposal.candidates[0].snapshotFetchedAt,catalog.snapshotFetchedAt);
  assert.equal(proposal.candidates[0].rowId,match('Fall 2026\nNBAY 5300-001 (18400)').candidates[0].rowId);
  assert.throws(()=>parseEnrollmentText('x'.repeat(ENROLLMENT_LIMITS.textCharacters+1)));
});

test('searchable PDFs use local text extraction, respect page limits, and return no raw document', {skip:!hasPoppler},async()=>{
  const catalog={get:async()=>snapshot()};
  const result=await analyzeEnrollment({buffer:textPDF(['My Fall 2026 Class Schedule','NBAY 5300-001 (18400)','INFO 6410-030 (16714)']),mimeType:'application/pdf',name:'synthetic.pdf',term:'FA26'},catalog);
  assert.equal(result.candidates.length,2);assert.match(result.method,/^(?:MarkItDown )?PDF text$/);assert.equal(result.rawTextRetained,false);
  await assert.rejects(analyzeEnrollment({buffer:textPDF(['NBAY 5300-001 (18400)'],7),mimeType:'application/pdf',term:'FA26'},catalog),/6 pages/);
});

test('real local photo OCR and scanned-PDF OCR match a synthetic schedule without external inference', {skip:!hasPoppler||process.env.RUN_ENROLLMENT_OCR_TESTS!=='1',timeout:180000},async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'brf-enrollment-fixture-'));
  try{
    const file=path.join(directory,'synthetic.pdf');await writeFile(file,textPDF(['My Fall 2026 Class Schedule','NBAY 5300-001 (18400)','INFO 6410-030 (16714)']),{mode:0o600});
    execFileSync('pdftoppm',['-singlefile','-scale-to-x','1200','-scale-to-y','1600','-png',file,path.join(directory,'photo')],{timeout:20000,stdio:'pipe'});
    const image=await readFile(path.join(directory,'photo.png'));
    const options={mimeType:'image/png',name:'Synthetic photo.png',term:'FA26'},catalog={get:async()=>snapshot()};
    const photo=await analyzeEnrollment({buffer:validateEnrollmentUpload({...options,base64:image.toString('base64')}),...options},catalog);
    assert.equal(photo.candidates.length,2);assert.match(photo.method,/local .* OCR/);assert.equal(photo.rawTextRetained,false);assert.deepEqual(photo.defaultSelection,[]);
    execFileSync('pdftoppm',['-singlefile','-scale-to-x','1200','-scale-to-y','1600','-jpeg',file,path.join(directory,'scan')],{timeout:20000,stdio:'pipe'});
    const jpeg=await readFile(path.join(directory,'scan.jpg'));
    validateEnrollmentUpload({base64:jpeg.toString('base64'),mimeType:'image/jpeg'});
    const content='q 612 0 0 792 0 0 cm /Im1 Do Q';
    const scanned=pdf(['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1200 /Height 1600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),jpeg,Buffer.from('\nendstream')]),`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
    const scan=await analyzeEnrollment({buffer:scanned,mimeType:'application/pdf',name:'Synthetic scan.pdf',term:'FA26'},catalog);
    assert.equal(scan.candidates.length,2);assert.match(scan.method,/OCR/);assert.equal(scan.rawTextRetained,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});


test('syllabus photos and searchable PDFs use local OCR/text extraction without requiring enrollment identifiers', {skip:!hasPoppler||spawnSync('tesseract',['--version'],{stdio:'ignore'}).status!==0},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'brb-syllabus-ocr-'));
 try {
  const buffer=textPDF(['Economics Fall 2026 Syllabus','Research deck due December 1, 2026 at 5 pm.','Include a market analysis and five slides.']);
  const pdfFile=path.join(directory,'synthetic.pdf');await writeFile(pdfFile,buffer);
  const text=await readLocalDocumentText({buffer,mimeType:'application/pdf',term:'FA26'});assert.match(text.text,/Research deck due December 1/);
  const prefix=path.join(directory,'photo');execFileSync('pdftoppm',['-singlefile','-scale-to','1600','-png',pdfFile,prefix],{timeout:20000});
  const image=await readFile(prefix+'.png'),recognized=await readLocalDocumentText({buffer:image,mimeType:'image/png',term:'FA26'});
  assert.match(recognized.method,/OCR/);assert.match(recognized.text,/December 1, 2026/);assert.ok(recognized.warnings.some(w=>w.includes('dates')));
 } finally {await rm(directory,{recursive:true,force:true});}
});

test('six searchable syllabus pages with small logos do not exhaust the scanned-page OCR limit',{skip:!hasPoppler},async()=>{
 const buffer=illustratedPDF({pages:6,lines:['Synthetic economics syllabus, Fall 2026','Research deck due December 1, 2026 at 5 pm.'],image:deflateSync(Buffer.alloc(100*100*3,80)),width:100,height:100});
 const result=await readLocalDocumentText({buffer,mimeType:'application/pdf',term:'FA26'});
 assert.match(result.method,/^(?:MarkItDown )?PDF text$/);assert.equal((result.text.match(/Research deck due December 1/g)||[]).length,6);
 assert.equal(result.warnings.filter(warning=>warning.includes('Small embedded illustrations')).length,6);
});

test('searchable syllabus headers do not hide deadlines inside a large scanned image',{skip:!hasPoppler||spawnSync('tesseract',['--version'],{stdio:'ignore'}).status!==0,timeout:60000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'brb-syllabus-hybrid-'));
 try{
  const source=path.join(directory,'deadline.pdf'),prefix=path.join(directory,'deadline-image');
  await writeFile(source,textPDF(['Research deck due December 1, 2026 at 5 pm.','Prepare five economics analysis slides.']));
  execFileSync('pdftoppm',['-singlefile','-scale-to-x','1200','-scale-to-y','1600','-jpeg',source,prefix],{timeout:20000});
  const image=await readFile(prefix+'.jpg'),buffer=illustratedPDF({lines:['Economics syllabus - Fall 2026 assignments and course policies'],image,width:1200,height:1600,filter:'DCTDecode',displayWidth:490,displayHeight:634});
  const result=await readLocalDocumentText({buffer,mimeType:'application/pdf',term:'FA26'});
  assert.match(result.method,/OCR/);assert.match(result.text,/December 1, 2026/);assert.match(result.text,/five economics analysis slides/i);
 }finally{await rm(directory,{recursive:true,force:true});}
});
