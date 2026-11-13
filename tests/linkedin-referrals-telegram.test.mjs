import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {handleCareerMessage} from '../lib/career-telegram.mjs';
import {handleMenuCallback} from '../lib/telegram-menu.mjs';
import {dispatchLinkedInLeads} from '../lib/linkedin-delivery.mjs';
import {validateTelegramReplyMarkup} from '../lib/telegram-delivery.mjs';
import {importLinkedInConnections,deleteLinkedInConnections} from '../lib/linkedin-connections.mjs';
import {skipDemographics} from '../lib/demographics.mjs';

const csv=(count=1,company='Example Company')=>'First Name,Last Name,URL,Company,Position,Connected On\n'+Array.from({length:count},(_,i)=>`Alex${i},Example,https://www.linkedin.com/in/alex-${i},${company},Manager,01 Jan 2025`).join('\n');
async function setup(t,{count=1,company='Example Company'}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'brb-referrals-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true}),a=db.forUser('alice'),b=db.forUser('bob'),queued=[],sent=[],keys=new Set();
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 await a.put('secrets','telegram',{chatId:101,linkedAt:'link-a'});await b.put('secrets','telegram',{chatId:202,linkedAt:'link-b'});
 await skipDemographics(a,{all:true});
 await a.put('documents','resume',{text:'Synthetic resume for product work.'});
 await a.put('jobs','example',{id:'example',title:'Product Manager',company:'Example Company',url:'https://example.com/jobs/pm'});
 await importLinkedInConnections(a,{csv:csv(count,company)});
 const queue={enqueue:async(user,type,payload,options)=>{if(!keys.has(options.idempotencyKey)){queued.push({user,type,payload,options});keys.add(options.idempotencyKey);}return {id:options.idempotencyKey};}};
 const apply=key=>handleCareerMessage(db,queue,a,{text:'/apply example',chat:{id:101,type:'private'}},key);
 const dispatch=async payload=>dispatchLinkedInLeads(a,payload,{send:async(store,text,options)=>{validateTelegramReplyMarkup(options.replyMarkup);sent.push({text,options});return {result:{message_id:sent.length}};}});
 const click=async(label,key,{message=sent.at(-1),store=a,chatId=101}={})=>{const button=message.options.replyMarkup.inline_keyboard.flat().find(b=>b.text===label);assert.ok(button,`Missing button ${label}`);await handleMenuCallback(db,store,queue,{data:button.callback_data,message:{chat:{id:chatId,type:'private'}}},key);return button;};
 return {db,a,b,queue,queued,sent,apply,dispatch,click};
}

test('applying offers a named referral draft before prep, while Continue remains a separate choice',async t=>{
 const s=await setup(t);await s.apply(1);await s.apply(1);
 assert.equal(s.queued.length,1);assert.equal(s.queued[0].type,'telegram-leads');assert.equal(s.queued[0].payload.mode,'offer');
 assert.doesNotMatch(JSON.stringify(s.queued),/Alex0|looking to apply|Synthetic resume/);
 await s.dispatch(s.queued[0].payload);const offer=s.sent.at(-1);assert.match(offer.text,/Before you apply/);
 await s.click('Draft referral message',2);const draftRequest=s.queued.at(-1);assert.equal(draftRequest.payload.mode,'draft');assert.doesNotMatch(JSON.stringify(draftRequest),/Alex0|looking to apply/);
 await s.dispatch(draftRequest.payload);const draft=s.sent.at(-1);assert.match(draft.text,/Hey Alex0/);assert.match(draft.text,/Product Manager role at Example Company/);assert.match(draft.text,/referral program/);assert.match(draft.text,/quick call/);
 assert.equal(draft.options.replyMarkup.inline_keyboard.flat().find(b=>b.text==='Open LinkedIn profile').url,'https://www.linkedin.com/in/alex-0');
 assert.equal(s.queued.filter(j=>j.type==='draft').length,0);assert.equal(s.queued.filter(j=>j.type==='application-submit').length,0);
 const button=await s.click('Continue application',3);assert.equal(s.queued.filter(j=>j.type==='draft').length,1);
 await handleMenuCallback(s.db,s.a,s.queue,{data:button.callback_data,message:{chat:{id:101,type:'private'}}},4);
 assert.equal(s.queued.filter(j=>j.type==='draft').length,1);
});

