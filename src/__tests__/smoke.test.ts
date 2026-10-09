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
      CONTAINMENT_ENABLED: 'false',
    };
  });

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const req = new Request(BASE + path, init);
    return await worker.fetch(req, env as any, {} as any);
  }

  it('exports the dedicated RSVP token so Workspace links resolve to the event', async () => {
    env.INTERNAL_API_SECRET = 'test-event-feed-secret';
    const response = await request('/api/events/list', {
      headers: {
        Authorization: 'Bearer test-event-feed-secret',
        'X-Tenant-Id': 'tenant_primeamerica',
      },
    });
    expect(response.status).toBe(200);
    const { events } = await response.json() as {
      events: { public_token: string; rsvp_token: string }[];
    };
    expect(events).toHaveLength(1);
    expect(events[0].rsvp_token).toBe('rsvp_token_a');
    expect(events[0].rsvp_token).not.toBe(events[0].public_token);
    const rsvp = await request(`/rsvp/${events[0].rsvp_token}`);
    expect(rsvp.status).toBe(200);
    expect(await rsvp.text()).toContain('Prime Home');
  });

  it('/admin/* reaches the authentication boundary when containment is disabled', async () => {
    expect((await request('/admin')).status).toBe(401);
    expect((await request('/admin/events/admin_token_a', { headers: { Accept: 'text/html' } })).status).toBe(302);
  });

  it('/agent/* serves the public agent capability page', async () => {
    const res = await request('/agent/admin_token_a', { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Prime Home');
  });

  it('public sign-in, RSVP, and media routes keep their intended behavior', async () => {
    const signIn = await request('/e/public_token_a/signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'first_name=Joe&last_name=Smith&phone=5551234&consent_contact=1',
    });
    expect(signIn.status).toBe(302);

    const rsvp = await request('/rsvp/rsvp_token_a/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'first_name=Rita&last_name=Wong&phone=5559999&consent_contact=1',
    });
    expect(rsvp.status).toBe(302);

    expect((await request('/api/photo/events/evt_1/missing.jpg')).status).toBe(404);
    expect((await request('/api/flyer/events/evt_1/missing.pdf')).status).toBe(404);
    expect((await request('/e/public_token_a', { headers: { Accept: 'text/html' } })).status).toBe(200);
  });
});
