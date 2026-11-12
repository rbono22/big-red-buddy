/* Pure display filters. No account data is persisted or sent by this helper. */
(() => {
  'use strict';
  const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  const normalize = value => clean(value).normalize('NFKC').toLocaleLowerCase('en-US');
  const workplaces = Object.freeze({remote:'remote',hybrid:'hybrid',onsite:'on-site','on-site':'on-site'});
  const types = Object.freeze({fulltime:'full-time','full-time':'full-time',parttime:'part-time','part-time':'part-time',intern:'internship',internship:'internship',contract:'contract',contractor:'contract',temporary:'temporary'});
  const canonical = (value, options) => {const key=normalize(value).replace(/[ _]/g,'');return Object.hasOwn(options,key)?options[key]:null;};
  function jobFacts(job = {}) {
    const raw = job.rawSource && typeof job.rawSource === 'object' ? job.rawSource : {};
    const workplace = canonical(Object.hasOwn(job, 'workplaceType') ? job.workplaceType : raw.workplaceType, workplaces);
    const type = canonical(Object.hasOwn(job, 'employmentType') ? job.employmentType : raw.employmentType, types);
    const salary = clean(job.salary);
    const fit = job.experienceFit?.status || job.experienceFit?.category;
    const experience = canonical(fit,{'within-range':'within',within:'within',stretch:'stretch','outside-range':'beyond',beyond:'beyond'});
    return {workplace,type,salary:salary && /\d/.test(salary) ? salary : null,experience};
  }
  function date(value) {
    if (typeof value !== 'string' || value.length > 40) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return null;
    const [,year,month,day,hour,minute,second='0',,zone] = match;
    const [y,m,d,h,min,s] = [year,month,day,hour,minute,second].map(Number);
    const days = [31,y%4===0&&(y%100!==0||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
    if (y<1900||y>2100||m<1||m>12||d<1||d>days[m-1]||h>23||min>59||s>59) return null;
    if (zone!=='Z') {const [zh,zm]=zone.slice(1).split(':').map(Number);if(zh>14||zm>59||zh===14&&zm!==0)return null;}
    const at=Date.parse(value);return Number.isFinite(at)?new Date(at).toISOString():null;
  }
  function timestamp(now) {const value=typeof now==='function'?now():now;const at=typeof value==='string'?Date.parse(value):value;return Number.isFinite(at)?at:Date.now();}
  function posting(job = {}, {now=Date.now()} = {}) {
    let publishedAt=date(Object.hasOwn(job,'publication')?job.publication?.publishedAt:job.publishedAt);
    if (!Object.hasOwn(job,'publication')&&job.rawSource&&['greenhouse','ashby'].includes(job.provider)) {
      const raw=date(job.provider==='ashby'?job.rawSource.publishedAt:job.rawSource.first_published);
      if(!raw||raw!==publishedAt)publishedAt=null;
    }
    if(job.publicationTimeVerified===false||!publishedAt)return null;
    const at=Date.parse(publishedAt),age=timestamp(now)-at;
    return age>=0?{publishedAt,at,age}:null;
  }
  // Commas separate alternatives; words in each alternative all need to match.
  function matches(value, query) {
    const groups=normalize(query).slice(0,600).split(/[,;|]/).map(part=>part.trim()).filter(Boolean).slice(0,15);
    const haystack=normalize(value);
    return !groups.length || groups.some(group=>group.split(/\s+/).every(word=>haystack.includes(word)));
  }
  function filterJobs(jobs, filters = {}, {now=Date.now()} = {}) {
    const at=timestamp(now),f=filters,seen=new Set();
    const rows=(Array.isArray(jobs)?jobs:[]).filter(job=>job&&typeof job.id==='string'&&!seen.has(job.id)&&seen.add(job.id)).map(job=>({job,facts:jobFacts(job),posted:posting(job,{now:at})}));
    const selected=rows.filter(({job,facts,posted})=>{
      if(f.savedOnly&&job.saved!==true)return false;
      if(!matches([job.title,job.company,job.description,...(Array.isArray(job.matchEvidence?.skills)?job.matchEvidence.skills:[])].filter(v=>typeof v==='string').join(' '),f.query))return false;
      if(!matches(job.location,f.location))return false;
      if(f.company&&f.company!=='all'&&normalize(job.company)!==normalize(f.company))return false;
      for(const key of ['workplace','experience','type'])if(f[key]&&f[key]!=='all'&&(f[key]==='unknown'?facts[key]!==null:facts[key]!==f[key]))return false;
      if(f.salary==='published'&&!facts.salary||f.salary==='unknown'&&facts.salary)return false;
      if(f.recency==='undated'&&posted)return false;
      if(['24h','week'].includes(f.recency)&&(!posted||posted.age>(f.recency==='24h'?86400000:604800000)))return false;
      return true;
    });
    selected.sort((a,b)=>{
      if(f.sort==='match'){const score=job=>Number.isFinite(job.score)?job.score:Number.isFinite(job.match)?job.match:0;const difference=score(b.job)-score(a.job);if(difference)return difference;}
      return (b.posted?.at??-Infinity)-(a.posted?.at??-Infinity)||a.job.id.localeCompare(b.job.id);
    });
    return selected.map(row=>row.job);
  }
  globalThis.BRBCareerSearch=Object.freeze({filterJobs,jobFacts,posting});
})();
