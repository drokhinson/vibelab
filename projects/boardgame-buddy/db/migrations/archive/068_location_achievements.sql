-- 068_location_achievements.sql — the Achievements spoke learns where you played.
--
-- Migration 065 added boardgamebuddy_plays.country_code and said outright that
-- it "feeds a future popularity-by-country view and nothing today". This is its
-- first reader: three badges in a fifth group, On the road.
--
--   • Border Hopper    — plays in 2 different countries
--   • Globe Trotter    — plays on 2 different continents
--   • Country Counter  — plays in 5 different countries
--
-- EVERYONE STARTS AT ZERO, and that is the design, not an oversight. Every play
-- logged before 065 has a NULL country and none can be invented for it — the
-- host's timezone today says nothing about where they were in 2023, and a
-- backfill would label a decade of history with wherever somebody happens to
-- live now. 065 refused to guess for exactly this reason; so does this. The
-- badges fill forwards, from the next play onward.
--
-- WHY A CONTINENT TABLE. Nothing in the repo maps a country to a continent, and
-- the mapping has to live SOMEWHERE the SQL can join to. Per
-- .claude/rules/database-supabase.md ("data belongs in the database") that is
-- rows, not a 247-branch CASE buried in a function body: a disputed assignment
-- is then an UPDATE, not a redeploy of the whole RPC.
--
-- WHICH PLAYS COUNT. The same visibility rule 062 settled on for every other
-- metric: a play counts when you LOGGED it or when you appear on it as a
-- participant. A play's country is a fact about the evening, not about who
-- typed it in, so a guest at a table in Berlin has been to Germany just as much
-- as the host who logged it.

BEGIN;


-- ── 1. The country → continent table ─────────────────────────────────────────
-- Two columns and no continent NAME, deliberately: no surface prints one today,
-- and seven labels repeated 247 times is a column waiting to drift out of step
-- with itself. Add it in the migration that first needs to display one.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_countries (
  code      TEXT PRIMARY KEY CHECK (code ~ '^[A-Z]{2}$'),
  continent TEXT NOT NULL CHECK (continent IN ('AF','AN','AS','EU','NA','OC','SA'))
);
ALTER TABLE public.boardgamebuddy_countries ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_countries TO boardgamebuddy_role;

COMMENT ON TABLE public.boardgamebuddy_countries IS
  'ISO 3166-1 alpha-2 → continent, for the location achievements (migration '
  '068). The code set is exactly the one web/domain/geo-data.js can produce, so '
  'no country the app can detect or offer is missing a continent.';


