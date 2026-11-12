import {randomBytes} from 'node:crypto';
import {isIP} from 'node:net';
import {idFor} from './domain.mjs';
import {readNotificationPreferences,notificationAllowed} from './notification-preferences.mjs';
import {readCareerExperience,jobExperienceFit} from './career-experience.mjs';
import {readJobDiscoverySettings} from './job-preferences.mjs';
import {listJobSources} from './job-source-catalog.mjs';
import {normalizePublishedAt,jobPublication,recentJobGroups} from './job-recency.mjs';
import {sourceJobDisplayFacts} from './job-display.mjs';

export const JOB_DISCOVERY_LIMITS=Object.freeze({refreshMs:6*3600000,responseBytes:12*1024*1024,rows:1000,matchesPerBoard:250,storedJobs:1800,boards:20,alertMatches:10});
const HOUR=3600000,DAY=24*HOUR;
const sensitive=/\b(?:veterans?|disabilit\w*|disabled|gender|ethnic\w*|religio\w*|marital|birthdate|citizenship|nationality|sponsorship|visa|sexual orientation|pregnan\w*|race|racial|social security)\b/i;
const skills=['Python','SQL','JavaScript','TypeScript','Java','C++','C#','Go','Rust','R','React','Node.js','AWS','Azure','GCP','Docker','Kubernetes','PostgreSQL','MongoDB','Redis','Tableau','Power BI','Excel','Figma','TensorFlow','PyTorch','machine learning','deep learning','natural language processing','LLM','data analysis','data science','data engineering','A/B testing','experimentation','user research','customer research','product management','product strategy','product roadmap','product discovery','project management','stakeholder management','agile','scrum','UX','UI','API','REST','GraphQL','distributed systems','sales','business development','financial modeling','marketing','operations','supply chain','cybersecurity'];
const normalize=value=>String(value||'').toLowerCase().replace(/\bnyc\b|\bnew york city\b/g,'new york').replace(/\bsf\b/g,'san francisco').replace(/\bpm\b/g,'product manager').replace(/\bml\b/g,'machine learning').replace(/\bai\b/g,'artificial intelligence').replace(/[^a-z0-9+#]+/g,' ').trim();
const short=(value,max=200)=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const resumeText=text=>String(text||'').slice(0,60000).split(/\r?\n/).filter(line=>!sensitive.test(line)).join('\n');
const hasPhrase=(text,phrase)=>` ${normalize(text)} `.includes(` ${normalize(phrase)} `);
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const safeURL=value=>{try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.href.length>2048||['localhost','localhost.localdomain'].includes(u.hostname)||isIP(u.hostname.replace(/^\[|\]$/g,'')))return '';return u.href;}catch{return '';}};
function plain(value){return String(value||'').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/<[^>]*>/g,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&#39;/g,"'").replace(/&[^;\s]{1,12};/g,' ').replace(/\s+/g,' ').trim().slice(0,24000);}

async function matchingInputs(store,{now=Date.now()}={}){
  const [profile,resume,experience,preferences]=await Promise.all([store.get('settings','profile'),store.get('documents','resume'),readCareerExperience(store,{now:()=>now}),readJobDiscoverySettings(store)]);
  const text=resumeText(resume?.text);
  return {titles:String(profile?.jobTitles||'').slice(0,500),location:String(profile?.jobLocation||'').slice(0,500),resume:text,resumeVersion:idFor(resume?.text||'',resume?.updatedAt||''),experience,stretchYears:preferences.stretchYears,resumeStrengths:resumeStretchSignals(text)};
}
const fingerprint=input=>idFor('job-matching-v2',input.titles,input.location,input.resumeVersion,input.stretchYears,input.experience?.sourceHash,input.experience?.analyzed,input.experience?.status,input.experience?.stale,input.experience?.totalMonths,input.experience?.asOfMonth,JSON.stringify((input.experience?.roles||[]).map(role=>[role.id,role.employmentType,role.startMonth,role.endMonth,role.provenance])));
export async function jobMatchingFingerprint(store,options){return fingerprint(await matchingInputs(store,options));}
export function resumeStretchSignals(resume){
 const lines=resumeText(resume).split(/\r?\n/).map(line=>short(line,400)).filter(Boolean),signals=[];
 for(const [kind,label,pattern] of [['impact','Reported measurable result',/\b(?:increased|reduced|grew|saved|improved|delivered|generated|launched)\b.{0,150}\d/i],['promotion','Explicit promotion',/\bpromot(?:ed|ion)\b/i],['leadership','Reported leadership experience',/\b(?:led|managed|mentored|supervised|directed)\b/i]]){const evidence=lines.find(line=>pattern.test(line));if(evidence)signals.push({kind,label,evidence});}
 return signals;
}

/** Re-score private saved postings after explicit preference/experience changes. No provider calls. */
export async function refreshStoredJobMatches(store,{pass=0}={}){
 const input=await matchingInputs(store),matchingFingerprint=fingerprint(input),resumeSkills=skills.filter(skill=>hasPhrase(input.resume,skill));let updated=0;
 for(const old of (await store.all('jobs')).slice(0,JOB_DISCOVERY_LIMITS.storedJobs)){
  if(old.closed||['closed','removed','cancelled'].includes(old.status))continue;
  const match=scoreJobRelevance(old,{...input,resumeSkills}),next={...old,...match,matchingFingerprint,resumeVersion:input.resumeVersion,status:match.eligible?(old.status==='not-matching'?'discovered':old.status):old.status==='discovered'?'not-matching':old.status};
  if(store.compareAndSet){if(await store.compareAndSet('jobs',old.id,old,next))updated++;}else{await store.put('jobs',old.id,next);updated++;}
 }
 if(pass<2&&matchingFingerprint!==await jobMatchingFingerprint(store))return refreshStoredJobMatches(store,{pass:pass+1});
 return {updated};
}

/** A bounded discovery heuristic, not a probability or qualification assessment. */
export function scoreJobRelevance(job,{titles='',location='',resume='',resumeSkills,experience,stretchYears=3,resumeStrengths}={}){
  const targetTitles=String(titles).split(/[,;\n]/).map(normalize).filter(Boolean).slice(0,15),title=normalize(job.title);
  const stop=new Set(['senior','junior','lead','staff','principal','the','of','and','a','an','intern','internship']);
  let titleMatch=null,titleOverlap=0;
  for(const target of targetTitles){const terms=target.split(' ').filter(word=>!stop.has(word));if(!terms.length)continue;const overlap=terms.filter(word=>` ${title} `.includes(` ${word} `)).length/terms.length;if(overlap>titleOverlap){titleOverlap=overlap;titleMatch=target;}}
  const ownSkills=resumeSkills||skills.filter(skill=>hasPhrase(resumeText(resume),skill));
  const matchingSkills=ownSkills.filter(skill=>hasPhrase(`${job.title}\n${job.description}`,skill)).slice(0,8);
  const prefs=String(location).split(/[,;|]/).map(normalize).filter(part=>part&&part!=='anywhere'&&part!=='any').slice(0,12),jobLocation=normalize(job.location),remote=job.isRemote===true||/\bremote\b/.test(jobLocation);
  let locationFit='not-requested';
  if(prefs.length){
    if(prefs.some(pref=>pref==='remote'&&remote||pref!=='remote'&&hasPhrase(jobLocation,pref)))locationFit='matched';
    else if(!jobLocation||remote)locationFit='unverified';
    else locationFit='mismatch';
  }
  const titleRelevant=targetTitles.length?titleOverlap>=0.6:false;
  const experienceFit=jobExperienceFit(job,experience,{stretchYears}),stretchSignals=[...(resumeStrengths||resumeStretchSignals(resume))];
  if(matchingSkills.length)stretchSignals.push({kind:'skills',label:'Relevant skills named in resume and posting',evidence:matchingSkills.join(', ')});
  const eligible=locationFit!=='mismatch'&&experienceFit.eligible!==false&&(targetTitles.length?titleRelevant:matchingSkills.length>=2);
  const score=eligible?Math.min(95,Math.round((titleRelevant?50+titleOverlap*20:35)+matchingSkills.length*3+(locationFit==='matched'?8:0)+(experienceFit.category==='stretch'?Math.min(6,stretchSignals.length*2):0))):0;
  const reasons=[];
  if(titleRelevant)reasons.push(`Target-title overlap: ${titleMatch}`);
  if(matchingSkills.length)reasons.push(`Resume skill overlap: ${matchingSkills.join(', ')}`);
  if(locationFit==='matched')reasons.push('Listed location matches your preference');
  if(locationFit==='unverified')reasons.push('Location eligibility needs review');
  if(!resume.trim())reasons.push('No resume available; title/location matching only');
  reasons.push(experienceFit.rationale);
  return {eligible,score,match:score,matchBasis:'Deterministic discovery heuristic; not evidence of qualification or a percentage of requirements met',matchReasons:reasons,matchEvidence:{targetTitle:titleRelevant?titleMatch:null,skills:matchingSkills,locationFit},locationFit,experienceFit,stretchSignals};
}

async function boundedJSON(url,fetchImpl){
  const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(25000),headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error(`Job source returned HTTP ${Number(response.status)||'error'}.`);
  if(Number(response.headers?.get('content-length'))>JOB_DISCOVERY_LIMITS.responseBytes)throw new Error('Job source response exceeds the 12 MB limit.');
  let data;
  if(response.body?.getReader){
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>JOB_DISCOVERY_LIMITS.responseBytes)throw new Error('Job source response exceeds the 12 MB limit.');chunks.push(Buffer.from(value));}data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }else{data=await response.json();if(Buffer.byteLength(JSON.stringify(data))>JOB_DISCOVERY_LIMITS.responseBytes)throw new Error('Job source response exceeds the 12 MB limit.');}
  if(!Array.isArray(data?.jobs))throw new Error('Job source returned an invalid jobs list.');
  return data;
}

