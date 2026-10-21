// The Trail: scan-to-collect Worker. Each QR code is a plain https link
// (PREFIX/s/<token>), so the phone's default camera app opens it in the
// browser: no app, no website to visit first. The Worker records the scan and
// answers with a finished HTML page ("Found N codes!"), so nothing else has to
// load or run on the visitor's phone.
//
// Identity: an anonymous visitor id kept in a first-party HttpOnly cookie that
// this Worker sets. Cookies set in a response header outlive Safari's 7-day
// cap on script-written storage, and nothing here needs JavaScript.
//
// Storage (D1):
//   spots(token PK, name, created_at)     one row per physical QR code
//   scans(visitor, token, scanned_at)     PRIMARY KEY (visitor, token), so a
//                                         visitor can only count a spot once
//
// Email recovery (optional, on when RESEND_API_KEY and EMAIL_FROM are set): a
// visitor can link an email, confirm it from a one-time emailed link, and get
// their collection back on a new phone the same way. Entering an email never
// shows anyone's progress; it only sends a link to that inbox. See email.js.
//   identities(email PK, visitor)     confirmed email -> canonical visitor
//   aliases(visitor PK, canonical)    visitor ids merged into one person
//   magic_tokens, email_sends         one-time links and rate limiting
//
// Bindings: DB (D1), LIST (optional KV: the mailing list, for the opt-in box)
// Vars:     SITE_NAME, SITE_URL (the main site, for the logo and back link),
//           PUBLIC_BASE (optional; origin for admin QR codes and emailed links),
//           EMAIL_FROM, TURNSTILE_SITE_KEY (optional)
// Secrets:  ADMIN_PASSWORD (required for /admin), RESEND_API_KEY,
//           TURNSTILE_SECRET (optional)

import { LOGO_LINE_DATA_URI } from './logo.js';
import { emailEnabled, sendLinkEmail } from './email.js';

const PREFIX = '/api/trail';
const COOKIE = 'pls_trail';
const TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (i, l, o, 0, 1)
const TOKEN_LENGTH = 8;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    if (path === PREFIX + '/admin' || path.startsWith(PREFIX + '/admin/')) {
      return admin(request, env, url, path);
    }

    const recovery = await recoveryRoute(request, env, ctx, url, path);
    if (recovery) return recovery;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (path === PREFIX) return collection(request, env, url);

    const scanMatch = path.match(/^\/api\/trail\/s\/([A-Za-z0-9]{4,32})$/);
    if (scanMatch) return scan(request, env, scanMatch[1], url);

    return new Response('Not found', { status: 404 });
  },
};

// ---------- visitor pages ----------

async function collection(request, env, url) {
  const gated = phoneOnlyGate(request, env, url);
  if (gated) return gated;
  const visitor = await getVisitor(env, request);
  if (request.method === 'HEAD') return htmlResponse('', 200, visitor);
  const { found, total } = await progress(env, visitor.id);
  const recoveryHtml = await recoveryCard(env, visitor.id, found.length);
  return htmlResponse(page(env, { found, total, recoveryHtml }), 200, visitor);
}

async function scan(request, env, token, url) {
  // Desktop browsers get a "phones only" page and nothing is recorded.
  const gated = phoneOnlyGate(request, env, url);
  if (gated) return gated;
  const visitor = await getVisitor(env, request);
  // Link-preview bots often send HEAD first; never count those as a scan.
  if (request.method === 'HEAD') return htmlResponse('', 200, visitor);

  const spot = await env.DB.prepare('SELECT token, name FROM spots WHERE token = ?').bind(token).first();
  if (!spot) {
    const { found, total } = await progress(env, visitor.id);
    const recoveryHtml = await recoveryCard(env, visitor.id, found.length);
    return htmlResponse(page(env, { found, total, banner: { tone: 'unknown' }, recoveryHtml }), 404, visitor);
  }

  const [insert, foundRows, totalRow] = await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO scans (visitor, token) VALUES (?, ?)').bind(visitor.id, token),
    foundQuery(env, visitor.id),
    env.DB.prepare('SELECT COUNT(*) AS n FROM spots'),
  ]);
  const isNew = insert.meta.changes > 0;
  const found = foundRows.results;
  const total = totalRow.results[0].n;
  const banner = { tone: isNew ? 'new' : 'repeat', name: spot.name };
  const recoveryHtml = await recoveryCard(env, visitor.id, found.length);
  return htmlResponse(page(env, { found, total, banner, recoveryHtml }), 200, visitor);
}

