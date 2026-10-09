import { describe, it, expect } from 'vitest';
import { SqliteD1 } from './helpers/d1';
import { deliverAttendance, replayAttendance } from '../lib/attendance-delivery';
function setup() {
  const db = new SqliteD1(); db.applyMigrations();
  db.exec(`INSERT INTO events (id,title,property_address,agent_name,agent_email,start_time,end_time,admin_token,public_token,tenant_id,agent_user_id)
    VALUES ('event','Manual event','1 Main','Agent','a@example.com','2026-01-01','2026-01-02','admin','public','tenant','agent');
    INSERT INTO guests (id,event_id,first_name,last_name,phone,consent_contact,consent_captured_at,signed_in_at)
    VALUES ('guest','event','A','Visitor','5551234567',1,'2026-01-01T12:00:00Z','2026-01-01T12:00:00Z');`);
  return db;
}
describe('durable attendance delivery', () => {
  it('replays a manual event after CRM recovers without another submission', async () => {
    const db = setup(); let online = false; const payloads: unknown[] = [];
    const env = { DB: db as unknown as D1Database, CRM: { fetch: async (_url: unknown, init: RequestInit) => {
      payloads.push(JSON.parse(String(init.body)));
      return online ? Response.json({ data: { contactId: 'contact' } }) : new Response('', { status: 503 });
    } } as unknown as Fetcher };
    await deliverAttendance(env, 'guest');
    expect(db.queryOne<{ crm_sync_status: string }>('SELECT crm_sync_status FROM guests')?.crm_sync_status).toBe('failed');
    online = true; db.exec('UPDATE guests SET crm_next_attempt_at = NULL');
    await replayAttendance(env); await replayAttendance(env);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({ sourceId: 'guest', listingId: null, openHouseEventId: 'event' });
    expect(db.queryOne<{ crm_contact_id: string }>('SELECT crm_contact_id FROM guests')?.crm_contact_id).toBe('contact');
  });
  it('retains a visible repair state for missing assignment and exhausted leases', async () => {
    const db = setup(); db.exec('UPDATE events SET agent_user_id = NULL');
    const env = { DB: db as unknown as D1Database, CRM: {} as Fetcher };
    await replayAttendance(env);
    expect(db.queryOne<{ crm_error_code: string }>('SELECT crm_error_code FROM guests')?.crm_error_code).toBe('assignment_missing');
    db.exec("UPDATE guests SET crm_sync_status='failed', crm_attempts=8, crm_next_attempt_at='2020-01-01'");
    await replayAttendance(env);
    expect(db.queryOne<{ crm_error_code: string }>('SELECT crm_error_code FROM guests')?.crm_error_code).toBe('retry_exhausted');
  });
  it('does not deliver attendance without captured contact consent', async () => {
    const db = setup(); db.exec('UPDATE guests SET consent_contact=0');
    await replayAttendance({ DB: db as unknown as D1Database, CRM: {} as Fetcher });
    expect(db.queryOne<{ crm_attempts: number }>('SELECT crm_attempts FROM guests')?.crm_attempts).toBe(0);
  });
});
