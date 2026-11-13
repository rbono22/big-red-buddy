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
