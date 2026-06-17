-- Migration to add flyer support and soft delete
ALTER TABLE events ADD COLUMN flyer_key TEXT;
ALTER TABLE events ADD COLUMN deleted_at TEXT;
