-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — revoke anon/authenticated EXECUTE on SECURITY DEFINER RPCs
-- Clears Supabase's "Public Can Execute SECURITY DEFINER Function" warnings
-- for every bgb RPC.
--
-- WHY
--   A SECURITY DEFINER function runs as its owner — `postgres` on Supabase,
--   effectively superuser — and bypasses RLS by design. Three defaults stack:
--
--     1. CREATE FUNCTION grants EXECUTE to PUBLIC automatically.
--     2. Supabase's stock default privileges additionally
--        GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role.
--     3. PostgREST publishes every public-schema function at
--        /rest/v1/rpc/<name>, reachable by `anon` with the publishable anon
--        key — the key that ships inside our frontend bundles.
--
--   So anyone could POST /rest/v1/rpc/bgb_log_play with p_user set to any
--   uuid they liked and have it execute with owner privileges. RLS does not
--   help: SECURITY DEFINER is precisely what steps around it.
--
-- NAMING anon AND authenticated IS THE POINT
--   `REVOKE ... FROM PUBLIC` alone does NOT clear this. It drops only the
--   PUBLIC entry, while the grants Supabase's default privileges handed anon
--   and authenticated are separate, direct ACL entries that survive it:
--
--     {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--                          ^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^ left behind
--
--   travelscrapbook/015 already revokes all three, which is why its RPCs were
--   the only SECURITY DEFINER functions in the database not flagged.
--
-- SAFE FOR THE APP
--   No client calls an RPC: `grep -rn "\.rpc(" projects/` is empty across
--   every web prototype and native app. supabase-js is used only for Auth,
--   Realtime and direct table reads — bgb's live-scores grid reads
--   boardgamebuddy_play_session_scores with the anon key. Every RPC call goes
--   through shared-backend, whose client is built from
--   SUPABASE_SERVICE_ROLE_KEY and so executes as `service_role`.
--
--   This file touches function EXECUTE only. Schema USAGE and table grants for
--   anon / authenticated are untouched, so that read and the Realtime
--   subscription keep working. service_role keeps EXECUTE (its ACL entry is
--   not named here), and so does boardgamebuddy_role, which 003_rpcs.sql
--   grants for psql / TablePlus access.
--
-- Covers the 60 SECURITY DEFINER functions defined by boardgamebuddy/003–027.
-- Signatures were generated from pg_proc (oid::regprocedure) against a replay
-- of those migrations, not typed by hand. Idempotent: revoking an absent
-- privilege is a no-op.
--
-- Any NEW SECURITY DEFINER function needs its own revoke next to its CREATE —
-- see .claude/rules/database-supabase.md. There is no default-privileges
-- setting that covers it: Postgres hardcodes EXECUTE-to-PUBLIC for new
-- functions and ALTER DEFAULT PRIVILEGES ... REVOKE cannot suppress that.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────


REVOKE EXECUTE ON FUNCTION public.bgb_abandon_session(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_accept_ghost_claim(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_add_participant(uuid, text, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_advance_phase(uuid, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_bgg_push_status(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_bgg_sync_status(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_bootstrap(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_collection_page(uuid, uuid, text, text, integer, integer, integer, text, boolean, text, boolean, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_collection_shelf(uuid, uuid, text, boolean, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_collection_status_map(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_create_ghost_claim(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_create_session(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_delete_import_batch(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_delete_import_group(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_dismiss_ghost_claim(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_distinct_mechanics()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_dormant_collection(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_feed_plays(uuid, date, timestamp with time zone, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_finalize_session(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_game_bundles(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_game_detail_bundle(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_game_summary(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_get_session(text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claim_detail(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claim_suggestions(uuid, integer, real)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_claims(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_out_of_plays(uuid, uuid[], uuid[], uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_ghost_summary(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_hot_games(integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_import_plays(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_join_session(text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_joinable_sessions(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_link_ghost(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_link_ghost_rows(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_list_imports(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_log_play(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_mark_link_notifications_seen(uuid, timestamp with time zone)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_merge_ghosts(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_notifications(uuid, integer, timestamp with time zone, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_notifications_unread(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_onboarding_buddy_suggestions(uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_onboarding_suggestion_network(uuid, uuid[], integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_play_partners(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_play_stats(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_plays_page(uuid, integer, integer, uuid, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_profile_bundle(uuid, uuid, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_push_note_failure(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_reject_ghost_claim(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_remove_participant(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_reorder_participants(uuid, text, uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_session_bundle(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_session_gate(text, uuid, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_set_session_scoring(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_suggested_buddies(uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_sync_achievements(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_update_session_game(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_user_stats(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_user_stats_detail(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bgb_watch_session(text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.boardgamebuddy_search_games(uuid, text, integer, boolean)
  FROM PUBLIC, anon, authenticated;


-- ── Verification ────────────────────────────────────────────────────────────
-- Must return zero rows — the linter's own question, asked directly:
--
--   SELECT p.oid::regprocedure AS still_exposed
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.prosecdef
--      AND (p.proname LIKE 'bgb%' OR p.proname LIKE 'boardgamebuddy%')
--      AND (has_function_privilege('anon',          p.oid, 'EXECUTE')
--        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
--    ORDER BY 1;
--
-- And the backend must keep all 60 — both columns must read 60:
--
--   SELECT count(*) FILTER (WHERE has_function_privilege('service_role', p.oid, 'EXECUTE')) AS callable,
--          count(*) AS total
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.prosecdef
--      AND (p.proname LIKE 'bgb%' OR p.proname LIKE 'boardgamebuddy%');
