import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

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

type Admin = {
  id: string;
  username: string;
  password_hash: string;
  name: string;
  created_at: string;
};

type Event = {
  id: string;
  title: string;
  property_address: string;
  agent_name: string;
  agent_email: string;
  agent_phone: string | null;
  company_name: string | null;
  agent_photo_key: string | null;
  description: string | null;
  start_time: string;
  end_time: string;
  timezone: string;
  listing_url: string | null;
  photo_key: string | null;
  status: string;
  admin_token: string;
  public_token: string;
  rsvp_token: string | null;
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
  is_rsvp: number;
  checked_in: number;
  checked_in_at: string | null;
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

async function hashPassword(password: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

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
  const label = status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}">${label}</span>`;
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
  <script src="https://cdn.tailwindcss.com"><\/script>
  ${extraHead}
  <style>[x-cloak]{display:none}<\/style>
</head>
<body class="bg-gray-50 min-h-screen">
  ${body}
</body>
</html>`;
}

function guestPageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(title)}</title>
  <script src="https://cdn.tailwindcss.com"><\/script>
  <style>
    :root { --gold: #c9a84c; --navy: #0f1c2e; }
    body { background-color: var(--navy); }
    .hero-overlay {
      background: linear-gradient(to bottom,
        rgba(15,28,46,0.15) 0%,
        rgba(15,28,46,0.65) 55%,
        rgba(15,28,46,1) 100%);
    }
    .glass-card { background: rgba(255,255,255,0.98); }
    .divider {
      height: 1px;
      background: linear-gradient(to right, transparent, rgba(201,168,76,0.35), transparent);
    }
    .input-field { transition: border-color 0.2s, box-shadow 0.2s; }
    .input-field:focus {
      border-color: var(--gold) !important;
      box-shadow: 0 0 0 3px rgba(201,168,76,0.18);
      outline: none;
    }
    .btn-gold {
      background: linear-gradient(135deg, #b8922e 0%, #e8c85a 50%, #b8922e 100%);
      background-size: 200% auto;
      color: #0f1c2e;
      transition: background-position 0.4s ease, transform 0.15s ease, box-shadow 0.2s ease;
    }
    .btn-gold:hover {
      background-position: right center;
      transform: translateY(-2px);
      box-shadow: 0 10px 30px rgba(201,168,76,0.45);
    }
    .btn-gold:active { transform: translateY(0); }
    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(22px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .anim-1 { animation: fadeUp 0.55s ease-out 0.05s both; }
    .anim-2 { animation: fadeUp 0.55s ease-out 0.18s both; }
    .anim-3 { animation: fadeUp 0.55s ease-out 0.30s both; }
  <\/style>
</head>
<body>
  ${body}
</body>
</html>`;
}

function adminNav(extra = ''): string {
  return `<nav class="bg-white shadow-sm border-b border-gray-200">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-14">
      <a href="/admin" class="text-indigo-600 font-bold text-lg tracking-tight">&#127968; Open House Admin<\/a>
      ${extra}
    <\/div>
  <\/nav>`;
}

function agentNav(agentName: string, companyName: string | null, extra = ''): string {
  return `<nav class="bg-white shadow-sm border-b border-gray-200">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-14">
      <div class="flex items-center gap-3 min-w-0">
        <span class="text-indigo-600 font-bold text-base flex-shrink-0">&#127968; Open House<\/span>
        <span class="text-gray-300 flex-shrink-0">|<\/span>
        <span class="text-gray-700 text-sm truncate">${escHtml(agentName)}${companyName ? ` &middot; ${escHtml(companyName)}` : ''}<\/span>
      <\/div>
      ${extra}
    <\/div>
  <\/nav>`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Bindings }>();

// ---------------------------------------------------------------------------
// Middleware: Setup & Auth
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
  const path = c.req.path;

  // Always allow API and static-ish routes
  if (path.startsWith('/api/')) {
    return await next();
  }

  // Check if any admin exists
  const { results } = await c.env.DB.prepare('SELECT id FROM admins LIMIT 1').all();
  const adminExists = results && results.length > 0;

  if (!adminExists) {
    // If no admin, only allow /setup
    if (path !== '/setup') {
      return c.redirect('/setup');
    }
  } else {
    // If admin exists, disable /setup
    if (path === '/setup') {
      return c.redirect('/admin');
    }
  }

  await next();
});

app.get('/', (c) => c.redirect('/admin'));

// ---------------------------------------------------------------------------
// Setup Flow
// ---------------------------------------------------------------------------

app.get('/setup', async (c) => {
  const body = `
<div class="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8 bg-slate-950">
  <div class="max-w-md w-full space-y-8 bg-white p-10 rounded-2xl shadow-2xl">
    <div>
      <div class="mx-auto h-12 w-12 flex items-center justify-center rounded-full bg-indigo-100 text-indigo-600 text-2xl">
        &#127968;
      </div>
      <h2 class="mt-6 text-center text-3xl font-extrabold text-gray-900">
        Initialize Open House
      </h2>
      <p class="mt-2 text-center text-sm text-gray-600">
        Create the first administrator account to get started.
      </p>
    </div>
    <form class="mt-8 space-y-6" action="/setup" method="POST">
      <div class="rounded-md shadow-sm space-y-4">
        <div>
          <label for="name" class="block text-sm font-medium text-gray-700">Full Name</label>
          <input id="name" name="name" type="text" required class="appearance-none rounded-lg relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm" placeholder="John Doe">
        </div>
        <div>
          <label for="username" class="block text-sm font-medium text-gray-700">Username / Email</label>
          <input id="username" name="username" type="text" required class="appearance-none rounded-lg relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm" placeholder="admin@example.com">
        </div>
        <div>
          <label for="password" class="block text-sm font-medium text-gray-700">Password</label>
          <input id="password" name="password" type="password" required class="appearance-none rounded-lg relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm" placeholder="••••••••">
        </div>
      </div>

      <div>
        <button type="submit" class="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500">
          Create Admin Account
        </button>
      </div>
    </form>
  </div>
</div>`;
  return c.html(pageShell('Initial Setup', body));
});

