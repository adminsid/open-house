-- Migration 003: Auth, RBAC, and Management
-- Tables for Users (Admins), Agents, Listings, and Companies

-- 1. Companies
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  logo_key TEXT,
  website TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Users (Admins/Superusers)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin', -- 'superuser', 'admin'
  company_id TEXT REFERENCES companies(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3. Agents
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  photo_key TEXT,
  company_id TEXT REFERENCES companies(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 4. Listings
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  address TEXT NOT NULL,
  description TEXT,
  photo_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 5. Update events table
-- We add columns to link to the new entities
ALTER TABLE events ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE events ADD COLUMN agent_id TEXT REFERENCES agents(id);
ALTER TABLE events ADD COLUMN listing_id TEXT REFERENCES listings(id);
ALTER TABLE events ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1; -- 1 = private, 0 = public

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_agents_company_id ON agents(company_id);
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_is_private ON events(is_private);
