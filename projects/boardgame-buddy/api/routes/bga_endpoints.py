"""Everything this codebase believes about Board Game Arena's wire format.

THIS IS A QUARANTINE MODULE. Every URL, every form field name, every parse
lives here and nowhere else, and nothing in it does I/O, touches Supabase or
imports FastAPI. Two consequences, both deliberate:

  * Every function is testable from a saved fixture with no network, which is
    how `api/tests/test_bga_endpoints.py` pins the format.
  * BGA has no public API and nothing below was verified against the live site
    when it was written (see Docs/BGA_IMPORT.md). Reconciling it against the
    real thing is an edit to THIS FILE, not a change that ripples outward.

If you are here because the importer stopped working, the format changed and
this is the file to fix. Do not add a fallback elsewhere.

WHAT BGA IS NOT. It is not BGG. Three differences drive the shapes below:

  1. A failed login answers HTTP 200. BGG returns 401/403; BGA's ajax handlers
     answer `{"status": "0", "error": "..."}` with a 200, so the status code
     tells you nothing. `login_result()` is what turns that into a typed
     outcome instead of a silent success.
  2. Two-factor is a distinct, unrecoverable outcome. An importer cannot answer
     a second factor, and telling that user to "check your password" sends them
     round a loop they cannot exit.
  3. Tables can seat AI opponents. A bot is not a person and must never become
     a ghost player somebody could later claim.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from enum import StrEnum
from typing import Any

# Overridable so a local fixture server can drive the whole import end to end
# without touching the real site — which is the only way the flow is testable
# before anyone has verified it. See ENV.md.
BGA_BASE = os.getenv("BGA_BASE_URL", "https://boardgamearena.com").rstrip("/")

LOGIN_PAGE_PATH = "/account"
LOGIN_PATH = "/account/account/login.html"
GAMESTATS_PATH = "/gamestats/gamestats/getGames.html"
TABLEINFO_PATH = "/table/table/tableinfos.html"

# Honest, and NOT the browser spoof api/routes/bgg_client.py sends. BGG's web
# endpoints sit behind Cloudflare screening ordinary traffic; BGA's terms name
# automated access itself, so a bot screen that turns us away is a control
# working as designed and defeating it is a different act from reading your own
# data. If this gets blocked, that is information the user needs.
BGA_USER_AGENT = os.getenv("BGA_USER_AGENT", "vibelab-boardgame-buddy/1.0")


def url(path: str) -> str:
    """Absolute URL for one of the paths above."""
    return f"{BGA_BASE}{path}"


# ── Dry run ──────────────────────────────────────────────────────────────────
#
# Defaults to ON, like BGG_PUSH_DRY_RUN and for the same reason: the endpoints
# below are reverse-engineered, and a feature that talks to a site whose terms
# it is already stretching should not reach that site by accident on a fresh
# deploy. With it on, every BGA call is served from BGA_FIXTURE_DIR instead of
# the network, which is also what makes the whole wizard walkable end to end
# before anyone has verified anything.


def dry_run_enabled() -> bool:
    """True when BGA calls are served from fixtures rather than the network."""
    return os.getenv("BGA_DRY_RUN", "true").strip().lower() not in ("0", "false", "no")


def fixture(name: str) -> str | None:
    """A dry-run fixture body by name (`login`, `gamestats`, `tableinfo`).

    Returns None when no fixture directory is configured or the file is
    missing, so the caller can raise something that says which file it wanted
    rather than failing as an empty page.
    """
    root = os.getenv("BGA_FIXTURE_DIR", "").strip()
    if not root:
        return None
    path = os.path.join(root, f"{name}.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return None


def default_headers() -> dict[str, str]:
    """Headers every BGA request carries."""
    return {
        "User-Agent": BGA_USER_AGENT,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
    }


# ── Outcomes ─────────────────────────────────────────────────────────────────


class BgaLoginOutcome(StrEnum):
    """Why a login attempt ended, independent of its HTTP status."""

    OK = "ok"
    BAD_CREDENTIALS = "bad_credentials"
    NEEDS_2FA = "needs_2fa"
    THROTTLED = "throttled"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class BgaLoginResult:
    outcome: BgaLoginOutcome
    player_id: str | None = None
    message: str | None = None


@dataclass(frozen=True)
class BgaSeat:
    """One chair at a BGA table."""

    handle: str
    player_id: str | None = None
    score: int | None = None
    rank: int | None = None
    is_ai: bool = False


@dataclass(frozen=True)
class BgaTableStub:
    """What a gamestats row carries.

    `seats` may be empty: whether the list endpoint includes the roster is the
    single most important unverified fact about BGA (it decides whether a full
    history costs five requests or five hundred), so the stub is allowed to
    arrive without one and `needs_detail` says so.
    """

    table_id: int
    game_name: str
    bga_game_id: str | None = None
    ended_at: date | None = None
    seats: tuple[BgaSeat, ...] = field(default_factory=tuple)

    @property
    def needs_detail(self) -> bool:
        """True when this row has to be enriched by a tableinfos call."""
        return not self.seats


@dataclass(frozen=True)
class BgaTable:
    """A finished table, complete enough to become a draft play."""

    table_id: int
    game_name: str
    bga_game_id: str | None
    ended_at: date | None
    seats: tuple[BgaSeat, ...]


# ── Login ────────────────────────────────────────────────────────────────────

# BGA's login page carries a per-session CSRF token. Three spellings have been
# seen in the wild and none is documented, so all three are tried rather than
# betting on one; a page with none at all is handled by the caller (the token
# is optional in login_form).
_TOKEN_PATTERNS = (
    re.compile(r'name=["\']request_token["\'][^>]*value=["\']([^"\']+)["\']', re.I),
    re.compile(r'value=["\']([^"\']+)["\'][^>]*name=["\']request_token["\']', re.I),
    re.compile(r'["\']request_token["\']\s*[:=]\s*["\']([^"\']+)["\']', re.I),
)


def parse_request_token(html: str) -> str | None:
    """Pull the CSRF token out of the login page, or None if there isn't one."""
    for pattern in _TOKEN_PATTERNS:
        found = pattern.search(html or "")
        if found:
            return found.group(1)
    return None


