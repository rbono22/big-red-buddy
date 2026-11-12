import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const context = vm.createContext({ Intl, Date });
vm.runInContext(await readFile(new URL('../public/schedule-groups.js', import.meta.url), 'utf8'), context);
const groups = events => context.groupClassSchedules(events);
const plain = value => JSON.parse(JSON.stringify(value));
function meeting(date, extra = {}) {
  return {
    id: date, kind: 'class', title: 'NBAY 5300 · Finance', sourceId: 'syllabus-finance',
    sourceName: 'Finance syllabus', courseId: 'NBAY5300', sectionId: 'LEC001', term: 'FA26',
    date, start: `${date}T13:25:00-05:00`, end: `${date}T14:40:00-05:00`,
    location: 'Tata L23', status: 'review', evidenceVerified: true, ...extra,
  };
}

test('groups actual recurring classes while keeping deadlines separate', () => {
  const events = ['2026-11-03', '2026-11-05', '2026-11-10', '2026-11-12'].map(date => meeting(date));
  events.push(meeting('2026-11-10', { id: 'assignment', kind: 'assignment' }));
  const result = groups(events);
  assert.equal(result.length, 1);
  const [pattern] = result[0].patterns;
  assert.equal(result[0].events.length, 4);
  assert.equal(pattern.label, 'Tue & Thu');
  assert.deepEqual(plain(pattern.weekdays), ['Tue', 'Thu']);
  assert.deepEqual(plain(pattern.dates), events.slice(0, 4).map(event => event.date));
  assert.deepEqual(plain(pattern.missingDates), []);
  assert.equal(pattern.startTime, '13:25');
  assert.equal(pattern.endTime, '14:40');
});

test('New York local times group across DST instead of separating UTC clock values', () => {
  const result = groups([
    meeting('2026-10-28', { start: '2026-10-28T17:25:00Z', end: '2026-10-28T18:40:00Z' }),
    meeting('2026-11-04', { start: '2026-11-04T18:25:00Z', end: '2026-11-04T19:40:00Z' }),
  ]);
  assert.equal(result[0].patterns.length, 1);
  assert.equal(result[0].patterns[0].startTime, '13:25');
  assert.deepEqual(plain(result[0].patterns[0].missingDates), []);
});

test('break gaps are disclosed without generating new meetings', () => {
  const source = ['2026-11-03', '2026-11-05', '2026-11-10', '2026-11-17', '2026-11-19'].map(date => meeting(date));
  const [group] = groups(source), [pattern] = group.patterns;
  assert.deepEqual(plain(pattern.missingDates), ['2026-11-12']);
  assert.equal(pattern.irregular, true);
  assert.equal(pattern.label, 'Tue & Thu · dates vary');
  assert.equal(group.events.length, source.length);
  assert.ok(group.events.every(event => source.includes(event)));
});

test('different local times, locations and overnight offsets remain distinct patterns', () => {
  const [group] = groups([
    meeting('2026-11-03'),
    meeting('2026-11-10', { location: 'Bloomberg 101' }),
    meeting('2026-11-17', { start: '2026-11-17T14:25:00-05:00', end: '2026-11-17T15:40:00-05:00' }),
    meeting('2026-11-24', { end: '2026-11-25T14:40:00-05:00' }),
  ]);
  assert.equal(group.patterns.length, 4);
  assert.equal(group.patterns[3].endDayOffset, 1);
  assert.equal(group.patterns[1].location, 'Bloomberg 101');
});

test('sections, courses, terms, sources and titles define separate course groups', () => {
  const source = [meeting('2026-11-03'),
    meeting('2026-11-03', { sectionId: 'LEC002' }),
    meeting('2026-11-03', { courseId: 'NBAY5400' }),
    meeting('2026-11-03', { term: 'SP27' }),
    meeting('2026-11-03', { sourceId: 'different-syllabus' }),
    meeting('2026-11-03', { title: 'Different class' }),
  ];
  assert.equal(groups(source).length, 6);
  const fallback = groups([
    meeting('2026-11-03', { courseId: undefined, sectionId: undefined, catalogCourseId: 'NBAY5300', catalogSectionId: 'LEC001' }),
    meeting('2026-11-10'),
  ]);
  assert.equal(fallback.length, 1);
});

test('source name is a fallback and does not collide with an explicit source ID', () => {
  assert.equal(groups([
    meeting('2026-11-03', { sourceId: '', sourceName: 'A' }),
    meeting('2026-11-10', { sourceId: null, sourceName: 'A' }),
    meeting('2026-11-17', { sourceId: null, sourceName: 'B' }),
    meeting('2026-11-24', { sourceId: 'A', sourceName: 'A' }),
  ]).length, 3);
});

test('review, approved, dismissed, cancelled and unsupported evidence retain individual events', () => {
  const source = [meeting('2026-11-03'),
    meeting('2026-11-10', { status: 'approved' }),
    meeting('2026-11-17', { status: 'dismissed' }),
    meeting('2026-11-24', { cancelled: true }),
    meeting('2026-12-01', { evidenceVerified: false }),
  ];
  for (const event of source) Object.freeze(event);
  Object.freeze(source);
  const [group] = groups(source);
  assert.equal(group.patterns.length, 1);
  assert.equal(group.events.length, source.length);
  source.forEach((event, index) => assert.equal(group.events[index], event));
});

test('invalid timestamps and impossible dates remain visible without throwing or assuming local timezone', () => {
  const source = [meeting('2026-11-03'),
    meeting('2026-11-10', { start: null, end: null }),
    meeting('2026-11-17', { start: 'invalid', end: 'invalid' }),
    meeting('2026-11-24', { start: '2026-11-24T13:25:00', end: '2026-11-24T14:40:00' }),
    meeting('2026-02-30'),
    meeting('2026-12-01', { start: '2026-12-02T13:25:00-05:00', end: '2026-12-02T14:40:00-05:00' }),
    meeting('2026-12-08', { end: '2026-12-08T12:25:00-05:00' }),
  ];
  const [group] = groups(source);
  assert.equal(group.events.length, source.length);
  assert.equal(group.patterns.length, 2);
  const invalid = group.patterns.find(pattern => pattern.invalidCount);
  assert.equal(invalid.invalidCount, 6);
  assert.equal(invalid.label, 'Time/date needs review');
  assert.equal(invalid.startTime, null);
  assert.deepEqual(plain(invalid.missingDates), []);
  assert.ok(!invalid.dates.includes('2026-02-30'));
});

test('a single class is labelled as one date and repeated imported rows are preserved', () => {
  const first = meeting('2026-11-03'), duplicate = meeting('2026-11-03', { id: 'other-id' });
  const [pattern] = groups([first, duplicate])[0].patterns;
  assert.equal(pattern.label, 'Single date · Tue');
  assert.equal(pattern.events.length, 2);
  assert.deepEqual(plain(pattern.dates), ['2026-11-03']);
});

test('empty and malformed collections are harmless and unnamed classes get readable titles', () => {
  for (const input of [null, undefined, {}, [], [null, {}, { kind: 'exam' }]]) assert.deepEqual(plain(groups(input)), []);
  assert.equal(groups([meeting('2026-11-03', { title: '' })])[0].title, 'Untitled class');
});

test('unusually broad date ranges bound gap detection without inventing dates', () => {
  const [pattern] = groups([meeting('2026-11-03'), meeting('2099-11-03')])[0].patterns;
  assert.equal(pattern.gapCheckLimited, true);
  assert.equal(pattern.irregular, true);
  assert.equal(pattern.events.length, 2);
  assert.deepEqual(plain(pattern.missingDates), []);
});
