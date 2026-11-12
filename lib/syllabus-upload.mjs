import path from 'node:path';
import {HttpError} from './security.mjs';
import {idFor} from './domain.mjs';
import {validateEnrollmentUpload,readLocalDocumentText} from './enrollment.mjs';
import {extractEvents,persistCandidates} from './ingest.mjs';

export async function processSyllabusUpload(store,payload,{read=readLocalDocumentText,extract=extractEvents}={}) {
 const mimeType=payload.mimeType==='image/jpg'?'image/jpeg':payload.mimeType||'application/pdf',term=payload.term||'FA26';
 if(!['FA26','SP27'].includes(term))throw new HttpError(400,'Choose Fall 2026 or Spring 2027.');
 const buffer=validateEnrollmentUpload({...payload,mimeType}),name=path.basename(String(payload.name||'Syllabus').replaceAll('\\','/')).replace(/[\u0000-\u001f]/g,'').slice(0,160);
 let document;
 try {document=await read({buffer,mimeType,name,term});}
 catch {const error=new HttpError(400,'Could not read the syllabus. Send a clearer JPG/PNG or an unlocked PDF of up to 6 pages (up to 4 scanned pages).','SYLLABUS_OCR_FAILED');error.retryable=false;throw error;}
 if(!document.text||document.text.length>55000){const error=new HttpError(400,'Send fewer syllabus pages containing the deadline dates and rules.','SYLLABUS_OCR_FAILED');error.retryable=false;throw error;}
 let result;
 try {result=await extract(document.text,'syllabus',process.env.OLLAMA_MODEL,{deadlinesOnly:true,academicTerm:term==='SP27'?'Spring 2027':'Fall 2026'});}
 catch {throw new HttpError(503,'Deadline extraction could not finish. Check that the page includes dates, try a clearer image, and check private model availability.','SYLLABUS_EXTRACTION_FAILED');}
 const events=(result.events||[]).filter(e=>['assignment','quiz','exam','studio'].includes(e.kind));
 if(!events.length) {const error=new HttpError(400,'No assignment, quiz, or exam dates were found. Upload the pages containing deadlines.','SYLLABUS_EXTRACTION_FAILED');error.retryable=false;throw error;}
 // Independent photos with the same camera filename must not replace each
 // other's deadlines. PDFs retain the existing named-document update behavior.
 const sourceId=mimeType==='application/pdf'?idFor('syllabus',name):idFor('syllabus-image',payload.base64,term);
 const method=`${document.method}; ${result.method}`;
 // Earlier PDF imports also contained class meetings. A deadlines-only update
 // must not interpret those deliberately omitted meetings as cancellations.
 await persistCandidates(store,{id:sourceId,name,type:'syllabus',hash:idFor(payload.base64),method},events,{reconcileKinds:['assignment','quiz','exam','studio']});
 return {count:events.length,method,metrics:result.metrics};
}
