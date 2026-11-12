import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,chmod,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const execute=promisify(execFile);
export const RESUME_LAYOUT_LIMITS=Object.freeze({bytes:12*1024*1024,pages:20,outputBytes:3*1024*1024,infoBytes:128*1024,textRuns:20000,fonts:100,timeoutMs:12000});
const ESTIMATE='Measurements are estimates from extracted PDF text boxes in points (72 points = 1 inch), not a visual layout verdict.';
const LIMITATIONS=[ESTIMATE,'Margins describe the outermost extracted text, not document margin settings; images, shapes, hidden text, and OCR errors can change the visible layout.','Font counts are extracted text runs, not character counts. Font names may be embedded PDF names, and sizes are approximate.','These measurements do not establish reading order, column quality, overlaps, clipping, visual balance, or accessibility.'];
const unavailable=(reason,pageCount=null)=>({status:'unavailable',pageCount,pages:[],fonts:[],limitations:[reason,ESTIMATE]});
const round=value=>Math.round(value*10)/10;
const attributes=tag=>Object.fromEntries([...tag.matchAll(/([A-Za-z][A-Za-z0-9_-]*)="([^"]*)"/g)].map(match=>[match[1],match[2]]));
function xmlText(value){return String(value).replace(/<[^>]*>/g,'').replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:[0-9]+|x[0-9a-f]+);/gi,entity=>{const named={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '};if(named[entity.toLowerCase()]!==undefined)return named[entity.toLowerCase()];const number=entity[2].toLowerCase()==='x'?parseInt(entity.slice(3,-1),16):Number(entity.slice(2,-1));return number>0&&number<=0x10ffff&&! (number>=0xd800&&number<=0xdfff)?String.fromCodePoint(number):'';});}
function pdfBytes(resume){
 const encoded=resume?.file,maxEncoded=Math.ceil(RESUME_LAYOUT_LIMITS.bytes/3)*4;
 if(typeof encoded!=='string'||!encoded.length)return {error:'The original PDF is not available. Text-only review can still proceed.'};
 if(encoded.length>maxEncoded)return {error:'PDF layout inspection supports files no larger than 12 MB.'};
 if(encoded.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))return {error:'The stored PDF encoding is invalid. Text-only review can still proceed.'};
 const bytes=Buffer.from(encoded,'base64');
 if(bytes.length>RESUME_LAYOUT_LIMITS.bytes||bytes.toString('base64')!==encoded||!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))return {error:'The stored file is not a supported PDF. Text-only review can still proceed.'};
 return {bytes};
}
function measurements(xml,pageCount){
 if(typeof xml!=='string'||Buffer.byteLength(xml)>RESUME_LAYOUT_LIMITS.outputBytes||!/<pdf2xml(?:\s|>)/.test(xml))return unavailable('Local PDF layout output was missing, invalid, or exceeded its size limit.',pageCount);
 const pageBlocks=[...xml.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/g)];
 if(pageBlocks.length!==pageCount)return unavailable('Not every PDF page could be measured reliably.',pageCount);
 const fontsById=new Map(),fontCounts=new Map(),pages=[],limitations=[...LIMITATIONS];let runs=0,measurable=0,blank=0,clipped=false,missingFonts=false;
 for(const [index,block] of pageBlocks.entries()){
  const meta=attributes(block[1]),width=Number(meta.width),height=Number(meta.height);
  if(Number(meta.number)!==index+1||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||width>14400||height>14400)return unavailable('PDF page dimensions could not be measured reliably.',pageCount);
  for(const font of block[2].matchAll(/<fontspec\b([^>]*)\/?\s*>/g)){
   const attrs=attributes(font[1]),size=Number(attrs.size),family=xmlText(attrs.family||'').replace(/^[A-Z]{6}\+/,'').replace(/[^\p{L}\p{N}\s.,_()+#-]/gu,'').trim().slice(0,96);
   if(attrs.id&&family&&Number.isFinite(size)&&size>0&&size<=300)fontsById.set(attrs.id,{family,sizePt:round(size)});
   if(fontsById.size>RESUME_LAYOUT_LIMITS.fonts)return unavailable('PDF layout exceeds the supported font limit.',pageCount);
  }
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
  for(const match of block[2].matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)){
   if(++runs>RESUME_LAYOUT_LIMITS.textRuns)return unavailable('PDF layout exceeds the supported text-run limit.',pageCount);
   if(!xmlText(match[2]).trim())continue;
   const attrs=attributes(match[1]),x=Number(attrs.left),y=Number(attrs.top),w=Number(attrs.width),h=Number(attrs.height);
   if(![x,y,w,h].every(Number.isFinite)||w<=0||h<=0||w>14400||h>14400)continue;
   if(x<0||y<0||x+w>width||y+h>height)clipped=true;
   left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+w);bottom=Math.max(bottom,y+h);measurable++;
   const font=fontsById.get(attrs.font);if(font){const key=`${font.family}\0${font.sizePt}`,entry=fontCounts.get(key)||{...font,count:0};entry.count++;fontCounts.set(key,entry);if(fontCounts.size>RESUME_LAYOUT_LIMITS.fonts)return unavailable('PDF layout exceeds the supported font limit.',pageCount);}else missingFonts=true;
  }
  const marginsPt=left===Infinity?{left:null,right:null,top:null,bottom:null}:{left:round(Math.max(0,Math.min(width,left))),right:round(Math.max(0,Math.min(width,width-right))),top:round(Math.max(0,Math.min(height,top))),bottom:round(Math.max(0,Math.min(height,height-bottom)))};
  if(left===Infinity)blank++;
  pages.push({widthPt:round(width),heightPt:round(height),marginsPt});
 }
 if(!measurable)return unavailable('No measurable searchable text was found. Scanned/image-only PDFs need visual review; this helper does not perform OCR.',pageCount);
 if(blank)limitations.push(`${blank} page(s) had no measurable text; their text margins are unavailable.`);
 if(clipped)limitations.push('Some extracted text boxes extend outside a page; reported margins are clamped at zero and require visual review.');
 if(missingFonts)limitations.push('Some text runs had no usable font metadata; the font list is incomplete.');
 return {status:'measured',pageCount,pages,fonts:[...fontCounts.values()].sort((a,b)=>b.count-a.count||a.family.localeCompare(b.family)||a.sizePt-b.sizePt),limitations};
}

