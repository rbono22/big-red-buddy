import {createHash,randomUUID} from 'node:crypto';
import {HttpError} from './security.mjs';
import {idFor} from './domain.mjs';
import {createPrivateEmailReader,withEventEmailLock} from './event-email.mjs';
import {parseLinkedInJobAlert,linkedinJobLinks,isLinkedInJobAlertSender} from './linkedin-job-email-parser.mjs';

const SETTINGS='linkedinJobEmail',MESSAGES='linkedinJobEmailMessages',DAY=86400000,WINDOW=30*DAY,MAX_BODIES=6,MAX_MESSAGES=300,MAX_JOBS=200;
const QUERY='newer_than:30d from:jobalerts-noreply@linkedin.com';
const SCOPE='https://www.googleapis.com/auth/gmail.readonly';
const clean=(value,max=240)=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const hash=value=>createHash('sha256').update(String(value||'')).digest('hex');
const stamp=at=>new Date(at).toISOString();
const hasGrant=grant=>!!(grant?.subject&&grant?.connectionRevision&&grant?.refresh_token&&String(grant.scope||'').split(/\s+/).includes(SCOPE));
// These are local MIME/size validation failures, not Gmail transport, access,
// or mailbox-consent errors. A bad edition must not block later alerts.
function unreadableMessage(error){
 if(!(error instanceof HttpError))return null;
 if(error.status===400&&error.message==='Email text exceeds 40 KB. Paste only the relevant event announcement.')return 'message-too-large';
 if(error.status===502&&error.message==='Gmail text exceeds the import size limit.')return 'message-too-large';
 if(error.status===502&&error.message==='Gmail message is too complex. Import its visible text instead.')return 'message-unreadable';
 return null;
}
const timestamp=now=>typeof now==='function'?now():now;
const coverage='Checks up to 50 LinkedIn job-alert emails received in the past 30 days and reads at most 6 new emails per refresh. Email arrival is not the job posting date.';
const permissionNotice='Uses your connected Gmail mailbox to read LinkedIn job alerts from jobalerts-noreply@linkedin.com. Gmail read-only permission covers the mailbox; BRB applies this sender filter in code. It does not log into LinkedIn or change your email.';
function requireStore(store,{write=false}={}){
 if(!store||typeof store.get!=='function'||typeof store.all!=='function'||write&&(!store.userId||typeof store.compareAndSetMany!=='function'))throw new HttpError(401,'Sign in to manage LinkedIn job alerts.');
}
function sameMailbox(cfg,grant){return hasGrant(grant)&&cfg?.connectionRevision===grant.connectionRevision&&cfg?.mailboxKey===hash(grant.subject);}
function active(cfg,grant,profile,account){return !!(cfg?.continuous&&['daily','alerts'].includes(cfg.delivery)&&sameMailbox(cfg,grant)&&!profile?.paused&&!account?.deleting);}

/** Only current, opted-in mailbox roles may enter a proactive digest. */
export async function getLinkedInAlertJobs(store,{now=Date.now,limit=300}={}){
 requireStore(store);const at=timestamp(now),bounded=Number.isInteger(limit)?Math.max(0,Math.min(limit,300)):300;
 const [cfg,grant,profile,account]=await Promise.all([store.get('settings',SETTINGS),store.get('secrets','eventEmailGoogle'),store.get('settings','profile'),store.get('settings','account')]);
 const empty={jobs:[],revision:null,connectionRevision:null,delivery:null};
 if(!active(cfg,grant,profile,account))return empty;
 const [rows,removed,skipped]=await Promise.all([store.all('jobs'),store.all('careerRemovals'),store.all('skippedJobs')]);
 const hidden=new Set([...removed.filter(row=>row?.foundRemovedAt),...skipped.filter(row=>row&&row.hidden!==false)].map(row=>row.id));
 const jobs=rows.filter(row=>{
  const source=row?.linkedinEmail,received=Date.parse(source?.receivedAt||'');
  return row?.provider==='linkedin-email'&&source?.connectionRevision===cfg.connectionRevision&&source.mailboxKey===cfg.mailboxKey&&!hidden.has(row.id)&&!row.closed&&!row.removedAt&&!['closed','removed','cancelled','dismissed'].includes(row.status)&&Number.isFinite(received)&&received<=at+300000&&received>=at-WINDOW;
 }).sort((a,b)=>Date.parse(b.linkedinEmail.receivedAt)-Date.parse(a.linkedinEmail.receivedAt)||String(a.id).localeCompare(String(b.id))).slice(0,bounded).map(row=>({...row,receivedAt:row.linkedinEmail.receivedAt,alertName:row.linkedinEmail.alertName||''}));
 // Fence races during the reads, including disconnect/reconnect and pause.
 const [latest,currentGrant,currentProfile,currentAccount]=await Promise.all([store.get('settings',SETTINGS),store.get('secrets','eventEmailGoogle'),store.get('settings','profile'),store.get('settings','account')]);
 if(latest?.revision!==cfg.revision||!active(latest,currentGrant,currentProfile,currentAccount))return empty;
 return {jobs,revision:cfg.revision,connectionRevision:cfg.connectionRevision,delivery:cfg.delivery};
}

