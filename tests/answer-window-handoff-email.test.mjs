import test from 'node:test';
import assert from 'node:assert/strict';
import {startQuickApplication,executeLiveApplication,handleLiveApplicationAction,ANSWER_WINDOW_MS} from '../lib/live-applications.mjs';
import {saveCareerProfile} from '../lib/career.mjs';
import {emailApplicationHandoff,handoffEmailMessage} from '../lib/application-handoff-email.mjs';
import {menuMarkup} from '../lib/telegram-menu.mjs';

// Synthetic students, jobs, and forms only. No real employer or Gmail request is made.
const URL='https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply';
const field=(key,label,type='text',required=true,profileField)=>({key,label,type,required,options:[],...(profileField?{profileField}:{})});
const FORM={title:'Product Manager',fields:[field('_systemfield_resume','Resume','file'),field('name','Full name','text',true,'fullName'),field('email','Email','email',true,'email'),field('phone','Phone','tel',true,'phone'),field('years','How many years of product experience do you have?','text',true)],consentText:''};
function memory(userId){const rows=new Map();return {userId,rows,get:async(b,k)=>structuredClone(rows.get(b+':'+k)||null),put:async(b,k,v)=>rows.set(b+':'+k,structuredClone(v)),delete:async(b,k)=>rows.delete(b+':'+k),all:async b=>[...rows].filter(([k])=>k.startsWith(b+':')).map(([,v])=>structuredClone(v)),compareAndSet:async(b,k,old,next)=>{if(JSON.stringify(rows.get(b+':'+k)||null)!==JSON.stringify(old))return false;rows.set(b+':'+k,structuredClone(next));return true;}};}
async function setup(t){
 const prior={APPLICATION_BROWSER_ENABLED:process.env.APPLICATION_BROWSER_ENABLED,APP_ORIGIN:process.env.APP_ORIGIN,PILOT_SHEET_ID:process.env.PILOT_SHEET_ID};
 t.after(()=>{for(const [k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
 process.env.APPLICATION_BROWSER_ENABLED='true';process.env.APP_ORIGIN='https://app.bigredbuddy.com';delete process.env.PILOT_SHEET_ID;
 const a=memory('alice'),tasks=[],queue={enqueue:async(userId,type,payload,options)=>{const old=tasks.find(j=>j.options.idempotencyKey===options.idempotencyKey);if(old)return old;const row={id:String(tasks.length),userId,type,payload,options};tasks.push(row);return row;}};
 await a.put('secrets','telegram',{chatId:101,linkedAt:'link-a'});
 await a.put('jobs','role',{id:'role',title:FORM.title,company:'Example',url:URL});
 await a.put('documents','resume',{name:'Student.pdf',file:Buffer.from('%PDF-1.7 synthetic').toString('base64'),text:'Synthetic resume'});
 await saveCareerProfile(a,{fullName:'Example Student',email:'student@example.edu',phone:'+1 212 555 1234',recruitingSMS:'no',recruitingWhatsApp:'no'});
 const db={forUser:()=>a},current=async()=>(await a.all('liveApplications'))[0];
 const run=type=>executeLiveApplication(db,tasks.filter(j=>j.type===type).at(-1),{queue,inspect:async()=>structuredClone(FORM),analyze:async()=>{throw Error('no');},draft:async()=>{throw Error('no');},submit:async()=>{throw Error('must not submit');}});
 return {a,queue,tasks,current,run};
}
const lastButtons=s=>s.tasks.filter(j=>j.type==='telegram-send').at(-1).payload.replyMarkup.inline_keyboard.flat();
const near=(value,target,slack=60000)=>Math.abs(value-target)<=slack;

test('a question sent to Telegram can be answered for a full day, and its buttons stay valid that long',async t=>{
 const s=await setup(t),start=Date.now();await startQuickApplication(s.a,s.queue,'role',1);await s.run('application-inspect');
 const a=await s.current();assert.equal(a.status,'collecting');assert.ok(near(a.quickAuthorizationExpiresAt,start+ANSWER_WINDOW_MS),'authorization lasts 24 hours');assert.equal(ANSWER_WINDOW_MS,86400000);
 const actions=await s.a.all('menuActions');assert.ok(actions.length);for(const row of actions)assert.ok(near(row.expiresAt,start+ANSWER_WINDOW_MS),'application buttons last 24 hours');
 await menuMarkup(s.a,[[['Jobs',{page:'jobs'}]]]);const ordinary=(await s.a.all('menuActions')).find(row=>row.action.page==='jobs');assert.ok(near(ordinary.expiresAt,Date.now()+1800000),'other menus keep 30 minutes');
});

test('the handoff email is a plain BRB link without tokens, sent only through the student’s own Gmail grant',()=>{
 const message=handoffEmailMessage({company:'Example <Co>',title:'PM\r\nBcc: x@example.com'},'https://app.bigredbuddy.com/#application-handoff/app-1');
 assert.equal(message.subject,'Finish your Example <Co> application in Chrome');assert.doesNotMatch(message.subject,/[\r\n]/);
 assert.match(message.text,/https:\/\/app\.bigredbuddy\.com\/#application-handoff\/app-1/);assert.match(message.text,/you submit on the employer page/);
 assert.match(message.html,/Example &lt;Co&gt;/);assert.doesNotMatch(message.html,/<Co>|<script/);assert.doesNotMatch(message.text+message.html,/token=|\?/);
});

test('handoff emails need Gmail delivery, send automatically once per attempt, and throttle repeat requests',async()=>{
 const s=memory('alice'),sent=[],send=async(_store,message,options)=>{sent.push({message,options});return {id:'gmail-'+sent.length,accepted:true};};
 const app={id:'app-1',revision:4,company:'Example',title:'Product Manager'};let clock=Date.parse('2026-11-13T15:00:00Z');const now=()=>clock;
 assert.deepEqual(await emailApplicationHandoff(s,app,{send,now,origin:'https://app.bigredbuddy.com'}),{sent:false,reason:'gmail-not-connected'});
 await s.put('secrets','dailyEmailGoogle',{connectionRevision:'rev-1',refresh_token:'r',subject:'g',email:'student@cornell.edu'});
 assert.deepEqual(await emailApplicationHandoff(s,app,{reason:'automatic',send,now,origin:'https://app.bigredbuddy.com'}),{sent:true});
 assert.equal(sent[0].options.expectedConnectionRevision,'rev-1');assert.match(sent[0].message.text,/#application-handoff\/app-1/);
 clock+=10*60000;assert.deepEqual(await emailApplicationHandoff(s,app,{reason:'automatic',send,now,origin:'https://app.bigredbuddy.com'}),{sent:false,reason:'already-sent'});
 assert.deepEqual(await emailApplicationHandoff(s,app,{reason:'requested',send,now,origin:'https://app.bigredbuddy.com'}),{sent:true});
 clock+=30000;assert.deepEqual(await emailApplicationHandoff(s,app,{reason:'requested',send,now,origin:'https://app.bigredbuddy.com'}),{sent:false,reason:'recently-sent'});
 clock+=3*60000;assert.deepEqual(await emailApplicationHandoff(s,{...app,revision:5},{reason:'automatic',send,now,origin:'https://app.bigredbuddy.com'}),{sent:true});
 assert.equal(sent.length,3);
 assert.deepEqual(await emailApplicationHandoff(s,{...app,revision:6},{reason:'automatic',send:async()=>{throw Error('unknown outcome');},now:()=>clock+600000,origin:'https://app.bigredbuddy.com'}),{sent:false,reason:'delivery-uncertain'});
 assert.deepEqual(await emailApplicationHandoff(s,{...app,revision:7},{reason:'automatic',send:async()=>({failed:true,reason:'gmail-reconnect-required'}),now:()=>clock+1200000,origin:'https://app.bigredbuddy.com'}),{sent:false,reason:'gmail-reconnect-required'});
});

test('every Open & fill button comes with Email me this link, and the button tells the student what happened',async t=>{
 const s=await setup(t);await startQuickApplication(s.a,s.queue,'role',1);await s.run('application-inspect');
 let a=await s.current();a=await (async()=>{const next={...a,status:'needs_attention',error:'The employer page asked for a human check.',revision:a.revision+1};await s.a.put('liveApplications',a.id,next);return next;})();
 await handleLiveApplicationAction(s.a,s.queue,{id:a.id,revision:a.revision,op:'show'},'k1');
 const texts=lastButtons(s).map(b=>b.text);
 assert.ok(texts.includes('Open & fill in my browser'),'handoff offered: '+texts.join('|'));assert.ok(texts.includes('Email me this link'));
 const before=s.tasks.length;await handleLiveApplicationAction(s.a,s.queue,{id:a.id,revision:a.revision-1,op:'email-handoff'},'k2');
 const reply=s.tasks.slice(before).find(j=>j.type==='telegram-send').payload.text;
 assert.match(reply,/Connect Gmail delivery|isn’t available for this application/,'without Gmail the student is told how to enable it');
});
