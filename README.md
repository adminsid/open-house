# Open House Sign-in System

A production-ready Cloudflare Workers application for managing real estate open house events. Guests scan a QR code to sign in, and agents manage guests & follow-ups through a protected admin panel.

## Features

- 📋 **Guest sign-in form** — Mobile-friendly form accessible via QR code or direct link
- 🏠 **Admin dashboard** — Create and manage events, view guests, track follow-ups
- 📸 **Photo uploads** — Store listing photos in Cloudflare R2
- 📊 **Follow-up tracking** — per-guest status (pending, contacted, interested, not_interested, closed)
- 🔒 **Token-based auth** — unique admin token per event, separate public token for guests
- 🕐 **Automatic status** — computed from current time vs event start/end (scheduled, happening_now, ended)
- 📱 **QR code generation** — ready-to-print QR codes for each event

---

## Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js ≥ 18](https://nodejs.org/)
- Wrangler CLI — installed as a dev dependency (`npx wrangler`)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create Cloudflare resources

```bash
# Create D1 database
npx wrangler d1 create open-house-db
# → copy the database_id into wrangler.toml [[d1_databases]]

# Create KV namespace
npx wrangler kv:namespace create KV
# → copy the id into wrangler.toml [[kv_namespaces]]

# Create R2 bucket
npx wrangler r2 bucket create open-house-photos
# (bucket_name already matches wrangler.toml)
```

### 3. Update wrangler.toml

Replace the placeholder IDs in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "open-house-db"
database_id = "<your-d1-database-id>"   # ← paste here

[[kv_namespaces]]
binding = "KV"
id = "<your-kv-namespace-id>"           # ← paste here
```

Also update `APP_URL` to your deployed worker URL, and set `ADMIN_SECRET` to a strong secret.

### 4. Run database migrations

```bash
npm run db:migrate
```

For local development:

```bash
npx wrangler d1 execute open-house-db --local --file=./migrations/001_schema.sql
```

---

## Development

```bash
npm run dev
```

Opens at `http://localhost:8787`. The admin dashboard is at `/admin`.

---

## Deployment

```bash
npm run deploy
```

---

## Usage Guide

### Creating an Event (Admin)

1. Go to `https://your-worker.workers.dev/admin`
2. Click **New Event** and fill in the details (title, address, agent info, date/time, timezone)
3. After creating, you'll land on the event admin page with:
   - **Guest sign-in link** — share or embed in listings
   - **QR code** — download and print for the open house
   - **Photo upload** — add a listing photo guests will see
4. The admin URL (`/admin/events/<adminToken>`) is your private management page — bookmark it.

### During the Open House

Guests scan the QR code or visit the sign-in link, fill out the form, and are redirected to a thank-you page.

### After the Event

1. Return to the admin event page to see all signed-in guests.
2. Use the **Edit** button per guest to update follow-up status and notes.
3. Optionally mark the event as **Achieved** (archived) when follow-ups are complete.

### Event Statuses

| Status | Meaning |
|---|---|
| `scheduled` | Before start time |
| `happening_now` | Between start and end time |
| `ended` | After end time |
| `cancelled` | Manually cancelled |
| `achieved` | Manually archived/achieved |

---

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: [Hono.js v4](https://hono.dev/)
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2 (photos)
- **Cache/Sessions**: Cloudflare KV
- **Language**: TypeScript
- **Styling**: Tailwind CSS (CDN)