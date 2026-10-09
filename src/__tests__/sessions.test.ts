import { describe, it, expect } from 'vitest';
import { SqliteD1 } from './helpers/d1';
import {
  createSession,
  findSession,
  validateSession,
  revokeSession,
  revokeAllUserSessions,
  generateSessionToken,
  SESSION_COOKIE,
  ABSOLUTE_TTL_SECONDS,
  IDLE_TTL_SECONDS,
} from '../lib/sessions';

async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function makeDb(): D1Database {
  const db = new SqliteD1();
  db.applyMigrations();
  return db as unknown as D1Database;
}

function query(db: D1Database, sql: string, ...params: unknown[]): any[] {
  return (db as unknown as SqliteD1).query(sql, ...params);
}

async function insertSession(
  db: D1Database,
  rawToken: string,
  overrides: { absoluteExpiresAt?: string; idleExpiresAt?: string; revokedAt?: string | null } = {}
): Promise<void> {
  const tokenHash = await sha256(rawToken);
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO admin_sessions
         (token_hash, user_id, csrf_token, created_at, last_seen_at, absolute_expires_at, idle_expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      tokenHash,
      'user_1',
      'csrf-token',
      past,
      past,
      overrides.absoluteExpiresAt ?? future,
      overrides.idleExpiresAt ?? future,
      overrides.revokedAt ?? null
    )
    .run();
}

describe('session creation', () => {
  it('persists only the SHA-256 hash, never the raw token', async () => {
    const db = makeDb();
    const raw = await createSession(db, {
      userId: 'user_1',
      tenantId: 'tenant_primeamerica',
      role: 'broker',
      userEmail: 'agent@example.com',
      userName: 'Jane Agent',
    });

    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    const row = query(db, 'SELECT token_hash, user_id, tenant_id, role, user_email, user_name, csrf_token, revoked_at FROM admin_sessions')[0];
    expect(row).toBeDefined();
    expect(row.token_hash).toBe(await sha256(raw));
    expect(row.token_hash).not.toBe(raw);
    expect(row.user_id).toBe('user_1');
    expect(row.tenant_id).toBe('tenant_primeamerica');
    expect(row.role).toBe('broker');
    expect(row.user_email).toBe('agent@example.com');
    expect(row.user_name).toBe('Jane Agent');
    expect(row.csrf_token).toMatch(/^[0-9a-f]{48}$/);
    expect(row.revoked_at).toBeNull();
  });

  it('sets absolute and idle expiry windows from the constants', async () => {
    const db = makeDb();
    const before = Date.now();
    await createSession(db, { userId: 'user_1' });
    const after = Date.now();
    const row = query(db, 'SELECT absolute_expires_at, idle_expires_at FROM admin_sessions')[0];
    const absolute = new Date(row.absolute_expires_at).getTime();
    const idle = new Date(row.idle_expires_at).getTime();
    expect(absolute).toBeGreaterThanOrEqual(before + ABSOLUTE_TTL_SECONDS * 1000 - 2000);
    expect(absolute).toBeLessThanOrEqual(after + ABSOLUTE_TTL_SECONDS * 1000);
    expect(idle).toBeGreaterThanOrEqual(before + IDLE_TTL_SECONDS * 1000 - 2000);
    expect(idle).toBeLessThanOrEqual(after + IDLE_TTL_SECONDS * 1000);
  });

  it('stores NULL for optional fields when omitted', async () => {
    const db = makeDb();
    await createSession(db, { userId: 'user_1' });
    const row = query(db, 'SELECT tenant_id, role, user_email, user_name FROM admin_sessions')[0];
    expect(row.tenant_id).toBeNull();
    expect(row.role).toBeNull();
    expect(row.user_email).toBeNull();
    expect(row.user_name).toBeNull();
  });

  it('binds a unique session-bound CSRF token', async () => {
    const db = makeDb();
    await createSession(db, { userId: 'user_1' });
    await createSession(db, { userId: 'user_1' });
    const rows = query(db, 'SELECT csrf_token FROM admin_sessions');
    expect(rows[0].csrf_token).toMatch(/^[0-9a-f]{48}$/);
    expect(rows[0].csrf_token).not.toBe(rows[1].csrf_token);
  });
});

