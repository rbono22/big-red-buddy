import test from 'node:test';
import assert from 'node:assert/strict';
import {persistCandidates} from '../lib/ingest.mjs';

test('changed syllabus contents reopen approval even when extracted dates match; unchanged imports preserve approval', async()=>{
  const rows=new Map(), key=(b,id)=>JSON.stringify([b,id]);
  const store={
    async get(b,id){return structuredClone(rows.get(key(b,id))||null);},
    async all(b){return [...rows].filter(([k])=>JSON.parse(k)[0]===b).map(([,v])=>structuredClone(v));},
    async put(b,id,v){rows.set(key(b,id),structuredClone(v));},
    async delete(b,id){rows.delete(key(b,id));}
  };
  const source={id:'syllabus',name:'Synthetic syllabus.pdf',type:'syllabus',hash:'original'};
  const event={title:'Final project',kind:'assignment',date:'2026-12-04',start:'2026-12-04T22:00:00Z',end:'2026-12-04T22:01:00Z',evidence:'Final project due December 4, 5pm.',evidenceVerified:true};
  await persistCandidates(store,source,[event]);
  const original=(await store.all('events'))[0];
  await store.put('events',original.id,{...original,status:'approved',googleId:'existing-calendar-item'});
  await persistCandidates(store,source,[event]);
  assert.equal((await store.get('events',original.id)).status,'approved');
  assert.equal((await store.get('sources',source.id)).lastChangedAt,null);
  await persistCandidates(store,{...source,hash:'changed-instructions'},[event]);
  const changed=await store.get('events',original.id),record=await store.get('sources',source.id);
  assert.equal(changed.status,'review');
  assert.equal(changed.googleId,'existing-calendar-item');
  assert.match(changed.warning,/Source changed/);
  assert.equal(record.previousHash,'original');
  assert.ok(Number.isFinite(Date.parse(record.lastChangedAt)));
  assert.match(record.warning,/need review again/);
  assert.equal((await store.all('events')).length,1);
  await persistCandidates(store,{...source,hash:'changed-instructions'},[event]);
  assert.equal((await store.get('events',original.id)).status,'review');
  assert.equal((await store.get('sources',source.id)).lastChangedAt,record.lastChangedAt);
});
