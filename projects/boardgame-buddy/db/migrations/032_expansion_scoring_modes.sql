-- 032_expansion_scoring_modes.sql — an expansion's scoring grid says how it
-- meets the base game's: it either ADDS ROWS to it, or REPLACES it outright.
--
-- Migration 018 made a scoring grid a chapter and a chapter belongs to ONE
-- game. Expansions are games, so an expansion could already carry a grid of its
-- own and the reference guide already merges base + expansion chapters into one
-- pool. What nothing recorded was the relationship between the two grids, and
-- there are exactly two of them:
--
--   * ADD-ON — the expansion brings extra scoring categories to a scorepad that
--     is otherwise the base game's. Everdell + Pearlbrook: the fourteen base
--     rows, then Pearls and Wonders. This is the common case by a wide margin.
--   * REPLACE — the expansion reprints the whole score sheet with its own
--     categories, and the base game's grid is not used at all while it is on
--     the table. A legacy box, a campaign mode, a standalone-ish big box.
--
-- Without the distinction the play screen could only offer the two grids as
-- rival scorepads and make the host pick one every game — which is wrong for
-- BOTH modes: an add-on's rows are not an alternative to the base game's, and a
-- replacement is not a choice the host should have to remember to make.
--
-- WHAT THE MODE DECIDES, AND WHAT IT DOES NOT. A replace-mode expansion on the
-- table is what the scorepad DEFAULTS to; it does not remove the base game as
-- an option. The play screen shows the base game and every replace expansion as
-- a row of pills and the host can pick any of them, which is the difference
-- between a default and a lockout — a host who wants the base scorepad back
-- with the big box still on the table is asking for something reasonable.
-- Add-on grids are never pills: their rows fold into whichever pill is chosen,
-- and the rows say so themselves by drawing the expansion's colour down the
-- RIGHT edge of their header cell — the left edge already carries the row's own
-- palette tint, so the two facts get opposite edges rather than one.
--
-- WHY INSIDE `grid` AND NOT A COLUMN. `grid` is a versioned document
-- ({"v":1,"rows":[…]}) and 018 put `v` there precisely so it could grow; the
-- mode is part of what the grid IS, travels with it into the play snapshot's
-- provenance, and is never selected, filtered, sorted or joined on. A column
-- would also have to be nullable-and-meaningful in the same way (NULL on a base
-- game's grid), which is a CHECK either way — so this is the same constraint on
-- the document that already has one.
--
-- WHY NULL ON A BASE GAME'S GRID. The mode answers "how does this meet the base
-- game's grid", and a base game's own grid cannot be asked it. Storing 'add_on'
-- there would read as "these rows join something" and make every base grid look
-- like half a scorepad. The API resolves this (services/chapter_grid
-- .resolve_grid_mode) because only the write path knows whether the chapter's
-- game is an expansion; SQL cannot check it here without a subquery, which a
-- CHECK constraint may not contain. This file constrains the VALUE DOMAIN and
-- the API owns the base-vs-expansion half — stated plainly rather than left to
-- be discovered.
--
-- EXISTING ROWS ARE NOT BACKFILLED. A grid written before this migration has no
-- `mode` key at all, and absent is exactly right for the base-game grids that
-- are nearly all of them. The handful written against an expansion read as
-- add-on (resolve_grid_mode's default, and the composition code's), which is
-- the behaviour those grids already had — their rows joined the table beside
-- the base game's — so nothing changes under anyone.
--
-- NO NEW TABLES and no data movement: one CHECK constraint, and one COMMENT
-- rewritten to describe the document's new key.


-- ── The value domain ─────────────────────────────────────────────────────────
-- Absent and NULL both mean "no mode" and both are allowed here; a present
-- value must be one of the two. `grid -> 'mode'` (not ->>) is what tells a JSON
-- null apart from an absent key, and jsonb_typeof folds them together on
-- purpose: the API writes an explicit null for a base game's grid and older
-- rows have no key, and neither is a violation.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bgb_chapters_grid_mode'
  ) THEN
    ALTER TABLE public.boardgamebuddy_guide_chapters
      ADD CONSTRAINT bgb_chapters_grid_mode CHECK (
        grid IS NULL
        OR grid -> 'mode' IS NULL
        OR jsonb_typeof(grid -> 'mode') = 'null'
        OR grid ->> 'mode' = ANY (ARRAY['add_on'::text, 'replace'::text])
      );
  END IF;
