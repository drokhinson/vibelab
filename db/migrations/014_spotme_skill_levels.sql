-- Drop the hardcoded proficiency CHECK constraint so hobby-specific level values
-- (e.g. 'green_circle', 'black_diamond', 'casual', 'hardcore') can be stored.
-- Validation now happens at the application layer using HOBBY_LEVEL_PRESETS.

ALTER TABLE spotme_user_hobbies
  DROP CONSTRAINT IF EXISTS spotme_user_hobbies_proficiency_check;
