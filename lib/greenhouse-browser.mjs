import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {applicationDocument,isCoverLetterField} from './application-documents.mjs';

const fail=code=>{const error=new Error(code);error.code=code;error.retryable=false;throw error;};
const norm=value=>String(value??'').replace(/\s+/g,' ').trim();
// Greenhouse multi-answer questions use ids/names such as question_123[] and
// question_123[]_456. Brackets are allowed only as a literal "[]" pair.
const safeID=value=>typeof value==='string'&&value.length<=160&&/^(?:[-_a-zA-Z0-9]|\[\])+$/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
const inputFor=(page,field)=>page.locator(`#application-form [id="${field.controlId}"]`);
export const greenhouseFingerprint=form=>createHash('sha256').update(JSON.stringify(form)).digest('hex');

// Many employers redirect Greenhouse's hosted job page to their own careers site.
// Greenhouse's embeddable form (what those sites load in an iframe) stays on
// job-boards.greenhouse.io with the same #application-form markup.
export const greenhouseEmbedURL=(board,id)=>/^[a-zA-Z0-9_-]{1,100}$/.test(String(board||''))&&/^[1-9][0-9]{0,15}$/.test(String(id||''))?`https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${id}`:'';
export function greenhouseApplicationURL(value){
 try{
  const u=new URL(value);
  if(u.protocol==='https:'&&['job-boards.greenhouse.io','boards.greenhouse.io'].includes(u.hostname)&&!u.port&&!u.username&&!u.password&&!u.hash&&u.pathname.replace(/\/$/,'')==='/embed/job_app'){
   const keys=[...u.searchParams.keys()];if(keys.some(key=>!['for','token','gh_src','source'].includes(key)))return '';
   return greenhouseEmbedURL(u.searchParams.get('for'),u.searchParams.get('token'));
  }
  if(u.protocol!=='https:'||!['job-boards.greenhouse.io','boards.greenhouse.io'].includes(u.hostname)||u.port||u.username||u.password||u.hash||!/^\/[a-zA-Z0-9_-]{1,100}\/jobs\/[1-9][0-9]{0,15}\/?$/.test(u.pathname))return '';
  for(const [key,value] of u.searchParams)if(!['gh_jid','gh_src','source','utm_source','utm_medium','utm_campaign','utm_term','utm_content'].includes(key)||value.length>500)return '';
  return 'https://job-boards.greenhouse.io'+u.pathname.replace(/\/$/,'');
 }catch{return '';}
}
export const greenhouseApplicationSupported=job=>process.env.APPLICATION_BROWSER_ENABLED==='true'&&!!greenhouseApplicationURL(job?.applyUrl||job?.url);

// Hosts observed on the public hosted form on 2026-11-12. OAuth, Dropbox,
// analytics, arbitrary employer hosts, and all websocket traffic stay blocked.
export function allowedGreenhouseResource(value){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&[
  'job-boards.greenhouse.io','boards.greenhouse.io','job-boards.cdn.greenhouse.io',
  'recruiting.cdn.greenhouse.io','api-geocode-earth-proxy.greenhouse.io',
  'www.recaptcha.net','www.gstatic.com',
 ].includes(u.hostname);}catch{return false;}
}

