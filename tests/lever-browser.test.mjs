import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {leverApplicationURL,leverApplicationSupported,allowedLeverResource,readLeverForm,leverFingerprint,fillLeverApplication} from '../lib/lever-browser.mjs';
const url='https://jobs.lever.co/tenna/ed0a2111-ff61-40a8-aed9-23c1081d97dd/apply';
const html=await readFile(new URL('./fixtures/lever-tenna-application.html',import.meta.url),'utf8');
function page(markup=html){return {evaluate:async fn=>{const prior=globalThis.document,css=globalThis.getComputedStyle;globalThis.document=parseHTML(markup).document;globalThis.getComputedStyle=e=>({display:e.style.display||'block',visibility:e.style.visibility||'visible'});try{return fn();}finally{globalThis.document=prior;globalThis.getComputedStyle=css;}}};}
test('Lever URL accepts exact public hosted posting/application and strips only known tracking',()=>{
 assert.equal(leverApplicationURL(url),url);assert.equal(leverApplicationURL(url.replace('/apply','')+'?lever-source=LinkedIn&utm_source=email'),url);
 for(const bad of ['http://jobs.lever.co/tenna/ed0a2111-ff61-40a8-aed9-23c1081d97dd/apply',url+'?next=https://evil.example',url+'#x',url+'#',url.replace('jobs.lever.co','jobs.lever.co.evil.example'),url.replace('jobs.lever.co','name:pass@jobs.lever.co'),url.replace('jobs.lever.co','jobs.lever.co:443'),url.replace('/tenna/','/foo/../tenna/'),url.replace('/tenna/','/foo/%2e%2e/tenna/'),url.replace('/tenna/','/tenna%2f/'),url+'/extra',url.replace('jobs.lever.co','127.0.0.1')])assert.equal(leverApplicationURL(bad),'',bad);
});
test('Lever live submission has an explicit environment gate',()=>{
 const prior=process.env.APPLICATION_BROWSER_ENABLED;try{delete process.env.APPLICATION_BROWSER_ENABLED;assert.equal(leverApplicationSupported({url}),false);process.env.APPLICATION_BROWSER_ENABLED='true';assert.equal(leverApplicationSupported({applyUrl:url}),true);assert.equal(leverApplicationSupported({url:'https://example.com'}),false);}finally{if(prior===undefined)delete process.env.APPLICATION_BROWSER_ENABLED;else process.env.APPLICATION_BROWSER_ENABLED=prior;}
});
test('Lever resource scope excludes alternate hosts and non-HTTPS schemes',()=>{
 for(const host of ['jobs.lever.co','cdn.lever.co','js.hcaptcha.com','newassets.hcaptcha.com'])assert.equal(allowedLeverResource(`https://${host}/a`),true);
 for(const bad of ['http://jobs.lever.co','https://jobs.lever.co.evil.example','https://evil.hcaptcha.com','https://www.googletagmanager.com','file:///etc/passwd','https://127.0.0.1/','https://user:secret@jobs.lever.co','https://jobs.lever.co:123/'])assert.equal(allowedLeverResource(bad),false);
});
test('Captured public Tenna form is parsed with stable keys, custom questions, exact choices and no inferred eligibility',async()=>{
 const form=await readLeverForm(page());assert.equal(form.title,'Product Manager');assert.equal(form.fields.length,35);assert.equal(new Set(form.fields.map(f=>f.key)).size,35);
 assert.equal(form.fields[0].key,'_systemfield_resume');assert.equal(form.fields[0].required,true);assert.equal(form.fields.find(f=>f.controlName==='name').profileField,'fullName');assert.equal(form.fields.find(f=>f.controlName==='location').type,'location');
 assert.equal(form.fields.find(f=>f.controlName==='org').profileField,'currentCompany');assert.equal(form.fields.find(f=>f.controlName==='org').required,true);
 const sponsorship=form.fields.find(f=>f.label.includes('require sponsorship'));assert.equal(sponsorship.type,'select');assert.deepEqual(sponsorship.options,['Yes','No']);assert.equal(sponsorship.profileField,undefined);
 assert.ok(form.fields.find(f=>f.label.includes('full-time product management')).options.includes('6+'));assert.equal(leverFingerprint(form),leverFingerprint(await readLeverForm(page())));
});
test('Unseen files, disabled controls and conditional signatures are never silently omitted',async()=>{
 for(const extra of ['<input type="file" name="coverLetter">','<input name="secret" disabled>','<div style="display:none"><input required name="signature"></div>','<div role="combobox">Choose value</div>'])await assert.rejects(readLeverForm(page(html.replace('</form>',`<li class="application-question"><span class="application-label">Additional question</span>${extra}</li></form>`))),/UNSUPPORTED_FORM/);
});
test('Submission destination or method changes are refused',async()=>{
 await assert.rejects(readLeverForm(page(html.replace('method="POST"','method="GET"'))),/UNSUPPORTED_FORM/);
 await assert.rejects(readLeverForm(page(html.replace('method="POST"','method="POST" action="https://elsewhere.example/submit"'))),/UNSUPPORTED_FORM/);
});
test('Single consent checkbox has explicit Yes/No and no default inferred answer',async()=>{
 const form=await readLeverForm(page(html.replace('</form>','<li class="application-question"><label class="application-label">Recruiting updates by SMS<input name="smsConsent" type="checkbox"></label></li></form>')));assert.deepEqual(form.fields.at(-1).options,['Yes','No']);assert.equal(form.fields.at(-1).profileField,undefined);
});