function foundQuery(env, visitorId) {
  return env.DB.prepare(
    `SELECT p.name AS name, s.scanned_at AS at
       FROM scans s JOIN spots p ON p.token = s.token
      WHERE s.visitor = ?
      ORDER BY s.scanned_at, s.rowid`,
  ).bind(visitorId);
}

async function progress(env, visitorId) {
  const [foundRows, totalRow] = await env.DB.batch([
    foundQuery(env, visitorId),
    env.DB.prepare('SELECT COUNT(*) AS n FROM spots'),
  ]);
  return { found: foundRows.results, total: totalRow.results[0].n };
}

// `cookieId` is what the browser holds; `id` is the person it belongs to. They
// differ once email recovery has merged two visitor ids into one.
async function getVisitor(env, request) {
  const match = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)pls_trail=([0-9a-f-]{36})(?:;|$)/);
  const cookieId = match ? match[1] : crypto.randomUUID();
  return { cookieId, id: match ? await resolveVisitor(env, cookieId) : cookieId };
}

async function resolveVisitor(env, id) {
  const alias = await env.DB.prepare('SELECT canonical FROM aliases WHERE visitor = ?').bind(id).first();
  return alias ? alias.canonical : id;
}

function htmlResponse(body, status, visitor) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Re-set on every visit so the year-long expiry slides forward.
      'Set-Cookie': `${COOKIE}=${visitor.cookieId}; Max-Age=31536000; Path=${PREFIX}; Secure; HttpOnly; SameSite=Lax`,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function plural(n) {
  return `${n} code${n === 1 ? '' : 's'}`;
}

