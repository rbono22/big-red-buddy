import {NOTIFICATION_TOPICS,NOTIFICATION_MODES,readNotificationPreferences,saveNotificationPreferences,notificationPreferencesText} from './notification-preferences.mjs';

/** Commands only change the authenticated student's saved notification choices. */
export async function handleNotificationsMessage(store,queue,msg,updateId,{now=Date.now}={}){
 const match=String(msg?.text||'').trim().match(/^\/notifications(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
 if(!match||!store?.userId||msg?.chat?.type!=='private')return false;
 if(match[1]&&match[1].toLowerCase()!==(process.env.TELEGRAM_BOT_USERNAME||'dabas_class_bot').toLowerCase())return false;
 const binding=await store.get('secrets','telegram');if(!binding?.chatId||String(binding.chatId)!==String(msg.chat.id))return false;
 if(!Number.isSafeInteger(updateId)||updateId<0)throw new Error('Invalid Telegram update ID');
 const args=(match[2]||'').trim().toLowerCase(),parts=args.split(/\s+/);
 const reply=async text=>{await queue.enqueue(store.userId,'telegram-send',{text},{idempotencyKey:`notifications:${updateId}`,retrySafe:false,maxAttempts:1});return true;};
 let preferences;
 if(!args||args==='show'||args==='help')preferences=await readNotificationPreferences(store);
 else if(args==='off'||args==='on')preferences=await saveNotificationPreferences(store,{enabled:args==='on'},{updateId,now});
 else if(parts.length===2&&NOTIFICATION_TOPICS.includes(parts[0])&&NOTIFICATION_MODES.includes(parts[1]))preferences=await saveNotificationPreferences(store,{topics:{[parts[0]]:parts[1]}},{updateId,now});
 else return reply('Use /notifications to see your choices; /notifications school daily, /notifications events alerts, /notifications news both, or /notifications jobs off. Topics: school, events, jobs, news, games. Modes: daily, alerts, both, off. Games are not available yet. /notifications off/on controls proactive delivery.');
 return reply(`${preferences.replayed?'This update was already handled or superseded. Current choices:\n':''}${notificationPreferencesText(preferences)}`);
}
