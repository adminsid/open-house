// The attendance row is also its durable delivery record: submission commits both
// in one INSERT. A lease prevents concurrent replay, and CRM deduplicates sourceId.
export type AttendanceEnvironment = { DB: D1Database; CRM: Fetcher };
type Attendance = {
  id: string; event_id: string; tenant_id: string; agent_user_id: string | null;
  listing_id: string | null; first_name: string; last_name: string;
  email: string | null; phone: string | null; address: string | null;
  notes: string | null; consent_marketing: number; consent_captured_at: string;
  signed_in_at: string; crm_attempts: number;
};
export async function deliverAttendance(env: AttendanceEnvironment, guestId: string): Promise<void> {
  const now = new Date().toISOString();
  const lease = crypto.randomUUID();
  const claimed = await env.DB.prepare(`UPDATE guests SET crm_lease = ?, crm_next_attempt_at = ?,
    crm_attempts = crm_attempts + 1 WHERE id = ? AND consent_contact = 1
    AND crm_sync_status IN ('pending', 'failed') AND crm_attempts < 8
    AND (crm_next_attempt_at IS NULL OR crm_next_attempt_at <= ?)`)
    .bind(lease, new Date(Date.now() + 60000).toISOString(), guestId, now).run();
  if (!claimed.meta.changes) return;
  const guest = await env.DB.prepare(`SELECT g.*, e.tenant_id, e.agent_user_id, e.listing_id
    FROM guests g JOIN events e ON e.id = g.event_id WHERE g.id = ? AND g.crm_lease = ?`)
    .bind(guestId, lease).first<Attendance>();
  if (!guest) return;
  let state = 'failed';
  let code: string | null = 'crm_unavailable';
  let contactId: string | null = null;
  if (!guest.tenant_id || !guest.agent_user_id) {
    state = 'needs_review'; code = 'assignment_missing';
  } else {
    try {
      const response = await env.CRM.fetch('https://crm.internal/api/contacts/upsert-open-house-attendance', {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', 'X-User-Id': guest.agent_user_id,
          'X-Tenant-Id': guest.tenant_id, 'X-User-Role': 'system' },
        body: JSON.stringify({ sourceId: guest.id, listingId: guest.listing_id,
          openHouseEventId: guest.event_id, assignedTo: guest.agent_user_id,
          firstName: guest.first_name, lastName: guest.last_name, email: guest.email,
          phone: guest.phone, address: guest.address, notes: guest.notes,
          consentStatus: guest.consent_marketing ? 'property_and_marketing' : 'property_contact_only',
          consentCapturedAt: guest.consent_captured_at, occurredAt: guest.signed_in_at,
          metadata: { channel: 'open_house_sign_in' } }),
      });
      if (response.ok) {
        const body = await response.json() as { data?: { contactId?: string } };
        if (!body.data?.contactId) throw new Error('Missing acknowledgment');
        contactId = body.data.contactId; state = 'synced'; code = null;
      } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        state = 'needs_review'; code = 'crm_rejected';
      }
    } catch { /* Durable failure below; never log visitor data. */ }
  }
  if (state === 'failed' && guest.crm_attempts >= 8) { state = 'needs_review'; code = 'retry_exhausted'; }
  await env.DB.prepare(`UPDATE guests SET crm_sync_status = ?, crm_error_code = ?,
    crm_contact_id = COALESCE(?, crm_contact_id), crm_synced_at = ?, crm_lease = NULL,
    crm_next_attempt_at = ? WHERE id = ? AND crm_lease = ?`)
    .bind(state, code, contactId, state === 'synced' ? new Date().toISOString() : null,
      new Date(Date.now() + Math.min(3600000, 30000 * 2 ** guest.crm_attempts)).toISOString(), guestId, lease).run();
}
export async function replayAttendance(env: AttendanceEnvironment): Promise<void> {
  await env.DB.prepare(`UPDATE guests SET crm_sync_status = 'needs_review', crm_error_code = 'retry_exhausted', crm_lease = NULL
    WHERE crm_sync_status IN ('pending', 'failed') AND crm_attempts >= 8 AND crm_next_attempt_at <= ?`)
    .bind(new Date().toISOString()).run();
  const rows = await env.DB.prepare(`SELECT id FROM guests WHERE consent_contact = 1
    AND crm_sync_status IN ('pending', 'failed') AND crm_attempts < 8
    AND (crm_next_attempt_at IS NULL OR crm_next_attempt_at <= ?) ORDER BY signed_in_at LIMIT 50`)
    .bind(new Date().toISOString()).all<{ id: string }>();
  for (const row of rows.results) await deliverAttendance(env, row.id);
}
