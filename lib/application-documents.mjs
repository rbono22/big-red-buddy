const fail=code=>{throw Object.assign(new Error(code),{code,retryable:false});};

/** Recognize a letter request, never a legal declaration or an unrelated attachment. */
export function isCoverLetterField(field){
 if(!field||!['text','textarea','file'].includes(field.type)||field.multiple)return false;
 const label=String(field.label||'').replace(/[✱*]/g,'').replace(/\s+/g,' ').trim();
 if(/\b(?:resume|résumé|consent|certify|certification|agree|acknowledge|salary|sponsorship|authorization)\b/i.test(label))return false;
 return /^(?:(?:please )?(?:attach|upload|provide|write|paste|add|enter|include|submit)(?: (?:a|your|the))? )?(?:cover[ -]?letter|covering letter)(?:$|\s*[(\[.:]|\s+(?:upload|attachment|required|optional|text)\b)/i.test(label);
}

/** Resolve a specific PDF. An unsupported attachment can never receive the résumé. */
export function applicationDocument(field,{resume,coverLetter}={}){
 const cover=isCoverLetterField(field);
 if(field?.type!=='file'||field.multiple||(!cover&&field.key!=='_systemfield_resume'))fail('UNSUPPORTED_APPLICATION_DOCUMENT');
 const accept=String(field.accept||'').trim().toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
 if(accept.length&&!accept.some(x=>['.pdf','application/pdf','application/*','*/*'].includes(x)))fail('UNSUPPORTED_APPLICATION_DOCUMENT');
 const document=cover?coverLetter:resume;
 if(!document||typeof document.file!=='string'||document.file.length>17*1024*1024)fail(cover?'INVALID_COVER_LETTER':'INVALID_RESUME');
 const buffer=Buffer.from(document.file,'base64');
 if(!buffer.subarray(0,5).equals(Buffer.from('%PDF-'))||buffer.length>12*1024*1024)fail(cover?'INVALID_COVER_LETTER':'INVALID_RESUME');
 const name=String(document.name||(cover?'Cover Letter.pdf':'Resume.pdf')).replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_');
 if(!name.trim()||name.length>240||!name.toLowerCase().endsWith('.pdf'))fail('INVALID_APPLICATION_DOCUMENT_NAME');
 return {name,mimeType:'application/pdf',buffer};
}
