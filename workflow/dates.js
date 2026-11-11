function localDate(date) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string' || !value.trim()) return NaN;
  return /^-?\d+$/.test(value) ? Number(value) : Date.parse(value);
}

export function sessionTimestamp(header) {
  const updated = timestamp(header.updatedAt);
  return Number.isFinite(updated) ? updated : timestamp(header.createdAt);
}

export function sessionDateRanges(records, now = new Date()) {
  const today = localDate(now);
  const monday = new Date(now);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  let earliest;
  for (const { header } of records) {
    if (!header?.id || header.delegationDepth) continue;
    const created = timestamp(header.createdAt);
    for (const stamp of [created, sessionTimestamp(header)]) {
      if (!Number.isFinite(stamp)) continue;
      const day = localDate(new Date(stamp));
      if (!earliest || day < earliest) earliest = day;
    }
  }
  return {
    all: { since: earliest ?? '', until: today },
    today: { since: today, until: today },
    week: { since: localDate(monday), until: localDate(sunday) },
    month: { since: localDate(first), until: localDate(last) },
  };
}

function bound(value, end) {
  if (value === undefined || value === null || value === '') return end ? Infinity : -Infinity;
  if (typeof value !== 'string') throw Error(end ? '结束日期无效' : '起始日期无效');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value);
  // A date picker supplies a calendar day in the host time zone, not UTC midnight.
  const date = new Date(day ? value + 'T00:00:00' : value);
  if (!Number.isFinite(date.getTime()) || (day && localDate(date) !== value)) {
    throw Error(end ? '结束日期无效' : '起始日期无效');
  }
  if (day && end) {
    date.setDate(date.getDate() + 1);
    return date.getTime() - 1;
  }
  return date.getTime();
}

export function parseDateBounds({ since, until }) {
  const start = bound(since, false);
  const end = bound(until, true);
  if (start > end) throw Error('起始日期不能晚于结束日期');
  return { start, end };
}
