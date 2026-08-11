// Privileged admin audit recorder.
//
// Writes append-only records to the admin_audit table. Like the logger, it
// accepts only a fixed, safe-field schema: no raw PII, tokens, secrets,
// guest content, or storage keys. actor_email, if provided, is stored only
// as a one-way SHA-256 hash so the record never contains readable contact data.

export interface AuditRecord {
  actorId?: string;
  actorEmail?: string; // hashed before storage; never stored in clear
  tenantId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  outcome: 'success' | 'denied' | 'error';
  requestId?: string;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function generateId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function recordAudit(db: D1Database, record: AuditRecord): Promise<void> {
  const id = generateId();
  const emailHash = record.actorEmail ? await sha256Hex(record.actorEmail.trim().toLowerCase()) : null;

  await db.prepare(
    `INSERT INTO admin_audit
       (id, actor_id, actor_email_hash, tenant_id, action, target_type, target_id, outcome, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      record.actorId ?? null,
      emailHash,
      record.tenantId ?? null,
      record.action,
      record.targetType ?? null,
      record.targetId ?? null,
      record.outcome,
      record.requestId ?? null
    )
    .run();
}
