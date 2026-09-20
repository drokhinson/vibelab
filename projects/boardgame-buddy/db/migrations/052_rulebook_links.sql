-- ─────────────────────────────────────────────────────────────────────────────
-- 052 — A rulebook link is a chapter, and it is moderated before anyone follows it
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Until now a game's rulebook was ONE column on the catalog row —
-- boardgamebuddy_games.rulebook_url — writable by an admin and by nobody else,
-- through PATCH /games/admin/{id}/rulebook-url and a long-press on the game
-- page. Three things were wrong with that, and they are the three this file
-- fixes:
--
--   1. IT LIVED IN THE WRONG PLACE. Everything else a player reaches for
--      mid-game — setup, the turn order, scoring, the score sheet itself — is a
--      chapter in the reference guide. The rulebook, the one thing the guide
--      exists to save you opening, was a button somewhere else entirely, filed
--      with the box art and the player count.
--   2. IT WAS ADMIN-ONLY, so a game nobody had curated had no rulebook and no
--      way for the table to fix that. The guide's whole premise is that the
--      people playing write what they know down for the next table.
--   3. IT WAS AN UNCHECKED OUTBOUND LINK. Every other chapter is text this app
--      renders; a rulebook link sends a reader to somebody else's server. Open
--      authoring and an unchecked outbound link cannot both be true at once,
--      which is why this migration adds authoring and moderation in the SAME
--      breath rather than shipping the first and promising the second.
--
-- WHY A CHAPTER AND NOT A SECOND COLUMN. The same argument 018 made for the
-- scoring grid, and this file follows that precedent line for line: a rulebook
-- link is reference material ABOUT A GAME, which is exactly what the reference
-- guide already holds — authored, pooled, browsed, adopted, reported and
-- moderated by machinery that exists. A column on the games row can hold one
-- link for everybody; a chapter can hold the one an admin curated AND the one
-- your buddy found for the printing you actually own, and let each reader keep
-- whichever they want. The pool, the guide, the "N of M" count, the per-chapter
-- report and the admin's delete all come free.
--
-- WHY A TYPED `link_url` COLUMN AND NOT THE URL IN `content`. Exactly 018's
-- answer for `grid`: `content` is ILIKE-searched by the pool, sliced into the
-- moderation preview and fed to renderMarkdown on three surfaces. A bare URL in
-- there would be searchable but unreadable in the first two, and — the real
-- reason — a link a MODERATOR has to look at must be one column the API can
-- read, validate and show, not a substring some renderer found. `content` keeps
-- a GENERATED markdown mirror of the link ("[Rulebook](https://…)"), rewritten
-- on every save and never hand-edited, so the three surfaces above go on
-- working with no branch and a client that has never heard of this layout
-- still renders a working link.
--
-- WHY MODERATION IS A COLUMN AND NOT A SECOND REPORTS TABLE.
-- boardgamebuddy_chapter_reports is REACTIVE: something is published, somebody
-- objects, an admin looks. That is the right shape for prose — the worst case
-- is a reader losing a minute to nonsense. It is the wrong shape for an
-- outbound link, where the worst case is the reader on somebody else's server
-- before the first report is ever filed. So a rulebook link carries its own
-- gate, up front, on the row: `moderation_status` is what every read path
-- filters on, and the reports table stays exactly what it is for prose.
--
-- WHO SEES A LINK THAT IS NOT YET APPROVED, and why it is not simply nobody:
--
--   * approved — everyone, signed in or not. An admin put their name to it.
--   * pending  — its author, and their ACCEPTED BUDDIES. Vouching is the
--                relationship this app is built on: a link from somebody you
--                have already accepted as a buddy is not a link from a
--                stranger, and holding it back until an admin wakes up would
--                make the common case (a table of four adding the PDF they are
--                all reading from tonight) useless. Everyone else waits.
--   * denied   — nobody but its author (who sees it struck through, so they
--                know it was looked at rather than lost) and admins. A denial
--                is not a delete: the row stays so the same URL cannot be
--                re-submitted through the UNIQUE below and quietly re-enter
--                every buddy's guide.
--
-- The rule is enforced in ONE place — routes/services/chapter_rulebook.py,
-- applied by every chapter read path — and NOT in RLS, for the reason this
-- whole API already runs the way it does: the service role bypasses RLS, so
-- policies here would protect the browser-direct paths and nothing else, and
-- no browser-direct path reads chapters. Stating that plainly so nobody later
-- reads the missing policy as an oversight.
--
-- ONE LINK PER (GAME, AUTHOR), enforced by a UNIQUE index below. The pool can
-- hold several links for a game — an admin's, your buddy's — and a reader keeps
-- whichever they adopt, exactly as they do with scoring grids. What nobody gets
-- is to post six. That is the one anti-spam property this feature actually
-- needs, and an index gives it for free.
--
-- NO NEW TABLES: the columns below inherit the RLS and the grants
-- boardgamebuddy_guide_chapters already carries.


