import { Hono } from 'hono';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  BUCKET: R2Bucket;
  ADMIN_SECRET: string;
  APP_URL: string;
};

type Event = {
  id: string;
  title: string;
  property_address: string;
  agent_name: string;
  agent_email: string;
  agent_phone: string | null;
  description: string | null;
  start_time: string;
  end_time: string;
  timezone: string;
  listing_url: string | null;
  photo_key: string | null;
  status: string;
  admin_token: string;
  public_token: string;
  created_at: string;
  updated_at: string;
};

type Guest = {
  id: string;
  event_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  is_agent: number;
  how_did_you_hear: string | null;
  notes: string | null;
  signed_in_at: string;
  follow_up_status: string;
  follow_up_notes: string | null;
  follow_up_at: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID();
}

function generateToken(byteLength: number = 16): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(byteLength)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compute the live status of an event based on current time vs start/end in
 * the event's timezone.  If the stored status is 'cancelled' or 'achieved'
 * those take precedence.
 */
function getEventStatus(event: Event, now: Date): string {
  if (event.status === 'cancelled' || event.status === 'achieved') {
    return event.status;
  }

  const start = new Date(event.start_time);
  const end = new Date(event.end_time);

  if (now < start) return 'scheduled';
  if (now >= start && now <= end) return 'happening_now';
  return 'ended';
}

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    happening_now: 'bg-green-100 text-green-800',
    scheduled: 'bg-blue-100 text-blue-800',
    ended: 'bg-gray-100 text-gray-700',
    cancelled: 'bg-red-100 text-red-800',
    achieved: 'bg-purple-100 text-purple-800',
  };
  const label: Record<string, string> = {
    happening_now: 'Happening Now',
    scheduled: 'Scheduled',
    ended: 'Ended',
    cancelled: 'Cancelled',
    achieved: 'Achieved',
  };
  const cls = map[status] ?? 'bg-gray-100 text-gray-700';
  return `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}">${label[status] ?? status}</span>`;
}

function followUpBadge(status: string): string {
  const map: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    contacted: 'bg-blue-100 text-blue-800',
    interested: 'bg-green-100 text-green-800',
    not_interested: 'bg-gray-100 text-gray-600',
    closed: 'bg-purple-100 text-purple-800',
  };
  const cls = map[status] ?? 'bg-gray-100 text-gray-700';
  return `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}">${status.replace('_', ' ')}</span>`;
}

function formatDateTime(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// HTML layout helpers
// ---------------------------------------------------------------------------

function pageShell(title: string, body: string, extraHead = ''): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(title)} | Open House</title>
  <script src="https://cdn.tailwindcss.com"></script>
  ${extraHead}
  <style>
    [x-cloak]{display:none}
    .form-input{@apply block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm;}
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
  ${body}
</body>
</html>`;
}

function adminNav(extra = ''): string {
  return `<nav class="bg-white shadow-sm border-b border-gray-200">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-14">
      <a href="/admin" class="text-indigo-600 font-bold text-lg tracking-tight">🏠 Open House Admin</a>
      ${extra}
    </div>
  </nav>`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Bindings }>();

// ---------------------------------------------------------------------------
// Root redirect
// ---------------------------------------------------------------------------

app.get('/', (c) => c.redirect('/admin'));

// ---------------------------------------------------------------------------
// Photo serving
// ---------------------------------------------------------------------------

app.get('/api/photo/:key', async (c) => {
  const key = c.req.param('key');
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  return new Response(obj.body, { headers });
});

// ---------------------------------------------------------------------------
// Guest sign-in page
// ---------------------------------------------------------------------------

app.get('/e/:token', async (c) => {
  const token = c.req.param('token');
  const event = await c.env.DB.prepare(
    'SELECT * FROM events WHERE public_token = ?'
  )
    .bind(token)
    .first<Event>();

  if (!event) {
    return c.html(
      pageShell(
        'Not Found',
        `<div class="flex items-center justify-center min-h-screen">
          <div class="text-center p-8">
            <h1 class="text-2xl font-bold text-gray-800 mb-2">Event Not Found</h1>
            <p class="text-gray-500">This sign-in link is invalid or has expired.</p>
          </div>
        </div>`
      ),
      404
    );
  }

  const liveStatus = getEventStatus(event, new Date());
  const photoUrl = event.photo_key ? `/api/photo/${encodeURIComponent(event.photo_key)}` : null;

  const body = `
