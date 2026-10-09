import app from '../index';
import { describe,it,expect } from 'vitest';
import { SqliteD1 } from './helpers/d1';
import { captureOfflineAttendance } from '../lib/offline-attendance';
describe('offline attendance receipt',()=>{
 it('rejects internal event enumeration without explicit tenant context',async()=>{
  const response=await app.request('/api/events/list',{headers:{Authorization:'Bearer test'}},{INTERNAL_API_SECRET:'test'} as any);
  expect(response.status).toBe(403);
 });
 it('binds tenant, host, version and consent while deduplicating captures',async()=>{
  const db=new SqliteD1();db.applyMigrations();
  db.exec(`INSERT INTO events(id,title,property_address,agent_name,agent_email,start_time,end_time,admin_token,public_token,tenant_id,agent_user_id,updated_at)
    VALUES('event','Synthetic','1 Main','Agent','a@example.com','2026-09-01','2026-09-02','a','p','tenant','agent','v1')`);
  const env={DB:db as unknown as D1Database,INTERNAL_API_SECRET:'test'};
  const command={commandId:'offline-1',eventId:'event',eventVersion:'v1',occurredAt:'2026-09-01T12:00:00Z',firstName:'A',lastName:'Visitor',phone:'5551234567',consentContact:true};
  const send=(body:object,actor='agent',tenant='tenant')=>captureOfflineAttendance(new Request('https://example.com/api/attendance-capture',{method:'POST',headers:{Authorization:'Bearer test','X-User-Id':actor,'X-Tenant-Id':tenant},body:JSON.stringify(body)}),env);
  expect((await send(command,'other')).status).toBe(403);
  expect((await send(command,'agent','other')).status).toBe(403);
  expect((await send({...command,consentContact:false})).status).toBe(400);
  expect((await send({...command,eventVersion:'old'})).status).toBe(409);
  expect(await (await send(command)).json()).toMatchObject({state:'server_saved',delivery:'crm_pending'});
  expect((await send(command)).status).toBe(200);
  expect((await send({...command,phone:'different'})).status).toBe(409);
  expect(db.queryOne<{n:number}>('SELECT COUNT(*) n FROM guests')?.n).toBe(1);
  db.exec("UPDATE events SET agent_user_id='other'");
  expect((await send(command)).status).toBe(403);
 });
});
