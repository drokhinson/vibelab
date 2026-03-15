# Vibelab Admin — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-03-15

## What This App Does

Owner-only dashboard for monitoring all vibelab apps. Tracks app usage (open counts), manages users in apps that have accounts (list users, generate password reset codes), and monitors database storage per app and per table. Protected by a simple admin API key — no user accounts needed since there is exactly one admin.

## Current Status
- Stage: Prototype
- Web prototype: local only (not yet deployed to Vercel)
- Backend: routes added to shared service
- Native app: not planned (web-only dashboard)

## Tech Stack
| Layer | Technology | Notes |
|---|---|---|
| Web frontend | Vanilla HTML/CSS/JS + Pico.css | No build step, deployed to Vercel |
| Backend | Python FastAPI (shared service) | Routes at `/api/v1/admin/...` and `/api/v1/analytics/...` |
| Database | Supabase (shared project) | Uses `analytics_events` table + `admin_table_sizes()` RPC |
| Auth | Admin API key | `ADMIN_API_KEY` env var on Railway, Bearer token auth |

## Data Model

- **analytics_events** — Cross-app event tracking (no app prefix — shared infra). Columns: id (bigint PK), app (text), event (text), metadata (jsonb), created_at (timestamptz).
- **admin_table_sizes()** — PostgreSQL RPC function that queries `pg_class` for per-table storage sizes.

## API Endpoints

### Analytics (`shared-backend/routes/analytics.py`)
- `GET /api/v1/analytics/health` — Health check
- `POST /api/v1/analytics/track` — Record event (no auth, called by app frontends)
- `GET /api/v1/analytics/summary` — Per-app event counts for 24h/7d/30d/all-time (admin-only)

### Admin (`shared-backend/routes/admin.py`)
- `GET /api/v1/admin/health` — Health check
- `GET /api/v1/admin/apps-with-users` — List apps that have user management (admin-only)
- `GET /api/v1/admin/users?app=wealthmate` — List users for an app (admin-only)
- `POST /api/v1/admin/users/{user_id}/reset-code?app=wealthmate` — Generate recovery code (admin-only)
- `GET /api/v1/admin/storage` — Per-app and per-table DB storage (admin-only)

## Screen / Page Flow

```
Login (admin key) → Dashboard
  ├── App Usage section (auto-loads)
  ├── User Management section (select app → user table → reset code button → dialog)
  └── Database Storage section (expandable per-app → per-table breakdown)
```

## Key Business Logic

- Admin auth is a simple API key comparison, not JWT. The key is stored in `sessionStorage` (cleared on tab close).
- User management only exposes identity fields (username, email, display_name, created_at) — never financial data.
- The `APPS_WITH_USERS` dict in `admin.py` maps app names to their user table. Update it when a new app adds user auth.
- Storage monitoring uses `pg_total_relation_size()` which includes indexes, so sizes may be larger than raw data.
- Analytics tracking is fire-and-forget — frontend pings never block the app.

## Environment Variables
| Variable | Used In | Purpose |
|---|---|---|
| `ADMIN_API_KEY` | shared-backend | Admin dashboard authentication (set in Railway) |
| `SUPABASE_URL` | shared-backend | Supabase project URL (set in Railway) |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend | Server-side DB access (set in Railway) |

## Development Setup
```bash
# Backend (from vibelab root)
cd shared-backend
source .venv/Scripts/activate   # Windows; use .venv/bin/activate on Mac/Linux
uvicorn main:app --reload --port 8000

# Web prototype
# Open projects/admin/web/index.html in browser
# Or: npx serve projects/admin/web
```

## Active Development Notes

- 2026-03-15 — Project implemented. Migrations 009 and 010 need to be run in Supabase dashboard.
