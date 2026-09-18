-- ─────────────────────────────────────────────────────────────────────────────
-- 045_bgg_meta_sync.sql — one queue marker for everything /thing?stats=1 gives
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHY. Three admin backfills drained three queues — `description IS NULL`,
-- `bgg_stats_synced_at IS NULL` (038) and `publishers IS NULL` (040) — and all
-- three asked BoardGameGeek the SAME question: GET /thing?stats=1 for a game
-- id. One response carries the blurb, the four stats, the publisher links AND
-- the year, which is what import_game_from_bgg has always done with it. So the
-- catalog was walked three times to read one document, and a game short of two
-- fields was counted twice by the admin badge.
--
-- It also left year_published with no queue at all. Nothing anywhere keyed on
-- `year_published IS NULL`, so a game imported without one kept it forever:
-- blank on the game page, and permanently ineligible for Discover's "New this
-- year" rail, which filters `.eq("year_published", year)`.
--
-- SHAPE. TIMESTAMPTZ, not a boolean: "when we last read BGG's record for this
-- game" is the fact, and the re-check window below wants the date rather than a
-- flag. Same shape and reasoning as bgg_stats_synced_at, which this supersedes
-- AS A QUEUE MARKER while staying a real column — it still records when the
-- ratings landed, and the sweep still writes it.
--
-- NULLABLE WITH NO DEFAULT. NULL = never asked. A row with no bgg_id can never
-- be asked and is excluded by the queue's own `bgg_id IS NOT NULL`, so it stays
-- NULL and out of the way rather than being stamped to hide it.
--
-- THE QUEUE IS NOT THE LIST, and that distinction is the point of this column.
-- Conflating them is what made the description backfill re-request the same
-- games on every pass forever:
--
--   * The PANEL lists every row still missing any of the four fields. A game
--     BoardGameGeek has no blurb or no year for keeps showing there — that is
--     what the panel is for, and that count is not expected to reach zero.
--   * The RUN works `bgg_meta_synced_at IS NULL`, so it terminates. After a
--     fetch the row is stamped whether or not BGG had anything to give, and it
--     stops being asked.
--
-- The API re-checks a stamped-but-still-incomplete row after 90 days, so a
-- blurb BoardGameGeek adds later still lands. That lives in the endpoint, not
-- here, because it is a policy and this is a fact.
--
-- THE SEED IS LOAD-BEARING. Stamping nothing would re-fetch a catalog that is
-- already complete — a thousand-odd games, twenty per throttled call. Stamping
-- everything would swallow the bug this exists to fix. So: stamp exactly the
-- rows already complete on all four fields, and leave anything short of one to
-- queue up once. A game missing only its year lands in the queue on the first
-- run after this migration, which is the reported case.
--
-- bgb_game_detail_bundle needs no change (it builds its payload with
-- to_jsonb(g.*), so the new column rides along) and bootstrap_version is not
-- bumped — same reason 030, 039 and 040 give: the key is purely additive.

BEGIN;

ALTER TABLE public.boardgamebuddy_games
  ADD COLUMN IF NOT EXISTS bgg_meta_synced_at TIMESTAMPTZ;

-- Back-dated to the stats stamp rather than now(): that IS when we last read
-- BGG's record for these rows, and a truthful old date beats a flattering
-- fresh one for the 90-day re-check.
UPDATE public.boardgamebuddy_games
   SET bgg_meta_synced_at = bgg_stats_synced_at
 WHERE bgg_meta_synced_at IS NULL
   AND bgg_id              IS NOT NULL
   AND bgg_stats_synced_at IS NOT NULL
   AND description         IS NOT NULL
   AND publishers          IS NOT NULL
   AND year_published      IS NOT NULL;

-- Mirrors idx_bgb_games_stats_synced, whose predicate the backfill no longer
-- runs. NULLS FIRST because the queue scan wants exactly the null head of it.
CREATE INDEX IF NOT EXISTS idx_bgb_games_meta_synced
  ON public.boardgamebuddy_games (bgg_meta_synced_at ASC NULLS FIRST)
  WHERE (bgg_id IS NOT NULL);

COMMENT ON COLUMN public.boardgamebuddy_games.bgg_meta_synced_at IS
  'When POST /games/admin/backfill-metadata last read BGG''s /thing?stats=1 record for this game (migration 045). NULL with a non-null bgg_id IS the backfill queue. Stamped even when BGG had no description or no year, so the queue terminates — the panel keeps listing those rows from the field predicate instead.';

COMMENT ON COLUMN public.boardgamebuddy_games.bgg_stats_synced_at IS
  'When the BGG rating/rank/weight last landed (migration 038). No longer a queue marker — 045 moved that to bgg_meta_synced_at — but still written by every sync.';

COMMENT ON COLUMN public.boardgamebuddy_games.publishers IS
  'BGG boardgamepublisher links, in BGG''s order. ''{}'' = BGG credits nobody. NULL no longer means "never synced" (045 moved that to bgg_meta_synced_at); readers coerce both to [].';

COMMIT;
