import {recentJobGroups,jobPublication} from './job-recency.mjs';

export const WARM_LEAD_TIP='Before applying, check your LinkedIn 1st-degree connections for someone at the company who could offer context or a warm introduction.';
const clean=(value,max)=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const posted=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
export function postedLabel(job){return `Posted ${posted.format(new Date(job.publishedAt))}`;}
export function publicationNotice(jobs,{now=Date.now()}={}){return {requireCurrentPublication:true,jobs:jobs.map(job=>{const pub=jobPublication(job,{now});return {id:job.id,publishedAt:pub.publishedAt,bucket:pub.bucket};})};}
export function careerJobList(jobs,{now=Date.now(),window='week'}={}){
 const groups=recentJobGroups(jobs,{now}),sections=[['Posted in the past 24 hours',groups.last24Hours],...(window==='24h'?[]:[['Posted 1–7 days ago',groups.pastWeek]])],listed=[];
 const header='Matching jobs · newest first\nPublication times are shown in New York time.',footer=`\n\n${WARM_LEAD_TIP}\n/leads JOB_ID checks your uploaded connection list.\nCopy /apply JOB_ID to prepare an application. /answer JOB_ID | question | optional guidance, then /generate or /write your answer. Employer submission still happens on the employer’s site.`;
 let text=header;
 for(const [title,rows] of sections){let body='';for(const job of rows){if(listed.length>=8)break;const line=`${clean(job.title,75)} — ${clean(job.company,50)}\n${clean(job.location,65)||'Location not published'}\n${postedLabel(job)}\n/apply ${clean(job.id,200)}`;if((text+'\n\n'+title+'\n'+body+'\n\n'+line+footer).length>3700)break;body+=(body?'\n\n':'')+line;listed.push(job);}text+='\n\n'+title+'\n'+(body||'No matching postings with a confirmed publication time in this window.');}
 const total=sections.reduce((sum,[,rows])=>sum+rows.length,0);if(total>listed.length)text+=`\n\n${total-listed.length} more in Career Studio. Use /jobs 24h or /jobs week.`;
 return {text:text+footer,listed,total,...publicationNotice(listed,{now})};
}