app.post('/setup', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id FROM admins LIMIT 1').all();
  if (results && results.length > 0) {
    return c.redirect('/admin');
  }

  const form = await c.req.formData();
  const name = (form.get('name') as string)?.trim();
  const username = (form.get('username') as string)?.trim();
  const password = (form.get('password') as string);

  if (!name || !username || !password) {
    return c.text('All fields are required', 400);
  }

  const id = generateId();
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    'INSERT INTO admins (id, username, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)'
  )
    .bind(id, username, passwordHash, name, now)
    .run();

  // For now, we'll just redirect to admin. 
  // In a real app, we might set a session cookie here.
  return c.redirect('/admin');
});

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
      guestPageShell(
        'Event Not Found',
        `<div class="flex items-center justify-center min-h-screen p-8">
          <div class="text-center">
            <div class="text-6xl mb-5">&#127968;<\/div>
            <h1 class="text-2xl font-bold text-white mb-2">Event Not Found<\/h1>
            <p class="text-slate-400 text-sm">This sign-in link is invalid or has expired.<\/p>
          <\/div>
        <\/div>`
      ),
      404
    );
  }

  const liveStatus = getEventStatus(event, new Date());
  const photoUrl = event.photo_key
    ? `/api/photo/${encodeURIComponent(event.photo_key)}`
    : null;
  const agentPhotoUrl = event.agent_photo_key
    ? `/api/photo/${encodeURIComponent(event.agent_photo_key)}`
    : null;
  const initials = event.agent_name
    .split(' ')
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '??';

  const isCancelled = liveStatus === 'cancelled';

  const heroHtml = `
<div class="relative h-72 sm:h-96 w-full overflow-hidden">
  ${photoUrl
    ? `<img src="${escAttr(photoUrl)}" alt="${escAttr(event.title)}" class="w-full h-full object-cover" \/>`
    : `<div class="w-full h-full" style="background:linear-gradient(135deg,#1a3557 0%,#0f1c2e 100%)"><\/div>`}
  <div class="hero-overlay absolute inset-0"><\/div>
  <div class="absolute bottom-0 left-0 right-0 px-5 pb-5">
    <div class="max-w-lg mx-auto flex items-end gap-4">
      <div class="flex-shrink-0">
        ${agentPhotoUrl
          ? `<img src="${escAttr(agentPhotoUrl)}" alt="${escAttr(event.agent_name)}" class="w-14 h-14 rounded-full border-2 object-cover shadow-xl" style="border-color:var(--gold)" \/>`
          : `<div class="w-14 h-14 rounded-full border-2 flex items-center justify-center text-lg font-bold shadow-xl" style="border-color:var(--gold);background:rgba(201,168,76,0.25);color:var(--gold)">${escHtml(initials)}<\/div>`}
      <\/div>
      <div class="min-w-0 flex-1">
        ${event.company_name ? `<p class="text-xs font-semibold uppercase tracking-widest mb-0.5" style="color:var(--gold)">${escHtml(event.company_name)}<\/p>` : ''}
        <p class="text-white font-semibold text-sm leading-tight">${escHtml(event.agent_name)}<\/p>
        <p class="text-slate-300 text-xs mt-0.5">${escHtml(event.agent_email)}${event.agent_phone ? ` &middot; ${escHtml(event.agent_phone)}` : ''}<\/p>
      <\/div>
      <div class="flex-shrink-0">${statusBadge(liveStatus)}<\/div>
    <\/div>
  <\/div>
<\/div>`;

  const formHtml = isCancelled
    ? `<div class="glass-card rounded-2xl shadow-xl p-8 text-center anim-2">
        <div class="text-5xl mb-4">&#10060;<\/div>
        <h2 class="text-lg font-bold text-gray-900 mb-2">Event Cancelled<\/h2>
        <p class="text-gray-500 text-sm">This open house has been cancelled. Please contact the agent for more information.<\/p>
        <div class="mt-5 pt-5 border-t border-gray-100 text-sm text-gray-500">
          <a href="mailto:${escAttr(event.agent_email)}" class="font-medium" style="color:var(--gold)">${escHtml(event.agent_name)}<\/a>
          ${event.agent_phone ? ` &nbsp;&middot;&nbsp; ${escHtml(event.agent_phone)}` : ''}
        <\/div>
      <\/div>`
    : `<div class="glass-card rounded-2xl shadow-xl p-6 anim-2">
        <div class="text-center mb-5">
          <h2 class="text-xl font-bold text-gray-900">Welcome!<\/h2>
          <p class="text-gray-500 text-sm mt-1">Please sign in &mdash; we&rsquo;d love to stay in touch<\/p>
          <div class="divider mt-4"><\/div>
        <\/div>
        <form method="POST" action="/e/${escHtml(token)}/signin" class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">First Name <span class="text-red-400">*<\/span><\/label>
              <input type="text" name="first_name" required autofocus
                class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
                placeholder="Jane" \/>
            <\/div>
            <div>
              <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Last Name <span class="text-red-400">*<\/span><\/label>
              <input type="text" name="last_name" required
                class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
                placeholder="Smith" \/>
            <\/div>
          <\/div>
          <div>
            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Email Address<\/label>
            <input type="email" name="email"
              class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
              placeholder="jane@example.com" \/>
          <\/div>
          <div>
            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Phone Number <span class="text-red-400">*<\/span><\/label>
            <input type="tel" name="phone" required
              class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
              placeholder="(555) 000-0000" \/>
          <\/div>
          <div>
            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Current Address<\/label>
            <input type="text" name="address"
              class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
              placeholder="123 Main St, City, State" \/>
          <\/div>
          <div class="divider"><\/div>
          <div>
            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Working with a real estate agent?<\/label>
            <div class="flex gap-6">
              <label class="flex items-center gap-2 text-sm cursor-pointer text-gray-700 select-none">
                <input type="radio" name="is_agent" value="1" style="accent-color:var(--gold)" \/>  Yes
              <\/label>
              <label class="flex items-center gap-2 text-sm cursor-pointer text-gray-700 select-none">
                <input type="radio" name="is_agent" value="0" checked style="accent-color:var(--gold)" \/>  No
              <\/label>
            <\/div>
          <\/div>
          <div>
            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">How did you hear about this property?<\/label>
            <select name="how_did_you_hear"
              class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-700">
              <option value="">Select one&hellip;<\/option>
              <option value="zillow">Zillow<\/option>
              <option value="realtor_com">Realtor.com<\/option>
              <option value="redfin">Redfin<\/option>
              <option value="mls">MLS<\/option>
              <option value="social_media">Social Media<\/option>
              <option value="yard_sign">Yard Sign<\/option>
              <option value="friend_family">Friend \/ Family<\/option>
              <option value="agent">My Agent<\/option>
              <option value="other">Other<\/option>
            <\/select>
          <\/div>
          <div>
            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Notes \/ Questions<\/label>
            <textarea name="notes" rows="2"
              class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
              placeholder="Anything you&rsquo;d like the agent to know&hellip;"><\/textarea>
          <\/div>
          <div class="pt-1">
            <button type="submit" class="btn-gold w-full font-bold py-3.5 rounded-xl text-sm shadow-lg">
              &#10003; &nbsp;Sign In to Open House
            <\/button>
          <\/div>
        <\/form>
      <\/div>`;

  const body = `
<div style="background-color:var(--navy);min-height:100vh">
  ${heroHtml}
  <div class="max-w-lg mx-auto px-4 pb-12 -mt-3 relative">
    <div class="glass-card rounded-2xl shadow-2xl p-5 mb-4 anim-1">
      <h1 class="text-lg font-bold text-gray-900 leading-tight mb-1">${escHtml(event.title)}<\/h1>
      <p class="text-gray-500 text-sm mb-0.5">&#128205; ${escHtml(event.property_address)}<\/p>
      <p class="text-gray-500 text-sm">&#128336; ${formatDateTime(event.start_time, event.timezone)} &ndash; ${formatDateTime(event.end_time, event.timezone)}<\/p>
      ${event.description ? `<div class="divider my-3"><\/div><p class="text-gray-500 text-sm italic">${escHtml(event.description)}<\/p>` : ''}
      ${event.listing_url ? `<a href="${escHtml(event.listing_url)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-sm font-medium mt-2" style="color:var(--gold)">View Listing &#8599;<\/a>` : ''}
    <\/div>
    ${formHtml}
    <div class="text-center mt-6 text-slate-500 text-xs space-y-2">
      ${equalHousingLogo('text-slate-400')}
      <p class="text-slate-600">Powered by Open House Sign-in<\/p>
    <\/div>
  <\/div>
<\/div>`;

  return c.html(guestPageShell(event.title, body));
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
      guestPageShell(
        'Cancelled',
        `<div class="flex items-center justify-center min-h-screen p-8">
          <div class="text-center">
            <p class="text-red-400 text-lg font-medium">This event has been cancelled.<\/p>
          <\/div>
        <\/div>`
      ),
      400
    );
  }

  const form = await c.req.formData();
  const firstName = (form.get('first_name') as string | null)?.trim() ?? '';
  const lastName = (form.get('last_name') as string | null)?.trim() ?? '';
  const phone = (form.get('phone') as string | null)?.trim() ?? '';

  if (!firstName || !lastName || !phone) {
    return c.html(
      guestPageShell(
        'Error',
        `<div class="flex items-center justify-center min-h-screen p-8">
          <div class="glass-card rounded-2xl shadow-xl p-8 max-w-sm w-full text-center">
            <div class="text-4xl mb-4">&#9888;&#65039;<\/div>
            <h1 class="text-lg font-bold text-gray-900 mb-2">Missing Required Fields<\/h1>
            <p class="text-gray-500 text-sm mb-5">Please fill in your first name, last name, and phone number.<\/p>
            <a href="/e/${escHtml(token)}" class="btn-gold inline-block px-6 py-2.5 rounded-xl text-sm font-bold">Go Back<\/a>
          <\/div>
        <\/div>`
      ),
      400
    );
  }

  const email = (form.get('email') as string | null)?.trim() || null;
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
    'SELECT title, agent_name, agent_email, agent_phone, company_name, agent_photo_key, photo_key FROM events WHERE public_token = ?'
  )
    .bind(token)
    .first<Pick<Event, 'title' | 'agent_name' | 'agent_email' | 'agent_phone' | 'company_name' | 'agent_photo_key' | 'photo_key'>>();

  const title = event?.title ?? 'Open House';
  const photoUrl = event?.photo_key
    ? `/api/photo/${encodeURIComponent(event.photo_key)}`
    : null;
  const agentPhotoUrl = event?.agent_photo_key
    ? `/api/photo/${encodeURIComponent(event.agent_photo_key)}`
    : null;
  const initials = (event?.agent_name ?? '??')
    .split(' ')
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '??';

  const body = `
<div style="background-color:var(--navy);min-height:100vh">
  ${photoUrl
    ? `<div class="relative h-40 overflow-hidden">
         <img src="${escAttr(photoUrl)}" alt="${escAttr(title)}" class="w-full h-full object-cover opacity-50" \/>
         <div class="hero-overlay absolute inset-0"><\/div>
       <\/div>`
    : `<div class="h-20" style="background:linear-gradient(135deg,#1a3557 0%,#0f1c2e 100%)"><\/div>`}
  <div class="max-w-lg mx-auto px-4 pb-12 -mt-6 relative">
    <div class="glass-card rounded-2xl shadow-2xl p-8 text-center anim-1">
      <div class="text-6xl mb-4">&#127881;<\/div>
      <h1 class="text-2xl font-bold text-gray-900 mb-2">You&rsquo;re All Set!<\/h1>
      <p class="text-gray-600 mb-6">Thank you for visiting <strong>${escHtml(title)}<\/strong>.<\/p>
      <div class="divider mb-6"><\/div>
      ${event
        ? `<div class="flex items-center justify-center gap-4">
             <div class="flex-shrink-0">
               ${agentPhotoUrl
                 ? `<img src="${escAttr(agentPhotoUrl)}" alt="${escAttr(event.agent_name)}" class="w-14 h-14 rounded-full border-2 object-cover" style="border-color:var(--gold)" \/>`
                 : `<div class="w-14 h-14 rounded-full border-2 flex items-center justify-center text-lg font-bold" style="border-color:var(--gold);background:rgba(201,168,76,0.1);color:var(--gold)">${escHtml(initials)}<\/div>`}
             <\/div>
             <div class="text-left">
               ${event.company_name ? `<p class="text-xs font-semibold uppercase tracking-widest" style="color:var(--gold)">${escHtml(event.company_name)}<\/p>` : ''}
               <p class="font-semibold text-gray-900 text-sm">${escHtml(event.agent_name)}<\/p>
               <a href="mailto:${escAttr(event.agent_email)}" class="text-xs text-gray-500 hover:underline">${escHtml(event.agent_email)}<\/a>
               ${event.agent_phone ? `<p class="text-xs text-gray-500">${escHtml(event.agent_phone)}<\/p>` : ''}
             <\/div>
           <\/div>
           <p class="text-gray-400 text-xs mt-5">Your agent will be in touch soon &mdash; we look forward to helping you find your perfect home!<\/p>`
        : ''}
      <div class="mt-6 pt-5 border-t border-gray-100">
        ${equalHousingLogo('text-gray-400')}
      <\/div>
    <\/div>
  <\/div>
