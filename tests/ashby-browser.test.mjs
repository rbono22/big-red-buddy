import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {fillAshbyApplication} from '../lib/ashby-browser.mjs';

// Exercise the omitted-answer contract against DOM controls; the standalone
// verify-ashby-browser script also runs it in Chrome with PDF-triggered autofill.
function fixture(type,control){
 const {document}=parseHTML(`<div data-field-path="optional">${control}</div>`);
 for(const input of document.querySelectorAll('input')){input.checked=input.hasAttribute('checked');input.files=[];}
 const locator=elements=>({
  locator:selector=>locator(elements.flatMap(element=>[...element.querySelectorAll(selector)])),
  getByRole:role=>locator(elements.flatMap(element=>[...element.querySelectorAll(`[role="${role}"]`)])),
  first:()=>locator(elements.slice(0,1)),filter:()=>locator(elements),
  count:async()=>elements.length,evaluateAll:async fn=>fn(elements),
  fill:async value=>{assert.equal(elements.length,1);elements[0].value=value;},
  inputValue:async()=>{assert.equal(elements.length,1);return elements[0].value;},
 });
 const page={locator:selector=>locator([...document.querySelectorAll(selector)])};
 return {page,document,form:{fields:[{key:'optional',label:'Optional answer',type,required:false,options:[]}]}};
}
const omit={optional:{value:null,reviewed:true}};

test('Ashby clears omitted optional text values instead of submitting page defaults',async()=>{
 for(const type of ['text','email','tel','textarea']){
  const f=fixture(type,type==='textarea'?'<textarea>Page default</textarea>':`<input type="${type}" value="Page default">`);
  await fillAshbyApplication(f.page,f.form,omit,{});
  assert.equal(f.document.querySelector('input,textarea').value,'');
 }
});

test('Ashby refuses preselected optional radios, yes/no values and locations',async()=>{
 for(const [type,control] of [['radio','<input type="radio" checked>'],['consent','<input type="radio" name="optional" checked>'],['yesno','<button aria-pressed="true">Yes</button><input type="checkbox">'],['yesno','<button aria-pressed="false">Yes</button><input type="checkbox" checked>'],['location','<input role="combobox" value="Unrequested location">']]){
  const f=fixture(type,control);await assert.rejects(fillAshbyApplication(f.page,f.form,omit,{}),{code:'UNREVIEWED_DEFAULT'});
 }
});

test('Ashby accepts empty omitted choices and files without selecting or uploading anything',async()=>{
 for(const [type,control] of [['radio','<input type="radio">'],['consent','<input type="radio" name="optional">'],['yesno','<button aria-pressed="false">Yes</button><input type="checkbox">'],['location','<input role="combobox" value="">'],['file','<input type="file">']]){
  const f=fixture(type,control);await fillAshbyApplication(f.page,f.form,omit,{});
  for(const input of f.document.querySelectorAll('input'))assert.equal(input.checked,false);
 }
});

test('Ashby requires an explicit reviewed omission and refuses preloaded optional files',async()=>{
 const f=fixture('file','<input type="file">');
 await assert.rejects(fillAshbyApplication(f.page,f.form,{optional:{value:null,reviewed:false}},{}),{code:'MISSING_ANSWER'});
 f.document.querySelector('input').files=[{name:'Unreviewed.pdf'}];
 await assert.rejects(fillAshbyApplication(f.page,f.form,omit,{}),{code:'UNREVIEWED_DEFAULT'});
});

async function readAshby(markup){
 const {document}=parseHTML(`<h1>Example role</h1>${markup}`),prior=globalThis.document;
 for(const input of document.querySelectorAll('input'))input.multiple=input.hasAttribute('multiple');
 for(const input of document.querySelectorAll('textarea'))input.type='textarea';
 globalThis.document=document;
 try{return await (await import('../lib/ashby-browser.mjs')).readAshbyForm({evaluate:fn=>fn()});}finally{if(prior===undefined)delete globalThis.document;else globalThis.document=prior;}
}
const coverField=(type='file',extra='',label='Cover letter')=>`<div data-field-path="cover-document"><label class="ashby-application-form-question-title">${label}</label>${type==='textarea'?`<textarea required ${extra}></textarea>`:`<input type="${type}" required ${extra}>`}</div>`;
test('Ashby recognizes an explicit cover-letter file or text field and carries length limits',async()=>{
 const file=(await readAshby(coverField('file','accept="application/pdf,.docx"'))).fields[0];assert.equal(file.purpose,'coverLetter');assert.equal(file.type,'file');assert.equal(file.required,true);
 const text=(await readAshby(coverField('textarea','maxlength="1400"'))).fields[0];assert.equal(text.purpose,'coverLetter');assert.equal(text.maxLength,1400);
});
test('Ashby refuses unrelated attachments, multiple files and non-PDF-only cover uploads',async()=>{
 for(const markup of [coverField('file','','Portfolio sample'),coverField('file','accept=".docx"'),coverField('file','multiple')])await assert.rejects(readAshby(markup),{code:'UNSUPPORTED_FORM'});
});

function uploadFixture(){
 const fields=[{key:'_systemfield_resume',label:'Resume',type:'file',required:true,options:[]},{key:'cover',label:'Cover letter',type:'file',required:true,options:[],purpose:'coverLetter'}];
 const {document}=parseHTML(fields.map(f=>`<div data-field-path="${f.key}"><input type="file"></div>`).join('')),uploads=[];
 for(const input of document.querySelectorAll('input'))input.files=[];
 const locator=elements=>({locator:selector=>locator(elements.flatMap(e=>[...e.querySelectorAll(selector)])),evaluateAll:async fn=>fn(elements),filter:()=>locator(elements),count:async()=>elements.length,getByText:name=>({waitFor:async()=>assert.ok(elements.some(e=>e.textContent.includes(name)))}),setInputFiles:async data=>{assert.equal(elements.length,1);const e=elements[0];e.files=[{name:data.name,size:data.buffer.length}];const span=document.createElement('span');span.textContent=data.name;e.parentElement.append(span);uploads.push({key:e.parentElement.dataset.fieldPath,...data});}});
 return {document,uploads,page:{locator:selector=>locator([...document.querySelectorAll(selector)])},form:{fields}};
}
test('Ashby uploads the required cover PDF separately from the saved resume',async()=>{
 const f=uploadFixture(),resume={name:'Resume.pdf',file:Buffer.from('%PDF-1.7 resume').toString('base64')},coverLetter={name:'Cover Letter.pdf',file:Buffer.from('%PDF-1.7 tailored cover letter').toString('base64')};
 await fillAshbyApplication(f.page,f.form,{_systemfield_resume:{value:resume.name,reviewed:true},cover:{value:coverLetter.name,reviewed:true}},resume,coverLetter);
 assert.equal(f.uploads.length,2);assert.equal(f.uploads[0].key,'_systemfield_resume');assert.equal(f.uploads[0].buffer.toString(),'%PDF-1.7 resume');assert.equal(f.uploads[1].key,'cover');assert.equal(f.uploads[1].buffer.toString(),'%PDF-1.7 tailored cover letter');
});
test('Ashby never replaces a missing cover letter with the saved resume',async()=>{
 const f=uploadFixture(),resume={name:'Resume.pdf',file:Buffer.from('%PDF-1.7 resume').toString('base64')};
 await assert.rejects(fillAshbyApplication(f.page,f.form,{_systemfield_resume:{value:resume.name,reviewed:true},cover:{value:'Cover Letter.pdf',reviewed:true}},resume));assert.equal(f.uploads.length,0);
});
