// Deterministic suggestions from explicit student preferences. No resume/model
// input, sensitive inference, automatic answer acceptance or employer submission.
const clean=value=>String(value??'').normalize('NFKC').replace(/[’]/g,"'").replace(/[\s\u00a0]+/g,' ').trim().replace(/[.?!:*]+$/,'').trim().toLowerCase();
const decline=['Prefer not to answer','Prefer not to say','Decline to answer','Decline to self-identify','I do not wish to answer',"I don't wish to answer",'I do not want to answer','I do not wish to disclose',"I don't wish to disclose"];
const labels={
 gender:['Gender','Gender identity','Your gender','Please select your gender','What is your gender','What is your gender identity','How do you describe your gender identity'],
 veteranStatus:['Veteran status','Veteran','Are you a veteran','Please select your veteran status'],
 protectedVeteranStatus:['Protected veteran status','Protected veteran','Are you a protected veteran','Please select your protected veteran status'],
 disabilityStatus:['Disability status','Disability','Do you have a disability or a history of a disability','Do you have a disability or a history of one','Do you have a disability or have you ever had one'],
 ethnicity:['Ethnicity','Hispanic or Latino','Are you Hispanic or Latino','Do you identify as Hispanic or Latino'],
 race:['Race','Racial identity','Please select your race','What is your race','Race (select all that apply)']
};
const aliases={
 gender:{male:['Male','Man'],female:['Female','Woman'],non_binary:['Non-binary','Nonbinary'],decline},
 veteranStatus:{veteran:['Veteran','I am a veteran','Yes'],non_veteran:['Not a veteran','I am not a veteran','No'],decline},
 protectedVeteranStatus:{protected:['Protected veteran','I am a protected veteran','I identify as one or more of the classifications of protected veteran listed above','Yes'],not_protected:['Not a protected veteran','I am not a protected veteran','No'],unsure:['Unsure','Not sure'],decline},
 disabilityStatus:{yes:['Yes','Yes, I have a disability or a history of one','Yes, I have a disability or have had one in the past','Yes, I have a disability, or have had one in the past'],no:['No','No, I do not have a disability and have not had one in the past',"No, I don't have a disability, or a history/record of having a disability"],decline},
 ethnicity:{hispanic:['Hispanic or Latino'],not_hispanic:['Not Hispanic or Latino'],decline},
 race:{american_indian_alaska_native:['American Indian or Alaska Native'],asian:['Asian'],black_african_american:['Black or African American'],native_hawaiian_pacific_islander:['Native Hawaiian or Pacific Islander','Native Hawaiian or Other Pacific Islander'],white:['White'],middle_eastern_north_african:['Middle Eastern or North African'],decline}
};
function exactOption(options,accepted){
 if(!accepted)return null;const names=new Set(accepted.map(clean)),found=options.filter(option=>names.has(clean(option)));
 return found.length===1?found[0]:null;
}
export function savedDemographicSuggestion(field,demographics){
 if(!field||typeof field.label!=='string'||!['select','radio','checkbox','yesno'].includes(field.type)||!Array.isArray(field.options)||!field.options.length||field.options.length>300||field.options.some(o=>typeof o!=='string'||!o.trim()||o.length>2400)||new Set(field.options.map(clean)).size!==field.options.length)return null;
 const label=clean(field.label);let kind=Object.keys(labels).find(key=>labels[key].some(v=>clean(v)===label));if(!kind)return null;
 // A generic veteran heading with explicitly protected-veteran choices must
 // use the separate protected preference, never ordinary military status.
 if(kind==='veteranStatus'&&field.options.some(o=>/\bprotected veteran\b/i.test(o))){
  const substantive=field.options.filter(o=>!decline.some(d=>clean(d)===clean(o)));
  if(!substantive.length||substantive.some(o=>!aliases.protectedVeteranStatus.protected.concat(aliases.protectedVeteranStatus.not_protected,aliases.protectedVeteranStatus.unsure).filter(a=>!['yes','no'].includes(clean(a))).some(a=>clean(a)===clean(o))))return null;
  kind='protectedVeteranStatus';
 }
 const values=demographics?.values;if(!values||typeof values!=='object'||Array.isArray(values)||!Object.hasOwn(values,kind))return null;
 const saved=values[kind];let choices;
 if(kind==='race'){
  if(!Array.isArray(saved)||!saved.length||new Set(saved).size!==saved.length||saved.length>1&&(saved.includes('decline')||!field.multiple))return null;
  choices=saved.map(value=>typeof value==='string'&&Object.hasOwn(aliases.race,value)?exactOption(field.options,aliases.race[value]):null);
 }else{
  if(field.multiple||typeof saved!=='string'||!Object.hasOwn(aliases[kind],saved))return null;
  let accepted=aliases[kind][saved];
  if(kind==='disabilityStatus'&&saved==='yes'&&!/history|ever had/.test(label))accepted=accepted.filter(option=>option!=='Yes');
  // Yes/No is unambiguous only when the question explicitly asks the Hispanic
  // or Latino question. Never derive ethnicity from a saved race category.
  if(kind==='ethnicity'&&label!=='ethnicity'&&['hispanic','not_hispanic'].includes(saved))accepted=accepted.concat(saved==='hispanic'?['Yes']:['No']);
  choices=[exactOption(field.options,accepted)];
 }
 if(!choices.length||choices.some(choice=>!choice)||new Set(choices).size!==choices.length)return null;
 // Preserve the employer's own option order for multi-selection review.
 const value=(field.multiple?field.options.filter(option=>choices.includes(option)):choices).join('\n');
 return {value,source:'saved demographic preference',reviewed:false,demographicField:kind,preferenceRevision:typeof demographics.revision==='string'?demographics.revision:null,note:'From your saved optional preference. Check the employer’s wording before using this answer.'};
}
