import {HttpError} from './security.mjs';
const LIMIT=12*1024*1024;
export function enrollmentAttachment(message){
  if(message.photo?.length){const p=[...message.photo].filter(x=>typeof x.file_id==='string').sort((a,b)=>(b.width*b.height)-(a.width*a.height))[0];if(!p)throw new HttpError(400,'Photo could not be read.');if(p.file_size>LIMIT)throw new HttpError(400,'Send a photo smaller than 12 MB.');return {fileId:p.file_id,mimeType:'image/jpeg',name:'Telegram enrollment photo.jpg'};}
  const d=message.document;if(!d)return null;
  if(!['application/pdf','image/jpeg','image/png'].includes(d.mime_type)||typeof d.file_id!=='string')throw new HttpError(400,'Send your enrollment PDF, JPEG, or PNG image.');
  if(d.file_size>LIMIT)throw new HttpError(400,'Send a file smaller than 12 MB.');
  return {fileId:d.file_id,mimeType:d.mime_type,name:String(d.file_name||'Enrollment document').replace(/[\/\\\u0000-\u001f]/g,'_').slice(0,160)};
}
export async function downloadTelegramEnrollment(fileId,{fetchImpl=fetch,token=process.env.TELEGRAM_BOT_TOKEN}={}){
  if(!token||typeof fileId!=='string'||fileId.length>500)throw new HttpError(400,'Telegram file is unavailable.');
  try{
    const meta=await fetchImpl(`https://api.telegram.org/bot${token}/getFile`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_id:fileId}),redirect:'error',signal:AbortSignal.timeout(15000)});
    const value=await meta.json();const path=value.result?.file_path;
    if(!meta.ok||!value.ok||typeof path!=='string'||!/^[-A-Za-z0-9_./]+$/.test(path)||path.startsWith('/')||path.split('/').includes('..')||value.result?.file_size>LIMIT)throw new Error();
    const r=await fetchImpl(`https://api.telegram.org/file/bot${token}/${path}`,{redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!r.ok||r.redirected||Number(r.headers.get('content-length')||0)>LIMIT)throw new Error();
    const reader=r.body.getReader(),chunks=[];let total=0;
    try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>LIMIT)throw new Error();chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    return Buffer.concat(chunks);
  }catch{throw new HttpError(400,'The Telegram file could not be downloaded safely. Try a PDF/JPEG/PNG smaller than 12 MB, or upload it in Academics.');}
}
