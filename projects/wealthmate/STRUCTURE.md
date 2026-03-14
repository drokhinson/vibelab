# WealthMate — STRUCTURE.md

> AI development context document. Keep this up-to-date as the project evolves.
> Last updated: 2026-03-14

## What This App Does

WealthMate is a wealth-tracking app that works solo or as a couple. Instead of logging every transaction, users do periodic "Wealth Check-Ins" where they snapshot the current value of every account (bank, retirement, investments, properties, loans, etc). Over time, the app shows how total net worth changes from check-in to check-in. Users start solo with their own household, and can later "merge finances" with a partner by sending an invite — the partner must accept, and their existing data merges into the shared household. A "Big Costs" tracker lets users group large multi-bill expenses (medical, travel, renovations). Users authenticate with username + password. Dark/light mode supported.

## Current Status
- Stage: Prototype (Stage 3)
- Web prototype: deployed to Vercel (`https://vibelab-jusv.vercel.app`)
- Backend: deployed to Railway (`https://vibelab-production-2119.up.railway.app`)
- Native app: not started

## Tech Stack
| Layer | Technology | Notes |
|---|---|---|
| Web frontend | Vanilla HTML/CSS/JS + Pico.css | No build step, deployed to Vercel |
| Backend | Python FastAPI (shared service) | Routes at `/api/v1/wealthmate/...` |
| Database | Supabase (shared project) | Tables prefixed `wealthmate_` |
| Native app | React Native / Expo | Not started |
| Auth | Custom JWT (username/password) | bcrypt + PyJWT, not Supabase Auth |
| Storage | Supabase Storage | Not used |

