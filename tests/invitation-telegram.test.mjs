import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {CALENDAR_SCOPE} from '../lib/auth.mjs';
import {handleInvitationMessage,handleInvitationCallback,processInvitationUpload,pruneExpiredInvitationFlow} from '../lib/invitation-telegram.mjs';

const NOW=Date.parse('2026-11-10T20:00:00Z');
const complete={title:'Friendsgiving',date:'2026-11-13',time:'19:00',location:'Tata L24',duration:120};
const evidence='Friendsgiving · November 13 2026 · 7 pm · Tata L24';
async function setup(t){
 const dir=await mkdtemp(path.join(tmpdir(),'brb-invitation-state-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true}),queue=await createQueue(db),a=db.forUser('alice'),b=db.forUser('bob'),rows=new Map();
 t.after(async()=>{await queue.close();await db.close();await rm(dir,{recursive:true,force:true});});
 await a.put('secrets','telegram',{chatId:101,linkedAt:'first'});await b.put('secrets','telegram',{chatId:202,linkedAt:'first'});
 let clock=NOW,sequence=100;const now=()=>clock,enqueue=queue.enqueue.bind(queue);
 queue.enqueue=async(...args)=>{const job=await enqueue(...args);if(!rows.has(job.id))rows.set(job.id,{id:job.id,userId:args[0],type:args[1],payload:structuredClone(args[2])});return job;};
 const jobs=type=>[...rows.values()].filter(row=>!type||row.type===type),last=()=>jobs('telegram-send').at(-1)?.payload;
 const send=(text,id=sequence++,extra={})=>handleInvitationMessage(a,queue,{text,from:{id:101},chat:{type:'private',id:101},...extra},id,{now});
 const photo=(caption='/invite',id=sequence++,file='one')=>send(undefined,id,{caption,photo:[{file_id:`file-${file}`,file_unique_id:`unique-${file}`,width:1000,height:1000,file_size:1200}]});
 const button=(pattern,payload=last())=>{const result=payload?.replyMarkup?.inline_keyboard.flat().find(row=>pattern.test(row.text));assert.ok(result,`Missing button ${pattern}`);return result.callback_data;};
 const click=(data,id=sequence++,extra={})=>handleInvitationCallback(a,queue,{data,from:{id:101},message:{chat:{type:'private',id:101}},...extra},id,{now});
 const result=(fields=complete,extra={})=>({fields,rsvpUrl:'https://luma.com/friendsgiving',provider:'luma',sourceText:evidence,warnings:[],method:'synthetic',...extra});
 const process=(output=result(),options={})=>processInvitationUpload(a,queue,jobs('telegram-invitation').at(-1).payload,{download:async()=>Buffer.from('private-screenshot-bytes'),extract:async()=>output,now,...options});
 return{db,a,b,queue,jobs,last,send,photo,button,click,result,process,now,setTime:time=>{clock=time;},flow:()=>a.get('settings','invitationFlow'),events:()=>a.all('events')};
}

test('missing fields use ordinary replies and buttons, and a complete review alone cannot write a calendar event',async t=>{
 const s=await setup(t);await s.a.put('secrets','google',{refresh_token:'test-only',scope:CALENDAR_SCOPE});
 await s.photo();await s.process(s.result({title:'Friendsgiving',date:null,time:null,location:null,duration:null}));
 assert.equal((await s.flow()).question,'date');await s.send('Nov 13');assert.equal((await s.flow()).fields.date,null);
 await s.send('Nov 13 2026');assert.equal((await s.flow()).question,'time');await s.send('7:30');assert.equal((await s.flow()).fields.time,null);
 await s.send('7:30 pm');await s.send('Tata L24');await s.click(s.button(/^2 hours$/));
 const flow=await s.flow();assert.equal(flow.question,'confirm');assert.equal(flow.start,'2026-11-14T00:30:00.000Z');
 await s.send('yes');assert.equal((await s.events()).length,0);assert.match(s.last().text,/Tap the Add/);
 await s.click(s.button(/^Add to Google Calendar$/));
 const [event]=await s.events();assert.equal(event.title,'Friendsgiving');assert.equal(event.status,'approved');assert.equal(event.connector,'telegram-invitation');assert.equal(event.rsvpUrl,'https://luma.com/friendsgiving');
 assert.equal((await s.a.all('reminders'))[0].minutes,10);assert.deepEqual(s.jobs('google-sync')[0].payload,{eventIds:[event.id]});
 assert.match(s.last().text,/sync queued/);assert.match(s.last().text,/still need to RSVP/);assert.doesNotMatch(s.last().text,/Google Calendar (?:created|added|confirmed)/);
 assert.equal((await s.flow()).fields,undefined);assert.equal((await s.flow()).sourceText,undefined);
 assert.doesNotMatch(JSON.stringify(await s.a.all('settings'))+JSON.stringify(await s.events()),/private-screenshot-bytes/);
});

test('students without a Calendar scope get an accurate local save button and no Google sync job',async t=>{
 const s=await setup(t);await s.a.put('secrets','google',{refresh_token:'test-only',scope:'openid email'});
 await s.photo();await s.process();await s.click(s.button(/^Save to BRB schedule$/));
 assert.equal((await s.events()).length,1);assert.equal(s.jobs('google-sync').length,0);assert.match(s.last().text,/Connect Google Calendar/);
});

test('date changes invalidate old confirmation buttons and DST or past starts cannot be confirmed',async t=>{
 const s=await setup(t);await s.photo();await s.process();const stale=s.button(/^Save to BRB/);
 await s.click(s.button(/^Edit date$/));await s.send('2027-03-14');await s.click(s.button(/^Edit time$/));await s.send('2:30 am');
 assert.equal((await s.flow()).question,'time');assert.match(s.last().text,/does not exist/);await assert.rejects(s.click(stale),/changed|already used/);
 await s.send('3:30 am');assert.equal((await s.flow()).start,'2027-03-14T07:30:00.000Z');
 await s.click(s.button(/^Edit date$/));await s.send('2027-11-07');await s.click(s.button(/^Edit time$/));await s.send('1:30 am');assert.match(s.last().text,/occurs twice/);
 await s.send('2:30 am');assert.equal((await s.flow()).start,'2027-11-07T07:30:00.000Z');
 s.setTime(Date.parse('2027-11-07T07:31:00Z'));await assert.rejects(s.click(s.button(/^Save to BRB/)),/expired/);assert.equal((await s.events()).length,0);
});

test('pasting a visible RSVP link updates the draft safely and old replayed updates cannot change it',async t=>{
 const s=await setup(t);await s.photo(undefined,100);await s.process(s.result(complete,{rsvpUrl:'',provider:null}));assert.match(s.last().text,/hidden link/);
 await s.send('/invite https://partiful.com/e/helloEvent',110);assert.equal((await s.flow()).rsvpUrl,'https://partiful.com/e/helloEvent');
 const prior=await s.flow();await s.send('/invite https://luma.com/old-replayed-event',109);assert.deepEqual(await s.flow(),prior);
 const urls=s.last().replyMarkup.inline_keyboard.flat().filter(row=>row.url);assert.equal(urls[0].url,'https://partiful.com/e/helloEvent');
 await s.send('/invite javascript:alert(1)',111);assert.equal((await s.flow()).rsvpUrl,'https://partiful.com/e/helloEvent');
});

test('OCR completion is suppressed after relink, deletion, a newer upload, or loss of pilot access',async t=>{
 for(const kind of ['relink','delete','new-upload','revoked'])await t.test(kind,async t=>{
  const s=await setup(t);await s.photo();let allowed=true;const before=s.jobs('telegram-send').length;
  const result=await s.process(undefined,{assertAccess:async()=>allowed,extract:async()=>{
   if(kind==='relink')await s.a.put('secrets','telegram',{chatId:101,linkedAt:'new-link'});
   if(kind==='delete')await s.a.put('settings','account',{deleting:true});
   if(kind==='new-upload')await s.photo('/invite',200,'two');
   if(kind==='revoked')allowed=false;
   return s.result();
  }});
  assert.equal(result.superseded,true);assert.equal((await s.events()).length,0);
  assert.equal(s.jobs('telegram-send').length,before+(kind==='new-upload'?1:0));assert.notEqual((await s.flow()).status,'draft');
 });
});

test('expiry and cancellation remove unconfirmed fields, source text, image references, and expired buttons',async t=>{
 const s=await setup(t);await s.photo();const processing=await s.flow();assert.ok(processing.file);await s.process();
 s.setTime(NOW+31*60000);assert.equal(await pruneExpiredInvitationFlow(s.a,{now:s.now}),true);
 const expired=await s.flow();for(const key of ['fields','sourceText','file','caption','imageHash'])assert.equal(expired[key],undefined,key);
 assert.deepEqual(await s.a.all('invitationActions'),[]);
 s.setTime(NOW+32*60000);await s.photo('/invite',200,'two');await s.click(s.button(/^Cancel$/),201);assert.equal((await s.flow()).file,undefined);assert.equal((await s.flow()).status,'cancelled');
 assert.equal(await s.send('normal assistant question',202),false);
});

test('a button is bound to the current student, private chat, Telegram link, and exact draft revision',async t=>{
 const s=await setup(t);await s.photo();await s.process();const data=s.button(/^Save to BRB/);
 await assert.rejects(handleInvitationCallback(s.b,s.queue,{data,from:{id:202},message:{chat:{type:'private',id:202}}},500,{now:s.now}),/expired|changed/);
 assert.equal(await s.click(data,501,{from:{id:202}}),false);assert.equal(await s.click(data,502,{message:{chat:{type:'group',id:101}}}),false);
 await s.a.put('secrets','telegram',{chatId:101,linkedAt:'new-link'});await assert.rejects(s.click(data,503),/expired|changed/);
 assert.equal((await s.events()).length,0);assert.equal((await s.b.all('events')).length,0);
});

test('confirmation recovers after an interrupted write without duplicate events or calendar tasks',async t=>{
 const s=await setup(t);await s.a.put('secrets','google',{refresh_token:'test-only',scope:CALENDAR_SCOPE});await s.photo();await s.process();const data=s.button(/^Add to Google Calendar$/);
 const put=s.a.putIfAbsent.bind(s.a);let crashed=false;s.a.putIfAbsent=async(...args)=>{const result=await put(...args);if(args[0]==='events'&&!crashed){crashed=true;throw new Error('synthetic process interruption');}return result;};
 await assert.rejects(s.click(data,500),/synthetic process interruption/);assert.equal((await s.flow()).status,'committing');assert.equal((await s.events()).length,1);
 await s.click(data,500);assert.equal((await s.flow()).status,'complete');assert.equal((await s.events()).length,1);assert.equal(s.jobs('google-sync').length,1);
 await assert.rejects(s.click(data,501),/already used|changed/);assert.equal((await s.events()).length,1);
});

test('an interrupted save keeps its recovery window, then prunes private draft data after 24 hours without changing a saved event',async t=>{
 const s=await setup(t);await s.photo();await s.process();const data=s.button(/^Save to BRB/);
 const put=s.a.putIfAbsent.bind(s.a);s.a.putIfAbsent=async(...args)=>{const result=await put(...args);if(args[0]==='events')throw new Error('synthetic interruption after save');return result;};
 await assert.rejects(s.click(data,500),/synthetic interruption/);
 const committing=await s.flow(),events=await s.events();assert.equal(committing.status,'committing');assert.equal(events.length,1);assert.equal(events[0].status,'approved');assert.ok(committing.sourceText);
 s.setTime(NOW+23*60*60000);assert.equal(await pruneExpiredInvitationFlow(s.a,{now:s.now}),false);assert.deepEqual(await s.flow(),committing);
 const tasksBefore=s.jobs().length;s.setTime(NOW+24*60*60000+1);assert.equal(await pruneExpiredInvitationFlow(s.a,{now:s.now}),true);
 const failed=await s.flow();assert.equal(failed.status,'failed');assert.equal(failed.eventId,events[0].id);assert.match(failed.lastReply,/Saving was interrupted/);assert.match(failed.lastReply,/may already have completed/);assert.doesNotMatch(failed.lastReply,/nothing was added/i);
 for(const key of ['fields','sourceText','file','caption','imageHash'])assert.equal(failed[key],undefined,key);
 assert.deepEqual(await s.a.all('invitationActions'),[]);assert.deepEqual(await s.events(),events);assert.equal(s.jobs().length,tasksBefore,'Pruning does not queue provider operations or messages');
});

test('repeated screenshots and canonical existing event links avoid duplicates without reviving dismissed events',async t=>{
 const s=await setup(t);await s.photo();await s.process();await s.click(s.button(/^Save to BRB/));assert.equal((await s.events()).length,1);
 await s.photo('/invite',200);assert.equal(s.jobs('telegram-invitation').length,1);assert.equal((await s.events()).length,1);
 await s.photo('/invite',201,'other-photo');await s.process(s.result({...complete,title:'Different screenshot title'},{rsvpUrl:'https://lu.ma/friendsgiving'}));await s.click(s.button(/^Save to BRB/),202);
 assert.equal((await s.events()).length,1);assert.equal((await s.events())[0].title,'Friendsgiving');
 const [event]=await s.events();await s.a.put('events',event.id,{...event,status:'dismissed',localIntent:'declined'});
 await s.photo('/invite',203,'third-photo');await s.process();await s.click(s.button(/^Save to BRB/),204);
 assert.equal((await s.events()).length,1);assert.equal((await s.events())[0].status,'dismissed');assert.match(s.last().text,/not re-added/);
});

test('file/model failures stay generic and never expose OCR error text, credentials, or local paths',async t=>{
 const s=await setup(t);await s.photo();await assert.rejects(s.process(undefined,{extract:async()=>{throw new Error('SECRET-CREDENTIAL /Users/private/invite.jpg');}}),error=>error.status===400&&!/SECRET|Users/.test(error.message));
 assert.equal((await s.flow()).status,'failed');assert.equal((await s.flow()).file,undefined);assert.doesNotMatch(JSON.stringify(s.last()),/SECRET|Users/);assert.equal((await s.events()).length,0);
});

test('switching between typed events and invitations clears only unconfirmed drafts, while demographic answers remain separate',async t=>{
 const s=await setup(t);await s.a.put('settings','newEventFlow',{id:'typed',status:'draft',sourceText:'private typed details',fields:{title:'Other event'},revision:1});
 await s.send('/invite');assert.equal((await s.a.get('settings','newEventFlow')).status,'cancelled');assert.equal((await s.a.get('settings','newEventFlow')).sourceText,undefined);
 await s.photo();await s.process();assert.equal(await s.send('/newevent study tomorrow'),false);assert.equal((await s.flow()).status,'cancelled');
 await s.a.put('career','demographics',{questionnaire:{active:{field:'disabilityStatus'},telegramSessionActive:true}});const prior=await s.flow();
 assert.equal(await s.send('sensitive answer'),false);await s.photo('/invite',300,'blocked');assert.deepEqual(await s.flow(),prior);assert.match(s.last().text,/demographics/);
 assert.doesNotMatch(JSON.stringify(await s.flow()),/sensitive answer/);
});
