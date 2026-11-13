import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {isCoverLetterField,applicationDocument} from './application-documents.mjs';

// Initial verified employer. Further tenants require their public forms and upload hosts to be inspected.
export function workableApplicationURL(value){
 try{const u=new URL(value);if(u.protocol!=='https:'||u.hostname!=='apply.workable.com'||u.port||u.username||u.password||u.search||u.hash||!/^\/valsoft-corp\/j\/[A-F0-9]{10}(?:\/apply)?\/?$/.test(u.pathname))return '';return u.origin+u.pathname.replace(/\/$/,'').replace(/\/apply$/,'')+'/apply/';}catch{return '';}
}
export const workableApplicationSupported=job=>process.env.APPLICATION_BROWSER_ENABLED==='true'&&!!workableApplicationURL(job?.applyUrl||job?.url);
export const workableFingerprint=form=>createHash('sha256').update(JSON.stringify(form)).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code,retryable:false});};
const norm=value=>String(value||'').replace(/\s+/g,' ').trim();
const READ_HOSTS=['apply.workable.com','dcvxs6ggqztsa.cloudfront.net','workable-application-form.s3.amazonaws.com','workable-application-form.s3.us-east-1.amazonaws.com','workablehr.s3.amazonaws.com','challenges.cloudflare.com'];
export function allowedWorkableResource(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&READ_HOSTS.includes(u.hostname);}catch{return false;}}

