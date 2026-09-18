-- 045_affiliate_partners.sql — retailer partners under every game, off by default.
--
-- WHY. The Discover tab (038/039) finds games; this is where finding one turns
-- into revenue. A partner row is a retailer BoardgameBuddy can send a reader to
-- with a tracked link — Amazon Associates, Miniature Market's Impact program,
-- and so on — and the "Where to buy" section on a game page renders one pill
-- per LIVE partner.
--
-- NOTHING IS LIVE UNTIL SOMEONE MAKES IT SO. That is the whole contract:
--
--   live = enabled AND (tracking_tag IS NOT NULL OR wrapper_template IS NOT NULL)
--
-- Every seeded row is disabled with no credentials, so applying this migration
-- changes nothing a reader can see. An admin pastes what the program issued
-- (Settings → Admin tools → Affiliate partners), checks the Preview, and only
-- then enables the row; enabling with neither credential is refused by the API.
-- Disabling is instant and needs no deploy. See Docs/AFFILIATE_LINKS.md.
--
-- TWO WAYS A LINK IS TRACKED, because the programs differ:
--   tracking_tag      a value substituted into url_template's {tag} — Amazon's
--                     Store ID (`bgbuddy-20`) is the model.
--   wrapper_template  a network redirect wrapped AROUND the resolved store URL,
--                     with {url} = the store URL, percent-encoded — Impact's
--                     `https://x.sjv.io/c/…?u={url}` is the model. Miniature
--                     Market issues these; there is no tag to substitute.
-- A partner may use either or both; the resolver (affiliate_service.build_url)
-- substitutes {query} and {tag} first, strips a dangling `tag=` when the tag is
-- empty, then wraps.
--
-- THE CLICK LOG CARRIES NO USER. Privacy §5 promises usage records carry no
-- account identifier, and a retailer tap is a usage record. partner + game +
-- surface + time is enough to answer "is this partner earning its pill".

BEGIN;

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_affiliate_partners (
  id               TEXT NOT NULL,
  label            TEXT NOT NULL,
  url_template     TEXT NOT NULL,
  wrapper_template TEXT,
  tracking_tag     TEXT,
  disclosure       TEXT,
  notes            TEXT,
  display_order    INTEGER DEFAULT 0 NOT NULL,
  enabled          BOOLEAN DEFAULT false NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT now() NOT NULL,
  updated_at       TIMESTAMPTZ DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_affiliate_partners_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_affiliate_partners_id_slug_chk CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,40}$')
);
ALTER TABLE public.boardgamebuddy_affiliate_partners ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_affiliate_partners TO boardgamebuddy_role;

COMMENT ON TABLE public.boardgamebuddy_affiliate_partners IS
  'Retailers a game page can link to. live = enabled AND (tracking_tag OR wrapper_template): a row with neither credential never renders, enabled or not. Edited only through /affiliate/admin/*; read by GET /affiliate/links.';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.url_template IS
  'The store URL with {query} (the game name, URL-encoded) and optionally {tag} (tracking_tag). Resolved server-side by affiliate_service.build_url.';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.wrapper_template IS
  'Optional network redirect wrapped around the resolved store URL, with {url} = that URL percent-encoded (Impact: https://x.sjv.io/c/A/B/C?u={url}). Counts as a credential for the live rule.';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.tracking_tag IS
  'The value for {tag}. Counts as a credential for the live rule. NULL until the program approves the account.';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.disclosure IS
  'A sentence the program requires beside its links (Amazon''s "As an Amazon Associate…"). Rendered under the pills only while the partner is live.';
COMMENT ON COLUMN public.boardgamebuddy_affiliate_partners.notes IS
  'Operator hint shown in the admin editor: what to paste where. Never rendered to readers.';

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_affiliate_clicks (
  id         UUID DEFAULT gen_random_uuid() NOT NULL,
  partner_id TEXT NOT NULL,
  game_id    UUID,
  surface    TEXT NOT NULL,
  clicked_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  CONSTRAINT boardgamebuddy_affiliate_clicks_pkey PRIMARY KEY (id),
  CONSTRAINT bgb_affiliate_clicks_partner_fkey FOREIGN KEY (partner_id)
    REFERENCES public.boardgamebuddy_affiliate_partners(id) ON DELETE CASCADE,
  CONSTRAINT bgb_affiliate_clicks_game_fkey FOREIGN KEY (game_id)
    REFERENCES public.boardgamebuddy_games(id) ON DELETE SET NULL,
  CONSTRAINT bgb_affiliate_clicks_surface_chk CHECK (surface IN ('game_detail', 'discover'))
);
ALTER TABLE public.boardgamebuddy_affiliate_clicks ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_affiliate_clicks TO boardgamebuddy_role;
CREATE INDEX IF NOT EXISTS idx_bgb_affiliate_clicks_partner
  ON public.boardgamebuddy_affiliate_clicks (partner_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_bgb_affiliate_clicks_game
  ON public.boardgamebuddy_affiliate_clicks (game_id, clicked_at DESC);

COMMENT ON TABLE public.boardgamebuddy_affiliate_clicks IS
  'One row per tap on a partner pill. No user column, by design: privacy §5 says usage records carry no account identifier. Written by POST /affiliate/click, summarised by GET /affiliate/admin/clicks.';

-- ── Seed: the four partners, ALL DISABLED, no credentials ────────────────────
-- Applying this changes nothing a reader can see. Each `notes` line is the
-- short form of Docs/AFFILIATE_LINKS.md for that partner.
INSERT INTO public.boardgamebuddy_affiliate_partners
  (id, label, url_template, wrapper_template, tracking_tag, disclosure, notes, display_order, enabled)
VALUES
  ('amazon', 'Amazon',
   'https://www.amazon.com/s?k={query}&tag={tag}',
   NULL, NULL,
   'As an Amazon Associate, BoardgameBuddy earns from qualifying purchases.',
   'Amazon Associates issues a Store ID (looks like bgbuddy-20). Paste it into Tracking tag. Leave Wrapper empty. Amazon requires the disclosure sentence above wherever its links appear — do not remove it.',
   10, false),
  ('miniature-market', 'Miniature Market',
   'https://www.miniaturemarket.com/searchresults/?q={query}',
   NULL, NULL,
   NULL,
   'Runs on Impact. Once approved, create a tracking link there and paste it into Wrapper with the destination replaced by {url}, e.g. https://miniaturemarket.sjv.io/c/1234/5678/9012?u={url}. Leave Tracking tag empty.',
   20, false),
  ('gamenerdz', 'GameNerdz',
   'https://www.gamenerdz.com/search.php?search_query={query}',
   NULL, NULL,
   NULL,
   'Apply at gamenerdz.com/partners-affiliates. If they issue a redirect link, paste it into Wrapper with {url} where the destination goes; if they issue a URL parameter, add it to the URL template as &ref={tag} and paste the value into Tracking tag.',
   30, false),
  ('noble-knight', 'Noble Knight Games',
   'https://www.nobleknight.com/Products/Search?searchTerm={query}',
   NULL, NULL,
   NULL,
   'No formal program was found; they credit referrals on request. Ask them for a referral parameter, add it to the URL template as &ref={tag}, and paste the value into Tracking tag.',
   40, false)
ON CONFLICT (id) DO NOTHING;

COMMIT;
