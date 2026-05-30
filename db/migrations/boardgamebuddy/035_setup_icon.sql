-- 035_setup_icon.sql — swap the "Setup" chapter-type icon off the settings
-- gear (reads as app-settings) onto a box, which evokes setting the game up
-- from the box. Idempotent: re-running just re-sets the same value.

UPDATE public.boardgamebuddy_chunk_types
SET icon = 'box'
WHERE id = 'setup';
