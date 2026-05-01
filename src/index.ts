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
  flyer_key: string | null;
  status: string;
  admin_token: string;
  public_token: string;
  rsvp_token: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type GuestAnalytics = {
  event_id: string;
  total: number;
  rsvp_count: number;
  checked_in_count: number;
  pending_count: number;
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

function toUtc(localIso: string, timezone: string): string {
  try {
    const d = new Date(localIso);
    const tzDate = new Date(d.toLocaleString('en-US', { timeZone: timezone }));
    const diff = d.getTime() - tzDate.getTime();
    return new Date(d.getTime() + diff).toISOString();
  } catch {
    return new Date(localIso).toISOString();
  }
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

function icon(name: 'map' | 'clock' | 'user' | 'mail' | 'phone' | 'calendar' | 'external', cls = 'w-4 h-4'): string {
  const paths: Record<string, string> = {
    map: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.81 12.81 0 0 0 .62 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.62A2 2 0 0 1 22 16.92z"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}">${paths[name]}</svg>`;
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
  <style>[x-cloak]{display:none}</style>
</head>
<body class="bg-gray-50 min-h-screen">
  ${body}
</body>
</html>`;
}

function guestPageShell(title: string, body: string, meta?: { description: string, image: string | null, url: string }): string {
  const ogTags = meta ? `
  <meta name="description" content="${escAttr(meta.description)}" />
  <meta property="og:title" content="${escAttr(title)}" />
  <meta property="og:description" content="${escAttr(meta.description)}" />
  ${meta.image ? `<meta property="og:image" content="${escAttr(meta.image)}" />` : ''}
  <meta property="og:url" content="${escAttr(meta.url)}" />
  <meta property="og:type" content="website" />
  <meta name="twitter:card" content="summary_large_image" />
  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escHtml(title)}</title>
  ${ogTags}
  <script src="https://cdn.tailwindcss.com"></script>
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
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

function adminNav(extra = ''): string {
  return `<nav class="bg-white shadow-sm border-b border-gray-200">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between h-14">
      <div class="flex items-center gap-6">
        <a href="/admin" class="text-indigo-600 font-bold text-lg tracking-tight">&#127968; Open House Admin</a>
      </div>
      <div class="flex items-center gap-4">
        ${extra}
        <form action="/logout" method="POST" class="inline">
          <button type="submit" class="text-gray-500 hover:text-gray-700 text-sm font-medium">Sign Out</button>
        </form>
      </div>
    </div>
  </nav>`;
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
    // Admin exists: Disable /setup
    if (path === '/setup') {
      return c.redirect('/admin');
    }

    // Protect /admin routes
    if (path.startsWith('/admin')) {
      const sessionId = getCookie(c, 'admin_session');
      if (!sessionId) {
        return c.redirect('/login');
      }
    }

    // Redirect /login to /admin if already logged in
    if (path === '/login') {
      const sessionId = getCookie(c, 'admin_session');
      if (sessionId) {
        return c.redirect('/admin');
      }
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

  setCookie(c, 'admin_session', id, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 7,
  });

  return c.redirect('/admin');
});

// ---------------------------------------------------------------------------
// Auth Flow
// ---------------------------------------------------------------------------

app.get('/login', (c) => {
  const body = `
<div class="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8 bg-slate-950">
  <div class="max-w-md w-full space-y-8 bg-white p-10 rounded-2xl shadow-2xl">
    <div>
      <div class="mx-auto h-12 w-12 flex items-center justify-center rounded-full bg-indigo-100 text-indigo-600 text-2xl">
        &#127968;
      </div>
      <h2 class="mt-6 text-center text-3xl font-extrabold text-gray-900">
        Admin Login
      </h2>
      <p class="mt-2 text-center text-sm text-gray-600">
        Please sign in to manage your events.
      </p>
    </div>
    <form class="mt-8 space-y-6" action="/login" method="POST">
      <div class="rounded-md shadow-sm space-y-4">
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
          Sign In
        </button>
      </div>
    </form>
  </div>
</div>`;
  return c.html(pageShell('Login', body));
});

app.post('/login', async (c) => {
  const form = await c.req.formData();
  const username = (form.get('username') as string)?.trim();
  const password = (form.get('password') as string);

  if (!username || !password) {
    return c.text('Username and password are required', 400);
  }

  const admin = await c.env.DB.prepare('SELECT * FROM admins WHERE username = ?')
    .bind(username)
    .first<Admin>();

  if (admin && admin.password_hash === await hashPassword(password)) {
    setCookie(c, 'admin_session', admin.id, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24 * 7, // 1 week
    });
    return c.redirect('/admin');
  }

  return c.html(pageShell('Login Error', `
    <div class="min-h-screen flex items-center justify-center bg-gray-100">
      <div class="bg-white p-8 rounded-lg shadow-md text-center">
        <h2 class="text-red-600 text-xl font-bold mb-4">Invalid Credentials</h2>
        <a href="/login" class="text-indigo-600 hover:underline">Try again</a>
      </div>
    </div>
  `), 401);
});

app.post('/logout', async (c) => {
  setCookie(c, 'admin_session', '', {
    path: '/',
    maxAge: 0,
  });
  return c.redirect('/login');
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
      <h1 class="text-lg font-bold text-gray-900 leading-tight mb-1">${escHtml(event.title)}</h1>
      <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.property_address)}" target="_blank" class="text-gray-500 text-sm mb-0.5 flex items-center gap-1.5 hover:text-indigo-600">
        ${icon('map', 'w-3.5 h-3.5')} ${escHtml(event.property_address)}
      </a>
      <p class="text-gray-500 text-sm flex items-center gap-1.5">
        ${icon('clock', 'w-3.5 h-3.5')} ${formatDateTime(event.start_time, event.timezone)} &ndash; ${formatDateTime(event.end_time, event.timezone)}
      </p>
      ${event.description ? `<div class="divider my-3"></div><p class="text-gray-500 text-sm italic">${escHtml(event.description)}</p>` : ''}
      ${event.listing_url ? `<a href="${escHtml(event.listing_url)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 text-sm font-medium mt-2" style="color:var(--gold)">View Listing ${icon('external', 'w-3.5 h-3.5')}</a>` : ''}
    </div>
    ${formHtml}
    <div class="text-center mt-6 text-slate-500 text-xs space-y-2">
      ${equalHousingLogo('text-slate-400')}
      <p class="text-slate-600">Powered by Open House Sign-in</p>
    </div>
  </div>
</div>`;

  return c.html(guestPageShell(event.title, body, {
    description: `Open House at ${event.property_address}. Hosted by ${event.agent_name}.`,
    image: photoUrl ? `${c.env.APP_URL}${photoUrl}` : null,
    url: `${c.env.APP_URL}/e/${token}`
  }));
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
  const now = new Date();
  const filter = c.req.query('filter') ?? 'scheduled';
  const view = c.req.query('view') ?? 'grid';

  // Guest analytics (batch)
  const analyticsResult = await c.env.DB.prepare(
    `SELECT event_id,
       COUNT(*) as total,
       SUM(is_rsvp) as rsvp_count,
       SUM(checked_in) as checked_in_count,
       SUM(CASE WHEN follow_up_status = 'pending' THEN 1 ELSE 0 END) as pending_count
     FROM guests GROUP BY event_id`
  ).all<GuestAnalytics>();
  const analyticsMap = new Map<string, GuestAnalytics>(
    (analyticsResult.results ?? []).map((a) => [a.event_id, a])
  );

  if (filter === 'deleted') {
    // Trash tab: soft-deleted events
    const trashedEvents = await c.env.DB.prepare(
      'SELECT * FROM events WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'
    ).all<Event>();

    const trashedCards = (trashedEvents.results ?? [])
      .map((ev) => {
        const deletedAgo = ev.deleted_at
          ? Math.round((now.getTime() - new Date(ev.deleted_at).getTime()) / 1000 / 60 / 60)
          : 0;
        const deletedAgoLabel = deletedAgo < 24
          ? `${deletedAgo}h ago`
          : `${Math.floor(deletedAgo / 24)}d ago`;
        return `
        <div class="bg-white rounded-xl shadow border border-red-100 overflow-hidden opacity-75 hover:opacity-100 transition-opacity"
             data-search="${escAttr((ev.title + ' ' + ev.property_address + ' ' + ev.agent_name).toLowerCase())}">
          <div class="p-5">
            <div class="flex items-start justify-between mb-2 gap-2">
              <h3 class="font-semibold text-gray-700 text-base leading-tight">${escHtml(ev.title)}<\/h3>
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Deleted<\/span>
            <\/div>
            <p class="text-sm text-gray-400 mb-0.5">&#128205; ${escHtml(ev.property_address)}<\/p>
            <p class="text-sm text-gray-400 mb-1">&#128100; ${escHtml(ev.agent_name)}<\/p>
            <p class="text-xs text-red-400 mb-4">&#128465; Deleted ${deletedAgoLabel}<\/p>
            <div class="flex items-center gap-2 flex-wrap">
              <form method="POST" action="/admin/events/${escHtml(ev.admin_token)}/restore" class="inline">
                <button type="submit" class="inline-flex items-center gap-1 bg-green-50 hover:bg-green-100 text-green-700 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">&#8635; Restore<\/button>
              <\/form>
              <form method="POST" action="/admin/events/${escHtml(ev.admin_token)}/permanent-delete" class="inline"
                onsubmit="return confirm('Permanently delete this event and ALL its data? This CANNOT be undone.')">
                <button type="submit" class="inline-flex items-center gap-1 bg-red-600 hover:bg-red-700 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">&#128465; Delete Forever<\/button>
              <\/form>
            <\/div>
          <\/div>
        <\/div>`;
      })
      .join('');

    const deletedCount = trashedEvents.results?.length ?? 0;
    const tabs2 = buildTabBar(filter, {}, view);

    const body = `
${adminNav(`<a href="/admin/events/new" class="inline-flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">+ New Event<\/a>`)}
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  <div class="flex items-center justify-between mb-5">
    <h1 class="text-2xl font-bold text-gray-900">Events<\/h1>
  <\/div>
  ${tabs2}
  ${deletedCount === 0
    ? `<div class="text-center py-20"><p class="text-gray-400 text-lg">Trash is empty.<\/p><\/div>`
    : `<div class="mb-4">
        <input type="text" id="search-input" placeholder="&#128269; Search events&hellip;"
          oninput="filterEvents(this.value)"
          class="w-full sm:w-80 rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" \/>
       <\/div>
       <div id="events-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">${trashedCards}<\/div>
       <p id="no-results" class="hidden text-center text-gray-400 py-10">No matching events.<\/p>`}
<\/div>
<script>
function filterEvents(q) {
  const term = q.toLowerCase().trim();
  const cards = document.querySelectorAll('[data-search]');
  let visible = 0;
  cards.forEach(function(card) {
    const match = !term || card.dataset.search.includes(term);
    card.style.display = match ? '' : 'none';
    if (match) visible++;
  });
  const noResults = document.getElementById('no-results');
  if (noResults) noResults.classList.toggle('hidden', visible > 0);
}
<\/script>`;

    return c.html(pageShell('Admin Dashboard', body));
  }

  // Normal tabs: exclude soft-deleted events
  const eventsResult = await c.env.DB.prepare(
    'SELECT * FROM events WHERE deleted_at IS NULL ORDER BY start_time DESC'
  ).all<Event>();

  const deletedCountResult = await c.env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM events WHERE deleted_at IS NOT NULL'
  ).first<{ cnt: number }>();
  const deletedCount = deletedCountResult?.cnt ?? 0;

  const allEvents = (eventsResult.results ?? []).map((ev) => ({
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
    deleted: deletedCount,
  };

  const tabBar = buildTabBar(filter, counts, view);

  // Build event data for calendar view
  const calendarData = filtered.map(({ ev, liveStatus }) => ({
    id: ev.id,
    title: ev.title,
    date: ev.start_time.slice(0, 10),
    status: liveStatus,
    url: `/admin/events/${ev.admin_token}`,
  }));

  const gridCards = filtered
    .map(({ ev, liveStatus }) => {
      const photoUrl = ev.photo_key
        ? `/api/photo/${encodeURIComponent(ev.photo_key)}`
        : null;
      const a = analyticsMap.get(ev.id);
      const totalGuests = a?.total ?? 0;
      const rsvpCount = a?.rsvp_count ?? 0;
      const checkedIn = a?.checked_in_count ?? 0;
      const searchText = (ev.title + ' ' + ev.property_address + ' ' + ev.agent_name + ' ' + (ev.company_name ?? '')).toLowerCase();
      return `
      <div class="bg-white rounded-xl shadow hover:shadow-md transition-shadow border border-gray-100 overflow-hidden"
           data-search="${escAttr(searchText)}">
        ${photoUrl ? `<div class="h-36 overflow-hidden"><img src="${escAttr(photoUrl)}" alt="" class="w-full h-full object-cover" \/><\/div>` : ''}
        <div class="p-5">
          <div class="flex items-start justify-between mb-2 gap-2">
            <h3 class="font-semibold text-gray-900 text-base leading-tight">${escHtml(ev.title)}<\/h3>
            ${statusBadge(liveStatus)}
          <\/div>
          <p class="text-sm text-gray-500 mb-0.5">&#128205; ${escHtml(ev.property_address)}<\/p>
          <p class="text-sm text-gray-500 mb-1">&#128100; ${escHtml(ev.agent_name)}${ev.company_name ? ` &middot; ${escHtml(ev.company_name)}` : ''}<\/p>
          <p class="text-xs text-gray-400 mb-3">&#128336; ${formatDateTime(ev.start_time, ev.timezone)}<\/p>
          <div class="flex items-center gap-3 mb-4 py-2.5 px-3 bg-gray-50 rounded-lg">
            <div class="text-center flex-1">
              <p class="text-base font-bold text-gray-800">${totalGuests}<\/p>
              <p class="text-xs text-gray-500">Guests<\/p>
            <\/div>
            <div class="w-px h-8 bg-gray-200"><\/div>
            <div class="text-center flex-1">
              <p class="text-base font-bold text-purple-600">${rsvpCount}<\/p>
              <p class="text-xs text-gray-500">RSVPs<\/p>
            <\/div>
            <div class="w-px h-8 bg-gray-200"><\/div>
            <div class="text-center flex-1">
              <p class="text-base font-bold text-green-600">${checkedIn}<\/p>
              <p class="text-xs text-gray-500">Check-ins<\/p>
            <\/div>
          <\/div>
          <div class="flex items-center gap-2 flex-wrap">
            <a href="/admin/events/${escHtml(ev.admin_token)}" class="inline-flex items-center gap-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">&#9998; Manage<\/a>
            <a href="/agent/${escHtml(ev.admin_token)}" class="inline-flex items-center gap-1 bg-gray-50 hover:bg-gray-100 text-gray-700 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">&#128100; Agent<\/a>
            <form method="POST" action="/admin/events/${escHtml(ev.admin_token)}/duplicate" class="inline">
              <button type="submit" class="inline-flex items-center gap-1 bg-green-50 hover:bg-green-100 text-green-700 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">&#10064; Copy<\/button>
            <\/form>
            <form method="POST" action="/admin/events/${escHtml(ev.admin_token)}/delete" class="inline"
              onsubmit="return confirm('Move this event to Trash?')">
              <button type="submit" class="inline-flex items-center gap-1 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors">&#128465;<\/button>
            <\/form>
          <\/div>
        <\/div>
      <\/div>`;
    })
    .join('');

  const listRows = filtered
    .map(({ ev, liveStatus }) => {
      const a = analyticsMap.get(ev.id);
      const totalGuests = a?.total ?? 0;
      const rsvpCount = a?.rsvp_count ?? 0;
      const searchText = (ev.title + ' ' + ev.property_address + ' ' + ev.agent_name + ' ' + (ev.company_name ?? '')).toLowerCase();
      return `
      <tr class="hover:bg-gray-50 border-b border-gray-100 last:border-0"
          data-search="${escAttr(searchText)}">
        <td class="px-4 py-3">
          <div class="font-medium text-gray-900 text-sm">${escHtml(ev.title)}<\/div>
          <div class="text-xs text-gray-400">&#128205; ${escHtml(ev.property_address)}<\/div>
        <\/td>
        <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">&#128336; ${formatDateTime(ev.start_time, ev.timezone)}<\/td>
        <td class="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">&#128100; ${escHtml(ev.agent_name)}<\/td>
        <td class="px-4 py-3">${statusBadge(liveStatus)}<\/td>
        <td class="px-4 py-3 text-sm text-center">
          <span class="font-semibold text-gray-800">${totalGuests}<\/span>
          ${rsvpCount > 0 ? `<span class="ml-1 text-xs text-purple-600">(${rsvpCount} RSVP)<\/span>` : ''}
        <\/td>
        <td class="px-4 py-3">
          <div class="flex items-center gap-2 flex-wrap">
            <a href="/admin/events/${escHtml(ev.admin_token)}" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-medium px-2 py-1 rounded-lg">&#9998; Manage<\/a>
            <a href="/agent/${escHtml(ev.admin_token)}" class="bg-gray-50 hover:bg-gray-100 text-gray-700 text-xs font-medium px-2 py-1 rounded-lg">Agent<\/a>
            <form method="POST" action="/admin/events/${escHtml(ev.admin_token)}/delete" class="inline"
              onsubmit="return confirm('Move this event to Trash?')">
              <button type="submit" class="bg-red-50 hover:bg-red-100 text-red-700 text-xs font-medium px-2 py-1 rounded-lg">&#128465;<\/button>
            <\/form>
          <\/div>
        <\/td>
      <\/tr>`;
    })
    .join('');

  const emptyLabel = filter === 'all'
    ? 'No events yet.'
    : `No ${filter.replace(/_/g, ' ')} events.`;

  const body = `
${adminNav(`<a href="/admin/events/new" class="inline-flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors">+ New Event<\/a>`)}
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
  <div class="flex items-center justify-between mb-5">
    <h1 class="text-2xl font-bold text-gray-900">Events<\/h1>
    <span class="text-sm text-gray-500">${filtered.length} event(s)<\/span>
  <\/div>
  ${tabBar}
  ${filtered.length === 0
    ? `<div class="text-center py-20">
        <p class="text-gray-400 text-lg mb-4">${emptyLabel}<\/p>
        ${filter === 'all' ? `<a href="/admin/events/new" class="inline-flex items-center gap-1 bg-indigo-600 text-white font-medium px-5 py-2.5 rounded-lg hover:bg-indigo-700 transition-colors">Create your first event<\/a>` : ''}
       <\/div>`
    : `
  <div class="flex items-center gap-3 mb-4 flex-wrap">
    <input type="text" id="search-input" placeholder="&#128269; Search by title, address, or agent&hellip;"
      oninput="filterEvents(this.value)"
      class="flex-1 min-w-0 sm:max-w-sm rounded-lg border border-gray-300 px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" \/>
  <\/div>

  ${view === 'list'
    ? `<div class="bg-white rounded-xl shadow overflow-hidden">
        <div class="overflow-x-auto">
          <table class="min-w-full">
            <thead>
              <tr class="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wider border-b border-gray-100">
                <th class="px-4 py-3 text-left">Event<\/th>
                <th class="px-4 py-3 text-left">Date<\/th>
                <th class="px-4 py-3 text-left">Agent<\/th>
                <th class="px-4 py-3 text-left">Status<\/th>
                <th class="px-4 py-3 text-center">Guests<\/th>
                <th class="px-4 py-3 text-left">Actions<\/th>
              <\/tr>
            <\/thead>
            <tbody id="events-list">
              ${listRows}
            <\/tbody>
          <\/table>
        <\/div>
       <\/div>`
    : view === 'calendar'
    ? `<div id="calendar-container" class="bg-white rounded-xl shadow p-6"><\/div>
       <script>
       (function(){
         const events = ${JSON.stringify(calendarData)};
         let year = new Date().getFullYear();
         let month = new Date().getMonth();
         function render() {
           const container = document.getElementById('calendar-container');
           if (!container) return;
           const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
           const firstDay = new Date(year, month, 1).getDay();
           const daysInMonth = new Date(year, month+1, 0).getDate();
           const todayStr = new Date().toISOString().slice(0,10);
           let html = '<div class="flex items-center justify-between mb-4">'
             + '<button onclick="prevMonth()" class="p-2 rounded-lg hover:bg-gray-100 text-gray-600 font-bold text-lg">&lsaquo;<\/button>'
             + '<h2 class="text-lg font-semibold text-gray-800">' + monthNames[month] + ' ' + year + '<\/h2>'
             + '<button onclick="nextMonth()" class="p-2 rounded-lg hover:bg-gray-100 text-gray-600 font-bold text-lg">&rsaquo;<\/button>'
             + '<\/div>';
           html += '<div class="grid grid-cols-7 gap-1 mb-1">';
           ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => {
             html += '<div class="text-center text-xs font-semibold text-gray-400 py-1">' + d + '<\/div>';
           });
           html += '<\/div><div class="grid grid-cols-7 gap-1">';
           for (let i=0; i<firstDay; i++) html += '<div><\/div>';
           for (let d=1; d<=daysInMonth; d++) {
             const dateStr = year + '-' + String(month+1).padStart(2,'0') + '-' + String(d).padStart(2,'0');
             const dayEvents = events.filter(e => e.date === dateStr);
             const isToday = dateStr === todayStr;
             html += '<div class="min-h-[60px] p-1 rounded-lg border ' + (isToday ? 'border-indigo-300 bg-indigo-50' : 'border-gray-100 hover:bg-gray-50') + '">'
               + '<div class="text-xs font-medium ' + (isToday ? 'text-indigo-600' : 'text-gray-500') + ' mb-1">' + d + '<\/div>';
             dayEvents.forEach(e => {
               const colors = {happening_now:'bg-green-100 text-green-800',scheduled:'bg-blue-100 text-blue-800',ended:'bg-gray-100 text-gray-600',cancelled:'bg-red-100 text-red-700',achieved:'bg-purple-100 text-purple-700'};
               const cls = colors[e.status] || 'bg-gray-100 text-gray-600';
               html += '<a href="' + e.url + '" class="block text-xs px-1 py-0.5 rounded mb-0.5 truncate ' + cls + '" title="' + e.title.replace(/"/g,'&quot;') + '">' + e.title.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '<\/a>';
             });
             html += '<\/div>';
           }
           html += '<\/div>';
           container.innerHTML = html;
         }
         window.prevMonth = function() { month--; if(month<0){month=11;year--;} render(); };
         window.nextMonth = function() { month++; if(month>11){month=0;year++;} render(); };
         render();
       })();
       <\/script>`
    : `<div id="events-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">${gridCards}<\/div>`}
  <p id="no-results" class="hidden text-center text-gray-400 py-10">No matching events.<\/p>`}
<\/div>
<script>
function filterEvents(q) {
  const term = q.toLowerCase().trim();
  const rows = document.querySelectorAll('[data-search]');
  let visible = 0;
  rows.forEach(function(row) {
    const match = !term || row.dataset.search.includes(term);
    row.style.display = match ? '' : 'none';
    if (match) visible++;
  });
  const noResults = document.getElementById('no-results');
  if (noResults) noResults.classList.toggle('hidden', visible > 0);
}
<\/script>`;

  return c.html(pageShell('Admin Dashboard', body));
});

function buildTabBar(activeFilter: string, counts: Record<string, number>, view: string): string {
  const tabs: { key: string; label: string; icon: string }[] = [
    { key: 'scheduled', label: 'Upcoming', icon: '&#128197;' },
    { key: 'happening_now', label: 'Live Now', icon: '&#127897;' },
    { key: 'all', label: 'All', icon: '&#128196;' },
    { key: 'ended', label: 'Past', icon: '&#10003;' },
    { key: 'cancelled', label: 'Cancelled', icon: '&#10060;' },
    { key: 'achieved', label: 'Achieved', icon: '&#11088;' },
    { key: 'deleted', label: 'Trash', icon: '&#128465;' },
  ];

  const viewButtons = activeFilter !== 'deleted'
    ? `<div class="ml-auto flex items-center gap-1 bg-white border border-gray-200 rounded-lg p-0.5">
        <a href="/admin?filter=${activeFilter}&view=grid" title="Grid view"
          class="p-1.5 rounded-md text-sm transition-colors ${view === 'grid' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-100'}">&#8982;<\/a>
        <a href="/admin?filter=${activeFilter}&view=list" title="List view"
          class="p-1.5 rounded-md text-sm transition-colors ${view === 'list' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-100'}">&#9776;<\/a>
        <a href="/admin?filter=${activeFilter}&view=calendar" title="Calendar view"
          class="p-1.5 rounded-md text-sm transition-colors ${view === 'calendar' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-100'}">&#128197;<\/a>
      <\/div>`
    : '';

  const tabLinks = tabs
    .map(({ key, label, icon }) => {
      const count = counts[key] ?? 0;
      const active = activeFilter === key;
      const isDeleted = key === 'deleted';
      return `<a href="/admin?filter=${key}${key !== 'deleted' ? '&view=' + view : ''}"
        class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
          active
            ? isDeleted ? 'bg-red-600 text-white shadow-sm' : 'bg-indigo-600 text-white shadow-sm'
            : isDeleted ? 'bg-white text-red-600 border border-red-200 hover:bg-red-50' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
        }">
        ${icon} ${label}
        ${count > 0 || key === 'all' ? `<span class="${active ? (isDeleted ? 'bg-red-500 text-red-100' : 'bg-indigo-500 text-indigo-100') : (isDeleted ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-500')} text-xs px-1.5 py-0.5 rounded-full">${count}<\/span>` : ''}
      <\/a>`;
    })
    .join('');

  return `<div class="flex gap-1.5 flex-wrap items-center mb-6">
    ${tabLinks}
    ${viewButtons}
  <\/div>`;
}

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

  const startUtc = toUtc(start_time, timezone);
  const endUtc = toUtc(end_time, timezone);

  try {
    await c.env.DB.prepare(
      `INSERT INTO events (id, title, property_address, agent_name, agent_email, agent_phone, company_name, description, start_time, end_time, timezone, listing_url, status, admin_token, public_token, rsvp_token, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`
    )
      .bind(id, title, property_address, agent_name, agent_email, agent_phone, company_name, description, startUtc, endUtc, timezone, listing_url, admin_token, public_token, rsvp_token, now, now)
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
  const flyerUrl = event.flyer_key
    ? `/admin/flyer/${encodeURIComponent(event.flyer_key)}`
    : null;

  // Quick analytics
  const guestList = guests.results ?? [];
  const totalGuests = guestList.length;
  const rsvpCount = guestList.filter((g) => g.is_rsvp).length;
  const checkedInCount = guestList.filter((g) => g.checked_in).length;
  const pendingCount = guestList.filter((g) => g.follow_up_status === 'pending').length;

  const guestRows = guestList
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

  const deletedBanner = event.deleted_at
    ? `<div class="bg-red-50 border border-red-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <span class="text-red-500 text-xl">&#128465;<\/span>
          <div>
            <p class="font-semibold text-red-700 text-sm">This event is in the Trash<\/p>
            <p class="text-xs text-red-500">Deleted ${formatDateTime(event.deleted_at, event.timezone)}<\/p>
          <\/div>
        <\/div>
        <div class="flex gap-2">
          <form method="POST" action="/admin/events/${escHtml(adminToken)}/restore" class="inline">
            <button type="submit" class="bg-green-600 hover:bg-green-700 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors">&#8635; Restore<\/button>
          <\/form>
          <form method="POST" action="/admin/events/${escHtml(adminToken)}/permanent-delete" class="inline"
            onsubmit="return confirm('Permanently delete this event and ALL its data? This CANNOT be undone.')">
            <button type="submit" class="bg-red-600 hover:bg-red-700 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors">&#128465; Delete Forever<\/button>
          <\/form>
        <\/div>
      <\/div>`
    : '';

  const body = `
${adminNav(`<a href="/admin" class="text-sm text-gray-500 hover:text-gray-700">&larr; All Events<\/a>`)}
${followUpModal}
<div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
  ${deletedBanner}

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
      <a href="/admin/events/${escHtml(adminToken)}/signin-sheet" target="_blank"
        class="inline-flex items-center gap-1 bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
        title="Open printable guest sign-in sheet">
        &#128196; Sign-In Sheet
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
      ${!event.deleted_at
        ? `<form method="POST" action="/admin/events/${escHtml(adminToken)}/delete" class="inline"
            onsubmit="return confirm('Move this event to Trash? You can restore it later.')">
            <button type="submit" class="bg-red-50 hover:bg-red-100 text-red-700 border border-red-200 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors">&#128465; Move to Trash<\/button>
          <\/form>`
        : ''}
    <\/div>
  <\/div>

  <!-- Quick analytics strip -->
  <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
    <div class="bg-white rounded-xl shadow p-4 text-center">
      <p class="text-2xl font-bold text-gray-900">${totalGuests}<\/p>
      <p class="text-xs text-gray-500 mt-0.5">Total Guests<\/p>
    <\/div>
    <div class="bg-white rounded-xl shadow p-4 text-center">
      <p class="text-2xl font-bold text-purple-600">${rsvpCount}<\/p>
      <p class="text-xs text-gray-500 mt-0.5">RSVPs<\/p>
    <\/div>
    <div class="bg-white rounded-xl shadow p-4 text-center">
      <p class="text-2xl font-bold text-green-600">${checkedInCount}<\/p>
      <p class="text-xs text-gray-500 mt-0.5">Checked In<\/p>
    <\/div>
    <div class="bg-white rounded-xl shadow p-4 text-center">
      <p class="text-2xl font-bold text-yellow-600">${pendingCount}<\/p>
      <p class="text-xs text-gray-500 mt-0.5">Pending Follow-up<\/p>
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

      <div class="bg-white rounded-xl shadow p-5 border-l-4 border-amber-400">
        <h2 class="font-semibold text-gray-900 mb-1">Event Flyer<\/h2>
        <p class="text-xs text-gray-500 mb-3">Upload a PDF or image flyer. Visible to admins only.<\/p>
        ${flyerUrl
          ? `<div class="mb-3 flex items-center gap-2 p-3 bg-amber-50 rounded-lg">
              <span class="text-amber-600 text-lg">&#128196;<\/span>
              <div class="flex-1 min-w-0">
                <p class="text-sm font-medium text-gray-700 truncate">Flyer attached<\/p>
              <\/div>
              <a href="${escAttr(flyerUrl)}" target="_blank"
                class="bg-amber-600 text-white text-xs px-3 py-1.5 rounded-lg hover:bg-amber-700 transition-colors whitespace-nowrap">&#11015; View<\/a>
            <\/div>
            <form method="POST" action="/admin/events/${escHtml(adminToken)}/flyer/delete" class="mb-2">
              <button type="submit" onclick="return confirm('Remove this flyer?')"
                class="w-full bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-medium py-1.5 rounded-lg transition-colors">Remove Flyer<\/button>
            <\/form>`
          : '<p class="text-sm text-gray-400 mb-3">No flyer uploaded yet.<\/p>'}
        <form method="POST" action="/admin/events/${escHtml(adminToken)}/flyer" enctype="multipart/form-data" class="space-y-2">
          <input type="file" name="flyer" accept="image\/*,.pdf"
            class="block w-full text-sm text-gray-600 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-amber-50 file:text-amber-700 hover:file:bg-amber-100" \/>
          <button type="submit" class="w-full bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium py-1.5 rounded-lg transition-colors">${flyerUrl ? 'Replace Flyer' : 'Upload Flyer'}<\/button>
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
      <h2 class="font-semibold text-gray-900">Guests <span class="text-gray-400 font-normal">(${totalGuests})<\/span><\/h2>
      <div class="flex gap-2 flex-wrap">
        <a href="/admin/events/${escHtml(adminToken)}/signin-sheet" target="_blank"
          class="inline-flex items-center gap-1 bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors"
          title="Open sign-in sheet">
          &#128196; Sign-In Sheet
        <\/a>
        <a href="/admin/events/${escHtml(adminToken)}/export.csv"
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

  const startTimeUtc = toUtc((form.get('start_time') as string)?.trim(), (form.get('timezone') as string)?.trim() || 'America/New_York');
  const endTimeUtc = toUtc((form.get('end_time') as string)?.trim(), (form.get('timezone') as string)?.trim() || 'America/New_York');

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
      startTimeUtc,
      endTimeUtc,
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
// Admin: upload event flyer (admin-only)
// ---------------------------------------------------------------------------

app.post('/admin/events/:adminToken/flyer', async (c) => {
  const adminToken = c.req.param('adminToken');
  const event = await c.env.DB.prepare(
    'SELECT id, flyer_key FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id' | 'flyer_key'>>();

  if (!event) return c.notFound();

  const form = await c.req.formData();
  const file = form.get('flyer') as File | null;

  if (!file || file.size === 0) {
    return c.redirect(`/admin/events/${adminToken}`);
  }

  // Validate extension against allowlist
  const allowedFlyerExts: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };
  const rawExt = (file.name.split('.').pop() ?? '').toLowerCase();
  const safeContentType = allowedFlyerExts[rawExt];
  if (!safeContentType) {
    return c.html(
      pageShell('Invalid File', `<div class="flex items-center justify-center min-h-screen"><div class="text-center p-8"><h1 class="text-xl font-bold text-red-600 mb-2">Invalid file type<\/h1><p class="text-gray-500 mb-4">Allowed types: PDF, JPG, PNG, GIF, WebP<\/p><a href="/admin/events/${escHtml(adminToken)}" class="text-indigo-600 underline">Go back<\/a><\/div><\/div>`),
      400
    );
  }

  if (event.flyer_key) {
    await c.env.BUCKET.delete(event.flyer_key).catch(() => {});
  }

  const key = `flyers/${event.id}/${generateId()}.${rawExt}`;

  await c.env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: safeContentType },
  });

  await c.env.DB.prepare(
    'UPDATE events SET flyer_key = ?, updated_at = ? WHERE admin_token = ?'
  )
    .bind(key, new Date().toISOString(), adminToken)
    .run();

  return c.redirect(`/admin/events/${adminToken}`);
});

// ---------------------------------------------------------------------------
// Admin: delete flyer
// ---------------------------------------------------------------------------

app.post('/admin/events/:adminToken/flyer/delete', async (c) => {
  const adminToken = c.req.param('adminToken');
  const event = await c.env.DB.prepare(
    'SELECT id, flyer_key FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id' | 'flyer_key'>>();

  if (!event) return c.notFound();

  if (event.flyer_key) {
    await c.env.BUCKET.delete(event.flyer_key).catch(() => {});
  }

  await c.env.DB.prepare(
    'UPDATE events SET flyer_key = NULL, updated_at = ? WHERE admin_token = ?'
  )
    .bind(new Date().toISOString(), adminToken)
    .run();

  return c.redirect(`/admin/events/${adminToken}`);
});

// ---------------------------------------------------------------------------
// Admin: serve flyer (admin-only, protected by middleware)
// ---------------------------------------------------------------------------

app.get('/admin/flyer/:key', async (c) => {
  const key = c.req.param('key');
  // Validate that the key refers to a flyer owned by an event in the DB
  const event = await c.env.DB.prepare(
    'SELECT id FROM events WHERE flyer_key = ?'
  ).bind(key).first<Pick<Event, 'id'>>();
  if (!event) return c.notFound();

  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('content-disposition', `inline; filename="${key.split('/').pop() ?? 'flyer'}"`);
  headers.set('cache-control', 'private, max-age=3600');
  return new Response(obj.body, { headers });
});

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
// Admin: delete event (soft delete — moves to Trash)
// ---------------------------------------------------------------------------

app.post('/admin/events/:adminToken/delete', async (c) => {
  const adminToken = c.req.param('adminToken');
  const event = await c.env.DB.prepare(
    'SELECT id FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id'>>();

  if (!event) return c.notFound();

  await c.env.DB.prepare(
    'UPDATE events SET deleted_at = ?, updated_at = ? WHERE admin_token = ?'
  )
    .bind(new Date().toISOString(), new Date().toISOString(), adminToken)
    .run();

  return c.redirect('/admin?filter=deleted');
});

// ---------------------------------------------------------------------------
// Admin: restore a soft-deleted event
// ---------------------------------------------------------------------------

app.post('/admin/events/:adminToken/restore', async (c) => {
  const adminToken = c.req.param('adminToken');
  const event = await c.env.DB.prepare(
    'SELECT id FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id'>>();

  if (!event) return c.notFound();

  await c.env.DB.prepare(
    'UPDATE events SET deleted_at = NULL, updated_at = ? WHERE admin_token = ?'
  )
    .bind(new Date().toISOString(), adminToken)
    .run();

  return c.redirect(`/admin/events/${adminToken}`);
});

// ---------------------------------------------------------------------------
// Admin: permanently delete event
// ---------------------------------------------------------------------------

app.post('/admin/events/:adminToken/permanent-delete', async (c) => {
  const adminToken = c.req.param('adminToken');
  const event = await c.env.DB.prepare(
    'SELECT id, photo_key, agent_photo_key, flyer_key FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Pick<Event, 'id' | 'photo_key' | 'agent_photo_key' | 'flyer_key'>>();

  if (!event) return c.notFound();

  if (event.photo_key) {
    await c.env.BUCKET.delete(event.photo_key).catch(() => {});
  }
  if (event.agent_photo_key) {
    await c.env.BUCKET.delete(event.agent_photo_key).catch(() => {});
  }
  if (event.flyer_key) {
    await c.env.BUCKET.delete(event.flyer_key).catch(() => {});
  }

  await c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(event.id).run();

  return c.redirect('/admin?filter=deleted');
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
        <a href="/admin/events/${escHtml(adminToken)}/signin-sheet" target="_blank"
          class="inline-flex items-center gap-1 bg-sky-50 hover:bg-sky-100 text-sky-700 border border-sky-200 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors">
          &#128196; Sign-In Sheet
        <\/a>
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
          <h2 class="text-xl font-bold text-gray-900">RSVP to This Open House</h2>
          <p class="text-gray-500 text-sm mt-1">Reserve your spot &mdash; we&rsquo;d love to see you there</p>
          <div class="divider mt-4"></div>
        </div>
        <form method="POST" action="/rsvp/${escHtml(rsvpToken)}/submit" class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">First Name <span class="text-red-400">*</span></label>
              <input type="text" name="first_name" required autofocus
                class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
                placeholder="Jane" />
            </div>
            <div>
              <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Last Name <span class="text-red-400">*</span></label>
              <input type="text" name="last_name" required
                class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
                placeholder="Smith" />
            </div>
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Phone Number <span class="text-red-400">*</span></label>
            <input type="tel" name="phone" required
              class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
              placeholder="(555) 000-0000" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Email Address</label>
            <input type="email" name="email"
              class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
              placeholder="jane@example.com" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Notes / Questions</label>
            <textarea name="notes" rows="2"
              class="input-field w-full rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-sm text-gray-800"
              placeholder="Anything you'd like to ask?"></textarea>
          </div>
          <div class="pt-1">
            <button type="submit" class="btn-gold w-full font-bold py-3.5 rounded-xl text-sm shadow-lg">
              Confirm My RSVP
            </button>
          </div>
        </form>
      </div>`;

  const body = `
<div style="background-color:var(--navy);min-height:100vh">
  ${heroHtml}
  <div class="max-w-lg mx-auto px-4 pb-12 -mt-3 relative">
    <div class="glass-card rounded-2xl shadow-2xl p-5 mb-4 anim-1">
      <h1 class="text-lg font-bold text-gray-900 leading-tight mb-1">${escHtml(event.title)}</h1>
      <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.property_address)}" target="_blank" class="text-gray-500 text-sm mb-0.5 flex items-center gap-1.5 hover:text-indigo-600">
        ${icon('map', 'w-3.5 h-3.5')} ${escHtml(event.property_address)}
      </a>
      <p class="text-gray-500 text-sm flex items-center gap-1.5">
        ${icon('clock', 'w-3.5 h-3.5')} ${formatDateTime(event.start_time, event.timezone)} &ndash; ${formatDateTime(event.end_time, event.timezone)}
      </p>
      ${event.description ? `<div class="divider my-3"></div><p class="text-gray-500 text-sm italic">${escHtml(event.description)}</p>` : ''}
      ${event.listing_url ? `<a href="${escHtml(event.listing_url)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 text-sm font-medium mt-2" style="color:var(--gold)">View Listing ${icon('external', 'w-3.5 h-3.5')}</a>` : ''}
    </div>
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
  const phone = (form.get('phone') as string | null)?.trim() ?? '';

  if (!firstName || !lastName || !phone) {
    return c.redirect(`/rsvp/${rsvpToken}`);
  }

  const email = (form.get('email') as string | null)?.trim() || null;
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
    'SELECT title, agent_name, agent_email, agent_phone, company_name, agent_photo_key, photo_key, start_time, end_time, timezone, property_address FROM events WHERE rsvp_token = ?'
  )
    .bind(rsvpToken)
    .first<Pick<Event, 'title' | 'agent_name' | 'agent_email' | 'agent_phone' | 'company_name' | 'agent_photo_key' | 'photo_key' | 'start_time' | 'end_time' | 'timezone' | 'property_address'>>();

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
         <img src="${escAttr(photoUrl)}" alt="${escAttr(title)}" class="w-full h-full object-cover opacity-50" />
         <div class="hero-overlay absolute inset-0"></div>
       </div>`
    : `<div class="h-20" style="background:linear-gradient(135deg,#1a3557 0%,#0f1c2e 100%)"></div>`}
  <div class="max-w-lg mx-auto px-4 pb-12 -mt-6 relative">
    <div class="glass-card rounded-2xl shadow-2xl p-8 text-center anim-1">
      <div class="text-6xl mb-4">✅</div>
      <h1 class="text-2xl font-bold text-gray-900 mb-2">You're On The List!</h1>
      <p class="text-gray-600 mb-3">You've successfully RSVP'd for <strong>${escHtml(title)}</strong>.</p>
      ${event ? `<p class="text-gray-500 text-sm mb-4 flex items-center justify-center gap-1.5">${icon('clock', 'w-4 h-4')} ${formatDateTime(event.start_time, event.timezone)} &ndash; ${formatDateTime(event.end_time, event.timezone)}</p>` : ''}
      
      <div class="flex justify-center mb-6">
        <a href="https://www.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${event?.start_time.replace(/[-:]/g, '').split('.')[0]}Z/${event?.end_time.replace(/[-:]/g, '').split('.')[0]}Z&details=${encodeURIComponent('Open House Sign-in RSVP')}&location=${encodeURIComponent(event?.property_address ?? '')}" 
           target="_blank" class="inline-flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition-colors shadow-md">
          ${icon('calendar', 'w-4 h-4')} Add to Calendar
        </a>
      </div>

      <div class="divider mb-6"></div>
      ${event
        ? `<div class="flex items-center justify-center gap-4">
             <div class="flex-shrink-0">
               ${agentPhotoUrl
                 ? `<img src="${escAttr(agentPhotoUrl)}" alt="${escAttr(event.agent_name)}" class="w-14 h-14 rounded-full border-2 object-cover" style="border-color:var(--gold)" />`
                 : `<div class="w-14 h-14 rounded-full border-2 flex items-center justify-center text-lg font-bold" style="border-color:var(--gold);background:rgba(201,168,76,0.1);color:var(--gold)">${escHtml(initials)}</div>`}
             </div>
             <div class="text-left">
               ${event.company_name ? `<p class="text-xs font-semibold uppercase tracking-widest" style="color:var(--gold)">${escHtml(event.company_name)}</p>` : ''}
               <p class="font-semibold text-gray-900 text-sm">${escHtml(event.agent_name)}</p>
               <a href="mailto:${escAttr(event.agent_email)}" class="text-xs text-gray-500 hover:underline flex items-center gap-1">${icon('mail', 'w-3 h-3')} ${escHtml(event.agent_email)}</a>
               ${event.agent_phone ? `<a href="tel:${escAttr(event.agent_phone)}" class="text-xs text-gray-500 hover:underline flex items-center gap-1">${icon('phone', 'w-3 h-3')} ${escHtml(event.agent_phone)}</a>` : ''}
             </div>
           </div>
           <p class="text-gray-400 text-xs mt-5">We look forward to seeing you there! The agent will be in touch with any updates.</p>`
        : ''}
      <div class="mt-6 pt-5 border-t border-gray-100">
        ${equalHousingLogo('text-gray-400')}
      </div>
    </div>
  </div>
</div>`;

  return c.html(guestPageShell(`RSVP Confirmed \u2013 ${title}`, body));
});

// ---------------------------------------------------------------------------
// Admin: generate sign-in sheet (printable HTML page)
// ---------------------------------------------------------------------------

app.get('/admin/events/:adminToken/signin-sheet', async (c) => {
  const adminToken = c.req.param('adminToken');
  const event = await c.env.DB.prepare(
    'SELECT * FROM events WHERE admin_token = ?'
  )
    .bind(adminToken)
    .first<Event>();

  if (!event) return c.notFound();

  const appUrl = c.env.APP_URL;
  const signInUrl = `${appUrl}/e/${event.public_token}`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(signInUrl)}`;
  const dateTime = formatSignInSheetDateTime(event);

  const html = buildSignInSheetHtml(event.property_address, dateTime, event.agent_name, qrUrl);

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
});

function formatSignInSheetDateTime(event: Event): string {
  try {
    const tz = event.timezone;
    const startDate = new Date(event.start_time);
    const endDate = new Date(event.end_time);

    const startTime = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hour12: true,
    }).format(startDate).replace(/\s+/g, '').toUpperCase();

    const endTime = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hour12: true,
    }).format(endDate).replace(/\s+/g, '').toUpperCase();

    const dayOfWeek = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'long',
    }).format(startDate).toUpperCase();

    const date = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, month: 'numeric', day: 'numeric', year: 'numeric',
    }).format(startDate);

    return `${startTime} TO ${endTime}, ${dayOfWeek}, ${date}`;
  } catch {
    return formatDateTime(event.start_time, event.timezone);
  }
}

