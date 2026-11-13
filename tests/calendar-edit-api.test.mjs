import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {openDatabase} from '../lib/database.mjs';
import {createQueue} from '../lib/queue.mjs';
import {CALENDAR_EDIT_SCOPES,CALENDAR_SCOPE,CAMPUS_CALENDAR_SCOPES,identityId} from '../lib/auth.mjs';
import {idFor,localISO} from '../lib/domain.mjs';
import {writeCalendarTombstones} from '../lib/calendar-mutations.mjs';

const token=()=>randomBytes(32).toString('base64url');
const hash=value=>createHash('sha256').update(value).digest('hex');

test('calendar editing consent, disconnect and removal guards remain student-owned over HTTP',{timeout:30000},async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'brb-calendar-edit-api-')),origin='http://127.0.0.1:4386';
  const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:'4386',APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),SESSION_SECRET:token(),PILOT_EMAILS:'calendar-a@cornell.edu,calendar-b@cornell.edu',GOOGLE_CLIENT_ID:'synthetic.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'synthetic-only',OLLAMA_URL:'http://127.0.0.1:1'};
  let database,queue,output='';
  const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}await queue?.close();await database?.close();await rm(dir,{recursive:true,force:true});});
  let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(origin+'/healthz')).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(output);await delay(50);}assert.ok(ready,output);
  database=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false});queue=await createQueue(database,{workerDatabaseUrl:null});
  async function account(letter){
    const subject=`synthetic-calendar-${letter}`,id=identityId('google',subject),raw=token(),csrfToken=token(),email=`calendar-${letter}@cornell.edu`;
    await database.auth.put('users',id,{id,provider:'google',subject,email,name:`Student ${letter}`,hostedDomain:'cornell.edu'});
    await database.auth.put('sessions',hash(raw),{idHash:hash(raw),userId:id,createdAt:Date.now(),expiresAt:Date.now()+3600000,csrfToken,epoch:'initial'});
    return {id,subject,email,csrfToken,cookie:`dabas_session=${raw}`,store:database.forUser(id)};
  }
  const get=(a,route)=>fetch(origin+route,{headers:a?{Cookie:a.cookie}:{}});
  async function post(a,route,body={},headers={}){const r=await fetch(origin+route,{method:'POST',headers:{Cookie:a?.cookie||'',Origin:origin,'Content-Type':'application/json','X-CSRF-Token':a?.csrfToken||'',...headers},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};}
  const a=await account('a'),b=await account('b');
  const grant=owner=>({subject:owner.subject,email:owner.email,connectionRevision:token(),connectedAt:new Date().toISOString(),refresh_token:'EDIT_REFRESH_SECRET',access_token:'EDIT_ACCESS_SECRET',scope:CALENDAR_EDIT_SCOPES.join(' ')});

  await t.test('connection requires authentication, CSRF, same origin and explicit POST',async()=>{
    assert.equal((await post(null,'/api/calendar-edit/connect')).status,401);
    for(const headers of [{'X-CSRF-Token':''},{'X-CSRF-Token':b.csrfToken},{Origin:'https://untrusted.example'}])assert.equal((await post(a,'/api/calendar-edit/connect',{},headers)).status,403);
    assert.equal((await get(a,'/api/calendar-edit/connect')).status,404);
    const result=await post(a,'/api/calendar-edit/connect',{userId:b.id,email:b.email});assert.equal(result.status,200);
    const params=new URL(result.body.url).searchParams;
    assert.deepEqual(params.get('scope').split(' '),['openid','email','profile',...CALENDAR_EDIT_SCOPES]);assert.equal(params.get('prompt'),'consent');assert.equal(params.get('login_hint'),a.email);
    const pending=await database.auth.get('oauth_states',hash(params.get('state')));assert.equal(pending.userId,a.id);assert.equal(pending.returnPath,'/#calendar-edit');
    assert.equal(await a.store.get('secrets','calendarEditGoogle'),null);assert.equal(await b.store.get('secrets','calendarEditGoogle'),null);assert.deepEqual(await queue.list(a.id),[]);
  });
  await t.test('state exposes connection status without credentials and ignores a copied account grant',async()=>{
    const saved=grant(a);await a.store.put('secrets','calendarEditGoogle',saved);await b.store.put('secrets','calendarEditGoogle',saved);
    const stateA=await(await get(a,'/api/state')).json(),stateB=await(await get(b,'/api/state')).json();
    assert.deepEqual(stateA.connections.calendarEdit,{configured:true,connected:true,accountEmail:a.email,connectedAt:saved.connectedAt});
    assert.deepEqual(stateB.connections.calendarEdit,{configured:true,connected:false,accountEmail:null,connectedAt:null});
    assert.doesNotMatch(JSON.stringify(stateA),/EDIT_REFRESH_SECRET|EDIT_ACCESS_SECRET|synthetic-calendar-a|refresh_token|access_token/);
    assert.equal(JSON.stringify(stateA).includes(saved.connectionRevision),false);
  });
  await t.test('disconnect cancels only owned pending work and preserves a revision tombstone plus reading grants',async()=>{
    const app={refresh_token:'APP_ONLY',scope:CALENDAR_SCOPE},read={refresh_token:'READ_ONLY',scope:CAMPUS_CALENDAR_SCOPES.join(' ')};
    await a.store.put('secrets','google',app);await a.store.put('secrets','campusGoogle',read);
    await a.store.put('settings','personalCalendar',{enabled:true,calendars:[{id:'primary',name:'My calendar'}],events:[],revision:1});
    const before=await a.store.get('secrets','calendarEditGoogle'),other=await b.store.get('secrets','calendarEditGoogle');
    await queue.enqueue(a.id,'google-sync',{});await queue.enqueue(b.id,'google-sync',{});
    for(const headers of [{'X-CSRF-Token':''},{'X-CSRF-Token':b.csrfToken}])assert.equal((await post(a,'/api/disconnect',{service:'calendarEditGoogle'},headers)).status,403);
    assert.equal((await post(a,'/api/disconnect',{service:'calendarEditGoogle',userId:b.id})).status,200);
    const tombstone=await a.store.get('secrets','calendarEditGoogle');assert.match(tombstone.connectionRevision,/^[\w-]{43}$/);assert.notEqual(tombstone.connectionRevision,before.connectionRevision);assert.ok(tombstone.disconnectedAt);assert.equal(tombstone.refresh_token,undefined);
    assert.deepEqual(await a.store.get('secrets','google'),app);assert.deepEqual(await a.store.get('secrets','campusGoogle'),read);assert.equal((await a.store.get('settings','personalCalendar')).enabled,true);
    assert.deepEqual(await b.store.get('secrets','calendarEditGoogle'),other);assert.deepEqual(await queue.list(a.id),[]);assert.equal((await queue.list(b.id)).length,1);
    const next=(await(await get(a,'/api/state')).json()).connections.calendarEdit;assert.equal(next.connected,false);assert.equal(next.accountEmail,null);
    await queue.cancelPending(b.id);
  });
  await t.test('removed events cannot be reapproved, retimed or recreated by stale web forms',async()=>{
    const date='2027-01-15',title='Removed study session',sourceId=idFor('manual',title,date),id=idFor(sourceId,'event',title,date);
    const event={id,title,kind:'event',date,start:localISO(date,'12:00'),end:localISO(date,'13:00'),status:'approved',location:'Study room',sourceId};
    await a.store.put('events',id,event);await b.store.put('events',id,event);await writeCalendarTombstones(a.store,{localId:id},{proposalId:'synthetic-removal'});
    for(const action of ['approve','dismiss','cancel']){const result=await post(a,'/api/events/review',{ids:[id],action});assert.equal(result.status,409);assert.equal(result.body.code,'calendar_event_removed');}
    assert.equal((await post(a,'/api/events/time',{id,time:'14:00'})).status,409);
    assert.equal((await post(a,'/api/events/manual',{title,date,time:'12:00',endTime:'13:00'})).status,409);
    assert.deepEqual(await a.store.get('events',id),event);
    assert.equal((await post(b,'/api/events/review',{ids:[id],action:'approve'})).status,200);
    const name='schedule.ics',icsId=idFor(idFor('campus-export',name),'event',title,date);
    await writeCalendarTombstones(a.store,{localId:icsId},{proposalId:'synthetic-import-removal',status:'deleted'});
    const text=`BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:${title}\nDTSTART:20270115T120000\nDTEND:20270115T130000\nEND:VEVENT\nEND:VCALENDAR`;
    assert.equal((await post(a,'/api/events/import-ics',{name,text})).status,409);assert.equal(await a.store.get('events',icsId),null);
  });
});
