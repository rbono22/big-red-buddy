import {readDailyBriefingSettings,saveDailyBriefingSettings} from './daily-briefing.mjs';

export async function handleBriefingMessage(store,queue,msg,updateId){
 const text=String(msg.text||'').trim(),match=text.match(/^\/(briefing|schedule|coverage)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/i);
 if(!match)return false;
 if(msg.chat?.type!=='private'||String((await store.get('secrets','telegram'))?.chatId)!==String(msg.chat.id))return false;
 if(match[2]&&match[2].toLowerCase()!==(process.env.TELEGRAM_BOT_USERNAME||'dabas_class_bot').toLowerCase())return false;
 const reply=async text=>{await queue.enqueue(store.userId,'telegram-send',{text},{idempotencyKey:`briefing-command:${updateId}`,retrySafe:false,maxAttempts:1});return true;};
 const command=match[1].toLowerCase(),args=(match[3]||'').trim();
 if(command==='schedule'){await queue.enqueue(store.userId,'telegram-daily-preview',{}, {idempotencyKey:`briefing-command:${updateId}`,retrySafe:false,maxAttempts:1});return true;}
 if(command==='coverage'){
  const boards=(await store.get('settings','jobBoards'))?.boards||[],campus=await store.get('settings','campusCalendar'),partiful=await store.get('settings','partifulCalendar');
  const lines=['BRB source coverage',...boards.slice(0,12).map(b=>`${String(b.board).slice(0,80)} (${b.provider}): last successful read ${b.lastSuccess||'never'}${(b.lastError||b.errorMessage)?' — read failed; check Career Studio':''}${b.truncated?' — partial results':''}`)];
  if(!boards.length)lines.push('Jobs: no employer boards connected. Configure titles and sources in Career Studio.');
  lines.push(`Partiful: ${partiful?.calendarName||'not selected'}; last read ${partiful?.lastSuccess||'never'}${partiful&&!partiful.continuous?' (snapshot only)':''}. Google subscription updates may lag about 24 hours. RSVP directly on Partiful.`);
  lines.push(`Campus: ${campus?.calendarName||'not selected'}; last read ${campus?.lastSuccess||'never'}${campus&&!campus.continuous?' (snapshot only)':''}. Daily read: 05:00 America/New_York. Automatic calendar additions: ${campus?.autoAdd?'on':'off'}.${campus?.autoAddWarning?' '+campus.autoAddWarning:''}`,'Job sources refresh within 6 hours; Partiful checks run every 15 minutes. Campus calendars refresh at 5 a.m. New York time, with catch-up until 11 a.m. The host must remain awake and connected. Configured sources do not cover every job or event.',`${process.env.APP_ORIGIN}/#events`);
  return reply(lines.join('\n\n').slice(0,3800));
 }
 if(args==='off')await saveDailyBriefingSettings(store,{enabled:false});
 else if(args==='on')await saveDailyBriefingSettings(store,{enabled:true});
 else if(/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(args))await saveDailyBriefingSettings(store,{enabled:true,time:args});
 else if(args)return reply('Use /briefing HH:mm in New York time, /briefing off, or /briefing on. Example: /briefing 08:00');
 const cfg=await readDailyBriefingSettings(store);
 return reply(`Daily briefing: ${cfg.enabled?'on':'off'}, ${cfg.time} America/New_York.\nClasses, due work, campus events, and recent matching jobs; times and locations, without descriptions.\nChange: /briefing 08:00\nPause: /briefing off\nSee today: /schedule\nCheck sources: /coverage`);
}
