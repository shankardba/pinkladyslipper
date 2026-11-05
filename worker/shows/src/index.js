// Tour-dates Worker: reads the band's public Google Calendar (iCal feed) and
// returns upcoming shows as JSON for the site's Tour Dates section.
//
//   GET /api/shows             ->  { shows: [{ id, date, time, title, city, address, mapUrl, ticketUrl,
//                                              note, details, image, status }], updated }
//   GET /api/shows/image/<key> ->  the show's poster, fetched once and cached in KV
//
// Field mapping (see the client guide):
//   Title               venue name; a leading CANCELLED / SOLD OUT becomes `status`
//   Start date/time     `date` (YYYY-MM-DD, band time zone) and `time` ("8:00 PM", null for all-day)
//   Location            `city` ("Charlottesville, VA") and `mapUrl`
//   Description line 1  `ticketUrl` (first URL on that line)
//   Description rest    `note` (short, for the list) and `details` (full, for the pop-up)
//   Attached image      the first image attached to the event (Calendar stores it in
//                       Drive); served from this Worker as `image`
//   Visibility Private  hidden (CLASS:PRIVATE / CONFIDENTIAL)
//
// The parsed calendar is cached in KV for CACHE_SECONDS. If Google can't be
// reached, the last good copy is served, so the section never goes blank.
// Only shows dated today or later (in the band's time zone) are returned.
//
// Bindings: SHOWS (KV)   Vars: ICS_URL, ALLOWED_ORIGINS, TIME_ZONE, CACHE_SECONDS

const CACHE_KEY = 'calendar';
const IMAGE_TTL = 24 * 3600;          // seconds a cached poster is kept
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const path = url.pathname.replace(/\/+$/, '');
    const img = path.match(/^\/api\/shows\/image\/([A-Za-z0-9_-]{1,80})$/);
    if (img && request.method === 'GET') return serveImage(img[1], env, ctx);
    if (path !== '/api/shows') return new Response('Not found', { status: 404 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env, origin) });
    if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405, env, origin);

    const { events, updated } = await loadEvents(env, ctx);
    const tz = env.TIME_ZONE || 'America/New_York';
    const today = ymd(new Date(), tz);
    const shows = events
      .filter((e) => e.date >= today)
      .sort((a, b) => (a.date + (a.sortTime || '')).localeCompare(b.date + (b.sortTime || '')))
      .map(({ sortTime, imageSrc, ...show }) => ({
        ...show,
        image: imageSrc ? new URL('/api/shows/image/' + imageKey(imageSrc), url).href : null,
      }));
    return json({ shows, updated }, 200, env, origin, 'public, max-age=60');
  },
};

async function loadEvents(env, ctx) {
  const ttl = Number(env.CACHE_SECONDS || 600) * 1000;
  const cached = await env.SHOWS.get(CACHE_KEY, 'json');
  if (cached && Date.now() - cached.fetchedAt < ttl) return { events: cached.events, updated: cached.fetchedAt };

  try {
    const res = await fetch(env.ICS_URL, { headers: { 'User-Agent': 'pls-shows' } });
    if (!res.ok) throw new Error('ICS ' + res.status);
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Not an iCal feed');
    const events = parseCalendar(text, env.TIME_ZONE || 'America/New_York');
    const fetchedAt = Date.now();
    ctx.waitUntil(env.SHOWS.put(CACHE_KEY, JSON.stringify({ fetchedAt, events })));
    return { events, updated: fetchedAt };
  } catch (err) {
    // Serve the last good copy rather than an empty list.
    if (cached) return { events: cached.events, updated: cached.fetchedAt };
    return { events: [], updated: null };
  }
}

// ---------- iCal parsing ----------

function parseCalendar(text, tz) {
  // Unfold continuation lines (RFC 5545 3.1).
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT') { if (ev) events.push(ev); ev = null; continue; }
    if (!ev) continue;
    const m = line.match(/^([A-Z-]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    const [, name, paramStr, value] = m;
    const params = {};
    for (const p of paramStr.split(';').filter(Boolean)) {
      const [k, v] = p.split('=');
      params[k.toUpperCase()] = (v || '').replace(/^"|"$/g, '');
    }
    if (name === 'ATTACH') (ev.ATTACH_LIST ||= []).push({ value, params });
    else if (!(name in ev)) ev[name] = { value, params };
  }
  return events.map((e) => toShow(e, tz)).filter(Boolean);
}

function toShow(e, tz) {
  if (!e.DTSTART || !e.SUMMARY) return null;
  const cls = (e.CLASS && e.CLASS.value || '').toUpperCase();
  if (cls === 'PRIVATE' || cls === 'CONFIDENTIAL') return null;
  if ((e.STATUS && e.STATUS.value || '').toUpperCase() === 'CANCELLED') return null;

  let title = unescapeText(e.SUMMARY.value).trim();
  // A calendar shared as "free/busy only" publishes every event as a bare "Busy".
  if (title === 'Busy' && !e.LOCATION && !e.DESCRIPTION) return null;
  let status = null;
  const prefix = title.match(/^(cancell?ed|sold[\s-]*out)\b[\s:\-–—]*/i);
  if (prefix) {
    status = /^sold/i.test(prefix[1]) ? 'soldout' : 'cancelled';
    title = title.slice(prefix[0].length).trim() || title;
  }

  const start = parseDate(e.DTSTART, tz);
  if (!start) return null;

  const location = e.LOCATION ? unescapeText(e.LOCATION.value).trim() : '';
  const { ticketUrl, note, details } = parseDescription(e.DESCRIPTION ? unescapeText(e.DESCRIPTION.value) : '');
  const uid = e.UID ? e.UID.value : start.date + title;

  return {
    id: `${start.date}-${slug(title)}`,
    uid,
    date: start.date,
    time: start.time,
    sortTime: start.sortTime,
    title,
    city: cityFrom(location),
    address: location || null,
    mapUrl: location ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(location) : null,
    ticketUrl,
    note,
    details,
    imageSrc: imageFromAttachments(e.ATTACH_LIST),
    status,
  };
}

function parseDate(prop, tz) {
  const v = prop.value;
  if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, time: null, sortTime: '' };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  let instant;
  if (z) instant = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  else instant = zonedToUtc(+y, +mo, +d, +h, +mi, +s, prop.params.TZID || tz);
  return {
    date: ymd(instant, tz),
    time: new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(instant),
    sortTime: new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant),
  };
}

