-- Fresh Start Migration
-- Drop all existing tables
DROP TABLE IF EXISTS guests;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS admins;
DROP TABLE IF EXISTS companies;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS listings;
DROP TABLE IF EXISTS settings;

-- Create admins table
CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Create events table (combined from 001, 002, 003)
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  property_address TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_email TEXT NOT NULL,
  agent_phone TEXT,
  company_name TEXT,
  agent_photo_key TEXT,
  description TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  listing_url TEXT,
  photo_key TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  admin_token TEXT NOT NULL UNIQUE,
  public_token TEXT NOT NULL UNIQUE,
  rsvp_token TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_admin_token ON events(admin_token);
CREATE INDEX idx_events_public_token ON events(public_token);
CREATE INDEX idx_events_rsvp_token ON events(rsvp_token);
CREATE INDEX idx_events_status ON events(status);

-- Create guests table (combined from 001, 003)
CREATE TABLE guests (
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
  follow_up_at TEXT,
  is_rsvp INTEGER NOT NULL DEFAULT 0,
  checked_in INTEGER NOT NULL DEFAULT 0,
  checked_in_at TEXT
);

CREATE INDEX idx_guests_event_id ON guests(event_id);
CREATE INDEX idx_guests_email ON guests(email);
CREATE INDEX idx_guests_follow_up_status ON guests(follow_up_status);
