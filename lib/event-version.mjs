import {createHash} from 'node:crypto';

const MATERIAL_FIELDS=Object.freeze(['title','date','start','end','endDate','allDay','location','status','cancelled','evidence','sourceUrl','rsvpUrl','localIntent','sourceCalendarId','addedEventId']);

/** Hash reviewed source details, excluding polling timestamps and connector bookkeeping. */
export function eventApprovalVersion(row){
  if(!row||typeof row!=='object'||Array.isArray(row))throw new TypeError('An event record is required.');
  return createHash('sha256').update(JSON.stringify(MATERIAL_FIELDS.map(field=>row[field]??null))).digest('hex');
}
