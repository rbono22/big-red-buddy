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
 async function page(mode='success',{cover=false}={}){
  const p=await context.newPage();p.setDefaultTimeout(1500);
  await p.setContent('<h1>Product Manager | Bill Pay</h1><div id="fields">'+markup+'</div><button id="submit">Submit Application</button>');
  await p.evaluate(({mode,cover})=>{
   if(cover){const field=document.createElement('div');field.dataset.fieldPath='cover_document';field.innerHTML='<label class="ashby-application-form-question-title">Cover letter</label><input type="file" required accept="application/pdf">';document.getElementById('fields').append(field);}
   window.submissions=0;window.mode=mode;
   const input=document.querySelector('[role=combobox]');input.addEventListener('input',()=>{document.querySelectorAll('[role=option]').forEach(e=>e.remove());const option=document.createElement('div');option.setAttribute('role','option');option.textContent='New York City, New York, United States';option.onclick=()=>{input.value=option.textContent;option.remove();};document.body.append(option);});
   document.querySelectorAll('[data-option]').forEach(button=>{button.type='button';button.onclick=()=>{button.parentElement.querySelectorAll('[data-option]').forEach(b=>b.setAttribute('aria-pressed','false'));button.setAttribute('aria-pressed','true');};});
   for(const input of document.querySelectorAll('input[type=file]'))input.addEventListener('change',event=>{const span=document.createElement('span');span.textContent=event.target.files[0].name;event.target.parentElement.append(span);if(mode==='autofill')document.querySelector('[data-field-path="_systemfield_name"] input').value='Changed by autofill';if(mode==='optional-autofill')document.querySelector('[data-field-path="64157536-a836-4d08-be51-ee4ec8cb3fb6"] textarea').value='Unrequested resume summary';});
   document.getElementById('submit').onclick=()=>{window.submissions++;window.saved=[...document.querySelectorAll('input,textarea')].map(e=>({value:e.value,checked:e.checked}));document.getElementById('fields').remove();document.getElementById('submit').remove();if(mode==='success'){const h=document.createElement('h2');h.textContent='Application submitted!';document.body.append(h);}else{const p=document.createElement('p');p.textContent='Application submitted is a phrase in the job description, not a receipt.';document.body.append(p);}};
  },{mode,cover});return p;
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
 const coverLetter={name:'Cover Letter.pdf',file:Buffer.from('%PDF-1.7\nCover fixture; distinct from resume.').toString('base64')};
 const withCover=await page('success',{cover:true}),coverForm=await readAshbyForm(withCover),coverAnswers={...answers,cover_document:{value:coverLetter.name,reviewed:true}};
 const coverReceipt=await submitAshbyPage(withCover,{...input,form:coverForm,answers:coverAnswers,coverLetter,beforeSubmit:async()=>{const files=await withCover.locator('input[type=file]').evaluateAll(async inputs=>Promise.all(inputs.map(async e=>({name:e.files[0].name,text:await e.files[0].text()}))));assert.equal(files.length,2);assert.equal(files[0].text,Buffer.from(resume.file,'base64').toString());assert.equal(files[1].text,Buffer.from(coverLetter.file,'base64').toString());}});assert.equal(coverReceipt.confirmation,'Application submitted!');await withCover.close();
 const missingCover=await page('success',{cover:true});await assert.rejects(submitAshbyPage(missingCover,{...input,form:await readAshbyForm(missingCover),answers:coverAnswers}));assert.equal(await missingCover.locator('input[type=file]').evaluateAll(inputs=>inputs.reduce((sum,e)=>sum+e.files.length,0)),0);assert.equal(await missingCover.evaluate(()=>window.submissions),0);await missingCover.close();

 // Checkbox groups ("select all that apply"), markup mirrors Ashby's checkbox-group fieldset.
 const group=(key,label,options,{required=false,checked=[]}={})=>`<div data-field-path="${key}"><fieldset class="ashby-application-form-input-checkbox-group"><label class="ashby-application-form-question-title${required?' _required_x':''}" for="${key}">${label}</label>${options.map((o,i)=>`<div class="ashby-application-form-input-checkbox-group-option"><span><input type="checkbox" id="${key}-labeled-checkbox-${i}" name="${o}"${checked.includes(o)?' checked':''}></span><label for="${key}-labeled-checkbox-${i}">${o}</label></div>`).join('')}</fieldset></div>`;
 async function groupPage(extra){const p=await page();await p.evaluate(html=>document.getElementById('fields').insertAdjacentHTML('beforeend',html),extra);return p;}
 const heardKey='heard-about',heardOptions=['LinkedIn','Glassdoor','Company Blog'];
 const groupHTML=group(heardKey,'How did you hear about this opportunity? (select all that apply)',heardOptions,{required:true})+group('optional-communities','Which communities do you belong to?',['Group A','Group B']);
 const withGroups=await groupPage(groupHTML),groupForm=await readAshbyForm(withGroups);
 const heard=groupForm.fields.find(f=>f.key===heardKey),optionalGroup=groupForm.fields.find(f=>f.key==='optional-communities');
 assert.deepEqual({type:heard.type,multiple:heard.multiple,required:heard.required,options:heard.options},{type:'checkbox',multiple:true,required:true,options:heardOptions});assert.equal(optionalGroup.required,false);
 const groupAnswers={...answers,[heardKey]:{reviewed:true,value:'LinkedIn\nCompany Blog'},'optional-communities':{reviewed:true,value:null}},groupInput={...input,form:groupForm,answers:groupAnswers};
 const groupReceipt=await submitAshbyPage(withGroups,{...groupInput,beforeSubmit:async()=>{assert.deepEqual(await withGroups.locator(`[data-field-path="${heardKey}"] input[type=checkbox]`).evaluateAll(es=>es.map(e=>e.checked)),[true,false,true]);assert.deepEqual(await withGroups.locator('[data-field-path="optional-communities"] input').evaluateAll(es=>es.map(e=>e.checked)),[false,false]);}});
 assert.equal(groupReceipt.confirmation,'Application submitted!');await withGroups.close();
 const badChoice=await groupPage(groupHTML);await assert.rejects(submitAshbyPage(badChoice,{...groupInput,answers:{...groupAnswers,[heardKey]:{reviewed:true,value:'Twitter'}}}),/INVALID_CHOICE/);assert.equal(await badChoice.evaluate(()=>window.submissions),0);await badChoice.close();
 const preChecked=await groupPage(group(heardKey,'How did you hear about this opportunity? (select all that apply)',heardOptions,{required:true})+group('optional-communities','Which communities do you belong to?',['Group A','Group B'],{checked:['Group B']}));
 await assert.rejects(submitAshbyPage(preChecked,groupInput),/UNREVIEWED_DEFAULT/);assert.equal(await preChecked.evaluate(()=>window.submissions),0);await preChecked.close();
 const unchecked=await groupPage(groupHTML);await unchecked.evaluate(key=>{for(const input of document.querySelectorAll('input[type=file]'))input.addEventListener('change',()=>{document.querySelector(`[data-field-path="${key}"] input`).checked=false;});},heardKey);
 await assert.rejects(submitAshbyPage(unchecked,groupInput),/FIELD_CHANGED_AFTER_UPLOAD/);assert.equal(await unchecked.evaluate(()=>window.submissions),0);await unchecked.close();
 const changedGroup=await groupPage(groupHTML);await changedGroup.locator(`label[for="${heardKey}-labeled-checkbox-2"]`).evaluate(e=>e.textContent='Podcast');await assert.rejects(submitAshbyPage(changedGroup,groupInput),/FORM_CHANGED/);assert.equal(await changedGroup.evaluate(()=>window.submissions),0);await changedGroup.close();
 const strayBox=await groupPage(groupHTML.replace('</fieldset>','<input type="checkbox" id="stray"></fieldset>'));await assert.rejects(readAshbyForm(strayBox),/UNSUPPORTED_FORM/);await strayBox.close();
 assert.equal(network,0);console.log('Passed: actual field parsing, all input types, PDF upload, success receipt, changed-form refusal, required and optional autofill rechecks, omitted text clearing, refusal of omitted radio/yesno/location defaults, checkbox groups (fill, recheck, omitted-optional default refusal, changed form, stray control), missing receipt. Zero external requests.');
}finally{await browser.close();}
