# BoardgameBuddy v2.0 — Release Notes

## Short version (Google Play "What's new" — ~480 chars)

> v2.0 is a top-to-bottom rewrite around three screens: a chronological
> Feed of buddy plays, a guided Log-a-Play flow with shared session
> codes, and a public Profile with stats + game collection + buddies.
> Mutual friend requests replace one-way buddy links, every game tile
> now carries an Owned / Wishlist / Played pill, and your BoardGameGeek
> account links in one tap for collection + play history sync.

---

## Full notes

### A new home screen — Feed

A chronological timeline of plays from you and your buddies, mixed with
"Hot this week" and "Time to revisit" cards. Each play card is
Strava-style: who played what, when, with whom, who won, and an
optional photo with the box-art tucked into the corner. Scroll to the
bottom and the next page auto-loads.

### Log a play — guided, multi-phone, scoring-aware

- A single **Log a play** screen handles solo logs and co-located
  groups. Tap **Session code** to spin up a five-character code other
  phones can join — once they're in, they appear in your players list
  automatically.
- Pick your **game type** — Competitive, Team, or Co-op — and the
  scoring table adapts. Per-player trophies for competitive, teammate
  sync for team games, a single shared "We won" toggle for co-op.
- A round-by-round scoring grid totals as you go, and each round has
  its own × so a misclick doesn't blow up the whole session.
- Players list shows the name, an editable initials field (which feeds
  the column header in the score table), and a team field when needed.
- Snap a play photo to attach to the log; tap the rulebook link if the
  game has one set.

### Profile — collection, plays, and buddies in one place

Profile is now three tabs:

- **Game Collection** — paginated grid of every game you've marked
  Owned, Wishlist, or Played. Filter by player count, playtime,
  mechanics, and play mode. Each tile carries a status pill and an
  expansion-count badge so you can see at a glance "I own 4 of this
  game's expansions".
- **Recent Plays** — searchable, paginated log of your full play
  history with winners and player counts. Tap any row to open the full
  play record (notes, photo, expansions, per-player scores) and edit it
  if you logged it.
- **Buddies** — mutual friend list, incoming + outgoing requests,
  played-with discovery, and the ghost-player linking tool to attach
  past plays you logged for "guest" names to a real account.

A stats strip above the tabs shows Played Games, Owned Games, Wins, and
your most-played Favorite Game.

### Settings — moved off Profile chrome

Tap your avatar in the global header to open **Settings**. Account
Details holds your display name (editable) and your stable `@username`
handle (set at signup, used in search). Admins see a dedicated **Admin
tools** section with three sub-actions (Import, Pending guides,
Missing-images sweep). Logout is now a red destructive-action button
at the bottom, with a BoardGameGeek attribution footer beneath it.

### BoardGameGeek sync

Link your BGG account once with username + password (we exchange them
for a session cookie at link time, store it encrypted, and re-use it
silently). After that, **Sync** pulls your owned collection, wishlist,
and play history into BoardgameBuddy with a single tap. Pending /
errored counts surface in Settings, and individual games can be
fetched on demand from the search screen.

### Buddies — now mutual

Buddies use a mutual friend-request model:

- Search for users by **display name or @username**.
- Send a request; the other side accepts to form the edge.
- Incoming / sent requests have their own rows so you can act on them
  without scrolling.
- Played-with surfaces people you've shared games with — accounts get a
  "Buddy up" CTA, ghost players (free-text names from older plays) get
  a "Link" affordance so you can retroactively point them at a real
  account and pull their wins into the stats.

### Game pages — richer, faster

Every game-detail page now shows:

- A large clickable status pill — **Add to collection**, or the current
  Owned / Wishlist / Played state if it's already set. Tap to switch
  state or remove without leaving the page.
- A solid-coloured **BGG** link (brand orange) and **Rulebook** link
  (gold) sized to match Log a play.
- A full **Expansions** list for base games, with the owned-count
  surfaced inline; expansion pages link back to their base game.
- A **Recent plays** rail using the same card design as the profile
  feed so plays read consistently across the app.
- A "Looking up <Game> info" loader during navigation — the previous
  game's hero/title/meta clear immediately, so there's never a flash of
  stale content.

### Searching the catalog

A single Browse screen lists every game in BoardgameBuddy, newest
first. Filters live in a collapsible panel:

- **Players** chips for exact player count.
- **Playtime** bubble ranges (`< 30`, `30–60`, `60–90`, `90–120`,
  `2+ hours`).
- **Play mode** (Competitive / Cooperative / Teams).
- **Mechanics** (AND match).
- Owned-only toggle.

Free-text search filters the same list. If you don't find what you
want, **Search BoardGameGeek for more** extends to BGG on demand and
lets you import new games into the catalog in one tap.

### Visual polish

- New global app header: BoardgameBuddy wordmark + "powered by BGG"
  mark, with the bouncing-buddy logo to its left. Tap the avatar to
  reach Settings.
- Bottom nav constrained to the 480 px app width so the desktop
  experience doesn't stretch the bar across the viewport.
- Every loading state now uses the **bouncing buddy mark** — same
  animation as the splash, so the app feels alive while data warms up.
- Every game tile across the app carries the same status pill +
  expansion-count badge, so collection state is glanceable wherever a
  game appears.

### Fixes worth calling out

- The stats tile finally counts your own wins — a backfill migration
  reattaches legacy host-self play rows to your account so historical
  wins now show up.
- Navigating between two game pages no longer flashes the previous
  game's hero while the next one is in flight.
- The lobby UI no longer blinks every 2 seconds while polling for new
  joiners.
- Editing a play preserves focus and selection in inputs across
  re-renders.

---

Thanks for playing with BoardgameBuddy.
