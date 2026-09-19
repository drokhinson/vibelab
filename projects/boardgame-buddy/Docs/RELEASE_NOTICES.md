# Release notices — source text

The in-app "what's new" notices, kept here as the drafting surface for the
popup that ships them.

**This file is not read by anything.** A notice only exists once it has been
typed into the admin spoke at **/admin/release-notices** (Settings → Release
notices, admin only) and published there — that is what writes
`boardgamebuddy_release_notices` and what the `/bootstrap` payload reads. The
copy lives here because a popup that every user sees exactly once deserves a
review pass in a pull request rather than in a textarea, and because the
Settings archive is the only other place it can be read back.

Not to be confused with `Docs/release-notes-v2.md`, which is an app-store
document about a version. These are in-app notes about a feature.

## How to use an entry below

Each entry maps 1:1 onto the four fields of the editor:

| Here | Editor field | Cap |
|---|---|---|
| `### <heading>` | Title | 120 chars |
| the body | What changed (markdown) | 8000 chars |
| **Take me there** | the route picker | param-free routes only |
| **Button** | the label beside it | 40 chars |

Markdown is rendered by `web/ui/markdown.js`: `**bold**`, `*italic*`, `-`
lists, `##` headings. Do **not** put an in-app destination in a markdown link —
that renderer opens every link in a new tab. Use the route picker.

Publishing is the moment a notice becomes visible, and `published_at` is the
watermark users' "seen" marks compare against, so a notice is only ever read by
people who open the app **after** it goes live. Editing a published notice does
not re-show it. Keep entries here in publication order, newest last.

---

## Unpublished drafts

### Score on the game's own sheet

**Take me there:** `collection` · **Button:** Open my collection

Rounds work until they don't — a game whose score lives in eight columns wants
those eight columns, not a running total. So a game can now carry a **scoring
grid**: an ordered list of scoring categories, each one labelled, colour-tagged,
and annotated where a rule needs the reminder. Put one on the table and the
scorepad opens with those rows already drawn, a column per player.

**Making one, or taking one.**

A grid is a chapter in a game's reference guide, so both halves live on the
game's own page under **Reference guide**:

- **Adopt one somebody already wrote.** Browse prints each grid's real rows, its
  author and how many people use it — you are picking between scorepads you can
  see, not names. Add it and it is yours; **Edit guide** on the same page takes
  it back off.
- **Write your own.** New chapter, type **Scoring Grid Template**, then either
  rough the rows out with AI or fill them in from the box. Up to 24 rows, ten
  row colours, an optional note per row. You do not name it — it takes the
  game's.

Sit down to a game that has grids you have never adopted and you will be asked
once, with the rows on screen. One question per game on the table, and a thumbs
down means you are not asked again.

**When there is an expansion.**

An expansion is its own game, so it can carry its own grid — and writing one
asks how it meets the base game's:

- **Add these rows** — they join the base game's rows underneath, each one
  marked with the expansion's colour down its edge. Everdell plus Pearlbrook is
  the fourteen base rows, then Pearls and Wonders. This is the common case.
- **Replace the template** — the expansion reprints the whole sheet and the base
  game's rows sit the night out. A big box, or a campaign mode.

A replacement is a **default, not a lockout**: with its box on the table it is
what the scorepad opens on, and the base game stays a pill on the scoring bar,
so the plain game is always one tap away. Add-ons are never pills — they are not
an alternative to anything, they fold into whichever pill is on, and several
expansions stack in publication order so two people scoring the same game with
the same boxes get the same sheet.

### A Discover tab that reads your own shelf

**Take me there:** `discovery` · **Button:** Open Discover

**Discover** is where the app answers "what should we play next". Five rails,
one screen:

- **Picked for you** — the catalog scored against your shelf and your plays, and
  every tile says why it is there: *Because you play Wingspan*, *Shares Deck
  Building and Drafting with your shelf*, *Fits your usual table*. What you own
  counts, what you wishlist counts, and what has hit your table in the last
  three months counts most — taste drifts. Games you already own or have
  wishlisted are left out, because pointing at those is not discovery.
- **Trending on BoardGameGeek** — BGG's hot list, each game with its rank and
  which way it moved since yesterday. A game the catalog has never seen is still
  a tile: tap it and it imports.
- **Climbing this week** — the half of a hot list worth reading. What actually
  moved up, when enough of it did.
- **New in 2026** — this year's releases, best-ranked first.
- **Back on the shelf** — games you own that have not been played in sixty days.

Brand new account? The picks start from the best-ranked games in the catalog and
sharpen as you add a shelf and log a few nights. Pull down to refresh any of it.

Trending and ratings courtesy of BoardGameGeek.

---

## Published

_Nothing recorded here yet — entries move up from **Unpublished drafts** once
they are live, newest last._
