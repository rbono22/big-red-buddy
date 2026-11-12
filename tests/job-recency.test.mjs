import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePublishedAt,jobPublication,recentJobGroups} from '../lib/job-recency.mjs';
import {queuedNotification,dispatchQueuedTelegram} from '../lib/telegram-delivery.mjs';

const NOW=Date.parse('2026-11-10T12:00:00Z'),HOUR=3600000,DAY=24*HOUR;
const row=(id,age,extra={})=>({id,publishedAt:new Date(NOW-age).toISOString(),...extra});

test('publication timestamps require explicit valid date, time and timezone before normalization',()=>{
 assert.equal(normalizePublishedAt('2026-11-10T07:00:00-05:00'),'2026-11-10T12:00:00.000Z');
 assert.equal(normalizePublishedAt('2026-11-10T12:00Z'),'2026-11-10T12:00:00.000Z');
 assert.equal(normalizePublishedAt('2024-02-29T12:00:00.123Z'),'2024-02-29T12:00:00.123Z');
 for(const value of [null,0,{},'2026-11-10','Nov 10, 2026','2026-11-10T12:00:00','2026-11-10 12:00:00Z','2026-02-29T12:00:00Z','2026-02-30T12:00:00Z','2026-00-01T12:00:00Z','2026-13-01T12:00:00Z','2026-11-10T24:00:00Z','2026-11-10T12:60:00Z','2026-11-10T12:00:60Z','2026-11-10T12:00:00+15:00','2026-11-10T12:00:00+14:30'])assert.equal(normalizePublishedAt(value),null,String(value));
});

test('rolling windows are disjoint, inclusive at 24hours and7days, with no future tolerance',()=>{
 for(const age of [0,HOUR,DAY])assert.equal(jobPublication(row('one',age),{now:NOW}).bucket,'last24Hours');
 for(const age of [DAY+1,6*DAY,7*DAY])assert.equal(jobPublication(row('one',age),{now:NOW}).bucket,'pastWeek');
 assert.equal(jobPublication(row('one',7*DAY+1),{now:NOW}).reason,'older-than-seven-days');
 assert.equal(jobPublication(row('one',-1),{now:NOW}).reason,'publication-in-future');
 assert.equal(jobPublication(row('one',DAY),{now:()=>NOW}).eligible,true);
});

test('first-seen and update times never substitute for unknown or ambiguous publication',()=>{
 for(const publishedAt of [undefined,null,'2026-11-10','2026-11-10T10:00:00']){
  const result=jobPublication({publishedAt,firstSeenAt:new Date(NOW).toISOString(),fetchedAt:new Date(NOW).toISOString(),sourceUpdatedAt:new Date(NOW).toISOString()},{now:NOW});
  assert.equal(result.eligible,false);assert.equal(result.publishedAt,null);assert.equal(result.bucket,null);
 }
 assert.equal(jobPublication(row('one',HOUR,{publicationTimeVerified:false}),{now:NOW}).eligible,false);
});

test('retained provider evidence blocks legacy midnight normalization and changed timestamps',()=>{
 assert.equal(jobPublication(row('one',12*HOUR,{provider:'ashby',rawSource:{publishedAt:'2026-11-10'}}),{now:NOW}).eligible,false);
 assert.equal(jobPublication(row('one',HOUR,{provider:'greenhouse',rawSource:{updated_at:new Date(NOW-HOUR).toISOString()}}),{now:NOW}).eligible,false);
 assert.equal(jobPublication(row('one',HOUR,{provider:'ashby',rawSource:{publishedAt:new Date(NOW-2*HOUR).toISOString()}}),{now:NOW}).eligible,false);
 assert.equal(jobPublication(row('one',HOUR,{provider:'ashby',rawSource:{publishedAt:'2026-11-10T06:00:00-05:00'}}),{now:NOW}).eligible,true);
});

test('groups sort by source publication descending, deduplicate IDs and break ties deterministically',()=>{
 const input=[row('z',2*HOUR),row('week-old',6*DAY),row('a',2*HOUR),row('newest',HOUR),row('week-new',2*DAY),row('newest',4*DAY),row('stale',8*DAY),row('future',-HOUR),{id:'unknown',firstSeenAt:new Date(NOW).toISOString()}],original=structuredClone(input);
 const groups=recentJobGroups(input,{now:NOW});
 assert.deepEqual(groups.last24Hours.map(job=>job.id),['newest','a','z']);assert.deepEqual(groups.pastWeek.map(job=>job.id),['week-new','week-old']);assert.deepEqual(input,original);
 assert.deepEqual(recentJobGroups(input.toReversed(),{now:NOW}),groups);
});

test('inactive and explicitly nonmatching jobs are absent from shared groups',()=>{
 const input=['closed','cancelled','removed','not-matching','dismissed'].map((status,i)=>row(`status-${i}`,HOUR,{status}));input.push(row('flagged',HOUR,{closed:true}),row('outside-range',HOUR,{eligible:false}),row('active',HOUR,{status:'discovered',eligible:true}));
 assert.deepEqual(recentJobGroups(input,{now:NOW}).last24Hours.map(job=>job.id),['active']);
 let calls=0;recentJobGroups(input,{now:()=>{calls++;return NOW;}});assert.equal(calls,1,'one reference clock for a grouped response');
 assert.throws(()=>recentJobGroups([],{now:NaN}),/finite/);assert.throws(()=>recentJobGroups(null),/array/);
});

test('legacy and current queued job alerts always require publication guards at final send',async()=>{
 const legacy={idempotencyKey:'job-discovery:legacy:0',payload:{text:'Old unknown-date message'}};
 assert.deepEqual(queuedNotification(legacy),{channel:'alerts',topic:'jobs',requireCurrentMatching:true,requireCurrentPublication:true});
 const jobs=[{id:'a'.repeat(32),publishedAt:new Date(NOW-HOUR).toISOString(),bucket:'last24Hours'}],current={idempotencyKey:'job-discovery:current:0',payload:{text:'Synthetic current message',notification:{matchingFingerprint:'saved-fingerprint',jobs,requireCurrentPublication:false}}};
 assert.equal(queuedNotification(current).requireCurrentPublication,true);assert.deepEqual(queuedNotification(current).jobs,jobs);
 const result=await dispatchQueuedTelegram({userId:'synthetic'},current,{send:async(store,text,{notification})=>{assert.equal(notification.requireCurrentPublication,true);assert.deepEqual(notification.jobs,jobs);return {suppressed:true,reason:'publication-changed'};}});
 assert.deepEqual(result,{accepted:false,suppressed:true,reason:'publication-changed'});
});
