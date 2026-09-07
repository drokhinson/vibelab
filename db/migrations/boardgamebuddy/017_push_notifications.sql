-- 017_push_notifications.sql — the bell can reach a phone that isn't open.
--
-- Everything BoardgameBuddy knows how to tell you, it tells you inside
-- BoardgameBuddy. The bell (008/009/017) is complete and derived and correct,
-- and it is also invisible to anyone who is not currently looking at the app —
-- which is everyone, most of the time. This adds Web Push: the app is already
-- an installed PWA with a service worker, so the missing pieces are a place to
-- keep each device's subscription and a per-account answer to "how much do you
-- want to hear from this".
--
-- TWO TIERS, CUMULATIVE. 'actionable' is the things that are waiting on you —
-- a buddy request, a ghost claim, being seated in a play or added to a live
-- lobby. 'all' adds the pleasant noise on top: a good game, an accepted
-- request, a badge. 'none' is off. A ladder rather than independent switches
-- because the question a person actually asks themselves is "how much", and
-- three radio options answer it in one glance where two checkboxes make them
-- work out what four combinations mean.
--
-- WHY THE TIER IS ON THE PROFILE AND THE SUBSCRIPTION IS PER-DEVICE. They are
-- different facts. "How much do you want to hear" is about the person and
-- should follow them to a new phone; "here is a push endpoint that works" is
-- about one browser on one device and is meaningless anywhere else. So the
-- tier is a profile column (and every device obeys it the moment it changes),
-- while each device that has been turned on owns one row below. Turning
-- notifications off silences the account AND drops the device you did it on;
-- the other devices keep their rows and simply never get sent to, which is
-- what makes turning it back on not require re-granting permission everywhere.
--
-- NO NEW PREFERENCES TABLE. This is the first per-user setting the app has
-- stored server-side at all — theme lives in localStorage because it is about
-- the device, not the account — and one column is not a settings system. If a
-- third or fourth account-level preference ever arrives, THAT is the moment to
-- consider a table; doing it now would be a schema for a shape nobody has seen.

-- ── The per-account tier ─────────────────────────────────────────────────────

ALTER TABLE public.boardgamebuddy_profiles
  ADD COLUMN IF NOT EXISTS push_tier TEXT NOT NULL DEFAULT 'none';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'boardgamebuddy_profiles_push_tier_check'
  ) THEN
    ALTER TABLE public.boardgamebuddy_profiles
      ADD CONSTRAINT boardgamebuddy_profiles_push_tier_check
      CHECK (push_tier IN ('none', 'actionable', 'all'));
  END IF;
END
$$;

COMMENT ON COLUMN public.boardgamebuddy_profiles.push_tier IS
  'How much this account wants pushed: none | actionable | all. Cumulative — all implies actionable. Mirrored by PushTier in the backend constants; the DB values ARE the enum values. Default none: push is opt-in, and a migration that turned it on for every existing account would be a notification nobody asked for.';

-- ── One row per device ───────────────────────────────────────────────────────
--
-- endpoint is the identity, not user_id: it is the URL the push service issued
-- for this browser, it is globally unique by construction, and it is what a
-- re-subscribe hands back. Keying on it makes the write an upsert and makes the
-- same device signing in as a second account move rather than duplicate.
--
-- The FK is to boardgamebuddy_profiles rather than auth.users, matching
-- play_reactions: DELETE /profile drops the profile row and the app's whole
-- cascade hangs off that, so a deleted account's devices go with it. Pointed at
-- auth.users these rows would outlive the account that owns them.
CREATE TABLE IF NOT EXISTS public.boardgamebuddy_push_subscriptions (
  id           UUID DEFAULT gen_random_uuid() NOT NULL,
  user_id      UUID NOT NULL,
  -- The push service's URL for this browser. Treat it as a secret: anyone
  -- holding it can ask that service to wake the device (they cannot read the
  -- payload without the keys below, which is the point of the encryption).
  endpoint     TEXT NOT NULL,
  -- The subscription's public key and auth secret, straight from
  -- PushSubscription.toJSON().keys. pywebpush encrypts each payload to these,
  -- so a push service never sees the contents.
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  -- Purely so a person can tell their own devices apart if a management screen
  -- is ever built. Nothing reads it today.
  user_agent   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now() NOT NULL,
  last_success_at TIMESTAMPTZ,
  -- Bumped on a send that failed for a reason that is NOT "this endpoint is
  -- gone" (404/410 delete the row outright — the subscription is permanently
  -- dead and keeping it would mean retrying it forever). A row whose count
  -- climbs without ever succeeding is a diagnosis, not a trigger: nothing
  -- prunes on it automatically, because a phone that is off for a fortnight
  -- looks identical to one that is never coming back.
  failure_count INT DEFAULT 0 NOT NULL,
  CONSTRAINT boardgamebuddy_push_subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT boardgamebuddy_push_subscriptions_endpoint_key UNIQUE (endpoint),
  CONSTRAINT boardgamebuddy_push_subscriptions_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE
);
ALTER TABLE public.boardgamebuddy_push_subscriptions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_push_subscriptions TO boardgamebuddy_role;

-- The fan-out read: every device belonging to the people a notification is for.
CREATE INDEX IF NOT EXISTS idx_bgb_push_subs_user
  ON public.boardgamebuddy_push_subscriptions USING btree (user_id);

COMMENT ON TABLE public.boardgamebuddy_push_subscriptions IS
  'One Web Push subscription per browser per account. Written by POST /push/subscriptions, read by services/push_service when fanning a notification out, and deleted on a 404/410 from the push service. No Data API grant: only the service-role backend touches it.';


-- ── bgb_push_note_failure ────────────────────────────────────────────────────
-- Increment one subscription's failure counter.
--
-- An RPC for a one-line UPDATE because PostgREST cannot express
-- `failure_count = failure_count + 1` — it only sets literals, so the backend
-- would have to read the row, add one, and write it back. Two round trips and
-- a lost update whenever two notifications fail against the same dead device at
-- once, which is precisely when this runs.
--
-- Silently does nothing for an unknown id: the common way to get here is a send
-- failing against a subscription another notification's 410 handler has already
-- deleted, and that is the system working.
CREATE OR REPLACE FUNCTION public.bgb_push_note_failure(p_id uuid)
 RETURNS void
 LANGUAGE sql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE boardgamebuddy_push_subscriptions
     SET failure_count = failure_count + 1
   WHERE id = p_id;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_push_note_failure(p_id uuid) TO boardgamebuddy_role;