-- ── 2. Seed: all 247 countries the app knows ─────────────────────────────────
-- The code list is not hand-written — it is the key set of geo-data.js's
-- zonesByCountry table, which is BOTH the app's detection table and the country
-- picker's list, so it is the complete universe of values any client can send:
--
--   awk '/zonesByCountry: `/,/^`,/' projects/boardgame-buddy/web/domain/geo-data.js \
--     | grep -oE '^[A-Z]{2} ' | tr -d ' ' | sort
--
-- Regenerate the same way after a tzdata refresh adds a country.
--
-- TRANSCONTINENTAL COUNTRIES get one continent each, because the metric is
-- COUNT(DISTINCT continent) and a country in two of them would hand somebody
-- Globe Trotter for a single evening at home. The picks follow the conventional
-- ISO/UN-derived assignment rather than geography-by-landmass:
--   RU → EU   (population and capital, though most of the landmass is Asian)
--   TR → AS,  CY → AS,  AM → AS,  AZ → AS,  GE → AS,  KZ → AS
--   EG → AF   (Sinai is Asian; the country is counted African)
--   AQ → AN,  GS → AN,  TF → AN   (the polar territories)
--   UM → OC   (US Minor Outlying Islands: Midway and Wake)
--   EH → AF   (Western Sahara)
INSERT INTO public.boardgamebuddy_countries (code, continent)
VALUES
  -- Africa (58)
  ('AO','AF'), ('BF','AF'), ('BI','AF'), ('BJ','AF'), ('BW','AF'), ('CD','AF'), ('CF','AF'), ('CG','AF'),
  ('CI','AF'), ('CM','AF'), ('CV','AF'), ('DJ','AF'), ('DZ','AF'), ('EG','AF'), ('EH','AF'), ('ER','AF'),
  ('ET','AF'), ('GA','AF'), ('GH','AF'), ('GM','AF'), ('GN','AF'), ('GQ','AF'), ('GW','AF'), ('KE','AF'),
  ('KM','AF'), ('LR','AF'), ('LS','AF'), ('LY','AF'), ('MA','AF'), ('MG','AF'), ('ML','AF'), ('MR','AF'),
  ('MU','AF'), ('MW','AF'), ('MZ','AF'), ('NA','AF'), ('NE','AF'), ('NG','AF'), ('RE','AF'), ('RW','AF'),
  ('SC','AF'), ('SD','AF'), ('SH','AF'), ('SL','AF'), ('SN','AF'), ('SO','AF'), ('SS','AF'), ('ST','AF'),
  ('SZ','AF'), ('TD','AF'), ('TG','AF'), ('TN','AF'), ('TZ','AF'), ('UG','AF'), ('YT','AF'), ('ZA','AF'),
  ('ZM','AF'), ('ZW','AF'),
  -- Antarctica (3)
  ('AQ','AN'), ('GS','AN'), ('TF','AN'),
  -- Asia (54)
  ('AE','AS'), ('AF','AS'), ('AM','AS'), ('AZ','AS'), ('BD','AS'), ('BH','AS'), ('BN','AS'), ('BT','AS'),
  ('CC','AS'), ('CN','AS'), ('CX','AS'), ('CY','AS'), ('GE','AS'), ('HK','AS'), ('ID','AS'), ('IL','AS'),
  ('IN','AS'), ('IO','AS'), ('IQ','AS'), ('IR','AS'), ('JO','AS'), ('JP','AS'), ('KG','AS'), ('KH','AS'),
  ('KP','AS'), ('KR','AS'), ('KW','AS'), ('KZ','AS'), ('LA','AS'), ('LB','AS'), ('LK','AS'), ('MM','AS'),
  ('MN','AS'), ('MO','AS'), ('MV','AS'), ('MY','AS'), ('NP','AS'), ('OM','AS'), ('PH','AS'), ('PK','AS'),
  ('PS','AS'), ('QA','AS'), ('SA','AS'), ('SG','AS'), ('SY','AS'), ('TH','AS'), ('TJ','AS'), ('TL','AS'),
  ('TM','AS'), ('TR','AS'), ('TW','AS'), ('UZ','AS'), ('VN','AS'), ('YE','AS'),
  -- Europe (51)
  ('AD','EU'), ('AL','EU'), ('AT','EU'), ('AX','EU'), ('BA','EU'), ('BE','EU'), ('BG','EU'), ('BY','EU'),
  ('CH','EU'), ('CZ','EU'), ('DE','EU'), ('DK','EU'), ('EE','EU'), ('ES','EU'), ('FI','EU'), ('FO','EU'),
  ('FR','EU'), ('GB','EU'), ('GG','EU'), ('GI','EU'), ('GR','EU'), ('HR','EU'), ('HU','EU'), ('IE','EU'),
  ('IM','EU'), ('IS','EU'), ('IT','EU'), ('JE','EU'), ('LI','EU'), ('LT','EU'), ('LU','EU'), ('LV','EU'),
  ('MC','EU'), ('MD','EU'), ('ME','EU'), ('MK','EU'), ('MT','EU'), ('NL','EU'), ('NO','EU'), ('PL','EU'),
  ('PT','EU'), ('RO','EU'), ('RS','EU'), ('RU','EU'), ('SE','EU'), ('SI','EU'), ('SJ','EU'), ('SK','EU'),
  ('SM','EU'), ('UA','EU'), ('VA','EU'),
  -- North America (41)
  ('AG','NA'), ('AI','NA'), ('AW','NA'), ('BB','NA'), ('BL','NA'), ('BM','NA'), ('BQ','NA'), ('BS','NA'),
  ('BZ','NA'), ('CA','NA'), ('CR','NA'), ('CU','NA'), ('CW','NA'), ('DM','NA'), ('DO','NA'), ('GD','NA'),
  ('GL','NA'), ('GP','NA'), ('GT','NA'), ('HN','NA'), ('HT','NA'), ('JM','NA'), ('KN','NA'), ('KY','NA'),
  ('LC','NA'), ('MF','NA'), ('MQ','NA'), ('MS','NA'), ('MX','NA'), ('NI','NA'), ('PA','NA'), ('PM','NA'),
  ('PR','NA'), ('SV','NA'), ('SX','NA'), ('TC','NA'), ('TT','NA'), ('US','NA'), ('VC','NA'), ('VG','NA'),
  ('VI','NA'),
  -- Oceania (26)
  ('AS','OC'), ('AU','OC'), ('CK','OC'), ('FJ','OC'), ('FM','OC'), ('GU','OC'), ('KI','OC'), ('MH','OC'),
  ('MP','OC'), ('NC','OC'), ('NF','OC'), ('NR','OC'), ('NU','OC'), ('NZ','OC'), ('PF','OC'), ('PG','OC'),
  ('PN','OC'), ('PW','OC'), ('SB','OC'), ('TK','OC'), ('TO','OC'), ('TV','OC'), ('UM','OC'), ('VU','OC'),
  ('WF','OC'), ('WS','OC'),
  -- South America (14)
  ('AR','SA'), ('BO','SA'), ('BR','SA'), ('CL','SA'), ('CO','SA'), ('EC','SA'), ('FK','SA'), ('GF','SA'),
  ('GY','SA'), ('PE','SA'), ('PY','SA'), ('SR','SA'), ('UY','SA'), ('VE','SA')
