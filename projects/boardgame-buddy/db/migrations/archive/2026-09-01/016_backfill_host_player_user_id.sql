-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Backfill player_user_id on legacy host-self play_players
--
-- Before the OOP redesign the log-play UI treated the host as an implicit
-- player. When they marked themselves as the winner, the resulting
-- play_players row carried only player_display_name (no player_user_id),
-- because the old client never sent a user_id for the host.
--
-- bgb_user_stats counts wins via player_user_id = uid, so the host's own
-- wins on those legacy rows came back as 0 even though Recent Plays still
-- showed the host's name in the winner slot (it reads is_winner directly).
--
-- This migration sets player_user_id = play.user_id on every play_players
-- row where:
--   • player_user_id is currently NULL, AND
--   • player_display_name matches the play owner's profile display_name
--     (case-insensitive, trimmed).
-- It's safe to re-run — only NULL rows are touched, and the match is
-- restricted to the play's own host.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.boardgamebuddy_play_players AS pp
SET player_user_id = p.user_id
FROM public.boardgamebuddy_plays AS p
JOIN public.boardgamebuddy_profiles AS prof ON prof.id = p.user_id
WHERE pp.play_id = p.id
  AND pp.player_user_id IS NULL
  AND pp.player_display_name IS NOT NULL
  AND LOWER(TRIM(pp.player_display_name)) = LOWER(TRIM(prof.display_name));
