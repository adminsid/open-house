-- P2: provenance for Inventory data copied into an open-house event.
ALTER TABLE events ADD COLUMN listing_source TEXT;
ALTER TABLE events ADD COLUMN listing_source_version TEXT;
ALTER TABLE events ADD COLUMN listing_snapshot_synced_at TEXT;
ALTER TABLE events ADD COLUMN listing_snapshot_json TEXT;

UPDATE events
SET listing_source = 'listing-input',
    listing_snapshot_synced_at = updated_at
WHERE listing_id IS NOT NULL;