ON CONFLICT (code) DO UPDATE
  SET continent = EXCLUDED.continent;


-- ── 3. The group ─────────────────────────────────────────────────────────────
-- display_order 15 slots On the road between At the table (10) and Victories
-- (20): where you played reads as a facet of the table rather than a category
-- of its own, and no existing row has to be renumbered to make room.
INSERT INTO public.boardgamebuddy_achievement_groups (id, label, blurb, display_order)
VALUES
  ('travel', 'On the road', 'Not just what you played — where.', 15)
ON CONFLICT (id) DO UPDATE
  SET label = EXCLUDED.label,
      blurb = EXCLUDED.blurb,
      display_order = EXCLUDED.display_order;


-- ── 4. Two new metric names ──────────────────────────────────────────────────
-- 062's CHECK is what stops a badge naming a metric the RPC never computes, so
-- it has to be widened before the catalog rows below can land. It was declared
-- inline and therefore carries a server-generated name; drop it by looking it
-- up rather than by guessing what Postgres called it, and give the replacement
-- a name of our own so the next widening is a one-liner.
DO $$
DECLARE c TEXT;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.boardgamebuddy_achievements'::regclass
       AND contype  = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%metric%'
  LOOP
    EXECUTE format('ALTER TABLE public.boardgamebuddy_achievements DROP CONSTRAINT %I', c);
  END LOOP;
END;
$$;

ALTER TABLE public.boardgamebuddy_achievements
  ADD CONSTRAINT bgb_achievements_metric_chk CHECK (metric IN (
    'plays_logged', 'wins', 'biggest_table', 'two_player_games',
    'buddies', 'guide_chapters', 'chapters_borrowed', 'plays_with_notes',
    'bgg_linked', 'app_installed',
    'countries', 'continents'));


-- ── 5. The badges ────────────────────────────────────────────────────────────
-- `tagline` is the plain past-tense statement 067 established (printed once the
-- badge is earned, and in the unlock popup); `requirement` is the same fact in
-- the imperative, printed while it is still locked.
--
-- display_order 52–56 sits between Full Table (50) and Crowned (60), so the
-- catalog's global order matches the group order above. Within the rail the
-- ladder is 2 countries → 2 continents → 5 countries: crossing one border is
-- the easy one, and the ocean is easier to reach than five separate countries.
INSERT INTO public.boardgamebuddy_achievements
  (id, group_id, name, tagline, requirement, metric, threshold, icon, display_order)
