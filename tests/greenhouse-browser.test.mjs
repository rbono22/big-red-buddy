import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseHTML} from 'linkedom';
import {greenhouseApplicationURL,greenhouseApplicationSupported,allowedGreenhouseResource,greenhouseDOMSnapshot,normalizeGreenhouseSnapshot,greenhouseFingerprint,validateGreenhouseAnswers} from '../lib/greenhouse-browser.mjs';
const APP_URL='https://job-boards.greenhouse.io/reddit/jobs/8023563';
const html=await readFile(new URL('./fixtures/greenhouse-synthetic-application.html',import.meta.url),'utf8').catch(()=>null);
function snapshot(markup=html){const {document}=parseHTML(markup),old=globalThis.document;globalThis.document=document;try{return greenhouseDOMSnapshot();}finally{if(old===undefined)delete globalThis.document;else globalThis.document=old;}}
function form(){const f=normalizeGreenhouseSnapshot(snapshot());for(const field of f.fields)if(field.type==='select'&&field.widget==='combobox')field.options=field.key==='country'?['United States +1','Canada +1']:field.key==='identity'?['Choice A','Choice B','Prefer not to answer']:['Yes','No'];return f;}
function answers(f){return Object.fromEntries(f.fields.map(field=>[field.key,{reviewed:true,value:field.type==='file'?'Example.pdf':field.options[0]||'Example'}]));}
const resume={file:Buffer.from('%PDF-1.7\nSynthetic fixture').toString('base64'),name:'Example.pdf'};

test('canonical Greenhouse destinations accept known tracking only and reject host confusion',()=>{
 assert.equal(greenhouseApplicationURL(APP_URL+'?gh_src=example&utm_source=news'),APP_URL);
 assert.equal(greenhouseApplicationURL(APP_URL.replace('job-boards.','boards.')+'/'),APP_URL);
 assert.equal(greenhouseApplicationURL(APP_URL.replace('/reddit/','/figma/')),APP_URL.replace('/reddit/','/figma/'));
 for(const u of [APP_URL+'?redirect=https://evil.test',APP_URL+'#fragment',APP_URL.replace('https:','http:'),APP_URL.replace('greenhouse.io','greenhouse.io.evil.test'),APP_URL.replace('https://','https://user:pass@'),APP_URL.replace('.io/','.io:444/'),APP_URL.replace('/jobs/','/apply/'),APP_URL.replace('/8023563','/not-a-number'),'https://127.0.0.1/reddit/jobs/123'])assert.equal(greenhouseApplicationURL(u),'');
});
test('provider feature flag and fixed request allowlist fail closed',()=>{
 const previous=process.env.APPLICATION_BROWSER_ENABLED;
 try{process.env.APPLICATION_BROWSER_ENABLED='false';assert.equal(greenhouseApplicationSupported({url:APP_URL}),false);process.env.APPLICATION_BROWSER_ENABLED='true';assert.equal(greenhouseApplicationSupported({url:APP_URL}),true);assert.equal(greenhouseApplicationSupported({url:'https://example.org/jobs'}),false);}finally{if(previous===undefined)delete process.env.APPLICATION_BROWSER_ENABLED;else process.env.APPLICATION_BROWSER_ENABLED=previous;}
 for(const u of ['https://job-boards.greenhouse.io/reddit/jobs/8023563','https://api-geocode-earth-proxy.greenhouse.io/search','https://job-boards.cdn.greenhouse.io/asset.js'])assert.equal(allowedGreenhouseResource(u),true);
 for(const u of ['http://job-boards.greenhouse.io/','https://localhost/','https://job-boards.greenhouse.io.evil.test/','https://job-boards.greenhouse.io:8443/','https://x:y@job-boards.greenhouse.io/','https://accounts.google.com/','wss://job-boards.greenhouse.io/','https://evil.greenhouse.io/'])assert.equal(allowedGreenhouseResource(u),false);
});
test('all native and observed hosted controls are represented, with no demographic inference',()=>{
 const f=form();assert.equal(f.title,'Example Analyst');assert.equal(f.fields.length,14);
 assert.equal(f.fields.find(f=>f.key==='_systemfield_resume').required,true);
 assert.equal(f.fields.find(f=>f.key==='first_name').profileField,'firstName');
 assert.equal(f.fields.find(f=>f.key==='email').type,'email');
 assert.equal(f.fields.find(f=>f.key==='candidate-location').type,'location');
 assert.equal(f.fields.find(f=>f.key==='identity').multiple,true);
 assert.equal(f.fields.find(f=>f.key==='identity').profileField,undefined);
 assert.equal(f.fields.find(f=>f.key==='work_auth').profileField,undefined);
 assert.deepEqual(f.fields.find(f=>f.key==='contact').options,['Email','Phone']);
 assert.match(f.consentText,/Example privacy notice/);
});
test('unknown, duplicated, oversized or attachment-only extra controls refuse the whole form',()=>{
 for(const addition of ['<input id="unknown" type="date">','<label for="first_name">Duplicate</label><input id="first_name">','<div contenteditable="true">Unknown</div>','<label for="other_file">Certificate</label><input id="other_file" type="file">','<input aria-hidden="true" tabindex="-1">'])assert.throws(()=>normalizeGreenhouseSnapshot(snapshot(html.replace('</form>',addition+'</form>'))),/UNSUPPORTED_FORM/);
 const s=snapshot();s.fields[0].label='X'.repeat(1801);assert.throws(()=>normalizeGreenhouseSnapshot(s),/UNSUPPORTED_FORM/);
});
test('reviewed exact choices, explicit optional skips and valid resume required before filling',()=>{
 const f=form(),a=answers(f);assert.doesNotThrow(()=>validateGreenhouseAnswers(f,a,resume));
 a.identity.value='Choice A\nChoice B';assert.doesNotThrow(()=>validateGreenhouseAnswers(f,a,resume));
 a.identity.value='Choice A\nBogus';assert.throws(()=>validateGreenhouseAnswers(f,a,resume),/INVALID_CHOICE/);
 a.identity.value=null;a.cover_letter_text.value=null;assert.doesNotThrow(()=>validateGreenhouseAnswers(f,a,resume));
 a.notice.value='No';assert.throws(()=>validateGreenhouseAnswers(f,a,resume),/REQUIRED_CONSENT_DECLINED/);a.notice.value='Yes';
 a.first_name.reviewed=false;assert.throws(()=>validateGreenhouseAnswers(f,a,resume),/MISSING_ANSWER/);a.first_name.reviewed=true;
 a.first_name.value=null;assert.throws(()=>validateGreenhouseAnswers(f,a,resume),/MISSING_ANSWER/);a.first_name.value='Example';
 assert.throws(()=>validateGreenhouseAnswers(f,a,{file:Buffer.from('not a PDF').toString('base64')}),/INVALID_RESUME/);
});
test('fingerprints bind question options, legal notice, and job title to the review',()=>{
 const base=form();for(const change of [f=>f.title='Different job',f=>f.fields[0].required=false,f=>f.fields.find(x=>x.key==='identity').options.push('New choice'),f=>f.consentText+=' Changed terms']){const f=structuredClone(base);change(f);assert.notEqual(greenhouseFingerprint(f),greenhouseFingerprint(base));}
});