/** Dependency injection is for local tests; input cannot select commands or paths. */
export function createResumeLayoutInspector({run=execute,temporaryDirectory=tmpdir()}={}){
 return async function inspectResumeLayout(resume){
  const decoded=pdfBytes(resume);if(decoded.error)return unavailable(decoded.error);
  let directory,result,pageCount=null;const started=performance.now();
  try{
   directory=await mkdtemp(path.join(temporaryDirectory,'brf-resume-layout-'));await chmod(directory,0o700);
   const file=path.join(directory,'input.pdf');await writeFile(file,decoded.bytes,{mode:0o600,flag:'wx'});
   const call=async(command,args,maxBuffer,perCallMs)=>{
    const remaining=RESUME_LAYOUT_LIMITS.timeoutMs-(performance.now()-started);if(remaining<=0)throw Object.assign(new Error('Layout processing limit'),{code:'ETIMEDOUT'});
    return run(command,args,{cwd:directory,encoding:'utf8',timeout:Math.max(1,Math.min(perCallMs,Math.floor(remaining))),maxBuffer,killSignal:'SIGKILL',windowsHide:true,env:{PATH:process.env.PATH||'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TMPDIR:directory}});
   };
   const info=await call('pdfinfo',[file],RESUME_LAYOUT_LIMITS.infoBytes,4000);
   if(typeof info.stdout!=='string'||Buffer.byteLength(info.stdout)>RESUME_LAYOUT_LIMITS.infoBytes)throw new Error('Invalid PDF information');
   const count=info.stdout.match(/^Pages:\s*(\d+)\s*$/m);pageCount=count?Number(count[1]):null;
   if(!Number.isSafeInteger(pageCount)||pageCount<1)result=unavailable('The PDF page count could not be determined. Text-only review can still proceed.');
   else if(pageCount>RESUME_LAYOUT_LIMITS.pages)result=unavailable('PDF layout inspection supports at most 20 pages.',pageCount);
   else{
    const converted=await call('pdftohtml',['-xml','-i','-stdout','-zoom','1','-noroundcoord','-fontfullname','-enc','UTF-8','-f','1','-l',String(pageCount),file],RESUME_LAYOUT_LIMITS.outputBytes,8000);
    result=measurements(converted.stdout,pageCount);
   }
  }catch(error){
   const reason=error?.code==='ENOENT'?'Local Poppler PDF tools are unavailable. Text-only review can still proceed.':error?.killed||['ETIMEDOUT','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(error?.code)?'Local PDF layout processing reached its time or output limit. Text-only review can still proceed.':'The PDF could not be measured locally; it may be damaged, encrypted, or unsupported. Text-only review can still proceed.';
   result=unavailable(reason,pageCount);
  }finally{
   decoded.bytes.fill(0);
   if(directory)try{await rm(directory,{recursive:true,force:true,maxRetries:2});}catch{result=unavailable('Temporary PDF cleanup failed; contact the operator. Text-only review can still proceed.',pageCount);}
  }
  return result;
 };
}
export const inspectResumeLayout=createResumeLayoutInspector();
