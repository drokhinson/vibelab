# WealthMate — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-03-14

## What This App Does

WealthMate is a couples wealth-tracking app. Instead of logging every transaction, couples do periodic "Wealth Check-Ins" where they snapshot the current value of every account (checking, savings, 401k, investments, properties, loans, etc). Over time, the app shows how total net worth changes from check-in to check-in. Two users "couple up" by username, after which they can each see personal accounts (their own), their partner's personal accounts, and shared joint accounts. Users authenticate with username + password. A large-expense tracker (grouped line items for things like medical bills or vacations) is a separate add-on feature.

## Current Status
- Stage: Ideation
- Web prototype: not deployed
- Backend: not deployed
- Native app: not started

## Tech Stack
| Layer | Technology | Notes |
|---|---|---|
| Web frontend | Vanilla HTML/CSS/JS + Pico.css | No build step, deployed to Vercel |
| Backend | Python FastAPI (shared service) | Routes at `/api/v1/wealthmate/...` |
| Database | Supabase (shared project) | Tables prefixed `wealthmate_` |
| Native app | React Native / Expo | Not started |
| Auth | Custom JWT (username/password) | Supabase Auth not used — custom table + bcrypt |
| Storage | Supabase Storage | Not used |

## Directory Layout
```
projects/wealthmate/
├── web/
│   ├── index.html    — App shell / login gate
│   ├── styles.css    — App-specific overrides
│   ├── config.js     — Sets window.APP_CONFIG.apiBase
│   └── app.js        — All JS logic
├── app/              — React Native / Expo (future)
└── STRUCTURE.md      — this file

shared-backend/routes/wealthmate.py  — FastAPI routes
db/migrations/004_wealthmate_schema.sql
db/migrations/005_wealthmate_seed.sql
```

---

## Data Model

All tables prefixed `wealthmate_`.

### `wealthmate_users`
Stores credentials and profile info. Auth is custom (bcrypt + JWT), not Supabase Auth.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | gen_random_uuid() |
| username | text UNIQUE NOT NULL | login handle |
| display_name | text | friendly name shown in UI |
| password_hash | text NOT NULL | bcrypt hash |
| created_at | timestamptz | default now() |

### `wealthmate_couples`
A couple is a named pair. Members are in `wealthmate_couple_members`.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| created_at | timestamptz | |

### `wealthmate_couple_members`
Links users to a couple. A user belongs to at most one couple at a time.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| couple_id | uuid FK → wealthmate_couples | |
| user_id | uuid FK → wealthmate_users | |
| role | text | 'owner' or 'partner' |
| joined_at | timestamptz | |

### `wealthmate_invitations`
Pending couple link requests.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| from_user_id | uuid FK → wealthmate_users | sender |
| to_username | text NOT NULL | invitee's username (may not exist yet) |
| couple_id | uuid FK → wealthmate_couples | the couple being formed |
| status | text | 'pending' / 'accepted' / 'declined' |
| created_at | timestamptz | |

### `wealthmate_accounts`
An account belongs to a couple. `owner_user_id` is set for personal accounts, null for joint.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| couple_id | uuid FK → wealthmate_couples | |
| owner_user_id | uuid FK → wealthmate_users nullable | null = joint account |
| name | text NOT NULL | user-given label, e.g. "Chase Checking" |
| account_type | text NOT NULL | see Account Types below |
| url | text nullable | link to account website |
| notes | text nullable | free-form notes |
| is_active | boolean | soft delete; default true |
| sort_order | int | display ordering |
| created_at | timestamptz | |

**Account Types** (enum stored as text):
`checking_personal`, `checking_joint`, `savings`, `401k`, `investment`, `property_personal`, `property_rental`, `car_loan`, `mortgage`, `other`

### `wealthmate_account_loan_details`
Optional extra details for loan/mortgage accounts.
| Column | Type | Notes |
|---|---|---|
| account_id | uuid PK FK → wealthmate_accounts | one-to-one |
| original_loan_amount | numeric nullable | |
| interest_rate | numeric nullable | percentage e.g. 6.5 |
| loan_term_months | int nullable | |
| origination_date | date nullable | |
| lender_name | text nullable | |

