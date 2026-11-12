import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {prepareSyllabusProposal,confirmSyllabus,syllabusReviewMessage,handleSyllabusMessage} from '../lib/syllabus-telegram.mjs';
import {normalizeEvent} from '../lib/domain.mjs';
import {handleMessage} from '../lib/telegram.mjs';

function store(userId){const m=new Map(),key=(b,id)=>b+':'+id;return {userId,async get(b,id){return structuredClone(m.get(key(b,id))||null);},async all(b){return [...m].filter(([k])=>k.startsWith(b+':')).map(([,v])=>structuredClone(v));},async put(b,id,v){m.set(key(b,id),structuredClone(v));return v;},async putIfAbsent(b,id,v){if(!m.has(key(b,id)))m.set(key(b,id),structuredClone(v));return this.get(b,id);},async compareAndSet(b,id,old,next){if(JSON.stringify(await this.get(b,id))!==JSON.stringify(old))return false;await this.put(b,id,next);return true;},async delete(b,id){m.delete(key(b,id));}};}
async function setup(){const a=store('alice'),b=store('bob'),system=store('system'),jobs=[],keys=new Set();const queue={async enqueue(userId,type,payload,options={}){const key=userId+':'+options.idempotencyKey;if(!keys.has(key)){jobs.push({userId,type,payload,options});keys.add(key);}return {id:'job'};}};await a.put('secrets','telegram',{chatId:101});await b.put('secrets','telegram',{chatId:202});await system.put('telegramChats',createHash('sha256').update('101').digest('hex'),{userId:'alice'});const database={system,forUser:id=>id==='alice'?a:b};return {a,b,system,database,queue,jobs};}
const input={buffer:Buffer.from('synthetic file'),mimeType:'image/jpeg',name:'Syllabus photo',term:'FA26'};
const events=[normalizeEvent({title:'Economics deck',kind:'assignment',date:'2026-12-01',time:'17:00',evidence:'Economics deck due December 1 at 5 pm.',evidenceVerified:true}),normalizeEvent({title:'Quiz',kind:'quiz',date:'2026-12-02',evidence:'Quiz due December 2.',evidenceVerified:true})];
const dependencies={read:async()=>({text:'Economics deck due December 1 at 5 pm. Quiz due December 2.',method:'synthetic OCR'}),extract:async(_text,_type,_model,options)=>{assert.equal(options.deadlinesOnly,true);assert.equal(options.academicTerm,'Fall 2026');return {events,method:'synthetic extraction'};}};

