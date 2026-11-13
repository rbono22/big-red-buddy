// Reuse explicit profile declarations only when the employer asks the same
// question. No resume, model, nationality, or demographic inference is used.
const normalize=value=>String(value??'').normalize('NFKC').replace(/[\s\u00a0]+/g,' ').trim().replace(/[?!.:*]+$/,'').trim().toLowerCase();
const labels={
 workAuthorizationUS:[
  'Are you legally authorized to work in the United States',
  'Are you authorized to work in the United States',
  'Are you legally eligible to work in the United States',
  'Are you legally authorized to work in the US',
  'Are you authorized to work in the US',
  'Are you legally authorized to work in the U.S.',
  'Are you authorized to work in the U.S.'
 ],
 sponsorship:[
  'Will you now or in the future require sponsorship for employment visa status',
  'Will you now or in the future require visa sponsorship for employment',
  'Do you now or in the future require sponsorship for employment visa status',
  'Will you now or in the future require sponsorship for employment visa status in the United States',
  'Will you now or in the future require visa sponsorship to work in the United States'
 ]
};
const supported=new Set(['yes','no','not applicable','prefer not to answer','decline to answer']);
// Employers word these two questions many ways. Match only US-specific yes/no
// questions with the same meaning as the saved declaration:
//  - authorization: "authorized/eligible ... to work ... United States/U.S."
//  - sponsorship: "require/need ... sponsorship" covering now AND future
// A "now"-only sponsorship question can have a different answer (e.g. OPT), so it is never matched.
// Checked against the original wording so the pronoun "us" never counts as the country.
const US=/\b(?:United States|U\.S\.(?:A\.?)?|U\.S\b|USA\b|US\b)/;
const OTHER=/\b(?:canada|uk|united kingdom|ireland|europe|eu|australia|india|country for which|any country|other country)\b/;
function patternKey(label,original){
 // One question only: no negation, combined clause, certification, or transfer.
 if(!US.test(original)||OTHER.test(label)||/\b(?:not|and|also|relocate|certify|confirm|attest|acknowledge|transfer)\b/.test(label)||(String(original).match(/\?/g)||[]).length>1)return null;
 if(/\bsponsor/.test(label))return /^(?:will|do) you\b/.test(label)&&/\b(?:require|need)\b/.test(label)&&/\bnow\b/.test(label)&&/\bfuture\b/.test(label)?'sponsorship':null;
 // Present tense only: "Will you be authorized" asks about a future state.
 if(/^are you (?:currently )?(?:legally |lawfully )?(?:authori[sz]ed|eligible) to work\b/.test(label)&&!/\b(?:if|opt|stem|extension|visa)\b/.test(label))return 'workAuthorizationUS';
 return null;
}
export function employmentProfileField(field){
 if(!field||!['radio','select','yesno'].includes(field.type)||field.multiple||typeof field.label!=='string'||!Array.isArray(field.options)||field.options.length<2||field.options.length>5||field.options.some(option=>typeof option!=='string'))return null;
 const options=field.options.map(normalize);
 if(new Set(options).size!==options.length||!options.includes('yes')||!options.includes('no')||options.some(option=>!supported.has(option)))return null;
 const label=normalize(field.label);
 const key=Object.keys(labels).find(key=>labels[key].some(value=>normalize(value)===label))||patternKey(label,String(field.label));
 if(field.profileField&&field.profileField!==key)return null;
 return key;
}
export function savedEmploymentProfileAnswer(field,profile){
 const key=employmentProfileField(field),value=key&&profile?.[key];
 if(value!=='yes'&&value!=='no')return null;
 return field.options.find(option=>normalize(option)===value)||null;
}
