-- 042_release_notices.sql — what's new, told once.
--
-- WHY. Big releases ship silently. Docs/release-notes-v2.md is an app-store
-- document and nothing in web/ reads it, so a user who opens the app the day
-- after the Discover tab landed has no way to learn it exists short of
-- stumbling onto it. This is the in-app half: an admin writes a short note, and
-- the next time each user opens the app it pops up once.
--
-- SHAPE. Two pieces.
--
--   boardgamebuddy_release_notices — the notes themselves. `published_at` is
--   the ONLY draft/published flag: NULL is a draft, a timestamp is live, and
--   the same column is the sort key and the unit the watermark compares
--   against. A `status` text column beside it would be two sources of truth for
--   one fact, written by three routes and correct only if all three remember.
--
--   boardgamebuddy_profiles.release_notices_seen_at — one watermark per user,
--   the same shape link_notifications_seen_at has carried since 008. A
--   per-(user, notice) table would buy per-notice analytics nobody asked for,
--   in exchange for a join on the boot path and a row per user per release.
--
-- THE DEFAULT IS THE FEATURE. release_notices_seen_at is NOT NULL DEFAULT
-- now(), and that one clause does three jobs that would otherwise be three
-- decisions to get wrong:
--
--   1. New accounts do not see the backlog. A profile row inserted by
--      dependencies._load_or_create_profile does not name this column, so it
--      gets signup time and can only ever see notices published after it. No
--      Python change, and no second insert path can forget it.
--   2. Existing accounts are watermarked at migration time, because ADD COLUMN
--      with a non-volatile-looking default evaluates now() once and stores it
--      as the fast-default for every existing row. Nobody wakes up to a backlog.
--   3. There is no NULL, so there is no COALESCE direction to get backwards.
--      COALESCE(col, '-infinity') would show everyone everything; '+infinity'
--      would show nobody anything. 008 needed the nullable form and a separate
--      backfill UPDATE; this does not, and the read stays a bare `>`.
--
-- Deliberately NOT also filtering on profiles.created_at. With the default
-- above the watermark AT CREATION *is* created_at, so the extra predicate is
-- tautological on day one and actively wrong afterwards — once a user marks
-- things seen, created_at is older than their watermark and would re-widen the
-- set. (profiles.created_at is also nullable, which is the exact trap this
-- column is shaped to avoid.)
--
-- WRITTEN BY the admin spoke at /admin/release-notices (POST/PATCH/DELETE
-- /release-notices/admin*). READ BY GET /bootstrap (the popup's unseen list,
-- via bgb_release_notices_unseen) and GET /release-notices (the Settings
-- "What's new" archive). The watermark is advanced by POST /release-notices/seen.

BEGIN;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_release_notices (
  id           UUID DEFAULT gen_random_uuid() NOT NULL,
  title        TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  link_route   TEXT,
  link_label   TEXT,
  published_at TIMESTAMPTZ,
  created_by   UUID,
  created_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_release_notices_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_release_notices_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.boardgamebuddy_profiles(id)
    ON DELETE SET NULL
);
ALTER TABLE public.boardgamebuddy_release_notices ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_release_notices TO boardgamebuddy_role;

-- Partial on purpose. Every user-facing read filters `published_at IS NOT NULL`
-- and orders by it; the admin list wants drafts too but is a seq scan over tens
-- of rows, which is the right price for not carrying a second index.
CREATE INDEX IF NOT EXISTS idx_bgb_release_notices_published
  ON public.boardgamebuddy_release_notices (published_at DESC)
  WHERE published_at IS NOT NULL;

COMMENT ON TABLE public.boardgamebuddy_release_notices IS
  'Admin-authored "what''s new" notes shown once per user in a popup on their next visit. Written from /admin/release-notices; read by bgb_release_notices_unseen (the popup) and GET /release-notices (the Settings archive).';
COMMENT ON COLUMN public.boardgamebuddy_release_notices.published_at IS
  'NULL = draft, never sent. Set by POST /release-notices/admin/{id}/publish and never by the client, because a backdated timestamp would sort behind watermarks users already hold and be invisible to exactly the people it was written for. Republishing moves it forward, so an unpublish/republish cycle re-shows the notice.';
COMMENT ON COLUMN public.boardgamebuddy_release_notices.body_md IS
  'Markdown, rendered by web/ui/markdown.js — which escapes first and allows only http(s), mailto and root-relative hrefs. Note that renderer opens every link in a new tab, so an in-app destination belongs in link_route, not in a markdown link here.';
