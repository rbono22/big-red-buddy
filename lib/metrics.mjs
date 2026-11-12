export const percentile=(values,q=.95)=>values.length?[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.ceil(values.length*q)-1)]:null;
export function modelTimingMetrics(runs){
  const values=key=>runs.map(row=>row[key]).filter(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0);
  const profiles=['chat','summary','draft','review','extraction'];
  return {samples:values('providerTotalMs').length,loadP50Ms:percentile(values('loadMs'),.5),loadP95Ms:percentile(values('loadMs')),promptP95Ms:percentile(values('promptMs')),generationP95Ms:percentile(values('generationMs')),outputTokensPerSecondP50:percentile(values('outputTokensPerSecond'),.5),profiles:profiles.flatMap(profile=>{const matching=runs.filter(row=>row.profile===profile&&typeof row.ms==='number'&&Number.isFinite(row.ms)&&row.ms>=0);return matching.length?[{profile,runs:matching.length,latencyP95Ms:percentile(matching.map(row=>row.ms))}]:[];})};
}
export async function studentMetrics(database,queue,userId) {
  const store=database.forUser(userId), cutoff=Date.now()-30*86400000;
  const runs=(await store.all('metrics')).filter(m=>Date.parse(m.at)>cutoff&&m.ms>0);
  const reminders=await store.all('reminders');
  return {queue:await queue.metrics(userId),model:{windowDays:30,runs:runs.length,latencyP50Ms:percentile(runs.map(m=>m.ms),.5),latencyP95Ms:percentile(runs.map(m=>m.ms)),inputTokens:runs.reduce((n,m)=>n+(m.inputTokens||0),0),outputTokens:runs.reduce((n,m)=>n+(m.outputTokens||0),0),timing:modelTimingMetrics(runs)},reminders:{sent:reminders.filter(r=>r.status==='sent').length,missed:reminders.filter(r=>r.status==='missed').length,uncertain:reminders.filter(r=>['sending','needs-review'].includes(r.status)).length,latenessP95Ms:percentile(reminders.filter(r=>r.status==='sent'&&Number.isFinite(r.latenessMs)).map(r=>r.latenessMs))}};
}
export async function operationsMetrics(database,queue) {
  const ids=await database.listUserIds(),counts={queued:0,running:0,completed:0,failed:0,needs_review:0};
  let activeStudents=0,sent=0,missed=0,uncertain=0;const latency=[],delays=[],lateness=[];
  for(const id of ids) {
    const store=database.forUser(id), last=await store.get('settings','lastActive');
    if(last?.at>Date.now()-30*86400000)activeStudents++;
    const q=await queue.metrics(id);for(const key of Object.keys(counts))counts[key]+=q.counts[key]||0;
    for(const job of await queue.list(id,{limit:500}))if(job.startedAt&&job.createdAt>Date.now()-86400000)delays.push(Math.max(0,job.startedAt-job.availableAt));
    for(const m of await store.all('metrics'))if(m.ms>0&&Date.parse(m.at)>Date.now()-30*86400000)latency.push(m.ms);
    for(const r of await store.all('reminders')){if(r.status==='sent'){sent++;if(Number.isFinite(r.latenessMs))lateness.push(r.latenessMs);}if(r.status==='missed')missed++;if(['sending','needs-review'].includes(r.status))uncertain++;}
  }
  const configured=process.env.MONTHLY_INFRA_COST_USD, cost=configured&&Number.isFinite(Number(configured))&&Number(configured)>=0?Number(configured):null;
  const workers=await database.system.all('workerHealth');
  return {at:new Date().toISOString(),windowDays:30,activeStudents,queueWindowHours:24,queue:counts,queueDelayP95Ms:percentile(delays),modelLatencyP95Ms:percentile(latency),reminders:{sent,missed,uncertain,latenessP95Ms:percentile(lateness)},monthlyInfrastructureCostUSD:cost,costPerActiveStudentUSD:cost!==null&&activeStudents?cost/activeStudents:null,costBasis:'Configured monthly infrastructure expense; excludes labor, excludes historical billing attribution',workers:workers.filter(w=>w.lastSeen>Date.now()-86400000).map(({role,lastSeen})=>({role,lastSeen,stale:Date.now()-lastSeen>60000})),sampling:'Bounded pilot metrics; at most 500 recent queue samples per student for fleet latency. Completed jobs expire after 24h; model and delivery metrics are retained separately.'};
}