def login_form(username: str, password: str, token: str | None) -> dict[str, str]:
    """The POST body BGA's own login form submits."""
    form = {
        "email": username,
        "password": password,
        "rememberme": "on",
        "redirect": "join",
        "form_id": "loginform",
    }
    if token:
        form["request_token"] = token
    return form


def _payload_of(body: str) -> dict[str, Any]:
    """Best-effort JSON body. A non-JSON answer is not an error here."""
    try:
        parsed = json.loads(body or "")
    except (ValueError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


# Matched against BGA's own error text, which is a moving target — hence
# substring matching on the distinctive word rather than the whole sentence.
_2FA_MARKERS = ("two-factor", "two factor", "2fa", "authentication code", "verification code")
_BAD_MARKERS = ("password", "identifi", "not found", "unknown", "incorrect", "invalid")
_THROTTLE_MARKERS = ("too many", "try again later", "rate", "flood")


def login_result(status_code: int, body: str, cookies: dict[str, str]) -> BgaLoginResult:
    """Classify a login response.

    The status code is deliberately the LAST thing consulted. BGA answers a
    rejected password with HTTP 200 and an error in the body, so a
    status-first reading reports success and the caller stores a session that
    was never granted.
    """
    payload = _payload_of(body)
    message = str(payload.get("error") or payload.get("message") or "").strip()
    lowered = message.lower()

    if status_code == 429 or any(m in lowered for m in _THROTTLE_MARKERS):
        return BgaLoginResult(BgaLoginOutcome.THROTTLED, message=message or None)

    if any(m in lowered for m in _2FA_MARKERS):
        return BgaLoginResult(BgaLoginOutcome.NEEDS_2FA, message=message or None)

    # `status` is BGA's own success flag: "1"/1/True for granted. An explicit
    # falsy status with no recognised message is still a refusal.
    status = payload.get("status")
    granted = status in (1, "1", True) if status is not None else None

    if granted is False:
        return BgaLoginResult(BgaLoginOutcome.BAD_CREDENTIALS, message=message or None)

    if message and any(m in lowered for m in _BAD_MARKERS):
        return BgaLoginResult(BgaLoginOutcome.BAD_CREDENTIALS, message=message)

    if status_code >= 400:
        return BgaLoginResult(BgaLoginOutcome.UNKNOWN, message=message or f"HTTP {status_code}")

    # A grant without a session cookie is not a grant. BGG has the same
    # failure mode (a 200 with no SessionID when the password is wrong) and
    # bgg_credentials.py treats it as a credential failure for the same reason.
    if not cookies:
        return BgaLoginResult(BgaLoginOutcome.BAD_CREDENTIALS, message=message or None)

    return BgaLoginResult(BgaLoginOutcome.OK, player_id=parse_player_id(payload, cookies))


def parse_player_id(payload: dict[str, Any], cookies: dict[str, str]) -> str | None:
    """The numeric BGA player id, from wherever the login happened to put it."""
    for source in (payload, payload.get("data") if isinstance(payload.get("data"), dict) else {}):
        if not isinstance(source, dict):
            continue
        for key in ("id", "player_id", "playerId", "infos_id"):
            value = source.get(key)
            if value not in (None, ""):
                return str(value)
    for key in ("PHPSESSID_player_id", "bga_player_id"):
        if cookies.get(key):
            return str(cookies[key])
    return None


# A signed-out BGA answers an ajax call with its login page or a "you must be
# logged in" envelope rather than a 401, so the session-refresh path cannot key
# on a status code either.
def looks_signed_out(status_code: int, body: str) -> bool:
    """True when this response means 'your session is gone', not 'no data'."""
    if status_code in (401, 403):
        return True
    lowered = (body or "")[:2000].lower()
    return any(
        marker in lowered
        for marker in ("you must be logged", "not logged in", "must be connected", "loginform")
    )


# ── Game history ─────────────────────────────────────────────────────────────


def gamestats_params(player_id: str, *, page: int = 1, finished_only: bool = True) -> dict[str, str]:
    """Query for one page of a player's game history, newest first."""
    params = {"player": str(player_id), "opponent_id": "0", "page": str(max(1, page))}
    if finished_only:
        params["finished"] = "1"
    return params


def _as_int(value: Any) -> int | None:
    try:
        if value in (None, ""):
            return None
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _as_date(value: Any) -> date | None:
    """BGA timestamps are unix seconds; tolerate an ISO string too."""
    seconds = _as_int(value)
    if seconds is not None and seconds > 0:
        return datetime.fromtimestamp(seconds, tz=timezone.utc).date()
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).date()
        except ValueError:
            return None
    return None


