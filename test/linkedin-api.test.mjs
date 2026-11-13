import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';

const header='First Name,Last Name,URL,Email Address,Company,Position,Connected On';
const exportCSV=(name,company,slug)=>`${header}\n${name},Example,https://www.linkedin.com/in/${slug}?trk=PRIVATE_LINK_QUERY,PRIVATE_CSV_EMAIL@example.test,${company},Product Manager,10 Nov 2026\n`;

// Synthetic isolated web process only. No worker/model/LinkedIn/Telegram runs;
// disabling child fetch also prevents accidental outbound provider requests.
test('LinkedIn connections HTTP routes keep imports private, job matches owned, and refresh consent explicit',{timeout:30000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brf-linkedin-api-')),origin='http://127.0.0.1:4361';
 const env={PATH:process.env.PATH,LANG:'en_US.UTF-8',NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4361',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:randomBytes(32).toString('base64'),DEV_AUTH_EMAILS:'linkedin-a@cornell.edu,linkedin-b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
 const guard=path.join(dir,'no-network.mjs');await writeFile(guard,"globalThis.fetch=async()=>{throw new Error('Provider calls disabled in synthetic LinkedIn API test');};\n");
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--import',guard,'server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});let output='',database,queue;
 child.stdout.on('data',chunk=>{output=(output+chunk).slice(-12000);});child.stderr.on('data',chunk=>{output=(output+chunk).slice(-12000);});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),11000);timer.unref();try{await stopped;}finally{clearTimeout(timer);}}await queue?.close();await database?.close();await rm(dir,{recursive:true,force:true});});
 let started=false;for(let i=0;i<150;i++){try{started=(await fetch(origin+'/healthz')).ok;}catch{}if(started)break;if(child.exitCode!==null)throw new Error(`Synthetic server failed: ${output}`);await delay(50);}assert.ok(started,output);
 async function login(email){const response=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');return {...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json(),cookie};}
 async function api(user,route,body,headers={}){const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{Cookie:user.cookie,Origin:origin,'Content-Type':'application/json','X-CSRF-Token':user.csrfToken,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
 for(const route of ['/api/career/linkedin','/api/career/linkedin/matches?jobId=shared'])assert.equal((await fetch(origin+route)).status,401);
 for(const route of ['/api/career/linkedin/import','/api/career/linkedin/settings','/api/career/linkedin/delete'])assert.equal((await fetch(origin+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,401);
 const alice=await login('linkedin-a@cornell.edu'),bob=await login('linkedin-b@cornell.edu');database=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});queue=await createQueue(database,{workerDatabaseUrl:null});const a=database.forUser(alice.user.id),b=database.forUser(bob.user.id);
 const aliceCSV=exportCSV('ALICE_PRIVATE_CONNECTION','Acme Inc.','alice-private-connection'),bobCSV=exportCSV('BOB_PRIVATE_CONNECTION','Other LLC','bob-private-connection');let first,second,bobImport;

 await t.test('authentication, CSRF, and origin checks precede any import or preference change',async()=>{
  const initial=await api(alice,'/api/career/linkedin');assert.equal(initial.status,200);assert.equal(initial.body.connected,false);assert.equal(initial.body.refreshDays,null);assert.equal(initial.body.version,null);
  assert.equal((await api(alice,'/api/career/linkedin/import',{csv:aliceCSV},{'X-CSRF-Token':''})).status,403);
  assert.equal((await api(alice,'/api/career/linkedin/import',{csv:aliceCSV},{'X-CSRF-Token':bob.csrfToken})).status,403);
  assert.equal((await api(alice,'/api/career/linkedin/settings',{refreshDays:7},{Origin:'https://attacker.example'})).status,403);
  assert.equal((await api(alice,'/api/career/linkedin/delete',{}, {'X-CSRF-Token':''})).status,403);
  assert.equal((await api(alice,'/api/career/linkedin',undefined,{'Sec-Fetch-Site':'cross-site'})).status,403);assert.equal(await a.get('career','linkedinConnections'),null);
 });

 await t.test('imports expose metadata only and never store email columns, raw CSV or filename',async()=>{
  const imported=await api(alice,'/api/career/linkedin/import',{csv:aliceCSV,name:'PRIVATE_SOURCE_FILENAME.csv',expectedVersion:null,requestId:'alice-import-one'});assert.equal(imported.status,200);first=imported.body;assert.equal(first.count,1);assert.equal(first.connected,true);assert.equal(first.refreshDays,null);assert.equal(first.refreshDue,false);assert.ok(first.sourceVersion);assert.ok(first.version);assert.equal(first.contacts,undefined);assert.equal(first.csv,undefined);assert.match(first.notice,/not verified current employment/);
  const other=await api(bob,'/api/career/linkedin/import',{csv:bobCSV,requestId:'bob-import-one'});assert.equal(other.status,200);bobImport=other.body;assert.notEqual(first.sourceVersion,bobImport.sourceVersion);
  for(const user of [alice,bob]){const metadata=(await api(user,'/api/career/linkedin')).body,state=(await api(user,'/api/state')).body;assert.equal(state.linkedinConnections.count,1);assert.equal(state.linkedinConnections.contacts,undefined);assert.doesNotMatch(JSON.stringify(metadata),/ALICE_PRIVATE_CONNECTION|BOB_PRIVATE_CONNECTION|PRIVATE_CSV_EMAIL|PRIVATE_SOURCE_FILENAME|PRIVATE_LINK_QUERY|First Name/);assert.doesNotMatch(JSON.stringify(state),/ALICE_PRIVATE_CONNECTION|BOB_PRIVATE_CONNECTION|PRIVATE_CSV_EMAIL|PRIVATE_SOURCE_FILENAME|PRIVATE_LINK_QUERY|First Name/);}
  const stored=await a.get('career','linkedinConnections');assert.equal(stored.contacts.length,1);assert.equal(stored.contacts[0].name,'ALICE_PRIVATE_CONNECTION Example');assert.equal(stored.contacts[0].email,undefined);assert.doesNotMatch(JSON.stringify(stored),/PRIVATE_CSV_EMAIL|PRIVATE_SOURCE_FILENAME|PRIVATE_LINK_QUERY|First Name/);
 });

 await t.test('matches are derived from each student’s own saved job rather than caller-supplied company or student ID',async()=>{
  await a.put('jobs','shared',{id:'shared',title:'Alice saved role',company:'Acme LLC'});await b.put('jobs','shared',{id:'shared',title:'Bob saved role',company:'Other Inc.'});await b.put('jobs','bob-only',{id:'bob-only',company:'Other LLC',title:'Bob private saved role'});await a.put('jobs','acme-bank',{id:'acme-bank',company:'Acme Bank',title:'Different company'});
  const own=await api(alice,`/api/career/linkedin/matches?jobId=shared&company=Other&userId=${bob.user.id}`);assert.equal(own.status,200);assert.equal(own.body.totalMatches,1);assert.equal(own.body.matches[0].name,'ALICE_PRIVATE_CONNECTION Example');assert.equal(own.body.matches[0].url,'https://www.linkedin.com/in/alice-private-connection');assert.doesNotMatch(JSON.stringify(own.body),/BOB_PRIVATE_CONNECTION|PRIVATE_CSV_EMAIL|PRIVATE_LINK_QUERY/);assert.equal(own.body.sourceVersion,first.sourceVersion);
  assert.match(own.body.matches[0].referralDraft,/ALICE_PRIVATE_CONNECTION/);assert.match(own.body.matches[0].referralDraft,/Alice saved role/);assert.match(own.body.matches[0].referralDraft,/Acme LLC/);assert.match(own.body.matches[0].referralDraft,/referr/i);assert.doesNotMatch(own.body.matches[0].referralDraft,/Bob saved role|Other Inc/);
  const foreign=await api(alice,'/api/career/linkedin/matches?jobId=bob-only');assert.equal(foreign.status,404);assert.doesNotMatch(JSON.stringify(foreign.body),/Bob private|BOB_PRIVATE/);
  const bobOwn=await api(bob,'/api/career/linkedin/matches?jobId=shared');assert.equal(bobOwn.body.matches[0].name,'BOB_PRIVATE_CONNECTION Example');assert.doesNotMatch(JSON.stringify(bobOwn.body),/ALICE_PRIVATE_CONNECTION/);
  assert.match(bobOwn.body.matches[0].referralDraft,/Bob saved role/);assert.match(bobOwn.body.matches[0].referralDraft,/Other Inc/);assert.doesNotMatch(bobOwn.body.matches[0].referralDraft,/Alice saved role|Acme/);assert.deepEqual(await queue.list(alice.user.id),[]);assert.deepEqual(await queue.list(bob.user.id),[]);
  assert.equal((await api(alice,'/api/career/linkedin/matches?jobId=acme-bank')).body.totalMatches,0);assert.equal((await api(alice,'/api/career/linkedin/matches')).status,400);assert.equal((await api(alice,'/api/career/linkedin/matches?jobId='+ 'x'.repeat(201))).status,400);
 });

 await t.test('biweekly, monthly, quarterly and legacy weekly reminders are explicit, validated, and student-owned',async()=>{
  assert.equal((await api(alice,'/api/career/linkedin/settings',{refreshDays:7},{'X-CSRF-Token':''})).status,403);
  for(const invalid of [{},{refreshDays:1},{refreshDays:31},{refreshDays:'7'},{refreshDays:0},{refreshDays:7,userId:bob.user.id},[],null])assert.equal((await api(alice,'/api/career/linkedin/settings',invalid)).status,400);
  const weekly=await api(alice,'/api/career/linkedin/settings',{refreshDays:7});assert.equal(weekly.status,200);assert.equal(weekly.body.refreshDays,7);assert.ok(weekly.body.nextRefreshAt);assert.equal(weekly.body.sourceVersion,first.sourceVersion);assert.notEqual(weekly.body.version,first.version);assert.equal((await api(bob,'/api/career/linkedin')).body.refreshDays,null);
  const biweekly=await api(bob,'/api/career/linkedin/settings',{refreshDays:14});assert.equal(biweekly.status,200);assert.equal(biweekly.body.refreshDays,14);assert.equal((await api(alice,'/api/career/linkedin')).body.refreshDays,7);
  for(const days of [30,90]){const saved=await api(alice,'/api/career/linkedin/settings',{refreshDays:days});assert.equal(saved.status,200);assert.equal(saved.body.refreshDays,days);assert.equal(Date.parse(saved.body.nextRefreshAt)-Date.parse(saved.body.importedAt),days*86400000);assert.equal((await api(bob,'/api/career/linkedin')).body.refreshDays,14);}
  assert.equal((await api(alice,'/api/career/linkedin/settings',{refreshDays:null})).body.refreshDays,null);assert.equal((await api(alice,'/api/career/linkedin/settings',{refreshDays:7})).body.refreshDays,7);
 });

 await t.test('malformed or stale replacements retain current contacts and valid replacement is atomic',async()=>{
  const current=(await api(alice,'/api/career/linkedin')).body;assert.equal((await api(alice,'/api/career/linkedin/import',{csv:'PRIVATE_BAD_CSV'})).status,400);assert.equal((await api(alice,'/api/career/linkedin/import',{csv:aliceCSV,userId:bob.user.id})).status,400);const stale=await api(alice,'/api/career/linkedin/import',{csv:aliceCSV,expectedVersion:first.version});assert.equal(stale.status,409);assert.equal((await api(alice,'/api/career/linkedin')).body.sourceVersion,current.sourceVersion);
  const replaced=await api(alice,'/api/career/linkedin/import',{csv:exportCSV('ALICE_NEW_CONNECTION','New Employer LLC','alice-new-connection'),name:'Connections.csv',expectedVersion:current.version,requestId:'alice-import-two'});assert.equal(replaced.status,200);second=replaced.body;assert.notEqual(second.sourceVersion,first.sourceVersion);assert.equal(second.refreshDays,7);assert.equal((await api(alice,'/api/career/linkedin/matches?jobId=shared')).body.totalMatches,0);assert.equal((await api(bob,'/api/career/linkedin/matches?jobId=shared')).body.totalMatches,1);
  const replay=await api(alice,'/api/career/linkedin/import',{csv:aliceCSV,requestId:'alice-import-one'});assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(replay.body.sourceVersion,second.sourceVersion);assert.equal((await api(alice,'/api/career/linkedin/matches?jobId=shared')).body.totalMatches,0);
 });

 await t.test('deletion clears names, matches, and refresh preference without touching another student or sending anything',async()=>{
  assert.equal((await api(alice,'/api/career/linkedin/delete',{userId:bob.user.id})).status,400);const deleted=await api(alice,'/api/career/linkedin/delete',{});assert.equal(deleted.status,200);assert.equal(deleted.body.connected,false);assert.equal(deleted.body.count,0);assert.equal(deleted.body.refreshDays,null);assert.equal(deleted.body.refreshDue,false);assert.equal(deleted.body.nextRefreshAt,null);assert.notEqual(deleted.body.sourceVersion,second.sourceVersion);
  const stored=await a.get('career','linkedinConnections');assert.deepEqual(stored.contacts,[]);assert.equal(stored.contentHash,null);assert.doesNotMatch(JSON.stringify(stored),/ALICE_PRIVATE_CONNECTION|ALICE_NEW_CONNECTION|linkedin\.com\/in|PRIVATE_CSV_EMAIL/);assert.equal((await api(alice,'/api/career/linkedin/matches?jobId=shared')).body.matches.length,0);
  const retry=await api(alice,'/api/career/linkedin/import',{csv:aliceCSV,requestId:'alice-import-one'});assert.equal(retry.status,200);assert.equal(retry.body.replayed,true);assert.equal(retry.body.connected,false);assert.equal((await api(bob,'/api/career/linkedin')).body.count,1);assert.equal((await api(bob,'/api/career/linkedin')).body.refreshDays,14);
  const state=(await api(alice,'/api/state')).body;assert.equal(state.linkedinConnections.count,0);assert.doesNotMatch(JSON.stringify(state),/ALICE_PRIVATE_CONNECTION|ALICE_NEW_CONNECTION|BOB_PRIVATE_CONNECTION|PRIVATE_CSV_EMAIL/);assert.deepEqual(await queue.list(alice.user.id),[]);assert.deepEqual(await queue.list(bob.user.id),[]);assert.deepEqual(await database.system.all('workerHealth'),[]);
 });
});
