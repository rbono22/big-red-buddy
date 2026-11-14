import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {parseHTML} from 'linkedom';
import {scanApplication} from '../browser-extension/scan.mjs';

const url='https://careers.example.org/apply/product-manager';
function fixture(markup,{address=url}={}){
 const {document,HTMLElement}=parseHTML(`<html><head><title>Job application</title></head><body>${markup}</body></html>`);
 HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden],[style*="display:none"],[style*="display: none"]')?[]:[{}];};
 for(const input of document.querySelectorAll('input,textarea,select')){
  Object.defineProperties(input,{
   labels:{get(){return [...document.querySelectorAll('label')].filter(e=>e.getAttribute('for')===this.id&&this.id||e.contains(this));}},
   form:{get(){return this.closest('form');}},
   required:{get(){return this.hasAttribute('required');}},
   multiple:{get(){return this.hasAttribute('multiple');}},
   readOnly:{get(){return this.hasAttribute('readonly');}},
   maxLength:{get(){return Number(this.getAttribute('maxlength')||-1);}},
  });
  if(input.tagName==='SELECT')Object.defineProperty(input,'options',{get(){return [...this.querySelectorAll('option')];}});
 }
 const world=vm.createContext({document,URL,Uint8Array,crypto:webcrypto,location:{href:address},getComputedStyle:e=>({display:e.style.display||'block',visibility:e.style.visibility||'visible'})});
 return {document,world,scan:()=>vm.runInContext(`(${scanApplication.toString()})()`,world)};
}
const contact='<label>Full name<input name="name" autocomplete="name" required></label><label>Email<input name="email" type="email" required></label>';
const json=value=>JSON.parse(JSON.stringify(value));

test('standalone scanner serializes labelled fields, not applicant answers or page content',()=>{
 const f=fixture(`<h1>Product Manager</h1><p>Private arbitrary page text</p><form>${contact}<label>Phone<input type="tel" value="secret-phone"></label><label>Why this company?<textarea maxlength="500">Private draft</textarea></label><label>Résumé<input type="file" accept=".pdf"></label></form>`);
 f.document.querySelector('[name=name]').value='Private applicant name';
 const result=f.scan();assert.equal(result.ok,true);assert.match(result.scanId,/^[a-f0-9]{32}$/);assert.equal(result.title,'Product Manager');
 assert.deepEqual(json(result.fields.map(field=>field.type)),['text','email','tel','textarea','file']);
 assert.equal(result.fields[3].maxLength,500);assert.equal(result.fields[4].document,'resume');assert.equal(result.fields[4].accept,'.pdf');
 assert.doesNotMatch(JSON.stringify(result),/Private|secret-phone|page text/);assert.equal(result.fields[0].required,true);
});
test('standalone scanner recognizes autocomplete-only contact steps',()=>{
 const result=fixture('<form><input autocomplete="given-name"><input autocomplete="email" type="email"></form>').scan();
 assert.equal(result.ok,true);assert.deepEqual(json(result.fields.map(field=>field.label)),['First name','Email']);
});
test('standalone scanner groups exact native choices, including multi-selects and checkbox groups',()=>{
 const result=fixture(`<form>${contact}<fieldset><legend>Work authorization</legend><label><input id="yes" name="work" type="radio" value="1">Yes</label><label><input id="no" name="work" type="radio" value="0">No</label></fieldset><fieldset><legend>Preferred offices</legend><label><input id="ny" type="checkbox" name="office" value="nyc">New York</label><label><input id="sf" type="checkbox" name="office" value="sf">San Francisco</label></fieldset><label>Skills<select multiple><option value="sql">SQL</option><option value="py">Python</option></select></label><label><input type="checkbox" name="updates">Recruiting updates</label></form>`).scan();
 assert.equal(result.ok,true);const work=result.fields.find(field=>field.label==='Work authorization');assert.deepEqual(json(work.options),['Yes','No']);assert.deepEqual(json(work.optionValues),['1','0']);assert.deepEqual(json(work.radioIds),['yes','no']);
 const offices=result.fields.find(field=>field.label==='Preferred offices');assert.equal(offices.multiple,true);assert.deepEqual(json(offices.checkboxIds),['ny','sf']);
 const multi=result.fields.find(field=>field.type==='select');assert.equal(multi.multiple,true);assert.deepEqual(json(multi.optionValues),['sql','py']);
 assert.deepEqual(json(result.fields.at(-1).options),['Yes','No']);
});
test('standalone scanner excludes credentials, hidden values, sensitive identifiers and disabled fields',()=>{
 const result=fixture(`<form>${contact}<label>Password<input type="password" value="password-secret"></label></form><form>${contact}<input type="hidden" value="token-secret"><label>Social Security number<input value="ssn-secret"></label><label>Bank account<input value="bank-secret"></label><label>Hidden<input hidden value="hidden-secret"></label><label>Disabled<input disabled></label><label>Read-only<input readonly></label><button>Submit</button></form>`).scan();
 assert.equal(result.ok,true);assert.equal(result.fields.length,2);assert.doesNotMatch(JSON.stringify(result),/secret|Password|Social Security|Bank account|Hidden|Disabled|Read-only|Submit/);
});
test('standalone scanner refuses login/contact pages and sends no embedded frame contents',()=>{
 const login=fixture(`<h1>Sign in</h1><form>${contact}<input type="password"></form>`).scan();assert.equal(login.ok,false);
 const contactPage=fixture(`<form>${contact}</form>`);contactPage.document.title='Contact us';assert.equal(contactPage.scan().ok,false);
 const frame=fixture('<iframe src="https://jobs.example.org/apply"></iframe>').scan();assert.equal(frame.ok,false);assert.match(frame.error,/own tab/);
});
test('standalone scanner refuses local/private/insecure destinations',()=>{
 for(const address of ['http://jobs.example.org/apply','https://127.0.0.1/apply','https://10.0.0.1/apply','https://[::1]/apply','https://localhost/apply','https://host.local/apply','https://host.internal/apply','https://user:password@jobs.example.org/apply','https://jobs.example.org:8443/apply','https://app.bigredbuddy.com/'])assert.equal(fixture(contact,{address}).scan().ok,false,address);
});
test('standalone scanner bounds metadata and invalidates a prior scan if the form disappears',()=>{
 const f=fixture(`<form>${contact}${Array.from({length:90},(_,i)=>`<label>Question ${i}<input></label>`).join('')}</form>`);
 const first=f.scan();assert.equal(first.ok,true);assert.equal(first.fields.length,70);assert.equal(new Set(first.fields.map(field=>field.key)).size,70);
 const second=f.scan();assert.notEqual(second.scanId,first.scanId);f.document.body.innerHTML='<p>Gone</p>';assert.equal(f.scan().ok,false);assert.equal(f.world.__brbApplicationScan,undefined);
});
test('standalone scanner sees a hidden native résumé input with a visible upload label',()=>{
 const f=fixture('<label for="resume">Upload résumé</label><input id="resume" type="file" style="display:none">');
 assert.equal(f.scan().ok,true);assert.equal(f.scan().fields[0].key,'_systemfield_resume');
});
