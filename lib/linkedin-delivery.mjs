import {readLinkedInConnections,matchLinkedInConnections} from './linkedin-connections.mjs';
import {referralMessage} from './linkedin-referrals.mjs';
import {menuMarkup} from './telegram-menu.mjs';
import {sendTelegram} from './integrations.mjs';
const clean=(value,max)=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
/** Resolve contacts at dispatch, so queues never retain copies of an imported network. */
export async function dispatchLinkedInLeads(store,{jobId,sourceVersion,mode='list',contactId,offset=0,expectedChatId,expectedTelegramLinkedAt}={}, {send=sendTelegram}={}){
 if(typeof jobId!=='string'||jobId.length>200||typeof sourceVersion!=='string'||!['offer','list','draft'].includes(mode)||!Number.isInteger(offset)||offset<0||offset>15||offset%5)return {accepted:false,reason:'invalid-request'};
 const linked=await store.get('secrets','telegram');
 if(!linked?.chatId||expectedChatId!==undefined&&String(linked.chatId)!==expectedChatId||expectedTelegramLinkedAt!==undefined&&(linked.linkedAt||'')!==expectedTelegramLinkedAt)return {accepted:false,reason:'telegram-link-changed'};
 const binding={expectedChatId:expectedChatId??String(linked.chatId),expectedTelegramLinkedAt:expectedTelegramLinkedAt??linked.linkedAt??''};
 const metadata=await readLinkedInConnections(store);if(!metadata.connected||metadata.sourceVersion!==sourceVersion)return {accepted:false,reason:'linkedin-export-changed'};
 const job=await store.get('jobs',jobId);if(!job||job.closed||job.status==='closed'||job.eligible===false)return {accepted:false,reason:'job-unavailable'};
 const result=await matchLinkedInConnections(store,job.company);if(result.sourceVersion!==sourceVersion)return {accepted:false,reason:'linkedin-export-changed'};
 const action=(op,extra={})=>({referral:{op,jobId,sourceVersion,...extra}}),continueButton=['Continue application',action('continue')];
 let lines,actions;
 if(mode==='offer'){
  lines=[`Before you apply to ${clean(job.title,160)} at ${clean(job.company,100)}…`,`${result.totalMatches} connection${result.totalMatches===1?'':'s'} in your imported LinkedIn list match${result.totalMatches===1?'es':''} this company. Would you like a referral message to reach out first?`];
  actions=result.matches.length?[[['Draft referral message',result.matches.length===1?action('draft',{contactId:result.matches[0].id}):action('list')]]]:[];
 }else if(mode==='draft'){
  const person=result.matches.find(person=>person.id===contactId);if(!person)return {accepted:false,reason:'contact-unavailable'};
  lines=[`A message for ${clean(person.name,160)}\nCopy and edit this draft before sending.`,referralMessage(job,person)];
  actions=[...(person.url?[[['Open LinkedIn profile',{url:person.url}]]]:[]),[['Choose another connection',action('list')]]];
 }else{
  const people=result.matches.slice(offset,offset+5);
  lines=[`Potential contacts at ${clean(job.company,100)} from your uploaded LinkedIn export.`,...people.map(person=>`${clean(person.name,80)} · ${clean(person.title,100)||'Title not provided'}${person.url?'\n'+person.url:''}`)];
  actions=people.map(person=>[[`Draft for ${clean(person.name,48)}`,action('draft',{contactId:person.id})],...(person.url?[['Open profile',{url:person.url}]]:[])]);
  if(offset+5<result.matches.length)actions.push([['More connections',action('list',{offset:offset+5})]]);
  if(offset>0)actions.push([['Previous connections',action('list',{offset:offset-5})]]);
  if(result.matches.length)lines.push(`Choose a person below for a ready-to-edit referral request.${result.truncated?' Showing up to 20 company matches.':''}`);
 }
 if(!result.matches.length)lines.push('No exact company match in this export. Check your current connections on LinkedIn; this does not establish that you have no contacts there.');
 lines.push(`Export uploaded: ${result.importedAt?.slice(0,10)||'unknown'}. Employment and connections may have changed. Check their current role before sending. BRB has not contacted anyone.${result.stale?' Upload an updated export when convenient.':''}`);
 actions.push([continueButton],[["Not now",{page:'jobs'}]]);
 const replyMarkup=await menuMarkup(store,actions);
 const response=await send(store,lines.join('\n\n'),{replyMarkup,...binding,notification:{channel:'requested-leads',linkedinSourceVersion:sourceVersion}});
 if(response?.suppressed)return {accepted:false,reason:response.reason};if(!Number.isSafeInteger(response?.result?.message_id)||response.result.message_id<=0)throw new Error('Telegram acceptance is unconfirmed.');return {accepted:true};
}
