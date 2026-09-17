-- 041_dev_feedback.sql — the Dev feedback board: what users want built next.
--
-- WHY. This app has exactly one user→maintainer channel today, and it is not a
-- general one: boardgamebuddy_chapter_reports (migration 011) carries "this
-- community chapter breaks the rules" and nothing else. There is nowhere to put
-- "the Discover tab loads slowly" or "let me sort my shelf by weight", so those
-- arrive — when they arrive at all — as a message to somebody's phone and are
-- lost. This is the board that holds them.
--
-- WHY LIKES AND NOT A PRIORITY COLUMN. A maintainer-set priority is a guess
-- about demand; a like count IS demand, from the only people who can measure it.
-- So the list's sort key is the like count and the board's whole editorial
-- policy is "the thing most people tapped is at the top". That one decision is
-- what forces the RPC at the bottom of this file — see its header.
--
-- SHAPE. Four tables:
--   boardgamebuddy_feedback_types   lookup: bug | feature | suggestion
--   boardgamebuddy_feedback_topics  lookup: which part of the app it is about
--   boardgamebuddy_feedback         the item itself, with an open|resolved status
--   boardgamebuddy_feedback_likes   one row per (item, person)
--
-- WHY TYPE AND TOPIC ARE TABLES AND STATUS IS NOT. This repo's rule is in
-- .claude/rules/database-supabase.md — "any named list, option set, lookup
-- table, or configurable preset must be stored as rows" — and the existing
-- reading of it is boardgamebuddy_chapter_types: a value that carries a LABEL,
-- an ICON and a DISPLAY ORDER is a table, because all three are presentation
-- the frontend must not hardcode and a deploy must not be needed to change.
-- `status` carries none of those. It is two words the code branches on, it has
-- no icon and no order, and chapter_reports models the identical open|resolved
-- axis as a plain TEXT + CHECK with a ChapterReportStatus StrEnum on the Python
-- side. Same here. A boardgamebuddy_feedback_statuses table would be a lookup
-- with nothing to look up.
--
-- WHY ICONS ARE SLUGS. .claude/rules/assets.md: a seeded `icon` column stores a
-- slug, never an emoji character. The slugs below are LUCIDE names — that is the
-- vocabulary web/ui/icons.js keys on (Lucide names, Phosphor glyphs, see its
-- header), and it is what chapter_types is already seeded with. Every name below
-- was checked against that map; an unknown name renders a neutral fallback
-- rather than nothing, which fails silently, so they are worth checking again if
-- this seed is ever extended.

BEGIN;

-- ── Feedback types ────────────────────────────────────────────────────────────
-- What KIND of thing this is. Three, and deliberately not more: the taxonomy
-- exists to let a maintainer skim, not to be exhaustive, and every axis that
-- says WHERE lives on topic below.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_feedback_types (
  id            TEXT NOT NULL,
  label         TEXT NOT NULL,
  icon          TEXT,
  display_order INTEGER DEFAULT 0,
  CONSTRAINT boardgamebuddy_feedback_types_pkey PRIMARY KEY (id)
);
ALTER TABLE public.boardgamebuddy_feedback_types ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_feedback_types TO boardgamebuddy_role;

INSERT INTO public.boardgamebuddy_feedback_types (id, label, icon, display_order) VALUES
  ('bug',        'Bug',            'alert-triangle', 10),
  ('feature',    'Feature request', 'sparkles',      20),
  ('suggestion', 'Suggestion',     'lightbulb',      30)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.boardgamebuddy_feedback_types IS
  'Lookup for boardgamebuddy_feedback.feedback_type. Seeded here (041). `icon` is a Lucide slug into web/ui/icons.js, never an emoji. Served by GET /feedback-types and denormalised onto every row bgb_feedback_list returns, so the list paints from one call.';


