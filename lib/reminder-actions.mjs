import {saveReminderSettings} from './reminder-settings.mjs';
import {reconcileReminders} from './integrations.mjs';
import {idFor} from './domain.mjs';
export async function updateStudentReminders(store,patch,queue){
 const settings=await saveReminderSettings(store,patch);await reconcileReminders(store);
 let calendarTask=null,calendarError=null;
 const ids=(await store.all('events')).filter(e=>e.googleId&&e.status==='approved'&&!e.cancelled&&Date.parse(e.start)>Date.now()).map(e=>e.id);
 if(ids.length&&(await store.get('secrets','google'))?.refresh_token&&queue){try{const job=await queue.enqueue(store.userId,'google-sync',{eventIds:ids},{idempotencyKey:`reminder-settings:${idFor(JSON.stringify(settings))}`,retrySafe:false,maxAttempts:1});calendarTask={taskId:job.id};}catch{calendarError='Reminder settings saved. Google Calendar notification updates could not be queued; use Sync reviewed items in Connections.';}}
 return {settings,calendarTask,calendarError};
}
export function reminderSettingsText(settings){const show=values=>values.length?values.map(m=>m%1440===0?`${m/1440}d`:m%60===0?`${m/60}h`:`${m}m`).join(', ')+' before':'off';return `Your reminder settings\nClasses: ${show(settings.classes)}\nEvents: ${show(settings.events)}\nAssignments, quizzes, exams: ${show(settings.deadlines)}\nOnly approved dates with confirmed times send reminders.\nChange: /reminders classes 15m\n/reminders deadlines 1d 2h\n/reminders events off\n/reminders reset`;}
