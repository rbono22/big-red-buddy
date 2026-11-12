export const JOB_PUBLICATION_WINDOWS = Object.freeze({last24Hours:86400000,pastWeek:7*86400000});

/** A published day without a time/offset cannot establish rolling-hour recency. */
export function normalizePublishedAt(value) {
  if(typeof value!=='string'||value.length>40)return null;
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if(!match)return null;
  const [,year,month,day,hour,minute,second='0',,zone]=match,numbers=[year,month,day,hour,minute,second].map(Number),[y,m,d,h,min,s]=numbers;
  const days=[31,(y%4===0&&(y%100!==0||y%400===0))?29:28,31,30,31,30,31,31,30,31,30,31];
  if(y<1900||y>2100||m<1||m>12||d<1||d>days[m-1]||h>23||min>59||s>59)return null;
  if(zone!=='Z'){const [zh,zm]=zone.slice(1).split(':').map(Number);if(zh>14||zm>59||zh===14&&zm!==0)return null;}
  const at=Date.parse(value);return Number.isFinite(at)?new Date(at).toISOString():null;
}

export function jobPublication(job,{now=Date.now()}={}) {
  const at=typeof now==='function'?now():now;
  if(!Number.isFinite(at))throw new TypeError('Job recency requires a finite current timestamp.');
  let publishedAt=normalizePublishedAt(job?.publishedAt);
  // Re-check retained provider evidence for legacy rows that were normalized
  // before strict timestamp validation (e.g. date-only -> midnight UTC).
  if(job?.rawSource&&typeof job.rawSource==='object'&&!Array.isArray(job.rawSource)&&['greenhouse','ashby'].includes(job.provider)){
    const raw=normalizePublishedAt(job.provider==='ashby'?job.rawSource.publishedAt:job.rawSource.first_published);
    if(!raw||raw!==publishedAt)publishedAt=null;
  }
  if(job?.publicationTimeVerified===false)publishedAt=null;
  if(!publishedAt)return {eligible:false,bucket:null,publishedAt:null,ageMs:null,reason:'publication-time-unknown'};
  const ageMs=at-Date.parse(publishedAt);
  if(ageMs<0)return {eligible:false,bucket:null,publishedAt,ageMs,reason:'publication-in-future'};
  if(ageMs>JOB_PUBLICATION_WINDOWS.pastWeek)return {eligible:false,bucket:null,publishedAt,ageMs,reason:'older-than-seven-days'};
  return {eligible:true,bucket:ageMs<=JOB_PUBLICATION_WINDOWS.last24Hours?'last24Hours':'pastWeek',publishedAt,ageMs,reason:null};
}

const tieKey=job=>String(job?.id||`${job?.provider||''}:${job?.board||''}:${job?.externalId||job?.url||job?.title||''}`);
export function recentJobGroups(jobs,{now=Date.now()}={}) {
  if(!Array.isArray(jobs))throw new TypeError('Jobs must be an array.');
  const at=typeof now==='function'?now():now;if(!Number.isFinite(at))throw new TypeError('Job recency requires a finite current timestamp.');
  const active=job=>job&&job.closed!==true&&job.eligible!==false&&!['closed','cancelled','removed','not-matching','dismissed'].includes(job.status);
  const groups={last24Hours:[],pastWeek:[]},rows=jobs.filter(active).map(job=>({job,publication:jobPublication(job,{now:at})})).filter(row=>row.publication.eligible);
  rows.sort((a,b)=>Date.parse(b.publication.publishedAt)-Date.parse(a.publication.publishedAt)||(tieKey(a.job)<tieKey(b.job)?-1:tieKey(a.job)>tieKey(b.job)?1:0));
  const seen=new Set();for(const row of rows){const key=tieKey(row.job);if(seen.has(key))continue;seen.add(key);groups[row.publication.bucket].push(row.job);}
  return groups;
}
