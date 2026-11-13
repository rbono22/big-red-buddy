// Public Tenna form capture + synthetic answers only. Every network request is intercepted.
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readLeverForm,submitLeverPage} from '../lib/lever-browser.mjs';
const url='https://jobs.lever.co/tenna/ed0a2111-ff61-40a8-aed9-23c1081d97dd/apply';
const markup=await readFile(new URL('../tests/fixtures/lever-tenna-application.html',import.meta.url),'utf8');
const browser=await chromium.launch({executablePath:process.env.APPLICATION_BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true});
let blocked=0,authorized=0;
try{
 const context=await browser.newContext({serviceWorkers:'block'});await context.routeWebSocket('**/*',socket=>socket.close());
 await context.route('**/*',route=>route.request().url()===url&&route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:markup}):(blocked++,route.abort()));
 async function fixture(mode='success'){
  const p=await context.newPage();p.setDefaultTimeout(1000);await p.goto(url);
  await p.evaluate(mode=>{
   window.submissions=0;
   document.querySelector('#application-form').insertAdjacentHTML('beforeend','<input type="hidden" id="selected-location" name="selectedLocation"><li class="application-question"><label class="application-label">Recruiting updates by SMS<input type="hidden" name="smsConsent" value="false"><input type="checkbox" name="smsConsent"></label></li><li class="application-question"><span class="application-label">Skills</span><label><input type="checkbox" name="skills" value="js">JavaScript</label><label><input type="checkbox" name="skills" value="sql">SQL</label></li><li class="application-question"><span class="application-label">Interests</span><select name="interests" multiple><option value="one">One</option><option value="two">Two</option></select></li>');
   document.querySelectorAll('.resume-upload-working,.resume-upload-success,.resume-upload-failure,.resume-upload-oversize,.dropdown-container').forEach(e=>e.style.display='none');
   const location=document.querySelector('input.location-input');location.addEventListener('keydown',()=>{document.querySelector('.dropdown-container').style.display='block';document.querySelector('.dropdown-results').innerHTML='<div class="dropdown-location">New York, New York, United States</div>';document.querySelector('.dropdown-location').onmousedown=()=>{location.value='New York, New York, United States';document.querySelector('#selected-location').value=JSON.stringify({name:location.value});document.querySelector('.dropdown-container').style.display='none';};});
   document.querySelector('input[name=resume]').onchange=e=>{
    document.querySelector('.resume .filename').textContent=e.target.files[0].name;document.querySelector('.resume-upload-working').style.display='block';
    setTimeout(()=>{if(mode==='autofill')document.querySelector('input[name=name]').value='Unreviewed autofill';if(mode==='optional-autofill')document.querySelector('input[name="urls[Other]"]').value='https://unreviewed.example';if(mode==='new-field')document.querySelector('#application-form').insertAdjacentHTML('beforeend','<li class="application-question"><label class="application-label">New required question<input required name="newQuestion"></label></li>');document.querySelector('.resume-upload-working').style.display='none';},20);
   };
   document.querySelector('#btn-submit').onclick=()=>{window.submissions++;if(mode==='captcha'){document.body.insertAdjacentHTML('beforeend','<iframe title="hCaptcha security challenge"></iframe>');return;}document.querySelector('#application-form').remove();if(mode==='success')document.body.insertAdjacentHTML('beforeend','<h2>Application submitted!</h2>');else document.body.insertAdjacentHTML('beforeend','<p>Application submitted is quoted in ordinary content, not a receipt.</p>');};
  },mode);
  return p;
 }
 const first=await fixture();const form=await readLeverForm(first);
 const answers=Object.fromEntries(form.fields.map(f=>[f.key,{reviewed:true,value:f.multiple?f.options.join('\n'):f.type==='file'?'Synthetic.pdf':f.type==='location'?'New York, New York, United States':f.type==='email'?'synthetic@example.edu':f.options.length?f.options.at(-1):f.required?'Synthetic answer':null}]));
 const resume={name:'Synthetic.pdf',file:Buffer.from('%PDF-1.7\nsynthetic fixture').toString('base64')};
 const input={url,form,answers,resume,receiptTimeout:200,beforeSubmit:async()=>{authorized++;}};
 const receipt=await submitLeverPage(first,input);assert.equal(receipt.confirmation,'Application submitted!');assert.equal(await first.evaluate(()=>window.submissions),1);assert.equal(authorized,1);await first.close();
 for(const [mode,error,clicks] of [['autofill','FIELD_CHANGED_AFTER_UPLOAD',0],['optional-autofill','FIELD_CHANGED_AFTER_UPLOAD',0],['new-field','FORM_CHANGED',0],['no-receipt','SUBMISSION_UNCONFIRMED',1],['captcha','HUMAN_VERIFICATION_REQUIRED',1]]){
  const p=await fixture(mode);await assert.rejects(submitLeverPage(p,input),new RegExp(error));assert.equal(await p.evaluate(()=>window.submissions),clicks);await p.close();
 }
 const changed=await fixture();await changed.locator('input[name=email]').evaluate(e=>e.closest('.application-question').querySelector('.application-label').textContent='Changed email question');await assert.rejects(submitLeverPage(changed,input),/FORM_CHANGED/);assert.equal(await changed.evaluate(()=>window.submissions),0);await changed.close();
 const denied=await fixture();await assert.rejects(submitLeverPage(denied,{...input,beforeSubmit:async()=>{throw Error('CANCELLED');}}),/CANCELLED/);assert.equal(await denied.evaluate(()=>window.submissions),0);await denied.close();
 const unknown=await fixture();const bad=structuredClone(answers);bad[form.fields.find(f=>f.type==='radio').key].value='Guessed answer';await assert.rejects(submitLeverPage(unknown,{...input,answers:bad}),/INVALID_CHOICE/);assert.equal(await unknown.evaluate(()=>window.submissions),0);await unknown.close();
 const unsigned=await fixture();const missing=structuredClone(answers);missing[form.fields.find(f=>f.type==='text').key].reviewed=false;await assert.rejects(submitLeverPage(unsigned,{...input,answers:missing}),/MISSING_ANSWER/);assert.equal(await unsigned.evaluate(()=>window.submissions),0);await unsigned.close();
 const coverLetter={name:'Cover Letter.pdf',file:Buffer.from('%PDF-1.7\ncover letter only').toString('base64')};
 async function coverFixture({replaceResume=false}={}){
  const p=await fixture();await p.evaluate(replaceResume=>{
   document.querySelector('#application-form').insertAdjacentHTML('beforeend','<li class="application-question"><label class="application-label">Cover letter<input name="coverLetter" type="file" accept=".pdf" required></label></li>');
   document.querySelector('[name=coverLetter]').onchange=()=>{if(replaceResume){const files=new DataTransfer();files.items.add(new File(['%PDF-1.7 unrequested'],'Unexpected.pdf',{type:'application/pdf'}));document.querySelector('[name=resume]').files=files.files;}};
  },replaceResume);return p;
 }
 const coverPage=await coverFixture(),coverForm=await readLeverForm(coverPage),coverField=coverForm.fields.find(f=>f.purpose==='coverLetter'),coverAnswers={...structuredClone(answers),[coverField.key]:{value:coverLetter.name,reviewed:true}};
 const coverInput={...input,form:coverForm,answers:coverAnswers,coverLetter};
 await submitLeverPage(coverPage,{...coverInput,beforeSubmit:async()=>{
  const files=await coverPage.evaluate(async()=>({resume:await document.querySelector('[name=resume]').files[0].text(),letter:await document.querySelector('[name=coverLetter]').files[0].text()}));
  assert.equal(files.resume,Buffer.from(resume.file,'base64').toString());assert.equal(files.letter,Buffer.from(coverLetter.file,'base64').toString());
 }});assert.equal(await coverPage.evaluate(()=>window.submissions),1);await coverPage.close();
 const missingCover=await coverFixture();await assert.rejects(submitLeverPage(missingCover,{...coverInput,coverLetter:undefined}),/INVALID_COVER_LETTER/);assert.equal(await missingCover.evaluate(()=>window.submissions),0);await missingCover.close();
 const changedFile=await coverFixture({replaceResume:true});await assert.rejects(submitLeverPage(changedFile,coverInput),/FIELD_CHANGED_AFTER_UPLOAD/);assert.equal(await changedFile.evaluate(()=>window.submissions),0);await changedFile.close();
 console.log(`Passed public form contract: 38 fields; PDF, selects, radios, exact location, consent; reviewed values rechecked; optional autofill blocked; changing forms/challenges refused; authorization boundary; one click; receipt required. All network intercepted (${blocked} blocked resource requests). No employer submissions.`);
}finally{await browser.close();}