test('Native checkbox groups and multiple selects keep exact labels and require explicit reviewed choices',async()=>{
 const form=await readLeverForm(page(html.replace('</form>','<li class="application-question"><span class="application-label">Options</span><label><input type="checkbox" name="choices" value="a">First</label><label><input type="checkbox" name="choices" value="b">Second</label></li><li class="application-question"><span class="application-label">Multiple select</span><select name="multi" multiple><option value="1">One</option><option value="2">Two</option></select></li></form>')));
 assert.equal(form.fields.at(-2).multiple,true);assert.deepEqual(form.fields.at(-2).options,['First','Second']);assert.equal(form.fields.at(-1).multiple,true);assert.deepEqual(form.fields.at(-1).optionValues,['1','2']);
});

test('Lever recognizes explicit cover-letter text and PDF controls, and refuses unrelated or unsupported uploads',async()=>{
 const extra='<li class="application-question"><label class="application-label">Cover letter<input name="coverLetter" type="file" accept="application/pdf" required></label></li>';
 const form=await readLeverForm(page(html.replace('</form>',extra+'</form>'))),cover=form.fields.at(-1);
 assert.equal(cover.purpose,'coverLetter');assert.equal(cover.required,true);assert.equal(cover.controlName,'coverLetter');assert.notEqual(cover.key,'_systemfield_resume');assert.equal(cover.accept,'application/pdf');
 const written=await readLeverForm(page(html.replace('</form>','<li class="application-question"><label class="application-label">Please provide your cover letter<textarea name="coverText" maxlength="1600" required></textarea></label></li></form>')));
 assert.equal(written.fields.at(-1).purpose,'coverLetter');assert.equal(written.fields.at(-1).maxLength,1600);
 for(const invalid of [extra.replace('application/pdf','.docx'),extra.replace('type="file"','type="file" multiple'),extra.replace('Cover letter','Work sample')])await assert.rejects(readLeverForm(page(html.replace('</form>',invalid+'</form>'))),/UNSUPPORTED_FORM/);
});

// Use real DOM values, including the location value the employer actually posts.
// The browser verification script separately exercises the full captured form.
async function omittedFixture({selectedLocation='',visibleLocation='',files=[],afterUpload,afterFill,extraHTML=''}={}){
 const {document}=parseHTML('<h2>Fixture role</h2><form id="application-form" method="POST"><div class="application-question"><label class="application-label">Resume</label><input type="file" name="resume"></div><div class="application-question"><label class="application-label">Current location</label><input type="text" name="location" class="location-input"></div><input type="hidden" id="selected-location" name="selectedLocation"><div class="application-question"><label class="application-label">Optional text</label><input type="text" name="extra"></div><div class="resume"><span class="filename"></span></div><div class="resume-upload-working"></div>'+extraHTML+'</form>');
 document.querySelector('[name=resume]').files=files;
 document.querySelector('[name=location]').value=visibleLocation;
 document.querySelector('#selected-location').value=selectedLocation;
 document.querySelector('#application-form').checkValidity=()=>true;
 const locator=elements=>({
  filter:()=>locator(elements),count:async()=>elements.length,
  evaluateAll:async fn=>fn(elements),evaluate:async fn=>{assert.equal(elements.length,1);return fn(elements[0]);},
  fill:async value=>{assert.equal(elements.length,1);elements[0].value=value;afterFill?.(document,elements[0]);},
  blur:async()=>{},inputValue:async()=>{assert.equal(elements.length,1);return elements[0].value;},
  setChecked:async value=>{assert.equal(elements.length,1);assert.equal(elements[0].type,'checkbox');elements[0].checked=value;},
  isChecked:async()=>{assert.equal(elements.length,1);return !!elements[0].checked;},
  setInputFiles:async file=>{assert.equal(elements.length,1);elements[0].files=[{name:file.name,size:file.buffer.length}];document.querySelector('.filename').textContent=file.name;afterUpload?.(document);},
  waitFor:async()=>{},
 });
 const fixturePage={locator:selector=>locator([...document.querySelectorAll(selector)]),evaluate:async fn=>{
  const prior=globalThis.document,css=globalThis.getComputedStyle;globalThis.document=document;globalThis.getComputedStyle=e=>({display:e.style.display||'block',visibility:e.style.visibility||'visible'});
  try{return fn();}finally{globalThis.document=prior;globalThis.getComputedStyle=css;}
 }};
 const form=await readLeverForm(fixturePage),answers=Object.fromEntries(form.fields.map(f=>[f.key,{value:null,reviewed:true}]));
 return {page:fixturePage,document,form,answers};
}

