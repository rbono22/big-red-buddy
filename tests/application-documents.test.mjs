import test from 'node:test';
import assert from 'node:assert/strict';
import {applicationDocument,isCoverLetterField} from '../lib/application-documents.mjs';
const pdf=text=>Buffer.from('%PDF-1.7\n'+text).toString('base64');
test('only explicit cover letter fields authorize generated letter content',()=>{
 for(const label of ['Cover letter','Cover Letter (required)','Upload your cover letter','Please attach a cover letter','Cover letter: tell us why you want this role'])for(const type of ['text','textarea','file'])assert.equal(isCoverLetterField({label,type}),true,label);
 for(const label of ['Why this company?','Resume and cover letter','I consent to using my cover letter','Cover letter certification','Cover letter salary history','Upload your portfolio','Do you have a cover letter?'])assert.equal(isCoverLetterField({label,type:'textarea',key:'cover_letter'}),false,label);
 assert.equal(isCoverLetterField({label:'Cover letter',type:'checkbox'}),false);
 assert.equal(isCoverLetterField({label:'Cover letter',type:'file',multiple:true}),false);
});
test('application documents route distinct PDF bytes to their own fields and never fall back to resume',()=>{
 const resume={name:'Resume.pdf',file:pdf('RESUME')},coverLetter={name:'Cover Letter.pdf',file:pdf('COVER')},cover={key:'cover',label:'Cover letter',type:'file'};
 assert.equal(applicationDocument(cover,{resume,coverLetter}).buffer.toString(),'%PDF-1.7\nCOVER');
 assert.equal(applicationDocument({key:'_systemfield_resume',label:'Resume',type:'file'},{resume,coverLetter}).buffer.toString(),'%PDF-1.7\nRESUME');
 assert.throws(()=>applicationDocument(cover,{resume}),/INVALID_COVER_LETTER/);
 assert.throws(()=>applicationDocument({key:'portfolio',label:'Portfolio',type:'file'},{resume,coverLetter}),/UNSUPPORTED_APPLICATION_DOCUMENT/);
 for(const field of [{...cover,accept:'.docx'},{...cover,multiple:true}])assert.throws(()=>applicationDocument(field,{resume,coverLetter}),/UNSUPPORTED_APPLICATION_DOCUMENT/);
 assert.throws(()=>applicationDocument(cover,{resume,coverLetter:{...coverLetter,file:Buffer.from('not PDF').toString('base64')}}),/INVALID_COVER_LETTER/);
});
