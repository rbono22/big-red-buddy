import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {leverApplicationURL,leverApplicationSupported,allowedLeverResource,readLeverForm,leverFingerprint} from '../lib/lever-browser.mjs';
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
