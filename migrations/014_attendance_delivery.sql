ALTER TABLE guests ADD COLUMN crm_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guests ADD COLUMN crm_next_attempt_at TEXT;
ALTER TABLE guests ADD COLUMN crm_lease TEXT;
ALTER TABLE guests ADD COLUMN crm_error_code TEXT;
CREATE INDEX idx_guests_crm_replay ON guests(crm_sync_status, crm_next_attempt_at);
-- A worker crash on its final lease must remain visible and recoverable.
-- Operators can reset attempts through the authenticated event repair action.
