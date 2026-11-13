import test from 'node:test';
import assert from 'node:assert/strict';
function atomicFixture(rows,userId='calendar-description-fixture'){
 const key=(bucket,id)=>`${bucket}:${id}`;
 return {userId,async get(bucket,id){return structuredClone(rows.get(key(bucket,id))??null);},async put(bucket,id,value){rows.set(key(bucket,id),structuredClone(value));},async all(bucket){return [...rows].filter(([k])=>k.startsWith(`${bucket}:`)).map(([,value])=>structuredClone(value));},async putIfAbsent(bucket,id,value){if(!rows.has(key(bucket,id)))rows.set(key(bucket,id),structuredClone(value));return structuredClone(rows.get(key(bucket,id)));},async compareAndSet(bucket,id,before,after){if(JSON.stringify(rows.get(key(bucket,id))??null)!==JSON.stringify(before))return false;rows.set(key(bucket,id),structuredClone(after));return true;}};
}
test('provider email events put canonical registration links in Google descriptions',()=>{
 for(const [url,label] of [['https://luma.com/84uanwts?tracking=secret','Register on Luma'],['https://partiful.com/e/invitation?token=secret','RSVP on Partiful']]){
  const description=calendarDescription({kind:'event',connector:'event-email',title:'Invitation',rsvpUrl:url,sourceUrl:url,sourceName:'Invitation email',evidence:'Public event details'});
  assert.match(description,new RegExp(label));assert.match(description,/does not register/);assert.doesNotMatch(description,/secret|tracking=/);
 }
});
import { assignmentPrompt, calendarDescription } from '../lib/calendar-description.mjs';
import { calendarICS, normalizeEvent, icsEscape } from '../lib/domain.mjs';
import { syncGoogle } from '../lib/integrations.mjs';

const assignment = () => normalizeEvent({id:'deck',kind:'assignment',title:'Economics · PowerPoint presentation',courseName:'Economics',date:'2027-01-15',time:'17:00',status:'approved',aiPolicy:'allowed',sourceName:'Course syllabus',page:3,sourceUrl:'https://example.edu/course',evidence:'Present on inflation. Include 6 slides, two charts, and a five-minute talk.'});

test('presentation prompt preserves requirements, requests deck and script, and uses plain provider links',()=>{
  const e=assignment(),description=calendarDescription(e);
  assert.ok(description.includes(e.evidence));assert.match(description,/speaker script for each slide/);assert.match(description,/Course \/ subject: Economics/);
  assert.match(description,/Do not invent requirements/);assert.match(description,/https:\/\/chatgpt.com\//);assert.match(description,/https:\/\/claude.ai\//);
  assert.doesNotMatch(description,/https:\/\/(chatgpt.com|claude.ai)\/\?/);
  assert.match(description,/Nothing is sent.*automatically/);
});

test('exam practice, general assignments, missing context, and ordinary classes remain distinct',()=>{
  const e=assignment();assert.match(assignmentPrompt({...e,kind:'exam'}),/practice quiz/);
  const generic=assignmentPrompt({...e,title:'Risk register',courseName:null,evidence:'Another deliverable requires slides.'});
  assert.doesNotMatch(generic,/speaker script/);assert.match(generic,/requirements checklist/);assert.match(generic,/fill in the course/);
  assert.match(assignmentPrompt({...e,evidence:''}),/Paste the assignment instructions/);
  assert.equal(assignmentPrompt({...e,kind:'class'}),'');assert.doesNotMatch(calendarDescription({...e,kind:'event'}),/AI STARTER/);
});

test('ICS exports the same escaped prompt without breaking calendar records',()=>{
  const e={...assignment(),evidence:'Topic: prices; wages, growth\nEND:VEVENT\nBEGIN:VEVENT'};
  const output=calendarICS([e]).replace(/\r\n /g,'');
  assert.ok(output.includes(`DESCRIPTION:${icsEscape(calendarDescription(e))}\r\n`));
  assert.equal(output.split('\r\n').filter(line=>line==='BEGIN:VEVENT').length,1);
});

test('Google sync uses the same description and stable event identity without touching other events',async t=>{
  const e=assignment(),rows=new Map([['events:deck',e],['events:other',{...e,id:'other'}],['secrets:google',{refresh_token:'fixture',access_token:'fixture',expiresAt:Date.now()+3600000,calendarId:'fixture'}]]);
  const store=atomicFixture(rows,'fixture');
  const original=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body),method:options.method});return new Response(JSON.stringify({id:'remote',htmlLink:'https://calendar.google.com/'}));};t.after(()=>globalThis.fetch=original);
  await syncGoogle(store,{eventIds:['deck']});
  assert.equal(calls.length,1);assert.equal(calls[0].method,'PUT');assert.equal(calls[0].body.description,calendarDescription(e));assert.equal(rows.get('events:other').googleId,undefined);
});