function sourceRows(data,provider,board,sourceUrl){
  let invalid=0;const rows=[],companyName=listJobSources().sources.find(source=>source.provider===provider&&source.board===board)?.name||board;
  for(const raw of data.jobs.slice(0,JOB_DISCOVERY_LIMITS.rows)){
    if(provider==='ashby'&&raw?.isListed===false)continue;
    if(!raw||typeof raw!=='object'||Array.isArray(raw)){invalid++;continue;}
    const url=safeURL(provider==='ashby'?raw.jobUrl:raw.absolute_url),title=short(raw.title,240);
    if(!url||!title){invalid++;continue;}
    const externalId=short(raw.id??idFor('posting-url',url),160),rawText=JSON.stringify(raw);
    const salary=provider==='ashby'?short(raw.compensation?.scrapeableCompensationSalarySummary||raw.compensation?.compensationTierSummary,200):short((Array.isArray(raw.pay_input_ranges)?raw.pay_input_ranges:[]).filter(r=>r&&Number.isFinite(r.min_cents)&&Number.isFinite(r.max_cents)&&r.min_cents>=0&&r.max_cents>=r.min_cents&&typeof r.currency_type==='string'&&/^[A-Z]{3}$/.test(r.currency_type)).slice(0,10).map(r=>`${r.currency_type} ${r.min_cents/100}–${r.max_cents/100} ${short(r.title,100)}`).join('; '),200);
    const publishedAt=normalizePublishedAt(provider==='ashby'?raw.publishedAt:raw.first_published);
    const display=sourceJobDisplayFacts(provider,raw);
    rows.push({externalId,title,location:short(provider==='ashby'?[raw.location,...(Array.isArray(raw.secondaryLocations)?raw.secondaryLocations:[]).slice(0,5).map(v=>v?.location)].filter(Boolean).join('; '):raw.location?.name,400),description:plain(provider==='ashby'?raw.descriptionPlain||raw.descriptionHtml:raw.content),url,applyUrl:safeURL(raw.applyUrl)||url,company:short(raw.companyName||raw.company_name||companyName,160),...display,isRemote:display.workplaceType==='remote',salary:salary||null,publishedAt,publicationTimeVerified:!!publishedAt,sourceUpdatedAt:date(provider==='ashby'?raw.updatedAt:raw.updated_at),sourceUrl,rawSource:rawText.length<=65536?raw:null,rawSourceTruncated:rawText.length>65536});
  }
  const total=Number(data.meta?.total)||data.jobs.length;
  return {rows,partial:data.jobs.length>JOB_DISCOVERY_LIMITS.rows||total>data.jobs.length||invalid>0,invalid,total};
}

