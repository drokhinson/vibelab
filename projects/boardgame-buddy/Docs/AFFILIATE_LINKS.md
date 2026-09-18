# Affiliate links — how to set each partner up, and what stays off until you do

BoardgameBuddy can show a **Where to buy** section under every game, one pill
per retailer, with the disclosure each program requires beside it. This
document is the operator's side of that: how to join each program, what it
hands you, where to paste it, and what the app promises about it.

**Nothing is showing to readers until you finish a partner's setup.** The four
partner rows ship disabled with no credentials (migration 045), and a partner
renders only when it is *enabled* **and** holds a *tracking tag* or a *wrapper
link*. Enabling a row with neither is refused. Disabling is instant and needs no
deploy.

## Where the switch is

**Settings → Admin tools → Affiliate partners** (`/admin/affiliates`, admins
only). The list shows each partner's state — *Off*, *Enabled · no credential*,
or *Live* — and, for live ones, taps in the last 30 days. **Edit** opens the
row; **Enable** / **Disable** is the switch.

The editor's fields, and what each is for:

| Field | What goes in it |
|---|---|
| **Label on the pill** | The retailer's name as the reader sees it. |
| **Tracking tag** | A value the program issued that goes *into* the store URL — substituted for `{tag}`. Amazon's Store ID is the model. |
| **Wrapper link** | A redirect the program issued that goes *around* the store URL — the store link is placed where `{url}` is, percent-encoded. Impact-style tracking links are the model. |
| **Store URL template** | The retailer's search page, with `{query}` for the game's name. Pre-filled; change it only if the retailer changes its search URL. |
| **Required disclosure** | A sentence the program makes you show beside its links, if it has one. Pre-filled for Amazon. |

**Link preview** under the form shows the exact URL the app will build for a
sample game, from the *saved* row — press Save, then read it. The same server
function builds the preview and the real pills, so what you see is what a
reader gets. A partner can be previewed while it is off.

**The order of operations, every time:** apply to the program → wait for
approval → paste what they issued → Save → read the preview → Enable.

## The partners

### Amazon (Amazon Associates)

1. Apply at [affiliate-program.amazon.com](https://affiliate-program.amazon.com/).
   You will describe the site (`https://bgbuddy.app`) and how you send traffic.
2. Approval issues a **Store ID** (also called a tracking ID) that looks like
   `bgbuddy-20`. The `-20` suffix is the US marketplace.
3. Paste it into **Tracking tag**. Leave **Wrapper link** empty. The store
   URL template is already `https://www.amazon.com/s?k={query}&tag={tag}`.
4. Save, check the preview ends in `&tag=bgbuddy-20`, then Enable.

Amazon's rules that the app already honours, and that you must not undo:

- The sentence **"As an Amazon Associate, BoardgameBuddy earns from qualifying
  purchases."** must appear wherever Amazon links do. It is pre-filled in
  **Required disclosure** and rendered under the pills whenever Amazon is live.
  Do not clear it.
- Every Amazon link must carry the tag. The app never renders an Amazon pill
  without one (a missing tag is what keeps the row *not live*).
- No link shorteners that hide the destination. The pill's `href` is the
  Amazon URL itself.
- **Three qualifying sales within 180 days of approval**, or Amazon closes the
  account. Enable Amazon only once the app has enough readers to make that
  plausible, or be prepared to re-apply.
- Amazon may ask to see the disclosure and the links; the Terms page (§6) and
  the Privacy page (§4, §5) describe them.

### Miniature Market

1. Apply at [miniaturemarket.com/affiliate-program](https://www.miniaturemarket.com/affiliate-program).
   The program runs on **Impact**; approval gives you an Impact account.
2. In Impact, create a **tracking link**. It looks like
   `https://miniaturemarket.sjv.io/c/1234/5678/9012?u=https%3A%2F%2Fwww.miniaturemarket.com%2F`.
3. Paste it into **Wrapper link** with the destination replaced by `{url}`:
   `https://miniaturemarket.sjv.io/c/1234/5678/9012?u={url}`. Leave **Tracking
   tag** empty. The store URL template
   (`https://www.miniaturemarket.com/searchresults/?q={query}`) is what goes
   into `{url}`.
4. Save, check the preview is your Impact link with the encoded search URL
   after `u=`, then Enable.

Commission and payout terms are Impact's; at the time of writing the program
listed a 5% commission. Confirm the current terms in the Impact dashboard.

### GameNerdz

1. Apply through [gamenerdz.com/partners-affiliates](https://www.gamenerdz.com/partners-affiliates).
   The program's network was not confirmed when this was written — read what
   they send you.
2. If they issue a **redirect link** (a URL on another domain that forwards to
   their store), treat it like Miniature Market's: paste it into **Wrapper
   link** with `{url}` where the destination goes.
3. If they issue a **URL parameter** (something like `?ref=abc123` or
   `&aff=…`), add it to the **Store URL template** as `&ref={tag}` (using their
   parameter name) and paste the value into **Tracking tag**.
4. Save, read the preview, Enable.

### Noble Knight Games

No formal affiliate program was found; Noble Knight credits referrals on
request. Write to them (the contact form at
[nobleknight.com/contact](https://www.nobleknight.com/contact)) and ask for a
referral parameter or link. Then follow GameNerdz's step 2 or 3 depending on
what they issue. If they offer nothing trackable, leave the row **Off** — an
untracked pill earns nothing and still needs the disclosure.

## What the app promises, so you do not have to

- **Off until set up.** No pill, no heading, no disclosure appears anywhere
  until a partner is live. The Discover tab's "Shop these games" line follows
  the same rule.
- **One link builder.** `api/routes/services/affiliate_service.py:build_url`
  is the only code that turns a partner row and a game into a URL. The preview
  and the pills are the same call.
- **Disclosure travels with the pills.** The generic line ("Some links are
  affiliate links…") and each live program's required sentence render inside
  the Where to buy section, never on their own and never absent when pills are
  present. The Terms page has an *Affiliate links* section and the Privacy page
  names retailers as an outbound destination.
- **Taps are counted without an account.** A tap logs the partner, the game,
  the screen and the time — no user id, no IP, no device — so the Privacy
  page's "usage counts carry no account identifier" stays true. A tap on a
  partner that has since been switched off is dropped, not counted.
- **Ten minutes to reach everyone.** The server caches the partner list for
  ten minutes and the client for five; your own device sees a change at once
  because every admin write clears both.

## Before enabling anything: BoardGameGeek's terms

Game names, art and the Discover tab's trending and ratings come from
BoardGameGeek's XML API, whose terms of use restrict commercial use of the
data. Affiliate pills beside BGG-sourced content may need BGG's permission.
Confirm with BoardGameGeek (or obtain a commercial licence) before enabling
the first partner, and record the outcome here.

## Where things live

| What | Where |
|---|---|
| The tables and the seeded rows | `db/migrations/045_affiliate_partners.sql` |
| The live rule and the URL builder | `api/routes/services/affiliate_service.py` |
| The endpoints | `api/routes/affiliate_routes.py` (`GET /affiliate/links`, `POST /affiliate/click`, `/affiliate/admin/*`) |
| The pills | `web/ui/buy-links.js`, painted by `web/views/game-detail-view.js` |
| The Discover line | `web/views/discovery-view.js#_loadShopFooter` |
| The admin screen | `web/views/admin-affiliates-view.js` + `web/widgets/affiliate-partner-editor.js` |
| Tests | `api/tests/test_affiliate.py`, `tools/check-affiliate-links.mjs` |