### `wealthmate_checkins`
One check-in per wealth snapshot session. Status starts as `in_progress`, moves to `submitted`.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| couple_id | uuid FK → wealthmate_couples | |
| initiated_by_user_id | uuid FK → wealthmate_users | |
| checkin_date | date NOT NULL | the "as-of" date for this snapshot |
| status | text | 'in_progress' / 'submitted' |
| created_at | timestamptz | |
| submitted_at | timestamptz nullable | set when submitted |

### `wealthmate_checkin_values`
One row per account per check-in. Updated incrementally until checkin is submitted.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| checkin_id | uuid FK → wealthmate_checkins | |
| account_id | uuid FK → wealthmate_accounts | |
| current_value | numeric nullable | asset value (e.g. house estimated worth) |
| balance_owed | numeric nullable | for loans/mortgages — amount still owed |
| data_source | text | 'manual' or 'copied' (from previous checkin) |
| updated_at | timestamptz | last save time |

### `wealthmate_expense_groups`
A named group of related large expenses (e.g. "ACL Surgery", "Spain Trip").
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| couple_id | uuid FK → wealthmate_couples | |
| name | text NOT NULL | |
| description | text nullable | |
| created_at | timestamptz | |

### `wealthmate_expense_items`
Individual line items within an expense group.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| group_id | uuid FK → wealthmate_expense_groups | |
| description | text NOT NULL | e.g. "ER Visit" |
| amount | numeric NOT NULL | |
| item_date | date nullable | |
| created_at | timestamptz | |

---

## API Endpoints

All routes under `/api/v1/wealthmate/`. Auth: most endpoints require `Authorization: Bearer <token>` header. Token is a simple JWT signed with `WEALTHMATE_JWT_SECRET`.

### Auth
- `POST /api/v1/wealthmate/auth/register` — Create account. Body: `{username, password, display_name}`
- `POST /api/v1/wealthmate/auth/login` — Returns `{token, user}`. Body: `{username, password}`
- `GET /api/v1/wealthmate/auth/me` — Returns current user (auth required)

### Couple Management
- `GET /api/v1/wealthmate/couple` — Get current user's couple + members (auth required)
- `POST /api/v1/wealthmate/couple` — Create a new couple (makes caller the owner)
- `POST /api/v1/wealthmate/couple/invite` — Send invite. Body: `{to_username}`
- `POST /api/v1/wealthmate/couple/invite/{id}/respond` — Body: `{action: "accept"|"decline"}`
- `GET /api/v1/wealthmate/couple/invites` — List pending invites for current user

### Accounts
- `GET /api/v1/wealthmate/accounts` — List all accounts for couple (auth required)
- `POST /api/v1/wealthmate/accounts` — Create account
- `PUT /api/v1/wealthmate/accounts/{id}` — Update account metadata / loan details
- `DELETE /api/v1/wealthmate/accounts/{id}` — Soft-delete (sets is_active=false)

### Check-ins
- `GET /api/v1/wealthmate/checkins` — List all submitted check-ins for couple
- `GET /api/v1/wealthmate/checkins/active` — Get the in-progress check-in (if any)
- `POST /api/v1/wealthmate/checkins` — Start new check-in. Body: `{checkin_date}`. Creates an empty check-in; also returns the last submitted check-in's values so the frontend can show "previous value" hints per account.
- `GET /api/v1/wealthmate/checkins/{id}` — Get check-in with all account values
- `PUT /api/v1/wealthmate/checkins/{id}/values/{account_id}` — Save a single account value. Body: `{current_value, balance_owed, data_source}`
- `POST /api/v1/wealthmate/checkins/{id}/submit` — Submit check-in (status → submitted)

### Wealth History
- `GET /api/v1/wealthmate/wealth/history` — Returns per-checkin totals: gross_assets, total_liabilities, net_worth

### Large Expenses (add-on)
- `GET /api/v1/wealthmate/expenses` — List expense groups for couple
- `POST /api/v1/wealthmate/expenses` — Create group. Body: `{name, description}`
- `GET /api/v1/wealthmate/expenses/{id}` — Get group with line items
- `POST /api/v1/wealthmate/expenses/{id}/items` — Add item. Body: `{description, amount, item_date}`
- `DELETE /api/v1/wealthmate/expenses/{id}/items/{item_id}` — Remove line item

### Health
- `GET /api/v1/wealthmate/health` — Returns `{"project": "wealthmate", "status": "ok"}`

---

## Screen / Page Flow

