import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {getDemographics,editDemographics,DEMOGRAPHIC_FIELDS} from '../lib/demographics.mjs';
import {handleCallbackQuery,handleMessage} from '../lib/telegram.mjs';
import {validateTelegramReplyMarkup,dispatchQueuedTelegram} from '../lib/telegram-delivery.mjs';

async function setup(t){
 const dir=await mkdtemp(path.join(tmpdir(),'brb-demographic-buttons-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
 const queue=await createQueue(db),a=db.forUser('alice'),b=db.forUser('bob'),cards=[],answers=[],enqueue=queue.enqueue.bind(queue),now=Date.now();
 queue.enqueue=async(...args)=>{const result=await enqueue(...args);cards.push({id:result.id,type:args[1],payload:structuredClone(args[2])});return result;};
 for(const [store,chatId]of [[a,101],[b,202]]){await store.put('secrets','telegram',{chatId,linkedAt:'original-link'});await db.system.put('telegramChats',createHash('sha256').update(String(chatId)).digest('hex'),{userId:store.userId});}
 let sequence=100;
 const send=(text,updateId=sequence++)=>handleMessage(db,queue,{text,from:{id:101},chat:{id:101,type:'private'}},updateId);
 const click=(data,overrides={},updateId=sequence++,at=Date.now())=>handleCallbackQuery(db,queue,{id:`callback-${updateId}`,from:{id:101,is_bot:false},message:{chat:{id:101,type:'private'}},data,...overrides},updateId,{now:()=>at,answer:async body=>{answers.push(body);return{ok:true};}});
 const last=()=>cards.filter(card=>card.type==='telegram-send').at(-1)?.payload;
 const button=(pattern,payload=last())=>{const found=payload?.replyMarkup?.inline_keyboard?.flat().find(item=>pattern.test(item.text));assert.ok(found,`Button ${pattern} exists in ${JSON.stringify(payload?.replyMarkup)}`);return found.callback_data;};
 return{db,queue,a,b,cards,answers,now,send,click,last,button,state:()=>getDemographics(a)};
}

test('one menu lists all six optional fields and consent uses a tap without exposing nonce commands',async t=>{
 const s=await setup(t);await s.send('/demographics');const first=s.last();
 for(const field of DEMOGRAPHIC_FIELDS)assert.ok(first.text.toLowerCase().includes(field.label.toLowerCase()),field.label);
 assert.equal((await s.state()).questionnaire.active,null);
 await s.click(s.button(/agree/i));
 assert.ok((await s.state()).questionnaire.startedAt);
 await s.send('/demographics');const menu=s.last();
 const buttons=menu.replyMarkup.inline_keyboard.flat();
 for(const field of DEMOGRAPHIC_FIELDS)assert.ok(buttons.some(button=>button.text.toLowerCase().includes(field.label.toLowerCase())),field.label);
 assert.ok(buttons.some(button=>/remaining/i.test(button.text)));assert.ok(buttons.some(button=>/skip unanswered/i.test(button.text)));
 for(const card of s.cards.filter(card=>card.type==='telegram-send')){
  assert.doesNotMatch(card.payload.text,/\/demographic\s+[a-f0-9]{32}|Replace 1 with|<token>/);
  assert.equal(card.payload.expectedChatId,'101');
  assert.doesNotThrow(()=>validateTelegramReplyMarkup(card.payload.replyMarkup));
 }
 assert.deepEqual((await getDemographics(s.b)).values.veteranStatus,'unanswered');
});

test('the screenshot reply works as plain text and unknown sensitive replies never reach model jobs',async t=>{
 const s=await setup(t);await s.send('/newevent');const eventDraft=await s.a.get('settings','newEventFlow');await s.send('/demographics start');
 await s.send('2. Not a veteran');assert.equal((await s.state()).values.veteranStatus,'non_veteran');
 const privateText='PRIVATE_UNKNOWN_DEMOGRAPHIC_REPLY';await s.send(privateText);
 assert.ok((await s.queue.list('alice')).every(job=>job.type==='telegram-send'));
 assert.ok(s.cards.every(card=>!JSON.stringify(card.payload).includes(privateText)));
 await s.send('/demographics');await s.send('PRIVATE_MENU_REPLY');
 assert.ok((await s.queue.list('alice')).every(job=>job.type==='telegram-send'));
 assert.ok(s.cards.every(card=>!JSON.stringify(card.payload).includes('PRIVATE_MENU_REPLY')));
 assert.deepEqual(await s.a.get('settings','newEventFlow'),eventDraft);assert.deepEqual(await s.a.all('events'),[]);
});

test('answer buttons save once, stale callbacks cannot overwrite a website edit, and other students stay isolated',async t=>{
 const s=await setup(t);await s.send('/demographics start');const original=s.last(),answer=s.button(/^Not a veteran$/i,original);
 await s.click(answer,{},200);assert.equal((await s.state()).values.veteranStatus,'non_veteran');
 const after=await s.state();await s.click(answer,{},200);assert.deepEqual((await s.state()).values,after.values);
 await editDemographics(s.a,{veteranStatus:'decline'});
 await s.click(answer,{},201);assert.equal((await s.state()).values.veteranStatus,'decline');
 await s.click(s.button(/^Veteran$/i,original),{from:{id:202},message:{chat:{id:202,type:'private'}}},202);
 assert.equal((await getDemographics(s.b)).values.veteranStatus,'unanswered');assert.equal((await s.state()).values.veteranStatus,'decline');
 assert.ok(s.answers.length>=4);
});

test('race choices remain a draft until Done and stale toggles cannot change the newer selection',async t=>{
 const s=await setup(t);await s.send('/demographics edit race');const first=s.last(),asian=s.button(/Asian/,first);
 await s.click(asian,{},300);assert.deepEqual((await s.state()).values.race,['unanswered']);
 const second=s.last(),white=s.button(/White/,second);await s.click(asian,{},301);
 await s.click(white,{},302);assert.deepEqual((await s.state()).values.race,['unanswered']);
 await s.click(s.button(/^(Done|Save selections)/i),{},303);assert.deepEqual((await s.state()).values.race,['asian','white']);
 await s.send('/demographics edit race');await s.click(s.button(/prefer not/i),{},304);
 assert.deepEqual((await s.state()).values.race,['decline']);
});

test('callbacks reject forged senders, groups, bots, relinks, expiry and account deletion',async t=>{
 const s=await setup(t);await s.send('/demographics start');const answer=s.button(/^Not a veteran$/i);
 assert.equal(await s.click(answer,{from:{id:202}},400),false);
 assert.equal(await s.click(answer,{message:{chat:{id:101,type:'group'}}},401),false);
 assert.equal(await s.click(answer,{from:{id:101,is_bot:true}},402),false);
 await s.click(answer,{},403,s.now+86400000+5000);assert.equal((await s.state()).values.veteranStatus,'unanswered');
 await s.send('/demographics edit veteranStatus');const fresh=s.button(/^Not a veteran$/i);
 await s.a.put('secrets','telegram',{chatId:101,linkedAt:'new-link'});await s.click(fresh,{},404);assert.equal((await s.state()).values.veteranStatus,'unanswered');
 await s.send('/demographics edit veteranStatus');const final=s.button(/^Not a veteran$/i);await s.a.put('settings','account',{deleting:true});
 assert.equal(await s.click(final,{},405),false);assert.equal((await s.state()).values.veteranStatus,'unanswered');
 assert.ok((await s.queue.list('alice')).every(job=>job.type==='telegram-send'));
});

test('queued question cards are bounded and are suppressed after switching the linked chat',async t=>{
 const s=await setup(t);await s.send('/demographics edit race');const payload=s.last(),buttons=payload.replyMarkup.inline_keyboard.flat();
 assert.ok(buttons.length>=9);for(const button of buttons.filter(button=>button.callback_data)){assert.match(button.callback_data,/^demo:[a-f0-9]{32}$/);assert.ok(Buffer.byteLength(button.callback_data)<=64);}
 assert.doesNotThrow(()=>validateTelegramReplyMarkup(payload.replyMarkup));
 const calls=[],send=async(...args)=>{calls.push(args);return{result:{message_id:1}};};
 await dispatchQueuedTelegram(s.a,{payload},{send});assert.equal(calls.length,1);
 await s.a.put('secrets','telegram',{chatId:101,linkedAt:'new-link'});assert.equal((await dispatchQueuedTelegram(s.a,{payload},{send})).suppressed,true);assert.equal(calls.length,1);
 await s.a.put('secrets','telegram',{chatId:303,linkedAt:'new-link'});assert.equal((await dispatchQueuedTelegram(s.a,{payload},{send})).suppressed,true);assert.equal(calls.length,1);
});

test('taps update the existing message, stale queued menus cannot replace newer choices, and edit IDs are validated',async t=>{
 const s=await setup(t);await s.send('/demographics start');const old=s.last(),answer=s.button(/^Not a veteran$/i);
 await s.click(answer,{message:{message_id:77,chat:{id:101,type:'private'}}});const current=s.last();assert.equal(current.editMessageId,77);
 const calls=[],send=async(...args)=>{calls.push(args);return{result:{message_id:77}};};
 assert.equal((await dispatchQueuedTelegram(s.a,{payload:old},{send})).suppressed,true);assert.equal(calls.length,0);
 await dispatchQueuedTelegram(s.a,{payload:current},{send});assert.equal(calls[0][2].editMessageId,77);assert.equal(calls[0][2].expectedChatId,'101');assert.equal(calls[0][2].expectedTelegramLinkedAt,'original-link');
 for(const editMessageId of [0,-1,1.5,'77',null])await assert.rejects(dispatchQueuedTelegram(s.a,{payload:{...current,editMessageId}},{send}),/Invalid Telegram message/);
 assert.equal(calls.length,1);
});

test('finishing the last field keeps stray sensitive replies out of AI until the student closes setup',async t=>{
 const s=await setup(t);await s.send('/demographics edit gender');await s.click(s.button(/^Female$/i));
 assert.equal((await s.state()).values.gender,'female');assert.equal((await s.state()).questionnaire.active,null);assert.equal((await s.state()).questionnaire.telegramSessionActive,true);
 await s.send('PRIVATE_REPLY_AFTER_LAST_QUESTION');assert.ok((await s.queue.list('alice')).every(job=>job.type==='telegram-send'));assert.ok(s.cards.every(card=>!JSON.stringify(card.payload).includes('PRIVATE_REPLY_AFTER_LAST_QUESTION')));
 await s.click(s.button(/Done \/ close setup/i));assert.equal((await s.state()).questionnaire.telegramSessionActive,false);
 await s.send('What is my next class?');assert.equal((await s.queue.list('alice')).filter(job=>job.type==='telegram-chat').length,1);
});

test('all-at-once website buttons allow only the configured secure demographic page',()=>{
 const previous=process.env.APP_ORIGIN;process.env.APP_ORIGIN='https://app.synthetic.example';
 try{
  const markup=url=>({inline_keyboard:[[{text:'Fill all at once',url}]]});
  assert.deepEqual(validateTelegramReplyMarkup(markup('https://app.synthetic.example/#demographics')),markup('https://app.synthetic.example/#demographics'));
  for(const url of ['http://app.synthetic.example/#demographics','https://app.synthetic.example.attacker.test/#demographics','https://app.synthetic.example/#careers','https://app.synthetic.example/?token=secret#demographics','https://user:secret@app.synthetic.example/#demographics','https://app.synthetic.example:4430/#demographics'])assert.throws(()=>validateTelegramReplyMarkup(markup(url)));
 }finally{if(previous===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=previous;}
});
