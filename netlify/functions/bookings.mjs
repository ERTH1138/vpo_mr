// Netlify Function: fetches one month of bookings from the Skedda API.
// Needs two environment variables in Netlify:
//   SKEDDA_API_KEY  – venue API key from Skedda (Integrations → Developer)
//   APP_PASSWORD    – password people type on the page to use this function
// Optional: SKEDDA_TIMEZONE (default Europe/Budapest)

const API = 'https://api.skedda.com/api/v1/booking-occurrences';

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const pad = n => String(n).padStart(2, '0');

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Offset (minutes) of a time zone at a given instant
function offsetMin(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ts) / 60000);
}

// Local wall-clock time in tz -> ISO string with explicit offset (Skedda requires one)
function localIso(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let off = offsetMin(guess, tz);
  off = offsetMin(guess - off * 60000, tz);
  const a = Math.abs(off);
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

class SkeddaError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function fetchRange(key, from, to) {
  const out = [];
  let after = null;
  for (let guard = 0; guard < 200; guard++) {
    const qs = new URLSearchParams();
    qs.set('filter[dateTimeFrom]', from);
    qs.set('filter[dateTimeTo]', to);
    qs.set('expand', 'holder,spaces');
    qs.set('page[pageSize]', '100');
    if (after) qs.set('page[after]', after);

    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(`${API}?${qs}`, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
      if (res.status !== 429) break;
      const wait = Math.min(15, Number(res.headers.get('retry-after')) || 5);
      await new Promise(r => setTimeout(r, wait * 1000));
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = body.errors?.[0] || {};
      if (res.status === 401) throw new SkeddaError(502, 'Skedda rejected the API key (missing, wrong, expired or revoked). Check SKEDDA_API_KEY in Netlify.');
      if (res.status === 403) throw new SkeddaError(502, "Skedda says this venue's plan does not include API access.");
      throw new SkeddaError(502, `Skedda error ${res.status}: ${e.title || 'unknown error'}${e.requestId ? ` (request ${e.requestId})` : ''}`);
    }
    out.push(...(body.data || []));
    if (!body.paging || body.paging.isLast || !body.paging.cursor) break;
    after = body.paging.cursor;
  }
  return out;
}

export default async (req) => {
  const key = process.env.SKEDDA_API_KEY;
  const pass = process.env.APP_PASSWORD;
  if (!key || !pass) return json(500, { error: 'The site is not set up yet: add SKEDDA_API_KEY and APP_PASSWORD in Netlify → Environment variables, then redeploy.' });
  if (!safeEqual(req.headers.get('x-app-password') || '', pass)) return json(401, { error: 'Wrong password.' });

  const month = new URL(req.url).searchParams.get('month') || '';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return json(400, { error: 'Month must look like 2026-08.' });

  const tz = process.env.SKEDDA_TIMEZONE || 'Europe/Budapest';
  const [y, mo] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();

  try {
    // Two half-month requests: Skedda allows at most 31 days per request,
    // and a month with a daylight-saving change can exceed that by an hour.
    const parts = await Promise.all([
      fetchRange(key, localIso(y, mo, 1, 0, 0, 0, tz), localIso(y, mo, 15, 23, 59, 59, tz)),
      fetchRange(key, localIso(y, mo, 16, 0, 0, 0, tz), localIso(y, mo, last, 23, 59, 59, tz)),
    ]);
    const seen = new Set();
    const bookings = [];
    let blocked = 0;
    for (const o of parts.flat()) {
      const id = `${o.bookingId}|${o.start}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!o.start || o.start.slice(0, 7) !== month) continue;   // only occurrences starting in this month
      if (o.type === 'unavailable') { blocked++; continue; }       // "unavailable" blocks are not client bookings
      const h = o.holder || {};
      bookings.push({
        start: o.start,
        end: o.end,
        minutes: Math.round((Date.parse(o.end) - Date.parse(o.start)) / 60000),
        title: o.title || '',
        type: o.type,
        firstName: h.firstName || '',
        lastName: h.lastName || '',
        organization: h.organisation || '',
        spaces: (o.spaces || []).map(s => s.name || s.id).sort().join(', '),
      });
    }
    bookings.sort((a, b) => a.start.localeCompare(b.start));
    return json(200, { month, timezone: tz, count: bookings.length, skippedUnavailable: blocked, bookings });
  } catch (err) {
    return json(err.status || 500, { error: err.message || 'Unexpected error while contacting Skedda.' });
  }
};
