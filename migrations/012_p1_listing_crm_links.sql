-- P1: stable Inventory, agent, license, and CRM relationships.

ALTER TABLE events ADD COLUMN listing_id TEXT;
ALTER TABLE events ADD COLUMN property_id TEXT;
ALTER TABLE events ADD COLUMN agent_user_id TEXT;
ALTER TABLE events ADD COLUMN professional_license_id TEXT;

CREATE INDEX IF NOT EXISTS idx_events_listing_id ON events (tenant_id, listing_id);
CREATE INDEX IF NOT EXISTS idx_events_agent_user_id ON events (tenant_id, agent_user_id);

ALTER TABLE guests ADD COLUMN crm_contact_id TEXT;
ALTER TABLE guests ADD COLUMN consent_contact INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guests ADD COLUMN consent_marketing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guests ADD COLUMN consent_captured_at TEXT;
ALTER TABLE guests ADD COLUMN crm_sync_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE guests ADD COLUMN crm_synced_at TEXT;

CREATE INDEX IF NOT EXISTS idx_guests_crm_contact ON guests (crm_contact_id);
CREATE INDEX IF NOT EXISTS idx_guests_crm_sync ON guests (crm_sync_status);
