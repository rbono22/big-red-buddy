import {personalCalendarStatus,savePersonalCalendars} from './lib/personal-calendar.mjs';
import { pilotSheetConfig, isPilotOwner, createPilotSheetSync, PILOT_REFRESH_MS } from './lib/pilot-access.mjs';
import {readDailyBriefingSettings,saveDailyBriefingSettings,buildDailyBriefing} from './lib/daily-briefing.mjs';
import {getDailyEmailStatus,disconnectDailyEmail,scheduleDailyEmailPreview} from './lib/daily-email.mjs';
import {renderDailyEmail} from './lib/daily-email-template.mjs';
import {listCampusCalendars,selectCampusCalendar,addCampusEvent,saveCampusSettings} from './lib/campus-calendar.mjs';
import {listPartifulCalendars,selectPartifulCalendar,addPartifulEvent,savePartifulSettings,savePartifulIntent,disconnectPartifulCalendar} from './lib/partiful-calendar.mjs';
import {listLumaCalendars,selectLumaCalendar,addLumaEvent,saveLumaSettings,saveLumaIntent,disconnectLumaCalendar} from './lib/luma-calendar.mjs';
import {buildEventHub} from './lib/event-hub.mjs';
import {eventApprovalVersion} from './lib/event-version.mjs';
import {readNotificationPreferences,saveNotificationPreferences,FRESH_NOTIFICATION_PREFERENCES} from './lib/notification-preferences.mjs';
import {listNews,saveNewsSettings,listNewsLabels,selectNewsLabel,startAutomaticNews,disconnectNews} from './lib/news.mjs';
import {listAcademicCalendar,addAcademicCalendarEvents} from './lib/academic-calendar.mjs';
import {listEventEmailLabels,selectEventEmailLabel,enableAutomaticEventEmail,stopEventEmailMonitoring,disconnectEventEmail,listEventEmailInbox} from './lib/event-email.mjs';
import {getCareerProfile,saveCareerProfile,saveCareerAnswer} from './lib/career.mjs';
import {DEMOGRAPHIC_FIELDS,getDemographics,editDemographics} from './lib/demographics.mjs';
import {resumeReviewTemplate} from './lib/resume-template.mjs';
import {readCareerExperience,saveCareerExperience} from './lib/career-experience.mjs';
import {queueExperienceAnalysis} from './lib/career-experience-jobs.mjs';
import {importLinkedInConnections,readLinkedInConnections,deleteLinkedInConnections,matchLinkedInConnections,saveLinkedInConnectionSettings} from './lib/linkedin-connections.mjs';
import {listJobSources,resolveJobSearchSources,parseJobBoardURL} from './lib/job-source-catalog.mjs';
import {readJobDiscoverySettings,saveJobDiscoverySettings} from './lib/job-preferences.mjs';
import {refreshStoredJobMatches,jobMatchingFingerprint} from './lib/job-discovery.mjs';
import {listCareerJobs,setJobSaved} from './lib/job-saves.mjs';
import {listApplicationTracker,setApplicationStatus,startApplicationTracking,updateApplicationTracking} from './lib/application-tracker.mjs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { openDatabase } from './lib/database.mjs';
import { createQueue } from './lib/queue.mjs';
import { createAuth } from './lib/auth.mjs';
import { createSlackAuth } from './lib/slack-auth.mjs';
import { loadSecurityConfig, applySecurityHeaders, enforceRequestHost, enforceRequestOrigin, RateLimiter, clientIP, safeError, HttpError, createJsonBodyReader } from './lib/security.mjs';
import { TZ, idFor, normalizeEvent, calendarICS, localISO, calendarBounds } from './lib/domain.mjs';
import { connectCanvasFeed, disconnectCanvasFeed, readCanvasStatus, saveCourseAIPolicy } from './lib/canvas-feed.mjs';
import { readCanvasEmailStatus, setCanvasEmailWatching } from './lib/canvas-email.mjs';
import { persistCandidates } from './lib/ingest.mjs';
import { audit, nowISO, jsonFetch, reconcileReminders } from './lib/integrations.mjs';
import { createTelegramLink, disconnectTelegram } from './lib/telegram.mjs';
import { validateUpload } from './lib/job-handlers.mjs';
import { readReminderSettings } from './lib/reminder-settings.mjs';
import { updateStudentReminders } from './lib/reminder-actions.mjs';
import { validateEnrollmentUpload } from './lib/enrollment.mjs';
import { confirmEnrollmentProposal } from './lib/enrollment-workflow.mjs';
import { createCourseCatalog } from './lib/course-catalog.mjs';
import { importCourseSelection } from './lib/course-import.mjs';
import { studentMetrics, operationsMetrics } from './lib/metrics.mjs';
const courseCatalog = createCourseCatalog();
const ROOT = path.dirname(fileURLToPath(import.meta.url)),
  config = {...loadSecurityConfig(), pilotSheet: pilotSheetConfig()};
if (config.pilotSheet && !config.pilotEmails.includes(config.pilotSheet.owner)) throw new Error('Pilot sheet owner must be in the operator-managed pilot list.');
const PORT = Number(process.env.PORT || 4318),
  HOST = process.env.HOST || '127.0.0.1';
if (config.devEmails.length && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) throw new Error('Development sign-in requires a loopback listener.');
const database = await openDatabase({
  dataDir: process.env.ASSISTANT_DATA || path.join(ROOT, 'data')
});
const queue = await createQueue(database, {
  workerDatabaseUrl: null,
  maxPendingPerUser: 120
});
const auth = createAuth({
  database,
  config
});
const pilotSheet = createPilotSheetSync({database, config});
const slackAuth = createSlackAuth({
  database,
  auth,
  config
});
const limiter = new RateLimiter({
    limit: 180
  }),
  authLimiter = new RateLimiter({
    limit: 120
  }),
  heavyLimiter = new RateLimiter({
    limit: 8
  });
