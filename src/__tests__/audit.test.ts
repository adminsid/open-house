import { describe, it, expect } from 'vitest';
import { recordAudit } from '../lib/audit';

// A faithful D1 mock that records the bound args of every prepared statement.
function createRecordingD1() {
  const boundArgs: unknown[][] = [];
  const stmt = {
    bind: (...args: unknown[]) => {
      boundArgs.push(args);
      return {
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
        first: async () => null,
      };
    },
  };
  const db = {
    prepare: () => stmt,
    __boundArgs: boundArgs,
  };
  return db as unknown as D1Database & { __boundArgs: unknown[][] };
}

describe('recordAudit', () => {
  it('writes a record with all safe fields bound', async () => {
    const db = createRecordingD1();
    await recordAudit(db, {
      actorId: 'user_42',
      actorEmail: 'Agent@Example.com',
      tenantId: 'tenant_primeamerica',
      action: 'event.delete',
      targetType: 'event',
      targetId: 'evt_abc',
      outcome: 'success',
      requestId: 'ray-123',
    });

    expect(db.__boundArgs).toHaveLength(1);
    const args = db.__boundArgs[0];
    // id, actor_id, actor_email_hash, tenant_id, action, target_type, target_id, outcome, request_id
    expect(args).toHaveLength(9);

    expect(args[1]).toBe('user_42'); // actor_id
    expect(args[4]).toBe('event.delete'); // action
    expect(args[5]).toBe('event'); // target_type
    expect(args[6]).toBe('evt_abc'); // target_id
    expect(args[7]).toBe('success'); // outcome
    expect(args[8]).toBe('ray-123'); // request_id
  });

  it('hashes the actor email (SHA-256, lowercase) and never stores it in clear', async () => {
    const db = createRecordingD1();
    await recordAudit(db, { actorId: 'user_42', actorEmail: 'Agent@Example.com', action: 'x', outcome: 'success' });

    const args = db.__boundArgs[0];
    const emailHash = args[2] as string;

    // 64 hex chars = SHA-256.
    expect(emailHash).toMatch(/^[0-9a-f]{64}$/);
    // Not the clear email in any case variant.
    expect(emailHash).not.toContain('agent');
    expect(emailHash).not.toContain('example');
    // Deterministic: same email → same hash.
    const db2 = createRecordingD1();
    await recordAudit(db2, { actorId: 'user_42', actorEmail: 'agent@example.com', action: 'x', outcome: 'success' });
    expect((db2.__boundArgs[0][2] as string)).toBe(emailHash);
  });

  it('stores NULL for an absent email', async () => {
    const db = createRecordingD1();
    await recordAudit(db, { actorId: 'user_42', action: 'x', outcome: 'success' });
    expect(db.__boundArgs[0][2]).toBeNull();
  });

  it('stores NULL for optional absent fields', async () => {
    const db = createRecordingD1();
    await recordAudit(db, { action: 'x', outcome: 'success' });
    const args = db.__boundArgs[0];
    expect(args[1]).toBeNull(); // actor_id
    expect(args[3]).toBeNull(); // tenant_id
    expect(args[5]).toBeNull(); // target_type
    expect(args[6]).toBeNull(); // target_id
    expect(args[8]).toBeNull(); // request_id
  });

  it('audit record contains no PII, token, or secret values', async () => {
    const db = createRecordingD1();
    await recordAudit(db, {
      actorId: 'user_42',
      actorEmail: 'secret-agent@example.com',
      tenantId: 'tenant_primeamerica',
      action: 'event.delete',
      targetType: 'event',
      targetId: 'evt_abc',
      outcome: 'success',
      requestId: 'ray-123',
    });

    const args = db.__boundArgs[0];
    const serialized = JSON.stringify(args);
    // Clear email must not appear anywhere in the bound values.
    expect(serialized).not.toContain('secret-agent@example.com');
    expect(serialized).not.toContain('secret-agent');

    // The only 32-hex value is the generated audit-row id (args[0]) and the
    // 64-char email hash (args[2]). No external token/secret/key is ever bound.
    const id = args[0] as string;
    const emailHash = args[2] as string;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(emailHash).toMatch(/^[0-9a-f]{64}$/);
    // Every other bound value must be a short opaque id or a known action string.
    const rest = [args[1], args[3], args[4], args[5], args[6], args[7], args[8]];
    for (const v of rest) {
      if (typeof v === 'string') {
        expect(v).not.toMatch(/^[0-9a-f]{32}$/); // no raw token/secret hex
      }
    }
  });
});
