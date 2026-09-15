-- ─────────────────────────────────────────────────────────────────────────────
-- 021 — A scoring grid is its own chapter type, and it sorts first
-- ─────────────────────────────────────────────────────────────────────────────
-- 018 shipped scoring grids as a LAYOUT of the existing 'scoring' chapter type.
-- That put authoring one two taps deep and invisible until you picked Scoring
-- first — a poor home for a feature whose other half is a "custom scoring grids
-- are available, tap to add" nag on the reference-guide scroll.
--
-- WHY THE 018 ARGUMENT INVERTS. It had two legs, and both turn out to argue the
-- other way:
--
--   * "The scroll groups by chapter_type with one header each, so a 7th type
--     would split a user's scoring material into two sections both saying
--     scoring." — With a dedicated type that split is the POINT. A grid is a
--     table, not prose; prose about scoring is still a real chapter and keeps
--     the 'scoring' type. Two sections is the honest picture of two things.
--   * "services/chapter_ai.py keys its prompt on the type, so reusing 'scoring'
--     leaves the AI path untouched." — The wizard already skipped its AI step
--     for grids. A dedicated type makes that skip structural rather than
--     conditional, and lets the generate endpoint refuse the type outright
--     (chapter_routes.generate_chapter) instead of relying on the client not to
--     ask. Rows are authored in an editor; there is nothing to draft.
--
-- WHY `layout` STAYS, AND STAYS THE STORAGE DISCRIMINATOR. The type and the
-- layout are not alternatives — they answer different questions, and each holds
-- half the truth. `chapter_type` is an FK to a lookup table and says what the
-- chapter is ABOUT: it is what the author picks, what the scroll groups under
-- one header, and what the pool filters by. `layout` says what SHAPE the body
-- is stored in: it is what bgb_chapters_grid_shape keys off, what the ?layout=
-- pool filter reads, and what every renderer branches on. So this migration
-- adds the type BESIDE the layout and changes nothing 018 defined — no
-- constraint, no index, no RPC below is touched.
--
-- The two become 1:1, which is why services/chapter_grid.validate_layout_pairing
-- now cross-checks them in BOTH directions on every write. A grid under another
-- type renders bare R1..Rn; a 'scoring_grid' chapter with a text body renders an
-- empty section under a heading promising a table. Neither is drawable, and only
-- application code can see the pair (the DB constraint sees the layout alone).
--
-- WHY display_order 5. The existing six run 10–60, so 5 sorts the new type
-- first. The authoring picker and the guide scroll read the SAME column, so this
-- is deliberately both: first option to author, and first section in every
-- user's guide — which is where you want the thing you reach for mid-game.
-- Decoupling the two orders would need a second column and is not worth it.
--
-- NO NEW TABLES and no schema change at all: one seed row and one backfill.
-- Both idempotent, so re-running this file is safe and is the repair if it lands
-- twice.


-- ── The type ─────────────────────────────────────────────────────────────────
-- Seeded here rather than in 002_seed.sql for the same reason 019's two badges
-- are: a fresh database runs the baseline seed before this file, and a row there
-- would be a seventh type nothing in the shipped code could yet author. Fold it
-- into 002 at the next baseline collapse.
--
-- `icon` is a slug resolved to a vendored icon by web/ui/icons.js, never an
-- emoji (.claude/rules/assets.md). 'table' is already in that map.

INSERT INTO public.boardgamebuddy_chapter_types (id, label, icon, display_order) VALUES
  ('scoring_grid', 'Scoring Grid Template', 'table', 5)
ON CONFLICT (id) DO NOTHING;


-- ── The backfill ─────────────────────────────────────────────────────────────
-- Every grid becomes a 'scoring_grid' chapter. This is the whole reason the file
-- exists as a migration rather than a seed edit: any grid authored between 018
-- landing and this one is filed under 'scoring', and would otherwise sit in the
-- scroll's Scoring section rendering a table under a prose heading.
--
-- Scoped by `layout`, not by anything looser: a prose chapter about scoring must
-- NOT move, and layout is the column that tells them apart. A no-op on a
-- database where nobody has authored a grid yet.
--
-- The INSERT above has to precede this, since chapter_type is an FK to the
-- lookup table this row was just added to.

UPDATE public.boardgamebuddy_guide_chapters
   SET chapter_type = 'scoring_grid'
 WHERE layout = 'scoring_grid'
   AND chapter_type <> 'scoring_grid';
