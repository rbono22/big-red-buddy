const EMPLOYMENT=Object.freeze({FullTime:'full-time',PartTime:'part-time',Intern:'internship',Contract:'contract',Temporary:'temporary'});
const WORKPLACE=Object.freeze({Remote:'remote',Hybrid:'hybrid',OnSite:'on-site'});
const employmentValues=new Set(Object.values(EMPLOYMENT)),workplaceValues=new Set(Object.values(WORKPLACE));
const ownValue=(values,key)=>typeof key==='string'&&Object.hasOwn(values,key)?values[key]:null;

/** Only explicit source fields qualify. Ashby's isRemote also means hybrid. */
export function sourceJobDisplayFacts(provider,raw){
 return provider==='ashby'?{employmentType:ownValue(EMPLOYMENT,raw?.employmentType),workplaceType:ownValue(WORKPLACE,raw?.workplaceType)}:{employmentType:null,workplaceType:null};
}

/** Project older stored source records without fetching or guessing from prose. */
export function jobDisplayFacts(job){
 const source=sourceJobDisplayFacts(job.provider,job.rawSource);
 return {employmentType:employmentValues.has(job.employmentType)?job.employmentType:source.employmentType,workplaceType:workplaceValues.has(job.workplaceType)?job.workplaceType:source.workplaceType};
}
