import test from 'node:test';
import assert from 'node:assert/strict';
import {createNews} from '../lib/news.mjs';
import {EVENT_EMAIL_SCOPE} from '../lib/auth.mjs';
import {readNotificationPreferences} from '../lib/notification-preferences.mjs';
import {createPrivateEmailReader} from '../lib/event-email.mjs';
import {idFor} from '../lib/domain.mjs';

const NOW=Date.parse('2026-11-12T15:00:00Z'),now=()=>NOW,DAY=86400000;
const EVIDENCE='Business leaders are postponing expansion as they evaluate changing market conditions and uncertain overseas demand.';
const BODY=`The 10-Point\n${EVIDENCE}`;
const result=()=>({bullets:[{text:'Companies are taking a cautious stance while considering their next growth decisions.',evidence:EVIDENCE,url:''}]});
const grant={subject:'owned-mailbox-a',email:'student@cornell.edu',connectionRevision:'mailbox-a',access_token:'synthetic-reader',refresh_token:'synthetic-refresh',expiresAt:NOW+3600000,scope:EVENT_EMAIL_SCOPE};
function student(userId='alice'){
 const records=new Map();return {userId,records,
  async get(bucket,id){return structuredClone(records.get(`${bucket}:${id}`)||null);},
  async put(bucket,id,value){records.set(`${bucket}:${id}`,structuredClone(value));return value;},
  async putIfAbsent(bucket,id,value){const key=`${bucket}:${id}`;if(!records.has(key))records.set(key,structuredClone(value));return structuredClone(records.get(key));},
  async compareAndSet(bucket,id,previous,next){const key=`${bucket}:${id}`;if(JSON.stringify(records.get(key)||null)!==JSON.stringify(previous))return false;records.set(key,structuredClone(next));return true;},
  async all(bucket){return [...records].filter(([key])=>key.startsWith(`${bucket}:`)).map(([,row])=>structuredClone(row));},
  async delete(bucket,id){records.delete(`${bucket}:${id}`);},
 };
}
function message(id,{age=1000,subject='The 10-Point',sender='WSJ <newsletters@news.wsj.com>',listId='The 10-Point <10-point.wsj.com>',body=BODY,labels=['INBOX']}={}){
 return {id,labelIds:labels,internalDate:String(NOW-age),payload:{mimeType:'text/plain',headers:[{name:'From',value:sender},{name:'Subject',value:subject},{name:'List-ID',value:listId}],body:{data:Buffer.from(body).toString('base64url')}}};
}
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
function service({messages=[message('aa')],beforeResponse=async()=>{},summarize=async()=>result()}={}){
 const calls=[],modelInputs=[];
 const client=createNews({now,summarize:async(...args)=>{modelInputs.push(args[0]);return summarize(...args);},fetchImpl:async(url,options)=>{
  const u=new URL(url);assert.equal(u.origin,'https://gmail.googleapis.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer synthetic-reader');
  if(u.pathname.endsWith('/messages')){
   const query=u.searchParams.get('q')||'';assert.match(query,/newer_than:30d/);assert.match(query,/from:/);assert.match(query,/10|pitch/i);assert.equal(u.searchParams.get('includeSpamTrash'),'false');assert.equal(u.searchParams.has('labelIds'),false);
   calls.push({stage:'list',query});await beforeResponse('list');return json({messages:messages.map(row=>({id:row.id})),resultSizeEstimate:messages.length});
  }
  const id=u.pathname.split('/').at(-1),row=messages.find(item=>item.id===id);assert.ok(row,`Unexpected Gmail request ${u.pathname}`);
  const stage=u.searchParams.get('format');assert.ok(['metadata','full'].includes(stage));calls.push({stage,id});await beforeResponse(stage,id);
  if(stage==='metadata')return json({...row,payload:{headers:row.payload.headers}});
  return json(row);
 }});
 return {client,calls,modelInputs};
}
async function enable(client,store=student(),sources=['wsj10point']){
 await store.put('secrets','eventEmailGoogle',grant);await client.startAutomaticNews(store,{sources});return store;
}

