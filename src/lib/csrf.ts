// CSRF protection for cookie-authenticated state-changing admin requests.
//
// Two layers:
//   1. Strict Origin/Referer validation against the approved application origin.
//   2. A session-bound CSRF token (double-submit style): the token stored in
//      the D1 session must match the token the client sends back via the
//      `X-CSRF-Token` header or a `_csrf` form field.
//
// The validated SSO callback is exempt: it is server-to-server and is
// authenticated by the Workspace token exchange itself.

export interface CsrfContext {
  /** Approved origin, e.g. "https://openhouse.primeamericarealestate.com". */
  approvedOrigin: string;
}

/** True if the request's Origin or Referer matches the approved origin. */
export function isApprovedOrigin(request: Request, approvedOrigin: string): boolean {
  const origin = request.headers.get('origin');
  if (origin) {
    return origin === approvedOrigin;
  }
  // Fall back to Referer when Origin is absent (e.g. same-origin navigations).
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).origin === approvedOrigin;
    } catch {
      return false;
    }
  }
  // No Origin and no Referer: reject state-changing requests.
  return false;
}

/** Extract the CSRF token from the X-CSRF-Token header or _csrf form field. */
export async function extractCsrfToken(request: Request): Promise<string | null> {
  const header = request.headers.get('x-csrf-token');
  if (header) return header;

  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    try {
      const form = await request.clone().formData();
      const value = form.get('_csrf');
      if (typeof value === 'string' && value) return value;
    } catch {
      // ignore parse failures; fall through to null
    }
  }
  return null;
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
