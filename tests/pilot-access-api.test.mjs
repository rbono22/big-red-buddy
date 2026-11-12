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
import {sha256} from '../lib/security.mjs';
import {identityId} from '../lib/auth.mjs';

test('pilot access endpoints require the operator session and CSRF; ordinary students cannot connect or inspect the sheet', {timeout:20000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'brb-pilot-api-')),origin='http://127.0.0.1:4397';
 const env={...process.env,NODE_ENV:'test',DATABASE_URL:'',DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),ASSISTANT_DATA:dir,APP_ORIGIN:origin,PORT:'4397',HOST:'127.0.0.1',DEV_AUTH_EMAILS:'',PILOT_EMAILS:'owner@cornell.edu,bob@cornell.edu',ALLOWED_GOOGLE_DOMAINS:'cornell.edu',ALLOW_ALL_CORNELL:'false',GOOGLE_CLIENT_ID:'test.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:'synthetic',SESSION_SECRET:randomBytes(32).toString('hex'),PILOT_SHEET_ID:'private-sheet-for-api-testing',PILOT_SHEET_OWNER:'owner@cornell.edu',PILOT_SHEET_GID:'0'};
 const db=await openDatabase({dataDir:dir,databaseUrl:null,encryptionKey:env.DATA_ENCRYPTION_KEY,production:false}),users={};
 for(const name of ['owner','bob']){
  const id=identityId('google',name),token=randomBytes(32).toString('base64url'),csrfToken=randomBytes(32).toString('base64url');
  await db.auth.put('users',id,{id,email:`${name}@cornell.edu`,hostedDomain:'cornell.edu',provider:'google',subject:name});
  await db.auth.put('sessions',sha256(token),{userId:id,expiresAt:Date.now()+60000,epoch:'initial',csrfToken});
  users[name]={cookie:`dabas_session=${token}`,csrfToken};
 }
 await db.close();
 const child=spawn(process.execPath,['server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const end=once(child,'exit');child.kill('SIGTERM');await end;}await rm(dir,{recursive:true,force:true});});
 let ready=false;for(let i=0;i<100;i++){try{ready=(await fetch(`${origin}/healthz`)).ok;}catch{}if(ready)break;if(child.exitCode!==null)throw new Error(output);await delay(50);}assert.ok(ready,output);
 async function api(user,route,post=false,csrf=true){return fetch(origin+route,{method:post?'POST':'GET',headers:{Cookie:user?.cookie||'',Origin:origin,'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':user?.csrfToken||''}:{})},...(post?{body:'{}'}:{})});}
 assert.equal((await api(null,'/api/pilot-access')).status,401);
 for(const route of ['/api/pilot-access','/api/pilot-access/connect','/api/pilot-access/sync'])assert.equal((await api(users.bob,route,route!=='/api/pilot-access')).status,403);
 assert.equal((await api(users.owner,'/api/pilot-access/connect',true,false)).status,403);
 const status=await(await api(users.owner,'/api/pilot-access')).json();assert.equal(status.configured,true);assert.equal(status.active,false);assert.equal(JSON.stringify(status).includes('synthetic'),false);
 const connect=await(await api(users.owner,'/api/pilot-access/connect',true)).json();assert.ok(new URL(connect.url).searchParams.get('scope').includes('spreadsheets.readonly'));
 assert.equal((await(await api(users.owner,'/api/session')).json()).pilotAccessAdmin,true);
 assert.equal((await(await api(users.bob,'/api/session')).json()).pilotAccessAdmin,false);
});
