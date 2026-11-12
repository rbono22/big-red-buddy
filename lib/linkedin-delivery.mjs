import {readLinkedInConnections,matchLinkedInConnections} from './linkedin-connections.mjs';
import {sendTelegram} from './integrations.mjs';
const clean=(value,max)=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
/** Resolve contacts at dispatch, so queues never retain copies of an imported network. */
export async function dispatchLinkedInLeads(store,{jobId,sourceVersion}={}, {send=sendTelegram}={}){
 if(typeof jobId!=='string'||jobId.length>200||typeof sourceVersion!=='string')return {accepted:false,reason:'invalid-request'};
 const metadata=await readLinkedInConnections(store);if(!metadata.connected||metadata.sourceVersion!==sourceVersion)return {accepted:false,reason:'linkedin-export-changed'};
 const job=await store.get('jobs',jobId);if(!job||job.closed||job.eligible===false)return {accepted:false,reason:'job-unavailable'};
 const result=await matchLinkedInConnections(store,job.company);if(result.sourceVersion!==sourceVersion)return {accepted:false,reason:'linkedin-export-changed'};
 const lines=[`Potential contacts at ${clean(job.company,80)} from your uploaded LinkedIn export.`,...result.matches.slice(0,5).map(person=>`${clean(person.name,80)} · ${clean(person.title,100)||'Title not provided'}${person.url?'\n'+person.url:''}`)];
 if(!result.matches.length)lines.push('No exact company match in this export. Check your current connections on LinkedIn; this does not establish that you have no contacts there.');
 lines.push(`Export uploaded: ${result.importedAt?.slice(0,10)||'unknown'}. Employment and connections may have changed. Ask whether they can help; BRB has not contacted anyone.${result.stale?' Upload an updated export when convenient.':''}`);
 const response=await send(store,lines.join('\n\n'),{notification:{channel:'requested-leads',linkedinSourceVersion:sourceVersion}});
 if(response?.suppressed)return {accepted:false,reason:response.reason};if(!Number.isSafeInteger(response?.result?.message_id)||response.result.message_id<=0)throw new Error('Telegram acceptance is unconfirmed.');return {accepted:true};
}
