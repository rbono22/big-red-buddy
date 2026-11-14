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
  resolveMarkdown:async()=>null,
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

test('MarkItDown is the PDF reader while page order, mixed-page OCR and isolated execution stay intact',async()=>{
 const converted=['Selectable requirement page 1. Deadline December 1, 2026 at 5 pm.',native,''],fixture=synthetic({pages:3,images:[image(2),image(3)].join('\n'),run:async program=>program==='/synthetic/python'?{stdout:JSON.stringify({version:1,engine:'markitdown',packageVersion:'0.1.9',pages:converted})}:null});
 const result=await readLocalDocumentText(input,{...fixture.options,resolveMarkdown:async()=>'/synthetic/python'}),pages=result.text.split('\f');
 assert.equal(result.extractionMetrics.pdfParser,'markitdown');assert.equal(result.extractionMetrics.markitdownVersion,'0.1.9');assert.match(result.method,/MarkItDown PDF text/);assert.equal(pages.length,3);assert.match(pages[0],/page 1/);assert.match(pages[1],/exact searchable requirement/);assert.match(pages[1],/Research deck 2/);assert.match(pages[2],/Research deck 3/);
 assert.equal(fixture.calls.filter(call=>call.program==='pdftotext').length,0);assert.equal(fixture.calls.filter(call=>call.program==='pdfimages').length,1);
 const conversion=fixture.calls.find(call=>call.program==='/synthetic/python');assert.equal(conversion.args[0],'-I');assert.match(conversion.args[1],/scripts\/markitdown_extract\.py$/);assert.equal(conversion.args[3],'--pages');assert.equal(conversion.args[4],'3');assert.equal(conversion.settings.env.HOME,conversion.settings.env.TMPDIR);assert.equal(conversion.settings.killSignal,'SIGKILL');assert.ok(conversion.settings.timeout<=25000);assert.deepEqual(Object.keys(conversion.settings.env).filter(key=>/TOKEN|SECRET|PASSWORD|DATABASE|PYTHONPATH/.test(key)),[]);
});

test('failed, malformed, incomplete and oversized MarkItDown conversions fall back without leaking source errors',async()=>{
 for(const output of [null,'private text instead of JSON',JSON.stringify({version:1,engine:'markitdown',packageVersion:'0.1.9',pages:[]}),JSON.stringify({version:1,engine:'markitdown',packageVersion:'0.1.9',pages:['x'.repeat(200001)]})]){
  let directory;const fixture=synthetic({run:async(program,args,settings)=>{if(program!=='/synthetic/python')return;directory=settings.env.TMPDIR;if(output===null)throw new Error('PRIVATE_PDF_CONTENT');return {stdout:output};}});
  const result=await readLocalDocumentText(input,{...fixture.options,resolveMarkdown:async()=>'/synthetic/python'});
  assert.equal(result.text,native);assert.equal(result.extractionMetrics.pdfParser,'poppler');assert.equal(result.extractionMetrics.pdfParserFallback,'conversion_failed');assert.equal(fixture.calls.filter(call=>call.program==='pdftotext').length,1);assert.match(result.warnings[0],/fallback reader/);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PDF_CONTENT|private text instead/);await assert.rejects(access(directory),{code:'ENOENT'});
 }
});

test('a timed-out MarkItDown subprocess can recover through the bounded native reader',async()=>{
 const fixture=synthetic({run:async program=>{if(program==='/synthetic/python')throw Object.assign(new Error('PRIVATE_PATH'),{killed:true});}});
 const result=await readLocalDocumentText(input,{...fixture.options,resolveMarkdown:async()=>'/synthetic/python'});assert.equal(result.text,native);assert.equal(result.extractionMetrics.pdfParserFallback,'timeout');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PATH/);
});

test('PDF page count and encryption are checked before MarkItDown starts',async()=>{
 for(const info of ['Pages: 7\nEncrypted: no\n','Pages: 1\nEncrypted: yes\n']){
  const fixture=synthetic({run:async program=>program==='pdfinfo'?{stdout:info}:null});let resolverCalls=0;
  await assert.rejects(readLocalDocumentText(input,{...fixture.options,resolveMarkdown:async()=>{resolverCalls++;return '/synthetic/python';}}));assert.equal(resolverCalls,0);assert.equal(fixture.calls.length,1);
 }
});

test('photos remain real local OCR and never treat image metadata as document text',async()=>{
 const png=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(500,16);png.writeUInt32BE(500,20);
 const fixture=synthetic({recognize:async()=>native});
 const result=await readLocalDocumentText({buffer:png,mimeType:'image/png'},{...fixture.options,resolveMarkdown:()=>assert.fail('Photos must use local OCR rather than MarkItDown metadata')});assert.equal(result.text,native);assert.equal(result.extractionMetrics.ocrPages,1);assert.match(result.method,/local Tesseract OCR/);
});
