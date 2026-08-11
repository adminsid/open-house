-- Migration 010: server-side admin sessions.
--
-- Stores only a one-way SHA-256 hash of the opaque session token — the raw
-- token is never persisted. Also holds a session-bound CSRF token and the
-- trusted tenant/role captured at SSO validation time.
--
-- user_email / user_name are server-validated identity snapshots taken from
-- the Workspace SSO validation response (never from client input). They exist
-- solely so per-event agent assignment checks can run against trusted data
-- instead of the unsigned openhouse_user cookie. They are never written to
-- logs or audit records.

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash       TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  tenant_id        TEXT,
  role             TEXT,
  user_email       TEXT,
  user_name        TEXT,
  csrf_token       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  absolute_expires_at TEXT NOT NULL,
  idle_expires_at     TEXT NOT NULL,
  revoked_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user     ON admin_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_tenant   ON admin_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires  ON admin_sessions(absolute_expires_at);
