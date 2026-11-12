import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewResume,draftCareerAnswer} from '../lib/career.mjs';

test('saved demographic declarations never enter resume-review or application-drafting model context',async()=>{
 const rows=new Map(),key=(b,id)=>`${b}:${id}`;
 const store={async get(b,id){return rows.get(key(b,id))||null;},async put(b,id,value){rows.set(key(b,id),value);return value;},async putIfAbsent(b,id,value){if(!rows.has(key(b,id)))rows.set(key(b,id),value);return rows.get(key(b,id));}};
 await store.put('documents','resume',{name:'Synthetic.pdf',text:'Built a campus scheduling application and interviewed student users.',updatedAt:'2026-11-10T00:00:00Z'});
 await store.put('jobs','role',{id:'role',title:'Product role',description:'Interview users and define product requirements.'});
 await store.put('career','demographics',{values:{gender:'PRIVATE_GENDER',race:['PRIVATE_RACE'],disabilityStatus:'PRIVATE_DISABILITY',protectedVeteranStatus:'PRIVATE_VETERAN'}});
 await store.put('career','profile',{veteranStatus:'PRIVATE_PROFILE_VETERAN'});
 const prompts=[];
 await reviewResume(store,{generate:async prompt=>{prompts.push(prompt);return {value:{summary:'Check your outcomes.',suggestions:[],facts:{},gaps:[]}};}});
 await draftCareerAnswer(store,{jobId:'role',question:'Why this role?'},{generate:async prompt=>{prompts.push(prompt);return {value:{answer:'My user research experience fits the role.',evidence:[],gaps:[]}};}});
 assert.equal(prompts.length,2);for(const prompt of prompts)assert.doesNotMatch(prompt,/PRIVATE_(GENDER|RACE|DISABILITY|VETERAN|PROFILE_VETERAN)/);
});