async function updateBoard(store,key,patch){
  for(let n=0;n<10;n++){
    const previous=await store.get('settings','jobBoards'),boards=previous?.boards||[],old=boards.find(b=>b.key===key)||{};
    if(!old.key&&boards.length>=JOB_DISCOVERY_LIMITS.boards)throw new Error('Maximum 20 configured employer boards.');
    const next={...previous,boards:[...boards.filter(b=>b.key!==key),{...old,...patch,key}]};
    if(store.compareAndSet){if(!await store.compareAndSet('settings','jobBoards',previous,next))continue;}else await store.put('settings','jobBoards',next);
    return next.boards.find(b=>b.key===key);
  }
  throw new Error('Employer board settings changed concurrently. Retry later.');
}
async function healthSummary(store){
  const boards=(await store.get('settings','jobBoards'))?.boards||[],successful=boards.filter(b=>b.lastSuccess).sort((a,b)=>b.lastSuccess.localeCompare(a.lastSuccess));
  await store.put('settings','jobsHealth',{lastSuccess:successful[0]?.lastSuccess||null,count:boards.reduce((sum,b)=>sum+(b.matchedCount||0),0),boards,refreshHours:6,freshnessTargetHours:24,coverage:'Configured employer boards only; refresh depends on source and worker availability. No whole-web or 24-hour delivery guarantee.'});
}

