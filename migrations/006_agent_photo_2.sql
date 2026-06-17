-- Migration 006: Add agent_photo_2_key to events
ALTER TABLE events ADD COLUMN agent_photo_2_key TEXT;