function formatDay(sqliteUtc) {
  const date = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

function bannerHtml(banner, found, total) {
  if (!banner) return '';
  const all = total > 0 && found.length === total;
  if (banner.tone === 'unknown') {
    return `<p class="banner banner-unknown"><strong>That code isn't on the trail.</strong> Check the QR code and try again.</p>`;
  }
  if (banner.tone === 'info') {
    return `<p class="banner banner-new"><strong>${escapeHtml(banner.text)}</strong></p>`;
  }
  const lead = banner.tone === 'new'
    ? `<strong>New find: ${escapeHtml(banner.name)}</strong>`
    : `<strong>You already have ${escapeHtml(banner.name)}.</strong> Keep looking for the others.`;
  const tail = all ? ' You found every code on the trail!' : '';
  return `<p class="banner banner-${banner.tone}">${lead}${tail}</p>`;
}

function page(env, { found, total, banner, recoveryHtml }) {
  const n = found.length;
  const headline = n === 0 ? 'No codes yet' : `Found ${plural(n)}!`;
  const cards = found.map((f) => `
        <li class="card found">
          <svg class="icon" aria-hidden="true"><use href="#slipper-found" /></svg>
          <span class="card-name">${escapeHtml(f.name)}</span>
          <span class="card-note">Found ${escapeHtml(formatDay(f.at))}</span>
        </li>`);
  for (let i = n; i < total; i++) {
    cards.push(`
        <li class="card">
          <svg class="icon" aria-hidden="true"><use href="#slipper-unfound" /></svg>
          <span class="card-name">???</span>
          <span class="card-note">Not yet found</span>
        </li>`);
  }
  const progressPct = total ? Math.round((n / total) * 100) : 0;

  return `<!DOCTYPE html>
<html lang="en">
${head(env)}<body>
  <svg width="0" height="0" style="position:absolute" aria-hidden="true">
    <defs>
      <linearGradient id="pouch" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#f602bc" /><stop offset="1" stop-color="#b0128f" />
      </linearGradient>
      <symbol id="slipper-found" viewBox="0 0 48 48">
        <path d="M12 30C10 20 16 12 24 12s14 8 12 18c-2 8-22 8-24 0Z" fill="url(#pouch)" stroke="#02d565" stroke-width="2" stroke-linejoin="round" />
        <path d="M24 12C21 8 15 6 9 8M24 12c3-4 9-6 15-4" fill="none" stroke="#b0128f" stroke-width="2" stroke-linecap="round" />
        <path d="M18 30C16 22 8 26 6 34" fill="none" stroke="#02d565" stroke-width="1.6" stroke-linecap="round" opacity=".7" />
      </symbol>
      <symbol id="slipper-unfound" viewBox="0 0 48 48">
        <path d="M12 30C10 20 16 12 24 12s14 8 12 18c-2 8-22 8-24 0Z" fill="none" stroke="#b8a8d6" stroke-width="2" stroke-linejoin="round" />
        <path d="M24 12C21 8 15 6 9 8M24 12c3-4 9-6 15-4" fill="none" stroke="#b8a8d6" stroke-width="2" stroke-linecap="round" />
        <path d="M18 30C16 22 8 26 6 34" fill="none" stroke="#b8a8d6" stroke-width="1.6" stroke-linecap="round" opacity=".7" />
      </symbol>
    </defs>
  </svg>

  <main class="wrap">
    ${brandHtml(env)}
    ${phoneNote()}

    ${bannerHtml(banner, found, total)}

    <header class="head">
      <span class="eyebrow">The Trail</span>
      <h1 class="count">${headline}</h1>
      <p class="of">${n} of ${total} on the trail</p>
      <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${n}" aria-label="Codes found">
        <div class="fill" style="width:${progressPct}%"></div>
      </div>
    </header>

    <ul class="grid">${cards.join('')}
    </ul>

    ${recoveryHtml || ''}

    <p class="help">Pink lady's slippers are hiding around town. Scan the QR code on each one with your phone's camera to add it to your collection.</p>
  </main>
</body>
</html>`;
}

// ---------- phones only ----------

// The Trail is played by scanning a QR code with a phone, so a desktop browser
// gets a short explanation instead of the game, and nothing is recorded.
// Detection is best-effort and errs toward letting people in: Chromium sends
// client hints, other desktop browsers are caught by their user agent, and a
// "Macintosh" user agent is left alone because iPadOS Safari reports it too.
// A phone that trips this can add ?phone=1 (the page links to it).
function isDesktop(request) {
  const ua = request.headers.get('User-Agent') || '';
  const mobileHint = request.headers.get('Sec-CH-UA-Mobile');
  const platform = (request.headers.get('Sec-CH-UA-Platform') || '').replace(/"/g, '');
  if (mobileHint === '?1') return false;
  if (mobileHint === '?0' && ['Windows', 'macOS', 'Linux', 'Chrome OS', 'ChromeOS'].includes(platform)) return true;
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return false;
  return /Windows NT|X11|CrOS/i.test(ua);
}

function phoneOnlyGate(request, env, url) {
  if (url.searchParams.get('phone') === '1' || !isDesktop(request)) return null;
  const href = url.pathname + '?phone=1';
  return new Response(`<!DOCTYPE html>
<html lang="en">
${head(env)}<body>
  <main class="wrap">
    ${brandHtml(env)}
    ${phoneNote(href)}
  </main>
</body>
</html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Vary': 'User-Agent, Sec-CH-UA-Mobile, Sec-CH-UA-Platform',
      'X-Robots-Tag': 'noindex',
    },
  });
}

// With an href this is the server-rendered desktop page. Without one it is the
// copy of the same message that the stylesheet reveals for mouse-driven
// devices the server could not tell apart (for example Safari on a Mac).
function phoneNote(href) {
  return `<section class="desktop-note${href ? ' show' : ''}">
      <h1 class="count">Phones only</h1>
      <p>The Trail is a scavenger hunt around town. Scan the QR code on a pink lady's slipper with your phone's camera to play.</p>
      ${href ? `<p><a href="${escapeHtml(href)}">On a phone? Continue anyway</a></p>` : ''}
    </section>`;
}

function brandHtml(env) {
  const siteUrl = (env.SITE_URL || '').replace(/\/+$/, '');
  return `<a class="brand" href="${escapeHtml(siteUrl || '/')}">
      ${siteUrl ? `<img src="${escapeHtml(siteUrl)}/images/logo.webp" alt="" width="40" height="40" />` : ''}
      <span>Pink Lady Slipper</span>
    </a>`;
}

function head(env) {
  return `<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex" />
  <meta name="theme-color" content="#06040f" />
  <title>The Trail | ${escapeHtml(env.SITE_NAME || 'Pink Lady Slipper')}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bungee&family=Poppins:wght@600;700;800&family=Inter:wght@400;500;600&family=Kaushan+Script&display=swap" rel="stylesheet" />
  <style>${CSS}</style>
</head>
`;
}

const CSS = `
:root{--bg:#06040f;--bg-alt:#0f0a1f;--pink:#f602bc;--cyan:#02d3ff;--green:#02d565;--maroon:#b0128f;--text:#f7f2ff;--muted:#b8a8d6}
*{box-sizing:border-box;margin:0;padding:0}
body{background:radial-gradient(circle at 15% 0%,rgba(246,2,188,.28),transparent 45%),radial-gradient(circle at 90% 100%,rgba(61,43,255,.28),transparent 50%),var(--bg);background-attachment:fixed;color:var(--text);font-family:'Inter',system-ui,sans-serif;line-height:1.6;min-height:100vh}
.wrap{max-width:480px;margin:0 auto;padding:20px 20px 56px;display:flex;flex-direction:column;gap:22px}
.brand{display:flex;align-items:center;gap:10px;color:inherit;text-decoration:none;font-family:'Kaushan Script',cursive;font-size:1.4rem;background:linear-gradient(135deg,var(--pink),var(--cyan));-webkit-background-clip:text;background-clip:text}
.brand span{color:transparent}
.brand img{border-radius:50%;object-fit:cover}
.banner{padding:14px 16px;border-radius:14px;background:var(--bg-alt);border:1px solid rgba(2,211,255,.18);border-left:3px solid var(--cyan);font-size:1rem}
.banner strong{font-family:'Poppins',sans-serif;font-weight:700}
.banner-new{border-left-color:var(--green);box-shadow:0 0 24px rgba(2,213,101,.2)}
.banner-unknown{border-left-color:var(--maroon)}
.head{text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px}
.eyebrow{font-size:.8rem;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:var(--green)}
.count{font-family:'Bungee',sans-serif;font-weight:400;font-size:clamp(2rem,10vw,3rem);line-height:1.1;background:linear-gradient(135deg,var(--pink),var(--cyan));-webkit-background-clip:text;background-clip:text;color:transparent;text-wrap:balance}
.of{color:var(--muted);font-variant-numeric:tabular-nums}
.track{width:min(260px,70%);height:6px;margin-top:6px;border-radius:999px;background:var(--bg-alt);border:1px solid rgba(2,211,255,.18);overflow:hidden}
.fill{height:100%;background:linear-gradient(90deg,var(--green),var(--cyan))}
.grid{list-style:none;display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.card{display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;padding:16px 10px;border-radius:12px;background:var(--bg-alt);border:1px solid rgba(2,211,255,.12)}
.card.found{border-color:rgba(2,213,101,.35);box-shadow:0 0 18px rgba(2,213,101,.12)}
.icon{width:36px;height:36px}
.card-name{font-family:'Poppins',sans-serif;font-weight:600;font-size:.95rem}
.card:not(.found) .card-name{color:var(--muted);letter-spacing:2px}
.card-note{font-size:.8rem;color:var(--muted)}
.help{color:var(--muted);font-size:.9rem;text-align:center}
.wrap button{font:inherit;font-family:'Poppins',sans-serif;font-weight:600;padding:12px 20px;border:0;border-radius:999px;background:linear-gradient(135deg,var(--pink),var(--cyan));color:#10061a;cursor:pointer}
:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.recovery{display:flex;flex-direction:column;gap:12px;padding:18px;border-radius:14px;background:var(--bg-alt);border:1px solid rgba(2,211,255,.18)}
.recovery h2{font-family:'Poppins',sans-serif;font-size:1.05rem}
.recovery p,.recovery summary,.recovery label{color:var(--muted);font-size:.92rem}
.recovery form{display:flex;flex-direction:column;gap:10px}
.recovery input[type=email]{font:inherit;font-size:16px;padding:12px;border-radius:10px;border:1px solid #3a2d5c;background:var(--bg);color:var(--text);width:100%}
.recovery .check{display:flex;gap:10px;align-items:flex-start}
.recovery .check input{margin-top:5px}
.recovery summary{cursor:pointer}
.recovery details form{margin-top:12px}
.recovery .saved{color:var(--green);font-weight:600}
.prose{display:flex;flex-direction:column;gap:14px;align-items:center;text-align:center}
.prose p{color:var(--muted)}
.prose form{width:100%}
.prose a{color:var(--cyan)}
.desktop-note{display:none;flex-direction:column;align-items:center;gap:12px;text-align:center;padding-top:12vh}
.desktop-note.show{display:flex}
.desktop-note p{color:var(--muted);max-width:34ch}
.desktop-note a{color:var(--cyan)}
@media (hover:hover) and (pointer:fine){.wrap>:not(.brand):not(.desktop-note){display:none}.desktop-note{display:flex}}
@media (prefers-reduced-motion:no-preference){.banner{animation:in .45s ease}@keyframes in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}}
`;

// ---------- email recovery ----------

const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
const LINK_MINUTES = 15;
const MAX_PER_EMAIL_PER_HOUR = 3;
const MAX_PER_IP_PER_HOUR = 10;

async function recoveryRoute(request, env, ctx, url, path) {
  if (!emailEnabled(env)) return null;
  const method = request.method;

  if (method === 'POST' && (path === PREFIX + '/save' || path === PREFIX + '/restore')) {
    return requestLink(request, env, ctx, url, path.endsWith('/save') ? 'save' : 'restore');
  }
  if (method === 'GET' && path === PREFIX + '/sent') {
    return sentPage(request, env, url);
  }
  const linkMatch = path.match(/^\/api\/trail\/link\/([A-Za-z0-9_-]{20,64})$/);
  if (linkMatch && method === 'GET') return linkPage(request, env, url, linkMatch[1]);
  if (linkMatch && method === 'POST') return confirmLink(request, env, url, linkMatch[1]);
  return null;
}

// The reply never depends on whether the address is known: the work happens
// after the response (so timing doesn't give it away either), and the page
// always says "if this address qualifies, we sent a link".
async function requestLink(request, env, ctx, url, purpose) {
  if (!sameOrigin(request, url)) return new Response('Forbidden', { status: 403 });
  const form = await request.formData().catch(() => null);
  const visitor = await getVisitor(env, request);
  const input = {
    email: normalizeEmail(form && form.get('email')),
    joinList: purpose === 'save' && Boolean(form && form.get('join_list')),
    turnstile: form && form.get('cf-turnstile-response'),
    ip: request.headers.get('CF-Connecting-IP') || 'unknown',
  };
  const base = (env.PUBLIC_BASE || url.origin).replace(/\/+$/, '');
  ctx.waitUntil(
    processLinkRequest(env, input, visitor.id, purpose, base).catch((err) => console.error('link request failed', err)),
  );
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${PREFIX}/sent?for=${purpose}`,
      'Set-Cookie': `${COOKIE}=${visitor.cookieId}; Max-Age=31536000; Path=${PREFIX}; Secure; HttpOnly; SameSite=Lax`,
      'Cache-Control': 'no-store',
    },
  });
}

async function processLinkRequest(env, input, visitorId, purpose, base) {
  const { email, ip } = input;
  if (!email) return;
  if (env.TURNSTILE_SECRET && !(await verifyTurnstile(env.TURNSTILE_SECRET, input.turnstile, ip))) return;

  // Rate limit every attempt, known address or not, so the limit leaks nothing.
  await env.DB.prepare("DELETE FROM email_sends WHERE sent_at < datetime('now', '-1 day')").run();
  const countSince = (key) =>
    env.DB.prepare("SELECT COUNT(*) AS n FROM email_sends WHERE key = ? AND sent_at > datetime('now', '-1 hour')").bind(key);
  const [perEmail, perIp] = await env.DB.batch([countSince('e:' + email), countSince('i:' + ip)]);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO email_sends (key) VALUES (?)').bind('e:' + email),
    env.DB.prepare('INSERT INTO email_sends (key) VALUES (?)').bind('i:' + ip),
  ]);
  if (perEmail.results[0].n >= MAX_PER_EMAIL_PER_HOUR || perIp.results[0].n >= MAX_PER_IP_PER_HOUR) return;

  if (purpose === 'restore') {
    const known = await env.DB.prepare('SELECT 1 AS x FROM identities WHERE email = ?').bind(email).first();
    if (!known) return; // nothing to restore, and nothing is sent
  }

  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO magic_tokens (token_hash, purpose, email, visitor, join_list, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', '+${LINK_MINUTES} minutes'))`,
  ).bind(await sha256Hex(token), purpose, email, visitorId, input.joinList && env.LIST ? 1 : 0).run();
  await sendLinkEmail(env, { to: email, purpose, link: `${base}${PREFIX}/link/${token}` });
}

function sentPage(request, env, url) {
  const restore = url.searchParams.get('for') === 'restore';
  const body = restore
    ? `<p>If that address has saved progress, we've emailed you a link. Tap it on the phone you want your collection on.</p>`
    : `<p>We've emailed you a link to confirm. Tap it to finish saving your progress.</p>`;
  return proseResponse(env, 'Check your inbox', `${body}<p>It works once and expires in ${LINK_MINUTES} minutes.</p><p><a href="${PREFIX}">Back to my collection</a></p>`, 200);
}

// Opening the link only shows a button. The restore itself is a POST, so mail
// scanners that fetch links in advance can't use the link up.
async function linkPage(request, env, url, token) {
  const gated = phoneOnlyGate(request, env, url);
  if (gated) return gated;
  const row = await env.DB.prepare(
    "SELECT purpose FROM magic_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')",
  ).bind(await sha256Hex(token)).first();
  if (!row) return expiredPage(env);
  const save = row.purpose === 'save';
  const body = `<p>${save ? 'Link this email to your Trail collection so you can get it back later.' : 'Bring your saved collection onto this phone.'}</p>
    <form method="post" action="${PREFIX}/link/${escapeHtml(token)}"><button type="submit">${save ? 'Save my progress' : 'Restore my progress'}</button></form>`;
  return proseResponse(env, save ? 'Save your progress' : 'Restore your progress', body, 200);
}

async function confirmLink(request, env, url, token) {
  if (!sameOrigin(request, url)) return new Response('Forbidden', { status: 403 });
  const hash = await sha256Hex(token);
  const claim = await env.DB.prepare(
    "UPDATE magic_tokens SET used_at = datetime('now') WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')",
  ).bind(hash).run();
  if (claim.meta.changes !== 1) return expiredPage(env);
  const row = await env.DB.prepare('SELECT purpose, email, visitor, join_list FROM magic_tokens WHERE token_hash = ?').bind(hash).first();

  const here = await getVisitor(env, request); // the browser that tapped the link
  const known = await env.DB.prepare('SELECT visitor FROM identities WHERE email = ?').bind(row.email).first();
  let canonical;
  if (known) {
    canonical = await resolveVisitor(env, known.visitor);
  } else if (row.purpose === 'save') {
    canonical = await resolveVisitor(env, row.visitor);
    await env.DB.prepare('INSERT OR IGNORE INTO identities (email, visitor) VALUES (?, ?)').bind(row.email, canonical).run();
  } else {
    return expiredPage(env);
  }
  // Fold in whichever visitor ids belong to this person: the browser that
  // asked for the link and the one that opened it (they can differ, e.g. an
  // email app's built-in browser).
  await mergeVisitors(env, canonical, [row.visitor, here.cookieId, here.id]);
  if (row.join_list && env.LIST) await joinMailingList(env, row.email).catch((err) => console.error('mailing list opt-in failed', err));

  const { found, total } = await progress(env, canonical);
  const banner = { tone: 'info', text: row.purpose === 'save' ? 'Progress saved!' : 'Progress restored!' };
  const recoveryHtml = await recoveryCard(env, canonical, found.length);
  return htmlResponse(page(env, { found, total, banner, recoveryHtml }), 200, { cookieId: here.cookieId, id: canonical });
}

async function mergeVisitors(env, canonical, others) {
  const ids = [...new Set(others)].filter((id) => id && id !== canonical);
  const statements = [];
  for (const other of ids) {
    statements.push(
      env.DB.prepare('INSERT OR IGNORE INTO scans (visitor, token, scanned_at) SELECT ?, token, scanned_at FROM scans WHERE visitor = ?').bind(canonical, other),
      env.DB.prepare('DELETE FROM scans WHERE visitor = ?').bind(other),
      env.DB.prepare('UPDATE aliases SET canonical = ? WHERE canonical = ?').bind(canonical, other),
      env.DB.prepare('INSERT OR REPLACE INTO aliases (visitor, canonical) VALUES (?, ?)').bind(other, canonical),
      env.DB.prepare('UPDATE identities SET visitor = ? WHERE visitor = ?').bind(canonical, other),
    );
  }
  if (statements.length) await env.DB.batch(statements);
}

// Same record the mailing-list Worker writes, so its admin page lists these
// people too. An existing subscriber is left untouched.
async function joinMailingList(env, email) {
  const key = 'sub:' + email;
  const existing = await env.LIST.getWithMetadata(key);
  if (!existing.metadata) {
    await env.LIST.put(key, '', {
      metadata: { email, name: '', source: 'trail', subscribed_at: new Date().toISOString() },
    });
  }
}

// The card under the collection: a "saved" note once an email is linked, a
// save form for someone with finds, or just the restore form for a new phone.
async function recoveryCard(env, visitorId, foundCount) {
  if (!emailEnabled(env)) return '';
  const linked = await env.DB.prepare('SELECT 1 AS x FROM identities WHERE visitor = ? LIMIT 1').bind(visitorId).first();
  if (linked) return `<section class="recovery"><p class="saved">Progress saved to your email &#10003;</p></section>`;

  const turnstile = env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET
    ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(env.TURNSTILE_SITE_KEY)}"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : '';
  const emailField = `<label>Your email<input type="email" name="email" required autocomplete="email" inputmode="email" maxlength="254" /></label>`;
  const restoreForm = `<form method="post" action="${PREFIX}/restore">${emailField}${turnstile}<button type="submit">Email me a restore link</button></form>`;

  if (foundCount === 0) {
    return `<section class="recovery"><h2>On a new phone?</h2><p>Enter the email you saved your progress with and we'll send a link to get it back.</p>${restoreForm}</section>`;
  }
  const optIn = env.LIST
    ? `<label class="check"><input type="checkbox" name="join_list" value="1" /><span>Also send me news from Pink Lady Slipper</span></label>`
    : '';
  return `<section class="recovery">
      <h2>Keep your collection safe</h2>
      <p>Save your progress to your email so you can get it back if you change phones or clear your browser. We'll send you a link; there's no password. We keep your email only for this.</p>
      <form method="post" action="${PREFIX}/save">${emailField}${optIn}${turnstile}<button type="submit">Save my progress</button></form>
      <details><summary>Already saved on another phone? Restore it</summary>${restoreForm}</details>
    </section>`;
}