<div class="min-h-screen bg-gradient-to-br from-indigo-50 to-white">
  <div class="max-w-lg mx-auto px-4 py-10">
    ${photoUrl ? `<div class="mb-6 rounded-2xl overflow-hidden shadow-lg">
      <img src="${escAttr(photoUrl)}" alt="Property photo" class="w-full h-56 object-cover" />
    </div>` : ''}

    <div class="bg-white rounded-2xl shadow-lg p-6 mb-6">
      <div class="flex items-start justify-between mb-1">
        <h1 class="text-2xl font-bold text-gray-900">${escHtml(event.title)}</h1>
        ${statusBadge(liveStatus)}
      </div>
      <p class="text-gray-500 text-sm mb-3">📍 ${escHtml(event.property_address)}</p>
      <div class="text-sm text-gray-600 space-y-1">
        <p>🕐 ${formatDateTime(event.start_time, event.timezone)} – ${formatDateTime(event.end_time, event.timezone)}</p>
        <p>👤 ${escHtml(event.agent_name)} &bull; ${escHtml(event.agent_email)}${event.agent_phone ? ` &bull; ${escHtml(event.agent_phone)}` : ''}</p>
        ${event.description ? `<p class="mt-2 text-gray-500 italic">${escHtml(event.description)}</p>` : ''}
        ${event.listing_url ? `<p><a href="${escHtml(event.listing_url)}" target="_blank" class="text-indigo-600 underline">View Listing ↗</a></p>` : ''}
      </div>
    </div>

    ${liveStatus === 'cancelled' ? `<div class="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
      <p class="text-red-700 font-medium">This event has been cancelled.</p>
    </div>` : `
    <div class="bg-white rounded-2xl shadow-lg p-6">
      <h2 class="text-lg font-semibold text-gray-900 mb-4">Sign In</h2>
      <form method="POST" action="/e/${escHtml(token)}/signin" class="space-y-4">
        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">First Name <span class="text-red-500">*</span></label>
            <input type="text" name="first_name" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">Last Name <span class="text-red-500">*</span></label>
            <input type="text" name="last_name" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Email <span class="text-red-500">*</span></label>
          <input type="email" name="email" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Phone</label>
          <input type="tel" name="phone" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Current Address</label>
          <input type="text" name="address" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">Are you working with a real estate agent?</label>
          <div class="flex gap-6">
            <label class="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" name="is_agent" value="1" class="text-indigo-600" /> Yes
            </label>
            <label class="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" name="is_agent" value="0" checked class="text-indigo-600" /> No
            </label>
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">How did you hear about this property?</label>
          <select name="how_did_you_hear" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <option value="">Select one…</option>
            <option value="zillow">Zillow</option>
            <option value="realtor_com">Realtor.com</option>
            <option value="redfin">Redfin</option>
            <option value="mls">MLS</option>
            <option value="social_media">Social Media</option>
            <option value="yard_sign">Yard Sign</option>
            <option value="friend_family">Friend / Family</option>
            <option value="agent">My Agent</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">Additional Notes</label>
          <textarea name="notes" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"></textarea>
        </div>
        <button type="submit" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 rounded-lg transition-colors">
          Sign In
        </button>
      </form>
    </div>
    `}
  </div>
