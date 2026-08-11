import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

async function makeEnv(db: SqliteD1, containment: boolean): Promise<Record<string, unknown>> {
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
    CONTAINMENT_ENABLED: containment ? 'false' : undefined,
  };
}

async function request(path: string, env: Record<string, unknown>, init: RequestInit = {}): Promise<Response> {
  const req = new Request(BASE + path, init);
  return await worker.fetch(req, env as any, {} as any);
}

function cookieFrom(res: Response, name: string): string | null {
  const setCookies = (res.headers as any).getSetCookie?.() ?? [];
  for (const sc of setCookies) {
    const m = sc.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return m[1];
  }
  return null;
}

async function sessionToken(db: SqliteD1, userId = 'admin_1'): Promise<string> {
  return createSession(db as unknown as D1Database, { userId, role: 'admin', userEmail: 'admin@example.com' });
}

async function csrfOf(db: SqliteD1): Promise<string> {
  const row = db.queryOne<{ csrf_token: string }>('SELECT csrf_token FROM admin_sessions ORDER BY created_at DESC LIMIT 1');
  return row!.csrf_token;
}

describe('production default: containment stays on', () => {
  it('still 503s /admin when CONTAINMENT_ENABLED is unset, even with a valid session', async () => {
    const db = makeDb();
    const env = await makeEnv(db, false);
    const token = await sessionToken(db);
    const res = await request('/admin', env, { headers: { Cookie: `oh_session=${token}` } });
    expect(res.status).toBe(503);
  });
});

