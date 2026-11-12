import {randomBytes} from 'node:crypto';
import {idFor} from './domain.mjs';
import {HttpError} from './security.mjs';

const choices=entries=>Object.freeze(entries.map(([value,label])=>Object.freeze({value,label})));
const end=[['decline','Prefer not to answer'],['unanswered','Skip this question']];
export const DEMOGRAPHIC_FIELDS=Object.freeze([
  {field:'veteranStatus',label:'Veteran status',prompt:'Optional: which veteran status would you like to save?',options:choices([['veteran','Veteran'],['non_veteran','Not a veteran'],...end])},
  {field:'protectedVeteranStatus',label:'Protected veteran status',prompt:'Optional: which protected veteran status would you like to save? This is separate from veteran status; choose unsure if you do not know.',options:choices([['protected','Protected veteran'],['not_protected','Not a protected veteran'],['unsure','Unsure'],...end])},
  {field:'disabilityStatus',label:'Disability status',prompt:'Optional: do you have a disability or a history of one? No medical details are requested.',options:choices([['yes','Yes, I have a disability or a history of one'],['no','No'],...end])},
  {field:'ethnicity',label:'Ethnicity',prompt:'Optional ethnicity preference: would you like to identify as Hispanic or Latino?',options:choices([['hispanic','Hispanic or Latino'],['not_hispanic','Not Hispanic or Latino'],...end])},
  {field:'race',label:'Race',prompt:'Optional: which race categories would you like to save? You may choose more than one. Employer labels can differ.',multiple:true,options:choices([['american_indian_alaska_native','American Indian or Alaska Native'],['asian','Asian'],['black_african_american','Black or African American'],['native_hawaiian_pacific_islander','Native Hawaiian or Pacific Islander'],['white','White'],['middle_eastern_north_african','Middle Eastern or North African'],['other','Another category'],...end])},
  {field:'gender',label:'Gender',prompt:'Optional: which gender preference would you like to save? No free-text identity description is required here.',options:choices([['male','Male'],['female','Female'],['non_binary','Non-binary'],['other','Self-describe on the employer form'],...end])}
].map(definition=>Object.freeze({...definition,optional:true})));
export const definitions=DEMOGRAPHIC_FIELDS;
const FIELDS=DEMOGRAPHIC_FIELDS.map(item=>item.field),recordId='demographics';
const time=()=>new Date().toISOString(),token=()=>randomBytes(16).toString('hex');
const defaultValues=()=>Object.fromEntries(FIELDS.map(field=>[field,field==='race'?['unanswered']:'unanswered']));
const missing=(field,value)=>field==='race'?!value?.length||value.includes('unanswered'):!value||value==='unanswered';
function definition(field){const result=DEMOGRAPHIC_FIELDS.find(item=>item.field===field);if(!result)throw new HttpError(400,'Choose a supported demographic field.');return result;}
function validate(field,value){
  const spec=definition(field),allowed=spec.options.map(option=>option.value);
  if(spec.multiple){
    if(!Array.isArray(value)||!value.length||value.length>9||value.some(item=>typeof item!=='string'||!allowed.includes(item)))throw new HttpError(400,'Choose one or more supported race categories, or decline/skip.');
    const result=[...new Set(value)];if(result.length>1&&result.some(item=>['decline','unanswered'].includes(item)))throw new HttpError(400,'Decline or skip cannot be combined with another race category.');return allowed.filter(item=>result.includes(item));
  }
  if(typeof value!=='string'||!allowed.includes(value))throw new HttpError(400,`Choose a supported value for ${field}.`);return value;
}
function updateHash(value){if(value===undefined||value===null)return null;const text=String(value);if(!/^[A-Za-z0-9:_-]{1,160}$/.test(text))throw new HttpError(400,'Invalid questionnaire update identifier.');return idFor('demographic-update',text);}
function initial(){return {version:1,values:Object.fromEntries(FIELDS.filter(field=>field!=='veteranStatus').map(field=>[field,field==='race'?['unanswered']:'unanswered'])),questionnaire:{invitedAt:null,invitationId:null,invitationUpdateHash:null,startedAt:null,completedAt:null,skippedAllAt:null,askedFields:[],answeredFields:[],skippedFields:[],active:null,remainingFields:[],editMode:false},handledUpdates:[],revision:0};}
function profileVeteran(profile){return ['veteran','non_veteran','decline','unanswered'].includes(profile?.veteranStatus)?profile.veteranStatus:'unanswered';}
function view(record,profile){
  const values={...defaultValues(),...record.values,veteranStatus:profileVeteran(profile)},q=structuredClone(record.questionnaire);
  if(!missing('veteranStatus',values.veteranStatus)&&!q.answeredFields.includes('veteranStatus'))q.answeredFields.push('veteranStatus');
  delete q.invitationUpdateHash;delete q.remainingFields;delete q.editMode;
  return {values,questionnaire:q,revision:`r${Number.isSafeInteger(record.revision)?record.revision:0}.p${Number.isSafeInteger(profile?.revision)?profile.revision:0}`,note:'Optional student preferences, not an official employer or government form. Answers are not inferred, submitted, or sent to the model.'};
}
function question(active){if(!active)return null;const spec=definition(active.field);return {...spec,token:active.token,...(spec.multiple?{selected:active.selected||[]}: {})};}
async function cas(store,previous,next){if(store.compareAndSet)return store.compareAndSet('career',recordId,previous,next);await store.put('career',recordId,next);return true;}