</div>`;

  return c.html(pageShell(event.title, body));
});

// ---------------------------------------------------------------------------
// Guest sign-in submit
// ---------------------------------------------------------------------------

app.post('/e/:token/signin', async (c) => {
  const token = c.req.param('token');
  const event = await c.env.DB.prepare(
    'SELECT * FROM events WHERE public_token = ?'
  )
    .bind(token)
    .first<Event>();

  if (!event) return c.notFound();

  const liveStatus = getEventStatus(event, new Date());
  if (liveStatus === 'cancelled') {
    return c.html(
      pageShell('Cancelled', '<div class="flex items-center justify-center min-h-screen"><p class="text-red-600 text-lg">This event has been cancelled.</p></div>'),
      400
    );
  }

  const form = await c.req.formData();
  const firstName = (form.get('first_name') as string | null)?.trim() ?? '';
  const lastName = (form.get('last_name') as string | null)?.trim() ?? '';
  const email = (form.get('email') as string | null)?.trim() ?? '';

  if (!firstName || !lastName || !email) {
    return c.html(
      pageShell('Error', `<div class="flex items-center justify-center min-h-screen">
        <div class="text-center p-8">
          <h1 class="text-xl font-bold text-red-600 mb-2">Missing required fields</h1>
          <a href="/e/${escHtml(token)}" class="text-indigo-600 underline">Go back</a>
        </div>
      </div>`),
      400
    );
  }

  const phone = (form.get('phone') as string | null)?.trim() || null;
  const address = (form.get('address') as string | null)?.trim() || null;
  const isAgent = form.get('is_agent') === '1' ? 1 : 0;
  const howDidYouHear = (form.get('how_did_you_hear') as string | null)?.trim() || null;
  const notes = (form.get('notes') as string | null)?.trim() || null;

  const guestId = generateId();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO guests (id, event_id, first_name, last_name, email, phone, address, is_agent, how_did_you_hear, notes, signed_in_at, follow_up_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  )
    .bind(guestId, event.id, firstName, lastName, email, phone, address, isAgent, howDidYouHear, notes, now)
    .run();

  return c.redirect(`/e/${token}/success`);
});

// ---------------------------------------------------------------------------
// Thank-you page
// ---------------------------------------------------------------------------

app.get('/e/:token/success', async (c) => {
  const token = c.req.param('token');
  const event = await c.env.DB.prepare(
    'SELECT title, agent_name, agent_email FROM events WHERE public_token = ?'
  )
    .bind(token)
    .first<Pick<Event, 'title' | 'agent_name' | 'agent_email'>>();

  const title = event?.title ?? 'Open House';

  const body = `
<div class="min-h-screen bg-gradient-to-br from-indigo-50 to-white flex items-center justify-center px-4">
  <div class="bg-white rounded-2xl shadow-lg p-10 max-w-md w-full text-center">
    <div class="text-6xl mb-4">🎉</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-2">You're signed in!</h1>
    <p class="text-gray-600 mb-4">Thank you for visiting <strong>${escHtml(title)}</strong>.</p>
    ${event ? `<p class="text-sm text-gray-500">Questions? Contact <a href="mailto:${escHtml(event.agent_email)}" class="text-indigo-600 underline">${escHtml(event.agent_name)}</a></p>` : ''}
  </div>
</div>`;

  return c.html(pageShell('Thank You', body));
});

// ---------------------------------------------------------------------------
// Admin: list all events
// ---------------------------------------------------------------------------

app.get('/admin', async (c) => {
  const events = await c.env.DB.prepare(
    'SELECT * FROM events ORDER BY start_time DESC'
  ).all<Event>();

  const now = new Date();

  const cards = (events.results ?? [])
    .map((ev) => {
      const liveStatus = getEventStatus(ev, now);
      return `
      <a href="/admin/events/${escHtml(ev.admin_token)}" class="block bg-white rounded-xl shadow hover:shadow-md transition-shadow p-5 border border-gray-100">
        <div class="flex items-start justify-between mb-2">
          <h3 class="font-semibold text-gray-900 text-base leading-tight">${escHtml(ev.title)}</h3>
          ${statusBadge(liveStatus)}
        </div>
        <p class="text-sm text-gray-500 mb-1">📍 ${escHtml(ev.property_address)}</p>
        <p class="text-sm text-gray-500 mb-1">👤 ${escHtml(ev.agent_name)}</p>
        <p class="text-xs text-gray-400 mt-2">🕐 ${formatDateTime(ev.start_time, ev.timezone)}</p>
      </a>`;
    })
    .join('');

  const body = `
