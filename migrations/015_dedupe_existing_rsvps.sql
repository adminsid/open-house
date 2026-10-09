-- Migration 015: Deduplicate existing RSVP guest records
-- Keep the single most recent record for each (event_id, lower(email)) or (event_id, clean_phone)

-- 1. Deduplicate by event_id and email
DELETE FROM guests
WHERE is_rsvp = 1
  AND email IS NOT NULL
  AND trim(email) != ''
  AND id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY event_id, lower(email)
        ORDER BY signed_in_at DESC
      ) as rn
      FROM guests
      WHERE is_rsvp = 1 AND email IS NOT NULL AND trim(email) != ''
    ) WHERE rn = 1
  );

-- 2. Deduplicate by event_id and normalized phone (for any without email or remaining duplicates)
DELETE FROM guests
WHERE is_rsvp = 1
  AND phone IS NOT NULL
  AND trim(phone) != ''
  AND id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY event_id, replace(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '')
        ORDER BY signed_in_at DESC
      ) as rn
      FROM guests
      WHERE is_rsvp = 1 AND phone IS NOT NULL AND trim(phone) != ''
    ) WHERE rn = 1
  );
