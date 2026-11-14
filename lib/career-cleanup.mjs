import {randomBytes,createHash} from 'node:crypto';
import {HttpError} from './security.mjs';
import {listApplicationTracker} from './application-tracker.mjs';
export {isCareerJobRemoved,listVisibleJobs,listVisibleDraftApplications} from './career-visibility.mjs';

const SCOPES=new Set(['applications','saved','found','all']),TTL=10*60*1000;
const BUCKETS=['jobs','jobSaves','careerRemovals','applicationTracker','applications','liveApplications'];
const active=new Set(['inspecting','drafting','locating','queued','submitting']);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,200}$/.test(value);
const fail=(status,message)=>{throw new HttpError(status,message);};
function requireStore(store){if(!store?.userId||typeof store.compareAndSetMany!=='function')fail(401,'Sign in to manage your career lists.');}
async function all(store,bucket){let rows=[],offset=0;for(;;){const page=await store.all(bucket,{limit:2000,offset});rows.push(...page);if(page.length<2000)return rows;if(rows.length>=10000)fail(409,'This list is too large to reset at once. Remove individual items.');offset+=page.length;}}
async function snapshot(store){const data={};for(const bucket of BUCKETS)data[bucket]=await all(store,bucket);return data;}
const select=(data,scope,id)=>{
 const jobs=new Map(data.jobs.map(row=>[row.id,row])),hidden=new Set(data.careerRemovals.filter(row=>row.foundRemovedAt).map(row=>row.id));
 const applications=new Set([...data.applicationTracker,...data.applications,...data.liveApplications].filter(row=>!row.removedAt).map(row=>row.jobId));
 const saved=new Set(data.jobSaves.filter(row=>row.saved&&jobs.has(row.id)).map(row=>row.id));
 const found=new Set(data.jobs.filter(row=>!hidden.has(row.id)).map(row=>row.id));
 return Object.fromEntries(Object.entries({applications,saved,found}).map(([key,ids])=>[key,[...ids].filter(value=>(scope==='all'||scope===key)&&(!id||value===id)).sort()]));
};
function blockers(data,selected){
 const ids=new Set(selected.applications),blocked=new Map();
 for(const row of data.liveApplications)if(ids.has(row.jobId)&&!row.removedAt&&active.has(row.status))blocked.set(row.jobId,{jobId:row.jobId,title:row.title||'Application',reason:'This application is processing. Wait for it to finish before removing it.'});
 for(const row of data.applicationTracker)if(ids.has(row.jobId)&&!row.removedAt&&['requested','queued'].includes(row.preparationStatus))blocked.set(row.jobId,{jobId:row.jobId,title:row.title||'Application',reason:'Application preparation is processing. Wait for it to finish before removing it.'});
 return [...blocked.values()];
}
const counts=selected=>Object.fromEntries(Object.entries(selected).map(([key,ids])=>[key,ids.length]));
function bindings(data,selected){
 const every=new Set(Object.values(selected).flat()),appIds=new Set(selected.applications),saved=new Set(selected.saved),found=new Set(selected.found);
 return Object.fromEntries(BUCKETS.map(bucket=>[bucket,data[bucket].filter(row=>bucket==='jobs'?every.has(row.id):bucket==='jobSaves'?saved.has(row.id):bucket==='careerRemovals'?found.has(row.id):appIds.has(row.jobId)).map(row=>({id:row.id,hash:hash(row)}))]));
}
/** A confirmation refers only to the rows actually displayed in this preview. */
export async function previewCareerCleanup(store,input,{queue,now=Date.now}={}){
 requireStore(store);
 if(!input||typeof input!=='object'||Array.isArray(input)||!SCOPES.has(input.scope)||Object.keys(input).some(key=>!['scope','id'].includes(key))||input.id!==undefined&&!validId(input.id))fail(400,'Choose applications, saved jobs, found jobs, or all lists.');
 if((await store.get('settings','account'))?.deleting)fail(409,'Account deletion is in progress.');
 await listApplicationTracker(store,{queue});
 const data=await snapshot(store),selected=select(data,input.scope,input.id),number=counts(selected),blocked=blockers(data,selected),at=now();
 if(input.id&&!Object.values(number).some(Boolean))fail(404,'That item is not in your career list.');
 const token=randomBytes(24).toString('hex'),record={id:token,scope:input.scope,...(input.id?{jobId:input.id}:{}),selected,bindings:bindings(data,selected),createdAt:at,expiresAt:at+TTL,usedAt:null};
 const label=input.id?(data.jobs.find(row=>row.id===input.id)||[...data.applicationTracker,...data.liveApplications].find(row=>row.jobId===input.id))?.title||'This item':input.scope==='all'?'All career lists':{applications:'Applications',saved:'Saved jobs',found:'Found jobs'}[input.scope];
 for(const row of (await all(store,'careerCleanupPreviews')).sort((a,b)=>b.createdAt-a.createdAt).filter((row,index)=>row.expiresAt<at||index>=20))await store.delete('careerCleanupPreviews',row.id);
 await store.put('careerCleanupPreviews',token,record);
 return {token,scope:input.scope,...(input.id?{id:input.id}:{}),counts:number,blocked,canConfirm:blocked.length===0&&Object.values(number).some(Boolean),expiresAt:record.expiresAt,label};
}
/** Archive tracker entries without discarding submission receipts or duplicate guards. */
export async function performCareerCleanup(store,input,{now=Date.now}={}){
 requireStore(store);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!/^[a-f0-9]{48}$/.test(input.token||''))fail(400,'Open a fresh removal confirmation.');
 const preview=await store.get('careerCleanupPreviews',input.token),at=now();
 if(!preview||preview.usedAt!==null||preview.expiresAt<=at)fail(409,'This confirmation expired or was already used. Open a fresh confirmation.');
 const account=await store.get('settings','account');if(account?.deleting)fail(409,'Account deletion is in progress.');
 const data=await snapshot(store),selected=preview.selected;
 if(hash(bindings(data,selected))!==hash(preview.bindings))fail(409,'These career items changed. Open a fresh confirmation.');
 if(blockers(data,selected).length)fail(409,'An application is processing. Wait for it to finish before removing it.');
 const changes=[],stamp=new Date(at).toISOString(),appIds=new Set(selected.applications);
 for(const bucket of ['applicationTracker','applications','liveApplications'])for(const row of data[bucket])if(appIds.has(row.jobId)){
   const value={...row,removedAt:stamp,updatedAt:stamp,...(bucket==='liveApplications'?{revision:(row.revision||0)+1,...(!row.submitAttemptAt&&row.status!=='submitted'?{status:'cancelled'}:{})}:{})};
   changes.push({bucket,id:row.id,expected:row,value});
 }
 for(const id of selected.saved){const row=data.jobSaves.find(row=>row.id===id);changes.push({bucket:'jobSaves',id,expected:row,value:{...row,saved:false,savedAt:null,updatedAt:stamp}});}
 for(const id of selected.found){const row=data.careerRemovals.find(row=>row.id===id)||null;changes.push({bucket:'careerRemovals',id,expected:row,value:{...row,id,foundRemovedAt:stamp}});}
 // All source records are checked in the same transaction, including read-only
 // guards and absence of newly created application rows during confirmation.
 const changed=new Set(changes.map(row=>`${row.bucket}:${row.id}`));
 for(const bucket of BUCKETS)for(const row of data[bucket])if(preview.bindings[bucket].some(binding=>binding.id===row.id)&&!changed.has(`${bucket}:${row.id}`))changes.push({bucket,id:row.id,expected:row});
 changes.push({bucket:'settings',id:'account',expected:account},{bucket:'careerCleanupPreviews',id:preview.id,expected:preview,value:{...preview,usedAt:at}});
 const flow=await store.get('settings','liveApplicationFlow');if(flow&&data.liveApplications.some(row=>row.id===flow.id&&appIds.has(row.jobId)))changes.push({bucket:'settings',id:'liveApplicationFlow',expected:flow,value:{}});
 const buckets=selected.applications.length?['applicationTracker','applications','liveApplications'].map(bucket=>({bucket,ids:data[bucket].map(row=>row.id)})):[];
 if(!await store.compareAndSetMany(changes,{buckets}))fail(409,'These career items changed. Open a fresh confirmation.');
 return {scope:preview.scope,counts:counts(selected)};
}
