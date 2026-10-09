import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from '../index';
import { MockR2Bucket } from './helpers/r2';

// Read the deployed-style vars from wrangler.toml so the test exercises the
// real binding shape (minus secrets, which are unset in test).
const env = {
  DB: {} as unknown as D1Database,
  KV: {} as unknown as KVNamespace,
  BUCKET: new MockR2Bucket(),
  APP_URL: 'https://openhouse.primeamericarealestate.com',
  WORKSPACE_URL: 'https://workspace.primeamericany.com',
};

async function request(path: string, headers: Record<string, string> = {}): Promise<Response> {
  const req = new Request(`https://openhouse.primeamericarealestate.com${path}`, { headers });
  return worker.fetch(req, env as any, {} as any);
}

describe('emergency containment guard', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(line));
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns 503 for /admin with no cookie', async () => {
    const res = await request('/admin');
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(await res.text()).toBe('Admin temporarily unavailable');
  });

  it('returns 503 for /admin with a forged admin_session cookie', async () => {
    const res = await request('/admin', { Cookie: 'admin_session=forged-arbitrary-value' });
    expect(res.status).toBe(503);
  });

  it('returns 503 for /admin/events/anything with a forged cookie', async () => {
    const res = await request('/admin/events/anything', { Cookie: 'admin_session=forged' });
    expect(res.status).toBe(503);
  });

  it('returns 503 for /admin/storage/list', async () => {
    const res = await request('/admin/storage/list', { Cookie: 'admin_session=forged' });
    expect(res.status).toBe(503);
  });

  it('does NOT over-match /administrator or /admin-x', async () => {
    const a = await request('/administrator');
    const b = await request('/admin-x');
    expect(a.status).not.toBe(503);
    expect(b.status).not.toBe(503);
  });

  it('emits a sanitized denial log with no credential leakage', async () => {
    await request('/admin', { Cookie: 'admin_session=should-not-appear' });
    expect(logs.length).toBeGreaterThan(0);

    const record = JSON.parse(logs[0]);
    expect(record.event).toBe('admin.containment.denied');
    expect(record.outcome).toBe('denied');
    expect(record.route).toBe('/admin');

    // The forged cookie value must never appear in the log.
    const serialized = logs[0];
    expect(serialized).not.toContain('should-not-appear');
    expect(serialized).not.toContain('admin_session');
    expect(serialized).not.toMatch(/[0-9a-f]{32}/);
  });
});

describe('public routes remain unaffected by containment', () => {
  it('GET / redirects (not 503)', async () => {
    const res = await request('/');
    expect(res.status).not.toBe(503);
  });

  it('GET /login serves (not 503)', async () => {
    const res = await request('/login');
    expect(res.status).not.toBe(503);
  });

  it('GET /api/photo/nonexistent reaches its normal route (not 503)', async () => {
    const res = await request('/api/photo/nonexistent');
    expect(res.status).not.toBe(503);
  });

  it('GET /api/flyer/nonexistent reaches its normal route (not 503)', async () => {
    const res = await request('/api/flyer/nonexistent');
    expect(res.status).not.toBe(503);
  });

  it('GET /e/faketoken reaches its normal route (not 503)', async () => {
    const res = await request('/e/faketoken');
    expect(res.status).not.toBe(503);
  });

  it('GET /rsvp/faketoken reaches its normal route (not 503)', async () => {
    const res = await request('/rsvp/faketoken');
    expect(res.status).not.toBe(503);
  });
});
