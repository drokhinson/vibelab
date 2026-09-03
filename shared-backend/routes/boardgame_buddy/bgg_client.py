"""Shared BoardGameGeek XMLAPI2 client.

Two entry points:

  * `fetch_bgg(path, params)` — anonymous catalog requests (search, /thing).
    Adds the shared `BGG_API_TOKEN` Bearer header for rate-limit accounting.
    NOT user-scoped — the token is BGG's app-registration token, not a
    per-user credential.
  * `fetch_bgg_as_user(user_id, path, params)` — per-user requests
    (`/collection`, `/plays`, future writes). Loads the user's stored
    SessionID + bgg cookies from `boardgamebuddy_profiles`, transparently
    re-logs in via `bgg_credentials.login_to_bgg()` when the session is
    missing/expired, and sends the cookies on the GET so BGG evaluates the
    request as that user (which unlocks `showprivate=1`).

Both paths share the same 202/429/non-200 mapping below.
"""

import asyncio
import html
import logging
import os
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional

import httpx
from fastapi import HTTPException
from supabase import Client

import cache
from api_logger import log_external_call
from db import get_supabase

from .bgg_credentials import (
    BggSession,
    decrypt_password,
    encrypt_password,
    login_to_bgg,
)

logger = logging.getLogger(__name__)

BGG_API_BASE = "https://boardgamegeek.com/xmlapi2"
BGG_USER_AGENT = "vibelab-boardgame-buddy/1.0"
# The web app is a different animal from xmlapi2. xmlapi2 is a published API
# that accounts for us by the BGG_API_TOKEN bearer and does not care what we
# call ourselves; boardgamegeek.com's own .php endpoints sit behind Cloudflare,
# which screens POSTs on how browser-shaped the request looks and answers a
# request that fails that screen with a 403 the app never sees. So the two
# surfaces get two identities: xmlapi2 keeps the honest one above, and the web
# form endpoints send a browser's. Env-overridable because the UA that gets
# through is a moving target and re-deploying to change a string is absurd.
#
# See BGG's own Geek Tools threads on POSTs to geekplay.php being answered by a
# Cloudflare challenge — same edge, same shape of failure as the collection
# write.
BGG_WEB_USER_AGENT = os.getenv(
    "BGG_WEB_USER_AGENT",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
)
BGG_API_TOKEN = os.getenv("BGG_API_TOKEN")
# Re-login this far ahead of the cookie's actual expiry so a long-running
# sync doesn't tip over mid-request.
_SESSION_REFRESH_LEEWAY = timedelta(minutes=5)


def _default_headers() -> dict[str, str]:
    headers = {"User-Agent": BGG_USER_AGENT}
    if BGG_API_TOKEN:
        headers["Authorization"] = f"Bearer {BGG_API_TOKEN}"
    return headers


class BggWarmUpError(HTTPException):
    """BGG signalled the result is still being prepared and our retries gave up.

    Raised by `_fetch_with_warmup_retry` after exhausting attempts on either
    HTTP 202 or HTTP 200 with a top-level <message> element. Callers (notably
    `_run_sync`) catch this distinctly to surface a clearer FE message instead
    of treating it as a generic 503/502.
    """

    def __init__(self) -> None:
        super().__init__(
            status_code=503,
            detail="BoardGameGeek is still preparing this collection. Try again in ~30 seconds.",
        )


class BggRefusedError(HTTPException):
    """BGG refused a request that was carrying a session it had just minted.

    THE POINT OF THIS CLASS IS WHAT IT IS NOT. `_run_as_user` answers a 401/403
    by logging in again and retrying once. `login_to_bgg` only returns when BGG
    hands back a SessionID — a wrong password is a 400 raised in there, never
    here — so by the time the retry also comes back 401/403, the stored
    password has just been PROVEN correct. This used to raise "BoardGameGeek
    rejected the stored password" at that exact point and send the user off to
    re-link credentials that were never the problem.

    What is actually happening is the layer in front of the app: BGG's web
    endpoints are behind Cloudflare, which screens POSTs and answers a request
    it does not like with a 403 the application never sees. A session cannot
    fix that, which is why this aborts the run instead of burning three
    attempts per row against it.

    Carries `ray_id` when Cloudflare identified itself, because that is the one
    piece of evidence BGG staff ask for.
    """

    def __init__(self, detail: str, *, ray_id: Optional[str] = None) -> None:
        super().__init__(status_code=502, detail=detail)
        self.ray_id = ray_id