VALUES
  ('countries_2',  'travel', 'Border Hopper',
   'Logged plays in 2 different countries.',
   'Log plays in 2 different countries',     'countries',   2, 'border-hopper',   52),
  ('continents_2', 'travel', 'Globe Trotter',
   'Logged plays on 2 different continents.',
   'Log plays on 2 different continents',    'continents',  2, 'globe-trotter',   54),
  ('countries_5',  'travel', 'Country Counter',
   'Logged plays in 5 different countries.',
   'Log plays in 5 different countries',     'countries',   5, 'country-counter', 56)
ON CONFLICT (id) DO UPDATE
  SET group_id      = EXCLUDED.group_id,
      name          = EXCLUDED.name,
      tagline       = EXCLUDED.tagline,
      requirement   = EXCLUDED.requirement,
      metric        = EXCLUDED.metric,
      threshold     = EXCLUDED.threshold,
      icon          = EXCLUDED.icon,
      display_order = EXCLUDED.display_order;

COMMIT;


-- ─────────────────────────────────────────────────────────────────────────────
-- ── 6. bgb_sync_achievements — compute the two new metrics ───────────────────
--
-- 062's body verbatim, plus: country_code carried through the my_plays CTE, and
-- two keys on the metrics blob. Steps 2 and 3 are untouched — the unlock INSERT
-- and the payload build both read `m ->> a.metric` generically, so a new metric
-- costs exactly the lines that compute it.
--
-- VOLATILE because it inserts. PostgREST issues every .rpc() as a POST, so the
-- FastAPI layer calls it exactly like any read.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION public.bgb_sync_achievements(uid UUID)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  m       JSONB;
  payload JSONB;