test('automatic matching reads only metadata of unrelated mail and only the selected newest newsletter body',async()=>{
 const messages=[message('11',{age:2*DAY}),message('22',{sender:'attacker@wsj.com.evil.test'}),message('33',{subject:'Private student correspondence',body:'The 10-Point PRIVATE UNRELATED BODY'}),message('44',{age:1000}),message('55',{subject:'The Daily Pitch',sender:'news@pitchbook.com',listId:'Daily Pitch <pitchbook.com>',body:'The Daily Pitch PRIVATE UNSELECTED BODY'}),message('66',{subject:'PitchBook Alert: Saved company search',sender:'news@pitchbook.com',listId:'Saved alerts <pitchbook.com>',body:'The Daily Pitch PRIVATE ALERT BODY'})];
 const s=service({messages}),store=await enable(s.client);await s.client.syncNews(store);
 assert.deepEqual(s.calls.filter(call=>call.stage==='full').map(call=>call.id),['44']);
 assert.equal(s.modelInputs.length,1);assert.equal(s.modelInputs[0],BODY);
 assert.doesNotMatch(JSON.stringify([...store.records]),/PRIVATE UNRELATED|PRIVATE UNSELECTED|PRIVATE ALERT|Business leaders are postponing/);
 assert.equal((await readNotificationPreferences(store)).topics.news,'off','source discovery does not silently subscribe the student to Telegram news');
});

test('newest received edition wins shuffled results and older newsletters are never backfilled on repeat refreshes',async()=>{
 const s=service({messages:[message('aa',{age:4*DAY}),message('bb',{age:1000}),message('cc',{age:DAY})]}),store=await enable(s.client);
 await s.client.syncNews(store);await s.client.syncNews(store);await s.client.syncNews(store);
 assert.deepEqual(s.calls.filter(call=>call.stage==='full').map(call=>call.id),['bb']);
 assert.equal(s.modelInputs.length,1);assert.equal((await store.all('newsSummaries')).length,1);
 assert.equal((await s.client.listNews(store)).providers[0].latest.receivedAt,new Date(NOW-1000).toISOString());
});

