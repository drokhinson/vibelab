"""Web Push — the one place BoardgameBuddy talks to a phone that isn't open.

The bell (008/009/017) is derived, complete and correct, and completely
invisible to anyone not currently looking at the app. This is the other half:
the same events, delivered to a device.

WHY THIS IS NOT DERIVED, WHEN THE BELL IS. A derived feed answers "what has
happened to me" at read time, which is exactly right for a list somebody opens.
A push has a MOMENT — there is no read to hang it off, and by the time the
recipient opens the app the notification's whole job is already done. So push
is emitted from the write paths, as a BackgroundTasks job after the response.

WHICH WRITE PATHS, AND WHY NOT ALL OF THEM. notification_service warns that
play links are written by four paths (live save, offline flush, note importer,
BGG sync) and would be "correct only if all four remember". That is an argument
against events, and it applies here too — so the answer is that only the
INTERACTIVE paths emit. A 214-play BGG backfill seating six buddies must not
light six phones; the bell already collapses it into one entry, which is the
right surface for a bulk fact. The omission is the design, not an oversight.

FAILURE IS NEVER THE CALLER'S PROBLEM. Every public function here swallows
everything. A dead push service, a revoked subscription, a malformed row: none
of them may turn "your play was logged" into a 500. The only thing a failure
changes is this table — a 404/410 deletes the row, because the subscription is
permanently gone and keeping it means retrying it forever.

OFF BY DEFAULT AND INERT. With no VAPID keys configured — which is every local
dev environment — enabled() is False, send() returns before touching the
database, and GET /push/config tells the client not to offer the setting. The
app runs complete with no keys anywhere.
"""

import asyncio
import json
import logging
from typing import Any, Iterable

from pywebpush import WebPushException, webpush
from py_vapid import Vapid
from supabase import Client

from ..constants import (
    BGB_VAPID_PRIVATE_KEY,
    BGB_VAPID_PUBLIC_KEY,
    BGB_VAPID_SUBJECT,
    PUSH_TIMEOUT_SECONDS,
    PUSH_TTL_SECONDS,
    PushEvent,
    PushTier,
    push_tier_admits,
)

logger = logging.getLogger(__name__)

TABLE = "boardgamebuddy_push_subscriptions"
PROFILES = "boardgamebuddy_profiles"

# Parsed once. py_vapid re-derives the public key from the private one on every
# from_string, and webpush() additionally does an os.path.isfile() on a string
# key before deciding it is not a filename — neither is expensive, but a table
# of eight people is eight of each, for a value that cannot change without a
# redeploy.
_vapid_instance: Vapid | None = None


def enabled() -> bool:
    """Are the VAPID keys configured? If not, the whole feature is off."""
    return bool(BGB_VAPID_PUBLIC_KEY and BGB_VAPID_PRIVATE_KEY)


def public_key() -> str:
    """The applicationServerKey the browser needs to subscribe. '' when off."""
    return BGB_VAPID_PUBLIC_KEY


def _vapid() -> Vapid | None:
    """The signing key, parsed once and kept.

    A malformed key is a deploy-time mistake, so it is logged loudly and then
    treated as "push is off" — the alternative is every notifying write path in
    the app raising on a value none of them chose.
    """
    global _vapid_instance
    if _vapid_instance is None and enabled():
        try:
            _vapid_instance = Vapid.from_string(private_key=BGB_VAPID_PRIVATE_KEY)
        except Exception:
            logger.exception("push: BGB_VAPID_PRIVATE_KEY is not a usable key")
            return None
    return _vapid_instance


# ── Reads ────────────────────────────────────────────────────────────────────


def _tiers(sb: Client, user_ids: list[str]) -> dict[str, str]:
    """user_id -> push_tier, in one query rather than one per recipient."""
    rows = (
        sb.table(PROFILES)
        .select("id, push_tier")
        .in_("id", user_ids)
        .execute()
    ).data or []
    return {r["id"]: (r.get("push_tier") or PushTier.NONE) for r in rows}


def _subscriptions(sb: Client, user_ids: list[str]) -> list[dict[str, Any]]:
    """Every device belonging to these accounts."""
    if not user_ids:
        return []
    return (
        sb.table(TABLE)
        .select("id, user_id, endpoint, p256dh, auth")
        .in_("user_id", user_ids)
        .execute()
    ).data or []


def willing_recipients(
    sb: Client, user_ids: Iterable[str], event: PushEvent
) -> list[str]:
    """The subset of `user_ids` whose tier admits `event`.

    Exposed rather than kept private because callers use it to decide whether
    expensive work is worth doing at all — the achievement sweep asks this
    before recomputing anybody's badges.
    """
    ids = _dedupe(user_ids)
    if not ids or not enabled():
        return []
    tiers = _tiers(sb, ids)
    return [uid for uid in ids if push_tier_admits(tiers.get(uid, ""), event)]


def _dedupe(user_ids: Iterable[str]) -> list[str]:
    """Unique, order-preserving, and empties dropped.

    A play's roster can name the same account twice (a ghost linked to someone
    already seated), and two pushes for one event is the kind of thing people
    turn notifications off over.
    """
    seen: set[str] = set()
    out: list[str] = []
    for uid in user_ids:
        if uid and uid not in seen:
            seen.add(uid)
            out.append(uid)
    return out


