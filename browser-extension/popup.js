const button=document.getElementById('fill'),status=document.getElementById('status');
button.addEventListener('click',async()=>{
 button.disabled=true;status.textContent='Opening your employer form…';
 try{const result=await chrome.runtime.sendMessage({action:'beginHandoff'});if(!result?.ok)throw Error(result?.error||'Open a fresh browser handoff from BRB, then try again.');status.textContent=`Filled ${result.filled} fields. Finish ${result.remaining} remaining items on the employer page. Nothing was submitted.`;}
 catch(error){status.textContent=error.message;}
 finally{button.disabled=false;}
});
