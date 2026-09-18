# BoardgameBuddy — the BoardGameGeek API application

Copy for the application form at **boardgamegeek.com/applications**, whose
output is the `BGG_API_TOKEN` in `ENV.md` ("rate-limit headroom").

Register is deliberately flat — a reviewer is deciding whether to grant access,
not being sold to, so `BRAND_VOICE.md` does not apply here. No tagline, no
jokes. Every number below is read off the code; the table in §6 is the argument,
because it shows the API is being used sparingly on purpose.

**Fill these in before submitting** — they are the only things not derivable
from the repo: a contact address, current user count, and observed requests/day.
They appear as `«…»` below.

---

## 1. Application name

> Boardgame Buddy

## 2. URL

> https://bgbuddy.app

## 3. One-line description

> A free web app for logging in-person board game nights — scores, who played,
> and a per-game reference guide the table can read mid-game.

## 4. What the application does

> Boardgame Buddy records board games played face to face. One person at the
> table hosts a session; everyone else joins from their own phone with a short
> code and watches the score grid fill in. When the game ends the result is
> kept — the game, the players, the scores, the date.
>
> Around that sit four things: a chronological feed of a user's own plays and
> those of buddies they have accepted; a public profile with play statistics
> and a collection grid; a user-built reference guide system, where players
> write short chapters for a game's setup steps or commonly misplayed rules and
> can share them to a community pool; and a discovery screen showing what is
> trending and what a user's buddies have been playing.
>
> It is an independent hobby project, free to use, with no advertising and no
> paid tier. It runs as a static web front end against a single Python
> (FastAPI) backend at api.bgbuddy.app. Current scale: «N» registered users,
> «N» plays logged.

## 5. How it uses the BGG API, and why

> BoardGameGeek is the app's source of game identity. A game in Boardgame Buddy
> is stored against its BGG id, which is what lets two users who logged "Cascadia"
> be talking about the same game, and what lets a user's existing collection and
> play history come across intact rather than being retyped.
>
> Five endpoints on `xmlapi2`:
>
> - **`/thing`** — a game's name, year, player count, playing time, description
>   and thumbnail, shown on the game page and stored on our local row for that
>   game. This is the bulk of our traffic.
> - **`/search`** — the in-app game search, when a user adds a game we do not
>   already hold locally.
> - **`/hot`** — the trending strip on the discovery screen.
> - **`/collection`** — a linked user's own collection, fetched only when that
>   user asks for it.
> - **`/plays`** — a linked user's own play history, for an optional one-time
>   import when they first link their account.
>
> The last two run only against the account of the user who linked it, only on
> an explicit action of theirs, and never on a schedule. Users link and unlink
> from the app's settings screen; stored credentials are encrypted at rest.

## 6. Rate-limit discipline

> The API is treated as a scarce resource, and most of the app's game data is
> served without touching it at all:
>
> | Call | Cached for | Practical frequency |
> |---|---|---|
> | `/thing` | 24 hours, server-side | Once per game per day for the **entire user base**, not per user |
> | `/search` | 1 hour, server-side | User-initiated only |
> | `/hot` | 1 hour, server-side | At most once an hour **for the whole service** |
> | `/collection` | — | User-initiated; 1.5s enforced between calls within a sweep |
> | `/plays` | — | User-initiated, one-time, hard-capped at 50 pages |
>
> Also:
>
> - Owned-count lookups are batched at 20 ids per request, with at most 6
>   requests per user action.
> - A `202`, or a `200` carrying the "still being prepared" placeholder, is
>   retried with backoff — never re-requested immediately in a loop.
> - Requests identify themselves honestly as `vibelab-boardgame-buddy/1.0`.
> - The backend runs a single worker, so these limits are service-wide rather
>   than per-process.
>
> We do not mirror, bulk-download or redistribute BGG's database. We hold the
> metadata fields listed in §5 for games our users have actually played or
> added, fetched one game at a time as they come up.

## 7. Attribution

> BoardGameGeek is credited where its data appears: the discovery screen
> carries "Trending and ratings courtesy of BoardGameGeek." beneath the
> trending strip, and the BGG logo is shown on the settings screen where a user
> links their account (`web/assets/credits/`).

## 8. What we are asking for, and why

> A token for rate-limit headroom. Ordinary browsing does not need it — the
> 24-hour `/thing` cache means a popular game is fetched once a day no matter
> how many users open it. The ceiling we run into is the user-initiated burst:
> a new user linking their account and importing a collection of several
> hundred games, which is a sequence of throttled calls that currently has to
> be spread out or resumed. Current volume is «N» requests/day averaged over a
> week, with peaks of «N».

## 9. Contact

> «name» — «email»

---

## One thing to decide before submitting

**Whether to mention the collection *write* path.** `bgg_write.py` pushes a
user's plays back to their BGG collection, and it does not use `xmlapi2` at
all — BGG has no write API, so it posts to `geekcollection.php` as the
logged-in user, with a browser User-Agent, because Cloudflare screens
non-browser-shaped POSTs (`BGG_WEB_USER_AGENT`, and the reasoning in
`bgg_client.py`). It currently ships behind `BGG_PUSH_DRY_RUN`, which `ENV.md`
says to leave on.

Arguments both ways:

- **Leave it out.** The form asks about API use, and this is not API use. It is
  off in production. Including it invites a conversation about the browser UA
  that has nothing to do with the read token being requested.
- **Put it in.** If it is ever switched on, an application that described the
  integration as read-only was wrong, and a reviewer who finds it later finds
  it in the worst way. A short honest line — "a write-back feature exists,
  drives the site's own form endpoints as the signed-in user because there is
  no write API, and is currently disabled" — costs little and cannot be held
  against us later.

This is a judgment call about a relationship, not a technical one, so it is not
made here. If it goes in, §5 gets a sixth bullet and §6 keeps its read-only
framing intact.
