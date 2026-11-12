import test from 'node:test';
import assert from 'node:assert/strict';
import {sendTelegram} from '../lib/integrations.mjs';

test('Telegram question edits use the existing message and recheck the private link before calling the provider',async t=>{
 const originalFetch=globalThis.fetch,originalToken=process.env.TELEGRAM_BOT_TOKEN,calls=[];
 process.env.TELEGRAM_BOT_TOKEN='synthetic-test-token';
 t.after(()=>{globalThis.fetch=originalFetch;if(originalToken===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=originalToken;});
 globalThis.fetch=async(url,options)=>{calls.push({method:new URL(url).pathname.split('/').at(-1),body:JSON.parse(options.body)});return new Response(JSON.stringify({ok:true,result:{message_id:77}}),{status:200,headers:{'Content-Type':'application/json'}});};
 const store={get:async(bucket,id)=>bucket==='secrets'&&id==='telegram'?{chatId:101,linkedAt:'current-link'}:null};
 const replyMarkup={inline_keyboard:[[{text:'Not a veteran',callback_data:'demo:'+'a'.repeat(32)}]]};
 await sendTelegram(store,'Choose an answer',{replyMarkup,expectedChatId:'101',expectedTelegramLinkedAt:'current-link',editMessageId:77});
 assert.deepEqual(calls,[{method:'editMessageText',body:{chat_id:101,message_id:77,text:'Choose an answer',reply_markup:replyMarkup,link_preview_options:{is_disabled:true}}}]);
 const rejected=await sendTelegram(store,'Stale menu',{replyMarkup,expectedChatId:'101',expectedTelegramLinkedAt:'old-link',editMessageId:77});
 assert.equal(rejected.suppressed,true);assert.equal(calls.length,1);
 await assert.rejects(sendTelegram(store,'Bad edit',{replyMarkup,editMessageId:77}),/Invalid Telegram message/);
 await assert.rejects(sendTelegram(store,'Bad edit',{replyMarkup,expectedChatId:'101',editMessageId:0}),/Invalid Telegram message/);
 await sendTelegram(store,'New questionnaire',{replyMarkup,expectedChatId:'101'});
 assert.equal(calls.at(-1).method,'sendMessage');assert.equal(calls.at(-1).body.message_id,undefined);
});
