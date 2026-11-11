-- jaiou-guestbook — D1 schema. Run once in the D1 console (or via wrangler) before the first deploy test.
-- Emails live only in this table, never in a public response. The owner export reads them; nothing else does.

CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT,
  message    TEXT NOT NULL,
  badge      INTEGER NOT NULL DEFAULT 0,  -- 1 when the post carries a verified jAIou badge claim
  hidden     INTEGER NOT NULL DEFAULT 0,  -- owner sweep: 1 takes a post off the board without deleting it
  ip_hash    TEXT,                        -- sha256 of the poster IP, for the pace limit only
  parent_id  INTEGER,                     -- the post this one answers; NULL means an opening post
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS badge_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash  TEXT NOT NULL UNIQUE,        -- sha256 of the claim code; the code itself is never stored
  ip_hash    TEXT,                        -- who minted it, for the daily mint limit
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_created ON posts (created_at);
CREATE INDEX IF NOT EXISTS idx_posts_ip      ON posts (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_codes_ip      ON badge_codes (ip_hash, created_at);
