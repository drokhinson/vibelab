# BoardgameBuddy — voice, and the tagline

The tagline is:

> **Games Played, Nights Remembered.**

Set 2026-09-16, after three rounds of ideation over about ninety candidates.
Title case, with the period, because it reads as a statement rather than a
sentence — and because the two halves are meant to balance.

## Where the line actually lives

Four places, and they have to be changed together or the card and the page
disagree:

| Where | What |
|---|---|
| `tools/build-og-banner.py` → `COPY["tagline"]` | the banner artwork; re-run the script after editing |
| `web/assets/brand/bgb-og-banner.{svg,png}` | the generated output, committed |
| `web/index.html` → `og:description`, `og:image:alt` | the link-preview card |
| `web/index.html` → `meta name="description"` | the tagline plus the explainer sentence |

The banner's type is **outlines, not text** (see the header of the generator for
why), so the tagline cannot be edited in the SVG by hand. Change `COPY` and
re-run.

## Why this line

The app is five things — a reference you read mid-game, a scoresheet, a
collection manager, a discovery tool, and a feed of what your buddies played.
No three-word line carries five things, so the tagline's job is to name the
**one object all five serve**: the night.

"Games played" is the record half — the log, the scores, the collection. "Nights
remembered" is the half nothing else on the market does: BoardGameGeek has the
database, a notes app has the scores, and neither keeps the evening. Both halves
use the same compressed `noun + past participle` shape, which is what makes it
scan as one phrase rather than two features.

## Runners-up, kept on purpose

**`Your Games, Your People, Your Record.`** The closest second, and it is still
live — it survives a change of tagline because it is a *different shape*: a
triad, which suits a place the primary line does not reach. Obvious homes if you
want it: an onboarding deck's first slide, the empty state on a fresh account,
an app-store screenshot caption, or merch. Keep it in the possessive — the
version without "your" loses the whole point.

**`Half scoresheet, half scrapbook.`** The only line from the whole exercise
that carries *recorder AND social* in one breath. Better as a one-line product
description (an app-store subtitle, a directory listing) than as the tagline,
because it describes the software rather than the night.

**`The buddy who was paying attention.`** The most ownable line written, because
a competitor cannot use the word. Held back only because it personifies the app
harder than the rest of the product currently does. If BGB ever grows a real
voice in its own copy — toasts, empty states, achievement cards — this is the
line to build it on.

## The funny ones, and where funny belongs

Two lines landed as genuinely funny and should not be thrown away:

> **Play it. Log it. Gloat.**
> **Winning is temporary. The log is forever.**

**Neither should be the tagline.** Both are jokes at the reader's expense, and a
tagline is read by someone who has not yet decided to trust the app — the joke
lands on a stranger as a jab. They are excellent *in* the product, where the
reader has already opted in:

- an achievement or wrap-up card after a win,
- the empty state on a profile with no plays yet,
- a toast after logging a play,
- merch. **Winning is temporary. The log is forever.** is the best t-shirt in
  the set, and merch is the one surface where a joke needs no context.

## Tone rules, derived from the exercise

1. **Name the night, not the feature.** "Track your plays" is what the app does.
   Every competitor says it, and it describes the least interesting half.
2. **Concrete beats abstract.** "Who won" outperformed "memories" every time —
   it is funnier, more specific, and implies the argument, the rivalry and the
   record at once.
3. **No "actually".** The previous tagline was *"A log for the games you actually
   played"*, and the word quietly scolds the reader about their unplayed shelf.
   Self-deprecating jokes about the shelf of shame are for *inside* the app,
   made by a user about themselves — never by the app about the user.
4. **Don't name a day.** "Friday nights, filed" was the best-sounding line in one
   round and was cut for this: half the audience plays Tuesdays. Alliteration is
   not worth excluding people from their own app.
5. **Avoid "every X counts".** It is Strava's, and the echo invites "so it's
   Strava for board games", which undersells the reference and collection halves.
6. **A triad's middle beat carries the register.** The starter
   *"Unboxed, Uncomplicated, Unforgettable"* breaks because *uncomplicated* is
   about the software while the other two are about the evening. Fix the middle
   word, not the ends.

## One thing the tagline is not

It is **not** the OAuth consent screen. Google's screen takes the app name and a
120×120 square logo (`web/assets/brand/bgb-logo.svg`) and has no tagline or
banner slot at all. The banner exists for link previews, which is the only place
a 1.91:1 image is rendered.
