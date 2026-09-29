-- 040_game_publishers.sql — who published the game, on the game page.
--
-- WHY. The game detail screen carried the publication year only as the
-- polaroid's caption strip and named no publisher at all, so the two facts a
-- collector reaches for first ("which edition is this?") were either buried or
-- absent. Both now sit in a labelled facts block under the meta pills; the
-- year was already a column, the publisher was not.
--
-- SHAPE. TEXT[] rather than TEXT, because BGG has no single "the" publisher:
-- /thing lists the original alongside every localized reissue, in its own
-- order. The import keeps the first few links in BGG's order (the first is in
-- practice the original) and the UI names the first, with the rest available
-- to any later surface that wants an edition list.
--
-- NULLABLE WITH NO DEFAULT, on purpose and unlike categories/mechanics: NULL
-- means "never synced from BGG" and is the queue marker for
-- POST /games/admin/backfill-publishers, exactly as `description IS NULL`
-- drives the description backfill. A game BGG credits to nobody lands '{}',
-- which leaves the queue. Every row predating this migration is NULL, so the
-- whole catalog backfills through that endpoint (Settings → Missing
-- publishers) rather than through a one-shot script.
--
-- bgb_game_detail_bundle needs no change: it builds its game payload with
-- to_jsonb(g.*), so a new column rides along. bootstrap_version is not bumped
-- for the reason migrations 030 and 039 give — the key is purely additive, so
-- a device on a pre-040 cached bundle simply draws no publisher row until its
-- cache revalidates, which is cheaper than wiping every cache to save minutes.

BEGIN;

ALTER TABLE public.boardgamebuddy_games
  ADD COLUMN IF NOT EXISTS publishers TEXT[];

COMMENT ON COLUMN public.boardgamebuddy_games.publishers IS
  'BGG boardgamepublisher links, in BGG''s order, capped at 4 by the import. NULL = never synced (the backfill queue marker); ''{}'' = synced and BGG credits nobody.';

COMMIT;
