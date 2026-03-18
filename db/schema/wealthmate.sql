-- ─────────────────────────────────────────────────────────────────────────────
-- WealthMate — current schema snapshot
-- Last updated: migration 026
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.wealthmate_users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT        UNIQUE NOT NULL,
  display_name  TEXT        NOT NULL DEFAULT '',
  password_hash TEXT        NOT NULL,
  recovery_hash TEXT,
  email         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.wealthmate_users ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.wealthmate_couples (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.wealthmate_couples ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.wealthmate_couple_members (
  id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id UUID        NOT NULL REFERENCES public.wealthmate_couples(id) ON DELETE CASCADE,
  user_id   UUID        NOT NULL REFERENCES public.wealthmate_users(id)   ON DELETE CASCADE,
  role      TEXT        NOT NULL CHECK (role IN ('owner', 'partner')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);
ALTER TABLE public.wealthmate_couple_members ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.wealthmate_invitations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id UUID        NOT NULL REFERENCES public.wealthmate_users(id)   ON DELETE CASCADE,
  to_username  TEXT        NOT NULL,
  couple_id    UUID        NOT NULL REFERENCES public.wealthmate_couples(id) ON DELETE CASCADE,
  status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.wealthmate_invitations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.wealthmate_accounts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id     UUID        NOT NULL REFERENCES public.wealthmate_couples(id) ON DELETE CASCADE,
  owner_user_id UUID        REFERENCES public.wealthmate_users(id) ON DELETE SET NULL,
  name          TEXT        NOT NULL,
  account_type  TEXT        NOT NULL CHECK (account_type IN (
                                'checking_personal', 'checking_joint', 'savings',
                                '401k', 'investment', 'property_personal', 'property_rental',
                                'car_loan', 'mortgage', 'other'
                            )),
  url           TEXT,
  notes         TEXT,
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  sort_order    INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.wealthmate_accounts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.wealthmate_account_loan_details (
  account_id           UUID        PRIMARY KEY REFERENCES public.wealthmate_accounts(id) ON DELETE CASCADE,
  original_loan_amount NUMERIC(14,2),
  interest_rate        NUMERIC(6,3),
  loan_term_months     INT,
  origination_date     DATE,
  lender_name          TEXT
);
ALTER TABLE public.wealthmate_account_loan_details ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.wealthmate_checkins (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id            UUID        NOT NULL REFERENCES public.wealthmate_couples(id) ON DELETE CASCADE,
  initiated_by_user_id UUID        NOT NULL REFERENCES public.wealthmate_users(id),
  checkin_date         DATE        NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at         TIMESTAMPTZ
);
ALTER TABLE public.wealthmate_checkins ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.wealthmate_checkin_values (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  checkin_id    UUID        NOT NULL REFERENCES public.wealthmate_checkins(id) ON DELETE CASCADE,
  account_id    UUID        NOT NULL REFERENCES public.wealthmate_accounts(id) ON DELETE CASCADE,
  current_value NUMERIC(14,2),
  balance_owed  NUMERIC(14,2),
  data_source   TEXT        NOT NULL DEFAULT 'manual' CHECK (data_source IN ('manual', 'copied')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (checkin_id, account_id)
);
ALTER TABLE public.wealthmate_checkin_values ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.wealthmate_expense_groups (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id   UUID        NOT NULL REFERENCES public.wealthmate_couples(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.wealthmate_expense_groups ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.wealthmate_expense_items (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID        NOT NULL REFERENCES public.wealthmate_expense_groups(id) ON DELETE CASCADE,
  description TEXT        NOT NULL,
  amount      NUMERIC(14,2) NOT NULL,
  item_date   DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.wealthmate_expense_items ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.wealthmate_recurring_expenses (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id  UUID        NOT NULL REFERENCES public.wealthmate_couples(id),
  name       TEXT        NOT NULL,
  amount     NUMERIC     NOT NULL,
  frequency  TEXT        NOT NULL DEFAULT 'monthly',
  category   TEXT        NOT NULL DEFAULT 'other',
  start_date DATE,
  is_active  BOOLEAN     NOT NULL DEFAULT true,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.wealthmate_recurring_expenses ENABLE ROW LEVEL SECURITY;
