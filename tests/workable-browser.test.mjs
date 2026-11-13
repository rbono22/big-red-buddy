import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {workableApplicationURL,workableApplicationSupported,allowedWorkableResource,readWorkableForm,workableFingerprint} from '../lib/workable-browser.mjs';
const URL='https://apply.workable.com/valsoft-corp/j/4560CF5DD0/apply/';
const html=await readFile(new globalThis.URL('./fixtures/workable-valsoft-form.html',import.meta.url),'utf8');
async function read(mutator=()=>{}){
 const {document}=parseHTML(html);mutator(document);
 const prior=globalThis.document;globalThis.document=document;
 try{return await readWorkableForm({evaluate:fn=>fn()});}finally{if(prior===undefined)delete globalThis.document;else globalThis.document=prior;}
}
test('Workable canonical URL is limited to the inspected employer and strict HTTPS job paths',()=>{
 assert.equal(workableApplicationURL(URL.replace('/apply/','/')),URL);
 for(const v of [URL+'?next=evil',URL+'#fragment',URL.replace('https:','http:'),URL.replace('apply.workable.com','apply.workable.com.evil.test'),URL.replace('https://','https://user:pass@'),URL.replace('/valsoft-corp/','/unverified-employer/'),URL.replace('4560CF5DD0','abc'),URL.replace('apply.workable.com','apply.workable.com:444')])assert.equal(workableApplicationURL(v),'');
});
test('Workable resources use only fixed observed hosts',()=>{
 assert.equal(allowedWorkableResource('https://workable-application-form.s3.us-east-1.amazonaws.com/file'),true);
 for(const v of ['https://evil.test','http://127.0.0.1','https://workable-application-form.s3.us-east-1.amazonaws.com.evil.test/file','https://user:pass@apply.workable.com','https://apply.workable.com:444'])assert.equal(allowedWorkableResource(v),false);
});
test('Workable support respects the application browser switch',()=>{
 const old=process.env.APPLICATION_BROWSER_ENABLED;
 try{delete process.env.APPLICATION_BROWSER_ENABLED;assert.equal(workableApplicationSupported({url:URL}),false);process.env.APPLICATION_BROWSER_ENABLED='true';assert.equal(workableApplicationSupported({url:URL}),true);assert.equal(workableApplicationSupported({url:'https://example.test/'}),false);}finally{if(old===undefined)delete process.env.APPLICATION_BROWSER_ENABLED;else process.env.APPLICATION_BROWSER_ENABLED=old;}
});
test('Workable reads captured native controls and employer questions without inferred answers',async()=>{
 const f=await read();assert.equal(f.title,'Commercial Lead - Sales & Partnerships');assert.equal(f.fields.length,10);
 assert.deepEqual(f.fields.map(x=>x.key),['firstname','lastname','email','phone','address','CA_29438','_systemfield_resume','QA_12789816','QA_12789817','QA_12789818']);
 assert.equal(f.fields[0].profileField,'firstName');assert.equal(f.fields[3].profileField,'phone');assert.equal(f.fields[5].label,'Salary expectations');assert.equal(f.fields[9].profileField,undefined);assert.deepEqual(f.fields[9].options,['YES','NO']);
 assert.ok(f.fields.every(x=>x.required));assert.match(f.consentText,/gdpr_policy/);assert.match(f.consentText,/ccpa_policy/);
});
test('Workable rejects extra files, hidden answers, disabled fields and unsupported controls',async()=>{
 const extra=markup=>d=>d.querySelector('form').insertAdjacentHTML('beforeend',markup);
 for(const mutate of [extra('<input type="file" name="other" required>'),extra('<input type="hidden" name="secret-answer" value="yes">'),extra('<select name="unreviewed"><option>Yes</option></select>'),extra('<input role="combobox" name="city2">'),extra('<div contenteditable="true">Write</div>'),d=>d.querySelector('[name="firstname"]').disabled=true,d=>d.querySelector('[name="city"]').value='unreviewed',extra('<button type="button">Add experience</button>')])await assert.rejects(read(mutate),{code:'UNSUPPORTED_FORM'});
});
test('Workable rejects duplicate keys and additional form sections with hidden editors',async()=>{
 await assert.rejects(read(d=>d.querySelector('[name="lastname"]').setAttribute('data-ui','firstname')),{code:'UNSUPPORTED_FORM'});
 await assert.rejects(read(d=>d.querySelector('[data-ui="section-fields"]').insertAdjacentHTML('beforeend','<div>Add education</div>')),{code:'UNSUPPORTED_FORM'});
});
test('Workable fingerprints include title, question wording, requirement and policy links',async()=>{
 const original=await read(),fingerprint=workableFingerprint(original);
 for(const mutate of [d=>d.querySelector('h1').textContent='Different role',d=>d.querySelector('#QA_12789816_label').textContent='Changed question',d=>{const i=d.querySelector('[name="firstname"]');i.removeAttribute('required');i.setAttribute('aria-required','false');},d=>d.querySelector('[data-ui="footer-gdpr"] a').setAttribute('href','https://example.test/policy')])assert.notEqual(workableFingerprint(await read(mutate)),fingerprint);
});
