import {syncGoogle} from './integrations.mjs';
import {menuCard} from './telegram-menu.mjs';
export async function syncWithTelegramReceipt(store,queue,payload,{sync=syncGoogle,key}={}){
 const ids=Array.isArray(payload.eventIds)?payload.eventIds:null;
 const original=await store.get('secrets','telegram');
 let result,error;try{result=await sync(store,{eventIds:ids});}catch(e){error=e;}
 const current=await store.get('secrets','telegram');
 if(original?.chatId&&String(original.chatId)===String(current?.chatId)&&original.linkedAt===current.linkedAt&&!(await store.get('settings','account'))?.deleting){
  const text=error?'Google Calendar sync did not finish. Some changes may already be saved. Reconnect Google if authorization expired, then retry.':result.count>0?`Added or updated in Google Calendar: ${result.count} event(s).`:'Google sync finished. No eligible event updates were needed.';
  try{await menuCard(store,queue,text,error?[[['Retry sync',{retrySync:ids}],['Reconnect',{url:`${process.env.APP_ORIGIN}/#connections`}]]]:[[['My day',{page:'day'}],['Main menu',{page:'home'}]]],`calendar-result:${key}`);}catch{/* Provider outcome remains authoritative if notification queueing fails. */}
 }
 if(error)throw error;return result;
}