test('Daily Pitch editorial subjects from its exact news sender are discovered and validated against the body',async()=>{
 const sender='PitchBook News <NEWS-NOREPLY@news.pitchbook.com>',body=`The Daily Pitch\n${EVIDENCE}`;
 const s=service({messages:[message('aa',{age:DAY,subject:'A previous market briefing',sender,listId:'',body}),message('bb',{subject:'Private markets in focus',sender,listId:'',body})]}),store=await enable(s.client,student(),['dailypitch']);
 const out=await s.client.syncNews(store);assert.equal(out.processed,1);
 assert.match(s.calls.find(call=>call.stage==='list').query,/\{from:news-noreply@news\.pitchbook\.com \(from:\(pitchbook\.com\)/);
 assert.deepEqual(s.calls.filter(call=>call.stage==='full').map(call=>call.id),['bb']);assert.equal(s.modelInputs[0],body);
 assert.equal((await s.client.listNews(store)).providers.find(p=>p.id==='dailypitch').latest.subject,'Private markets in focus');
 await s.client.syncNews(store);assert.equal(s.modelInputs.length,1);
});

test('the exact PitchBook sender only permits body inspection, never summary of unrelated or unselected mail',async()=>{
 const sender='PitchBook News <news-noreply@news.pitchbook.com>';
 const unrelated=service({messages:[message('aa',{subject:'Your saved company search alert',sender,listId:'Saved alerts',body:EVIDENCE})]}),store=await enable(unrelated.client,student(),['dailypitch']);
 assert.equal((await unrelated.client.syncNews(store)).processed,0);assert.equal(unrelated.modelInputs.length,0);assert.deepEqual(await store.all('newsSummaries'),[]);
 const unselected=service({messages:[message('bb',{subject:'Private markets in focus',sender,listId:'',body:`The Daily Pitch\n${EVIDENCE}`})]});
 await unselected.client.syncNews(await enable(unselected.client));assert.equal(unselected.calls.filter(call=>call.stage==='full').length,0);assert.equal(unselected.modelInputs.length,0);
});

test('PitchBook sender shortcut rejects lookalikes, different mailboxes and multiple sender addresses',async()=>{
 const senders=['news-noreply@news.pitchbook.com.evil.test','news-noreply@other.pitchbook.com','other@news.pitchbook.com','PitchBook News <news-noreply@news.pitchbook.com>, attacker@example.test','"news-noreply@news.pitchbook.com" <attacker@example.test>'];
 const s=service({messages:senders.map((sender,i)=>message(`a${i}`,{subject:'Private markets in focus',sender,listId:'',body:`The Daily Pitch\n${EVIDENCE}`}))}),store=await enable(s.client,student(),['dailypitch']);
 assert.equal((await s.client.syncNews(store)).processed,0);assert.equal(s.calls.filter(call=>call.stage==='full').length,0);assert.equal(s.modelInputs.length,0);
});

test('a rejected exact-sender message cannot hide a valid edition on later refreshes',async()=>{
 const sender='PitchBook News <news-noreply@news.pitchbook.com>',body=`The Daily Pitch\n${EVIDENCE}`;
 const s=service({messages:[message('aa',{age:DAY,subject:'Private markets in focus',sender,listId:'',body}),message('bb',{subject:'Your saved company search alert',sender,listId:'Saved alerts',body:'PRIVATE UNRELATED ALERT BODY'})]}),store=await enable(s.client,student(),['dailypitch']);
 const first=await s.client.syncNews(store);assert.equal(first.read,1);assert.equal(first.processed,0);assert.equal(s.modelInputs.length,0);
 const rejection=await store.get('newsMessages',idFor('gmail-news',grant.subject,'bb'));
 assert.equal(rejection.status,'not-newsletter');assert.equal(rejection.provider,'dailypitch');assert.doesNotMatch(JSON.stringify([...store.records]),/PRIVATE UNRELATED ALERT BODY/);
 assert.equal((await store.get('settings','newsEmail')).latestReceivedAt.dailypitch,undefined,'rejection does not advance the accepted-edition watermark');
 const second=await s.client.syncNews(store);assert.equal(second.read,1);assert.equal(second.processed,1);assert.deepEqual(s.modelInputs,[body]);
 const third=await s.client.syncNews(store);assert.equal(third.read,0);assert.equal(third.processed,0);
 assert.deepEqual(s.calls.filter(call=>call.stage==='full').map(call=>call.id),['bb','aa']);assert.equal((await store.all('newsSummaries')).length,1);
});

test('rejected-message markers are scoped to both the mailbox and selected provider',async()=>{
 const sender='PitchBook News <news-noreply@news.pitchbook.com>',body=`The Daily Pitch\n${EVIDENCE}`;
 for(const [subject,provider] of [['another-mailbox','dailypitch'],[grant.subject,'wsj10point']]){
  const s=service({messages:[message('aa',{subject:'Private markets in focus',sender,listId:'',body})]}),store=await enable(s.client,student(),['dailypitch']),id=idFor('gmail-news',subject,'aa');
  await store.put('newsMessages',id,{id,provider,status:'not-newsletter',createdAt:new Date(NOW).toISOString()});
  assert.equal((await s.client.syncNews(store)).processed,1);assert.deepEqual(s.modelInputs,[body]);
 }
});

test('two opted-in providers get at most one current edition each rather than two editions from one publisher',async()=>{
 const s=service({messages:[message('11',{age:DAY}),message('22',{age:1000}),message('33',{age:2000,subject:'The Daily Pitch',sender:'news@pitchbook.com',listId:'The Daily Pitch <pitchbook.com>',body:`The Daily Pitch\n${EVIDENCE}`}),message('44',{age:2*DAY,subject:'The Daily Pitch',sender:'news@pitchbook.com',listId:'The Daily Pitch <pitchbook.com>',body:`The Daily Pitch\n${EVIDENCE}`})]}),store=await enable(s.client,student(),['wsj10point','dailypitch']);
 await s.client.syncNews(store);assert.deepEqual(s.calls.filter(call=>call.stage==='full').map(call=>call.id).sort(),['22','33']);assert.equal(s.modelInputs.length,2);
});

test('spam, trash, impossible future dates and old editions do not reach the model',async()=>{
 const s=service({messages:[message('11',{labels:['SPAM']}),message('22',{labels:['TRASH']}),message('33',{age:-2*DAY}),message('44',{age:31*DAY}),message('55',{age:1000})]}),store=await enable(s.client);await s.client.syncNews(store);
 assert.deepEqual(s.calls.filter(call=>call.stage==='full').map(call=>call.id),['55']);assert.equal(s.modelInputs.length,1);
});

test('withdrawn publisher consent during metadata discovery prevents full body fetches',async()=>{
 const store=student();let client,withdrawn=false;
 const s=service({beforeResponse:async(stage)=>{if(stage==='metadata'&&!withdrawn){withdrawn=true;await client.saveNewsSettings(store,{sources:[]});}}});client=s.client;await enable(client,store);
 await assert.rejects(client.syncNews(store),error=>error.status===409);
 assert.equal(s.calls.filter(call=>call.stage==='full').length,0);assert.equal(s.modelInputs.length,0);assert.deepEqual(await store.all('newsSummaries'),[]);
 assert.deepEqual((await store.get('settings','news')).sources,[]);
});

test('mailbox replacement or revocation during a full-body response cannot feed old data to the model',async()=>{
 for(const change of ['replacement','revocation']){
  const store=student(),s=service({beforeResponse:async(stage)=>{if(stage==='full')change==='replacement'?await store.put('secrets','eventEmailGoogle',{...grant,subject:'mailbox-b',connectionRevision:'mailbox-b'}):await store.delete('secrets','eventEmailGoogle');}});await enable(s.client,store);
  await assert.rejects(s.client.syncNews(store),error=>[403,409].includes(error.status));assert.equal(s.modelInputs.length,0);assert.deepEqual(await store.all('newsSummaries'),[]);
 }
});

test('pause, deletion and monitor disconnect during generation prevent persistence without restoring monitoring',async()=>{
 for(const change of ['pause','delete','disconnect']){
  const store=student();let client;const s=service({summarize:async()=>{if(change==='pause')await store.put('settings','profile',{paused:true});if(change==='delete')await store.put('settings','account',{deleting:true});if(change==='disconnect')await client.disconnectNews(store);return result();}});client=s.client;await enable(client,store);
  await assert.rejects(client.syncNews(store),error=>error.status===409);assert.deepEqual(await store.all('newsSummaries'),[]);
  if(change==='disconnect')assert.equal((await store.get('settings','newsEmail')).continuous,false);
 }
});

test('automatic summaries and credentials remain isolated even when Gmail message IDs match across students',async()=>{
 const s=service(),alice=await enable(s.client,student('alice')),bob=student('bob');
 await s.client.syncNews(alice);const [summary]=await alice.all('newsSummaries');
 await assert.rejects(s.client.syncNews(bob),error=>[400,403].includes(error.status));assert.equal(await s.client.getNewsSummary(bob,summary.id),null);
 await enable(s.client,bob);await s.client.syncNews(bob);assert.equal((await bob.all('newsSummaries')).length,1);
 await s.client.saveNewsSettings(alice,{sources:[]});assert.ok(await s.client.getNewsSummary(bob,summary.id));assert.equal(await s.client.getNewsSummary(alice,summary.id),null);
 assert.equal(s.modelInputs.length,2);
});

test('a missing newest email does not make later refreshes backfill older editions',async()=>{
 const messages=[message('aa',{age:3*DAY}),message('bb',{age:1000})],s=service({messages}),store=await enable(s.client);
 await s.client.syncNews(store);messages.splice(1,1);await s.client.syncNews(store);
 assert.deepEqual(s.calls.filter(call=>call.stage==='full').map(call=>call.id),['bb']);
 assert.equal(s.modelInputs.length,1);assert.equal((await store.all('newsSummaries')).length,1);
});

test('automatic setup cannot restore a publisher selection withdrawn between its settings writes',async()=>{
 const store=student(),s=service();await store.put('secrets','eventEmailGoogle',grant);
 const cas=store.compareAndSet.bind(store);let changed=false;
 store.compareAndSet=async(bucket,id,before,after)=>{
  if(bucket==='settings'&&id==='newsEmail'&&after?.continuous&&!changed){changed=true;await s.client.saveNewsSettings(store,{sources:[]});}
  return cas(bucket,id,before,after);
 };
 await assert.rejects(s.client.startAutomaticNews(store,{sources:['wsj10point']}),error=>error.status===409);
 assert.deepEqual((await store.get('settings','news')).sources,[]);assert.notEqual((await store.get('settings','newsEmail'))?.continuous,true);
 assert.equal(s.calls.length,0);assert.equal(s.modelInputs.length,0);
});

test('a label-free body read requires the same original metadata proof and owning student',async()=>{
 const alice=student('alice'),bob=student('bob');for(const store of [alice,bob])await store.put('secrets','eventEmailGoogle',grant);
 let full=0;const reader=createPrivateEmailReader({now,fetchImpl:async(url)=>{const u=new URL(url);if(u.searchParams.get('format')==='full'){full++;return json(message('aa'));}return json({...message('aa'),payload:{headers:message('aa').payload.headers}});}});
 const metadata=await reader.readMetadata(alice,{id:'aa',connectionRevision:grant.connectionRevision});
 for(const [store,proof]of [[bob,metadata],[alice,structuredClone(metadata)],[alice,{...metadata,sender:'attacker@wsj.com'}]])await assert.rejects(reader.readMessage(store,{id:'aa',metadata:proof,connectionRevision:grant.connectionRevision}),error=>error.status===400);
 assert.equal(full,0);
});

test('no matching newsletter reports missing sources and never reads a message body',async()=>{
 const s=service({messages:[]}),store=await enable(s.client),out=await s.client.syncNews(store);
 assert.deepEqual(out.missingSources,['wsj10point']);assert.equal(out.processed,0);assert.equal(out.truncated,false);
 assert.equal(s.calls.filter(call=>call.stage!=='list').length,0);assert.equal(s.modelInputs.length,0);
});

test('a persisted first-provider summary blocks old backfill even when another provider interrupts the refresh',async()=>{
 const messages=[message('aa',{age:3*DAY}),message('bb',{age:1000}),message('cc',{age:2000,subject:'The Daily Pitch',sender:'news@pitchbook.com',listId:'The Daily Pitch <pitchbook.com>',body:`The Daily Pitch\n${EVIDENCE}`})];
 let failed=false;const s=service({messages,summarize:async(body,{provider})=>{if(provider.id==='dailypitch'&&!failed){failed=true;throw new Error('Synthetic second-provider interruption');}return result();}}),store=await enable(s.client,student(),['wsj10point','dailypitch']);
 await assert.rejects(s.client.syncNews(store),/Synthetic second-provider interruption/);
 assert.equal((await store.all('newsSummaries')).length,1);messages.splice(1,1);await s.client.syncNews(store);
 assert.equal(s.calls.filter(call=>call.stage==='full'&&call.id==='aa').length,0);
 assert.equal((await store.all('newsSummaries')).length,2);
 assert.doesNotMatch(JSON.stringify(await s.client.listNews(store)),/mailboxKey|owned-mailbox-a/);
});
