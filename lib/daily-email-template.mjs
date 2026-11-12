const COLOR={red:'#b31b1b',ink:'#222222',muted:'#626262',line:'#dedede',paper:'#f7f7f7',soft:'#fdf0f0',white:'#ffffff'};
const FONT="Arial, Helvetica, sans-serif";
const SECTIONS=Object.freeze({
 classes:{topic:'school',title:'Classes today',page:'academics',label:'Open Academics'},
 deadlines:{topic:'school',title:'Due today',page:'academics',label:'Review your deadlines'},
 upcoming:{topic:'school',title:'Due in the next 7 days',page:'academics',label:'See your week'},
 academic:{topic:'school',title:'Holidays & academic dates',page:'events',label:'View academic dates'},
 events:{topic:'events',title:'Campus & community',page:'events',label:'Explore events'},
 jobs24h:{topic:'jobs',title:'New roles · past 24 hours',page:'careers',label:'Open Career Studio'},
 jobsWeek:{topic:'jobs',title:'Roles from the past week',page:'careers',label:'Open Career Studio'},
 news:{topic:'news',title:'From your selected newsletters',page:'news',label:'Open News'},
 review:{topic:null,title:'A few details to check',page:'overview',label:'Review in BRB'}
});
const ORDER=Object.keys(SECTIONS),MAX_ITEM_CHARS=1800,MAX_SECTIONS=9,MAX_ITEMS=6,MAX_CONTENT_CHARS=16000;
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const clean=(value,max=1000)=>String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,max).trim();
const single=(value,max=100)=>clean(value,max).replace(/\s+/g,' ');
const count=value=>Number.isSafeInteger(value)&&value>=0?Math.min(value,99999):0;
function link(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&url.href.length<=2048?url.href:null;}catch{return null;}}
function origin(value){
 const invalid=()=>new TypeError('Use a valid HTTPS BRB origin, or HTTP on an exact loopback host for development.');
 if(typeof value!=='string'||value.length>2048||/[\s\\]/.test(value)||!/^https?:\/\/[^/?#]+/i.test(value))throw invalid();
 let url;try{url=new URL(value);}catch{throw invalid();}
 const authority=value.match(/^https?:\/\/([^/?#]+)/i)?.[1]??'';
 if(url.username||url.password||authority.includes('@'))throw invalid();
 // Check the written authority as well as URL.hostname: the URL parser maps
 // alternate IPv4 spellings such as 127.1 to 127.0.0.1.
 const loopback=/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(authority)&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback))throw invalid();
 return url.origin;
}
function formatDate(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new TypeError('Use a valid briefing date.');
 const date=new Date(value+'T12:00:00Z');if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)throw new TypeError('Use a valid briefing date.');
 return new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(date);
}
function plainItem(value){
 return clean(value,MAX_ITEM_CHARS).split(/\r?\n/).filter(line=>!/^\s*\/apply\s+/.test(line)).join('\n').trim();
}
function htmlLine(value,key){
 const whole=link(value.trim());
 if(whole){const label=key==='events'?'Open event / registration':key.startsWith('jobs')?'View role':key==='news'?'Read source':'Open source';return `<a href="${escape(whole)}" style="color:${COLOR.red};font-weight:700;text-decoration:underline;word-break:break-word;">${label} <span style="font-weight:400;">(${escape(new URL(whole).hostname)})</span></a>`;}
 // URLs embedded in a sentence retain their visible destination. Source text
 // can never introduce markup, CSS, images or an executable URI.
 let output='',offset=0;
 for(const match of value.matchAll(/https:\/\/[^\s<>"']+/g)){
  const candidate=match[0].replace(/[.,;!?]+$/,''),safe=link(candidate);
  output+=escape(value.slice(offset,match.index));
  output+=safe?`<a href="${escape(safe)}" style="color:${COLOR.red};text-decoration:underline;word-break:break-word;">${escape(candidate)}</a>${escape(match[0].slice(candidate.length))}`:escape(match[0]);
  offset=match.index+match[0].length;
 }
 return output+escape(value.slice(offset));
}
function itemHTML(item,key){
 const lines=item.split('\n'),first=lines.shift();
 return `<tr><td style="padding:15px 0;border-bottom:1px solid ${COLOR.line};font:15px/1.6 ${FONT};color:${COLOR.ink};overflow-wrap:anywhere;word-break:break-word;"><div style="font-weight:700;">${htmlLine(first,key)}</div>${lines.length?`<div style="margin-top:4px;color:${COLOR.muted};">${lines.map(line=>htmlLine(line,key)).join('<br>')}</div>`:''}</td></tr>`;
}
function topicAllowed(key,topics){const topic=SECTIONS[key]?.topic;return topic?topics.has(topic):key==='review'&&(topics.has('school')||topics.has('events'));}
function contentSections(briefing,topics){
 const candidates=Array.isArray(briefing.emailSections)?briefing.emailSections:[],seen=new Set();let budget=MAX_CONTENT_CHARS,markupBudget=50000;
 return candidates.filter(section=>section&&ORDER.includes(section.sectionKey)&&!seen.has(section.sectionKey)&&topicAllowed(section.sectionKey,topics)&&(seen.add(section.sectionKey),true)).sort((a,b)=>ORDER.indexOf(a.sectionKey)-ORDER.indexOf(b.sectionKey)).slice(0,MAX_SECTIONS).map(section=>{
  const source=Array.isArray(section.items)?section.items:[],items=[];
  for(const value of source.slice(0,MAX_ITEMS)){if(typeof value!=='string')continue;const item=plainItem(value);if(!item||item.length>budget)continue;const markupSize=Buffer.byteLength(itemHTML(item,section.sectionKey),'utf8');if(markupSize>markupBudget)continue;budget-=item.length;markupBudget-=markupSize;items.push(item);}
  const total=Math.max(count(section.total),source.length),empty=single(section.empty,220);
  // An empty school day collapses into one "Today" line instead of two empty sections.
  const title=section.sectionKey==='classes'&&section.title==='Today'?'Today':SECTIONS[section.sectionKey].title;
  return{...SECTIONS[section.sectionKey],title,key:section.sectionKey,items,total,empty};
 }).filter(section=>section.items.length||section.empty||section.total);
}
function coverageLines(briefing,topics){return(Array.isArray(briefing.coverage)?briefing.coverage:[]).filter(line=>typeof line==='string').filter(line=>{
 const topic=/^(Jobs?|Job selection|Job alert)/i.test(line)?'jobs':/^News/i.test(line)?'news':/^(Campus|Partiful|Luma|Email)/i.test(line)?'events':/^(Schedule|Academic dates|Product Studio)/i.test(line)?'school':null;
 return topic?topics.has(topic):topics.size>0;
}).slice(0,16).map(line=>single(line,240));}
function summaryLine(briefing,topics){const c=briefing.counts||{},pieces=[];if(topics.has('school')){pieces.push(`${count(c.classes)} ${count(c.classes)===1?'class':'classes'}`);pieces.push(`${count(c.deadlines)} due today`);}if(topics.has('events'))pieces.push(`${count(c.events)} ${count(c.events)===1?'event':'events'}`);if(topics.has('jobs')){const fresh=count(c.newJobs);pieces.push(fresh?`${fresh} new ${fresh===1?'role':'roles'}`:`${count(c.jobs)} ${count(c.jobs)===1?'role':'roles'} this week`);}return pieces.join(' · ');}

/** Deterministic email presentation: no new inference, tracking assets or sends. */
export function renderDailyEmail(briefing,{name='',appOrigin='https://app.bigredbuddy.com'}={}){
 if(!briefing||typeof briefing!=='object')throw new TypeError('A briefing is required.');
 const base=origin(appOrigin),date=formatDate(briefing.date),topics=new Set((Array.isArray(briefing.notificationTopics)?briefing.notificationTopics:[]).filter(topic=>['school','events','jobs','news'].includes(topic)));
 const first=single(name,80).split(' ')[0],greeting=first?`Good morning, ${first}.`:'Good morning.',subject=`Your BRB morning briefing · ${briefing.date}`;
 const summary=summaryLine(briefing,topics),sections=contentSections(briefing,topics),coverage=coverageLines(briefing,topics),headline=topics.size?single(briefing.headline,320):'',intro=topics.size?headline||'Here’s what’s on your radar today.':'Choose which topics you want in your morning briefing in BRB.';
 const sectionHTML=sections.map(section=>`<tr><td class="content-padding" style="padding:24px 32px 8px;"><h2 style="margin:0 0 3px;font:700 19px/1.4 ${FONT};color:${COLOR.ink};"><a href="${base}/#${section.page}" title="${escape(section.label)}" style="color:${COLOR.ink};text-decoration:none;">${escape(section.title)} <span style="color:${COLOR.red};font-weight:400;">→</span></a></h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;table-layout:fixed;">${section.items.map(item=>itemHTML(item,section.key)).join('')}</table>${!section.items.length&&section.empty?`<p style="margin:12px 0;font:14px/1.6 ${FONT};color:${COLOR.muted};">${escape(section.empty)}</p>`:''}${section.total>section.items.length?`<p style="margin:12px 0;font:14px/1.6 ${FONT};color:${COLOR.muted};">${section.total-section.items.length} more in BRB.</p>`:''}</td></tr>`).join('');
 const text=[`BIG RED BUDDY\n${date} · New York`,greeting,intro,summary,...sections.map(section=>[section.title,...section.items,section.items.length?'':section.empty,section.total>section.items.length?`${section.total-section.items.length} more in BRB.`:'',`${section.label}: ${base}/#${section.page}`].filter(Boolean).join('\n\n')),`Open your day: ${base}/#overview`,coverage.length?`Source notes\n${coverage.join('\n')}`:'', 'This briefing reflects imported sources. Check the original source for changes. Calendar entries do not register you for events; application drafts do not submit to employers.',`Manage delivery and topics: ${base}/#connections`,'Big Red Buddy · An independent Cornell Tech student project.'].filter(Boolean).join('\n\n');
 const html=`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(subject)}</title><style>@media only screen and (max-width:480px){.outer-padding{padding:12px 8px!important}.content-padding{padding-left:20px!important;padding-right:20px!important}.email-title{font-size:30px!important}}a:focus{outline:2px solid ${COLOR.red};outline-offset:3px}</style></head>
<body style="margin:0;padding:0;width:100%;background:${COLOR.paper};color:${COLOR.ink};font-family:${FONT};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escape(headline||summary||'Your selected daily updates from Big Red Buddy.')}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;background:${COLOR.paper};"><tr><td class="outer-padding" align="center" style="padding:28px 12px;">
<table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:640px;border-collapse:separate;border-spacing:0;background:${COLOR.white};border:1px solid ${COLOR.line};border-radius:12px;overflow:hidden;table-layout:fixed;">
<tr><td class="content-padding" style="padding:26px 32px 24px;border-top:6px solid ${COLOR.red};"><p style="margin:0 0 24px;font:700 14px/1.5 ${FONT};letter-spacing:1px;color:${COLOR.red};">BIG RED BUDDY</p><p style="margin:0 0 10px;font:13px/1.6 ${FONT};color:${COLOR.muted};">${escape(date)} · New York</p><h1 class="email-title" style="margin:0;font:400 36px/1.2 Georgia,'Times New Roman',serif;color:${COLOR.ink};">${escape(greeting)}</h1>${headline?`<p style="margin:20px 0 0;padding:12px 14px;border-left:3px solid ${COLOR.red};background:${COLOR.soft};font:700 16px/1.6 ${FONT};color:${COLOR.ink};">${escape(headline)}</p>`:`<p style="margin:14px 0 0;font:16px/1.65 ${FONT};color:${COLOR.muted};">${escape(intro)}</p>`}${summary?`<p style="margin:10px 0 0;font:13px/1.6 ${FONT};color:${COLOR.muted};">${escape(summary)}</p>`:''}</td></tr>
${sectionHTML||`<tr><td class="content-padding" style="padding:8px 32px 24px;font:15px/1.65 ${FONT};color:${COLOR.muted};">${topics.size?'No selected updates are available from your imported sources. Open BRB to check your connections.':'Your topics stay under your control. Pick school, events, jobs, or news to shape your next briefing.'}</td></tr>`}
<tr><td class="content-padding" style="padding:28px 32px 32px;"><a href="${base}/#overview" style="display:inline-block;background:${COLOR.red};border:1px solid ${COLOR.red};border-radius:7px;padding:14px 22px;color:${COLOR.white};font:700 15px/1.4 ${FONT};text-decoration:none;">Open your day in BRB →</a></td></tr>
<tr><td class="content-padding" style="padding:24px 32px;background:${COLOR.paper};border-top:1px solid ${COLOR.line};font:12px/1.7 ${FONT};color:${COLOR.muted};">${coverage.length?`<h2 style="margin:0 0 8px;font:700 13px/1.5 ${FONT};color:${COLOR.ink};">Source notes</h2><ul style="margin:0 0 14px;padding-left:18px;">${coverage.map(line=>`<li style="margin:0 0 5px;">${escape(line)}</li>`).join('')}</ul>`:''}<p style="margin:0 0 12px;">This briefing reflects imported sources. Check originals for changes. Calendar entries do not register you for events; application drafts do not submit to employers.</p><p style="margin:0;"><a href="${base}/#connections" style="color:${COLOR.red};text-decoration:underline;font-weight:700;">Manage delivery & topics</a><br>Big Red Buddy · An independent Cornell Tech student project.</p></td></tr>
</table></td></tr></table></body></html>`;
 // Keep messages well below Gmail's clipping threshold, even for hostile input.
 if(Buffer.byteLength(html,'utf8')>95000||Buffer.byteLength(text,'utf8')>60000)throw new RangeError('The briefing email is too large to render safely.');
 return{subject,html,text};
}
