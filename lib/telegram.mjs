import {menuCard,showMenu,handleMenuMessage,handleMenuCallback} from './telegram-menu.mjs';
import {handleSyllabusMessage} from './syllabus-telegram.mjs';
import {handleInvitationMessage,handleInvitationCallback} from './invitation-telegram.mjs';
import { pilotWorkAllowed } from './pilot-access.mjs';
import {handleBriefingMessage} from './briefing-telegram.mjs';
import {handleCareerMessage} from './career-telegram.mjs';
import {handleDemographicsCallback,handleDemographicsMessage} from './demographics-telegram.mjs';
import {handlePartifulMessage} from './partiful-telegram.mjs';
import {handleLumaMessage} from './luma-telegram.mjs';
import {claimSocialEventAction,finishSocialEventAction,queueSocialEventCard} from './social-event-telegram.mjs';
import {handleNotificationsMessage} from './notifications-telegram.mjs';
import {handleNewEventMessage} from './newevent-telegram.mjs';
import {parseReminderCommand,readReminderSettings,DEFAULT_REMINDER_SETTINGS} from './reminder-settings.mjs';
import {updateStudentReminders,reminderSettingsText} from './reminder-actions.mjs';
import {enrollmentAttachment} from './telegram-files.mjs';
import {confirmEnrollmentProposal} from './enrollment-workflow.mjs';
import {HttpError} from './security.mjs';
import { randomBytes, createHash } from 'node:crypto';
import { telegramCall, sendTelegram, nowISO } from './integrations.mjs';
const hash = value => createHash('sha256').update(String(value)).digest('hex');

export async function pruneSharedMetadata(database) {
  const store=database.system;
  for(const bucket of ['telegramLinks','workerHealth','telegramWelcome']) {
    const key=`cursor:${bucket}`,cursor=await store.get('sharedMaintenance',key);
    const rows=await store.allEntries(bucket,{limit:200,after:cursor?.after||null});
    for(const {id,value} of rows)if(bucket==='telegramLinks'?value.expiresAt<Date.now():(value.lastSeen||value.at)<Date.now()-86400000)await store.delete(bucket,id);
    await store.put('sharedMaintenance',key,{after:rows.length===200?rows.at(-1).id:null});
  }
}

export async function createTelegramLink(database, store) {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('The operator must configure the shared bot first.');
  const old = await store.get('secrets', 'telegram') || {};
  if (old.linkCode) await database.system.delete('telegramLinks', hash(old.linkCode));
  const linkCode = randomBytes(24).toString('base64url'), expiresAt = Date.now() + 15 * 60000;
  await database.system.put('telegramLinks', hash(linkCode), {userId: store.userId, expiresAt});
  await store.put('secrets', 'telegram', {...old, linkCode, linkExpires: expiresAt});
  return {linkCode, bot: process.env.TELEGRAM_BOT_USERNAME || 'dabas_class_bot'};
}
export async function disconnectTelegram(database, store) {
  const cfg = await store.get('secrets', 'telegram');
  if (cfg?.linkCode) await database.system.delete('telegramLinks', hash(cfg.linkCode));
  if (cfg?.chatId) {
    const key = hash(cfg.chatId), binding = await database.system.get('telegramChats', key);
    if (binding?.userId === store.userId) await database.system.delete('telegramChats', key);
  }
  await store.delete('secrets', 'telegram');
}

