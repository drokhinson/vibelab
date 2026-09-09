-- 022_feed_import_batch.sql — the feed learns which plays came from an import.
--
-- The Feed groups plays into session cards client-side on
-- (played_at, participant-set). That key is right for a game night: the people
-- at the table are what makes it one night. It is wrong for an IMPORT, where
-- one paste of a notebook writes plays whose rosters differ from line to line —
-- Marco and Lachie for two, Marco alone for the next four — and every distinct
-- roster becomes its own section with its own header and its own footer. A
-- single afternoon's import lands as five or six stacked sections saying almost
-- the same thing, and consumes a screen of vertical space per section.
--
-- The fix is client-side (see groupCards() in
-- projects/boardgame-buddy/web/views/feed-view.js): imported plays group on
-- (played_at, LOGGER) instead, so one person's import of one day is one section
-- headed "Marco imported 19 games". But the client cannot tell an imported play
-- from a live one — `import_group_id` is set only on plays the importer judged
-- indistinguishable from at least one other (migration 005), so every one-off
-- in a paste arrives looking exactly like a live log.
--
-- `import_batch_id` (migration 007) is the honest flag: one id per paste, on
-- EVERY row the importer wrote, one-offs included. It is already on the table
-- and already read by the run sheet and the export; this migration just puts it
-- on the feed payload alongside the group id that has ridden there since 007.
--
-- No schema change, no behavior change in SQL — one more OUT column, carried
-- straight off the `page` CTE. DROP + CREATE rather than CREATE OR REPLACE,
-- because another OUT column is a new return type.

DROP FUNCTION IF EXISTS public.bgb_feed_plays(uuid, date, timestamptz, integer);

