-- Migration 005: Flyer attachment and soft-delete support

ALTER TABLE events ADD COLUMN flyer_key TEXT;
ALTER TABLE events ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_events_deleted_at ON events(deleted_at);
