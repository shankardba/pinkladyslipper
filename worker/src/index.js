// Mailing-list Worker: signup, self-serve unsubscribe, and a password-protected
// admin page. Storage is Workers KV, one key per address:
//
//   key       sub:<lowercased email>
//   value     ""            (unused)
//   metadata  { email, name, source, subscribed_at }
//
// Keeping everything in metadata means the admin page needs a single
// KV.list() pass, with no per-key reads.
//
// Bindings: LIST (KV namespace)
// Vars:     SITE_NAME, ALLOWED_ORIGINS (comma-separated), UNSUBSCRIBE_URL
//           (shown on the admin page as the footer line for every email)
//           ADMIN_USER (admin username; defaults to "admin")
// Secrets:  ADMIN_PASSWORD (required for /admin), TURNSTILE_SECRET (optional;
//           when unset, the Turnstile check is skipped)

const PREFIX = '/api/list';
const KEY_PREFIX = 'sub:';
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const origin = request.headers.get('Origin') || '';

    if (path === PREFIX + '/subscribe' || path === PREFIX + '/unsubscribe') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
      if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, env, origin);
      if (!isAllowedOrigin(env, origin)) return json({ error: 'Origin not allowed.' }, 403, env, origin);
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') return json({ error: 'Invalid request.' }, 400, env, origin);
      return path.endsWith('/unsubscribe')
        ? unsubscribe(body, env, origin)
        : subscribe(body, env, origin, request);
    }

    if (path === PREFIX + '/admin' || path.startsWith(PREFIX + '/admin/')) {
      return admin(request, env, url, path);
    }

    return new Response('Not found', { status: 404 });
  },
};

// ---------- public endpoints ----------

async function subscribe(body, env, origin, request) {
  // Honeypot: real visitors never fill this in. Pretend it worked.
  if (body.company) return json({ ok: true }, 200, env, origin);

  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'Please enter a valid email address.' }, 400, env, origin);

  if (env.TURNSTILE_SECRET) {
    const passed = await verifyTurnstile(env.TURNSTILE_SECRET, body.turnstileToken, request.headers.get('CF-Connecting-IP'));
    if (!passed) return json({ error: 'Please complete the verification and try again.' }, 400, env, origin);
  }

  const key = KEY_PREFIX + email;
  const existing = await env.LIST.getWithMetadata(key);
  if (!existing.metadata) {
    await env.LIST.put(key, '', {
      metadata: {
        email,
        name: clean(body.name, 80),
        source: clean(body.source, 120),
        subscribed_at: new Date().toISOString(),
      },
    });
  }
  // Same answer for new and existing subscribers, so the endpoint never
  // reveals who is already on the list.
  return json({ ok: true }, 200, env, origin);
}

async function unsubscribe(body, env, origin) {
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: 'Please enter a valid email address.' }, 400, env, origin);
  await env.LIST.delete(KEY_PREFIX + email);
  return json({ ok: true }, 200, env, origin);
}

// ---------- admin ----------

async function admin(request, env, url, path) {
  if (!env.ADMIN_PASSWORD) return new Response('Admin password not configured.', { status: 503 });
  if (!(await checkBasicAuth(request, env.ADMIN_USER || 'admin', env.ADMIN_PASSWORD))) {
    return new Response('Password required.', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Mailing list admin", charset="UTF-8"', 'Cache-Control': 'no-store' },
    });
  }

  if (path === PREFIX + '/admin/remove') {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    // Browsers resend Basic Auth credentials on cross-site form posts, so only
    // accept posts that come from this admin page itself.
    if (request.headers.get('Origin') !== url.origin) return new Response('Forbidden', { status: 403 });
    const form = await request.formData();
    const email = normalizeEmail(form.get('email'));
    if (email) await env.LIST.delete(KEY_PREFIX + email);
    return new Response(null, { status: 303, headers: { Location: PREFIX + '/admin?removed=' + encodeURIComponent(email || '') } });
  }

  // KV listings can lag a delete by up to a minute, so hide an address the
  // admin just removed rather than show it again on the redirect.
  const removed = normalizeEmail(url.searchParams.get('removed'));
  const subscribers = (await listSubscribers(env)).filter((s) => s.email !== removed);

  if (path === PREFIX + '/admin/export.csv') {
    const rows = [['email', 'name', 'subscribed_at', 'source']].concat(
      subscribers.map((s) => [s.email, s.name, s.subscribed_at, s.source]),
    );
    const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="mailing-list-${stamp}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  if (path !== PREFIX + '/admin') return new Response('Not found', { status: 404 });
  return new Response(adminPage(env, subscribers, removed), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'X-Frame-Options': 'DENY',
    },
  });
}

