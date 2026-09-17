"""Reading a BoardGameGeek play history: the page walk, the parser, the filter.

Split out of bgg_link_routes.py once the plays read acquired a second consumer,
for the same reason bgg_collection_read.py was — and the split landed at the
same moment the two consumers stopped wanting the same thing from it:

  * `POST /bgg/sync` now reads plays only to COUNT the ones BgB does not have.
    It writes none. It parks what it read (services/bgg_plays_cache.py) for the
    importer the user is about to be handed to.
  * `POST /bgg/plays/pending` reads them to SHOW them, so it needs three fields
    the sync never cared about — the game's BGG name, each player's BGG
    username, and the play's quantity.

Both go through `parse_plays`, at the fuller fidelity, because a parser with a
"cheap mode" is two parsers that drift.

WHAT THE PARSER DELIBERATELY DROPS. A play with no date, no `<item>` or no
object id is skipped rather than carried as a partial: BGB's `played_at` is NOT
NULL and a play with no game is not a play. BGG returns those for half-finished
entries, so this is routine rather than exceptional.

QUANTITY IS CARRIED, NEVER EXPANDED. BGG lets one `<play>` stand for N sittings
via `quantity`. Expanding it would mint N rows sharing one `bgg_play_id`, and
the partial UNIQUE on (user_id, bgg_play_id) would reject all but the first —
so the import would silently land one play and report N. The retired sync wrote
one row per element; the importer keeps that parity and says so in the review.
"""

import logging

from supabase import Client

from .bgg_client import fetch_bgg_as_user, parse_bgg_xml
from .services._helpers import chunked

logger = logging.getLogger(__name__)

# BGG serves 100 plays a page. A bad response that keeps reporting a total it
# never delivers would otherwise loop forever, so the walk is capped: 50 pages
# is 5000 plays, well past any real account.
_MAX_PLAY_PAGES = 50

# PostgREST caps an `in_` list long before Postgres does, so the dedup read is
# chunked. Same value the collection upserts use.
_BATCH = 500


def parse_plays(body: str, *, username: str) -> tuple[list[dict], int]:
    """Parse a BGG /plays page into (rows, total).

    Each row:
      {bgg_play_id, bgg_id, bgg_game_name, played_at, notes, quantity, players[]}

    where each player is {name, username, is_winner}. `username` is BGG's own
    handle for that seat when the play records one, and it is what lets the
    importer seat the syncing account without guessing at a name match.

    `total` is the server-reported count, so the caller knows when to stop
    paginating.
    """
    root = parse_bgg_xml(body, context=f"plays user={username!r}")
    try:
        total = int(root.get("total", "0"))
    except (TypeError, ValueError):
        total = 0

    rows: list[dict] = []
    for play_el in root.findall("play"):
        try:
            bgg_play_id = int(play_el.get("id", "0"))
        except (TypeError, ValueError):
            continue
        if not bgg_play_id:
            continue

        played_at = play_el.get("date") or None
        # BGG sometimes returns date="" for incomplete plays — skip those.
        if not played_at:
            continue

        item_el = play_el.find("item")
        if item_el is None:
            continue
        try:
            bgg_id = int(item_el.get("objectid", "0"))
        except (TypeError, ValueError):
            continue
        if not bgg_id:
            continue

        # The catalog may not have this game, and the importer's Games step has
        # to be able to name what it is asking the user about.
        bgg_game_name = (item_el.get("name") or "").strip() or None

        try:
            quantity = int(play_el.get("quantity", "1"))
        except (TypeError, ValueError):
            quantity = 1
        quantity = max(1, quantity)

        comments_el = play_el.find("comments")
        notes = comments_el.text if comments_el is not None else None

        players: list[dict] = []
        players_el = play_el.find("players")
        if players_el is not None:
            for p in players_el.findall("player"):
                name = (p.get("name") or "").strip()
                handle = (p.get("username") or "").strip() or None
                # A seat with neither a name nor a handle names nobody; the
                # roster gate in bgb_log_play would drop it anyway.
                if not name and not handle:
                    continue
                players.append({
                    "name": name or handle,
                    "username": handle,
                    "is_winner": p.get("win") == "1",
                })

        rows.append({
            "bgg_play_id": bgg_play_id,
            "bgg_id": bgg_id,
            "bgg_game_name": bgg_game_name,
            "played_at": played_at,
            "notes": notes,
            "quantity": quantity,
            "players": players,
        })
    return rows, total


async def fetch_all_plays(user_id: str, username: str) -> list[dict]:
    """Pull every page of /plays for a user (BGG returns 100 per page).

    Uses cookie auth so private plays — and any future write actions — are
    available, mirroring the collection sweep. Raises BggWarmUpError when BGG
    never stops serving its "still preparing" placeholder; the caller decides
    whether an unread history is fatal.
    """
    page = 1
    out: list[dict] = []
    while True:
        body = await fetch_bgg_as_user(
            user_id,
            "/plays",
            {"username": username, "page": page},
            timeout=20.0,
        )
        rows, total = parse_plays(body, username=username)
        out.extend(rows)
        # Stop when we've collected all of them or the page returned nothing.
        if not rows or len(out) >= total:
            return out
        page += 1
        if page > _MAX_PLAY_PAGES:
            logger.warning(
                "BGG plays walk hit the %d-page cap for user=%s (%d plays read)",
                _MAX_PLAY_PAGES, user_id, len(out),
            )
            return out


def existing_bgg_play_ids(sb: Client, user_id: str, bgg_play_ids) -> set[int]:
    """Which of these BGG play ids this account already holds a play for.

    One batched SELECT per chunk against the partial UNIQUE on
    (user_id, bgg_play_id) (001_baseline.sql), rather than a probe per play.

    This is the single definition of "already here", and it answers for every
    writer at once: the retired sync path, the pending-imports worker still
    draining kind='play' rows, and the importer. That matters because the three
    do not share an idempotency key — only this column.
    """
    ids = sorted({int(i) for i in bgg_play_ids if i is not None})
    if not ids:
        return set()
    found: set[int] = set()
    for chunk in chunked(ids, _BATCH):
        res = (
            sb.table("boardgamebuddy_plays")
            .select("bgg_play_id")
            .eq("user_id", user_id)
            .in_("bgg_play_id", chunk)
            .execute()
        )
        found.update(r["bgg_play_id"] for r in (res.data or []) if r.get("bgg_play_id"))
    return found