BEGIN
  -- ── 1. Every metric, in one pass ──────────────────────────────────────────
  -- country_code rides along from migration 068. It is on the play, so both
  -- legs carry it and the UNION still dedupes on the id.
  WITH my_plays AS (
    SELECT p.id, p.game_id, p.country_code
    FROM public.boardgamebuddy_plays p
    WHERE p.user_id = uid
    UNION
    SELECT p.id, p.game_id, p.country_code
    FROM public.boardgamebuddy_plays p
    JOIN public.boardgamebuddy_play_players pp ON pp.play_id = p.id
    WHERE pp.player_user_id = uid
  ),
  -- Head count per play. Ghost players (a free-text name, no account) are
  -- people at the table too, so every player row counts — "five around the
  -- board" is about the board, not about who has signed up.
  table_sizes AS (
    SELECT mp.id, COUNT(pp.id) AS players
    FROM my_plays mp
    JOIN public.boardgamebuddy_play_players pp ON pp.play_id = mp.id
    GROUP BY mp.id
  )
  SELECT jsonb_build_object(
    'plays_logged', (SELECT COUNT(*) FROM my_plays),
    'wins', (
      SELECT COUNT(*)
      FROM my_plays mp
      JOIN public.boardgamebuddy_play_players pp
        ON pp.play_id = mp.id AND pp.player_user_id = uid
      WHERE pp.is_winner
    ),
    'biggest_table', COALESCE((SELECT MAX(players) FROM table_sizes), 0),
    -- Duelist: a game the BOX is built for two, not an evening that happened
    -- to seat two. `max_players = 2` is the test — a game that can never
    -- seat a third — which keeps 1-2 player games (Patchwork, Watergate) in:
    -- they are duels the moment a second person sits down, and excluding them
    -- on min_players would be a stricter reading than anyone means by "a
    -- two-player game". This is the one metric that has to reach the games
    -- table: migration 020 denormalized name and thumbnail onto plays, never
    -- the player counts.
    'two_player_games', (
      SELECT COUNT(DISTINCT mp.game_id)
      FROM my_plays mp
      JOIN public.boardgamebuddy_games g ON g.id = mp.game_id
      WHERE g.max_players = 2
    ),
    'buddies', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_buddy_edges e
      WHERE e.status = 'accepted' AND (e.user_a = uid OR e.user_b = uid)
    ),
    'guide_chapters', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_user_chapters uc
      WHERE uc.user_id = uid
    ),
    -- Chapters this user WROTE that somebody else keeps in their own guide.
    -- Distinct on the chapter: one popular chapter kept by nine people is one
    -- chapter, and the badge only needs the first.
    'chapters_borrowed', (
      SELECT COUNT(DISTINCT uc.chapter_id)
      FROM public.boardgamebuddy_user_chapters uc
      JOIN public.boardgamebuddy_guide_chapters gc ON gc.id = uc.chapter_id
      WHERE gc.created_by = uid AND uc.user_id <> uid
    ),
    -- Notes are written by whoever logged the play, so this counts the user's
    -- own rows rather than my_plays.
    'plays_with_notes', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_plays p
      WHERE p.user_id = uid AND COALESCE(BTRIM(p.notes), '') <> ''
    ),
    'bgg_linked', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_profiles pr
      WHERE pr.id = uid AND COALESCE(BTRIM(pr.bgg_username), '') <> ''
    ),
    'app_installed', (
      SELECT COUNT(*)
      FROM public.boardgamebuddy_profiles pr
      WHERE pr.id = uid AND pr.app_installed_at IS NOT NULL
    ),
    -- ── Migration 068 ──────────────────────────────────────────────────────
    -- Distinct countries. COUNT(DISTINCT …) already skips NULLs, so the
    -- decade of pre-065 plays that have no country simply do not participate;
    -- the WHERE is there to say so out loud rather than to change the answer.
    'countries', (
      SELECT COUNT(DISTINCT mp.country_code)
      FROM my_plays mp
      WHERE mp.country_code IS NOT NULL
    ),
    -- Distinct continents. The JOIN is inner ON PURPOSE. bgb_log_play accepts
    -- any well-formed ^[A-Z]{2}$ from any client — the native app, an offline
    -- outbox flush, a future integration — so a code the lookup has never
    -- heard of is possible. Such a play still counts toward `countries` and
    -- contributes no continent: the badge under-reports by one, which is a far
    -- better failure than the whole Achievements screen erroring out because
    -- somebody's browser reported a country tzdata has since retired.
    'continents', (
      SELECT COUNT(DISTINCT c.continent)
      FROM my_plays mp
      JOIN public.boardgamebuddy_countries c ON c.code = mp.country_code
    )
  )
  INTO m;

  -- ── 2. Pin the unlock date for anything newly earned ──────────────────────
  INSERT INTO public.boardgamebuddy_user_achievements (user_id, achievement_id)
  SELECT uid, a.id
  FROM public.boardgamebuddy_achievements a
  WHERE COALESCE((m ->> a.metric)::NUMERIC, 0) >= a.threshold
  ON CONFLICT (user_id, achievement_id) DO NOTHING;

  -- ── 3. The screen ─────────────────────────────────────────────────────────
  -- `earned` reads the unlock row, not the metric: step 2 has already written
  -- a row for everything currently clearing its bar, and keeping the row is
  -- what makes a badge permanent when a play is later deleted.
  SELECT jsonb_build_object(
    'total', COUNT(*),
    'earned_count', COUNT(*) FILTER (WHERE ua.user_id IS NOT NULL),
    'metrics', m,
    'groups', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', g.id, 'label', g.label, 'blurb', g.blurb
             ) ORDER BY g.display_order), '[]'::JSONB)
      FROM public.boardgamebuddy_achievement_groups g
    ),
    'achievements', COALESCE(jsonb_agg(jsonb_build_object(
        'id',          a.id,
        'group_id',    a.group_id,
        'name',        a.name,
        'tagline',     a.tagline,
        'requirement', a.requirement,
        'icon',        a.icon,
        'metric',      a.metric,
        'threshold',   a.threshold,
        -- Clamped for the progress bar; `metrics` above carries the raw value
        -- for anything that wants to print "312 plays".
        'progress',    LEAST(COALESCE((m ->> a.metric)::NUMERIC, 0), a.threshold)::INT,
        'earned',      ua.user_id IS NOT NULL,
        'unlocked_at', ua.unlocked_at
      ) ORDER BY a.display_order), '[]'::JSONB)
  )
  INTO payload
  FROM public.boardgamebuddy_achievements a
  LEFT JOIN public.boardgamebuddy_user_achievements ua
    ON ua.achievement_id = a.id AND ua.user_id = uid;

  RETURN payload;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.bgb_sync_achievements(UUID) TO boardgamebuddy_role;

COMMIT;