${adminNav(`<a href="/admin/events/new" class="inline-flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">+ New Event</a>`)}
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  <div class="flex items-center justify-between mb-6">
    <h1 class="text-2xl font-bold text-gray-900">Events</h1>
    <span class="text-sm text-gray-500">${(events.results ?? []).length} event(s)</span>
  </div>
  ${
    (events.results ?? []).length === 0
      ? `<div class="text-center py-20">
          <p class="text-gray-400 text-lg mb-4">No events yet.</p>
          <a href="/admin/events/new" class="inline-flex items-center gap-1 bg-indigo-600 text-white font-medium px-5 py-2.5 rounded-lg hover:bg-indigo-700 transition-colors">Create your first event</a>
         </div>`
      : `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">${cards}</div>`
  }
</div>`;

  return c.html(pageShell('Admin Dashboard', body));
});

// ---------------------------------------------------------------------------
// Admin: new event form
// ---------------------------------------------------------------------------

app.get('/admin/events/new', (c) => {
  const body = `
${adminNav()}
<div class="max-w-2xl mx-auto px-4 py-10">
  <h1 class="text-2xl font-bold text-gray-900 mb-6">Create New Event</h1>
  <div class="bg-white rounded-2xl shadow p-6">
    <form method="POST" action="/admin/events/new" class="space-y-5">
      ${eventFormFields()}
      <div class="flex justify-end pt-2">
        <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors">
          Create Event
        </button>
      </div>
    </form>
  </div>
</div>`;
  return c.html(pageShell('New Event', body));
});

// ---------------------------------------------------------------------------
// Admin: create event
// ---------------------------------------------------------------------------

app.post('/admin/events/new', async (c) => {
  const form = await c.req.formData();

  const title = (form.get('title') as string | null)?.trim() ?? '';
  const property_address = (form.get('property_address') as string | null)?.trim() ?? '';
  const agent_name = (form.get('agent_name') as string | null)?.trim() ?? '';
  const agent_email = (form.get('agent_email') as string | null)?.trim() ?? '';
  const agent_phone = (form.get('agent_phone') as string | null)?.trim() || null;
  const description = (form.get('description') as string | null)?.trim() || null;
  const start_time = (form.get('start_time') as string | null)?.trim() ?? '';
  const end_time = (form.get('end_time') as string | null)?.trim() ?? '';
  const timezone = (form.get('timezone') as string | null)?.trim() || 'America/New_York';
  const listing_url = (form.get('listing_url') as string | null)?.trim() || null;

  if (!title || !property_address || !agent_name || !agent_email || !start_time || !end_time) {
    return c.html(
      pageShell('Error', `<div class="flex items-center justify-center min-h-screen">
        <div class="text-center p-8">
          <h1 class="text-xl font-bold text-red-600 mb-2">Missing required fields</h1>
          <a href="/admin/events/new" class="text-indigo-600 underline">Go back</a>
        </div>
      </div>`),
      400
    );
  }

  const id = generateId();
  const admin_token = generateToken(16); // 16 bytes → 32-char hex
  const public_token = generateToken(16); // 16 bytes → 32-char hex
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO events (id, title, property_address, agent_name, agent_email, agent_phone, description, start_time, end_time, timezone, listing_url, status, admin_token, public_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`
  )
    .bind(id, title, property_address, agent_name, agent_email, agent_phone, description, start_time, end_time, timezone, listing_url, admin_token, public_token, now, now)
    .run();

  return c.redirect(`/admin/events/${admin_token}`);
});

// ---------------------------------------------------------------------------
// Admin: event detail page
// ---------------------------------------------------------------------------