# Cloudflare's block and challenge pages. Matched loosely on purpose — the
# exact wording changes with their product names, and the cost of a false
# positive is one honest error message instead of another.
_CF_BODY_MARKERS = (
    "attention required",
    "just a moment",
    "cf-error-details",
    "cf_chl_opt",
    "cf-browser-verification",
    "enable javascript and cookies to continue",
)


def _cloudflare_block(resp: httpx.Response) -> Optional[str]:
    """The Cloudflare ray id if this response is an edge block, else None.

    Returns "" rather than None for a block with no ray id, so callers can tell
    "not Cloudflare" from "Cloudflare, unidentified" — `is not None`, not truthiness.
    """
    if resp.status_code not in (403, 503, 429):
        return None
    ray = resp.headers.get("cf-ray") or ""
    if resp.headers.get("cf-mitigated"):
        return ray
    try:
        body = (resp.text or "")[:4000].lower()
    except (UnicodeDecodeError, httpx.ResponseNotRead):
        body = ""
    if any(marker in body for marker in _CF_BODY_MARKERS):
        return ray
    # A cloudflare-served error page always names them somewhere near the ray.
    if "cloudflare" in body and ("ray id" in body or "blocked" in body):
        return ray
    return None


def _is_warm_up_response(body: str) -> bool:
    """True when a BGG xmlapi2 200 body is the 'request accepted, retry shortly' placeholder.

    Conservative: only fires when a top-level <message> element is present.
    A legit empty subtype (`<items totalitems="0"/>` with no <message>) is NOT
    a warm-up — we must not retry users who genuinely own no expansions.
    """
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return False
    return root.find("message") is not None


async def _fetch_with_warmup_retry(
    do_get: Callable[[], Awaitable[httpx.Response]],
    *,
    path: str,
    params: dict,
    attempts: int = 3,
    delays: tuple[float, ...] = (5.0, 10.0, 20.0),
    on_warm_up: Optional[Callable[[int, int, float], None]] = None,
) -> httpx.Response:
    """Call do_get() with retries when BGG signals it's still computing the result.

    Two warm-up signals are retriable: HTTP 202 (documented but rare in the
    wild) and HTTP 200 with a top-level <message> element (the common case for
    large /collection requests on first hit). All other responses are returned
    as-is so the caller's `_map_bgg_status` handles them.
    """
    for attempt in range(attempts):
        resp = await do_get()
        warming_up = (
            resp.status_code == 202
            or (resp.status_code == 200 and _is_warm_up_response(resp.text))
        )
        if not warming_up:
            return resp
        if attempt + 1 >= attempts:
            break
        delay = delays[min(attempt, len(delays) - 1)]
        logger.info(
            "BGG warm-up on %s %s — sleeping %.1fs (attempt %d/%d)",
            path, params, delay, attempt + 1, attempts,
        )
        # The user is watching a checklist while this sleeps. Telling them BGG
        # is warming up, and for how long, is the difference between a wait and
        # a hang.
        if on_warm_up is not None:
            on_warm_up(attempt + 1, attempts, delay)
        await asyncio.sleep(delay)
    logger.warning(
        "BGG warm-up exhausted on %s %s after %d attempts",
        path, params, attempts,
    )
    raise BggWarmUpError()


def _map_bgg_status(resp: httpx.Response, *, path: str, params: dict) -> None:
    """Translate BGG-specific status codes into HTTPException. 200 returns silently."""
    if resp.status_code == 200:
        return
    if resp.status_code == 401:
        logger.error("BGG 401 — BGG_API_TOKEN missing or invalid")
        raise HTTPException(
            status_code=502,
            detail="BoardGameGeek authentication failed. Ensure BGG_API_TOKEN is set in Railway.",
        )
    if resp.status_code == 202:
        # Warm-up retries happen in _fetch_with_warmup_retry; reaching this
        # branch means we somehow bypassed the wrapper. Treat the same.
        raise BggWarmUpError()
    if resp.status_code == 429:
        logger.warning("BGG 429 rate limit for %s %s", path, params)
        raise HTTPException(
            status_code=429,
            detail="BoardGameGeek rate-limited us. Wait a few seconds and try again.",
        )
    logger.warning(
        "BGG returned %s for %s %s: %s",
        resp.status_code, path, params, resp.text[:200],
    )
    raise HTTPException(
        status_code=502,
        detail=f"BoardGameGeek returned HTTP {resp.status_code}.",
    )