function buildSignInSheetHtml(
  propertyAddress: string,
  dateTime: string,
  host: string,
  qrUrl: string,
): string {
  const COMPANY_LOGO = 'https://inside.primeamericarealestate.com/images/logo.png';
  const EH_LOGO = 'https://www.nar.realtor/sites/default/files/downloadable/equal-housing-opportunity-logo-1200w.jpg';

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const border = 'border:1px solid #000;';
  const colHeaderStyle = `${border}font-weight:bold;text-align:center;background-color:#f2f2f2;` +
    `padding:5px 6px;font-size:10pt;font-family:Arial,sans-serif;vertical-align:middle;`;
  const dataCellStyle = `${border}height:30px;font-family:Arial,sans-serif;font-size:10pt;padding:2px 5px;`;

  const emptyRows = Array.from({ length: 22 }, () =>
    `  <tr>
    <td style="${dataCellStyle}"></td>
    <td style="${dataCellStyle}"></td>
    <td style="${dataCellStyle}"></td>
    <td style="${dataCellStyle}"></td>
  </tr>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Open House Sign-In Sheet</title>
<style>
  @page { size: landscape; margin: 0.5in; }
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background: #fff; }
  table { border-collapse: collapse; width: 100%; }
  td { vertical-align: middle; }
  .no-print { display: block; text-align: center; margin-bottom: 16px; }
  .print-btn {
    background: #4f46e5; color: #fff; border: none; padding: 10px 28px;
    font-size: 15px; border-radius: 8px; cursor: pointer; font-family: Arial, sans-serif;
  }
  .print-btn:hover { background: #4338ca; }
  @media print {
    .no-print { display: none !important; }
    body { padding: 0; }
  }
</style>
</head>
<body>
<div class="no-print">
  <button class="print-btn" onclick="window.print()">&#128438; Print Sign-In Sheet</button>
</div>
<table cellspacing="0" cellpadding="0">
  <colgroup>
    <col style="width:23%">
    <col style="width:14%">
    <col style="width:22%">
    <col style="width:39%">
  </colgroup>
  <!-- Company logo row -->
  <tr>
    <td colspan="4" style="text-align:center;border:none;padding:10px 4px 6px;">
      <img src="${COMPANY_LOGO}" height="80" alt="Company Logo" />
    </td>
  </tr>
  <!-- Sheet title row -->
  <tr>
    <td colspan="4" style="${border}text-align:center;font-weight:bold;font-size:13pt;
      font-family:Arial,sans-serif;padding:7px 4px;letter-spacing:0.5pt;">
      OPEN HOUSE SIGN-IN SHEET
    </td>
  </tr>
  <!-- Event info / logos row -->
  <tr>
    <td colspan="2" style="${border}padding:10px 10px;vertical-align:top;
      font-family:Arial,sans-serif;font-size:10pt;line-height:1.7;">
      <b>PROPERTY ADDRESS:</b> ${esc(propertyAddress)}<br>
      <b>DATE &amp; TIME:</b>&nbsp;${esc(dateTime)}<br>
      <b>HOST:</b> ${esc(host)}
    </td>
    <td style="${border}text-align:center;vertical-align:middle;padding:6px 4px;">
      <img src="${EH_LOGO}" height="65" alt="Equal Housing Opportunity" /><br>
      <span style="font-size:7.5pt;font-family:Arial,sans-serif;font-weight:bold;
        line-height:1.3;display:inline-block;margin-top:3px;">
        EQUAL HOUSING<br>OPPORTUNITY
      </span>
    </td>
    <td style="${border}text-align:center;vertical-align:middle;padding:6px 4px;
      font-family:Arial,sans-serif;font-size:9pt;">
      <span style="font-weight:bold;">Scan For Online Sign In</span><br>
      <img src="${esc(qrUrl)}" height="95" width="95" alt="QR Code"
        style="margin-top:4px;" />
    </td>
  </tr>
  <!-- Column header row -->
  <tr>
    <td style="${colHeaderStyle}">NAME</td>
    <td style="${colHeaderStyle}">Is agent representing you?</td>
    <td style="${colHeaderStyle}">CONTACT NUMBER</td>
    <td style="${colHeaderStyle}">EMAIL</td>
  </tr>
${emptyRows}
</table>
</body>
</html>`;
}

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

  const fromUtc = (utcIso: string, timezone: string) => {
    try {
      const d = new Date(utcIso);
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      }).formatToParts(d);
      const get = (t: string) => parts.find(p => p.type === t)?.value;
      return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
    } catch {
      return utcIso.slice(0, 16);
    }
  };

  const toLocal = (iso: string | undefined) => {
    if (!iso) return '';
    const timezone = ev?.timezone || 'America/New_York';
    return fromUtc(iso, timezone);
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
          placeholder="Prime America Real Estate, Inc."
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
