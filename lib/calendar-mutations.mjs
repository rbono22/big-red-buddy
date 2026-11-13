import {randomUUID} from 'node:crypto';
import {idFor} from './domain.mjs';
import {HttpError} from './security.mjs';

// Separate from source rows: re-importing a source must not undo a removal.
export const calendarTombstoneIds = ({localId,calendarId,remoteId}={}) => [
  ...(localId?[idFor('calendar-removed-local',localId)]:[]),
  ...(calendarId&&remoteId?[idFor('calendar-removed-remote',calendarId,remoteId)]:[])
];
export async function calendarEventRemoved(store,target){
  for(const id of calendarTombstoneIds(target))if(await store.get('calendarDeletionTombstones',id))return true;
  return false;
}
export async function writeCalendarTombstones(store,target,{proposalId,status='pending',at=new Date().toISOString()}={}){
  for(const id of calendarTombstoneIds(target))await store.put('calendarDeletionTombstones',id,{id,...target,proposalId,status,updatedAt:at});
}

// Serialize all writes to a student's Google calendars across worker processes.
// Renew immediately before each request. A lease is longer than the bounded
// Google request timeout, so a lost worker cannot overlap a new mutation.
export async function withCalendarMutationLock(store,operation,{now=Date.now}={}){
  const key='calendarMutationLock',owner=randomUUID(),ttl=120000;
  let lock={owner,expiresAt:now()+ttl};
  if(!store.compareAndSet||!store.putIfAbsent)throw new HttpError(503,'Calendar editing needs durable storage.');
  const previous=await store.putIfAbsent('settings',key,lock);
  if(previous.owner!==owner){
    if(previous.expiresAt>now()||!await store.compareAndSet('settings',key,previous,lock))throw new HttpError(409,'Another calendar update is running. Try again shortly.');
  }
  async function renew(){
    const next={owner,expiresAt:now()+ttl};
    if(lock.expiresAt<=now()||!await store.compareAndSet('settings',key,lock,next))throw new HttpError(409,'The calendar update lease expired. Please try again.');
    lock=next;
  }
  try{return await operation(renew);}
  finally{await store.compareAndSet('settings',key,lock,{owner,expiresAt:0});}
}
