import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const script=await readFile(new URL('../browser-extension/brb-content.js',import.meta.url),'utf8');
function fixture({url='https://app.bigredbuddy.com/#careers',frame=false,response={ok:true,filled:3,remaining:1},send}={}){
 const calls=[],listeners=[],panels=[];const window={};window.top=frame?{}:window;
 const element=tag=>({tag,style:{},attrs:{},children:[],textContent:'',setAttribute(name,value){this.attrs[name]=value;},addEventListener(){},replaceChildren(...children){this.children=children;},remove(){const i=panels.indexOf(this);if(i>=0)panels.splice(i,1);}});
 const document={addEventListener:(type,fn,capture)=>listeners.push({type,fn,capture}),createElement:element,getElementById:id=>panels.find(p=>p.id===id),body:{append:p=>panels.push(p)}};
 runInNewContext(script,{location:new URL(url),window,document,URL,chrome:{runtime:{sendMessage:async message=>{calls.push(JSON.parse(JSON.stringify(message)));return send?send():response;}}}});
 const text=()=>panels.flatMap(p=>p.children).map(e=>e.textContent).join(' ');
 async function click({href='/#application-handoff/app-1',target='',download=false,marked=true,...changes}={}){
  const link={getAttribute:name=>name==='href'?href:name==='target'?target:null,hasAttribute:name=>name==='download'&&download};
  const event={isTrusted:true,defaultPrevented:false,button:0,ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,target:{closest:()=>marked?link:null},preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;},...changes};
  await listeners[0]?.fn(event);return event;
 }
 return {calls,listeners,panels,click,text};
}
test('one-click helper does nothing on load and only handles a trusted marked handoff click',async()=>{
 const f=fixture();assert.equal(f.calls.length,0);assert.equal(f.panels.length,0);assert.deepEqual(f.listeners.map(({type,capture})=>({type,capture})),[{type:'click',capture:true}]);
 const event=await f.click();assert.equal(event.defaultPrevented,true);assert.equal(event.stopped,true);assert.deepEqual(f.calls,[{action:'beginHandoff',applicationId:'app-1'}]);
 assert.match(f.text(),/Filled 3 fields/);assert.match(f.text(),/1 items still need attention/);assert.match(f.text(),/did not submit/);
 assert.equal(f.panels[0].attrs.role,'status');assert.equal(f.panels[0].attrs['aria-live'],'polite');assert.equal(f.panels[0].children.find(e=>e.tag==='a').href,'https://app.bigredbuddy.com/#application-handoff/app-1');
});
test('synthetic clicks, modified clicks, other links and malformed destinations retain normal browser behavior',async()=>{
 const f=fixture();
 for(const options of [{isTrusted:false},{defaultPrevented:true},{button:1},{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{target:'_blank'},{download:true},{marked:false},{href:'https://evil.test/#application-handoff/app-1'},{href:'https://app.bigredbuddy.com.evil.test/#application-handoff/app-1'},{href:'/?extra=1#application-handoff/app-1'},{href:'/other#application-handoff/app-1'},{href:'/#application-handoff/../app-1'},{href:'/#application-handoff/'},{href:'/#application-handoff/'+ 'a'.repeat(161)}]){
  const event=await f.click(options);assert.equal(event.stopped,undefined,JSON.stringify(options));
 }
 assert.equal(f.calls.length,0);assert.equal(f.panels.length,0);
});
test('content helper is inactive off the exact BRB root or in a child frame',()=>{
 for(const options of [{url:'https://evil.test/'},{url:'https://app.bigredbuddy.com/other'},{url:'https://app.bigredbuddy.com/?extra=1'},{frame:true}]){
  const f=fixture(options);assert.equal(f.listeners.length,0);assert.equal(f.calls.length,0);
 }
});
test('duplicate clicks cannot start a second handoff while the first is opening',async()=>{
 let complete;const f=fixture({send:()=>new Promise(resolve=>{complete=resolve;})}),first=f.click();assert.match(f.text(),/Opening/);
 const second=await f.click();assert.equal(second.defaultPrevented,true);assert.equal(f.calls.length,1);
 complete({ok:true,filled:1,remaining:0});await first;assert.match(f.text(),/Filled 1 field/);
});
test('failures show accessible help and uncertainty is preserved in success messages',async()=>{
 const failed=fixture({response:{ok:false,error:'Sign in to BRB first.'}});await failed.click();assert.match(failed.text(),/Sign in to BRB/);assert.match(failed.text(),/Open handoff help/);
 const uncertain=fixture({response:{ok:true,filled:3,remaining:0,priorSubmissionUnconfirmed:true}});await uncertain.click();assert.match(uncertain.text(),/previous submission may already have succeeded/);assert.match(uncertain.text(),/check for an employer confirmation/);assert.match(uncertain.text(),/did not submit/);
});
