/** Removal state is separate from fetched postings, so refreshes cannot undo it. */
export async function isCareerJobRemoved(store,id){return !!(await store.get('careerRemovals',id))?.foundRemovedAt;}
export async function listVisibleJobs(store){
 const removed=new Set((await store.all('careerRemovals')).filter(row=>row.foundRemovedAt).map(row=>row.id));
 return (await store.all('jobs')).filter(job=>!removed.has(job.id));
}
export async function listVisibleDraftApplications(store){return (await store.all('applications')).filter(row=>!row.removedAt);}