COMMENT ON COLUMN public.boardgamebuddy_release_notices.link_route IS
  'Optional router route name for the "take me there" button (web/domain/view.js _routes). Plain TEXT, not an enum: the backend has no route table, so any server-side enum would be a copy that drifts the first time a route is renamed. The admin picker offers only param-free routes and both render paths drop the button when router.pathFor() cannot build a URL, which also covers a route retired after the notice was written.';
COMMENT ON COLUMN public.boardgamebuddy_release_notices.created_by IS
  'ON DELETE SET NULL, not CASCADE: deleting an admin''s account must not delete the notices everyone else is still reading.';

ALTER TABLE public.boardgamebuddy_profiles
  ADD COLUMN IF NOT EXISTS release_notices_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON COLUMN public.boardgamebuddy_profiles.release_notices_seen_at IS
  'Watermark: release notices published at or before this are not shown again. NOT NULL DEFAULT now() so a new account starts watermarked at signup and never sees the backlog, and so existing rows were watermarked at migration time. Advanced only by bgb_mark_release_notices_seen; read by bgb_release_notices_unseen.';


-- ── bgb_release_notices_unseen ────────────────────────────────────────────────
-- The published notices this viewer has not been shown, oldest-first.
--
-- The inner DESC LIMIT then outer ASC is deliberate: the NEWEST p_limit notices
-- are the ones worth showing, but they read as a chronology, so they are handed
-- back oldest-first. An account six releases behind gets the last five and
-- marks through the newest; the older ones stay in the Settings archive. That
-- is a decision to drop a nag, not an oversight.
--
-- The watermark comes from a scalar subquery rather than a Python pre-read so
-- that "what counts as unseen" lives in exactly one place — the same shape
-- bgb_link_notifications_unread uses.
--
-- If the profile row somehow does not exist the subquery is NULL and
-- `published_at > NULL` yields no rows: this fails CLOSED (nothing shown),
-- which is the right direction. Do not "fix" that with a COALESCE.
CREATE OR REPLACE FUNCTION public.bgb_release_notices_unseen(
  p_viewer uuid,
  p_limit  integer DEFAULT 5
)
 RETURNS TABLE(
   id           uuid,
   title        text,
   body_md      text,
   link_route   text,
   link_label   text,
   published_at timestamptz
 )
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT newest.id, newest.title, newest.body_md,
         newest.link_route, newest.link_label, newest.published_at
    FROM (
      SELECT n.id, n.title, n.body_md, n.link_route, n.link_label, n.published_at
        FROM public.boardgamebuddy_release_notices n
       WHERE n.published_at IS NOT NULL
         AND n.published_at > (SELECT pr.release_notices_seen_at
                                 FROM public.boardgamebuddy_profiles pr
                                WHERE pr.id = p_viewer)
       ORDER BY n.published_at DESC
       LIMIT GREATEST(COALESCE(p_limit, 5), 1)
    ) newest
   ORDER BY newest.published_at ASC;
$function$;

GRANT EXECUTE ON FUNCTION public.bgb_release_notices_unseen(p_viewer uuid, p_limit integer) TO boardgamebuddy_role;
REVOKE EXECUTE ON FUNCTION public.bgb_release_notices_unseen(p_viewer uuid, p_limit integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_release_notices_unseen(p_viewer uuid, p_limit integer) TO service_role;


-- ── bgb_mark_release_notices_seen ─────────────────────────────────────────────
-- bgb_mark_link_notifications_seen's twin, and monotonic for the same reason:
-- it takes the watermark the CLIENT was shown rather than now(), so a notice
-- published between /bootstrap and the dismissal is not marked seen without
-- ever having appeared. That race is ordinary here rather than contrived — the
-- admin publishes from inside this same app. GREATEST makes a stale retry
-- harmless.
--
-- No COALESCE around the column the way 008 has: it is NOT NULL here, so the
-- inner COALESCE would be dead code.
CREATE OR REPLACE FUNCTION public.bgb_mark_release_notices_seen(
  p_viewer  uuid,
  p_through timestamptz DEFAULT NULL
)
 RETURNS timestamptz
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_through TIMESTAMPTZ := COALESCE(p_through, now());
  v_result  TIMESTAMPTZ;
BEGIN
  UPDATE public.boardgamebuddy_profiles
     SET release_notices_seen_at = GREATEST(release_notices_seen_at, v_through)
   WHERE id = p_viewer
   RETURNING release_notices_seen_at INTO v_result;
  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.bgb_mark_release_notices_seen(p_viewer uuid, p_through timestamptz) TO boardgamebuddy_role;
REVOKE EXECUTE ON FUNCTION public.bgb_mark_release_notices_seen(p_viewer uuid, p_through timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bgb_mark_release_notices_seen(p_viewer uuid, p_through timestamptz) TO service_role;

COMMIT;
