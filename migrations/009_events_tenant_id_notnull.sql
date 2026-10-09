-- Migration 009: make event tenant ownership mandatory.
--
-- DEFERRED. Do NOT apply until:
--   1. every event creation/duplicate path writes tenant_id from the
--      validated server-side session;
--   2. SELECT COUNT(*) FROM events WHERE tenant_id IS NULL returns 0;
--   3. a D1 export/backup is completed;
--   4. guest row counts are captured (pre/post) as a safety check;
--   5. a rollback plan is documented and approved.
--
-- Uses the standard SQLite table rebuild (the only D1-compatible way to add
-- NOT NULL to an existing column). Column order and types mirror the live
-- schema exactly. guests.event_id references events(id); foreign_keys is
-- disabled for the swap, so verify guest counts before and after.

PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

CREATE TABLE events_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  property_address TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_email TEXT NOT NULL,
  agent_phone TEXT,
  company_name TEXT,
  agent_photo_key TEXT,
  agent_photo_2_key TEXT,
  description TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  listing_url TEXT,
  photo_key TEXT,
  flyer_key TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  admin_token TEXT NOT NULL UNIQUE,
  public_token TEXT NOT NULL UNIQUE,
  rsvp_token TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

INSERT INTO events_new (
  id, tenant_id, title, property_address, agent_name, agent_email,
  agent_phone, company_name, agent_photo_key, agent_photo_2_key,
  description, start_time, end_time, timezone, listing_url, photo_key,
  flyer_key, status, admin_token, public_token, rsvp_token,
  created_at, updated_at, deleted_at
)
SELECT
  id, tenant_id, title, property_address, agent_name, agent_email,
  agent_phone, company_name, agent_photo_key, agent_photo_2_key,
  description, start_time, end_time, timezone, listing_url, photo_key,
  flyer_key, status, admin_token, public_token, rsvp_token,
  created_at, updated_at, deleted_at
FROM events;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX idx_events_admin_token  ON events(admin_token);
CREATE INDEX idx_events_public_token ON events(public_token);
CREATE INDEX idx_events_rsvp_token   ON events(rsvp_token);
CREATE INDEX idx_events_status       ON events(status);
CREATE INDEX idx_events_deleted_at   ON events(deleted_at);
CREATE INDEX idx_events_tenant_id    ON events(tenant_id);

COMMIT;
PRAGMA foreign_keys=OFF;
