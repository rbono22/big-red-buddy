import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createResumeLayoutInspector,inspectResumeLayout,RESUME_LAYOUT_LIMITS} from '../lib/resume-layout.mjs';

const input={name:'../../PRIVATE_NAME.pdf',text:'PRIVATE_RESUME_TEXT',file:Buffer.from('%PDF-1.4\nsynthetic').toString('base64')};
const XML=`<?xml version="1.0"?><!DOCTYPE pdf2xml SYSTEM "pdf2xml.dtd"><pdf2xml><page number="1" width="612" height="792"><fontspec id="0" size="12" family="ABCDEF+Calibri" color="#000000"/><text top="50.4" left="36" width="540" height="12" font="0">PRIVATE_TEXT</text><text top="100" left="72" width="200" height="12" font="0"><b>PRIVATE_SECOND_RUN</b></text></page></pdf2xml>`;
async function fixture(t,run){const dir=await mkdtemp(path.join(tmpdir(),'brf-layout-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,inspect:createResumeLayoutInspector({temporaryDirectory:dir,run})};}
function responseRun(xml=XML,pages=1){return async command=>({stdout:command==='pdfinfo'?`Title: PRIVATE_METADATA\nPages: ${pages}\n`:xml,stderr:''});}
function pdf(pages){
 const fontId=pages.length+3,streamStart=fontId+1,objects=['<< /Type /Catalog /Pages 2 0 R >>',`<< /Type /Pages /Kids [${pages.map((_,i)=>`${i+3} 0 R`).join(' ')}] /Count ${pages.length} >>`,...pages.map((p,i)=>`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.width||612} ${p.height||792}] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamStart+i} 0 R >>`),'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',...pages.map(p=>{const stream=p.blank?'':`BT /F1 ${p.size||12} Tf ${p.x||72} ${p.y||720} Td (SYNTHETIC TEXT ONLY) Tj ET`;return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;})];
 const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[0];let length=chunks[0].length;
 objects.forEach((object,i)=>{offsets.push(length);const bytes=Buffer.from(`${i+1} 0 obj\n${object}\nendobj\n`);chunks.push(bytes);length+=bytes.length;});
 chunks.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));return Buffer.concat(chunks);
}
const hasPoppler=['pdfinfo','pdftohtml'].every(command=>spawnSync(command,['-v'],{stdio:'ignore'}).status===0);

test('layout helper uses fixed local commands, private temporary files, bounded execution, and always removes raw files',async t=>{
 const calls=[];const f=await fixture(t,async(command,args,options)=>{
  calls.push(command);assert.ok(['pdfinfo','pdftohtml'].includes(command));assert.equal(options.shell,undefined);assert.equal(options.killSignal,'SIGKILL');assert.ok(options.timeout>0&&options.timeout<=8000);assert.ok(options.maxBuffer<=RESUME_LAYOUT_LIMITS.outputBytes);assert.equal((await stat(options.cwd)).mode&0o777,0o700);const file=args.at(-1);assert.equal(path.basename(file),'input.pdf');assert.equal((await stat(file)).mode&0o777,0o600);assert.deepEqual(await readFile(file),Buffer.from(input.file,'base64'));assert.equal(JSON.stringify(args).includes('PRIVATE_NAME'),false);
  if(command==='pdftohtml'){assert.ok(args.includes('-i'));assert.ok(args.includes('-stdout'));assert.equal(args[args.indexOf('-zoom')+1],'1');}
  return responseRun()(command);
 });
 const result=await f.inspect(input);assert.deepEqual(calls,['pdfinfo','pdftohtml']);assert.equal(result.status,'measured');assert.equal(result.pageCount,1);assert.deepEqual(result.pages,[{widthPt:612,heightPt:792,marginsPt:{left:36,right:36,top:50.4,bottom:680}}]);assert.deepEqual(result.fonts,[{family:'Calibri',sizePt:12,count:2}]);assert.match(result.limitations.join(' '),/not document margin settings/);assert.match(result.limitations.join(' '),/not a visual layout verdict/);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|input\.pdf|brf-layout-test/);assert.deepEqual(await readdir(f.dir),[]);
});

