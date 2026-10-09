// Workspace SSO → local session bridging.
//
// On a validated SSO callback we exchange the Workspace token server-to-server,
// read user/role/tenant ONLY from that verified response, and create a local
// D1 session. We never trust client-supplied identity, role, or tenant.
//
// DEPENDENCY: the Workspace must expose GET {workspaceUrl}/api/sso/validate
// which consumes the one-time sso_token and returns
//   { success: true, data: { user: { id, email, name, role }, tenant: { id } } }
// (see RE Workspace migrations/025_sso_tokens.sql). Until that endpoint is
// deployed, SSO login cannot complete end-to-end; this side is built against
// the documented contract and is exercised in tests via a stubbed fetch.

import { createSession } from './sessions';

export interface SsoValidation {
  id: string;
  email?: string;
  name?: string;
  role?: string;
  tenantId?: string | null;
}

export interface SsoResult {
  sessionToken: string;
  redirectTo: string;
  /** Opaque ids returned for sanitized logging only. Never rendered or stored in logs verbatim. */
  actorId: string;
  tenantId: string | null;
}

/**
 * Exchange a Workspace sso_token for a local D1 session.
 * Returns the raw session token (to be set as a cookie) and a same-origin
 * redirect path with the sso_token stripped. Returns null if validation fails.
 */
export async function completeSsoLogin(
  db: D1Database,
  workspaceUrl: string,
  ssoToken: string,
  returnTo: string
): Promise<SsoResult | null> {
  const valRes = await fetch(
    `${workspaceUrl}/api/sso/validate?token=${encodeURIComponent(ssoToken)}`,
    { headers: { Accept: 'application/json' } }
  ).catch(() => null);

  if (!valRes || !valRes.ok) return null;

  const valData: any = await valRes.json().catch(() => null);
  if (!valData?.success || !valData?.data?.user) return null;

  const user = valData.data.user;
  const tenant = valData.data.tenant;

  if (!user?.id || typeof user.id !== 'string') return null;

  const sessionToken = await createSession(db, {
    userId: user.id,
    role: typeof user.role === 'string' ? user.role : null,
    tenantId: tenant?.id ?? null,
    userEmail: typeof user.email === 'string' ? user.email : null,
    userName: typeof user.name === 'string' ? user.name : null,
  });

  // Strip the sso_token from the return path; never echo it back. Redirect is
  // host-relative so it can never be an open redirect.
  let redirectTo = '/admin';
  try {
    const clean = new URL(returnTo);
    clean.searchParams.delete('sso_token');
    redirectTo = clean.pathname + clean.search;
  } catch {
    redirectTo = '/admin';
  }

  return {
    sessionToken,
    redirectTo,
    actorId: user.id,
    tenantId: tenant?.id ?? null,
  };
}
