// Read-only live acceptance check under the production adapter's network policy.
// No applicant controls are filled, no resume is uploaded, and no application is submitted.
import {inspectLeverApplication} from '../lib/lever-browser.mjs';
const url='https://jobs.lever.co/tenna/ed0a2111-ff61-40a8-aed9-23c1081d97dd/apply';
const form=await inspectLeverApplication(url);
console.log(JSON.stringify({url,title:form.title,fieldCount:form.fields.length,types:[...new Set(form.fields.map(f=>f.type))],fields:form.fields.map(f=>({label:f.label,type:f.type,required:f.required,options:f.options.length}))},null,2));
