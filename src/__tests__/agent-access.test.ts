import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../index';
import { SqliteD1 } from './helpers/d1';
import { MockR2Bucket } from './helpers/r2';

const BASE = 'https://openhouse.primeamericarealestate.com';

function makeDb(): SqliteD1 {
  const db = new SqliteD1();
  db.applyMigrations();
  return db;
}

function makeEnv(db: SqliteD1): Record<string, unknown> {
  return {
    DB: db as unknown as D1Database,
    KV: {} as unknown as KVNamespace,
    BUCKET: new MockR2Bucket(),
    APP_URL: BASE,
    WORKSPACE_URL: 'https://workspace.primeamericany.com',
    ADMIN_TENANT_ID: 'tenant_primeamerica',
    CONTAINMENT_ENABLED: 'false',
  };
}

function seedEvent(db: SqliteD1): void {
  db.exec(
    `INSERT INTO events (id, title, property_address, agent_name, agent_email, start_time, end_time, timezone,
       status, admin_token, public_token, rsvp_token, tenant_id, created_at, updated_at)
     VALUES ('evt_1', 'Prime Home', '123 Prime Ave, NYC', 'Alice Agent', 'alice@example.com',
       '2026-01-01T10:00:00.000Z', '2026-01-01T12:00:00.000Z', 'America/New_York',
       'scheduled', 'admin_token_a', 'public_token_a', 'rsvp_token_a', 'tenant_primeamerica',
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  );
}

async function request(path: string, env: Record<string, unknown>, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(BASE + path, init), env as any, {} as any);
}

describe('public agent capability access', () => {
  let db: SqliteD1;
  let env: Record<string, unknown>;

  beforeEach(() => {
    db = makeDb();
    env = makeEnv(db);
    db.exec(
      `INSERT INTO admins (id, username, password_hash, name, created_at)
       VALUES ('admin_1', 'admin@example.com', 'hash', 'Admin One', '2026-01-01T00:00:00.000Z')`
    );
    seedEvent(db);
  });

  it('loads the agent dashboard for a valid event token', async () => {
    const res = await request('/agent/admin_token_a', env, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Prime Home');
  });

  it('returns not found for an invalid event token', async () => {
    const res = await request('/agent/not-a-real-token', env, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(404);
  });

  it('supports agent guest check-in without a login or CSRF token', async () => {
    await db.exec(
      `INSERT INTO guests (id, event_id, first_name, last_name, signed_in_at, follow_up_status)
       VALUES ('guest_1', 'evt_1', 'Jane', 'Doe', '2026-01-01T11:00:00.000Z', 'pending')`
    );
    const res = await request('/agent/admin_token_a/guests/guest_1/checkin', env, { method: 'POST' });
    expect(res.status).toBe(302);
    expect(db.queryOne<{ checked_in: number }>('SELECT checked_in FROM guests WHERE id = ?', 'guest_1')!.checked_in).toBe(1);
  });

  it('supports adding a guest through the public capability link', async () => {
    const res = await request('/agent/admin_token_a/guests/add', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'first_name=Jane&last_name=Doe&phone=5551234',
    });
    expect(res.status).toBe(302);
    expect(db.query("SELECT * FROM guests WHERE first_name = 'Jane'")).toHaveLength(1);
  });

  it('keeps public guest and RSVP routes available', async () => {
    expect((await request('/e/public_token_a', env, { headers: { Accept: 'text/html' } })).status).toBe(200);
    expect((await request('/rsvp/rsvp_token_a', env, { headers: { Accept: 'text/html' } })).status).toBe(200);
  });
});
