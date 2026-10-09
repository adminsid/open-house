-- Migration 011: durable media-operation outbox for R2 consistency.
--
-- R2 and D1 cannot be mutated in a single atomic transaction, so every
-- security-relevant media state change is written to this outbox first and
-- completed by a retryable executor. A request only reports success after
-- the required D1 mutation, audit row, AND R2 operation all complete.
--
-- Lifecycle:
--   pending -> done          (operation completed successfully)
--   pending -> failed        (attempts exhausted; blocked for operator review)
--   pending -> superseded    (the event field no longer matches the operation's
--                             expected prior reference; a newer operation won.
--                             Terminal: never applied, never audited as success,
--                             owned objects are cleaned under refcount guard.)
--   pending -> (retry)       (executor re-attempts; every op is idempotent)
--
-- Optimistic concurrency: every op records the event field's expected prior
-- reference (expected_ref) and the intended new reference (intended_ref).
-- Upload/repoint ops apply via `SET col = intended WHERE col IS expected` and
-- treat a zero-row match as superseded — a stale retry can never overwrite a
-- newer media reference.
--
-- Invariants:
--   * delete ops only execute when the object is unreferenced in D1
--     (count of the key across all event photo columns == 0), so a retry can
--     never remove an object that was replaced.
--   * apply_upload ops copy from a unique staging key to the final key
--     idempotently; the event column is only pointed at the final key after
--     the object exists AND the field still equals expected_ref.
--   * audit rows carry only opaque ids and hashed actor email; the R2 key
--     stored here is a D1 control-plane record and is never echoed to logs,
--     audit records, HTTP responses, or the reconciliation UI.
--
-- Idempotency: seq-0 op of a group may carry an idempotency_key so duplicate
-- browser submissions reuse one group instead of competing.
--
-- Keys are REQUIRED here by design (the outbox must know what to complete);
-- this table is the single durable record of an in-flight media operation.

CREATE TABLE IF NOT EXISTS media_ops (
  id               TEXT PRIMARY KEY,
  group_id         TEXT NOT NULL,
  seq              INTEGER NOT NULL DEFAULT 0,
  action           TEXT NOT NULL,              -- 'apply_upload' | 'delete'
  key              TEXT NOT NULL,              -- final/new key (apply_upload) or object key (delete)
  staging_key      TEXT,                       -- apply_upload only
  target_type      TEXT,                       -- 'event' | 'storage'
  target_event_id  TEXT,                       -- opaque event id, never a token
  target_column    TEXT,                       -- 'photo_key' | 'agent_photo_key' | 'agent_photo_2_key' | 'flyer_key'
  expected_ref     TEXT,                       -- field value at op creation (may be NULL)
  intended_ref     TEXT,                       -- field value this op intends to set
  idempotency_key  TEXT,                       -- seq-0 only; dedupes duplicate submissions
  tenant_id        TEXT,
  audit_action     TEXT NOT NULL,
  actor_id         TEXT,
  actor_email_hash TEXT,                       -- SHA-256, never the clear email
  request_id       TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',   -- pending | processing | done | failed | superseded
  attempts         INTEGER NOT NULL DEFAULT 0,
  error_code       TEXT,                       -- fixed code, never a raw error string or key
  claim_id         TEXT,                       -- runner token; serializes concurrent retries
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_ops_status ON media_ops(status);
CREATE INDEX IF NOT EXISTS idx_media_ops_group  ON media_ops(group_id, seq);
CREATE INDEX IF NOT EXISTS idx_media_ops_tenant ON media_ops(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_ops_idem ON media_ops(idempotency_key) WHERE idempotency_key IS NOT NULL;
