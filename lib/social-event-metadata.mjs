import {lumaRSVP,partifulRSVP} from './event-provider-links.mjs';
import {calendarLocation} from './calendar-description.mjs';

const MAX_BYTES=1_000_000,MAX_JSON_BYTES=256_000,TZ='America/New_York';
const WARNING='Public event details could not be verified. Review the invitation and registration page before adding it.';
const clean=(value,limit=300)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,limit):'';
const failure=(warning=WARNING)=>({event:null,verified:false,warnings:[warning]});

/** Accept a single public event URL, not arbitrary text containing an allowed URL. */
export function socialEventURL(value){
 if(typeof value!=='string'||value.length>2048||value!==value.trim())return '';
 try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port||/[\s\\]/.test(value))return '';return lumaRSVP(url.href)||partifulRSVP(url.href);}catch{return '';}
}
function identity(value){const canonical=socialEventURL(value);if(!canonical)return '';const url=new URL(canonical);return `${url.hostname==='lu.ma'?'luma.com':url.hostname}${url.pathname}`;}
function provider(value){return new URL(value).hostname==='partiful.com'?'partiful':'luma';}
function dateOnly(value){return typeof value==='string'&&/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value?value:null;}
function timestamp(value){
 if(typeof value!=='string')return null;
 const match=/^([1-9]\d{3}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
 if(!match||!dateOnly(match[1])||+match[2]>23||+match[3]>59||+(match[4]||0)>59)return null;
 if(match[6]!=='Z'){const hour=+match[6].slice(1,3),minute=+match[6].slice(4);if(hour>14||minute>59||hour===14&&minute!==0||match[6]==='-00:00')return null;}
 const instant=Date.parse(value);return Number.isFinite(instant)?new Date(instant).toISOString():null;
}
function localParts(instant){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));return {date:`${parts.year}-${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`};}
function locationText(value){
 if(typeof value==='string')return meaningfulLocation(clean(value));
 if(!value||Array.isArray(value)||typeof value!=='object')return '';
 const address=typeof value.address==='string'?clean(value.address):value.address&&typeof value.address==='object'?['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'].map(key=>clean(value.address[key],100)).filter(Boolean).join(', '):'';
 return meaningfulLocation(calendarLocation([...new Set([clean(value.name,150),address].filter(Boolean))].join(' · ')).slice(0,300));
}
function meaningfulLocation(value){return /^(?:tbd|tba|unknown|undisclosed|private(?: location)?|location (?:tbd|tba)|to be (?:announced|determined)|sign in to (?:see|view) (?:the )?location|register to (?:see|view) (?:the )?location)$/i.test(value)?'':value;}
function evidenceLocation(value){
 if(typeof value==='string')return value.slice(0,300);
 if(!value||Array.isArray(value)||typeof value!=='object')return null;
 const address=typeof value.address==='string'?value.address.slice(0,300):value.address&&typeof value.address==='object'?Object.fromEntries(['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'].filter(key=>typeof value.address[key]==='string').map(key=>[key,value.address[key].slice(0,100)])):null;
 return {name:typeof value.name==='string'?value.name.slice(0,150):null,address};
}
function statusName(value){return typeof value==='string'?value.replace(/^https?:\/\/schema\.org\//,''):'';}
function canonicalDeclarations(html){const links=[];for(const match of html.matchAll(/<link\b([^>]{0,5000})>/gi)){const attributes=match[1],rel=attribute(attributes,'rel');if(rel?.toLowerCase().split(/\s+/).includes('canonical')){const url=attribute(attributes,'href');if(url)links.push(url);}}return links;}
function attribute(attributes,name){const match=attributes.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,'i'));return match?match[1]??match[2]??match[3]:null;}
function eventsInJSON(value){
 const events=[],stack=[{value,depth:0}];let count=0;
 while(stack.length){const {value:node,depth}=stack.pop();if(++count>2000||depth>12)throw new Error('bounded JSON traversal');if(!node||typeof node!=='object')continue;if(Array.isArray(node)){for(const child of node)stack.push({value:child,depth:depth+1});continue;}
  const types=Array.isArray(node['@type'])?node['@type']:[node['@type']];if(types.some(type=>['Event','https://schema.org/Event','http://schema.org/Event'].includes(type)))events.push(node);
  // Only schema containers can contribute event records; descriptions and links are data.
  for(const key of ['@graph','mainEntity','itemListElement','item'])if(node[key]&&typeof node[key]==='object')stack.push({value:node[key],depth:depth+1});
 }
 return events;
}