<\/div>`;

  return c.html(guestPageShell(`Thank You \u2013 ${title}`, body));
});

// ---------------------------------------------------------------------------
// Admin: list all events
// ---------------------------------------------------------------------------

app.get('/admin', async (c) => {
  const events = await c.env.DB.prepare(
    'SELECT * FROM events ORDER BY start_time DESC'
  ).all<Event>();

  const now = new Date();
  const filter = c.req.query('filter') ?? 'all';

  const allEvents = (events.results ?? []).map((ev) => ({
    ev,
    liveStatus: getEventStatus(ev, now),
  }));

  const filtered =
    filter === 'all'
      ? allEvents
      : allEvents.filter(({ liveStatus }) => liveStatus === filter);

  const counts: Record<string, number> = {
    all: allEvents.length,
    happening_now: allEvents.filter((e) => e.liveStatus === 'happening_now').length,
    scheduled: allEvents.filter((e) => e.liveStatus === 'scheduled').length,
    ended: allEvents.filter((e) => e.liveStatus === 'ended').length,
    cancelled: allEvents.filter((e) => e.liveStatus === 'cancelled').length,
    achieved: allEvents.filter((e) => e.liveStatus === 'achieved').length,
  };

  const tabs: { key: string; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'happening_now', label: 'Live Now' },
    { key: 'scheduled', label: 'Upcoming' },
    { key: 'ended', label: 'Past' },
    { key: 'cancelled', label: 'Cancelled' },
    { key: 'achieved', label: 'Achieved' },
  ];

  const tabBar = `<div class="flex gap-1.5 flex-wrap mb-6">
    ${tabs
      .map(({ key, label }) => {
        const count = counts[key] ?? 0;
        const active = filter === key;
        return `<a href="/admin?filter=${key}"
          class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
            active
              ? 'bg-indigo-600 text-white shadow-sm'
              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
          }">
          ${label}
          <span class="${active ? 'bg-indigo-500 text-indigo-100' : 'bg-gray-100 text-gray-500'} text-xs px-1.5 py-0.5 rounded-full">${count}<\/span>
        <\/a>`;
      })
      .join('')}
  <\/div>`;

  const cards = filtered
    .map(({ ev, liveStatus }) => {
      const photoUrl = ev.photo_key
        ? `/api/photo/${encodeURIComponent(ev.photo_key)}`
        : null;
      return `
      <div class="bg-white rounded-xl shadow hover:shadow-md transition-shadow border border-gray-100 overflow-hidden">
        ${photoUrl ? `<div class="h-36 overflow-hidden"><img src="${escAttr(photoUrl)}" alt="" class="w-full h-full object-cover" \/><\/div>` : ''}
        <div class="p-5">
          <div class="flex items-start justify-between mb-2 gap-2">
            <h3 class="font-semibold text-gray-900 text-base leading-tight">${escHtml(ev.title)}<\/h3>
            ${statusBadge(liveStatus)}
          <\/div>
          <p class="text-sm text-gray-500 mb-0.5">&#128205; ${escHtml(ev.property_address)}<\/p>
          <p class="text-sm text-gray-500 mb-1">&#128100; ${escHtml(ev.agent_name)}${ev.company_name ? ` &middot; ${escHtml(ev.company_name)}` : ''}<\/p>
          <p class="text-xs text-gray-400 mb-4">&#128336; ${formatDateTime(ev.start_time, ev.timezone)}<\/p>
          <div class="flex items-center gap-2 flex-wrap">
            <a href="/admin/events/${escHtml(ev.admin_token)}" class="inline-flex items-center gap-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">&#9998; Manage<\/a>
            <a href="/agent/${escHtml(ev.admin_token)}" class="inline-flex items-center gap-1 bg-gray-50 hover:bg-gray-100 text-gray-700 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">&#128100; Agent View<\/a>
            <form method="POST" action="/admin/events/${escHtml(ev.admin_token)}/duplicate" class="inline">
              <button type="submit" class="inline-flex items-center gap-1 bg-green-50 hover:bg-green-100 text-green-700 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">&#10064; Duplicate<\/button>
            <\/form>
            <form method="POST" action="/admin/events/${escHtml(ev.admin_token)}/delete" class="inline" onsubmit="return confirm('Delete this event and all its guests? This cannot be undone.')">
              <button type="submit" class="inline-flex items-center gap-1 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">&#128465; Delete<\/button>
            <\/form>
          <\/div>
        <\/div>
      <\/div>`;
    })
    .join('');

  const body = `
${adminNav(`<a href="/admin/events/new" class="inline-flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">+ New Event<\/a>`)}
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  <div class="flex items-center justify-between mb-5">
    <h1 class="text-2xl font-bold text-gray-900">Events<\/h1>
    <span class="text-sm text-gray-500">${filtered.length} of ${allEvents.length} event(s)<\/span>
  <\/div>
  ${tabBar}
  ${
    filtered.length === 0
      ? `<div class="text-center py-20">
          <p class="text-gray-400 text-lg mb-4">No ${filter === 'all' ? '' : filter.replace(/_/g, ' ') + ' '}events yet.<\/p>
          ${filter === 'all' ? `<a href="/admin/events/new" class="inline-flex items-center gap-1 bg-indigo-600 text-white font-medium px-5 py-2.5 rounded-lg hover:bg-indigo-700 transition-colors">Create your first event<\/a>` : ''}
         <\/div>`
      : `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">${cards}<\/div>`
  }
<\/div>`;

  return c.html(pageShell('Admin Dashboard', body));
});

// ---------------------------------------------------------------------------
// Admin: new event form
// ---------------------------------------------------------------------------

app.get('/admin/events/new', (c) => {
  const body = `
${adminNav()}
<div class="max-w-2xl mx-auto px-4 py-10">
  <h1 class="text-2xl font-bold text-gray-900 mb-6">Create New Event<\/h1>
  <div class="bg-white rounded-2xl shadow p-6">
    <form method="POST" action="/admin/events/new" class="space-y-5">
      ${eventFormFields()}
      <div class="flex justify-end pt-2">
        <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors">
          Create Event
        <\/button>
      <\/div>
    <\/form>
  <\/div>
