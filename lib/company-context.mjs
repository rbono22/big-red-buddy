// Bounded paraphrases checked against official employer careers/values pages.
// Refresh from these sources before extending checkedAt; never match substrings.
const CHECKED_AT='2026-11-13T03:52:34.000Z';
const MAX_AGE_MS=180*24*60*60*1000;
const records=[
 {company:'Splunk',names:['splunk','splunk inc.','splunk inc','splunk, a cisco company'],sources:[
  {url:'https://careers.cisco.com/global/en/splunk',title:'Working at Splunk — Cisco Careers',checkedAt:CHECKED_AT,summaries:[
   'Splunk develops security and observability products that help organizations maintain reliable digital systems.',
   'Splunk’s careers page emphasizes optimism, enthusiasm, openness, teamwork, and learning through mentorship.'
  ]}
 ]},
 {company:'Ramp',names:['ramp','ramp business corporation'],sources:[
  {url:'https://ramp.com/about-us/',title:'Ramp — Our values',checkedAt:CHECKED_AT,summaries:[
   'Ramp puts customer outcomes at the center of product decisions and seeks to help businesses operate more effectively.',
   'Ramp encourages acting quickly on priorities, owning work from start to finish, and sharing information across teams.'
  ]}
 ]},
 {company:'Stripe',names:['stripe','stripe inc.','stripe inc'],sources:[
  {url:'https://stripe.com/careers/compatibility',title:'Stripe Careers — How we operate',checkedAt:CHECKED_AT,summaries:[
   'Stripe’s operating principles emphasize understanding user needs, careful craftsmanship, focused execution, collaboration across teams, and continuous learning.',
   'Stripe describes its mission as expanding internet economic activity and supporting entrepreneurship.'
  ]}
 ]}
];
const exactName=value=>typeof value==='string'?value.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase():'';

/** Only a known exact employer identity receives cached official evidence. */
export function officialCompanyContext(company,{now=Date.now()}={}){
 const record=records.find(row=>row.names.includes(exactName(company)));
 if(!record||!Number.isFinite(now))return null;
 const sources=record.sources.filter(source=>{const checked=Date.parse(source.checkedAt);return now>=checked&&now-checked<=MAX_AGE_MS;});
 return sources.length?structuredClone({company:record.company,sources}):null;
}

export function companyContextText(context){
 if(!context)return '';
 return context.sources.flatMap(source=>source.summaries.map(summary=>`${summary}\nOfficial source: ${source.url}\nChecked: ${source.checkedAt}`)).join('\n\n');
}
