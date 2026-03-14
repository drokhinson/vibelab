-- 004_wealthmate_schema.sql
-- WealthMate: couples wealth tracking app
-- Run in Supabase dashboard → SQL Editor → New Query → Run

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE wealthmate_users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username      text UNIQUE NOT NULL,
    display_name  text NOT NULL DEFAULT '',
    password_hash text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Couples ───────────────────────────────────────────────────────────────────
CREATE TABLE wealthmate_couples (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wealthmate_couple_members (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    couple_id uuid NOT NULL REFERENCES wealthmate_couples(id) ON DELETE CASCADE,
    user_id   uuid NOT NULL REFERENCES wealthmate_users(id) ON DELETE CASCADE,
    role      text NOT NULL CHECK (role IN ('owner', 'partner')),
    joined_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id)  -- one couple per user at a time
);

-- ── Invitations ───────────────────────────────────────────────────────────────
CREATE TABLE wealthmate_invitations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user_id uuid NOT NULL REFERENCES wealthmate_users(id) ON DELETE CASCADE,
    to_username  text NOT NULL,
    couple_id    uuid NOT NULL REFERENCES wealthmate_couples(id) ON DELETE CASCADE,
    status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Accounts ──────────────────────────────────────────────────────────────────
CREATE TABLE wealthmate_accounts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    couple_id     uuid NOT NULL REFERENCES wealthmate_couples(id) ON DELETE CASCADE,
    owner_user_id uuid REFERENCES wealthmate_users(id) ON DELETE SET NULL,  -- null = joint
    name          text NOT NULL,
    account_type  text NOT NULL CHECK (account_type IN (
                      'checking_personal', 'checking_joint', 'savings',
                      '401k', 'investment', 'property_personal', 'property_rental',
                      'car_loan', 'mortgage', 'other'
                  )),
    url           text,
    notes         text,
    is_active     boolean NOT NULL DEFAULT true,
    sort_order    int NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wealthmate_account_loan_details (
    account_id           uuid PRIMARY KEY REFERENCES wealthmate_accounts(id) ON DELETE CASCADE,
    original_loan_amount numeric(14,2),
    interest_rate        numeric(6,3),  -- e.g. 6.500
    loan_term_months     int,
    origination_date     date,
    lender_name          text
);

-- ── Check-ins ─────────────────────────────────────────────────────────────────
CREATE TABLE wealthmate_checkins (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    couple_id            uuid NOT NULL REFERENCES wealthmate_couples(id) ON DELETE CASCADE,
    initiated_by_user_id uuid NOT NULL REFERENCES wealthmate_users(id),
    checkin_date         date NOT NULL,
    status               text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted')),
    created_at           timestamptz NOT NULL DEFAULT now(),
    submitted_at         timestamptz
);

CREATE TABLE wealthmate_checkin_values (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    checkin_id    uuid NOT NULL REFERENCES wealthmate_checkins(id) ON DELETE CASCADE,
    account_id    uuid NOT NULL REFERENCES wealthmate_accounts(id) ON DELETE CASCADE,
    current_value numeric(14,2),   -- asset value (optional for liabilities)
    balance_owed  numeric(14,2),   -- debt remaining (for loans/mortgages)
    data_source   text NOT NULL DEFAULT 'manual' CHECK (data_source IN ('manual', 'copied')),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (checkin_id, account_id)
);

-- ── Large Expenses (add-on) ───────────────────────────────────────────────────
CREATE TABLE wealthmate_expense_groups (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    couple_id   uuid NOT NULL REFERENCES wealthmate_couples(id) ON DELETE CASCADE,
    name        text NOT NULL,
    description text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wealthmate_expense_items (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id    uuid NOT NULL REFERENCES wealthmate_expense_groups(id) ON DELETE CASCADE,
    description text NOT NULL,
    amount      numeric(14,2) NOT NULL,
    item_date   date,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX ON wealthmate_accounts(couple_id);
CREATE INDEX ON wealthmate_checkins(couple_id, status);
CREATE INDEX ON wealthmate_checkin_values(checkin_id);
CREATE INDEX ON wealthmate_expense_groups(couple_id);
