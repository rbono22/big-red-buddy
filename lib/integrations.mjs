import { calendarDescription, calendarLocation } from './calendar-description.mjs';
import { randomBytes } from 'node:crypto';
import { TZ, idFor, reminderSpecs,calendarBounds } from './domain.mjs';
import { modelJSON, extractEvents, persistCandidates } from './ingest.mjs';
import { readReminderSettings } from './reminder-settings.mjs';
import {readNotificationPreferences,notificationAllowed} from './notification-preferences.mjs';
import {validateTelegramReplyMarkup} from './telegram-delivery.mjs';
export const nowISO = () => new Date().toISOString();
export async function audit(store, kind, detail, extra = {}) {
  const id = randomBytes(8).toString('hex');
  await store.put('activity', id, {
    id,
    kind,
    detail,
    at: nowISO(),
    ...extra
  });
  const rows = (await store.all('activity')).sort((a, b) => b.at.localeCompare(a.at));
  for (const r of rows.slice(150)) await store.delete('activity', r.id);
}
export async function jsonFetch(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options.signal || AbortSignal.timeout(25000)
    });
  } catch {
    throw new Error('Connection failed or timed out. Check service availability.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Service returned HTTP ${response.status}. Check credentials and permissions.`);
  if (body.ok === false) throw new Error(`Service rejected request (${String(body.error || body.error_code || 'unknown').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 80)}).`);
  return body;
}
export async function telegramCall(store, method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('The shared Telegram bot has not been configured by the operator.');
  if (!['sendMessage','editMessageText','getUpdates','getMe','answerCallbackQuery'].includes(method)) throw new Error('Unsupported Telegram operation.');
  return jsonFetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(35000)
  });
}
export async function sendTelegram(store, text, {notification,replyMarkup,expectedChatId,expectedTelegramLinkedAt,editMessageId}={}) {
  const cfg = await store.get('secrets', 'telegram');
  if (!cfg?.chatId) throw new Error('Link your Telegram account with the one-time start code first.');
  if(expectedChatId!==undefined&&String(expectedChatId)!==String(cfg.chatId))return {suppressed:true,reason:'telegram-binding-changed'};
  if(expectedTelegramLinkedAt!==undefined&&String(cfg.linkedAt||'')!==expectedTelegramLinkedAt)return {suppressed:true,reason:'telegram-binding-changed'};
  if(editMessageId!==undefined&&(!Number.isSafeInteger(editMessageId)||editMessageId<=0||expectedChatId===undefined))throw new Error('Invalid Telegram message to update.');
  const markup=replyMarkup===undefined?undefined:validateTelegramReplyMarkup(replyMarkup);
  if(notification){
    const profile=await store.get('settings','profile'),prefs=await readNotificationPreferences(store),requested=notification.channel==='requested-daily'||['requested-jobs','requested-leads'].includes(notification.channel);
    if(!await (await import('./personal-calendar.mjs')).personalCalendarRevisionMatches(store,notification.personalCalendarRevision))return {suppressed:true,reason:'personal-calendars-changed'};
    const allowed=['requested-jobs','requested-leads'].includes(notification.channel)||((notification.channel==='daily'||notification.channel==='requested-daily')?Array.isArray(notification.topics)&&notification.topics.length>0&&notification.revision===prefs.revision&&notification.topics.every(topic=>notificationAllowed(prefs,topic,'daily',{ignoreMaster:requested})):notification.channel==='alerts'&&notificationAllowed(prefs,notification.topic,'alerts'));
    if(!allowed||profile?.paused&&!requested)return {suppressed:true,reason:'notification-preferences'};
    if(notification.requireCurrentMatching){
      const {jobMatchingFingerprint}=await import('./job-discovery.mjs');
      if(typeof notification.matchingFingerprint!=='string'||notification.matchingFingerprint!==await jobMatchingFingerprint(store))return {suppressed:true,reason:'job-matching-changed'};
    }
    if(notification.requireCurrentPublication){
      const {jobPublication}=await import('./job-recency.mjs'),items=notification.jobs;
      if(!Array.isArray(items)||!items.length||items.length>10)return {suppressed:true,reason:'job-publication-missing'};
      const now=Date.now();
      for(const item of items){
        if(typeof item?.id!=='string'||item.id.length>200)return {suppressed:true,reason:'job-publication-missing'};
        const job=await store.get('jobs',item.id),pub=jobPublication(job,{now});
        if(!job||job.closed||job.eligible===false||['closed','removed','cancelled','not-matching'].includes(job.status)||!pub.eligible||pub.publishedAt!==item.publishedAt||pub.bucket!==item.bucket)return {suppressed:true,reason:'job-publication-changed'};
      }
    }
    if(notification.channel==='requested-leads'){
      const {readLinkedInConnections}=await import('./linkedin-connections.mjs'),meta=await readLinkedInConnections(store);
      if(!meta.connected||!notification.linkedinSourceVersion||meta.sourceVersion!==notification.linkedinSourceVersion)return {suppressed:true,reason:'linkedin-export-changed'};
    }
    if(Object.hasOwn(notification,'linkedinRefreshVersion')){
      const {readLinkedInConnections}=await import('./linkedin-connections.mjs'),meta=await readLinkedInConnections(store);
      if(!meta.connected||!meta.refreshDays||!meta.refreshDue||meta.version!==notification.linkedinRefreshVersion)return {suppressed:true,reason:'linkedin-refresh-changed'};
    }
    if(notification.topic==='news'||notification.topics?.includes('news')){
      const news=await store.get('settings','news');
      if(!Object.hasOwn(notification,'newsSourceRevision')||notification.newsSourceRevision!==(news?.revision||null)||notification.provider&&!news?.sources?.includes(notification.provider))return {suppressed:true,reason:'news-sources-changed'};
    }
    if(notification.requireCurrentMatching){
      const [latestPrefs,latestProfile]=await Promise.all([readNotificationPreferences(store),store.get('settings','profile')]);
      if(!requested&&(latestPrefs.revision!==prefs.revision||latestProfile?.paused))return {suppressed:true,reason:'notification-preferences'};
    }
  }
  return telegramCall(store, editMessageId===undefined?'sendMessage':'editMessageText', {
    chat_id: cfg.chatId,
    ...(editMessageId!==undefined?{message_id:editMessageId}:{}),
    text: text.slice(0, 3900),
    ...(markup?{reply_markup:markup}:{}),
    link_preview_options: {
      is_disabled: true
    }
  });
}
export function reminderText(e, minutes) {
  if (e.allDay) {
    const day = new Intl.DateTimeFormat('en-US', {timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric'}).format(new Date(`${e.date}T12:00:00Z`));
    return `Due tomorrow · ${day}\n${e.title}\nNo time listed; check the source for the exact deadline.\nSource: ${e.sourceName}${e.sourceUrl ? '\n' + e.sourceUrl : ''}`;
  }
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(e.start));
  const remaining=Math.max(0,Math.ceil((Date.parse(e.start)-Date.now())/60000));
  const late=Math.max(0,Math.floor((Date.now()-(Date.parse(e.start)-minutes*60000))/60000));
  const heading=remaining>=120?`Scheduled in about ${(remaining/60).toFixed(1)} hours`:`Scheduled in ${remaining} minutes`;
  return `${heading}${late>1?` · reminder delayed ${late} minutes`:''}\n${e.title}\n${when} · New York\n${e.location || 'Location not published'}\nSource: ${e.sourceName}${e.page ? ' · page ' + e.page : ''}${e.sourceUrl ? '\n' + e.sourceUrl : ''}`;
}
async function replaceReminder(store,previous,next){
  if(store.compareAndSet)return store.compareAndSet('reminders',previous.id,previous,next);
  await store.put('reminders',previous.id,next);return true;
}
export async function reconcileReminders(store, {now = Date.now} = {}) {
  // A concurrent settings save gets another pass. Dispatch also checks the latest
  // preferences immediately before delivery instead of trusting stale pending rows.
  for(let pass=0;pass<3;pass++){
    const preferences=await readReminderSettings(store),specs=new Map(),at=now();
    for (const e of await store.all('events')) for (const r of reminderSpecs(e,preferences)) specs.set(r.id, r);
    for (const r of await store.all('reminders')) if (!specs.has(r.id) && r.status === 'pending') {
      await replaceReminder(store,r,{...r,status:'cancelled',cancelReason:'schedule-changed',cancelledAt:new Date(at).toISOString()});
    }
    for (const r of specs.values()) {
      const value={...r,status:Date.parse(r.due)<=at?'historical':'pending',attempts:0},previous=await store.get('reminders',r.id);
      if(!previous){
        if(store.putIfAbsent)await store.putIfAbsent('reminders',r.id,value);
        else await store.put('reminders',r.id,value);
      }else if(previous.status==='cancelled'&&previous.cancelReason==='schedule-changed'&&!previous.attempts){
        // Re-enable only an unsent occurrence. A due time that passed stays historical.
        await replaceReminder(store,previous,value);
      }
    }
    if(JSON.stringify(preferences)===JSON.stringify(await readReminderSettings(store)))return;
  }
}
const reminderRunning = new Set();
export async function dispatchReminders(store) {
  const owner = store.userId || store;
  if (reminderRunning.has(owner)) return {
    busy: true
  };
  reminderRunning.add(owner);
  try {
    await store.put('settings', 'scheduler', {
      lastRun: nowISO()
    });
    await reconcileReminders(store);
    const settings = (await store.get('settings', 'profile')) || {};
    const cfg = await store.get('secrets', 'telegram');
    if (settings.paused || !cfg?.chatId) return {
      sent: 0,
      reason: settings.paused ? 'paused' : 'telegram-not-linked'
    };
    const due = (await store.all('reminders')).filter(r => r.status === 'pending' && Date.parse(r.due) <= Date.now()).sort((a, b) => a.due.localeCompare(b.due));
    let sent = 0;
    for (const r of due.slice(0, 20)) {
      const event = await store.get('events', r.eventId);
      if (!event || event.status !== 'approved' || event.cancelled) {
        await replaceReminder(store, r, {
          ...r,
          status: 'cancelled'
        });
        continue;
      }
      if(!reminderSpecs(event,await readReminderSettings(store)).some(spec=>spec.id===r.id)){
        await replaceReminder(store,r,{...r,status:'cancelled',cancelReason:'schedule-changed',cancelledAt:nowISO()});
        continue;
      }
      const topic=event.academicCandidateId||event.connector==='academic'||event.kind!=='event'?'school':'events';
      if(!notificationAllowed(await readNotificationPreferences(store),topic,'alerts')){
        await replaceReminder(store,r,{...r,status:'suppressed',suppressedAt:nowISO(),reason:'notification-preferences'});continue;
      }
      if (Date.now() - Date.parse(r.due) > 30 * 60000 || Date.parse(event.start)<=Date.now()) {
        await replaceReminder(store, r, {
          ...r,
          status: 'missed'
        });
        await audit(store, 'reminder', 'A reminder missed its 30-minute delivery window.');
        continue;
      }
      // Mark before transmitting: uncertain outcomes require review, never an automatic duplicate.
      const sending = {
        ...r,
        status: 'sending',
        sendingAt: nowISO(),
        attempts: r.attempts + 1
      };
      if (store.compareAndSet) { if (!await store.compareAndSet('reminders', r.id, r, sending)) continue; }
      else await store.put('reminders', r.id, sending);
      const latestPreferences=await readReminderSettings(store);
      if(!reminderSpecs(event,latestPreferences).some(spec=>spec.id===r.id)){
        await replaceReminder(store,sending,{...r,status:'cancelled',cancelReason:'schedule-changed',cancelledAt:nowISO()});
        continue;
      }
      if((await store.get('settings','profile'))?.paused){await replaceReminder(store,sending,r);continue;}
      try {
        const {menuMarkup,eventActions}=await import('./telegram-menu.mjs');
        const replyMarkup=await menuMarkup(store,eventActions(event));
        const result = await sendTelegram(store, reminderText(event, r.minutes),{notification:{channel:'alerts',topic},replyMarkup});
        if(result?.suppressed){await replaceReminder(store,sending,{...r,status:'suppressed',suppressedAt:nowISO(),reason:'notification-preferences'});continue;}
        await store.put('reminders', r.id, {
          ...r,
          status: 'sent',
          sentAt: nowISO(),
          latenessMs: Math.max(0, Date.now() - Date.parse(r.due)),
          providerId: result.result.message_id
        });
        sent++;
        await audit(store, 'reminder', 'Telegram accepted a scheduled reminder.');
      } catch {
        await store.put('reminders', r.id, {
          ...r,
          status: 'needs-review',
          attempts: r.attempts + 1
        });
        await audit(store, 'error', 'Reminder delivery is uncertain. Review before retrying.');
      }
    }
    await store.put('settings', 'scheduler', {
      lastRun: nowISO()
    });
    return {
      sent
    };
  } finally {
    reminderRunning.delete(owner);
  }
}
export async function brief(store, days = 1) {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
  const end = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const rows = (await store.all('events')).filter(e => !e.cancelled && e.date >= date && e.date <= end).sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date));
  return `${days === 1 ? 'Your next day' : 'Your week'} at Cornell Tech\n\n` + (rows.slice(0, 12).map(e => `${e.date} ${e.time || 'Time needs confirmation'} · ${e.title}${e.status !== 'approved' ? ' [review]' : ''}\n${e.location || 'Location not published'}`).join('\n\n') || 'No imported items in this window. This does not establish that you have no obligations.');
}
export async function assistantReply(store, question) {
  const context = (await store.all('events')).filter(e => !e.cancelled).map(e => ({
    title: e.title,
    date: e.date,
    time: e.time,
    location: e.location,
    status: e.status,
    evidence: e.evidence,
    source: e.sourceName,
    page: e.page
  }));
  const result = await modelJSON(`Answer the student's question using ONLY the supplied schedule and sources. Today is ${nowISO()}, timezone America/New_York. If cited records have status review, explicitly say "Awaiting your review". Mention source name and page. Missing information is unknown. Never suggest the regular classroom as an exam room when the exam room is unspecified. You cannot change calendars or send anything. Return {"answer":"concise helpful answer"}. QUESTION: ${String(question).slice(0, 2000)}\nRECORDS: ${JSON.stringify(context).slice(0, 35000)}`, {
    profile: 'chat'
  });
  await store.put('metrics', randomBytes(8).toString('hex'), {
    ...result.metrics,
    task: 'assistant',
    at: nowISO()
  });
  return result.value.answer || 'No answer returned.';
}
export async function googleAccess(store) {
  const cfg = await store.get('secrets', 'google');
  if (!cfg?.refresh_token) throw new Error('Connect Google Calendar first.');
  if (cfg.access_token && cfg.expiresAt > Date.now() + 60000) return cfg.access_token;
  const result = await jsonFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: cfg.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  await store.put('secrets', 'google', {
    ...cfg,
    ...result,
    expiresAt: Date.now() + result.expires_in * 1000
  });
  return result.access_token;
}
export async function googleRequest(store, path, method = 'GET', body) {
  const token = await googleAccess(store);
  return jsonFetch(`https://www.googleapis.com/calendar/v3/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    ...(body ? {
      body: JSON.stringify(body)
    } : {})
  });
}
export async function syncGoogle(store, {eventIds = null} = {}) {
  const selected = eventIds === null ? null : new Set(eventIds);
  const reminderSettings=await readReminderSettings(store);
  let cfg = await store.get('secrets', 'google');
  if (!cfg?.refresh_token) throw new Error('Connect Google Calendar first.');
  if (!cfg.calendarId) {
    if(cfg.creationPending)throw new Error('Calendar creation outcome is uncertain. Resolve the existing calendar before retrying.');
    const creating={...cfg,creationPending:nowISO()};
    if(store.compareAndSet){if(!await store.compareAndSet('secrets','google',cfg,creating))throw new Error('Calendar connection changed. Wait for the active sync before retrying.');}
    else await store.put('secrets','google',creating);
    const cal = await googleRequest(store, 'calendars', 'POST', {
      summary: 'Cornell Tech Assistant',
      timeZone: TZ,
      description: 'Events reviewed in your local Big Red Buddy assistant.'
    });
    cfg = {
      ...(await store.get('secrets', 'google')),
      calendarId: cal.id,
      creationPending:null
    };
    await store.put('secrets', 'google', cfg);
  }
  let count = 0;
  for(const e of (await store.all('events')).filter(e=>(!selected || selected.has(e.id))&&e.cancelled&&e.status==='cancel-approved'&&e.googleId)) {
    try {await googleRequest(store,`calendars/${encodeURIComponent(cfg.calendarId)}/events/${encodeURIComponent(e.googleId)}`,'DELETE');}
    catch(error){if(!/HTTP (404|410)/.test(error.message))throw error;}
    await store.put('events',e.id,{...e,googleId:null,googleLink:null,removedFromGoogleAt:nowISO()});
  }
  for (const e of (await store.all('events')).filter(e => (!selected || selected.has(e.id)) && e.status === 'approved' && (e.allDay||e.start) && !e.cancelled)) {
    const eid = idFor('google', e.id),
      prefix = `calendars/${encodeURIComponent(cfg.calendarId)}/events`;
    const event = {
      summary: e.title,
      location: calendarLocation(e.location),
      description: calendarDescription(e),
      ...calendarBounds(e),
      reminders: {
        useDefault: false,
        overrides: reminderSpecs(e,reminderSettings).filter(r=>Date.parse(r.due)>Date.now()).map(r => ({
          method: 'popup',
          minutes: r.minutes
        }))
      },
      extendedProperties: {
        private: {
          dabasId: e.id
        }
      }
    };
    let result;
    // Stable IDs make retry after an uncertain insert safe.
    try {
      result = await googleRequest(store, `${prefix}/${eid}`, 'PUT', event);
    } catch (err) {
      if (!/HTTP 404/.test(err.message)) throw err;
      try {
        result = await googleRequest(store, prefix, 'POST', {
          ...event,
          id: eid
        });
      } catch (insertError) {
        if (!/HTTP 409/.test(insertError.message)) throw insertError;
        result = await googleRequest(store, `${prefix}/${eid}`, 'PUT', event);
      }
    }
    await store.put('events', e.id, {
      ...e,
      googleId: result.id,
      googleLink: result.htmlLink,
      syncedAt: nowISO()
    });
    count++;
  }
  await store.put('settings', 'googleHealth', {
    lastSuccess: nowISO(),
    count
  });
  await audit(store, 'calendar', `${count} reviewed calendar entries synchronized.`);
  return {
    count
  };
}
export async function slackCall(store, method, body = {}) {
  const cfg = await store.get('secrets', 'slack');
  if (!cfg?.userToken) throw new Error('Connect your Slack account first.');
  if (cfg.expiresAt && cfg.expiresAt <= Date.now()) throw new Error('Slack authorization expired. Reconnect Slack.');
  return jsonFetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.userToken}`,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(body)
  });
}
export async function ingestSlackMessage(store, message, {
  notify = false, queueNotification
} = {}) {
  const cfg = (await store.get('secrets', 'slack')) || {};
  if (!message.text || message.channel !== cfg.channel) return;
  const sourceId = idFor('slack', message.channel, message.ts),
    old = await store.get('sources', sourceId);
  if (old?.hash === idFor(message.text)) return;
  // Only date-bearing announcements become candidates; questions and general chat are skipped.
  if (/\?\s*$/.test(message.text) || !/due|deadline|upload|cancel|reschedul|moved|reminder|submit|important|announcement|please read|action required|feedback/i.test(message.text)) return;
  const source = {
    id: sourceId,
    name: 'Product Studio · Slack',
    type: 'slack',
    url: `${String(cfg.teamURL || 'https://cornelltech.slack.com').replace(/\/$/,'')}/archives/${message.channel}/p${message.ts.replace('.', '')}`,
    hash: idFor(message.text),
    author: message.user || 'Unknown',
    text: message.text.slice(0, 12000),
    method: 'Keyword-selected announcement; check original and author'
  };
  const hasDate = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|tomorrow)\w*\b|\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}/i.test(message.text);
  if (hasDate) {
    try {
      const result = await extractEvents(message.text, 'studio', (await store.get('settings', 'profile'))?.model);
      await persistCandidates(store, {
        ...source,
        method: result.method
      }, result.events);
    } catch {
      await store.put('sources', source.id, {
        ...source,
        count: 0,
        warning: 'Dates could not be resolved. Check original source.',
        updatedAt: nowISO()
      });
      for (const e of (await store.all('events')).filter(e => e.sourceId === source.id)) await store.put('events', e.id, {
        ...e,
        status: 'review',
        warning: 'Source changed but new dates could not be resolved. Review original.'
      });
      await reconcileReminders(store);
    }
  } else await store.put('sources', source.id, {
    ...source,
    count: 0,
    updatedAt: nowISO()
  });
  if (notify && (await store.get('secrets', 'telegram'))?.chatId && !(await store.get('settings', 'profile'))?.paused && notificationAllowed(await readNotificationPreferences(store),'school','alerts')) {
    try {
      const text=`Product Studio update · review the original\n\n${message.text.slice(0, 700)}\n\n${source.url}\nAny extracted dates need your review before calendar changes.`;
      if(queueNotification)await queueNotification({id:source.id,hash:source.hash,text});
      else await sendTelegram(store,text,{notification:{channel:'alerts',topic:'school'}});
    } catch {
      await audit(store, 'error', 'Telegram could not confirm a Studio update notification.');
    }
  }
  await audit(store, 'slack', 'A Product Studio announcement is ready for review.');
}
export async function syncSlack(store, {queueNotification} = {}) {
  const cfg = await store.get('secrets', 'slack');
  if (!cfg?.channel) throw new Error('Choose a Slack channel first.');
  const membership = await slackCall(store, 'conversations.info', {channel:cfg.channel});
  if (membership.channel?.is_member !== true) throw new Error('Your Slack account is not a member of this channel.');
  const health = (await store.get('settings', 'slackHealth')) || {};
  const oldest = health.cursor ? health.scanOldest : health.latest ? String(Math.max(0,Number(health.latest)-86400)) : undefined;
  const result = await slackCall(store, 'conversations.history', {
    channel: cfg.channel,
    limit: 15,
    ...(oldest ? {oldest} : {}),
    ...(health.cursor ? {cursor:health.cursor} : {})
  });
  let count = 0;
  for (const m of [...(result.messages || [])].reverse()) {
    await ingestSlackMessage(store, {
      ...m,
      channel: cfg.channel
    }, {notify:health.initialImportComplete===true,queueNotification});
    count++;
  }
  const latest = (result.messages || []).reduce((a, m) => Number(m.ts) > Number(a) ? m.ts : a, health.scanLatest || health.latest || '0');
  const cursor=result.response_metadata?.next_cursor||'';
  await store.put('settings', 'slackHealth', {
    ...health,
    lastSuccess: nowISO(),
    latest: result.has_more ? health.latest : latest,
    scanLatest: result.has_more ? latest : null,
    scanOldest: result.has_more ? oldest : null,
    cursor,
    initialImportComplete: health.initialImportComplete===true || !result.has_more,
    moreAvailable: !!result.has_more,
    warning: result.has_more&&!cursor?'Provider returned a partial page without a continuation cursor. Check Slack directly.':null,
    editCoverage:'Recent 24-hour overlap; older edits require manual source review.'
  });
  return {
    count,
    moreAvailable: !!result.has_more
  };
}
export async function fetchJobs(store, board, provider = 'greenhouse', options = {}) {
  const {refreshJobBoard}=await import('./job-discovery.mjs');
  const result=await refreshJobBoard(store,board,provider,options);
  if(!result.alreadyRunning)await audit(store,'jobs',`${result.count} roles matched using a title, resume-skill and location discovery heuristic. Source coverage is limited to this configured board.`);
  return result;
}

let jobPolling = false;
export async function pollJobBoards(store, options = {}) {
  if (jobPolling) return;
  jobPolling = true;
  try {
    for (const entry of ((await store.get('settings', 'jobBoards'))?.boards || []).filter(b => b.nextRun < Date.now()).slice(0, 2)) {
      try { await fetchJobs(store, entry.board, entry.provider, options); }
      catch { await audit(store, 'error', 'An employer board refresh failed. Per-board health records the retry time; existing results may be stale.'); }
    }
  } finally { jobPolling = false; }
}
