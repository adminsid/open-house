-- Open House Sign-in System Database Schema
-- Migration: 001_schema.sql

-- Events table
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  property_address TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_email TEXT NOT NULL,
  agent_phone TEXT,
  description TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  listing_url TEXT,
  photo_key TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  admin_token TEXT NOT NULL UNIQUE,
  public_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_admin_token ON events(admin_token);
CREATE INDEX IF NOT EXISTS idx_events_public_token ON events(public_token);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- Guests table
CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  address TEXT,
  is_agent INTEGER NOT NULL DEFAULT 0,
  how_did_you_hear TEXT,
  notes TEXT,
  signed_in_at TEXT NOT NULL DEFAULT (datetime('now')),
  follow_up_status TEXT NOT NULL DEFAULT 'pending',
  follow_up_notes TEXT,
  follow_up_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_guests_event_id ON guests(event_id);
CREATE INDEX IF NOT EXISTS idx_guests_email ON guests(email);
CREATE INDEX IF NOT EXISTS idx_guests_follow_up_status ON guests(follow_up_status);
