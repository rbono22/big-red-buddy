import {applicationURL} from './application-providers.mjs';
import {linkedInProfileURL} from './linkedin-connections.mjs';
import {linkedinJobLinks} from './linkedin-job-email-parser.mjs';
/** Explicit bot replies stay available while proactive topics are muted. */
export function validateTelegramReplyMarkup(value){
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='inline_keyboard')||!Array.isArray(value.inline_keyboard)||!value.inline_keyboard.length||value.inline_keyboard.length>12)throw new Error('Invalid Telegram buttons.');
  const inline_keyboard=value.inline_keyboard.map(row=>{
    if(!Array.isArray(row)||!row.length||row.length>3)throw new Error('Invalid Telegram button row.');
    return row.map(button=>{
      if(!button||typeof button!=='object'||Array.isArray(button)||Object.keys(button).some(key=>!['text','url','callback_data'].includes(key))||typeof button.text!=='string'||!button.text.trim()||button.text.length>64||/[\u0000-\u001f\u007f]/.test(button.text)||Boolean(button.url)===Boolean(button.callback_data))throw new Error('Invalid Telegram button.');
      if(button.callback_data){if(typeof button.callback_data!=='string'||!/^(?:social|demo|invite|menu):[a-f0-9]{32}$/.test(button.callback_data))throw new Error('Invalid Telegram action.');return {text:button.text,callback_data:button.callback_data};}
      let url;try{url=new URL(button.url);}catch{throw new Error('Invalid Telegram event link.');}
      const eventPath=url.hostname==='partiful.com'?/^\/e\/[A-Za-z0-9_-]{1,160}$/.test(url.pathname):['luma.com','lu.ma'].includes(url.hostname)&&/^\/[A-Za-z0-9_-]{1,160}$/.test(url.pathname);
      const campusLink=url.hostname==='cornelltech.campusgroups.com'&&url.pathname==='/rsvp'&&/^\?id=\d{1,20}$/.test(url.search)&&!url.hash;
      const applicationLink=!!applicationURL(button.url);
      const linkedinLink=linkedInProfileURL(button.url)===button.url||linkedinJobLinks(button.url)[0]===button.url;
      const calendarLink=url.hostname==='calendar.google.com'&&url.pathname==='/calendar/event'&&/^\?eid=[A-Za-z0-9_-]{1,2000}$/.test(url.search)&&!url.hash;
      let appLink=false;try{
        const origin=new URL(process.env.APP_ORIGIN);
        // A handoff contains an application ID only. Require the literal canonical
        // URL so encoded hosts, normalized paths, and secret parameters cannot ride along.
        const handoff=/^#application-handoff\/[A-Za-z0-9:_-]{1,160}$/.test(url.hash)&&button.url===url.href;
        appLink=origin.protocol==='https:'&&!origin.username&&!origin.password&&url.origin===origin.origin&&url.pathname==='/'&&!url.search&&(handoff||['#demographics','#career-profile','#connections','#calendar-edit','#careers','#events','#academics'].includes(url.hash));
      }catch{}
      if(url.protocol!=='https:'||url.username||url.password||url.port||(!appLink&&!campusLink&&!calendarLink&&!applicationLink&&!linkedinLink&&(url.search||url.hash||!eventPath)))throw new Error('Invalid Telegram event link.');
      return {text:button.text,url:url.href};
    });
  });
  return {inline_keyboard};
}

export function queuedNotification(job){
  // Old queued proactive messages predate topic metadata. Keep their durable
  // producer keys subject to the current controls as well.
  const key=String(job?.idempotencyKey||'');
  if(key.startsWith('job-discovery:'))return {...job?.payload?.notification,channel:'alerts',topic:'jobs',requireCurrentMatching:true,requireCurrentPublication:true};
  if(key.startsWith('slack:'))return {channel:'alerts',topic:'school'};
  return job?.payload?.notification;
}

export async function dispatchQueuedTelegram(store,job,{send}={}){
  if(typeof send!=='function')throw new Error('A Telegram delivery function is required.');
  const payload=job?.payload||{},replyMarkup=validateTelegramReplyMarkup(payload.replyMarkup);
  if(payload.editMessageId!==undefined&&(!Number.isSafeInteger(payload.editMessageId)||payload.editMessageId<=0))throw new Error('Invalid Telegram message to update.');
  if(payload.expectedChatId!==undefined||payload.expectedTelegramLinkedAt!==undefined){
    const linked=await store.get('secrets','telegram');
    if(payload.expectedChatId!==undefined&&String(linked?.chatId)!==String(payload.expectedChatId)||payload.expectedTelegramLinkedAt!==undefined&&String(linked?.linkedAt||'')!==payload.expectedTelegramLinkedAt)return {accepted:false,suppressed:true,reason:'telegram-link-changed'};
  }
  if(payload.liveApplicationId!==undefined){
    const application=await store.get('liveApplications',payload.liveApplicationId);
    if(!application||application.revision!==payload.liveApplicationRevision)return {accepted:false,suppressed:true,reason:'application-changed'};
  }
  if(payload.calendarDeletionFlowId!==undefined){
    const flow=await store.get('settings','calendarDeletionFlow');
    if(flow?.id!==payload.calendarDeletionFlowId||flow.expiresAt<=Date.now()||['cancelled','confirming','queued'].includes(flow.status))return {accepted:false,suppressed:true,reason:'calendar-removal-changed'};
  }
  if(payload.demographicRevision!==undefined){
    const {getDemographics}=await import('./demographics.mjs');
    if(typeof payload.demographicRevision!=='string'||(await getDemographics(store)).revision!==payload.demographicRevision)return {accepted:false,suppressed:true,reason:'demographic-choices-changed'};
  }
  if(payload.invitationFlowId!==undefined||payload.invitationRevision!==undefined){
    const account=await store.get('settings','account');
    if(account?.deleting)return {accepted:false,suppressed:true,reason:'account-deleting'};
    if(payload.invitationFlowId==='demographics'){
      const demographics=await store.get('career','demographics');
      if(!demographics?.questionnaire?.active&&!demographics?.questionnaire?.telegramSessionActive)return {accepted:false,suppressed:true,reason:'invitation-details-changed'};
    }else{
      const flow=await store.get('settings','invitationFlow');
      if(typeof payload.invitationFlowId!=='string'||!Number.isSafeInteger(payload.invitationRevision)||flow?.id!==payload.invitationFlowId||flow?.revision!==payload.invitationRevision)return {accepted:false,suppressed:true,reason:'invitation-details-changed'};
    }
  }
  const result=await send(store,String(payload.text||''),{notification:queuedNotification(job),...(replyMarkup?{replyMarkup}:{}),...(payload.expectedChatId!==undefined?{expectedChatId:payload.expectedChatId}:{}),...(payload.expectedTelegramLinkedAt!==undefined?{expectedTelegramLinkedAt:payload.expectedTelegramLinkedAt}:{}),...(payload.editMessageId!==undefined?{editMessageId:payload.editMessageId}:{})});
  if(result?.suppressed)return {accepted:false,suppressed:true,reason:result.reason};
  if(!Number.isSafeInteger(result?.result?.message_id)||result.result.message_id<=0)throw new Error('Telegram acceptance is unconfirmed.');
  return {accepted:true};
}
