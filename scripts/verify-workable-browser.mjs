// Offline browser checks only. Every network request is blocked; no employer data is sent.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {readWorkableForm,fillWorkableApplication,submitWorkablePage,workableFingerprint} from '../lib/workable-browser.mjs';
const html=await readFile(new URL('../tests/fixtures/workable-valsoft-form.html',import.meta.url),'utf8');
const url='https://apply.workable.com/valsoft-corp/j/4560CF5DD0/apply/';
const resume={name:'Synthetic-offline-resume.pdf',file:Buffer.from('%PDF-1.7\nOffline test only.').toString('base64')};
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true});
let checks=0;
async function sample(run){
 const context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',route=>route.request().url()===url&&route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:html}):route.request().url()==='https://workable-application-form.s3.us-east-1.amazonaws.com/offline-only'?route.fulfill({status:204,headers:{'access-control-allow-origin':'*'}}):route.abort());
 await context.routeWebSocket('**/*',socket=>socket.close());
 try{
  const page=await context.newPage();await page.goto(url);
  await page.evaluate(()=>{
   window.submits=0;
   for(const radio of document.querySelectorAll('[role="radio"]'))radio.addEventListener('click',()=>{radio.querySelector('input').checked=true;});
   document.querySelector('input[data-ui="resume"]').addEventListener('change',async e=>{
    const widget=e.target.closest('[data-role="dropzone"]'),span=document.createElement('span');span.dataset.id='filename';span.textContent=e.target.files[0].name;widget.append(span);
    const progress=document.createElement('div');progress.setAttribute('role','progressbar');widget.append(progress);
    const submit=document.querySelector('[data-ui="apply-button"]');submit.disabled=true;
    await fetch('https://workable-application-form.s3.us-east-1.amazonaws.com/offline-only',{method:'POST',body:'offline fixture; locally intercepted'});
    await new Promise(resolve=>setTimeout(resolve,window.delayAfterUpload||30));
    if(window.changeAfterUpload)document.querySelector('[name="firstname"]').value='Unreviewed change';
    if(window.redirectAfterUpload)history.pushState({},'',window.redirectAfterUpload);
    progress.remove();const view=document.createElement('a');view.dataset.action='view';view.href='https://workable-application-form.s3.us-east-1.amazonaws.com/offline-only';view.textContent='View';widget.append(view);
    const remove=document.createElement('button');remove.type='button';remove.dataset.action='delete';remove.textContent='Delete';widget.append(remove);e.target.required=false;
    submit.disabled=!!window.stayDisabled;window.uploadComplete=true;
   });
   document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submits++;if(window.showReceipt!==false){e.target.remove();const box=document.createElement('div');box.dataset.ui='successful-submit';const status=document.createElement('div');status.setAttribute('role','status');const h=document.createElement('h3');h.textContent='Your application has been submitted successfully.';status.append(h);box.append(status);document.body.append(box);if(window.receiptRedirect)history.pushState({},'',window.receiptRedirect);}});
  });
  const form=await readWorkableForm(page),answers=Object.fromEntries(form.fields.map(f=>[f.key,{reviewed:true,value:f.type==='file'?resume.name:f.type==='radio'?f.options[0]:f.type==='email'?'synthetic@example.test':f.type==='tel'?'+12125550100':f.key==='CA_29438'?'100000':'Synthetic answer'}]));
  await run(page,form,answers);checks++;
 }finally{await context.close();}
}
try{
 await sample(async(page,form,answers)=>{let calls=0;const result=await submitWorkablePage(page,{url,form,answers,resume,beforeSubmit:async()=>{assert.equal(await page.evaluate(()=>window.submits),0);assert.equal(await page.evaluate(()=>window.uploadComplete),true);calls++;}});assert.equal(calls,1);assert.equal(await page.evaluate(()=>window.submits),1);assert.match(result.confirmation,/submitted successfully/);});
 await sample(async(page,form,answers)=>{await page.locator('[data-ui="job-title"]').evaluate(e=>e.textContent='Changed employer job');let calls=0;await assert.rejects(submitWorkablePage(page,{url,form,answers,resume,beforeSubmit:async()=>calls++}),{code:'FORM_CHANGED'});assert.equal(calls,0);});
 await sample(async(page,form,answers)=>{await page.evaluate(()=>{window.changeAfterUpload=true;window.delayAfterUpload=300;});let calls=0;await assert.rejects(submitWorkablePage(page,{url,form,answers,resume,beforeSubmit:async()=>calls++}),{code:'FIELD_CHANGED_AFTER_UPLOAD'});assert.equal(calls,0);assert.equal(await page.evaluate(()=>window.submits),0);});
 await sample(async(page,form,answers)=>{await page.evaluate(()=>window.showReceipt=false);let calls=0;await assert.rejects(submitWorkablePage(page,{url,form,answers,resume,beforeSubmit:async()=>calls++,receiptTimeout:100}),{code:'SUBMISSION_UNCONFIRMED'});assert.equal(calls,1);assert.equal(await page.evaluate(()=>window.submits),1);});
 await sample(async(page,form,answers)=>{answers.firstname.reviewed=false;await assert.rejects(fillWorkableApplication(page,form,answers,resume),{code:'MISSING_ANSWER'});assert.equal(await page.locator('input[data-ui="resume"]').evaluate(e=>e.files.length),0);});
 await sample(async(page,form,answers)=>{answers.QA_12789818.value='invented';await assert.rejects(fillWorkableApplication(page,form,answers,resume),{code:'INVALID_CHOICE'});});
 await sample(async(page,form,answers)=>{await page.locator('[id^="turnstile-container-"]').evaluate(e=>{e.hidden=false;e.textContent='Human verification';});await assert.rejects(fillWorkableApplication(page,form,answers,resume),{code:'HUMAN_VERIFICATION_REQUIRED'});});
 await sample(async(page,form,answers)=>{await assert.rejects(submitWorkablePage(page,{url,form,answers,resume,beforeSubmit:async()=>{throw new Error('stale review');}}),/stale review/);assert.equal(await page.evaluate(()=>window.submits),0);});
 await sample(async(page,form)=>{assert.equal(workableFingerprint(await readWorkableForm(page)),workableFingerprint(form));});
 await sample(async(page,form,answers)=>{const f=form.fields.find(f=>f.type==='file');f.required=false;answers[f.key]={reviewed:true,value:null};await fillWorkableApplication(page,form,answers,resume);assert.equal(await page.locator('input[data-ui="resume"]').evaluate(e=>e.files.length),0);});
 await sample(async(page,form,answers)=>{await page.evaluate(()=>window.redirectAfterUpload='/valsoft-corp/j/0000000000/apply/');let calls=0;await assert.rejects(submitWorkablePage(page,{url,form,answers,resume,beforeSubmit:async()=>calls++}),{code:'APPLICATION_REDIRECTED'});assert.equal(calls,0);});
 await sample(async(page,form,answers)=>{await page.evaluate(()=>window.receiptRedirect='/valsoft-corp/j/0000000000/apply/');await assert.rejects(submitWorkablePage(page,{url,form,answers,resume,beforeSubmit:async()=>{}}),{code:'SUBMISSION_UNCONFIRMED'});});
 await sample(async(page,form,answers)=>{await page.evaluate(()=>window.stayDisabled=true);let calls=0;await assert.rejects(submitWorkablePage(page,{url,form,answers,resume,beforeSubmit:async()=>calls++}),{code:'FORM_NOT_READY'});assert.equal(calls,0);});
 console.log(`${checks} Workable offline browser checks passed; all external network requests blocked.`);
}finally{await browser.close();}
