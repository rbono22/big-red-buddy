// Real Chrome and a real PDF, with synthetic applicant data only. Employer
// requests are fulfilled locally or blocked; no application is submitted.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {scanApplication} from '../scan.mjs';
import {fillApplication} from '../fill.mjs';
import {renderEnhancedResumePDF} from '../../lib/resume-enhancer-pdf.mjs';

const output='/private/tmp/brb-resume-tailoring-qa';
await mkdir(output,{recursive:true});
const source=`Alex Example
alex@example.edu | New York, NY

SUMMARY
Product and operations professional with experience in analytics and customer research.

EXPERIENCE
Example Company | Product Analyst | 2022 - 2025
- Built SQL dashboards for data visualization to measure customer retention.
- Interviewed 25 customers and presented product recommendations to the product team.
- Coordinated weekly project updates with engineering and sales teams.

EDUCATION
Example University | Master of Business Administration | 2027

SKILLS
SQL, customer research, data visualization, project coordination
`;
const rendered=await renderEnhancedResumePDF(source),bytes=Buffer.from(rendered.file,'base64');
const resume={name:'Resume_Example.pdf',mimeType:'application/pdf',file:rendered.file,sha256:createHash('sha256').update(bytes).digest('hex')};
await writeFile(`${output}/${resume.name}`,bytes);
const browser=await chromium.launch({headless:true,executablePath:process.env.APPLICATION_BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',chromiumSandbox:true});
const url='https://careers.example.org/apply/product-analyst',cases=[];
let employerWrites=0;
const existing=(name='Existing.pdf')=>({name,mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\nSynthetic existing applicant choice')});
async function fixture(name,run,{accept='.pdf'}={}){
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1200,height:850}});
 try{
  await context.routeWebSocket('**/*',socket=>socket.close());
  await context.route('**/*',route=>{
   const request=route.request();if(request.method()!=='GET')employerWrites++;
   return request.url()===url&&request.method()==='GET'?route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:`<!doctype html><html><head><title>Job application</title></head><body><h1>Product Analyst</h1><p class="company-name">Example</p><section class="job-description">Use SQL dashboards and data visualization to understand customer retention. Work with engineering and sales teams to turn customer research into clear product recommendations.</section><form><label>Full name<input id="name" required></label><label>Email<input id="email" type="email" required></label><label id="resume-label">Résumé<input id="resume" type="file" accept="${accept}"></label><button type="submit">Submit application</button></form></body></html>`}):route.abort();
  });
  const page=await context.newPage();await page.goto(url);
  await page.evaluate(()=>{window.__submissions=0;document.addEventListener('submit',event=>{window.__submissions++;event.preventDefault();},true);});
  const scan=async()=>{
   const scanned=await page.evaluate(scanApplication);assert.equal(scanned.ok,true,JSON.stringify(scanned));
   const answers={};for(const field of scanned.fields){if(field.label==='Full name')answers[field.key]={value:'Alex Example'};if(field.label==='Email')answers[field.key]={value:'alex@example.edu'};if(field.document==='resume')answers[field.key]={value:resume.name};}
   return {version:1,mode:'standalone',url,title:scanned.title,fields:scanned.fields,scanId:scanned.scanId,answers,documents:{resume},expiresAt:Date.now()+300000,resumeEnhancement:{id:'synthetic',fileName:resume.name,noChanges:false}};
  };
  await run(page,scan);assert.equal(await page.evaluate(()=>window.__submissions),0);cases.push(name);
 }finally{await context.close();}
}
try{
 await fixture('attaches a genuine company-named PDF and preserves typed answers',async(page,scan)=>{
  await page.locator('#name').fill('My preferred name');
  const result=await page.evaluate(fillApplication,await scan());assert.equal(result.ok,true);assert.equal(result.resumeEnhancement.attached,true);assert.equal(result.resumeEnhancement.fileName,resume.name);assert.equal(result.preserved,1);
  assert.equal(await page.locator('#name').inputValue(),'My preferred name');assert.equal(await page.locator('#email').inputValue(),'alex@example.edu');
  const attached=await page.locator('#resume').evaluate(async input=>{const file=input.files[0],digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());return {name:file.name,size:file.size,sha256:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('')};});
  assert.deepEqual(attached,{name:resume.name,size:bytes.length,sha256:resume.sha256});assert.match(await page.locator('#brb-application-helper').innerText(),/Resume_Example\.pdf attached/);
  await page.locator('#brb-application-helper').screenshot({path:`${output}/attached.png`});
 });
 await fixture('explicit tailoring replaces the file present when scanning',async(page,scan)=>{
  await page.locator('#resume').setInputFiles(existing());const payload=await scan(),result=await page.evaluate(fillApplication,payload);
  assert.equal(result.resumeEnhancement.attached,true);assert.equal(await page.locator('#resume').evaluate(input=>input.files[0].name),resume.name);
 });
 await fixture('ordinary autofill preserves an existing résumé',async(page,scan)=>{
  await page.locator('#resume').setInputFiles(existing());const payload=await scan();delete payload.resumeEnhancement;
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.preserved,1);assert.equal(await page.locator('#resume').evaluate(input=>input.files[0].name),'Existing.pdf');
 });
 await fixture('a file changed after scanning is never overwritten',async(page,scan)=>{
  await page.locator('#resume').setInputFiles(existing());const payload=await scan();await page.locator('#resume').setInputFiles(existing('New selection.pdf'));
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.resumeEnhancement.attached,false);assert.equal(await page.locator('#resume').evaluate(input=>input.files[0].name),'New selection.pdf');assert.ok(result.remaining>0);assert.doesNotMatch(await page.locator('#brb-application-helper').innerText(),/Resume_Example\.pdf attached/);
 });
 await fixture('docx-only uploads reject the PDF honestly',async(page,scan)=>{
  const result=await page.evaluate(fillApplication,await scan());assert.equal(result.resumeEnhancement.attached,false);assert.equal(await page.locator('#resume').evaluate(input=>input.files.length),0);assert.ok(result.skipped.some(item=>/different document format/.test(item.reason)));
 },{accept:'.docx'});
 await fixture('noChanges describes the current source PDF honestly',async(page,scan)=>{
  const payload=await scan();payload.resumeEnhancement.noChanges=true;const result=await page.evaluate(fillApplication,payload);
  assert.equal(result.resumeEnhancement.attached,true);assert.equal(result.resumeEnhancement.noChanges,true);const banner=await page.locator('#brb-application-helper').innerText();assert.match(banner,/No supported wording changes were needed/);assert.doesNotMatch(banner,/Tailored to this role/);
  await page.locator('#brb-application-helper').screenshot({path:`${output}/unchanged.png`});
 });
 await fixture('changed field metadata at the same URL prevents attachment',async(page,scan)=>{
  const payload=await scan();await page.locator('#resume').evaluate(input=>input.accept='.docx');
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.resumeEnhancement.attached,false);assert.equal(await page.locator('#resume').evaluate(input=>input.files.length),0);assert.ok(result.remaining>0);
 });
 await fixture('the employer discarding the file is not reported as attached',async(page,scan)=>{
  const payload=await scan();await page.locator('#resume').evaluate(input=>input.addEventListener('change',()=>setTimeout(()=>{input.value='';},50)));
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.resumeEnhancement.attached,false);assert.equal(await page.locator('#resume').evaluate(input=>input.files.length),0);assert.ok(result.skipped.some(item=>/Confirm the résumé upload/.test(item.reason)));
 });
 await fixture('corrupted PDF payload is rejected',async(page,scan)=>{
  const payload=await scan();payload.documents={resume:{...resume,sha256:'0'.repeat(64)}};const result=await page.evaluate(fillApplication,payload);
  assert.equal(result.resumeEnhancement.attached,false);assert.equal(await page.locator('#resume').evaluate(input=>input.files.length),0);assert.ok(result.skipped.some(item=>item.reason==='Document changed'));
 });
 await fixture('public job context excludes arbitrary page text and applicant values',async page=>{
  await page.evaluate(()=>{
   document.querySelector('#name').value='PRIVATE_APPLICANT';
   document.head.insertAdjacentHTML('beforeend','<style>.private-nested-content{display:none}</style>');
   document.querySelector('.job-description').insertAdjacentHTML('beforeend','<input value="PRIVATE_INPUT"><textarea>PRIVATE_TEXTAREA</textarea><div contenteditable>PRIVATE_EDITABLE</div><div hidden>PRIVATE_HIDDEN</div><div aria-hidden="true">PRIVATE_ARIA</div><div style="display:none">PRIVATE_INLINE_DISPLAY</div><div style="visibility:hidden">PRIVATE_INLINE_VISIBILITY</div><div class="private-nested-content">PRIVATE_CLASS_HIDDEN</div>');
   document.body.insertAdjacentHTML('beforeend','<p>PRIVATE_ARBITRARY_BODY</p>');
  });
  const scanned=await page.evaluate(scanApplication);assert.equal(scanned.ok,true);assert.equal(scanned.jobContext.company,'Example');assert.match(scanned.jobContext.description,/customer retention/);assert.doesNotMatch(JSON.stringify(scanned),/PRIVATE_/);
  await page.evaluate(()=>document.querySelector('.company-name').textContent='Another Company');
  assert.equal(await page.evaluate(()=>globalThis.__brbApplicationScan.readJobContext().company),'Another Company','the final context reader observes same-URL company changes');
 });
 await fixture('JobPosting metadata is parsed without exporting form or hidden text',async page=>{
  await page.evaluate(()=>{
   const script=document.createElement('script');script.type='application/ld+json';script.textContent=JSON.stringify({'@type':'JobPosting',title:'Research Analyst',hiringOrganization:{name:'Metadata Company'},description:'<p>Analyze customer research and data visualization to improve product decisions and communicate findings to engineering.</p><form><textarea>PRIVATE_JSON_FORM</textarea></form><p hidden>PRIVATE_JSON_HIDDEN</p><p style="display:none">PRIVATE_JSON_DISPLAY</p><p style="visibility:hidden">PRIVATE_JSON_VISIBILITY</p>'});document.head.append(script);
  });
  const scanned=await page.evaluate(scanApplication);assert.equal(scanned.ok,true);assert.equal(scanned.jobContext.company,'Metadata Company');assert.equal(scanned.jobContext.title,'Research Analyst');assert.match(scanned.jobContext.description,/Analyze customer research/);assert.doesNotMatch(JSON.stringify(scanned),/PRIVATE_/);
 });
 const popupContext=await browser.newContext({viewport:{width:380,height:600},serviceWorkers:'block'});
 try{
  const origin='https://brb-popup.example.org',files=new Map(await Promise.all(['popup.html','popup.css','popup.js'].map(async name=>[name,await readFile(new URL(`../${name}`,import.meta.url),'utf8')])));
  await popupContext.routeWebSocket('**/*',socket=>socket.close());
  await popupContext.route('**/*',route=>{
   const request=route.request();if(request.method()!=='GET')employerWrites++;
   const target=new URL(request.url()),name=target.pathname.slice(1),body=files.get(name);
   return target.origin===origin&&body&&request.method()==='GET'?route.fulfill({status:200,contentType:name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':'text/html',body}):route.abort();
  });
  await popupContext.addInitScript(()=>{window.chrome={runtime:{sendMessage:async message=>message.action==='getContext'?{context:'application',host:'careers.example.org'}:{ok:false,code:'JOB_CONTEXT_REQUIRED',error:'Add the role details to tailor your résumé.',jobContext:{title:'Product Analyst',company:'',description:''}}}};});
  const page=await popupContext.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`${origin}/popup.html`);await page.locator('#tailor:not([disabled])').waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),380);await page.screenshot({path:`${output}/popup.png`,fullPage:true});
  await page.locator('#tailor').click();await page.locator('#job-context:not([hidden])').waitFor();assert.equal(await page.locator('#job-title').inputValue(),'Product Analyst');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),380);assert.deepEqual(errors,[]);
  await page.screenshot({path:`${output}/popup-context.png`,fullPage:true});cases.push('popup and missing-context form fit a 380px extension panel');
 }finally{await popupContext.close();}
 assert.equal(employerWrites,0);const report={passed:cases.length,cases,employerWrites,submissions:0,pdf:`${output}/${resume.name}`,pdfBytes:bytes.length};
 await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
