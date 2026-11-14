/** Runs in the clicked tab's isolated world. Returns field metadata, never existing answers. */
export function scanApplication(){
 delete globalThis.__brbApplicationScan;
 const normalize=value=>String(value||'').replace(/[✱*]/g,'').replace(/\s+/g,' ').trim();
 const safeURL=value=>{try{const u=new URL(value),h=u.hostname.toLowerCase();return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&h.includes('.')&&!h.includes(':')&&!h.endsWith('.')&&!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h)&&!/(?:^|\.)(?:localhost|local|internal|test|invalid|example|lan|home|arpa)$/.test(h)&&!['app.bigredbuddy.com','bigredbuddy.com'].includes(h)&&u.href.length<=2000;}catch{return false;}};
 if(!safeURL(location.href))return {ok:false,error:'Open an employer’s HTTPS application page, then click BRB again.'};
 const hidden=e=>{
  if(e.disabled||e.readOnly||e.type==='hidden'||e.closest('[inert],[aria-hidden="true"]'))return true;
  const target=e.type==='file'?(e.closest('.file-upload,.application-question,[data-field-path]')||e.labels?.[0]||e.closest('label')||e):e;
  return !!target.closest('[hidden]')||getComputedStyle(target).display==='none'||getComputedStyle(target).visibility==='hidden'||!target.getClientRects().length;
 };
 const labelText=e=>{if(!e||e.matches('input,textarea,select,[contenteditable]'))return '';const copy=(e.querySelector('.application-label,.ashby-application-form-question-title')||e).cloneNode(true);for(const control of copy.querySelectorAll('input,textarea,select,[contenteditable]'))control.remove();return normalize(copy.textContent);};
 const labelled=e=>{const ids=(e.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean);return normalize(ids.map(id=>labelText(document.getElementById(id))).join(' '))||normalize(e.getAttribute('aria-label'))||labelText(e.labels?.[0])||labelText(e.closest('label'));};
 const groupFor=e=>e.closest('fieldset,[role="radiogroup"],[role="group"],.application-question,[data-field-path]');
 const groupLabel=e=>{const g=groupFor(e);if(!g)return '';return labelText(g.querySelector('legend,.application-label,.ashby-application-form-question-title'))||normalize((g.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>labelText(document.getElementById(id))).join(' '))||normalize(g.getAttribute('aria-label'));};
 const autoLabels={name:'Full name','given-name':'First name','family-name':'Last name',email:'Email',tel:'Phone','street-address':'Street address','address-line1':'Address line 1','address-line2':'Address line 2','address-level2':'City','address-level1':'State / province','postal-code':'Postal code','country-name':'Country',country:'Country',organization:'Current company','organization-title':'Current job title',url:'Website'};
 const labelFor=e=>labelled(e)||autoLabels[(e.autocomplete||e.getAttribute('autocomplete')||'').split(/\s+/).at(-1)]||groupLabel(e)||normalize(e.getAttribute('placeholder'));
 const sensitive=/\b(?:password|passcode|one[- ]time|security code|credit card|debit card|card number|bank account|routing number|social security|ssn|passport|date of birth|birth date)\b/i;
 const clean=value=>typeof value==='string'&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value)?value:'';
 const read=()=>{
  const all=[...document.querySelectorAll('input,textarea,select,button[type="button"][aria-pressed]')].filter(e=>!e.closest('#brb-application-helper'));
  const entries=[],seen=new Set();if(all.length>500)return entries;
  for(const [index,e] of all.entries()){
   if(seen.has(e)||hidden(e)||e.closest('form')?.querySelector('input[type="password"]'))continue;
   const native=e.tagName==='TEXTAREA'?'textarea':e.tagName==='SELECT'?'select':e.tagName==='BUTTON'?'yesno':(e.type||'text').toLowerCase();
   if(!['text','email','tel','search','url','textarea','select','radio','checkbox','file','yesno'].includes(native))continue;
   let controls=[e],label=labelFor(e),type=['search','url'].includes(native)?'text':native,options=[],optionValues=[];
   if(native==='yesno'){
    const group=e.closest('[data-field-path]');if(!group)continue;
    controls=[...group.querySelectorAll('button')];label=groupLabel(e);options=controls.map(control=>normalize(control.textContent));
    if(controls.length!==2||controls.some(control=>control.type!=='button'||!control.hasAttribute('aria-pressed')||hidden(control))||!options.includes('Yes')||!options.includes('No'))continue;
   }else if(native==='radio'||native==='checkbox'){
    const group=groupFor(e),name=e.getAttribute('name');
    controls=all.filter(other=>other.type===native&&!hidden(other)&&(name?other.getAttribute('name')===name&&other.form===e.form:group&&groupFor(other)===group));
    if(!controls.length)controls=[e];
    if(native==='radio'||controls.length>1){label=groupLabel(e);if(!label)continue;options=controls.map(labelled);optionValues=controls.map(control=>String(control.value||''));if(options.some(x=>!x)||new Set(options).size!==options.length)continue;}
    else{label=labelled(e)||label;options=['Yes','No'];}
   }else if(native==='select'){
    options=[...e.options].filter(o=>!o.disabled&&String(o.value||'')!=='').map(o=>normalize(o.textContent));
    optionValues=[...e.options].filter(o=>!o.disabled&&String(o.value||'')!=='').map(o=>String(o.value));
    if(!options.length||new Set(options).size!==options.length)continue;
   }else if(native==='file'){
    label=label||normalize(e.closest('.file-upload,[data-field-path],.application-question')?.getAttribute('aria-label'))||normalize(e.name||e.id).replace(/[_-]/g,' ');
    if(!/\b(?:resume|cv|cover[ -]?letter)\b/i.test(label.normalize('NFD').replace(/\p{Diacritic}/gu,''))||e.multiple)continue;
   }else if((e.getAttribute('role')==='combobox'||e.matches('.location-input'))&&/\b(?:city|location)\b/i.test(label))type='location';
   if(!label||label.length>2400||sensitive.test(label)||/[\u0000-\u001f\u007f]/.test(label)||options.length>300||options.some(x=>x.length>2400)||optionValues.some(x=>x.length>2400))continue;
   const field={key:native==='file'&&/\b(?:resume|cv)\b/i.test(label.normalize('NFD').replace(/\p{Diacritic}/gu,''))?'_systemfield_resume':`field-${index}`,label,type,required:controls.some(c=>c.required||c.getAttribute('aria-required')==='true')||native==='yesno'&&e.closest('[data-field-path]')?.getAttribute('aria-required')==='true'};
   if(entries.some(entry=>entry.field.key===field.key))field.key=`field-${index}`;
   if(clean(e.id))field.controlId=e.id;if(clean(e.getAttribute('name')))field.controlName=e.getAttribute('name');
   if(options.length){field.options=options;field.optionValues=optionValues;}
   if(native==='radio'&&controls.every(c=>clean(c.id)))field.radioIds=controls.map(c=>c.id);
   if(native==='checkbox'&&controls.length>1&&controls.every(c=>clean(c.id)))field.checkboxIds=controls.map(c=>c.id);
   if(native==='checkbox'&&controls.length>1||native==='select'&&e.multiple)field.multiple=true;
   if(Number.isSafeInteger(e.maxLength)&&e.maxLength>0)field.maxLength=e.maxLength;
   if(native==='file'){field.document=/cover[ -]?letter/i.test(label)?'coverLetter':'resume';if(clean(e.getAttribute('accept')))field.accept=e.getAttribute('accept');}
   entries.push({field,controls});controls.forEach(control=>seen.add(control));if(entries.length>=70)break;
  }
  return entries;
 };
 const entries=read(),fields=entries.map(entry=>entry.field);
 const fileSelections=new WeakMap();for(const entry of entries)if(entry.field.type==='file')for(const control of entry.controls)fileSelections.set(control,[...control.files||[]]);
 const readTitle=()=>normalize(document.querySelector('[data-ui="job-title"],.posting-header h2,h1')?.textContent||document.title).slice(0,240)||'Job application';
 const title=readTitle();
 const context=normalize([document.title,...[...document.querySelectorAll('h1,h2,form[aria-label]')].slice(0,12).map(e=>e.getAttribute('aria-label')||e.textContent)].join(' '));
 const identity=fields.filter(f=>/\b(?:name|email|phone|location|company)\b/i.test(f.label)).length;
 const application=fields.some(f=>f.type==='file'&&f.document==='resume')||identity>=2&&/\b(?:apply|application|career|job|candidate|employment|recruit)/i.test(context)||fields.some(f=>/\b(?:work authorization|sponsorship|employment|resume|résumé|cv)\b/i.test(f.label))&&identity>=1;
 if(!fields.length||!application)return {ok:false,error:document.querySelector('iframe')?'Open the application form in its own tab, then click BRB again.':'I could not identify a job application on this page. Open the application form and try again.'};
 const scanId=[...crypto.getRandomValues(new Uint8Array(16))].map(n=>n.toString(16).padStart(2,'0')).join('');
 // Read only public job-description containers or JobPosting metadata. Never
 // collect application answers, arbitrary body text, or unbounded scripts.
 const readJobContext=()=>{
 const publicText=(node,max=20000)=>{
  if(!node||node.matches?.('input,textarea,select,[contenteditable],form'))return '';
  const children=[...node.querySelectorAll('*')];if(children.length>2500)return '';
  const copy=node.cloneNode(true),copies=[...copy.querySelectorAll('*')];
  for(const [index,element] of children.entries()){const style=element.isConnected?getComputedStyle(element):element.style;if(style?.display==='none'||style?.visibility==='hidden')copies[index].remove();}
  for(const child of copy.querySelectorAll('script,style,noscript,form,input,textarea,select,button,[contenteditable],[hidden],[aria-hidden="true"],[inert],#brb-application-helper'))child.remove();
  return normalize(copy.textContent).slice(0,max);
 };
 const htmlText=value=>{
  if(typeof value!=='string'||value.length>50000)return '';
  const template=document.createElement('template');template.innerHTML=value;
  return publicText(template.content);
 };
 const candidates=[];let visited=0;
 const visit=(node,depth=0)=>{
  if(!node||typeof node!=='object'||depth>7||++visited>150)return;
  if(Array.isArray(node)){for(const item of node.slice(0,30))visit(item,depth+1);return;}
  if(node['@type']==='JobPosting'||Array.isArray(node['@type'])&&node['@type'].includes('JobPosting'))candidates.push(node);
  if(node['@graph'])visit(node['@graph'],depth+1);
 };
 for(const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0,10)){
  const value=script.textContent||'';if(value.length>50000)continue;
  try{visit(JSON.parse(value));}catch{}
 }
 let jobTitle='',company='',description='';
 if(candidates.length===1){const job=candidates[0];jobTitle=typeof job.title==='string'?normalize(job.title).slice(0,240):'';company=typeof job.hiringOrganization?.name==='string'?normalize(job.hiringOrganization.name).slice(0,160):'';description=htmlText(job.description);}
 if(!description){
  const selector='[itemprop="description"],[data-ui="job-description"],[data-testid="job-description"],.ashby-job-posting-description,.posting-page .section-wrapper,#job-description,.job-description,.job__description'+(location.hostname==='job-boards.greenhouse.io'?',#content':'');
  const parts=[];for(const node of [...document.querySelectorAll(selector)].slice(0,12)){
   if(node.closest('form,[hidden],[aria-hidden="true"],[inert]')||getComputedStyle(node).display==='none'||getComputedStyle(node).visibility==='hidden'||!node.getClientRects().length)continue;
   const value=publicText(node);if(value&&!parts.some(part=>part.includes(value)))parts.push(value);
  }
  description=parts.join(' ').slice(0,20000);
 }
 if(!company){
  const companyNode=document.querySelector('[itemprop="hiringOrganization"] [itemprop="name"],[data-ui="company-name"],[data-testid="company-name"],.company-name');
  company=publicText(companyNode,160);
  if(!company&&location.hostname==='jobs.lever.co')company=normalize(document.querySelector('.main-header-logo img,.main-header-logo')?.getAttribute('alt')||document.querySelector('.main-header-logo img')?.getAttribute('alt')).replace(/\s+logo$/i,'').slice(0,160);
 }
 return {title:jobTitle||readTitle(),company,description};
 };
 const jobContext=readJobContext();
 globalThis.__brbApplicationScan={scanId,url:location.href,title,read,readTitle,fields,fileSelections,jobContext,readJobContext};
 return {ok:true,url:location.href,title,company:jobContext.company,scanId,fields,jobContext};
}
