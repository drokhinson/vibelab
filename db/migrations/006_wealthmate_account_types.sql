-- 006_wealthmate_account_types.sql
-- Expand account_type enum to support new categories

ALTER TABLE wealthmate_accounts
  DROP CONSTRAINT IF EXISTS wealthmate_accounts_account_type_check;

ALTER TABLE wealthmate_accounts
  ADD CONSTRAINT wealthmate_accounts_account_type_check
  CHECK (account_type IN (
    'checking_personal', 'checking_joint', 'savings',
    '401k', 'roth_ira', 'retirement_other',
    'investment',
    'property_personal', 'property_rental',
    'car_loan', 'mortgage', 'loan',
    'other', 'other_liability'
  ));
