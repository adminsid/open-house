import { describe, it, expect } from 'vitest';
import { isApprovedOrigin, extractCsrfToken, safeEqual } from '../lib/csrf';

const ORIGIN = 'https://openhouse.primeamericarealestate.com';
const URL = 'https://openhouse.primeamericarealestate.com/admin/events/new';

describe('isApprovedOrigin', () => {
  it('accepts an exact origin match', () => {
    const req = new Request(URL, { method: 'POST', headers: { origin: ORIGIN } });
    expect(isApprovedOrigin(req, ORIGIN)).toBe(true);
  });

  it('rejects a different origin', () => {
    const req = new Request(URL, { method: 'POST', headers: { origin: 'https://evil.example.com' } });
    expect(isApprovedOrigin(req, ORIGIN)).toBe(false);
  });

  it('rejects a scheme downgrade to http', () => {
    const req = new Request(URL, { method: 'POST', headers: { origin: 'http://openhouse.primeamericarealestate.com' } });
    expect(isApprovedOrigin(req, ORIGIN)).toBe(false);
  });

  it('rejects a port-aliased origin', () => {
    const req = new Request(URL, { method: 'POST', headers: { origin: `${ORIGIN}:8443` } });
    expect(isApprovedOrigin(req, ORIGIN)).toBe(false);
  });

  it('falls back to the Referer origin when Origin is absent', () => {
    const req = new Request(URL, { method: 'POST', headers: { referer: `${ORIGIN}/admin` } });
    expect(isApprovedOrigin(req, ORIGIN)).toBe(true);
  });

  it('rejects a cross-origin Referer', () => {
    const req = new Request(URL, { method: 'POST', headers: { referer: 'https://evil.example.com/admin' } });
    expect(isApprovedOrigin(req, ORIGIN)).toBe(false);
  });

  it('rejects a malformed Referer', () => {
    const req = new Request(URL, { method: 'POST', headers: { referer: 'not-a-url' } });
    expect(isApprovedOrigin(req, ORIGIN)).toBe(false);
  });

  it('rejects when neither Origin nor Referer is present', () => {
    const req = new Request(URL, { method: 'POST' });
    expect(isApprovedOrigin(req, ORIGIN)).toBe(false);
  });
});

describe('extractCsrfToken', () => {
  it('prefers the X-CSRF-Token header over a form field', async () => {
    const req = new Request(URL, {
      method: 'POST',
      headers: { 'x-csrf-token': 'header-token', 'content-type': 'application/x-www-form-urlencoded' },
      body: '_csrf=form-token',
    });
    expect(await extractCsrfToken(req)).toBe('header-token');
  });

  it('reads _csrf from an urlencoded form body', async () => {
    const req = new Request(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=New+Event&_csrf=form-token',
    });
    expect(await extractCsrfToken(req)).toBe('form-token');
  });

  it('reads _csrf from a multipart body (file upload forms)', async () => {
    const form = new FormData();
    form.set('_csrf', 'multipart-token');
    form.set('photo', new Blob(['x'], { type: 'image/png' }), 'a.png');
    const req = new Request(URL, { method: 'POST', body: form });
    expect(await extractCsrfToken(req)).toBe('multipart-token');
  });

  it('returns null when no token is present', async () => {
    const req = new Request(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=New+Event',
    });
    expect(await extractCsrfToken(req)).toBeNull();
  });

  it('returns null for non-form content types (JSON)', async () => {
    const req = new Request(URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(await extractCsrfToken(req)).toBeNull();
  });

  it('returns null for GET requests with no header', async () => {
    const req = new Request(URL, { method: 'GET' });
    expect(await extractCsrfToken(req)).toBeNull();
  });

  it('does not consume the body for a later reader', async () => {
    const req = new Request(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '_csrf=form-token&title=New+Event',
    });
    const token = await extractCsrfToken(req);
    expect(token).toBe('form-token');
    const form = await req.clone().formData();
    expect(form.get('title')).toBe('New Event');
  });
});

describe('safeEqual', () => {
  it('is true for identical strings', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
  });

  it('is false for same-length differing strings', () => {
    expect(safeEqual('abc123', 'abc124')).toBe(false);
  });

  it('is false for different lengths', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  it('is true for identical long hex tokens', () => {
    const a = 'a'.repeat(48);
    expect(safeEqual(a, a)).toBe(true);
    expect(safeEqual(a, 'a'.repeat(47) + 'b')).toBe(false);
  });
});