-- ── Feedback topics ───────────────────────────────────────────────────────────
-- WHICH PART OF THE APP it is about. These are the app's own surfaces, named as
-- the user sees them, so the set tracks the bottom nav plus the two header
-- screens. Adding a topic is an INSERT here, not a deploy — which is the whole
-- reason this is a table.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_feedback_topics (
  id            TEXT NOT NULL,
  label         TEXT NOT NULL,
  icon          TEXT,
  display_order INTEGER DEFAULT 0,
  CONSTRAINT boardgamebuddy_feedback_topics_pkey PRIMARY KEY (id)
);
ALTER TABLE public.boardgamebuddy_feedback_topics ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_feedback_topics TO boardgamebuddy_role;

INSERT INTO public.boardgamebuddy_feedback_topics (id, label, icon, display_order) VALUES
  ('feed',          'Feed',          'home',    10),
  ('play',          'Play',          'dices',   20),
  ('game',          'Games',         'puzzle',  30),
  ('profile',       'Profile',       'user',    40),
  ('settings',      'Settings',      'gear',    50),
  ('notifications', 'Notifications', 'bell',    60),
  ('discover',      'Discover',      'compass', 70)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.boardgamebuddy_feedback_topics IS
  'Lookup for boardgamebuddy_feedback.topic — which surface of the app an item is about. Seeded here (041); the set mirrors the bottom nav plus the two header screens. `icon` is a Lucide slug into web/ui/icons.js. Served by GET /feedback-topics.';


-- ── Feedback ──────────────────────────────────────────────────────────────────
-- One row per submitted item. Column-for-column this is the shape of
-- boardgamebuddy_chapter_reports — an author, a body, an open|resolved status
-- and a resolver — because it is the same kind of object: something a user
-- writes that an admin later closes. Where it differs is that the body IS the
-- content rather than a reason attached to other content, so `body` is NOT NULL
-- here where reports' `reason` is nullable.
--
-- NO UNIQUE ON (user_id, …). Reports are deduped per (chapter, reporter)
-- because flagging the same chapter twice means nothing. Filing two pieces of
-- feedback means two things, so nothing is deduped here.
--
-- NO ON DELETE for the type/topic FKs beyond the default RESTRICT: a seeded
-- option must not be deletable out from under the rows that name it. Retiring a
-- topic is a display_order change or a label edit, not a DELETE.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_feedback (
  id            UUID DEFAULT gen_random_uuid() NOT NULL,
  user_id       UUID NOT NULL,
  feedback_type TEXT NOT NULL,
  topic         TEXT NOT NULL,
  body          TEXT NOT NULL,
  status        TEXT DEFAULT 'open'::text NOT NULL,
  resolved_by   UUID,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_feedback_pkey PRIMARY KEY (id),
  -- profiles, not auth.users: migration 035 dropped that FK when accounts moved
  -- to Identity Platform.
  CONSTRAINT boardgamebuddy_feedback_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_feedback_resolved_by_fkey FOREIGN KEY (resolved_by)
    REFERENCES boardgamebuddy_profiles(id) ON DELETE SET NULL,
  CONSTRAINT boardgamebuddy_feedback_feedback_type_fkey FOREIGN KEY (feedback_type)
    REFERENCES boardgamebuddy_feedback_types(id),
  CONSTRAINT boardgamebuddy_feedback_topic_fkey FOREIGN KEY (topic)
    REFERENCES boardgamebuddy_feedback_topics(id),
  CONSTRAINT boardgamebuddy_feedback_status_check
    CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text])))
);
ALTER TABLE public.boardgamebuddy_feedback ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_feedback TO boardgamebuddy_role;

-- Every read of this table filters on status and breaks ties on created_at. The
-- primary sort is the like count, which no index on THIS table can serve — see
-- the RPC header.
CREATE INDEX IF NOT EXISTS idx_bgb_feedback_status_created
  ON public.boardgamebuddy_feedback USING btree (status, created_at DESC);