// Wall-clock time in a named zone -> UTC instant.
function zonedToUtc(y, mo, d, h, mi, s, zone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asZone = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return new Date(guess - (asZone - guess));
}

function ymd(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// "Rapture, 303 E Main St, Charlottesville, VA 22902, USA" -> "Charlottesville, VA"
function cityFrom(location) {
  const parts = location.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = parts.length - 1; i > 0; i--) {
    const st = parts[i].match(/^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/);
    if (st) return `${parts[i - 1]}, ${st[1]}`;
  }
  return null;
}

// Google stores descriptions typed in its web editor as HTML. The first line's
// URL is the ticket link; any other lines become a short note.
function parseDescription(raw) {
  const none = { ticketUrl: null, note: null, details: null };
  if (!raw) return none;
  let text = raw
    .replace(/<a\b[^>]*href="([^"]+)"[^>]*>.*?<\/a>/gi, ' $1 ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  text = decodeEntities(text);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return none;

  let ticketUrl = null;
  const first = lines[0].match(/https?:\/\/\S+/);
  if (first) {
    ticketUrl = unwrapGoogleRedirect(first[0].replace(/[).,]+$/, ''));
    lines.shift();
  }
  const details = lines.join('\n').slice(0, 1000) || null;
  const note = lines.join(' · ').slice(0, 160) || null;
  return { ticketUrl, note, details };
}

function unwrapGoogleRedirect(link) {
  try {
    const u = new URL(link);
    if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/url' && u.searchParams.get('q')) return u.searchParams.get('q');
  } catch { /* not a URL */ }
  return link;
}

function unescapeText(s) {
  return s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// ---------- Posters ----------

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'show';
}

// First image attachment. Google Calendar attachments are Drive files; FMTTYPE
// is usually set, otherwise trust the file name.
function imageFromAttachments(list) {
  for (const a of list || []) {
    const type = (a.params.FMTTYPE || '').toLowerCase();
    const name = (a.params.FILENAME || '').toLowerCase();
    if (type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic)$/.test(name)) return a.value;
  }
  return null;
}

function driveId(link) {
  try {
    const u = new URL(link);
    if (!/(^|\.)google\.com$/.test(u.hostname)) return null;
    const m = u.pathname.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/);
    return m ? m[1] : u.searchParams.get('id');
  } catch { return null; }
}

// Stable short key for a poster source: the Drive file id, or a hash of the URL.
function imageKey(src) {
  const id = driveId(src);
  if (id) return 'd' + id.slice(0, 70);
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 16777619) >>> 0;
  return 'u' + h.toString(36) + src.length.toString(36);
}

// Only posters attached to events on the current calendar can be fetched, so
// this endpoint can't be used to proxy arbitrary URLs. A poster cached in KV is
// served first. Attachments are private in Drive until read-only Google access
// is set up, so until then an uncached poster returns 502 and the site shows
// its fallback header.
async function serveImage(key, env, ctx) {
  const hit = await env.SHOWS.getWithMetadata('img:' + key, 'arrayBuffer');
  if (hit.value) return imageResponse(hit.value, hit.metadata && hit.metadata.type);

  const cached = await env.SHOWS.get(CACHE_KEY, 'json');
  const src = cached && cached.events.map((e) => e.imageSrc).find((s) => s && imageKey(s) === key);
  if (!src) return new Response('Not found', { status: 404 });

  const id = driveId(src);
  const fetchUrl = id ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w1400` : src;
  try {
    const res = await fetch(fetchUrl, { headers: { 'User-Agent': 'pls-shows' }, redirect: 'follow' });
    const type = (res.headers.get('Content-Type') || '').split(';')[0];
    if (!res.ok || !type.startsWith('image/')) return new Response('Image unavailable', { status: 502 });
    const body = await res.arrayBuffer();
    if (body.byteLength > IMAGE_MAX_BYTES) return new Response('Image too large', { status: 502 });
    ctx.waitUntil(env.SHOWS.put('img:' + key, body, { expirationTtl: IMAGE_TTL, metadata: { type } }));
    return imageResponse(body, type);
  } catch {
    return new Response('Image unavailable', { status: 502 });
  }
}

function imageResponse(body, type) {
  return new Response(body, {
    headers: { 'Content-Type': type || 'image/jpeg', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' },
  });
}

// ---------- HTTP ----------

function cors(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const headers = { 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
  if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(data, status, env, origin, cache = 'no-store') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache, ...cors(env, origin) },
  });
}
