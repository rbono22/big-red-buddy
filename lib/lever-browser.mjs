import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {applicationDocument,isCoverLetterField} from './application-documents.mjs';

const fail=code=>{const error=new Error(code);error.code=code;error.retryable=false;throw error;};
const norm=value=>String(value??'').replace(/\s+/g,' ').trim();
const digest=value=>createHash('sha256').update(value).digest('hex');
export const leverFingerprint=form=>digest(JSON.stringify(form));
const tracking=new Set(['lever-source','lever-origin','source','ref','referral','utm_source','utm_medium','utm_campaign','utm_content','utm_term']);
export function leverApplicationURL(value){
 try{
  if(typeof value!=='string'||!value.startsWith('https://jobs.lever.co/')||/[\\\u0000-\u0020#]/.test(value)||/\/(?:\.|%2e){1,2}(?:\/|%2f)/i.test(value))return '';
  const u=new URL(value);
  if(u.protocol!=='https:'||u.hostname!=='jobs.lever.co'||u.port||u.username||u.password||u.hash||!/^\/[A-Za-z0-9_-]{1,100}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\/apply)?\/?$/.test(u.pathname)||[...u.searchParams.keys()].some(key=>!tracking.has(key)))return '';
  return u.origin+u.pathname.replace(/\/$/,'').replace(/\/apply$/,'')+'/apply';
 }catch{return '';}
}
export const leverApplicationSupported=job=>process.env.APPLICATION_BROWSER_ENABLED==='true'&&!!leverApplicationURL(job?.applyUrl||job?.url);
export function allowedLeverResource(value){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&['jobs.lever.co','cdn.lever.co','js.hcaptcha.com','newassets.hcaptcha.com','api.hcaptcha.com','api2.hcaptcha.com','hcaptcha.com'].includes(u.hostname);}catch{return false;}
}

// Read the actual controls, including optional ones. Complex/conditional forms fail closed.
export async function readLeverForm(page){
 const raw=await page.evaluate(()=>{
  const text=e=>(e?.innerText||e?.textContent||'').replace(/\s+/g,' ').trim();
  const form=document.querySelector('#application-form');if(!form||form.getAttribute('action')||form.getAttribute('method')?.toLowerCase()!=='post'||form.querySelector('[contenteditable=true],div[role=combobox]'))return null;
  const concealed=e=>{for(let node=e;node&&node!==form;node=node.parentElement){const css=getComputedStyle(node);if(node.hasAttribute('hidden')||css.display==='none'||css.visibility==='hidden')return true;}return false;};
  const controls=[...form.querySelectorAll('input,select,textarea')].filter(e=>!['hidden','submit','button','reset'].includes(e.type));
  const groups=new Map();for(const e of controls){const name=e.getAttribute('name')||'';if(!groups.has(name))groups.set(name,[]);groups.get(name).push(e);}
  const fields=[...groups].map(([controlName,inputs])=>{
   const input=inputs[0],container=input.closest('.application-question')||input.closest('label')||input.parentElement;
   const heading=container?.querySelector('.application-label');
   const label=text(heading||input.labels?.[0]||container).replace(/\s*[✱*]\s*$/,'');
   const tag=input.tagName.toLowerCase();let type=tag==='select'?'select':tag==='textarea'?'textarea':input.type||'text';
   if(input.classList.contains('location-input'))type='location';
   const multiple=type==='checkbox'&&inputs.length>1||type==='select'&&input.hasAttribute('multiple');
   if(!['radio','checkbox'].includes(type)&&inputs.length!==1||inputs.some(e=>e.tagName!==input.tagName||e.type!==input.type))type='unsupported';
   if(inputs.some(e=>e.disabled)||inputs.some(e=>e.type!=='file'&&concealed(e)))type='unsupported';
   const choices=type==='select'?[...input.querySelectorAll('option')].filter(o=>!o.disabled&&o.value!==''):type==='radio'||type==='checkbox'&&multiple?inputs:[];
   const options=type==='checkbox'&&!multiple?['Yes','No']:choices.map(e=>text(['radio','checkbox'].includes(type)?(e.labels?.[0]||e.closest('label')):e));
   const optionValues=choices.map(e=>e.value);
   return {controlName,label,type,required:inputs.some(e=>e.required||e.hasAttribute('required')||e.getAttribute('aria-required')==='true')||!!container?.querySelector('.required,.required-field'),options,...(multiple||type==='file'&&input.hasAttribute('multiple')?{multiple:true}:{}),...(type==='file'&&input.hasAttribute('accept')?{accept:input.getAttribute('accept')}:{}),...(input.hasAttribute('maxlength')?{maxLength:Number(input.getAttribute('maxlength'))}:{}),...(choices.length?{optionValues}:{})};
  });
  const copy=form.cloneNode(true);copy.querySelectorAll('.application-question,input,select,textarea,button,script,iframe,svg,h4').forEach(e=>e.remove());
  return {title:text(document.querySelector('.posting-header h2')||document.querySelector('h2')),fields,consentText:text(copy)};
 });
 if(!raw||!raw.title||raw.title.length>500||!raw.fields.length||raw.fields.length>70||raw.consentText.length>20000)fail('UNSUPPORTED_FORM');
 const profileNames={name:'fullName',email:'email',phone:'phone',org:'currentCompany','urls[LinkedIn]':'linkedin','urls[Portfolio]':'portfolio',location:'location'};
 const fields=raw.fields.map(field=>{
  const {controlName,type,options,optionValues}=field;
  if(!/^[A-Za-z0-9_\[\]. -]{1,180}$/.test(controlName)||!field.label||field.label.length>2400||!['text','email','tel','textarea','file','radio','select','checkbox','location'].includes(type)||options.length>300||options.some(v=>!v||v.length>2400)||new Set(options).size!==options.length||optionValues&&new Set(optionValues).size!==optionValues.length||type==='file'&&controlName!=='resume'&&!isCoverLetterField(field)||['radio','select'].includes(type)&&!options.length)fail('UNSUPPORTED_FORM');
  if(type==='file'&&(field.multiple||field.accept&&!String(field.accept).split(',').some(value=>['.pdf','application/pdf','application/*','*/*'].includes(value.trim().toLowerCase()))))fail('UNSUPPORTED_FORM');
  if(field.maxLength!==undefined&&(!Number.isSafeInteger(field.maxLength)||field.maxLength<1||field.maxLength>1000000))fail('UNSUPPORTED_FORM');
  return {key:controlName==='resume'?'_systemfield_resume':`lever_${digest(controlName).slice(0,24)}`,...field,...(isCoverLetterField(field)?{purpose:'coverLetter'}:{}),...(profileNames[controlName]?{profileField:profileNames[controlName]}:{})};
 });
 return {...raw,fields};
}