COMMENT ON TABLE public.boardgamebuddy_feedback IS
  'The Dev feedback board: one row per item a user submitted from Settings → Dev feedback. status=open is what every non-admin sees; resolving hides it from them and leaves it visible to admins under the Resolved filter, which is why resolve is reversible and nothing is deleted. Ordered for display by like count DESC then created_at DESC — see bgb_feedback_list.';

COMMENT ON COLUMN public.boardgamebuddy_feedback.resolved_by IS
  'The admin who resolved it. ON DELETE SET NULL rather than CASCADE: a deleted admin account must not take the resolution with it — the item stays resolved, it just stops naming who did it.';


-- ── Feedback likes ────────────────────────────────────────────────────────────
-- "I want this too." The priority signal the board is sorted by.
--
-- Shaped on boardgamebuddy_play_reactions (016) and for the same reasons: NO
-- surrogate id, because the composite PK is the identity AND the idempotency —
-- the endpoint upserts ON CONFLICT DO NOTHING and a double-tap costs nothing.
-- And NO stored count on boardgamebuddy_feedback, because a denormalised
-- counter is a second source of truth that drifts the first time a profile is
-- deleted and the CASCADE takes its likes without touching the tally.
--
-- feedback_id LEADS the PK deliberately: the count aggregate groups by it, so
-- the PK index serves that read and no second index is needed.
--
-- WHERE THIS DIFFERS FROM 016. Reactions drop the caller's own plays — you
-- cannot kudos yourself, the Strava rule. Feedback likes explicitly do NOT:
-- POST /feedback inserts the author's own like with the item, so a new item
-- lands at 1 rather than 0, and the author keeps the ability to take it back if
-- they stop wanting the thing they asked for. The board measures how many people
-- want something, and the person who asked is one of them.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_feedback_likes (
  feedback_id UUID NOT NULL,
  user_id     UUID NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT boardgamebuddy_feedback_likes_pkey PRIMARY KEY (feedback_id, user_id),
  CONSTRAINT boardgamebuddy_feedback_likes_feedback_id_fkey FOREIGN KEY (feedback_id)
    REFERENCES boardgamebuddy_feedback(id) ON DELETE CASCADE,
  CONSTRAINT boardgamebuddy_feedback_likes_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES boardgamebuddy_profiles(id) ON DELETE CASCADE
);
ALTER TABLE public.boardgamebuddy_feedback_likes ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_feedback_likes TO boardgamebuddy_role;

COMMENT ON TABLE public.boardgamebuddy_feedback_likes IS
  'One row per (feedback item, person). The composite PK is both the identity and the idempotency guarantee, so POST /feedback/{id}/like upserts ignore_duplicates and returns 200 rather than 201. Counts are aggregated in bgb_feedback_list, never stored on the item.';


