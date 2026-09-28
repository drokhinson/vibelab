-- ─────────────────────────────────────────────────────────────────────────────
-- 058_rank_deferrals.sql — "Rank after next play": park an unranked game until
--                          the player has played it again
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The ranking gut check (Love it / A good game / Not for me) has a fourth
-- answer for a game the player cannot judge yet. The game stays unranked, but
-- it stops counting toward the Collection's "N unranked" nudge and sits at the
-- foot of the Unranked games list, which the Start walk passes over.
--
-- 1. boardgamebuddy_rank_deferrals. One row per (user, game), stamped when the
--    player parked it. Written by PUT /ranks/games/{id}/defer, deleted when the
--    game is ranked. Service-role only, like boardgamebuddy_game_ranks: RLS on,
--    no policies, SELECT for boardgamebuddy_role.
--
-- 2. bgb_rank_deferrals_active. A deferral is not cleared by a write: it lapses
--    by itself once the player plays the game again, so nothing on the play
--    paths (logging, seating, importing, the BGG worker) has to know about it.
--    It is active while no play the player can see — logged by them or seated
--    in, the bgb_play_stats rule — was both CREATED after the stamp and PLAYED
--    on or after its date. The second half keeps an import of old plays from
--    reading as "played it again". A lapsed row is left in place; the game
--    simply reads as unranked again, and ranking it deletes the row.
--
-- Deploy order: run this before the API — the queue calls the RPC on every
-- read of GET /ranks/queue.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. The deferrals table ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_rank_deferrals (
  user_id     UUID        NOT NULL,
  game_id     UUID        NOT NULL,
  deferred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT boardgamebuddy_rank_deferrals_pkey PRIMARY KEY (user_id, game_id),
  CONSTRAINT boardgamebuddy_rank_deferrals_user_fkey FOREIGN KEY (user_id)
    REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_rank_deferrals_game_fkey FOREIGN KEY (game_id)
    REFERENCES public.boardgamebuddy_games(id) ON DELETE CASCADE
);
ALTER TABLE public.boardgamebuddy_rank_deferrals ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_rank_deferrals TO boardgamebuddy_role;

COMMENT ON TABLE public.boardgamebuddy_rank_deferrals IS
  'Unranked games a player chose to rank after their next play (migration 058). Active until a play the player can see is created after deferred_at and played on or after its date — see bgb_rank_deferrals_active. Written by PUT /ranks/games/{id}/defer, deleted when the game is ranked.';


-- ── 2. Which deferrals still hold ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgb_rank_deferrals_active(p_viewer uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(d.game_id), '[]'::jsonb)
  FROM boardgamebuddy_rank_deferrals d
  WHERE d.user_id = p_viewer
    AND NOT EXISTS (
      SELECT 1 FROM boardgamebuddy_plays p
      WHERE p.game_id = d.game_id
        AND p.created_at > d.deferred_at
        AND p.played_at >= d.deferred_at::date
        AND (p.user_id = p_viewer
             OR EXISTS (
                  SELECT 1 FROM boardgamebuddy_play_players pp
                  WHERE pp.play_id = p.id AND pp.player_user_id = p_viewer)));
$function$;

-- Naming PUBLIC alone does not close this — see 028 and 051.
REVOKE EXECUTE ON FUNCTION public.bgb_rank_deferrals_active(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.bgb_rank_deferrals_active(uuid) TO service_role;

COMMENT ON FUNCTION public.bgb_rank_deferrals_active(uuid) IS
  'The game ids p_viewer parked with "Rank after next play" and has not played since (migration 058), as a JSONB array. Called by GET /api/v1/boardgame_buddy/ranks/queue.';

COMMIT;
