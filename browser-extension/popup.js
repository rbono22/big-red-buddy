const button=document.getElementById('fill'),status=document.getElementById('status');
button.addEventListener('click',async()=>{
 button.disabled=true;status.textContent='Opening your employer form…';
 try{const result=await chrome.runtime.sendMessage({action:'beginHandoff'});if(!result?.ok)throw Error(result?.error||'Open a fresh browser handoff from BRB, then try again.');status.textContent=`Filled ${result.filled} ${result.filled===1?'field':'fields'}. ${result.remaining?`${result.remaining} items still need attention. `:''}${result.priorSubmissionUnconfirmed?'A previous submission attempt may already have succeeded. Check employer confirmation before submitting again. This helper did not submit.':'Check your answers on the employer page. This helper did not submit.'}`;}
 catch(error){status.textContent=error.message;}
 finally{button.disabled=false;}
});
