// Synthetic browser QA. Every request is fulfilled locally or blocked; no employer receives data.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {fillApplication} from '../fill.mjs';
import {readLeverForm} from '../../lib/lever-browser.mjs';

const urls={brb:'https://app.bigredbuddy.com/',lever:'https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply',greenhouse:'https://job-boards.greenhouse.io/example/jobs/123',greenhouseEmbed:'https://job-boards.greenhouse.io/embed/job_app?for=example&token=123',ashby:'https://jobs.ashbyhq.com/ramp/12345678-1234-1234-1234-123456789abc/application',workable:'https://apply.workable.com/valsoft-corp/j/ABC123DEF4/apply/'};
const pdf=(name,text)=>{const bytes=Buffer.from('%PDF-1.7\n'+text);return {name,mimeType:'application/pdf',file:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};};
const documents={resume:pdf('Resume.pdf','Synthetic résumé for Alex Example'),coverLetter:pdf('Cover Letter.pdf','Synthetic cover letter for Alex Example')};
const browser=await chromium.launch({headless:true,executablePath:process.env.APPLICATION_BROWSER_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',chromiumSandbox:true});
let cases=0,writes=0;
async function fixture(provider,html,run){
 const context=await browser.newContext({serviceWorkers:'block'});
 try{
  await context.routeWebSocket('**/*',socket=>socket.close());
  await context.route('**/*',route=>{const request=route.request();if(request.method()!=='GET')writes++;return request.url()===urls[provider]&&request.method()==='GET'?route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html}):route.abort();});
  const page=await context.newPage();await page.goto(urls[provider]);
  await page.evaluate(()=>{window.__submissions=0;document.addEventListener('submit',event=>{window.__submissions++;event.preventDefault();},true);});
  const payload={version:1,applicationId:'synthetic',provider:provider.replace(/Embed$/,''),url:urls[provider],title:'Product Manager',company:'Example',fields:[],answers:{},documents,expiresAt:Date.now()+300000};
  await run(page,payload);assert.equal(await page.evaluate(()=>window.__submissions),0);cases++;
 }finally{await context.close();}
}
try{
 const content=await readFile(new URL('../brb-content.js',import.meta.url),'utf8');
 await fixture('brb','<h1>Applications</h1><a id="open" data-brb-autofill href="/#application-handoff/synthetic">Open &amp; autofill application</a>',async page=>{
  await page.evaluate(()=>{window.__handoffs=[];window.__bubbleClicks=0;window.chrome={runtime:{sendMessage:async message=>{window.__handoffs.push(message);return {ok:true,filled:2,remaining:0};}}};});
  await page.addScriptTag({content});
  await page.evaluate(()=>{document.addEventListener('click',event=>{if(!event.isTrusted)event.preventDefault();window.__bubbleClicks++;});document.getElementById('open').click();});
  assert.equal(await page.evaluate(()=>window.__handoffs.length),0,'programmatic clicks cannot launch a handoff');
  assert.equal(await page.evaluate(()=>window.__bubbleClicks),1);
  await page.locator('#open').click();
  await page.waitForFunction(()=>document.getElementById('brb-autofill-status')?.textContent.includes('Filled 2 fields'));
  assert.deepEqual(await page.evaluate(()=>window.__handoffs),[{action:'beginHandoff',applicationId:'synthetic'}]);
  assert.equal(await page.evaluate(()=>window.__bubbleClicks),1,'trusted click is captured before the app fallback');assert.equal(page.url(),urls.brb);
 });
 const html=await readFile(new URL('../../tests/fixtures/lever-tenna-application.html',import.meta.url),'utf8');
 await fixture('lever',html.replace('</form>','<div class="application-question"><label><span class="application-label">Cover letter</span><input type="file" name="coverLetter"></label></div></form>'),async(page,payload)=>{
  const form=await readLeverForm(page);payload.fields=form.fields.map(f=>({...f,...(f.type==='file'?{document:f.key==='_systemfield_resume'?'resume':'coverLetter'}:{})}));
  const name=form.fields.find(f=>f.controlName==='name'),email=form.fields.find(f=>f.controlName==='email'),phone=form.fields.find(f=>f.controlName==='phone'),cover=form.fields.find(f=>f.controlName==='coverLetter'),degree=form.fields.find(f=>f.options.includes('Bachelors Degree')),radio=form.fields.find(f=>f.type==='radio'&&f.options.includes('No'));
  payload.answers={_systemfield_resume:{value:'Resume.pdf'},[cover.key]:{value:'Cover Letter.pdf'},[name.key]:{value:'Alex Example'},[email.key]:{value:'alex@example.test'},[phone.key]:{value:'+12125550123'},[degree.key]:{value:'Bachelors Degree'},[radio.key]:{value:'No'}};
  await page.locator('[name="phone"]').evaluate(e=>{e.closest('.application-question').querySelector('.application-label').textContent='Changed phone question';});
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.ok,true);assert.equal(result.filled,6);assert.ok(result.skipped.some(s=>s.label===phone.label&&s.reason==='Question wording changed'),JSON.stringify(result.skipped));
  assert.equal(await page.locator('[name="name"]').inputValue(),'Alex Example');assert.equal(await page.locator('[name="phone"]').inputValue(),'');
  assert.deepEqual(await page.locator('input[type=file]').evaluateAll(es=>es.map(e=>e.files[0]?.name)),['Resume.pdf','Cover Letter.pdf']);
  assert.equal(await page.locator(`select[name="${degree.controlName}"]`).inputValue(),'Bachelors Degree');
  assert.equal(await page.locator('input[type=radio]:checked').inputValue(),'No');
  await page.setViewportSize({width:1200,height:850});await page.locator('#brb-application-helper').screenshot({path:'/private/tmp/brb-handoff-qa.png'});
 });
 await fixture('lever','<h2>Product Manager</h2><form id="application-form"><div class="application-question"><span class="application-label">Updates</span><input type="hidden" name="updates" value="false"><label><input type="checkbox" name="updates">Updates</label></div><div class="application-question"><label><span class="application-label">Current location</span><input name="location"></label><button role="option">New York, NY</button></div></form>',async(page,payload)=>{
  payload.fields=[{key:'updates',controlName:'updates',label:'Updates',type:'checkbox',options:['Yes','No']},{key:'location',controlName:'location',label:'Current location',type:'location'}];payload.answers={updates:{value:'Yes'},location:{value:'New York, NY'}};
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.filled,1);assert.equal(result.remaining,1);assert.equal(await page.locator('input[type=checkbox]').isChecked(),true);assert.equal(result.skipped[0].reason,'Select the matching city');
 });
 await fixture('lever','<h2>Product Manager</h2><form id="application-form" method="POST"><div class="application-question"><div class="application-label">Are you legally authorized to work in the United States?</div><label><input type="radio" name="cards[synthetic][authorization]" value="Yes">Yes</label><label><input type="radio" name="cards[synthetic][authorization]" value="No">No</label></div><div class="application-question"><div class="application-label">Will you now or in the future require sponsorship for employment visa status</div><label><input type="radio" name="cards[synthetic][sponsorship]" value="Yes">Yes</label><label><input type="radio" name="cards[synthetic][sponsorship]" value="No">No</label><label><input type="radio" name="cards[synthetic][sponsorship]" value="Not Applicable">Not Applicable</label></div><button type="submit">Submit application</button></form>',async(page,payload)=>{
  const form=await readLeverForm(page),authorization=form.fields.find(f=>f.controlName==='cards[synthetic][authorization]'),sponsorship=form.fields.find(f=>f.controlName==='cards[synthetic][sponsorship]');
  payload.fields=form.fields;payload.answers={[authorization.key]:{value:'Yes'},[sponsorship.key]:{value:'No'}};
  assert.equal(authorization.required,false);assert.equal(sponsorship.required,false);
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.ok,true);assert.equal(result.filled,2);assert.equal(result.remaining,0);
  assert.deepEqual(await page.locator('input[type=radio]').evaluateAll(inputs=>inputs.map(input=>({name:input.name,value:input.value,checked:input.checked}))),[
   {name:'cards[synthetic][authorization]',value:'Yes',checked:true},{name:'cards[synthetic][authorization]',value:'No',checked:false},
   {name:'cards[synthetic][sponsorship]',value:'Yes',checked:false},{name:'cards[synthetic][sponsorship]',value:'No',checked:true},{name:'cards[synthetic][sponsorship]',value:'Not Applicable',checked:false}
  ]);
  assert.equal(await page.evaluate(()=>window.__submissions),0);
 });
 await fixture('lever','<h2>Product Manager</h2><form id="application-form"><div class="application-question"><label><span class="application-label">Name</span><input name="name"></label></div></form>',async(page,payload)=>{
  payload.fields=[{key:'name',controlName:'name',type:'text',label:'Name'}];payload.answers={name:{value:'Alex Example'}};
  assert.equal((await page.evaluate(fillApplication,{...payload,url:urls.lever+'?changed=1'})).ok,false);
  assert.equal((await page.evaluate(fillApplication,{...payload,title:'Different Job'})).ok,false);assert.equal(await page.locator('input').inputValue(),'');
 });
 await fixture('lever','<h2>Product Manager</h2><form id="application-form"><div class="application-question"><label><span class="application-label">Name</span><input name="name"></label></div><button type="submit">Submit application</button></form>',async(page,payload)=>{
  payload.priorSubmissionUnconfirmed=true;payload.status='uncertain';payload.fields=[{key:'name',controlName:'name',type:'text',label:'Name'}];payload.answers={name:{value:'Alex Example'}};
  assert.equal((await page.evaluate(fillApplication,{...payload,url:urls.lever+'?changed=1'})).ok,false);assert.equal(await page.locator('input').inputValue(),'');
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.ok,true);assert.equal(result.filled,1);assert.equal(result.priorSubmissionUnconfirmed,true);assert.equal(await page.locator('input').inputValue(),'Alex Example');
  const banner=await page.locator('#brb-application-helper').innerText();assert.match(banner,/previous submission attempt could not be confirmed and may already have succeeded/);assert.match(banner,/Check employer confirmation before submitting again/);assert.match(banner,/This helper only filled fields; it did not submit/);assert.doesNotMatch(banner,/BRB has not submitted/);
  await page.locator('#brb-application-helper').screenshot({path:'/private/tmp/brb-handoff-uncertain-qa.png'});
 });
 await fixture('greenhouse','<h1>Product Manager</h1><form id="application-form"><label for="first_name">First name *</label><input id="first_name"><span id="resume-label">Resume *</span><div class="file-upload" aria-labelledby="resume-label"><input type="file" id="resume"></div><fieldset><legend>Can you relocate?</legend><label for="yes">Yes</label><input type="radio" name="move" id="yes"><label for="no">No</label><input type="radio" name="move" id="no"></fieldset></form>',async(page,payload)=>{
  payload.fields=[{key:'name',controlId:'first_name',label:'First name',type:'text'},{key:'_systemfield_resume',controlId:'resume',label:'Resume',type:'file',document:'resume'},{key:'move',controlId:'yes',radioIds:['yes','no'],label:'Can you relocate?',type:'radio',options:['Yes','No']}];payload.answers={name:{value:'Alex'},_systemfield_resume:{value:'Resume.pdf'},move:{value:'No'}};
  payload.documents={...documents,resume:{...documents.resume,sha256:'0'.repeat(64)}};
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.filled,2);assert.equal(result.skipped[0].reason,'Document changed');assert.equal(await page.locator('#resume').evaluate(e=>e.files.length),0);assert.equal(await page.locator('#no').isChecked(),true);
 });
 await fixture('ashby','<h1>Product Manager</h1><main></main>',async(page,payload)=>{
  await page.evaluate(()=>setTimeout(()=>{document.querySelector('main').innerHTML='<div data-field-path="name"><label class="ashby-application-form-question-title">Full name</label><input></div><div data-field-path="available"><span class="ashby-application-form-question-title">Available?</span><button type="button" aria-pressed="false">Yes</button><button type="button" aria-pressed="false">No</button></div>';document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>b.setAttribute('aria-pressed','true')));},300));
  payload.fields=[{key:'name',label:'Full name',type:'text'},{key:'available',label:'Available?',type:'yesno',options:['Yes','No']}];payload.answers={name:{value:'Alex Example'},available:{value:'Yes'}};
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.filled,2);assert.equal(result.remaining,0);
 });
 await fixture('workable','<h1 data-ui="job-title">Product Manager</h1><form data-ui="application-form"><span id="name-label">First name</span><span id="help">Help</span><input name="firstname" aria-labelledby="name-label help"><span id="move-label">Can you relocate?</span><fieldset role="radiogroup" data-ui="move" aria-labelledby="move-label"><label><input type="radio" name="move">Yes</label><label><input type="radio" name="move">No</label></fieldset></form>',async(page,payload)=>{
  payload.fields=[{key:'firstname',label:'First name',type:'text'},{key:'move',label:'Can you relocate?',type:'radio',options:['Yes','No']}];payload.answers={firstname:{value:'Alex'},move:{value:'No'}};const result=await page.evaluate(fillApplication,payload);assert.equal(result.filled,2);assert.equal(result.remaining,0);
 });
 // Greenhouse's embeddable form: no <h1>, title only in document.title, and a grouped multi-answer checkbox question.
 await fixture('greenhouseEmbed','<title>Job Application for Product Manager at Example</title><h2>Apply for this job</h2><form id="application-form"><label for="first_name">First name *</label><input id="first_name"><fieldset id="countries"><legend>Which countries could you work in? *</legend><label for="c_us">United States</label><input type="checkbox" name="question_9[]" id="c_us"><label for="c_ca">Canada</label><input type="checkbox" name="question_9[]" id="c_ca" checked><label for="c_uk">United Kingdom</label><input type="checkbox" name="question_9[]" id="c_uk"></fieldset><button type="submit">Submit application</button></form>',async(page,payload)=>{
  payload.fields=[{key:'first_name',controlId:'first_name',label:'First name',type:'text',required:true},{key:'question_9[]',controlId:'countries',label:'Which countries could you work in?',type:'checkbox',multiple:true,required:true,options:['United States','Canada','United Kingdom'],checkboxIds:['c_us','c_ca','c_uk']}];
  payload.answers={first_name:{value:'Alex'},'question_9[]':{value:'United States\nUnited Kingdom'}};
  const result=await page.evaluate(fillApplication,payload);assert.equal(result.error,undefined,JSON.stringify(result));assert.equal(result.filled,2,JSON.stringify(result.skipped));
  assert.deepEqual(await page.evaluate(()=>['c_us','c_ca','c_uk'].map(id=>document.getElementById(id).checked)),[true,false,true],'exactly the chosen countries, preselected default cleared');
  assert.equal(await page.evaluate(()=>document.getElementById('first_name').value),'Alex');
  const wrong=await page.evaluate(fillApplication,{...payload,title:'Different role'});assert.match(wrong.error,/job title changed/);
 });
 assert.equal(writes,0);console.log(JSON.stringify({passed:cases,employerWrites:writes,screenshot:'/private/tmp/brb-handoff-qa.png'}));
}finally{await browser.close();}