export async function readWorkableForm(page){
 const form=await page.evaluate(()=>{
  const text=e=>(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const roots=document.querySelectorAll('form[data-ui="application-form"]');if(roots.length!==1)return null;
  const root=roots[0],fields=[],accounted=new Set(),invalid=[];
  const label=e=>{const ids=(e.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean);return (text(document.getElementById(ids[0]))||text(e.labels?.[0]||e.closest('label'))).replace(/^\*\s*/, '');};
  for(const group of root.querySelectorAll('fieldset[data-ui][role="radiogroup"]')){
   const inputs=[...group.querySelectorAll('input')];
   if(!inputs.length||inputs.some(e=>e.type!=='radio')){invalid.push('radio');continue;}
   const key=group.getAttribute('data-ui');
   if(inputs.some(e=>e.name!==key)){invalid.push('radio-name');continue;}
   inputs.forEach(e=>accounted.add(e));
   fields.push({key,label:label(group),type:'radio',required:inputs.some(e=>e.hasAttribute('required')||e.getAttribute('aria-required')==='true'),options:inputs.map(e=>text(e.labels?.[0]||e.closest('label')))});
  }
  for(const input of root.querySelectorAll('input,textarea,select')){
   if(accounted.has(input))continue;
   const key=input.getAttribute('data-ui')||input.name||input.id;
   if(input.type==='hidden'&&input.name==='cf-turnstile-response')continue;
   if(['city','postcode','country'].includes(key)&&input.getAttribute('aria-hidden')==='true'&&input.getAttribute('tabindex')==='-1'&&!input.hasAttribute('required')&&!input.value)continue;
   if(input.getAttribute('aria-hidden')==='true'||input.type==='hidden'||input.disabled){invalid.push('hidden-or-disabled');continue;}
   const type=input.tagName==='TEXTAREA'?'textarea':input.tagName==='SELECT'?'unsupported':input.type;
   if(input.getAttribute('role')||!['text','email','tel','textarea','file'].includes(type)){invalid.push('control');continue;}
   if(type==='file'&&(input.multiple||input.getAttribute('accept')&&!input.getAttribute('accept').split(',').some(value=>['.pdf','application/pdf','application/*','*/*'].includes(value.trim().toLowerCase())))){invalid.push('file');continue;}
   accounted.add(input);
   const profile={firstname:'firstName',lastname:'lastName',email:'email',phone:'phone',address:'location'}[key];
   const heading=document.getElementById((input.getAttribute('aria-labelledby')||'').split(/\s+/)[0]);
   const required=input.hasAttribute('required')||input.getAttribute('aria-required')==='true'||type==='file'&&/^\*/.test(text(heading?.parentElement?.parentElement));
   fields.push({key:type==='file'&&key==='resume'?'_systemfield_resume':key,label:label(input).replace(/\s*(Choose|Replace) file$/,''),type,required,options:[],...(Number(input.getAttribute('maxlength'))>0?{maxLength:Number(input.getAttribute('maxlength'))}:{}),...(profile?{profileField:profile}:{})});
  }
  // Groups with hidden editors must not silently disappear from the review.
  for(const block of root.querySelectorAll('[data-ui="section-fields"] > div')){
   if(!block.querySelector('input,textarea,select'))invalid.push('empty-editor');
  }
  if(root.querySelector('[contenteditable="true"],[role="combobox"],[role="checkbox"],[role="switch"],[role="slider"],[role="spinbutton"],input[readonly],textarea[readonly],select'))invalid.push('complex');
  for(const radio of root.querySelectorAll('[role="radio"]'))if(!radio.closest('fieldset[data-ui][role="radiogroup"]')||!radio.querySelector('input[type="radio"]'))invalid.push('custom-radio');
  for(const control of root.querySelectorAll('[role="button"]:not(button)')){
   if(control.matches('a[data-ui^="clear-section-"]'))continue;
   if(control.matches('label[for]')&&document.getElementById(control.getAttribute('for'))?.type==='file')continue;
   invalid.push('custom-button');
  }
  for(const button of root.querySelectorAll('button')){
   if(button.type==='submit'&&button.getAttribute('data-ui')==='apply-button')continue;
   if(button.closest('[data-ui="autofill-button"]')||button.classList.contains('iti__selected-country'))continue;
   if(button.getAttribute('data-action')==='delete'&&button.closest('[data-role="dropzone"]')?.querySelector('input[type="file"]'))continue;
   invalid.push('button');
  }
  const consent=[...document.querySelectorAll('[data-ui="footer-compliance-notice"],[data-ui="footer-gdpr"],[data-ui="footer-ccpa"]')].map(e=>text(e)+[...e.querySelectorAll('a[href]')].map(a=>' '+a.href).join('')).join('\n');
  // Sort by document order, independent of randomized DOM ids.
  const order=[...root.querySelectorAll('input,textarea,select')].map(e=>e.getAttribute('data-ui')||e.name||e.id);
  fields.sort((a,b)=>order.indexOf(a.key==='_systemfield_resume'?'resume':a.key)-order.indexOf(b.key==='_systemfield_resume'?'resume':b.key));
  return {title:text(document.querySelector('h1[data-ui="job-title"]')),fields,consentText:consent,invalid};
 });
 if(!form||form.invalid.length||!form.title||!form.fields.length||form.fields.length>35||new Set(form.fields.map(f=>f.key)).size!==form.fields.length||form.fields.some(f=>!/^[_a-zA-Z0-9-]{1,160}$/.test(f.key)||!f.label||f.label.length>1800||f.type==='file'&&f.key!=='_systemfield_resume'&&!isCoverLetterField(f)||f.options.length>8||new Set(f.options).size!==f.options.length||f.options.some(o=>!o||o.length>500)))fail('UNSUPPORTED_FORM');
 for(const field of form.fields)if(isCoverLetterField(field))field.purpose='coverLetter';
 delete form.invalid;return form;
}

async function assertNoChallenge(page){
 if(await page.locator('iframe[src*="challenges.cloudflare.com"],iframe[title*="challenge"],[id^="turnstile-container-"]').filter({visible:true}).count())fail('HUMAN_VERIFICATION_REQUIRED');
}
async function openApplication(value,run){
 const url=workableApplicationURL(value);if(!url)fail('UNSUPPORTED_EMPLOYER');
 const executablePath=process.env.APPLICATION_BROWSER_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'');
 if(!executablePath||!existsSync(executablePath))fail('BROWSER_NOT_CONFIGURED');
 const {chromium}=await import('playwright-core');
 const browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:true,timeout:20000}),timer=setTimeout(()=>void browser.close(),150000);
 try{
  const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
  await context.routeWebSocket('**/*',socket=>socket.close());
  await context.route('**/*',route=>allowedWorkableResource(route.request().url())?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(12000);
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
  if(workableApplicationURL(page.url())!==url)fail('APPLICATION_REDIRECTED');
  await page.locator('form[data-ui="application-form"] button[data-ui="apply-button"]').waitFor({timeout:25000});
  const declineCookies=page.locator('button[data-ui="cookie-consent-decline"]');
  if(await declineCookies.isVisible())await declineCookies.click();
  await assertNoChallenge(page);
  return await run(page);
 }finally{clearTimeout(timer);await browser.close();}
}
export async function inspectWorkableApplication(url){return openApplication(url,readWorkableForm);}
const fieldInput=(page,field)=>field.type==='file'?page.locator(`form[data-ui="application-form"] input[data-ui="${field.key==='_systemfield_resume'?'resume':field.key}"],form[data-ui="application-form"] input[name="${field.key==='_systemfield_resume'?'resume':field.key}"]`):page.locator(`form[data-ui="application-form"] [name="${field.key}"]`);
async function phoneValue(input){return input.evaluate(e=>{const raw=e.value;if(raw.trim().startsWith('+'))return raw.replace(/\D/g,'');return ((e.closest('.iti')?.querySelector('.iti__selected-dial-code')?.textContent||'')+raw).replace(/\D/g,'');});}

