# HQAdz Admin Panel

Next.js 14 admin dashboard for the HQAdz AdBot platform.

## Setup

```bash
cd frontend
npm install
```

## Environment

Copy `.env.local` and update values:

```
NEXT_PUBLIC_API_URL=http://localhost:8000    # FastAPI backend URL
NEXTAUTH_URL=http://localhost:3000           # This frontend URL
NEXTAUTH_SECRET=your-random-secret-32chars  # Random string for JWT signing
```

The backend must have these env vars set:
- `WEB_ADMIN_USER` — admin username (default: "admin")
- `WEB_ADMIN_PASS_HASH` — bcrypt hash of admin password
- `JWT_SECRET` — secret for API JWT tokens
- `CORS_ORIGINS` — set to your frontend URL (e.g. `http://localhost:3000`)

## Development

```bash
npm run dev
```

Opens at http://localhost:3000 → redirects to /admin (login required).

## Production Build

```bash
npm run build
npm start
```

## Connect to Backend

1. Start the FastAPI backend: `python run_api.py` (runs on port 8000)
2. Start the frontend: `npm run dev` (runs on port 3000)
3. Go to http://localhost:3000/login
4. Login with your admin credentials

## Pages

| Route | Description |
|---|---|
| `/login` | Admin login |
| `/admin` | Dashboard — revenue, bot fleet, session pool, alerts |
| `/admin/adbots` | Bot list — start/stop/delete, create new |
| `/admin/adbots/[name]` | Bot detail — god mode with tabs for overview, sessions, groups, chatlist, logs, config, repair |
| `/admin/sessions` | Session manager — upload, delete, filter by status |
| `/admin/groups` | Group files — create, upload, notepad editor |
| `/admin/payments` | Orders — mark paid, cancel, filter by status |
| `/admin/plans` | Plans — create/edit/delete pricing plans |
| `/admin/broadcast` | Broadcast — send messages to user segments |
| `/admin/settings` | System — emergency stop/resume, maintenance, workers, audit log |

## Tech Stack

- Next.js 14 (App Router)
- TypeScript
- Tailwind CSS (dark theme)
- SWR (data fetching with auto-refresh)
- NextAuth (JWT auth)
- Recharts (charts)
- React Hook Form (forms)
- React Hot Toast (notifications)
- Framer Motion (animations)
- Lucide React (icons)
