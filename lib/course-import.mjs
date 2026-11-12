import { idFor } from './domain.mjs';
import { HttpError } from './security.mjs';
import { reconcileReminders } from './integrations.mjs';

// The selected section is the approval boundary; caller supplies an authenticated store.
export async function importCourseSelection(store, selection, {now = () => new Date().toISOString()} = {}) {
  if (selection.blocked || !selection.events?.length) throw new HttpError(400, selection.blockedReason || selection.warnings?.join(' ') || 'This section has no supported published meeting schedule.');
  const {source,course,section} = selection;
  const sourceId = source.id || idFor('catalog',source.term || source.roster,course.id,section.id);
  const existing = await store.all('events'), ids = [], warnings = [...(selection.warnings || [])];
  let imported=0, reused=0;
  for (const candidate of selection.events) {
    const matching = existing.find(e => !e.cancelled && e.kind === 'class' && e.start === candidate.start && e.end === candidate.end &&
      (!e.catalogSectionId || e.catalogSectionId === section.id) &&
      (e.catalogCourseId === course.id || e.title?.startsWith(`${course.code} ·`) || e.title?.startsWith(`${course.code} `)));
    const id = matching?.id || candidate.id;
    if (!id || !candidate.start || !candidate.end || candidate.evidenceVerified === false) throw new HttpError(400,'A selected meeting is missing verified schedule details.');
    const old = await store.get('events',id);
    await store.put('events',id,{
      ...candidate,id,sourceId,sourceName:source.name || `${course.code} course catalog`,sourceUrl:source.url || source.sourceUrl || '',
      catalogCourseId:course.id,catalogSectionId:section.id,status:'approved',reviewedAt:now(),updatedAt:now(),
      approvalMethod:'Student selected this published section and requested calendar import',
      ...(old?.googleId ? {googleId:old.googleId,googleLink:old.googleLink} : {})
    });
    ids.push(id); old ? reused++ : imported++;
  }
  await store.put('sources',sourceId,{...source,id:sourceId,type:'course-catalog',name:source.name || `${course.code} course catalog`,count:ids.length,updatedAt:now()});
  await reconcileReminders(store);
  if(reused) warnings.push(`${reused} existing meetings were reused; no duplicate copies were added.`);
  return {imported,skipped:Array.isArray(selection.skipped) ? selection.skipped.length : selection.skipped || 0,reused,warnings,eventIds:ids};
}