test('invalid, missing, and over-limit inputs return unavailable without invoking a process',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;throw new Error('should not run');});
 for(const value of [null,{text:'text-only'},{file:'not base64'},{file:'Zg==='},{file:Buffer.from('not a PDF').toString('base64')},{file:'A'.repeat(Math.ceil(RESUME_LAYOUT_LIMITS.bytes/3)*4+4)}]){const result=await f.inspect(value);assert.equal(result.status,'unavailable');assert.deepEqual(result.pages,[]);assert.deepEqual(result.fonts,[]);}
 assert.equal(calls,0);assert.deepEqual(await readdir(f.dir),[]);
});

test('missing tools, corrupt/encrypted PDFs, timeouts, and output overflow do not disclose tool output or leave raw files',async t=>{
 for(const error of [Object.assign(new Error('PRIVATE_TOOL_PATH_AND_TEXT'),{code:'ENOENT'}),Object.assign(new Error('PRIVATE_ENCRYPTED_DETAILS'),{code:1,stderr:'PRIVATE_STDERR'}),Object.assign(new Error('PRIVATE_TIMEOUT'),{killed:true}),Object.assign(new Error('PRIVATE_OVERFLOW'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'})]){
  const f=await fixture(t,async()=>{throw error;}),result=await f.inspect(input);assert.equal(result.status,'unavailable');assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);assert.deepEqual(await readdir(f.dir),[]);
 }
});

test('page/output/run limits and malformed dimensions fail safely before unbounded results',async t=>{
 let calls=0;const many=await fixture(t,async command=>{calls++;return responseRun(XML,21)(command);});const tooMany=await many.inspect(input);assert.equal(tooMany.status,'unavailable');assert.equal(tooMany.pageCount,21);assert.equal(calls,1);
 for(const xml of ['not xml',XML.replace('width="612"','width="NaN"'),XML.replace('number="1"','number="2"'),XML.replace('</pdf2xml>','<page number="2" width="612" height="792"></page></pdf2xml>'),'x'.repeat(RESUME_LAYOUT_LIMITS.outputBytes+1),`<pdf2xml><page number="1" width="612" height="792">${'<text top="1" left="1" width="1" height="1">x</text>'.repeat(RESUME_LAYOUT_LIMITS.textRuns+1)}</page></pdf2xml>`]){const f=await fixture(t,responseRun(xml));assert.equal((await f.inspect(input)).status,'unavailable');assert.deepEqual(await readdir(f.dir),[]);}
});

test('blank/scanned pages and out-of-page text are disclosed without invented margins',async t=>{
 const blank=await fixture(t,responseRun('<pdf2xml><page number="1" width="612" height="792"></page></pdf2xml>'));const empty=await blank.inspect(input);assert.equal(empty.status,'unavailable');assert.equal(empty.pageCount,1);assert.match(empty.limitations.join(' '),/does not perform OCR/);
 const mixed=await fixture(t,responseRun(XML.replace('left="36"','left="-4"').replace('</pdf2xml>','<page number="2" width="612" height="792"></page></pdf2xml>'),2));const result=await mixed.inspect(input);assert.equal(result.status,'measured');assert.equal(result.pages[0].marginsPt.left,0);assert.deepEqual(result.pages[1].marginsPt,{left:null,right:null,top:null,bottom:null});assert.match(result.limitations.join(' '),/clamped at zero/);assert.match(result.limitations.join(' '),/1 page\(s\) had no measurable text/);
});

test('real Poppler reports synthetic page dimensions and approximate text positions/font sizes without private text',{skip:!hasPoppler},async()=>{
 const file=pdf([{x:72,y:720,size:12},{width:595,height:842,x:36,y:750,size:10}]).toString('base64'),result=await inspectResumeLayout({file,name:'synthetic.pdf'});
 assert.equal(result.status,'measured');assert.equal(result.pageCount,2);assert.equal(result.pages[0].widthPt,612);assert.equal(result.pages[0].heightPt,792);assert.equal(result.pages[0].marginsPt.left,72);assert.ok(result.pages[0].marginsPt.top>=55&&result.pages[0].marginsPt.top<=75);assert.equal(result.pages[1].widthPt,595);assert.equal(result.pages[1].heightPt,842);assert.equal(result.pages[1].marginsPt.left,36);assert.ok(result.fonts.some(font=>font.family.includes('Helvetica')&&font.sizePt===12));assert.ok(result.fonts.some(font=>font.sizePt===10));assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC TEXT/);
 const scanned=await inspectResumeLayout({file:pdf([{blank:true}]).toString('base64')});assert.equal(scanned.status,'unavailable');assert.equal(scanned.pageCount,1);
});
