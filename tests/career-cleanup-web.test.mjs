import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const fixture=()=>({profile:{name:'Test student'},events:[],sources:[],jobs:[{id:'job-a',title:'Product Manager',company:'Example',saved:true,publishedAt:'2026-11-13T12:00:00Z',publicationTimeVerified:true},{id:'job-b',title:'Saved hidden role',company:'Example',saved:true,foundRemoved:true}],applications:[],applicationTracker:[{id:'track-a',jobId:'job-a',title:'Product Manager',company:'Example',status:'submitted',startedAt:'2026-11-13T12:00:00Z'}],reminders:[],activity:[],metrics:[],resume:null,now:'2026-11-14T14:00:00Z',connections:{telegram:{},google:{},slack:{},campusgroups:{}}});
const preview=()=>({token:'synthetic-snapshot',scope:'applications',counts:{applications:1,saved:0,found:0},blocked:[],canConfirm:true});
async function app(routes={}){
 const [html,...scripts]=await Promise.all([readFile(new URL('../public/index.html',import.meta.url),'utf8'),...['schedule-groups.js','career-search.js','app.js'].map(name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8'))]);
 const {document,window}=parseHTML(html),requests=[],listeners={};let active=document.body,current=fixture();
 Object.defineProperty(document,'activeElement',{get:()=>active});window.HTMLElement.prototype.focus=function(){active=this;};
 const dialog=document.querySelector('#detail-dialog');dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
 const context={document,URL,Intl,Date,console,Map,Set,FormData:class{constructor(form){this.values=Array.from(form.querySelectorAll('[name]'),el=>[el.name,el.value||'']);}entries(){return this.values[Symbol.iterator]();}[Symbol.iterator](){return this.entries();}},location:{hash:'#careers',href:''},window:{addEventListener(name,fn){listeners[name]=fn;},scrollTo(){}},setTimeout(){return 1;},clearTimeout(){},setInterval(){return 1;},clearInterval(){},fetch:async(url,options)=>{
  requests.push({url,options});const result=typeof routes[url]==='function'?await routes[url](options):routes[url];
  return {ok:!result?.errorStatus,status:result?.errorStatus||200,json:async()=>result??(url==='/api/session'?{user:{id:'student-a',name:'Student'},csrfToken:'synthetic'}:url==='/api/state'?current:{model:{connected:false}})};
 }};
 const api=await vm.runInNewContext(`(async()=>{${scripts.join('\n')}\nreturn {openCareerCleanup,confirmCareerCleanup,refreshCareerCleanupPreview,setCareerTab,careerJobRows,render,replaceSession(value){session=value;},getCleanup(){return careerCleanupUI;}};})()`,context);
 return {...api,document,window,dialog,requests,setState(value){current=value;}};
}
const calls=(ui,url)=>ui.requests.filter(request=>request.url===url);

test('career lists expose individual and bulk cleanup while hidden found jobs remain saved',async()=>{
 const ui=await app();
 assert.ok(ui.document.querySelector('[data-action="career-cleanup"][data-scope="all"]'));
 assert.ok(ui.document.querySelector('[data-scope="found"][data-id="job-a"]'));
 assert.deepEqual(Array.from(ui.careerJobRows(),row=>row.id),['job-a']);
 ui.setCareerTab('saved');
 assert.ok(ui.document.querySelector('[data-action="career-cleanup"][data-scope="saved"]'));
 assert.deepEqual(Array.from(ui.careerJobRows(),row=>row.id),['job-a','job-b']);
 ui.setCareerTab('applications');
 assert.ok(ui.document.querySelector('[data-scope="applications"][data-id="job-a"]'));
 assert.ok(ui.document.querySelector('[data-scope="applications"]:not([data-id])'));
});

test('cleanup previews exact scope then confirms only with its snapshot token; fresh lists reload',async()=>{
 const ui=await app({'/api/career/cleanup/preview':preview(),'/api/career/cleanup/confirm':{scope:'applications',counts:{applications:1,saved:0,found:0}}});
 ui.setCareerTab('applications');const trigger=ui.document.querySelector('[data-scope="applications"][data-id="job-a"]');trigger.focus();
 await ui.openCareerCleanup('applications','job-a');
 assert.equal(ui.dialog.open,true);assert.equal(ui.document.activeElement.id,'career-cleanup-cancel');
 assert.deepEqual(JSON.parse(calls(ui,'/api/career/cleanup/preview')[0].options.body),{scope:'applications',id:'job-a'});
 assert.equal(calls(ui,'/api/career/cleanup/confirm').length,0);
 assert.match(ui.document.querySelector('#detail-content').textContent,/1 application record/);
 assert.match(ui.document.querySelector('#detail-content').textContent,/does not withdraw/);
 const after=fixture();after.applicationTracker=[];ui.setState(after);await ui.confirmCareerCleanup();
 assert.deepEqual(JSON.parse(calls(ui,'/api/career/cleanup/confirm')[0].options.body),{token:'synthetic-snapshot'});
 assert.equal(ui.dialog.open,false);assert.equal(ui.document.querySelector('[data-tracker-id="track-a"]'),null);
 assert.match(ui.document.querySelector('#toast-message').textContent,/Removed 1 application record/);
 assert.equal(ui.document.querySelector('#close-dialog').disabled,false);
});

test('cancelled previews ignore late responses and never remove anything',async()=>{
 let resolve;const ui=await app({'/api/career/cleanup/preview':()=>new Promise(done=>{resolve=done;})});
 const pending=ui.openCareerCleanup('all');assert.equal(ui.dialog.open,true);ui.dialog.close();resolve(preview());await pending;
 assert.equal(ui.getCleanup(),null);assert.equal(ui.document.querySelector('[data-action="career-cleanup-confirm"]'),null);
 assert.equal(calls(ui,'/api/career/cleanup/confirm').length,0);assert.equal(ui.dialog.open,false);
});

test('active application blocks confirmation and allows a fresh check without partial cleanup',async()=>{
 const ui=await app({'/api/career/cleanup/preview':{...preview(),canConfirm:false,blocked:[{jobId:'job-a',title:'Product Manager',reason:'Submission is in progress.'}]}});
 await ui.openCareerCleanup('all');assert.equal(ui.document.querySelector('[data-action="career-cleanup-confirm"]'),null);
 assert.match(ui.document.querySelector('#detail-content').textContent,/Nothing will be removed until they finish/);
 assert.ok(ui.document.querySelector('[data-action="career-cleanup-refresh"]'));
 await ui.confirmCareerCleanup();assert.equal(calls(ui,'/api/career/cleanup/confirm').length,0);
});

test('double confirmation sends once and failed confirmation requires a fresh preview',async()=>{
 let resolve;const ui=await app({'/api/career/cleanup/preview':preview(),'/api/career/cleanup/confirm':()=>new Promise(done=>{resolve=done;})});
 await ui.openCareerCleanup('applications','job-a');const first=ui.confirmCareerCleanup();await ui.confirmCareerCleanup();
 assert.equal(calls(ui,'/api/career/cleanup/confirm').length,1);assert.equal(ui.document.querySelector('#close-dialog').disabled,true);
 const cancel=new ui.window.Event('cancel',{cancelable:true});ui.dialog.dispatchEvent(cancel);assert.equal(cancel.defaultPrevented,true);
 resolve({errorStatus:409,error:'Your list changed.'});await first;assert.match(ui.document.querySelector('[role="alert"]').textContent,/Your list changed/);
 assert.equal(ui.document.querySelector('[data-action="career-cleanup-confirm"]'),null);await ui.confirmCareerCleanup();assert.equal(calls(ui,'/api/career/cleanup/confirm').length,1);
 assert.equal(ui.document.querySelector('#close-dialog').disabled,false);
});

test('a response belonging to an old signed-in session cannot publish a cleanup confirmation',async()=>{
 let resolve;const ui=await app({'/api/career/cleanup/preview':()=>new Promise(done=>{resolve=done;})});
 const pending=ui.openCareerCleanup('all');ui.replaceSession({user:{id:'student-b'},csrfToken:'other'});resolve(preview());await pending;
 assert.equal(ui.document.querySelector('[data-action="career-cleanup-confirm"]'),null);await ui.confirmCareerCleanup();assert.equal(calls(ui,'/api/career/cleanup/confirm').length,0);
});
