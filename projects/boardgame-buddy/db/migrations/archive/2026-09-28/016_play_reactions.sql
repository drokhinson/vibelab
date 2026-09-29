-- 016_play_reactions.sql — "Good game": a reaction on a play, shown per session.
--
-- The feed has never had a way to answer anything. This adds one, and the whole
-- design turns on a fact about what a "session" actually is.
--
-- WHY THE ROW IS KEYED ON A PLAY, NOT A SESSION. The feed groups plays into
-- session cards client-side, in feed-view.js `sessionKey()`, as
-- `played_at | participants[].user_id`. Every part of that is unstable as an
-- identity: `participants` is VIEWER-FILTERED by this very function (see the
-- roster LATERAL below), so two viewers compute different keys for the same
-- plays and would write different rows for the same night; the id list is
-- ordered by display name, so a rename re-keys history; and the grouping map is
-- rebuilt per page, so a night spanning a pagination boundary becomes two
-- sessions. It is a rendering convenience, not a key.
--
-- Nor does the live-session table rescue it. boardgamebuddy_play_sessions holds
-- ONE game_id and ONE finalized_play_id, and bgb_create_session abandons the
-- host's other open sessions — so a three-game night through the live flow is
-- three sessions with three codes. The DB models a ROUND; the feed renders a
-- NIGHT. And /log-play and BGG import create no session row at all.
--
-- So `play_id` is the only stable, viewer-independent id on the feed. A tap on
-- the session footer fans out to one row per play in that night, sharing one
-- `reaction_group_id` so the write stays one logical act — which is what lets a
-- future notification say "Priya said good game" once rather than three times.
-- The session stays what it already is everywhere else in this app: a
-- presentation-layer grouping.
--
-- WHY THE TABLE IS NAMED `reactions` AND THE BUTTON SAYS "Good game". The row
-- means "this person said good game to this play". Naming the table after the
-- label would need a migration the day the wording changes, and `good_games`
-- reads as *games that are good*. No `kind` column until a second reaction
-- actually exists — this table has exactly one meaning today.
--
-- NOT A NEW DISCLOSURE. Who reacted is only ever shown to people who can
-- already see the play, and feed visibility is gated by `visible_plays` below.

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_reactions (
  play_id           UUID NOT NULL,
  user_id           UUID NOT NULL,
  -- One per TAP, shared by every row that tap wrote. A session footer covering
  -- three plays writes three rows carrying the same group id, so the write can
  -- be read back as one act. Not unique: it is a grouping key, not an identity.
  reaction_group_id UUID NOT NULL DEFAULT gen_random_uuid(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One reaction per person per play, which makes the write idempotent by
  -- construction: the endpoint inserts ON CONFLICT DO NOTHING and a double-tap
  -- costs nothing.
  CONSTRAINT boardgamebuddy_play_reactions_pkey PRIMARY KEY (play_id, user_id),
  CONSTRAINT boardgamebuddy_play_reactions_play_id_fkey FOREIGN KEY (play_id)
    REFERENCES boardgamebuddy_plays(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_play_reactions_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
ALTER TABLE public.boardgamebuddy_play_reactions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_reactions TO boardgamebuddy_role;

-- For the future notification arm, which groups a night's rows back into one
-- entry. Useless to the feed reads below (they go through the PK), so it exists
-- for that consumer alone and is cheap enough to add now rather than in the
-- migration that needs it.
CREATE INDEX IF NOT EXISTS idx_bgb_play_reactions_group
  ON public.boardgamebuddy_play_reactions USING btree (reaction_group_id);

-- Who reacted, for the avatar stack — the profile join in the LATERAL below.
CREATE INDEX IF NOT EXISTS idx_bgb_play_reactions_user
  ON public.boardgamebuddy_play_reactions USING btree (user_id);

COMMENT ON TABLE public.boardgamebuddy_play_reactions IS
  'One "good game" from one person to one play. A session footer tap fans out to every play in that night sharing one reaction_group_id, because the feed session is a client-side grouping with no stable id — see migration 016.';

-- ── The feed RPC gains three columns ────────────────────────────────────────
-- DROP + CREATE, not CREATE OR REPLACE: more OUT columns is a new return type.

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
   reaction_count integer, viewer_reacted boolean, reactors jsonb
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
  -- `players` and `expansions` to that set of shadowed names and 016 adds
  -- `reactors`, which is one more reason this stays EXECUTE rather than a
  -- plain RETURN QUERY.
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
    COALESCE(rx.reactors, '[]'::jsonb)
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
