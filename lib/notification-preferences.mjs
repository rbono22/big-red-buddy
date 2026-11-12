import {HttpError} from './security.mjs';

export const NOTIFICATION_TOPICS=Object.freeze(['school','events','jobs','news','games']);
export const NOTIFICATION_MODES=Object.freeze(['off','daily','alerts','both']);
export const NOTIFICATION_AVAILABILITY=Object.freeze({school:true,events:true,jobs:true,news:true,games:false});
export const DEFAULT_NOTIFICATION_PREFERENCES=Object.freeze({enabled:true,topics:Object.freeze({school:'both',events:'both',jobs:'both',news:'off',games:'off'})});
export const FRESH_NOTIFICATION_PREFERENCES=Object.freeze({enabled:true,topics:Object.freeze({school:'off',events:'off',jobs:'off',news:'off',games:'off'})});
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
function view(raw){
 const existing=raw!==null&&raw!==undefined,value=object(raw)?raw:existing?{enabled:false,topics:{}}:DEFAULT_NOTIFICATION_PREFERENCES;
 const topics=Object.fromEntries(NOTIFICATION_TOPICS.map(topic=>[topic,NOTIFICATION_MODES.includes(value.topics?.[topic])?value.topics[topic]:'off']));
 return {enabled:typeof value.enabled==='boolean'?value.enabled:false,topics,available:{...NOTIFICATION_AVAILABILITY},revision:Number.isSafeInteger(value.revision)&&value.revision>=0?value.revision:0,updatedAt:typeof value.updatedAt==='string'?value.updatedAt:null};
}
function requireStore(store,{write=false}={}){if(!store?.userId||typeof store.get!=='function'||write&&typeof store.compareAndSet!=='function')throw new Error('Notification preferences require a student-owned store.');}
function patch(input){
 if(!object(input)||!Object.keys(input).length||Object.keys(input).some(key=>!['enabled','topics'].includes(key)))throw new HttpError(400,'Update notification enabled or topic modes only.');
 if(own(input,'enabled')&&typeof input.enabled!=='boolean')throw new HttpError(400,'Notification enabled must be true or false.');
 if(own(input,'topics')&&(!object(input.topics)||!Object.keys(input.topics).length||Object.keys(input.topics).some(topic=>!NOTIFICATION_TOPICS.includes(topic)||!NOTIFICATION_MODES.includes(input.topics[topic]))))throw new HttpError(400,'Use school, events, jobs, news, or games with off, daily, alerts, or both.');
 return {...(own(input,'enabled')?{enabled:input.enabled}:{}),...(own(input,'topics')?{topics:{...input.topics}}:{})};
}
export async function readNotificationPreferences(store){requireStore(store);return view(await store.get('settings','notifications'));}
export async function saveNotificationPreferences(store,input,{updateId,now=Date.now,expectedPrevious}={}){
 requireStore(store,{write:true});const update=patch(input),at=typeof now==='function'?now():now;
 if(!Number.isFinite(at))throw new HttpError(400,'Use a valid preference time.');
 if(updateId!==undefined&&(!Number.isSafeInteger(updateId)||updateId<0))throw new HttpError(400,'Invalid Telegram update ID.');
 for(let attempt=0;attempt<12;attempt++){
  const previous=await store.get('settings','notifications'),current=view(previous);
  if(expectedPrevious!==undefined&&JSON.stringify(previous)!==JSON.stringify(expectedPrevious))throw new HttpError(409,'Notification settings changed. Review a new proposal.');
  // Telegram may choose a new update sequence after a week without updates.
  // Within that replay window, old commands cannot undo a later web/bot choice.
  if(updateId!==undefined&&previous?.lastTelegramUpdateId>=updateId&&at>=previous.lastTelegramUpdateAt&&at-previous.lastTelegramUpdateAt<7*86400000)return {...current,replayed:true};
  const next={...previous,enabled:own(update,'enabled')?update.enabled:current.enabled,topics:{...current.topics,...update.topics},revision:current.revision+1,updatedAt:new Date(at).toISOString(),...(updateId!==undefined?{lastTelegramUpdateId:updateId,lastTelegramUpdateAt:at}:{})};
  if(await store.compareAndSet('settings','notifications',previous,next))return view(next);
 }
 throw new HttpError(409,'Notification preferences changed concurrently. Refresh and retry.');
}
export function notificationAllowed(preferences,topic,channel,{ignoreMaster=false}={}){
 if(!NOTIFICATION_TOPICS.includes(topic)||!['daily','alerts'].includes(channel)||!NOTIFICATION_AVAILABILITY[topic]||(!ignoreMaster&&preferences?.enabled!==true))return false;
 return preferences?.topics?.[topic]===channel||preferences?.topics?.[topic]==='both';
}
export function activeDailyTopics(preferences,options){return NOTIFICATION_TOPICS.filter(topic=>notificationAllowed(preferences,topic,'daily',options));}
export function notificationPreferencesText(preferences){
 return [`Proactive notifications: ${preferences.enabled?'on':'off'}.`,...NOTIFICATION_TOPICS.map(topic=>`${topic}: ${preferences.topics[topic]}${NOTIFICATION_AVAILABILITY[topic]?'':' (not available yet; preference saved for when available)'}`),'Daily means your morning briefing; alerts means separate reminders or updates. Only available topics are delivered.','/notifications <topic> daily|alerts|both|off','/notifications off pauses proactive delivery; /notifications on restores your saved choices. Explicit replies still work.','Set the briefing time with /briefing HH:mm (New York).'].join('\n');
}
