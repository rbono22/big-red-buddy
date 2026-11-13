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
export function employmentProfileField(field){
 if(!field||!['radio','select','yesno'].includes(field.type)||field.multiple||typeof field.label!=='string'||!Array.isArray(field.options)||field.options.length<2||field.options.length>5||field.options.some(option=>typeof option!=='string'))return null;
 const options=field.options.map(normalize);
 if(new Set(options).size!==options.length||!options.includes('yes')||!options.includes('no')||options.some(option=>!supported.has(option)))return null;
 const label=normalize(field.label);
 const key=Object.keys(labels).find(key=>labels[key].some(value=>normalize(value)===label))||null;
 if(field.profileField&&field.profileField!==key)return null;
 return key;
}
export function savedEmploymentProfileAnswer(field,profile){
 const key=employmentProfileField(field),value=key&&profile?.[key];
 if(value!=='yes'&&value!=='no')return null;
 return field.options.find(option=>normalize(option)===value)||null;
}