/** No model or external requests: a uniquely URL-attributed JSON-LD Event only. */
export function parseSocialEventHTML(html,url){
 const canonical=socialEventURL(url);if(!canonical||typeof html!=='string'||Buffer.byteLength(html)>MAX_BYTES)return failure();
 const expected=identity(canonical),declarations=canonicalDeclarations(html);
 if(declarations.some(link=>identity(link)!==expected))return failure('The public page identifies a different event. Review its registration link.');
 const candidates=[];let scripts=0,malformed=false;
 try{
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)){
   if((attribute(match[1],'type')||'').toLowerCase()!=='application/ld+json')continue;
   if(++scripts>16||Buffer.byteLength(match[2])>MAX_JSON_BYTES)return failure();
   let data;try{data=JSON.parse(match[2]);}catch{malformed=true;continue;}
   for(const item of eventsInJSON(data)){
    const declared=[item.url,item['@id']].filter(value=>typeof value==='string');
    if(declared.some(value=>identity(value)===expected)){
     if(declared.some(value=>socialEventURL(value)&&identity(value)!==expected))return failure('The public event contains conflicting registration links. Review the invitation.');
     candidates.push(item);
    }
   }
  }
 }catch{return failure();}
 if(malformed||candidates.length!==1)return failure(candidates.length>1?'The page contains multiple matching event records. Review its date and time.':WARNING);
 const record=candidates[0],title=clean(record.name,240),start=timestamp(record.startDate),end=timestamp(record.endDate),location=locationText(record.location),status=statusName(record.eventStatus),warnings=[];
 if(!title)return failure();
 if(!start){return failure('The public page does not supply a complete event time with a timezone. Review the invitation.');}
 const {date,time}=localParts(start),validEnd=!!end&&Date.parse(end)>Date.parse(start)&&Date.parse(end)-Date.parse(start)<=31*86400000;
 if(!validEnd)warnings.push('The public page does not supply a valid end time. Confirm the duration before adding it.');
 if(!location)warnings.push('The public page does not publish a location. Check the invitation or registration page.');
 if(status!=='EventScheduled')warnings.push(status==='EventCancelled'?'The organizer marks this event as cancelled.':status==='EventPostponed'?'The organizer marks this event as postponed.':status==='EventRescheduled'?'The organizer marks this event as rescheduled. Review the new date.':'The public page does not confirm a scheduled event status.');
 const verified=validEnd&&!!location&&status==='EventScheduled';
 // Keep only the fields that support this calendar candidate, never the full document.
 const evidence=JSON.stringify({'@type':'Event',url:canonical,name:record.name.slice(0,240),startDate:record.startDate,endDate:typeof record.endDate==='string'?record.endDate.slice(0,60):null,eventStatus:typeof record.eventStatus==='string'?record.eventStatus.slice(0,100):null,location:evidenceLocation(record.location)});
 return {event:{title,kind:'event',date,time,start,end:validEnd?end:null,allDay:false,timezone:TZ,location,rsvpUrl:canonical,sourceUrl:canonical,evidence,status:'review',evidenceVerified:verified,sourceProvider:provider(canonical),sourceStatus:status||null,cancelled:status==='EventCancelled',warning:warnings.join(' ')},verified,warnings};
}

async function readHTML(response){
 if(!response.ok||response.status!==200||!/^text\/html(?:\s*;|$)|^application\/xhtml\+xml(?:\s*;|$)/i.test(response.headers.get('content-type')||''))throw new Error('not public HTML');
 if(Number(response.headers.get('content-length'))>MAX_BYTES)throw new Error('oversized HTML');
 let html='',bytes=0;const reader=response.body?.getReader();
 if(reader){const decoder=new TextDecoder();try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES){await reader.cancel();throw new Error('oversized HTML');}html+=decoder.decode(value,{stream:true});}html+=decoder.decode();}finally{reader.releaseLock();}}
 else{html=await response.text();if(Buffer.byteLength(html)>MAX_BYTES)throw new Error('oversized HTML');}
 return html;
}

export async function lookupSocialEvent(value,{fetchImpl=globalThis.fetch,now=Date.now}={}){
 const canonical=socialEventURL(value);if(!canonical)return failure('Use a direct public Luma or Partiful event link.');
 // The clock is injectable for callers; past-event eligibility belongs to their consent policy.
 void now;
 let url=canonical;const seen=new Set();
 try{
  for(let redirects=0;redirects<=2;redirects++){
   if(seen.has(url))return failure();seen.add(url);
   const response=await fetchImpl(url,{method:'GET',redirect:'manual',credentials:'omit',headers:{Accept:'text/html'},signal:AbortSignal.timeout(15000)});
   if([301,302,303,307,308].includes(response.status)){
    const location=response.headers.get('location');await response.body?.cancel?.();if(!location||redirects===2)return failure();
    const next=socialEventURL(new URL(location,url).href);
    // Only the same event's lu.ma/luma.com alias can redirect; no login or tracking endpoints.
    if(!next||identity(next)!==identity(canonical))return failure();url=next;continue;
   }
   if(response.url&&socialEventURL(response.url)!==url)return failure();
   return parseSocialEventHTML(await readHTML(response),canonical);
  }
 }catch{return failure();}
 return failure();
}