-- ── The type ─────────────────────────────────────────────────────────────────
-- Seeded here rather than in 002_seed.sql for the reason 021 gives for the
-- scoring-grid type: a fresh database runs the baseline seed before this file,
-- and a row there would be a type nothing in the shipped code could author.
-- Fold it into 002 at the next baseline collapse.
--
-- `icon` is a slug resolved by web/ui/icons.js, never an emoji
-- (.claude/rules/assets.md). 'book-open' is already in that map — it is the
-- glyph the old rulebook button carried, so the mark survives the move.
--
-- display_order 6 puts it directly after the scoring grid's 5 and ahead of the
-- six original types at 10–60. Both the authoring picker and the guide scroll
-- read this column, so the number is deliberately both: second thing offered to
-- write, and — since the scroll draws the rulebook in a section of its own at
-- the TOP of the body — the first thing you see in a guide. That is the right
-- place for the document every other chapter is a shortcut around.

INSERT INTO public.boardgamebuddy_chapter_types (id, label, icon, display_order) VALUES
  ('rulebook', 'Rulebook', 'book-open', 6)
ON CONFLICT (id) DO NOTHING;


-- ── Chapters: the layout ─────────────────────────────────────────────────────
-- The constraint keeps its chunks-era name for the reason 018 kept it: the
-- tables were renamed in archive/018 and the constraints were not, so db/schema/
-- diffs by one line.

ALTER TABLE public.boardgamebuddy_guide_chapters
  DROP CONSTRAINT IF EXISTS boardgamebuddy_guide_chunks_layout_check;

ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD CONSTRAINT boardgamebuddy_guide_chunks_layout_check
  CHECK (layout = ANY (ARRAY['text'::text, 'scoring_grid'::text, 'rulebook_link'::text]));


-- ── Chapters: the typed body, and the gate ───────────────────────────────────

ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD COLUMN IF NOT EXISTS link_url TEXT;

ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD COLUMN IF NOT EXISTS moderation_status TEXT;

-- The FK is NAMED rather than left to Postgres's default
-- (boardgamebuddy_guide_chapters_moderated_by_fkey), for the reason every other
-- constraint on this table carries a bgb_ name: a later migration that has to
-- drop or re-add it should not have to guess what the server called it, and
-- db/schema/ records the name it finds.
ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD COLUMN IF NOT EXISTS moderated_by UUID
    CONSTRAINT bgb_chapters_moderated_by_fkey
    REFERENCES public.boardgamebuddy_profiles(id) ON DELETE SET NULL;

ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD COLUMN IF NOT EXISTS moderated_at TIMESTAMPTZ;

COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.link_url IS
  'The outbound rulebook URL of a layout=''rulebook_link'' chapter. http(s) only, pinned by '
  'bgb_chapters_link_shape — this is a link the app sends readers to, so the scheme is not left '
  'to the client. NULL for every other layout. `content` carries a generated markdown mirror '
  '("[Rulebook](url)") so the pool''s ILIKE search, the moderation preview and renderMarkdown '
  'need no branch; `link_url` is the source of truth and the mirror is derived from it.';

COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.moderation_status IS
  'pending | approved | denied, on a layout=''rulebook_link'' chapter only (NULL everywhere else). '
  'Approved is visible to everyone; pending only to its author and their ACCEPTED buddies; denied '
  'only to its author and admins. A link authored by an admin is born approved. The rule is '
  'applied by routes/services/chapter_rulebook.py on every chapter read path, NOT by RLS — this '
  'API is service-role and bypasses RLS, and nothing reads chapters browser-direct. A denial is '
  'deliberately not a delete: the row is what stops the same author re-posting the same link past '
  'the UNIQUE index below.';

COMMENT ON COLUMN public.boardgamebuddy_guide_chapters.moderated_by IS
  'The admin whose decision moderation_status records. NULL while pending, and NULL on the rows '
  'migration 052 backfilled out of boardgamebuddy_games.rulebook_url — those were approved by '
  'having been admin-only data in the first place, and naming an admin who never looked at them '
  'would be a lie the audit trail cannot tell apart from a real decision.';


-- The grid's shape CHECK has to LEARN the new layout, not merely tolerate it:
-- as written in 018 it is an exhaustive two-branch rule over `layout`, so a
-- 'rulebook_link' row satisfies neither branch and every insert below would
-- fail. The grid half is reproduced verbatim — this migration changes nothing
-- 018 decided — with one branch added for the layout that carries no grid.
ALTER TABLE public.boardgamebuddy_guide_chapters
  DROP CONSTRAINT IF EXISTS bgb_chapters_grid_shape;

ALTER TABLE public.boardgamebuddy_guide_chapters
  ADD CONSTRAINT bgb_chapters_grid_shape CHECK (
    ((layout = 'text'::text) AND (grid IS NULL))
    OR ((layout = 'rulebook_link'::text) AND (grid IS NULL))
    OR ((layout = 'scoring_grid'::text)
        AND (jsonb_typeof(grid -> 'rows'::text) = 'array'::text)
        AND (jsonb_array_length(grid -> 'rows'::text) BETWEEN 1 AND 24))
  );


-- Layout, link and gate move together or not at all — the same all-or-nothing
-- rule bgb_chapters_grid_shape puts on the grid. The scheme test is in the
-- DATABASE and not only in the API because this column's whole risk is where it
-- sends somebody: a `javascript:` or `data:` URL written by any future caller
-- that forgot to validate would otherwise be one render away from executing,
-- and the API's check is one code path where this is every code path.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bgb_chapters_link_shape'
  ) THEN
    ALTER TABLE public.boardgamebuddy_guide_chapters
      ADD CONSTRAINT bgb_chapters_link_shape CHECK (
        (
          layout = 'rulebook_link'
          -- The IS NOT NULL tests are load-bearing, not belt-and-braces: a
          -- CHECK whose expression evaluates to NULL PASSES, so `link_url ~*
          -- '…'` alone would let a rulebook link through with no URL at all,
          -- and the status test alone would let one through with no gate —
          -- which is exactly the row every read path would then have to guess
          -- about. (services/chapter_rulebook.is_visible_to guesses "pending",
          -- the closed reading, for precisely this reason; this constraint is
          -- what keeps it from ever having to.)
          AND link_url IS NOT NULL
          AND link_url ~* '^https?://[^[:space:]]+$'
          AND moderation_status IS NOT NULL
          AND moderation_status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text])
        )
        OR (
          layout <> 'rulebook_link'
          AND link_url IS NULL
          AND moderation_status IS NULL
        )
      );
  END IF;
END $$;