## Directory Layout
```
projects/wealthmate/
├── web/
│   ├── index.html    — App shell / login gate (SPA)
│   ├── styles.css    — Pico.css overrides + dark/light mode
│   ├── config.js     — Sets window.APP_CONFIG.apiBase
│   └── app.js        — All JS logic
├── app/              — React Native / Expo (future)
└── STRUCTURE.md      — this file

shared-backend/routes/wealthmate.py  — FastAPI routes
db/migrations/004_wealthmate_schema.sql  — table creation
db/migrations/005_wealthmate_seed.sql    — Adam & Eve test data
db/migrations/006_wealthmate_account_types.sql — expanded account types
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
A household. Created automatically for every user on registration. When two users merge, one household absorbs the other.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| created_at | timestamptz | |

### `wealthmate_couple_members`
Links users to a household. A user belongs to at most one household at a time.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| couple_id | uuid FK → wealthmate_couples | |
| user_id | uuid FK → wealthmate_users | UNIQUE constraint |
| role | text | 'owner' or 'partner' |
| joined_at | timestamptz | |

### `wealthmate_invitations`
Pending merge-finances requests. Invitee must accept before merge happens.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| from_user_id | uuid FK → wealthmate_users | sender |
| to_username | text NOT NULL | invitee's username |
| couple_id | uuid FK → wealthmate_couples | the inviter's household |
| status | text | 'pending' / 'accepted' / 'declined' |
| created_at | timestamptz | |

### `wealthmate_accounts`
An account belongs to a household. `owner_user_id` is set for personal accounts, null for joint.
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| couple_id | uuid FK → wealthmate_couples | |
| owner_user_id | uuid FK → wealthmate_users nullable | null = joint account |
| name | text NOT NULL | user-given label, e.g. "Chase Checking" |
| account_type | text NOT NULL | see Account Types below |
| url | text nullable | link to account website |
| notes | text nullable | free-form notes (also stores address, provider) |
| is_active | boolean | soft delete; default true |
| sort_order | int | display ordering |
| created_at | timestamptz | |

**Account Types** (enum stored as text):
- Bank: `checking_personal`, `checking_joint`, `savings`
- Retirement: `401k`, `roth_ira`, `retirement_other`
- Investment: `investment`
- Property: `property_personal`, `property_rental`
- Loan: `car_loan`, `mortgage`, `loan`
- Other: `other`, `other_liability`

**UI Categories** map to these DB types:
| UI Category | DB type(s) | Extra fields shown |
|---|---|---|
| Bank Account | `savings` | — |
| Retirement Account | `401k`, `roth_ira`, `retirement_other` | Sub-type picker, brokerage |
| Investment Account | `investment` | Brokerage |
| Property | `property_personal`, `property_rental` | Sub-type, est. value, mortgage outstanding, address |
| Loan | `car_loan`, `mortgage`, `loan` | Sub-type, balance owed, original amount, rate, term, lender |
| Other Account | `other` | — |
| Other Liability | `other_liability` | Amount owed |

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
| account_id | uuid FK → wealthmate_accounts | UNIQUE(checkin_id, account_id) |
| current_value | numeric nullable | asset value (e.g. house estimated worth) |
| balance_owed | numeric nullable | for loans/mortgages — amount still owed |
| data_source | text | 'manual' or 'copied' (from previous checkin) |
| updated_at | timestamptz | last save time |

### `wealthmate_expense_groups`
A named group of related large expenses (e.g. "ACL Surgery", "Spain Trip"). Displayed as "Big Costs" in the UI.
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
- `POST /auth/register` — Create account + auto-create solo household. Body: `{username, password, display_name}`. Returns `{token, user}`.
- `POST /auth/login` — Returns `{token, user}`. Body: `{username, password}`. Dev bypass for adam/eve with "password".
- `GET /auth/me` — Returns current user with couple_id (auth required)

### Couple / Household Management
- `GET /couple` — Get current user's household + members
- `POST /couple` — Returns existing household (auto-created on register; creates one as fallback)
- `POST /couple/invite` — Send merge invite. Body: `{to_username}`. Blocks if invitee already merged with someone else.
- `POST /couple/invite/{id}/respond` — Body: `{action: "accept"|"decline"}`. On accept, merges invitee's data into inviter's household.
- `GET /couple/invites` — List pending invites for current user (enriched with sender info)

### Accounts
- `GET /accounts` — List all active accounts for household with loan details attached
- `POST /accounts` — Create account with optional loan details
- `PUT /accounts/{id}` — Update account metadata / loan details (upsert)
- `DELETE /accounts/{id}` — Soft-delete (sets is_active=false)

### Check-ins
- `GET /checkins` — List all submitted check-ins (newest first)
- `GET /checkins/active` — Get current user's in-progress check-in with values
- `POST /checkins` — Start new empty check-in. Body: `{checkin_date}`. Returns `{checkin, previous_values}`.
- `GET /checkins/{id}` — Get check-in with all account values
- `PUT /checkins/{id}/values/{account_id}` — Upsert a single account value. Body: `{current_value, balance_owed, data_source}`
- `POST /checkins/{id}/submit` — Submit check-in (status → submitted, sets submitted_at)

### Wealth History
- `GET /wealth/history` — Per-checkin totals: `{checkin_date, gross_assets, total_liabilities, net_worth}`
- `GET /wealth/accounts` — Per-account values across all submitted check-ins for account-level charts. Returns `{dates[], accounts[{id, name, account_type, values[{value, owed}]}]}`

### Big Costs (Large Expenses)
- `GET /expenses` — List expense groups with item totals and counts
- `POST /expenses` — Create group. Body: `{name, description}`
- `GET /expenses/{id}` — Get group with line items and total
- `POST /expenses/{id}/items` — Add item. Body: `{description, amount, item_date}`
- `DELETE /expenses/{id}/items/{item_id}` — Remove line item

### Health
- `GET /health` — Returns `{"project": "wealthmate", "status": "ok"}`

---

## Screen / Page Flow

```
index.html (login gate)
│
├── [not logged in]
│   ├── Login form (username + password)
│   └── Register form (creates account + solo household)
│
└── [logged in]
    ├── Dashboard
    │   ├── Couple status bar ("Tracking solo" or "Merged with [name]")
    │   ├── Pending merge invite banner (Accept/Decline)
    │   ├── Net worth summary card (latest check-in)
    │   ├── "Start New Check-In" button
    │   ├── "Continue Check-In" button (if current user has one in-progress)
    │   └── Recent check-ins list
    │
    ├── Check-In Flow (multi-step wizard)
    │   ├── Step 1: Set Check-In Date
    │   ├── Step 2: For each account group (Your / Partner's / Joint):
    │   │   ├── Show account name + type + previous value hint
    │   │   ├── Input: current_value (and balance_owed for loans)
    │   │   ├── "Use Previous" button per account
    │   │   └── Values saved incrementally via PUT
    │   ├── Step 3: "Add new account?" → opens shared Add Account dialog
    │   └── Step 4: Review summary → must fill all accounts → Submit
    │
    ├── Accounts Page
    │   ├── List all accounts grouped by owner (You / Partner / Joint)
    │   ├── "+ Add" button → opens shared Add Account dialog
    │   └── Tap account → edit / deactivate
    │
    ├── History Page
    │   ├── [Overview tab]
    │   │   ├── Line chart: Net Worth + Assets + Liabilities over check-ins
    │   │   └── History table (date, net worth, change vs prior)
    │   └── [By Account tab]
    │       ├── Multi-line chart with each account as a colored line
    │       ├── Toggle chips to show/hide individual accounts
    │       └── Per-account history table grouped by date
    │
    ├── Big Costs Page (Large Expenses)
    │   ├── Subtitle explaining purpose (medical, travel, renovations)
    │   ├── List expense groups with totals
    │   ├── "+ New Group" button
    │   └── Group detail: list items, add/delete items
    │
    └── Settings Page
        ├── Profile (display name, username)
        ├── Merge Finances (invite by username or send email invite link)
        ├── Pending invites with Accept/Decline
        ├── Appearance (light/dark mode toggle)
        └── Logout
```

---

## Key Business Logic

- **Solo-first onboarding**: Every user gets a solo household on registration. They can immediately create accounts, do check-ins, and track expenses. The `get_current_user` dependency auto-creates a household if one is missing (covers legacy users). The app works fully as a single-user finance tracker until you choose to merge.
- **Merge finances flow**: User A sends invite to User B by username. B sees it on dashboard (prominent banner) and in Settings. B must accept. On accept, B's accounts, check-ins, and expense groups are re-assigned to A's household, B's old solo household is deleted, and B is added as 'partner'. Users already merged with someone else are blocked from accepting.
- **Email invite**: If the partner isn't on the platform yet, the inviter can enter their email to open a pre-filled mailto: with the app signup link.
- **Net worth calculation**: `net_worth = SUM(current_value) - SUM(balance_owed)` across all values in a check-in. Gross assets = SUM(current_value). Total liabilities = SUM(balance_owed).
- **Liability accounts** (car_loan, mortgage, loan, other_liability): `current_value` is the asset value (optional), `balance_owed` is the debt. Both can be null.
- **Copying from previous check-in**: Check-in starts empty. The backend returns `previous_values` from the last submitted check-in so the frontend shows "last value" hints. User must explicitly tap "Use Previous" per account (data_source = 'copied') or enter a new value manually.
- **Submit validation**: All accounts must have a value entered (or balance_owed for loans) before the check-in can be submitted. Submit button is disabled until all are filled.
- **Couple visibility**: Each member can see all accounts in the household (personal of both + joint). Personal accounts display which user they belong to.
- **Auth**: Custom bcrypt + JWT (PyJWT). JWT payload: `{user_id, username, couple_id}`. Token stored in localStorage. couple_id is refreshed on every authenticated request.
- **In-progress check-ins**: Both partners can have separate in-progress check-ins simultaneously.
- **Account dialog**: Same dialog used from both the Accounts page and Check-in step 3. Owner dropdown shows "Mine" when solo, adds partner name and "Joint" when merged.
- **Dark/light mode**: Toggle in Settings > Appearance. Uses Pico.css `data-theme` attribute. Preference saved to localStorage.
- **Dummy test accounts**: Adam (username: `adam`, password: `password`) and Eve (username: `eve`, password: `password`) are seeded as a couple with ~6 months of check-in history across 9 realistic accounts.

---

## Environment Variables
| Variable | Used In | Purpose |
|---|---|---|
| `SUPABASE_URL` | shared-backend | Supabase project URL (Railway) |
| `SUPABASE_SERVICE_ROLE_KEY` | shared-backend | Server-side DB access (Railway) |
| `WEALTHMATE_JWT_SECRET` | shared-backend | Signs JWT tokens (Railway) |
| `ALLOWED_ORIGINS` | shared-backend | CORS origins including Vercel URL (Railway) |
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
- 2026-03-14 — Full prototype built and deployed. Solo-first onboarding, merge finances, check-in wizard, per-account history, big costs tracker, dark/light mode.