export function createLinkedInJobEmail({fetchImpl=globalThis.fetch,now=Date.now}={}){
 const reader=createPrivateEmailReader({fetchImpl,now});
 async function status(store){
  requireStore(store);const [cfg,grant,profile,account,snapshot]=await Promise.all([store.get('settings',SETTINGS),store.get('secrets','eventEmailGoogle'),store.get('settings','profile'),store.get('settings','account'),getLinkedInAlertJobs(store,{now})]);
  const connected=hasGrant(grant),current=sameMailbox(cfg,grant),continuous=active(cfg,grant,profile,account);
  const jobs=snapshot.jobs.map(row=>({id:row.id,provider:'linkedin-email',sourceLabel:'LinkedIn alert',title:clean(row.title),company:clean(row.company,160),location:clean(row.location),url:row.url,receivedAt:row.receivedAt}));
  const capacityWarning=cfg?.lastScan?.globalCapacityReached?'Career Studio’s job list is full. Some LinkedIn roles were not imported.': 'The 200 LinkedIn-job limit was reached. Some roles were not imported. Remove unsaved roles to make room for future alerts.';
  const warnings=[...(cfg?.continuous&&!current?['Your Gmail connection changed. Turn LinkedIn job alerts on again for this mailbox.']:[]),...(profile?.paused?['Your workspace is paused. LinkedIn job alerts are paused too.']:[]),...(cfg?.lastScan?.capacityReached?[capacityWarning]:[]),...(cfg?.lastScan?.truncated?['The email search limit was reached. Some LinkedIn alerts may be omitted.']:[]),...(cfg?.lastScan?.unreadable>0?[`${cfg.lastScan.unreadable} LinkedIn alert email${cfg.lastScan.unreadable===1?' was':'s were'} too large or unreadable and skipped. Check the original email for those roles.`]:[])];
  return {...snapshot,jobs,connected,accountEmail:connected?clean(grant.email,254):null,continuous,delivery:['daily','alerts'].includes(cfg?.delivery)?cfg.delivery:'alerts',revision:cfg?.revision||null,connectionRevision:current?cfg.connectionRevision:null,lastSuccess:cfg?.lastSuccess||null,lastAttemptAt:cfg?.lastAttemptAt||null,lastError:cfg?.lastError||null,lastScan:cfg?.lastScan||null,coverageWarning:cfg?.coverageWarning||coverage,permissionNotice,warnings,retention:'Message records are kept for up to 30 days. Removed jobs and jobs received over 30 days ago are cleared only when unsaved and unrelated to any application. Saved and application-linked jobs are retained. Up to 200 LinkedIn jobs are imported; full email bodies are not stored.'};
 }
 async function enable(store,input){
  requireStore(store,{write:true});if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='delivery')||!['daily','alerts'].includes(input.delivery))throw new HttpError(400,'Choose a daily digest or new-job alerts.');
  return withEventEmailLock(store,now,async assertLease=>{
   const account=await reader.account(store),previous=await store.get('settings',SETTINGS),[grant,profile,accountState]=await Promise.all([store.get('secrets','eventEmailGoogle'),store.get('settings','profile'),store.get('settings','account')]);
   if(profile?.paused||accountState?.deleting)throw new HttpError(409,'Resume your workspace before enabling LinkedIn job alerts.');
   if(!hasGrant(grant)||grant.connectionRevision!==account.connectionRevision||grant.subject!==account.subject)throw new HttpError(409,'The connected Gmail mailbox changed. Try again.');
   const next={continuous:true,delivery:input.delivery,revision:randomUUID(),connectionRevision:account.connectionRevision,mailboxKey:hash(account.subject),enabledAt:stamp(now()),lastSuccess:null,lastError:null,coverageWarning:coverage};
   await assertLease();const lease=await store.get('settings','eventEmailLock');
   if(!await store.compareAndSetMany([{bucket:'settings',id:SETTINGS,expected:previous,value:next},{bucket:'secrets',id:'eventEmailGoogle',expected:grant},{bucket:'settings',id:'profile',expected:profile},{bucket:'settings',id:'account',expected:accountState},{bucket:'settings',id:'eventEmailLock',expected:lease}]))throw new HttpError(409,'LinkedIn job-alert preferences or the mailbox changed. Try again.');
   return status(store);
  });
 }
 // Deliberately does not acquire the scan lease: withdrawal interrupts a scan.
 async function stop(store){
  requireStore(store,{write:true});for(let attempt=0;attempt<8;attempt++){const cfg=await store.get('settings',SETTINGS);if(await store.compareAndSet('settings',SETTINGS,cfg,{...cfg,continuous:false,revision:randomUUID(),stoppedAt:stamp(now())}))return status(store);}
  throw new HttpError(409,'LinkedIn job-alert preferences changed. Try again.');
 }
 async function prune(store){
  const rows=(await store.all(MESSAGES)).sort((a,b)=>Date.parse(b.receivedAt||b.createdAt)-Date.parse(a.receivedAt||a.createdAt));
  for(const [index,row] of rows.entries())if(index>=MAX_MESSAGES||!Number.isFinite(Date.parse(row.receivedAt||row.createdAt))||Date.parse(row.receivedAt||row.createdAt)<now()-WINDOW)await store.delete(MESSAGES,row.id);
 }
 async function sync(store){
  requireStore(store,{write:true});return withEventEmailLock(store,now,async assertLease=>{
   const [cfg,account]=await Promise.all([store.get('settings',SETTINGS),reader.account(store)]);
   if(!cfg?.continuous||cfg.connectionRevision!==account.connectionRevision||cfg.mailboxKey!==hash(account.subject))throw new HttpError(409,'Turn LinkedIn job alerts on for your current Gmail mailbox first.');
   const assertCurrent=async()=>{
    await assertLease();const [current,grant,profile,accountState,lease]=await Promise.all([store.get('settings',SETTINGS),store.get('secrets','eventEmailGoogle'),store.get('settings','profile'),store.get('settings','account'),store.get('settings','eventEmailLock')]);
    if(current?.revision!==cfg.revision||!active(current,grant,profile,accountState))throw new HttpError(409,'LinkedIn job-alert consent, Gmail connection, or workspace availability changed.');
    return [{bucket:'settings',id:SETTINGS,expected:current},{bucket:'secrets',id:'eventEmailGoogle',expected:grant},{bucket:'settings',id:'profile',expected:profile},{bucket:'settings',id:'account',expected:accountState},{bucket:'settings',id:'eventEmailLock',expected:lease}];
   };
   const commit=async(changes,options)=>{const guards=await assertCurrent();if(!await store.compareAndSetMany([...guards,...changes],options))throw new HttpError(409,'LinkedIn alert data changed during import. Refresh again.');};
   async function pruneJobs(){
    const referenceBuckets=['applications','applicationTracker','liveApplications'];
    const [jobs,saves,removals,...references]=await Promise.all([store.all('jobs'),store.all('jobSaves'),store.all('careerRemovals'),...referenceBuckets.map(bucket=>store.all(bucket))]);
    const linked=jobs.filter(row=>row?.provider==='linkedin-email');
    // If a reference list hit the database read bound, retain every role. We
    // cannot prove absence of another application in a truncated list.
    if(references.some(rows=>rows.length>=2000)||saves.length>=2000)return {linkedin:linked.length,total:jobs.length};
    const referenced=new Set(references.flat().map(row=>row?.jobId)),saveMap=new Map(saves.filter(Boolean).map(row=>[row.id,row])),removalMap=new Map(removals.filter(Boolean).map(row=>[row.id,row]));
    const expired=linked.filter(row=>!referenced.has(row.id)&&!saveMap.get(row.id)?.saved&&row.saved!==true&&!['saved','applied','submitted'].includes(row.status)&&(removalMap.get(row.id)?.foundRemovedAt||Date.parse(row.linkedinEmail?.receivedAt||row.receivedAt||'')<now()-WINDOW));
    if(!expired.length)return {linkedin:linked.length,total:jobs.length};
    const changes=references.flatMap((rows,index)=>rows.filter(Boolean).map(row=>({bucket:referenceBuckets[index],id:row.id,expected:row})));
    for(const row of expired)changes.push({bucket:'jobs',id:row.id,expected:row,delete:true},{bucket:'jobSaves',id:row.id,expected:saveMap.get(row.id)||null},{bucket:'careerRemovals',id:row.id,expected:removalMap.get(row.id)||null});
    await commit(changes,{buckets:referenceBuckets.map((bucket,index)=>({bucket,ids:references[index].filter(Boolean).map(row=>row.id)}))});
    return {linkedin:linked.length-expired.length,total:jobs.length-expired.length};
   }
   try{
    await assertCurrent();await prune(store);let storedJobs=await pruneJobs();const scan=await reader.scanSearch(store,{query:QUERY,connectionRevision:account.connectionRevision});await assertCurrent();
    let read=0,processed=0,imported=0,reused=0,skipped=0,backlog=0,unreadable=0,capacityReached=false,globalCapacityReached=false;const jobIds=new Set();
    for(const remoteId of scan.messageIds){
     await assertCurrent();const id=idFor('linkedin-job-email',account.subject,remoteId),existing=await store.get(MESSAGES,id);
     if(existing?.status==='done'&&existing.connectionRevision===cfg.connectionRevision){skipped++;continue;}
     let prepared=existing?.status==='processing'&&existing.connectionRevision===cfg.connectionRevision?existing:null;
     if(!prepared){
      if(read>=MAX_BODIES){backlog++;continue;}
      const metadata=await reader.readMetadata(store,{id:remoteId,connectionRevision:account.connectionRevision});await assertCurrent();
      if(!metadata||!isLinkedInJobAlertSender(metadata.sender)){skipped++;continue;}
      let message;read++;
      try{message=await reader.readMessage(store,{id:remoteId,metadata,connectionRevision:account.connectionRevision,linkPolicy:linkedinJobLinks});}
      catch(error){
       const reason=unreadableMessage(error);if(!reason)throw error;
       await commit([{bucket:MESSAGES,id,expected:existing,value:{id,status:'done',reason,connectionRevision:cfg.connectionRevision,mailboxKey:cfg.mailboxKey,receivedAt:metadata.receivedAt,createdAt:stamp(now()),jobIds:[]}}]);skipped++;unreadable++;continue;
      }
      await assertCurrent();
      if(!message||!isLinkedInJobAlertSender(message.sender)){skipped++;continue;}
      const parsed=parseLinkedInJobAlert(message);
      prepared={id,status:'processing',connectionRevision:cfg.connectionRevision,mailboxKey:cfg.mailboxKey,receivedAt:message.receivedAt,createdAt:stamp(now()),alertName:clean(parsed.alertName),preparedJobs:parsed.jobs.slice(0,20),contentHash:hash(message.text)};
      await commit([{bucket:MESSAGES,id,expected:existing,value:prepared}]);
     }
     for(const candidate of prepared.preparedJobs){
      const jobId=idFor('linkedin-email',candidate.externalId);await assertCurrent();
      const [old,removal]=await Promise.all([store.get('jobs',jobId),store.get('careerRemovals',jobId)]);
      if(removal?.foundRemovedAt){skipped++;continue;}
      if(!old&&(storedJobs.linkedin>=MAX_JOBS||storedJobs.total>=2000)){capacityReached=true;globalCapacityReached ||= storedJobs.total>=2000;skipped++;continue;}
      // The stable posting ID deduplicates different alert emails and reconnects.
      // Never replace a newer alert's facts with an older edition.
      const newer=!old?.linkedinEmail||old.linkedinEmail.connectionRevision!==cfg.connectionRevision||Date.parse(old.linkedinEmail.receivedAt)<Date.parse(prepared.receivedAt);
      if(old&&!newer){reused++;jobIds.add(jobId);continue;}
      const next={...old,id:jobId,provider:'linkedin-email',sourceLabel:'LinkedIn alert',externalId:candidate.externalId,title:candidate.title,company:candidate.company,location:candidate.location,url:candidate.url,applyUrl:candidate.url,description:old?.description||'',publishedAt:null,publicationTimeVerified:false,receivedAt:prepared.receivedAt,firstSeenAt:old?.firstSeenAt||stamp(now()),fetchedAt:stamp(now()),...(!old?{status:'discovered',eligible:true}:{}),linkedinEmail:{mailboxKey:cfg.mailboxKey,connectionRevision:cfg.connectionRevision,receivedAt:prepared.receivedAt,messageId:remoteId,alertName:prepared.alertName}};
      await commit([{bucket:'jobs',id:jobId,expected:old,value:next},{bucket:'careerRemovals',id:jobId,expected:removal}]);jobIds.add(jobId);if(old)reused++;else{imported++;storedJobs.linkedin++;storedJobs.total++;}
     }
     const {preparedJobs,...record}=prepared;
     await commit([{bucket:MESSAGES,id,expected:prepared,value:{...record,status:'done',jobIds:preparedJobs.map(job=>idFor('linkedin-email',job.externalId))}}]);processed++;
    }
    await assertCurrent();const lastScan={scanned:scan.messageIds.length,read,processed,imported,reused,skipped,backlog,unreadable,truncated:scan.truncated,capacityReached,globalCapacityReached},at=stamp(now()),guards=await assertCurrent();
    const current=guards.find(row=>row.bucket==='settings'&&row.id===SETTINGS).expected;
    const capacityWarning=globalCapacityReached?' Career Studio’s job list is full. Some LinkedIn roles were not imported.':' The 200 LinkedIn-job limit was reached. Some roles in these emails were not imported. Remove unsaved roles to make room for future alerts.';
    const final=guards.map(row=>row.bucket==='settings'&&row.id===SETTINGS?{...row,value:{...current,lastSuccess:at,lastAttemptAt:at,lastError:null,lastScan,coverageWarning:coverage+(scan.truncated?' Search limit reached; some alerts may be omitted.':'')+(capacityReached?capacityWarning:'')}}:row);
    if(!await store.compareAndSetMany(final))throw new HttpError(409,'LinkedIn job-alert preferences changed during refresh.');
    await prune(store);return {...lastScan,jobIds:[...jobIds],complete:!scan.truncated&&!backlog&&!capacityReached};
   }catch(error){const current=await store.get('settings',SETTINGS);if(current?.revision===cfg.revision)await store.compareAndSet('settings',SETTINGS,current,{...current,lastAttemptAt:stamp(now()),lastError:error instanceof HttpError?clean(error.message,300):'LinkedIn job alerts could not be refreshed. Try again shortly.'});throw error;}
  });
 }
 return {status,enable,stop,sync};
}
const service=createLinkedInJobEmail();
export const listLinkedInJobEmail=(...args)=>service.status(...args);
export const enableLinkedInJobEmail=(...args)=>service.enable(...args);
export const stopLinkedInJobEmail=(...args)=>service.stop(...args);
export const syncLinkedInJobEmail=(...args)=>service.sync(...args);