describe('admin authentication (containment opt-out for tests)', () => {
  let db: SqliteD1;
  let env: Record<string, unknown>;

  beforeEach(async () => {
    db = makeDb();
    env = await makeEnv(db, true);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('redirects HTML navigations to Workspace SSO with app=openhouse when unauthenticated', async () => {
    const res = await request('/admin', env, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith(`${WORKSPACE}/api/sso/redirect?`)).toBe(true);
    expect(loc).toContain('app=openhouse');
    expect(loc).toContain(encodeURIComponent(BASE + '/admin'));
  });

  it('returns 401 JSON for non-HTML unauthenticated requests', async () => {
    const res = await request('/admin/events/new', env, { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });

  it('rejects a forged session cookie', async () => {
    const res = await request('/admin', env, { headers: { Cookie: 'oh_session=f'.repeat(64) } });
    expect(res.status).toBe(401);
  });

  it('rejects a valid-format but unknown session token', async () => {
    const token = await sessionToken(db);
    const res = await request('/admin', env, { headers: { Cookie: `oh_session=${token}x` } });
    expect(res.status).toBe(401);
  });

  it('rejects a revoked session', async () => {
    const token = await sessionToken(db);
    await db.exec("UPDATE admin_sessions SET revoked_at = '2026-01-01T00:00:00.000Z' WHERE token_hash IN (SELECT token_hash FROM admin_sessions)");
    const res = await request('/admin', env, { headers: { Cookie: `oh_session=${token}` } });
    expect(res.status).toBe(401);
  });

  it('allows a valid session to load the admin dashboard', async () => {
    const token = await sessionToken(db);
    const res = await request('/admin', env, { headers: { Cookie: `oh_session=${token}`, Accept: 'text/html' } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Open House Admin');
    expect(html).toContain('csrf-token');
  });

  it('records an audit row for a denied authentication attempt', async () => {
    await request('/admin', env, { method: 'POST' });
    const rows = db.query<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM admin_audit WHERE action = 'admin.auth'"
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].outcome).toBe('denied');
  });

  it('never logs the rejected session token', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(line));
    await request('/admin', env, { headers: { Cookie: 'oh_session=supersecrettokenvalue' } });
    const serialized = logs.join('\n');
    expect(serialized).not.toContain('supersecrettokenvalue');
    expect(serialized).not.toContain('oh_session');
  });
});

describe('admin CSRF', () => {
  let db: SqliteD1;
  let env: Record<string, unknown>;
  let token: string;

  beforeEach(async () => {
    db = makeDb();
    env = await makeEnv(db, true);
    token = await sessionToken(db);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('rejects a state-changing POST without any CSRF token', async () => {
    const res = await request('/admin/events/new', env, {
      method: 'POST',
      headers: { Cookie: `oh_session=${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a POST from a mismatched origin even with a valid token', async () => {
    const res = await request('/admin/events/new', env, {
      method: 'POST',
      headers: {
        Cookie: `oh_session=${token}`,
        Origin: 'https://evil.example.com',
        'X-CSRF-Token': await csrfOf(db),
      },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a POST with a wrong token from the approved origin', async () => {
    const res = await request('/admin/events/new', env, {
      method: 'POST',
      headers: {
        Cookie: `oh_session=${token}`,
        Origin: ORIGIN,
        'X-CSRF-Token': 'f'.repeat(48),
      },
    });
    expect(res.status).toBe(403);
  });

  it('accepts a POST with a valid X-CSRF-Token header from the approved origin', async () => {
    const res = await request('/admin/events/new', env, {
      method: 'POST',
      headers: {
        Cookie: `oh_session=${token}`,
        Origin: ORIGIN,
        'X-CSRF-Token': await csrfOf(db),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'title=Test',
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('accepts a POST with a valid _csrf form field', async () => {
    const res = await request('/admin/events/new', env, {
      method: 'POST',
      headers: {
        Cookie: `oh_session=${token}`,
        Origin: ORIGIN,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `title=Test&_csrf=${await csrfOf(db)}`,
    });
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('accepts GET requests without a CSRF token', async () => {
    const res = await request('/admin', env, { headers: { Cookie: `oh_session=${token}`, Accept: 'text/html' } });
    expect(res.status).toBe(200);
  });

  it('rejects a cross-origin POST with no Origin header but a hostile Referer', async () => {
    const res = await request('/admin/events/new', env, {
      method: 'POST',
      headers: {
        Cookie: `oh_session=${token}`,
        Referer: 'https://evil.example.com/fake',
        'X-CSRF-Token': await csrfOf(db),
      },
    });
    expect(res.status).toBe(403);
  });
});

describe('logout', () => {
  let db: SqliteD1;
  let env: Record<string, unknown>;
  let token: string;

  beforeEach(async () => {
    db = makeDb();
    env = await makeEnv(db, true);
    token = await sessionToken(db);
  });

  it('revokes the session and clears cookies from the approved origin', async () => {
    const res = await request('/logout', env, {
      method: 'POST',
      headers: { Cookie: `oh_session=${token}`, Origin: ORIGIN },
    });
    expect(res.status).toBe(302);
    const revoked = db.queryOne<{ revoked_at: string | null }>('SELECT revoked_at FROM admin_sessions LIMIT 1');
    expect(revoked!.revoked_at).not.toBeNull();
    expect(cookieFrom(res, 'oh_session')).toBe('');
  });

  it('rejects cross-origin logout', async () => {
    const res = await request('/logout', env, {
      method: 'POST',
      headers: { Cookie: `oh_session=${token}`, Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
    const revoked = db.queryOne<{ revoked_at: string | null }>('SELECT revoked_at FROM admin_sessions LIMIT 1');
    expect(revoked!.revoked_at).toBeNull();
  });
});

describe('SSO callback', () => {
  let db: SqliteD1;
  let env: Record<string, unknown>;

  beforeEach(async () => {
    db = makeDb();
    env = await makeEnv(db, true);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('exchanges a valid token for a session cookie and host-relative redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({
          success: true,
          data: {
            user: { id: 'user_9', email: 'agent@example.com', name: 'Jane', role: 'broker' },
            tenant: { id: 'tenant_primeamerica' },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      )
    );
    const res = await request('/admin?sso_token=onetimetoken', env, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    expect(cookieFrom(res, 'oh_session')).toMatch(/^[0-9a-f]{64}$/);
    const row = db.queryOne<{ user_id: string; tenant_id: string }>('SELECT user_id, tenant_id FROM admin_sessions');
    expect(row!.user_id).toBe('user_9');
    expect(row!.tenant_id).toBe('tenant_primeamerica');
  });

  it('never leaks the sso_token into the redirect', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { user: { id: 'u' } } }), { status: 200 })
      )
    );
    const res = await request('/admin?sso_token=leakme', env, { headers: { Accept: 'text/html' } });
    expect(res.headers.get('location')).not.toContain('leakme');
    expect(res.headers.get('location')).not.toContain('sso_token');
  });

  it('returns 401 and creates no session when validation fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const res = await request('/admin?sso_token=bad', env, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(401);
    expect(db.query('SELECT * FROM admin_sessions')).toHaveLength(0);
  });

  it('clears legacy cookies on a successful exchange', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, data: { user: { id: 'u' } } }), { status: 200 })
      )
    );
    const res = await request('/admin?sso_token=tok', env, {
      headers: { Cookie: 'admin_session=old; openhouse_user=%7B%7D', Accept: 'text/html' },
    });
    expect(cookieFrom(res, 'admin_session')).toBe('');
    expect(cookieFrom(res, 'openhouse_user')).toBe('');
  });
});

describe('login flow creates a server-side session', () => {
  it('POST /login sets oh_session and the session works on /admin', async () => {
    const db = makeDb();
    const env = await makeEnv(db, true);
    const res = await request('/login', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=admin@example.com&password=secret-password',
    });
    expect(res.status).toBe(302);
    const cookie = cookieFrom(res, 'oh_session');
    expect(cookie).toMatch(/^[0-9a-f]{64}$/);

    const dashboard = await request('/admin', env, { headers: { Cookie: `oh_session=${cookie}`, Accept: 'text/html' } });
    expect(dashboard.status).toBe(200);
  });

  it('rejects bad credentials', async () => {
    const db = makeDb();
    const env = await makeEnv(db, true);
    const res = await request('/login', env, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=admin@example.com&password=wrong',
    });
    expect(res.status).toBe(401);
    expect(cookieFrom(res, 'oh_session')).toBeNull();
  });
});

describe('public routes unaffected when containment is opted out', () => {
  it('GET /login still serves', async () => {
    const db = makeDb();
    const env = await makeEnv(db, true);
    const res = await request('/login', env, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(200);
  });

  it('GET /e/:token still reaches its route', async () => {
    const db = makeDb();
    const env = await makeEnv(db, true);
    const res = await request('/e/faketoken', env);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});