CREATE OR REPLACE FUNCTION public.bgb_feed_plays(
  viewer uuid,
  before_played_at date DEFAULT NULL::date,
  before_created_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  lim integer DEFAULT 20
)
 RETURNS TABLE(
   play_id uuid, play_user_id uuid, play_user_name text, play_user_avatar jsonb,
   game_id uuid, game_name text, game_image_url text, game_thumbnail_url text,
   played_at date, created_at timestamp with time zone, notes text, photo_url text,
   play_mode text, winner_display_name text, participant_count integer,
   participants jsonb, group_count integer, import_group_id uuid,
   -- New in 015.
   players jsonb, expansions jsonb, country_code text,
   -- New in 016.
   reaction_count integer, viewer_reacted boolean, reactors jsonb,
   -- New in 022. The paste this play came from, or NULL for a live log.
   import_batch_id uuid
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Dynamic SQL for one reason: `lim` is interpolated as a literal instead of
  -- being bound as a parameter. With BOTH `viewer` and `lim` opaque, the
  -- planner has no idea the `page` CTE yields ~20 rows, so it plans the roster
  -- lookup as if `page` were huge and reads the whole play_players table —
  -- measured 555 ms versus 12 ms with the limit visible. Interpolating just
  -- the limit restores the estimate; viewer/cursor stay bound via USING, which
  -- is enough for a good plan. Injection-safe because `lim` is typed INT, so
  -- it cannot carry SQL, and it's clamped to a sane range below.
  --
  -- EXECUTE also sidesteps plpgsql's substitution of RETURNS TABLE column
  -- names (play_id, played_at, notes, participants, players, …) into the query
  -- body: the string is handed to the SQL engine untouched. 015 added
  -- `players` and `expansions` to that set of shadowed names, 016 added
  -- `reactors` and 022 adds `import_batch_id` — which `page` selects by name
  -- from the plays table, so the shadowing would be a live bug rather than a
  -- theoretical one. One more reason this stays EXECUTE.
  RETURN QUERY EXECUTE format($q$
  WITH visible AS (
    SELECT $1::uuid AS uid
    UNION
    SELECT CASE WHEN be.user_a = $1::uuid THEN be.user_b ELSE be.user_a END AS uid
    FROM public.boardgamebuddy_buddy_edges be
    WHERE be.status = 'accepted'
      AND $1::uuid IN (be.user_a, be.user_b)
  ),
  -- Plays the viewer themselves attended — used to widen the roster
  -- filter so non-buddy participants are exposed on cards for plays
  -- the viewer was at.
  viewer_was_at AS (
    SELECT DISTINCT pp.play_id
    FROM public.boardgamebuddy_play_players pp
    WHERE pp.player_user_id = $1::uuid
  ),
  -- Plays where at least one visible user (viewer or any accepted buddy)
  -- appears in play_players. This is the "main" visibility branch.
  attended AS (
    SELECT DISTINCT pp.play_id
    FROM public.boardgamebuddy_play_players pp
    WHERE pp.player_user_id IN (SELECT uid FROM visible)
  ),
  -- Final candidate set: legacy "logger ∈ visible" UNION attended. The
  -- legacy branch is technically subsumed by `attended` when the logger
  -- is always tagged as a participant (the standard log_play flow does
  -- this), but we keep it as a belt-and-suspenders cover for any
  -- historical rows where it isn't.
  visible_plays AS (
    SELECT p.id
    FROM public.boardgamebuddy_plays p
    JOIN visible v ON v.uid = p.user_id
    UNION
    SELECT play_id FROM attended
  ),
  -- Resolve the page BEFORE touching play_players. This is the whole point of
  -- the rewrite: the roster lookup below runs per page row, so it reads at
  -- most `lim` plays' worth of play_players instead of the entire table.
  page AS (
    SELECT p.id, p.user_id, p.game_id, p.played_at, p.created_at,
           p.notes, p.photo_url, p.play_mode, p.import_group_id,
           -- New in 022. Free: `page` already reads this row, and the column
           -- is a plain uuid on it.
           p.import_batch_id,
           p.country_code,
           -- How many plays this row stands for. 1 for everything the app has
           -- ever logged live; the run's size for an imported group.
           CASE WHEN p.import_group_id IS NULL THEN 1
                ELSE (SELECT COUNT(*)::INT
                        FROM public.boardgamebuddy_plays q
                       WHERE q.import_group_id = p.import_group_id)
           END AS group_count
    FROM public.boardgamebuddy_plays p
    JOIN visible_plays vp ON vp.id = p.id
    WHERE (
      $2::date IS NULL
      OR $3::timestamptz IS NULL
      OR (p.played_at, p.created_at) < ($2::date, $3::timestamptz)
    )
      -- Migration 005. One representative row per imported run: the lowest id
      -- in the run, so the choice is stable and deleting the representative
      -- just promotes the next row rather than losing the group.
      --
      -- ORDER BY ... LIMIT 1 rather than MIN(): Postgres has no MIN aggregate
      -- for uuid, though the type orders fine in an index.
      --
      -- This sits INSIDE `page`, before the LIMIT, on purpose: that is what
      -- makes a page 20 CARDS rather than 20 rows of which 19 are the same
      -- run. A 106-play import used to consume five pages of everyone's feed
      -- before anything else could appear.
      --
      -- Deliberately a correlated lookup on the partial index rather than a
      -- window function over the viewer's visible plays: the window is the
      -- shape migration 043 removed (105 ms -> 5 ms on a 30k-play fixture),
      -- and it would make every feed call pay for grouping that almost no row
      -- needs. Both subqueries are short-circuited by the NULL check for every
      -- play that was not imported, which is all of them but a handful.
      AND (
        p.import_group_id IS NULL
        OR p.id = (SELECT q.id
                     FROM public.boardgamebuddy_plays q
                    WHERE q.import_group_id = p.import_group_id
                    ORDER BY q.id
                    LIMIT 1)
      )
    ORDER BY p.played_at DESC, p.created_at DESC, p.id
    LIMIT %s
  )
  -- Roster + winners, resolved per page row via LATERAL rather than as
  -- page-filtered CTEs. This matters: `lim` is a function parameter, so the
  -- planner has no idea `page` yields ~20 rows. Given `pp.play_id IN (SELECT
  -- id FROM page)` it assumes `page` is large and picks a hash semi-join over
  -- the whole play_players table — twice — which measured ~8x SLOWER than the
  -- original. A LATERAL keyed on p.id is an index lookup on
  -- idx_bgb_play_players_play per page row, so the work stays bounded by `lim`
  -- no matter what the planner estimates.
  SELECT
    p.id,
    p.user_id,
    prof.display_name,
    prof.avatar,
    g.id,
    g.name,
    g.image_url,
    g.thumbnail_url,
    p.played_at,
    p.created_at,
    p.notes,
    p.photo_url,
    p.play_mode,
    roster.winner_display_name,
    COALESCE(roster.participant_count, 0),
    COALESCE(roster.participants, '[]'::jsonb),
    p.group_count,
    p.import_group_id,
    COALESCE(roster.players, '[]'::jsonb),
    COALESCE(exp.expansions, '[]'::jsonb),
    p.country_code,
    COALESCE(rx.reaction_count, 0),
    COALESCE(rx.viewer_reacted, false),
    COALESCE(rx.reactors, '[]'::jsonb),
    p.import_batch_id
  FROM page p
  JOIN public.boardgamebuddy_profiles prof ON prof.id = p.user_id
  JOIN public.boardgamebuddy_games g       ON g.id = p.game_id
  LEFT JOIN LATERAL (
    SELECT
      string_agg(
        COALESCE(pprof.display_name, pp.player_display_name), ', '
        ORDER BY COALESCE(pprof.display_name, pp.player_display_name)
      ) FILTER (WHERE pp.is_winner = true) AS winner_display_name,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'user_id',      pp.player_user_id::text,
            'display_name', COALESCE(pprof.display_name, pp.player_display_name)
          )
          ORDER BY COALESCE(pprof.display_name, pp.player_display_name)
        ) FILTER (
          WHERE pp.player_user_id IS NOT NULL
            AND (
              pp.player_user_id IN (SELECT uid FROM visible)
              OR p.id IN (SELECT play_id FROM viewer_was_at)
            )
        ),
        '[]'::jsonb
      ) AS participants,
      -- The scorecard, added by 015. UNFILTERED, unlike `participants`: this
      -- is the roster the back of the card and the detail popup draw, and both
      -- have always shown every seat — ghosts included — because that is what
      -- GET /plays/{id} returns them today.
      --
      -- Ordered by is_winner then score, both DESC NULLS LAST, so the array
      -- arrives in the order the scoreboard wants and the client's sort is a
      -- no-op on well-formed data rather than the thing that makes it correct.
      -- Field names mirror PlayPlayerResponse exactly (name, not display_name)
      -- so the FE adapter is a pass-through.
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'user_id',      pp.player_user_id::text,
            'name',         COALESCE(pprof.display_name, pp.player_display_name),
            'avatar',       pprof.avatar,
            'is_winner',    COALESCE(pp.is_winner, false),
            'score',        pp.score,
            'round_scores', pp.round_scores
          )
          ORDER BY COALESCE(pp.is_winner, false) DESC, pp.score DESC NULLS LAST
        ),
        '[]'::jsonb
      ) AS players,
      COUNT(*)::INT AS participant_count
    FROM public.boardgamebuddy_play_players pp
    LEFT JOIN public.boardgamebuddy_profiles pprof ON pprof.id = pp.player_user_id
    WHERE pp.play_id = p.id
  ) roster ON true
  -- The one genuinely new read in 015. Same LATERAL shape as the roster so it
  -- inherits the same bounded-by-`lim` property: an index lookup per page row
  -- on the (play_id, expansion_game_id) primary key. Most plays have no
  -- expansions and the aggregate collapses to NULL -> '[]'.
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
             jsonb_build_object(
               'expansion_game_id', pe.expansion_game_id::text,
               'name',              eg.name,
               'color',             eg.theme_color
             )
             ORDER BY eg.name
           ) AS expansions
    FROM public.boardgamebuddy_play_expansions pe
    JOIN public.boardgamebuddy_games eg ON eg.id = pe.expansion_game_id
    WHERE pe.play_id = p.id
  ) exp ON true
  -- Reactions, added by 016. Same bounded-by-`lim` LATERAL shape as the two
  -- above: an index lookup per page row on the (play_id, user_id) primary key.
  --
  -- `reactors` is capped at 8 and newest-first because the footer only ever
  -- draws three avatars; the exact total rides in `reaction_count`, so the cap
  -- never makes the number wrong. The viewer's own row is answered by an EXISTS
  -- rather than by scanning the capped array, which would go wrong the moment a
  -- ninth person reacted.
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::int AS reaction_count,
      bool_or(r.user_id = $1::uuid) AS viewer_reacted,
      COALESCE(
        (SELECT jsonb_agg(x)
           FROM (SELECT jsonb_build_object(
                          'user_id',      r2.user_id::text,
                          'display_name', rprof.display_name,
                          'avatar',       rprof.avatar
                        ) AS x
                   FROM public.boardgamebuddy_play_reactions r2
                   LEFT JOIN public.boardgamebuddy_profiles rprof ON rprof.id = r2.user_id
                  WHERE r2.play_id = p.id
                  ORDER BY r2.created_at DESC
                  LIMIT 8) capped),
        '[]'::jsonb
      ) AS reactors
    FROM public.boardgamebuddy_play_reactions r
    WHERE r.play_id = p.id
  ) rx ON true
  ORDER BY p.played_at DESC, p.created_at DESC, p.id
  -- The clamp bounds what a caller can interpolate. The ceiling must stay
  -- ABOVE every caller's own cap, because feed_service derives next_cursor
  -- from `len(rows) == limit` — if this silently returned fewer rows than
  -- asked for, pagination would stop early. Today /feed is capped at 50
  -- (feed_routes.py) and bootstrap asks for 20, so 100 has margin.
  $q$, LEAST(GREATEST(COALESCE(lim, 20), 1), 100))
  USING viewer, before_played_at, before_created_at;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.bgb_feed_plays(viewer uuid, before_played_at date, before_created_at timestamptz, lim integer) TO boardgamebuddy_role;
