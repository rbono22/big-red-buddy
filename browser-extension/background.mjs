import {fillApplication} from './fill.mjs';
import {scanApplication} from './scan.mjs';

const BRB='https://app.bigredbuddy.com';
const applicationId=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,160}$/.test(value);
const brbPage=value=>{try{const u=new URL(value);return u.origin===BRB&&u.pathname==='/'&&!u.search&&!u.username&&!u.password;}catch{return false;}};
// Must accept exactly the application URLs BRB's server builds (lib/application-providers.mjs).
// Greenhouse employers with their own careers sites are filled through Greenhouse's embeddable form.
const greenhouseEmbed=u=>{const keys=[...u.searchParams.keys()];return u.hostname==='job-boards.greenhouse.io'&&u.pathname==='/embed/job_app'&&keys.length===2&&keys[0]==='for'&&keys[1]==='token'&&/^[A-Za-z0-9_-]{1,100}$/.test(u.searchParams.get('for'))&&/^[1-9][0-9]{0,15}$/.test(u.searchParams.get('token'));};
const canonical=value=>{try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)return '';if(greenhouseEmbed(u))return u.href;if(u.search)return '';if(u.hostname==='jobs.lever.co'&&/^\/[A-Za-z0-9_-]+\/[a-f0-9-]{36}\/apply$/.test(u.pathname)||u.hostname==='job-boards.greenhouse.io'&&/^\/[A-Za-z0-9_-]+\/jobs\/\d+$/.test(u.pathname)||u.hostname==='jobs.ashbyhq.com'&&/^\/[A-Za-z0-9._-]{1,100}\/[a-f0-9-]{36}\/application$/.test(u.pathname)||u.hostname==='apply.workable.com'&&/^\/valsoft-corp\/j\/[A-F0-9]{10}\/apply\/$/.test(u.pathname))return u.href;return '';}catch{return '';}};

