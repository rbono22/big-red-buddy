/* Display-only grouping: imported events remain the sole source of calendar dates. */
(() => {
  'use strict';
  const DAY = 86_400_000;
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const localClock = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const text = value => typeof value === 'string' ? value : value == null ? '' : String(value);
  const firstValue = (...values) => values.find(value => value != null && value !== '') ?? '';
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  function dateMillis(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    const stamp = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? stamp : null;
  }
  function timestamp(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/);
    if (!match || dateMillis(match[1]) == null || +match[2] > 23 || +match[3] > 59 || +(match[4] || 0) > 59) return null;
    const millis = Date.parse(value);
    if (!Number.isFinite(millis)) return null;
    const parts = Object.fromEntries(localClock.formatToParts(new Date(millis)).map(part => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    return { millis, date, time: `${parts.hour}:${parts.minute}` };
  }
  function inspect(event, index) {
    const start = timestamp(event.start), end = timestamp(event.end);
    const sourceDate = dateMillis(event.date) == null ? null : event.date;
    // A conflict stays visible instead of silently choosing one of two dates.
    const invalid = !start || !end || end.millis <= start.millis ||
      (event.date != null && event.date !== '' && (!sourceDate || sourceDate !== start?.date));
    return {
      event, index, invalid,
      date: sourceDate || start?.date || null,
      startTime: invalid ? null : start.time,
      endTime: invalid ? null : end.time,
      endDayOffset: invalid ? 0 : Math.round((dateMillis(end.date) - dateMillis(start.date)) / DAY),
      location: text(event.location),
    };
  }
  function orderRows(a, b) {
    return compare(a.date || '9999-99-99', b.date || '9999-99-99') ||
      compare(a.startTime || '', b.startTime || '') || a.index - b.index;
  }
  function patternFor(key, rows) {
    rows.sort(orderRows);
    const first = rows[0], dates = [...new Set(rows.map(row => row.date).filter(Boolean))].sort();
    const firstDate = dates[0] || null, lastDate = dates.at(-1) || null;
    const weekdayIndexes = new Set(dates.map(date => (new Date(dateMillis(date)).getUTCDay() + 6) % 7));
    const weekdays = WEEKDAYS.filter((_, index) => weekdayIndexes.has(index));
    const missingDates = [], actual = new Set(dates);
    // Bound work for malformed or unusually broad imported ranges. Never expand events.
    const gapCheckLimited = dates.length > 1 && (dateMillis(lastDate) - dateMillis(firstDate)) / DAY > 1096;
    if (!first.invalid && !gapCheckLimited && dates.length > 1) {
      for (let day = dateMillis(firstDate); day <= dateMillis(lastDate); day += DAY) {
        const date = new Date(day).toISOString().slice(0, 10);
        if (weekdayIndexes.has((new Date(day).getUTCDay() + 6) % 7) && !actual.has(date)) missingDates.push(date);
      }
    }
    const irregular = first.invalid || missingDates.length > 0 || gapCheckLimited;
    const label = first.invalid ? 'Time/date needs review' : dates.length === 1 ?
      `Single date · ${weekdays[0]}` : `${weekdays.join(' & ')}${irregular ? ' · dates vary' : ''}`;
    return {
      key, label, startTime: first.startTime, endTime: first.endTime,
      endDayOffset: first.endDayOffset, weekdays, dates, firstDate, lastDate,
      location: first.location, missingDates, events: rows.map(row => row.event),
      invalidCount: rows.filter(row => row.invalid).length, irregular, gapCheckLimited,
    };
  }
  globalThis.groupClassSchedules = function groupClassSchedules(events) {
    const groups = new Map();
    for (const [index, event] of (Array.isArray(events) ? events : []).entries()) {
      if (!event || event.kind !== 'class') continue;
      const sourceId = text(event.sourceId), sourceName = text(event.sourceName);
      const courseId = text(firstValue(event.courseId, event.catalogCourseId));
      const sectionId = text(firstValue(event.sectionId, event.catalogSectionId));
      const term = text(event.term), title = text(event.title).trim() || 'Untitled class';
      const key = JSON.stringify([sourceId ? ['id', sourceId] : ['name', sourceName], courseId, sectionId, term, title]);
      if (!groups.has(key)) groups.set(key, { key, title, sourceName, sourceId, courseId, sectionId, term, rows: [] });
      groups.get(key).rows.push(inspect(event, index));
    }
    return [...groups.values()].map(group => {
      group.rows.sort(orderRows);
      const patterns = new Map();
      for (const row of group.rows) {
        const key = JSON.stringify([row.invalid, row.startTime, row.endTime, row.endDayOffset, row.location]);
        if (!patterns.has(key)) patterns.set(key, []);
        patterns.get(key).push(row);
      }
      const dates = [...new Set(group.rows.map(row => row.date).filter(Boolean))].sort();
      const { rows, ...identity } = group;
      return {
        ...identity, events: rows.map(row => row.event), dates,
        firstDate: dates[0] || null, lastDate: dates.at(-1) || null,
        patterns: [...patterns].map(([key, rows]) => patternFor(key, rows)),
      };
    }).sort((a, b) => compare(a.firstDate || '9999-99-99', b.firstDate || '9999-99-99') || compare(a.title, b.title) || compare(a.key, b.key));
  };
})();
