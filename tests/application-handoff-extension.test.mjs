import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {readFile} from 'node:fs/promises';

const employer='https://jobs.lever.co/example/12345678-1234-1234-1234-123456789abc/apply';
let sequence=0;
async function fixture({signedIn=true,redirect='',url=employer,expiresAt=Date.now()+300000,priorSubmissionUnconfirmed=false,tabURL='https://app.bigredbuddy.com/#application-handoff/app-1'}={}){
 const calls=[],exports=[],tab={id:10,status:'complete',url:tabURL};let listener,target;
 const token='a'.repeat(64),csrf='synthetic-csrf',payload={version:1,url,expiresAt,fields:[],answers:{name:{value:'Synthetic Example'}},documents:{},priorSubmissionUnconfirmed};
 const chrome={runtime:{id:'brb',getURL:path=>'chrome-extension://brb/'+path,onMessage:{addListener:fn=>{listener=fn;}}},tabs:{query:async()=>[tab],create:async options=>{calls.push({kind:'open',...options});target={id:20,status:'complete',url:redirect||options.url};return target;},get:async id=>id===10?tab:target,onUpdated:{addListener(){},removeListener(){}}},scripting:{executeScript:async options=>{
  if(options.target.tabId===20){exports.push(options);return [{result:{ok:true,filled:1,remaining:0,priorSubmissionUnconfirmed:options.args[0].priorSubmissionUnconfirmed}}];}
  assert.equal(options.world,'MAIN');
  const output=await runInNewContext(`(${options.func.toString()})(...args)`,{args:options.args||[],location:new URL(tab.url),fetch:async(path,options={})=>{
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
 const contentSender={id:'brb',url:tabURL,tab,frameId:0};
 return {calls,exports,token,async run(message={action:'beginHandoff'},from=sender){return new Promise(resolve=>listener(message,from,resolve));},listener,sender,contentSender};
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
  let click;const button={addEventListener:(_,fn)=>{click=fn;}},status={textContent:''},other={textContent:'',addEventListener(){}};
  runInNewContext(script,{document:{getElementById:id=>id==='fill'?button:id==='status'?status:other},chrome:{runtime:{sendMessage:async message=>message.action==='getContext'?{ok:true,context:'handoff'}:{ok:true,filled:3,remaining:1,priorSubmissionUnconfirmed:uncertain}}}});
  await new Promise(resolve=>setImmediate(resolve));await click();assert.match(status.textContent,/Filled 3 fields/);assert.match(status.textContent,/This helper did not submit/);assert.equal(button.disabled,false);
  if(uncertain){assert.match(status.textContent,/previous submission attempt may already have succeeded/);assert.match(status.textContent,/Check employer confirmation before submitting again/);assert.doesNotMatch(status.textContent,/Nothing was submitted/);}
 }
});
test('extension refuses disallowed destinations, expiration, and redirects before exporting answers',async()=>{
 for(const options of [{url:'https://example.invalid/apply'},{expiresAt:0},{redirect:'https://jobs.lever.co/other/12345678-1234-1234-1234-123456789abc/apply'}]){
  const f=await fixture(options),result=await f.run();assert.equal(result.ok,false);assert.equal(f.exports.length,0);
 }
});
test('only the installed popup or root BRB content script with a valid application id can trigger a handoff',async()=>{
 const f=await fixture();
 for(const sender of [{id:'other',url:f.sender.url},{id:'brb',url:'https://app.bigredbuddy.com/'},{id:'brb',url:'https://jobs.lever.co/'}])assert.equal(f.listener({action:'beginHandoff'},sender,()=>assert.fail('Unexpected response')),false);
 for(const sender of [
  {...f.contentSender,id:'other'},
  {...f.contentSender,frameId:1},
  {...f.contentSender,tab:undefined},
  {...f.contentSender,url:'https://evil.test/'},
  {...f.contentSender,url:'https://app.bigredbuddy.com/other'},
  {...f.contentSender,url:'https://app.bigredbuddy.com/?next=employer'},
  {...f.contentSender,tab:{id:10,url:'https://jobs.lever.co/'}}
 ])assert.equal(f.listener({action:'beginHandoff',applicationId:'app-1'},sender,()=>assert.fail('Unexpected response')),false);
 for(const applicationId of ['',null,42,'../app','app?extra=1','x'.repeat(161)])assert.equal(f.listener({action:'beginHandoff',applicationId},f.contentSender,()=>assert.fail('Unexpected response')),false);
 for(const message of [{action:'beginHandoff',applicationId:'app-1',url:employer},{action:'beginHandoff',applicationId:'app-1',token:'a'.repeat(64)},{action:'beginHandoff',applicationId:'app-1',answers:{name:'Injected'}}])assert.equal(f.listener(message,f.contentSender,()=>assert.fail('Unexpected response')),false);
 assert.equal(f.listener({action:'other'},f.sender,()=>assert.fail('Unexpected response')),false);assert.equal(f.calls.length,0);
 const manifest=JSON.parse(await readFile(new URL('../browser-extension/manifest.json',import.meta.url),'utf8'));
 assert.deepEqual(manifest.permissions,['activeTab','scripting']);assert.equal(manifest.host_permissions.length,5);assert.deepEqual(manifest.content_scripts,[{matches:['https://app.bigredbuddy.com/*'],js:['brb-content.js'],run_at:'document_idle',all_frames:false}]);assert.equal(manifest.externally_connectable,undefined);
});
test('a BRB tracker click opens and fills the exact application once without the extension popup',async()=>{
 const f=await fixture({tabURL:'https://app.bigredbuddy.com/#careers'});
 const first=f.run({action:'beginHandoff',applicationId:'app-1'},f.contentSender),duplicate=await f.run({action:'beginHandoff',applicationId:'app-1'},f.contentSender);
 assert.equal(duplicate.ok,false);assert.match(duplicate.error,/already opening/);
 const result=await first;assert.equal(result.ok,true);assert.equal(f.exports.length,1);
 assert.equal(f.calls.filter(c=>c.path==='/api/career/application-handoff').length,1);assert.equal(f.calls.filter(c=>c.path==='/api/career/application-handoff/redeem').length,1);
 assert.deepEqual(f.calls.filter(c=>c.kind==='open'),[{kind:'open',url:employer,active:true}]);assert.equal(f.calls.filter(c=>c.kind==='request').length,3);
 assert.deepEqual(Object.keys(result).sort(),['filled','ok','priorSubmissionUnconfirmed','remaining']);assert.doesNotMatch(JSON.stringify(result),/Synthetic Example|token/);
});
test('popup still requires a handoff page while content-script requests recheck the actual source tab',async()=>{
 const popup=await fixture({tabURL:'https://app.bigredbuddy.com/#careers'});assert.equal((await popup.run()).ok,false);assert.equal(popup.calls.length,0);
 const f=await fixture({tabURL:'https://evil.test/'}),sender={...f.contentSender,url:'https://app.bigredbuddy.com/#careers',tab:{id:10,url:'https://app.bigredbuddy.com/#careers'}};
 assert.equal((await f.run({action:'beginHandoff',applicationId:'app-1'},sender)).ok,false);assert.equal(f.calls.length,0);
});
test('extension accepts the exact application URLs the server builds, including Greenhouse embeds and any Ashby employer',async()=>{
 for(const url of ['https://job-boards.greenhouse.io/embed/job_app?for=figma&token=5426468004','https://job-boards.greenhouse.io/figma/jobs/5426468004','https://jobs.ashbyhq.com/notion/1fc309c8-da20-4ff2-84c7-8b863ece2b0a/application']){
  const f=await fixture({url}),result=await f.run();assert.equal(result.ok,true,url);assert.equal(f.calls.find(c=>c.kind==='open').url,url);assert.equal(f.exports.length,1);
 }
 for(const url of ['https://job-boards.greenhouse.io/embed/job_app?for=figma&token=5426468004&next=https://evil.test','https://job-boards.greenhouse.io/embed/job_app?token=5426468004&for=figma','https://job-boards.greenhouse.io/embed/job_app?for=../x&token=1','https://job-boards.greenhouse.io.evil.test/embed/job_app?for=figma&token=1','https://jobs.ashbyhq.com/notion/1fc309c8-da20-4ff2-84c7-8b863ece2b0a/application?x=1','https://stripe.com/jobs/search?gh_jid=8172487']){
  const f=await fixture({url}),result=await f.run();assert.equal(result.ok,false,url);assert.equal(f.calls.some(c=>c.kind==='open'),false,url);assert.equal(f.exports.length,0);
 }
});
test('the downloadable helper zip matches the helper source, so a fix always ships to students',async()=>{
 const {execFileSync}=await import('node:child_process');
 for(const name of ['manifest.json','background.mjs','brb-content.js','fill.mjs','scan.mjs','popup.html','popup.css','popup.js','README.md']){
  const zipped=execFileSync('unzip',['-p','public/browser-helper.zip',`BRB-browser-helper/${name}`]);
  assert.ok(zipped.equals(await readFile(`browser-extension/${name}`)),`public/browser-helper.zip is stale for ${name}; rebuild it from browser-extension/`);
 }
 const version=JSON.parse(await readFile('browser-extension/manifest.json','utf8')).version;
 assert.match(await readFile('public/app.js','utf8'),new RegExp(`version ${version.replaceAll('.','\\.')}</strong>`),'the install instructions show the current helper version');
});
