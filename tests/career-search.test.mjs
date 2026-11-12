import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const context=vm.createContext({Date});
vm.runInContext(await readFile(new URL('../public/career-search.js',import.meta.url),'utf8'),context);
const {filterJobs,jobFacts,posting}=context.BRBCareerSearch;
const now=Date.parse('2026-11-11T21:00:00Z'),day=86400000;
const job=(id,age=day,extra={})=>({id,title:'Product Manager',company:'Example',location:'New York',publishedAt:new Date(now-age).toISOString(),publicationTimeVerified:true,...extra});
const ids=rows=>Array.from(rows,row=>row.id);
const plain=value=>JSON.parse(JSON.stringify(value));

test('career recency uses verified source times rather than discovery, update or invalid dates',()=>{
 const jobs=[job('older',8*day),job('new',1000),job('week',4*day),job('date-only',0,{publishedAt:'2026-11-11',createdAt:new Date(now).toISOString()}),job('future',-1000),job('false',0,{publicationTimeVerified:false}),job('invalid',0,{publishedAt:'2026-02-30T12:00:00Z'}),job('invalid-offset',0,{publishedAt:'2026-11-11T12:00:00+14:01'})];
 assert.deepEqual(ids(filterJobs(jobs,{recency:'24h'},{now})),['new']);
 assert.deepEqual(ids(filterJobs(jobs,{recency:'week'},{now})),['new','week']);
 assert.deepEqual(ids(filterJobs(jobs,{recency:'undated'},{now})),['date-only','false','future','invalid','invalid-offset']);
 assert.equal(posting(job('legacy',0,{provider:'greenhouse',rawSource:{first_published:'2026-11-11'}}),{now}),null);
 assert.equal(posting(job('sanitized',0,{publication:{publishedAt:null}}),{now}),null);
 assert.equal(posting(job('timezone',0,{publishedAt:'2026-11-11T16:00:00-05:00'}),{now}).at,now);
 assert.deepEqual(ids(filterJobs([job('boundary',day)],{recency:'24h'},{now})),['boundary']);
});

test('career facts distinguish explicit workplace and employment fields from guesses',()=>{
 assert.deepEqual(plain(jobFacts({isRemote:true,title:'Remote full-time intern',location:'Remote',description:'Full time',salary:'Competitive'})),{workplace:null,type:null,salary:null,experience:null});
 assert.deepEqual(plain(jobFacts({rawSource:{workplaceType:'Hybrid',employmentType:'FullTime'},salary:'$100,000–$140,000',experienceFit:{status:'stretch'}})),{workplace:'hybrid',type:'full-time',salary:'$100,000–$140,000',experience:'stretch'});
 assert.deepEqual(plain(jobFacts({workplaceType:null,employmentType:null,rawSource:{workplaceType:'Remote',employmentType:'FullTime'}})),{workplace:null,type:null,salary:null,experience:null});
 assert.equal(jobFacts({employmentType:'Intern'}).type,'internship');
 assert.equal(jobFacts({workplaceType:'OnSite'}).workplace,'on-site');
 assert.equal(jobFacts({experienceFit:{category:'outside-range'}}).experience,'beyond');
 assert.deepEqual(plain(jobFacts({employmentType:'constructor',workplaceType:'__proto__',experienceFit:{status:'toString'}})),{workplace:null,type:null,salary:null,experience:null});
});

test('career filters combine local search and source-backed facets without mutating records',()=>{
 const jobs=[job('a',1000,{title:'Senior Product Manager',company:'Adobe',location:'New York',workplaceType:'hybrid',employmentType:'full-time',salary:'$150k',experienceFit:{status:'within-range'},saved:true}),job('b',2000,{title:'Data Analyst',company:'Example',location:'San Francisco',workplaceType:'remote',employmentType:'contract',experienceFit:{status:'stretch'}}),job('c',3000,{title:'Analyst',company:'Adobe',location:'London',description:'SQL and Python experience',saved:true})];
 const original=JSON.stringify(jobs);
 assert.deepEqual(ids(filterJobs(jobs,{query:'data analyst, product manager',location:'New York, Boston',workplace:'hybrid',experience:'within',company:'Adobe',type:'full-time',salary:'published',savedOnly:true},{now})),['a']);
 assert.deepEqual(ids(filterJobs(jobs,{query:'sql python'},{now})),['c']);
 assert.deepEqual(ids(filterJobs(jobs,{type:'unknown',salary:'unknown',workplace:'unknown',experience:'unknown'},{now})),['c']);
 assert.deepEqual(ids(filterJobs(jobs,{query:'[a-z]*'},{now})),[]);
 assert.deepEqual(ids(filterJobs(jobs,{company:'Ad'},{now})),[]);
 assert.equal(JSON.stringify(jobs),original);
});

test('saved jobs are real bookmarks and can include old or closed roles while date filters remain explicit',()=>{
 const jobs=[job('discovered',1000),job('saved-old',30*day,{saved:true,status:'closed'}),job('saved-new',2000,{saved:true}),job('saved-new',2000,{saved:true}),job('not-saved',2000,{saved:'true'})];
 assert.deepEqual(ids(filterJobs(jobs,{savedOnly:true,recency:'all'},{now})),['saved-new','saved-old']);
 assert.deepEqual(ids(filterJobs(jobs,{savedOnly:true,recency:'week'},{now})),['saved-new']);
});

test('career sort is deterministic, newest by default, with optional bounded match-score ordering',()=>{
 const jobs=[job('b',day,{score:95}),job('a',day,{score:95}),job('new',10,{score:60}),job('undated',0,{publishedAt:null})];
 assert.deepEqual(ids(filterJobs(jobs,{}, {now})),['new','a','b','undated']);
 assert.deepEqual(ids(filterJobs(jobs,{sort:'match'}, {now})),['a','b','new','undated']);
 assert.deepEqual(ids(filterJobs(undefined,{}, {now})),[]);
});