test('syllabus photo mode routes files by explicit purpose, is tenant-scoped, and preserves replay deduplication',async()=>{
 const s=await setup(),msg={chat:{id:101,type:'private'}};
 await s.a.put('settings','careerUpload',{expiresAt:Date.now()+60000});
 await handleMessage(s.database,s.queue,{...msg,text:'/syllabus FA26'},1);
 assert.equal(await s.a.get('settings','careerUpload'),null);
 const photo={...msg,photo:[{file_id:'photo',width:1200,height:1600,file_size:10000}]};
 await handleMessage(s.database,s.queue,photo,2);await handleMessage(s.database,s.queue,photo,2);
 assert.equal(s.jobs.filter(j=>j.type==='telegram-syllabus').length,1);assert.equal(s.jobs.filter(j=>j.type==='telegram-enrollment').length,0);
 assert.equal(s.jobs.find(j=>j.type==='telegram-syllabus').payload.term,'FA26');assert.equal(await s.b.get('settings','syllabusUpload'),null);
 await handleMessage(s.database,s.queue,{...msg,text:'/enrollment SP27'},3);
 assert.equal(await s.a.get('settings','syllabusUpload'),null);
 await handleMessage(s.database,s.queue,photo,4);assert.equal(s.jobs.find(j=>j.type==='telegram-enrollment').payload.term,'SP27');
});
test('caption supports syllabus mode, expired mode never becomes enrollment, wrong chat cannot import',async()=>{
 const s=await setup(),photo={chat:{id:101,type:'private'},photo:[{file_id:'photo',width:400,height:500}],caption:'/syllabus SP27'};
 await handleMessage(s.database,s.queue,photo,1);assert.equal(s.jobs.find(j=>j.type==='telegram-syllabus').payload.term,'SP27');
 await s.a.put('settings','syllabusUpload',{term:'FA26',expiresAt:1});await handleMessage(s.database,s.queue,{...photo,caption:''},2);assert.equal(s.jobs.filter(j=>j.type==='telegram-enrollment').length,0);assert.match(s.jobs.at(-1).payload.text,/expired/);
 assert.equal(await handleSyllabusMessage(s.a,s.queue,{...photo,chat:{id:202,type:'private'}},3),false);
 const before=s.jobs.length;await handleMessage(s.database,s.queue,{...photo,caption:'/syllabus@another_bot FA26'},4);assert.equal(s.jobs.length,before);
});
test('extraction only creates review items; subset approval queues only selected owned events and is idempotent',async()=>{
 const s=await setup();await s.a.put('secrets','google',{refresh_token:'synthetic'});
 const p=await prepareSyllabusProposal(s.a,input,dependencies);assert.ok((await s.a.all('events')).every(e=>e.status==='review'));assert.equal((await s.a.all('reminders')).length,0);
 assert.equal((await prepareSyllabusProposal(s.a,input,{read:()=>{throw new Error('must reuse');}})).id,p.id);
 await assert.rejects(confirmSyllabus(s.b,p,[1],s.queue));
 await assert.rejects(confirmSyllabus(s.a,p,[2],s.queue),/time/);
 const result=await confirmSyllabus(s.a,p,[1],s.queue);assert.equal(result.calendarQueued,true);assert.equal(result.count,1);
 assert.deepEqual(s.jobs.find(j=>j.type==='google-sync').payload.eventIds,[p.items[0].id]);assert.equal((await s.a.get('events',p.items[1].id)).status,'review');
 const saved=await s.a.get('syllabusProposals',p.id);await confirmSyllabus(s.a,saved,[1],s.queue);assert.equal(s.jobs.filter(j=>j.type==='google-sync').length,1);
 await assert.rejects(confirmSyllabus(s.a,saved,[2],s.queue),/already confirmed/);
});
test('student-supplied time requires a second confirmation; unreadable evidence and stale revisions cannot be approved',async()=>{
 const s=await setup(),p=await prepareSyllabusProposal(s.a,input,dependencies),code=p.id.slice(0,8);
 await handleSyllabusMessage(s.a,s.queue,{chat:{id:101,type:'private'},text:`/syllabus_time ${code} 2 18:30`},1);
 const e=await s.a.get('events',p.items[1].id);assert.equal(e.time,'18:30');assert.equal(e.status,'review');
 await assert.rejects(confirmSyllabus(s.a,p,[2],s.queue),/changed/);
 const updated=await s.a.get('syllabusProposals',p.id);assert.equal((await confirmSyllabus(s.a,updated,[2],s.queue)).calendarQueued,false);
 const other=await prepareSyllabusProposal(s.b,input,{...dependencies,extract:async()=>({events:[{...events[0],evidenceVerified:false}]})});
 await assert.rejects(confirmSyllabus(s.b,other,[1],s.queue),/source review/);
});
test('large reviews are paginated and Telegram-sized, retaining every numbered item',async()=>{
 const s=await setup(),long=Array.from({length:18},(_,i)=>({...events[0],title:`${i} `+'A'.repeat(238),location:'B'.repeat(300),warning:'C'.repeat(240)}));
 const p=await prepareSyllabusProposal(s.a,input,{...dependencies,extract:async()=>({events:long})});
 for(const page of [1,2,3]){const text=await syllabusReviewMessage(s.a,p,page);assert.ok(text.length<=3900);assert.ok(text.includes(`${(page-1)*6+1}.`));}
 await assert.rejects(syllabusReviewMessage(s.a,p,4));
});
