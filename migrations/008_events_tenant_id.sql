-- Migration 008: additive tenant ownership for events.
--
-- Adds a nullable tenant_id column and explicitly backfills ALL existing
-- events (including soft-deleted rows) to the single known tenant. No
-- DEFAULT clause: tenant must be supplied deliberately from trusted
-- server-side session context once write paths are updated.

ALTER TABLE events ADD COLUMN tenant_id TEXT;

UPDATE events SET tenant_id = 'tenant_primeamerica' WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_events_tenant_id ON events(tenant_id);
