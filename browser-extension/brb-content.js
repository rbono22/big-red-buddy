// Listen only for a student's click on a BRB-owned application handoff link.
// No profile data, browser token, or page-message bridge is exposed to the site.
(()=>{
 const BRB='https://app.bigredbuddy.com';
 if(location.origin!==BRB||location.pathname!=='/'||location.search||window!==window.top)return;
 let running=false;
 function show(message,href){
  let panel=document.getElementById('brb-autofill-status');
  if(!panel){panel=document.createElement('section');panel.id='brb-autofill-status';panel.setAttribute('role','status');panel.setAttribute('aria-live','polite');panel.style.cssText='position:fixed;right:20px;bottom:20px;z-index:2147483647;max-width:min(420px,calc(100vw - 40px));padding:20px;background:#fff;color:#222;border:2px solid #b31b1b;border-radius:12px;box-shadow:0 8px 28px #0003;font:16px/1.5 system-ui,sans-serif';document.body.append(panel);}
  const title=document.createElement('strong');title.textContent='Big Red Buddy';
  const text=document.createElement('p');text.textContent=message;
  const fallback=document.createElement('a');fallback.href=href;fallback.textContent='Open handoff help';fallback.style.cssText='color:#9c1515;margin-right:20px';
  const close=document.createElement('button');close.type='button';close.textContent='Close';close.addEventListener('click',()=>panel.remove());
  panel.replaceChildren(title,text,fallback,close);
 }
 document.addEventListener('click',async event=>{
  if(!event.isTrusted||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;
  const link=event.target?.closest?.('a[data-brb-autofill]');if(!link||link.hasAttribute('download')||link.getAttribute('target')&&!['_self',''].includes(link.getAttribute('target')))return;
  let url;try{url=new URL(link.getAttribute('href'),BRB+'/');}catch{return;}
  const match=/^#application-handoff\/([A-Za-z0-9:_-]{1,160})$/.exec(url.hash);
  if(url.origin!==BRB||url.pathname!=='/'||url.search||url.username||url.password||!match)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(running)return;
  running=true;show('Opening the employer’s application and filling your saved details…',url.href);
  try{
   const result=await chrome.runtime.sendMessage({action:'beginHandoff',applicationId:match[1]});
   if(!result?.ok)throw Error(result?.error||'The helper could not open this application. Open handoff help below to continue.');
   show(`Filled ${result.filled} ${result.filled===1?'field':'fields'} on the employer’s page. ${result.remaining?`${result.remaining} items still need attention. `:''}${result.priorSubmissionUnconfirmed?'A previous submission may already have succeeded; check for an employer confirmation before submitting again. ':''}This helper did not submit.`,url.href);
  }catch(error){show(String(error.message||'Open handoff help below to continue.').slice(0,240),url.href);}
  finally{running=false;}
 },true);
})();
