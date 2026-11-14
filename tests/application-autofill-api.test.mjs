import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes} from 'node:crypto';
import {openDatabase} from '../lib/database.mjs';
import {saveCareerProfile} from '../lib/career.mjs';

test('standalone autofill API requires session and CSRF, isolates students and works without Telegram or an application',{timeout:30000},async t=>{
 const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
 const port=reserve.address().port,origin=`http://127.0.0.1:${port}`;await new Promise(resolve=>reserve.close(resolve));
 const dir=await mkdtemp(path.join(tmpdir(),'brb-autofill-api-')),encryptionKey=randomBytes(32).toString('hex');
 const env={PATH:process.env.PATH,NODE_ENV:'test',HOST:'127.0.0.1',PORT:String(port),APP_ORIGIN:origin,ASSISTANT_DATA:dir,DATA_ENCRYPTION_KEY:encryptionKey,SESSION_SECRET:randomBytes(32).toString('base64url'),DEV_AUTH_EMAILS:'fill-a@cornell.edu,fill-b@cornell.edu',OLLAMA_URL:'http://127.0.0.1:1'};
 let output='',database;const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}if(database)await database.close();await rm(dir,{recursive:true,force:true});});
 for(let n=0;n<200&&!output.includes(`Big Red Buddy web ready: ${origin}`);n++){if(child.exitCode!==null)throw new Error(output);await delay(30);}assert.match(output,/web ready/);
 async function login(email){const response=await fetch(origin+'/auth/dev',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email})});assert.equal(response.status,200);const cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');return {cookie,...await(await fetch(origin+'/api/session',{headers:{Cookie:cookie}})).json()};}
 const alice=await login('fill-a@cornell.edu'),bob=await login('fill-b@cornell.edu');
 database=await openDatabase({dataDir:dir,encryptionKey,databaseUrl:null,production:false,allowLocal:true});const a=database.forUser(alice.user.id),b=database.forUser(bob.user.id);
 await saveCareerProfile(a,{fullName:'Synthetic Alice',email:'alice@example.edu',phone:'2125550123'});
 await saveCareerProfile(b,{fullName:'Synthetic Bob',email:'bob@example.edu'});
 await a.put('documents','resume',{name:'Alice resume.pdf',file:Buffer.from('%PDF-1.7\nsynthetic alice resume').toString('base64'),text:'SYNTHETIC_PRIVATE_RESUME_TEXT'});
 await a.put('notes','private',{text:'PRIVATE_WORKSPACE_NOTE'});
 const scan={url:'https://careers.example.com/application/analyst',title:'Analyst',fields:[{key:'name',label:'Full name',type:'text',required:true},{key:'email',label:'Email',type:'email',required:true},{key:'resume',label:'Resume/CV',type:'file',required:true},{key:'why',label:'Why this company?',type:'textarea'}]};
 const endpoint=origin+'/api/career/application-autofill';
 const request=({student=alice,method='POST',value=scan,csrf=student?.csrfToken,source=origin}={})=>fetch(endpoint,{method,headers:{Origin:source,...(student?{Cookie:student.cookie}:{}),...(method==='POST'?{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})}:{})},...(method==='POST'?{body:JSON.stringify(value)}:{})});
 assert.equal((await request({student:null})).status,401);
 assert.equal((await request({csrf:null})).status,403);
 assert.equal((await request({csrf:bob.csrfToken})).status,403);
 assert.equal((await request({source:'https://untrusted.example.com'})).status,403);
 assert.equal((await request({method:'GET'})).status,404);
 for(const value of [null,[],{}, {...scan,userId:bob.user.id},{...scan,url:'http://127.0.0.1/apply'},{...scan,fields:[{...scan.fields[0],value:'PAGE_VALUE_MUST_NOT_BE_SENT'}]}])assert.equal((await request({value})).status,400);
 const response=await request();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const data=await response.json(),payload=data.autofill;
 assert.equal(payload.mode,'standalone');assert.equal(payload.url,scan.url);assert.equal(payload.answers.name.value,'Synthetic Alice');assert.equal(payload.answers.email.value,'alice@example.edu');assert.equal(payload.documents.resume.name,'Alice resume.pdf');assert.equal(payload.answers.why,undefined);
 assert.doesNotMatch(JSON.stringify(data),/PRIVATE_WORKSPACE_NOTE|SYNTHETIC_PRIVATE_RESUME_TEXT|2125550123/);
 const other=await(await request({student:bob})).json();assert.equal(other.autofill.answers.name.value,'Synthetic Bob');assert.equal(other.autofill.answers.email.value,'bob@example.edu');assert.deepEqual(other.autofill.documents,{});assert.doesNotMatch(JSON.stringify(other),/Synthetic Alice|Alice resume/);
 for(const store of [a,b]){assert.equal(await store.get('secrets','telegram'),null);assert.deepEqual(await store.all('liveApplications'),[]);assert.deepEqual(await store.all('jobs'),[]);assert.deepEqual(await store.all('applicationHandoffs'),[]);}
});
