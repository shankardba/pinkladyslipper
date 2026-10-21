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
// Bindings: DB (D1)
// Vars:     SITE_NAME, SITE_URL (the main site, for the logo and back link),
//           PUBLIC_BASE (optional; origin the admin page puts in QR codes)
// Secrets:  ADMIN_PASSWORD (required for /admin)

const PREFIX = '/api/trail';
const COOKIE = 'pls_trail';
const TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alikes (i, l, o, 0, 1)
const TOKEN_LENGTH = 8;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    if (path === PREFIX + '/admin' || path.startsWith(PREFIX + '/admin/')) {
      return admin(request, env, url, path);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (path === PREFIX) return collection(request, env);

    const scanMatch = path.match(/^\/api\/trail\/s\/([A-Za-z0-9]{4,32})$/);
    if (scanMatch) return scan(request, env, scanMatch[1]);

    return new Response('Not found', { status: 404 });
  },
};

// ---------- visitor pages ----------

async function collection(request, env) {
  const visitor = getVisitor(request);
  if (request.method === 'HEAD') return htmlResponse('', 200, visitor);
  const { found, total } = await progress(env, visitor.id);
  return htmlResponse(page(env, { found, total }), 200, visitor);
}

async function scan(request, env, token) {
  const visitor = getVisitor(request);
  // Link-preview bots often send HEAD first; never count those as a scan.
  if (request.method === 'HEAD') return htmlResponse('', 200, visitor);

  const spot = await env.DB.prepare('SELECT token, name FROM spots WHERE token = ?').bind(token).first();
  if (!spot) {
    const { found, total } = await progress(env, visitor.id);
    return htmlResponse(page(env, { found, total, banner: { tone: 'unknown' } }), 404, visitor);
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
  return htmlResponse(page(env, { found, total, banner }), 200, visitor);
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

function getVisitor(request) {
  const match = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)pls_trail=([0-9a-f-]{36})(?:;|$)/);
  return { id: match ? match[1] : crypto.randomUUID() };
}

function htmlResponse(body, status, visitor) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Re-set on every visit so the year-long expiry slides forward.
      'Set-Cookie': `${COOKIE}=${visitor.id}; Max-Age=31536000; Path=${PREFIX}; Secure; HttpOnly; SameSite=Lax`,
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
  const lead = banner.tone === 'new'
    ? `<strong>New find: ${escapeHtml(banner.name)}</strong>`
    : `<strong>You already have ${escapeHtml(banner.name)}.</strong> Keep looking for the others.`;
  const tail = all ? ' You found every code on the trail!' : '';
  return `<p class="banner banner-${banner.tone}">${lead}${tail}</p>`;
}

function page(env, { found, total, banner }) {
  const n = found.length;
  const siteUrl = (env.SITE_URL || '').replace(/\/+$/, '');
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
<head>
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
<body>
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
    <a class="brand" href="${escapeHtml(siteUrl || '/')}">
      ${siteUrl ? `<img src="${escapeHtml(siteUrl)}/images/logo.webp" alt="" width="40" height="40" />` : ''}
      <span>Pink Lady Slipper</span>
    </a>

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

    <p class="help">Pink lady's slippers are hiding around town. Scan the QR code on each one with your phone's camera to add it to your collection.</p>
  </main>
</body>
</html>`;
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
@media (prefers-reduced-motion:no-preference){.banner{animation:in .45s ease}@keyframes in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}}
`;

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

  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  <script>
    const baseInput = document.getElementById('base');
    function render() {
      const base = baseInput.value.trim().replace(/\\/+$/, '');
      document.querySelectorAll('.card[data-token]').forEach((card) => {
        const link = base + '${PREFIX}/s/' + card.dataset.token;
        const box = card.querySelector('.qr');
        box.innerHTML = '';
        new QRCode(box, { text: link, width: 160, height: 160, colorDark: '#10061a', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
        card.querySelector('.link').textContent = link;
      });
    }
    baseInput.addEventListener('input', render);
    render();
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