<\/div>`;
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
  const company_name = (form.get('company_name') as string | null)?.trim() || null;
  const description = (form.get('description') as string | null)?.trim() || null;
  const start_time = (form.get('start_time') as string | null)?.trim() ?? '';
  const end_time = (form.get('end_time') as string | null)?.trim() ?? '';
  const timezone = (form.get('timezone') as string | null)?.trim() || 'America/New_York';
  const listing_url = (form.get('listing_url') as string | null)?.trim() || null;

  if (!title || !property_address || !agent_name || !agent_email || !start_time || !end_time) {
    return c.html(
      pageShell(
        'Error',
        `<div class="flex items-center justify-center min-h-screen">
          <div class="text-center p-8">
            <h1 class="text-xl font-bold text-red-600 mb-2">Missing required fields<\/h1>
            <a href="/admin/events/new" class="text-indigo-600 underline">Go back<\/a>
          <\/div>
        <\/div>`
      ),
      400
    );
  }

  const id = generateId();
  const admin_token = generateToken(16);
  const public_token = generateToken(16);
  const rsvp_token = generateToken(16);
  const now = new Date().toISOString();

  try {
    await c.env.DB.prepare(
      `INSERT INTO events (id, title, property_address, agent_name, agent_email, agent_phone, company_name, description, start_time, end_time, timezone, listing_url, status, admin_token, public_token, rsvp_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`
    )
      .bind(id, title, property_address, agent_name, agent_email, agent_phone, company_name, description, start_time, end_time, timezone, listing_url, admin_token, public_token, rsvp_token, now, now)
      .run();

    return c.redirect(`/admin/events/${admin_token}`);
  } catch (err: any) {
    console.error('Error creating event:', err);
    return c.html(
      pageShell(
        'Error',
        `<div class="max-w-2xl mx-auto px-4 py-10">
          <div class="bg-white rounded-2xl shadow p-8 text-center">
            <h1 class="text-xl font-bold text-red-600 mb-4">Database Error<\/h1>
            <p class="text-gray-600 mb-6">${escHtml(err.message || 'Unknown error')}<\/p>
            <a href="/admin/events/new" class="text-indigo-600 underline">Try again<\/a>
          </div>
        </div>`
      ),
      500
    );
  }
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
      pageShell('Not Found', '<div class="flex items-center justify-center min-h-screen"><p class="text-gray-500">Event not found.<\/p><\/div>'),
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
  const agentUrl = `${appUrl}/agent/${event.admin_token}`;
  const rsvpUrl = event.rsvp_token ? `${appUrl}/rsvp/${event.rsvp_token}` : null;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(signInUrl)}`;
  const photoUrl = event.photo_key
    ? `/api/photo/${encodeURIComponent(event.photo_key)}`
    : null;
  const agentPhotoUrl = event.agent_photo_key
    ? `/api/photo/${encodeURIComponent(event.agent_photo_key)}`
    : null;

  const guestRows = (guests.results ?? [])
    .map(
      (g) => `
    <tr class="hover:bg-gray-50">
      <td class="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">
        ${escHtml(g.first_name)} ${escHtml(g.last_name)}
        ${g.is_rsvp ? '<span class="ml-1 text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium">RSVP<\/span>' : ''}
      <\/td>
      <td class="px-4 py-3 text-sm text-gray-600">${g.email ? `<a href="mailto:${escHtml(g.email)}" class="text-indigo-600 hover:underline">${escHtml(g.email)}<\/a>` : '&mdash;'}<\/td>
      <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">${g.phone ? escHtml(g.phone) : '&mdash;'}<\/td>
      <td class="px-4 py-3 text-sm text-gray-600">${g.address ? escHtml(g.address) : '&mdash;'}<\/td>
      <td class="px-4 py-3 text-sm text-center">${g.is_agent ? '&#9989;' : '&mdash;'}<\/td>
      <td class="px-4 py-3 text-sm text-center">${g.checked_in ? '<span class="text-green-600 font-semibold">&#10003; In<\/span>' : (g.is_rsvp ? '<span class="text-gray-400">Pending<\/span>' : '&mdash;')}<\/td>
      <td class="px-4 py-3 text-sm text-gray-600">${g.how_did_you_hear ? escHtml(g.how_did_you_hear.replace(/_/g, ' ')) : '&mdash;'}<\/td>
      <td class="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">${formatDateTime(g.signed_in_at, event.timezone)}<\/td>
      <td class="px-4 py-3 text-sm">${followUpBadge(g.follow_up_status)}<\/td>
      <td class="px-4 py-3 text-sm text-gray-600">${g.follow_up_notes ? escHtml(g.follow_up_notes) : '&mdash;'}<\/td>
      <td class="px-4 py-3 text-sm">
        <button
          data-guest-id="${escAttr(g.id)}"
          data-follow-up-status="${escAttr(g.follow_up_status)}"
          data-follow-up-notes="${escAttr(g.follow_up_notes ?? '')}"
          onclick="openFollowUp(this.dataset.guestId,this.dataset.followUpStatus,this.dataset.followUpNotes)"
          class="text-indigo-600 hover:text-indigo-800 text-xs font-medium">Edit<\/button>
      <\/td>
    <\/tr>`
    )
    .join('');

  const followUpModal = `
<div id="followup-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/40">
  <div class="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4">
    <h3 class="text-lg font-semibold text-gray-900 mb-4">Update Follow-up<\/h3>
    <form id="followup-form" method="POST" class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Status<\/label>
        <select id="fu-status" name="follow_up_status" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="pending">Pending<\/option>
          <option value="contacted">Contacted<\/option>
          <option value="interested">Interested<\/option>
          <option value="not_interested">Not Interested<\/option>
          <option value="closed">Closed<\/option>
        <\/select>
      <\/div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Notes<\/label>
        <textarea id="fu-notes" name="follow_up_notes" rows="3" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"><\/textarea>
      <\/div>
      <div class="flex justify-end gap-3">
        <button type="button" onclick="closeFollowUp()" class="text-gray-600 px-4 py-2 rounded-lg border hover:bg-gray-50 text-sm">Cancel<\/button>
        <button type="submit" class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700">Save<\/button>
      <\/div>
    <\/form>
  <\/div>
<\/div>
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
<\/script>`;

  const body = `
${adminNav(`<a href="/admin" class="text-sm text-gray-500 hover:text-gray-700">&larr; All Events<\/a>`)}
${followUpModal}
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">

  <div class="flex flex-wrap items-start gap-4 justify-between">
    <div>
      <div class="flex items-center gap-3 mb-1">
        <h1 class="text-2xl font-bold text-gray-900">${escHtml(event.title)}<\/h1>
        ${statusBadge(liveStatus)}
      <\/div>
      <p class="text-gray-500">&#128205; ${escHtml(event.property_address)}<\/p>
    <\/div>
    <div class="flex gap-2 flex-wrap">
      <a href="/agent/${escHtml(adminToken)}" target="_blank"
        class="inline-flex items-center gap-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors">
        &#128100; Agent View
      <\/a>
      <form method="POST" action="/admin/events/${escHtml(adminToken)}/duplicate" class="inline">
        <button type="submit" class="bg-green-50 hover:bg-green-100 text-green-700 border border-green-200 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors">&#10064; Duplicate<\/button>
      <\/form>
      ${
        liveStatus !== 'cancelled' && liveStatus !== 'achieved'
          ? `<form method="POST" action="/admin/events/${escHtml(adminToken)}/status" class="inline">
              <input type="hidden" name="status" value="cancelled" \/>
              <button type="submit" onclick="return confirm('Cancel this event?')" class="bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors">Cancel Event<\/button>
            <\/form>
            <form method="POST" action="/admin/events/${escHtml(adminToken)}/status" class="inline">
              <input type="hidden" name="status" value="achieved" \/>
              <button type="submit" onclick="return confirm('Mark as achieved\/archived?')" class="bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors">Mark Achieved<\/button>
            <\/form>`
          : ''
      }
      <form method="POST" action="/admin/events/${escHtml(adminToken)}/delete" class="inline"
        onsubmit="return confirm('Permanently delete this event and ALL its guests? This cannot be undone.')">
        <button type="submit" class="bg-red-600 hover:bg-red-700 text-white text-sm font-medium px-3 py-1.5 rounded-lg transition-colors">&#128465; Delete<\/button>
      <\/form>
    <\/div>
  <\/div>

  <div class="grid grid-cols-1 lg:grid-cols-3 gap-8">
    <div class="space-y-6">
      <div class="bg-white rounded-xl shadow p-5">
        <h2 class="font-semibold text-gray-900 mb-3">Guest Sign-in Link<\/h2>
        <div class="flex items-center gap-2 mb-2">
          <input id="signin-url" type="text" readonly value="${escHtml(signInUrl)}"
            class="flex-1 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-gray-600" \/>
          <button onclick="copyText('signin-url')" class="bg-indigo-600 text-white text-xs px-3 py-2 rounded-lg hover:bg-indigo-700 transition-colors whitespace-nowrap">Copy<\/button>
        <\/div>
        <a href="${escHtml(signInUrl)}" target="_blank" class="text-xs text-indigo-600 hover:underline">Open guest page &#8599;<\/a>
      <\/div>

      ${rsvpUrl ? `<div class="bg-white rounded-xl shadow p-5 border-l-4 border-purple-400">
        <h2 class="font-semibold text-gray-900 mb-1">RSVP Link<\/h2>
        <p class="text-xs text-gray-500 mb-3">Share with guests to pre-register before the event.<\/p>
        <div class="flex items-center gap-2 mb-2">
          <input id="rsvp-url" type="text" readonly value="${escHtml(rsvpUrl)}"
            class="flex-1 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-gray-600" \/>
          <button onclick="copyText('rsvp-url')" class="bg-purple-600 text-white text-xs px-3 py-2 rounded-lg hover:bg-purple-700 transition-colors whitespace-nowrap">Copy<\/button>
        <\/div>
        <a href="${escHtml(rsvpUrl)}" target="_blank" class="text-xs text-purple-600 hover:underline">Preview RSVP page &#8599;<\/a>
      <\/div>` : ''}

      <div class="bg-white rounded-xl shadow p-5">
        <h2 class="font-semibold text-gray-900 mb-3">Agent Management Link<\/h2>
        <div class="flex items-center gap-2 mb-2">
          <input id="agent-url" type="text" readonly value="${escHtml(agentUrl)}"
            class="flex-1 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-gray-600" \/>
          <button onclick="copyText('agent-url')" class="bg-indigo-600 text-white text-xs px-3 py-2 rounded-lg hover:bg-indigo-700 transition-colors whitespace-nowrap">Copy<\/button>
        <\/div>
        <a href="${escHtml(agentUrl)}" target="_blank" class="text-xs text-indigo-600 hover:underline">Open agent view &#8599;<\/a>
      <\/div>

      <div class="bg-white rounded-xl shadow p-5 text-center">
        <h2 class="font-semibold text-gray-900 mb-3">QR Code<\/h2>
        <img src="${escHtml(qrUrl)}" alt="QR Code" class="mx-auto rounded-lg border border-gray-100 w-48 h-48" \/>
        <a href="${escHtml(qrUrl)}" download="qr-${escHtml(event.public_token)}.png"
          class="mt-3 inline-block text-indigo-600 text-sm hover:underline">&#11015; Download QR<\/a>
      <\/div>

      <div class="bg-white rounded-xl shadow p-5">
        <h2 class="font-semibold text-gray-900 mb-3">Property Photo<\/h2>
        ${photoUrl ? `<div class="mb-3 rounded-lg overflow-hidden"><img src="${escAttr(photoUrl)}" alt="Property" class="w-full h-40 object-cover" \/><\/div>` : '<p class="text-sm text-gray-400 mb-3">No photo uploaded yet.<\/p>'}
        <form method="POST" action="/admin/events/${escHtml(adminToken)}/photo" enctype="multipart/form-data" class="space-y-2">
          <input type="file" name="photo" accept="image\/*" class="block w-full text-sm text-gray-600 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" \/>
          <button type="submit" class="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium py-1.5 rounded-lg transition-colors">Upload Photo<\/button>
        <\/form>
      <\/div>

      <div class="bg-white rounded-xl shadow p-5">
        <h2 class="font-semibold text-gray-900 mb-3">Agent Photo \/ Headshot<\/h2>
        ${agentPhotoUrl
          ? `<div class="mb-3 flex items-center gap-3"><img src="${escAttr(agentPhotoUrl)}" alt="Agent" class="w-16 h-16 rounded-full object-cover border-2 border-indigo-100" \/><span class="text-sm text-gray-500">Current headshot<\/span><\/div>`
          : '<p class="text-sm text-gray-400 mb-3">No agent photo yet.<\/p>'}
        <form method="POST" action="/admin/events/${escHtml(adminToken)}/agent-photo" enctype="multipart/form-data" class="space-y-2">
          <input type="file" name="photo" accept="image\/*" class="block w-full text-sm text-gray-600 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" \/>
          <button type="submit" class="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium py-1.5 rounded-lg transition-colors">Upload Agent Photo<\/button>
        <\/form>
      <\/div>
    <\/div>

    <div class="lg:col-span-2 space-y-6">
      <div class="bg-white rounded-xl shadow p-6">
        <h2 class="font-semibold text-gray-900 mb-4">Event Details<\/h2>
        <form method="POST" action="/admin/events/${escHtml(adminToken)}/update" class="space-y-4">
          ${eventFormFields(event)}
          <div class="flex justify-end pt-1">
            <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white font-semibold px-5 py-2 rounded-lg transition-colors text-sm">Save Changes<\/button>
          <\/div>
        <\/form>
      <\/div>

      <div class="bg-white rounded-xl shadow p-6">
        <h2 class="font-semibold text-gray-900 mb-4">Manually Add Guest \/ RSVP<\/h2>
        <form method="POST" action="/admin/events/${escHtml(adminToken)}/guests/add" class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">First Name <span class="text-red-500">*<\/span><\/label>
              <input type="text" name="first_name" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
            <\/div>
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">Last Name <span class="text-red-500">*<\/span><\/label>
              <input type="text" name="last_name" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
            <\/div>
          <\/div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">Email<\/label>
              <input type="email" name="email" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
            <\/div>
            <div>
              <label class="block text-xs font-medium text-gray-600 mb-1">Phone<\/label>
              <input type="tel" name="phone" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
            <\/div>
          <\/div>
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Type<\/label>
            <select name="is_rsvp" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
              <option value="1">RSVP (pre-registered)<\/option>
              <option value="0">Walk-in<\/option>
            <\/select>
          <\/div>
          <div>
            <label class="block text-xs font-medium text-gray-600 mb-1">Notes<\/label>
            <input type="text" name="notes" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Optional notes&hellip;" \/>
          <\/div>
          <div class="flex justify-end">
            <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold px-5 py-2 rounded-lg transition-colors">Add Guest<\/button>
          <\/div>
        <\/form>
      <\/div>
    <\/div>
  <\/div>

  <div class="bg-white rounded-xl shadow">
    <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
      <h2 class="font-semibold text-gray-900">Guests <span class="text-gray-400 font-normal">(${(guests.results ?? []).length})<\/span><\/h2>
      <a href="/admin/events/${escHtml(adminToken)}/export.csv"
        class="inline-flex items-center gap-1 bg-green-50 hover:bg-green-100 text-green-700 border border-green-200 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors">
        &#11015; Export CSV
      <\/a>
    <\/div>
    <div class="overflow-x-auto">
      <table class="min-w-full divide-y divide-gray-100">
        <thead>
          <tr class="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wider">
            <th class="px-4 py-3 text-left">Name<\/th>
            <th class="px-4 py-3 text-left">Email<\/th>
            <th class="px-4 py-3 text-left">Phone<\/th>
            <th class="px-4 py-3 text-left">Address<\/th>
            <th class="px-4 py-3 text-center">Agent?<\/th>
            <th class="px-4 py-3 text-center">Check-in<\/th>
            <th class="px-4 py-3 text-left">How Heard<\/th>
            <th class="px-4 py-3 text-left">Signed In<\/th>
            <th class="px-4 py-3 text-left">Follow-up<\/th>
            <th class="px-4 py-3 text-left">Notes<\/th>
            <th class="px-4 py-3 text-left">Actions<\/th>
          <\/tr>
        <\/thead>
        <tbody class="divide-y divide-gray-50">
          ${guestRows || `<tr><td colspan="11" class="px-4 py-10 text-center text-gray-400 text-sm">No guests have signed in yet.<\/td><\/tr>`}
        <\/tbody>
      <\/table>
    <\/div>
  <\/div>
<\/div>
<script>
function copyText(id) {
  navigator.clipboard.writeText(document.getElementById(id).value).then(() => alert('Copied!'));
}
<\/script>`;

  return c.html(pageShell(event.title + ' \u2013 Admin', body));
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
      company_name = ?, description = ?, start_time = ?, end_time = ?, timezone = ?,
      listing_url = ?, updated_at = ?
     WHERE admin_token = ?`
  )
    .bind(
      (form.get('title') as string)?.trim(),
      (form.get('property_address') as string)?.trim(),
      (form.get('agent_name') as string)?.trim(),
      (form.get('agent_email') as string)?.trim(),
      (form.get('agent_phone') as string | null)?.trim() || null,
      (form.get('company_name') as string | null)?.trim() || null,
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
// Admin: upload property photo
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
// Admin: upload agent photo
// ---------------------------------------------------------------------------

app.post('/admin/events/:adminToken/agent-photo', async (c) => {
  const adminToken = c.req.param('adminToken');
  const event = await c.env.DB.prepare(
    'SELECT id, agent_photo_key FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id' | 'agent_photo_key'>>();

  if (!event) return c.notFound();

  const form = await c.req.formData();
  const file = form.get('photo') as File | null;

  if (!file || file.size === 0) {
    return c.redirect(`/admin/events/${adminToken}`);
  }

  if (event.agent_photo_key) {
    await c.env.BUCKET.delete(event.agent_photo_key).catch((err: unknown) => {
      console.error('R2 delete error:', err);
    });
  }

  const ext = file.name.split('.').pop() ?? 'jpg';
  const key = `agents/${event.id}/${generateId()}.${ext}`;

  await c.env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
  });

  await c.env.DB.prepare(
    'UPDATE events SET agent_photo_key = ?, updated_at = ? WHERE admin_token = ?'
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
// Admin: delete event
// ---------------------------------------------------------------------------

app.post('/admin/events/:adminToken/delete', async (c) => {
  const adminToken = c.req.param('adminToken');
  const event = await c.env.DB.prepare(
    'SELECT id, photo_key, agent_photo_key FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id' | 'photo_key' | 'agent_photo_key'>>();

  if (!event) return c.notFound();

  if (event.photo_key) {
    await c.env.BUCKET.delete(event.photo_key).catch(() => {});
  }
  if (event.agent_photo_key) {
    await c.env.BUCKET.delete(event.agent_photo_key).catch(() => {});
  }

  await c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(event.id).run();

  return c.redirect('/admin');
});

// ---------------------------------------------------------------------------
// Admin: duplicate event
// ---------------------------------------------------------------------------

app.post('/admin/events/:adminToken/duplicate', async (c) => {
  const adminToken = c.req.param('adminToken');
  const source = await c.env.DB.prepare(
    'SELECT * FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Event>();

  if (!source) return c.notFound();

  const newId = generateId();
  const newAdminToken = generateToken(16);
  const newPublicToken = generateToken(16);
  const newRsvpToken = generateToken(16);
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO events (id, title, property_address, agent_name, agent_email, agent_phone, company_name,
       description, start_time, end_time, timezone, listing_url, photo_key, agent_photo_key,
       status, admin_token, public_token, rsvp_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`
  )
    .bind(
      newId,
      // Strip existing "(Copy)" suffix to avoid "Event (Copy) (Copy) (Copy)..." stacking
      `${source.title.replace(/\s*\(Copy\)\s*$/, '').trim()} (Copy)`,
      source.property_address,
      source.agent_name,
      source.agent_email,
      source.agent_phone,
      source.company_name,
      source.description,
      source.start_time,
      source.end_time,
      source.timezone,
      source.listing_url,
      // Do not copy R2 photo keys — deleted originals would break the duplicate's images
      null,
      null,
      newAdminToken,
      newPublicToken,
      newRsvpToken,
      now,
      now
    )
    .run();

  return c.redirect(`/admin/events/${newAdminToken}`);
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
// Agent view  (GET /agent/:adminToken)
// ---------------------------------------------------------------------------

