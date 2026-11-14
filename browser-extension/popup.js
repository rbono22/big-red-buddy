const button=document.getElementById('fill'),status=document.getElementById('status'),description=document.getElementById('description'),heading=document.getElementById('heading'),signin=document.getElementById('signin');
let available=false;
async function initialize(){
 try{
  const result=await chrome.runtime.sendMessage({action:'getContext'}),kind=result?.context;
  if(kind==='handoff'){
   available=true;heading.textContent='Continue your application';button.textContent='Open & fill application';description.textContent='Open the employer’s form with the answers and documents saved for this BRB application.';status.textContent='Ready to open your application.';
  }else if(kind==='application'){
   available=true;button.textContent='Autofill this application';description.textContent='Fill supported fields on this page using your saved BRB profile, résumé, and matching answers.';status.textContent=result.host?`Ready on ${result.host}.`:'Ready on this application.';
  }else{
   button.textContent='Autofill this application';status.textContent=kind==='brb'?'Open an employer’s application, then click this helper. You can also use Open & autofill application in BRB.':'Open an HTTPS employer application in Chrome, then click this helper.';
  }
 }catch{button.textContent='Autofill this application';status.textContent='The helper could not read this tab. Close it, refresh the application, and try again.';}
 finally{button.disabled=!available;}
}
button.addEventListener('click',async()=>{
 if(!available||button.disabled)return;
 button.disabled=true;signin.hidden=true;status.textContent='Reading the form and matching your saved details…';
 try{
  const result=await chrome.runtime.sendMessage({action:'fillActiveApplication'});
  if(!result?.ok){if(result?.code==='AUTH_REQUIRED')signin.hidden=false;throw Error(result?.error||'The form could not be filled. Refresh it and try again.');}
  const outcome=result.alreadySubmitted?'BRB already records this application as submitted. Check your employer confirmation before submitting again.':result.submissionInProgress?'An automatic submission is still in progress. Wait for its result before submitting on this page.':result.priorSubmissionUnconfirmed?'A previous submission attempt may already have succeeded. Check employer confirmation before submitting again.':'Check your answers on the employer page.';
  status.textContent=`Filled ${result.filled} ${result.filled===1?'field':'fields'}. ${result.preserved?`${result.preserved} existing ${result.preserved===1?'answer was':'answers were'} kept. `:''}${result.remaining?`${result.remaining} ${result.remaining===1?'item still needs':'items still need'} attention. `:''}${result.resumeNeedsRefresh?'Your résumé selection needs updating in BRB. ':''}${outcome} This helper did not submit.`;
 }catch(error){status.textContent=error.message;}
 finally{button.disabled=!available;}
});
signin.addEventListener('click',async()=>{
 signin.disabled=true;
 try{const result=await chrome.runtime.sendMessage({action:'openBRB'});if(!result?.ok)throw Error(result?.error||'Open app.bigredbuddy.com to sign in.');status.textContent='After signing in, return to your application and click Autofill again.';}
 catch(error){status.textContent=error.message;}
 finally{signin.disabled=false;}
});
void initialize();
