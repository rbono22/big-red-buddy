import {createHash,randomBytes} from 'node:crypto';
import {HttpError} from './security.mjs';
const BUCKET='demographicTelegramActions',DAY=86400000;
export const demographicTelegramBinding=cfg=>createHash('sha256').update(JSON.stringify([String(cfg?.chatId||''),cfg?.linkedAt||null])).digest('hex');
const fingerprint=state=>createHash('sha256').update(JSON.stringify([state.revision,state.values,state.questionnaire.active,state.questionnaire.telegramSessionActive])).digest('hex');
export async function demographicButtons(store,state,{now=Date.now}={}){
  const linked=await store.get('secrets','telegram'),at=now();
  if(!store.userId||!Number.isSafeInteger(Number(linked?.chatId))||Number(linked.chatId)<=0)throw new HttpError(400,'Link your private Telegram chat first.');
  const rows=await store.all(BUCKET),live=rows.filter(row=>row.expiresAt>at).sort((a,b)=>b.createdAt-a.createdAt);
  for(const row of rows.filter(row=>row.expiresAt<=at).concat(live.slice(240)))await store.delete(BUCKET,row.id);
  const snapshot=fingerprint(state);
  return async(text,action)=>{
    const id=randomBytes(16).toString('hex');
    await store.put(BUCKET,id,{id,action,snapshot,chatId:String(linked.chatId),binding:demographicTelegramBinding(linked),createdAt:at,expiresAt:at+DAY,status:'ready'});
    return {text,callback_data:`demo:${id}`};
  };
}
export async function claimDemographicAction(store,data,chatId,state,{now=Date.now}={}){
  if(typeof data!=='string'||!/^demo:[a-f0-9]{32}$/.test(data))throw new HttpError(400,'Open /demographics for fresh buttons.');
  const id=data.slice(5),row=await store.get(BUCKET,id),linked=await store.get('secrets','telegram');
  if(!row||row.chatId!==String(chatId)||String(linked?.chatId)!==String(chatId)||row.binding!==demographicTelegramBinding(linked)||row.expiresAt<=now())throw new HttpError(409,'These buttons expired or your Telegram link changed. Open /demographics for fresh choices.');
  if(row.status!=='ready'||row.snapshot!==fingerprint(state))throw new HttpError(409,'These choices have already changed. Use the latest buttons below.');
  const claimed={...row,status:'handling'};
  if(!await store.compareAndSet(BUCKET,id,row,claimed))throw new HttpError(409,'This choice is already being saved. Check the latest message.');
  return claimed;
}
export async function finishDemographicAction(store,row){await store.compareAndSet(BUCKET,row.id,row,{...row,status:'handled'});}