async function listSubscribers(env) {
  const out = [];
  let cursor;
  do {
    const page = await env.LIST.list({ prefix: KEY_PREFIX, cursor });
    for (const k of page.keys) {
      const m = k.metadata || {};
      out.push({
        email: m.email || k.name.slice(KEY_PREFIX.length),
        name: m.name || '',
        source: m.source || '',
        subscribed_at: m.subscribed_at || '',
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => (b.subscribed_at || '').localeCompare(a.subscribed_at || ''));
}

function adminPage(env, subscribers, removed) {
  const site = escapeHtml(env.SITE_NAME || 'Mailing list');
  const all = subscribers.map((s) => s.email).join(', ');
  const rows = subscribers.map((s) => `
      <tr>
        <td>${escapeHtml(s.email)}</td>
        <td>${escapeHtml(s.name)}</td>
        <td>${escapeHtml(s.subscribed_at.slice(0, 10))}</td>
        <td>
          <form method="post" action="${PREFIX}/admin/remove" onsubmit="return confirm('Remove ' + this.email.value + '?')">
            <input type="hidden" name="email" value="${escapeHtml(s.email)}">
            <button type="submit" class="remove">Remove</button>
          </form>
        </td>
      </tr>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${site} — mailing list</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1d1a24; --muted: #6b6478; --line: #e4e0ea; --accent: #b0127a; }
  @media (prefers-color-scheme: dark) { :root { --bg: #15121b; --fg: #eee9f5; --muted: #a59fb3; --line: #2e2838; --accent: #ff5fae; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .muted { color: var(--muted); }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 20px 0 8px; }
  .btn { display: inline-block; padding: 9px 16px; border-radius: 999px; border: 1px solid var(--accent); background: var(--accent); color: #fff; font: inherit; font-weight: 600; text-decoration: none; cursor: pointer; }
  .btn.secondary { background: transparent; color: var(--accent); }
  .help { margin: 6px 0 20px; }
  .notice { padding: 10px 14px; border: 1px solid var(--line); border-radius: 10px; margin: 16px 0 0; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  td:first-child { overflow-wrap: anywhere; }
  td:nth-child(3) { white-space: nowrap; }
  @media (max-width: 600px) {
    thead { display: none; }
    tr { display: grid; grid-template-columns: 1fr auto; column-gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
    td { border: 0; padding: 1px 0; }
    td:first-child { font-weight: 600; }
    td:nth-child(2), td:nth-child(3) { grid-column: 1; color: var(--muted); font-size: 0.85rem; }
    td:nth-child(2):empty { display: none; }
    td:last-child { grid-column: 2; grid-row: 1 / span 3; align-self: center; }
  }
  form { margin: 0; }
  .remove { background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 8px; padding: 4px 10px; font: inherit; font-size: 0.85rem; cursor: pointer; }
  .remove:hover { color: var(--accent); border-color: var(--accent); }
  textarea { position: absolute; left: -9999px; }
</style>
</head>
<body>
<main>
  <h1>${site} mailing list</h1>
  <p class="muted">${subscribers.length} subscriber${subscribers.length === 1 ? '' : 's'}</p>
  ${removed ? `<p class="notice">Removed ${escapeHtml(removed)}.</p>` : ''}
  <div class="actions">
    <button type="button" class="btn" id="copy"${subscribers.length ? '' : ' disabled'}>Copy all for Gmail BCC</button>
    <a class="btn secondary" href="${PREFIX}/admin/export.csv">Download CSV</a>
  </div>
  <p class="help muted">To send a newsletter: copy the list, open a new Gmail message, put your own address in <b>To</b>, and paste the list into <b>Bcc</b>. ${env.UNSUBSCRIBE_URL ? `End every email with: “To unsubscribe, visit ${escapeHtml(env.UNSUBSCRIBE_URL)}”.` : ''}</p>
  <textarea id="all" readonly aria-hidden="true">${escapeHtml(all)}</textarea>
  <div class="table-wrap">
  <table>
    <thead><tr><th>Email</th><th>Name</th><th>Joined</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="muted">No subscribers yet.</td></tr>'}</tbody>
  </table>
  </div>
</main>
<script>
  document.getElementById('copy').addEventListener('click', async (event) => {
    const text = document.getElementById('all').value;
    try { await navigator.clipboard.writeText(text); }
    catch { const t = document.getElementById('all'); t.select(); document.execCommand('copy'); }
    event.target.textContent = 'Copied!';
    setTimeout(() => { event.target.textContent = 'Copy all for Gmail BCC'; }, 2000);
  });
</script>
</body>
</html>`;
}

// ---------- helpers ----------

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

function clean(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function isAllowedOrigin(env, origin) {
  return allowedOrigins(env).includes(origin);
}

function corsHeaders(env, origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (isAllowedOrigin(env, origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function json(data, status, env, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(env, origin) },
  });
}

async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  return data.success === true;
}

async function checkBasicAuth(request, username, password) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try { decoded = atob(header.slice(6)); } catch { return false; }
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  const [a, b] = await Promise.all([
    sha256(decoded.slice(0, sep) + '\n' + decoded.slice(sep + 1)),
    sha256(username + '\n' + password),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function sha256(text) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // keep spreadsheets from running it as a formula
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