```
index.html (login gate)
│
├── [not logged in]
│   ├── Login form (username + password)
│   └── Register form
│
└── [logged in]
    ├── Dashboard
    │   ├── Net worth summary card (latest check-in)
    │   ├── "Start New Check-In" button
    │   ├── "Continue Check-In" button (if current user has one in-progress)
    │   └── Couple status bar (partner info or invite prompt)
    │
    ├── Check-In Flow (multi-step)
    │   ├── Step 1: Set Check-In Date
    │   ├── Step 2: For each account group (Personal — You, Personal — Partner, Joint):
    │   │   ├── Show account name + type
    │   │   ├── Show previous value (pre-filled)
    │   │   ├── Input: current_value (and balance_owed for loans)
    │   │   └── Toggle: "Copy from last" vs "Update manually"
    │   ├── Step 3: "Any new accounts?" prompt → inline add-account form
    │   └── Step 4: Review summary → Submit
    │
    ├── Accounts Page
    │   ├── List all accounts grouped by owner (You / Partner / Joint)
    │   ├── Add new account button
    │   └── Edit / deactivate each account
    │
    ├── History Page
    │   ├── Line chart: Net Worth over check-ins
    │   ├── Stacked bars: Gross Assets vs Liabilities
    │   └── Check-in history table (date, net worth, change vs prior)
    │
    ├── Expenses Page (add-on)
    │   ├── List expense groups with totals
    │   ├── Create new group
    │   └── Group detail: list items, add/delete items
    │
    └── Settings Page
        ├── Profile (display name)
        ├── Couple management (partner info, invite status)
        └── Logout
```

---

## Key Business Logic

- **Net worth calculation**: `net_worth = SUM(current_value) - SUM(balance_owed)` across all active accounts in a checkin. Gross assets = SUM(current_value). Total liabilities = SUM(balance_owed).
- **Liability accounts** (car_loan, mortgage): `current_value` is the asset value (optional), `balance_owed` is the debt. Both can be null if user doesn't want to track the asset side.
- **Copying from previous check-in**: When a new check-in is started, the backend does NOT pre-populate values. The check-in starts empty. The frontend fetches the previous submitted check-in's values and displays them as "last value" hints alongside each account. The user must explicitly choose per account: enter a new value manually, or tap "Use previous" to copy it in (data_source = 'copied'). Nothing is saved until the user interacts with an account.
- **Couple visibility**: Each member can see all accounts in the couple (personal of both + joint). Personal accounts display which user they belong to.
- **Solo-first onboarding**: Every user gets a solo household on registration. They can immediately create accounts, do check-ins, and track expenses. When they invite a partner and the partner accepts, the partner's data (accounts, check-ins, expenses) is merged into the inviter's household. The app works fully as a single-user finance tracker until you choose to merge.
- **Auth**: Custom bcrypt + JWT (PyJWT). JWT payload: `{user_id, username, couple_id}`. Token stored in localStorage on the web.
- **In-progress check-ins**: Both partners can have separate in-progress check-ins simultaneously. Each check-in is tied to the user who initiated it. There is no uniqueness constraint on in-progress status per couple — both can be gathering data at the same time and submit independently.
- **Dummy test accounts**: Adam (username: `adam`, password: `password`) and Eve (username: `eve`, password: `password`) are seeded as a couple with ~6 months of check-in history across realistic accounts.

---

## Environment Variables
| Variable | Used In | Purpose |
|---|---|---|
| `SUPABASE_URL` | shared-backend | Supabase project URL (Railway) |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend | Server-side DB access (Railway) |
| `WEALTHMATE_JWT_SECRET` | shared-backend | Signs JWT tokens (Railway) |
| `SUPABASE_ANON_KEY` | web | Client-side (Vercel, if needed) |
| `EXPO_PUBLIC_API_URL` | app | Railway backend URL |

---

## Development Setup
```bash
# Backend (from vibelab root)
cd shared-backend
source .venv/Scripts/activate   # Windows; use .venv/bin/activate on Mac/Linux
uvicorn main:app --reload --port 8000

# Web prototype
# Open projects/wealthmate/web/index.html in browser
# Or: npx serve projects/wealthmate/web

# React Native app (once started)
cd projects/wealthmate/app
npx expo start
```

## Active Development Notes
- 2026-03-14 — STRUCTURE.md complete. Awaiting user approval before writing code.
