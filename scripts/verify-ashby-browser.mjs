// Offline contract check against public Ramp form markup captured 2026-11-12.
// No employer requests, private student data, or external submissions.
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readAshbyForm,submitAshbyPage} from '../lib/ashby-browser.mjs';
const markup=await readFile(new URL('../tests/fixtures/ramp-application-fields.html',import.meta.url),'utf8');
const form=JSON.parse(await readFile(new URL('../tests/fixtures/ramp-application-form.json',import.meta.url),'utf8'));
const browser=await chromium.launch({executablePath:process.env.APPLICATION_BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
let network=0;
try{
 const context=await browser.newContext();await context.route('**/*',route=>{network++;return route.abort();});
 async function page(mode='success'){
  const p=await context.newPage();p.setDefaultTimeout(1500);
  await p.setContent('<h1>Product Manager | Bill Pay</h1><div id="fields">'+markup+'</div><button id="submit">Submit Application</button>');
  await p.evaluate(mode=>{
   window.submissions=0;window.mode=mode;
   const input=document.querySelector('[role=combobox]');input.addEventListener('input',()=>{document.querySelectorAll('[role=option]').forEach(e=>e.remove());const option=document.createElement('div');option.setAttribute('role','option');option.textContent='New York City, New York, United States';option.onclick=()=>{input.value=option.textContent;option.remove();};document.body.append(option);});
   document.querySelectorAll('[data-option]').forEach(button=>{button.type='button';button.onclick=()=>{button.parentElement.querySelectorAll('[data-option]').forEach(b=>b.setAttribute('aria-pressed','false'));button.setAttribute('aria-pressed','true');};});
   document.querySelector('[data-field-path="_systemfield_resume"] input').addEventListener('change',event=>{const span=document.createElement('span');span.textContent=event.target.files[0].name;event.target.parentElement.append(span);if(mode==='autofill')document.querySelector('[data-field-path="_systemfield_name"] input').value='Changed by autofill';if(mode==='optional-autofill')document.querySelector('[data-field-path="64157536-a836-4d08-be51-ee4ec8cb3fb6"] textarea').value='Unrequested resume summary';});
   document.getElementById('submit').onclick=()=>{window.submissions++;window.saved=[...document.querySelectorAll('input,textarea')].map(e=>({value:e.value,checked:e.checked}));document.getElementById('fields').remove();document.getElementById('submit').remove();if(mode==='success'){const h=document.createElement('h2');h.textContent='Application submitted!';document.body.append(h);}else{const p=document.createElement('p');p.textContent='Application submitted is a phrase in the job description, not a receipt.';document.body.append(p);}};
  },mode);return p;
 }
 const answers=Object.fromEntries(form.fields.map(f=>[f.key,{reviewed:true,value:f.type==='file'?'Synthetic.pdf':f.type==='location'?'New York City, New York, United States':f.type==='email'?'synthetic@example.edu':f.type==='tel'?'+12125551234':f.options.length?f.options.at(-1):'Synthetic answer'}]));
 const resume={name:'Synthetic.pdf',file:Buffer.from('%PDF-1.7\nsynthetic fixture').toString('base64')};let authorized=0;
 const input={url:'https://jobs.ashbyhq.com/ramp/a84ae1e2-8c88-4e05-9cb6-fa3e11b55aeb/application',form,answers,resume,receiptTimeout:250,beforeSubmit:async()=>{authorized++;}};
 const success=await page();assert.deepEqual(await readAshbyForm(success),form);const receipt=await submitAshbyPage(success,input);assert.equal(receipt.confirmation,'Application submitted!');assert.equal(await success.evaluate(()=>window.submissions),1);assert.equal(authorized,1);await success.close();
 const changed=await page();await changed.locator('[data-field-path="_systemfield_email"] input').evaluate(e=>e.removeAttribute('required'));await changed.locator('[data-field-path="_systemfield_email"] .ashby-application-form-question-title').evaluate(e=>e.textContent='Changed email question');await assert.rejects(submitAshbyPage(changed,input),/FORM_CHANGED/);assert.equal(await changed.evaluate(()=>window.submissions),0);await changed.close();
 const altered=await page('autofill');await assert.rejects(submitAshbyPage(altered,input),/FIELD_CHANGED_AFTER_UPLOAD/);assert.equal(await altered.evaluate(()=>window.submissions),0);await altered.close();
 const optionalKey='64157536-a836-4d08-be51-ee4ec8cb3fb6',omittedAnswers={...answers,[optionalKey]:{reviewed:true,value:null}};
 const emptyOptional=await page();await emptyOptional.locator(`[data-field-path="${optionalKey}"] textarea`).fill('Unrequested initial default');
 const cleared=await submitAshbyPage(emptyOptional,{...input,answers:omittedAnswers});assert.equal(cleared.confirmation,'Application submitted!');assert.equal(await emptyOptional.evaluate(()=>window.saved.some(answer=>answer.value==='Unrequested initial default')),false);await emptyOptional.close();
 const changedOptional=await page('optional-autofill'),beforeOptional=authorized;await assert.rejects(submitAshbyPage(changedOptional,{...input,answers:omittedAnswers}),/FIELD_CHANGED_AFTER_UPLOAD/);assert.equal(await changedOptional.evaluate(()=>window.submissions),0);assert.equal(authorized,beforeOptional);await changedOptional.close();
 for(const kind of ['radio','yesno','location']){
  const defaults=await page();
  await defaults.evaluate(kind=>{
   const box=document.createElement('div');box.setAttribute('data-field-path','optional_default');
   box.innerHTML='<label class="ashby-application-form-question-title">Optional additional answer</label>'+(kind==='radio'?'<div class="ashby-application-form-input-radio-group"><label><input type="radio" name="optional_default" checked>Yes</label><label><input type="radio" name="optional_default">No</label></div>':kind==='yesno'?'<div class="ashby-application-form-input-yesno"><button aria-pressed="true">Yes</button><button aria-pressed="false">No</button><input type="checkbox" checked></div>':'<input role="combobox" value="Unrequested location">');
   document.getElementById('fields').append(box);
  },kind);
  const optionalForm=await readAshbyForm(defaults),before=authorized;
  await assert.rejects(submitAshbyPage(defaults,{...input,form:optionalForm,answers:{...answers,optional_default:{reviewed:true,value:null}}}),/UNREVIEWED_DEFAULT/);
  assert.equal(await defaults.evaluate(()=>window.submissions),0);assert.equal(authorized,before);await defaults.close();
 }
 const uncertain=await page('no-receipt');await assert.rejects(submitAshbyPage(uncertain,input),/SUBMISSION_UNCONFIRMED/);assert.equal(await uncertain.evaluate(()=>window.submissions),1);await uncertain.close();
 assert.equal(network,0);console.log('Passed: actual field parsing, all input types, PDF upload, success receipt, changed-form refusal, required and optional autofill rechecks, omitted text clearing, refusal of omitted radio/yesno/location defaults, missing receipt. Zero external requests.');
}finally{await browser.close();}
