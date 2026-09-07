-- 018_push_default_on.sql — notifications are on unless you say otherwise.
--
-- 017 shipped push opt-in: every account started on 'none' and had to find the
-- Settings card to turn it on. That is the safe default for a feature nobody
-- has tried yet and the wrong one for a feature that works — an app whose whole
-- point is "your buddies did something while you weren't looking" is silent by
-- default for everyone who never opened Settings, which is most people.
--
-- So the ladder's rest position moves from 'none' to 'all'. The tier is now a
-- statement of INTENT rather than of state: 'all' means "this account is happy
-- to hear about everything", not "this account is currently being pushed to".
--
-- WHY THAT IS NOT A NOTIFICATION NOBODY ASKED FOR — the thing 017's own comment
-- refused to do. The tier is only half of a delivery; the other half is a
-- per-device subscription, and a subscription can only exist where the person
-- granted their browser's permission by hand. Flipping a column cannot create
-- one. So an account switched to 'all' here receives exactly nothing until
-- somebody accepts a permission prompt on a device — which the app now asks for
-- on the first open after this lands (ui/push-prompt.js) and during first-run
-- setup (widgets/onboarding-deck-slides.js). The consent still comes from the
-- person; what changed is that we ask instead of waiting to be found.
--
-- THE BACKFILL IS GUARDED, for the one case where the flip WOULD be audible.
-- Someone who turned notifications off on their phone while a laptop was also
-- registered still has the laptop's row: for them, and only them, 'none' is a
-- decision rather than a default, and switching it to 'all' would resume push
-- to a device they never revoked. Restricting the update to accounts with no
-- registered device at all leaves every such choice intact — nobody starts
-- getting notifications out of this migration, they start getting a prompt.

ALTER TABLE public.boardgamebuddy_profiles
  ALTER COLUMN push_tier SET DEFAULT 'all';

UPDATE public.boardgamebuddy_profiles p
   SET push_tier = 'all'
 WHERE p.push_tier = 'none'
   AND NOT EXISTS (
     SELECT 1
       FROM public.boardgamebuddy_push_subscriptions s
      WHERE s.user_id = p.id
   );

COMMENT ON COLUMN public.boardgamebuddy_profiles.push_tier IS
  'How much this account wants pushed: none | actionable | all. Cumulative — all implies actionable. Mirrored by PushTier in the backend constants; the DB values ARE the enum values. Default all since 018: the column states intent, and nothing is delivered until a device subscription exists, which only a browser permission grant can create.';
