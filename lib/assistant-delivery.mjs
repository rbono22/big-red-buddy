import {splitAssistantAnswer} from './assistant-schedule.mjs';

export const ASSISTANT_REPLIES_BUCKET='assistantReplySnapshots';
const TTL=24*60*60*1000;

// Scheduled maintenance runs this even for revoked pilot accounts. Account
// deletion removes every owner-scoped bucket, including these encrypted rows.
export async function pruneAssistantReplies(store,{now=Date.now()}={}) {
  const expired=[];
  for(let offset=0;;offset+=2000){
    const rows=await store.all(ASSISTANT_REPLIES_BUCKET,{limit:2000,offset});
    expired.push(...rows.filter(row=>!Number.isFinite(row.expiresAt)||row.expiresAt<=now).map(row=>row.id));
    if(rows.length<2000)break;
  }
  for(const id of expired)await store.delete(ASSISTANT_REPLIES_BUCKET,id);
  return expired.length;
}

/** Freeze the complete response before queueing any part. A retried model job
 * must not combine old already-enqueued parts with a regenerated schedule. */
export async function prepareAssistantDelivery(store,job,generate,{now=Date.now()}={}) {
  if(job.expiresAt<=now)throw new Error('ASSISTANT_REQUEST_EXPIRED');
  await pruneAssistantReplies(store,{now});
  let snapshot=await store.get(ASSISTANT_REPLIES_BUCKET,job.id);
  const linked=await store.get('secrets','telegram');
  if(!linked?.chatId)return null;
  const binding={expectedChatId:String(linked.chatId),expectedTelegramLinkedAt:String(linked.linkedAt||'')};
  if(snapshot)return snapshot.expectedChatId===binding.expectedChatId&&snapshot.expectedTelegramLinkedAt===binding.expectedTelegramLinkedAt?snapshot:null;
  const answer=await generate();
  snapshot=await store.putIfAbsent(ASSISTANT_REPLIES_BUCKET,job.id,{id:job.id,parts:splitAssistantAnswer(answer),...binding,createdAt:now,expiresAt:Math.min(job.expiresAt||now+TTL,now+TTL)});
  return snapshot.expectedChatId===binding.expectedChatId&&snapshot.expectedTelegramLinkedAt===binding.expectedTelegramLinkedAt?snapshot:null;
}
