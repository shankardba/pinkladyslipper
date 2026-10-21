# Trail Worker

A standalone Cloudflare Worker behind "The Trail", the QR scavenger hunt. Each physical QR code is a plain https link, so the phone's default camera app opens it in the browser. The Worker records the scan and answers with a finished page that says "Found N codes!". No app, no JavaScript and no visit to the main site is needed first. Storage is D1; this folder is kept out of the site's PROD assets by `/.assetsignore`.

## Routes (under `/api/trail`)

| Method + path | Response |
|---|---|
| `GET /s/<token>` | Records the scan (once per visitor per spot) and shows "Found N codes!", a note saying whether it was a new find, and the visitor's collection. An unknown token gets a 404 page with the same layout. `HEAD` never counts as a scan. |
| `GET /` | The visitor's collection without recording anything. |
| `GET /admin` | HTTP Basic Auth (any username, password = `ADMIN_PASSWORD`). Lists the spots with printable QR codes, a per-spot count of finders, an add-a-spot form and a Delete button. |
| `POST /admin/add`, `POST /admin/delete` | Same auth. Rejected with 403 unless `Origin` equals the Worker's own origin. |

Phones only: desktop browsers get a "Phones only" page from `/s/<token>` and `/`, nothing is recorded, and no cookie is set. Detection is best-effort and errs toward letting people in: Chromium client hints (`Sec-CH-UA-Mobile`/`Platform`) and Windows/Linux/ChromeOS user agents are treated as desktop, while a "Macintosh" user agent is left alone because iPadOS Safari reports it. A stylesheet fallback hides the game for any mouse-driven device (`hover: hover` and `pointer: fine`) that slips through. A phone that trips the gate can add `?phone=1` (the page links to it). `/admin` is never gated. To try the game on a laptop, use the browser's device emulation or add `?phone=1`.

## Email recovery (optional)

Lets a fan get their collection back after changing phones or clearing the browser, with no password. It is off until the `RESEND_API_KEY` secret is set; until then the pages look as before and the endpoints do not exist.

- **Save:** under the collection a card asks for an email (plus an unchecked "Also send me news" box when the `LIST` KV binding is present). The Worker emails a one-time link; tapping it and pressing **Save my progress** links the email to the visitor. Once linked the card just says "Progress saved to your email"; later scans add to the same record, so there is nothing to save again.
- **Restore:** on a new phone, enter the email and tap the emailed link, then **Restore my progress**. Finds made on the new phone first are merged in (a code found twice still counts once).
- **No one can read another person's progress:** the email box only sends a link to that inbox. The reply is identical whether or not the address is known, the work happens after the response, an unknown address gets no email, and the email is never displayed anywhere (the admin page does not show it).
- **Links:** random, single use, 15 minutes, only a hash stored. Opening the link just shows a button; the change is a POST, so mail scanners that prefetch links cannot use it up.
- **Abuse limits:** 3 emails per address and 10 per IP per hour (silently dropped beyond that), same-origin POSTs only, and optional Turnstile (`TURNSTILE_SITE_KEY` var plus `TURNSTILE_SECRET` secret; the forms work without it).
- **Data:** `identities(email, visitor)` keeps the plain lowercased email for internal use; `aliases(visitor, canonical)` records merged visitor ids (cookies are never rewritten); `magic_tokens`; `email_sends`. The mailing-list opt-in writes the same `sub:<email>` record as the mailing-list Worker, applied only after the link is confirmed.

Setup (test): create a free Resend account, create an API key, save it to `~/.config/pls-trail/resend-api-key`, then:

```
export CLOUDFLARE_API_TOKEN=$(cat ~/.config/cloudflare-pls-prod/token)
export CLOUDFLARE_ACCOUNT_ID=feaccfb4bfda7d10bd645e2d95928d51
cd worker/trail
npx wrangler d1 execute pls-trail-test --remote --file schema.sql --config wrangler.test.toml
npx wrangler secret put RESEND_API_KEY --config wrangler.test.toml < ~/.config/pls-trail/resend-api-key
```

Until a sending domain is verified in Resend, `EMAIL_FROM` is `onboarding@resend.dev`, which only delivers to the Resend account owner's own address. For prod, verify pinkladyslipper.net in Resend (SPF/DKIM records on the domain), then set `EMAIL_FROM` to e.g. `Pink Lady Slipper <trail@pinkladyslipper.net>`.

The visitor is an anonymous UUID in a first-party `HttpOnly; Secure; SameSite=Lax` cookie set by the Worker, scoped to `/api/trail`. Clearing browser data or switching phones starts a visitor over.

QR tokens are 8 random characters from a no-look-alike alphabet, so nobody can claim spots by guessing URLs. Tokens only appear on the password-protected admin page.

## Data (D1)

`schema.sql`: `spots(token, name, created_at)` and `scans(visitor, token, scanned_at)` with `PRIMARY KEY (visitor, token)`. `seed.test.sql` adds six placeholder spots for the test database only.

## Local run (no Cloudflare access needed)

```
cd worker/trail
npx wrangler d1 execute pls-trail-test --local --file schema.sql --config wrangler.test.toml
npx wrangler d1 execute pls-trail-test --local --file seed.test.sql --config wrangler.test.toml
npx wrangler dev --local --port 8788 --config wrangler.test.toml --var ADMIN_PASSWORD:testpw
```

## Deploy the test Worker

The band's API token needs the D1 Edit permission as well as Workers and KV.

```
export CLOUDFLARE_API_TOKEN=$(cat ~/.config/cloudflare-pls-prod/token)
export CLOUDFLARE_ACCOUNT_ID=feaccfb4bfda7d10bd645e2d95928d51
npx wrangler d1 create pls-trail-test      # put the database_id in wrangler.test.toml
npx wrangler d1 execute pls-trail-test --remote --file schema.sql --config wrangler.test.toml
npx wrangler deploy --config wrangler.test.toml
npx wrangler secret put ADMIN_PASSWORD --config wrangler.test.toml
```

Never run `wrangler deploy` from the repo root, because PROD's Cloudflare build runs there.

## Going live

Needs the user's explicit go: a prod D1 database and Worker on the band's account routed at `pinkladyslipper.net/api/trail*`, with `PUBLIC_BASE` and `SITE_URL` set to `https://pinkladyslipper.net`. Add the spots on the prod admin page and print QR codes from there (test tokens do not exist in the prod database). Then add `pinkladyslipper.net` to the hostname map in `script.js`.
