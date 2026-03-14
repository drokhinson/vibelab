-- 008_wealthmate_recovery_code.sql
-- Add recovery_hash column for password reset via recovery code
-- Add email column for future email-based recovery
ALTER TABLE wealthmate_users ADD COLUMN recovery_hash text;
ALTER TABLE wealthmate_users ADD COLUMN email text;
