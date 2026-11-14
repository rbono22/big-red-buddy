import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const fixture=()=>({profile:{name:'Test student'},events:[],sources:[],jobs:[{id:'job-a',title:'Product Manager',company:'Example',description:'Customer research and product strategy.',saved:true,publishedAt:'2026-11-13T12:00:00Z',publicationTimeVerified:true},{id:'job-b',title:'Program Manager',company:'Other employer',description:'Program planning.',saved:true}],applications:[],applicationTracker:[],reminders:[],activity:[],metrics:[],resume:{name:'Original resume.pdf',updatedAt:'2026-11-14T10:00:00Z'},now:'2026-11-14T14:00:00Z',connections:{telegram:{},google:{},slack:{},campusgroups:{}}});
const ready=(extra={})=>({jobId:'job-a',id:'enhance-a',status:'ready',selected:false,current:true,stale:false,changes:[{original:'Interviewed customers to improve onboarding.',suggested:'Used customer research to improve onboarding.',keywords:['customer research'],evidence:'Interviewed customers.'}],keywords:['customer research'],gaps:['No evidence of managing a product team.'],downloadable:true,fileName:'Example-tailored.pdf',job:{title:'Product Manager',company:'Example'},...extra});
async function app(routes={},options={}){
 const [html,...scripts]=await Promise.all([readFile(new URL('../public/index.html',import.meta.url),'utf8'),...['schedule-groups.js','career-search.js','app.js'].map(name=>readFile(new URL(`../public/${name}`,import.meta.url),'utf8'))]);
 const {document,window}=parseHTML(html),requests=[],intervals=new Map();let active=document.body,current=options.state||fixture(),serial=0;
 Object.defineProperty(document,'activeElement',{get:()=>active});window.HTMLElement.prototype.focus=function(){active=this;};
 const dialog=document.querySelector('#detail-dialog');dialog.showModal=function(){this.open=true;};dialog.close=function(){this.open=false;this.dispatchEvent(new window.Event('close'));};
 const context={document,URL,Intl,Date,console,Map,Set,FormData:class{constructor(form){this.values=Array.from(form.querySelectorAll('[name]'),el=>[el.name,el.value||'']);}entries(){return this.values[Symbol.iterator]();}[Symbol.iterator](){return this.entries();}},location:{hash:options.hash||'#careers',href:''},window:{addEventListener(){},scrollTo(){}},setTimeout(){return 1;},clearTimeout(){},setInterval(fn){intervals.set(++serial,fn);return serial;},clearInterval(id){intervals.delete(id);},fetch:async(url,requestOptions)=>{
  requests.push({url,options:requestOptions});const result=typeof routes[url]==='function'?await routes[url](requestOptions):routes[url];
  return {ok:!result?.errorStatus,status:result?.errorStatus||200,json:async()=>result??(url==='/api/session'?{user:{id:'student-a',name:'Student'},csrfToken:'synthetic'}:url==='/api/state'?current:url.startsWith('/api/career/resume-enhancement?')?{jobId:new URL(url,'https://example.test').searchParams.get('jobId'),status:'none'}:{model:{connected:false}})};
 }};
 const api=await vm.runInNewContext(`(async()=>{${scripts.join('\n')}\nreturn {openResumeEnhancer,loadResumeEnhancement,generateResumeEnhancement,selectResumeEnhancement,setCareerTab,render,refreshResumeEnhancer,replaceSession(value){session=value;},replaceState(value){state=value;},chooseJob(value){resumeEnhancerUI.jobId=value;},getUI(){return resumeEnhancerUI;}};})()`,context);
 return {...api,document,window,requests,async tick(){for(const fn of [...intervals.values()])await fn();},async settle(){for(let i=0;i<10;i++)await Promise.resolve();}};
}
const calls=(ui,url)=>ui.requests.filter(request=>request.url===url);
const getURL='/api/career/resume-enhancement?jobId=job-a';