function expiredPage(env) {
  return proseResponse(env, 'Link expired', `<p>This link has expired or was already used.</p><p><a href="${PREFIX}">Back to my collection</a> and ask for a new one.</p>`, 410);
}

function proseResponse(env, heading, bodyHtml, status) {
  return new Response(`<!DOCTYPE html>
<html lang="en">
${head(env)}<body>
  <main class="wrap">
    ${brandHtml(env)}
    <section class="prose">
      <h1 class="count">${escapeHtml(heading)}</h1>
      ${bodyHtml}
    </section>
  </main>
</body>
</html>`, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  return !origin || origin === url.origin;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip && ip !== 'unknown') form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

// ---------- admin ----------

async function admin(request, env, url, path) {
  if (!env.ADMIN_PASSWORD) return new Response('Admin password not configured.', { status: 503 });
  if (!(await checkBasicAuth(request, env.ADMIN_PASSWORD))) {
    return new Response('Password required.', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Trail admin", charset="UTF-8"', 'Cache-Control': 'no-store' },
    });
  }

  if (path === PREFIX + '/admin/add' || path === PREFIX + '/admin/delete') {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    // Browsers resend Basic Auth credentials on cross-site form posts, so only
    // accept posts that come from this admin page itself.
    if (request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
    const form = await request.formData();
    if (path.endsWith('/add')) {
      const name = clean(form.get('name'), 60);
      if (name) {
        await env.DB.prepare('INSERT INTO spots (token, name) VALUES (?, ?)').bind(makeToken(), name).run();
      }
    } else {
      const token = String(form.get('token') || '');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM scans WHERE token = ?').bind(token),
        env.DB.prepare('DELETE FROM spots WHERE token = ?').bind(token),
      ]);
    }
    return new Response(null, { status: 303, headers: { Location: PREFIX + '/admin' } });
  }

  if (path !== PREFIX + '/admin') return new Response('Not found', { status: 404 });

  const [spotRows, visitorRow] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.token AS token, p.name AS name, COUNT(s.visitor) AS finders
         FROM spots p LEFT JOIN scans s ON s.token = p.token
        GROUP BY p.token ORDER BY p.created_at, p.rowid`,
    ),
    env.DB.prepare('SELECT COUNT(DISTINCT visitor) AS n FROM scans'),
  ]);
  return new Response(adminPage(env, url, spotRows.results, visitorRow.results[0].n), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'X-Frame-Options': 'DENY',
    },
  });
}

function adminPage(env, url, spots, visitors) {
  const base = (env.PUBLIC_BASE || url.origin).replace(/\/+$/, '');
  const cards = spots.map((s) => `
      <div class="card" data-token="${escapeHtml(s.token)}">
        <div class="qr"></div>
        <strong>${escapeHtml(s.name)}</strong>
        <span class="meta">${s.finders} ${s.finders === 1 ? 'person has' : 'people have'} found this</span>
        <code class="link"></code>
        <form method="post" action="${PREFIX}/admin/delete" class="noprint" onsubmit="return confirm('Delete this spot and its scans? Printed QR codes for it will stop working.')">
          <input type="hidden" name="token" value="${escapeHtml(s.token)}" />
          <button type="submit" class="danger">Delete</button>
        </form>
      </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex" />
  <title>Trail admin | ${escapeHtml(env.SITE_NAME || 'Pink Lady Slipper')}</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0f0a1f;color:#f7f2ff;margin:0;padding:24px;line-height:1.5}
    .wrap{max-width:900px;margin:0 auto}
    h1{font-size:1.5rem;margin:0 0 4px}
    .muted{color:#b8a8d6}
    .bar{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin:20px 0;padding:16px;background:#06040f;border-radius:12px}
    label{display:flex;flex-direction:column;gap:4px;font-size:.8rem;color:#b8a8d6;flex:1;min-width:240px}
    input[type=text]{font:inherit;padding:9px 11px;border-radius:8px;border:1px solid #3a2d5c;background:#0f0a1f;color:#f7f2ff}
    button{font:inherit;font-weight:600;padding:9px 16px;border:0;border-radius:999px;background:#02d565;color:#06040f;cursor:pointer}
    button.danger{background:none;color:#f602bc;border:1px solid #f602bc;padding:5px 12px;font-size:.8rem}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px}
    .card{background:#f5f0ff;color:#10061a;border-radius:14px;padding:18px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center}
    .qr{background:#fff;padding:8px;border-radius:8px;line-height:0}
    .qr img{width:200px;height:200px;display:block}
    .meta{font-size:.8rem;color:#5a4a70}
    .link{font-size:.68rem;color:#5a4a70;word-break:break-all}
    @media print{body{background:#fff;color:#000}.bar,.noprint,.top button{display:none}.grid{gap:28px}.card{border:1px solid #ccc;break-inside:avoid}}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <h1>The Trail: QR codes</h1>
      <p class="muted">${spots.length} spot${spots.length === 1 ? '' : 's'} &middot; ${visitors} visitor${visitors === 1 ? '' : 's'} with at least one find</p>
    </div>

    <div class="bar noprint">
      <label>QR links start with
        <input type="text" id="base" value="${escapeHtml(base)}" />
      </label>
      <button type="button" onclick="window.print()">Print</button>
    </div>

    <form method="post" action="${PREFIX}/admin/add" class="bar noprint">
      <label>Add a spot
        <input type="text" name="name" maxlength="60" placeholder="e.g. The Coffee Shop" required />
      </label>
      <button type="submit">Add</button>
    </form>

    <div class="grid" id="grid">${cards || '<p class="muted">No spots yet. Add the first one above.</p>'}
    </div>
  </div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>
  <script>
    // Each code is drawn at a large whole-number module size, so square edges
    // stay sharp and the logo's round cut-out is anti-aliased. The <img> shows
    // it at card size; right-click > Save Image gives the full-resolution PNG.
    const LOGO_SRC = ${JSON.stringify(LOGO_LINE_DATA_URI)};
    const baseInput = document.getElementById('base');
    const QUIET = 4;       // quiet-zone width, in modules
    const LOGO_FRAC = 0.28; // logo diameter as a share of the whole image

    function drawQr(link, logo) {
      const qr = qrcode(0, 'H'); // highest error correction so the logo can cover the middle
      qr.addData(link);
      qr.make();
      const n = qr.getModuleCount();
      const mod = Math.ceil(1600 / (n + QUIET * 2));
      const size = (n + QUIET * 2) * mod;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#000000';
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (qr.isDark(r, c)) ctx.fillRect((c + QUIET) * mod, (r + QUIET) * mod, mod, mod);
        }
      }
      const d = Math.round(size * LOGO_FRAC);
      const pad = Math.round(size * 0.016);
      const mid = size / 2;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(mid, mid, d / 2 + pad, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.beginPath();
      ctx.arc(mid, mid, d / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(logo, mid - d / 2, mid - d / 2, d, d);
      ctx.restore();
      const img = new Image();
      img.alt = 'QR code';
      img.src = canvas.toDataURL('image/png');
      return img;
    }

    function render(logo) {
      const base = baseInput.value.trim().replace(/\\/+$/, '');
      document.querySelectorAll('.card[data-token]').forEach((card) => {
        const link = base + '${PREFIX}/s/' + card.dataset.token;
        const box = card.querySelector('.qr');
        box.replaceChildren(drawQr(link, logo));
        card.querySelector('.link').textContent = link;
      });
    }

    const logoImage = new Image();
    logoImage.onload = () => {
      render(logoImage);
      baseInput.addEventListener('input', () => render(logoImage));
    };
    logoImage.src = LOGO_SRC;
  </script>
</body>
</html>`;
}

// ---------- helpers ----------

function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_LENGTH));
  return Array.from(bytes, (b) => TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]).join('');
}

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function checkBasicAuth(request, password) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = atob(header.slice(6)); } catch { return false; }
  const supplied = decoded.slice(decoded.indexOf(':') + 1); // any username
  const [a, b] = await Promise.all([sha256(supplied), sha256(password)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function sha256(text) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