-- ── bgb_feedback_list ─────────────────────────────────────────────────────────
-- The board, as the screen renders it: filtered, counted, and ordered.
--
-- WHY THIS IS AN RPC WHEN CHAPTER REPORTS IS NOT. The obvious question about
-- this whole migration is why the feedback list does not just do what its twin
-- does — chapter_routes.py:967 lists reports with plain PostgREST, embeds,
-- .eq() and .order(), no function at all. The answer is one clause: ORDER BY
-- like_count DESC. That sort key is an aggregate over a SECOND table, and
-- PostgREST cannot order by an embedded aggregate. Every alternative is worse:
-- fetching the board and sorting it in Python is the Python-side aggregation
-- .claude/rules/performance-caching.md exists to forbid, and it stops being
-- correct the moment the board outgrows one page; a stored counter is the
-- drifting second source of truth the likes table's header rejects.
--
-- So: one function, one round trip, and the type/topic display fields ride along
-- denormalised so the client needs no second call to render a row.
--
-- NULL means "no filter" for want_type and want_topic. want_status carries NO
-- default on purpose — the caller always knows which half of the board it is
-- asking for, and defaulting it would hide a non-admin leak behind a missing
-- argument. feedback_routes.py forces it to 'open' for non-admins.
--
-- want_id fetches ONE item and, when set, overrides the status filter. That is
-- not a convenience: it is what every write path needs. A submit, a like and a
-- resolve all return the refreshed row so the client has one row renderer
-- rather than two — and a resolve has just moved the item from one side of the
-- status filter to the other, so a read that still honoured want_status would
-- return nothing precisely when the caller needs the row most.
--
-- viewer_id is only read to compute viewer_liked. It is the caller's own id and
-- never a filter: everybody sees the same board.
CREATE OR REPLACE FUNCTION public.bgb_feedback_list(
  viewer_id   UUID,
  want_status TEXT,
  want_type   TEXT DEFAULT NULL,
  want_topic  TEXT DEFAULT NULL,
  want_id     UUID DEFAULT NULL
)
 RETURNS TABLE(
   id                  UUID,
   user_id             UUID,
   author_name         TEXT,
   feedback_type       TEXT,
   feedback_type_label TEXT,
   feedback_type_icon  TEXT,
   topic               TEXT,
   topic_label         TEXT,
   topic_icon          TEXT,
   body                TEXT,
   status              TEXT,
   resolved_at         TIMESTAMPTZ,
   resolver_name       TEXT,
   created_at          TIMESTAMPTZ,
   like_count          BIGINT,
   viewer_liked        BOOLEAN
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    f.id,
    f.user_id,
    author.display_name,
    f.feedback_type,
    ft.label,
    ft.icon,
    f.topic,
    tp.label,
    tp.icon,
    f.body,
    f.status,
    f.resolved_at,
    resolver.display_name,
    f.created_at,
    -- A correlated count rather than a LEFT JOIN + GROUP BY: it reads off the
    -- likes PK directly (feedback_id leads it) and keeps every column above out
    -- of a GROUP BY clause that would have to list all fourteen of them.
    (SELECT COUNT(*) FROM public.boardgamebuddy_feedback_likes l
      WHERE l.feedback_id = f.id),
    EXISTS (SELECT 1 FROM public.boardgamebuddy_feedback_likes l
             WHERE l.feedback_id = f.id AND l.user_id = viewer_id)
  FROM public.boardgamebuddy_feedback f
  JOIN public.boardgamebuddy_profiles author ON author.id = f.user_id
  JOIN public.boardgamebuddy_feedback_types  ft ON ft.id = f.feedback_type
  JOIN public.boardgamebuddy_feedback_topics tp ON tp.id = f.topic
  -- LEFT, unlike the three above: resolved_by is null on every open item, and an
  -- inner join here would return an empty board.
  LEFT JOIN public.boardgamebuddy_profiles resolver ON resolver.id = f.resolved_by
  WHERE (want_id IS NULL     OR f.id     = want_id)
    -- Skipped entirely on an id lookup — see the header.
    AND (want_id IS NOT NULL OR f.status = want_status)
    AND (want_type  IS NULL OR f.feedback_type = want_type)
    AND (want_topic IS NULL OR f.topic         = want_topic)
  ORDER BY (SELECT COUNT(*) FROM public.boardgamebuddy_feedback_likes l
             WHERE l.feedback_id = f.id) DESC,
           f.created_at DESC;
$function$;

-- SECURITY DEFINER + published by PostgREST: the anon key must not reach it.
-- Same trio 028 applies to every bgb RPC — and 028 loops over a fixed list of
-- names, so it will never pick this one up. It has to be here.
GRANT EXECUTE ON FUNCTION public.bgb_feedback_list(viewer_id uuid, want_status text, want_type text, want_topic text, want_id uuid) TO boardgamebuddy_role;
REVOKE EXECUTE ON FUNCTION public.bgb_feedback_list(viewer_id uuid, want_status text, want_type text, want_topic text, want_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_feedback_list(viewer_id uuid, want_status text, want_type text, want_topic text, want_id uuid) TO service_role;

COMMIT;