export async function fillWorkableApplication(page,form,answers,resume,coverLetter){
 const uploads=new Map();
 await assertNoChallenge(page);
 for(const field of form.fields){
  const answer=answers[field.key];if(!answer?.reviewed||answer.value!==null&&typeof answer.value!=='string')fail('MISSING_ANSWER');
  if(field.type==='file'){if(field.required&&!answer.value)fail('MISSING_ANSWER');if(answer.value===null){if(await fieldInput(page,field).evaluateAll(inputs=>inputs.some(input=>input.files?.length)))fail('UNREVIEWED_DEFAULT');}else{const document=applicationDocument(field,{resume,coverLetter});if(answer.value!==document.name)fail('INVALID_DOCUMENT');uploads.set(field.key,document);}continue;}
  const input=fieldInput(page,field);
  if(answer.value===null){if(field.required)fail('MISSING_ANSWER');if(field.type==='radio'){if(await input.evaluateAll(es=>es.some(e=>e.checked)))fail('FIELD_NOT_FILLED');}else await input.fill('');continue;}
  if(!answer.value.trim())fail('MISSING_ANSWER');
  if(field.maxLength&&answer.value.length>field.maxLength)fail('INVALID_ANSWER');
  if(field.type==='radio'){
   const index=field.options.indexOf(answer.value);if(index<0)fail('INVALID_CHOICE');
   const group=page.locator(`fieldset[data-ui="${field.key}"]`);await group.locator('[role="radio"]').nth(index).click();
   if(!await input.nth(index).isChecked())fail('FIELD_NOT_FILLED');
  }else{
   if(field.type==='tel'&&!/^\+[1-9][0-9 ()-]{6,24}$/.test(answer.value))fail('INVALID_PHONE');
   await input.fill(answer.value);await input.blur();
  }
 }
 for(const [key,document] of uploads){
  const field=form.fields.find(f=>f.key===key),input=fieldInput(page,field);
  const upload=page.waitForResponse(response=>{try{return new URL(response.url()).hostname==='workable-application-form.s3.us-east-1.amazonaws.com'&&response.request().method()==='POST'&&response.ok();}catch{return false;}},{timeout:25000}).then(()=>true,()=>false);
  await input.setInputFiles(document);
  if(!await upload)fail('UPLOAD_UNCONFIRMED');
  // Filenames appear before completion. Check the specific document's widget,
  // completed upload, and selected bytes before accepting either attachment.
  await page.waitForFunction(({key,name})=>{const nameKey=key==='_systemfield_resume'?'resume':key,input=document.querySelector(`input[data-ui="${nameKey}"],input[name="${nameKey}"]`),widget=input?.closest('[data-role="dropzone"]');return widget?.querySelector('[data-action="view"]')&&widget.querySelector('[data-action="delete"]')&&!widget.querySelector('[data-action="abort"],[role="progressbar"]')&&(widget.querySelector('[data-id="filename"]')?.textContent||'')===name;},{key,name:document.name},{timeout:25000});
  const href=await input.evaluate(e=>e.closest('[data-role="dropzone"]').querySelector('[data-action="view"]').href);
  if(!allowedWorkableResource(href)||new URL(href).hostname!=='workable-application-form.s3.us-east-1.amazonaws.com')fail('UNSUPPORTED_UPLOAD');
 }
 await assertWorkableAnswers(page,form,answers,{resume,coverLetter});
 await assertNoChallenge(page);
}
export async function assertWorkableAnswers(page,form,answers,documents){
 for(const field of form.fields){
  if(field.type==='file'){
   const files=await fieldInput(page,field).evaluateAll(inputs=>inputs.flatMap(input=>[...input.files].map(file=>({name:file.name,size:file.size}))));
   if(answers[field.key]?.value===null){if(files.length)fail('FIELD_CHANGED_AFTER_UPLOAD');}
   else if(documents){const document=applicationDocument(field,documents);if(files.length!==1||files[0].name!==document.name||files[0].size!==document.buffer.length)fail('FIELD_CHANGED_AFTER_UPLOAD');}
   continue;
  }
  const value=answers[field.key]?.value,input=fieldInput(page,field);
  if(field.type==='radio'){
   const selected=await input.evaluateAll(es=>es.map((e,i)=>e.checked?i:-1).filter(i=>i>=0));
   if(value===null&&!field.required){if(selected.length)fail('FIELD_CHANGED_AFTER_UPLOAD');}
   else if(selected.length!==1||selected[0]!==field.options.indexOf(value))fail('FIELD_CHANGED_AFTER_UPLOAD');
  }else if(field.type==='tel'&&value!==null){if(await phoneValue(input)!==value.replace(/\D/g,''))fail('FIELD_CHANGED_AFTER_UPLOAD');}
  else if(norm(await input.inputValue())!==norm(value))fail('FIELD_CHANGED_AFTER_UPLOAD');
 }
}
export async function submitWorkablePage(page,{url,form,answers,resume,coverLetter,beforeSubmit,receiptTimeout=30000}){
 if(!workableApplicationURL(url)||workableApplicationURL(page.url())!==workableApplicationURL(url))fail('APPLICATION_REDIRECTED');
 if(workableFingerprint(await readWorkableForm(page))!==workableFingerprint(form))fail('FORM_CHANGED');
 await fillWorkableApplication(page,form,answers,resume,coverLetter);
 if(workableFingerprint(await readWorkableForm(page))!==workableFingerprint(form))fail('FORM_CHANGED');
 if(workableApplicationURL(page.url())!==workableApplicationURL(url))fail('APPLICATION_REDIRECTED');
 const submitButton=page.locator('form[data-ui="application-form"] button[data-ui="apply-button"]');
 if(!await submitButton.isEnabled())fail('FORM_NOT_READY');
 await assertWorkableAnswers(page,form,answers,{resume,coverLetter});
 await beforeSubmit();
 await submitButton.click();
 try{await page.waitForFunction(()=>{const e=[...document.querySelectorAll('[data-ui="successful-submit"] [role="status"] h3')].find(n=>(n.innerText||'').trim()==='Your application has been submitted successfully.');return !!e&&e.getClientRects().length>0&&![...document.querySelectorAll('form[data-ui="application-form"]')].some(f=>f.getClientRects().length>0);},{},{timeout:receiptTimeout});}
 catch{fail('SUBMISSION_UNCONFIRMED');}
 if(workableApplicationURL(page.url())!==workableApplicationURL(url))fail('SUBMISSION_UNCONFIRMED');
 return {confirmedAt:new Date().toISOString(),url,confirmation:'Your application has been submitted successfully.'};
}
export async function submitWorkableApplication(options){return openApplication(options.url,page=>submitWorkablePage(page,{...options,url:workableApplicationURL(options.url)}));}
