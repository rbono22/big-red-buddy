import {HttpError} from './security.mjs';

export async function readJobDiscoverySettings(store){const raw=await store.get('settings','jobDiscovery');return {stretchYears:[2,3].includes(raw?.stretchYears)?raw.stretchYears:3};}
export async function saveJobDiscoverySettings(store,input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'stretchYears')||![2,3].includes(input.stretchYears))throw new HttpError(400,'Choose a stretch range of 2 or 3 additional years.');
 for(let attempt=0;attempt<8;attempt++){const previous=await store.get('settings','jobDiscovery'),next={stretchYears:input.stretchYears,revision:(previous?.revision||0)+1,updatedAt:new Date().toISOString()};if(await store.compareAndSet('settings','jobDiscovery',previous,next))return readJobDiscoverySettings(store);}
 throw new HttpError(409,'Job preferences changed. Refresh and retry.');
}
