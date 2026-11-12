import {DEMOGRAPHIC_FIELDS,getDemographics,inviteDemographics,startDemographics,answerDemographics,skipDemographics,pauseDemographics,toggleDemographicsSelection} from './demographics.mjs';
import {demographicButtons,claimDemographicAction,finishDemographicAction} from './demographics-actions.mjs';
import {HttpError} from './security.mjs';

const triggers=new Set(['/resume_upload','/resume_review','/apply','/career_profile']);
const otherCommands=new Set(['/resume_upload','/resume_review','/jobs','/apply','/applications','/applied','/career_profile','/answer','/generate','/write','/save_answer','/today','/week','/help','/start','/pause','/resume','/reminders','/enrollment','/confirm','/luma','/partiful','/notifications','/briefing','/syllabus','/syllabus_review','/syllabus_confirm','/newevent','/schedule','/coverage']);
const privacy='Optional answers are saved encrypted in your BRB workspace. Telegram also processes chat replies. They stay out of AI and are not automatically sent to employers. You can skip any question or edit later.';
const fail=message=>{throw new HttpError(400,message);};
const specFor=field=>DEMOGRAPHIC_FIELDS.find(item=>item.field===field);
const consented=state=>!!(state.questionnaire.consentedAt||state.questionnaire.startedAt);
const activeQuestion=state=>{const active=state?.questionnaire?.active,spec=specFor(active?.field);return spec?{...spec,token:active.token,selected:active.selected||[]}:null;};
const missing=(field,value)=>field==='race'?!value?.length||value.includes('unanswered'):!value||value==='unanswered';
function website(){try{const origin=new URL(process.env.APP_ORIGIN);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)return null;return new URL('/#demographics',origin).href;}catch{return null;}}

async function queueCard(store,queue,card,key,{editMessageId,demographicRevision,expectedChatId,expectedTelegramLinkedAt}={}){
  const linked=await store.get('secrets','telegram');
  if(!linked?.chatId||(await store.get('settings','account'))?.deleting)return true;
  if(expectedChatId!==undefined&&String(linked.chatId)!==String(expectedChatId)||expectedTelegramLinkedAt!==undefined&&String(linked.linkedAt||'')!==expectedTelegramLinkedAt)return true;
  await queue.enqueue(store.userId,'telegram-send',{text:card.text.slice(0,3900),...(Number.isSafeInteger(editMessageId)&&editMessageId>0?{editMessageId}:{}),demographicRevision,replyMarkup:{inline_keyboard:card.rows},expectedChatId:String(linked.chatId),expectedTelegramLinkedAt:String(linked.linkedAt||'')},{idempotencyKey:key,retrySafe:false,maxAttempts:1});
  return true;
}
async function overviewCard(store,state,{now=Date.now,note=''}={}){
  const button=await demographicButtons(store,state,{now}),q=state.questionnaire,hasConsent=consented(state),statuses=DEMOGRAPHIC_FIELDS.map(spec=>({spec,status:missing(spec.field,state.values[spec.field])?(q.skippedFields.includes(spec.field)?'Skipped':'Not answered'):'Saved'}));
  const rows=[];
  if(hasConsent){
    for(let i=0;i<statuses.length;i+=2)rows.push(await Promise.all(statuses.slice(i,i+2).map(({spec,status})=>button(`${status==='Saved'?'✓ ':status==='Skipped'?'– ':''}${spec.label}`,{op:'field',field:spec.field}))));
    if(statuses.some(({status})=>status==='Not answered'))rows.push([await button('Answer remaining',{op:'remaining'})]);
  }else rows.push([await button('Agree & set up',{op:'consent'})]);
  rows.push([await button('Skip unanswered',{op:'skip'}),await button('Done / close setup',{op:'close'})]);
  const url=website();if(url)rows.push([{text:'Fill all at once on website',url}]);
  const text=[note,'Optional application preferences',statuses.map(({spec,status})=>`${spec.label} · ${status}`).join('\n'),hasConsent?'All six questions are here. Tap a question to answer or change it. “Answer remaining” walks through unfinished questions.':'Choose Agree & set up to answer here, or fill all six together on the website.',privacy,'Work authorization and sponsorship are separate application details in Career Studio.'].filter(Boolean).join('\n\n');
  return {text,rows};
}
async function questionCard(store,state,{now=Date.now,note=''}={}){
  const question=activeQuestion(state);if(!question)return overviewCard(store,state,{now,note});
  const button=await demographicButtons(store,state,{now}),rows=[],selected=question.selected||[];
  for(const option of question.options){
    const multiple=question.multiple&&!['decline','unanswered'].includes(option.value),label=(multiple?(selected.includes(option.value)?'✓ ':'○ '):'')+option.label;
    rows.push([await button(label,{op:multiple?'toggle':'answer',field:question.field,value:question.multiple?[option.value]:option.value,questionToken:question.token})]);
  }
  if(question.multiple)rows.push([await button('Done · save selected',{op:'done',field:question.field,questionToken:question.token})]);
  rows.push([await button('← All questions',{op:'back'})]);
  const progress=DEMOGRAPHIC_FIELDS.filter(spec=>!missing(spec.field,state.values[spec.field])||state.questionnaire.skippedFields.includes(spec.field)).length;
  return {text:[note,`${question.label} · ${progress} of ${DEMOGRAPHIC_FIELDS.length} handled`,question.prompt,question.multiple?'Tap all categories you want, then Done. Prefer not to answer or Skip saves immediately.':'Tap a choice below. You can also type the exact choice label.',question.field==='protectedVeteranStatus'?'Definitions: https://www.dol.gov/agencies/ofccp/faqs/vevraa':'','Every question is optional. Back returns to all questions.'].filter(Boolean).join('\n\n'),rows};
}
async function replyState(store,queue,state,key,{now=Date.now,note='',overview=false,...delivery}={}){return queueCard(store,queue,await (overview?overviewCard:questionCard)(store,state,{now,note}),key,{...delivery,demographicRevision:state.revision});}

