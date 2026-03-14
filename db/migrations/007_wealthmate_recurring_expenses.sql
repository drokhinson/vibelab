-- 007_wealthmate_recurring_expenses.sql
-- Monthly recurring expenses (bills, subscriptions, etc.)

CREATE TABLE wealthmate_recurring_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  couple_id uuid NOT NULL REFERENCES wealthmate_couples(id),
  name text NOT NULL,
  amount numeric NOT NULL,
  frequency text NOT NULL DEFAULT 'monthly',        -- monthly, yearly, quarterly, weekly
  category text NOT NULL DEFAULT 'other',            -- housing, subscription, insurance, utilities, transportation, food, other
  start_date date,
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wealthmate_recurring_expenses_couple
  ON wealthmate_recurring_expenses(couple_id);