test('Find connections offers individual drafts, bounded pagination, and no outreach action',async t=>{
 const s=await setup(t,{count:9});await handleCareerMessage(s.db,s.queue,s.a,{text:'/leads example',chat:{id:101,type:'private'}},1);
 await s.dispatch(s.queued[0].payload);const first=s.sent.at(-1);assert.equal(first.options.replyMarkup.inline_keyboard.flat().filter(b=>b.text.startsWith('Draft for')).length,5);
 await s.click('More connections',2);await s.dispatch(s.queued.at(-1).payload);const second=s.sent.at(-1);
 assert.equal(second.options.replyMarkup.inline_keyboard.flat().filter(b=>b.text.startsWith('Draft for')).length,4);
 assert.ok(second.options.replyMarkup.inline_keyboard.flat().some(b=>b.text==='Previous connections'));
 assert.ok(s.queued.every(j=>j.type==='telegram-leads'));
 assert.doesNotMatch(JSON.stringify(s.queued),/Alex\d|quick call/);
});

test('no employer match keeps the normal application preparation path',async t=>{
 const s=await setup(t,{company:'Unrelated Company'});await s.apply(1);
 assert.equal(s.queued.filter(j=>j.type==='telegram-leads').length,0);assert.equal(s.queued.filter(j=>j.type==='draft').length,1);
});

test('deleted or replaced imports and relinked chats suppress queued referral text',async t=>{
 const s=await setup(t);await s.apply(1);await s.dispatch(s.queued[0].payload);await s.click('Draft referral message',2);const request=s.queued.at(-1).payload;
 await importLinkedInConnections(s.a,{csv:csv(2)});assert.equal((await s.dispatch(request)).reason,'linkedin-export-changed');assert.equal(s.sent.length,1);
 await s.apply(3);const newRequest=s.queued.at(-1).payload;await s.a.put('secrets','telegram',{chatId:101,linkedAt:'new-link'});assert.equal((await s.dispatch(newRequest)).reason,'telegram-link-changed');
 await deleteLinkedInConnections(s.a);assert.equal((await s.dispatch({...newRequest,expectedTelegramLinkedAt:'new-link'})).reason,'linkedin-export-changed');
});

test('foreign, expired, closed-job and stale-export callback choices cannot begin an application',async t=>{
 const s=await setup(t);await s.apply(1);await s.dispatch(s.queued[0].payload);const message=s.sent.at(-1);
 await s.click('Continue application',2,{message,store:s.b,chatId:202});assert.equal(s.queued.filter(j=>j.type==='draft').length,0);
 const button=message.options.replyMarkup.inline_keyboard.flat().find(b=>b.text==='Continue application'),token=button.callback_data.slice(5),action=await s.a.get('menuActions',token);
 await s.a.put('menuActions',token,{...action,expiresAt:Date.now()-1});await s.click('Continue application',3,{message});assert.equal(s.queued.filter(j=>j.type==='draft').length,0);
 await s.apply(4);await s.dispatch(s.queued.at(-1).payload);const current=s.sent.at(-1);await deleteLinkedInConnections(s.a);await s.click('Continue application',5,{message:current});assert.equal(s.queued.filter(j=>j.type==='draft').length,0);
 await importLinkedInConnections(s.a,{csv:csv()});await s.apply(6);const request=s.queued.at(-1).payload;await s.a.put('jobs','example',{...(await s.a.get('jobs','example')),status:'closed'});assert.equal((await s.dispatch(request)).reason,'job-unavailable');
});

test('Telegram profile buttons allow only canonical LinkedIn person URLs',()=>{
 const markup=url=>({inline_keyboard:[[{text:'Open profile',url}]]});
 assert.doesNotThrow(()=>validateTelegramReplyMarkup(markup('https://www.linkedin.com/in/alex-example')));
 for(const url of ['http://www.linkedin.com/in/alex','https://www.linkedin.com.evil.test/in/alex','https://user:password@www.linkedin.com/in/alex','https://www.linkedin.com/in/alex?redirect=evil','https://www.linkedin.com/company/example','https://www.linkedin.com/in/alex#other','https://www.linkedin.com/in/alex%2Fother'])assert.throws(()=>validateTelegramReplyMarkup(markup(url)));
});