const adminEmails = String(process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const bodyOwners = new WeakMap(), readJsonBody = createJsonBodyReader();
function closeRequestAfterResponse(req, res) {
  if (!req || res.destroyed) return;
  res.shouldKeepAlive = false;
  if (!res.headersSent) res.setHeader('Connection', 'close');
  res.once('finish', () => req.destroy());
}
function json(res, status, value) {
  if (res.req && !res.req.complete) closeRequestAfterResponse(res.req, res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(value));
}
function redirect(res, target) {
  res.writeHead(303, {
    Location: target
  });
  res.end();
}
async function body(req) {
  return readJsonBody(req, {owner: bodyOwners.get(req) || `ip:${clientIP(req)}`});
}
function safeLink(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}
async function owned(store, bucket, id) {
  if (typeof id !== 'string' || !id || id.length > 200) throw new HttpError(404, 'Item not found.');
  const item = await store.get(bucket, id);
  if (!item) throw new HttpError(404, 'Item not found.');
  return item;
}
const publicTask = t => ({
  id: t.id,
  label: t.type,
  status: t.status === 'completed' ? 'done' : ['failed', 'needs_review'].includes(t.status) ? 'error' : t.status,
  started: t.createdAt,
  result: t.result,
  error: t.errorCode ? t.errorCode === 'SYLLABUS_OCR_FAILED' ? 'Could not read this syllabus. Use a clear JPG/PNG or an unlocked PDF of up to 6 pages (up to 4 scanned pages). Include the full dates and deadline rules.' : t.errorCode === 'SYLLABUS_EXTRACTION_FAILED' ? 'Could not extract deadline dates. Try a clearer page containing assignments and dates, and check private model availability in Connections.' : t.status === 'needs_review' ? 'Outcome uncertain. Check the connected service before retrying.' : 'Processing failed. Check source and service status, then retry.' : null
});
async function task(user, type, payload, options = {}) {
  try {
    const job = await queue.enqueue(user.id, type, payload, {
      maxAttempts: 2,
      retrySafe: true,
      ...options
    });
    return {
      taskId: job.id
    };
  } catch (e) {
    if (['STUDENT_QUEUE_FULL','STUDENT_MODEL_QUEUE_FULL'].includes(e.message)) throw new HttpError(429, 'Your processing queue is full. Let current tasks finish.');
    throw e;
  }
}
async function state(store) {
  const secretT = (await store.get('secrets', 'telegram')) || {},
    secretG = (await store.get('secrets', 'google')) || {},
    secretS = (await store.get('secrets', 'slack')) || {};
  const resume = await store.get('documents', 'resume');
  const academic=await listAcademicCalendar(store);
  const careerProfile=await getCareerProfile(store);
  delete careerProfile.veteranStatus; // Optional self-identification is loaded through its own authenticated form.
  return {
    notifications:await readNotificationPreferences(store),
    news:await listNews(store),
    eventHub:await buildEventHub(store),
    academicCalendar:academic.settings,
    canvas:{...await readCanvasStatus(store),email:await readCanvasEmailStatus(store)},
    eventEmail:await listEventEmailInbox(store),
    profile: await store.get('settings', 'profile'),
    reminderSettings: await readReminderSettings(store),
    personalCalendar: await personalCalendarStatus(store),
    dailyBriefing: await readDailyBriefingSettings(store),
    dailyEmail: await getDailyEmailStatus(store),
    campusEvents: await store.all('campusEvents'),
    campusCalendar: await store.get('settings','campusCalendar'),
    campusConnected: !!(await store.get('secrets','campusGoogle'))?.refresh_token,
    partifulEvents: await store.all('partifulEvents'),
    partifulCalendar: await store.get('settings','partifulCalendar'),
    partifulConnected: !!(await store.get('secrets','campusGoogle'))?.refresh_token,
    lumaEvents: await store.all('lumaEvents'),
    lumaCalendar: await store.get('settings','lumaCalendar'),
    lumaConnected: !!(await store.get('secrets','campusGoogle'))?.refresh_token,
    jobBoards: (await store.get('settings','jobBoards'))?.boards||[],
    jobAlertsHealth:await store.get('settings','jobAlertsHealth'),
    events: (await store.all('events')).sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date)),
    sources: await store.all('sources'),
    jobs: await listCareerJobs(store),
    linkedinConnections:await readLinkedInConnections(store),
    applications: await store.all('applications'),
    applicationTracker: await listApplicationTracker(store,{queue}),
    careerProfile,
    resumeReview: await store.get('career','resumeReview'),
    resumeReviewTemplate:resumeReviewTemplate(),
    careerExperience:await readCareerExperience(store),
    jobDiscovery:{...listJobSources(),settings:await readJobDiscoverySettings(store)},
    applicationAnswers: await store.all('applicationAnswers'),
    reminders: await store.all('reminders'),
    activity: (await store.all('activity')).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
    metrics: (await store.all('metrics')).slice(-50),
    capacity: await studentMetrics(database, queue, store.userId),
    resume: resume ? {
      name: resume.name,
      updatedAt: resume.updatedAt
    } : null,
    now: nowISO(),
    timezone: TZ,
    connections: {
      telegram: {
        configured: !!process.env.TELEGRAM_BOT_TOKEN,
        linked: !!secretT.chatId,
        bot: process.env.TELEGRAM_BOT_USERNAME || 'dabas_class_bot',
        linkCode: secretT.linkExpires > Date.now() ? secretT.linkCode : null,
        health: await database.system.get('serviceHealth', 'telegram')
      },
      google: {
        configured: !!config.googleClientId,
        connected: !!secretG.refresh_token,
        calendar: secretG.calendarId || null,
        health: await store.get('settings', 'googleHealth')
      },
      slack: {
        available: !!process.env.SLACK_CLIENT_ID,
        configured: !!secretS.userToken,
        channel: secretS.channel || '',
        health: await store.get('settings', 'slackHealth')
      },
      campusgroups: {
        connected: !!(await store.get('secrets','campusGoogle'))?.refresh_token,
        mode: (await store.get('settings','campusCalendar'))?.continuous?'Subscribed Google calendar':'Imported snapshot; connect calendar reading to refresh'
      },
      scheduler: await store.get('settings', 'scheduler'),
      jobs: await store.get('settings', 'jobsHealth')
    },
    tasks: (await queue.list(store.userId)).map(publicTask)
  };
}
async function route(req, res) {
  applySecurityHeaders(res, config);
  enforceRequestHost(req, config);
  const url = new URL(req.url, config.origin),
    p = url.pathname;
  if (p === '/healthz' && req.method === 'GET') {
    try {
      await database.health();
      return json(res, 200, {
        ok: true
      });
    } catch {
      return json(res, 503, {
        ok: false
      });
    }
  }
  const callback = p === '/auth/google/callback' || p === '/auth/slack/callback';
  const publicAsset=['/','/app.js','/schedule-groups.js','/career-search.js','/style.css'].includes(p)&&['GET','HEAD'].includes(req.method);
  if (!callback&&!publicAsset) enforceRequestOrigin(req, config);
  if (p === '/api/session' && req.method === 'GET') {
    const session = await auth.authenticate(req, {
      required: false
    });
    return json(res, 200, {
      user: session?.user || null,
      pilotAccessAdmin: isPilotOwner(config, session?.user),
      csrfToken: session?.csrfToken || null,
      ...auth.publicConfig()
    });
  }
  if (p.startsWith('/auth/')) authLimiter.check(clientIP(req));
  if (p === '/auth/google/start' && req.method === 'GET') {
    const result = await auth.beginGoogle(req, res, {
      purpose: 'login'
    });
    return redirect(res, result.url);
  }
  if (p === '/auth/google/callback' && req.method === 'GET') {
    const result = await auth.completeGoogle(req, res, url);
    if (result.purpose === 'pilot-sheet') await pilotSheet.sync();
    return redirect(res, result.redirectPath);
  }
  if (p === '/auth/dev' && req.method === 'POST') {
    const b = await body(req);
    await auth.devSignIn(req, res, b.email);
    return json(res, 200, {
      ok: true
    });
  }
  if (['/', '/app.js', '/schedule-groups.js', '/career-search.js', '/style.css'].includes(p) && ['GET', 'HEAD'].includes(req.method)) {
    const name = p === '/' ? 'index.html' : p.slice(1),
      data = await readFile(path.join(ROOT, 'public', name));
    res.writeHead(200, {
      'Content-Type': name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8'
    });
    return res.end(req.method === 'HEAD' ? '' : data);
  }
  const session = await auth.authenticate(req),
    user = session.user,
    store = database.forUser(user.id);
  bodyOwners.set(req, `student:${user.id}`);
  limiter.check(user.id);
  if (!['GET', 'HEAD'].includes(req.method)) auth.requireCSRF(req, session);
  if (p === '/auth/logout' && req.method === 'POST') {
    await auth.logout(req, res);
    return json(res, 200, {
      ok: true
    });
  }
  if (p === '/auth/slack/callback' && req.method === 'GET') {
    await slackAuth.complete(req, res, url, {
      userSession: session
    });
    return redirect(res, '/#connections');
  }
  if (p.startsWith('/api/pilot-access')) {
    if (!isPilotOwner(config, user)) throw new HttpError(403, 'Operator access required.', 'operator_required');
    if (p === '/api/pilot-access' && req.method === 'GET') return json(res, 200, await pilotSheet.status());
    if (p === '/api/pilot-access/connect' && req.method === 'POST') return json(res, 200, await auth.beginGoogle(req, res, {purpose: 'pilot-sheet', userSession: session}));
    if (p === '/api/pilot-access/sync' && req.method === 'POST') { heavyLimiter.check(user.id); return json(res, 200, await pilotSheet.sync()); }
    throw new HttpError(404, 'Not found.');
  }
  if ((await store.get('settings', 'account'))?.deleting && p !== '/api/delete-data') throw new HttpError(409, 'Account deletion in progress. Finish deletion before using the assistant.');
  if (!(await store.get('settings', 'profile'))) {
    await store.putIfAbsent('settings','notifications',{...FRESH_NOTIFICATION_PREFERENCES,revision:0,updatedAt:nowISO()});
    await store.putIfAbsent('settings', 'profile', {
    name: user.name || 'Student',
    email: user.email,
    model: process.env.OLLAMA_MODEL || 'qwen3.5:9b-q4_K_M',
    jobTitles: '',
    jobLocation: '',
    paused: false
    });
  }
  const last = await store.get('settings', 'lastActive');
  if (!last || last.at < Date.now() - 300000) await store.put('settings', 'lastActive', {
    at: Date.now()
  });
  if (p === '/api/reminders/settings' && req.method === 'GET') return json(res,200,await readReminderSettings(store));
  if(p==='/api/notifications/settings'&&req.method==='GET')return json(res,200,await readNotificationPreferences(store));
  if(p==='/api/notifications/settings'&&req.method==='POST')return json(res,200,await saveNotificationPreferences(store,await body(req)));
  if(p==='/api/career/experience'&&req.method==='GET')return json(res,200,await readCareerExperience(store));
  if(p==='/api/jobs/discovery/settings'&&req.method==='GET')return json(res,200,await readJobDiscoverySettings(store));
  if(p==='/api/jobs/sources'&&req.method==='GET')return json(res,200,listJobSources());
  if(p==='/api/career/linkedin'&&req.method==='GET')return json(res,200,await readLinkedInConnections(store));
  if(p==='/api/career/linkedin/matches'&&req.method==='GET'){
    const id=url.searchParams.get('jobId');if(!id||!/^[-a-zA-Z0-9._:]{1,200}$/.test(id))throw new HttpError(400,'Choose a saved job.');
    const job=await store.get('jobs',id);if(!job)throw new HttpError(404,'Choose a job in your own workspace.');
    return json(res,200,await matchLinkedInConnections(store,job.company));
  }
  if (p === '/api/reminders/settings' && req.method === 'POST') return json(res,200,await updateStudentReminders(store,await body(req),queue));
  if (p === '/api/enrollment/analyze' && req.method === 'POST') {
    heavyLimiter.check(user.id);const b=await body(req);
    if(!['FA26','SP27'].includes(b.term))throw new HttpError(400,'Choose Fall 2026 or Spring 2027.');
    validateEnrollmentUpload(b);
    return json(res,202,await task(user,'enrollment',{base64:b.base64,mimeType:b.mimeType,name:String(b.name||'Enrollment document').slice(0,160),term:b.term}));
  }
  if (p === '/api/enrollment/proposals' && req.method === 'GET') return json(res,200,(await store.all('enrollmentProposals')).filter(p=>p.expiresAt>Date.now()).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
  if (p === '/api/enrollment/dismiss' && req.method === 'POST') {
    const b = await body(req);
    if (typeof b.id !== 'string' || !/^[a-f0-9]{32}$/.test(b.id)) throw new HttpError(400, 'Choose an upload to dismiss.');
    const proposal = await store.get('enrollmentProposals', b.id);
    if (!proposal) throw new HttpError(404, 'That upload is no longer waiting for review.');
    if (proposal.status === 'review' && !await store.compareAndSet('enrollmentProposals', b.id, proposal, {...proposal, status: 'dismissed', dismissedAt: nowISO()})) throw new HttpError(409, 'That upload changed. Refresh and try again.');
    return json(res, 200, {dismissed: true});
  }
  if (p === '/api/enrollment/confirm' && req.method === 'POST') {
    heavyLimiter.check(user.id);return json(res,200,await confirmEnrollmentProposal(store,await body(req),{catalog:courseCatalog,queue}));
  }
  if (p === '/api/courses' && req.method === 'GET') {
    heavyLimiter.check(user.id);
    const term = url.searchParams.get('term') || 'FA26', q = url.searchParams.get('q') || '';
    if (!['FA26','SP27'].includes(term) || !q.trim() || q.length>100) throw new HttpError(400,'Choose a supported term and enter a course code or name, up to 100 characters.');
    return json(res, 200, await courseCatalog.search({term,q}));
  }
  if (p === '/api/courses/import' && req.method === 'POST') {
    heavyLimiter.check(user.id);
    const b = await body(req);
    if (!['FA26','SP27'].includes(b.term) || ![b.term,b.courseId,b.sectionId].every(v=>typeof v==='string' && v.length>0 && v.length<160)) throw new HttpError(400,'Choose a term, course, and exact section.');
    const selection = await courseCatalog.select({term:b.term,courseId:b.courseId,sectionId:b.sectionId});
    const result = await importCourseSelection(store,selection);
    let calendarTask = null, calendarError = null;
    if ((await store.get('secrets','google'))?.refresh_token) {
      try {calendarTask = await task(user,'google-sync',{eventIds:result.eventIds},{retrySafe:false,maxAttempts:1});}
      catch {calendarError='Classes saved; calendar sync could not be queued. Retry sync from Connections.';}
    }
    await audit(store,'course-import','Selected course section imported with student batch approval.');
    const {eventIds,...publicResult}=result;
    return json(res,200,{...publicResult,calendarTask,calendarError});
  }
  if (p === '/api/state' && req.method === 'GET') return json(res, 200, await state(store));
  if (p === '/api/tasks' && req.method === 'GET') return json(res, 200, (await queue.list(user.id)).map(publicTask));
  if (p === '/api/metrics' && req.method === 'GET') return json(res, 200, await studentMetrics(database, queue, user.id));
  if (p === '/api/operations' && req.method === 'GET') {
    if (!adminEmails.includes(user.email.toLowerCase())) throw new HttpError(403, 'Operator access required.');
    return json(res, 200, await operationsMetrics(database, queue));
  }
  if (p === '/api/health' && req.method === 'GET') {
    let model = {
      connected: false,
      models: []
    };
    try {
      const r = await jsonFetch(`${config.ollamaURL}/api/tags`, {
        signal: AbortSignal.timeout(2500)
      });
      model = {
        connected: true,
        models: (r.models || []).map(m => m.name)
      };
    } catch {}
    return json(res, 200, {
      model,
      storage: database.kind,
      mode: config.production ? 'Hosted pilot' : 'Local development',
      now: nowISO(),
      workers: (await database.system.all('workerHealth')).map(({
        role,
        lastSeen
      }) => ({
        role,
        lastSeen,
        stale: Date.now() - lastSeen > 60000
      }))
    });
  }
  if (p === '/api/calendar.ics' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'attachment; filename="cornell-tech-assistant.ics"'
    });
    return res.end(calendarICS(await store.all('events'), await readReminderSettings(store)));
  }
  if (p === '/api/evaluation.json' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="dabas-evaluation.json"'
    });
    return res.end(JSON.stringify({
      generatedAt: nowISO(),
      capacity: await studentMetrics(database, queue, user.id),
      metrics: await store.all('metrics'),
      reminders: (await store.all('reminders')).map(({
        id,
        status,
        due,
        sentAt,
        minutes,
        latenessMs
      }) => ({
        id,
        status,
        due,
        sentAt,
        minutes,
        latenessMs
      })),
      limitations: ['Deployment and provider consent must be completed before pilot use', 'Campus monitoring requires a selected subscribed calendar and read permission', 'Employer submissions use a local sandbox', 'No measured student time savings yet']
    }, null, 2));
  }
  if(p==='/api/career/packet'&&req.method==='GET'){
    const jobId=new URL(req.url,'http://localhost').searchParams.get('jobId');
    const job=await owned(store,'jobs',jobId);
    const profile=await getCareerProfile(store);
    const answers=(await store.all('applicationAnswers')).filter(a=>a.jobId===jobId&&a.status==='reviewed').map(a=>({question:a.question,answer:a.answer}));
    for(const application of (await store.all('applications')).filter(a=>a.jobId===jobId&&['reviewed','sandbox-submitted'].includes(a.status))){for(const [key,question] of [['whyCompany','Why this company?'],['relevantExperience','Relevant experience']])if(application.answers?.[key]&&!answers.some(a=>a.question===question))answers.push({question,answer:application.answers[key]});}
    res.setHeader('Content-Disposition','attachment; filename="brf-application-packet.json"');
    return json(res,200,{status:'prepared-not-submitted',job:{id:job.id,title:job.title,company:job.company,url:job.applyUrl||job.url},profile,answers,resume:(await store.get('documents','resume'))?.name||null,note:'Only student-saved profile values and reviewed answers are included. Unanswered fields must be completed. Check each employer question and upload your resume on its application form.'});
  }
  if(p==='/api/campus/calendars'&&req.method==='GET')return json(res,200,await listCampusCalendars(store));
  if(p==='/api/career/applications'&&req.method==='GET')return json(res,200,await listApplicationTracker(store,{queue}));
  if(p==='/api/career/demographics'&&req.method==='GET')return json(res,200,{...await getDemographics(store),fields:DEMOGRAPHIC_FIELDS});
  if(p==='/api/partiful/calendars'&&req.method==='GET')return json(res,200,await listPartifulCalendars(store));
  if(p==='/api/luma/calendars'&&req.method==='GET')return json(res,200,await listLumaCalendars(store));
  if(p==='/api/event-hub'&&req.method==='GET'){await listAcademicCalendar(store);return json(res,200,await buildEventHub(store));}
  if(p==='/api/event-email/labels'&&req.method==='GET')return json(res,200,await listEventEmailLabels(store));
  if(p==='/api/news'&&req.method==='GET')return json(res,200,await listNews(store));
  if(p==='/api/news/labels'&&req.method==='GET')return json(res,200,await listNewsLabels(store));
  if(p==='/api/academic'&&req.method==='GET')return json(res,200,await listAcademicCalendar(store));
  if(p==='/api/daily-briefing/preview'&&req.method==='GET')return json(res,200,await buildDailyBriefing(store));
  if(p==='/api/daily-email/preview'&&req.method==='GET'){
    const briefing=await buildDailyBriefing(store),email=renderDailyEmail(briefing,{name:user.name,appOrigin:config.origin});
    res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox allow-popups allow-popups-to-escape-sandbox");
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.end(email.html);
  }
  if (req.method !== 'POST') throw new HttpError(404, 'Endpoint not found.');
  if(p==='/api/career/demographics'){
    const input=await body(req);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||!Object.hasOwn(input,'values')||!Object.hasOwn(input,'expectedRevision')||typeof input.expectedRevision!=='string'||!/^r\d+\.p\d+$/.test(input.expectedRevision))throw new HttpError(400,'Review your optional choices before saving.');
    return json(res,200,{...await editDemographics(store,input.values,{expectedRevision:input.expectedRevision}),fields:DEMOGRAPHIC_FIELDS});
  }
  if(p==='/api/news/connect')return json(res,200,await auth.beginGoogle(req,res,{purpose:'event-email',userSession:session,returnPath:'/#news'}));
  if(p==='/api/news/settings')return json(res,200,await saveNewsSettings(store,await body(req)));
  if(p==='/api/news/automatic'){
    heavyLimiter.check(user.id);await startAutomaticNews(store,await body(req));return json(res,202,await task(user,'news-sync',{}, {retrySafe:false,maxAttempts:1}));
  }
  if(p==='/api/news/disconnect')return json(res,200,await disconnectNews(store));
  if(p==='/api/news/select'){
    heavyLimiter.check(user.id);await selectNewsLabel(store,await body(req));return json(res,202,await task(user,'news-sync',{}, {retrySafe:false,maxAttempts:1}));
  }
  if(p==='/api/news/sync'){
    heavyLimiter.check(user.id);return json(res,202,await task(user,'news-sync',{}, {retrySafe:false,maxAttempts:1}));
  }
  if(p==='/api/news/import'){
    heavyLimiter.check(user.id);const b=await body(req);
    if(typeof b.text!=='string'||b.text.trim().length<20||Buffer.byteLength(b.text)>100000||!['text','eml'].includes(b.format||'text')||!['wsj10point','dailypitch'].includes(b.provider))throw new HttpError(400,'Choose The 10-Point or The Daily Pitch and provide newsletter text or EML, up to 100 KB.');
    return json(res,202,await task(user,'news-import',{text:b.text,name:String(b.name||'Imported newsletter').slice(0,160),format:b.format||'text',provider:b.provider},{retrySafe:true,maxAttempts:2}));
  }
  if(p==='/api/event-email/connect')return json(res,200,await auth.beginGoogle(req,res,{purpose:'event-email',userSession:session,returnPath:'/#events'}));
  if(p==='/api/event-email/automatic'){
    heavyLimiter.check(user.id);await enableAutomaticEventEmail(store,await body(req));
    return json(res,202,await task(user,'event-email-sync',{}, {retrySafe:false,maxAttempts:1}));
  }
  if(p==='/api/event-email/stop')return json(res,200,await stopEventEmailMonitoring(store));
  if(p==='/api/event-email/disconnect')return json(res,200,await disconnectEventEmail(store));
  if(p==='/api/event-email/select'){
    heavyLimiter.check(user.id);await selectEventEmailLabel(store,await body(req));
    return json(res,202,await task(user,'event-email-sync',{}, {retrySafe:false,maxAttempts:1}));
  }
  if(p==='/api/event-email/sync'){
    heavyLimiter.check(user.id);return json(res,202,await task(user,'event-email-sync',{}, {retrySafe:false,maxAttempts:1}));
  }
  if(p==='/api/event-email/import'){
    heavyLimiter.check(user.id);const b=await body(req);
    if(typeof b.text!=='string'||b.text.trim().length<20||Buffer.byteLength(b.text)>100000||!['text','eml'].includes(b.format||'text'))throw new HttpError(400,'Paste event email text or import an .eml file, up to 100 KB.');
    return json(res,202,await task(user,'event-email-import',{text:b.text,name:String(b.name||'Imported event email').slice(0,160),format:b.format||'text'},{retrySafe:true,maxAttempts:2}));
  }
  if(p==='/api/canvas/connect'&&req.method==='POST'){
    heavyLimiter.check(user.id);const b=await body(req);
    await connectCanvasFeed(store,b.url);await audit(store,'canvas','Canvas calendar feed connected.');
    return json(res,202,{connected:true,...await task(user,'canvas-sync',{}, {retrySafe:true,maxAttempts:2})});
  }
  if(p==='/api/canvas/sync'&&req.method==='POST'){
    heavyLimiter.check(user.id);if(!(await store.get('secrets','canvasFeed'))?.url)throw new HttpError(409,'Connect your Canvas calendar feed first.');
    return json(res,202,await task(user,'canvas-sync',{}, {retrySafe:true,maxAttempts:2}));
  }
  if(p==='/api/canvas/disconnect'&&req.method==='POST'){
    const result=await disconnectCanvasFeed(store);await audit(store,'canvas','Canvas calendar feed disconnected; imported items kept.');return json(res,200,result);
  }
  if(p==='/api/canvas/email'&&req.method==='POST'){
    const b=await body(req),status=await setCanvasEmailWatching(store,{enabled:b.enabled});
    await audit(store,'canvas',`Canvas email watching ${status.enabled?'on':'off'}.`);
    return json(res,200,status.enabled?{...status,...await task(user,'canvas-email-sync',{}, {retrySafe:true,maxAttempts:2})}:status);
  }
  if(p==='/api/canvas/email/sync'&&req.method==='POST'){
    heavyLimiter.check(user.id);if(!(await store.get('settings','canvasEmail'))?.enabled)throw new HttpError(409,'Turn on Canvas email watching first.');
    return json(res,202,await task(user,'canvas-email-sync',{}, {retrySafe:true,maxAttempts:2}));
  }
  if(p==='/api/canvas/policy'&&req.method==='POST'){
    const b=await body(req);return json(res,200,await saveCourseAIPolicy(store,{courseCode:b.courseCode,policy:b.policy},{queue}));
  }
  if(p==='/api/academic/refresh'){
    heavyLimiter.check(user.id);return json(res,202,await task(user,'academic-refresh',{}, {retrySafe:true,maxAttempts:2}));
  }
  if(p==='/api/academic/add'){
    heavyLimiter.check(user.id);return json(res,200,await addAcademicCalendarEvents(store,await body(req),queue));
  }
  if(p==='/api/event-hub/add'){
    heavyLimiter.check(user.id);const b=await body(req);
    if(typeof b.id!=='string'||!/^[a-f0-9]{32}$/.test(b.id))throw new HttpError(404,'Event not found.');
    const item=(await buildEventHub(store)).items.find(item=>item.id===b.id);
    if(!item||['cancelled','dismissed'].includes(item.status))throw new HttpError(404,'This event is no longer available. Refresh your agenda.');
    if(typeof b.revision!=='string'||b.revision!==item.revision)throw new HttpError(409,'The event changed or the review expired. Refresh and check the latest details before adding.');
    const {kind,id}=item.action;
    const approval={expectedVersion:item.action.version};
    if(kind==='campus')return json(res,200,await addCampusEvent(store,{id},queue,approval));
    if(kind==='partiful')return json(res,200,await addPartifulEvent(store,{id},queue,approval));
    if(kind==='luma')return json(res,200,await addLumaEvent(store,{id},queue,approval));
    if(kind==='academic')return json(res,200,await addAcademicCalendarEvents(store,{ids:[id]},queue,approval));
    const event=await owned(store,'events',id);
    if(eventApprovalVersion(event)!==item.action.version)throw new HttpError(409,'The source changed while approving. Refresh and review the new details.');
    if(!event.start||event.evidenceVerified===false||event.cancelled||event.localIntent==='declined')throw new HttpError(400,'Review the source and confirm the missing date or time before adding.');
    let update={...event,status:'approved',reviewedAt:nowISO()};
    if(!event.end){
      if(!Number.isInteger(b.durationMinutes)||b.durationMinutes<1||b.durationMinutes>1440)throw new HttpError(400,'Confirm a duration between 1 and 1,440 minutes before adding this email event.');
      update={...update,end:new Date(Date.parse(event.start)+b.durationMinutes*60000).toISOString(),durationOrigin:'student',warning:'Duration supplied by student; check the original event for changes.'};
    }
    if(!Number.isFinite(Date.parse(update.end))||Date.parse(update.end)<=Date.parse(update.start))throw new HttpError(400,'Confirm a valid end time before adding.');
    if((event.status!=='approved'||!event.end)&&!await store.compareAndSet('events',id,event,update))throw new HttpError(409,'The event changed. Review its latest details before adding.');
    await reconcileReminders(store);
    let calendarTask=null,calendarError=null;
    if((await store.get('secrets','google'))?.refresh_token){try{calendarTask=await task(user,'google-sync',{eventIds:[id]},{retrySafe:false,maxAttempts:1});}catch{calendarError='Saved in BRB. Retry Google Calendar sync from Connections.';}}
    return json(res,200,{imported:1,calendarTask,calendarError});
  }
  if (['/api/upload', '/api/chat', '/api/studio/import', '/api/jobs/draft', '/api/slack/sync', '/api/jobs/search'].includes(p)) heavyLimiter.check(user.id);
  if (p === '/api/upload') {
    const b = await body(req);
    try {
      validateUpload(b);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    return json(res, 202, await task(user, 'pdf', {
      type: b.type,
      name: String(b.name || 'Document.pdf').slice(0, 200),
      ...(b.type==='syllabus'?{mimeType:b.mimeType||'application/pdf',term:b.term||'FA26'}:{}),
      base64: b.base64
    }));
  }
  if (p === '/api/settings') {
    const b = await body(req),
      old = await store.get('settings', 'profile'),
      next = {
        ...old
      };
    for (const key of ['name', 'jobTitles', 'jobLocation']) if (typeof b[key] === 'string') next[key] = b[key].slice(0, 500);
    if (typeof b.paused === 'boolean') next.paused = b.paused;
    await store.put('settings', 'profile', next);
    if(next.jobTitles!==old?.jobTitles||next.jobLocation!==old?.jobLocation)await refreshStoredJobMatches(store);
    return json(res, 200, {
      ok: true
    });
  }
  if (p === '/api/events/review') {
    const b = await body(req);
    if (!['approve', 'dismiss', 'cancel'].includes(b.action) || !Array.isArray(b.ids) || !b.ids.length || b.ids.length > 200) throw new HttpError(400, 'Choose items and a review action.');
    const selected = await Promise.all([...new Set(b.ids)].map(id => owned(store, 'events', id)));
    if(b.expected!==undefined){
      const keys=['id','title','kind','date','start','end','location','status','cancelled','evidenceVerified','evidence','updatedAt','sourceId'];
      if(!Array.isArray(b.expected)||b.expected.length!==selected.length||selected.some(event=>{const expected=b.expected.filter(item=>item?.id===event.id);return expected.length!==1||keys.some(key=>expected[0][key]!== (event[key]??null));}))throw new HttpError(409,'These dates changed since you opened this view. Refresh and review the updated schedule.');
    }
    if (b.action === 'cancel' && selected.some(e=>!e.cancelled)) throw new HttpError(400,'Only source-removed items can be confirmed for calendar removal.');
    const validAllDay = e => { if (!e.allDay) return false; try { calendarBounds(e); return true; } catch { return false; } };
    if (b.action === 'approve' && selected.some(e => (!validAllDay(e) && (!Number.isFinite(Date.parse(e.start)) || !Number.isFinite(Date.parse(e.end)) || Date.parse(e.end)<=Date.parse(e.start))) || e.evidenceVerified === false || e.cancelled)) throw new HttpError(400, 'Resolve missing start/end times and evidence before approval.');
    for (const e of selected) {
      const update={
      ...e,
      status: b.action === 'approve' ? 'approved' : b.action === 'cancel' ? 'cancel-approved' : 'dismissed',
      reviewedAt: nowISO()
      };
      if(b.expected!==undefined){if(!await store.compareAndSet('events',e.id,e,update))throw new HttpError(409,'A date changed while saving. Some reviews may have saved; refresh before reviewing the remaining dates.');}
      else await store.put('events',e.id,update);
    }
    await reconcileReminders(store);
    await audit(store, 'review', `${selected.length} schedule items reviewed.`);
    return json(res, 200, {
      count: selected.length
    });
  }
  if (p === '/api/events/time') {
    const b = await body(req),
      e = await owned(store, 'events', b.id);
    let start;
    try {
      start = localISO(e.date, b.time);
    } catch {
      throw new HttpError(400, 'Enter a valid New York time.');
    }
    await store.put('events', e.id, {
      ...e,
      time: b.time,
      start,
      end: e.connector==='event-email'?null:new Date(Date.parse(start) + 60000).toISOString(),
      warning: 'Time supplied by student; not independently established by source.',
      timeOrigin: 'student',
      status: 'review'
    });
    await reconcileReminders(store);
    return json(res, 200, {
      ok: true
    });
  }
  if (p === '/api/events/manual') {
    const b = await body(req);
    let e;
    try {
      e = normalizeEvent({
        title: String(b.title || '').slice(0, 300),
        date: b.date,
        time: b.time,
        endTime: b.endTime,
        location: String(b.location || '').slice(0, 500),
        kind: 'event',
        status: 'review',
        evidence: 'Event details entered by student.'
      });
    } catch {
      throw new HttpError(400, 'Enter a title, valid date and time.');
    }
    await persistCandidates(store, {
      id: idFor('manual', e.title, e.date),
      name: 'Student-entered event',
      type: 'event',
      url: safeLink(b.url),
      method: 'Manual entry'
    }, [e]);
    return json(res, 200, {
      ok: true
    });
  }
  if (p === '/api/studio/import') {
    const b = await body(req);
    if (typeof b.text !== 'string' || b.text.length < 20 || b.text.length > 55000) throw new HttpError(400, 'Paste announcement text, up to 55,000 characters.');
    return json(res, 202, await task(user, 'studio', {
      text: b.text,
      sourceUrl: safeLink(b.sourceUrl)
    }));
  }
  if (p === '/api/events/import-ics' && req.method === 'POST') {
    const b = await body(req);
    if (typeof b.text !== 'string' || b.text.length > 1024 * 1024) throw new HttpError(400, 'Provide a calendar export smaller than 1 MB.');
    if (/\nRRULE[:;]/.test(b.text)) throw new HttpError(400, 'Recurring calendar feeds are not supported yet. Export individual event occurrences.');
    const blocks = b.text.replace(/\r?\n[ \t]/g, '').split('BEGIN:VEVENT').slice(1);
    const events = [];
    const unescape = s => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
    for (const block of blocks) {
      const val = key => {
        const m = block.match(new RegExp('(?:^|\\n)' + key + '(?:;[^:\\r\\n]*)?:([^\\r\\n]*)'));
        return m ? unescape(m[1].trim()) : '';
      };
      const dt = val('DTSTART'),
        title = val('SUMMARY');
      if (!title || !/^\d{8}T\d{6}Z?$/.test(dt)) throw new HttpError(400, 'Each event needs a title and a full start time. All-day exports need manual review.');
      const date = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`,
        time = `${dt.slice(9, 11)}:${dt.slice(11, 13)}`;
      const tzid = block.match(/DTSTART;TZID=([^:;\r\n]+)/)?.[1];
      if (!dt.endsWith('Z') && tzid && tzid !== TZ) throw new HttpError(400, 'This export uses an unsupported timezone. Use UTC or America/New_York.');
      const e = normalizeEvent({
        title,
        kind: 'event',
        date,
        time,
        location: val('LOCATION'),
        evidence: val('DESCRIPTION') || 'Imported calendar event; review details.',
        sourceUid: val('UID')
      });
      if (dt.endsWith('Z')) {
        e.start = new Date(`${date}T${time}:${dt.slice(13, 15)}Z`).toISOString();
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone: TZ,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23'
        }).formatToParts(new Date(e.start)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
        e.date = `${parts.year}-${parts.month}-${parts.day}`;
        e.time = `${parts.hour}:${parts.minute}`;
        e.end = new Date(Date.parse(e.start) + 3600000).toISOString();
      }
      const end = val('DTEND');
      if (/^\d{8}T\d{6}Z$/.test(end)) e.end = new Date(`${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}T${end.slice(9, 11)}:${end.slice(11, 13)}:${end.slice(13, 15)}Z`).toISOString();else if (/^\d{8}T\d{6}$/.test(end)) e.end = localISO(`${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}`, `${end.slice(9, 11)}:${end.slice(11, 13)}`);
      if (e.end <= e.start) throw new HttpError(400, 'Calendar end time must follow start time.');
      events.push(e);
    }
    if (!events.length) throw new HttpError(400, 'No supported calendar events found.');
    const source = {
      id: idFor('campus-export', b.name || 'events.ics'),
      name: b.name || 'CampusGroups calendar export',
      type: 'event',
      method: 'Uploaded .ics export; no automatic refresh'
    };
    await persistCandidates(store, source, events);
    return json(res, 200, {
      count: events.length
    });
  }
  if (p === '/api/telegram/link') {
    try {
      return json(res, 200, await createTelegramLink(database, store));
    } catch {
      throw new HttpError(409, 'The operator must configure the shared Telegram bot first.');
    }
  }
  if (p === '/api/telegram/test') return json(res, 202, await task(user, 'telegram-send', {
    text: 'Big Red Buddy connection test · Your assistant can send reminders.'
  }, {
    retrySafe: false,
    maxAttempts: 1
  }));
  if (p === '/api/telegram/brief') return json(res, 202, await task(user, 'telegram-brief', {}, {
    retrySafe: false,
    maxAttempts: 1
  }));
  if(p==='/api/daily-briefing/settings'){
    const patch=await body(req);
    if(patch?.emailEnabled===true&&!(await getDailyEmailStatus(store)).connected)throw new HttpError(409,'Connect Gmail delivery before enabling the daily email.');
    return json(res,200,await saveDailyBriefingSettings(store,patch));
  }
  if(p==='/api/daily-email/connect')return json(res,200,await auth.beginGoogle(req,res,{purpose:'daily-email',userSession:session,returnPath:'/#connections'}));
  if(p==='/api/daily-email/disconnect')return json(res,200,await disconnectDailyEmail(store));
  if(p==='/api/daily-email/send'){
    const input=await body(req);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new HttpError(400,'Daily email is sent only to your connected Cornell account; no recipient or content overrides are supported.');
    const result=await scheduleDailyEmailPreview(store,queue);
    return json(res,202,result);
  }
  if(p==='/api/daily-briefing/send')return json(res,202,await task(user,'telegram-daily-preview',{}, {retrySafe:false,maxAttempts:1}));
  if(p==='/api/personal-calendar/connect')return json(res,200,await auth.beginGoogle(req,res,{purpose:'campus-calendar',userSession:session,returnPath:'/#connections'}));
  if(p==='/api/personal-calendar/settings'){heavyLimiter.check(user.id);return json(res,200,await savePersonalCalendars(store,await body(req)));}
  if(p==='/api/campus/connect')return json(res,200,await auth.beginGoogle(req,res,{purpose:'campus-calendar',userSession:session,returnPath:'/#events'}));
  if(['/api/partiful/telegram','/api/luma/telegram'].includes(p)&&req.method==='POST'){
    heavyLimiter.check(user.id);
    const provider=p.split('/')[2],input=await body(req);
    const {queueSocialEventCard}=await import('./lib/social-event-telegram.mjs');
    const result=await queueSocialEventCard(store,queue,provider,input.id,{idempotencyKey:`social-card-web:${randomBytes(12).toString('hex')}`});
    return json(res,202,result);
  }
  if(p==='/api/partiful/connect')return json(res,200,await auth.beginGoogle(req,res,{purpose:'campus-calendar',userSession:session,returnPath:'/#events'}));
  if(p==='/api/partiful/select'){
    heavyLimiter.check(user.id);const b=await body(req);await selectPartifulCalendar(store,{calendarId:b.calendarId,autoAdd:b.autoAdd??false});
    return json(res,202,await task(user,'partiful-sync',{}, {retrySafe:false,maxAttempts:1}));
  }
  if(p==='/api/partiful/settings'){
    const settings=await savePartifulSettings(store,await body(req));
    let refresh=null,refreshError=null;
    if(settings.autoAdd)try{refresh=await task(user,'partiful-sync',{}, {retrySafe:false,maxAttempts:1});}catch{refreshError='Auto-add is enabled, but the immediate refresh could not be queued. The next scheduled refresh will retry while the host is online.';}
    return json(res,200,{...settings,refreshTaskId:refresh?.taskId||null,refreshError});
  }
  if(p==='/api/partiful/disconnect')return json(res,200,await disconnectPartifulCalendar(store));
  if(p==='/api/partiful/sync'){
    heavyLimiter.check(user.id);return json(res,202,await task(user,'partiful-sync',{}, {retrySafe:false,maxAttempts:1}));
  }
  if(p==='/api/partiful/add'){
    heavyLimiter.check(user.id);const b=await body(req);await owned(store,'partifulEvents',b.id);return json(res,200,await addPartifulEvent(store,{id:b.id},queue));
  }
  if(p==='/api/partiful/intent'){
    const b=await body(req);await owned(store,'partifulEvents',b.id);return json(res,200,await savePartifulIntent(store,{id:b.id,intent:b.intent}));
  }
  if(p==='/api/luma/connect')return json(res,200,await auth.beginGoogle(req,res,{purpose:'campus-calendar',userSession:session,returnPath:'/#events'}));
  if(p==='/api/luma/select'){
    heavyLimiter.check(user.id);const b=await body(req);await selectLumaCalendar(store,{calendarId:b.calendarId,autoAdd:b.autoAdd??false});
    return json(res,202,await task(user,'luma-sync',{}, {retrySafe:false,maxAttempts:1}));
  }
  if(p==='/api/luma/settings'){
    const settings=await saveLumaSettings(store,await body(req));
    let refresh=null,refreshError=null;
    if(settings.autoAdd)try{refresh=await task(user,'luma-sync',{}, {retrySafe:false,maxAttempts:1});}catch{refreshError='Auto-add is enabled, but the immediate refresh could not be queued. The next scheduled refresh will retry while the host is online.';}
    return json(res,200,{...settings,refreshTaskId:refresh?.taskId||null,refreshError});
  }
  if(p==='/api/luma/disconnect')return json(res,200,await disconnectLumaCalendar(store));
  if(p==='/api/luma/sync'){
    heavyLimiter.check(user.id);return json(res,202,await task(user,'luma-sync',{}, {retrySafe:false,maxAttempts:1}));
  }
  if(p==='/api/luma/add'){
    heavyLimiter.check(user.id);const b=await body(req);await owned(store,'lumaEvents',b.id);return json(res,200,await addLumaEvent(store,{id:b.id},queue));
  }
  if(p==='/api/luma/intent'){
    const b=await body(req);await owned(store,'lumaEvents',b.id);return json(res,200,await saveLumaIntent(store,{id:b.id,intent:b.intent}));
  }
  if(p==='/api/campus/select'){
    heavyLimiter.check(user.id);const b=await body(req);await selectCampusCalendar(store,{calendarId:b.calendarId});
    return json(res,202,await task(user,'campus-sync',{}, {retrySafe:false,maxAttempts:1}));
  }
  if(p==='/api/campus/settings')return json(res,200,await saveCampusSettings(store,await body(req)));
  if(p==='/api/campus/sync'){
    heavyLimiter.check(user.id);return json(res,202,await task(user,'campus-sync',{}, {retrySafe:false,maxAttempts:1}));
  }
  if(p==='/api/campus/add'){
    heavyLimiter.check(user.id);const b=await body(req);await owned(store,'campusEvents',b.id);return json(res,200,await addCampusEvent(store,{id:b.id},queue));
  }
  if (p === '/api/google/connect') return json(res, 200, await auth.beginGoogle(req, res, {
    purpose: 'calendar',
    userSession: session
  }));
  if (p === '/api/google/sync') return json(res, 202, await task(user, 'google-sync', {}, {
    retrySafe: false,
    maxAttempts: 1
  }));
  if (p === '/api/slack/connect') return json(res, 200, await slackAuth.begin(req, res, {
    userSession: session
  }));
  if (p === '/api/slack/channel') {
    const b = await body(req);
    await slackAuth.selectChannel(store, b.channel);
    return json(res, 200, {
      ok: true
    });
  }
  if (p === '/api/slack/sync') return json(res, 202, await task(user, 'slack-sync', {}, {
    retrySafe: false,
    maxAttempts: 1
  }));
  if (p === '/api/jobs/search') {
    const b = await body(req);
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(key=>!['provider','board','careerUrl','sourceIds'].includes(key)))throw new HttpError(400,'Choose employer sources or leave sources blank for the recommended set.');
    const profile=await store.get('settings','profile'),resume=await store.get('documents','resume');
    if(!String(profile?.jobTitles||'').trim()&&!String(resume?.text||'').trim())throw new HttpError(400,'Add target job titles or upload a resume before searching.');
    const advanced=Object.hasOwn(b,'provider')||Object.hasOwn(b,'board'),url=Object.hasOwn(b,'careerUrl');
    if((advanced&&url)||(Object.hasOwn(b,'sourceIds')&&(advanced||url)))throw new HttpError(400,'Use one employer-source selection method.');
    let sources;
    if(advanced){if(!['greenhouse','ashby'].includes(b.provider)||typeof b.board!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(b.board))throw new HttpError(400,'Choose a supported provider and employer board in Advanced sources.');sources=[{provider:b.provider,board:b.board,name:b.board}];}
    else if(url){const parsed=parseJobBoardURL(b.careerUrl);sources=[{...parsed,name:parsed.board}];}
    else sources=resolveJobSearchSources({sourceIds:b.sourceIds,existingBoards:(await store.get('settings','jobBoards'))?.boards||[]});
    const experienceTask=await queueExperienceAnalysis(store,queue),fingerprint=await jobMatchingFingerprint(store),taskIds=[],warnings=[];
    for(const source of sources){try{const queued=await task(user,'jobs-search',{board:source.board,provider:source.provider},{priority:-10,idempotencyKey:`job-search:${source.provider}:${source.board}:${fingerprint}:${Math.floor(Date.now()/60000)}`});taskIds.push(queued.taskId);}catch(error){if(error.status!==429)throw error;warnings.push(`The queue is full; ${sources.length-taskIds.length} employer sources were not queued. Retry after current searches finish.`);break;}}
    if(!taskIds.length)throw new HttpError(429,'Your processing queue is full. Let current searches finish, then retry.');
    return json(res,202,{taskId:taskIds[0],taskIds:[...taskIds,...(experienceTask?[experienceTask.taskId]:[])],experienceTaskId:experienceTask?.taskId||null,sources:sources.slice(0,taskIds.length).map(source=>({provider:source.provider,board:source.board,name:source.name||source.board})),warnings,coverage:'Searches the listed employer sources only; it is not a whole-web search.'});
  }
  if(p==='/api/jobs/save')return json(res,200,await setJobSaved(store,await body(req)));
  if(p==='/api/jobs/discovery/settings'){const settings=await saveJobDiscoverySettings(store,await body(req));await refreshStoredJobMatches(store);return json(res,200,settings);}
  if(p==='/api/career/experience/analyze'){heavyLimiter.check(user.id);if(!(await store.get('documents','resume')))throw new HttpError(400,'Upload your resume first.');const result=await queueExperienceAnalysis(store,queue,{force:true});if(!result)throw new HttpError(400,'Upload a readable resume first.');return json(res,202,result);}
  if(p==='/api/career/experience'){const result=await saveCareerExperience(store,await body(req));await refreshStoredJobMatches(store);return json(res,200,result);}
  if(p==='/api/career/linkedin/import'){
    heavyLimiter.check(user.id);const b=await body(req);
    if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(key=>!['csv','name','expectedVersion','requestId'].includes(key)))throw new HttpError(400,'Upload your Connections.csv export.');
    const result=await importLinkedInConnections(store,{csv:b.csv,name:b.name},{...(Object.hasOwn(b,'expectedVersion')?{expectedVersion:b.expectedVersion}:{}),...(Object.hasOwn(b,'requestId')?{requestId:b.requestId}:{})});
    await audit(store,'linkedin-import','Student connection export imported privately.');return json(res,200,result);
  }
  if(p==='/api/career/linkedin/settings')return json(res,200,await saveLinkedInConnectionSettings(store,await body(req)));
  if(p==='/api/career/linkedin/delete'){const b=await body(req);if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).length)throw new HttpError(400,'Use an empty deletion request.');return json(res,200,await deleteLinkedInConnections(store));}
  if (p === '/api/career/profile') {
    const patch=await body(req);
    if(patch&&typeof patch==='object'&&Object.hasOwn(patch,'veteranStatus'))throw new HttpError(400,'Save veteran status in Optional self-identification. Refresh this page to use the updated form.');
    return json(res,200,await saveCareerProfile(store,patch));
  }
  if (p === '/api/career/answer-save') return json(res,200,await saveCareerAnswer(store,await body(req)));
  if (p === '/api/career/resume-review') {
    heavyLimiter.check(user.id);
    if(!(await store.get('documents','resume')))throw new HttpError(400,'Upload your resume first.');
    return json(res,202,await task(user,'resume-review',{}, {retrySafe:false,maxAttempts:1}));
  }
  if (p === '/api/career/answer-draft') {
    heavyLimiter.check(user.id);const b=await body(req);
    await owned(store,'jobs',b.jobId);
    if(!(await store.get('documents','resume')))throw new HttpError(400,'Upload your resume first.');
    if(typeof b.question!=='string'||b.question.trim().length<3||b.question.length>2000||typeof (b.guidance??'')!=='string'||(b.guidance||'').length>2000)throw new HttpError(400,'Use a question of 3–2,000 characters and guidance up to 2,000 characters.');
    return json(res,202,await task(user,'career-answer',{jobId:b.jobId,question:b.question,guidance:b.guidance||''},{retrySafe:false,maxAttempts:1}));
  }
  if (p === '/api/jobs/draft') {
    const b = await body(req);
    const job = await owned(store, 'jobs', b.id);
    if (!(await store.get('documents', 'resume'))) throw new HttpError(400, 'Upload your resume first.');
    const tracking = await startApplicationTracking(store, job, {source:'web'});
    try {
      const queued = await task(user, 'draft', {id:b.id,trackerId:tracking.id,trackerRequestId:tracking.requestId});
      await updateApplicationTracking(store,{id:tracking.id,requestId:tracking.requestId,status:'queued',taskId:queued.taskId});
      return json(res, 202, queued);
    } catch (error) {
      await updateApplicationTracking(store,{id:tracking.id,requestId:tracking.requestId,status:'needs_attention',errorCode:'QUEUE_REQUEST_FAILED'});
      throw error;
    }
  }
  if(p==='/api/career/application-status'){
    const b=await body(req);return json(res,200,await setApplicationStatus(store,{id:b.id,status:b.status}));
  }
  if (p === '/api/applications/review') {
    const b = await body(req),
      a = await owned(store, 'applications', b.id);
    await store.put('applications', a.id, {
      ...a,
      answers: {
        ...a.answers,
        whyCompany: String(b.whyCompany || '').slice(0, 5000),
        relevantExperience: String(b.relevantExperience || '').slice(0, 5000)
      },
      status: 'reviewed',
      reviewedAt: nowISO()
    });
    return json(res, 200, {
      ok: true
    });
  }
  if (p === '/api/applications/sandbox-submit') {
    const b = await body(req),
      a = await owned(store, 'applications', b.id);
    if (a.status !== 'reviewed') throw new HttpError(400, 'Review the application before sandbox submission.');
    const receipt = {
      ...a,
      status: 'sandbox-submitted',
      receipt: `LOCAL-${randomBytes(5).toString('hex').toUpperCase()}`,
      submittedAt: nowISO(),
      destination: 'LOCAL SANDBOX ONLY — no employer received this application'
    };
    await store.put('applications', a.id, receipt);
    return json(res, 200, {
      receipt: receipt.receipt
    });
  }
  if (p === '/api/chat') {
    const b = await body(req);
    if (typeof b.question !== 'string' || !b.question.trim() || b.question.length > 2000) throw new HttpError(400, 'Ask a question of up to 2,000 characters.');
    return json(res, 202, await task(user, 'chat', {
      question: b.question
    }));
  }
  if (p === '/api/reminders/tick') return json(res, 202, await task(user, 'reminders', {}, {
    priority: 100,
    retrySafe: false,
    maxAttempts: 1
  }));
  if (p === '/api/disconnect') {
    const b = await body(req);
    if (!['google', 'telegram', 'slack','campusGoogle'].includes(b.service)) throw new HttpError(400, 'Unknown connection.');
    if (await queue.hasRunning(user.id)) throw new HttpError(409, 'Wait for your running jobs to finish before disconnecting.');
    await queue.cancelPending(user.id);
    if (b.service === 'telegram') await disconnectTelegram(database, store);else await store.delete('secrets', b.service);
    if(b.service==='campusGoogle'){const personal=await store.get('settings','personalCalendar');if(personal)await store.put('settings','personalCalendar',{...personal,enabled:false,events:[],lastSuccess:null,lastError:null,revision:(personal.revision||0)+1});}
    if(b.service==='campusGoogle')for(const key of ['campusCalendar','partifulCalendar','lumaCalendar']){const old=await store.get('settings',key);if(old)await store.put('settings',key,{...old,continuous:false,autoAdd:false,warning:'Calendar reading disconnected; retained events are a snapshot.'});}
    await audit(store, 'connection', `${b.service} disconnected. Provider permissions may be revoked separately.`);
    return json(res, 200, {
      ok: true
    });
  }
  if (p === '/api/delete-data') {
    const b = await body(req);
    if (b.confirm !== 'DELETE MY DATA') throw new HttpError(400, 'Type DELETE MY DATA to confirm.');
    await store.put('settings', 'account', {
      deleting: true
    });
    await queue.cancelPending(user.id);
    if (await queue.hasRunning(user.id)) throw new HttpError(409, 'Processing is finishing. Retry deletion once running jobs stop.');
    await disconnectTelegram(database, store);
    try { await database.deleteStudent(user.id); } catch(e) { if(e.message==='STUDENT_JOBS_RUNNING')throw new HttpError(409,'Processing is finishing. Retry deletion shortly.'); throw e; }
    await auth.deleteIdentity(user.id);
    await auth.logout(req, res);
    return json(res, 200, {
      ok: true,
      note: 'Active assistant content and connections removed. Provider records and backup copies follow their separate retention policies.'
    });
  }
  throw new HttpError(404, 'Endpoint not found.');
}
const server = http.createServer({
  requestTimeout: 60000,
  headersTimeout: 15000,
  maxHeaderSize: 16384
}, (req, res) => {
  route(req, res).catch(err => {
    if (res.destroyed) return;
    if (err.closeConnection || !req.complete) closeRequestAfterResponse(req, res);
    const result = safeError(err);
    if (err.retryAfter) res.setHeader('Retry-After', err.retryAfter);
    if (!res.headersSent) json(res, result.status, result.body);else res.end();
  });
});
server.keepAliveTimeout = 5000;
server.listen(PORT, HOST, () => console.log(`Big Red Buddy web ready: ${config.origin} (${database.kind})`));
const pilotTimer = config.pilotSheet ? setInterval(() => void pilotSheet.sync().catch(() => {}), PILOT_REFRESH_MS) : null;
pilotTimer?.unref();
if (config.pilotSheet) void pilotSheet.sync().catch(() => {});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  if (pilotTimer) clearInterval(pilotTimer);
  server.close(async () => {
    await queue.close();
    await database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
