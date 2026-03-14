-- 005_wealthmate_seed.sql
-- Seed Adam and Eve as a couple with 6 months of check-in history
-- Passwords are bcrypt hashes of "password"

DO $$
DECLARE
    adam_id   uuid := gen_random_uuid();
    eve_id    uuid := gen_random_uuid();
    couple_id uuid := gen_random_uuid();

    -- Account IDs
    acc_adam_checking   uuid := gen_random_uuid();
    acc_adam_401k       uuid := gen_random_uuid();
    acc_adam_car        uuid := gen_random_uuid();
    acc_eve_checking    uuid := gen_random_uuid();
    acc_eve_investment  uuid := gen_random_uuid();
    acc_joint_checking  uuid := gen_random_uuid();
    acc_joint_savings   uuid := gen_random_uuid();
    acc_joint_house     uuid := gen_random_uuid();
    acc_joint_mortgage  uuid := gen_random_uuid();

    -- Check-in IDs (6 months, oldest → newest)
    ci_1 uuid := gen_random_uuid();
    ci_2 uuid := gen_random_uuid();
    ci_3 uuid := gen_random_uuid();
    ci_4 uuid := gen_random_uuid();
    ci_5 uuid := gen_random_uuid();
    ci_6 uuid := gen_random_uuid();