// Veteran status has one canonical value in career/profile. A small durable intent
// bridges the two encrypted records and recovers after a process restart. A newer
// explicit veteran edit wins instead of being overwritten by a delayed sync.
async function flushVeteran(store){
  for(let attempt=0;attempt<8;attempt++){
    const record=await store.get('career',recordId),pending=record?.profileWrite;if(!pending)return;
    const profile=await store.get('career','profile'),current=profileVeteran(profile);
    if(current!==pending.value&&current===pending.expected){
      const next={...(profile||{}),veteranStatus:pending.value,updatedAt:time(),revision:(Number.isSafeInteger(profile?.revision)?profile.revision:0)+1,source:'student-entered'};
      if(store.compareAndSet){if(!await store.compareAndSet('career','profile',profile,next))continue;}else await store.put('career','profile',next);
    }
    const latest=await store.get('career',recordId);if(latest?.profileWrite?.id!==pending.id)continue;
    const next={...latest};delete next.profileWrite;if(await cas(store,latest,next))return;
  }
  throw new HttpError(409,'Questionnaire preferences changed concurrently. Please retry.');
}
async function read(store){await flushVeteran(store);return {record:(await store.get('career',recordId))||initial(),profile:await store.get('career','profile')};}
export async function getDemographics(store){const {record,profile}=await read(store);return view(record,profile);}

async function transition(store,updateId,action){
  const hash=updateHash(updateId);
  for(let attempt=0;attempt<12;attempt++){
    await flushVeteran(store);const previous=await store.get('career',recordId),record=structuredClone(previous||initial()),profile=await store.get('career','profile'),state=view(record,profile);
    if(hash&&record.handledUpdates.includes(hash))return {question:null,state,duplicate:true};
    record.questionnaire.answeredFields=[...state.questionnaire.answeredFields];
    const result=action(record,state,profile)||{};
    if(result.noWrite)return {...result,question:result.question||null,state};
    if(hash)record.handledUpdates=[...record.handledUpdates,hash].slice(-120);
    record.revision++;record.updatedAt=time();if(!await cas(store,previous,record))continue;
    await flushVeteran(store);return {...result,question:result.question||null,state:await getDemographics(store),duplicate:false};
  }
  throw new HttpError(409,'Questionnaire changed concurrently. Please retry.');
}
function nextQuestion(record,state){
  const q=record.questionnaire;let field;
  while(q.remainingFields.length){const candidate=q.remainingFields.shift();if(q.editMode||missing(candidate,state.values[candidate])){field=candidate;break;}}
  if(!field){q.active=null;q.completedAt=time();return null;}
  q.active={field,token:token(),...(field==='race'?{selected:state.values.race.filter(value=>!['unanswered','decline'].includes(value))}:{})};if(!q.askedFields.includes(field))q.askedFields.push(field);return question(q.active);
}
function markField(record,state,profile,field,value){
  const q=record.questionnaire;
  if(field==='veteranStatus')record.profileWrite={id:token(),value,expected:profileVeteran(profile)};
  else record.values[field]=value;
  state.values[field]=value;
  const skipped=missing(field,value),target=skipped?'skippedFields':'answeredFields',other=skipped?'answeredFields':'skippedFields';
  if(!q[target].includes(field))q[target].push(field);q[other]=q[other].filter(item=>item!==field);
}

export async function inviteDemographics(store,{updateId}={}){
  const hash=updateHash(updateId);
  for(let attempt=0;attempt<12;attempt++){
    const {record,profile}=await read(store),q=record.questionnaire;
    if(q.invitedAt||q.startedAt||q.completedAt||q.skippedAllAt)return {shouldInvite:!!hash&&hash===q.invitationUpdateHash&&!q.startedAt&&!q.completedAt&&!q.skippedAllAt,invitationId:q.invitationId,state:view(record,profile)};
    const previous=await store.get('career',recordId);if(previous&&previous.revision!==record.revision)continue;
    const next=structuredClone(record);next.questionnaire.invitedAt=time();next.questionnaire.invitationId=token();next.questionnaire.invitationUpdateHash=hash;next.revision++;next.updatedAt=time();
    if(await cas(store,previous,next))return {shouldInvite:true,invitationId:next.questionnaire.invitationId,state:view(next,profile)};
  }
  throw new HttpError(409,'Questionnaire invitation changed concurrently. Please retry.');
}
export const offerDemographics=inviteDemographics;

