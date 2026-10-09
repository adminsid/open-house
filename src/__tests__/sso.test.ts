import { describe, it, expect, vi, afterEach } from 'vitest';
import { SqliteD1 } from './helpers/d1';
import { completeSsoLogin } from '../lib/sso';

const WORKSPACE = 'https://workspace.primeamericany.com';

function makeDb(): D1Database {
  const db = new SqliteD1();
  db.applyMigrations();
  return db as unknown as D1Database;
}

function query(db: D1Database, sql: string, ...params: unknown[]): any[] {
  return (db as unknown as SqliteD1).query(sql, ...params);
}

function stubValidate(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    return new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('completeSsoLogin', () => {
  it('creates a session from the validated workspace response only', async () => {
    const db = makeDb();
    stubValidate({
      success: true,
      data: {
        user: { id: 'user_7', email: 'agent@example.com', name: 'Jane', role: 'broker' },
        tenant: { id: 'tenant_primeamerica' },
      },
    });

    const result = await completeSsoLogin(
      db,
      WORKSPACE,
      'sso-token-123',
      'https://openhouse.primeamericarealestate.com/admin?sso_token=sso-token-123'
    );

    expect(result).not.toBeNull();
    expect(result!.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    expect(result!.redirectTo).toBe('/admin');
    expect(result!.actorId).toBe('user_7');
    expect(result!.tenantId).toBe('tenant_primeamerica');

    const row = query(db, 'SELECT user_id, tenant_id, role, user_email, user_name FROM admin_sessions')[0];
    expect(row.user_id).toBe('user_7');
    expect(row.tenant_id).toBe('tenant_primeamerica');
    expect(row.role).toBe('broker');
    expect(row.user_email).toBe('agent@example.com');
    expect(row.user_name).toBe('Jane');
  });

  it('calls the workspace validate endpoint with the sso token', async () => {
    const fetchMock = stubValidate({ success: true, data: { user: { id: 'user_1' } } });
    await completeSsoLogin(makeDb(), WORKSPACE, 'tok-1', '/admin');
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith(`${WORKSPACE}/api/sso/validate?`)).toBe(true);
    expect(url).toContain('token=tok-1');
  });

  it('returns null on a non-2xx validation response and creates no session', async () => {
    const db = makeDb();
    stubValidate({ success: false }, false);
    const result = await completeSsoLogin(db, WORKSPACE, 'bad', '/admin');
    expect(result).toBeNull();
    expect(query(db, 'SELECT * FROM admin_sessions')).toHaveLength(0);
  });

  it('returns null when success is false', async () => {
    const db = makeDb();
    stubValidate({ success: false, data: { user: { id: 'u' } } });
    expect(await completeSsoLogin(db, WORKSPACE, 'bad', '/admin')).toBeNull();
    expect(query(db, 'SELECT * FROM admin_sessions')).toHaveLength(0);
  });

  it('returns null when the user payload is missing', async () => {
    const db = makeDb();
    stubValidate({ success: true, data: {} });
    expect(await completeSsoLogin(db, WORKSPACE, 'bad', '/admin')).toBeNull();
    expect(query(db, 'SELECT * FROM admin_sessions')).toHaveLength(0);
  });

  it('returns null when user.id is missing', async () => {
    const db = makeDb();
    stubValidate({ success: true, data: { user: { email: 'x@example.com' } } });
    expect(await completeSsoLogin(db, WORKSPACE, 'bad', '/admin')).toBeNull();
  });

  it('returns null when the workspace is unreachable', async () => {
    const db = makeDb();
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));
    expect(await completeSsoLogin(db, WORKSPACE, 'bad', '/admin')).toBeNull();
    expect(query(db, 'SELECT * FROM admin_sessions')).toHaveLength(0);
  });

  it('strips the sso_token from the redirect and keeps it host-relative', async () => {
    const db = makeDb();
    stubValidate({ success: true, data: { user: { id: 'u' } } });
    const result = await completeSsoLogin(
      db,
      WORKSPACE,
      'sso-token-123',
      'https://openhouse.primeamericarealestate.com/admin/events/new?from=header&sso_token=sso-token-123'
    );
    expect(result!.redirectTo).toBe('/admin/events/new?from=header');
    expect(result!.redirectTo).not.toContain('sso_token');
    expect(result!.redirectTo.startsWith('/')).toBe(true);
    expect(result!.redirectTo.startsWith('http')).toBe(false);
  });

  it('defaults to /admin for an unparseable returnTo', async () => {
    const db = makeDb();
    stubValidate({ success: true, data: { user: { id: 'u' } } });
    const result = await completeSsoLogin(db, WORKSPACE, 'tok', 'not a url');
    expect(result!.redirectTo).toBe('/admin');
  });

  it('stores NULL for tenant/role/email/name when the response omits them', async () => {
    const db = makeDb();
    stubValidate({ success: true, data: { user: { id: 'u' } } });
    const result = await completeSsoLogin(db, WORKSPACE, 'tok', '/admin');
    expect(result!.tenantId).toBeNull();
    const row = query(db, 'SELECT tenant_id, role, user_email, user_name FROM admin_sessions')[0];
    expect(row.tenant_id).toBeNull();
    expect(row.role).toBeNull();
    expect(row.user_email).toBeNull();
    expect(row.user_name).toBeNull();
  });

  it('does not store the raw sso token or raw session token in the session row', async () => {
    const db = makeDb();
    stubValidate({ success: true, data: { user: { id: 'u' } } });
    const result = await completeSsoLogin(db, WORKSPACE, 'raw-sso-token', '/admin');
    const serialized = JSON.stringify(query(db, 'SELECT * FROM admin_sessions'));
    expect(serialized).not.toContain('raw-sso-token');
    expect(serialized).not.toContain(result!.sessionToken);
  });
});
