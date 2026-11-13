import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {affirmativeOption,isStandingConsentField,standingConsentAnswer,acceptedConsentLabels,STANDING_CONSENT_SOURCE} from '../lib/application-consent.mjs';
import {saveApplicationAutopilot,saveCareerProfile,getCareerProfile} from '../lib/career.mjs';
import {quickApplicationAnswers,startLiveApplication,executeLiveApplication,handleLiveApplicationAction,handleLiveApplicationMessage} from '../lib/live-applications.mjs';
import {validateTelegramReplyMarkup} from '../lib/telegram-delivery.mjs';

const on={applicationAutopilot:{consents:true,answers:false,authorizedAt:'2026-11-13T12:00:00.000Z'}};
const off={applicationAutopilot:{consents:false,answers:false,authorizedAt:null}};
const checkbox={key:'cert',type:'checkbox',label:'I certify that the information in this application is accurate.',required:true,options:['Yes','No']};
const privacyRadio={key:'privacy',type:'radio',label:'Do you acknowledge the Applicant Privacy Notice?',required:true,options:['No, I do not acknowledge','Yes, I acknowledge']};
const dataSelect={key:'gdpr',type:'select',label:'I consent to the processing of my personal data',required:true,options:['I do not consent','I consent']};
function memory(userId){const rows=new Map();return {userId,get:async(b,k)=>structuredClone(rows.get(b+':'+k)||null),put:async(b,k,v)=>rows.set(b+':'+k,structuredClone(v)),delete:async(b,k)=>rows.delete(b+':'+k),all:async b=>[...rows].filter(([k])=>k.startsWith(b+':')).map(([,v])=>structuredClone(v)),putIfAbsent:async(b,k,v)=>{if(!rows.has(b+':'+k))rows.set(b+':'+k,structuredClone(v));return structuredClone(rows.get(b+':'+k));},compareAndSet:async(b,k,old,next)=>{if(JSON.stringify(rows.get(b+':'+k)??null)!==JSON.stringify(old??null))return false;rows.set(b+':'+k,structuredClone(next));return true;}};}

test('only single consent-type controls qualify, and only a single unambiguous affirmative choice is picked',()=>{
 assert.equal(affirmativeOption(['No','Yes']),'Yes');assert.equal(affirmativeOption(['I do not agree','I agree']),'I agree');
 assert.equal(affirmativeOption(['Yes','Yes, and send updates']),null,'two affirmative choices are ambiguous');assert.equal(affirmativeOption(['No','Decline']),null);
 assert.ok(isStandingConsentField(checkbox));assert.ok(isStandingConsentField(privacyRadio));assert.ok(isStandingConsentField({key:'sms',type:'consent',label:'SMS updates',options:['Yes - I consent','No - I do not consent']}));
 // Grouped checkbox questions (Stripe countries, Notion "how did you hear", Ashby demographics) arrive as
 // type:'checkbox' with multiple:true. They are never consents, even when the wording mentions agreement or policy.
 for(const group of [{key:'countries',type:'checkbox',multiple:true,label:'In which countries do you agree to work? (select all)',options:['Australia','Belgium','United States']},{key:'heard',type:'checkbox',multiple:true,label:'How did you hear about this opportunity? (select all that apply)',options:['LinkedIn','Referral','Other']},{key:'eth',type:'checkbox',multiple:true,label:'Which ethnicity(ies) do you identify with? Please see our privacy policy.',options:['Asian','Black','White','Prefer not to say']}]){assert.equal(isStandingConsentField(group),false,group.label);assert.equal(standingConsentAnswer(group,on),null,group.label);}
 for(const field of [{...checkbox,multiple:true},{key:'vet',type:'checkbox',label:'I am a protected veteran',options:['Yes','No']},{key:'why',type:'textarea',label:'Why do you agree with our mission?',options:[]},{key:'auth',type:'select',label:'Are you authorized to work in the United States?',options:['Yes','No']}])assert.equal(isStandingConsentField(field),false,field.label);
});

