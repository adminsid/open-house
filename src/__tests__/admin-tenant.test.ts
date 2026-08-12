import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../index';
import { SqliteD1 } from './helpers/d1';
import { createSession } from '../lib/sessions';

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
    BUCKET: {} as unknown as R2Bucket,
    APP_URL: ORIGIN,
    WORKSPACE_URL: WORKSPACE,
    CONTAINMENT_ENABLED: 'false',
  };
}

async function request(path: string, env: Record<string, unknown>, init: RequestInit = {}): Promise<Response> {
  const req = new Request(BASE + path, init);
  return await worker.fetch(req, env as any, {} as any);
}

async function sessionToken(db: SqliteD1, userId: string, tenantId: string): Promise<string> {
  return createSession(db as unknown as D1Database, { userId, tenantId, role: 'admin', userEmail: `${userId}@example.com` });
}

async function csrfOf(db: SqliteD1, userId: string): Promise<string> {
  const row = db.queryOne<{ csrf_token: string }>('SELECT csrf_token FROM admin_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', userId);
  return row!.csrf_token;
}

describe('tenant boundary on admin event operations', () => {
  let db: SqliteD1;
  let env: Record<string, unknown>;

  beforeEach(async () => {
    db = makeDb();
    env = await makeEnv(db);
    await db.exec(
      `INSERT INTO events (id, title, property_address, agent_name, agent_email, start_time, end_time, timezone,
         status, admin_token, public_token, tenant_id, created_at, updated_at)
       VALUES ('evt_1', 'Tenant A Home', '1 Main St', 'Alice', 'alice@example.com',
         '2026-01-01T10:00:00.000Z', '2026-01-01T12:00:00.000Z', 'America/New_York',
         'scheduled', 'admin_token_a', 'public_token_a', 'tenant_primeamerica',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    );
  });

  it('creates an event with the session tenant, not a client-supplied one', async () => {
    const token = await sessionToken(db, 'admin_1', 'tenant_primeamerica');
    const res = await request('/admin/events/new', env, {
      method: 'POST',
      headers: {
        Cookie: `oh_session=${token}`,
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': await csrfOf(db, 'admin_1'),
      },
      body: [
        'title=New+Tenant+A+Event',
        'property_address=9+Oak+St',
        'agent_name=Alice',
        'agent_email=alice%40example.com',
        'start_time=2026-02-01T10%3A00',
        'end_time=2026-02-01T12%3A00',
        'timezone=America%2FNew_York',
      ].join('&'),
    });
    expect(res.status).toBe(302);
    const rows = db.query<{ tenant_id: string | null }>("SELECT tenant_id FROM events WHERE title = 'New Tenant A Event'");
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe('tenant_primeamerica');
  });

  it('a session for another tenant cannot read or mutate a tenant-A event', async () => {
    const otherToken = await sessionToken(db, 'admin_2', 'tenant_other');
    const csrf = await csrfOf(db, 'admin_2');

    const read = await request('/admin/events/admin_token_a', env, {
      headers: { Cookie: `oh_session=${otherToken}`, Accept: 'text/html' },
    });
    expect(read.status).toBe(404);

    const status = await request('/admin/events/admin_token_a/status', env, {
      method: 'POST',
      headers: {
        Cookie: `oh_session=${otherToken}`,
        Origin: ORIGIN,
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'status=achieved',
    });
    expect(status.status).toBe(404);

    const row = db.queryOne<{ status: string }>("SELECT status FROM events WHERE id = 'evt_1'");
    expect(row!.status).toBe('scheduled');
  });

  it('the owning tenant can read and mutate its event', async () => {
    const ownToken = await sessionToken(db, 'admin_1', 'tenant_primeamerica');
    const csrf = await csrfOf(db, 'admin_1');

    const read = await request('/admin/events/admin_token_a', env, {
      headers: { Cookie: `oh_session=${ownToken}`, Accept: 'text/html' },
    });
    expect(read.status).toBe(200);

    const status = await request('/admin/events/admin_token_a/status', env, {
      method: 'POST',
      headers: {
        Cookie: `oh_session=${ownToken}`,
        Origin: ORIGIN,
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'status=achieved',
    });
    expect(status.status).toBe(302);
    const row = db.queryOne<{ status: string }>("SELECT status FROM events WHERE id = 'evt_1'");
    expect(row!.status).toBe('achieved');
  });

  it('a tenant-scoped dashboard only lists events for the session tenant', async () => {
    await db.exec(
      `INSERT INTO events (id, title, property_address, agent_name, agent_email, start_time, end_time, timezone,
         status, admin_token, public_token, tenant_id, created_at, updated_at)
       VALUES ('evt_2', 'Tenant B Home', '2 Elm St', 'Bob', 'bob@example.com',
         '2026-01-01T10:00:00.000Z', '2026-01-01T12:00:00.000Z', 'America/New_York',
         'scheduled', 'admin_token_b', 'public_token_b', 'tenant_other',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    );
    const aToken = await sessionToken(db, 'admin_1', 'tenant_primeamerica');
    await sessionToken(db, 'admin_2', 'tenant_other');
    const res = await request('/admin?filter=all', env, {
      headers: { Cookie: `oh_session=${aToken}`, Accept: 'text/html' },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Tenant A Home');
    expect(html).not.toContain('Tenant B Home');
  });

  it('duplicate preserves the session tenant', async () => {
    const ownToken = await sessionToken(db, 'admin_1', 'tenant_primeamerica');
    const csrf = await csrfOf(db, 'admin_1');
    const res = await request('/admin/events/admin_token_a/duplicate', env, {
      method: 'POST',
      headers: { Cookie: `oh_session=${ownToken}`, Origin: ORIGIN, 'X-CSRF-Token': csrf },
    });
    expect(res.status).toBe(302);
    const rows = db.query<{ tenant_id: string | null }>("SELECT tenant_id FROM events WHERE title LIKE '%(Copy)%'");
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe('tenant_primeamerica');
  });
});