/** Compare literal labels only; a numbered label must agree with that exact current choice. */
function plainChoice(question,text){
  const normalize=value=>value.trim().normalize('NFKC').toLocaleLowerCase('en-US').replace(/[’‘]/g,"'");
  const raw=normalize(text),numbered=raw.match(/^(\d{1,2})[.)]\s+(.+)$/),label=numbered?.[2]||raw;
  const index=question.options.findIndex(option=>normalize(option.label)===label);
  if(index<0||numbered&&Number(numbered[1])!==index+1)return undefined;
  return question.multiple?[question.options[index].value]:question.options[index].value;
}

/** Sensitive replies are parsed deterministically and never become model jobs. */
export async function handleDemographicsMessage(database,queue,store,msg,updateId){
  if(!store?.userId||msg?.chat?.type!=='private')return false;
  const linked=await store.get('secrets','telegram');
  if(!linked?.chatId||String(linked.chatId)!==String(msg.chat.id)||(await store.get('settings','account'))?.deleting)return false;
  if(!Number.isSafeInteger(updateId)||updateId<0)throw new Error('Invalid Telegram update ID');
  const text=String(msg.text||'').trim(),match=text.match(/^(\/\w+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/),command=match?.[1]?.toLowerCase(),args=(match?.[3]||'').trim(),key=`demographics-reply:${updateId}`;
  if(match?.[2]&&match[2].toLowerCase()!==(process.env.TELEGRAM_BOT_USERNAME||'dabas_class_bot').toLowerCase())return false;
  const respond=(state,responseKey,options={})=>replyState(store,queue,state,responseKey,{...options,expectedChatId:String(msg.chat.id),expectedTelegramLinkedAt:String(linked.linkedAt||'')});
  if(triggers.has(command)){
    const offer=await inviteDemographics(store,{updateId});
    if(offer.shouldInvite)await respond(offer.state,`demographics-invite:${offer.invitationId}`,{overview:true,note:'Optional self-identification setup · save once and edit anytime.'});
    return false;
  }
  if(command==='/demographics'){
    if(!args){await inviteDemographics(store,{updateId});const result=await pauseDemographics(store,{updateId:`menu:${updateId}`});return respond(result.state,key,{overview:true});}
    if(args==='start')return respond((await startDemographics(store,{manual:true,remainingOnly:true,updateId})).state,key);
    if(args==='skip')return respond((await skipDemographics(store,{all:true,updateId})).state,key,{overview:true,note:'Setup stopped. Saved answers are kept; unanswered questions are skipped.'});
    if(args==='done')return respond((await pauseDemographics(store,{finish:true,updateId})).state,key,{overview:true,note:'Setup closed. Your saved choices are ready when you return.'});
    if(/^edit(?:\s|$)/.test(args)){
      const parts=args.split(/\s+/),field=parts[1];
      if(parts.length>2||field&&!specFor(field))fail(`Use /demographics edit, or /demographics edit followed by one of: ${DEMOGRAPHIC_FIELDS.map(item=>item.field).join(', ')}.`);
      if(!field){const result=await pauseDemographics(store,{updateId});return respond(result.state,key,{overview:true});}
      return respond((await startDemographics(store,{manual:true,edit:true,field,updateId})).state,key);
    }
    return respond(await getDemographics(store),key,{overview:true,note:'Tap a question below to update your preferences.'});
  }
  if(command==='/demographic'){
    const parts=args.split(/\s+/);
    if(parts.length!==3||!/^\d{1,2}(?:,\d{1,2})*$/.test(parts[2]))fail('Use /demographics and tap a choice. You no longer need to copy a command.');
    const [questionToken,field,numbers]=parts,spec=specFor(field);
    if(!spec||questionToken.length>160)fail('Open /demographics and tap a question to continue.');
    const indices=numbers.split(',').map(Number);
    if(indices.length===1&&indices[0]===0)return respond((await skipDemographics(store,{field,questionToken,updateId})).state,key);
    if(new Set(indices).size!==indices.length||indices.some(n=>n<1||n>spec.options.length)||!spec.multiple&&indices.length!==1)fail('Open /demographics and tap one of the choices.');
    const selected=indices.map(n=>spec.options[n-1].value),value=spec.multiple?selected:selected[0];
    return respond((await answerDemographics(store,{field,value,questionToken,updateId})).state,key);
  }
  if(msg.text&&!otherCommands.has(command)){
    const state=await getDemographics(store),question=activeQuestion(state);
    if(question){
      const value=!command?plainChoice(question,text):undefined;
      if(value!==undefined)return respond((await answerDemographics(store,{field:question.field,value,questionToken:question.token,updateId})).state,key,{note:'Choice saved.'});
      return respond(state,key,{note:'Tap a choice below, or type its exact label. No long command needed. This reply stayed out of AI.'});
    }
    if(state.questionnaire.telegramSessionActive)return respond(state,key,{overview:true,note:'Choose a question below first. Tap Done / close setup to return to the assistant.'});
  }
  return false;
}

/** Router verifies the sender and linked student; check again before any sensitive mutation. */
export async function handleDemographicsCallback(store,queue,query,updateId,{now=Date.now}={}){
  if(!query?.data?.startsWith('demo:'))return false;
  if(!Number.isSafeInteger(updateId)||updateId<0)throw new Error('Invalid Telegram update ID');
  const chat=query.message?.chat,linked=await store.get('secrets','telegram');
  if(!store.userId||chat?.type!=='private'||query.from?.is_bot||String(query.from?.id)!==String(chat.id)||String(linked?.chatId)!==String(chat.id)||(await store.get('settings','account'))?.deleting)return false;
  const key=`demographics-callback:${updateId}`,delivery={editMessageId:query.message?.message_id,expectedChatId:String(chat.id),expectedTelegramLinkedAt:String(linked.linkedAt||'')};let claim;
  try{
    const state=await getDemographics(store);claim=await claimDemographicAction(store,query.data,chat.id,state,{now});
    const action=claim.action,updateKey=`button:${claim.id}`;let result,note='',overview=false;
    if(action.op==='consent'){
      await startDemographics(store,{manual:true,remainingOnly:true,updateId:updateKey});
      result=await pauseDemographics(store,{updateId:`menu:${claim.id}`});overview=true;
    }else if(action.op==='field'){
      if(!consented(state))throw new HttpError(409,'Agree to optional storage before choosing an answer.');
      result=await startDemographics(store,{manual:true,edit:true,field:action.field,updateId:updateKey});
    }else if(action.op==='remaining'){
      if(!consented(state))throw new HttpError(409,'Agree to optional storage before choosing an answer.');
      result=await startDemographics(store,{manual:true,remainingOnly:true,updateId:updateKey});
    }else if(action.op==='answer'){
      result=await answerDemographics(store,{field:action.field,value:action.value,questionToken:action.questionToken,updateId:updateKey});note=missing(action.field,action.value)?'Question skipped.':'Choice saved.';
    }else if(action.op==='toggle')result=await toggleDemographicsSelection(store,{questionToken:action.questionToken,value:action.value[0],updateId:updateKey});
    else if(action.op==='done'){
      const active=state.questionnaire.active;
      if(active?.field!=='race'||active.token!==action.questionToken)throw new HttpError(409,'Open the latest question before saving.');
      if(!active.selected?.length)throw new HttpError(400,'Select at least one category, or tap Skip this question.');
      result=await answerDemographics(store,{field:'race',value:active.selected,questionToken:active.token,updateId:updateKey});note='Choices saved.';
    }else if(action.op==='skip'){result=await skipDemographics(store,{all:true,updateId:updateKey});overview=true;note='Setup stopped. Saved answers are kept; unanswered questions are skipped.';}
    else if(action.op==='back'){result=await pauseDemographics(store,{updateId:updateKey});overview=true;}
    else if(action.op==='close'){result=await pauseDemographics(store,{finish:true,updateId:updateKey});overview=true;note='Setup closed. Your saved choices are kept.';}
    else throw new HttpError(400,'Open /demographics for fresh choices.');
    return replyState(store,queue,result.state,key,{now,note,overview,...delivery});
  }catch(error){
    if(!(error instanceof HttpError))throw error;
    return replyState(store,queue,await getDemographics(store),key,{now,note:error.message,...delivery});
  }finally{if(claim)await finishDemographicAction(store,claim);}
}