test('consent answers are given only while the standing authorization is on',()=>{
 assert.equal(standingConsentAnswer(checkbox,on),'Yes');assert.equal(standingConsentAnswer(privacyRadio,on),'Yes, I acknowledge');assert.equal(standingConsentAnswer(dataSelect,on),'I consent');
 for(const profile of [off,{},null])for(const field of [checkbox,privacyRadio,dataSelect])assert.equal(standingConsentAnswer(field,profile),null);
 const form={fields:[checkbox,privacyRadio,dataSelect,{key:'phone',type:'tel',label:'Phone',required:false,options:[]}]};
 const accepted=quickApplicationAnswers(form,{...on,phone:'212 555 0100'},'Resume.pdf');
 assert.deepEqual(accepted.missing,[]);for(const key of ['cert','privacy','gdpr'])assert.equal(accepted.answers[key].source,STANDING_CONSENT_SOURCE);
 assert.deepEqual(acceptedConsentLabels(form,accepted.answers),[checkbox.label,privacyRadio.label,dataSelect.label]);
 const declined=quickApplicationAnswers(form,{...off,phone:'212 555 0100'},'Resume.pdf');assert.deepEqual(declined.missing,[checkbox.label,privacyRadio.label,dataSelect.label]);
 const sms={key:'smsConsent',type:'consent',label:'Recruiting updates by SMS',required:true,options:['Yes - I consent to receiving SMS text messages','No - I do not consent to receiving SMS text messages']};
 assert.equal(quickApplicationAnswers({fields:[sms]},{...on,recruitingSMS:'no'},'Resume.pdf').answers.smsConsent.value,sms.options[1],'an explicit saved choice wins');
 assert.equal(quickApplicationAnswers({fields:[sms]},{...on,recruitingSMS:'unanswered'},'Resume.pdf').answers.smsConsent.value,sms.options[0]);
});

test('autopilot storage accepts booleans only, dates authorization when turned on, and revocation clears it',async()=>{
 const store=memory('student');assert.deepEqual((await getCareerProfile(store)).applicationAutopilot,{consents:false,answers:false,authorizedAt:null});
 for(const bad of [{consents:'true'},{answers:1},{consents:true,extra:true},{},null,[]])await assert.rejects(saveApplicationAutopilot(store,bad),{status:400});
 const first=await saveApplicationAutopilot(store,{consents:true});assert.equal(first.consents,true);assert.equal(first.answers,false);assert.ok(Date.parse(first.authorizedAt));
 const both=await saveApplicationAutopilot(store,{answers:true});assert.equal(both.answers,true);assert.ok(Date.parse(both.authorizedAt)>=Date.parse(first.authorizedAt));
 await saveCareerProfile(store,{fullName:'Example Student'});assert.equal((await getCareerProfile(store)).applicationAutopilot.consents,true,'ordinary profile saves keep the authorization');
 await saveApplicationAutopilot(store,{consents:false});assert.equal((await getCareerProfile(store)).applicationAutopilot.authorizedAt!==null,true,'one choice still on');
 assert.deepEqual(await saveApplicationAutopilot(store,{answers:false}),{consents:false,answers:false,authorizedAt:null});
});

