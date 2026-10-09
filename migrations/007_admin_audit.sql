-- Migration 007: privileged admin audit trail.
--
-- Append-only record of every privileged state-changing admin action.
-- Designed to hold NO raw PII, tokens, secrets, guest content, or storage
-- keys: actor is identified by opaque id plus a hashed email; targets are
-- identified by opaque record id. A NULL outcome indicates the mutation must
-- not have proceeded (see handler logic).

CREATE TABLE IF NOT EXISTS admin_audit (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  actor_id     TEXT,
  actor_email_hash TEXT,
  tenant_id    TEXT,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  outcome      TEXT NOT NULL,
  request_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_ts         ON admin_audit(ts);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor      ON admin_audit(actor_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_tenant     ON admin_audit(tenant_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target     ON admin_audit(target_type, target_id);