// Runs in the page and also against synthetic DOM fixtures. Enumerating every
// control makes new/conditional questions a refusal, never a silently skipped field.
export function greenhouseDOMSnapshot(){
 const text=e=>(e?.innerText??e?.textContent??'').replace(/\s+/g,' ').trim();
 const form=document.querySelector('#application-form');if(!form)return {invalid:true};
 const isVisible=e=>e.style?.display!=='none'&&(typeof getComputedStyle!=='function'||!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
 const fields=[],seenRadio=new Set(),seenCheckboxGroup=new Set();let invalid=false;
 for(const e of form.querySelectorAll('input,textarea,select,[contenteditable=true],[role=checkbox],[role=radio]')){
  if(e.matches('[contenteditable=true]')||e.matches('[role=checkbox],[role=radio]')&&e.tagName!=='INPUT'){invalid=true;continue;}
  const id=e.id,type=e.getAttribute('type')||'text';
  if(type==='hidden')continue;
  if(e.name==='g-recaptcha-response'&&!isVisible(e))continue;
  if(!id&&!e.name&&e.getAttribute('aria-hidden')==='true'&&e.getAttribute('tabindex')==='-1'&&e.closest('.select-shell')?.querySelector('input[role=combobox]'))continue;
  // The international-phone widget has a hidden duplicate search input. It is
  // not an applicant answer; the visible country-code picker is read separately.
  if(e.matches('.iti__search-input')&&!isVisible(e))continue;
  if(id==='cover_letter'&&type==='file'&&e.closest('.file-upload')?.querySelector('textarea[id="cover_letter_text"]')){if(e.files?.length)invalid=true;continue;}
  if(!isVisible(e)&&type!=='file'){invalid=true;continue;}
  const group=e.closest('.file-upload'),label=group?text(document.getElementById(group.getAttribute('aria-labelledby'))):text([...form.querySelectorAll('label')].find(l=>l.htmlFor===id||l.getAttribute('for')===id))||text(document.getElementById(e.getAttribute('aria-labelledby')));
  const required=e.hasAttribute('required')||e.getAttribute('aria-required')==='true'||group?.getAttribute('aria-required')==='true';
  const field={key:id==='resume'?'_systemfield_resume':id,controlId:id,label:label.replace(/\s*\*\s*$/,''),type:e.tagName==='TEXTAREA'?'textarea':e.tagName==='SELECT'?'select':type,required:!!required,options:[]};
  if(type==='file'){if(e.hasAttribute('accept'))field.accept=e.getAttribute('accept');if(e.multiple||e.hasAttribute('multiple'))field.multiple=true;}
  if(['INPUT','TEXTAREA'].includes(e.tagName)&&e.hasAttribute('maxlength'))field.maxLength=Number(e.getAttribute('maxlength'));
  if(e.tagName==='SELECT'){
   field.options=[...e.options].filter(o=>o.value&&!o.disabled).map(text);
   if(e.multiple)field.multiple=true;
  }else if(e.getAttribute('role')==='combobox'){
   field.type=id==='candidate-location'?'location':'select';field.widget='combobox';
   if(e.closest('.select__value-container--is-multi'))field.multiple=true;
  }else if(type==='radio'){
   if(!e.name){invalid=true;continue;}if(seenRadio.has(e.name))continue;seenRadio.add(e.name);
   const members=[...form.querySelectorAll('input[type=radio]')].filter(r=>r.name===e.name),group=e.closest('fieldset,[role=radiogroup]');
   field.key=e.name;field.radioIds=members.map(r=>r.id);field.label=text(group?.querySelector('legend'))||text(document.getElementById(group?.getAttribute('aria-labelledby')));
   field.options=members.map(r=>text([...form.querySelectorAll('label')].find(l=>(l.htmlFor||l.getAttribute('for'))===r.id)));field.required=members.some(r=>r.required||r.getAttribute('aria-required')==='true');
  }else if(type==='checkbox'){
   // A multi-answer question renders one checkbox per option sharing a name
   // (e.g. question_123[]) inside a fieldset whose legend is the question.
   const members=e.name?[...form.querySelectorAll('input[type=checkbox]')].filter(c=>c.name===e.name):[e];
   if(members.length>1){
    if(seenCheckboxGroup.has(e.name))continue;seenCheckboxGroup.add(e.name);
    const set=e.closest('fieldset');
    if(!set||members.some(c=>c.closest('fieldset')!==set)){invalid=true;continue;}
    field.key=e.name;field.controlId=set.id||e.name;field.type='checkbox';field.multiple=true;field.checkboxIds=members.map(c=>c.id);
    field.label=text(set.querySelector('legend'))||text(document.getElementById(set.getAttribute('aria-labelledby')));
    field.options=members.map(c=>text([...form.querySelectorAll('label')].find(l=>(l.htmlFor||l.getAttribute('for'))===c.id)));
    field.required=set.getAttribute('aria-required')==='true'||members.some(c=>c.required||c.getAttribute('aria-required')==='true');
    field.label=field.label.replace(/\s*\*\s*$/,'');
   }else field.options=['Yes','No'];
  }
  if(field.multiple){const cap=field.label.match(/\bup to (\d+)\b/i);if(cap)field.maxChoices=Number(cap[1]);}
  if(id==='email'&&field.type==='text')field.type='email';
  const profile={first_name:'firstName',last_name:'lastName',email:'email',phone:'phone','candidate-location':'currentLocation'}[id];
  if(profile)field.profileField=profile;
  else if(/^LinkedIn(?: Profile| URL)?$/i.test(field.label))field.profileField='linkedin';
  else if(/^(?:Portfolio|Personal Website)(?: URL)?$/i.test(field.label))field.profileField='portfolio';
  fields.push(field);
 }
 const consentText=[...form.querySelectorAll('p')].filter(e=>!e.matches('.file-upload__filetypes')).map(text).filter(Boolean).join('\n');
 const consentLinks=[...form.querySelectorAll('a[href]')].map(a=>({text:text(a),url:a.getAttribute('href')}));
 const submit=[...form.querySelectorAll('button[type=submit],input[type=submit]')].filter(isVisible).map(e=>text(e)||e.value);
 // The embeddable form has no <h1>; its document title reads "Job Application for <role> at <company>".
 return {title:text(document.querySelector('h1'))||((document.title||'').match(/^Job Application for (.+) at .+$/)?.[1]||'').trim(),fields,consentText,consentLinks,invalid,submit};
}

export function normalizeGreenhouseSnapshot(snapshot){
 const form={title:snapshot.title,fields:snapshot.fields,consentText:snapshot.consentText||'',consentLinks:snapshot.consentLinks||[]};
 if(snapshot.invalid||snapshot.submit?.length!==1||!/^Submit application$/i.test(snapshot.submit[0])||!form.title||form.title.length>500||!form.fields?.length||form.fields.length>60||form.consentText.length>18000||form.consentLinks.length>30)fail('UNSUPPORTED_FORM');
 if(new Set(form.fields.map(f=>f.key)).size!==form.fields.length)fail('UNSUPPORTED_FORM');
 for(const field of form.fields){
  if(!safeID(field.key)||!safeID(field.controlId)||!field.label||field.label.length>1800||!['text','email','tel','textarea','file','radio','select','checkbox','location'].includes(field.type)||field.type==='file'&&field.key!=='_systemfield_resume'&&!isCoverLetterField(field)||!Array.isArray(field.options)||field.options.length>300||field.options.some(v=>typeof v!=='string'||!v||v.length>1800)||new Set(field.options).size!==field.options.length||field.radioIds?.some(id=>!safeID(id))||field.checkboxIds&&(!field.multiple||field.type!=='checkbox'||field.checkboxIds.length!==field.options.length||field.checkboxIds.length<2||field.checkboxIds.some(id=>!safeID(id))||new Set(field.checkboxIds).size!==field.checkboxIds.length))fail('UNSUPPORTED_FORM');
  if(field.type==='checkbox'&&field.multiple&&!field.checkboxIds)fail('UNSUPPORTED_FORM');
  if(field.type==='file'&&(field.multiple||field.accept&&!String(field.accept).split(',').some(value=>['.pdf','application/pdf','application/*','*/*'].includes(value.trim().toLowerCase()))))fail('UNSUPPORTED_FORM');
  if(field.maxLength!==undefined&&(!Number.isSafeInteger(field.maxLength)||field.maxLength<1||field.maxLength>1000000))fail('UNSUPPORTED_FORM');
  if(isCoverLetterField(field))field.purpose='coverLetter';
 }
 return form;
}

async function prepareForm(page){
 // Greenhouse offers a text equivalent of the cover-letter attachment. Use
 // that actual control so it can be reviewed, drafted, or explicitly skipped.
 const cover=page.locator('#application-form [data-testid="cover_letter-text"]');
 if(await cover.count()){
  if(await cover.count()!==1)fail('UNSUPPORTED_FORM');await cover.click();
  await page.locator('#application-form textarea[id="cover_letter_text"]').waitFor();
 }
}
async function comboOptions(page,field,{query}={}){
 const input=inputFor(page,field);
 if(query!==undefined){await input.fill(query);await input.press('ArrowDown');}else await input.click();
 // SSR controls can precede hydration. A bounded second opening does not choose
 // an answer or submit, and avoids mistaking an inert initial click for no options.
 const visibleOptions=page.getByRole('option').filter({visible:true});
 try{await visibleOptions.first().waitFor({timeout:5000});}
 catch{await input.click();try{await visibleOptions.first().waitFor({timeout:5000});}catch{fail(field.type==='location'?'LOCATION_NOT_FOUND':'UNSUPPORTED_FORM');}}
 const options=(await visibleOptions.allTextContents()).map(norm);
 if(!options.length||options.length>300||options.some(v=>!v||v.length>1800)||new Set(options).size!==options.length)fail('UNSUPPORTED_FORM');
 return options;
}
export async function readGreenhouseForm(page){
 await prepareForm(page);
 const form=normalizeGreenhouseSnapshot(await page.evaluate(greenhouseDOMSnapshot));
 for(const field of form.fields){
  if(field.widget==='combobox'&&field.type!=='location'){
   field.options=await comboOptions(page,field);
   if(field.controlId==='country'){
    field.countryOptionFlags=await page.getByRole('option').filter({visible:true}).evaluateAll(es=>es.map(e=>[...e.querySelector('.iti__flag')?.classList||[]].find(c=>/^iti__[a-z]{2}$/.test(c))||''));
    if(field.countryOptionFlags.length!==field.options.length||field.countryOptionFlags.some(v=>!v)||new Set(field.countryOptionFlags).size!==field.countryOptionFlags.length)fail('UNSUPPORTED_FORM');
   }
   await inputFor(page,field).press('Escape');
  }
  if(['radio','select'].includes(field.type)&&!field.options.length)fail('UNSUPPORTED_FORM');
 }
 return form;
}

async function openApplication(value,run){
 const url=greenhouseApplicationURL(value);if(!url)fail('UNSUPPORTED_EMPLOYER');
 const executablePath=process.env.APPLICATION_BROWSER_PATH||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':'');
 if(!executablePath||!existsSync(executablePath))fail('BROWSER_NOT_CONFIGURED');
 const {chromium}=await import('playwright-core');
 const browser=await chromium.launch({executablePath,headless:true,chromiumSandbox:true,timeout:20000});
 const timer=setTimeout(()=>void browser.close(),150000);
 try{
  const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
  await context.routeWebSocket('**/*',socket=>socket.close());
  let requests=0;
  await context.route('**/*',route=>++requests<=500&&allowedGreenhouseResource(route.request().url())?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(12000);
  await page.goto(url,{waitUntil:'load',timeout:35000});
  if(page.url()!==url)fail('APPLICATION_REDIRECTED');
  await page.locator('#application-form').getByRole('button',{name:'Submit application',exact:true}).waitFor({timeout:20000});
  return await run(page);
 }finally{clearTimeout(timer);await browser.close();}
}
export async function inspectGreenhouseApplication(url){return openApplication(url,readGreenhouseForm);}
export async function greenhouseLocationChoices(url,query,{field}={}){
 if(typeof query!=='string'||query.trim().length<2||query.length>200)fail('INVALID_LOCATION');
 return openApplication(url,async page=>{
  const f=field||{controlId:'candidate-location',type:'location'};
  if(f.type!=='location'||f.controlId!=='candidate-location')fail('UNSUPPORTED_FORM');
  return (await comboOptions(page,f,{query})).slice(0,8);
 });
}

export function validateGreenhouseAnswers(form,answers,resume,coverLetter){
 for(const f of form.fields){
  const a=answers?.[f.key];if(!a?.reviewed)fail('MISSING_ANSWER');
  if(a.value===null&&!f.required)continue;
  if(typeof a.value!=='string'||!a.value.trim()||a.value.length>10000)fail('MISSING_ANSWER');
  if(f.maxLength&&a.value.length>f.maxLength)fail('ANSWER_TOO_LONG');
  if(f.options.length){const values=f.multiple?a.value.split('\n').map(norm):[a.value];if(new Set(values).size!==values.length||values.some(v=>!f.options.includes(v))||f.maxChoices&&values.length>f.maxChoices)fail('INVALID_CHOICE');}
  if(f.type==='checkbox'&&!f.multiple&&f.required&&a.value!=='Yes')fail('REQUIRED_CONSENT_DECLINED');
 }
 for(const f of form.fields.filter(f=>f.type==='file'&&answers[f.key]?.value!==null))applicationDocument(f,{resume,coverLetter});
}

async function humanVerification(page){
 if(await page.locator('iframe[title*="challenge" i],iframe[src*="/bframe"],[data-sitekey]:not(.grecaptcha-badge)').filter({visible:true}).count())fail('HUMAN_VERIFICATION_REQUIRED');
}
const selectedComboValues=async(input,field)=>input.evaluate((e,field)=>{
 const container=e.closest('.select__value-container');
 return [...container.querySelectorAll('.select__single-value,.select__multi-value__label')].map(e=>{
  const value=(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  if(field.controlId!=='country')return value;
  const flag=[...e.querySelector('.iti__flag')?.classList||[]].find(c=>/^iti__[a-z]{2}$/.test(c)),index=field.countryOptionFlags?.indexOf(flag);
  return index>=0&&field.options[index].endsWith(' '+value)?field.options[index]:value;
 });
},field);
const sameSelection=(actual,wanted,multiple)=>JSON.stringify(multiple?[...actual].sort():actual)===JSON.stringify(multiple?[...wanted].sort():wanted);
async function chooseCombo(page,field,value){
 const input=inputFor(page,field),choices=field.multiple?value.split('\n').map(norm):[value];
 // Remove any provider default rather than silently retaining it alongside the
 // choices the student reviewed. New contexts should start with no defaults.
 const existing=await selectedComboValues(input,field);
 if(existing.length&&!sameSelection(existing,choices,field.multiple))fail('UNEXPECTED_DEFAULT');
 if(sameSelection(existing,choices,field.multiple))return;
 for(const choice of choices){
  const options=await comboOptions(page,field,field.type==='location'?{query:choice}:{});
  if(!options.includes(choice)){
   if(field.type==='location'){const error=Object.assign(new Error('CHOOSE_EXACT_LOCATION'),{code:'CHOOSE_EXACT_LOCATION',field:field.key,options:options.slice(0,8),retryable:false});throw error;}
   fail('INVALID_CHOICE');
  }
  await page.getByRole('option',{name:choice,exact:true}).filter({visible:true}).click();
 }
 await input.press('Escape');
 if(!sameSelection(await selectedComboValues(input,field),choices,field.multiple))fail('FIELD_NOT_FILLED');
}

async function verifyValues(page,form,answers,documents){
 const current=normalizeGreenhouseSnapshot(await page.evaluate(greenhouseDOMSnapshot));
 // Static option lists are hydrated by readGreenhouseForm. Structure, question
 // text, legal text, and visible controls must still match after all interactions.
 const shape=f=>({...f,fields:f.fields.map(x=>{const result={...x,options:x.widget==='combobox'?[]:x.options};delete result.countryOptionFlags;return result;})});
 if(greenhouseFingerprint(shape(current))!==greenhouseFingerprint(shape(form)))fail('FORM_CHANGED');
 for(const f of form.fields){
  const value=answers[f.key]?.value,input=inputFor(page,f);
  if(f.type==='file'){
   const files=await input.evaluate(e=>[...e.files].map(file=>({name:file.name,size:file.size}))),document=documents.get(f.key);
   if(value===null?files.length!==0:!document||files.length!==1||files[0].name!==document.name||files[0].size!==document.buffer.length)fail('FIELD_CHANGED_AFTER_UPLOAD');
   continue;
  }
  if(f.widget==='combobox'){
   const got=await selectedComboValues(input,f),wanted=value===null?[]:f.multiple?value.split('\n').map(norm):[value];
   if(!sameSelection(got,wanted,f.multiple))fail('FIELD_CHANGED_AFTER_UPLOAD');
  }else if(f.type==='select'){
   const got=await input.evaluate(e=>[...e.selectedOptions].filter(o=>o.value).map(o=>o.textContent.trim()));
   const wanted=value===null?[]:f.multiple?value.split('\n').map(norm):[value];if(!sameSelection(got,wanted,f.multiple))fail('FIELD_CHANGED_AFTER_UPLOAD');
  }else if(f.type==='radio'){
   const checked=[];for(let i=0;i<f.radioIds.length;i++)if(await page.locator(`[id="${f.radioIds[i]}"]`).isChecked())checked.push(f.options[i]);
   if(checked.join('\n')!==(value??''))fail('FIELD_CHANGED_AFTER_UPLOAD');
  }else if(f.type==='checkbox'&&f.multiple){
   const checked=[];for(let i=0;i<f.checkboxIds.length;i++)if(await page.locator(`#application-form [id="${f.checkboxIds[i]}"]`).isChecked())checked.push(f.options[i]);
   if(!sameSelection(checked,value===null?[]:value.split('\n').map(norm),true))fail('FIELD_CHANGED_AFTER_UPLOAD');
  }else if(f.type==='checkbox'){
   if(await input.isChecked()!==(value==='Yes'))fail('FIELD_CHANGED_AFTER_UPLOAD');
  }else if(await input.inputValue()!==(value??''))fail('FIELD_CHANGED_AFTER_UPLOAD');
 }
}

export async function fillGreenhouseApplication(page,form,answers,resume,coverLetter){
 validateGreenhouseAnswers(form,answers,resume,coverLetter);await humanVerification(page);
 const documents=new Map(form.fields.filter(f=>f.type==='file'&&answers[f.key]?.value!==null).map(f=>[f.key,applicationDocument(f,{resume,coverLetter})]));
 for(const f of form.fields){
  const value=answers[f.key].value,input=inputFor(page,f);
  if(value===null||f.type==='file')continue;
  if(f.widget==='combobox')await chooseCombo(page,f,value);
  else if(['text','email','tel','textarea'].includes(f.type))await input.fill(value);
  else if(f.type==='select')await input.selectOption((f.multiple?value.split('\n').map(norm):[value]).map(label=>({label})));
  else if(f.type==='radio')await page.locator(`[id="${f.radioIds[f.options.indexOf(value)]}"]`).check();
  else if(f.type==='checkbox'&&f.multiple){
   // Set every option explicitly, so provider defaults never survive alongside the reviewed choices.
   const wanted=value.split('\n').map(norm);
   for(let i=0;i<f.checkboxIds.length;i++)await page.locator(`#application-form [id="${f.checkboxIds[i]}"]`).setChecked(wanted.includes(f.options[i]));
  }
  else if(f.type==='checkbox')await input.setChecked(value==='Yes');
  else fail('UNSUPPORTED_FORM');
 }
 for(const f of form.fields.filter(f=>f.type==='file')){
  if(answers[f.key].value===null){if(await inputFor(page,f).evaluate(e=>e.files.length))fail('UNREVIEWED_DEFAULT');continue;}
  const document=documents.get(f.key);await inputFor(page,f).setInputFiles(document);
  await page.locator('.file-upload').filter({has:page.locator(`[id="${f.controlId}"]`)}).getByText(document.name,{exact:true}).waitFor({timeout:25000});
 }
 // A filename can appear before processing finishes. Wait for upload/form busy
 // signals to clear and the actual submit control to be enabled, then perform
 // every value/structure check. Never let Playwright wait for an enabled submit
 // button after those checks while asynchronous autofill changes the answers.
 try{await page.waitForFunction(()=>{
  const form=document.querySelector('#application-form'),button=form?.querySelector('button[type=submit]');
  const visible=e=>!!e.getClientRects().length;
  return !!button&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&
   ![...form.querySelectorAll('[aria-busy="true"],[role=progressbar],progress')].some(visible)&&
   ![...form.querySelectorAll('.file-upload')].some(e=>/\b(?:uploading|processing)\b/i.test(e.innerText));
 },undefined,{timeout:25000});}catch{fail('FORM_NOT_READY');}
 await verifyValues(page,form,answers,documents);await humanVerification(page);
}

export async function submitGreenhousePage(page,{url,form,answers,resume,coverLetter,beforeSubmit,receiptTimeout=30000}){
 if(typeof beforeSubmit!=='function')fail('SUBMISSION_NOT_AUTHORIZED');
 const expectedURL=greenhouseApplicationURL(url);
 if(!expectedURL||page.url()!==expectedURL)fail('APPLICATION_REDIRECTED');
 const current=await readGreenhouseForm(page);
 if(greenhouseFingerprint(current)!==greenhouseFingerprint(form))fail('FORM_CHANGED');
 await fillGreenhouseApplication(page,form,answers,resume,coverLetter);
 const submit=page.locator('#application-form').getByRole('button',{name:'Submit application',exact:true});
 if(await submit.count()!==1||await submit.isDisabled()||await submit.getAttribute('aria-disabled')==='true')fail('FORM_NOT_READY');
 if(page.url()!==expectedURL)fail('APPLICATION_REDIRECTED');
 await beforeSubmit();
 await submit.click(); // Exactly one final click. An uncertain receipt is never retried.
 try{await page.waitForFunction(()=>{
  const visible=e=>!!e.getClientRects().length;
  if([...document.querySelectorAll('#application-form input,#application-form textarea,#application-form button[type=submit]')].some(visible))return false;
  return [...document.querySelectorAll('h1,h2,h3,[role=status]')].some(e=>visible(e)&&/^(?:thank(?:s| you) for applying|(?:your )?application (?:has been )?(?:successfully )?(?:submitted|received))\b/i.test(e.innerText.trim()));
 },undefined,{timeout:receiptTimeout});}catch{fail('SUBMISSION_UNCONFIRMED');}
 if(page.url()!==expectedURL)fail('SUBMISSION_UNCONFIRMED');
 const confirmation=(await page.locator('h1,h2,h3,[role=status]').allTextContents()).map(norm).find(s=>/^(?:thank(?:s| you) for applying|(?:your )?application (?:has been )?(?:successfully )?(?:submitted|received))\b/i.test(s));
 if(!confirmation)fail('SUBMISSION_UNCONFIRMED');
 return {confirmedAt:new Date().toISOString(),url,confirmation:confirmation.slice(0,500)};
}
export async function submitGreenhouseApplication(input){return openApplication(input.url,page=>submitGreenhousePage(page,{...input,url:greenhouseApplicationURL(input.url)}));}
