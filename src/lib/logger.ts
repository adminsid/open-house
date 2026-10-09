// Sanitized structured logging.
//
// Security contract: this helper emits ONLY the fixed set of fields below.
// It never accepts arbitrary strings, so callers cannot accidentally log
// cookies, auth headers, tokens, secrets, PII, guest content, storage keys,
// or request bodies. Denied-auth events are logged; the credential that was
// rejected is NEVER included.

export type LogEvent =
  | 'admin.containment.denied'
  | 'admin.auth.success'
  | 'admin.auth.failure'
  | 'admin.auth.denied'
  | 'admin.tenant.denied'
  | 'admin.csrf.denied'
  | 'admin.authz.denied'
  | 'audit.record'
  | 'public.event.served'
  | 'public.rsvp.served'
  | 'public.media.served'
  | 'api.internal.request';

export type LogOutcome = 'success' | 'denied' | 'error';

export interface LogFields {
  event: LogEvent;
  outcome: LogOutcome;
  route?: string;
  /** cf-ray or a generated request correlation id. Never a session id. */
  requestId?: string;
  /** Opaque actor identifier (e.g. user id). Never an email or name. */
  actorId?: string;
  /** Tenant id from the trusted server-side session. Never client-supplied. */
  tenantId?: string;
  /** Target record id (event id, etc.). Never a token or key. */
  targetId?: string;
  /** Coarse client metadata only. */
  clientCountry?: string;
  clientBrowser?: string;
}

const FIELD_KEYS: Array<keyof LogFields> = [
  'event',
  'outcome',
  'route',
  'requestId',
  'actorId',
  'tenantId',
  'targetId',
  'clientCountry',
  'clientBrowser',
];

export function emitLog(fields: LogFields): void {
  const record: Record<string, unknown> = { event: fields.event, outcome: fields.outcome };

  for (const key of FIELD_KEYS.slice(2)) {
    const value = fields[key];
    if (value !== undefined && value !== null && value !== '') {
      record[key] = value;
    }
  }

  // Structured JSON so Workers Logs indexes fields instead of free-text match.
  console.log(JSON.stringify(record));
}

/** Generate an opaque request correlation id when cf-ray is unavailable. */
export function generateRequestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