function alertEntry(job,index){
  const reason=job.matchEvidence.skills.length?`Resume overlap: ${job.matchEvidence.skills.slice(0,3).join(', ')}`:`Title overlap: ${job.matchEvidence.targetTitle||'review match'}`;
  return `${index}. ${short(job.title,75)} — ${short(job.company,45)}\n${short(job.location||'Location not published',85)}${job.salary?` · ${short(job.salary,75)}`:''}\nPublished: ${normalizePublishedAt(job.publishedAt)}\nHeuristic: ${short(reason,105)}${job.locationFit==='unverified'?'; location needs review':''}\nExperience: ${short(job.experienceFit?.rationale||'Requirements not yet compared',230)}\n${job.url}\n/apply ${job.id}`;
}
async function queueAlerts(store,queue,boardKey,matches,now,matchingFingerprint){
  if(!notificationAllowed(await readNotificationPreferences(store),'jobs','alerts'))return {alertQueued:0,pendingAlerts:0,alerts:'disabled-by-preference'};
  if(matchingFingerprint!==await jobMatchingFingerprint(store,{now}))return {alertQueued:0,pendingAlerts:0,alerts:'matching-changed'};
  if(!queue||!store.userId||!(await store.get('secrets','telegram'))?.chatId||(await store.get('settings','profile'))?.paused)return {alertQueued:0,pendingAlerts:0,alerts:'not-enabled-or-paused'};
  const outboxId=idFor('job-alert-outbox',boardKey);let batch=await store.get('jobAlertOutbox',outboxId);
  async function supersede(reason){
    // An enqueue may have committed before a crash. Suppress that attempted
    // batch's IDs rather than rebuild it under new keys and risk duplicates.
    if(batch.attemptedAt)for(const id of batch.ids||[])if(!await store.get('jobAlerts',id))await store.put('jobAlerts',id,{id,batchId:batch.id,status:'suppressed',reason,at:new Date(now).toISOString()});
    await store.put('jobAlertOutbox',outboxId,{...batch,status:'superseded',reason,updatedAt:new Date(now).toISOString()});
    return null;
  }
  async function deliver(){
    if(batch.attemptedAt&&now-Date.parse(batch.attemptedAt)>6*DAY){await store.put('jobAlertOutbox',outboxId,{...batch,status:'needs_review'});return {alertQueued:0,pendingAlerts:batch.ids.length,alerts:'needs_review'};}
    if(batch.publicationVersion!==1||!Array.isArray(batch.chunks)||!batch.chunks.length||batch.chunks.length>10)return supersede('publication-metadata-missing');
    for(const chunk of batch.chunks){
      if(!Array.isArray(chunk.jobs)||!chunk.jobs.length||chunk.jobs.length>10)return supersede('publication-metadata-missing');
      for(const snapshot of chunk.jobs){const current=await store.get('jobs',snapshot.id),publication=jobPublication(current,{now});
        if(!current||current.closed||current.eligible===false||['closed','cancelled','removed','not-matching','dismissed'].includes(current.status)||current.matchingFingerprint!==batch.matchingFingerprint||!publication.eligible||publication.publishedAt!==snapshot.publishedAt||publication.bucket!==snapshot.bucket)return supersede('publication-or-matching-changed');
      }
    }
    if(!batch.attemptedAt){batch={...batch,attemptedAt:new Date(now).toISOString()};await store.put('jobAlertOutbox',outboxId,batch);}
    for(let i=0;i<batch.chunks.length;i++){
      const chunk=batch.chunks[i];
      const {menuMarkup}=await import('./telegram-menu.mjs');
      const actions=[];for(const item of chunk.jobs.slice(0,4)){const job=await store.get('jobs',item.id),label=short(job?.company||'Job',18);actions.push([[`${label}: Prepare`,{command:`/apply ${item.id}`}],[`${label}: Connections`,{command:`/leads ${item.id}`}]],[[`${label}: Save`,{saveJob:item.id}],[`${label}: Skip`,{skipJob:item.id}]]);}
      actions.push([['All jobs',{page:'jobs'}]]);const replyMarkup=await menuMarkup(store,actions);
      await queue.enqueue(store.userId,'telegram-send',{text:chunk.text,replyMarkup,notification:{channel:'alerts',topic:'jobs',matchingFingerprint:batch.matchingFingerprint,requireCurrentMatching:true,requireCurrentPublication:true,jobs:chunk.jobs}},{idempotencyKey:`job-discovery:${batch.id}:${i}`,ttlMs:7*DAY,retrySafe:false,maxAttempts:1});
      for(const snapshot of chunk.jobs)await store.put('jobAlerts',snapshot.id,{id:snapshot.id,batchId:batch.id,status:'queued',publishedAt:snapshot.publishedAt,queuedAt:new Date(now).toISOString()});
    }
    await store.put('jobAlertOutbox',outboxId,{...batch,status:'queued',queuedAt:new Date(now).toISOString()});
    return {alertQueued:batch.ids.length,pendingAlerts:0,alerts:'queued'};
  }
  if(batch?.status==='needs_review')return {alertQueued:0,pendingAlerts:batch.ids.length,alerts:'needs_review'};
  if(batch?.status==='pending'){
    if(batch.matchingFingerprint!==matchingFingerprint)await supersede('matching-changed');
    else {const recovered=await deliver();if(recovered)return recovered;}
  }
  const groups=recentJobGroups(matches,{now}),unseen=[];
  for(const job of [...groups.last24Hours,...groups.pastWeek])if(!await store.get('jobAlerts',job.id))unseen.push(job);
  const selected=unseen.slice(0,JOB_DISCOVERY_LIMITS.alertMatches);
  if(!selected.length)return {alertQueued:0,pendingAlerts:0,alerts:'up-to-date'};
  const header=`Recent matching roles across your currently fetched employer sources, newest first. ${unseen.length} recent matches have not yet been alerted; showing up to 10. Unfetched sources are not covered. Matching is a heuristic, not verified qualification.\n\n`,footer=`\n\nWarm lead: check your LinkedIn 1st-degree connections for someone at the company. /leads JOB_ID checks your uploaded export. This is a suggestion, not an identified connection.\nAll saved matches: ${process.env.APP_ORIGIN||'http://127.0.0.1:4318'}/#careers\n/apply <job ID> prepares materials using your saved resume. No employer submission. Check the posting before applying.`;
  const chunks=[];let text=header,jobs=[],bucket=null;
  selected.forEach((job,index)=>{
    const publication=jobPublication(job,{now}),label=publication.bucket==='last24Hours'?'Published in the last 24 hours':'Published in the past week (24 hours–7 days)',entry=alertEntry(job,index+1);
    const heading=bucket!==publication.bucket?`${label}\n`:'';
    if(text.length+heading.length+entry.length+footer.length+2>3850&&jobs.length){chunks.push({text:text.trim()+footer,jobs});text=header;jobs=[];bucket=null;}
    if(bucket!==publication.bucket){text+=`${label}\n`;bucket=publication.bucket;}
    text+=`${entry}\n\n`;jobs.push({id:job.id,publishedAt:publication.publishedAt,bucket:publication.bucket});
  });
  if(jobs.length)chunks.push({text:text.trim()+footer,jobs});
  batch={id:randomBytes(16).toString('hex'),status:'pending',ids:selected.map(j=>j.id),chunks,publicationVersion:1,matchingFingerprint,createdAt:new Date(now).toISOString()};await store.put('jobAlertOutbox',outboxId,batch);
  return {...await deliver(),pendingAlerts:Math.max(0,unseen.length-selected.length)};
}

