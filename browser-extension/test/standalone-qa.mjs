// Real Chrome, synthetic application pages only. Every network request is local or blocked.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {scanApplication} from '../scan.mjs';
import {fillApplication} from '../fill.mjs';
import {prepareStandaloneAutofill} from '../../lib/application-autofill.mjs';
import {saveCareerProfile} from '../../lib/career.mjs';

const url='https://careers.example.org/apply/product-manager';
const bytes=Buffer.from('%PDF-1.7\nSynthetic résumé for Alex Example');
const resume={name:'Resume.pdf',mimeType:'application/pdf',file:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};
const browser=await chromium.launch({headless:true,executablePath:process.env.APPLICATION_BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',chromiumSandbox:true});
let cases=0,writes=0;
async function fixture(markup,run){
 const context=await browser.newContext({serviceWorkers:'block'});
 try{
  await context.routeWebSocket('**/*',socket=>socket.close());
  await context.route('**/*',route=>{const request=route.request();if(request.method()!=='GET')writes++;return request.url()===url&&request.method()==='GET'?route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:`<html><head><title>Job application</title></head><body>${markup}</body></html>`}):route.abort();});
  const page=await context.newPage();await page.goto(url);
  await page.evaluate(()=>{window.__submissions=0;document.addEventListener('submit',event=>{window.__submissions++;event.preventDefault();},true);});
  const scan=await page.evaluate(scanApplication);assert.equal(scan.ok,true,JSON.stringify(scan));
  const payload={version:1,mode:'standalone',url,title:scan.title,scanId:scan.scanId,fields:scan.fields,answers:{},documents:{resume},expiresAt:Date.now()+300000};
  const answer=(label,value)=>{const field=payload.fields.find(f=>f.label===label);assert.ok(field,label);payload.answers[field.key]={value};return field;};
  await run(page,payload,answer);assert.equal(await page.evaluate(()=>window.__submissions),0);cases++;
 }finally{await context.close();}
}
const contact='<label>Full name<input id="name" name="name" required></label><label>Email<input id="email" type="email" required></label>';
const records=new Map();
const store={get:async(bucket,key)=>structuredClone(records.get(`${bucket}/${key}`)||null),put:async(bucket,key,value)=>{records.set(`${bucket}/${key}`,structuredClone(value));return value;},all:async bucket=>[...records.entries()].filter(([key])=>key.startsWith(`${bucket}/`)).map(([,value])=>structuredClone(value))};
await saveCareerProfile(store,{fullName:'Alex Example',firstName:'Alex',lastName:'Example',email:'alex@example.edu',phone:'+12125550123',location:'New York, NY',currentCompany:'Example Co',workAuthorizationUS:'yes',sponsorship:'no',veteranStatus:'non_veteran'});
await store.put('documents','resume',{name:resume.name,file:resume.file,text:'Alex Example built dashboards.'});
await store.put('career','demographics',{values:{gender:'male'}});
async function prepared(page){const scan=await page.evaluate(scanApplication);assert.equal(scan.ok,true);const input={url:scan.url,title:scan.title,company:scan.company,fields:scan.fields};return {...await prepareStandaloneAutofill(store,input),scanId:scan.scanId};}
try{
 await fixture(`<h1>Product Manager</h1><form>${contact}<label>Résumé<input id="resume" type="file" accept=".pdf" style="display:none"></label><label>Phone<input id="phone" type="tel"></label><label>Why this company?<textarea id="why" required>My existing explanation</textarea></label><fieldset><legend>Work authorization</legend><label><input id="work-yes" name="work" type="radio" value="1">Yes</label><label><input id="work-no" name="work" type="radio" value="0">No</label></fieldset><fieldset><legend>Requires sponsorship</legend><label><input name="sponsor" type="radio" value="yes">Yes</label><label><input id="sponsor-no" name="sponsor" type="radio" value="no" checked>No</label></fieldset><label>Country<select id="country"><option value="placeholder" disabled selected>Choose</option><option value="us">United States</option><option value="ca">Canada</option></select></label><label><input id="updates" type="checkbox">Recruiting updates</label><fieldset><legend>Preferred offices</legend><label><input name="offices" id="ny" type="checkbox" value="ny">New York</label><label><input name="offices" id="sf" type="checkbox" value="sf">San Francisco</label></fieldset><button type="submit">Submit</button></form>`,async(page,payload,answer)=>{
  await page.locator('#email').fill('my.existing@email.example');
  answer('Full name','Alex Example');answer('Email','new@email.example');answer('Résumé','Resume.pdf');answer('Phone','+12125550123');answer('Work authorization','Yes');answer('Requires sponsorship','Yes');answer('Country','United States');answer('Recruiting updates','Yes');answer('Preferred offices','New York\nSan Francisco');
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.ok,true);assert.equal(result.filled,7,JSON.stringify(result));assert.equal(result.preserved,3);assert.equal(result.remaining,0);
  assert.equal(await page.locator('#name').inputValue(),'Alex Example');assert.equal(await page.locator('#email').inputValue(),'my.existing@email.example');assert.equal(await page.locator('#why').inputValue(),'My existing explanation');
  assert.equal(await page.locator('#resume').evaluate(e=>e.files[0]?.name),'Resume.pdf');assert.equal(await page.locator('#work-yes').isChecked(),true);assert.equal(await page.locator('#sponsor-no').isChecked(),true);assert.equal(await page.locator('#country').inputValue(),'us');assert.equal(await page.locator('#ny').isChecked(),true);assert.equal(await page.locator('#sf').isChecked(),true);
  assert.match(await page.locator('#brb-application-helper').innerText(),/Kept 3 existing answers/);
  const rerun=await page.evaluate(fillApplication,payload);assert.equal(rerun.filled,0);assert.equal(rerun.preserved,10);assert.equal(await page.locator('#brb-application-helper').count(),1);
 });
 await fixture(`<h1>Product Manager</h1><form>${contact}<label>Country<select id="country"><option value="">Choose</option><option value="us">United States</option></select></label></form>`,async(page,payload,answer)=>{
  answer('Full name','Alex Example');answer('Email','alex@example.org');answer('Country','United States');
  await page.locator('#name').evaluate(e=>e.parentElement.firstChild.textContent='Changed question');await page.locator('option[value=us]').evaluate(e=>e.value='changed');
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.filled,1);assert.equal(result.remaining,2);assert.equal(await page.locator('#name').inputValue(),'');assert.equal(await page.locator('#country').inputValue(),'');
 });
 await fixture(`<h1>Product Manager</h1><form>${contact}</form>`,async(page,payload,answer)=>{
  answer('Full name','Alex Example');assert.equal((await page.evaluate(fillApplication,{...payload,scanId:'0'.repeat(32)})).ok,false);
  assert.equal((await page.evaluate(fillApplication,{...payload,expiresAt:0})).ok,false);
  await page.locator('h1').evaluate(e=>e.textContent='A different role');assert.equal((await page.evaluate(fillApplication,payload)).ok,false);assert.equal(await page.locator('#name').inputValue(),'');
 });
 await fixture(`<h1>Product Manager</h1><form>${contact}<div data-field-path="work"><div class="ashby-application-form-question-title">Work authorization</div><button type="button" aria-pressed="false">Yes</button><button type="button" aria-pressed="false">No</button></div><div data-field-path="sponsor"><div class="ashby-application-form-question-title">Requires sponsorship</div><button type="button" aria-pressed="false">Yes</button><button type="button" aria-pressed="true">No</button></div></form>`,async(page,payload,answer)=>{
  answer('Work authorization','Yes');answer('Requires sponsorship','Yes');await page.locator('[data-field-path="work"] button').evaluateAll(buttons=>buttons.forEach(button=>button.onclick=()=>buttons.forEach(other=>other.setAttribute('aria-pressed',String(other===button)))));
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.filled,1);assert.equal(result.preserved,1);assert.equal(await page.locator('[data-field-path="work"] button').first().getAttribute('aria-pressed'),'true');assert.equal(await page.locator('[data-field-path="sponsor"] button').last().getAttribute('aria-pressed'),'true');
 });
 const lever=await readFile(new URL('../../tests/fixtures/lever-tenna-application.html',import.meta.url),'utf8');
 await fixture(lever,async(page,payload)=>{
  const resumeField=payload.fields.find(f=>f.type==='file'&&f.document==='resume'),name=payload.fields.find(f=>f.controlName==='name'),email=payload.fields.find(f=>f.controlName==='email'),choice=payload.fields.find(f=>f.type==='radio'&&f.options.includes('No'));
  assert.ok(resumeField,'Lever hidden résumé control detected');assert.ok(name);assert.ok(email);assert.ok(choice,'Lever radio options detected');
  payload.answers={[resumeField.key]:{value:'Resume.pdf'},[name.key]:{value:'Alex Example'},[email.key]:{value:'alex@example.org'},[choice.key]:{value:'No'}};
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.filled,4,JSON.stringify(result));assert.equal(await page.locator('input[name=name]').inputValue(),'Alex Example');
 });
 await fixture(lever,async(page)=>{
  const payload=await prepared(page),result=await page.evaluate(fillApplication,payload);assert.equal(result.ok,true);
  for(const [name,value] of [['name','Alex Example'],['email','alex@example.edu'],['phone','+12125550123'],['org','Example Co']])assert.equal(await page.locator(`input[name="${name}"]`).inputValue(),value,JSON.stringify({fields:payload.fields,answers:payload.answers,result}));
  assert.equal(await page.locator('input[type=file]').first().evaluate(e=>e.files[0]?.name),'Resume.pdf',JSON.stringify({fields:payload.fields,answers:payload.answers,result}));
 });
 await fixture(`<h1>Product Manager</h1><form>${contact}<fieldset><legend>Are you legally authorized to work in the United States?</legend><label><input name="work" id="workyes" type="radio" value="1">Yes</label><label><input name="work" type="radio" value="0">No</label></fieldset><fieldset><legend>Will you now or in the future require sponsorship for employment visa status?</legend><label><input name="sponsor" type="radio" value="1">Yes</label><label><input name="sponsor" id="sponsorno" type="radio" value="0">No</label></fieldset><label>Gender<select id="gender"><option value="">Choose</option><option value="m">Male</option><option value="f">Female</option></select></label><label>Why this company?<textarea id="unknown"></textarea></label><label><input id="consent" type="checkbox">I agree to promotional messages</label></form>`,async page=>{
  await page.locator('#name').fill('My preferred name');const payload=await prepared(page),result=await page.evaluate(fillApplication,payload);assert.equal(result.ok,true);assert.equal(result.preserved,1);
  assert.equal(await page.locator('#name').inputValue(),'My preferred name');assert.equal(await page.locator('#email').inputValue(),'alex@example.edu');assert.equal(await page.locator('#workyes').isChecked(),true);assert.equal(await page.locator('#sponsorno').isChecked(),true);assert.equal(await page.locator('#gender').inputValue(),'m');assert.equal(await page.locator('#unknown').inputValue(),'');assert.equal(await page.locator('#consent').isChecked(),false);
 });
 await fixture(`<h1>Product Manager</h1><form>${contact}</form>`,async(page,payload)=>{
  for(const [flag,text] of [['alreadySubmitted',/already records this application as submitted/],['submissionInProgress',/Wait for its result/],['priorSubmissionUnconfirmed',/may already have succeeded/],['resumeNeedsRefresh',/saved résumé has changed/]]){
   const result=await page.evaluate(fillApplication,{...payload,[flag]:true});assert.equal(result[flag],true);assert.match(await page.locator('#brb-application-helper').innerText(),text);
  }
 });
 assert.equal(writes,0);console.log(JSON.stringify({passed:cases,employerWrites:writes,submitted:0}));
}finally{await browser.close();}
