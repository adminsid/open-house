import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index';
import { SqliteD1 } from './helpers/d1';
import { MockR2Bucket } from './helpers/r2';

const ORIGIN = 'https://openhouse.primeamericarealestate.com';
const BASE = 'https://openhouse.primeamericarealestate.com';
const WORKSPACE = 'https://workspace.primeamericany.com';

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function makeDb(): SqliteD1 {
  const db = new SqliteD1();
  db.applyMigrations();
  return db;
}

async function makeEnv(db: SqliteD1): Promise<Record<string, unknown>> {
  await db.exec(
    `INSERT INTO admins (id, username, password_hash, name, created_at)
     VALUES ('admin_1', 'admin@example.com', '${await sha256Hex('secret-password')}', 'Admin One', '2026-01-01T00:00:00.000Z')`
  );
  return {
    DB: db as unknown as D1Database,
    KV: {} as unknown as KVNamespace,
    BUCKET: new MockR2Bucket(),
    APP_URL: ORIGIN,
    WORKSPACE_URL: WORKSPACE,
    ADMIN_TENANT_ID: 'tenant_primeamerica',
    CONTAINMENT_ENABLED: 'false',
  };
}

async function request(path: string, env: Record<string, unknown>, init: RequestInit = {}): Promise<Response> {
  const req = new Request(BASE + path, init);
  return await worker.fetch(req, env as any, {} as any);
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

function seedGuest(db: SqliteD1): void {
  db.exec(
    `INSERT INTO guests (id, event_id, first_name, last_name, email, phone, follow_up_status, signed_in_at)
     VALUES ('guest_1', 'evt_1', 'Jane', 'Doe', 'jane@example.com', '555', 'pending', '2026-01-01T11:00:00.000Z')`
  );
}

async function expectGeneric503(res: Response): Promise<void> {
  expect(res.status).toBe(503);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('retry-after')).toBe('3600');
  const body = await res.text();
  expect(body).toBe('Agent access is temporarily unavailable');
}

describe('compromised agent-token surfaces (all-methods 503)', () => {
  let db: SqliteD1;
  let env: Record<string, unknown>;

  beforeEach(async () => {
    db = makeDb();
    env = await makeEnv(db);
    seedEvent(db);
    seedGuest(db);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('returns a generic 503 for GET agent dashboard and GET CSV export', async () => {
    await expectGeneric503(await request('/agent/admin_token_a', env, { headers: { Accept: 'text/html' } }));
    await expectGeneric503(await request('/agent/admin_token_a/export.csv', env));
  });

  it('returns a generic 503 for every agent POST mutation', async () => {
    await expectGeneric503(await request('/agent/admin_token_a/guests/guest_1/checkin', env, { method: 'POST' }));
    await expectGeneric503(await request('/agent/admin_token_a/guests/guest_1/followup', env, { method: 'POST' }));
    await expectGeneric503(await request('/agent/admin_token_a/guests/add', env, { method: 'POST' }));
  });

  it('returns a generic 503 for nested and future paths', async () => {
    await expectGeneric503(await request('/agent/admin_token_a/guests', env, { method: 'POST' }));
    await expectGeneric503(await request('/agent/admin_token_a/something/deep/route', env));
    await expectGeneric503(await request('/agent/admin_token_a', env, { method: 'PATCH' }));
  });

  it('never reveals token validity: valid, invalid, malformed, and leaked-style tokens are identical', async () => {
    const tokens = [
      'admin_token_a', // valid
      'not-a-real-token',
      'x'.repeat(1000),
      'leaked-or-guessed-token',
    ];
    for (const token of tokens) {
      await expectGeneric503(await request(`/agent/${token}/guests/guest_1/checkin`, env, { method: 'POST' }));
      await expectGeneric503(await request(`/agent/${token}`, env));
    }
  });

  it('leaks no guest or event data in the response', async () => {
    const res = await request('/agent/admin_token_a', env, { headers: { Accept: 'text/html' } });
    const body = await res.text();
    expect(body).not.toContain('Prime Home');
    expect(body).not.toContain('Jane');
    expect(body).not.toContain('Doe');
    expect(body).not.toContain('jane@example.com');
  });

  it('performs no mutation and writes no admin_audit row for blocked requests', async () => {
    await request('/agent/admin_token_a/guests/guest_1/checkin', env, { method: 'POST' });
    await request('/agent/admin_token_a/guests/add', env, { method: 'POST' });
    await request('/agent/admin_token_a', env);
    const guest = db.queryOne<{ checked_in: number }>('SELECT checked_in FROM guests WHERE id = ?', 'guest_1');
    expect(guest!.checked_in).toBe(0);
    expect(db.query('SELECT * FROM guests WHERE first_name = ?', 'New')).toHaveLength(0);
    expect(db.query('SELECT * FROM admin_audit')).toHaveLength(0);
  });

  it('lets no token value enter structured logs', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line: string) => logs.push(String(line)));
    await request('/agent/admin_token_a/guests/guest_1/checkin', env, { method: 'POST' });
    await request('/agent/admin_token_a', env);
    const serialized = logs.join('\n');
    expect(serialized).not.toContain('admin_token_a');
  });

  it('preserves public routes: sign-in, RSVP, /api/photo, /api/flyer', async () => {
    const signIn = await request('/e/public_token_a/signin', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'first_name=Joe&last_name=Smith&phone=5551234',
    });
    expect(signIn.status).toBe(302);

    const rsvp = await request('/rsvp/rsvp_token_a/submit', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'first_name=Rita&last_name=Wong&phone=5559999',
    });
    expect(rsvp.status).toBe(302);

    // Public media routes must reach their normal handlers (404 for missing), not 503.
    const photo = await request('/api/photo/events/evt_1/missing.jpg', env);
    expect(photo.status).toBe(404);
    const flyer = await request('/api/flyer/events/evt_1/missing.pdf', env);
    expect(flyer.status).toBe(404);
  });
});
