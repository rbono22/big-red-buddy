import test from 'node:test';
import assert from 'node:assert/strict';
import {sendTelegram} from '../lib/integrations.mjs';
import {dispatchQueuedTelegram} from '../lib/telegram-delivery.mjs';

test('event cards deliver only validated buttons to the expected private chat',async t=>{
 const originalFetch=globalThis.fetch,token=process.env.TELEGRAM_BOT_TOKEN,calls=[];process.env.TELEGRAM_BOT_TOKEN='synthetic-test-only';
 globalThis.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify({ok:true,result:{message_id:7}}),{status:200,headers:{'content-type':'application/json'}});};
 t.after(()=>{globalThis.fetch=originalFetch;if(token===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=token;});
 let chatId=101;const store={userId:'fixture',async get(bucket,id){return bucket==='secrets'&&id==='telegram'?{chatId}:null;}};
 const replyMarkup={inline_keyboard:[[{text:'Register on Luma',url:'https://luma.com/fixture'}],[{text:'Add to Google Calendar',callback_data:'social:'+'a'.repeat(32)}]]};
 const job={payload:{text:'Synthetic event',replyMarkup,expectedChatId:'101'}};
 assert.equal((await dispatchQueuedTelegram(store,job,{send:sendTelegram})).accepted,true);assert.equal(calls.length,1);assert.deepEqual(calls[0].reply_markup,replyMarkup);assert.equal(calls[0].chat_id,101);assert.equal(calls[0].link_preview_options.is_disabled,true);
 chatId=202;assert.equal((await dispatchQueuedTelegram(store,job,{send:sendTelegram})).suppressed,true);assert.equal(calls.length,1);
 assert.equal((await sendTelegram(store,'Old event card',{replyMarkup,expectedChatId:'101'})).suppressed,true);assert.equal(calls.length,1);
 await assert.rejects(sendTelegram(store,'Invalid card',{replyMarkup:{inline_keyboard:[[{text:'Bad',url:'https://evil.example/steal'}]]}}));assert.equal(calls.length,1);
});
