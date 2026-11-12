import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {normalizeEvent} from '../lib/domain.mjs';
import {prepareEnrollmentProposal,confirmEnrollmentProposal} from '../lib/enrollment-workflow.mjs';
import {enrollmentAttachment,downloadTelegramEnrollment} from '../lib/telegram-files.mjs';
import {handleMessage} from '../lib/telegram.mjs';
import {readReminderSettings} from '../lib/reminder-settings.mjs';
function store(userId){const m=new Map(),key=(b,id)=>b+':'+id;return {userId,async get(b,id){return structuredClone(m.get(key(b,id))||null);},async all(b){return [...m].filter(([k])=>k.startsWith(b+':')).map(([,v])=>structuredClone(v));},async put(b,id,v){m.set(key(b,id),structuredClone(v));return v;},async putIfAbsent(b,id,v){if(!m.has(key(b,id)))m.set(key(b,id),structuredClone(v));return this.get(b,id);},async compareAndSet(b,id,old,next){if(JSON.stringify(await this.get(b,id))!==JSON.stringify(old))return false;await this.put(b,id,next);return true;},async delete(b,id){m.delete(key(b,id));}};}
function setup(){let changed=false;const catalog={async select({courseId,sectionId}){return {source:{id:courseId,name:'Catalog',url:'https://example.com'},course:{id:courseId,code:courseId},section:{id:sectionId},warnings:[],events:[normalizeEvent({id:courseId,title:courseId+' class',kind:'class',date:'2026-12-01',time:changed?'14:00':'13:00',endTime:'15:00',evidence:'Source schedule',status:'approved'})]};}};const analyzer=async()=>({term:'FA26',sourceName:'Enrollment image',candidates:[{courseId:'INFO 6410',sectionId:'one',importable:true,enrollmentStatus:'unknown'},{courseId:'CS 5854',sectionId:'two',importable:true,enrollmentStatus:'unknown'},{courseId:'CS 9999',sectionId:'three',importable:true,enrollmentStatus:'dropped'}],warnings:[],unmatched:[]});const jobs=[],queue={async enqueue(userId,type,payload){jobs.push({userId,type,payload});return {id:'queued-calendar'};}};return {catalog,analyzer,jobs,queue,change:()=>changed=true};}
test('enrollment recognition creates only a review; explicit subset confirmation is isolated, idempotent, and scoped for Google',async()=>{
 const a=store('alice'),b=store('bob'),s=setup(),id='a'.repeat(32);
 await prepareEnrollmentProposal(a,{}, {...s,id});assert.equal((await a.all('events')).length,0);
 await assert.rejects(confirmEnrollmentProposal(a,{id,selections:[]},s),/Choose/);
 await assert.rejects(confirmEnrollmentProposal(b,{id,selections:[{courseId:'INFO 6410',sectionId:'one'}]},s),/not found/);
 await assert.rejects(confirmEnrollmentProposal(a,{id,selections:[{courseId:'CS 9999',sectionId:'three'}]},s),/supported/);
 await a.put('secrets','google',{refresh_token:'fixture'});
 const request={id,selections:[{courseId:'INFO 6410',sectionId:'one'}]};await confirmEnrollmentProposal(a,request,s);await confirmEnrollmentProposal(a,request,s);
 assert.equal((await a.all('events')).length,1);assert.equal((await a.all('events'))[0].catalogCourseId,'INFO 6410');assert.equal((await b.all('events')).length,0);assert.equal(s.jobs.length,1);assert.deepEqual(s.jobs[0].payload.eventIds,['INFO 6410']);
});
test('changed catalog or expired proposal blocks confirmation before any calendar records are written',async()=>{
 const a=store('alice'),s=setup(),id='b'.repeat(32);await prepareEnrollmentProposal(a,{}, {...s,id});s.change();await assert.rejects(confirmEnrollmentProposal(a,{id,selections:[{courseId:'INFO 6410',sectionId:'one'}]},s),/changed/);assert.equal((await a.all('events')).length,0);
 const old=await a.get('enrollmentProposals',id);await a.put('enrollmentProposals',id,{...old,expiresAt:0});await assert.rejects(confirmEnrollmentProposal(a,{id,selections:[{courseId:'INFO 6410',sectionId:'one'}]},s),/expired/);
});
test('Telegram file validation rejects unsupported/oversized files and download path traversal without leaking credentials',async()=>{
 assert.throws(()=>enrollmentAttachment({document:{file_id:'file',mime_type:'application/zip'}}),/PDF/);
 assert.throws(()=>enrollmentAttachment({photo:[{file_id:'file',width:50,height:50,file_size:13*1024*1024}]}),/12 MB/);
 let calls=0;await assert.rejects(downloadTelegramEnrollment('file',{token:'SECRET',fetchImpl:async()=>{calls++;return new Response(JSON.stringify({ok:true,result:{file_path:'../secrets'}}),{status:200});}}),error=>!error.message.includes('SECRET')&&/safely/.test(error.message));assert.equal(calls,1);
});
test('Telegram attachments require a matching linked account and reminder commands update only that student',async()=>{
 const alice=store('alice'),bob=store('bob'),system=store('system'),jobs=[],queue={async enqueue(userId,type,payload){jobs.push({userId,type,payload});return {id:'job'};}},database={system,forUser:id=>id==='alice'?alice:bob};
 const msg={chat:{id:123,type:'private'},photo:[{file_id:'safe-photo',width:100,height:100,file_size:500}],caption:'FA26'};
 await handleMessage(database,queue,msg,1);assert.equal(jobs.length,0);
 const hash=createHash('sha256').update('123').digest('hex');await system.put('telegramChats',hash,{userId:'alice'});await alice.put('secrets','telegram',{chatId:123});
 await handleMessage(database,queue,msg,2);assert.equal(jobs[0].type,'telegram-enrollment');assert.equal(jobs[0].userId,'alice');assert.equal(jobs[0].payload.term,'FA26');
 await handleMessage(database,queue,{chat:msg.chat,text:'/reminders classes 15m'},3);assert.deepEqual((await readReminderSettings(alice)).classes,[15]);assert.deepEqual((await readReminderSettings(bob)).classes,[10]);
 await alice.delete('secrets','telegram');const length=jobs.length;await handleMessage(database,queue,msg,4);assert.equal(jobs.length,length);
});
