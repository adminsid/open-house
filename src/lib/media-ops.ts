// Durable media-operation outbox.
//
// R2 and D1 cannot be mutated in a single atomic transaction, so security-
// relevant media state changes (photo/agent-photo/flyer/storage mutations)
// are written to the media_ops outbox FIRST and completed by a retryable
// executor. A request reports success only after the required D1 mutation,
// audit row, AND R2 operation have all completed.
//
// Safety rules enforced here:
//   * Delete ops run only when the object is unreferenced in D1 (count of the
//     key across all event photo columns == 0), so a retry can never remove a
//     newly replaced object. Upload keys are always unique (uuid-based), so a
//     stale delete can never match a replacement.
//   * apply_upload ops copy from a unique staging key to the final key
//     idempotently and only point the event column at the final key once the
//     object exists.
//   * R2 keys live ONLY in this outbox (a D1 control-plane record). They never
//     reach console output, structured logs, audit records, HTTP responses, or
//     the reconciliation UI.
//   * Errors are recorded as fixed codes (R2_DELETE_FAILED / MEDIA_APPLY_FAILED
//     / STAGING_MISSING / STAGING_CLEANUP_PENDING / KEY_REFERENCED), never as
//     raw error objects or strings that could echo a key.

import { AUDIT_SQL } from './audit';
import type { AuditRecord } from './audit';

export type MediaOpAction = 'apply_upload' | 'delete';
export type MediaOpStatus = 'pending' | 'processing' | 'done' | 'failed' | 'superseded';

export interface MediaOpInput {
  action: MediaOpAction;
  key: string;
  stagingKey?: string | null;
  targetType?: string | null;
  targetEventId?: string | null;
  targetColumn?: string | null;
  /** The event field's value at operation creation (optimistic concurrency baseline). */
  expectedRef?: string | null;
  /** The event field value this operation intends to set. */
  intendedRef?: string | null;
  /** Dedupes duplicate submissions; persisted on the seq-0 op only. */
  idempotencyKey?: string | null;
  tenantId?: string | null;
  auditAction: string;
  actorId?: string | null;
  actorEmail?: string | null; // clear value, hashed before persist
  requestId?: string | null;
}

export interface MediaOpRecord {
  id: string;
  groupId: string;
  seq: number;
  action: MediaOpAction;
  key: string;
  stagingKey: string | null;
  targetType: string | null;
  targetEventId: string | null;
  targetColumn: string | null;
  tenantId: string | null;
  auditAction: string;
  actorId: string | null;
  actorEmailHash: string | null;
  requestId: string | null;
  status: MediaOpStatus;
  attempts: number;
  errorCode: string | null;
  claimId: string | null;
  expectedRef: string | null;
  intendedRef: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

/** Columns the apply_upload finalize may set. Never interpolate arbitrary input. */
export const SAFE_COLUMNS = ['photo_key', 'agent_photo_key', 'agent_photo_2_key', 'flyer_key'] as const;

const MAX_ATTEMPTS = 5;

function generateId(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input.trim().toLowerCase());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface MediaOpRow {
  id: string;
  group_id: string;
  seq: number;
  action: MediaOpAction;
  key: string;
  staging_key: string | null;
  target_type: string | null;
  target_event_id: string | null;
  target_column: string | null;
  tenant_id: string | null;
  audit_action: string;
  actor_id: string | null;
  actor_email_hash: string | null;
  request_id: string | null;
  status: MediaOpStatus;
  attempts: number;
  error_code: string | null;
  claim_id: string | null;
  expected_ref: string | null;
  intended_ref: string | null;
  idempotency_key: string | null;
  created_at: string;
}

function rowToOp(row: MediaOpRow): MediaOpRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    seq: row.seq,
    action: row.action,
    key: row.key,
    stagingKey: row.staging_key,
    targetType: row.target_type,
    targetEventId: row.target_event_id,
    targetColumn: row.target_column,
    tenantId: row.tenant_id,
    auditAction: row.audit_action,
    actorId: row.actor_id,
    actorEmailHash: row.actor_email_hash,
    requestId: row.request_id,
    status: row.status,
    attempts: row.attempts,
    errorCode: row.error_code,
    claimId: row.claim_id,
    expectedRef: row.expected_ref,
    intendedRef: row.intended_ref,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

async function buildOpInsert(db: D1Database, groupId: string, seq: number, input: MediaOpInput): Promise<D1PreparedStatement> {
  return db
    .prepare(
      `INSERT INTO media_ops
         (id, group_id, seq, action, key, staging_key, target_type, target_event_id, target_column,
          expected_ref, intended_ref, idempotency_key, tenant_id, audit_action, actor_id, actor_email_hash,
          request_id, status, attempts, error_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`
    )
    .bind(
      generateId(),
      groupId,
      seq,
      input.action,
      input.key,
      input.stagingKey ?? null,
      input.targetType ?? null,
      input.targetEventId ?? null,
      input.targetColumn ?? null,
      input.expectedRef ?? null,
      input.intendedRef ?? null,
      seq === 0 ? input.idempotencyKey ?? null : null,
      input.tenantId ?? null,
      input.auditAction,
      input.actorId ?? null,
      input.actorEmail ? await sha256Hex(input.actorEmail) : null,
      input.requestId ?? null,
      now(),
      now()
    );
}

async function buildOpInserts(db: D1Database, ops: MediaOpInput[], groupId: string): Promise<D1PreparedStatement[]> {
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < ops.length; i++) {
    stmts.push(await buildOpInsert(db, groupId, i, ops[i]));
  }
  return stmts;
}

