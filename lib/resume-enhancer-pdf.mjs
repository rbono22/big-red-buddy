import {existsSync} from 'node:fs';
import {HttpError} from './security.mjs';

const escapeHTML=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fail=()=>{throw new HttpError(422,'The tailored PDF could not be created. Your original résumé is unchanged. Try again.','RESUME_ENHANCEMENT_PDF_FAILED');};

/** Text-only, ATS-readable output. Neither source text nor generated text can load resources. */
export async function renderEnhancedResumePDF(text){
 if(typeof text!=='string'||text.trim().length<40||text.length>60000||/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text))fail();
 const executablePath=process.env.APPLICATION_BROWSER_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'');
 if(!executablePath||!existsSync(executablePath))fail();
 let browser,timer;
 try{
  const {chromium}=await import('playwright-core');
  browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:true,timeout:20000});
  timer=setTimeout(()=>void browser.close(),30000);
  const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false,javaScriptEnabled:false});
  await context.routeWebSocket('**/*',socket=>socket.close());await context.route('**/*',route=>route.abort());
  const page=await context.newPage();page.setDefaultTimeout(10000);await page.emulateMedia({media:'print'});
  const rows=text.replace(/\r\n?/g,'\n').split('\n');
  let first=true;
  const content=rows.map(line=>{
   if(!line.trim())return '<div class="space" aria-hidden="true"></div>';
   const name=first;first=false;
   const section=/^(?:professional |work |relevant |additional )?(?:experience|education|skills|projects|certifications|publications|summary|leadership|volunteering|interests|awards)\s*:?$/i.test(line.trim());
   const bullet=/^\s*[•●▪◦*\-–—]\s/.test(line);
   return `<div class="line${name?' name':section?' section':bullet?' bullet':''}">${escapeHTML(line)}</div>`;
  }).join('');
  await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline'"><title>Tailored résumé</title><style>@page{size:Letter;margin:.65in .7in}*{box-sizing:border-box}html,body{margin:0;padding:0;color:#151515;background:#fff}body{font-family:Arial,Helvetica,sans-serif;font-size:10.5pt;line-height:1.35}main{width:7.1in}.line{white-space:pre-wrap;overflow-wrap:anywhere;min-height:1.35em;break-inside:avoid}.name{font-size:18pt;font-weight:700;margin-bottom:6pt}.section{font-size:10.5pt;font-weight:700;letter-spacing:.04em;margin-top:9pt;margin-bottom:3pt;break-after:avoid}.bullet{padding-left:10pt;text-indent:-10pt;margin:2pt 0}.space{height:5pt}</style></head><body><main>${content}</main></body></html>`,{waitUntil:'load'});
  const height=await page.locator('main').evaluate(e=>e.getBoundingClientRect().height);
  if(!Number.isFinite(height)||height>9.7*96*10)fail();
  const buffer=await page.pdf({format:'Letter',preferCSSPageSize:true,printBackground:false,tagged:true});
  if(!buffer.subarray(0,5).equals(Buffer.from('%PDF-'))||buffer.length>4*1024*1024)fail();
  return {name:'Tailored Resume.pdf',file:buffer.toString('base64')};
 }catch{fail();}finally{clearTimeout(timer);await browser?.close().catch(()=>{});}
}