def _truthy(value: Any) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes")


def _seats_from(rows: Any) -> tuple[BgaSeat, ...]:
    """Normalise whatever shape the roster arrived in.

    Drops AI seats and anything with no handle: a bot is not a person, and a
    nameless seat would become a ghost nobody can ever claim.
    """
    if isinstance(rows, dict):
        rows = list(rows.values())
    if not isinstance(rows, list):
        return ()

    seats: list[BgaSeat] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        handle = str(
            row.get("name") or row.get("player_name") or row.get("fullname") or ""
        ).strip()
        is_ai = _truthy(row.get("is_ai") or row.get("ai") or row.get("is_bot"))
        if not handle or is_ai:
            continue
        seats.append(
            BgaSeat(
                handle=handle,
                player_id=str(row["id"]).strip() if row.get("id") not in (None, "") else None,
                score=_as_int(row.get("score")),
                rank=_as_int(row.get("gamerank") or row.get("rank")),
                is_ai=False,
            )
        )
    return tuple(seats)


def _rows_of(payload: Any) -> list[dict[str, Any]]:
    """Find the list of tables inside whichever envelope BGA used."""
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    if not isinstance(payload, dict):
        return []
    for key in ("tables", "games"):
        found = payload.get(key)
        if isinstance(found, list):
            return [r for r in found if isinstance(r, dict)]
        if isinstance(found, dict):
            return [r for r in found.values() if isinstance(r, dict)]
    data = payload.get("data")
    if data is not None and data is not payload:
        return _rows_of(data)
    return []