async function scheduleJobAlerts(store,queue,now,{delayMs=30000,reason='refresh'}={}){
  if(!queue||!store.userId||!(await store.get('secrets','telegram'))?.chatId||(await store.get('settings','profile'))?.paused)return null;
  if(!notificationAllowed(await readNotificationPreferences(store),'jobs','alerts'))return null;
  const availableAt=now+delayMs;
  const task=await queue.enqueue(store.userId,'job-alerts',{}, {priority:-20,availableAt,idempotencyKey:`job-alert-digest:${reason}:${Math.floor(availableAt/30000)}`,retrySafe:true});
  return task.id;
}

/** One student-wide digest after source reads; no model or Telegram transmission.
 * Its lower priority lets queued board refreshes finish before the current known
 * postings are sorted together. Later/unfetched sources cannot be promised.
 */
export async function dispatchJobAlerts(store,{queue,now=Date.now()}={}){
  const lockId=idFor('job-alert-digest-lock'),old=await store.get('jobDiscoveryLocks',lockId),lease={nonce:randomBytes(12).toString('hex'),expiresAt:now+5*60000};
  if(old?.expiresAt>now)return {alertQueued:0,pendingAlerts:0,alerts:'already-running'};
  if(store.compareAndSet){if(!await store.compareAndSet('jobDiscoveryLocks',lockId,old,lease))return {alertQueued:0,pendingAlerts:0,alerts:'already-running'};}else await store.put('jobDiscoveryLocks',lockId,lease);
  try{
    const skipped=new Set((await store.all('skippedJobs')).filter(j=>j.hidden!==false).map(j=>j.id));
    const matchingFingerprint=await jobMatchingFingerprint(store,{now}),matches=(await store.all('jobs')).slice(0,JOB_DISCOVERY_LIMITS.storedJobs).filter(job=>job.matchingFingerprint===matchingFingerprint&&!skipped.has(job.id));
    let result;
    try{result=await queueAlerts(store,queue,'all-sources',matches,now,matchingFingerprint);}catch{const recent=recentJobGroups(matches,{now});result={alertQueued:0,pendingAlerts:recent.last24Hours.length+recent.pastWeek.length,alerts:'retry-pending'};}
    if(['queued','up-to-date'].includes(result.alerts)){const recent=recentJobGroups(matches,{now});let pendingAlerts=0;for(const job of [...recent.last24Hours,...recent.pastWeek])if(!await store.get('jobAlerts',job.id))pendingAlerts++;result={...result,pendingAlerts};}
    if(result.pendingAlerts>0&&result.alerts!=='needs_review')await scheduleJobAlerts(store,queue,now,{delayMs:15*60000,reason:'backlog'});
    await store.put('settings','jobAlertsHealth',{...result,lastRun:new Date(now).toISOString(),coverage:'All currently fetched matching employer sources; future or unfetched sources are not included.'});
    return result;
  }finally{if(store.compareAndSet)await store.compareAndSet('jobDiscoveryLocks',lockId,lease,{...lease,expiresAt:0});else await store.put('jobDiscoveryLocks',lockId,{...lease,expiresAt:0});}
}