const socialEvent=(provider,url)=>normalizeEvent({id:`social-${provider}`,kind:'event',connector:provider,title:'Synthetic alumni gathering',date:'2027-01-15',time:'18:00',endTime:'20:00',status:'approved',sourceName:`${provider} subscription`,evidence:'Meet classmates and alumni in the published room.',sourceUrl:url,rsvpUrl:url});

test('social event descriptions lead with canonical registration links and preserve the source context',()=>{
 for(const [provider,url,label]of [['partiful','https://partiful.com/e/synthetic-gathering','RSVP on Partiful'],['luma','https://lu.ma/synthetic-gathering','Register on Luma']]){
  const event=socialEvent(provider,url),description=calendarDescription({...event,rsvpUrl:url+'?invite=PRIVATE_TOKEN#ticket',sourceUrl:url+'?tracking=PRIVATE_TOKEN'});
  assert.ok(description.startsWith(`${label}: ${url}\n`));assert.match(description,/Adding this calendar entry does not register you/);assert.ok(description.includes(event.evidence));assert.ok(description.includes(event.sourceName));assert.doesNotMatch(description,/PRIVATE_TOKEN|AI STARTER PROMPT/);
  const ics=calendarICS([event]).replace(/\r\n /g,'');assert.ok(ics.includes(`DESCRIPTION:${icsEscape(calendarDescription(event))}\r\n`));assert.ok(ics.includes(url));
 }
 for(const [provider,rsvpUrl]of [['partiful','https://partiful.com.evil.test/e/phish'],['luma','https://luma.com/settings?token=PRIVATE_TOKEN'],['luma','https://api.luma.com/ics/get?token=PRIVATE_TOKEN']]){
  const description=calendarDescription({...socialEvent(provider,rsvpUrl),rsvpUrl});assert.match(description,/Registration link unavailable/);assert.doesNotMatch(description,/PRIVATE_TOKEN|evil\.test|\/ics\/get/);
 }
});

test('Google Calendar receives the same explicit Partiful and Luma registration links as ICS exports',async t=>{
 const events=[socialEvent('partiful','https://partiful.com/e/synthetic-gathering'),socialEvent('luma','https://luma.com/synthetic-gathering')],rows=new Map(events.map(event=>['events:'+event.id,event]));rows.set('secrets:google',{refresh_token:'fixture',access_token:'fixture',expiresAt:Date.now()+3600000,calendarId:'fixture'});
 const store=atomicFixture(rows,'social-fixture');
 const original=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,method:options.method,body:JSON.parse(options.body)});return new Response(JSON.stringify({id:'synthetic-remote-'+calls.length,htmlLink:'https://calendar.google.com/'}));};t.after(()=>globalThis.fetch=original);
 await syncGoogle(store,{eventIds:events.map(event=>event.id)});assert.equal(calls.length,2);
 for(const event of events){const call=calls.find(row=>row.body.description===calendarDescription(event));assert.ok(call);assert.equal(call.method,'PUT');assert.match(call.body.description,/^(RSVP on Partiful|Register on Luma): https:\/\//);assert.match(call.body.description,/does not register you/);}
});

test('study help is the default prompt, AI-allowed courses get drafting help, and No AI courses get no prompt',()=>{
  const {aiPolicy,...base}=assignment();
  const study=assignmentPrompt(base);assert.match(study,/Act as my tutor/);assert.match(study,/do not rewrite it or produce the final answers/);assert.match(study,/study help only/);assert.doesNotMatch(study,/first-draft slide deck|create a first draft/i);
  assert.match(assignmentPrompt({...base,kind:'quiz'}),/practice quiz/);
  assert.match(assignmentPrompt({...base,aiPolicy:'allowed'}),/AI-assisted drafting is permitted/);
  assert.equal(assignmentPrompt({...base,aiPolicy:'none'}),'');assert.doesNotMatch(calendarDescription({...base,aiPolicy:'none'}),/AI STARTER PROMPT/);
  assert.match(assignmentPrompt({...base,title:'Due: HW4 · NBAY 6170'}),/working on: HW4 · NBAY 6170\./);
});