BEGIN
    -- ── Users ──────────────────────────────────────────────────────────────────
    -- Password hash for "password" using bcrypt cost 12
    INSERT INTO wealthmate_users (id, username, display_name, password_hash)
    VALUES
        (adam_id, 'adam', 'Adam',
         '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj4J/HS.iK4i'),
        (eve_id,  'eve',  'Eve',
         '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj4J/HS.iK4i');

    -- ── Couple ─────────────────────────────────────────────────────────────────
    INSERT INTO wealthmate_couples (id) VALUES (couple_id);

    INSERT INTO wealthmate_couple_members (couple_id, user_id, role)
    VALUES
        (couple_id, adam_id, 'owner'),
        (couple_id, eve_id,  'partner');

    -- ── Accounts ───────────────────────────────────────────────────────────────
    INSERT INTO wealthmate_accounts
        (id, couple_id, owner_user_id, name, account_type, url, notes, sort_order)
    VALUES
        -- Adam's personal
        (acc_adam_checking, couple_id, adam_id, 'Chase Checking (Adam)',   'checking_personal', 'https://chase.com',    'Payroll deposits here', 1),
        (acc_adam_401k,     couple_id, adam_id, 'Fidelity 401k (Adam)',    '401k',              'https://fidelity.com', '6% employer match',      2),
        (acc_adam_car,      couple_id, adam_id, 'Toyota Tacoma Loan',      'car_loan',          null,                  '2023 Tacoma — 60 month loan', 3),
        -- Eve's personal
        (acc_eve_checking,  couple_id, eve_id,  'BofA Checking (Eve)',     'checking_personal', 'https://bankofamerica.com', null, 4),
        (acc_eve_investment,couple_id, eve_id,  'Schwab Brokerage (Eve)',  'investment',        'https://schwab.com',  'Index funds — SCHB/SCHF', 5),
        -- Joint
        (acc_joint_checking,couple_id, null,    'Chase Joint Checking',    'checking_joint',    'https://chase.com',   'Bills and shared expenses', 6),
        (acc_joint_savings, couple_id, null,    'Ally HYSA',               'savings',           'https://ally.com',    'Emergency fund + house savings', 7),
        (acc_joint_house,   couple_id, null,    'Primary Residence',       'property_personal', null,                  'Zillow estimate', 8),
        (acc_joint_mortgage,couple_id, null,    'Home Mortgage',           'mortgage',          'https://chase.com',   '30yr fixed @ 6.875%', 9);

    INSERT INTO wealthmate_account_loan_details
        (account_id, original_loan_amount, interest_rate, loan_term_months, origination_date, lender_name)
    VALUES
        (acc_adam_car,      38000,   6.990, 60,  '2023-06-01', 'Toyota Financial'),
        (acc_joint_mortgage,460000,  6.875, 360, '2022-09-01', 'Chase Mortgage');

    -- ── Check-ins (6 months) ───────────────────────────────────────────────────
    INSERT INTO wealthmate_checkins
        (id, couple_id, initiated_by_user_id, checkin_date, status, submitted_at)
    VALUES
        (ci_1, couple_id, adam_id, '2025-09-30', 'submitted', '2025-10-02 19:00:00+00'),
        (ci_2, couple_id, eve_id,  '2025-10-31', 'submitted', '2025-11-03 20:00:00+00'),
        (ci_3, couple_id, adam_id, '2025-11-30', 'submitted', '2025-12-02 18:30:00+00'),
        (ci_4, couple_id, eve_id,  '2025-12-31', 'submitted', '2026-01-04 21:00:00+00'),
        (ci_5, couple_id, adam_id, '2026-01-31', 'submitted', '2026-02-02 17:00:00+00'),
        (ci_6, couple_id, eve_id,  '2026-02-28', 'submitted', '2026-03-02 20:00:00+00');

    -- ── Check-in Values ────────────────────────────────────────────────────────
    -- Sep 2025
    INSERT INTO wealthmate_checkin_values
        (checkin_id, account_id, current_value, balance_owed, data_source)
    VALUES
        (ci_1, acc_adam_checking,    4200,   null,   'manual'),
        (ci_1, acc_adam_401k,       68000,   null,   'manual'),
        (ci_1, acc_adam_car,        30000,  28400,   'manual'),
        (ci_1, acc_eve_checking,     3100,   null,   'manual'),
        (ci_1, acc_eve_investment,  42000,   null,   'manual'),
        (ci_1, acc_joint_checking,   5800,   null,   'manual'),
        (ci_1, acc_joint_savings,   31000,   null,   'manual'),
        (ci_1, acc_joint_house,    485000,   null,   'manual'),
        (ci_1, acc_joint_mortgage,   null, 441200,   'manual');

    -- Oct 2025
    INSERT INTO wealthmate_checkin_values
        (checkin_id, account_id, current_value, balance_owed, data_source)
    VALUES
        (ci_2, acc_adam_checking,    5100,   null,   'manual'),
        (ci_2, acc_adam_401k,       70200,   null,   'manual'),
        (ci_2, acc_adam_car,        29500,  27900,   'manual'),
        (ci_2, acc_eve_checking,     3400,   null,   'manual'),
        (ci_2, acc_eve_investment,  44500,   null,   'manual'),
        (ci_2, acc_joint_checking,   6200,   null,   'manual'),
        (ci_2, acc_joint_savings,   32500,   null,   'manual'),
        (ci_2, acc_joint_house,    485000,   null,   'copied'),
        (ci_2, acc_joint_mortgage,   null, 440700,   'manual');

    -- Nov 2025
    INSERT INTO wealthmate_checkin_values
        (checkin_id, account_id, current_value, balance_owed, data_source)
    VALUES
        (ci_3, acc_adam_checking,    3800,   null,   'manual'),
        (ci_3, acc_adam_401k,       72800,   null,   'manual'),
        (ci_3, acc_adam_car,        29000,  27400,   'manual'),
        (ci_3, acc_eve_checking,     2900,   null,   'manual'),
        (ci_3, acc_eve_investment,  46000,   null,   'manual'),
        (ci_3, acc_joint_checking,   4500,   null,   'manual'),
        (ci_3, acc_joint_savings,   34000,   null,   'manual'),
        (ci_3, acc_joint_house,    490000,   null,   'manual'),
        (ci_3, acc_joint_mortgage,   null, 440200,   'manual');

    -- Dec 2025
    INSERT INTO wealthmate_checkin_values
        (checkin_id, account_id, current_value, balance_owed, data_source)
    VALUES
        (ci_4, acc_adam_checking,    6500,   null,   'manual'),
        (ci_4, acc_adam_401k,       74100,   null,   'manual'),
        (ci_4, acc_adam_car,        28500,  26900,   'manual'),
        (ci_4, acc_eve_checking,     4200,   null,   'manual'),
        (ci_4, acc_eve_investment,  49800,   null,   'manual'),
        (ci_4, acc_joint_checking,   7100,   null,   'manual'),
        (ci_4, acc_joint_savings,   36000,   null,   'manual'),
        (ci_4, acc_joint_house,    490000,   null,   'copied'),
        (ci_4, acc_joint_mortgage,   null, 439700,   'manual');

    -- Jan 2026
    INSERT INTO wealthmate_checkin_values
        (checkin_id, account_id, current_value, balance_owed, data_source)
    VALUES
        (ci_5, acc_adam_checking,    4900,   null,   'manual'),
        (ci_5, acc_adam_401k,       76500,   null,   'manual'),
        (ci_5, acc_adam_car,        28000,  26400,   'manual'),
        (ci_5, acc_eve_checking,     3600,   null,   'manual'),
        (ci_5, acc_eve_investment,  52100,   null,   'manual'),
        (ci_5, acc_joint_checking,   5900,   null,   'manual'),
        (ci_5, acc_joint_savings,   38000,   null,   'manual'),
        (ci_5, acc_joint_house,    492000,   null,   'manual'),
        (ci_5, acc_joint_mortgage,   null, 439200,   'manual');

    -- Feb 2026
    INSERT INTO wealthmate_checkin_values
        (checkin_id, account_id, current_value, balance_owed, data_source)
    VALUES
        (ci_6, acc_adam_checking,    5500,   null,   'manual'),
        (ci_6, acc_adam_401k,       78200,   null,   'manual'),
        (ci_6, acc_adam_car,        27500,  25900,   'manual'),
        (ci_6, acc_eve_checking,     4100,   null,   'manual'),
        (ci_6, acc_eve_investment,  54300,   null,   'manual'),
        (ci_6, acc_joint_checking,   6400,   null,   'manual'),
        (ci_6, acc_joint_savings,   40000,   null,   'manual'),
        (ci_6, acc_joint_house,    495000,   null,   'manual'),
        (ci_6, acc_joint_mortgage,   null, 438700,   'manual');

    -- ── Sample Expense Group ────────────────────────────────────────────────────
    INSERT INTO wealthmate_expense_groups (couple_id, name, description)
    VALUES (couple_id, 'Spain Trip 2025', 'Summer vacation — Barcelona & Madrid');

END $$;