export async function startDemographics(store,{manual=false,edit=false,field,remainingOnly=false,updateId}={}){
  if(typeof manual!=='boolean'||typeof edit!=='boolean'||typeof remainingOnly!=='boolean'||(edit&&!manual))throw new HttpError(400,'Editing questionnaire preferences requires an explicit request.');
  if(field!==undefined)definition(field);
  return transition(store,updateId,(record,state)=>{
    const q=record.questionnaire;
    if(!manual&&(q.startedAt||q.completedAt||q.skippedAllAt||q.invitedAt))return {noWrite:true,question:null};
    if(manual&&!edit&&q.active)return {question:question(q.active)};
    q.invitedAt=q.invitedAt||time();q.invitationId=q.invitationId||token();q.startedAt=time();q.consentedAt=q.consentedAt||time();q.telegramSessionActive=true;q.completedAt=null;q.editMode=edit;
    q.remainingFields=(field?[field]:FIELDS).filter(name=>edit||missing(name,state.values[name])).filter(name=>!remainingOnly||!q.skippedFields.includes(name)).filter(name=>manual||!q.askedFields.includes(name));
    q.active=null;return {question:nextQuestion(record,state)};
  });
}

/** Back/menu invalidates prior question buttons without changing saved preferences. */
export async function pauseDemographics(store,{finish=false,updateId}={}){
  if(typeof finish!=='boolean')throw new HttpError(400,'Choose whether to finish setup.');
  return transition(store,updateId,(record)=>{
    record.questionnaire.active=null;record.questionnaire.remainingFields=[];record.questionnaire.telegramSessionActive=!finish;
    return {question:null};
  });
}

/** Race selections are a temporary draft until Done; every toggle invalidates old buttons. */
export async function toggleDemographicsSelection(store,{questionToken,value,updateId}={}){
  if(!definition('race').options.some(option=>option.value===value&&!['decline','unanswered'].includes(value)))throw new HttpError(400,'Choose a listed race category.');
  return transition(store,updateId,(record)=>{
    const active=record.questionnaire.active;
    if(active?.field!=='race'||active.token!==questionToken)throw new HttpError(409,'These choices changed. Open the latest question.');
    const selected=new Set(active.selected||[]);if(selected.has(value))selected.delete(value);else selected.add(value);
    active.selected=definition('race').options.map(option=>option.value).filter(item=>selected.has(item));active.token=token();
    return {question:question(active)};
  });
}

export async function answerDemographics(store,{field,value,questionToken,updateId}={}){
  value=validate(field,value);
  return transition(store,updateId,(record,state,profile)=>{
    const active=record.questionnaire.active;
    if(!active||active.field!==field||typeof questionToken!=='string'||active.token!==questionToken)throw new HttpError(409,'This reply does not match the active question. Use /demographics to resume.');
    markField(record,state,profile,field,value);record.questionnaire.active=null;return {question:nextQuestion(record,state)};
  });
}

export async function skipDemographics(store,{all=false,field,questionToken,updateId}={}){
  if(typeof all!=='boolean')throw new HttpError(400,'Choose a question skip or skip all.');
  if(!all)return answerDemographics(store,{field,value:field==='race'?['unanswered']:'unanswered',questionToken,updateId});
  return transition(store,updateId,(record,state)=>{
    const q=record.questionnaire;q.skippedAllAt=time();q.completedAt=time();q.active=null;q.remainingFields=[];q.telegramSessionActive=false;q.invitedAt=q.invitedAt||time();
    q.skippedFields=[...new Set([...q.skippedFields,...FIELDS.filter(name=>missing(name,state.values[name]))])];return {question:null};
  });
}

export async function editDemographics(store,patch,{expectedRevision}={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length||Object.keys(patch).some(field=>!FIELDS.includes(field)))throw new HttpError(400,'Edit only supported demographic preferences.');
  const values=Object.fromEntries(Object.entries(patch).map(([field,value])=>[field,validate(field,value)]));
  const result=await transition(store,null,(record,state,profile)=>{
    if(expectedRevision!==undefined&&expectedRevision!==state.revision)throw new HttpError(409,'Your preferences changed in another window or Telegram. Reload them before saving.');
    for(const [field,value] of Object.entries(values))markField(record,state,profile,field,value);
    // An explicit edit consumes any active prompt for that field; a stale token
    // cannot overwrite the freshly edited preference.
    record.questionnaire.active=null;record.questionnaire.remainingFields=[];record.questionnaire.telegramSessionActive=false;
    record.questionnaire.consentedAt=record.questionnaire.consentedAt||time();
    record.questionnaire.invitedAt=record.questionnaire.invitedAt||time();
    if(FIELDS.every(field=>!missing(field,state.values[field])||record.questionnaire.skippedFields.includes(field)))record.questionnaire.completedAt=time();
    return {question:null};
  });return result.state;
}
