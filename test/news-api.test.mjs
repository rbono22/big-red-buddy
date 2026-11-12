import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';

// Only the web process runs. Newsletter bodies remain in the synthetic local
// queue: no worker, model, mailbox request, Telegram bot, or provider call runs.
test('news and notification HTTP endpoints preserve consent, private ownership, and shared-mailbox boundaries',{timeout:30000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brf-news-api-')),origin='http://127.0.0.1:4357';
 const env={PATH:process.env.PATH,LANG:'en_US.UTF-8',NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4357',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64'),DEV_AUTH_EMAILS:'news-a@cornell.edu,news-b@cornell.edu,news-legacy@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});let output='',database,queue;
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),11000);timer.unref();try{await stopped;}finally{clearTimeout(timer);}}await queue?.close();await database?.close();await rm(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<150;i++){try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(`Synthetic test server failed: ${output}`);await delay(50);}assert.ok(ready,output);
 async function login(email){const r=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(r.status,200);const cookie=r.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');return{...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json(),cookie};}
 async function api(user,route,body,headers={}){const r=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{Cookie:user.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':user.csrfToken,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};}
 for(const route of ['/api/news','/api/news/labels','/api/notifications/settings'])assert.equal((await fetch(origin+route)).status,401);
 const alice=await login('news-a@cornell.edu'),bob=await login('news-b@cornell.edu'),legacy=await login('news-legacy@cornell.edu');
 database=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});queue=await createQueue(database,{workerDatabaseUrl:null});
 const a=database.forUser(alice.user.id),b=database.forUser(bob.user.id),old=database.forUser(legacy.user.id);
 await old.put('settings','profile',{name:'Existing synthetic student',paused:false});
 const fresh=(await api(alice,'/api/notifications/settings')).body;
 assert.equal(fresh.enabled,true);assert.deepEqual(fresh.topics,{school:'off',events:'off',jobs:'off',news:'off',games:'off'});assert.equal(fresh.available.games,false);
 const existing=(await api(legacy,'/api/notifications/settings')).body;
 assert.deepEqual(existing.topics,{school:'both',events:'both',jobs:'both',news:'off',games:'off'},'legacy delivery is preserved only for an existing profile');
 assert.equal((await api(alice,'/api/notifications/settings',{enabled:false},{'X-CSRF-Token':''})).status,403);
 assert.equal((await api(alice,'/api/notifications/settings',{enabled:false},{'X-CSRF-Token':bob.csrfToken})).status,403);
 assert.equal((await api(alice,'/api/news/settings',{sources:['wsj10point']},{Origin:'https://attacker.example'})).status,403);
 assert.equal((await api(alice,'/api/news',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);
 for(const bad of [{enabled:'yes'},{topics:{news:'always'}},{topics:{unknown:'alerts'}},{topics:{}},{enabled:false,userId:bob.user.id}])assert.equal((await api(alice,'/api/notifications/settings',bad)).status,400);
 const choices=await api(alice,'/api/notifications/settings',{enabled:false,topics:{news:'daily',games:'both'}});
 assert.equal(choices.status,200);assert.equal(choices.body.enabled,false);assert.equal(choices.body.topics.news,'daily');assert.equal(choices.body.topics.games,'both');assert.equal(choices.body.available.games,false,'saving a future game preference does not activate games');assert.ok(choices.body.revision>fresh.revision);
 assert.deepEqual((await api(bob,'/api/notifications/settings')).body.topics,{school:'off',events:'off',jobs:'off',news:'off',games:'off'});
 const initial=(await api(alice,'/api/news')).body;assert.deepEqual(initial.settings.sources,[]);assert.equal(initial.summaries.length,0);assert.equal(initial.mailbox.connected,false);
 assert.equal((await api(alice,'/api/news/settings',{sources:['wsj10point']},{'X-CSRF-Token':''})).status,403);
 for(const invalid of [{sources:['not-a-publisher']},{sources:['wsj10point','wsj10point']},{sources:'wsj10point'},{sources:['wsj10point'],includeInBriefing:true},{sources:['wsj10point'],userId:bob.user.id}])assert.equal((await api(alice,'/api/news/settings',invalid)).status,400);
 assert.equal((await api(alice,'/api/news/settings',{sources:['wsj10point']})).status,200);
 assert.equal((await api(alice,'/api/notifications/settings')).body.topics.news,'daily','source reading consent does not overwrite delivery choices');
 assert.deepEqual((await api(bob,'/api/news')).body.settings.sources,[]);
 assert.equal((await api(alice,'/api/news/labels')).status,403,'no mailbox credentials means no label listing');
 assert.equal((await api(bob,'/api/news/select',{labelId:'alice-label'})).status,403);
 const stamp=new Date().toISOString(),summaryId='a'.repeat(32);
 await a.put('newsSummaries',summaryId,{id:summaryId,provider:'wsj10point',name:'WSJ · The 10-Point',subject:'ALICE_PRIVATE_NEWS_EDITION',date:stamp.slice(0,10),receivedAt:stamp,createdAt:stamp,bullets:[{text:'ALICE_PRIVATE_NEWS_SUMMARY',url:'https://wsj.com/business/example-story?private=TOKEN#fragment',evidence:'INTERNAL_NEWS_EVIDENCE'}],warnings:[],source:{kind:'gmail',senderDomainMatched:true,sender:'INTERNAL_SENDER'},contentHash:'INTERNAL_CONTENT_HASH',rawBody:'INTERNAL_RAW_NEWS_BODY'});
 const view=(await api(alice,'/api/news')).body;
 assert.equal(view.summaries[0].subject,'ALICE_PRIVATE_NEWS_EDITION');assert.equal(view.summaries[0].bullets[0].url,'https://www.wsj.com/business/example-story');assert.doesNotMatch(JSON.stringify(view),/INTERNAL_NEWS_EVIDENCE|INTERNAL_RAW_NEWS_BODY|INTERNAL_SENDER|INTERNAL_CONTENT_HASH|private=TOKEN/);
 assert.doesNotMatch(JSON.stringify((await api(bob,'/api/news')).body),/ALICE_PRIVATE_NEWS/);
 assert.equal((await api(alice,'/api/news/import',{provider:'rss',text:'A synthetic newsletter that is long enough.'})).status,400);
 assert.equal((await api(alice,'/api/news/import',{provider:'wsj10point',text:'short'})).status,400);
 assert.equal((await api(alice,'/api/news/import',{provider:'wsj10point',text:'Synthetic newsletter body with enough characters.',format:'pdf'})).status,400);
 assert.equal((await api(alice,'/api/news/import',{provider:'wsj10point',text:'😀'.repeat(25001)})).status,400,'the limit counts bytes, not Unicode characters');
 const imported=await api(alice,'/api/news/import',{provider:'wsj10point',name:'Synthetic newsletter',text:'ALICE_QUEUED_NEWS_BODY for a private, explicit local test.',format:'text',userId:bob.user.id});assert.equal(imported.status,202);
 const job=await queue.get(alice.user.id,imported.body.taskId);assert.equal(job.type,'news-import');assert.equal(job.userId,alice.user.id);assert.equal(job.payload,undefined,'student queue views omit private job input');const claimed=await queue.claim('synthetic-news-api-review',{types:['news-import'],leaseMs:90000});assert.equal(claimed.id,job.id);assert.equal(claimed.userId,alice.user.id);assert.equal(claimed.payload.userId,undefined);assert.match(claimed.payload.text,/ALICE_QUEUED_NEWS_BODY/);assert.equal(await queue.get(bob.user.id,imported.body.taskId),null);
 assert.equal((await api(bob,'/api/tasks')).body.length,0);assert.doesNotMatch(JSON.stringify((await api(alice,'/api/tasks')).body),/ALICE_QUEUED_NEWS_BODY/);
 await a.put('secrets','eventEmailGoogle',{subject:'synthetic-google-user',email:'synthetic-private@example.com',scope:'https://www.googleapis.com/auth/gmail.readonly',connectionRevision:'synthetic-connection',refresh_token:'SYNTHETIC_PRIVATE_REFRESH_TOKEN'});
 await a.put('settings','eventEmail',{labelId:'event-label',connectionRevision:'synthetic-connection',revision:'events-revision',continuous:true});
 await a.put('settings','newsEmail',{labelId:'news-label',labelName:'Private newsletter label',connectionRevision:'synthetic-connection',revision:'news-revision',continuous:true});
 assert.equal((await api(bob,'/api/news/disconnect',{})).status,200);assert.equal((await a.get('settings','newsEmail')).continuous,true,'one student cannot stop another student source');
 assert.equal((await api(alice,'/api/news/disconnect',{})).status,200);assert.equal((await a.get('settings','newsEmail')).continuous,false);assert.equal((await a.get('settings','eventEmail')).continuous,true);assert.equal((await a.get('secrets','eventEmailGoogle')).refresh_token,'SYNTHETIC_PRIVATE_REFRESH_TOKEN');
 const after=(await api(alice,'/api/news')).body;assert.equal(after.mailbox.connected,true);assert.equal(after.mailbox.continuous,false);assert.equal(after.summaries[0].id,summaryId);assert.doesNotMatch(JSON.stringify(after),/SYNTHETIC_PRIVATE_REFRESH_TOKEN/);
 assert.equal((await api(alice,'/api/news/settings',{sources:[]})).status,200);assert.equal((await api(alice,'/api/news')).body.summaries.length,0,'deselected sources are excluded from delivery summary selection');
 assert.equal((await b.all('newsSummaries')).length,0);
});
