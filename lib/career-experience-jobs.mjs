import {readCareerExperience} from './career-experience.mjs';
import {HttpError} from './security.mjs';

export async function queueExperienceAnalysis(store,queue,{force=false,allowDeferred=false}={}){
 const view=await readCareerExperience(store);
 if(view.status==='no-resume'||!view.sourceHash||!force&&view.analyzed&&!view.stale)return null;
 let job;
 try{job=await queue.enqueue(store.userId,'career-experience',{sourceHash:view.sourceHash},{idempotencyKey:`career-experience:${view.sourceHash}${force?`:${Math.floor(Date.now()/60000)}`:''}`,priority:5,retrySafe:false,maxAttempts:1});}
 catch(error){if(!['STUDENT_QUEUE_FULL','STUDENT_MODEL_QUEUE_FULL'].includes(error.message))throw error;const warning='Experience analysis is waiting for capacity. Use Analyze experience in Career Studio after current tasks finish.';if(allowDeferred)return {taskId:null,warning};throw new HttpError(429,warning);}
 return {taskId:job.id};
}