async def fetch_bgg(path: str, params: dict, *, timeout: float, use_cache: bool = True) -> str:
    """GET an XML document from the BGG API with consistent error mapping.

    Anonymous request — used for catalog endpoints (search, /thing). Sends the
    shared bearer token only.

    `/thing` (game detail) and `/search` responses are cached in-process by
    `_get_cached_response` / `_put_cached_response` since they're read-mostly
    and immutable per (path, params) for the cache lifetime: games never
    change post-import so 24h is fine, search results are momentary so 1h is
    enough to absorb repeat typing. fetch_bgg_as_user (per-user collection/
    plays) is never cached — those reflect the user's live BGG state.

    Pass `use_cache=False` for a response the caller doesn't want in that cache. The
    one user today is the batched `stats=1` /thing fetch behind
    `fetch_owner_counts`: 20 full game records is ~1MB of XML, and the
    `bgg.thing` namespace is capped at 500 entries, so admitting those would
    evict the per-game entries the rest of the app reads on every page. That
    caller keeps its own cache of the parsed integers instead.
    """
    cache_key = _cache_key_for(path, params) if use_cache else None
    if cache_key is not None:
        hit = _get_cached_response(path, cache_key)
        if hit is not None:
            return hit

    full_url = f"{BGG_API_BASE}{path}"

    async def _do_get() -> httpx.Response:
        async with httpx.AsyncClient(timeout=timeout, headers=_default_headers()) as client:
            async with log_external_call(
                app="boardgame-buddy", api_name="bgg",
                method="GET", url=full_url, params=params,
            ) as record:
                resp = await client.get(full_url, params=params)
                record.attach_response(resp)
                return resp

    try:
        resp = await _fetch_with_warmup_retry(_do_get, path=path, params=params)
    except httpx.HTTPError as exc:
        logger.warning("BGG network error on %s %s: %s", path, params, exc)
        raise HTTPException(
            status_code=503,
            detail="BoardGameGeek is temporarily unreachable. Try again in a moment.",
        )

    _map_bgg_status(resp, path=path, params=params)
    text = resp.text
    if cache_key is not None:
        _put_cached_response(path, cache_key, text)
    return text


# Cache namespaces + TTLs. /thing dominates memory (XML payloads ~30KB each)
# so it's capped at 500 entries (~15MB worst case); /search payloads are
# smaller and shorter-lived. fetch_bgg consults these and writes through on
# miss. Invalidation hooks live in game_routes (import / admin refresh).
#
# TODO (Redis upgrade): once shared-backend/cache.py is backed by Redis, the
# bgg.thing cache becomes cluster-wide. Today every uvicorn worker re-fetches
# the same BGG `/thing?id=N` payload on its first miss; Redis collapses that
# to one BGG call per game per 24h across the whole fleet. Same module API,
# no changes needed here. The per-key invalidation TODO in
# invalidate_bgg_thing_cache below also becomes trivial under Redis.
_BGG_CACHE_THING = "bgg.thing"
_BGG_CACHE_SEARCH = "bgg.search"
_BGG_THING_TTL_S = 24 * 60 * 60
_BGG_SEARCH_TTL_S = 60 * 60

cache.configure(_BGG_CACHE_THING, max_entries=500)
cache.configure(_BGG_CACHE_SEARCH, max_entries=200)

# Derived-value cache for `fetch_owner_counts`: one small int per bgg_id rather
# than the ~1MB XML the batched stats request returns. Entries are cheap, so the
# cap is generous — a few thousand expansion ids is well under a megabyte.
_BGG_CACHE_OWNED = "bgg.owned"
_BGG_OWNED_TTL_S = 24 * 60 * 60
# BGG's /thing takes a comma-joined id list. 20 full game records per response is
# already ~1MB of XML; larger batches mostly buy parse time. Chunk boundaries are
# derived from the sorted id list so repeat calls for the same base game issue
# byte-identical requests.
_OWNED_CHUNK_SIZE = 20
_OWNED_MAX_CHUNKS = 6

cache.configure(_BGG_CACHE_OWNED, max_entries=4000)


