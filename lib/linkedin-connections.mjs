import {createHash,randomUUID} from 'node:crypto';
import {idFor} from './domain.mjs';
import {HttpError} from './security.mjs';

export const LINKEDIN_CONNECTION_LIMITS=Object.freeze({bytes:8*1024*1024,recordBytes:16*1024*1024,contacts:30000,preambleRows:100,columns:64,fieldCharacters:16384,matches:20});
// Keep weekly settings readable for students who selected them before the new options.
export const LINKEDIN_REFRESH_DAYS=Object.freeze([7,14,30,90]);
const BUCKET='career',KEY='linkedinConnections',DAY=86400000;
const SOURCE='student-uploaded-linkedin-export';
const NOTICE='Potential warm leads from your uploaded LinkedIn connections export, not verified current employment or relationship strength. Upload age is not the export date. No LinkedIn login, scraping, live verification, messages, or model processing is used.';
const HEADERS=['first name','last name','url','company','position','connected on'];
const EMAIL=/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const hash=value=>createHash('sha256').update(value).digest('hex');
const clean=(value,max)=>String(value||'').replace(EMAIL,'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const fail=message=>new HttpError(400,message);
function requireStore(store){if(!store?.userId||typeof store.get!=='function'||typeof store.compareAndSet!=='function')throw new Error('LinkedIn imports require a student-owned atomic store.');}
function time(now=Date.now){const at=typeof now==='function'?now():now;if(!Number.isFinite(at)||Math.abs(at)>8640000000000000)throw fail('Use a valid import time.');return at;}
function expected(previous,value){if(value!==undefined&&value!==(previous?.version||null))throw new HttpError(409,'Connections changed. Refresh before replacing the export.');}
function requestKey(value){if(value===undefined)return null;if(typeof value!=='string'||!/^[A-Za-z0-9:_.-]{1,160}$/.test(value))throw fail('Use a valid import request identifier.');return hash(value);}
function empty(now){return {id:KEY,schemaVersion:1,version:randomUUID(),sourceVersion:randomUUID(),source:SOURCE,contacts:[],count:0,importedAt:null,refreshDays:null,contentHash:null,requests:[],warnings:[],updatedAt:new Date(now).toISOString()};}

/** Strict bounded RFC-4180-style parsing. Rows are consumed, not retained. */
function* csvRows(csv){
 let row=[],field='',quoted=false,closed=false,rowNumber=1;
 const push=()=>{row.push(field);field='';closed=false;if(row.length>LINKEDIN_CONNECTION_LIMITS.columns)throw fail(`CSV row ${rowNumber} exceeds the supported column limit.`);};
 for(let i=0;i<csv.length;i++){
  const char=csv[i];
  if(quoted){if(char==='"'){if(csv[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=char;}
  else if(char===','){push();}
  else if(char==='\r'||char==='\n'){if(char==='\r'&&csv[i+1]==='\n')i++;push();yield {row,number:rowNumber++};row=[];}
  else if(char==='"'){if(field||closed)throw fail(`CSV row ${rowNumber} contains an invalid quote. Export a UTF-8 CSV again.`);quoted=true;}
  else if(closed){if(!/[ \t]/.test(char))throw fail(`CSV row ${rowNumber} has unexpected text after a quoted field.`);}
  else field+=char;
  if(field.length>LINKEDIN_CONNECTION_LIMITS.fieldCharacters)throw fail(`CSV row ${rowNumber} exceeds the supported field length.`);
 }
 if(quoted)throw fail('The CSV contains an unfinished quoted field. Export the CSV again.');
 if(field||closed||row.length){push();yield {row,number:rowNumber};}
}
export function linkedInProfileURL(value){
 if(typeof value!=='string'||value.length>2048)return '';
 try{const url=new URL(value.trim());if(url.protocol!=='https:'||url.username||url.password||url.port||!['linkedin.com','www.linkedin.com'].includes(url.hostname))return '';const match=url.pathname.match(/^\/in\/([^/]+)\/?$/);if(!match)return '';const slug=decodeURIComponent(match[1]);if(slug.length>200||!slug||! /^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(slug))return '';return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;}catch{return '';}
}
export function normalizeConnectionCompany(value){
 let company=clean(value,240).normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g,' ').trim();
 // Legal suffix removal only. Do not match parent/subsidiary, division names,
 // acronyms, arbitrary punctuation, or substrings such as Apple/Apple Bank.
 for(let n=0;n<5;n++){const next=company.replace(/[\s,]+(?:inc\.?|incorporated|l\.?l\.?c\.?|ltd\.?|limited|corp\.?|corporation|p\.?l\.?c\.?)\.?$/i,'').replace(/[,\s]+$/,'').trim();if(next===company)break;company=next;}
 return company;
}
function connectionDate(value){
 const raw=String(value||'').trim();if(!raw)return null;let year,month,day,match;
 if((match=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/))){[,year,month,day]=match;}
 else if((match=raw.match(/^(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{4})$/i))){day=match[1];month=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match[2].slice(0,3).toLowerCase())+1;year=match[3];}
 else return null;
 year=Number(year);month=Number(month);day=Number(day);if(year<1900||year>2100||month<1||month>12||day<1||day>31)return null;const parsed=new Date(Date.UTC(year,month-1,day));return parsed.getUTCFullYear()===year&&parsed.getUTCMonth()===month-1&&parsed.getUTCDate()===day?parsed.toISOString().slice(0,10):null;
}
function parseConnections(csv){
 let header=null,preamble=0,dataRows=0,skipped=0,invalidLinks=0,invalidDates=0,duplicates=0,conflicts=0;const contacts=new Map();
 for(const {row,number} of csvRows(csv.replace(/^\uFEFF/,''))){
  if(row.every(cell=>!cell.trim()))continue;
  if(!header){const labels=row.map(cell=>cell.trim().replace(/^\uFEFF/,'').toLowerCase());if(HEADERS.every(label=>labels.includes(label))){if(HEADERS.some(label=>labels.filter(value=>value===label).length!==1))throw fail('The CSV repeats a required column. Export a fresh LinkedIn connections CSV.');header=Object.fromEntries(HEADERS.map(label=>[label,labels.indexOf(label)]));}
   else if(++preamble>LINKEDIN_CONNECTION_LIMITS.preambleRows)throw fail('LinkedIn connections headers were not found in the supported preamble.');continue;}
  if(++dataRows>LINKEDIN_CONNECTION_LIMITS.contacts)throw fail('Import at most 30,000 connection rows per CSV. The previous import was kept.');
  if(Math.max(...Object.values(header))>=row.length)throw fail(`CSV row ${number} is missing required columns. The previous import was kept.`);
  const name=clean(`${clean(row[header['first name']],80)} ${clean(row[header['last name']],80)}`,160);if(!name){skipped++;continue;}
  const company=clean(row[header.company],240),title=clean(row[header.position],240),url=linkedInProfileURL(row[header.url]),connectedOn=connectionDate(row[header['connected on']]);
  if(row[header.url].trim()&&!url)invalidLinks++;if(row[header['connected on']].trim()&&!connectedOn)invalidDates++;
  const key=url?`url:${url.toLowerCase()}`:`text:${name.toLocaleLowerCase('en-US')}\0${normalizeConnectionCompany(company)}\0${title.toLocaleLowerCase('en-US')}`,id=idFor('linkedin-contact',key),existing=contacts.get(key);
  if(existing){duplicates++;if(existing.company&&company&&normalizeConnectionCompany(existing.company)!==normalizeConnectionCompany(company)){existing.company='';existing.title='';existing.companyConflict=true;conflicts++;}else if(!existing.company&&!existing.companyConflict&&company){existing.company=company;existing.title=title;}continue;}
  contacts.set(key,{id,name,company,title,url,connectedOn});
 }
 if(!header)throw fail('Use a LinkedIn connections CSV with First Name, Last Name, URL, Company, Position, and Connected On columns.');
 const rows=[...contacts.values()].map(({companyConflict,...row})=>row).sort((a,b)=>a.id.localeCompare(b.id));
 const warnings=[];if(skipped)warnings.push(`${skipped} row(s) without a usable name were skipped.`);if(invalidLinks)warnings.push(`${invalidLinks} unsupported profile link(s) were omitted.`);if(invalidDates)warnings.push(`${invalidDates} unrecognized connection date(s) were omitted.`);if(duplicates)warnings.push(`${duplicates} duplicate connection row(s) were merged.`);if(conflicts)warnings.push(`${conflicts} duplicate profile(s) had conflicting companies; their company/title were cleared to avoid false matches.`);
 return {contacts:rows,warnings,contentHash:hash(JSON.stringify(rows)),dataRows};
}
function metadata(record,now){
 const importedAt=typeof record?.importedAt==='string'?record.importedAt:null,at=Date.parse(importedAt),connected=Number.isFinite(at)&&Array.isArray(record?.contacts),refreshDays=LINKEDIN_REFRESH_DAYS.includes(record?.refreshDays)?record.refreshDays:null,nextRefreshAt=connected&&refreshDays?new Date(at+refreshDays*DAY).toISOString():null,refreshDue=!!nextRefreshAt&&now>=Date.parse(nextRefreshAt),stale=connected&&(now<at||now-at>=30*DAY||refreshDue);
 return {connected,count:connected?record.contacts.length:0,version:record?.version||null,sourceVersion:record?.sourceVersion||null,importedAt:connected?importedAt:null,refreshDays,nextRefreshAt,refreshDue,stale,warnings:[...(record?.warnings||[]),...(connected&&now<at?['The recorded upload time is in the future; check the host clock.']:[])],error:null,source:SOURCE,notice:NOTICE};
}
export async function readLinkedInConnections(store,{now=Date.now}={}){requireStore(store);return metadata(await store.get(BUCKET,KEY),time(now));}
export async function importLinkedInConnections(store,input,{now=Date.now,expectedVersion,requestId}={}){
 requireStore(store);const at=time(now),key=requestKey(requestId);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(field=>!['csv','name'].includes(field))||typeof input.csv!=='string'||!input.csv.trim()||Buffer.byteLength(input.csv,'utf8')>LINKEDIN_CONNECTION_LIMITS.bytes||input.csv.includes('\0')||input.name!==undefined&&(typeof input.name!=='string'||input.name.length>255))throw fail('Upload a UTF-8 LinkedIn connections CSV no larger than 8 MB.');
 const previous=await store.get(BUCKET,KEY);
 // A deletion retains only request hashes, so a delayed replay cannot restore
 // deleted contacts. It never retains raw CSV, emails, filenames, or old people.
 if(key&&previous?.requests?.some(request=>request.key===key))return {...metadata(previous,at),replayed:true,reused:true};
 expected(previous,expectedVersion);
 const parsed=parseConnections(input.csv),sameContent=previous?.contentHash===parsed.contentHash,base=previous||empty(at),next={...base,version:randomUUID(),sourceVersion:randomUUID(),contacts:parsed.contacts,count:parsed.contacts.length,contentHash:parsed.contentHash,importedAt:new Date(at).toISOString(),updatedAt:new Date(at).toISOString(),deletedAt:null,warnings:parsed.warnings,requests:[...(base.requests||[]),...(key?[{key}]:[])].slice(-64)};
 if(Buffer.byteLength(JSON.stringify(next))>LINKEDIN_CONNECTION_LIMITS.recordBytes)throw fail('The normalized export exceeds the private storage limit. Use a smaller connections export; the previous import was kept.');
 if(!await store.compareAndSet(BUCKET,KEY,previous,next))throw new HttpError(409,'Connections changed during import. Refresh and retry; no partial import was saved.');
 return {...metadata(next,at),reused:sameContent,replayed:false};
}
export async function deleteLinkedInConnections(store,{now=Date.now,expectedVersion}={}){
 requireStore(store);const at=time(now);
 for(let attempt=0;attempt<10;attempt++){const previous=await store.get(BUCKET,KEY);expected(previous,expectedVersion);if(previous?.deletedAt&&!previous.contacts?.length&&previous.refreshDays===null)return metadata(previous,at);const next={...empty(at),requests:(previous?.requests||[]).map(request=>({key:request.key})).slice(-64),deletedAt:new Date(at).toISOString()};if(await store.compareAndSet(BUCKET,KEY,previous,next))return metadata(next,at);if(expectedVersion!==undefined)throw new HttpError(409,'Connections changed. Refresh before deleting.');}
 throw new HttpError(409,'Connections changed concurrently. Retry deletion.');
}
export async function saveLinkedInConnectionSettings(store,input,{now=Date.now}={}){
 requireStore(store);const at=time(now);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'refreshDays')||input.refreshDays!==null&&!LINKEDIN_REFRESH_DAYS.includes(input.refreshDays))throw fail('Choose a refresh reminder of 14, 30, or 90 days, or off. Existing 7-day reminders are also supported.');
 for(let attempt=0;attempt<10;attempt++){const previous=await store.get(BUCKET,KEY),base=previous||empty(at),next={...base,refreshDays:input.refreshDays,version:randomUUID(),updatedAt:new Date(at).toISOString()};if(await store.compareAndSet(BUCKET,KEY,previous,next))return metadata(next,at);}
 throw new HttpError(409,'Connections settings changed concurrently. Refresh and retry.');
}
export async function matchLinkedInConnections(store,company,{now=Date.now}={}){
 requireStore(store);if(typeof company!=='string'||company.length>240)throw fail('Choose a company name of at most 240 characters.');const record=await store.get(BUCKET,KEY),meta=metadata(record,time(now)),normalized=normalizeConnectionCompany(company),matches=meta.connected&&normalized?record.contacts.filter(contact=>contact.company&&normalizeConnectionCompany(contact.company)===normalized).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)):[];
 return {company:clean(company,240),totalMatches:matches.length,matches:matches.slice(0,LINKEDIN_CONNECTION_LIMITS.matches).map(contact=>({...contact})),truncated:matches.length>LINKEDIN_CONNECTION_LIMITS.matches,importedAt:meta.importedAt,version:meta.version,sourceVersion:meta.sourceVersion,stale:meta.stale,notice:NOTICE};
}
