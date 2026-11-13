import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {isCoverLetterField,applicationDocument} from './application-documents.mjs';

export const ashbyFingerprint=form=>createHash('sha256').update(JSON.stringify(form)).digest('hex');
export function ashbyApplicationURL(value){
 try{const u=new URL(value);if(u.protocol!=='https:'||u.hostname!=='jobs.ashbyhq.com'||u.port||u.username||u.password||u.search||u.hash||!/^\/[A-Za-z0-9._-]{1,100}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\/application)?\/?$/.test(u.pathname))return '';return u.origin+u.pathname.replace(/\/$/,'').replace(/\/application$/,'')+'/application';}catch{return '';}
}
export const liveApplicationSupported=job=>process.env.APPLICATION_BROWSER_ENABLED==='true'&&!!ashbyApplicationURL(job?.applyUrl||job?.url);
const fail=code=>{const error=new Error(code);error.code=code;error.retryable=false;throw error;};
const norm=value=>String(value||'').replace(/\s+/g,' ').trim();
export async function readAshbyForm(page){
 const form=await page.evaluate(()=>{
  const text=e=>(e?.innerText||'').replace(/\s+/g,' ').trim();
  const fields=Array.from(document.querySelectorAll('[data-field-path]')).map(e=>{
   const key=e.getAttribute('data-field-path'),heading=e.querySelector('.ashby-application-form-question-title'),input=e.querySelector('input,textarea,select'),label=text(heading);
   let type=e.querySelector('.ashby-application-form-input-yesno')?'yesno':e.querySelector('.ashby-application-form-input-checkbox-group')?'checkbox':e.querySelector('.ashby-application-form-input-radio-group')?'radio':input?.getAttribute('role')==='combobox'?'location':input?.type||'unsupported';
   if(type==='file'&&(input.multiple||input.getAttribute('accept')&&!input.getAttribute('accept').split(',').some(value=>['.pdf','application/pdf','application/*','*/*'].includes(value.trim().toLowerCase()))))type='unsupported';
   const options=type==='yesno'?['Yes','No']:type==='radio'?Array.from(e.querySelectorAll('input[type=radio]')).map(r=>text(r.labels?.[0])):type==='checkbox'?Array.from(e.querySelectorAll('.ashby-application-form-input-checkbox-group-option input[type=checkbox]')).map(c=>text(c.labels?.[0])):[];
   // Every checkbox in a group must be one of its labeled options; anything else is an unrecognized control.
   if(type==='checkbox'&&e.querySelectorAll('input[type=checkbox]').length!==options.length)type='unsupported';
   return {key,label,type,...(type==='checkbox'?{multiple:true}:{}),required:!!e.querySelector('[required]')||/\brequired\b|_required_/.test(heading?.className||''),options,...(Number(input?.getAttribute('maxlength'))>0?{maxLength:Number(input.getAttribute('maxlength'))}:{})};
  });
  for(const [name,label] of [['smsConsent','Recruiting updates by SMS'],['whatsAppConsent','Recruiting updates by WhatsApp']]){
   const options=Array.from(document.querySelectorAll(`input[name="${name}"]`)).map(e=>text(e.labels?.[0]));if(options.length)fields.push({key:name,label,type:'consent',required:true,options});
  }
  return {title:text(document.querySelector('h1')),fields,consentText:text(document.querySelector('.ashby-application-form-texting-consent-description'))};
 });
 if(!form.title||!form.fields.length||form.fields.length>35||new Set(form.fields.map(f=>f.key)).size!==form.fields.length||form.fields.some(f=>!/^[_a-zA-Z0-9-]{1,160}$/.test(f.key)||!f.label||f.label.length>1800||!['text','email','tel','textarea','file','location','radio','yesno','consent','checkbox'].includes(f.type)||(f.type==='checkbox'?f.options.length<1||f.options.length>50||f.options.some(o=>!o||o.length>500)||new Set(f.options).size!==f.options.length:f.options.length>8)||f.type==='file'&&f.key!=='_systemfield_resume'&&!isCoverLetterField(f)))fail('UNSUPPORTED_FORM');
 for(const field of form.fields)if(isCoverLetterField(field))field.purpose='coverLetter';
 return form;
}
export function allowedAshbyResource(value){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['jobs.ashbyhq.com','app.ashbyhq.com','cdn.ashbyprd.com','www.recaptcha.net','www.gstatic.com','www.google.com'].includes(u.hostname);}catch{return false;}
}
async function openApplication(url,run){
 if(!ashbyApplicationURL(url))fail('UNSUPPORTED_EMPLOYER');
 const executablePath=process.env.APPLICATION_BROWSER_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'');
 if(!executablePath||!existsSync(executablePath))fail('BROWSER_NOT_CONFIGURED');
 const {chromium}=await import('playwright-core');
 const browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:true,timeout:20000});
 const timer=setTimeout(()=>void browser.close(),150000);
 try{
  const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
  await context.routeWebSocket('**/*',socket=>socket.close());
  await context.route('**/*',route=>allowedAshbyResource(route.request().url())?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(12000);
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
  if(ashbyApplicationURL(page.url())!==url)fail('APPLICATION_REDIRECTED');
  await page.getByRole('button',{name:'Submit Application',exact:true}).waitFor({timeout:25000});
  return await run(page);
 }finally{clearTimeout(timer);await browser.close();}
}
export async function inspectAshbyApplication(url){return openApplication(url,readAshbyForm);}
export async function ashbyLocationChoices(url,value){return openApplication(url,async page=>{await page.getByRole('combobox').fill(value);await page.getByRole('option').first().waitFor();return (await page.getByRole('option').allTextContents()).slice(0,6).map(norm);});}
const ashbyChoices=container=>container.locator('.ashby-application-form-input-checkbox-group-option input[type=checkbox]');
async function checkedAshbyChoices(container,field){const states=await ashbyChoices(container).evaluateAll(inputs=>inputs.map(input=>input.checked));if(states.length!==field.options.length)fail('FORM_CHANGED');return field.options.filter((_,i)=>states[i]);}
const sameChoices=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
function ashbySelection(field,value){const values=String(value).split('\n').map(norm).filter(Boolean);if(!values.length||new Set(values).size!==values.length||values.some(v=>!field.options.includes(v)))fail('INVALID_CHOICE');return values;}
async function omittedAshbyField(page,field,{clear=false}={}){
 const container=page.locator(`[data-field-path="${field.key}"]`),code=clear?'UNREVIEWED_DEFAULT':'FIELD_CHANGED_AFTER_UPLOAD';
 if(['text','email','tel','textarea'].includes(field.type)){
  const input=container.locator(field.type==='textarea'?'textarea':'input').first();
  if(clear)await input.fill('');
  if(await input.inputValue()!=='')fail(code);
 }else if(field.type==='location'){
  // A preselected location may retain an internal place ID after its visible text
  // is cleared. Refuse it instead of treating a blank display as verified omission.
  if(await container.getByRole('combobox').inputValue()!=='')fail(code);
 }else if(field.type==='radio'||field.type==='consent'){
  const inputs=field.type==='consent'?page.locator(`input[name="${field.key}"]`):container.locator('input[type=radio]');
  if(await inputs.evaluateAll(elements=>elements.some(input=>input.checked)))fail(code);
 }else if(field.type==='yesno'){
  if(await container.locator('[aria-pressed="true"]').count()||await container.locator('input[type=checkbox]').evaluateAll(elements=>elements.some(input=>input.checked)))fail(code);
 }else if(field.type==='checkbox'){
  // A preselected choice is an unreviewed default: refuse rather than silently submit or clear it.
  if((await checkedAshbyChoices(container,field)).length)fail(code);
 }else if(field.type==='file'){
  if(await container.locator('input[type=file]').evaluateAll(elements=>elements.some(input=>input.files?.length)))fail(code);
 }else fail('UNSUPPORTED_FORM');
}
export async function fillAshbyApplication(page,form,answers,resume,coverLetter){
 const uploads=new Map();
 for(const field of form.fields){
  const answer=answers[field.key];
  if(!answer||answer.reviewed!==true)fail('MISSING_ANSWER');
  if(answer.value===null&&!field.required){await omittedAshbyField(page,field,{clear:true});continue;}
  if(typeof answer.value!=='string'||!answer.value.trim())fail('MISSING_ANSWER');
  if(field.maxLength&&answer.value.length>field.maxLength)fail('INVALID_ANSWER');
  const value=answer.value,container=page.locator(`[data-field-path="${field.key}"]`);
  if(field.type==='file'){const document=applicationDocument(field,{resume,coverLetter});if(answer.value!==document.name)fail('INVALID_DOCUMENT');uploads.set(field.key,document);continue;}
  if(['text','email','tel','textarea'].includes(field.type)){
   const input=container.locator(field.type==='textarea'?'textarea':'input').first();await input.fill(value);if(await input.inputValue()!==value)fail('FIELD_NOT_FILLED');
  }else if(field.type==='yesno'){
   if(!field.options.includes(value))fail('INVALID_CHOICE');const button=container.getByRole('button',{name:value,exact:true});await button.click();if(await button.getAttribute('aria-pressed')!=='true')fail('FIELD_NOT_FILLED');
  }else if(field.type==='radio'||field.type==='consent'){
   if(!field.options.includes(value))fail('INVALID_CHOICE');
   const input=field.type==='radio'?container.getByRole('radio',{name:value,exact:true}):page.locator(`input[name="${field.key}"]`).nth(field.options.indexOf(value));
   await input.check();if(!await input.isChecked())fail('FIELD_NOT_FILLED');
  }else if(field.type==='checkbox'){
   const wanted=ashbySelection(field,value),inputs=ashbyChoices(container);
   for(let i=0;i<field.options.length;i++)await inputs.nth(i).setChecked(wanted.includes(field.options[i]));
   if(!sameChoices(await checkedAshbyChoices(container,field),wanted))fail('FIELD_NOT_FILLED');
  }else if(field.type==='location'){
   const input=container.getByRole('combobox');await input.fill(value);await page.getByRole('option').first().waitFor();
   const labels=await page.getByRole('option').allTextContents(),matches=labels.filter(s=>norm(s).toLowerCase()===norm(value).toLowerCase());
   if(matches.length!==1){const error=new Error('CHOOSE_EXACT_LOCATION');error.code='CHOOSE_EXACT_LOCATION';error.options=labels.slice(0,6).map(norm);throw error;}
   await page.getByRole('option',{name:matches[0],exact:true}).click();if(norm(await input.inputValue())!==norm(matches[0]))fail('FIELD_NOT_FILLED');
  }
 }
 for(const [key,document] of uploads){
  const container=page.locator(`[data-field-path="${key}"]`);
  await container.locator('input[type=file]').setInputFiles(document);
  await container.getByText(document.name,{exact:true}).waitFor({timeout:25000});
 }
 // File widgets can trigger autofill. Recheck every reviewed value afterwards.
 for(const field of form.fields){
  const value=answers[field.key]?.value,container=page.locator(`[data-field-path="${field.key}"]`);
  if(value===null&&!field.required){await omittedAshbyField(page,field);continue;}
  if(['text','email','tel','textarea','location'].includes(field.type)){
   const input=container.locator(field.type==='textarea'?'textarea':'input').first();
   if(norm(await input.inputValue())!==norm(value))fail('FIELD_CHANGED_AFTER_UPLOAD');
  }else if(field.type==='file'){
   const document=uploads.get(field.key),files=await container.locator('input[type=file]').evaluateAll(inputs=>inputs.flatMap(input=>[...input.files].map(file=>({name:file.name,size:file.size}))));
   if(!document||files.length!==1||files[0].name!==document.name||files[0].size!==document.buffer.length)fail('FIELD_CHANGED_AFTER_UPLOAD');
  }else if(field.type==='yesno'){
   if(await container.getByRole('button',{name:value,exact:true}).getAttribute('aria-pressed')!=='true')fail('FIELD_CHANGED_AFTER_UPLOAD');
  }else if(field.type==='checkbox'){
   if(!sameChoices(await checkedAshbyChoices(container,field),ashbySelection(field,value)))fail('FIELD_CHANGED_AFTER_UPLOAD');
  }else if(field.type==='radio'||field.type==='consent'){
   const input=field.type==='radio'?container.getByRole('radio',{name:value,exact:true}):page.locator(`input[name="${field.key}"]`).nth(field.options.indexOf(value));
   if(!await input.isChecked())fail('FIELD_CHANGED_AFTER_UPLOAD');
  }
 }
 if(await page.locator('iframe[title*="challenge"]').filter({visible:true}).count())fail('HUMAN_VERIFICATION_REQUIRED');
}
export async function submitAshbyPage(page,{url,form,answers,resume,coverLetter,beforeSubmit,receiptTimeout=30000}){
  const current=await readAshbyForm(page);if(ashbyFingerprint(current)!==ashbyFingerprint(form))fail('FORM_CHANGED');
  await fillAshbyApplication(page,form,answers,resume,coverLetter);
  await beforeSubmit();
  await page.getByRole('button',{name:'Submit Application',exact:true}).click();
  // A click or HTTP 200 alone is never an application receipt.
  try{await page.waitForFunction(()=>{
   const submit=[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Submit Application'&&b.getClientRects().length);
   const fields=[...document.querySelectorAll('[data-field-path]')].some(e=>e.getClientRects().length);
   const receipt=[...document.querySelectorAll('h1,h2,h3,[role=status]')].some(e=>e.getClientRects().length&&/^(?:thank(?:s| you) for applying|(?:your )?application (?:has been )?(?:successfully )?(?:submitted|received))\b/i.test(e.innerText.trim()));
   return !submit&&!fields&&receipt;
  },undefined,{timeout:receiptTimeout});}catch{fail('SUBMISSION_UNCONFIRMED');}
  const lines=await page.locator('h1,h2,h3,[role=status]').allTextContents();
  const confirmation=lines.map(norm).find(line=>/^(?:thank(?:s| you) for applying|(?:your )?application (?:has been )?(?:successfully )?(?:submitted|received))\b/i.test(line));
  return {confirmedAt:new Date().toISOString(),url,confirmation:confirmation.slice(0,500)};
}
export async function submitAshbyApplication(input){return openApplication(input.url,page=>submitAshbyPage(page,input));}