test('guided applications prefill consent controls under the authorization and the receipt lists what was accepted',async t=>{
 const before={APPLICATION_BROWSER_ENABLED:process.env.APPLICATION_BROWSER_ENABLED,APP_ORIGIN:process.env.APP_ORIGIN,PILOT_SHEET_ID:process.env.PILOT_SHEET_ID};t.after(()=>{for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 process.env.APPLICATION_BROWSER_ENABLED='true';process.env.APP_ORIGIN='https://app.bigredbuddy.com';delete process.env.PILOT_SHEET_ID;
 const base=JSON.parse(await readFile(new URL('./fixtures/ramp-application-form.json',import.meta.url),'utf8'));
 const form={...base,fields:[...base.fields,{key:'privacyAck',label:'I acknowledge the Ramp Applicant Privacy Notice',type:'yesno',required:true,options:['Yes','No']}]};
 const url='https://jobs.ashbyhq.com/ramp/a84ae1e2-8c88-4e05-9cb6-fa3e11b55aeb/application',a=memory('alice'),sent=[];
 const queue={enqueue:async(userId,type,payload,options)=>{const previous=sent.find(j=>j.options.idempotencyKey===options.idempotencyKey);if(previous)return previous;const job={id:String(sent.length),userId,type,payload,options};sent.push(job);if(type==='telegram-send')validateTelegramReplyMarkup(payload.replyMarkup);return job;}};
 const db={forUser:()=>a};
 await a.put('jobs','ramp',{id:'ramp',title:form.title,company:'Ramp',applyUrl:url});await a.put('documents','resume',{name:'Example.pdf',file:Buffer.from('%PDF-1.7\nsynthetic').toString('base64'),text:'Example Student\nProduct Manager at Example, 2020 to 2025.'});await a.put('secrets','telegram',{chatId:101,linkedAt:'link-1'});
 await saveCareerProfile(a,{fullName:'Example Student',email:'student@example.edu',phone:'+1 212 555 1234',linkedin:'https://www.linkedin.com/in/example',plannedWorkLocation:'New York City, New York, United States',officeThreeDays:'local_nyc_sf',recruitingSMS:'no',recruitingWhatsApp:'no'});
 await saveApplicationAutopilot(a,{consents:true});
 const run=async(type,overrides={})=>executeLiveApplication(db,sent.filter(j=>j.type===type).at(-1),{queue,inspect:async()=>structuredClone(form),analyze:async()=>({roles:[],analyzed:true}),...overrides});
 await startLiveApplication(a,queue,'ramp','start');await run('application-inspect');
 let app=(await a.all('liveApplications'))[0];
 assert.equal(app.answers.privacyAck.value,'Yes');assert.equal(app.answers.privacyAck.source,STANDING_CONSENT_SOURCE);
 assert.notEqual(app.answers.smsConsent?.source,STANDING_CONSENT_SOURCE,'saved SMS choice is not overridden');
 for(let n=0;n<30&&app.status!=='ready';n++){const index=app.form.fields.findIndex(f=>!app.answers[f.key]?.reviewed);const f=app.form.fields[index];if(f.options.length)await handleLiveApplicationAction(a,queue,{id:app.id,revision:app.revision,op:'answer',field:index,choice:0},'a'+n);else if(!f.required)await handleLiveApplicationAction(a,queue,{id:app.id,revision:app.revision,op:'skip',field:index},'s'+n);else await handleLiveApplicationMessage(a,queue,{chat:{id:101,type:'private'},text:'A factual student-written response.'},200+n);app=(await a.all('liveApplications'))[0];}
 assert.equal(app.status,'ready');await handleLiveApplicationAction(a,queue,{id:app.id,revision:app.revision,op:'submit'},'submit');
 let submitted;await run('application-submit',{submit:async({answers,beforeSubmit})=>{submitted=answers;await beforeSubmit();return {confirmedAt:new Date().toISOString(),confirmation:'Application submitted!',url};}});
 assert.equal(submitted.privacyAck.value,'Yes');app=(await a.all('liveApplications'))[0];assert.equal(app.status,'submitted');assert.deepEqual(app.acceptedConsents,['I acknowledge the Ramp Applicant Privacy Notice']);
 const receipt=sent.filter(j=>j.type==='telegram-send').map(j=>j.payload.text).find(text=>/Submitted to Ramp/.test(text));assert.match(receipt,/Accepted for you \(standing authorization\): I acknowledge the Ramp Applicant Privacy Notice/);
 await saveApplicationAutopilot(a,{consents:false});assert.equal(standingConsentAnswer(form.fields.at(-1),await getCareerProfile(a)),null,'revocation stops future acceptance');
});
