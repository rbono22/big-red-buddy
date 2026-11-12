import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {readLocalDocumentText,analyzeEnrollment,ENROLLMENT_LIMITS} from '../lib/enrollment.mjs';

const buffer=Buffer.from('%PDF-1.4\nSynthetic document only\n%%EOF');
const input={buffer,mimeType:'application/pdf',term:'FA26'};
const native='Synthetic economics syllabus, Fall 2026. Keep this exact searchable requirement.';
const image=(page,{small=false}={})=>`${page} 0 image ${small?'100 100':'1200 1600'} rgb 3 8 jpeg no 4 0 ${small?'200 200':'150 150'} 36K 0.6%`;
function synthetic({pages=1,text=Array.from({length:pages},()=>native).join('\f'),images='',recognize=async page=>`Research deck ${page} due December 1, 2026 at 5 pm.`,engine='tesseract',run}={}){
 const calls=[],metrics={engineLookups:0,active:0,peak:0},options={
  resolveOCR:async()=>{metrics.engineLookups++;return{kind:engine,program:`/synthetic/${engine}`};},
  runCommand:async(program,args,settings)=>{
   calls.push({program,args,settings});
   if(run){const value=await run(program,args,settings);if(value)return value;}
   if(program==='pdfinfo')return{stdout:`Pages: ${pages}\nEncrypted: no\n`};
   if(program==='pdftotext')return{stdout:text};
   if(program==='pdfimages')return{stdout:images};
   if(program==='pdftoppm')return{stdout:''};
   if(program.startsWith('/synthetic/')){
    metrics.active++;metrics.peak=Math.max(metrics.active,metrics.peak);
    try{const page=Number(args.find(arg=>/page-\d+\.png$/.test(arg))?.match(/page-(\d+)\.png$/)[1]||1),result=await recognize(page,settings);return{stdout:engine==='vision'?JSON.stringify({lines:[{text:result}]}):result};}
    finally{metrics.active--;}
   }
   throw new Error('Unexpected synthetic command.');
  }
 };
 return{calls,metrics,options};
}

test('searchable illustrated PDF inspects images once and launches no OCR processes',async()=>{
 const fixture=synthetic({pages:6,images:Array.from({length:6},(_,i)=>image(i+1,{small:true})).join('\n')});
 const result=await readLocalDocumentText(input,fixture.options);
 assert.equal(fixture.calls.filter(call=>call.program==='pdfimages').length,1);
 assert.equal(fixture.metrics.engineLookups,0);assert.equal(fixture.calls.length,3);
 assert.equal(result.extractionMetrics.processes,3);assert.equal(result.extractionMetrics.ocrPages,0);
 assert.equal(result.text.split('\f').length,6);assert.equal(result.warnings.length,6);
 assert.ok(!Object.hasOwn(result.extractionMetrics,'text'));
});

test('mixed PDF preserves page order and searchable requirements while scanning only the necessary pages',async()=>{
 const fixture=synthetic({pages:4,text:[native,native,native,''].join('\f'),images:[image(2),image(3,{small:true}),image(4)].join('\n'),recognize:async page=>{await delay(page===2?15:1);return`Scanned requirement from page ${page}.`}});
 const result=await readLocalDocumentText(input,fixture.options),pages=result.text.split('\f');
 assert.equal(fixture.metrics.engineLookups,1);assert.equal(fixture.metrics.peak,2);
 assert.deepEqual(fixture.calls.filter(call=>call.program==='pdftoppm').map(call=>call.args[1]),['2','4']);
 assert.match(pages[1],/exact searchable requirement/);assert.match(pages[1],/page 2/);
 assert.doesNotMatch(pages[0],/Scanned/);assert.doesNotMatch(pages[2],/Scanned/);assert.match(pages[3],/page 4/);
 assert.equal(result.extractionMetrics.ocrPages,2);assert.equal(result.extractionMetrics.ocrConcurrency,2);
 assert.equal(result.warnings.filter(w=>w.startsWith('OCR can')).length,1);
});

