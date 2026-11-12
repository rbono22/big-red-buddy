import {HttpError} from './security.mjs';
import {jobPublication} from './job-recency.mjs';
import {jobDisplayFacts} from './job-display.mjs';

const safeId=value=>typeof value==='string'&&/^[-a-zA-Z0-9._:]{1,200}$/.test(value);
const selection=(id,record)=>({id,saved:record?.saved===true,savedAt:record?.saved===true?record.savedAt||null:null});
function requireStudent(store){if(!store?.userId)throw new HttpError(401,'Sign in to save jobs.');}

/** Bookmarks are independent of fetched postings and application progress. */
export async function setJobSaved(store,input,{now=()=>new Date().toISOString()}={}){
 requireStudent(store);
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||!Object.hasOwn(input,'id')||!Object.hasOwn(input,'saved')||!safeId(input.id)||typeof input.saved!=='boolean')throw new HttpError(400,'Choose a job and whether to save it.');
 for(let attempt=0;attempt<8;attempt++){
  if((await store.get('settings','account'))?.deleting)throw new HttpError(409,'Account deletion is in progress.');
  if(!await store.get('jobs',input.id))throw new HttpError(404,'Choose a job in your own workspace.');
  const previous=await store.get('jobSaves',input.id);
  if((previous?.saved===true)===input.saved)return selection(input.id,previous);
  const at=now(),next={id:input.id,saved:input.saved,savedAt:input.saved?at:null,updatedAt:at};
  if(await store.compareAndSet('jobSaves',input.id,previous,next))return selection(input.id,next);
 }
 throw new HttpError(409,'Your saved jobs changed. Refresh and retry.');
}

export async function listCareerJobs(store){
 requireStudent(store);
 const [jobs,records]=await Promise.all([store.all('jobs'),store.all('jobSaves')]),saved=new Map(records.map(record=>[record.id,record]));
 return jobs.map(job=>({...job,...jobDisplayFacts(job),...selection(job.id,saved.get(job.id)),publication:jobPublication(job)})).sort((a,b)=>(Date.parse(b.publication.publishedAt)||0)-(Date.parse(a.publication.publishedAt)||0)||String(a.id).localeCompare(String(b.id)));
}
