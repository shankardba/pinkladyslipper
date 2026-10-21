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
