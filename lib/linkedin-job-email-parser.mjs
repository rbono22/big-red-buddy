// This parser reads the bounded text of a received job-alert email. It never
// follows email links, logs into LinkedIn, or treats delivery time as job age.
const MAX_TEXT_BYTES=40000,MAX_JOBS=20;
const ALERT_SENDER='jobalerts-noreply@linkedin.com';
const invisibles=/[\p{Cf}\u034f]/gu;
const line=value=>String(value||'').replace(invisibles,'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();

export function isLinkedInJobAlertSender(value){
 if(typeof value!=='string'||value.length>512||/[\r\n\u0000-\u001f\u007f\p{Cf}\u034f]/u.test(value))return false;
 const sender=value.trim().toLowerCase();
 if(sender===ALERT_SENDER)return true;
 const match=sender.match(/^[^<>@]*<([^<>]+)>$/);
 return !!match&&match[1]===ALERT_SENDER;
}

function jobURL(value){
 if(typeof value!=='string'||value.length>8192||/[\s<>\u0000-\u001f\u007f]/.test(value))return '';
 try{
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port||!['linkedin.com','www.linkedin.com'].includes(url.hostname))return '';
  const match=url.pathname.match(/^\/(?:comm\/)?jobs\/view\/(?:[a-zA-Z0-9][a-zA-Z0-9_-]*-)?([1-9]\d{0,19})\/?$/);
  return match?`https://www.linkedin.com/jobs/view/${match[1]}`:'';
 }catch{return '';}
}

export function linkedinJobLinks(value){
 if(typeof value!=='string')return [];
 const links=[];
 for(const match of value.slice(0,100000).replace(/&amp;/gi,'&').matchAll(/https:\/\/[^\s"'<>]+/gi)){
  const canonical=jobURL(match[0].replace(/[\])},.;!]+$/,''));
  if(canonical&&!links.includes(canonical))links.push(canonical);
  if(links.length===MAX_JOBS)break;
 }
 return links;
}

const divider=value=>/^[-–—_=]{3,}$/.test(value);
const alertHeader=value=>/^your job alert(?: for)?\b/i.test(value);
const footer=value=>/^(?:see all jobs(?: on linkedin)?|manage your job alerts?|job search smarter|this email was intended|learn why we included|you are receiving|unsubscribe|help:|©|linkedin and the linkedin logo)\b/i.test(value);
const extra=value=>/^(?:\d+ (?:connections?|alumni)|this company is actively hiring|actively (?:hiring|recruiting)|promoted|easy apply|be an early applicant|view job:?)$/i.test(value)||/^\$[\d,.]+\s*(?:[-–]\s*\$?[\d,.]+)?(?:\s*\/\s*(?:year|yr|hour|hr)|\s*(?:a year|per year))$/i.test(value);
function field(value,max){return value&&value.length<=max&&!/https?:\/\/|www\.|[<>\u0000-\u001f]|\b[^\s@]+@[^\s@]+\b/i.test(value)&&!footer(value)&&!alertHeader(value)&&!divider(value)&&!extra(value)?value:'';}
function candidate(lines,url){
 if(lines.length!==3)return null;
 const [title,company,location]=[field(lines[0],240),field(lines[1],160),field(lines[2],240)];
 if(!title||!company||!location)return null;
 return {externalId:url.slice(url.lastIndexOf('/')+1),title,company,location,url};
}
function heading(row){
 if(row.links.length!==1)return '';
 // Text produced by the shared HTML reader puts the anchor label before its
// canonical URL. Parentheses also cover a common visible-text export format.
 return line(row.value.slice(0,row.value.search(/https:\/\//i)).replace(/[\s(]+$/,''));
}

export function parseLinkedInJobAlert(message={}){
 const empty={jobs:[],alertName:''};
 if(!isLinkedInJobAlertSender(message.sender)||typeof message.text!=='string'||Buffer.byteLength(message.text)>MAX_TEXT_BYTES||/<(?:html|body|script|a|div|table)\b/i.test(message.text))return empty;
 const rows=message.text.replace(invisibles,'').split(/\r?\n/).map(value=>({value:line(value)})).filter(row=>row.value);
 for(const row of rows)row.links=linkedinJobLinks(row.value);
 const alertName=(rows.find(row=>/^your job alert for\s+/i.test(row.value))?.value.replace(/^your job alert for\s+/i,'')||'').slice(0,240);
 const jobs=[],seen=new Set();
 const add=job=>{if(job&&!seen.has(job.externalId)&&jobs.length<MAX_JOBS){seen.add(job.externalId);jobs.push(job);}};
 let start=0;
 for(let index=0;index<rows.length&&jobs.length<MAX_JOBS;index++){
  const row=rows[index];
  if(footer(row.value))break;
  if(divider(row.value)||alertHeader(row.value)){start=index+1;continue;}
  const label=heading(row),splitView=row.links.length===1&&!label&&/^view job:?$/i.test(rows[index-1]?.value||'');
  if(row.links.length!==1||!(/^view job:?$/i.test(label)||splitView))continue;
  const url=row.links[0],fields=[];let valid=true;
  for(const previous of rows.slice(start,index)){
   if(extra(previous.value))continue;
   if(previous.links.length){if(previous.links.length!==1||previous.links[0]!==url||!heading(previous)){valid=false;break;}fields.push(heading(previous));}
   else fields.push(previous.value);
  }
  if(valid)add(candidate(fields,url));
  start=index+1;
 }
 // HTML-only messages may link the title without a trailing "View job".
 // Accept only a title plus exactly two following metadata lines, terminated
 // by a recognizable card boundary. Ambiguous layouts stay unimported.
 for(let index=0;index<rows.length&&jobs.length<MAX_JOBS;index++){
  const row=rows[index];if(footer(row.value))break;
  const title=heading(row);if(!field(title,240))continue;
  const company=rows[index+1],location=rows[index+2],after=rows[index+3];
  if(!company||!location||company.links.length||location.links.length)continue;
  if(after&&!divider(after.value)&&!footer(after.value)&&!extra(after.value)&&!after.links.length)continue;
  add(candidate([title,company.value,location.value],row.links[0]));
 }
 return {jobs,alertName};
}