async function assertNoChallenge(page){
 if(await page.locator('iframe[title*="challenge" i],iframe[title*="captcha" i],iframe[src*="/captcha/"]').filter({visible:true}).count())fail('HUMAN_VERIFICATION_REQUIRED');
}
async function openApplication(value,run){
 const url=leverApplicationURL(value);if(!url)fail('UNSUPPORTED_EMPLOYER');
 const executablePath=process.env.APPLICATION_BROWSER_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'');
 if(!executablePath||!existsSync(executablePath))fail('BROWSER_NOT_CONFIGURED');
 const {chromium}=await import('playwright-core');
 const browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:true,timeout:20000});
 const timer=setTimeout(()=>void browser.close(),180000);
 try{
  const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
  await context.routeWebSocket('**/*',socket=>socket.close());
  await context.route('**/*',route=>{const request=route.request(),target=new URL(request.url());const writesJob=request.method()!=='GET'&&target.hostname==='jobs.lever.co';const safeWrite=!writesJob||(request.method()==='POST'&&(target.href===url||target.pathname==='/parseResume'));return allowedLeverResource(request.url())&&safeWrite?route.continue():route.abort();});
  const page=await context.newPage();page.setDefaultTimeout(12000);
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
  if(page.url()!==url)fail('APPLICATION_REDIRECTED');
  await page.locator('#application-form #btn-submit').waitFor({timeout:25000});
  await assertNoChallenge(page);return await run(page,url);
 }finally{clearTimeout(timer);await browser.close();}
}
export async function inspectLeverApplication(url){return openApplication(url,readLeverForm);}
// Lever emits hidden "false" fallbacks with the same name as consent checkboxes.
// Read and fill the applicant controls, matching readLeverForm's enumeration.
const control=(page,field)=>page.locator(`#application-form :is(input,select,textarea)[name=${JSON.stringify(field.controlName)}]:not([type="hidden"])`);
async function assertOmittedLeverValue(page,field,code){
 const input=control(page,field);
 if(field.type==='file'&&await input.evaluateAll(es=>es.some(e=>e.files?.length)))fail(code);
 if(field.type==='location'&&(await input.inputValue()!==''||await page.locator('#application-form #selected-location').evaluateAll(es=>es.some(e=>e.value!==''))))fail(code);
}
async function locationChoices(page,input,value){
 await input.fill(value);await input.press('End');
 await page.locator('.dropdown-location').first().waitFor();
 return (await page.locator('.dropdown-location').allTextContents()).map(norm);
}
export async function leverLocationChoices(url,value){return openApplication(url,async page=>(await locationChoices(page,page.locator('input.location-input'),value)).slice(0,8));}
export async function fillLeverApplication(page,form,answers,resume,coverLetter){
 // Validate the entire reviewed answer set before touching any applicant control.
 for(const field of form.fields){
  const answer=answers[field.key];if(answer?.reviewed===true&&answer.value===null&&!field.required)continue;
  if(!answer||answer.reviewed!==true||typeof answer.value!=='string'||!answer.value.trim())fail('MISSING_ANSWER');
  if(field.maxLength&&answer.value.length>field.maxLength)fail('ANSWER_TOO_LONG');
  if(field.options.length){const values=field.multiple?answer.value.split('\n'): [answer.value];if(!values.length||new Set(values).size!==values.length||values.some(value=>!field.options.includes(value)))fail('INVALID_CHOICE');}
  if(field.type==='checkbox'&&!field.multiple&&field.required&&answer.value!=='Yes')fail('REQUIRED_CONSENT');
 }
 const documents=new Map(form.fields.filter(f=>f.type==='file'&&answers[f.key]?.value!==null).map(f=>[f.key,applicationDocument(f,{resume,coverLetter})]));
 for(const field of form.fields){
  const value=answers[field.key].value,input=control(page,field);if(field.type==='file'){if(value===null)await assertOmittedLeverValue(page,field,'UNREVIEWED_DEFAULT');continue;}
  if(['text','email','tel','textarea'].includes(field.type)){await input.fill(value??'');}
  else if(field.type==='location'){
   if(value===null){await input.fill('');await input.blur();await assertOmittedLeverValue(page,field,'UNREVIEWED_DEFAULT');continue;}
   const labels=await locationChoices(page,input,value),matches=labels.filter(s=>s.toLowerCase()===norm(value).toLowerCase());
   if(matches.length!==1){const error=new Error('CHOOSE_EXACT_LOCATION');error.code='CHOOSE_EXACT_LOCATION';error.field=field.key;error.options=labels.slice(0,8);throw error;}
   await page.locator('.dropdown-location').filter({hasText:new RegExp(`^${matches[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`)}).click();
  }else if(field.type==='select'){await input.selectOption(field.multiple?(value===null?[]:value.split('\n').map(v=>field.optionValues[field.options.indexOf(v)])):value===null?'':field.optionValues[field.options.indexOf(value)]);}
  else if(field.type==='radio'){
   if(value!==null)await input.nth(field.options.indexOf(value)).check();
   else if(await input.evaluateAll(es=>es.some(e=>e.checked)))fail('UNREVIEWED_DEFAULT');
  }else if(field.type==='checkbox'){if(field.multiple){const values=value===null?[]:value.split('\n');for(let i=0;i<field.options.length;i++)await input.nth(i).setChecked(values.includes(field.options[i]));}else await input.setChecked(value==='Yes');}
 }
 for(const field of form.fields.filter(f=>documents.has(f.key))){
  const document=documents.get(field.key),input=control(page,field);await input.setInputFiles(document);
  if(field.key==='_systemfield_resume'){
   await page.locator('#application-form .resume .filename').filter({hasText:document.name}).waitFor({timeout:30000});
   await page.locator('#application-form .resume-upload-working').waitFor({state:'hidden',timeout:30000});
  }
  const files=await input.evaluate(e=>[...e.files].map(f=>({name:f.name,size:f.size})));
  if(files.length!==1||files[0].name!==document.name||files[0].size!==document.buffer.length)fail('FIELD_NOT_FILLED');
 }
 // Lever parses PDF uploads asynchronously and may change even optional fields.
 for(const field of form.fields){
  const value=answers[field.key].value,input=control(page,field);
  if(value===null&&['file','location'].includes(field.type))await assertOmittedLeverValue(page,field,'FIELD_CHANGED_AFTER_UPLOAD');
  if(field.type==='file'&&value!==null){const document=documents.get(field.key),files=await input.evaluate(e=>[...e.files].map(f=>({name:f.name,size:f.size})));if(!document||files.length!==1||files[0].name!==document.name||files[0].size!==document.buffer.length)fail('FIELD_CHANGED_AFTER_UPLOAD');}
  if(['text','email','tel','textarea','location'].includes(field.type)){
   if(await input.inputValue()!==(value??''))fail('FIELD_CHANGED_AFTER_UPLOAD');
   if(field.type==='location'&&value!==null){const selected=await page.locator('#selected-location').inputValue();try{if(norm(JSON.parse(selected).name)!==norm(value))fail('FIELD_CHANGED_AFTER_UPLOAD');}catch{fail('FIELD_CHANGED_AFTER_UPLOAD');}}
  }else if(field.type==='select'){
   if(field.multiple){const values=value===null?[]:value.split('\n').map(v=>field.optionValues[field.options.indexOf(v)]);const selected=await input.evaluate(e=>[...e.selectedOptions].map(o=>o.value));if(selected.length!==values.length||selected.some(v=>!values.includes(v)))fail('FIELD_CHANGED_AFTER_UPLOAD');}else if(await input.inputValue()!==(value===null?'':field.optionValues[field.options.indexOf(value)]))fail('FIELD_CHANGED_AFTER_UPLOAD');
  }else if(field.type==='checkbox'){
   if(field.multiple){const values=value===null?[]:value.split('\n'),checked=await input.evaluateAll(es=>es.map(e=>e.checked));if(checked.some((yes,i)=>yes!==values.includes(field.options[i])))fail('FIELD_CHANGED_AFTER_UPLOAD');}else if(await input.isChecked()!==(value==='Yes'))fail('FIELD_CHANGED_AFTER_UPLOAD');
  }else if(field.type==='radio'){
   const checked=await input.evaluateAll(es=>es.map(e=>e.checked));
   if(checked.some((yes,i)=>yes!==(value!==null&&i===field.options.indexOf(value))))fail('FIELD_CHANGED_AFTER_UPLOAD');
  }
 }
 if(leverFingerprint(await readLeverForm(page))!==leverFingerprint(form))fail('FORM_CHANGED');
 await assertNoChallenge(page);
 if(!await page.locator('#application-form').evaluate(e=>e.checkValidity()))fail('INVALID_ANSWER');
}
export async function submitLeverPage(page,{url,form,answers,resume,coverLetter,beforeSubmit,receiptTimeout=30000}){
 if(page.url()!==url||!leverApplicationURL(url))fail('APPLICATION_REDIRECTED');
 if(leverFingerprint(await readLeverForm(page))!==leverFingerprint(form))fail('FORM_CHANGED');
 await assertNoChallenge(page);await fillLeverApplication(page,form,answers,resume,coverLetter);
 if(typeof beforeSubmit!=='function')fail('SUBMISSION_NOT_AUTHORIZED');
 await beforeSubmit();
 await page.locator('#application-form #btn-submit').click();
 // Exactly one click. A CAPTCHA, generic page, or HTTP 200 is never a receipt.
 try{await page.waitForFunction(()=>{
  const visible=e=>!!e&&!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
  const challenge=[...document.querySelectorAll('iframe[title*="challenge" i],iframe[title*="captcha" i]')].some(visible);
  const receipt=[...document.querySelectorAll('h1,h2,h3,[role=status]')].some(e=>visible(e)&&/^(?:thank(?:s| you) for applying|(?:your )?application (?:has been )?(?:successfully )?(?:submitted|received))\b/i.test(e.textContent.trim()));
  return challenge||(!visible(document.querySelector('#application-form'))&&receipt);
 },undefined,{timeout:receiptTimeout});}catch{fail('SUBMISSION_UNCONFIRMED');}
 await assertNoChallenge(page);
 const receiptURL=new URL(page.url()),applicationURL=new URL(url);
 if(receiptURL.origin!==applicationURL.origin||!(receiptURL.pathname===applicationURL.pathname||receiptURL.pathname.startsWith(applicationURL.pathname.replace(/\/apply$/,'')+'/')))fail('SUBMISSION_UNCONFIRMED');
 const lines=await page.locator('h1,h2,h3,[role=status]').filter({visible:true}).allTextContents();
 const confirmation=lines.map(norm).find(line=>/^(?:thank(?:s| you) for applying|(?:your )?application (?:has been )?(?:successfully )?(?:submitted|received))\b/i.test(line));
 if(!confirmation)fail('SUBMISSION_UNCONFIRMED');
 return {confirmedAt:new Date().toISOString(),url,confirmation:confirmation.slice(0,500)};
}
export async function submitLeverApplication(input){return openApplication(input.url,(page,url)=>submitLeverPage(page,{...input,url}));}
