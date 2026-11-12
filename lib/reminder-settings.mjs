import {HttpError} from './security.mjs';

export const REMINDER_CATEGORIES=Object.freeze(['classes','events','deadlines']);
export const DEFAULT_REMINDER_SETTINGS=Object.freeze({classes:Object.freeze([10]),events:Object.freeze([10]),deadlines:Object.freeze([1440,240])});
export const MAX_REMINDER_MINUTES=40320;
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);

function offsets(value,category){
  if(!Array.isArray(value)||value.length>50||value.some(minutes=>!Number.isInteger(minutes)||minutes<1||minutes>MAX_REMINDER_MINUTES))throw new HttpError(400,`${category} reminders must be whole minutes from 1 to 40320, or an empty list for off.`);
  const values=[...new Set(value)].sort((a,b)=>b-a);
  if(values.length>5)throw new HttpError(400,`${category} supports up to five reminder times.`);
  return values;
}

/** Resolve validated categories for domain exports; never mutate the supplied settings. */
export function resolveReminderSettings(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'Reminder settings must be an object.');
  return Object.fromEntries(REMINDER_CATEGORIES.map(category=>[category,offsets(own(value,category)?value[category]:DEFAULT_REMINDER_SETTINGS[category],category)]));
}

function patchSettings(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||!Object.keys(input).length||Object.keys(input).some(key=>!REMINDER_CATEGORIES.includes(key)))throw new HttpError(400,'Update only classes, events, or deadlines reminder settings.');
  return Object.fromEntries(Object.entries(input).map(([category,value])=>[category,offsets(value,category)]));
}

export async function readReminderSettings(store){
  const saved=await store.get('settings','reminders');
  return {...resolveReminderSettings(saved||{}),updatedAt:saved?.updatedAt||null};
}

/** Persist a validated partial update. The caller then reconciles pending reminders. */
export async function saveReminderSettings(store,input,{now=Date.now,expectedPrevious}={}){
  const patch=patchSettings(input);
  for(let attempt=0;attempt<8;attempt++){
    const previous=await store.get('settings','reminders');
    if(expectedPrevious!==undefined&&JSON.stringify(previous)!==JSON.stringify(expectedPrevious))throw new HttpError(409,'Reminder settings changed. Review a new proposal.');
    const next={...resolveReminderSettings(previous||{}),...patch,updatedAt:new Date(now()).toISOString(),revision:(Number.isSafeInteger(previous?.revision)?previous.revision:0)+1};
    if(store.compareAndSet){if(!await store.compareAndSet('settings','reminders',previous,next))continue;}
    else await store.put('settings','reminders',next);
    return {classes:next.classes,events:next.events,deadlines:next.deadlines,updatedAt:next.updatedAt};
  }
  throw new HttpError(409,'Reminder settings changed concurrently. Please retry.');
}

/** Commands contain explicit durations only; free-form model output cannot change settings. */
export function parseReminderCommand(value){
  if(typeof value!=='string'||!/^\/reminders(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(value.trim()))return null;
  const pieces=value.trim().split(/\s+/);pieces.shift();
  if(!pieces.length)return {action:'show'};
  if(pieces.length===1&&pieces[0].toLowerCase()==='reset')return {action:'reset'};
  const category=pieces.shift().toLowerCase();
  if(!REMINDER_CATEGORIES.includes(category)||!pieces.length||pieces.length>5)throw new HttpError(400,'Use /reminders classes 15m, /reminders events off, or /reminders deadlines 1d 2h.');
  if(pieces.length===1&&pieces[0].toLowerCase()==='off')return {action:'update',patch:{[category]:[]}};
  const multipliers={m:1,h:60,d:1440,w:10080};
  const values=pieces.map(piece=>{
    const match=piece.match(/^(\d{1,5})([mhdw])$/i);
    if(!match)throw new HttpError(400,'Use whole-number durations such as 15m, 2h, 1d, or 1w.');
    return Number(match[1])*multipliers[match[2].toLowerCase()];
  });
  return {action:'update',patch:{[category]:offsets(values,category)}};
}