app.get('/admin/events/:adminToken', async (c) => {
  const adminToken = c.req.param('adminToken');
  const event = await c.env.DB.prepare(
    'SELECT * FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Event>();

  if (!event) {
    return c.html(
      pageShell('Not Found', '<div class="flex items-center justify-center min-h-screen"><p class="text-gray-500">Event not found.</p></div>'),
      404
    );
  }

  const guests = await c.env.DB.prepare(
    'SELECT * FROM guests WHERE event_id = ? ORDER BY signed_in_at ASC'
  )
    .bind(event.id)
    .all<Guest>();

  const liveStatus = getEventStatus(event, new Date());
  const appUrl = c.env.APP_URL;
  const signInUrl = `${appUrl}/e/${event.public_token}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(signInUrl)}`;
  const photoUrl = event.photo_key ? `/api/photo/${encodeURIComponent(event.photo_key)}` : null;

  const guestRows = (guests.results ?? [])
    .map((g) => `
    <tr class="hover:bg-gray-50">
      <td class="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">${escHtml(g.first_name)} ${escHtml(g.last_name)}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${g.email ? `<a href="mailto:${escHtml(g.email)}" class="text-indigo-600 hover:underline">${escHtml(g.email)}</a>` : '—'}</td>
      <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">${g.phone ? escHtml(g.phone) : '—'}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${g.address ? escHtml(g.address) : '—'}</td>
      <td class="px-4 py-3 text-sm text-center">${g.is_agent ? '✅' : '—'}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${g.how_did_you_hear ? escHtml(g.how_did_you_hear.replace(/_/g, ' ')) : '—'}</td>
      <td class="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">${formatDateTime(g.signed_in_at, event.timezone)}</td>
      <td class="px-4 py-3 text-sm">${followUpBadge(g.follow_up_status)}</td>
      <td class="px-4 py-3 text-sm text-gray-600">${g.follow_up_notes ? escHtml(g.follow_up_notes) : '—'}</td>
      <td class="px-4 py-3 text-sm">
        <button
          data-guest-id="${escAttr(g.id)}"
          data-follow-up-status="${escAttr(g.follow_up_status)}"
          data-follow-up-notes="${escAttr(g.follow_up_notes ?? '')}"
          onclick="openFollowUp(this.dataset.guestId,this.dataset.followUpStatus,this.dataset.followUpNotes)"
          class="text-indigo-600 hover:text-indigo-800 text-xs font-medium">Edit</button>
      </td>
    </tr>`)
    .join('');

  const followUpModal = `
<div id="followup-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/40">
  <div class="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4">
    <h3 class="text-lg font-semibold text-gray-900 mb-4">Update Follow-up</h3>
    <form id="followup-form" method="POST" class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Status</label>
        <select id="fu-status" name="follow_up_status" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="pending">Pending</option>
          <option value="contacted">Contacted</option>
          <option value="interested">Interested</option>
          <option value="not_interested">Not Interested</option>
          <option value="closed">Closed</option>
        </select>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Notes</label>
        <textarea id="fu-notes" name="follow_up_notes" rows="3" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"></textarea>
      </div>
      <div class="flex justify-end gap-3">
        <button type="button" onclick="closeFollowUp()" class="text-gray-600 px-4 py-2 rounded-lg border hover:bg-gray-50 text-sm">Cancel</button>
        <button type="submit" class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700">Save</button>
      </div>
    </form>
  </div>
</div>
<script>
function openFollowUp(guestId, status, notes) {
  document.getElementById('followup-form').action = '/admin/events/${escHtml(adminToken)}/guests/' + guestId + '/followup';
  document.getElementById('fu-status').value = status;
  document.getElementById('fu-notes').value = notes;
  document.getElementById('followup-modal').classList.remove('hidden');
}
function closeFollowUp() {
  document.getElementById('followup-modal').classList.add('hidden');
}
</script>`;

  const body = `
${adminNav(`<a href="/admin" class="text-sm text-gray-500 hover:text-gray-700">← All Events</a>`)}
${followUpModal}
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">

  <!-- Header -->
  <div class="flex flex-wrap items-start gap-4 justify-between">
    <div>
      <div class="flex items-center gap-3 mb-1">
        <h1 class="text-2xl font-bold text-gray-900">${escHtml(event.title)}</h1>
        ${statusBadge(liveStatus)}
      </div>
      <p class="text-gray-500">📍 ${escHtml(event.property_address)}</p>
    </div>
    <div class="flex gap-2 flex-wrap">
      ${liveStatus !== 'cancelled' && liveStatus !== 'achieved' ? `
      <form method="POST" action="/admin/events/${escHtml(adminToken)}/status" class="inline">
        <input type="hidden" name="status" value="cancelled" />
        <button type="submit" onclick="return confirm('Cancel this event?')" class="bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors">Cancel Event</button>
      </form>
      <form method="POST" action="/admin/events/${escHtml(adminToken)}/status" class="inline">
        <input type="hidden" name="status" value="achieved" />
        <button type="submit" onclick="return confirm('Mark as achieved/archived?')" class="bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors">Mark Achieved</button>
      </form>
      ` : ''}
    </div>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
    <!-- Left column: sign-in link + QR + photo -->
    <div class="space-y-6">
      <!-- Sign-in link -->
      <div class="bg-white rounded-xl shadow p-5">
        <h2 class="font-semibold text-gray-900 mb-3">Guest Sign-in Link</h2>
        <div class="flex items-center gap-2">
          <input id="signin-url" type="text" readonly value="${escHtml(signInUrl)}"
            class="flex-1 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-gray-600" />
          <button onclick="copyLink()" class="bg-indigo-600 text-white text-xs px-3 py-2 rounded-lg hover:bg-indigo-700 transition-colors whitespace-nowrap">Copy</button>
        </div>
        <script>function copyLink(){navigator.clipboard.writeText(document.getElementById('signin-url').value).then(()=>alert('Copied!'))}</script>
      </div>

      <!-- QR Code -->
      <div class="bg-white rounded-xl shadow p-5 text-center">
        <h2 class="font-semibold text-gray-900 mb-3">QR Code</h2>
        <img src="${escHtml(qrUrl)}" alt="QR Code" class="mx-auto rounded-lg border border-gray-100 w-48 h-48" />
        <a href="${escHtml(qrUrl)}" download="qr-${escHtml(event.public_token)}.png"
          class="mt-3 inline-block text-indigo-600 text-sm hover:underline">⬇ Download QR</a>
      </div>

      <!-- Photo -->
      <div class="bg-white rounded-xl shadow p-5">
        <h2 class="font-semibold text-gray-900 mb-3">Property Photo</h2>
        ${photoUrl ? `<div class="mb-3 rounded-lg overflow-hidden"><img src="${escAttr(photoUrl)}" alt="Property" class="w-full h-40 object-cover" /></div>` : '<p class="text-sm text-gray-400 mb-3">No photo uploaded yet.</p>'}
        <form method="POST" action="/admin/events/${escHtml(adminToken)}/photo" enctype="multipart/form-data" class="space-y-2">
          <input type="file" name="photo" accept="image/*" class="block w-full text-sm text-gray-600 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
          <button type="submit" class="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium py-1.5 rounded-lg transition-colors">Upload Photo</button>
        </form>
      </div>
    </div>

    <!-- Right column: edit form -->
    <div class="lg:col-span-2 space-y-6">
      <div class="bg-white rounded-xl shadow p-6">
        <h2 class="font-semibold text-gray-900 mb-4">Event Details</h2>
        <form method="POST" action="/admin/events/${escHtml(adminToken)}/update" class="space-y-4">
          ${eventFormFields(event)}
          <div class="flex justify-end pt-1">
            <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-5 py-2 rounded-lg transition-colors text-sm">Save Changes</button>
          </div>
        </form>
      </div>
    </div>
  </div>

  <!-- Guest list -->
  <div class="bg-white rounded-xl shadow">
    <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
      <h2 class="font-semibold text-gray-900">Guests <span class="text-gray-400 font-normal">(${(guests.results ?? []).length})</span></h2>
    </div>
    <div class="overflow-x-auto">
      <table class="min-w-full divide-y divide-gray-100">
        <thead>
          <tr class="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wider">
            <th class="px-4 py-3 text-left">Name</th>
            <th class="px-4 py-3 text-left">Email</th>
            <th class="px-4 py-3 text-left">Phone</th>
            <th class="px-4 py-3 text-left">Address</th>
            <th class="px-4 py-3 text-center">Agent?</th>
            <th class="px-4 py-3 text-left">How Heard</th>
            <th class="px-4 py-3 text-left">Signed In</th>
            <th class="px-4 py-3 text-left">Follow-up</th>
            <th class="px-4 py-3 text-left">Notes</th>
            <th class="px-4 py-3 text-left">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-50">
          ${guestRows || `<tr><td colspan="10" class="px-4 py-10 text-center text-gray-400 text-sm">No guests have signed in yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>
</div>`;

  return c.html(pageShell(event.title + ' – Admin', body));
});

// ---------------------------------------------------------------------------
// Admin: update event details
// ---------------------------------------------------------------------------

app.post('/admin/events/:adminToken/update', async (c) => {
  const adminToken = c.req.param('adminToken');
  const event = await c.env.DB.prepare(
    'SELECT id FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id'>>();

  if (!event) return c.notFound();

  const form = await c.req.formData();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `UPDATE events SET
      title = ?, property_address = ?, agent_name = ?, agent_email = ?, agent_phone = ?,
      description = ?, start_time = ?, end_time = ?, timezone = ?, listing_url = ?, updated_at = ?
     WHERE admin_token = ?`
  )
    .bind(
      (form.get('title') as string)?.trim(),
      (form.get('property_address') as string)?.trim(),
      (form.get('agent_name') as string)?.trim(),
      (form.get('agent_email') as string)?.trim(),
      (form.get('agent_phone') as string | null)?.trim() || null,
      (form.get('description') as string | null)?.trim() || null,
      (form.get('start_time') as string)?.trim(),
      (form.get('end_time') as string)?.trim(),
      (form.get('timezone') as string)?.trim() || 'America/New_York',
      (form.get('listing_url') as string | null)?.trim() || null,
      now,
      adminToken
    )
    .run();

  return c.redirect(`/admin/events/${adminToken}`);
});

// ---------------------------------------------------------------------------
// Admin: upload photo
// ---------------------------------------------------------------------------

app.post('/admin/events/:adminToken/photo', async (c) => {
  const adminToken = c.req.param('adminToken');
  const event = await c.env.DB.prepare(
    'SELECT id, photo_key FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id' | 'photo_key'>>();

  if (!event) return c.notFound();

  const form = await c.req.formData();
  const file = form.get('photo') as File | null;

  if (!file || file.size === 0) {
    return c.redirect(`/admin/events/${adminToken}`);
  }

  // Delete old photo if one exists (R2 delete is a no-op for missing keys)
  if (event.photo_key) {
    await c.env.BUCKET.delete(event.photo_key).catch((err: unknown) => {
      console.error('R2 delete error:', err);
    });
  }

  const ext = file.name.split('.').pop() ?? 'jpg';
  const key = `events/${event.id}/${generateId()}.${ext}`;

  await c.env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
  });

  await c.env.DB.prepare(
    'UPDATE events SET photo_key = ?, updated_at = ? WHERE admin_token = ?'
  )
    .bind(key, new Date().toISOString(), adminToken)
    .run();

  return c.redirect(`/admin/events/${adminToken}`);
});

// ---------------------------------------------------------------------------
// Admin: update guest follow-up
// ---------------------------------------------------------------------------

app.post('/admin/events/:adminToken/guests/:guestId/followup', async (c) => {
  const adminToken = c.req.param('adminToken');
  const guestId = c.req.param('guestId');

  const event = await c.env.DB.prepare(
    'SELECT id FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id'>>();

  if (!event) return c.notFound();

  const form = await c.req.formData();
  const follow_up_status = (form.get('follow_up_status') as string | null)?.trim() ?? 'pending';
  const follow_up_notes = (form.get('follow_up_notes') as string | null)?.trim() || null;

  await c.env.DB.prepare(
    'UPDATE guests SET follow_up_status = ?, follow_up_notes = ?, follow_up_at = ? WHERE id = ? AND event_id = ?'
  )
    .bind(follow_up_status, follow_up_notes, new Date().toISOString(), guestId, event.id)
    .run();

  return c.redirect(`/admin/events/${adminToken}`);
});

// ---------------------------------------------------------------------------
// Admin: manually update event status
// ---------------------------------------------------------------------------

app.post('/admin/events/:adminToken/status', async (c) => {
  const adminToken = c.req.param('adminToken');
  const form = await c.req.formData();
  const newStatus = (form.get('status') as string | null)?.trim();

  if (newStatus !== 'cancelled' && newStatus !== 'achieved') {
    return c.redirect(`/admin/events/${adminToken}`);
  }

  await c.env.DB.prepare(
    'UPDATE events SET status = ?, updated_at = ? WHERE admin_token = ?'
  )
    .bind(newStatus, new Date().toISOString(), adminToken)
    .run();

  return c.redirect(`/admin/events/${adminToken}`);
});

// ---------------------------------------------------------------------------
// Admin: QR code redirect
// ---------------------------------------------------------------------------

app.get('/admin/events/:adminToken/qr', async (c) => {
  const adminToken = c.req.param('adminToken');
  const event = await c.env.DB.prepare(
    'SELECT public_token FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'public_token'>>();

  if (!event) return c.notFound();

  const appUrl = c.env.APP_URL;
  const signInUrl = `${appUrl}/e/${event.public_token}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(signInUrl)}`;
  return c.redirect(qrUrl);
});

// ---------------------------------------------------------------------------
// Shared: event form fields helper
// ---------------------------------------------------------------------------

function eventFormFields(ev?: Event): string {
  const timezones = [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Phoenix',
    'America/Anchorage',
    'Pacific/Honolulu',
    'Europe/London',
    'Europe/Paris',
    'Asia/Tokyo',
  ];
  const tzOptions = timezones
    .map((tz) => {
      const isSelected = ev ? ev.timezone === tz : tz === 'America/New_York';
      return `<option value="${tz}" ${isSelected ? 'selected' : ''}>${tz}</option>`;
    })
    .join('');

  // Convert stored ISO times to datetime-local format for the input
  const toLocal = (iso: string | undefined) => {
    if (!iso) return '';
    // datetime-local expects YYYY-MM-DDTHH:mm
    return iso.slice(0, 16);
  };

  return `
  <div class="grid grid-cols-1 gap-4">
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">Event Title <span class="text-red-500">*</span></label>
      <input type="text" name="title" required value="${escAttr(ev?.title ?? '')}"
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
    </div>
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">Property Address <span class="text-red-500">*</span></label>
      <input type="text" name="property_address" required value="${escAttr(ev?.property_address ?? '')}"
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Agent Name <span class="text-red-500">*</span></label>
        <input type="text" name="agent_name" required value="${escAttr(ev?.agent_name ?? '')}"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Agent Email <span class="text-red-500">*</span></label>
        <input type="email" name="agent_email" required value="${escAttr(ev?.agent_email ?? '')}"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      </div>
    </div>
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">Agent Phone</label>
      <input type="tel" name="agent_phone" value="${escAttr(ev?.agent_phone ?? '')}"
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Start Time <span class="text-red-500">*</span></label>
        <input type="datetime-local" name="start_time" required value="${escAttr(toLocal(ev?.start_time))}"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">End Time <span class="text-red-500">*</span></label>
        <input type="datetime-local" name="end_time" required value="${escAttr(toLocal(ev?.end_time))}"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
        <select name="timezone" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          ${tzOptions}
        </select>
      </div>
    </div>
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">Listing URL</label>
      <input type="url" name="listing_url" value="${escAttr(ev?.listing_url ?? '')}"
        placeholder="https://..."
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
    </div>
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">Description</label>
      <textarea name="description" rows="3"
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">${escHtml(ev?.description ?? '')}</textarea>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// HTML escape helpers
// ---------------------------------------------------------------------------

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(str: string): string {
  return escHtml(str);
}

export default app;
