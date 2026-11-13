import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {readFile} from 'node:fs/promises';

const employer='https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply';
let sequence=0;
async function fixture({signedIn=true,redirect='',url=employer,expiresAt=Date.now()+300000,priorSubmissionUnconfirmed=false}={}){
 const calls=[],exports=[],tab={id:10,status:'complete',url:'https://app.bigredbuddy.com/#application-handoff/app-1'};let listener,target;
 const token='a'.repeat(64),csrf='synthetic-csrf',payload={version:1,url,expiresAt,fields:[],answers:{name:{value:'Synthetic Example'}},documents:{},priorSubmissionUnconfirmed};
 const chrome={runtime:{id:'brb',getURL:path=>'chrome-extension://brb/'+path,onMessage:{addListener:fn=>{listener=fn;}}},tabs:{query:async()=>[tab],create:async options=>{calls.push({kind:'open',...options});target={id:20,status:'complete',url:redirect||options.url};return target;},get:async id=>id===10?tab:target,onUpdated:{addListener(){},removeListener(){}}},scripting:{executeScript:async options=>{
  if(options.target.tabId===20){exports.push(options);return [{result:{ok:true,filled:1,remaining:0,priorSubmissionUnconfirmed:options.args[0].priorSubmissionUnconfirmed}}];}
  assert.equal(options.world,'MAIN');
  const output=await runInNewContext(`(${options.func.toString()})()`,{location:new URL(tab.url),fetch:async(path,options={})=>{
   calls.push({kind:'request',path,options});
   if(path==='/api/session')return {ok:true,json:async()=>({user:signedIn?{id:'student'}:null,csrfToken:csrf})};
   assert.equal(options.credentials,'same-origin');assert.equal(options.headers['X-CSRF-Token'],csrf);
   if(path==='/api/career/application-handoff'){assert.deepEqual(JSON.parse(options.body),{applicationId:'app-1'});return {ok:true,json:async()=>({token})};}
   if(path==='/api/career/application-handoff/redeem'){assert.deepEqual(JSON.parse(options.body),{token});return {ok:true,json:async()=>({handoff:payload})};}
   throw Error('Unexpected request');
  }});return [{result:output}];
 }}};
 globalThis.chrome=chrome;
 await import(`../browser-extension/background.mjs?test=${sequence++}`);
 const sender={id:'brb',url:'chrome-extension://brb/popup.html'};
 return {calls,exports,token,async run(){return new Promise(resolve=>listener({action:'beginHandoff'},sender,resolve));},listener,sender};
}
test('extension redeems only through the authenticated BRB page and transfers no token to the employer',async()=>{
 const f=await fixture(),result=await f.run();assert.equal(result.ok,true);assert.equal(f.exports.length,1);assert.equal(f.exports[0].world,'ISOLATED');
 assert.equal(f.calls.filter(c=>c.kind==='request').length,3);assert.equal(f.calls.find(c=>c.kind==='open').url,employer);
 assert.doesNotMatch(JSON.stringify(f.exports),new RegExp(f.token));assert.doesNotMatch(JSON.stringify(f.calls.filter(c=>c.kind==='open')),new RegExp(f.token));
});
test('extension refuses a signed-out session and never opens or fills the employer',async()=>{
 const f=await fixture({signedIn:false}),result=await f.run();assert.equal(result.ok,false);assert.match(result.error,/Sign in/);assert.equal(f.calls.length,1);assert.equal(f.exports.length,0);
});
test('manual recovery forwards the uncertainty warning through the exact employer tab',async()=>{
 const f=await fixture({priorSubmissionUnconfirmed:true}),result=await f.run();assert.equal(result.ok,true);assert.equal(result.priorSubmissionUnconfirmed,true);assert.equal(f.exports[0].args[0].priorSubmissionUnconfirmed,true);assert.equal(f.calls.find(c=>c.kind==='open').url,employer);
 const redirected=await fixture({priorSubmissionUnconfirmed:true,redirect:employer+'?different=1'});assert.equal((await redirected.run()).ok,false);assert.equal(redirected.exports.length,0);
});
test('popup reports prior uncertainty without claiming the previous application was unsent',async()=>{
 const script=await readFile(new URL('../browser-extension/popup.js',import.meta.url),'utf8');
 for(const uncertain of [false,true]){
  let click;const button={addEventListener:(_,fn)=>{click=fn;}},status={textContent:''};
  runInNewContext(script,{document:{getElementById:id=>id==='fill'?button:status},chrome:{runtime:{sendMessage:async()=>({ok:true,filled:3,remaining:1,priorSubmissionUnconfirmed:uncertain})}}});
  await click();assert.match(status.textContent,/Filled 3 fields/);assert.match(status.textContent,/This helper did not submit/);assert.equal(button.disabled,false);
  if(uncertain){assert.match(status.textContent,/previous submission attempt may already have succeeded/);assert.match(status.textContent,/Check employer confirmation before submitting again/);assert.doesNotMatch(status.textContent,/Nothing was submitted/);}
 }
});
test('extension refuses disallowed destinations, expiration, and redirects before exporting answers',async()=>{
 for(const options of [{url:'https://example.invalid/apply'},{expiresAt:0},{redirect:'https://jobs.lever.co/other/12345678-1234-1234-1234-123456789abc/apply'}]){
  const f=await fixture(options),result=await f.run();assert.equal(result.ok,false);assert.equal(f.exports.length,0);
 }
});
test('only the installed extension popup can trigger a handoff',async()=>{
 const f=await fixture();
 for(const sender of [{id:'other',url:f.sender.url},{id:'brb',url:'https://app.bigredbuddy.com/'},{id:'brb',url:'https://jobs.lever.co/'}])assert.equal(f.listener({action:'beginHandoff'},sender,()=>assert.fail('Unexpected response')),false);
 assert.equal(f.listener({action:'other'},f.sender,()=>assert.fail('Unexpected response')),false);assert.equal(f.calls.length,0);
 const manifest=JSON.parse(await readFile(new URL('../browser-extension/manifest.json',import.meta.url),'utf8'));
 assert.deepEqual(manifest.permissions,['activeTab','scripting']);assert.equal(manifest.host_permissions.length,5);assert.equal(manifest.content_scripts,undefined);assert.equal(manifest.externally_connectable,undefined);
});
