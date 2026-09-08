-- 019_push_default_off.sql — put the ladder's rest position back at 'none'.
--
-- 018 moved the default to 'all' on the reasoning that a tier states INTENT and
-- delivers nothing on its own, so switching it on for everybody notified
-- nobody. That reasoning holds and the product answer is still no: an account
-- nobody has asked should read as off, in Settings and everywhere else, and
-- "we turned it on for you but it does not do anything yet" is a distinction
-- the person reading the card should not have to hold.
--
-- What 018 was really solving stays solved, and is now solved in the place it
-- belonged: the app ASKS. The first-run deck has a notifications slide and
-- ui/push-prompt.js makes the same offer once on the feed, so the opt-in is
-- something people are actually shown rather than something they have to go
-- looking for. Neither needs the column pre-flipped to work.
--
-- WHY THIS IS A MIGRATION AND NOT A DELETION OF 018. 018 is on main and this
-- repo's migrations are hand-applied (db/migrations/README.md), so it may
-- already have run against production — and removing the file would neither
-- undo that nor leave a fresh database matching the live one. An inverse is
-- honest either way: if 018 never ran, everything below is already true and
-- this is a no-op.
--
-- THE UPDATE IS 018'S OWN GUARD, RUN BACKWARDS. It reverts only accounts that
-- 018 could have touched — 'all' with no registered device — so anybody who has
-- since accepted a permission prompt keeps the tier they chose, and nobody
-- mid-ladder on 'actionable' is moved at all. The one row it cannot tell apart
-- is an account that chose 'all' back in 017 and whose only device later lost
-- its subscription: it reads identically to one 018 flipped, and lands on
-- 'none'. That account is receiving nothing either way (no subscription, no
-- send), and one tap in Settings puts it back — which is the cheaper mistake
-- than leaving somebody switched on who never asked to be.

ALTER TABLE public.boardgamebuddy_profiles
  ALTER COLUMN push_tier SET DEFAULT 'none';

UPDATE public.boardgamebuddy_profiles p
   SET push_tier = 'none'
 WHERE p.push_tier = 'all'
   AND NOT EXISTS (
     SELECT 1
       FROM public.boardgamebuddy_push_subscriptions s
      WHERE s.user_id = p.id
   );

COMMENT ON COLUMN public.boardgamebuddy_profiles.push_tier IS
  'How much this account wants pushed: none | actionable | all. Cumulative — all implies actionable. Mirrored by PushTier in the backend constants; the DB values ARE the enum values. Default none: push is opt-in. 018 briefly defaulted it to all and 019 put it back — what makes the opt-in reachable is that the app now offers it (first-run deck + ui/push-prompt.js), not a pre-set column.';
