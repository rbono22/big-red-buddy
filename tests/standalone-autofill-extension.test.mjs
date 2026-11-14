import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {readFile} from 'node:fs/promises';

const employer='https://careers.example.com/apply/product-manager?source=site#application';
let sequence=0;
async function fixture({url=employer,signedIn=true,brbOpen=true,brbRedirect='',scanOverride={},payloadOverride={},navigate='',reload=false,apiFailure=0}={}){
 let listener,currentDocument='employer-document',active={id:10,status:'complete',url},brb=brbOpen?{id:20,status:'complete',url:'https://app.bigredbuddy.com/#careers'}:null;
 const calls=[],exports=[],scanId='a'.repeat(32),field={key:'first',label:'First name',type:'text',required:true,controlId:'first'};
 const chrome={runtime:{id:'brb',getURL:path=>'chrome-extension://brb/'+path,onMessage:{addListener:fn=>{listener=fn;}}},tabs:{
  query:async query=>query.active?[active]:brb?[brb]:[],
  create:async options=>{calls.push({kind:'open',...options});brb={id:20,status:'complete',url:brbRedirect||options.url};return brb;},
  update:async(id,options)=>{calls.push({kind:'activate',id,...options});return brb;},
  get:async id=>id===10?active:brb,
  onUpdated:{addListener(){},removeListener(){}}
 },scripting:{executeScript:async options=>{
  calls.push({kind:'script',name:options.func.name,world:options.world,target:options.target});
  if(options.func.name==='scanApplication')return [{frameId:0,documentId:currentDocument,result:{ok:true,url:active.url,title:'Product Manager',company:'Example',fields:[field],scanId,...scanOverride}}];
  if(options.func.name==='fillApplication'){
   assert.equal(options.world,'ISOLATED');assert.deepEqual(options.target,{tabId:10,documentIds:['employer-document']});
   if(currentDocument!=='employer-document')throw Error('Document no longer exists');
   exports.push(options.args[0]);return [{frameId:0,documentId:currentDocument,result:{ok:true,filled:1,remaining:0,preserved:1,priorSubmissionUnconfirmed:!!options.args[0].priorSubmissionUnconfirmed}}];
  }
  assert.equal(options.func.name,'prepareInBRB');assert.equal(options.world,'MAIN');
  const output=await runInNewContext(`(${options.func.toString()})(...args)`,{args:options.args,location:new URL(brb.url),AbortSignal,fetch:async(path,options={})=>{
   calls.push({kind:'request',path,options});
   if(path==='/api/session')return {ok:true,json:async()=>({user:signedIn?{id:'synthetic'}:null,csrfToken:'synthetic-csrf'})};
   assert.equal(path,'/api/career/application-autofill');assert.equal(options.credentials,'same-origin');assert.equal(options.headers['X-CSRF-Token'],'synthetic-csrf');
   assert.deepEqual(JSON.parse(options.body),{url,title:'Product Manager',company:'Example',fields:[field]});
   if(navigate)active={...active,url:navigate};if(reload)currentDocument='new-document';
   return {ok:!apiFailure,status:apiFailure||200,json:async()=>apiFailure?{error:'Upload a readable résumé in BRB first.'}:{autofill:{version:1,mode:'standalone',url,expiresAt:Date.now()+300000,fields:[field],answers:{first:{value:'Alex'}},documents:{},...payloadOverride}}};
  }});return [{frameId:0,documentId:'brb-document',result:output}];
 }}};
 globalThis.chrome=chrome;await import(`../browser-extension/background.mjs?standalone=${sequence++}`);
 const sender={id:'brb',url:'chrome-extension://brb/popup.html'};
 return {calls,exports,sender,listener,async run(message={action:'fillActiveApplication'},from=sender){return new Promise(resolve=>{const accepted=listener(message,from,resolve);if(!accepted)resolve(undefined);});}};
}

test('toolbar fills the current standalone document through same-origin BRB auth without an application handoff',async()=>{
 const f=await fixture(),result=await f.run();assert.equal(result.ok,true);assert.equal(f.exports.length,1);
 assert.deepEqual(f.calls.filter(call=>call.kind==='request').map(call=>call.path),['/api/session','/api/career/application-autofill']);
 assert.equal(f.calls.filter(call=>call.kind==='open').length,0);assert.equal(f.exports[0].scanId,'a'.repeat(32));
 assert.equal(f.exports[0].url,employer);assert.equal(f.exports[0].mode,'standalone');
 assert.doesNotMatch(JSON.stringify(f.calls.filter(call=>call.kind==='request')),/scanId|documents|answers|Alex/);
 assert.doesNotMatch(JSON.stringify(result),/Alex|synthetic-csrf|resume|scanId/);
});

test('when BRB is not open the helper opens only a background BRB tab and still fills the same employer document',async()=>{
 const f=await fixture({brbOpen:false});assert.equal((await f.run()).ok,true);
 assert.deepEqual(f.calls.filter(call=>call.kind==='open'),[{kind:'open',url:'https://app.bigredbuddy.com/#careers',active:false}]);
 assert.equal(f.exports.length,1);
});

test('signed-out sessions expose a sign-in recovery code without exporting saved data',async()=>{
 const f=await fixture({signedIn:false});const result=await f.run();assert.equal(result.ok,false);assert.equal(result.code,'AUTH_REQUIRED');assert.match(result.error,/Sign in to BRB/);
 assert.equal(f.exports.length,0);assert.equal(f.calls.filter(call=>call.kind==='request').length,1);
 assert.equal((await f.run({action:'openBRB'})).ok,true);assert.ok(f.calls.some(call=>call.kind==='activate'&&call.id===20&&call.active));
});