def parse_table_page(body: str) -> tuple[list[BgaTableStub], bool]:
    """One gamestats page → (rows, has_more).

    `has_more` falls back to "the page was full" when BGA does not say. That is
    the safe direction: an extra empty request costs one throttled round trip,
    where a premature stop silently drops the rest of somebody's history.
    """
    payload = _payload_of(body)
    rows = _rows_of(payload)

    stubs: list[BgaTableStub] = []
    for row in rows:
        table_id = _as_int(row.get("table_id") or row.get("id"))
        if table_id is None:
            continue
        stubs.append(
            BgaTableStub(
                table_id=table_id,
                game_name=str(row.get("game_name") or row.get("gamename") or "").strip(),
                bga_game_id=(
                    str(row["game_id"]).strip() if row.get("game_id") not in (None, "") else None
                ),
                ended_at=_as_date(row.get("end") or row.get("gamestart") or row.get("start")),
                seats=_seats_from(row.get("players")),
            )
        )

    explicit = payload.get("has_more") if isinstance(payload, dict) else None
    has_more = _truthy(explicit) if explicit is not None else bool(stubs)
    return stubs, has_more


def tableinfo_params(table_id: int) -> dict[str, str]:
    """Query for one table's detail."""
    return {"id": str(table_id)}


def parse_table_info(body: str, *, fallback: BgaTableStub | None = None) -> BgaTable | None:
    """One tableinfos response → a complete table, or None if unusable.

    A table with no seats we can name is dropped rather than imported empty:
    `bgb_log_play` would answer `{"error": "no_players"}` anyway, and a play
    with nobody at it counts towards nobody's record.
    """
    payload = _payload_of(body)
    inner = payload.get("data") if isinstance(payload.get("data"), dict) else payload

    table_id = _as_int(inner.get("table_id") or inner.get("id"))
    if table_id is None and fallback is not None:
        table_id = fallback.table_id
    if table_id is None:
        return None

    seats = _seats_from(inner.get("result") or inner.get("players"))
    if not seats and fallback is not None:
        seats = fallback.seats
    if not seats:
        return None

    game_name = str(inner.get("game_name") or inner.get("gamename") or "").strip()
    if not game_name and fallback is not None:
        game_name = fallback.game_name

    ended_at = _as_date(inner.get("gameend") or inner.get("end") or inner.get("gamestart"))
    if ended_at is None and fallback is not None:
        ended_at = fallback.ended_at

    bga_game_id = str(inner["game_id"]).strip() if inner.get("game_id") not in (None, "") else None
    if bga_game_id is None and fallback is not None:
        bga_game_id = fallback.bga_game_id

    return BgaTable(
        table_id=table_id,
        game_name=game_name,
        bga_game_id=bga_game_id,
        ended_at=ended_at,
        seats=seats,
    )


def table_from_stub(stub: BgaTableStub) -> BgaTable | None:
    """Promote a stub that already carries its roster, with no second call."""
    if not stub.seats:
        return None
    return BgaTable(
        table_id=stub.table_id,
        game_name=stub.game_name,
        bga_game_id=stub.bga_game_id,
        ended_at=stub.ended_at,
        seats=stub.seats,
    )
