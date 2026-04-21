-- Migration 002: agent branding columns
-- Add company name and agent photo to events table

ALTER TABLE events ADD COLUMN company_name TEXT;
ALTER TABLE events ADD COLUMN agent_photo_key TEXT;
