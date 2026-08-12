import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../index';
import { SqliteD1 } from './helpers/d1';
import { MockR2Bucket } from './helpers/r2';

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

describe('launch smoke: containment, agent 503, public routes', () => {
  let db: SqliteD1;
  let env: Record<string, unknown>;

  beforeEach(async () => {
    db = makeDb();
    // Admins exist (as in production once setup is complete).
    await db.exec(
      `INSERT INTO admins (id, username, password_hash, name, created_at)
       VALUES ('admin_1', 'admin@example.com', '${await sha256Hex('secret-password')}', 'Admin One', '2026-01-01T00:00:00.000Z')`
    );
    await db.exec(
      `INSERT INTO events (id, title, property_address, agent_name, agent_email, start_time, end_time, timezone,
         status, admin_token, public_token, rsvp_token, tenant_id, created_at, updated_at)
       VALUES ('evt_1', 'Prime Home', '1 Main St', 'Alice', 'alice@example.com',
         '2026-01-01T10:00:00.000Z', '2026-01-01T12:00:00.000Z', 'America/New_York',
         'scheduled', 'admin_token_a', 'public_token_a', 'rsvp_token_a', 'tenant_primeamerica',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    );
    env = {
      DB: db as unknown as D1Database,
      KV: {} as unknown as KVNamespace,
      BUCKET: new MockR2Bucket(),
      APP_URL: BASE,
      WORKSPACE_URL: WORKSPACE,
      ADMIN_TENANT_ID: 'tenant_primeamerica',
    };
  });

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const req = new Request(BASE + path, init);
    return await worker.fetch(req, env as any, {} as any);
  }

  it('/admin/* returns 503 while containment stays on (production default, CONTAINMENT_ENABLED unset)', async () => {
    expect((await request('/admin')).status).toBe(503);
    expect((await request('/admin/events/admin_token_a', { headers: { Accept: 'text/html' } })).status).toBe(503);
  });

  it('/agent/* returns a generic 503 for every method', async () => {
    for (const [path, init] of [
      ['/agent/admin_token_a', { headers: { Accept: 'text/html' } }],
      ['/agent/admin_token_a/export.csv', {}],
      ['/agent/admin_token_a/guests/g1/checkin', { method: 'POST' }],
    ] as Array<[string, RequestInit]>) {
      const res = await request(path, init);
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('Agent access is temporarily unavailable');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('retry-after')).toBe('3600');
    }
  });

  it('public sign-in, RSVP, and media routes keep their intended behavior', async () => {
    const signIn = await request('/e/public_token_a/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'first_name=Joe&last_name=Smith&phone=5551234',
    });
    expect(signIn.status).toBe(302);

    const rsvp = await request('/rsvp/rsvp_token_a/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'first_name=Rita&last_name=Wong&phone=5559999',
    });
    expect(rsvp.status).toBe(302);

    expect((await request('/api/photo/events/evt_1/missing.jpg')).status).toBe(404);
    expect((await request('/api/flyer/events/evt_1/missing.pdf')).status).toBe(404);
    expect((await request('/e/public_token_a', { headers: { Accept: 'text/html' } })).status).toBe(200);
  });
});
