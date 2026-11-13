// Standing consent authorization ("Application autopilot → consents").
// The student explicitly chose to let BRB accept every consent, certification,
// acknowledgment, and agreement control on employer forms. This module only
// decides which controls qualify and which choice is the affirmative one.
// It never answers multi-select questions, free text, files, or demographic facts.
export const STANDING_CONSENT_SOURCE='standing consent authorization';

const CONSENT_WORDS=/\b(?:consent\w*|agree\w*|certif\w*|terms|privacy|acknowledg\w*|accept\w*|confirm\w*|understand|understood|attest\w*|authori[sz]e|declar\w*|polic(?:y|ies)|notice|gdpr|ccpa|data (?:processing|protection|retention)|process(?:ing)? (?:of )?my|retain|retention|i have read)\b/i;
const NEGATIVE=/\b(?:no|not|don'?t|do not|decline\w*|disagree\w*|refuse\w*|opt[- ]?out|withdraw\w*|reject\w*)\b/i;
const AFFIRMATIVE=/^(?:yes|y|true|ok(?:ay)?|i (?:agree|accept|acknowledge|consent|confirm|understand|certify|attest|authorize|authorise|have read)|agreed?|accept(?:ed)?|acknowledged?|consent|confirm(?:ed)?|understood|certif(?:y|ied))\b/i;
const norm=value=>String(value??'').replace(/\s+/g,' ').trim();

export const autopilotConsents=profile=>profile?.applicationAutopilot?.consents===true;

/** The single affirmative option, or null when there is none or more than one. */
export function affirmativeOption(options=[]){
  const matches=options.filter(option=>{const text=norm(option);return AFFIRMATIVE.test(text)&&!NEGATIVE.test(text);});
  return matches.length===1?matches[0]:null;
}

/** True for a single consent-type control whose label states a consent, certification, acknowledgment, or agreement. */
export function isStandingConsentField(field){
  if(!field||field.multiple||!Array.isArray(field.options))return false;
  if(field.type==='consent')return true;
  if(!CONSENT_WORDS.test(norm(field.label)))return false;
  return ['checkbox','radio','select','yesno'].includes(field.type);
}

/** The value BRB submits under the standing authorization, or null when it does not apply. */
export function standingConsentAnswer(field,profile){
  if(!autopilotConsents(profile)||!isStandingConsentField(field))return null;
  // A single checkbox is checked by answering "Yes" (all adapters use the ['Yes','No'] shape).
  if(field.type==='checkbox')return field.options.includes('Yes')?'Yes':null;
  return affirmativeOption(field.options);
}

/** Labels of consent controls accepted for the student, for the receipt and audit trail. */
export function acceptedConsentLabels(form,answers){
  return (form?.fields||[]).filter(field=>answers?.[field.key]?.source===STANDING_CONSENT_SOURCE&&answers[field.key].value!==null).map(field=>norm(field.label).slice(0,300));
}
