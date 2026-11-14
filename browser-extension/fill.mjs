/** Serialized into the exact employer tab after a user clicks the extension. Never submits. */
export async function fillApplication(payload){
 const result={ok:false,filled:0,remaining:0,skipped:[],priorSubmissionUnconfirmed:payload?.priorSubmissionUnconfirmed===true};
 const normalize=value=>String(value||'').replace(/[✱*]/g,'').replace(/\s+/g,' ').trim();
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 if(payload?.version!==1||location.href!==payload.url||payload.expiresAt<=Date.now()||!Array.isArray(payload.fields)||payload.fields.length>70)return {...result,error:'The employer address changed. Reopen the handoff from BRB.'};
 const standalone=payload.mode==='standalone',scan=standalone?globalThis.__brbApplicationScan:null;
 if(standalone){result.preserved=0;result.alreadySubmitted=payload.alreadySubmitted===true;result.submissionInProgress=payload.submissionInProgress===true;result.resumeNeedsRefresh=payload.resumeNeedsRefresh===true;}
 if(standalone&&payload.resumeEnhancement)result.resumeEnhancement={fileName:payload.documents?.resume?.name||payload.resumeEnhancement.fileName,noChanges:payload.resumeEnhancement.noChanges===true,attached:false};
 if(standalone&&(!scan||scan.scanId!==payload.scanId||scan.url!==payload.url||typeof scan.read!=='function'))return {...result,error:'This application changed. Click BRB again to scan the current form.'};
 const sameField=(a,b)=>['key','label','type','required','controlId','controlName','options','optionValues','radioIds','checkboxIds','maxLength','multiple','document','accept'].every(key=>JSON.stringify(a[key])===JSON.stringify(b[key]));
 const standaloneEntry=field=>{if(scan?.readTitle?.()!==scan?.title)return null;const current=scan?.read().find(entry=>entry.field.key===field.key);return current&&sameField(current.field,field)?current:null;};
 const unchangedFileSelection=input=>{const original=scan?.fileSelections?.get(input),current=[...(input.files||[])];return Array.isArray(original)&&original.length===current.length&&original.every((file,index)=>file===current[index]);};
 const unchangedJobContext=()=>typeof scan?.readJobContext==='function'&&JSON.stringify(scan.readJobContext())===JSON.stringify(scan.jobContext);
 if(standalone&&payload.resumeEnhancement&&!unchangedJobContext())return {...result,error:'The job details changed while tailoring. Click BRB again on the current role.'};
 const esc=value=>CSS.escape(String(value));
 if(!standalone&&!['lever','greenhouse','ashby','workable'].includes(payload.provider))return {...result,error:'This employer form is not supported.'};
 const root=()=>standalone?document:payload.provider==='workable'?document.querySelector('form[data-ui="application-form"]'):payload.provider==='ashby'?document.querySelector('[data-field-path]')?document:null:document.querySelector('#application-form');
 const jobHeading=()=>payload.provider==='lever'?document.querySelector('.posting-header h2')||document.querySelector('h2'):payload.provider==='workable'?document.querySelector('h1[data-ui="job-title"]'):document.querySelector('h1');
 // Greenhouse's embeddable form has no heading; its document title reads "Job Application for <role> at <company>".
 const jobTitle=()=>{if(standalone)return scan.readTitle();const heading=jobHeading();if(heading)return heading.textContent;if(payload.provider==='greenhouse'){const match=/^Job Application for (.+) at .+$/.exec(document.title||'');return match?match[1]:'';}return '';};
 for(let n=0;n<40&&(!root()||!jobTitle());n++)await wait(250);
 const form=root();if(!form)return {...result,error:'The employer application form is not ready. Complete it on the website.'};
 const title=jobTitle();if(!title||normalize(title)!==normalize(payload.title))return {...result,error:'The job title changed. Reopen the handoff from BRB.'};
 const controls=field=>{
  if(standalone)return standaloneEntry(field)?.controls||[];
  if(payload.provider==='lever'&&field.controlName)return [...form.querySelectorAll(`input[name="${esc(field.controlName)}"]:not([type="hidden"]),textarea[name="${esc(field.controlName)}"],select[name="${esc(field.controlName)}"]`)];
  if(payload.provider==='greenhouse'&&field.type==='checkbox'&&field.multiple&&Array.isArray(field.checkboxIds))return field.checkboxIds.flatMap(id=>[...form.querySelectorAll(`#${esc(id)}`)]);
  if(payload.provider==='greenhouse'&&field.controlId)return field.type==='radio'&&Array.isArray(field.radioIds)?field.radioIds.flatMap(id=>[...form.querySelectorAll(`#${esc(id)}`)]):[...form.querySelectorAll(`#${esc(field.controlId)}`)];
  if(payload.provider==='ashby')return field.type==='consent'?[...form.querySelectorAll(`input[name="${esc(field.key)}"]`)]:field.type==='yesno'?[...form.querySelectorAll(`[data-field-path="${esc(field.key)}"] button`)]:[...form.querySelectorAll(`[data-field-path="${esc(field.key)}"] input,[data-field-path="${esc(field.key)}"] textarea,[data-field-path="${esc(field.key)}"] select`)];
  if(payload.provider==='workable'){const key=field.key==='_systemfield_resume'?'resume':field.key;return [...form.querySelectorAll(`[name="${esc(key)}"],[data-ui="${esc(key)}"]`)].filter(e=>['INPUT','TEXTAREA','SELECT'].includes(e.tagName));}
  return [];
 };
 const visible=e=>e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden';
 const fieldLabel=(field,input)=>{
  if(standalone)return standaloneEntry(field)?.field.label||'';
  if(payload.provider==='ashby')return form.querySelector(`[data-field-path="${esc(field.key)}"] .ashby-application-form-question-title`)?.textContent||input.labels?.[0]?.textContent;
  if(payload.provider==='lever')return input.closest('.application-question')?.querySelector('.application-label')?.textContent||input.labels?.[0]?.textContent;
  const group=field.type==='radio'||field.type==='checkbox'&&field.multiple?input.closest('fieldset,[role="radiogroup"],[role="group"]'):field.type==='file'?input.closest('.file-upload'):null;
  if(group)return group.querySelector('legend')?.textContent||document.getElementById(group.getAttribute('aria-labelledby'))?.textContent;
  const ids=input.getAttribute('aria-labelledby')?.split(/\s+/)||[];
  const labelled=(payload.provider==='workable'?ids.slice(0,1):ids).map(id=>document.getElementById(id)?.textContent||'').join(' ');
  return labelled||input.labels?.[0]?.textContent||input.closest('label')?.textContent;
 };
 const setValue=(input,value)=>{const prototype=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:input.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(prototype,'value')?.set;if(setter)setter.call(input,value);else input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));};
 const skip=(field,reason)=>{result.skipped.push({label:field.label,reason});};
 const successful=[],files=payload.fields.filter(f=>f.type==='file'),other=payload.fields.filter(f=>f.type!=='file');
 for(const field of [...files,...other]){
  const replaceResume=standalone&&!!payload.resumeEnhancement&&field.type==='file'&&field.document==='resume';
  if(location.href!==payload.url||payload.expiresAt<=Date.now())return {...result,error:'The employer page or handoff changed. Reopen it from BRB.'};
  if(standalone){
   const current=controls(field),first=current[0];
   const occupied=field.type==='file'?first?.files?.length:current.some(control=>control.tagName==='BUTTON'?control.getAttribute('aria-pressed')==='true':['radio','checkbox'].includes(control.type)?control.checked:control.tagName==='SELECT'?[...control.selectedOptions].some(option=>!option.disabled&&String(option.value||'')!==''):String(control.value||'').trim()!=='');
   if(occupied&&!replaceResume){result.preserved++;continue;}
  }
  const answer=payload.answers?.[field.key];if(typeof answer?.value!=='string'||!answer.value.trim()){if(field.required)skip(field,'Needs your answer');continue;}
  const inputs=controls(field),input=inputs[0];
  if(!input||!input.isConnected||input.disabled||input.readOnly||field.type!=='file'&&!visible(input)){skip(field,'Control needs attention');continue;}
  const label=normalize(fieldLabel(field,input)).replace(payload.provider==='workable'?/\s*(Choose|Replace) file$/:/$^/,'');
  if(!label||label!==normalize(field.label)){skip(field,'Question wording changed');continue;}
  try{
   if(field.type==='file'){
    if(standalone&&input.accept&&!input.accept.split(',').some(value=>['.pdf','application/pdf','*/*'].includes(value.trim().toLowerCase())))throw Error('This upload needs a different document format');
    const doc=payload.documents?.[field.document];if(!doc||doc.mimeType!=='application/pdf'||doc.name!==answer.value||typeof doc.file!=='string'||doc.file.length>17*1024*1024||input.type!=='file'||input.multiple)throw Error('Document unavailable');
    const bytes=Uint8Array.from(atob(doc.file),c=>c.charCodeAt(0));if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw Error('Invalid PDF');
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');if(digest!==doc.sha256)throw Error('Document changed');
    if(standalone&&(!standaloneEntry(field)||location.href!==payload.url||payload.expiresAt<=Date.now()||(replaceResume?!unchangedFileSelection(input)||!unchangedJobContext():input.files?.length)))throw Error(replaceResume?'The page, job details or résumé selection changed while tailoring. Click BRB again.':'The employer page changed');
    const transfer=new DataTransfer();transfer.items.add(new File([bytes],doc.name,{type:'application/pdf'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    if(input.files.length!==1||input.files[0].name!==doc.name||input.files[0].size!==bytes.length)throw Error('Upload not selected');
    await wait(1000);
    if(replaceResume){if(!input.isConnected||input.files.length!==1||input.files[0].name!==doc.name||input.files[0].size!==bytes.length)throw Error('Confirm the résumé upload on the employer page');result.resumeEnhancement.attached=true;}
   }else if(['text','email','tel','textarea'].includes(field.type)){
    if(!['text','email','tel','search','url','textarea'].includes(input.type)||inputs.length!==1||input.maxLength>0&&answer.value.length>input.maxLength)throw Error('Unsupported input');setValue(input,answer.value);if(input.value!==answer.value)throw Error('Value changed');
   }else if(field.type==='location'){
    if(inputs.length!==1||!['text','search'].includes(input.type))throw Error('Unsupported location');setValue(input,answer.value);await wait(750);
    if(standalone&&(!standaloneEntry(field)||location.href!==payload.url||payload.expiresAt<=Date.now()||input.value!==answer.value))throw Error('The employer page changed');
    const options=[...document.querySelectorAll('[role="option"],.dropdown-location')].filter(e=>visible(e)&&normalize(e.textContent).toLowerCase()===normalize(answer.value).toLowerCase());
    if(options.length!==1||options[0].closest('a[href],input')||options[0].closest('button')?.type==='submit')throw Error('Select the matching city');options[0].click();
    if(normalize(input.value).toLowerCase()!==normalize(answer.value).toLowerCase())throw Error('Select the matching city');
   }else if(field.type==='select'&&input.tagName==='SELECT'&&!input.getAttribute('role')){
    const values=field.multiple?answer.value.split('\n'):[answer.value],options=[...input.options];
    if(values.some(value=>options.filter(o=>!o.disabled&&normalize(o.textContent)===normalize(value)).length!==1))throw Error('Choices changed');
    if(Boolean(input.multiple)!==Boolean(field.multiple))throw Error('Choices changed');
    if(field.multiple){for(const option of options)option.selected=values.some(value=>normalize(value)===normalize(option.textContent));input.dispatchEvent(new Event('change',{bubbles:true}));}else setValue(input,options.find(o=>normalize(o.textContent)===normalize(values[0])).value);
   }else if(field.type==='yesno'&&(payload.provider==='ashby'||standalone)){
    if(!['Yes','No'].includes(answer.value)||!field.options?.includes(answer.value)||inputs.some(e=>e.tagName!=='BUTTON'||e.type!=='button'))throw Error('Choice needs attention');
    const matches=inputs.filter(e=>normalize(e.textContent)===answer.value);if(matches.length!==1)throw Error('Choices changed');matches[0].click();if(matches[0].getAttribute('aria-pressed')!=='true')throw Error('Choice needs attention');
   }else if(['radio','consent','checkbox'].includes(field.type)){
    const expected=field.type==='checkbox'?'checkbox':'radio';if(inputs.some(e=>e.type!==expected))throw Error('Unsupported choice');
    const options=standalone?field.options.map(normalize):inputs.map(e=>normalize(e.labels?.[0]?.textContent||e.closest('label')?.textContent));
    const values=field.multiple?answer.value.split('\n'):[answer.value];
    if(field.type==='checkbox'&&!field.multiple){if(!['Yes','No'].includes(answer.value)||inputs.length!==1)throw Error('Choice changed');if(inputs[0].checked!==(answer.value==='Yes'))inputs[0].click();if(inputs[0].checked!==(answer.value==='Yes'))throw Error('Choice needs attention');}
    else{if(values.some(value=>options.filter(o=>o===normalize(value)).length!==1))throw Error('Choices changed');for(let i=0;i<inputs.length;i++){const wanted=values.some(v=>normalize(v)===options[i]);if(wanted&&!inputs[i].checked||!wanted&&inputs[i].checked&&expected==='checkbox')inputs[i].click();}if(inputs.some((e,i)=>e.checked!==values.some(v=>normalize(v)===options[i])))throw Error('Choice needs attention');}
   }else throw Error('Finish this question on the website');
   result.filled++;successful.push(field);
  }catch(error){skip(field,error.message);}
 }
 // Employer resume parsers can change other fields asynchronously. Report any
 // value that has already changed instead of claiming it was filled correctly.
 for(const field of successful.filter(f=>['text','email','tel','textarea','location'].includes(f.type))){
  const input=controls(field)[0],value=payload.answers[field.key].value;
  if(!input?.isConnected||normalize(input.value)!==normalize(value)){result.filled--;skip(field,'The employer page changed this answer');}
 }
 result.remaining=result.skipped.length;result.ok=true;
 document.getElementById('brb-application-helper')?.remove();
 const banner=document.createElement('aside');banner.id='brb-application-helper';banner.setAttribute('role','status');banner.style.cssText='position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:min(380px,calc(100vw - 64px));max-height:60vh;overflow:auto;overflow-wrap:anywhere;background:white;color:#222;border:2px solid #b31b1b;border-radius:10px;padding:16px;font:14px/1.5 Arial,sans-serif;box-shadow:0 4px 18px #0002';
 const heading=document.createElement('strong');heading.textContent=`BRB filled ${result.filled} ${result.filled===1?'field':'fields'}`;banner.append(heading);
 const status=payload.alreadySubmitted?'BRB already records this application as submitted. Check your employer confirmation before submitting again.':payload.submissionInProgress?'An automatic submission is still in progress. Wait for its result before submitting on this page.':result.priorSubmissionUnconfirmed?'A previous submission attempt could not be confirmed and may already have succeeded. Check employer confirmation before submitting again.':'Check your answers and upload status before submitting on this page.';
 const summary=document.createElement('p');summary.textContent=`${result.preserved?`Kept ${result.preserved} existing ${result.preserved===1?'answer':'answers'}. `:''}${result.remaining?`${result.remaining} items need your attention. `:''}${payload.resumeNeedsRefresh?'Your saved résumé has changed; choose the current résumé before submitting. ':''}${status} This helper only filled fields; it did not submit.`;banner.append(summary);
 if(result.resumeEnhancement){const notice=document.createElement('p'),resume=result.resumeEnhancement;notice.textContent=resume.attached?`${resume.fileName} attached. ${resume.noChanges?'No supported wording changes were needed; this PDF uses your current saved résumé.':'Tailored to this role using your saved experience.'}`:`${resume.fileName} was prepared but could not be attached. Check the résumé upload field and try again.`;banner.append(notice);}
 if(result.skipped.length){const list=document.createElement('ul');for(const item of result.skipped.slice(0,8)){const row=document.createElement('li');row.textContent=normalize(item.label)+(item.reason==='Needs your answer'?'':`: ${item.reason}`);list.append(row);}banner.append(list);}
 const dismiss=document.createElement('button');dismiss.type='button';dismiss.textContent='Close';dismiss.onclick=()=>banner.remove();banner.append(dismiss);document.body.append(banner);return result;
}