/** Public GET sources only. No browser, model, employer credentials or submission endpoint. */
export async function refreshJobBoard(store,board,provider='greenhouse',{queue,fetchImpl=globalThis.fetch,now=Date.now()}={}){
  if(typeof board!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(board)||!['greenhouse','ashby'].includes(provider))throw new Error('Choose a Greenhouse or Ashby employer board slug.');
  const key=`${provider}:${board}`,at=new Date(now).toISOString(),input=await matchingInputs(store,{now}),matchingFingerprint=fingerprint(input),lockId=idFor('job-source-lock',key),oldLock=await store.get('jobDiscoveryLocks',lockId),lease={nonce:randomBytes(12).toString('hex'),expiresAt:now+5*60000};
  if(oldLock?.expiresAt>now)return {count:0,alreadyRunning:true};
  if(store.compareAndSet){if(!await store.compareAndSet('jobDiscoveryLocks',lockId,oldLock,lease))return {count:0,alreadyRunning:true};}else await store.put('jobDiscoveryLocks',lockId,lease);
  const sourceUrl=provider==='ashby'?`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`:`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`;
  try{
    await updateBoard(store,key,{board,provider,lastAttempt:at,attemptedFingerprint:matchingFingerprint,lastStatus:'refreshing',nextRun:now+JOB_DISCOVERY_LIMITS.refreshMs});
    const data=await boundedJSON(sourceUrl,fetchImpl),parsed=sourceRows(data,provider,board,sourceUrl),existing=await store.all('jobs'),byId=new Map(existing.map(j=>[j.id,j])),liveIds=new Set(parsed.rows.map(j=>j.externalId));
    if(matchingFingerprint!==await jobMatchingFingerprint(store,{now})){await updateBoard(store,key,{lastStatus:'superseded',nextRun:now});return {count:0,superseded:true};}
    const resumeSkills=skills.filter(skill=>hasPhrase(input.resume,skill));
    const scored=parsed.rows.map(row=>({...row,...scoreJobRelevance(row,{...input,resumeSkills})})).filter(row=>row.eligible).sort((a,b)=>b.score-a.score||a.externalId.localeCompare(b.externalId));
    let saved=0,newMatches=0;const current=[];let room=Math.max(0,JOB_DISCOVERY_LIMITS.storedJobs-existing.length);
    for(const row of scored.slice(0,JOB_DISCOVERY_LIMITS.matchesPerBoard)){
      const id=idFor(provider,board,row.externalId),old=byId.get(id);if(!old&&room<=0)continue;if(!old)room--;
      const job={...old,...row,id,provider,board,firstSeenAt:old?.firstSeenAt||old?.fetchedAt||at,fetchedAt:at,lastSeenAt:at,matchingFingerprint,resumeVersion:input.resumeVersion,closed:false,closedAt:null,status:old?.status==='closed'||old?.status==='not-matching'?'discovered':old?.status||'discovered'};
      await store.put('jobs',id,job);current.push(job);saved++;if(!old)newMatches++;
    }
    for(const old of existing.filter(j=>j.board===board&&j.provider===provider)){
      if(!parsed.partial&&!liveIds.has(String(old.externalId)))await store.put('jobs',old.id,{...old,closed:true,status:'closed',closedAt:at});
      else if(liveIds.has(String(old.externalId))&&!scored.some(j=>j.externalId===String(old.externalId)))await store.put('jobs',old.id,{...old,eligible:false,match:0,status:old.status==='discovered'?'not-matching':old.status,matchingFingerprint,fetchedAt:at});
    }
    const truncated=parsed.partial||scored.length>saved;
    let alerts={alertQueued:0,pendingAlerts:0,alerts:'unavailable'};
    if(matchingFingerprint!==await jobMatchingFingerprint(store,{now}))await refreshStoredJobMatches(store);
    try{const alertTaskId=await scheduleJobAlerts(store,queue,now);alerts={alertQueued:0,pendingAlerts:0,alerts:alertTaskId?'digest-queued':'not-enabled-or-paused',alertTaskId};}catch{alerts={alertQueued:0,pendingAlerts:0,alerts:'retry-pending'};}
    await updateBoard(store,key,{lastSuccess:at,lastError:null,errorMessage:null,lastStatus:truncated?'partial':'ok',failureCount:0,matchingFingerprint,sourceUrl,nextRun:now+(alerts.alerts==='retry-pending'?HOUR:alerts.pendingAlerts>0?15*60000:JOB_DISCOVERY_LIMITS.refreshMs),scannedCount:parsed.rows.length,sourceCount:parsed.total,matchedCount:saved,newMatches,truncated,invalidRows:parsed.invalid,...alerts});await healthSummary(store);
    return {count:saved,newMatches,truncated,...alerts};
  }catch(error){
    const previous=(await store.get('settings','jobBoards'))?.boards?.find(b=>b.key===key),failureCount=Math.min(20,(previous?.failureCount||0)+1);
    await updateBoard(store,key,{board,provider,lastAttempt:at,attemptedFingerprint:matchingFingerprint,failureCount,lastStatus:'error',lastError:at,errorMessage:/HTTP \d+/.exec(String(error.message))?.[0]||'Source unavailable, invalid or beyond processing limits',nextRun:now+Math.min(6,2**(failureCount-1))*HOUR});await healthSummary(store);
    throw error;
  }finally{if(store.compareAndSet)await store.compareAndSet('jobDiscoveryLocks',lockId,lease,{...lease,expiresAt:0});else await store.put('jobDiscoveryLocks',lockId,{...lease,expiresAt:0});}
}
