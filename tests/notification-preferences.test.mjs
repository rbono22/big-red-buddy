import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../lib/database.mjs';
import {readNotificationPreferences,saveNotificationPreferences,notificationAllowed,activeDailyTopics,FRESH_NOTIFICATION_PREFERENCES} from '../lib/notification-preferences.mjs';

const NOW=Date.parse('2026-11-10T13:00:00Z');
async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'brf-notifications-')),db=await openDatabase({dataDir:dir,databaseUrl:null,production:false,allowLocal:true});t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});return {store:db.forUser('alice'),other:db.forUser('bob')};}

test('legacy notification defaults preserve existing topics; new accounts explicitly start with all topics off',async t=>{
 const {store,other}=await fixture(t),legacy=await readNotificationPreferences(store);
 assert.deepEqual(activeDailyTopics(legacy),['school','events','jobs']);assert.equal(legacy.topics.news,'off');assert.equal(legacy.topics.games,'off');
 await saveNotificationPreferences(store,FRESH_NOTIFICATION_PREFERENCES,{now:NOW});assert.deepEqual(activeDailyTopics(await readNotificationPreferences(store)),[]);
 assert.deepEqual(activeDailyTopics(await readNotificationPreferences(other)),['school','events','jobs']);
});

test('topic and master preferences preserve independent choices; games remain unavailable even with saved consent',async t=>{
 const {store}=await fixture(t);await saveNotificationPreferences(store,{topics:{school:'daily',events:'alerts',jobs:'off',news:'both',games:'both'}},{now:NOW});
 let p=await readNotificationPreferences(store);assert.deepEqual(activeDailyTopics(p),['school','news']);assert.equal(notificationAllowed(p,'events','alerts'),true);assert.equal(notificationAllowed(p,'school','alerts'),false);assert.equal(notificationAllowed(p,'games','daily'),false);assert.equal(p.topics.games,'both');assert.equal(p.available.games,false);
 await saveNotificationPreferences(store,{enabled:false},{now:NOW+1});p=await readNotificationPreferences(store);assert.deepEqual(activeDailyTopics(p),[]);assert.deepEqual(activeDailyTopics(p,{ignoreMaster:true}),['school','news']);
 await saveNotificationPreferences(store,{enabled:true},{now:NOW+2});assert.deepEqual((await readNotificationPreferences(store)).topics,p.topics);
});

test('notification edits validate bounded enum fields and concurrent changes retain both topics',async t=>{
 const {store}=await fixture(t);
 for(const patch of [null,[],{}, {enabled:'yes'},{userId:'bob'}, {topics:{}},{topics:{school:'weekly'}},{topics:{unknown:'daily'}},{topics:['daily']},{available:{games:true}}])await assert.rejects(saveNotificationPreferences(store,patch),{status:400});
 await Promise.all([saveNotificationPreferences(store,{topics:{school:'off'}}),saveNotificationPreferences(store,{topics:{news:'daily'}})]);
 const p=await readNotificationPreferences(store);assert.equal(p.topics.school,'off');assert.equal(p.topics.news,'daily');assert.equal(p.revision,2);
 await store.put('settings','notifications',{enabled:true,topics:{school:'bogus'}});assert.deepEqual(activeDailyTopics(await readNotificationPreferences(store)),[]);
 await assert.rejects(readNotificationPreferences({get:async()=>null}),/student-owned/);
});

test('replayed Telegram mutations cannot undo later choices and update sequence may reset after seven days',async t=>{
 const {store}=await fixture(t);await saveNotificationPreferences(store,{topics:{school:'off'}},{updateId:100,now:NOW});
 await saveNotificationPreferences(store,{topics:{school:'daily'}},{now:NOW+1});
 for(const updateId of [99,100]){const result=await saveNotificationPreferences(store,{topics:{school:'both'}},{updateId,now:NOW+2});assert.equal(result.replayed,true);assert.equal(result.topics.school,'daily');assert.equal(result.revision,2);}
 const reset=await saveNotificationPreferences(store,{topics:{school:'alerts'}},{updateId:1,now:NOW+7*86400000});assert.equal(reset.topics.school,'alerts');assert.equal(reset.revision,3);
});