test('standalone autofill refuses foreign senders, page scripts, extra arguments, private targets, and no-form pages',async()=>{
 const f=await fixture();
 for(const sender of [{...f.sender,id:'other'},{id:'brb',url:'https://app.bigredbuddy.com/',tab:{id:20,url:'https://app.bigredbuddy.com/'},frameId:0},{id:'brb',url:employer,tab:{id:10,url:employer},frameId:0}]){
  for(const action of ['getContext','fillActiveApplication','openBRB'])assert.equal(f.listener({action},sender,()=>assert.fail('Unexpected response')),false);
 }
 for(const message of [{action:'fillActiveApplication',url:employer},{action:'fillActiveApplication',answers:{}},{action:'openBRB',tabId:10},{action:'getContext',applicationId:'a'}])assert.equal(f.listener(message,f.sender,()=>assert.fail('Unexpected response')),false);
 assert.equal(f.calls.length,0);
 for(const url of ['http://careers.example.com/apply','https://localhost/apply','https://10.0.0.1/apply','https://server.local/apply','https://user:password@careers.example.com/apply','chrome://extensions/']){
  const invalid=await fixture({url});assert.equal((await invalid.run()).ok,false);assert.equal(invalid.exports.length,0);assert.equal(invalid.calls.some(call=>call.kind==='request'),false);
 }
 const missing=await fixture({scanOverride:{ok:false,error:'Open the application form first.'}});assert.match((await missing.run()).error,/Open the application/);assert.equal(missing.calls.some(call=>call.kind==='request'),false);
});

test('autofill checks exact destination, scan bounds, expiration, and document identity before transferring any answers',async()=>{
 for(const options of [
  {scanOverride:{url:employer+'-changed'}},{scanOverride:{scanId:'invalid'}},{scanOverride:{fields:Array.from({length:71},()=>({key:'x'}))}},
  {payloadOverride:{url:'https://other.example.com/apply'}},{payloadOverride:{mode:'handoff'}},{payloadOverride:{expiresAt:0}},
  {payloadOverride:{expiresAt:Date.now()+3600000}},{navigate:'https://careers.example.com/different-role'},{reload:true},{brbOpen:false,brbRedirect:'https://foreign.example.com/'}
 ]){
  const f=await fixture(options),result=await f.run();assert.equal(result.ok,false,JSON.stringify(options));assert.equal(f.exports.length,0,JSON.stringify(options));
 }
});

test('backend validation failures and unconfirmed application warnings remain actionable and truthful',async()=>{
 const failed=await fixture({apiFailure:400});assert.match((await failed.run()).error,/Upload a readable résumé/);assert.equal(failed.exports.length,0);
 const uncertain=await fixture({payloadOverride:{priorSubmissionUnconfirmed:true}});assert.equal((await uncertain.run()).priorSubmissionUnconfirmed,true);assert.equal(uncertain.exports[0].priorSubmissionUnconfirmed,true);
});

test('popup identifies the current application, keeps existing answers, and offers sign-in without requiring a handoff',async()=>{
 const script=await readFile(new URL('../browser-extension/popup.js',import.meta.url),'utf8');
 for(const signedIn of [true,false]){
  const elements=Object.fromEntries(['fill','status','description','heading','signin'].map(id=>[id,{textContent:'',disabled:id==='fill',hidden:id==='signin',listeners:{},addEventListener(event,fn){this.listeners[event]=fn;}}])),calls=[];
  runInNewContext(script,{document:{getElementById:id=>elements[id]},chrome:{runtime:{sendMessage:async message=>{calls.push(message);return message.action==='getContext'?{ok:true,context:'application',host:'careers.example.com'}:message.action==='openBRB'?{ok:true}:signedIn?{ok:true,filled:3,remaining:1,preserved:2}:{ok:false,code:'AUTH_REQUIRED',error:'Sign in to BRB, then return to this application.'};}}}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(elements.fill.disabled,false);assert.equal(elements.fill.textContent,'Autofill this application');
  await elements.fill.listeners.click();assert.equal(calls[1].action,'fillActiveApplication');
  if(signedIn){assert.match(elements.status.textContent,/Filled 3 fields/);assert.match(elements.status.textContent,/2 existing answers were kept/);assert.match(elements.status.textContent,/did not submit/);}
  else{assert.equal(elements.signin.hidden,false);await elements.signin.listeners.click();assert.equal(calls.at(-1).action,'openBRB');assert.match(elements.status.textContent,/return to your application/);}
 }
});

test('popup preserves submitted and in-progress warnings from standalone fill',async()=>{
 const script=await readFile(new URL('../browser-extension/popup.js',import.meta.url),'utf8');
 for(const [flag,expected] of [['alreadySubmitted',/already records this application as submitted/],['submissionInProgress',/Wait for its result before submitting/]]){
  const elements=Object.fromEntries(['fill','status','description','heading','signin'].map(id=>[id,{textContent:'',disabled:true,hidden:true,listeners:{},addEventListener(event,fn){this.listeners[event]=fn;}}]));
  runInNewContext(script,{document:{getElementById:id=>elements[id]},chrome:{runtime:{sendMessage:async message=>message.action==='getContext'?{ok:true,context:'application'}:{ok:true,filled:2,remaining:1,[flag]:true}}}});
  await new Promise(resolve=>setImmediate(resolve));await elements.fill.listeners.click();assert.match(elements.status.textContent,expected);assert.match(elements.status.textContent,/1 item still needs attention/);assert.match(elements.status.textContent,/This helper did not submit/);
 }
});