test('Lever refuses an omitted location with a stale hidden selection even when its visible input is empty',async()=>{
 for(const visibleLocation of ['', 'Unrequested city']){
  const f=await omittedFixture({visibleLocation,selectedLocation:JSON.stringify({name:'Unrequested city',id:'stale'})});
  await assert.rejects(fillLeverApplication(f.page,f.form,f.answers,{}),{code:'UNREVIEWED_DEFAULT'});
  assert.equal(f.document.querySelector('[name=location]').value,'');
 }
});

test('Lever accepts truly empty omitted location and resume without uploading a saved file',async()=>{
 const f=await omittedFixture();
 await fillLeverApplication(f.page,f.form,f.answers,{name:'Should not upload.pdf',file:Buffer.from('%PDF-1.7 fixture').toString('base64')});
 assert.deepEqual(f.document.querySelector('[name=resume]').files,[]);
 assert.equal(f.document.querySelector('#selected-location').value,'');
});

test('Lever refuses omitted files already present or introduced after initial field validation',async()=>{
 const initial=await omittedFixture({files:[{name:'Unreviewed.pdf',size:100}]});
 await assert.rejects(fillLeverApplication(initial.page,initial.form,initial.answers,{}),{code:'UNREVIEWED_DEFAULT'});
 const changed=await omittedFixture({afterFill:(document,input)=>{if(input.name==='extra')document.querySelector('[name=resume]').files=[{name:'Injected.pdf',size:100}];}});
 await assert.rejects(fillLeverApplication(changed.page,changed.form,changed.answers,{}),{code:'FIELD_CHANGED_AFTER_UPLOAD'});
});

test('Lever refuses hidden location autofill after a resume upload while the visible omitted location stays empty',async()=>{
 const f=await omittedFixture({afterUpload:document=>{document.querySelector('#selected-location').value=JSON.stringify({name:'PDF inferred city',id:'autofill'});}});
 f.answers._systemfield_resume={value:'Synthetic.pdf',reviewed:true};
 await assert.rejects(fillLeverApplication(f.page,f.form,f.answers,{name:'Synthetic.pdf',file:Buffer.from('%PDF-1.7 fixture').toString('base64')}),{code:'FIELD_CHANGED_AFTER_UPLOAD'});
 assert.equal(f.document.querySelector('[name=location]').value,'');
});

test('Lever fills the consent checkbox without selecting its same-name hidden false fallback',async()=>{
 const f=await omittedFixture({extraHTML:'<div class="application-question"><span class="application-label">Future recruiting opportunities</span><input type="hidden" name="consent[marketing]" value="false"><input type="checkbox" name="consent[marketing]" value="true"></div>'});
 const field=f.form.fields.find(field=>field.controlName==='consent[marketing]');assert.equal(field.type,'checkbox');assert.equal(f.form.fields.filter(field=>field.controlName==='consent[marketing]').length,1);
 for(const value of [null,'Yes','No']){
  f.answers[field.key]={value,reviewed:true};await fillLeverApplication(f.page,f.form,f.answers,{});
  assert.equal(f.document.querySelector('input[type=checkbox]').checked,value==='Yes');
  assert.equal(f.document.querySelector('input[type=hidden][name="consent[marketing]"]').value,'false');
 }
});
