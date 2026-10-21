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
