import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const MARKITDOWN_SCRIPT=fileURLToPath(new URL('../scripts/markitdown_extract.py',import.meta.url));
const localPython=fileURLToPath(new URL('../.venv-markitdown/bin/python',import.meta.url));

/** Operator configuration only. Never choose an executable or path from an upload. */
export async function resolveMarkItDownPython({env=process.env}={}){
 if(String(env.MARKITDOWN_ENABLED||'true').toLowerCase()==='false')return null;
 const program=env.MARKITDOWN_PYTHON||localPython;
 if(typeof program!=='string'||!path.isAbsolute(program)||/[\u0000-\u001f\u007f]/.test(program))return null;
 try{await access(program,constants.X_OK);return program;}catch{return null;}
}

/** Treat subprocess output as untrusted and preserve exact page boundaries. */
export function parseMarkItDownResult(raw,expectedPages,{maxCharacters=200000}={}){
 const invalid=()=>{throw new Error('Invalid local document conversion result.');};
 if(typeof raw!=='string'||Buffer.byteLength(raw,'utf8')>1024*1024||!Number.isSafeInteger(expectedPages)||expectedPages<1||expectedPages>6)invalid();
 let value;try{value=JSON.parse(raw);}catch{invalid();}
 if(!value||value.version!==1||value.engine!=='markitdown'||typeof value.packageVersion!=='string'||!/^\d+\.\d+\.\d+(?:[a-z0-9.+-]*)?$/.test(value.packageVersion)||!Array.isArray(value.pages)||value.pages.length!==expectedPages||value.pages.some(page=>typeof page!=='string'||/[\u0000\f]/.test(page))||value.pages.reduce((total,page)=>total+page.length,0)>maxCharacters)invalid();
 return {pages:[...value.pages],packageVersion:value.packageVersion};
}