def _parse_owned_counts(root: ET.Element) -> dict[int, int]:
    """Pull <statistics><ratings><owned value="N"> off every <item> in a /thing response."""
    counts: dict[int, int] = {}
    for item in root.findall("item"):
        try:
            item_id = int(item.get("id", "0"))
        except (TypeError, ValueError):
            continue
        if not item_id:
            continue
        owned_el = item.find("statistics/ratings/owned")
        if owned_el is None:
            continue
        try:
            counts[item_id] = int(owned_el.get("value", "0"))
        except (TypeError, ValueError):
            continue
    return counts


async def fetch_owner_counts(bgg_ids: list[int]) -> dict[int, int]:
    """Best-effort BGG owner counts keyed by bgg_id.

    Backs the popularity ordering in the "Import expansions" popup. Deliberately
    total: any BGG failure returns the counts gathered so far (possibly none) so
    a caller can degrade to its previous ordering instead of failing the request.

    Chunks are issued sequentially, not concurrently — this module has no
    rate-limit guard and `_map_bgg_status` turns BGG's 429 into an exception, so
    parallel batches would trip it for everyone.
    """
    counts: dict[int, int] = {}
    misses: list[int] = []
    for bgg_id in bgg_ids:
        hit = cache.get(_BGG_CACHE_OWNED, bgg_id)
        if hit is not None:
            counts[bgg_id] = hit
        else:
            misses.append(bgg_id)
    if not misses:
        return counts

    misses.sort()
    chunks = [
        misses[i:i + _OWNED_CHUNK_SIZE]
        for i in range(0, len(misses), _OWNED_CHUNK_SIZE)
    ][:_OWNED_MAX_CHUNKS]

    for chunk in chunks:
        try:
            body = await fetch_bgg(
                "/thing",
                {"id": ",".join(str(i) for i in chunk), "stats": 1},
                timeout=20.0,
                use_cache=False,
            )
            fetched = _parse_owned_counts(parse_bgg_xml(body, context="thing stats batch"))
        except Exception as exc:  # noqa: BLE001 — ordering is a nicety, never a failure
            logger.warning("BGG owner-count batch failed (%d ids): %s", len(chunk), exc)
            return counts
        for bgg_id in chunk:
            # Absent from the response means BGG has no stats for that id. Cache
            # the zero too, so the next open doesn't re-request the whole batch
            # for the sake of one id that will never have a count.
            n = fetched.get(bgg_id, 0)
            cache.set(_BGG_CACHE_OWNED, bgg_id, n, ttl_seconds=_BGG_OWNED_TTL_S)
            counts[bgg_id] = n
    return counts


def _cache_key_for(path: str, params: dict) -> Optional[tuple[str, ...]]:
    """Return a stable cache key for cacheable paths, or None to bypass.

    Tuple of sorted (k, str(v)) pairs so the key is hashable and order-stable
    across callers that pass the same params in different orders.
    """
    if path not in ("/thing", "/search"):
        return None
    return tuple(sorted((k, str(v)) for k, v in params.items()))


def _get_cached_response(path: str, key: tuple[str, ...]) -> Optional[str]:
    ns = _BGG_CACHE_THING if path == "/thing" else _BGG_CACHE_SEARCH
    return cache.get(ns, key)


def _put_cached_response(path: str, key: tuple[str, ...], value: str) -> None:
    ns = _BGG_CACHE_THING if path == "/thing" else _BGG_CACHE_SEARCH
    ttl = _BGG_THING_TTL_S if path == "/thing" else _BGG_SEARCH_TTL_S
    cache.set(ns, key, value, ttl_seconds=ttl)


def invalidate_bgg_thing_cache() -> None:
    """Drop the entire /thing cache.

    Called by admin paths that re-import or re-host images. Per-key
    invalidation would be more surgical but the cache is small (capped
    at 500 entries) and admin writes are rare, so clearing the namespace
    is the simpler safe choice.

    TODO (Redis upgrade): under Redis we can do per-bgg_id invalidation
    with `DEL bgg.thing:<key>` once the key set is known, or `SCAN` on the
    namespace prefix and unlink matching keys. That keeps unrelated games'
    cache entries warm when one admin path edits a single row.
    """
    cache.clear(_BGG_CACHE_THING)


# ── Per-user (cookie) variant ────────────────────────────────────────────────


def _profile_session_columns() -> str:
    return (
        "bgg_username, bgg_password_enc, bgg_session_id, bgg_session_expires_at, "
        "bgg_session_user_cookie, bgg_session_pass_cookie"
    )


