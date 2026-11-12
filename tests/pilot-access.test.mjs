import test from 'node:test';
import assert from 'node:assert/strict';
import {createPilotSheetSync, parsePilotRows, pilotEmailAllowed, pilotSheetConfig, pilotWorkAllowed, PILOT_MAX_STALE_MS} from '../lib/pilot-access.mjs';

const env = {PILOT_SHEET_ID: 'private-sheet-id-for-testing', PILOT_SHEET_OWNER: 'owner@cornell.edu', PILOT_EMAILS: 'owner@cornell.edu,old@cornell.edu'};
const sheet = pilotSheetConfig(env), rows = [['Email','Access'],['owner@cornell.edu','Approved'],['new@cornell.edu','Approved'],['old@cornell.edu','Revoked']];
function fixture() {
  const map = new Map(); let time = 1000000, values = rows, fail = false, calls = [];
  const auth = {
    async get(b,k) {return structuredClone(map.get(`${b}:${k}`) ?? null);},
    async put(b,k,v) {map.set(`${b}:${k}`,structuredClone(v));return v;},
    async compareAndSet(b,k,before,after) {if(JSON.stringify(await this.get(b,k))!==JSON.stringify(before))return false;await this.put(b,k,after);return true;},
  };
  const database = {auth}, config = {pilotSheet:sheet,pilotEmails:env.PILOT_EMAILS.split(','),allowAllCornell:false,googleClientId:'test',googleClientSecret:'secret'};
  const fetchImpl = async (url, options) => {
    calls.push({url,options});
    if(fail)return new Response('Do not expose provider secrets', {status:403});
    if(url.includes('oauth2'))return Response.json({access_token:'renewed-secret',expires_in:3600});
    if(url.includes('/values/'))return Response.json({values});
    return Response.json({sheets:[{properties:{sheetId:0,title:"Invites' list",gridProperties:{rowCount:1000}}}]});
  };
  const sync = createPilotSheetSync({database,config,fetchImpl,now:()=>time});
  return {database,config,sync,map,calls,fetchImpl,now:()=>time,advance:n=>time+=n,setRows:r=>values=r,fail:()=>fail=true,
    connect:()=>auth.put('pilot_access',`credentials:${sheet.key}`,{access_token:'secret-token',refresh_token:'refresh-secret',expiresAt:0})};
}
test('sheet parser accepts only explicit Cornell approvals and rejects ambiguous or malformed lists',()=>{
  assert.deepEqual(parsePilotRows(rows,sheet.owner),{approved:['new@cornell.edu','owner@cornell.edu'],revokedCount:1});
  for(const invalid of [[],[['Email','Access']], [['Access','Email'],...rows.slice(1)], [...rows,['new@cornell.edu','Revoked']], [...rows,['stranger@gmail.com','Approved']], [...rows,['evil@cornell.edu.evil.com','Approved']], [...rows,['a@cornell.edu','Yes']], [...rows,['=CONCAT("a","@cornell.edu")','Approved']], rows.slice(0,1).concat(rows.slice(2))]) assert.throws(()=>parsePilotRows(invalid,sheet.owner),e=>e.code==='invalid_pilot_sheet');
});
test('first sync atomically replaces bootstrap list; errors never restore old approvals',async()=>{
  const f=fixture();
  assert.equal(await pilotEmailAllowed(f.database,f.config,'old@cornell.edu',f.now()),true);
  assert.equal(await pilotEmailAllowed(f.database,f.config,'new@cornell.edu',f.now()),false);
  await f.connect();let status=await f.sync.sync();assert.equal(status.active,true);assert.equal(status.approvedCount,2);
  assert.equal(await pilotEmailAllowed(f.database,f.config,'old@cornell.edu',f.now()),false);
  assert.equal(await pilotEmailAllowed(f.database,f.config,'new@cornell.edu',f.now()),true);
  f.setRows([]);status=await f.sync.sync();assert.match(status.error,/header/);
  assert.equal(await pilotEmailAllowed(f.database,f.config,'old@cornell.edu',f.now()),false);
  assert.equal(await pilotEmailAllowed(f.database,f.config,'new@cornell.edu',f.now()),true);
  f.fail();await f.sync.sync();
  assert.equal(await pilotEmailAllowed(f.database,f.config,'old@cornell.edu',f.now()),false);
  f.advance(PILOT_MAX_STALE_MS+1);
  assert.equal(await pilotEmailAllowed(f.database,f.config,'new@cornell.edu',f.now()),false);
  assert.equal(await pilotEmailAllowed(f.database,f.config,'owner@cornell.edu',f.now()),true);
  assert.equal((await f.sync.status()).stale,true);
  const restarted=createPilotSheetSync({database:f.database,config:f.config,fetchImpl:f.fetchImpl,now:f.now});
  assert.equal((await restarted.status()).active,true);
  assert.equal(await pilotEmailAllowed(f.database,f.config,'old@cornell.edu',f.now()),false);
});
test('private reader resolves configured gid, uses bounded formula-aware ranges, refreshes token and never exposes secrets',async()=>{
  const f=fixture();await f.connect();const [a,b]=await Promise.all([f.sync.sync(),f.sync.sync()]);assert.equal(a.active,true);assert.deepEqual(a,b);
  assert.equal(f.calls.length,3);
  const read=f.calls.find(c=>c.url.includes('/values/'));
  assert.ok(decodeURIComponent(read.url).includes("'Invites'' list'!A1:B1000"));assert.ok(read.url.includes('valueRenderOption=FORMULA'));
  assert.equal(read.options.headers.Authorization,'Bearer renewed-secret');
  assert.equal(JSON.stringify(a).includes('secret'),false);assert.equal(JSON.stringify(a).includes('new@cornell.edu'),false);
  f.fail();const result=await f.sync.sync();assert.equal(result.error.includes('Do not expose'),false);
});
test('removing an approved row revokes it, including existing Telegram and worker identities',async()=>{
  const f=fixture();await f.connect();await f.sync.sync();
  // Work checks use wall time, so store a current snapshot for that boundary.
  await f.database.auth.put('users','student',{provider:'google',email:'new@cornell.edu',hostedDomain:'cornell.edu'});
  await f.database.auth.put('pilot_access',`snapshot:${sheet.key}`,{approved:['new@cornell.edu',sheet.owner],syncedAt:Date.now()});
  assert.equal(await pilotWorkAllowed(f.database,'student',env),true);
  await f.database.auth.put('pilot_access',`snapshot:${sheet.key}`,{approved:[sheet.owner],syncedAt:Date.now()});
  assert.equal(await pilotWorkAllowed(f.database,'student',env),false);
  assert.equal(await pilotWorkAllowed(f.database,'missing',env),false);
  f.setRows([rows[0],rows[1]]);await f.sync.sync();
  assert.equal(await pilotEmailAllowed(f.database,f.config,'new@cornell.edu',f.now()),false);
});
test('no connection keeps bootstrap policy; unrelated configurations cannot reuse a snapshot',async()=>{
  const f=fixture();assert.equal((await f.sync.sync()).active,false);assert.equal(f.calls.length,0);
  await f.connect();await f.sync.sync();
  const other={...f.config,pilotSheet:pilotSheetConfig({...env,PILOT_SHEET_ID:'another-private-sheet-id'})};
  assert.equal(await pilotEmailAllowed(f.database,other,'new@cornell.edu',f.now()),false);
  assert.equal(await pilotEmailAllowed(f.database,f.config,'new@gmail.com',f.now()),false);
  assert.throws(()=>pilotSheetConfig({...env,PILOT_SHEET_OWNER:'x@gmail.com'}));
});
