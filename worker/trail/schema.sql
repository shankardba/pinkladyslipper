-- One row per physical QR code. `token` is the unguessable part of the QR link.
CREATE TABLE IF NOT EXISTS spots (
  token TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per (visitor, spot): the primary key is what makes a repeat scan
-- count only once.
CREATE TABLE IF NOT EXISTS scans (
  visitor TEXT NOT NULL,
  token TEXT NOT NULL,
  scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (visitor, token)
);
CREATE INDEX IF NOT EXISTS scans_by_token ON scans (token);

-- Email recovery. A visitor can link an email (after confirming a link sent
-- to it) so progress survives a new phone or cleared browser. Emails are kept
-- internally only: nothing in the app or the admin page displays them.
CREATE TABLE IF NOT EXISTS identities (
  email TEXT PRIMARY KEY,                 -- lowercased
  visitor TEXT NOT NULL,                  -- canonical visitor id
  verified_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS identities_by_visitor ON identities (visitor);

-- When two visitor ids turn out to be the same person, the older one is
-- aliased to the canonical one. Cookies are left alone; lookups resolve them.
CREATE TABLE IF NOT EXISTS aliases (
  visitor TEXT PRIMARY KEY,
  canonical TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS aliases_by_canonical ON aliases (canonical);

-- One-time emailed links. Only a hash of the token is stored.
CREATE TABLE IF NOT EXISTS magic_tokens (
  token_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,                  -- 'save' | 'restore'
  email TEXT NOT NULL,
  visitor TEXT NOT NULL,                  -- visitor that asked for the link
  join_list INTEGER NOT NULL DEFAULT 0,   -- opted in to the mailing list
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Rate limiting: one row per request, keyed 'e:<email>' or 'i:<ip>'.
CREATE TABLE IF NOT EXISTS email_sends (
  key TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS email_sends_by_key ON email_sends (key, sent_at);
