const button=document.getElementById('fill'),tailor=document.getElementById('tailor'),status=document.getElementById('status'),description=document.getElementById('description'),heading=document.getElementById('heading'),signin=document.getElementById('signin'),contextForm=document.getElementById('job-context');
const company=document.getElementById('job-company'),title=document.getElementById('job-title'),jobDescription=document.getElementById('job-description');
let available=false,canTailor=false,busy=false,pollTimer;
const refreshButtons=()=>{button.disabled=!available||busy;tailor.disabled=!canTailor||busy;};
function outcomeText(result){
 if(result?.ok===false)return result.error||'The application could not be filled. Try again.';
 const outcome=result.alreadySubmitted?'BRB already records this application as submitted. Check your employer confirmation before submitting again.':result.submissionInProgress?'An automatic submission is still in progress. Wait for its result before submitting on this page.':result.priorSubmissionUnconfirmed?'A previous submission attempt may already have succeeded. Check employer confirmation before submitting again.':'Check your answers on the employer page.';
 const resume=result.resumeEnhancement;
 const attachment=resume?resume.attached?`${resume.fileName} attached. ${resume.noChanges?'No supported wording changes were needed; this PDF uses your saved résumé text. ':'Your résumé was tailored to this role. '}`:`The résumé was prepared but not attached. Check the upload field and try again. `:'';
 return `${attachment}Filled ${result.filled} ${result.filled===1?'field':'fields'}. ${result.preserved?`${result.preserved} existing ${result.preserved===1?'answer was':'answers were'} kept. `:''}${result.remaining?`${result.remaining} ${result.remaining===1?'item still needs':'items still need'} attention. `:''}${result.resumeNeedsRefresh?'Your résumé selection needs updating in BRB. ':''}${outcome} This helper did not submit.`;
}
function requestContext(result){
 if(result?.code!=='JOB_CONTEXT_REQUIRED')return;
 contextForm.hidden=false;
 for(const [element,key] of [[company,'company'],[title,'title'],[jobDescription,'description']])if(!element.value)element.value=result.jobContext?.[key]||'';
}
async function initialize(){
 try{
  const result=await chrome.runtime.sendMessage({action:'getContext'}),kind=result?.context;
  if(kind==='handoff'){
   available=true;heading.textContent='Continue your application';button.textContent='Open & fill application';description.textContent='Open the employer’s form with the answers and documents saved for this BRB application. On the employer page, use Tailor résumé & autofill to create a fresh résumé.';status.textContent='Ready to open your application.';
  }else if(kind==='application'){
   available=true;canTailor=true;button.textContent='Autofill this application';status.textContent=result.host?`Ready on ${result.host}.`:'Ready on this application.';
  }else{
   button.textContent='Autofill this application';status.textContent=kind==='brb'?'Open an employer’s application, then click this helper. You can also use Open & autofill application in BRB.':'Open an HTTPS employer application in Chrome, then click this helper.';
  }
  busy=!!result?.running;
  if(result?.result&&!busy){status.textContent=outcomeText(result.result);requestContext(result.result);}
  else if(result?.progress)status.textContent=result.progress;
  if(busy)pollTimer=setTimeout(initialize,1500);
 }catch{button.textContent='Autofill this application';status.textContent='The helper could not read this tab. Close it, refresh the application, and try again.';}
 finally{refreshButtons();}
}
async function run(tailored){
 if(!available||busy||tailored&&!canTailor)return;
 busy=true;refreshButtons();signin.hidden=true;status.textContent=tailored?'Reading the role and tailoring your latest saved résumé… Keep this application tab open.':'Reading the form and matching your saved details…';
 const message={action:tailored?'tailorActiveApplication':'fillActiveApplication'};
 if(tailored&&!contextForm.hidden){
  message.jobContext={company:company.value.trim(),title:title.value.trim(),description:jobDescription.value.trim()};
  if(message.jobContext.company.length<2||message.jobContext.title.length<2||message.jobContext.description.length<80){status.textContent='Add a company, job title, and at least 80 characters from the job description.';busy=false;refreshButtons();return;}
 }
 try{
  const result=await chrome.runtime.sendMessage(message);
  if(!result?.ok){if(result?.code==='AUTH_REQUIRED')signin.hidden=false;requestContext(result);throw Error(result?.error||'The form could not be filled. Refresh it and try again.');}
  status.textContent=outcomeText(result);
 }catch(error){status.textContent=error.message;}
 finally{busy=false;refreshButtons();}
}
button.addEventListener('click',()=>run(false));tailor.addEventListener('click',()=>run(true));
signin.addEventListener('click',async()=>{
 signin.disabled=true;
 try{const result=await chrome.runtime.sendMessage({action:'openBRB'});if(!result?.ok)throw Error(result?.error||'Open app.bigredbuddy.com to sign in.');status.textContent='After signing in, return to your application and click Autofill again.';}
 catch(error){status.textContent=error.message;}
 finally{signin.disabled=false;}
});
void initialize();
