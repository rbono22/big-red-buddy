import test from 'node:test';
import assert from 'node:assert/strict';
import {handleBriefingMessage} from '../lib/briefing-telegram.mjs';
import {readDailyBriefingSettings} from '../lib/daily-briefing.mjs';
function setup(){const rows=new Map([['secrets:telegram',{chatId:1}]]),messages=[];const store={userId:'alice',async get(b,id){return rows.get(`${b}:${id}`)||null;},async put(b,id,v){rows.set(`${b}:${id}`,v);},async all(b){return [...rows].filter(([key])=>key.startsWith(`${b}:`)).map(([,v])=>v);}};return {store,messages,queue:{async enqueue(userId,type,payload){messages.push({userId,type,payload});}},msg:text=>({text,chat:{id:1,type:'private'}})};}
test('briefing commands save only the linked student preferences and reject malformed times',async()=>{
 const s=setup();assert.equal(await handleBriefingMessage(s.store,s.queue,{text:'/briefing 07:30',chat:{id:2,type:'private'}},1),false);
 assert.equal((await readDailyBriefingSettings(s.store)).time,'08:00');
 await handleBriefingMessage(s.store,s.queue,s.msg('/briefing 07:30'),2);assert.equal((await readDailyBriefingSettings(s.store)).time,'07:30');
 await handleBriefingMessage(s.store,s.queue,s.msg('/briefing off'),3);assert.equal((await readDailyBriefingSettings(s.store)).enabled,false);
 await handleBriefingMessage(s.store,s.queue,s.msg('/briefing 29:00'),4);assert.equal((await readDailyBriefingSettings(s.store)).time,'07:30');
 assert.ok(s.messages.every(m=>m.userId==='alice'&&m.type==='telegram-send'));
});
test('schedule and coverage commands remain deterministic and disclose unconfigured sources',async()=>{
 const s=setup();await handleBriefingMessage(s.store,s.queue,s.msg('/schedule'),1);assert.equal(s.messages[0].type,'telegram-daily-preview');assert.deepEqual(s.messages[0].payload,{});
 await handleBriefingMessage(s.store,s.queue,s.msg('/coverage'),2);assert.match(s.messages[1].payload.text,/no employer boards/);
 assert.equal(await handleBriefingMessage(s.store,s.queue,s.msg('ordinary question'),3),false);
});
