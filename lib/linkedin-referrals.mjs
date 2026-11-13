import {jobApplicationURL} from './job-messages.mjs';

const clean=(value,max)=>String(value||'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);

/** A student-editable draft. It uses only the selected contact and job, never inferred qualifications. */
export function referralMessage(job,person){
 const name=clean(person?.name,160).split(' ')[0]||'[Name]',title=clean(job?.title,200)||'[job title]',company=clean(job?.company,160)||'[company]';
 const url=jobApplicationURL(job);
 return `Hey ${name}, I’m looking to apply for the ${title} role at ${company}. Does ${company} have a referral program, and would you feel comfortable referring me? I’d be happy to share my resume or have a quick call to talk through my relevant experience and catch up. No pressure either way—thanks!${url?'\n\nHere’s the role: '+url:''}`;
}
