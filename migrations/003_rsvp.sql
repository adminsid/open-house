-- Migration 003: RSVP support
-- Add rsvp_token to events and RSVP/check-in fields to guests

ALTER TABLE events ADD COLUMN rsvp_token TEXT;
UPDATE events SET rsvp_token = lower(hex(randomblob(16))) WHERE rsvp_token IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_rsvp_token ON events(rsvp_token);

ALTER TABLE guests ADD COLUMN is_rsvp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guests ADD COLUMN checked_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guests ADD COLUMN checked_in_at TEXT;
