import test from 'node:test';
import assert from 'node:assert/strict';
import {eventApprovalVersion} from '../lib/event-version.mjs';

test('approval versions cover reviewed fields but ignore fetch timestamps and connector bookkeeping',()=>{
 const row={title:'Campus panel',date:'2026-11-12',start:'2026-11-12T22:00:00Z',end:'2026-11-12T23:00:00Z',endDate:null,allDay:false,location:'Tata L24',status:'available',cancelled:false,evidence:'Published event details',sourceUrl:'https://luma.com/panel',rsvpUrl:'https://luma.com/panel',localIntent:null,sourceCalendarId:'selected-calendar',addedEventId:null};
 const before=eventApprovalVersion(row);assert.match(before,/^[a-f0-9]{64}$/);
 for(const key of Object.keys(row))assert.notEqual(eventApprovalVersion({...row,[key]:typeof row[key]==='boolean'?!row[key]:`${row[key]??''}-changed`}),before,key);
 assert.equal(eventApprovalVersion({...row,fetchedAt:'later',updatedAt:'later',connector:'luma',remoteId:'same-event',warning:'Connection bookkeeping'}),before);
 assert.equal(eventApprovalVersion({...row,endDate:undefined}),before);
 assert.throws(()=>eventApprovalVersion(null),TypeError);
});