-- ── One link per (game, author) ──────────────────────────────────────────────
-- The anti-spam property, and the thing that makes a denial stick: a denied row
-- stays, so the same author re-submitting the same link for the same game
-- collides here instead of quietly re-entering every buddy's guide.
--
-- created_by is NULLABLE (the author's profile FK is ON DELETE SET NULL, and
-- the backfill below writes NULL deliberately), and NULLs do not collide in a
-- UNIQUE index. That is the wanted behaviour on both paths: several curated
-- links can coexist, and an orphaned link outliving its author must not block
-- the next person from writing one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_chapters_rulebook_author
  ON public.boardgamebuddy_guide_chapters (game_id, created_by)
  WHERE layout = 'rulebook_link';

-- The admin queue's read: everything still pending, oldest first. Partial for
-- the same reason 018's grid index is — rulebook links are a small minority of
-- this table.
CREATE INDEX IF NOT EXISTS idx_bgb_chapters_rulebook_status
  ON public.boardgamebuddy_guide_chapters (moderation_status, created_at)
  WHERE layout = 'rulebook_link';


-- ── The backfill ─────────────────────────────────────────────────────────────
-- Every rulebook URL an admin ever curated becomes an approved rulebook
-- chapter. This is the whole reason the file is a migration rather than a seed
-- edit: without it, the day this ships every game that HAD a rulebook loses it,
-- and the app tells a hundred tables that no rulebook link is available for a
-- game one was curated for months ago.
--
-- created_by NULL, and not some admin's id: nobody authored these as chapters.
-- NULL is the column's existing "no author" value (the guide scroll and the
-- pool already render it as unattributed), and it keeps the UNIQUE index above
-- from tying a curated link to a person who would then be unable to write their
-- own for that game.
--
-- `boardgamebuddy_games.rulebook_url` IS NOT DROPPED. It stays where it is, and
-- forty RPCs and bundles go on selecting it — untouched, because rewriting them
-- would be a large, risky diff in service of deleting a column that costs
-- nothing. After this migration it is simply no longer READ by the app: the
-- write path (the admin PATCH endpoint and the long-press on the game page) is
-- gone, and every surface that used to render it now renders the chapter. Treat
-- it as the pre-052 seed this backfill drew from, not as a second source of
-- truth, and do not wire anything new to it.
--
COMMENT ON COLUMN public.boardgamebuddy_games.rulebook_url IS
  'LEGACY as of migration 052, and left in place only because forty RPCs and bundles select it. '
  'It was the admin-curated rulebook link, written by PATCH /games/admin/{id}/rulebook-url — an '
  'endpoint that no longer exists — and every value in it was backfilled into an approved '
  'layout=''rulebook_link'' chapter by 052. Nothing in the app reads it any more. Do not wire '
  'anything new to it and do not treat it as a second source of truth for a game''s rulebook; the '
  'chapters table is the one.';


-- Idempotent via NOT EXISTS, so re-running this file is safe and is the repair
-- if it lands twice. Scoped to rows with a URL that passes the same scheme test
-- the CHECK above applies — a malformed legacy value fails the constraint and
-- would abort the whole statement, taking every good row with it.
INSERT INTO public.boardgamebuddy_guide_chapters
  (game_id, chapter_type, title, content, layout, link_url, moderation_status, created_by)
SELECT
  g.id,
  'rulebook',
  -- The same derivation services/chapter_rulebook.rulebook_title applies on
  -- every write, fallback included, so a backfilled row and an authored one are
  -- titled by one rule rather than two.
  CASE
    WHEN trim(both from coalesce(g.name, '')) = '' THEN 'Rulebook'
    ELSE trim(both from coalesce(g.name, '')) || ' rulebook'
  END,
  '[Rulebook](' || g.rulebook_url || ')',
  'rulebook_link',
  g.rulebook_url,
  'approved',
  NULL
FROM public.boardgamebuddy_games g
WHERE g.rulebook_url IS NOT NULL
  AND g.rulebook_url ~* '^https?://[^[:space:]]+$'
  AND NOT EXISTS (
    SELECT 1
      FROM public.boardgamebuddy_guide_chapters c
     WHERE c.game_id = g.id
       AND c.layout = 'rulebook_link'
       AND c.link_url = g.rulebook_url
  );
