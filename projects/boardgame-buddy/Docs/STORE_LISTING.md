# Store listing — copy, and the shot list

What goes in Google Play and the App Store when the native app ships. The copy
is written now because it is the part that does not depend on the app existing;
the artwork is not, and the reason is below.

Everything here follows `Docs/BRAND_VOICE.md`. Read it before editing a line —
in particular rule 3, *no "actually"*, which this file has been through once
already.

---

## Why there is no artwork in this change

`hasNativeApp` is `false`. There is no `app/` tree, no simulator, and nothing
to screenshot. Rather than draw eight fake screens that will be wrong by the
time there is something to compare them against, the **animated vignettes in
`web/` are the artwork source**, and each shot below names the vignette and the
*beat* it is cut from.

That works because of one decision in `web/ui/tour-vignette.js`: a beat is an
**idempotent state application**, not a keyframe, so `seek("template-on")` lands
on exactly one frame, deterministically, with transitions suppressed. A capture
step, when it is written, is therefore small: a harness page that mounts one
scene, calls `seek(beat)`, and screenshots at the store's dimensions.

`tools/build-og-banner.py` is the precedent for the rasterising half — it
already shells out to headless Chromium with `--screenshot` and crops with
Pillow, including the `RENDER_PAD` guard for Chromium painting less than the
window it was given. Copy that, not a new approach.

`tools/check-tour.mjs` asserts that every `<scene> @ <beat>` pair cited below still
resolves, so a renamed beat fails a test rather than producing a screenshot of
the wrong frame months later.

---

## Copy

Character counts are stated because every one of these is a hard limit and the
store rejects, rather than truncates, a field that overruns.

### Google Play

**Short description** (≤80) — 72:

> Half scoresheet, half scrapbook. Keep score, log the night, see who won.

`Half scoresheet, half scrapbook` is the runner-up line `BRAND_VOICE.md` holds
for "a one-line product description — an app-store subtitle, a directory
listing". It is **31 characters**, so it fits here and *overruns Apple's
30-character subtitle by one*. That is why the two stores do not share a line.

**Full description** (≤4000). The first three sentences are what shows above
"Read more":

> BoardgameBuddy remembers your game nights. Log who played, who won and what it
> was scored on — then keep score for the next one on a scorepad the community
> has already built for that exact game.
>
> KEEP SCORE FOR ANY GAME
> Start a game, share the join code, and everyone at the table watches the same
> scorepad update live. It starts generic and stays that way until you switch on
> a community scoring template, which turns it into that game's real scoresheet —
> species, paths, hand size, whatever the game counts. Expansions add their rows
> on top, or replace the base game's, the way the expansion says.
>
> THE RULES, WITHOUT THE RULEBOOK
> Somebody has already looked up the rule you are stuck on. Pull their chapter
> into your own reference guide — setup, turn order, scoring, card references —
> and read it one-handed at the table. Once it is yours, you can edit it.
>
> YOUR TABLE, AND YOUR PEOPLE
> Add the people you sit down with, by QR code or by name. Every play lands in
> one shared feed, grouped by the night it happened rather than scattered by who
> got round to logging it. Players without accounts still get counted.
>
> YOUR RECORD, AND THE HEAD-TO-HEAD
> Wins, podiums, streaks, and the game you are quietly bad at. Because the log is
> shared, you also get the comparison nothing else gives you: how you do against
> the specific people you play with.
>
> WHAT TO PLAY NEXT
> Suggestions drawn from the games you play most and the shelf you already own,
> each one saying why it is there. Plus what is climbing on BoardGameGeek.
>
> BRING YOUR COLLECTION
> Import your BoardGameGeek collection and play history in a few taps, or type a
> night in from a photo of the scorepad.
>
> Free to start.

### App Store

**Subtitle** (≤30) — 27:

> Keep score. Keep the night.

**Promotional text** (≤170) — 134. Editable without a new build review, so this
is the slot for a "what's new" beat:

> Live scoring with community templates, a reference guide you can read at the
> table, and one shared feed with the people you play with.

**Description** — the Play full description above, unchanged. The two stores
differ only in the short line, for the character-count reason above.

**Keywords** (≤100, comma-separated, no spaces after commas, no words repeated
from the title) — 89:

> `boardgame,board game,scorepad,score keeper,tabletop,game night,bgg,play log,scoring,rules`

---

## The shot list

Eight shots, ordered. Play shows the first 1–3 in search results and the App
Store shows the first 2–3, so the order is the argument: what it is, then the
thing nothing else does, then the rest.

| # | Cut from | Caption |
|---|---|---|
| 1 | `community @ kudos` | Your Games, Your People, Your Record. |
| 2 | `scoring @ template-on` | A scorepad that knows the game |
| 3 | `scoring @ expansion-on` | Expansions add rows, or replace them |
| 4 | `scoring @ settle` | Settle up — and it is logged for everyone |
| 5 | `guides @ open` | The rules, without the rulebook |
| 6 | `stats @ nemesis` | Your record, and the head-to-head |
| 7 | `discover @ pick-3` | What to play next, with the reason |
| 8 | `community @ more` | One feed for everyone who was at the table |

Shot 1's caption is the other runner-up line `BRAND_VOICE.md` keeps on purpose,
and that file names "an app-store screenshot caption" as one of its homes. Keep
the possessive; the version without "your" loses the point.

Capture **both themes** and pick per store later. The app ships light and dark
as equals (`.claude/rules/theming.md`), and a listing that only shows one is
selling half the app.

---

## Dimensions

From `.claude/commands/build-native.md`, which is the source of truth — check it
rather than this table if the two ever disagree.

| Asset | Size | Notes |
|---|---|---|
| Play phone screenshots | 1080×1920 portrait | min 2, max 8 |
| Play feature graphic | 1024×500 | critical text in the upper 70% |
| Play high-res icon | 512×512 PNG | uploaded in console, not in the tree |
| App Store iPhone 6.7" | 1290×2796 | required |
| App Store iPhone 6.5" | 1242×2688 | Apple may derive these from the 6.7" set |
| App Store icon | 1024×1024 PNG | **no alpha** — Apple rejects icons with it |

The app icon is not a screenshot and is not generated: `web/assets/brand/`
already carries `bgb-logo.svg` plus the PNG ladder. Re-export from the SVG.

---

## Required hosted URLs

Both stores reject a submission without them, and both are already live on the
web app:

| Field | URL | View |
|---|---|---|
| Privacy policy | `https://bgbuddy.app/privacy` | `web/views/privacy-view.js` |
| Terms of service | `https://bgbuddy.app/terms` | `web/views/terms-view.js` |
| Support / marketing | `https://bgbuddy.app/tour` | `web/views/tour-view.js` |

`/tour` is public and works signed out, which is what makes it usable as the
listing's marketing link.