END $$;


-- ── The document, re-described ───────────────────────────────────────────────
-- 018's COMMENT is restated in full rather than appended to: it is the one
-- place the grid document's shape is written down, and a reader should not have
-- to reconstruct it from two migrations.

COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.grid IS
  'Row definitions for a layout=''scoring_grid'' chapter: '
  '{"v":1,"mode":…,"rows":[{"label":…,"color":…,"note":…}]}. '
  '`color` is a SLUG from a fixed palette (neutral|red|pink|rust|brown|gold|yellow|green|blue|purple), never a hex — the grid '
  'lands on the cream scorepad, and only a fixed palette can be guaranteed legible there in both themes. '
  '`mode` (migration 032) is add_on|replace on a grid whose game is an EXPANSION — its rows either join the base game''s grid '
  'or stand in for it — and NULL/absent on a base game''s own grid, where the question does not arise. The API resolves it '
  '(services/chapter_grid.resolve_grid_mode); the bgb_chapters_grid_mode CHECK only pins the value domain, because a CHECK '
  'cannot look up whether the chapter''s game is an expansion. '
  'NULL for layout=''text''; see the bgb_chapters_grid_shape constraint.';


-- ── The play snapshot, re-described ──────────────────────────────────────────
-- No schema change: `scoring_template` is JSONB and the composed document is
-- the same shape with one more optional key. The comment is what needs to keep
-- up, because "the scoring-grid chapter this play was scored with" stopped
-- being one chapter the moment an add-on could contribute rows to it.

COMMENT ON COLUMN public.boardgamebuddy_plays.scoring_template IS
  'Denormalised snapshot of the scoring grid this play was scored with: '
  '{"v":1,"chapter_id":…,"title":…,"rows":[…],"parts":[…]}. NOT a foreign key, on purpose. '
  'The chapter is community-owned, editable by its author and deletable by author or admin, so a play '
  'holding only an id would render bare R1..Rn the moment a moderator cleared the chapter, and would '
  'silently RELABEL a two-year-old play if the author reordered its rows — labels that stop describing '
  'the numbers under them is precisely the failure widgets/round-score-grid.js is written to prevent. '
  'ON DELETE SET NULL loses the labels and CASCADE deletes plays, so neither constraint tells the truth. '
  'chapter_id rides INSIDE the document as provenance: a bare uuid column would imply an integrity the '
  'database is not enforcing. Same reasoning as game_name / game_thumbnail_url on this table. '
  '`rows` may be COMPOSED from several grids (migration 032) — a base game''s plus each add-on expansion''s, '
  'the add-ons appended in ascending BGG id so every client composes the same scorepad — in which case '
  '`chapter_id` names the grid that supplied the leading rows and `parts` lists every contributor in row '
  'order as {chapter_id,game_id,game_name,mode,row_count}. A row an add-on contributed also carries that '
  'expansion''s `source_color` (boardgamebuddy_games.expansion_color), which draws a rule down the RIGHT '
  'edge of its header cell — the left edge carries the row''s own palette tint, so the two never collide; '
  'the leading grid''s rows carry none. `parts` is absent, and no row carries a '
  'source_color, when one grid supplied the whole thing — so a pre-032 snapshot reads exactly as it always did.';

COMMENT ON COLUMN public.boardgamebuddy_play_sessions.scoring_template IS
  'The template the host applied to this live grid, same shape as '
  'boardgamebuddy_plays.scoring_template — composed parts and all. Copied onto the play at finalize.';