test('selected job entry opens a focused enhancer with role picker and original preservation',async()=>{
 const ui=await app({[getURL]:ready()});
 assert.equal(ui.document.querySelector('[data-action="resume-enhancer-open"]').textContent,'Resume AI Enhancer');
 await ui.openResumeEnhancer('job-a');await ui.settle();
 assert.equal(ui.document.querySelector('#career-tab-profile').getAttribute('aria-selected'),'true');
 assert.equal(ui.document.activeElement.id,'resume-enhancer-heading');
 assert.equal(ui.document.querySelector('#resume-enhancer-job option[selected]').value,'job-a');
 assert.match(ui.document.querySelector('#resume-enhancer').textContent,/job titles, employers, dates, and original upload stay unchanged/);
 assert.match(ui.document.querySelector('#resume-enhancer').textContent,/Applications already started keep their current résumé/);
 assert.equal(ui.document.querySelector('.resume-enhancer-actions a').getAttribute('href'),'/api/career/resume-enhancement/download?jobId=job-a&enhancementId=enhance-a');
});

test('resume enhancer deep link from Telegram picks the correct role',async()=>{
 const ui=await app({[getURL]:ready()},{hash:'#resume-enhancer/job-a'});await ui.settle();
 assert.equal(ui.document.querySelector('#career-tab-profile').getAttribute('aria-selected'),'true');
 assert.equal(ui.document.querySelector('#resume-enhancer-job option[selected]').value,'job-a');
 assert.match(ui.document.querySelector('.resume-enhancer-result').textContent,/Product Manager/);
});

test('generation queues only once, waits for completion, then fetches saved result',async()=>{
 let done=false,release;const ui=await app({[getURL]:()=>done?ready():{jobId:'job-a',status:'none'},'/api/career/resume-enhance':()=>new Promise(resolve=>{release=resolve;}),'/api/tasks':()=>[{id:'task-a',status:'done'}]});
 await ui.openResumeEnhancer('job-a');await ui.settle();const pending=ui.generateResumeEnhancement();await ui.generateResumeEnhancement();
 assert.equal(calls(ui,'/api/career/resume-enhance').length,1);assert.equal(ui.document.querySelector('[data-action="resume-enhancer-generate"]').disabled,true);
 assert.deepEqual(JSON.parse(calls(ui,'/api/career/resume-enhance')[0].options.body),{jobId:'job-a'});
 release({taskId:'task-a'});await pending;assert.equal(ui.document.querySelector('.resume-enhancer-result'),null);
 done=true;await ui.tick();assert.match(ui.document.querySelector('.resume-enhancer-result').textContent,/Your tailored résumé/);
 assert.equal(ui.getUI().entries['job-a'].pending,false);
});

test('choosing tailored resume is explicit, per-job, and can switch back to original',async()=>{
 const ui=await app({[getURL]:ready(),'/api/career/resume-enhancement/select':options=>ready({selected:JSON.parse(options.body).enhancementId!==null})});
 await ui.openResumeEnhancer('job-a');await ui.settle();assert.equal(calls(ui,'/api/career/resume-enhancement/select').length,0);
 await ui.selectResumeEnhancement();assert.deepEqual(JSON.parse(calls(ui,'/api/career/resume-enhancement/select')[0].options.body),{jobId:'job-a',enhancementId:'enhance-a'});
 assert.match(ui.document.querySelector('.resume-enhancer-actions').textContent,/Switch to original/);
 await ui.selectResumeEnhancement(true);assert.deepEqual(JSON.parse(calls(ui,'/api/career/resume-enhancement/select')[1].options.body),{jobId:'job-a',enhancementId:null});
 assert.match(ui.document.querySelector('#resume-enhancer-status').textContent,/original résumé will be used/);
});

test('stale and non-downloadable drafts cannot be selected or downloaded',async()=>{
 for(const extra of [{stale:true},{downloadable:false}]){
  const ui=await app({[getURL]:ready(extra)});await ui.openResumeEnhancer('job-a');await ui.settle();
  assert.equal(ui.document.querySelector('.resume-enhancer-actions a'),null);await ui.selectResumeEnhancement();assert.equal(calls(ui,'/api/career/resume-enhancement/select').length,0);
 }
 const ui=await app({[getURL]:ready()});await ui.openResumeEnhancer('job-a');await ui.settle();const changed=fixture();changed.resume.updatedAt='2026-11-14T12:00:00Z';ui.replaceState(changed);ui.refreshResumeEnhancer();
 assert.match(ui.document.querySelector('#resume-enhancer').textContent,/Generate a fresh version/);assert.equal(ui.document.querySelector('.resume-enhancer-actions a'),null);
});