/**
 * Enqueue ops in their own batch (no data change yet). Returns the group id.
 * Used by uploads whose event-column + audit changes are applied at finalize.
 */
/** Look up the group already created for an idempotency key (duplicate submission). */
export async function findMediaGroupByKey(db: D1Database, idempotencyKey: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT group_id FROM media_ops WHERE idempotency_key = ? LIMIT 1')
    .bind(idempotencyKey)
    .first<{ group_id: string }>();
  return row?.group_id ?? null;
}

async function tryEnqueue(db: D1Database, stmts: D1PreparedStatement[], groupId: string, idempotencyKey?: string | null): Promise<string> {
  try {
    await db.batch(stmts);
    return groupId;
  } catch (err) {
    // A concurrent duplicate may have won the idempotency-key race (unique
    // index on seq-0). Reuse that group instead of creating a competing op.
    if (idempotencyKey) {
      const existing = await findMediaGroupByKey(db, idempotencyKey);
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Enqueue ops in their own batch (no data change yet). Returns the group id.
 * Used by uploads whose event-column + audit changes are applied at finalize.
 * If an idempotencyKey is given and a group already exists for it, the existing
 * group is returned (dedup; never a competing operation).
 */
export async function enqueueMediaOps(db: D1Database, ops: MediaOpInput[], idempotencyKey?: string | null): Promise<string> {
  if (idempotencyKey) {
    const existing = await findMediaGroupByKey(db, idempotencyKey);
    if (existing) return existing;
  }
  const groupId = generateId();
  const stmts = await buildOpInserts(db, ops, groupId);
  return await tryEnqueue(db, stmts, groupId, idempotencyKey);
}

/**
 * Enqueue ops ATOMICALLY with the D1 data change and its audit row: one batch
 * of [dataStmts..., auditStmt, opInserts...]. If any statement fails the whole
 * batch rolls back and nothing changes. Used by delete-style routes where the
 * DB reference clear and the outbox delete record must commit together.
 * If an idempotencyKey is given and a group already exists for it, the existing
 * group is returned (dedup; the duplicate submission does not re-apply).
 */
export async function enqueueMediaOpsAtomic(
  db: D1Database,
  dataStmts: D1PreparedStatement[],
  auditRecord: AuditRecord,
  ops: MediaOpInput[],
  idempotencyKey?: string | null
): Promise<string> {
  if (idempotencyKey) {
    const existing = await findMediaGroupByKey(db, idempotencyKey);
    if (existing) return existing;
  }
  const groupId = generateId();
  const opStmts = await buildOpInserts(db, ops, groupId);
  const auditStmt = db.prepare(AUDIT_SQL).bind(
    generateId(),
    auditRecord.actorId ?? null,
    auditRecord.actorEmail ? await sha256Hex(auditRecord.actorEmail) : null,
    auditRecord.tenantId ?? null,
    auditRecord.action,
    auditRecord.targetType ?? null,
    auditRecord.targetId ?? null,
    auditRecord.outcome,
    auditRecord.requestId ?? null
  );
  return await tryEnqueue(db, [...dataStmts, auditStmt, ...opStmts], groupId, idempotencyKey);
}

async function loadOp(db: D1Database, opId: string): Promise<MediaOpRecord | null> {
  const row = await db
    .prepare('SELECT * FROM media_ops WHERE id = ?')
    .bind(opId)
    .first<MediaOpRow>();
  return row ? rowToOp(row) : null;
}

async function loadGroup(db: D1Database, groupId: string): Promise<MediaOpRecord[]> {
  const { results } = await db
    .prepare('SELECT * FROM media_ops WHERE group_id = ? ORDER BY seq ASC')
    .bind(groupId)
    .all<MediaOpRow>();
  return (results ?? []).map(rowToOp);
}

async function setStatus(
  db: D1Database,
  opId: string,
  status: MediaOpStatus,
  attempts: number,
  errorCode: string | null
): Promise<void> {
  await db
    .prepare('UPDATE media_ops SET status = ?, attempts = ?, error_code = ?, updated_at = ? WHERE id = ?')
    .bind(status, attempts, errorCode, now(), opId)
    .run();
}

async function recordErrorCode(db: D1Database, opId: string, code: string): Promise<void> {
  await db
    .prepare('UPDATE media_ops SET error_code = ?, updated_at = ? WHERE id = ?')
    .bind(code, now(), opId)
    .run();
}

async function attemptFailed(db: D1Database, op: MediaOpRecord, code: string): Promise<boolean> {
  const attempts = op.attempts + 1;
  const status: MediaOpStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await setStatus(db, op.id, status, attempts, code);
  return false;
}

async function markDone(db: D1Database, op: MediaOpRecord): Promise<void> {
  await setStatus(db, op.id, 'done', op.attempts, op.errorCode);
}

async function isReferenced(db: D1Database, key: string): Promise<boolean> {
  const check = await db
    .prepare(
      'SELECT COUNT(*) as count FROM events WHERE photo_key = ? OR agent_photo_key = ? OR agent_photo_2_key = ? OR flyer_key = ?'
    )
    .bind(key, key, key, key)
    .first<{ count: number }>();
  return (check?.count ?? 0) > 0;
}

/** Execute one delete op: refcount check, R2 delete, mark done. Idempotent. */
async function runDelete(env: { BUCKET: R2Bucket }, db: D1Database, op: MediaOpRecord): Promise<boolean> {
  try {
    if (await isReferenced(db, op.key)) {
      // The object is still in use (e.g. a preceding op in the group did not
      // complete). Block rather than delete; operator reviews via the UI.
      return await attemptFailed(db, op, 'KEY_REFERENCED');
    }
    await env.BUCKET.delete(op.key);
    await markDone(db, op);
    return true;
  } catch {
    return await attemptFailed(db, op, 'R2_DELETE_FAILED');
  }
}

/** Execute one apply_upload op: guarded apply, then point ref + audit atomically. Idempotent. */
async function runApplyUpload(env: { BUCKET: R2Bucket }, db: D1Database, op: MediaOpRecord): Promise<boolean> {
  try {
    if (!SAFE_COLUMNS.includes(op.targetColumn as (typeof SAFE_COLUMNS)[number])) {
      return await attemptFailed(db, op, 'INVALID_TARGET');
    }
    const col = op.targetColumn as (typeof SAFE_COLUMNS)[number];

    // Read the current field value to decide apply vs already-applied vs superseded.
    const current = await db
      .prepare(`SELECT ${col} AS v FROM events WHERE id = ? AND tenant_id = ?`)
      .bind(op.targetEventId, op.tenantId)
      .first<{ v: string | null }>();
    if (current === null || current === undefined) {
      return await attemptFailed(db, op, 'TARGET_MISSING');
    }

    if (current.v === op.intendedRef) {
      // Already applied by an earlier attempt (e.g. the finalize batch failed
      // after the guarded UPDATE). Ensure audit + done exist, then clean staging.
      await db.batch([auditStmt(db, op), db.prepare('UPDATE media_ops SET status = ?, updated_at = ? WHERE id = ?').bind('done', now(), op.id)]);
      await cleanupStaging(env, db, op);
      return true;
    }

    if (current.v !== op.expectedRef) {
      // The field no longer equals this operation's expected prior reference:
      // a newer operation won. Never overwrite it and never write an
      // audit-success record.
      return await markSuperseded(env, db, op);
    }

    // Field still equals expectedRef: apply. The guarded UPDATE is the atomic
    // verify-and-set — it can only match the expected reference.
    const finalExists = await env.BUCKET.get(op.key);
    if (!finalExists) {
      if (!op.stagingKey) {
        return await attemptFailed(db, op, 'STAGING_MISSING');
      }
      const staging = await env.BUCKET.get(op.stagingKey);
      if (!staging) {
        return await attemptFailed(db, op, 'STAGING_MISSING');
      }
      await env.BUCKET.put(op.key, staging.body, {
        httpMetadata: staging.httpMetadata,
        customMetadata: staging.customMetadata,
      });
    }

    const applyResult = await db
      .prepare(`UPDATE events SET ${col} = ? WHERE id = ? AND tenant_id = ? AND ${col} IS ?`)
      .bind(op.intendedRef, op.targetEventId, op.tenantId, op.expectedRef)
      .run();
    const changes = Number((applyResult.meta as { changes?: unknown } | undefined)?.changes ?? 0);
    if (changes !== 1) {
      // Raced between the SELECT and the guarded UPDATE: a concurrent
      // operation changed the field. Treat as superseded.
      return await markSuperseded(env, db, op);
    }

    await db.batch([auditStmt(db, op), db.prepare('UPDATE media_ops SET status = ?, updated_at = ? WHERE id = ?').bind('done', now(), op.id)]);
    await cleanupStaging(env, db, op);
    return true;
  } catch {
    return await attemptFailed(db, op, 'MEDIA_APPLY_FAILED');
  }
}

function auditStmt(db: D1Database, op: MediaOpRecord): D1PreparedStatement {
  return db.prepare(AUDIT_SQL).bind(
    generateId(),
    op.actorId,
    op.actorEmailHash,
    op.tenantId,
    op.auditAction,
    op.targetType ?? null,
    op.targetEventId ?? null,
    'success',
    op.requestId
  );
}

/** Best-effort staging cleanup after a successful apply; failures are recorded, never fatal. */
async function cleanupStaging(env: { BUCKET: R2Bucket }, db: D1Database, op: MediaOpRecord): Promise<void> {
  if (!op.stagingKey) return;
  try {
    await env.BUCKET.delete(op.stagingKey);
  } catch {
    await recordErrorCode(db, op.id, 'STAGING_CLEANUP_PENDING');
  }
}

/**
 * Mark an op superseded: terminal, never applied, never audited as success.
 * Owned objects (staging key, and the final key if a prior attempt created it)
 * are cleaned up via the outbox under refcount protection, so cleanup can never
 * delete an object that a newer operation references.
 */
async function markSuperseded(env: { BUCKET: R2Bucket }, db: D1Database, op: MediaOpRecord): Promise<boolean> {
  await setStatus(db, op.id, 'superseded', op.attempts, 'SUPERSEDED');
  const cleanupOps: MediaOpInput[] = [];
  if (op.stagingKey) {
    cleanupOps.push({ action: 'delete', key: op.stagingKey, targetType: 'event', tenantId: op.tenantId, auditAction: 'media.cleanup', requestId: op.requestId });
  }
  if (op.key) {
    cleanupOps.push({ action: 'delete', key: op.key, targetType: 'event', tenantId: op.tenantId, auditAction: 'media.cleanup', requestId: op.requestId });
  }
  if (cleanupOps.length > 0) {
    const groupId = await enqueueMediaOps(db, cleanupOps).catch(() => null);
    if (groupId) {
      await executeMediaGroup(env, db, groupId).catch(() => {});
    }
  }
  return false;
}

async function runOp(env: { BUCKET: R2Bucket }, db: D1Database, op: MediaOpRecord): Promise<boolean> {
  if (op.action === 'delete') {
    return await runDelete(env, db, op);
  }
  if (op.action === 'apply_upload') {
    return await runApplyUpload(env, db, op);
  }
  return await attemptFailed(db, op, 'UNKNOWN_ACTION');
}

/**
 * Atomically claim an op for this runner. Only one claim_id wins per op, which
 * serializes concurrent retries of the same group: a concurrent runner either
 * sees 'processing' (already claimed) or 'done' and never re-runs the op.
 */
async function claimOp(db: D1Database, opId: string, claimId: string): Promise<boolean> {
  await db
    .prepare(
      "UPDATE media_ops SET status = 'processing', claim_id = ?, attempts = 0, error_code = NULL, updated_at = ? WHERE id = ? AND status IN ('pending','failed')"
    )
    .bind(claimId, now(), opId)
    .run();
  const row = await db
    .prepare('SELECT status, claim_id FROM media_ops WHERE id = ?')
    .bind(opId)
    .first<{ status: MediaOpStatus; claim_id: string | null }>();
  return row !== null && row.status === 'processing' && row.claim_id === claimId;
}

/**
 * Execute a group in seq order. Returns true only when every op reached 'done'.
 *
 * Concurrency: the first non-done op is claimed atomically; a concurrent
 * runner that loses the claim (or observes 'processing') returns false without
 * touching R2, so a group can never be applied twice. Each subsequent op is
 * claimed right before it runs, so no interleaving runner can double-apply.
 *
 * A false return means the group is incomplete: either a step failed
 * (attemptFailed leaves it pending/failed for operator retry) or another
 * runner is currently processing it. The durable operation may be pending
 * reconciliation — it is NOT rolled back.
 */
export async function executeMediaGroup(
  env: { BUCKET: R2Bucket },
  db: D1Database,
  groupId: string
): Promise<boolean> {
  const ops = await loadGroup(db, groupId);
  const claimId = generateId();
  for (const op of ops) {
    if (op.status === 'done') continue;
    if (op.status === 'superseded') continue; // terminal; never re-runs
    if (op.status === 'processing') return false; // claimed by another runner
    if (op.status === 'failed') return false; // blocked; operator retries
    if (!(await claimOp(db, op.id, claimId))) {
      // Lost the claim: another runner owns the op now (processing) or it just
      // completed / was superseded. Re-read to decide.
      const fresh = await loadOp(db, op.id);
      if (fresh?.status === 'done' || fresh?.status === 'superseded') continue;
      return false;
    }
    const ran = await runOp(env, db, op);
    if (!ran) return false;
  }
  return true;
}

export type RetryResult = {
  ok: boolean;
  status: 'done' | 'claimed' | 'superseded' | 'in_progress' | 'not_found' | 'failed';
  groupId: string | null;
};

/**
 * Operator retry. Idempotent and concurrency-safe:
 *   - a 'done' op is a no-op (never re-applied, no duplicate audit);
 *   - a 'superseded' op is a no-op (a newer operation won);
 *   - a 'processing' op is reported as in_progress (another runner owns it);
 *   - a 'pending'/'failed' op is claimed and its whole group re-executed.
 */
export async function retryMediaOp(
  env: { BUCKET: R2Bucket },
  db: D1Database,
  opId: string
): Promise<RetryResult> {
  const op = await loadOp(db, opId);
  if (!op) return { ok: false, status: 'not_found', groupId: null };
  if (op.status === 'done') return { ok: true, status: 'done', groupId: op.groupId };
  if (op.status === 'superseded') return { ok: true, status: 'superseded', groupId: op.groupId };
  if (op.status === 'processing') return { ok: false, status: 'in_progress', groupId: op.groupId };
  const ok = await executeMediaGroup(env, db, op.groupId);
  return { ok, status: ok ? 'claimed' : 'failed', groupId: op.groupId };
}

/** List ops for the operator reconciliation UI (keys are never surfaced). */
export async function listMediaOps(db: D1Database): Promise<MediaOpRecord[]> {
  const { results } = await db
    .prepare("SELECT * FROM media_ops WHERE status != 'done' ORDER BY created_at ASC")
    .all<MediaOpRow>();
  return (results ?? []).map(rowToOp);
}

/** Load a single op (used to render the reconciliation page without keys). */
export async function getMediaOp(db: D1Database, opId: string): Promise<MediaOpRecord | null> {
  return await loadOp(db, opId);
}
