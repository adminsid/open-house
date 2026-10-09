import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../index';
import { SqliteD1, TEST_LISTING_ID, mockInventory } from './helpers/d1';
import { MockR2Bucket } from './helpers/r2';
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

async function makeEnv(db: SqliteD1, bucket: MockR2Bucket): Promise<Record<string, unknown>> {
  await db.exec(
    `INSERT INTO admins (id, username, password_hash, name, created_at)
     VALUES ('admin_1', 'admin@example.com', '${await sha256Hex('secret-password')}', 'Admin One', '2026-01-01T00:00:00.000Z')`
  );
  return {
    DB: db as unknown as D1Database,
    KV: {} as unknown as KVNamespace,
    BUCKET: bucket,
    APP_URL: ORIGIN,
    WORKSPACE_URL: WORKSPACE,
    ADMIN_TENANT_ID: 'tenant_primeamerica',
    CONTAINMENT_ENABLED: 'false',
    INVENTORY: mockInventory(),
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

async function authHeaders(db: SqliteD1, token: string): Promise<Record<string, string>> {
  return {
    Cookie: `oh_session=${token}`,
    Origin: ORIGIN,
    'X-CSRF-Token': await csrfOf(db),
  };
}

function seedEvent(db: SqliteD1, photoKey: string | null = null): void {
  db.exec(
    `INSERT INTO events (id, title, property_address, agent_name, agent_email, start_time, end_time, timezone,
       status, admin_token, public_token, tenant_id, photo_key, created_at, updated_at)
     VALUES ('evt_1', 'Prime Home', '123 Prime Ave, NYC', 'Alice Agent', 'alice@example.com',
       '2026-01-01T10:00:00.000Z', '2026-01-01T12:00:00.000Z', 'America/New_York',
       'scheduled', 'admin_token_a', 'public_token_a', 'tenant_primeamerica', ${photoKey ? `'${photoKey}'` : 'NULL'},
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  );
}

function uploadForm(fileName = 'a.jpg'): FormData {
  const form = new FormData();
  form.set('photo', new File(['filedata'], fileName, { type: 'image/jpeg' }));
  return form;
}

async function postUpload(
  env: Record<string, unknown>,
  token: string,
  body: FormData | string
): Promise<Response> {
  const headers: Record<string, string> = { Cookie: `oh_session=${token}`, Origin: ORIGIN };
  if (typeof body === 'string') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  return request('/admin/events/admin_token_a/photo', env, { method: 'POST', headers, body });
}

function recreateAdminAudit(db: SqliteD1): void {
  db.exec(
    `CREATE TABLE admin_audit (
       id TEXT PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')),
       actor_id TEXT, actor_email_hash TEXT, tenant_id TEXT, action TEXT NOT NULL,
       target_type TEXT, target_id TEXT, outcome TEXT NOT NULL, request_id TEXT
     )`
  );
}

function auditRows(db: SqliteD1, action: string): Array<Record<string, unknown>> {
  return db.query('SELECT * FROM admin_audit WHERE action = ?', action);
}

function mediaOps(db: SqliteD1): Array<Record<string, unknown>> {
  return db.query('SELECT * FROM media_ops ORDER BY seq ASC');
}

describe('R2 consistency: upload failure / retry matrix', () => {
  let db: SqliteD1;
  let bucket: MockR2Bucket;
  let env: Record<string, unknown>;
  let token: string;

  beforeEach(async () => {
    db = makeDb();
    bucket = new MockR2Bucket();
    env = await makeEnv(db, bucket);
    token = await sessionToken(db);
    seedEvent(db);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('succeeds end-to-end: final object exists, staging cleaned, ref + audit committed, old object deleted on replace', async () => {
    db.query('UPDATE events SET photo_key = ? WHERE id = ?', 'events/evt_1/old.jpg', 'evt_1');
    await bucket.put('events/evt_1/old.jpg', 'old');

    const form = uploadForm();
    form.set('_csrf', await csrfOf(db));
    const res = await postUpload(env, token, form);
    expect(res.status).toBe(302);

    const row = db.queryOne<{ photo_key: string }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1');
    expect(row!.photo_key).toMatch(/^events\/evt_1\/[0-9a-f-]+\.jpg$/);
    const finalKey = row!.photo_key;

    // Final object present; old object removed; staging cleaned.
    expect(bucket.store.has(finalKey)).toBe(true);
    expect(bucket.store.has('events/evt_1/old.jpg')).toBe(false);
    expect(bucket.keys().some((k) => k.startsWith('staging/'))).toBe(false);

    // One audit row, no key in it.
    const audits = auditRows(db, 'admin.event.photo');
    expect(audits).toHaveLength(1);
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(finalKey);
    expect(serialized).not.toContain('staging/');

    // Ops done.
    const ops = mediaOps(db);
    expect(ops.every((o) => o.status === 'done')).toBe(true);
  });

  it('R2 put succeeds + D1/audit fails: op stays pending, guarded ref applied, retry completes audit', async () => {
    await db.exec('DROP TABLE admin_audit');

    const form = uploadForm();
    form.set('_csrf', await csrfOf(db));
    const res = await postUpload(env, token, form);
    expect(res.status).toBe(500);

    // The guarded UPDATE committed; the audit finalize batch rolled back, so the
    // op stays pending with one failed attempt. Staging + final objects exist.
    const ops = mediaOps(db);
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe('pending');
    expect(ops[0].attempts).toBe(1);
    expect(ops[0].error_code).toBe('MEDIA_APPLY_FAILED');
    const finalKey = ops[0].key as string;
    const row = db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1');
    expect(row!.photo_key).toBe(finalKey);
    expect(bucket.store.has(finalKey)).toBe(true);
    expect(bucket.keys().some((k) => k.startsWith('staging/'))).toBe(true);

    // Repair and retry via the operator reconciliation endpoint.
    recreateAdminAudit(db);
    const opId = ops[0].id as string;
    const retry = await request(`/admin/media-ops/retry/${opId}`, env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(retry.status).toBe(302);

    const after = db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1');
    expect(after!.photo_key).toBe(finalKey);
    expect(mediaOps(db)[0].status).toBe('done');
    expect(auditRows(db, 'admin.event.photo')).toHaveLength(1);
    expect(bucket.keys().some((k) => k.startsWith('staging/'))).toBe(false);
  });

  it('R2 put fails before D1/audit: nothing persisted, nothing orphaned', async () => {
    bucket.putFailPrefix = 'staging/';

    const form = uploadForm();
    form.set('_csrf', await csrfOf(db));
    const res = await postUpload(env, token, form);
    expect(res.status).toBe(500);

    expect(mediaOps(db)).toHaveLength(0);
    expect(auditRows(db, 'admin.event.photo')).toHaveLength(0);
    const row = db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1');
    expect(row!.photo_key).toBeNull();
    expect(bucket.keys()).toHaveLength(0);
  });

  it('R2 copy to final fails: op pending, retry completes and never loses the staged body', async () => {
    bucket.putFailPrefix = 'events/';

    const form = uploadForm();
    form.set('_csrf', await csrfOf(db));
    const res = await postUpload(env, token, form);
    expect(res.status).toBe(500);

    const row = db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1');
    expect(row!.photo_key).toBeNull();
    const ops = mediaOps(db);
    expect(ops[0].status).toBe('pending');
    expect(ops[0].error_code).toBe('MEDIA_APPLY_FAILED');
    expect(bucket.keys().some((k) => k.startsWith('staging/'))).toBe(true);

    bucket.putFailPrefix = null;
    const retry = await request(`/admin/media-ops/retry/${ops[0].id}`, env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(retry.status).toBe(302);

    const after = db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1');
    expect(after!.photo_key).toBe(ops[0].key as string);
    expect(mediaOps(db)[0].status).toBe('done');
    expect(bucket.keys().some((k) => k.startsWith('staging/'))).toBe(false);
  });
});

describe('R2 consistency: delete failure / retry matrix', () => {
  let db: SqliteD1;
  let bucket: MockR2Bucket;
  let env: Record<string, unknown>;
  let token: string;
  const OLD_KEY = 'events/evt_1/old.jpg';

  beforeEach(async () => {
    db = makeDb();
    bucket = new MockR2Bucket();
    env = await makeEnv(db, bucket);
    token = await sessionToken(db);
    seedEvent(db, OLD_KEY);
    await bucket.put(OLD_KEY, 'old');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('R2 delete fails after D1+audit commit: ref cleared, op pending, retry removes the object', async () => {
    bucket.deleteFailKeys.add(OLD_KEY);
    const res = await request('/admin/events/admin_token_a/photo/delete', env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(res.status).toBe(500);

    // DB ref cleared + audit committed in the first batch; object still present.
    const row = db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1');
    expect(row!.photo_key).toBeNull();
    expect(auditRows(db, 'admin.event.photo_delete')).toHaveLength(1);
    expect(bucket.store.has(OLD_KEY)).toBe(true);
    const ops = mediaOps(db);
    expect(ops[0].status).toBe('pending');
    expect(ops[0].attempts).toBe(1);
    expect(ops[0].error_code).toBe('R2_DELETE_FAILED');

    bucket.deleteFailKeys.clear();
    const retry = await request(`/admin/media-ops/retry/${ops[0].id}`, env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(retry.status).toBe(302);
    expect(mediaOps(db)[0].status).toBe('done');
    expect(bucket.store.has(OLD_KEY)).toBe(false);
  });

  it('a delete cannot remove a still-referenced object (refcount guard)', async () => {
    // Re-reference the object on another event's column to simulate a replace / cloned event.
    db.query('UPDATE events SET agent_photo_2_key = ? WHERE id = ?', OLD_KEY, 'evt_1');
    bucket.deleteFailKeys.clear();

    const res = await request('/admin/events/admin_token_a/photo/delete', env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(res.status).toBe(302);
    const ops = mediaOps(db);
    expect(ops[0].status).toBe('done');
    // The object survives in bucket because it is still referenced.
    expect(bucket.store.has(OLD_KEY)).toBe(true);
  });

  it('a retry is idempotent: re-running a completed group changes nothing', async () => {
    const res = await request('/admin/events/admin_token_a/photo/delete', env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(res.status).toBe(302);
    const opId = mediaOps(db)[0].id as string;
    expect(bucket.store.has(OLD_KEY)).toBe(false);

    const retry = await request(`/admin/media-ops/retry/${opId}`, env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(retry.status).toBe(302);
    expect(bucket.store.has(OLD_KEY)).toBe(false);
    expect(db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1')!.photo_key).toBeNull();
  });
});

describe('R2 consistency: rename copy succeeds but delete-old fails', () => {
  let db: SqliteD1;
  let bucket: MockR2Bucket;
  let env: Record<string, unknown>;
  let token: string;
  const OLD_KEY = 'events/evt_1/old.jpg';
  const NEW_KEY = 'events/evt_1/new.jpg';

  beforeEach(async () => {
    db = makeDb();
    bucket = new MockR2Bucket();
    env = await makeEnv(db, bucket);
    token = await sessionToken(db);
    seedEvent(db, OLD_KEY);
    await bucket.put(OLD_KEY, 'old');
  });

  it('fails the request, repoints DB, keeps delete-old pending, retry deletes old', async () => {
    bucket.deleteFailKeys.add(OLD_KEY);
    const form = new FormData();
    form.set('oldKey', OLD_KEY);
    form.set('newKey', NEW_KEY);
    const res = await request('/admin/storage/rename', env, {
      method: 'POST',
      headers: await authHeaders(db, token),
      body: form,
    });
    expect(res.status).toBe(500);

    // DB repointed; new object exists; old object still present; delete-old op pending.
    const row = db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1');
    expect(row!.photo_key).toBe(NEW_KEY);
    expect(bucket.store.has(NEW_KEY)).toBe(true);
    expect(bucket.store.has(OLD_KEY)).toBe(true);
    const ops = mediaOps(db);
    const deleteOld = ops.find((o) => o.key === OLD_KEY);
    expect(deleteOld!.status).toBe('pending');
    expect(deleteOld!.error_code).toBe('R2_DELETE_FAILED');

    bucket.deleteFailKeys.clear();
    const retry = await request(`/admin/media-ops/retry/${deleteOld!.id}`, env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(retry.status).toBe(302);
    expect(bucket.store.has(OLD_KEY)).toBe(false);
    expect(bucket.store.has(NEW_KEY)).toBe(true);
  });

  it('rename copy failure leaves DB and R2 untouched', async () => {
    bucket.putFailAll = true;
    const form = new FormData();
    form.set('oldKey', OLD_KEY);
    form.set('newKey', NEW_KEY);
    const res = await request('/admin/storage/rename', env, {
      method: 'POST',
      headers: await authHeaders(db, token),
      body: form,
    });
    expect(res.status).toBe(500);
    expect(db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1')!.photo_key).toBe(OLD_KEY);
    expect(bucket.store.has(NEW_KEY)).toBe(false);
    expect(bucket.store.has(OLD_KEY)).toBe(true);
  });
});

describe('R2 consistency: storage delete failure and no key leakage', () => {
  let db: SqliteD1;
  let bucket: MockR2Bucket;
  let env: Record<string, unknown>;
  let token: string;
  const KEY = 'photos/photo_a.jpg';

  beforeEach(async () => {
    db = makeDb();
    bucket = new MockR2Bucket();
    env = await makeEnv(db, bucket);
    token = await sessionToken(db);
    seedEvent(db, KEY);
    await bucket.put(KEY, 'data');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('storage delete: R2 delete failure leaves refs cleared + op pending, retry removes object', async () => {
    bucket.deleteFailKeys.add(KEY);
    const form = new FormData();
    form.set('key', KEY);
    const res = await request('/admin/storage/delete', env, {
      method: 'POST',
      headers: await authHeaders(db, token),
      body: form,
    });
    expect(res.status).toBe(500);

    expect(db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1')!.photo_key).toBeNull();
    expect(auditRows(db, 'admin.storage.delete')).toHaveLength(1);
    expect(bucket.store.has(KEY)).toBe(true);
    const ops = mediaOps(db);
    expect(ops[0].status).toBe('pending');
    expect(ops[0].error_code).toBe('R2_DELETE_FAILED');

    bucket.deleteFailKeys.clear();
    const retry = await request(`/admin/media-ops/retry/${ops[0].id}`, env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(retry.status).toBe(302);
    expect(bucket.store.has(KEY)).toBe(false);
  });

  it('no storage key leaks into logs, audit rows, responses, or the reconciliation UI', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line: string) => logs.push(String(line)));

    bucket.deleteFailKeys.add(KEY);
    const form = new FormData();
    form.set('key', KEY);
    const res = await request('/admin/storage/delete', env, {
      method: 'POST',
      headers: await authHeaders(db, token),
      body: form,
    });
    expect(res.status).toBe(500);

    const bodyText = await res.text();
    expect(bodyText).not.toContain(KEY);

    const serializedLogs = logs.join('\n');
    expect(serializedLogs).not.toContain(KEY);
    expect(serializedLogs).not.toContain('staging/');

    const serializedAudit = JSON.stringify(auditRows(db, 'admin.storage.delete'));
    expect(serializedAudit).not.toContain(KEY);

    const page = await request('/admin/media-ops', env, {
      headers: { Cookie: `oh_session=${token}`, Accept: 'text/html' },
    });
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).not.toContain(KEY);
    expect(pageHtml).toContain('Media Operations');
  });
});

describe('R2 consistency: recovery semantics', () => {
  let db: SqliteD1;
  let bucket: MockR2Bucket;
  let env: Record<string, unknown>;
  let token: string;

  beforeEach(async () => {
    db = makeDb();
    bucket = new MockR2Bucket();
    env = await makeEnv(db, bucket);
    token = await sessionToken(db);
    seedEvent(db);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('failed A, successful B, retry A: B stays referenced, A becomes superseded, A cleanup never deletes B', async () => {
    // Operation A fails (audit table unavailable).
    await db.exec('DROP TABLE admin_audit');
    const formA = uploadForm();
    formA.set('_csrf', await csrfOf(db));
    expect((await postUpload(env, token, formA)).status).toBe(500);
    const opA = mediaOps(db)[0];
    expect(opA.status).toBe('pending');

    // Operation B succeeds against the same field.
    recreateAdminAudit(db);
    const formB = uploadForm('b.jpg');
    formB.set('_csrf', await csrfOf(db));
    expect((await postUpload(env, token, formB)).status).toBe(302);
    const opB = mediaOps(db).find((o) => o.status === 'done')!;
    const keyB = opB.key as string;
    expect(db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1')!.photo_key).toBe(keyB);

    // Retrying A must NOT overwrite B: A becomes superseded, no audit-success.
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line: string) => logs.push(String(line)));
    const retryA = await request(`/admin/media-ops/retry/${opA.id}`, env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(retryA.status).toBe(500); // superseded is terminal; no re-apply

    const ops = mediaOps(db);
    const aAfter = ops.find((o) => o.id === opA.id)!;
    expect(aAfter.status).toBe('superseded');
    expect(db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1')!.photo_key).toBe(keyB);
    expect(auditRows(db, 'admin.event.photo')).toHaveLength(1); // only B's success

    // B's object survives; A's owned objects (staging + any final key) are gone.
    expect(bucket.store.has(keyB)).toBe(true);
    expect(bucket.keys().some((k) => k.startsWith('staging/'))).toBe(false);
    expect(bucket.store.has(opA.key as string)).toBe(false);

    // A retry of a superseded op is a no-op.
    const again = await request(`/admin/media-ops/retry/${opA.id}`, env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(again.status).toBe(302);
    expect(auditRows(db, 'admin.event.photo')).toHaveLength(1);
    expect(mediaOps(db).find((o) => o.id === opA.id)!.status).toBe('superseded');

    // No key or raw error leaks into logs.
    const serializedLogs = logs.join('\n');
    expect(serializedLogs).not.toContain(keyB);
    expect(serializedLogs).not.toContain(opA.key as string);
    expect(serializedLogs).not.toContain('staging/');
  });

  it('duplicate same submission (same idempotency key) produces one logical operation and one audit record', async () => {
    const form = uploadForm();
    form.set('_csrf', await csrfOf(db));
    form.set('_idem', 'idem-dup');
    const first = await postUpload(env, token, form);
    expect(first.status).toBe(302);
    expect(mediaOps(db)).toHaveLength(1);
    expect(auditRows(db, 'admin.event.photo')).toHaveLength(1);
    const refAfterFirst = db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1')!.photo_key;

    // Re-submit the identical form (same _idem): reuse the existing group.
    const second = await postUpload(env, token, form);
    expect(second.status).toBe(302);
    expect(mediaOps(db)).toHaveLength(1);
    expect(auditRows(db, 'admin.event.photo')).toHaveLength(1);
    expect(db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1')!.photo_key).toBe(refAfterFirst);
    // No competing staging/final objects were created.
    expect(bucket.keys().filter((k) => k.startsWith('staging/'))).toHaveLength(0);
    expect(bucket.keys().length).toBe(1);
  });

  it('duplicate submission after an HTTP 500 reuses the pending group instead of competing', async () => {
    await db.exec('DROP TABLE admin_audit');
    const form = uploadForm();
    form.set('_csrf', await csrfOf(db));
    form.set('_idem', 'idem-500');
    expect((await postUpload(env, token, form)).status).toBe(500);
    expect(mediaOps(db)).toHaveLength(1);

    // Same _idem resubmission must not create a second operation.
    recreateAdminAudit(db);
    expect((await postUpload(env, token, form)).status).toBe(302);
    expect(mediaOps(db)).toHaveLength(1);

    // Operator retry completes the single pending op.
    const opId = mediaOps(db)[0].id as string;
    const retry = await request(`/admin/media-ops/retry/${opId}`, env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(retry.status).toBe(302);
    expect(mediaOps(db)[0].status).toBe('done');
    expect(auditRows(db, 'admin.event.photo')).toHaveLength(1);
  });

  it('retry of a completed group is a no-op: no re-apply, no duplicate audit', async () => {
    const form = uploadForm();
    form.set('_csrf', await csrfOf(db));
    const res = await postUpload(env, token, form);
    expect(res.status).toBe(302);
    const op = mediaOps(db)[0];
    expect(op.status).toBe('done');
    const refBefore = db.queryOne<{ photo_key: string }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1')!.photo_key;
    expect(auditRows(db, 'admin.event.photo')).toHaveLength(1);

    const retry = await request(`/admin/media-ops/retry/${op.id}`, env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(retry.status).toBe(302);
    expect(mediaOps(db)[0].status).toBe('done');
    expect(db.queryOne<{ photo_key: string }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1')!.photo_key).toBe(refBefore);
    expect(auditRows(db, 'admin.event.photo')).toHaveLength(1);
  });

  it('concurrent retries of the same failed group apply the operation exactly once', async () => {
    await db.exec('DROP TABLE admin_audit');
    const form = uploadForm();
    form.set('_csrf', await csrfOf(db));
    expect((await postUpload(env, token, form)).status).toBe(500);
    recreateAdminAudit(db);
    const op = mediaOps(db)[0];

    const [a, b] = await Promise.all([
      request(`/admin/media-ops/retry/${op.id}`, env, { method: 'POST', headers: await authHeaders(db, token) }),
      request(`/admin/media-ops/retry/${op.id}`, env, { method: 'POST', headers: await authHeaders(db, token) }),
    ]);

    // At least one retry completed; the operation was applied exactly once.
    expect([a.status, b.status]).toContain(302);
    expect(auditRows(db, 'admin.event.photo')).toHaveLength(1);
    expect(mediaOps(db)[0].status).toBe('done');
    const ops = mediaOps(db);
    expect(db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1')!.photo_key).toBe(ops[0].key as string);
    expect(bucket.keys().some((k) => k.startsWith('staging/'))).toBe(false);
  });

  it('an R2 error whose message contains the storage key never leaks it anywhere', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line: string) => logs.push(String(line)));

    // Staging put succeeds; the copy to the final key fails with a key-carrying error.
    bucket.putFailPrefix = 'events/';
    const form = uploadForm();
    form.set('_csrf', await csrfOf(db));
    const res = await postUpload(env, token, form);
    expect(res.status).toBe(500);

    const ops = mediaOps(db);
    const finalKey = ops[0].key as string;
    const bodyText = await res.text();
    expect(bodyText).not.toContain(finalKey);
    expect(bodyText).not.toContain('staging/');

    const serializedLogs = logs.join('\n');
    expect(serializedLogs).not.toContain(finalKey);
    expect(serializedLogs).not.toContain('staging/');

    expect(JSON.stringify(auditRows(db, 'admin.event.photo'))).not.toContain(finalKey);

    const page = await request('/admin/media-ops', env, {
      headers: { Cookie: `oh_session=${token}`, Accept: 'text/html' },
    });
    const pageHtml = await page.text();
    expect(pageHtml).not.toContain(finalKey);
    expect(pageHtml).not.toContain('staging/');
  });

  it('failed staging cleanup after a successful upload records STAGING_CLEANUP_PENDING without failing the upload', async () => {
    bucket.deleteFailPrefix = 'staging/';
    const form = uploadForm();
    form.set('_csrf', await csrfOf(db));
    const res = await postUpload(env, token, form);
    expect(res.status).toBe(302); // upload succeeded

    const ops = mediaOps(db);
    expect(ops[0].status).toBe('done');
    expect(ops[0].error_code).toBe('STAGING_CLEANUP_PENDING');
    expect(db.queryOne<{ photo_key: string | null }>('SELECT photo_key FROM events WHERE id = ?', 'evt_1')!.photo_key).toBe(ops[0].key as string);
    expect(auditRows(db, 'admin.event.photo')).toHaveLength(1);
    // Staging object remains (recorded for a prefix sweep), never referenced.
    expect(bucket.keys().some((k) => k.startsWith('staging/'))).toBe(true);
  });
});

describe('R2 consistency: media-ops endpoint authorization', () => {
  let db: SqliteD1;
  let bucket: MockR2Bucket;
  let env: Record<string, unknown>;
  let token: string;

  beforeEach(async () => {
    db = makeDb();
    bucket = new MockR2Bucket();
    env = await makeEnv(db, bucket);
    token = await sessionToken(db);
    seedEvent(db);
  });

  afterEach(() => vi.unstubAllGlobals());

  async function agentRoleToken(): Promise<string> {
    return createSession(db as unknown as D1Database, { userId: 'agent_1', role: 'agent', tenantId: 'tenant_primeamerica', userEmail: 'agent@example.com' });
  }

  it('requires a validated session: unauthenticated list and retry are rejected', async () => {
    expect((await request('/admin/media-ops', env)).status).toBe(401);
    expect((await request('/admin/media-ops/retry/op-1', env, { method: 'POST' })).status).toBe(401);
  });

  it('denies a non-admin role (agent) even with a valid session and tenant', async () => {
    const agentToken = await agentRoleToken();
    const csrf = await csrfOf(db);
    const list = await request('/admin/media-ops', env, {
      headers: { Cookie: `oh_session=${agentToken}`, Accept: 'text/html' },
    });
    expect(list.status).toBe(403);
    const retry = await request('/admin/media-ops/retry/op-1', env, {
      method: 'POST',
      headers: { Cookie: `oh_session=${agentToken}`, Origin: ORIGIN, 'X-CSRF-Token': csrf },
    });
    expect(retry.status).toBe(403);
  });

  it('rejects a cross-origin retry even with a valid admin session', async () => {
    const opId = 'op-1';
    const res = await request('/admin/media-ops/retry/' + opId, env, {
      method: 'POST',
      headers: {
        Cookie: `oh_session=${token}`,
        Origin: 'https://evil.example.com',
        'X-CSRF-Token': await csrfOf(db),
      },
    });
    expect(res.status).toBe(403);
    expect(auditRows(db, 'admin.media_ops.retry')).toHaveLength(0);
  });

  it('audits each retry action and returns 404 for unknown ops', async () => {
    const missing = await request('/admin/media-ops/retry/op-does-not-exist', env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(missing.status).toBe(404);
    expect(auditRows(db, 'admin.media_ops.retry')).toHaveLength(0);

    // Create a real failed op, then retry it.
    await db.exec('DROP TABLE admin_audit');
    const form = uploadForm();
    form.set('_csrf', await csrfOf(db));
    expect((await postUpload(env, token, form)).status).toBe(500);
    recreateAdminAudit(db);
    const op = mediaOps(db)[0];

    const retry = await request(`/admin/media-ops/retry/${op.id}`, env, {
      method: 'POST',
      headers: await authHeaders(db, token),
    });
    expect(retry.status).toBe(302);
    expect(auditRows(db, 'admin.media_ops.retry')).toHaveLength(1);
    expect(mediaOps(db)[0].status).toBe('done');
  });
});

describe('mutation error logging sanitization', () => {
  let db: SqliteD1;
  let bucket: MockR2Bucket;
  let env: Record<string, unknown>;
  let token: string;

  beforeEach(async () => {
    db = makeDb();
    bucket = new MockR2Bucket();
    env = await makeEnv(db, bucket);
    token = await sessionToken(db);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('event-create failure logs a fixed structured code and never renders raw error detail', async () => {
    await db.exec('DROP TABLE events');
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line: string) => logs.push(String(line)));

    const res = await request('/admin/events/new', env, {
      method: 'POST',
      headers: { ...(await authHeaders(db, token)), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: [
        'title=New+Event',
        `listing_id=${TEST_LISTING_ID}`,
        'property_address=9+Oak+St',
        'agent_name=Bob',
        'agent_email=bob%40example.com',
        'start_time=2026-02-01T10%3A00',
        'end_time=2026-02-01T12%3A00',
        'timezone=America%2FNew_York',
      ].join('&'),
    });
    expect(res.status).toBe(500);

    const bodyText = await res.text();
    expect(bodyText).not.toContain('no such table');
    expect(bodyText).not.toContain('SQLite');
    expect(bodyText).toContain('The event could not be created');

    const serializedLogs = logs.join('\n');
    expect(serializedLogs).toContain('"event":"admin.mutation.error"');
    expect(serializedLogs).toContain('"message":"Create failed"');
    expect(serializedLogs).not.toContain('no such table');
    expect(serializedLogs).not.toContain('bob@example.com');
  });

  it('an intentionally key-bearing thrown error never reaches logs, responses, audit, or UI', async () => {
    // The R2 mock embeds the storage key in thrown errors; exercise every
    // failure direction and assert no key/raw text leaks anywhere.
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(String(line)));
    vi.spyOn(console, 'error').mockImplementation((line: string) => logs.push(String(line)));
    const KEY = 'events/evt_1/secret-object.jpg';
    await bucket.put(KEY, 'data');
    await db.exec(
      `INSERT INTO events (id, title, property_address, agent_name, agent_email, start_time, end_time, timezone,
         status, admin_token, public_token, tenant_id, photo_key, created_at, updated_at)
       VALUES ('evt_1', 'Prime Home', '1 Main St', 'Alice', 'alice@example.com',
         '2026-01-01T10:00:00.000Z', '2026-01-01T12:00:00.000Z', 'America/New_York',
         'scheduled', 'admin_token_a', 'public_token_a', 'tenant_primeamerica', '${KEY}',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    );

    bucket.deleteFailKeys.add(KEY);
    const form = new FormData();
    form.set('key', KEY);
    const res = await request('/admin/storage/delete', env, {
      method: 'POST',
      headers: await authHeaders(db, token),
      body: form,
    });
    expect(res.status).toBe(500);

    const bodyText = await res.text();
    expect(bodyText).not.toContain(KEY);
    expect(logs.join('\n')).not.toContain(KEY);
    expect(JSON.stringify(auditRows(db, 'admin.storage.delete'))).not.toContain(KEY);
    const page = await request('/admin/media-ops', env, { headers: { Cookie: `oh_session=${token}`, Accept: 'text/html' } });
    expect(await page.text()).not.toContain(KEY);
  });
});
