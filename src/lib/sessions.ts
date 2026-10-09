// Server-side opaque session management.
//
// The raw session token is given to the browser in a cookie; only its
// SHA-256 hash is ever stored in D1. A session carries the trusted user id,
// tenant id, role, and (for per-event assignment checks) the validated
// email/name captured at SSO-validation time, plus a session-bound CSRF
// token. Sessions expire absolutely and on idle, and can be revoked.

export interface Session {
  userId: string;
  tenantId: string | null;
  role: string | null;
  userEmail: string | null;
  userName: string | null;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  idleExpiresAt: string;
  revokedAt: string | null;
}

export interface CreateSessionInput {
  userId: string;
  tenantId?: string | null;
  role?: string | null;
  userEmail?: string | null;
  userName?: string | null;
}

// Conservative defaults for an admin portal: absolute cap of 12 hours,
// idle timeout of 30 minutes.
export const ABSOLUTE_TTL_SECONDS = 60 * 60 * 12; // 12 hours
export const IDLE_TTL_SECONDS = 60 * 30; // 30 minutes

const SESSION_COOKIE = 'oh_session';
const SESSION_TOKEN_BYTES = 32; // 256 bits

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(new Uint8Array(buf));
}

/** Generate a cryptographically random opaque session token (hex, 256 bits). */
export function generateSessionToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)));
}

/** Generate a CSRF token bound to the session. */
export function generateCsrfToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(24)));
}

function nowPlusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * Create a session. Returns the raw token (to be set as a cookie) and
 * persists only its hash plus metadata to D1.
 */
export async function createSession(db: D1Database, input: CreateSessionInput): Promise<string> {
  const rawToken = generateSessionToken();
  const tokenHash = await sha256Hex(rawToken);
  const csrfToken = generateCsrfToken();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO admin_sessions
         (token_hash, user_id, tenant_id, role, user_email, user_name, csrf_token, created_at, last_seen_at, absolute_expires_at, idle_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      tokenHash,
      input.userId,
      input.tenantId ?? null,
      input.role ?? null,
      input.userEmail ?? null,
      input.userName ?? null,
      csrfToken,
      now,
      now,
      nowPlusSeconds(ABSOLUTE_TTL_SECONDS),
      nowPlusSeconds(IDLE_TTL_SECONDS)
    )
    .run();

  return rawToken;
}

/** Look up a session by raw token, returning null if unknown. Does not mutate last_seen. */
export async function findSession(db: D1Database, rawToken: string): Promise<Session | null> {
  if (!rawToken) return null;
  const tokenHash = await sha256Hex(rawToken);
  const row = await db
    .prepare(
      `SELECT user_id, tenant_id, role, user_email, user_name, csrf_token, created_at, last_seen_at, absolute_expires_at, idle_expires_at, revoked_at
       FROM admin_sessions WHERE token_hash = ?`
    )
    .bind(tokenHash)
    .first<{
      user_id: string;
      tenant_id: string | null;
      role: string | null;
      user_email: string | null;
      user_name: string | null;
      csrf_token: string;
      created_at: string;
      last_seen_at: string;
      absolute_expires_at: string;
      idle_expires_at: string;
      revoked_at: string | null;
    }>();

  if (!row) return null;
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    role: row.role,
    userEmail: row.user_email,
    userName: row.user_name,
    csrfToken: row.csrf_token,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    absoluteExpiresAt: row.absolute_expires_at,
    idleExpiresAt: row.idle_expires_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Validate a session for an incoming request: exists, not revoked, not past
 * absolute expiry, not past idle expiry. On success, bumps last_seen_at and
 * returns the session. Returns null otherwise and marks an expired session
 * as revoked.
 */
export async function validateSession(db: D1Database, rawToken: string): Promise<Session | null> {
  const session = await findSession(db, rawToken);
  if (!session) return null;

  const now = Date.now();
  if (session.revokedAt) return null;
  if (new Date(session.absoluteExpiresAt).getTime() <= now) {
    await revokeSession(db, rawToken);
    return null;
  }
  if (new Date(session.idleExpiresAt).getTime() <= now) {
    await revokeSession(db, rawToken);
    return null;
  }

  // Bump idle window (best-effort; ignore write failures for the read path).
  const tokenHash = await sha256Hex(rawToken);
  await db
    .prepare(`UPDATE admin_sessions SET last_seen_at = ?, idle_expires_at = ? WHERE token_hash = ?`)
    .bind(new Date().toISOString(), nowPlusSeconds(IDLE_TTL_SECONDS), tokenHash)
    .run()
    .catch(() => {});

  return session;
}

/** Revoke a session by raw token. */
export async function revokeSession(db: D1Database, rawToken: string): Promise<void> {
  const tokenHash = await sha256Hex(rawToken);
  await db
    .prepare(`UPDATE admin_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`)
    .bind(new Date().toISOString(), tokenHash)
    .run();
}

/** Revoke every session for a user (incident response / password change). */
export async function revokeAllUserSessions(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(`UPDATE admin_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
    .bind(new Date().toISOString(), userId)
    .run();
}

export { SESSION_COOKIE };