describe('findSession', () => {
  it('returns the session for a known token', async () => {
    const db = makeDb();
    const raw = await createSession(db, { userId: 'user_1', tenantId: 'tenant_primeamerica' });
    const session = await findSession(db, raw);
    expect(session).not.toBeNull();
    expect(session!.userId).toBe('user_1');
    expect(session!.tenantId).toBe('tenant_primeamerica');
    expect(session!.csrfToken).toMatch(/^[0-9a-f]{48}$/);
  });

  it('returns null for an unknown, empty, or forged token', async () => {
    const db = makeDb();
    expect(await findSession(db, '')).toBeNull();
    expect(await findSession(db, 'does-not-exist')).toBeNull();
    expect(await findSession(db, 'f'.repeat(64))).toBeNull();
  });

  it('does not mutate last_seen_at', async () => {
    const db = makeDb();
    const raw = await createSession(db, { userId: 'user_1' });
    const past = '2000-01-01T00:00:00.000Z';
    await db.prepare('UPDATE admin_sessions SET last_seen_at = ?').bind(past).run();
    await findSession(db, raw);
    const row = query(db, 'SELECT last_seen_at FROM admin_sessions')[0];
    expect(row.last_seen_at).toBe(past);
  });
});

describe('validateSession', () => {
  it('accepts a valid, unexpired session and returns trusted fields', async () => {
    const db = makeDb();
    const raw = await createSession(db, {
      userId: 'user_1',
      tenantId: 'tenant_primeamerica',
      role: 'broker',
      userEmail: 'agent@example.com',
      userName: 'Jane',
    });
    const session = await validateSession(db, raw);
    expect(session).not.toBeNull();
    expect(session!.userId).toBe('user_1');
    expect(session!.tenantId).toBe('tenant_primeamerica');
    expect(session!.role).toBe('broker');
    expect(session!.userEmail).toBe('agent@example.com');
    expect(session!.userName).toBe('Jane');
  });

  it('rejects an unknown token', async () => {
    const db = makeDb();
    expect(await validateSession(db, generateSessionToken())).toBeNull();
  });

  it('rejects a revoked session', async () => {
    const db = makeDb();
    const raw = generateSessionToken();
    await insertSession(db, raw, { revokedAt: new Date().toISOString() });
    expect(await validateSession(db, raw)).toBeNull();
  });

  it('rejects and revokes an absolutely-expired session', async () => {
    const db = makeDb();
    const raw = generateSessionToken();
    await insertSession(db, raw, { absoluteExpiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await validateSession(db, raw)).toBeNull();
    const row = query(db, 'SELECT revoked_at FROM admin_sessions')[0];
    expect(row.revoked_at).not.toBeNull();
  });

  it('rejects and revokes an idle-expired session', async () => {
    const db = makeDb();
    const raw = generateSessionToken();
    await insertSession(db, raw, { idleExpiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await validateSession(db, raw)).toBeNull();
    const row = query(db, 'SELECT revoked_at FROM admin_sessions')[0];
    expect(row.revoked_at).not.toBeNull();
  });

  it('bumps last_seen_at and extends the idle window on success', async () => {
    const db = makeDb();
    const raw = await createSession(db, { userId: 'user_1' });
    const past = '2000-01-01T00:00:00.000Z';
    await db
      .prepare('UPDATE admin_sessions SET last_seen_at = ?')
      .bind(past)
      .run();
    await validateSession(db, raw);
    const row = query(db, 'SELECT last_seen_at, idle_expires_at FROM admin_sessions')[0];
    expect(new Date(row.last_seen_at).getTime()).toBeGreaterThan(new Date(past).getTime());
    expect(new Date(row.idle_expires_at).getTime()).toBeGreaterThan(new Date(past).getTime());
  });
});

describe('revocation', () => {
  it('revokes a single session', async () => {
    const db = makeDb();
    const raw = await createSession(db, { userId: 'user_1' });
    await revokeSession(db, raw);
    expect(await validateSession(db, raw)).toBeNull();
    const row = query(db, 'SELECT revoked_at FROM admin_sessions')[0];
    expect(row.revoked_at).not.toBeNull();
  });

  it('revokes all sessions for a user only', async () => {
    const db = makeDb();
    const a = await createSession(db, { userId: 'user_1' });
    const b = await createSession(db, { userId: 'user_1' });
    const other = await createSession(db, { userId: 'user_2' });
    await revokeAllUserSessions(db, 'user_1');
    expect(await validateSession(db, a)).toBeNull();
    expect(await validateSession(db, b)).toBeNull();
    expect(await validateSession(db, other)).not.toBeNull();
  });
});

describe('exports', () => {
  it('uses the documented cookie name and TTL constants', () => {
    expect(SESSION_COOKIE).toBe('oh_session');
    expect(ABSOLUTE_TTL_SECONDS).toBe(60 * 60 * 12);
    expect(IDLE_TTL_SECONDS).toBe(60 * 30);
  });
});
