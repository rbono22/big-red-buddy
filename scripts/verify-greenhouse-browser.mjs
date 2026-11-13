// Synthetic offline browser contract. No personal data or employer requests.
import {chromium} from 'playwright-core';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readGreenhouseForm,submitGreenhousePage} from '../lib/greenhouse-browser.mjs';
const markup=await readFile(new URL('../tests/fixtures/greenhouse-synthetic-application.html',import.meta.url),'utf8');
const browser=await chromium.launch({executablePath:process.env.APPLICATION_BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,chromiumSandbox:true});
let requests=0;
try{
 const context=await browser.newContext({serviceWorkers:'block'});await context.route('**/*',route=>{requests++;return route.abort();});
 async function makePage(mode='success'){
  const page=await context.newPage();page.setDefaultTimeout(2000);
  await page.route('https://job-boards.greenhouse.io/example/jobs/123',route=>route.fulfill({contentType:'text/html',body:markup}));
  await page.goto('https://job-boards.greenhouse.io/example/jobs/123');
  await page.evaluate(mode=>{
   window.submissions=0;window.mode=mode;
   const options={country:['United States +1','Canada +1'],'candidate-location':['New York, New York, United States'],work_auth:['Yes','No'],identity:['Choice A','Choice B','Prefer not to answer']};
   for(const input of document.querySelectorAll('[role=combobox]')){
    const close=()=>{document.querySelectorAll('[role=option]').forEach(e=>e.remove());input.setAttribute('aria-expanded','false');};
    const open=()=>{close();input.setAttribute('aria-expanded','true');for(const label of options[input.id]){const option=document.createElement('div');option.setAttribute('role','option');option.className='select__option';option.textContent=label;if(input.id==="country"){const flag=document.createElement("i");flag.className="iti__flag iti__"+(label.startsWith("Canada")?"ca":"us");option.prepend(flag);}option.onclick=()=>{const container=input.closest('.select__value-container'),multi=container.classList.contains('select__value-container--is-multi');if(!multi)container.querySelectorAll('.select__single-value').forEach(e=>e.remove());const selected=document.createElement('span');selected.className=multi?'select__multi-value__label':'select__single-value';selected.textContent=label;if(input.id==="country"){selected.textContent="+1";const flag=document.createElement("i");flag.className="iti__flag iti__"+(label.startsWith("Canada")?"ca":"us");selected.prepend(flag);}container.prepend(selected);input.value='';close();};document.body.append(option);}};
    input.addEventListener('click',open);input.addEventListener('input',open);input.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
   }
   document.getElementById('resume').addEventListener('change',e=>{const span=document.createElement('span');span.textContent=e.target.files[0].name;e.target.parentElement.append(span);if(mode==='autofill')document.getElementById('first_name').value='Unexpected autofill';if(mode==='async-autofill'||mode==='async-conditional'){const submit=document.querySelector('button[type=submit]');submit.setAttribute('aria-disabled','true');const progress=document.createElement('div');progress.setAttribute('role','progressbar');progress.textContent='Processing';e.target.parentElement.append(progress);setTimeout(()=>{if(mode==='async-autofill')document.getElementById('first_name').value='Late autofill';else{const label=document.createElement('label');label.htmlFor='late_field';label.textContent='Late conditional question';const input=document.createElement('input');input.id='late_field';document.getElementById('application-form').append(label,input);}progress.remove();submit.setAttribute('aria-disabled','false');},150);}if(mode==='conditional'){const label=document.createElement('label');label.htmlFor='new_question';label.textContent='A new conditional question';const input=document.createElement('input');input.id='new_question';document.getElementById('application-form').append(label,input);}});
   document.querySelector('button[type=submit]').onclick=e=>{e.preventDefault();window.submissions++;if(mode==='keep-form')return;document.getElementById('application-form').remove();const heading=document.createElement(mode==='body-text'?'p':'h2');heading.textContent=mode==='no-receipt'?'Unexpected error':'Application submitted!';document.body.append(heading);if(mode==='redirect-receipt')history.replaceState({},'', '/another-employer/jobs/999');};
   if(mode==='captcha'){const iframe=document.createElement('iframe');iframe.title='reCAPTCHA challenge';document.body.append(iframe);}
  },mode);return page;
 }
 const success=await makePage(),form=await readGreenhouseForm(success);
 const answers=Object.fromEntries(form.fields.map(f=>[f.key,{reviewed:true,value:f.key==='identity'?'Choice A\nChoice B':f.key==='email'?'synthetic@example.org':f.type==='location'?'New York, New York, United States':f.type==='file'?'Synthetic.pdf':f.type==='tel'?'+12125551234':f.options[0]||'Synthetic answer'}]));
 let authorized=0;const input={url:'https://job-boards.greenhouse.io/example/jobs/123',form,answers,resume:{name:'Synthetic.pdf',file:Buffer.from('%PDF-1.7\nfixture').toString('base64')},beforeSubmit:async()=>{authorized++;},receiptTimeout:150};
 const receipt=await submitGreenhousePage(success,input);assert.equal(receipt.confirmation,'Application submitted!');assert.equal(await success.evaluate(()=>window.submissions),1);assert.equal(authorized,1);await success.close();
 for(const [mode,error]of [['autofill','FIELD_CHANGED_AFTER_UPLOAD'],['async-autofill','FIELD_CHANGED_AFTER_UPLOAD'],['async-conditional','FORM_CHANGED'],['conditional','FORM_CHANGED'],['captcha','HUMAN_VERIFICATION_REQUIRED']]){const page=await makePage(mode);await assert.rejects(submitGreenhousePage(page,input),new RegExp(error));assert.equal(await page.evaluate(()=>window.submissions),0);await page.close();}
 for(const mode of ['no-receipt','body-text','keep-form','redirect-receipt']){const page=await makePage(mode);await assert.rejects(submitGreenhousePage(page,input),/SUBMISSION_UNCONFIRMED/);assert.equal(await page.evaluate(()=>window.submissions),1);await page.close();}
 const redirected=await makePage();await redirected.evaluate(()=>history.replaceState({},'','/another-employer/jobs/999'));await assert.rejects(submitGreenhousePage(redirected,input),/APPLICATION_REDIRECTED/);assert.equal(await redirected.evaluate(()=>window.submissions),0);await redirected.close();
 const denied=await makePage();await assert.rejects(submitGreenhousePage(denied,{...input,beforeSubmit:async()=>{throw Error('Authorization revoked');}}),/Authorization revoked/);assert.equal(await denied.evaluate(()=>window.submissions),0);await denied.close();
 const changed=await makePage();await changed.locator('label[for=first_name]').evaluate(e=>e.textContent='Changed question');await assert.rejects(submitGreenhousePage(changed,input),/FORM_CHANGED/);assert.equal(await changed.evaluate(()=>window.submissions),0);await changed.close();
 const skipped=await makePage(),skipAnswers=structuredClone(answers);for(const f of form.fields)if(!f.required)skipAnswers[f.key].value=null;await submitGreenhousePage(skipped,{...input,answers:skipAnswers});assert.equal(await skipped.evaluate(()=>window.submissions),1);await skipped.close();
 // A required cover letter may have only a PDF widget. Keep its bytes separate
 // from the resume and detect a later widget changing the earlier attachment.
 const coverLetter={name:'Cover Letter.pdf',file:Buffer.from('%PDF-1.7\ncover letter only').toString('base64')};
 async function coverFixture({replaceResume=false}={}){
  const page=await makePage();await page.evaluate(replaceResume=>{
   document.querySelector('label[for=cover_letter_text]').remove();document.querySelector('#cover_letter_text').remove();
   document.querySelector('#application-form').insertAdjacentHTML('beforeend','<div class="file-upload" aria-labelledby="upload-label-cover" aria-required="true"><div id="upload-label-cover">Cover Letter*</div><input id="cover_letter" type="file" accept=".pdf" required></div>');
   document.querySelector('#cover_letter').onchange=e=>{const span=document.createElement('span');span.textContent=e.target.files[0].name;e.target.parentElement.append(span);if(replaceResume){const files=new DataTransfer();files.items.add(new File(['%PDF-1.7 wrong attachment'],'Unexpected.pdf',{type:'application/pdf'}));document.querySelector('#resume').files=files.files;}};
  },replaceResume);return page;
 }
 const letterPage=await coverFixture(),letterForm=await readGreenhouseForm(letterPage),letterAnswers={...structuredClone(answers),cover_letter:{value:coverLetter.name,reviewed:true}};delete letterAnswers.cover_letter_text;
 const letterInput={...input,form:letterForm,answers:letterAnswers,coverLetter};
 await submitGreenhousePage(letterPage,{...letterInput,beforeSubmit:async()=>{
  const files=await letterPage.evaluate(async()=>({resume:await document.querySelector('#resume').files[0].text(),letter:await document.querySelector('#cover_letter').files[0].text()}));
  assert.equal(files.resume,Buffer.from(input.resume.file,'base64').toString());assert.equal(files.letter,Buffer.from(coverLetter.file,'base64').toString());
 }});assert.equal(await letterPage.evaluate(()=>window.submissions),1);await letterPage.close();
 const missingLetter=await coverFixture();await assert.rejects(submitGreenhousePage(missingLetter,{...letterInput,coverLetter:undefined}),/INVALID_COVER_LETTER/);assert.equal(await missingLetter.evaluate(()=>window.submissions),0);await missingLetter.close();
 const changedResume=await coverFixture({replaceResume:true});await assert.rejects(submitGreenhousePage(changedResume,letterInput),/FIELD_CHANGED_AFTER_UPLOAD/);assert.equal(await changedResume.evaluate(()=>window.submissions),0);await changedResume.close();

 // Embeddable form with multi-answer questions: grouped checkboxes and an async
 // multi-select, both using question_N[] ids, plus an optional checkbox group.
 const embedURL='https://job-boards.greenhouse.io/embed/job_app?for=example&token=123';
 const multiMarkup=await readFile(new URL('../tests/fixtures/greenhouse-synthetic-embed-multi.html',import.meta.url),'utf8');
 async function multiPage(mode='success'){
  const page=await context.newPage();page.setDefaultTimeout(2000);
  await page.route(embedURL,route=>route.fulfill({contentType:'text/html',body:multiMarkup}));
  await page.goto(embedURL);
  await page.evaluate(mode=>{
   window.submissions=0;
   const input=document.getElementById('question_200[]'),close=()=>{document.querySelectorAll('[role=option]').forEach(e=>e.remove());input.setAttribute('aria-expanded','false');};
   // Options load asynchronously after the menu opens, like Greenhouse's react-select.
   const open=()=>{close();input.setAttribute('aria-expanded','true');setTimeout(()=>{for(const label of ['New York','Boston','Denver']){const option=document.createElement('div');option.setAttribute('role','option');option.textContent=label;option.onclick=()=>{const selected=document.createElement('span');selected.className='select__multi-value__label';selected.textContent=label;input.closest('.select__value-container').prepend(selected);input.value='';close();};document.body.append(option);}},150);};
   input.addEventListener('click',open);input.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
   if(mode==='preselected')document.getElementById('question_300[]_2').checked=true;
   document.getElementById('resume').addEventListener('change',e=>{const span=document.createElement('span');span.textContent=e.target.files[0].name;e.target.parentElement.append(span);if(mode==='uncheck-after-upload')document.getElementById('question_100[]_2').checked=false;});
   document.querySelector('button[type=submit]').onclick=e=>{e.preventDefault();window.submissions++;document.getElementById('application-form').remove();const heading=document.createElement('h2');heading.textContent='Thank you for applying!';document.body.append(heading);};
  },mode);return page;
 }
 const multi=await multiPage(),multiForm=await readGreenhouseForm(multi);
 assert.equal(multiForm.title,'Example Strategist');
 const countries=multiForm.fields.find(f=>f.key==='question_100[]'),cities=multiForm.fields.find(f=>f.key==='question_200[]'),groups=multiForm.fields.find(f=>f.key==='question_300[]');
 assert.deepEqual({type:countries.type,multiple:countries.multiple,required:countries.required,label:countries.label,options:countries.options},{type:'checkbox',multiple:true,required:true,label:'Which countries could you work in?',options:['United States','Canada','Ireland']});
 assert.deepEqual({widget:cities.widget,multiple:cities.multiple,options:cities.options},{widget:'combobox',multiple:true,options:['New York','Boston','Denver']});
 assert.equal(groups.required,false);assert.equal(multiForm.fields.length,6,'each checkbox group is one field');
 const multiAnswers={first_name:{reviewed:true,value:'Synthetic'},email:{reviewed:true,value:'synthetic@example.org'},_systemfield_resume:{reviewed:true,value:'Synthetic.pdf'},'question_100[]':{reviewed:true,value:'United States\nCanada'},'question_200[]':{reviewed:true,value:'New York\nDenver'},'question_300[]':{reviewed:true,value:null}};
 const multiInput={...input,url:embedURL,form:multiForm,answers:multiAnswers};
 await submitGreenhousePage(multi,{...multiInput,beforeSubmit:async()=>{
  assert.deepEqual(await multi.evaluate(()=>[...document.querySelectorAll('input[name="question_100[]"]')].map(e=>e.checked)),[true,true,false]);
  assert.deepEqual(await multi.evaluate(()=>[...document.querySelectorAll('.select__multi-value__label')].map(e=>e.textContent).sort()),['Denver','New York']);
 }});assert.equal(await multi.evaluate(()=>window.submissions),1);await multi.close();
 for(const [mode,answerPatch,error] of [['success',{'question_100[]':{reviewed:true,value:'Germany'}},'INVALID_CHOICE'],['preselected',{},'FIELD_CHANGED_AFTER_UPLOAD'],['uncheck-after-upload',{},'FIELD_CHANGED_AFTER_UPLOAD']]){
  const page=await multiPage(mode);await assert.rejects(submitGreenhousePage(page,{...multiInput,answers:{...multiAnswers,...answerPatch}}),new RegExp(error));assert.equal(await page.evaluate(()=>window.submissions),0);await page.close();
 }
 const multiChanged=await multiPage();await multiChanged.evaluate(()=>document.querySelector('label[for="question_100[]_3"]').textContent='Mexico');await assert.rejects(submitGreenhousePage(multiChanged,multiInput),/FORM_CHANGED/);assert.equal(await multiChanged.evaluate(()=>window.submissions),0);await multiChanged.close();
 assert.equal(requests,0);console.log('Passed Greenhouse browser contract: all controls, multiple choices, embed form with grouped checkboxes and async multi-select ([] ids), exact location, PDF upload, optional skips, consent, receipt, changed form, autofill, conditional fields, CAPTCHA, revoked authorization, one final click. Zero external requests.');
}finally{await browser.close();}