/** A single shared poller; the persistent lease prevents two hosts advancing one bot's offset. */
export async function pollSharedTelegram(database, queue, workerId) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  const sys = database.system, previous = await sys.get('workerLeases', 'telegram');
  if (previous?.expiresAt > Date.now()) return;
  const lease = {workerId, nonce: randomBytes(8).toString('hex'), expiresAt: Date.now()+120000};
  if (!await sys.compareAndSet('workerLeases','telegram',previous,lease)) return;
  try {
    const cursor = await sys.get('telegramState','cursor') || {offset:0};
    const response = await telegramCall(null,'getUpdates',{offset:cursor.offset,timeout:0,limit:20,allowed_updates:['message','callback_query']});
    for (const update of response.result || []) {
      const msg = update.message;
      if ((msg?.text || msg?.photo || msg?.document) && msg.chat?.type === 'private') await handleMessage(database,queue,msg,update.update_id);
      if(update.callback_query)await handleCallbackQuery(database,queue,update.callback_query,update.update_id);
      // Advance only after durable enqueue/link. On a crash an update may replay; idempotency keys handle it.
      await sys.put('telegramState','cursor',{offset:update.update_id+1});
    }
    await sys.put('serviceHealth','telegram',{lastSuccess:nowISO()});
  } catch { await sys.put('serviceHealth','telegram',{error:'Telegram polling unavailable',at:nowISO()}); }
  finally { await sys.compareAndSet('workerLeases','telegram',lease,{...lease,expiresAt:0}); }
}
export async function handleCallbackQuery(database,queue,query,updateId,{now=Date.now,answer=body=>telegramCall(null,'answerCallbackQuery',body)}={}){
  if(typeof query?.data!=='string'||!['social:','demo:','invite:','menu:'].some(prefix=>query.data.startsWith(prefix)))return false;
  const demographic=query.data.startsWith('demo:');
  const invitation=query.data.startsWith('invite:');
  if(!Number.isSafeInteger(updateId)||updateId<0)throw new Error('Invalid Telegram update ID');
  const chat=query.message?.chat;
  const acknowledge=async text=>{try{if(typeof query.id==='string'&&query.id.length>0&&query.id.length<=200)await answer({callback_query_id:query.id,text});}catch{/* Callback acknowledgement failure must not interrupt the student's action. */}};
  if(chat?.type!=='private'||!Number.isSafeInteger(Number(chat.id))||Number(chat.id)<=0||query.from?.is_bot||String(query.from?.id)!==String(chat.id)){await acknowledge('Open this in your linked private chat.');return false;}
  const binding=await database.system.get('telegramChats',hash(chat.id));
  if(!binding||!await pilotWorkAllowed(database,binding.userId)){await acknowledge('Sign in and link your Telegram account again.');return false;}
  const store=database.forUser(binding.userId),linked=await store.get('secrets','telegram');
  if(String(linked?.chatId)!==String(chat.id)||(await store.get('settings','account'))?.deleting){await acknowledge('Link your private Telegram account again.');return false;}
  await acknowledge(demographic?'Opening your choices…':'Checking your event…');
  if(query.data.startsWith('menu:')){try{return await handleMenuCallback(database,store,queue,query,updateId,{route:(message,id)=>handleMessage(database,queue,message,id)});}catch(error){await menuCard(store,queue,error instanceof HttpError?error.message:'I could not finish this action. Check the current item and try again from the menu.',[[['Main menu',{page:'home'}]]],`retry:${updateId}`);return true;}}
  if(invitation){
    try{return await handleInvitationCallback(store,queue,query,updateId,{now});}
    catch(error){if(!(error instanceof HttpError))throw error;await queue.enqueue(store.userId,'telegram-send',{text:error.message,expectedChatId:String(chat.id),expectedTelegramLinkedAt:String(linked.linkedAt||'')},{idempotencyKey:`invitation-error:${updateId}`,retrySafe:false,maxAttempts:1});return true;}
  }
  if(demographic){
    try{return await handleDemographicsCallback(store,queue,query,updateId,{now});}
    catch(error){if(!(error instanceof HttpError))throw error;await queue.enqueue(store.userId,'telegram-send',{text:error.message,expectedChatId:String(chat.id),expectedTelegramLinkedAt:String(linked.linkedAt||'')},{idempotencyKey:`demographics-error:${updateId}`,retrySafe:false,maxAttempts:1});return true;}
  }
  let claim;
  try{
    claim=await claimSocialEventAction(store,query.data,chat.id,{now});
    const handler=claim.provider==='partiful'?handlePartifulMessage:handleLumaMessage;
    await handler(store,queue,{text:`/${claim.provider} ${claim.action} ${claim.eventId}`,chat},updateId,{now,expectedVersion:claim.version});
    await queueSocialEventCard(store,queue,claim.provider,claim.eventId,{now,idempotencyKey:`social-result:${updateId}`});
    return true;
  }catch(error){
    if(!(error instanceof HttpError))throw error;
    await queue.enqueue(store.userId,'telegram-send',{text:error.message,expectedChatId:String(chat.id)},{idempotencyKey:`social-error:${updateId}`,retrySafe:false,maxAttempts:1});
    return true;
  }finally{if(claim)await finishSocialEventAction(store,claim,{now});}
}
export async function handleMessage(database,queue,msg,updateId) {
  if(msg?.chat?.type!=='private')return;
  const text = String(msg.text || '').trim(), sys = database.system, chatKey = hash(msg.chat.id);
  const addressed=String(msg.text||msg.caption||'').trim().match(/^\/\w+@([a-zA-Z0-9_]+)(?:\s|$)/);
  if(addressed&&addressed[1].toLowerCase()!==(process.env.TELEGRAM_BOT_USERNAME||'dabas_class_bot').toLowerCase())return;
  if (text.startsWith('/start ')) {
    const link = await sys.take('telegramLinks',hash(text.split(/\s+/)[1]));
    if (!link || link.expiresAt < Date.now() || !await pilotWorkAllowed(database, link.userId)) return;
    const binding = await sys.get('telegramChats',chatKey);
    if (binding && binding.userId !== link.userId) return;
    if (!binding && !await sys.compareAndSet('telegramChats',chatKey,null,{userId:link.userId})) return;
    const store = database.forUser(link.userId), old = await store.get('secrets','telegram');
    if (old?.chatId && String(old.chatId)!==String(msg.chat.id)) await sys.delete('telegramChats',hash(old.chatId));
    await store.put('secrets','telegram',{chatId:msg.chat.id,linkedAt:nowISO()});
    await queue.enqueue(link.userId,'telegram-send',{text:'Connected to Big Red Buddy. /today · /week · /pause · /resume. Questions use your own imported sources.'},{idempotencyKey:`telegram:${updateId}`,retrySafe:false,maxAttempts:1});
    await showMenu(store,queue,'setup',`linked:${updateId}`);
    return;
  }
  const binding = await sys.get('telegramChats',chatKey);
  if(!binding){if(['/start','/menu','/help'].includes(text)){const previous=await sys.get('telegramWelcome',chatKey);if(!previous||Date.now()-previous.at>60000){await sys.put('telegramWelcome',chatKey,{at:Date.now()});await telegramCall(null,'sendMessage',{chat_id:msg.chat.id,text:'Welcome to Big Red Buddy. Sign in with your invited Cornell account, then choose Link Telegram in Connections to connect this private chat.',reply_markup:{inline_keyboard:[[{text:'Sign in and connect',url:`${process.env.APP_ORIGIN}/#connections`}]]}});}}return;}
  if(!await pilotWorkAllowed(database,binding.userId))return;
  const store = database.forUser(binding.userId), cfg = await store.get('secrets','telegram');
  if (String(cfg?.chatId)!==String(msg.chat.id)||(await store.get('settings','account'))?.deleting) return;
  const reply = message=>queue.enqueue(binding.userId,'telegram-send',{text:message},{idempotencyKey:`telegram:${updateId}`,retrySafe:false,maxAttempts:1});
  try {
    // A reply to the optional questionnaire must never become an event draft,
    // application answer, or model request through another active conversation.
    if((msg.text&&!text.startsWith('/')||/^\/demographics?(?:@\w+)?(?:\s|$)/i.test(text))&&await handleDemographicsMessage(database,queue,store,msg,updateId))return;
    if(await handleMenuMessage(store,queue,msg,updateId))return;
    if(await handleInvitationMessage(store,queue,msg,updateId))return;
    if(await handleSyllabusMessage(store,queue,msg,updateId))return;
    if(await handleNotificationsMessage(store,queue,msg,updateId))return;
    if(await handleBriefingMessage(store,queue,msg,updateId))return;
    if(await handlePartifulMessage(store,queue,msg,updateId))return;
    if(await handleLumaMessage(store,queue,msg,updateId))return;
    if(await handleNewEventMessage(store,queue,msg,updateId))return;
    if(await handleCareerMessage(database,queue,store,msg,updateId))return;
    const reminderCommand=parseReminderCommand(text);
    if(reminderCommand){
      if(reminderCommand.action==='show')return reply(reminderSettingsText(await readReminderSettings(store)));
      const result=await updateStudentReminders(store,reminderCommand.action==='reset'?DEFAULT_REMINDER_SETTINGS:reminderCommand.patch,queue);
      return reply(`Saved. ${reminderSettingsText(result.settings)}${result.calendarTask?'\nGoogle Calendar notification updates queued.':''}${result.calendarError?'\n'+result.calendarError:''}`);
    }
    if(/^\/enrollment(?:\s|$)/i.test(text)){
      const term=text.split(/\s+/)[1]?.toUpperCase();
      if(!['FA26','SP27'].includes(term))return reply('Send /enrollment FA26 or /enrollment SP27, then attach a PDF or clear JPEG/PNG photo of your enrollment schedule. BRB will match sections and ask which enrolled classes to add.');
      await store.put('settings','enrollmentTerm',{term});
      await store.put('settings','enrollmentUpload',{term,expiresAt:Date.now()+15*60000});
      return reply(`Enrollment term set to ${term}. Send your enrollment PDF or photo. Include course codes and class numbers; dropped/waitlisted classes must be excluded when you confirm.`);
    }
    if(/^\/confirm(?:\s|$)/i.test(text)){
      const [,code,...numbers]=text.split(/\s+/);
      if(!/^[a-f0-9]{8}$/.test(code||'')||!numbers.length||numbers.some(n=>!/^\d{1,2}$/.test(n)))throw new HttpError(400,'Use the proposal code and class numbers shown in the review, for example /confirm abc12345 1 3.');
      const matches=(await store.all('enrollmentProposals')).filter(p=>p.id.startsWith(code)&&p.expiresAt>Date.now());
      if(matches.length!==1)throw new HttpError(400,'That review code is missing, expired, or ambiguous. Upload the image again.');
      const proposal=matches[0],chosen=numbers.map(n=>proposal.candidates[Number(n)-1]);
      if(chosen.some(c=>!c))throw new HttpError(400,'One of those class numbers is not in this review.');
      const result=await confirmEnrollmentProposal(store,{id:proposal.id,selections:chosen.map(c=>({courseId:c.courseId,sectionId:c.sectionId}))},{queue});
      return reply(`Confirmed: ${result.imported} new class meetings, ${result.reused} existing meetings reused.${result.calendarTask?' Google Calendar sync queued.':result.calendarError?'':' Connect Google Calendar in BRB to sync.'}\n${result.calendarError||''}\nSend /syllabus ${proposal.term} then a syllabus photo/PDF for assignments and exams, or open Academics: ${process.env.APP_ORIGIN}/#academics`);
    }
    const attachment=enrollmentAttachment(msg);
    if(attachment){
      const captionTerm=String(msg.caption||'').match(/\b(FA26|SP27)\b/i)?.[1]?.toUpperCase();
      const term=captionTerm||(await store.get('settings','enrollmentTerm'))?.term||'FA26';
      await queue.enqueue(binding.userId,'telegram-enrollment',{...attachment,term},{idempotencyKey:`enrollment-upload:${updateId}`,retrySafe:false,maxAttempts:1});
      return reply(`Reading your enrollment document for ${term}. I will match course sections and ask you to select the enrolled classes before adding anything. For a different term, send /enrollment SP27 or /enrollment FA26 before uploading.`);
    }
  } catch(error){
    if(error.statusCode&&error.statusCode<500)return reply(error.message);
    if(['STUDENT_QUEUE_FULL','STUDENT_MODEL_QUEUE_FULL'].includes(error.message))return reply('Your processing queue is full. Wait for the current uploads to finish, then send this again.');
    throw error;
  }
  if (text==='/pause' || text==='/resume') {
    const profile = await store.get('settings','profile') || {};
    await store.put('settings','profile',{...profile,paused:text==='/pause'});
    await queue.enqueue(binding.userId,'telegram-send',{text:text==='/pause'?'Reminders paused.':'Reminders resumed.'},{idempotencyKey:`telegram:${updateId}`,retrySafe:false,maxAttempts:1});
  } else {
    await queue.enqueue(binding.userId,'telegram-chat',{question:text.slice(0,2000)},{idempotencyKey:`telegram:${updateId}`,retrySafe:false,maxAttempts:1});
  }
}
