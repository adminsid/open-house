import { safeEqual } from './csrf';
import type { AttendanceEnvironment } from './attendance-delivery';
export async function captureOfflineAttendance(request: Request, env: Pick<AttendanceEnvironment, 'DB'> & { INTERNAL_API_SECRET?: string }): Promise<Response> {
  const secret = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
  if (!env.INTERNAL_API_SECRET || !safeEqual(secret, env.INTERNAL_API_SECRET)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const actorId = request.headers.get('X-User-Id'), tenantId = request.headers.get('X-Tenant-Id');
  const body = await request.json() as { commandId?: string; eventId?: string; eventVersion?: string; occurredAt?: string;
    firstName?: string; lastName?: string; phone?: string; email?: string; consentContact?: boolean; consentMarketing?: boolean };
  if (!actorId || !tenantId || !body.commandId || !/^[a-zA-Z0-9-]{1,80}$/.test(body.commandId)
    || !body.firstName?.trim() || !body.lastName?.trim() || !body.phone?.trim() || body.consentContact !== true
    || !body.occurredAt || !Number.isFinite(Date.parse(body.occurredAt)) || Date.parse(body.occurredAt) > Date.now()
    || [body.firstName,body.lastName,body.phone,body.email||''].some(value=>value.length>254)) return Response.json({ error: 'Invalid attendance command' }, { status: 400 });
  const event = await env.DB.prepare('SELECT id,agent_user_id,updated_at,status FROM events WHERE id=? AND tenant_id=? AND deleted_at IS NULL')
    .bind(body.eventId||null,tenantId).first<{ id: string; agent_user_id: string; updated_at: string; status: string }>();
  if (!event || event.agent_user_id !== actorId) return Response.json({ error: 'Event assignment changed; review attendance' }, { status: 403 });
  const existing = await env.DB.prepare('SELECT event_id,first_name,last_name,phone,email,signed_in_at,consent_marketing FROM guests WHERE id=?')
    .bind(body.commandId).first<{ event_id: string; first_name: string; last_name: string; phone: string; email: string | null; signed_in_at: string; consent_marketing: number }>();
  if (existing) {
    if (existing.event_id !== event.id || existing.first_name !== body.firstName.trim() || existing.last_name !== body.lastName.trim()
      || existing.phone !== body.phone.trim() || existing.email !== (body.email?.trim()||null) || existing.signed_in_at !== body.occurredAt
      || existing.consent_marketing !== (body.consentMarketing===true?1:0)) return Response.json({ error: 'Attendance command conflict' }, { status: 409 });
  } else {
    if (event.updated_at !== body.eventVersion || event.status === 'cancelled') return Response.json({ error: 'Event changed; review before sending attendance' }, { status: 409 });
    const saved = await env.DB.prepare(`INSERT INTO guests (id,event_id,first_name,last_name,phone,email,signed_in_at,consent_contact,consent_marketing,consent_captured_at,crm_sync_status)
      SELECT ?,?,?,?,?,?,?,1,?,?,'pending' FROM events WHERE id=? AND tenant_id=? AND agent_user_id=? AND updated_at=? AND status!='cancelled' AND deleted_at IS NULL`).bind(body.commandId,event.id,body.firstName.trim(),body.lastName.trim(),body.phone.trim(),body.email?.trim()||null,
        body.occurredAt,body.consentMarketing===true?1:0,body.occurredAt,event.id,tenantId,actorId,body.eventVersion).run();
    if (!saved.meta.changes) return Response.json({ error: 'Event changed; review attendance' }, { status: 409 });
  }
  return Response.json({ success: true, id: body.commandId, state: 'server_saved', delivery: 'crm_pending' });
}
