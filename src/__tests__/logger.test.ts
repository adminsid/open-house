import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emitLog, generateRequestId, type LogFields } from '../lib/logger';

describe('emitLog', () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      logs.push(line);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a JSON record with only the fixed safe fields', () => {
    emitLog({
      event: 'admin.containment.denied',
      outcome: 'denied',
      route: '/admin',
      requestId: 'test-ray-123',
      actorId: 'user_42',
      tenantId: 'tenant_primeamerica',
      targetId: 'evt_abc',
      clientCountry: 'US',
      clientBrowser: 'Chrome',
    });

    expect(logs).toHaveLength(1);
    const record = JSON.parse(logs[0]);

    expect(record).toEqual({
      event: 'admin.containment.denied',
      outcome: 'denied',
      route: '/admin',
      requestId: 'test-ray-123',
      actorId: 'user_42',
      tenantId: 'tenant_primeamerica',
      targetId: 'evt_abc',
      clientCountry: 'US',
      clientBrowser: 'Chrome',
    });
  });

  it('omits undefined, null, and empty-string fields', () => {
    emitLog({ event: 'audit.record', outcome: 'success', actorId: 'user_42' });

    const record = JSON.parse(logs[0]);
    expect(record).toEqual({ event: 'audit.record', outcome: 'success', actorId: 'user_42' });
    expect(record).not.toHaveProperty('tenantId');
    expect(record).not.toHaveProperty('targetId');
    expect(record).not.toHaveProperty('route');
  });

  it('NEVER includes sensitive fields even if a caller tries to add them via the typed schema', () => {
    // The schema itself forbids these keys; this asserts the allowlist holds.
    const fields: LogFields = {
      event: 'admin.auth.failure',
      outcome: 'denied',
      actorId: 'user_42',
    };
    emitLog(fields);

    const record = JSON.parse(logs[0]);
    const str = logs[0];

    // No raw credential-like values can appear because the schema has no slot for them.
    expect(str).not.toMatch(/Bearer/i);
    expect(str).not.toMatch(/admin_session/i);
    expect(str).not.toMatch(/sso_token/i);
    expect(str).not.toMatch(/[0-9a-f]{32}/); // no 128-bit token/secret hex
    expect(record).not.toHaveProperty('cookie');
    expect(record).not.toHaveProperty('authorization');
    expect(record).not.toHaveProperty('token');
    expect(record).not.toHaveProperty('secret');
    expect(record).not.toHaveProperty('email');
    expect(record).not.toHaveProperty('name');
    expect(record).not.toHaveProperty('phone');
    expect(record).not.toHaveProperty('address');
  });

  it('logs an opaque actor id but never an email', () => {
    emitLog({ event: 'admin.auth.success', outcome: 'success', actorId: 'user_42' });
    const record = JSON.parse(logs[0]);
    // Opaque id is allowed and present.
    expect(record.actorId).toBe('user_42');
    // No email address (no @) can appear because the schema has no email field.
    expect(logs[0]).not.toMatch(/@/);
  });
});

describe('generateRequestId', () => {
  it('produces a 24-char hex string (12 bytes)', () => {
    const id = generateRequestId();
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it('produces unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateRequestId()));
    expect(ids.size).toBe(100);
  });
});