test('a previous selection can be cleared while a new version is queued, failed, or stale',async()=>{
 for(const extra of [{status:'queued',taskId:'task-b'},{status:'failed',error:'Private model is busy.'},{stale:true}]){
  const snapshot=ready({...extra,id:'enhance-b',selected:false,selectedEnhancementId:'enhance-a'}),ui=await app({[getURL]:snapshot,'/api/career/resume-enhancement/select':{...snapshot,selectedEnhancementId:null}});
  await ui.openResumeEnhancer('job-a');await ui.settle();
  assert.match(ui.document.querySelector('.resume-enhancer-previous').textContent,/previous tailored résumé is still selected/);
  assert.equal(ui.document.querySelector('.resume-enhancer-previous button').disabled,false);
  await ui.selectResumeEnhancement(true);assert.deepEqual(JSON.parse(calls(ui,'/api/career/resume-enhancement/select')[0].options.body),{jobId:'job-a',enhancementId:null});
  assert.equal(ui.document.querySelector('.resume-enhancer-previous'),null);
 }
});

test('job switches and old sessions cannot expose late results in another role',async()=>{
 let release;const ui=await app({[getURL]:()=>new Promise(resolve=>{release=resolve;})});
 await ui.openResumeEnhancer('job-a');await ui.openResumeEnhancer('job-b');release(ready());await ui.settle();
 assert.equal(ui.document.querySelector('#resume-enhancer-job option[selected]').value,'job-b');assert.equal(ui.document.querySelector('.resume-enhancer-result'),null);
 let end;const next=await app({[getURL]:()=>new Promise(resolve=>{end=resolve;})});await next.openResumeEnhancer('job-a');next.replaceSession({user:{id:'student-b'},csrfToken:'other'});end(ready());await next.settle();
 assert.equal(next.document.querySelector('.resume-enhancer-result'),null);assert.equal(next.getUI().entries['job-a'].snapshot,null);
});

test('model content is rendered as text and never creates HTML or external download URLs',async()=>{
 const bad='<img src=x onerror=alert(1)>',ui=await app({[getURL]:ready({job:{title:bad,company:bad},changes:[{original:bad,suggested:bad,evidence:bad}],keywords:[bad],gaps:[bad],fileName:'https://bad.test/file'})});
 await ui.openResumeEnhancer('job-a');await ui.settle();assert.equal(ui.document.querySelector('#resume-enhancer img'),null);
 assert.match(ui.document.querySelector('.resume-enhancer-result').textContent,/<img src=x onerror=alert\(1\)>/);
 assert.ok(ui.document.querySelector('.resume-enhancer-actions a').getAttribute('href').startsWith('/api/career/'));
});

test('missing upload, queue errors, and selection conflicts offer recoverable states',async()=>{
 const state=fixture();state.resume=null;const ui=await app({}, {state});ui.setCareerTab('profile');assert.ok(ui.document.querySelector('#resume-enhancer [data-action="upload-resume"]'));assert.equal(ui.document.querySelector('#resume-enhancer-job'),null);
 const failed=await app({'/api/career/resume-enhance':{errorStatus:503,error:'Private model is busy.'}});await failed.openResumeEnhancer('job-a');await failed.settle();await failed.generateResumeEnhancement();assert.match(failed.document.querySelector('#resume-enhancer-status').textContent,/Private model is busy/);assert.equal(failed.document.querySelector('[data-action="resume-enhancer-generate"]').disabled,false);
 const conflict=await app({[getURL]:ready(),'/api/career/resume-enhancement/select':{errorStatus:409,error:'Resume changed.'}});await conflict.openResumeEnhancer('job-a');await conflict.settle();await conflict.selectResumeEnhancement();assert.match(conflict.document.querySelector('#resume-enhancer-status').textContent,/Resume changed/);assert.equal(conflict.document.querySelector('.resume-enhancer-actions a'),null);
});