# ── Sending ──────────────────────────────────────────────────────────────────


def _send_one(sb: Client, sub: dict[str, Any], body: str) -> None:
    """One device. Blocking; runs in a worker thread. Never raises."""
    try:
        webpush(
            subscription_info={
                "endpoint": sub["endpoint"],
                "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
            },
            data=body,
            vapid_private_key=_vapid(),
            # A FRESH dict per call: webpush() mutates what it is handed,
            # writing `aud` (derived from this endpoint's origin) and `exp` into
            # it. A shared dict would carry one push service's audience onto the
            # next device's token, which that service would reject.
            vapid_claims={"sub": BGB_VAPID_SUBJECT},
            ttl=PUSH_TTL_SECONDS,
            timeout=PUSH_TIMEOUT_SECONDS,
        )
    except WebPushException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        # 404 Not Found / 410 Gone are the push service saying this endpoint
        # will never work again — the user cleared site data, uninstalled the
        # PWA, or the browser rotated the subscription. Deleting is the only
        # correct response; anything else retries it forever.
        if status in (404, 410):
            _drop(sb, sub["id"])
            return
        # Everything else is transient as far as we can tell from here — a 429,
        # a 5xx, a network blip. Count it and move on. Nothing prunes on the
        # count automatically: a phone switched off for a fortnight is
        # indistinguishable from one that is never coming back, and guessing
        # wrong means silently unsubscribing somebody who did nothing.
        logger.warning("push: send failed (%s) for subscription %s", status, sub["id"])
        _bump_failure(sb, sub["id"])
    except Exception:
        logger.exception("push: unexpected error sending to %s", sub["id"])


def _drop(sb: Client, sub_id: str) -> None:
    try:
        sb.table(TABLE).delete().eq("id", sub_id).execute()
    except Exception:
        logger.exception("push: could not delete dead subscription %s", sub_id)


def _bump_failure(sb: Client, sub_id: str) -> None:
    try:
        sb.rpc("bgb_push_note_failure", {"p_id": sub_id}).execute()
    except Exception:
        logger.exception("push: could not record failure for %s", sub_id)


def _note_success(sb: Client, sub_ids: list[str]) -> None:
    if not sub_ids:
        return
    try:
        sb.table(TABLE).update(
            {"last_success_at": "now()", "failure_count": 0}
        ).in_("id", sub_ids).execute()
    except Exception:
        logger.exception("push: could not stamp success")


def payload(
    *,
    event: PushEvent,
    title: str,
    body: str,
    url: str,
    tag: str,
) -> dict[str, str]:
    """One notification, in the shape sw.js's push handler reads.

    `tag` is what collapses repeats on the device: two buddy requests from the
    same person replace each other rather than stacking, because the second one
    does not tell the recipient anything the first did not.
    """
    return {"kind": str(event), "title": title, "body": body, "url": url, "tag": tag}


async def send(
    sb: Client,
    user_ids: Iterable[str],
    event: PushEvent,
    data: dict[str, str],
    *,
    exclude: str | None = None,
    ignore_tier: bool = False,
) -> None:
    """Fan one notification out to everyone who wants it. Never raises.

    `exclude` is the actor. Every caller passes it, because every one of these
    events is somebody doing something to somebody else and nobody needs their
    phone to tell them what they just did.

    `ignore_tier` skips the preference check, and exactly one caller sets it:
    POST /push/test. Pressing "send a test notification" IS the consent, and a
    test that silently vanished because the account is on `actionable` while
    the test's own event is informative would answer the opposite of the
    question being asked — the whole point of that button is to find out
    whether delivery works at all, which on iOS is otherwise unknowable.

    Blocking work — three PostgREST round trips and one HTTPS request per
    device — goes to worker threads for the reason notification_service spells
    out: the supabase client is synchronous, and calling it inline from an async
    context blocks every other in-flight request in the worker. That this runs
    after the response makes it later, not free.
    """
    try:
        if not enabled() or _vapid() is None:
            return
        ids = [u for u in _dedupe(user_ids) if u != exclude]
        if not ids:
            return

        wanted = (
            ids
            if ignore_tier
            else await asyncio.to_thread(willing_recipients, sb, ids, event)
        )
        if not wanted:
            return

        subs = await asyncio.to_thread(_subscriptions, sb, wanted)
        if not subs:
            return

        body = json.dumps(data)
        await asyncio.gather(
            *(asyncio.to_thread(_send_one, sb, sub, body) for sub in subs)
        )
        # Stamped optimistically for the whole batch rather than per-send: the
        # column is a coarse "this device was reachable recently" for a future
        # management screen, and threading a result back from every _send_one
        # to be exact about it is bookkeeping nothing reads.
        await asyncio.to_thread(_note_success, sb, [s["id"] for s in subs])
    except Exception:
        # The outermost net. A push must never be able to fail the mutation it
        # is reporting on — the play IS logged, the request IS sent.
        logger.exception("push: send failed for event %s", event)