def _load_profile_session(sb: Client, user_id: str) -> dict:
    """Read the linked username + stored session cookies + encrypted password.

    Raises 409 ("BGG re-link required") for users with no encrypted password
    (legacy public-only links from before per-user auth was added).
    """
    res = (
        sb.table("boardgamebuddy_profiles")
        .select(_profile_session_columns())
        .eq("id", user_id)
        .execute()
    )
    row = (res.data or [None])[0]
    if not row or not row.get("bgg_username"):
        raise HTTPException(
            status_code=400,
            detail="No BoardGameGeek account linked. Link one first.",
        )
    if not row.get("bgg_password_enc"):
        raise HTTPException(
            status_code=409,
            detail="BGG re-link required: please re-enter your BGG password.",
        )
    return row


def _persist_session(sb: Client, user_id: str, session: BggSession) -> None:
    sb.table("boardgamebuddy_profiles").update({
        "bgg_session_id": session.session_id,
        "bgg_session_expires_at": session.expires_at.isoformat(),
        "bgg_session_user_cookie": session.user_cookie,
        "bgg_session_pass_cookie": session.pass_cookie,
        "bgg_last_login_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", user_id).execute()


def _session_is_fresh(profile_row: dict) -> bool:
    """True if the stored SessionID is non-null and not within the refresh leeway."""
    if not profile_row.get("bgg_session_id"):
        return False
    expires_raw = profile_row.get("bgg_session_expires_at")
    if not expires_raw:
        return False
    try:
        expires_at = datetime.fromisoformat(expires_raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    return expires_at > datetime.now(timezone.utc) + _SESSION_REFRESH_LEEWAY


async def _ensure_session(sb: Client, user_id: str, profile_row: dict) -> dict:
    """Return a profile_row whose session cookies are fresh, refreshing if needed."""
    if _session_is_fresh(profile_row):
        return profile_row
    password = decrypt_password(profile_row["bgg_password_enc"])
    session = await login_to_bgg(profile_row["bgg_username"], password)
    _persist_session(sb, user_id, session)
    return {
        **profile_row,
        "bgg_session_id": session.session_id,
        "bgg_session_expires_at": session.expires_at.isoformat(),
        "bgg_session_user_cookie": session.user_cookie,
        "bgg_session_pass_cookie": session.pass_cookie,
    }


def _session_cookies(row: dict) -> dict[str, str]:
    """The three cookies BGG evaluates a request as a logged-in user by."""
    return {
        "SessionID": row["bgg_session_id"],
        "bggusername": row["bgg_session_user_cookie"] or row["bgg_username"],
        "bggpassword": row["bgg_session_pass_cookie"] or "",
    }


async def _run_as_user(
    user_id: str,
    *,
    attempt: Callable[[dict[str, str]], Awaitable[httpx.Response]],
    context: str,
    signed_out: Optional[Callable[[httpx.Response], bool]] = None,
) -> httpx.Response:
    """Run `attempt` with the user's BGG cookies, refreshing the session as needed.

    Owns IDENTITY only — loading the stored session, refreshing it before it
    expires, and re-logging in once when BGG rejects it mid-flight. The caller
    owns PROTOCOL: this never inspects the response beyond 401/403 and whatever
    `signed_out` tells it, so a GET against xmlapi2 and a form POST against the
    web app can share it while each keeps its own status mapping.

    `signed_out` is how a caller says "this 200 is a logged-out response".
    xmlapi2 answers a dead session with a 401; the web app answers one with a
    200 carrying its login form, and without this hook that reached the user as
    a re-link prompt for a password that only needed re-using.

    Only httpx.HTTPError is caught. BggWarmUpError is an HTTPException and must
    keep escaping to _fetch_collection_batched, which handles it per batch.

    `context` appears in the re-login log line only.
    """
    sb = get_supabase()
    profile_row = _load_profile_session(sb, user_id)
    profile_row = await _ensure_session(sb, user_id, profile_row)

    def _rejected(resp: httpx.Response) -> bool:
        return resp.status_code in (401, 403) or bool(signed_out and signed_out(resp))

    try:
        resp = await attempt(_session_cookies(profile_row))
    except httpx.HTTPError as exc:
        logger.warning("BGG network error on %s: %s", context, exc)
        raise HTTPException(
            status_code=503,
            detail="BoardGameGeek is temporarily unreachable. Try again in a moment.",
        )

    if not _rejected(resp):
        return resp

    # Cloudflare, not BGG. Their edge answers a request it does not like with a
    # 403 the application never sees, so no session can satisfy it — and a
    # re-login here would be one more POST at the login endpoint for nothing,
    # once per failing row, on an account we would rather not get locked.
    ray = _cloudflare_block(resp)
    if ray is not None:
        raise _refused(resp, context=context, ray_id=ray, relogged_in=False)

    # Server-side session was already invalidated. Force one fresh login and
    # retry.
    logger.info("BGG %s on %s for user=%s; re-logging in", resp.status_code, context, user_id)
    password = decrypt_password(profile_row["bgg_password_enc"])
    session = await login_to_bgg(profile_row["bgg_username"], password)
    _persist_session(sb, user_id, session)
    retry_row = {
        **profile_row,
        "bgg_session_id": session.session_id,
        "bgg_session_user_cookie": session.user_cookie,
        "bgg_session_pass_cookie": session.pass_cookie,
    }

    try:
        resp = await attempt(_session_cookies(retry_row))
    except httpx.HTTPError as exc:
        logger.warning("BGG retry network error on %s: %s", context, exc)
        raise HTTPException(
            status_code=503,
            detail="BoardGameGeek is temporarily unreachable. Try again in a moment.",
        )
    if _rejected(resp):
        # NOT a credential problem, and saying it was is how eighteen games got
        # told to re-link a password that had just worked. `login_to_bgg`
        # returns only when BGG issues a SessionID; a wrong password raises a
        # 400 in there and never reaches this line. Getting here means the
        # password authenticated and the request was refused anyway.
        raise _refused(
            resp, context=context,
            ray_id=_cloudflare_block(resp), relogged_in=True,
        )
    return resp


def _refused(
    resp: httpx.Response, *, context: str, ray_id: Optional[str], relogged_in: bool,
) -> BggRefusedError:
    """Build the honest error for a 401/403 no valid session can fix."""
    logger.warning(
        "BGG refused %s with HTTP %s (cloudflare=%s ray=%s relogged_in=%s)",
        context, resp.status_code, ray_id is not None, ray_id or "-", relogged_in,
    )
    if ray_id is not None:
        detail = (
            "BoardGameGeek's bot protection blocked this — your login is fine, "
            "their front door turned us away."
        )
        if ray_id:
            detail += f" (Cloudflare ray {ray_id})"
        return BggRefusedError(detail, ray_id=ray_id or None)
    if resp.status_code in (401, 403):
        return BggRefusedError(
            f"BoardGameGeek refused this with HTTP {resp.status_code}, even "
            "though your account signed in successfully.",
        )
    return BggRefusedError(
        "BoardGameGeek answered as though we were signed out, even though your "
        "account signed in successfully.",
    )


async def fetch_bgg_as_user(
    user_id: str,
    path: str,
    params: dict,
    *,
    timeout: float,
    on_warm_up: Optional[Callable[[int, int, float], None]] = None,
) -> str:
    """GET a BGG xmlapi2 path authenticated AS the linked user.

    Loads the user's stored cookies, refreshing them via `login_to_bgg()` when
    they're missing or near expiry. On a 401/403 from xmlapi2 (server-side
    session expiry that we didn't catch), re-logs in once and retries.
    """
    full_url = f"{BGG_API_BASE}{path}"

    async def _attempt(cookies: dict[str, str]) -> httpx.Response:
        async with httpx.AsyncClient(
            timeout=timeout, headers=_default_headers(), cookies=cookies,
        ) as client:
            async def _do_get() -> httpx.Response:
                async with log_external_call(
                    app="boardgame-buddy", api_name="bgg",
                    method="GET", url=full_url, params=params,
                ) as record:
                    resp = await client.get(full_url, params=params)
                    record.attach_response(resp)
                    return resp

            # Warm-up retries sit INSIDE the auth retry, preserving the original
            # nesting: a placeholder response is retried before we ever consider
            # the session dead, and the post-re-login attempt gets the same
            # treatment.
            return await _fetch_with_warmup_retry(
                _do_get, path=path, params=params, on_warm_up=on_warm_up,
            )

    resp = await _run_as_user(user_id, attempt=_attempt, context=f"GET {path}")
    _map_bgg_status(resp, path=path, params=params)
    return resp.text


# ── Per-user writes (BGG's web app, not xmlapi2) ─────────────────────────────
#
# BGG has no write API. Collection edits go to the same form endpoint their own
# site posts to, authenticated by the cookies above. Three things from the GET
# path are deliberately NOT reused here:
#
#   * _fetch_with_warmup_retry — it re-runs the request up to 3 times and
#     detects warm-up by parsing the body as XML. Around a write that is a
#     triple-submit bug.
#   * _map_bgg_status — its 401 branch tells the admin to set BGG_API_TOKEN, but
#     a 401 on a cookie write means the session died; its 202 branch raises
#     BggWarmUpError, which is meaningless for a form post.
#   * _default_headers — it attaches BGG's app-registration bearer token, which
#     has no business on the web form endpoint.


def _web_headers(username: str) -> dict[str, str]:
    """Headers BGG's ajax form handlers expect. No Authorization — cookies only.

    TWO AUDIENCES, and the second one is why this is longer than it looks like
    it needs to be. BGG's app wants the ajax markers (X-Requested-With, the
    Referer naming the page the form lives on). Cloudflare, sitting in front of
    it, wants the request to look like it came out of a browser — a POST from
    something calling itself "vibelab-boardgame-buddy/1.0", with no Origin and
    no fetch metadata, is the exact shape their POST screening answers with a
    403 the app never sees. That 403 is indistinguishable from a dead session
    at the HTTP layer, which is what used to get reported as a rejected
    password.

    Nothing here is a claim about who the user is — the cookies do that, and
    they are the user's own, minted from credentials they linked. This is only
    about looking like the browser the endpoint was written for.
    """
    return {
        "User-Agent": BGG_WEB_USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://boardgamegeek.com",
        "Referer": f"https://boardgamegeek.com/collection/user/{username}",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
    }


def _map_bgg_write_status(resp: httpx.Response, *, url: str, form: dict) -> None:
    """Translate a BGG form-POST status into HTTPException. 200 returns silently.

    The write-side sibling of _map_bgg_status. 401/403 never reach here —
    _run_as_user handles those. NOTE that a 200 is NOT proof the save landed:
    BGG answers a dead session with 200 and an error body, so the caller still
    has to read it (see bgg_write.interpret_save_response).
    """
    if resp.status_code == 200:
        return
    if resp.status_code == 429:
        logger.warning("BGG 429 rate limit on write %s", url)
        raise HTTPException(
            status_code=429,
            detail="BoardGameGeek rate-limited us. Wait a few seconds and try again.",
        )
    logger.warning(
        "BGG write returned %s for %s objectid=%s: %s",
        resp.status_code, url, form.get("objectid"), resp.text[:200],
    )
    raise HTTPException(
        status_code=502,
        detail=f"BoardGameGeek returned HTTP {resp.status_code} on a collection write.",
    )


async def post_bgg_form_as_user(
    user_id: str,
    username: str,
    url: str,
    form: dict[str, str],
    *,
    timeout: float,
    signed_out: Optional[Callable[[httpx.Response], bool]] = None,
) -> httpx.Response:
    """POST a form-encoded body to a BGG web endpoint AS the linked user.

    Takes a FULL url, not a path — the write endpoint is not under
    BGG_API_BASE. Returns the raw response rather than a parsed body, because
    what counts as success is the caller's call.

    `signed_out` is that same division applied to auth: the web app answers a
    dead session with a 200 and its login form, and only the caller knows what
    a logged-out body looks like for its endpoint. Passing it buys the one free
    re-login the GET path has always had.

    Logged under api_name="bgg-write", distinct from "bgg" and "bgg-login", so
    writes are isolable in api_logs. The form carries only ids and status
    flags, so nothing needs redacting.
    """

    async def _attempt(cookies: dict[str, str]) -> httpx.Response:
        async with httpx.AsyncClient(
            timeout=timeout, headers=_web_headers(username), cookies=cookies,
        ) as client:
            async with log_external_call(
                app="boardgame-buddy", api_name="bgg-write",
                method="POST", url=url, params=form,
            ) as record:
                resp = await client.post(url, data=form)
                record.attach_response(resp)
                return resp

    resp = await _run_as_user(
        user_id, attempt=_attempt, context=f"POST {url}", signed_out=signed_out,
    )
    _map_bgg_write_status(resp, url=url, form=form)
    return resp


def clear_user_session(sb: Client, user_id: str) -> None:
    """Wipe linked username + credentials + cookies on unlink."""
    sb.table("boardgamebuddy_profiles").update({
        "bgg_username": None,
        "bgg_password_enc": None,
        "bgg_session_id": None,
        "bgg_session_expires_at": None,
        "bgg_session_user_cookie": None,
        "bgg_session_pass_cookie": None,
        "bgg_last_login_at": None,
    }).eq("id", user_id).execute()


def store_user_credentials(
    sb: Client,
    user_id: str,
    username: str,
    plain_password: str,
    session: BggSession,
) -> None:
    """Persist the linked username + Fernet-encrypted password + initial session."""
    sb.table("boardgamebuddy_profiles").update({
        "bgg_username": username,
        "bgg_password_enc": encrypt_password(plain_password),
        "bgg_session_id": session.session_id,
        "bgg_session_expires_at": session.expires_at.isoformat(),
        "bgg_session_user_cookie": session.user_cookie,
        "bgg_session_pass_cookie": session.pass_cookie,
        "bgg_last_login_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", user_id).execute()





def parse_bgg_xml(body: str, *, context: str) -> ET.Element:
    """Parse a BGG XML payload; map parse errors to a 502."""
    try:
        return ET.fromstring(body)
    except ET.ParseError as exc:
        logger.warning(
            "BGG XML parse error (%s): %s\nbody[:300]=%r",
            context, exc, body[:300],
        )
        raise HTTPException(
            status_code=502,
            detail="Could not parse BoardGameGeek response.",
        )


def normalize_image_url(url: str | None) -> str | None:
    """Ensure BGG image URLs have an explicit https: scheme.

    BGG returns protocol-relative URLs (`//cf.geekdo-images.com/...`); the
    Storage uploader and the frontend image proxy both want a full URL.
    """
    if not url:
        return None
    url = url.strip()
    if url.startswith("//"):
        return "https:" + url
    return url


# ── Description normalization ────────────────────────────────────────────────
# BGG's <description> is a text node (like <image>/<thumbnail>, not a value=
# attribute) and it is DOUBLE-encoded: the wire bytes carry `&amp;#10;` and
# `&amp;quot;`, so after ElementTree's own decode we still hold the literal
# strings `&#10;` and `&quot;`. One html.unescape pass finishes the job.

# Longest description we persist. BGG's median is ~1200 chars but the tail runs
# to 10k+ of component manifests and award lists. The game page clamps to a few
# lines and links out to BGG, and bgb_game_bundles prewarms up to 250 bundles
# into a 3 MB localStorage budget on the client — so an uncapped column would
# start evicting the feed and stats caches for heavy collectors.
_DESCRIPTION_MAX_CHARS = 2500

_BLOCK_TAG_RE = re.compile(r"<\s*(?:br\s*/?|/p|/div|/li)\s*>", re.IGNORECASE)
_ANY_TAG_RE = re.compile(r"<[^>]{0,200}>")
_BLANK_LINES_RE = re.compile(r"\n{3,}")
_INLINE_WS_RE = re.compile(r"[ \t]{2,}")


def bgg_description_text(item: ET.Element) -> Optional[str]:
    """Extract a BGG /thing item's description as normalized plain text.

    Returns None (never "") when BGG has no description, so the column stays
    NULL and the admin backfill's `description IS NULL` filter keeps working.

    The stored value is plain text, not sanitized HTML: every frontend surface
    renders through `innerHTML` template literals, so markup in this column
    would be one missed escape away from being an injection vector, and BGG's
    inline `<i>`/`<a>` carries nothing the game page needs.
    """
    el = item.find("description")
    if el is None or not el.text:
        return None

    # Exactly one unescape pass. A second would turn a description that
    # literally reads "&lt;script&gt;" into a live tag.
    text = html.unescape(el.text)

    text = _BLOCK_TAG_RE.sub("\n", text)
    text = _ANY_TAG_RE.sub("", text)

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _INLINE_WS_RE.sub(" ", text)
    # BGG uses a doubled &#10; as a paragraph break and sometimes emits four.
    text = _BLANK_LINES_RE.sub("\n\n", text)
    text = "\n".join(line.strip() for line in text.split("\n")).strip()

    if not text:
        return None

    if len(text) > _DESCRIPTION_MAX_CHARS:
        cut = text[:_DESCRIPTION_MAX_CHARS]
        # Prefer a word boundary, but only if one is reasonably close to the
        # cap — a description with no spaces in its last 20% shouldn't lose it.
        space = cut.rfind(" ")
        if space > _DESCRIPTION_MAX_CHARS * 0.8:
            cut = cut[:space]
        text = cut.rstrip() + "…"

    return text
