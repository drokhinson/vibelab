# Importing plays from Board Game Arena

The play importer's third source. Read this before changing anything under
`api/routes/bga_*` or `web/**/bga*` — several things in there look like
oversights and are not.

---

## 1. The thing to understand first

**Board Game Arena has no public API, and its Terms of Service prohibit
automated access.** There is no app-password scheme, no OAuth, and no
documented endpoint. This feature works the way the BGG collection-write path
works: it signs in as the user and drives the site's own internal handlers.

Three consequences, and they are the reason for most of the design below:

1. **It can break without notice.** Nothing here is a contract anyone owes us.
2. **The user is taking the risk, not us.** Their account is the one that could
   be suspended, so they have to be told before they type a password — not in a
   tooltip, and not afterwards.
3. **It should ask politely and rarely.** Every request is throttled, capped,
   and made inside a request a person is watching.

If Board Game Arena ever ships a real API, or a data export, **replace this
entirely.** It exists because there is no better door, not because this is a
good one.

---

## 2. Three constraints that look like inefficiencies

A later tidy-up pass will want to remove each of these. Don't.

### 2a. An honest User-Agent

`api/routes/bga_endpoints.py` sends `vibelab-boardgame-buddy/1.0`.

`bgg_client._web_headers` sends a Chrome UA, because BoardGameGeek's web
endpoints sit behind Cloudflare screening ordinary traffic and that screen is
not about us. **BGA's terms name automated access itself**, so a bot screen
there is a control working as designed, and defeating it is a different act
from reading your own data.

If BGA blocks this UA, that is **information the user needs**, not a bug to
route around. `tests/test_bga_endpoints.py::test_user_agent_is_honest` fails on
any change here, so the change has to be argued for out loud.

### 2b. A process-wide throttle, not a per-sweep sleep

`bga_client._gate` is a module-level `asyncio.Lock`, and `_wait_turn` holds for
`BGA_THROTTLE_SECONDS` (default **2.0**) since the last call. One BGA request
at a time, per worker — and `CLAUDE.md` guarantees one uvicorn worker, so that
is the whole fleet.

`bgg_collection_read` throttles *inside* each sweep, which lets two users'
sweeps interleave at full speed. That is fine there and wrong here: **BGG
rate-limits, BGA bans.** Two concurrent imports each going slower is the
correct trade.

### 2c. In-handler, with a ledger — never a BackgroundTask

`POST /bga/tables/fetch` runs the whole sweep inside the request and narrates
it through `services/bga_progress.py`, an in-process cache. `POST /bgg/sync` is
a BackgroundTask over a queue table. These are not inconsistent:

| | `/bgg/sync` | `/bga/tables/fetch` |
|---|---|---|
| What it defers | catalog **writes** | nothing — it writes nothing |
| Worth doing unwatched? | yes | **no** |
| Survives a restart? | must | must not pretend to |

The sweep's entire output is a draft held in the user's browser until they
press the button on the review screen. A durable queue row would outlive the
connection and sit there claiming things about work that no longer exists —
`services/bgg_progress.py`'s docstring makes the argument in full.

It is also what keeps every BGA request inside a request a person is watching.
**No cron, no queue, no scheduled re-sync.** Do not "improve" this into a
worker.

---

## 3. Where everything lives

```
api/routes/
├── bga_endpoints.py      THE QUARANTINE — every URL and every parse, pure
├── bga_credentials.py    Fernet + login, mirroring bgg_credentials.py
├── bga_client.py         sessions, the throttle, the two fetches
├── bga_routes.py         GET/POST/DELETE /bga/link, /bga/tables/*, /bga/players/remember
└── services/
    ├── bga_progress.py       the sweep's ledger
    └── bga_import_service.py the sweep, the known-id filter, the match ladder

web/
├── domain/import-seats.js   whoOf / seatKey / collapse, shared (see §6)
├── domain/bga.js            the API wrapper
├── domain/bga-import.js     the third draft model (ImportSource)
├── widgets/import-bga-steps.js   four step bodies, pure
└── widgets/import-bga-branch.js  handlers + the shell's branch contract
```

**`bga_endpoints.py` is the only file that knows BGA's shape.** No HTTP, no
Supabase, no FastAPI — pure `str → data`, so every function is testable from a
saved fixture. When BGA changes, that is the file to fix, and the only one.
Do not add a fallback somewhere else.

---

## 4. What is NOT verified

The endpoints in `bga_endpoints.py` were **reconstructed, not recorded**. They
were written from third-party write-ups, and the sandbox they were written in
could not reach boardgamearena.com. The fixtures in
`api/tests/fixtures/bga/` match the reconstruction, not a real capture.

**`BGA_DRY_RUN` therefore defaults to `true`** — the same posture as
`BGG_PUSH_DRY_RUN` — and with it on, every call is served from
`BGA_FIXTURE_DIR` and nothing reaches BGA. Leave it on until the list below is
closed.

