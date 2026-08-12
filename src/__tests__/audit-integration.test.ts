import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../index';
import { SqliteD1 } from './helpers/d1';
import { createSession } from '../lib/sessions';
import { auditParams } from '../lib/audit';

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
    ADMIN_TENANT_ID: 'tenant_primeamerica',
    CONTAINMENT_ENABLED: 'false',
  };
}

async function request(path: string, env: Record<string, unknown>, init: RequestInit = {}): Promise<Response> {
  const req = new Request(BASE + path, init);
  return await worker.fetch(req, env as any, {} as any);
}

async function sessionToken(db: SqliteD1): Promise<string> {
  return createSession(db as unknown as D1Database, { userId: 'admin_1', tenantId: 'tenant_primeamerica', role: 'admin', userEmail: 'admin@example.com' });
}

async function csrfOf(db: SqliteD1): Promise<string> {
  const row = db.queryOne<{ csrf_token: string }>('SELECT csrf_token FROM admin_sessions ORDER BY created_at DESC LIMIT 1');
  return row!.csrf_token;
}

function seedEvent(db: SqliteD1): void {
  db.exec(
    `INSERT INTO events (id, title, property_address, agent_name, agent_email, start_time, end_time, timezone,
       status, admin_token, public_token, tenant_id, created_at, updated_at)
     VALUES ('evt_1', 'Prime Home', '123 Prime Ave, NYC', 'Alice Agent', 'alice@example.com',
       '2026-01-01T10:00:00.000Z', '2026-01-01T12:00:00.000Z', 'America/New_York',
       'scheduled', 'admin_token_a', 'public_token_a', 'tenant_primeamerica',
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  );
}

interface AuditRow {
  actor_id: string | null;
  actor_email_hash: string | null;
  tenant_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  outcome: string;
  request_id: string | null;
}

describe('atomic privileged audit trail', () => {
  let db: SqliteD1;
  let env: Record<string, unknown>;

  beforeEach(async () => {
    db = makeDb();
    env = await makeEnv(db);
    seedEvent(db);
  });

  it('persists a sanitized audit row atomically with the mutation', async () => {
    const token = await sessionToken(db);
    const res = await request('/admin/events/admin_token_a/status', env, {
      method: 'POST',
      headers: {
        Cookie: `oh_session=${token}`,
        Origin: ORIGIN,
        'X-CSRF-Token': await csrfOf(db),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'status=achieved',
    });
    expect(res.status).toBe(302);

    const row = db.queryOne<AuditRow>('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 1');
    expect(row).not.toBeNull();
    expect(row!.action).toBe('admin.event.status');
    expect(row!.outcome).toBe('success');
    expect(row!.actor_id).toBe('admin_1');
    expect(row!.tenant_id).toBe('tenant_primeamerica');
    expect(row!.target_type).toBe('event');
    expect(row!.target_id).toBe('evt_1');
    expect(row!.request_id).toBeTruthy();

    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('alice@example.com');
    expect(serialized).not.toContain('123 Prime Ave');
    expect(serialized).not.toContain('admin_token_a');
    expect(serialized).not.toContain('public_token_a');
    expect(row!.actor_email_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails the mutation and rolls back the data change when the audit write fails', async () => {
    const token = await sessionToken(db);
    await db.exec('DROP TABLE admin_audit');

    const res = await request('/admin/events/admin_token_a/status', env, {
      method: 'POST',
      headers: {
        Cookie: `oh_session=${token}`,
        Origin: ORIGIN,
        'X-CSRF-Token': await csrfOf(db),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'status=achieved',
    });
    expect(res.status).toBe(500);

    const row = db.queryOne<{ status: string }>("SELECT status FROM events WHERE id = 'evt_1'");
    expect(row!.status).toBe('scheduled');
  });

  it('does not persist a created event when the audit write fails', async () => {
    const token = await sessionToken(db);
    await db.exec('DROP TABLE admin_audit');

    const res = await request('/admin/events/new', env, {
      method: 'POST',
      headers: {
        Cookie: `oh_session=${token}`,
        Origin: ORIGIN,
        'X-CSRF-Token': await csrfOf(db),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: [
        'title=New+Event',
        'property_address=9+Oak+St',
        'agent_name=Bob',
        'agent_email=bob%40example.com',
        'start_time=2026-02-01T10%3A00',
        'end_time=2026-02-01T12%3A00',
        'timezone=America%2FNew_York',
      ].join('&'),
    });
    expect(res.status).toBe(500);

    const rows = db.query<{ id: string }>("SELECT id FROM events WHERE title = 'New Event'");
    expect(rows).toHaveLength(0);
  });

  it('never records guest content in the audit row for a guest add', async () => {
    const token = await sessionToken(db);
    const res = await request('/admin/events/admin_token_a/guests/add', env, {
      method: 'POST',
      headers: {
        Cookie: `oh_session=${token}`,
        Origin: ORIGIN,
        'X-CSRF-Token': await csrfOf(db),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'first_name=Jane&last_name=Doe&email=jane%40secret-email.com&notes=Private+medical+info',
    });
    expect(res.status).toBe(302);

    const auditRows = db.query<AuditRow>("SELECT * FROM admin_audit WHERE action = 'admin.guest.add'");
    expect(auditRows).toHaveLength(1);
    const serialized = JSON.stringify(auditRows);
    expect(serialized).not.toContain('Jane');
    expect(serialized).not.toContain('Doe');
    expect(serialized).not.toContain('jane@secret-email.com');
    expect(serialized).not.toContain('Private medical info');
    expect(auditRows[0].target_type).toBe('guest');
    expect(auditRows[0].target_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a denied authentication attempt writes NO admin_audit rows', async () => {
    await request('/admin', env, { method: 'POST' });
    const rows = db.query('SELECT * FROM admin_audit');
    expect(rows).toHaveLength(0);
  });

  it('audit bindings contain only the fixed safe schema', async () => {
    const params = await auditParams({
      actorId: 'admin_1',
      actorEmail: 'admin@example.com',
      tenantId: 'tenant_primeamerica',
      action: 'admin.event.status',
      targetType: 'event',
      targetId: 'evt_1',
      outcome: 'success',
      requestId: 'ray-1',
    });
    expect(params).toHaveLength(9);
    expect(params[0]).toMatch(/^[0-9a-f]{32}$/); // row id
    expect(params[1]).toBe('admin_1');
    expect(params[2]).toMatch(/^[0-9a-f]{64}$/); // email hash, never clear
    expect(params[3]).toBe('tenant_primeamerica');
    expect(params[4]).toBe('admin.event.status');
    expect(params[5]).toBe('event');
    expect(params[6]).toBe('evt_1');
    expect(params[7]).toBe('success');
    expect(params[8]).toBe('ray-1');
    const serialized = JSON.stringify(params);
    expect(serialized).not.toContain('admin@example.com');
    expect(serialized).not.toContain('admin_token');
    expect(serialized).not.toContain('public_token');
  });
});