// This function executes only inside the student's authenticated BRB tab.
async function redeemInBRB(requestedId){
 if(location.origin!=='https://app.bigredbuddy.com'||location.pathname!=='/'||location.search)throw Error('Open the BRB browser handoff page first.');
 const match=/^#application-handoff\/([A-Za-z0-9:_-]{1,160})$/.exec(location.hash),id=requestedId===undefined?match?.[1]:requestedId;
 if(typeof id!=='string'||!/^[A-Za-z0-9:_-]{1,160}$/.test(id))throw Error('Open the BRB browser handoff page first.');
 const session=await fetch('/api/session',{credentials:'same-origin',cache:'no-store'}).then(r=>r.json());
 if(!session?.user||typeof session.csrfToken!=='string')throw Error('Sign in to BRB first, then reopen the handoff.');
 async function post(path,body){const r=await fetch(path,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Error('BRB could not prepare this handoff. Reopen it from the current application.');return value;}
 const created=await post('/api/career/application-handoff',{applicationId:id});
 const token=created.token||created.handoff?.token;if(typeof token!=='string'||!/^([a-f0-9]{64})$/.test(token))throw Error('BRB returned an invalid handoff.');
 const result=await post('/api/career/application-handoff/redeem',{token});return result.handoff||result;
}
function loaded(tabId){return new Promise((resolve,reject)=>{
 let done=false;const finish=error=>{if(done)return;done=true;clearTimeout(timer);chrome.tabs.onUpdated.removeListener(listener);error?reject(error):resolve();};
 const listener=(id,info)=>{if(id===tabId&&info.status==='complete')finish();};
 const timer=setTimeout(()=>finish(Error('The employer page took too long to open. Return to BRB and try again.')),45000);
 chrome.tabs.onUpdated.addListener(listener);chrome.tabs.get(tabId).then(tab=>{if(tab.status==='complete')finish();},()=>finish(Error('The employer tab was closed.')));
});}
async function begin(sourceTabId,requestedId){
 const tab=sourceTabId===undefined?(await chrome.tabs.query({active:true,currentWindow:true}))[0]:await chrome.tabs.get(sourceTabId);
 if(!Number.isSafeInteger(tab?.id)||!brbPage(tab.url)||(requestedId===undefined&&!/^#application-handoff\/[A-Za-z0-9:_-]{1,160}$/.test(new URL(tab.url).hash)))throw Error('Open the browser handoff link from BRB first.');
 const result=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',func:redeemInBRB,args:requestedId===undefined?[]:[requestedId]});
 const payload=result[0]?.result;if(payload?.version!==1||!canonical(payload.url)||payload.expiresAt<=Date.now())throw Error('This handoff expired. Open a fresh one in BRB.');
 const target=await chrome.tabs.create({url:payload.url,active:true});await loaded(target.id);
 const destination=await chrome.tabs.get(target.id);if(destination.url!==payload.url)throw Error('The employer redirected this application. Complete it on the website.');
 // No stored payload, broad browsing access, or submission code. Data is scoped to this tab invocation.
 const filled=await chrome.scripting.executeScript({target:{tabId:target.id},world:'ISOLATED',func:fillApplication,args:[payload]});
 if(!filled[0]?.result?.ok)throw Error(filled[0]?.result?.error||'The employer form changed. Complete it on the website.');return filled[0].result;
}
const standaloneURL=value=>{
 try{const u=new URL(value),host=u.hostname.toLowerCase();if(u.protocol!=='https:'||u.username||u.password||u.port||!host.includes('.')||host.startsWith('[')||/^[\d.]+$/.test(host)||/(?:^|\.)(?:localhost|local|internal|lan|home|onion)$/.test(host)||u.origin===BRB||value.length>3000)return '';return u.href;}catch{return '';}
};
const failure=(message,code)=>Object.assign(Error(message),code?{code}:{});

// Called in BRB's root document so session cookies and CSRF remain same-origin.
// Page metadata is the only request body; private answers never enter a URL.
async function prepareInBRB(input){
 if(location.origin!=='https://app.bigredbuddy.com'||location.pathname!=='/'||location.search)return {ok:false,code:'BRB_PAGE_CHANGED',error:'BRB changed pages. Return to the application and try again.'};
 try{
  const response=await fetch('/api/session',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)}),session=await response.json();
  if(!response.ok||!session?.user||typeof session.csrfToken!=='string')return {ok:false,code:'AUTH_REQUIRED',error:'Sign in to BRB, then return to this application and click Autofill again.'};
  const result=await fetch('/api/career/application-autofill',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify(input),signal:AbortSignal.timeout(30000)}),value=await result.json();
  if(result.status===401)return {ok:false,code:'AUTH_REQUIRED',error:'Sign in to BRB, then return to this application and click Autofill again.'};
  if(!result.ok)return {ok:false,code:'AUTOFILL_UNAVAILABLE',error:typeof value?.error==='string'?value.error.slice(0,240):'BRB could not prepare these fields. Check your saved profile and résumé, then try again.'};
  return {ok:true,payload:value.autofill};
 }catch{return {ok:false,code:'BRB_UNAVAILABLE',error:'BRB could not be reached. Check that app.bigredbuddy.com opens, then try again.'};}
}
async function bridgeTab({active=false}={}){
 const tabs=await chrome.tabs.query({url:BRB+'/*'}),existing=tabs.find(tab=>Number.isSafeInteger(tab.id)&&brbPage(tab.url));
 if(existing){if(active)await chrome.tabs.update(existing.id,{active:true});await loaded(existing.id);return await chrome.tabs.get(existing.id);}
 const tab=await chrome.tabs.create({url:BRB+'/#careers',active});await loaded(tab.id);return await chrome.tabs.get(tab.id);
}
async function context(){
 const tab=(await chrome.tabs.query({active:true,currentWindow:true}))[0];
 if(!Number.isSafeInteger(tab?.id))return {ok:true,context:'unsupported'};
 if(brbPage(tab.url))return {ok:true,context:/^#application-handoff\/[A-Za-z0-9:_-]{1,160}$/.test(new URL(tab.url).hash)?'handoff':'brb'};
 const url=standaloneURL(tab.url);return {ok:true,context:url?'application':'unsupported',...(url?{host:new URL(url).hostname}:{})};
}
async function fillActive(){
 const target=(await chrome.tabs.query({active:true,currentWindow:true}))[0];
 if(brbPage(target?.url)&&/^#application-handoff\/[A-Za-z0-9:_-]{1,160}$/.test(new URL(target.url).hash))return begin(target.id);
 const url=standaloneURL(target?.url);if(!Number.isSafeInteger(target?.id)||!url)throw failure('Open an HTTPS job application, then click the BRB helper.');
 let scanResult;try{scanResult=await chrome.scripting.executeScript({target:{tabId:target.id},world:'ISOLATED',func:scanApplication});}catch{throw failure('Chrome could not read this application. Refresh the page, reopen the helper, and try again.');}
 const inspected=scanResult?.find(result=>result.frameId===0)||scanResult?.[0],scan=inspected?.result,documentId=inspected?.documentId;
 if(!scan?.ok)throw failure(scan?.error||'Open the application form before using Autofill.');
 if(scan.url!==url||typeof scan.scanId!=='string'||!/^[a-f0-9]{32}$/.test(scan.scanId)||typeof documentId!=='string'||!documentId)throw failure('The application page changed. Refresh it and try Autofill again.');
 if(!Array.isArray(scan.fields)||!scan.fields.length||scan.fields.length>70)throw failure('This form has too many fields or no supported fields. Open the next application step and try again.');
 const input={url,title:typeof scan.title==='string'?scan.title.slice(0,300):'',...(typeof scan.company==='string'&&scan.company?{company:scan.company.slice(0,200)}:{}),fields:scan.fields};
 if(JSON.stringify(input).length>150000)throw failure('This application form is too large. Try one application step at a time.');
 const source=await bridgeTab();if(!brbPage(source.url))throw failure('Sign in to BRB, then return to this application and click Autofill again.','AUTH_REQUIRED');
 const response=await chrome.scripting.executeScript({target:{tabId:source.id},world:'MAIN',func:prepareInBRB,args:[input]});
 const prepared=response[0]?.result;if(!prepared?.ok)throw failure(prepared?.error||'BRB could not prepare this application. Try again.',prepared?.code);
 const payload=prepared.payload;
 if(payload?.version!==1||payload.mode!=='standalone'||payload.url!==url||!Number.isFinite(payload.expiresAt)||payload.expiresAt<=Date.now()||payload.expiresAt>Date.now()+10*60*1000)throw failure('This autofill request expired or changed. Click Autofill again.');
 const current=await chrome.tabs.get(target.id);if(current.url!==url)throw failure('The application navigated to another page. Click Autofill on the page you want to complete.');
 // documentIds also fences reloads and same-URL navigations. The scanner's
 // isolated-world scanId binds the exact original controls inside that document.
 let filled;try{filled=await chrome.scripting.executeScript({target:{tabId:target.id,documentIds:[documentId]},world:'ISOLATED',func:fillApplication,args:[{...payload,scanId:scan.scanId}]});}catch{throw failure('The application page changed. Click Autofill again on its current page.');}
 if(!filled[0]?.result?.ok)throw failure(filled[0]?.result?.error||'The form changed. Click Autofill again.');
 return filled[0].result;
}
let running=false;
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
 if(sender.id!==chrome.runtime.id||!message||typeof message!=='object'||Array.isArray(message))return false;
 const keys=Object.keys(message),popup=sender.url===chrome.runtime.getURL('popup.html')&&keys.length===1;
 const page=!popup&&message.action==='beginHandoff'&&keys.length===2&&keys.includes('applicationId')&&applicationId(message.applicationId)&&sender.frameId===0&&Number.isSafeInteger(sender.tab?.id)&&brbPage(sender.url)&&brbPage(sender.tab.url);
 if(!popup&&!page)return false;
 if(popup&&message.action==='getContext'){context().then(sendResponse,()=>sendResponse({ok:true,context:'unsupported'}));return true;}
 if(popup&&message.action==='openBRB'){bridgeTab({active:true}).then(()=>sendResponse({ok:true}),()=>sendResponse({ok:false,error:'Open app.bigredbuddy.com in Chrome to sign in.'}));return true;}
 if(message.action!=='beginHandoff'&&!(popup&&message.action==='fillActiveApplication'))return false;
 if(running){sendResponse({ok:false,error:'An application is already opening or filling. Wait for it to finish.'});return false;}
 running=true;const operation=message.action==='fillActiveApplication'?fillActive():begin(page?sender.tab.id:undefined,page?message.applicationId:undefined);
 operation.then(sendResponse,error=>sendResponse({ok:false,error:String(error.message||'Open a fresh handoff in BRB.').slice(0,240),...(error.code==='AUTH_REQUIRED'?{code:'AUTH_REQUIRED'}:{})})).finally(()=>{running=false;});return true;
});