### The verification checklist

Open BGA in a browser with devtools on the Network tab, using a throwaway
account, and answer:

1. The login page URL, whether a `request_token`/CSRF exists and where in the
   page, the exact form field names, and whether login answers JSON or a
   redirect.
2. Whether login returns the numeric player id, or it has to be scraped.
3. `getGames.html` parameter names (`player`, `finished`, `page`), the page
   size, and how "no more pages" is signalled.
4. **Whether `getGames.html` carries the roster and the scores.** This single
   fact decides whether a full history costs ~5 requests or ~500, and therefore
   whether a first import finishes inside one request at all. Both shapes are
   supported (`BgaTableStub.needs_detail`); this decides which one runs.
5. `tableinfos.html`: handles vs player ids, `is_ai`, scores, ranks,
   timestamps, game id and name.
6. Whether BGA's game names resolve against our catalog well enough through
   `boardgamebuddy_search_games`, or whether a BGA-game-id → bgg-id map is
   needed. BGA names are often localised or abbreviated.
7. The real rate limit, and what a 429 or a block looks like on the wire.
8. Whether a 2FA account can be signed into at all. (It cannot, by design —
   confirm the message the user gets is the right one.)
9. **That table ids are always numeric and fit `BIGINT`.** This one gates
   migration 043, so answer it before running that migration, not after.

Replace the fixtures with scrubbed real captures as you go — see
`api/tests/fixtures/bga/README.md` — then run
`python -m pytest api/tests/test_bga_endpoints.py`. A failure there is the
reconstruction being wrong, which is what it is for.

---

## 5. What the user is told, and when

The wizard's `account` step carries all of this **above the password field**,
not behind a disclosure:

- Board Game Arena's terms don't allow this, and the risk is theirs.
- BGA has no API and no app passwords, so it needs a real account password.
- It is encrypted on our server and used only to sign in as them.
- Unlink is right there, and deletes it.

An acknowledgement checkbox gates Continue via `continueBlocker("account")`.

**Unlink lives on that step and nowhere else.** The link is deliberately not in
Settings → Connections — an importer reads what you already have, and filing it
next to the BGG sync would suggest importing needs an account somewhere. The
cost of that decision is that the account step owns the whole lifecycle, so
`DELETE /bga/link` must stay reachable from it. A user who can link and cannot
unlink has not consented to anything.

### Secrets

- `BGA_CREDENTIAL_KEY` is its own Fernet key, **not** `BGG_CREDENTIAL_KEY`.
  Rotating one must not orphan the other's stored passwords. Rotating this one
  forces every BGA-linked user to re-link.
- The password is redacted from `api_logs`, and so is the CSRF token — it is a
  session-bound capability.
- BGA error bodies are **not** logged. `bgg_client` logs `resp.text[:200]` on a
  non-200; BGA's error pages can carry the account's own email or handle.
- `api/tests/test_bga_secrets.py` asserts no `/bga/*` response model carries a
  credential-shaped field.

---

## 6. Two things that will look odd in review

1. **`web/domain/import-seats.js` has exactly one consumer.** The seat collapse
   is needed by all three import models, and `.claude/rules/ui-object-design.md`
   §4 says extract at instance #2 — this was instance #3. The two shipping
   models still carry their own copies on purpose: migrating them in the same
   change that adds a third source risks all three at once. What makes that
   migration safe later is that `tools/check-import-wizard.mjs` asserts all
   three `whoOf()` agree on the key shape. **Point them here; do not copy it
   again.**

2. **`ImportSource` grew `gameOf(item)`.** The shared summary used to read
   `model.sourceKey === "notes" ? model.playGame(item) : item.game`, which
   quietly assumed every non-note source had the photo shape — so the third
   source threw there and nowhere else. A shared step that names a source is a
   shared step with a countdown on it.

---

## 7. Dedupe, and why a re-import is free

`boardgamebuddy_plays.bga_table_id` is unique per user
(`idx_bgb_plays_user_bga_table`, migration 043), and `bgb_log_play` answers a
table already imported with `{"duplicate": true, "id": …}` whatever
`client_key` it arrives under.

Two things follow:

- The sweep walks history **newest-first and stops at the first already-known
  table**. BGA history is chronological, so that early exit is what makes the
  second import of a heavy account cost one page rather than five hundred.
- Running the import again after any kind of interruption is safe, which is why
  the caps in §2c are acceptable: the history is complete **across runs**, just
  bounded per request.

Unlinking does **not** clear `bga_table_id` from imported plays. Unlinking is
"stop using my account", not "forget what I already imported"; clearing it
would silently offer every one of those plays again on a future re-link.

Deleting an import batch from Settings **does** release those ids — the unique
index is over live rows — so an undo followed by a re-import offers them again,
which is what undo should mean.
