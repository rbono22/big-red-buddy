import {fillApplication} from './fill.mjs';

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
let running=false;
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
 if(sender.id!==chrome.runtime.id||message?.action!=='beginHandoff')return false;
 const keys=Object.keys(message),popup=sender.url===chrome.runtime.getURL('popup.html')&&keys.length===1;
 const page=!popup&&keys.length===2&&keys.includes('applicationId')&&applicationId(message.applicationId)&&sender.frameId===0&&Number.isSafeInteger(sender.tab?.id)&&brbPage(sender.url)&&brbPage(sender.tab.url);
 if(!popup&&!page)return false;
 if(running){sendResponse({ok:false,error:'An application is already opening. Finish that handoff first.'});return false;}
 running=true;begin(page?sender.tab.id:undefined,page?message.applicationId:undefined).then(sendResponse,error=>sendResponse({ok:false,error:String(error.message||'Open a fresh handoff in BRB.').slice(0,240)})).finally(()=>{running=false;});return true;
});
