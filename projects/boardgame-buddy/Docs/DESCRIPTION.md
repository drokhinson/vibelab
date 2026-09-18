# BoardgameBuddy — the description

Written against `BRAND_VOICE.md`. The tagline is fixed
(**Games Played, Nights Remembered.**) and lives in the eight places that file
tabulates; this file is everything *underneath* it — the sentence, the
paragraph and the long form that a store listing, a directory entry or a link
preview needs when a tagline alone is not enough.

Nothing here is shipped copy yet. The strings currently live in
`index.html`, `manifest.json` and `landing/registry.json` are unchanged; where
one of these lengths is meant to replace one of them, the table at the bottom
says so.

---

## The short forms

**Store subtitle** (Apple's slot is 30 characters):

> Keep score. Keep the night.

**Short description** (Google Play's is 80):

> Half scoresheet, half scrapbook. Log the game, keep the night.

`Half scoresheet, half scrapbook.` is the runner-up `BRAND_VOICE.md` holds
back from the tagline *because* it describes the software — which is exactly
what a store subtitle is for. This is its home.

**One sentence** (meta description, link preview, a directory listing):

> Boardgame Buddy keeps the score, the rules you need mid-game, and the record
> of who was around the table — so the night survives the box going back on
> the shelf.

---

## The paragraph

For a landing card, an app directory, the first screen of a press kit:

> Board game nights are easy to have and easy to lose. Boardgame Buddy holds
> on to them: one person hosts, everyone else joins with a short code, and the
> score grid fills in live on every phone at the table. When the box goes back
> on the shelf you keep the result, the people, and the rules chapter that
> settled the argument.

---

## The long form

For a store listing body, the About page, anywhere with room to run:

> Somebody wins, somebody gets robbed, somebody teaches the rules wrong. A
> week later nobody can name the game.
>
> Boardgame Buddy is a log for the table. One person hosts; everyone else
> joins with a short code and watches the score grid fill in live from their
> own phone. The host is walked through it in three steps — gather the
> players, play the game, settle up — and the app does the counting. No signal
> where you're playing is fine: hosting runs from cache and the play uploads
> itself the next time you're online. There is nothing to switch on.
>
> Afterwards it's a feed. Your plays and your buddies' in order, what's hot
> this week, people you might know from the tables you've shared. Your profile
> is public — a stats strip, a collection grid, and badges that stay earned
> even if you delete the play, because the evening still happened.
>
> The reference guides are yours to build. Write a chapter for the setup step
> you always forget or the rule your group has been playing wrong for a year,
> keep it to your own guide, or take one from the community pool. The table
> reads it mid-game instead of passing the rulebook around.
>
> Bring your shelf over from BoardGameGeek. And the people you've been logging
> who never signed up can turn up later and claim their own record.
>
> **Games Played, Nights Remembered.**

---

## Why it reads like this

**It opens on the night, not the feature.** Rule 1. The first paragraph
contains no product at all — it is the evening the app is for, and the reader
recognises it before they are told what the software does. "Track your plays"
appears nowhere, because every competitor's listing already says it.

**The jokes are about the table, never about the reader.** `BRAND_VOICE.md`
holds *Play it. Log it. Gloat.* and *Winning is temporary. The log is forever.*
back from outward-facing copy because a joke at the reader's expense lands on a
stranger as a jab. *Somebody gets robbed, somebody teaches the rules wrong* is
a different joke: it is about a game night in general, one the reader is
invited to recognise rather than be caught by. The shelf of unplayed games is
not mentioned, and will not be — that joke belongs to the user, inside the app,
about themselves.

**Concrete beats abstract.** Rule 2. Not "capture your memories" but *the rules
chapter that settled the argument*; not "offline support" but *no signal where
you're playing is fine*; not "persistent achievements" but *badges that stay
earned even if you delete the play*.

**No day is named.** Rule 4. Not one "Friday", anywhere.

**The five things are in feature order, night order.** The app is a
scoresheet, a reference, a collection, a discovery tool and a feed — too many
for one line, which is what the tagline exists to solve. The long form can
carry all five, so it walks them in the order the night does: the table first,
the record after, the guide you needed during, the shelf you brought with you.

---

## What goes where

| Slot | Which length | Currently |
|---|---|---|
| App Store subtitle | store subtitle | no native app yet — `hasNativeApp: false` |
| Google Play short description | short description | same |
| Store listing body / About page | long form | nowhere yet |
| `web/index.html` → `meta name="description"` | one sentence | tagline + its own explainer; leave unless the listing copy is unified |
| `web/index.html` → `og:description` | tagline alone | correct as is — a preview card that repeats itself under a banner that already says it reads as a stutter |
| `landing/registry.json` → BGB `description` | tagline + explainer clause | correct as is; the card has one line of room |
| Press kit / directory submission | paragraph | — |

The line `BRAND_VOICE.md` keeps for a fresh account's empty state and an
onboarding first slide — **Your Games, Your People, Your Record.** — is not a
description and does not belong in any of these slots. It is a triad; it works
where the reader has already signed up.
