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
-- WHY THIS MATCHES ON NAME, NOT SIGNATURE
--   The first draft of this file wrote out all 60 signatures explicitly,
--   generated from a replay of boardgamebuddy/003–027. Running it against
--   production failed:
--
--     ERROR: 42883: function public.boardgamebuddy_search_games(uuid, text,
--            integer, boolean) does not exist
--
--   Production still has the three-argument form from archive/040; the
--   p_include_expansions parameter that archive/041 added — and that the
--   consolidated 003_rpcs.sql carries — is not there. A replay of the
--   migrations is therefore NOT byte-identical to production, and any file
--   that hardcodes argument lists is one drift away from erroring out
--   halfway through and leaving the revokes only partly applied.
--
--   So the list below is 60 function NAMES, and the loop revokes whatever
--   overloads of those names actually exist in the database it is run
--   against. The scope stays explicit and bgb-owned (it is a fixed list, not
--   a schema-wide sweep, so replaying this app alone still lands the right
--   grants), but signature drift, extra overloads and functions that were
--   never created are all handled rather than fatal. Names absent from the
--   target database are reported in a NOTICE at the end.
--
-- SAFE FOR THE APP
--   No client calls an RPC: `grep -rn "\.rpc(" projects/` is empty across
--   every web prototype and native app. supabase-js is used only for Auth,
--   Realtime and direct table reads — bgb's live-scores grid reads
--   boardgamebuddy_play_session_scores with the anon key. Every RPC call goes
--   through shared-backend, whose client is built from
--   SUPABASE_SERVICE_ROLE_KEY and so executes as `service_role`.
--
--   Function EXECUTE only. Schema USAGE and table grants for anon /
--   authenticated are untouched, so that read and the Realtime subscription
--   keep working. service_role and boardgamebuddy_role are not named in the
--   REVOKE, so their grants survive.
--
-- Idempotent: revoking an absent privilege is a no-op, and the loop skips
-- names that are not present. Safe to re-run after adding RPCs.
--
-- Any NEW SECURITY DEFINER function needs its own revoke next to its CREATE
-- and its name added here — see .claude/rules/database-supabase.md. There is
-- no default-privileges setting that covers it: Postgres hardcodes
-- EXECUTE-to-PUBLIC for new functions and ALTER DEFAULT PRIVILEGES ... REVOKE
-- cannot suppress that.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → Run
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  bgb_rpcs CONSTANT text[] := ARRAY[
    'bgb_abandon_session',
    'bgb_accept_ghost_claim',
    'bgb_add_participant',
    'bgb_advance_phase',
    'bgb_bgg_push_status',
    'bgb_bgg_sync_status',
    'bgb_bootstrap',
    'bgb_collection_page',
    'bgb_collection_shelf',
    'bgb_collection_status_map',
    'bgb_create_ghost_claim',
    'bgb_create_session',
    'bgb_delete_import_batch',
    'bgb_delete_import_group',
    'bgb_dismiss_ghost_claim',
    'bgb_distinct_mechanics',
    'bgb_dormant_collection',
    'bgb_feed_plays',
    'bgb_finalize_session',
    'bgb_game_bundles',
    'bgb_game_detail_bundle',
    'bgb_game_summary',
    'bgb_get_session',
    'bgb_ghost_claim_detail',
    'bgb_ghost_claim_suggestions',
    'bgb_ghost_claims',
    'bgb_ghost_out_of_plays',
    'bgb_ghost_summary',
    'bgb_hot_games',
    'bgb_import_plays',
    'bgb_join_session',
    'bgb_joinable_sessions',
    'bgb_link_ghost',
    'bgb_link_ghost_rows',
    'bgb_list_imports',
    'bgb_log_play',
    'bgb_mark_link_notifications_seen',
    'bgb_merge_ghosts',
    'bgb_notifications',
    'bgb_notifications_unread',
    'bgb_onboarding_buddy_suggestions',
    'bgb_onboarding_suggestion_network',
    'bgb_play_partners',
    'bgb_play_stats',
    'bgb_plays_page',
    'bgb_profile_bundle',
    'bgb_push_note_failure',
    'bgb_reject_ghost_claim',
    'bgb_remove_participant',
    'bgb_reorder_participants',
    'bgb_session_bundle',
    'bgb_session_gate',
    'bgb_set_session_scoring',
    'bgb_suggested_buddies',
    'bgb_sync_achievements',
    'bgb_update_session_game',
    'bgb_user_stats',
    'bgb_user_stats_detail',
    'bgb_watch_session',
    'boardgamebuddy_search_games'
  ];
  fn        record;
  nm        text;
  n_revoked int  := 0;
  n_open    int  := 0;
  absent    text[] := '{}';
BEGIN
  -- Report names this database does not have at all, so a genuine typo here
  -- is visible instead of silently doing nothing.
  FOREACH nm IN ARRAY bgb_rpcs LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
        JOIN pg_namespace ns ON ns.oid = p.pronamespace
       WHERE ns.nspname = 'public' AND p.proname = nm
    ) THEN
      absent := absent || nm;
    END IF;
  END LOOP;

  FOR fn IN
    SELECT p.oid,
           quote_ident(ns.nspname) || '.' || quote_ident(p.proname)
             || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.prosecdef                    -- SECURITY DEFINER only
       AND p.proname = ANY (bgb_rpcs)
     ORDER BY p.proname
  LOOP
    IF has_function_privilege('anon', fn.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', fn.oid, 'EXECUTE') THEN
      n_open := n_open + 1;
    END IF;

    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.sig);
    n_revoked := n_revoked + 1;
  END LOOP;

  RAISE NOTICE 'bgb SECURITY DEFINER functions revoked: % (% were reachable by anon/authenticated before this run)',
    n_revoked, n_open;
  IF array_length(absent, 1) > 0 THEN
    RAISE NOTICE 'listed but not present in this database: %', absent;
  END IF;
END $$;


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
-- And the backend must keep every one of them — both columns must match:
--
--   SELECT count(*) FILTER (WHERE has_function_privilege('service_role', p.oid, 'EXECUTE')) AS callable,
--          count(*) AS total
--     FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.prosecdef
--      AND (p.proname LIKE 'bgb%' OR p.proname LIKE 'boardgamebuddy%');
