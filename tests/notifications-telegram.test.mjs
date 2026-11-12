import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {handleNotificationsMessage} from '../lib/notifications-telegram.mjs';
import {readNotificationPreferences,saveNotificationPreferences} from '../lib/notification-preferences.mjs';
import {handleMessage} from '../lib/telegram.mjs';

function fixture(){const rows=new Map([['secrets:telegram',{chatId:1}]]),messages=new Map();const clone=v=>v==null?null:structuredClone(v);const store={userId:'alice',async get(b,id){return clone(rows.get(`${b}:${id}`));},async put(b,id,v){rows.set(`${b}:${id}`,clone(v));},async all(b){return [...rows].filter(([key])=>key.startsWith(`${b}:`)).map(([,v])=>clone(v));},async compareAndSet(b,id,expected,value){const key=`${b}:${id}`;if(JSON.stringify(rows.get(key)||null)!==JSON.stringify(expected))return false;rows.set(key,clone(value));return true;}};const queue={async enqueue(userId,type,payload,options){assert.equal(userId,'alice');if(!messages.has(options.idempotencyKey))messages.set(options.idempotencyKey,{userId,type,payload,options});return {id:options.idempotencyKey};}};return {store,queue,messages,msg:text=>({text,chat:{id:1,type:'private'}})};}

test('notification commands require own linked private chat and correct addressed bot',async()=>{
 const f=fixture();for(const msg of [{text:'/notifications off',chat:{id:2,type:'private'}},{text:'/notifications off',chat:{id:1,type:'group'}},f.msg('/notifications@wrong_bot off'),f.msg('ordinary text')])assert.equal(await handleNotificationsMessage(f.store,f.queue,msg,1),false);
 assert.equal((await readNotificationPreferences(f.store)).enabled,true);assert.equal(f.messages.size,0);
});

test('commands independently save topics, preserve choices across master off/on, and reply while delivery is off',async()=>{
 const f=fixture();await handleNotificationsMessage(f.store,f.queue,f.msg('/notifications school daily'),1);await handleNotificationsMessage(f.store,f.queue,f.msg('/notifications off'),2);await handleNotificationsMessage(f.store,f.queue,f.msg('/notifications'),3);
 let p=await readNotificationPreferences(f.store);assert.equal(p.enabled,false);assert.equal(p.topics.school,'daily');assert.match([...f.messages.values()].at(-1).payload.text,/Proactive notifications: off/);
 await handleNotificationsMessage(f.store,f.queue,f.msg('/notifications on'),4);p=await readNotificationPreferences(f.store);assert.equal(p.enabled,true);assert.equal(p.topics.school,'daily');assert.ok([...f.messages.values()].every(m=>m.type==='telegram-send'&&!m.payload.notification&&m.options.maxAttempts===1));
});

test('malformed choices do not change consent and games consent stays future-only',async()=>{
 const f=fixture();for(const [i,text] of ['/notifications school weekly','/notifications school daily extra','/notifications unknown both'].entries())await handleNotificationsMessage(f.store,f.queue,f.msg(text),i+1);
 assert.equal((await readNotificationPreferences(f.store)).revision,0);
 await handleNotificationsMessage(f.store,f.queue,f.msg('/notifications games both'),4);const p=await readNotificationPreferences(f.store);assert.equal(p.topics.games,'both');assert.equal(p.available.games,false);assert.match([...f.messages.values()].at(-1).payload.text,/not available yet; preference saved/);
});

test('Telegram retries cannot overwrite a newer web choice and duplicate replies share one queue key',async()=>{
 const f=fixture(),msg=f.msg('/notifications school off');await handleNotificationsMessage(f.store,f.queue,msg,40);await saveNotificationPreferences(f.store,{topics:{school:'daily'}});await handleNotificationsMessage(f.store,f.queue,msg,40);
 assert.equal((await readNotificationPreferences(f.store)).topics.school,'daily');assert.equal(f.messages.size,1);
 await handleNotificationsMessage(f.store,f.queue,f.msg('/notifications school both'),39);assert.equal((await readNotificationPreferences(f.store)).topics.school,'daily');assert.match([...f.messages.values()].at(-1).payload.text,/already handled or superseded/);
});

test('shared router processes notifications without exposing commands to a model or active demographics questionnaire',async()=>{
 const f=fixture(),chatKey=createHash('sha256').update('1').digest('hex');await f.store.put('career','demographics',{status:'active',activeField:'gender',questionToken:'fixture'});
 const database={system:{async get(bucket,key){return bucket==='telegramChats'&&key===chatKey?{userId:'alice'}:null;}},forUser(userId){assert.equal(userId,'alice');return f.store;}};
 await handleMessage(database,f.queue,f.msg('/notifications jobs off'),80);assert.equal((await readNotificationPreferences(f.store)).topics.jobs,'off');assert.equal(f.messages.size,1);assert.equal([...f.messages.values()][0].type,'telegram-send');
});
