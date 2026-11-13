import {ashbyApplicationURL,inspectAshbyApplication,submitAshbyApplication,ashbyLocationChoices} from './ashby-browser.mjs';
import {greenhouseApplicationURL,inspectGreenhouseApplication,submitGreenhouseApplication,greenhouseLocationChoices} from './greenhouse-browser.mjs';
import {leverApplicationURL,inspectLeverApplication,submitLeverApplication,leverLocationChoices} from './lever-browser.mjs';
import {workableApplicationURL,inspectWorkableApplication,submitWorkableApplication} from './workable-browser.mjs';

// Public job feeds do not grant submission API credentials. These adapters use
// hosted candidate forms, with a separate, reviewed submit action for each job.
const PROVIDERS=Object.freeze([
 {id:'ashby',label:'Ashby',canonical:ashbyApplicationURL,inspect:inspectAshbyApplication,submit:submitAshbyApplication,locate:ashbyLocationChoices},
 {id:'greenhouse',label:'Greenhouse',canonical:greenhouseApplicationURL,inspect:inspectGreenhouseApplication,submit:submitGreenhouseApplication,locate:greenhouseLocationChoices},
 {id:'lever',label:'Lever',canonical:leverApplicationURL,inspect:inspectLeverApplication,submit:submitLeverApplication,locate:leverLocationChoices},
 {id:'workable',label:'Workable',canonical:workableApplicationURL,inspect:inspectWorkableApplication,submit:submitWorkableApplication}
]);
export function applicationProvider(value){
 for(const provider of PROVIDERS){const url=provider.canonical(value);if(url)return {...provider,url};}
 return null;
}
export const applicationURL=value=>applicationProvider(value)?.url||'';
export const liveApplicationSupported=job=>process.env.APPLICATION_BROWSER_ENABLED==='true'&&!!applicationProvider(job?.applyUrl||job?.url);
export function applicationProviderFor(record){
 const provider=applicationProvider(record.url);
 if(!provider||provider.id!==(record.provider||'ashby'))throw Object.assign(Error('UNSUPPORTED_EMPLOYER'),{code:'UNSUPPORTED_EMPLOYER'});
 return provider;
}