app.get('/agent/:adminToken', async (c) => {
  const adminToken = c.req.param('adminToken');
  const event = await c.env.DB.prepare(
    'SELECT * FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Event>();

  if (!event) {
    return c.html(
      pageShell('Not Found', '<div class="flex items-center justify-center min-h-screen"><p class="text-gray-500">Event not found.<\/p><\/div>'),
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
  const rsvpUrl = event.rsvp_token ? `${appUrl}/rsvp/${event.rsvp_token}` : null;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(signInUrl)}`;
  const photoUrl = event.photo_key
    ? `/api/photo/${encodeURIComponent(event.photo_key)}`
    : null;
  const agentPhotoUrl = event.agent_photo_key
    ? `/api/photo/${encodeURIComponent(event.agent_photo_key)}`
    : null;
  const initials = event.agent_name
    .split(' ')
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '??';

  const guestCount = (guests.results ?? []).length;
  const rsvpCount = (guests.results ?? []).filter((g) => g.is_rsvp).length;
  const checkedInCount = (guests.results ?? []).filter((g) => g.checked_in).length;
  const pendingCount = (guests.results ?? []).filter((g) => g.follow_up_status === 'pending').length;

  const guestRows = (guests.results ?? [])
    .map(
      (g) => `
    <tr class="hover:bg-gray-50">
      <td class="px-4 py-3">
        <div class="text-sm font-medium text-gray-900">${escHtml(g.first_name)} ${escHtml(g.last_name)}<\/div>
        ${g.is_rsvp ? '<span class="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded font-medium">RSVP<\/span>' : ''}
        ${g.is_agent ? '<div class="text-xs text-amber-600 font-medium">With Agent<\/div>' : ''}
      <\/td>
      <td class="px-4 py-3 text-sm text-gray-600">
        ${g.email ? `<a href="mailto:${escHtml(g.email)}" class="text-indigo-600 hover:underline">${escHtml(g.email)}<\/a>` : '&mdash;'}
      <\/td>
      <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
        ${g.phone ? `<a href="tel:${escHtml(g.phone)}" class="hover:text-indigo-600">${escHtml(g.phone)}<\/a>` : '&mdash;'}
      <\/td>
      <td class="px-4 py-3 text-sm text-center">
        ${g.checked_in
          ? `<span class="text-green-600 font-semibold text-xs">&#10003; Checked In<\/span>`
          : g.is_rsvp
            ? `<form method="POST" action="/agent/${escHtml(adminToken)}/guests/${escAttr(g.id)}/checkin" class="inline">
                <button type="submit" class="bg-green-50 hover:bg-green-100 text-green-700 text-xs font-medium px-2 py-1 rounded-lg border border-green-200 transition-colors">Check In<\/button>
               <\/form>`
            : '&mdash;'}
      <\/td>
      <td class="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">${formatDateTime(g.signed_in_at, event.timezone)}<\/td>
      <td class="px-4 py-3 text-sm">${followUpBadge(g.follow_up_status)}<\/td>
      <td class="px-4 py-3 text-sm text-gray-500">${g.follow_up_notes ? escHtml(g.follow_up_notes) : '&mdash;'}<\/td>
      <td class="px-4 py-3 text-sm">
        <button
          data-guest-id="${escAttr(g.id)}"
          data-follow-up-status="${escAttr(g.follow_up_status)}"
          data-follow-up-notes="${escAttr(g.follow_up_notes ?? '')}"
          onclick="openFollowUp(this.dataset.guestId,this.dataset.followUpStatus,this.dataset.followUpNotes)"
          class="text-indigo-600 hover:text-indigo-800 text-xs font-medium">Update<\/button>
      <\/td>
    <\/tr>`
    )
    .join('');

  const followUpModal = `
<div id="followup-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/40">
  <div class="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4">
    <h3 class="text-lg font-semibold text-gray-900 mb-4">Update Follow-up<\/h3>
    <form id="followup-form" method="POST" class="space-y-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Status<\/label>
        <select id="fu-status" name="follow_up_status" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="pending">Pending<\/option>
          <option value="contacted">Contacted<\/option>
          <option value="interested">Interested<\/option>
          <option value="not_interested">Not Interested<\/option>
          <option value="closed">Closed<\/option>
        <\/select>
      <\/div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Notes<\/label>
        <textarea id="fu-notes" name="follow_up_notes" rows="3" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="Add follow-up notes&hellip;"><\/textarea>
      <\/div>
      <div class="flex justify-end gap-3">
        <button type="button" onclick="closeFollowUp()" class="text-gray-600 px-4 py-2 rounded-lg border hover:bg-gray-50 text-sm">Cancel<\/button>
        <button type="submit" class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700">Save<\/button>
      <\/div>
    <\/form>
  <\/div>
<\/div>

<div id="add-guest-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/40">
  <div class="bg-white rounded-2xl shadow-xl p-6 w-full max-w-lg mx-4">
    <h3 class="text-lg font-semibold text-gray-900 mb-4">Add Guest<\/h3>
    <form method="POST" action="/agent/${escHtml(adminToken)}/guests/add" class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">First Name <span class="text-red-500">*<\/span><\/label>
          <input type="text" name="first_name" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
        <\/div>
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Last Name <span class="text-red-500">*<\/span><\/label>
          <input type="text" name="last_name" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
        <\/div>
      <\/div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Email<\/label>
          <input type="email" name="email" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
        <\/div>
        <div>
          <label class="block text-xs font-medium text-gray-600 mb-1">Phone<\/label>
          <input type="tel" name="phone" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
        <\/div>
      <\/div>
      <div>
        <label class="block text-xs font-medium text-gray-600 mb-1">Type<\/label>
        <select name="is_rsvp" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="1">RSVP (pre-registered)<\/option>
          <option value="0">Walk-in<\/option>
        <\/select>
      <\/div>
      <div>
        <label class="block text-xs font-medium text-gray-600 mb-1">Notes<\/label>
        <input type="text" name="notes" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Optional notes&hellip;" \/>
      <\/div>
      <div class="flex justify-end gap-3 pt-1">
        <button type="button" onclick="closeAddGuest()" class="text-gray-600 px-4 py-2 rounded-lg border hover:bg-gray-50 text-sm">Cancel<\/button>
        <button type="submit" class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700">Add Guest<\/button>
      <\/div>
    <\/form>
  <\/div>
<\/div>

<script>
function openFollowUp(guestId, status, notes) {
  document.getElementById('followup-form').action = '/agent/${escHtml(adminToken)}/guests/' + guestId + '/followup';
  document.getElementById('fu-status').value = status;
  document.getElementById('fu-notes').value = notes;
  document.getElementById('followup-modal').classList.remove('hidden');
}
function closeFollowUp() {
  document.getElementById('followup-modal').classList.add('hidden');
}
function openAddGuest() {
  document.getElementById('add-guest-modal').classList.remove('hidden');
}
function closeAddGuest() {
  document.getElementById('add-guest-modal').classList.add('hidden');
}
<\/script>`;

  const body = `
${agentNav(event.agent_name, event.company_name)}
${followUpModal}
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">

  <div class="bg-white rounded-2xl shadow overflow-hidden">
    ${photoUrl
      ? `<div class="h-40 overflow-hidden relative"><img src="${escAttr(photoUrl)}" alt="${escAttr(event.title)}" class="w-full h-full object-cover" \/><div class="absolute inset-0 bg-gradient-to-t from-black\/50 to-transparent"><\/div><\/div>`
      : ''}
    <div class="p-6 flex flex-wrap items-start gap-6">
      <div class="flex-shrink-0">
        ${agentPhotoUrl
          ? `<img src="${escAttr(agentPhotoUrl)}" alt="${escAttr(event.agent_name)}" class="w-16 h-16 rounded-full border-2 border-indigo-100 object-cover" \/>`
          : `<div class="w-16 h-16 rounded-full bg-indigo-100 flex items-center justify-center text-xl font-bold text-indigo-600">${escHtml(initials)}<\/div>`}
      <\/div>
      <div class="flex-1 min-w-0">
        <div class="flex items-start gap-3 mb-1">
          <h1 class="text-xl font-bold text-gray-900">${escHtml(event.title)}<\/h1>
          ${statusBadge(liveStatus)}
        <\/div>
        <p class="text-gray-500 text-sm mb-0.5">&#128205; ${escHtml(event.property_address)}<\/p>
        <p class="text-gray-500 text-sm">&#128336; ${formatDateTime(event.start_time, event.timezone)} &ndash; ${formatDateTime(event.end_time, event.timezone)}<\/p>
      <\/div>
    <\/div>
  <\/div>

  <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
    <div class="bg-white rounded-xl shadow p-5 text-center">
      <p class="text-3xl font-bold text-gray-900">${guestCount}<\/p>
      <p class="text-sm text-gray-500 mt-1">Total Guests<\/p>
    <\/div>
    <div class="bg-white rounded-xl shadow p-5 text-center">
      <p class="text-3xl font-bold text-purple-600">${rsvpCount}<\/p>
      <p class="text-sm text-gray-500 mt-1">RSVPs<\/p>
    <\/div>
    <div class="bg-white rounded-xl shadow p-5 text-center">
      <p class="text-3xl font-bold text-green-600">${checkedInCount}<\/p>
      <p class="text-sm text-gray-500 mt-1">Checked In<\/p>
    <\/div>
    <div class="bg-white rounded-xl shadow p-5 text-center">
      <p class="text-3xl font-bold text-yellow-600">${pendingCount}<\/p>
      <p class="text-sm text-gray-500 mt-1">Need Follow-up<\/p>
    <\/div>
  <\/div>

  <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
    <div class="bg-white rounded-xl shadow p-5">
      <h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Guest Sign-in Link<\/h2>
      <div class="flex items-center gap-2 mb-2">
        <input id="signin-url" type="text" readonly value="${escHtml(signInUrl)}"
          class="flex-1 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-gray-600" \/>
        <button onclick="copyText('signin-url')" class="bg-indigo-600 text-white text-xs px-3 py-2 rounded-lg hover:bg-indigo-700 whitespace-nowrap">Copy<\/button>
      <\/div>
      <a href="${escHtml(signInUrl)}" target="_blank" class="text-xs text-indigo-600 hover:underline">Preview guest page &#8599;<\/a>
    <\/div>
    ${rsvpUrl ? `<div class="bg-white rounded-xl shadow p-5 border-l-4 border-purple-400">
      <h2 class="text-xs font-semibold text-purple-600 uppercase tracking-wide mb-1">RSVP Link<\/h2>
      <p class="text-xs text-gray-400 mb-2">Share to let guests pre-register<\/p>
      <div class="flex items-center gap-2 mb-2">
        <input id="rsvp-url" type="text" readonly value="${escHtml(rsvpUrl)}"
          class="flex-1 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-gray-600" \/>
        <button onclick="copyText('rsvp-url')" class="bg-purple-600 text-white text-xs px-3 py-2 rounded-lg hover:bg-purple-700 whitespace-nowrap">Copy<\/button>
      <\/div>
      <a href="${escHtml(rsvpUrl)}" target="_blank" class="text-xs text-purple-600 hover:underline">Preview RSVP page &#8599;<\/a>
    <\/div>` : '<div class="bg-white rounded-xl shadow p-5"><p class="text-xs text-gray-400">No RSVP link available.<\/p><\/div>'}
    <div class="bg-white rounded-xl shadow p-5 text-center">
      <h2 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">QR Code<\/h2>
      <img src="${escHtml(qrUrl)}" alt="QR" class="mx-auto rounded border border-gray-100 w-28 h-28" \/>
      <a href="${escHtml(qrUrl)}" download="qr.png" class="text-xs text-indigo-600 hover:underline mt-1 inline-block">&#11015; Download<\/a>
    <\/div>
  <\/div>

  <div class="bg-white rounded-xl shadow">
    <div class="px-6 py-4 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
      <h2 class="font-semibold text-gray-900">Guests <span class="text-gray-400 font-normal">(${guestCount})<\/span><\/h2>
      <div class="flex gap-2">
        <button onclick="openAddGuest()" class="inline-flex items-center gap-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors">+ Add Guest<\/button>
        <a href="/agent/${escHtml(adminToken)}/export.csv"
          class="inline-flex items-center gap-1 bg-green-50 hover:bg-green-100 text-green-700 border border-green-200 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors">
          &#11015; Export CSV
        <\/a>
      <\/div>
    <\/div>
    <div class="overflow-x-auto">
      <table class="min-w-full divide-y divide-gray-100">
        <thead>
          <tr class="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wider">
            <th class="px-4 py-3 text-left">Name<\/th>
            <th class="px-4 py-3 text-left">Email<\/th>
            <th class="px-4 py-3 text-left">Phone<\/th>
            <th class="px-4 py-3 text-center">Check-in<\/th>
            <th class="px-4 py-3 text-left">Signed In<\/th>
            <th class="px-4 py-3 text-left">Follow-up<\/th>
            <th class="px-4 py-3 text-left">Notes<\/th>
            <th class="px-4 py-3 text-left">Actions<\/th>
          <\/tr>
        <\/thead>
        <tbody class="divide-y divide-gray-50">
          ${guestRows || `<tr><td colspan="8" class="px-4 py-10 text-center text-gray-400 text-sm">No guests have signed in yet.<\/td><\/tr>`}
        <\/tbody>
      <\/table>
    <\/div>
  <\/div>
<\/div>
<script>
function copyText(id) {
  navigator.clipboard.writeText(document.getElementById(id).value).then(() => alert('Copied!'));
}
<\/script>`;

  return c.html(pageShell(`${event.title} \u2013 Agent`, body));
});

// ---------------------------------------------------------------------------
// Agent: update guest follow-up
// ---------------------------------------------------------------------------

app.post('/agent/:adminToken/guests/:guestId/followup', async (c) => {
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

  return c.redirect(`/agent/${adminToken}`);
});

// ---------------------------------------------------------------------------
// Agent: check in a guest
// ---------------------------------------------------------------------------

app.post('/agent/:adminToken/guests/:guestId/checkin', async (c) => {
  const adminToken = c.req.param('adminToken');
  const guestId = c.req.param('guestId');

  const event = await c.env.DB.prepare(
    'SELECT id FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id'>>();

  if (!event) return c.notFound();

  await c.env.DB.prepare(
    'UPDATE guests SET checked_in = 1, checked_in_at = ? WHERE id = ? AND event_id = ?'
  )
    .bind(new Date().toISOString(), guestId, event.id)
    .run();

  return c.redirect(`/agent/${adminToken}`);
});

// ---------------------------------------------------------------------------
// Agent: manually add a guest
// ---------------------------------------------------------------------------

app.post('/agent/:adminToken/guests/add', async (c) => {
  const adminToken = c.req.param('adminToken');

  const event = await c.env.DB.prepare(
    'SELECT id FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id'>>();

  if (!event) return c.notFound();

  const form = await c.req.formData();
  const firstName = (form.get('first_name') as string | null)?.trim() ?? '';
  const lastName = (form.get('last_name') as string | null)?.trim() ?? '';

  if (!firstName || !lastName) return c.redirect(`/agent/${adminToken}`);

  const email = (form.get('email') as string | null)?.trim() || null;
  const phone = (form.get('phone') as string | null)?.trim() || null;
  const notes = (form.get('notes') as string | null)?.trim() || null;
  const isRsvp = form.get('is_rsvp') === '1' ? 1 : 0;
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO guests (id, event_id, first_name, last_name, email, phone, is_rsvp, notes, signed_in_at, follow_up_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  )
    .bind(generateId(), event.id, firstName, lastName, email, phone, isRsvp, notes, now)
    .run();

  return c.redirect(`/agent/${adminToken}`);
});

// ---------------------------------------------------------------------------
// Agent: export guests as CSV
// ---------------------------------------------------------------------------

app.get('/agent/:adminToken/export.csv', async (c) => {
  const adminToken = c.req.param('adminToken');

  const event = await c.env.DB.prepare(
    'SELECT id, title, timezone FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id' | 'title' | 'timezone'>>();

  if (!event) return c.notFound();

  const guests = await c.env.DB.prepare(
    'SELECT * FROM guests WHERE event_id = ? ORDER BY signed_in_at ASC'
  )
    .bind(event.id)
    .all<Guest>();

  const csv = buildGuestsCsv(guests.results ?? [], event.timezone);
  const filename = `guests-${event.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.csv`;

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
});

// ---------------------------------------------------------------------------
// Admin: manually add a guest
// ---------------------------------------------------------------------------

app.post('/admin/events/:adminToken/guests/add', async (c) => {
  const adminToken = c.req.param('adminToken');

  const event = await c.env.DB.prepare(
    'SELECT id FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id'>>();

  if (!event) return c.notFound();

  const form = await c.req.formData();
  const firstName = (form.get('first_name') as string | null)?.trim() ?? '';
  const lastName = (form.get('last_name') as string | null)?.trim() ?? '';

  if (!firstName || !lastName) return c.redirect(`/admin/events/${adminToken}`);

  const email = (form.get('email') as string | null)?.trim() || null;
  const phone = (form.get('phone') as string | null)?.trim() || null;
  const notes = (form.get('notes') as string | null)?.trim() || null;
  const isRsvp = form.get('is_rsvp') === '1' ? 1 : 0;
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO guests (id, event_id, first_name, last_name, email, phone, is_rsvp, notes, signed_in_at, follow_up_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  )
    .bind(generateId(), event.id, firstName, lastName, email, phone, isRsvp, notes, now)
    .run();

  return c.redirect(`/admin/events/${adminToken}`);
});

// ---------------------------------------------------------------------------
// Admin: export guests as CSV
// ---------------------------------------------------------------------------

app.get('/admin/events/:adminToken/export.csv', async (c) => {
  const adminToken = c.req.param('adminToken');

  const event = await c.env.DB.prepare(
    'SELECT id, title, timezone FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id' | 'title' | 'timezone'>>();

  if (!event) return c.notFound();

  const guests = await c.env.DB.prepare(
    'SELECT * FROM guests WHERE event_id = ? ORDER BY signed_in_at ASC'
  )
    .bind(event.id)
    .all<Guest>();

  const csv = buildGuestsCsv(guests.results ?? [], event.timezone);
  const filename = `guests-${event.title.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.csv`;

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
});

// ---------------------------------------------------------------------------
// RSVP page (guest pre-registration)
// ---------------------------------------------------------------------------

app.get('/rsvp/:rsvpToken', async (c) => {
  const rsvpToken = c.req.param('rsvpToken');
  const event = await c.env.DB.prepare(
    'SELECT * FROM events WHERE rsvp_token = ?'
  )
    .bind(rsvpToken)
    .first<Event>();

  if (!event) {
    return c.html(
      guestPageShell(
        'Event Not Found',
        `<div class="flex items-center justify-center min-h-screen p-8">
          <div class="text-center">
            <div class="text-6xl mb-5">&#127968;<\/div>
            <h1 class="text-2xl font-bold text-white mb-2">Event Not Found<\/h1>
            <p class="text-slate-400 text-sm">This RSVP link is invalid or has expired.<\/p>
          <\/div>
        <\/div>`
      ),
      404
    );
  }

  const liveStatus = getEventStatus(event, new Date());
  const isCancelled = liveStatus === 'cancelled';
  const isEnded = liveStatus === 'ended';

  const photoUrl = event.photo_key
    ? `/api/photo/${encodeURIComponent(event.photo_key)}`
    : null;
  const agentPhotoUrl = event.agent_photo_key
    ? `/api/photo/${encodeURIComponent(event.agent_photo_key)}`
    : null;
  const initials = event.agent_name
    .split(' ')
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '??';

  const heroHtml = `
<div class="relative h-72 sm:h-96 w-full overflow-hidden">
  ${photoUrl
    ? `<img src="${escAttr(photoUrl)}" alt="${escAttr(event.title)}" class="w-full h-full object-cover" \/>`
    : `<div class="w-full h-full" style="background:linear-gradient(135deg,#1a3557 0%,#0f1c2e 100%)"><\/div>`}
  <div class="hero-overlay absolute inset-0"><\/div>
  <div class="absolute bottom-0 left-0 right-0 px-5 pb-5">
    <div class="max-w-lg mx-auto flex items-end gap-4">
      <div class="flex-shrink-0">
        ${agentPhotoUrl
          ? `<img src="${escAttr(agentPhotoUrl)}" alt="${escAttr(event.agent_name)}" class="w-14 h-14 rounded-full border-2 object-cover shadow-xl" style="border-color:var(--gold)" \/>`
          : `<div class="w-14 h-14 rounded-full border-2 flex items-center justify-center text-lg font-bold shadow-xl" style="border-color:var(--gold);background:rgba(201,168,76,0.25);color:var(--gold)">${escHtml(initials)}<\/div>`}
      <\/div>
      <div class="min-w-0 flex-1">
        ${event.company_name ? `<p class="text-xs font-semibold uppercase tracking-widest mb-0.5" style="color:var(--gold)">${escHtml(event.company_name)}<\/p>` : ''}
        <p class="text-white font-semibold text-sm leading-tight">${escHtml(event.agent_name)}<\/p>
        <p class="text-slate-300 text-xs mt-0.5">${escHtml(event.agent_email)}${event.agent_phone ? ` &middot; ${escHtml(event.agent_phone)}` : ''}<\/p>
      <\/div>
      <div class="flex-shrink-0">${statusBadge(liveStatus)}<\/div>
    <\/div>
  <\/div>
<\/div>`;

  const formHtml = isCancelled
    ? `<div class="glass-card rounded-2xl shadow-xl p-8 text-center anim-2">
        <div class="text-5xl mb-4">&#10060;<\/div>
        <h2 class="text-lg font-bold text-gray-900 mb-2">Event Cancelled<\/h2>
        <p class="text-gray-500 text-sm">This open house has been cancelled. Please contact the agent for more information.<\/p>
        <div class="mt-5 pt-5 border-t border-gray-100 text-sm text-gray-500">
          <a href="mailto:${escAttr(event.agent_email)}" class="font-medium" style="color:var(--gold)">${escHtml(event.agent_name)}<\/a>
          ${event.agent_phone ? ` &nbsp;&middot;&nbsp; ${escHtml(event.agent_phone)}` : ''}
        <\/div>
      <\/div>`
    : isEnded
    ? `<div class="glass-card rounded-2xl shadow-xl p-8 text-center anim-2">
        <div class="text-5xl mb-4">&#9203;<\/div>
        <h2 class="text-lg font-bold text-gray-900 mb-2">Event Has Ended<\/h2>
        <p class="text-gray-500 text-sm">RSVPs are no longer being accepted for this event.<\/p>
      <\/div>`
    : `<div class="glass-card rounded-2xl shadow-xl p-6 anim-2">
        <div class="text-center mb-5">
          <h2 class="text-xl font-bold text-gray-900">RSVP to This Open House<\/h2>
          <p class="text-gray-500 text-sm mt-1">Reserve your spot &mdash; we&rsquo;d love to see you there<\/p>
          <div class="divider mt-4"><\/div>
        <\/div>
        <form method="POST" action="/rsvp/${escHtml(rsvpToken)}/submit" class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">First Name <span class="text-red-400">*<\/span><\/label>
              <input type="text" name="first_name" required autofocus
                class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
                placeholder="Jane" \/>
            <\/div>
            <div>
              <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Last Name <span class="text-red-400">*<\/span><\/label>
              <input type="text" name="last_name" required
                class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
                placeholder="Smith" \/>
            <\/div>
          <\/div>
          <div>
            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Email Address <span class="text-red-400">*<\/span><\/label>
            <input type="email" name="email" required
              class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
              placeholder="jane@example.com" \/>
          <\/div>
          <div>
            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Phone Number<\/label>
            <input type="tel" name="phone"
              class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
              placeholder="(555) 000-0000" \/>
          <\/div>
          <div>
            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Notes \/ Questions<\/label>
            <textarea name="notes" rows="2"
              class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
              placeholder="Anything you&rsquo;d like the agent to know&hellip;"><\/textarea>
          <\/div>
          <div class="pt-1">
            <button type="submit" class="btn-gold w-full font-bold py-3.5 rounded-xl text-sm shadow-lg">
              &#127968; &nbsp;RSVP Now
            <\/button>
          <\/div>
        <\/form>
      <\/div>`;

  const body = `
<div style="background-color:var(--navy);min-height:100vh">
  ${heroHtml}
  <div class="max-w-lg mx-auto px-4 pb-12 -mt-3 relative">
    <div class="glass-card rounded-2xl shadow-2xl p-5 mb-4 anim-1">
      <h1 class="text-lg font-bold text-gray-900 leading-tight mb-1">${escHtml(event.title)}<\/h1>
      <p class="text-gray-500 text-sm mb-0.5">&#128205; ${escHtml(event.property_address)}<\/p>
      <p class="text-gray-500 text-sm">&#128336; ${formatDateTime(event.start_time, event.timezone)} &ndash; ${formatDateTime(event.end_time, event.timezone)}<\/p>
      ${event.description ? `<div class="divider my-3"><\/div><p class="text-gray-500 text-sm italic">${escHtml(event.description)}<\/p>` : ''}
      ${event.listing_url ? `<a href="${escHtml(event.listing_url)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-sm font-medium mt-2" style="color:var(--gold)">View Listing &#8599;<\/a>` : ''}
    <\/div>
    ${formHtml}
    <div class="text-center mt-6 text-slate-500 text-xs space-y-2">
      ${equalHousingLogo('text-slate-400')}
      <p class="text-slate-600">Powered by Open House Sign-in<\/p>
    <\/div>
  <\/div>
<\/div>`;

  return c.html(guestPageShell(`RSVP \u2013 ${event.title}`, body));
});

// ---------------------------------------------------------------------------
// RSVP submit
// ---------------------------------------------------------------------------

app.post('/rsvp/:rsvpToken/submit', async (c) => {
  const rsvpToken = c.req.param('rsvpToken');
  const event = await c.env.DB.prepare(
    'SELECT * FROM events WHERE rsvp_token = ?'
  )
    .bind(rsvpToken)
    .first<Event>();

  if (!event) return c.notFound();

  const liveStatus = getEventStatus(event, new Date());
  if (liveStatus === 'cancelled' || liveStatus === 'ended') {
    return c.redirect(`/rsvp/${rsvpToken}`);
  }

  const form = await c.req.formData();
  const firstName = (form.get('first_name') as string | null)?.trim() ?? '';
  const lastName = (form.get('last_name') as string | null)?.trim() ?? '';
  const email = (form.get('email') as string | null)?.trim() ?? '';

  if (!firstName || !lastName || !email) {
    return c.redirect(`/rsvp/${rsvpToken}`);
  }

  const phone = (form.get('phone') as string | null)?.trim() || null;
  const notes = (form.get('notes') as string | null)?.trim() || null;
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO guests (id, event_id, first_name, last_name, email, phone, is_rsvp, notes, signed_in_at, follow_up_status)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'pending')`
  )
    .bind(generateId(), event.id, firstName, lastName, email, phone, notes, now)
    .run();

  return c.redirect(`/rsvp/${rsvpToken}/success`);
});

// ---------------------------------------------------------------------------
// RSVP success page
// ---------------------------------------------------------------------------

app.get('/rsvp/:rsvpToken/success', async (c) => {
  const rsvpToken = c.req.param('rsvpToken');
  const event = await c.env.DB.prepare(
    'SELECT title, agent_name, agent_email, agent_phone, company_name, agent_photo_key, photo_key, start_time, end_time, timezone FROM events WHERE rsvp_token = ?'
  )
    .bind(rsvpToken)
    .first<Pick<Event, 'title' | 'agent_name' | 'agent_email' | 'agent_phone' | 'company_name' | 'agent_photo_key' | 'photo_key' | 'start_time' | 'end_time' | 'timezone'>>();

  const title = event?.title ?? 'Open House';
  const photoUrl = event?.photo_key
    ? `/api/photo/${encodeURIComponent(event.photo_key)}`
    : null;
  const agentPhotoUrl = event?.agent_photo_key
    ? `/api/photo/${encodeURIComponent(event.agent_photo_key)}`
    : null;
  const initials = (event?.agent_name ?? '??')
    .split(' ')
    .map((p) => p[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || '??';

  const body = `
<div style="background-color:var(--navy);min-height:100vh">
  ${photoUrl
    ? `<div class="relative h-40 overflow-hidden">
         <img src="${escAttr(photoUrl)}" alt="${escAttr(title)}" class="w-full h-full object-cover opacity-50" \/>
         <div class="hero-overlay absolute inset-0"><\/div>
       <\/div>`
    : `<div class="h-20" style="background:linear-gradient(135deg,#1a3557 0%,#0f1c2e 100%)"><\/div>`}
  <div class="max-w-lg mx-auto px-4 pb-12 -mt-6 relative">
    <div class="glass-card rounded-2xl shadow-2xl p-8 text-center anim-1">
      <div class="text-6xl mb-4">&#9989;<\/div>
      <h1 class="text-2xl font-bold text-gray-900 mb-2">You&rsquo;re On The List!</h1>
      <p class="text-gray-600 mb-3">You&rsquo;ve successfully RSVP&rsquo;d for <strong>${escHtml(title)}<\/strong>.<\/p>
      ${event ? `<p class="text-gray-500 text-sm mb-6">&#128336; ${formatDateTime(event.start_time, event.timezone)} &ndash; ${formatDateTime(event.end_time, event.timezone)}<\/p>` : ''}
      <div class="divider mb-6"><\/div>
      ${event
        ? `<div class="flex items-center justify-center gap-4">
             <div class="flex-shrink-0">
               ${agentPhotoUrl
                 ? `<img src="${escAttr(agentPhotoUrl)}" alt="${escAttr(event.agent_name)}" class="w-14 h-14 rounded-full border-2 object-cover" style="border-color:var(--gold)" \/>`
                 : `<div class="w-14 h-14 rounded-full border-2 flex items-center justify-center text-lg font-bold" style="border-color:var(--gold);background:rgba(201,168,76,0.1);color:var(--gold)">${escHtml(initials)}<\/div>`}
             <\/div>
             <div class="text-left">
               ${event.company_name ? `<p class="text-xs font-semibold uppercase tracking-widest" style="color:var(--gold)">${escHtml(event.company_name)}<\/p>` : ''}
               <p class="font-semibold text-gray-900 text-sm">${escHtml(event.agent_name)}<\/p>
               <a href="mailto:${escAttr(event.agent_email)}" class="text-xs text-gray-500 hover:underline">${escHtml(event.agent_email)}<\/a>
               ${event.agent_phone ? `<p class="text-xs text-gray-500">${escHtml(event.agent_phone)}<\/p>` : ''}
             <\/div>
           <\/div>
           <p class="text-gray-400 text-xs mt-5">We look forward to seeing you there! The agent will be in touch with any updates.<\/p>`
        : ''}
      <div class="mt-6 pt-5 border-t border-gray-100">
        ${equalHousingLogo('text-gray-400')}
      <\/div>
    <\/div>
  <\/div>
<\/div>`;

  return c.html(guestPageShell(`RSVP Confirmed \u2013 ${title}`, body));
});

// ---------------------------------------------------------------------------
// CSV builder helper
// ---------------------------------------------------------------------------

function csvField(val: string | null | undefined): string {
  const s = val ?? '';
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildGuestsCsv(guests: Guest[], timezone: string): string {
  const headers = [
    'First Name', 'Last Name', 'Email', 'Phone', 'Address',
    'Type', 'Checked In', 'Checked In At', 'With Agent',
    'How Did You Hear', 'Notes', 'Signed In At',
    'Follow-up Status', 'Follow-up Notes',
  ];
  const rows = guests.map((g) => [
    csvField(g.first_name),
    csvField(g.last_name),
    csvField(g.email),
    csvField(g.phone),
    csvField(g.address),
    g.is_rsvp ? 'RSVP' : 'Walk-in',
    g.checked_in ? 'Yes' : 'No',
    csvField(g.checked_in_at ? formatDateTime(g.checked_in_at, timezone) : null),
    g.is_agent ? 'Yes' : 'No',
    csvField(g.how_did_you_hear?.replace(/_/g, ' ') ?? null),
    csvField(g.notes),
    csvField(formatDateTime(g.signed_in_at, timezone)),
    csvField(g.follow_up_status),
    csvField(g.follow_up_notes),
  ].join(','));
  return [headers.join(','), ...rows].join('\r\n');
}

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
      return `<option value="${tz}" ${isSelected ? 'selected' : ''}>${tz}<\/option>`;
    })
    .join('');

  const toLocal = (iso: string | undefined) => {
    if (!iso) return '';
    return iso.slice(0, 16);
  };

  return `
  <div class="grid grid-cols-1 gap-4">
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">Event Title <span class="text-red-500">*<\/span><\/label>
      <input type="text" name="title" required value="${escAttr(ev?.title ?? '')}"
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
    <\/div>
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">Property Address <span class="text-red-500">*<\/span><\/label>
      <input type="text" name="property_address" required value="${escAttr(ev?.property_address ?? '')}"
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
    <\/div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Agent Name <span class="text-red-500">*<\/span><\/label>
        <input type="text" name="agent_name" required value="${escAttr(ev?.agent_name ?? '')}"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
      <\/div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Agent Email <span class="text-red-500">*<\/span><\/label>
        <input type="email" name="agent_email" required value="${escAttr(ev?.agent_email ?? '')}"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
      <\/div>
    <\/div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Agent Phone<\/label>
        <input type="tel" name="agent_phone" value="${escAttr(ev?.agent_phone ?? '')}"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
      <\/div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Company \/ Brokerage<\/label>
        <input type="text" name="company_name" value="${escAttr(ev?.company_name ?? '')}"
          placeholder="e.g. Keller Williams Realty"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
      <\/div>
    <\/div>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Start Time <span class="text-red-500">*<\/span><\/label>
        <input type="datetime-local" name="start_time" required value="${escAttr(toLocal(ev?.start_time))}"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
      <\/div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">End Time <span class="text-red-500">*<\/span><\/label>
        <input type="datetime-local" name="end_time" required value="${escAttr(toLocal(ev?.end_time))}"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
      <\/div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Timezone<\/label>
        <select name="timezone" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          ${tzOptions}
        <\/select>
      <\/div>
    <\/div>
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">Listing URL<\/label>
      <input type="url" name="listing_url" value="${escAttr(ev?.listing_url ?? '')}"
        placeholder="https:\/\/..."
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" \/>
    <\/div>
    <div>
      <label class="block text-sm font-medium text-gray-700 mb-1">Description<\/label>
      <textarea name="description" rows="3"
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">${escHtml(ev?.description ?? '')}<\/textarea>
    <\/div>
  <\/div>`;
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

function equalHousingLogo(classes = ''): string {
  return `<div class="flex items-center justify-center gap-2 ${classes}" title="Equal Housing Opportunity">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 110" class="w-8 h-8 flex-shrink-0" aria-label="Equal Housing Opportunity logo" role="img">
      <polygon points="50,5 95,45 85,45 85,98 15,98 15,45 5,45" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/>
      <line x1="33" y1="66" x2="67" y2="66" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
      <line x1="33" y1="80" x2="67" y2="80" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>
    <\/svg>
    <span class="text-xs font-semibold uppercase tracking-wide">Equal Housing Opportunity<\/span>
  <\/div>`;
}

export default app;