test('OCR concurrency is bounded and one-thread Tesseract never inherits application secrets',async()=>{
 const fixture=synthetic({pages:4,text:'\f\f\f',images:[1,2,3,4].map(page=>image(page)).join('\n'),recognize:async page=>{await delay(8);return`Page ${page} deadline is December 1, 2026 at 5 pm.`;}});
 await readLocalDocumentText(input,fixture.options);
 assert.equal(fixture.metrics.peak,ENROLLMENT_LIMITS.ocrConcurrency);assert.equal(fixture.metrics.engineLookups,1);
 for(const call of fixture.calls.filter(call=>call.program==='/synthetic/tesseract')){
  assert.equal(call.settings.env.OMP_THREAD_LIMIT,'1');assert.equal(call.settings.killSignal,'SIGKILL');
  assert.equal(call.settings.signal.aborted,false);assert.ok(call.settings.timeout>0&&call.settings.timeout<=30000);
  assert.deepEqual(Object.keys(call.settings.env).filter(key=>/TOKEN|SECRET|PASSWORD|DATABASE/.test(key)),[]);
 }
});

test('Vision OCR remains sequential so compiler cache work is not raced',async()=>{
 const fixture=synthetic({pages:3,text:'\f\f',images:[1,2,3].map(page=>image(page)).join('\n'),engine:'vision',recognize:async page=>{await delay(4);return`Page ${page} deadline December 1, 2026.`;}});
 const result=await readLocalDocumentText(input,fixture.options);
 assert.equal(fixture.metrics.peak,1);assert.equal(result.extractionMetrics.ocrConcurrency,1);assert.equal(fixture.metrics.engineLookups,1);
});

test('scanned-page limits are enforced before OCR or image rendering starts',async()=>{
 const fixture=synthetic({pages:5,text:'\f\f\f\f'});
 await assert.rejects(readLocalDocumentText(input,fixture.options),/at most 4 scanned pages/);
 assert.equal(fixture.calls.filter(call=>call.program==='pdftoppm').length,0);
 assert.equal(fixture.metrics.engineLookups,0);
});

test('a failed OCR lane aborts and joins other lanes before removing temporary files',async()=>{
 let directory,siblingSettled=false;
 const fixture=synthetic({pages:4,text:'\f\f\f',recognize:async(page,settings)=>{
  directory=settings.env.TMPDIR;
  if(page===1){await delay(8);throw new Error('PRIVATE_SOURCE_FAILURE');}
  assert.equal(page,2,'no new page may begin after the first failure');
  await new Promise(resolve=>settings.signal.addEventListener('abort',resolve,{once:true}));
  await delay(10);await access(directory);siblingSettled=true;
  throw Object.assign(new Error('cancelled'),{code:'ABORT_ERR'});
 }});
 await assert.rejects(readLocalDocumentText(input,fixture.options),error=>error.code==='enrollment_processing_failed'&&!error.message.includes('PRIVATE_SOURCE_FAILURE'));
 assert.equal(siblingSettled,true);assert.equal(fixture.metrics.active,0);
 assert.equal(fixture.calls.filter(call=>call.program==='pdftoppm').length,2);
 await assert.rejects(access(directory),error=>error.code==='ENOENT');
});

test('a searchable course code does not suppress OCR for additional schedule rows in an embedded scan',async()=>{
 const snapshot={term:'FA26',courses:[{id:'one',code:'NBAY 5300',subject:'NBAY',catalogNumber:'5300',sections:[{id:'001',section:'001',classNumber:'18400',component:'LEC',importable:true}]},{id:'two',code:'INFO 6410',subject:'INFO',catalogNumber:'6410',sections:[{id:'030',section:'030',classNumber:'16714',component:'LEC',importable:true}]}]};
 const fixture=synthetic({text:'Fall 2026\nNBAY 5300-001 (18400)',images:image(1),recognize:async()=> 'INFO 6410-030 (16714)'});
 const result=await analyzeEnrollment(input,{get:async()=>snapshot},fixture.options);
 assert.equal(result.candidates.length,2);assert.equal(result.extractionMetrics.ocrPages,1);
 assert.equal(result.rawTextRetained,false);assert.deepEqual(result.defaultSelection,[]);
});

test('oversized combined text and timed-out native tools fail safely and clean up',async()=>{
 const fixture=synthetic({text:'',recognize:async()=> 'x'.repeat(ENROLLMENT_LIMITS.textCharacters+1)});
 await assert.rejects(readLocalDocumentText(input,fixture.options),/No usable syllabus text/);
 let directory;
 const timed=synthetic({run:async(program,args,settings)=>{directory=settings.env.TMPDIR;if(program==='pdfinfo')throw Object.assign(new Error('private file details'),{killed:true});}});
 await assert.rejects(readLocalDocumentText(input,timed.options),error=>error.status===408&&error.code==='enrollment_timeout'&&!error.message.includes('private file'));
 await assert.rejects(access(directory),error=>error.code==='ENOENT');
});
