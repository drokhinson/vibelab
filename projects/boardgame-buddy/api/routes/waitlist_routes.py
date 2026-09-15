"""Waitlist — pre-launch email capture for the landing page.

Unauthenticated, like analytics /track, because the whole point is that the
caller has no account yet. Self-contained on purpose: the models live here
rather than in models.py and nothing else imports this module, so when the
app goes live and the landing view comes down, deleting this file plus its
`from . import` line plus the table is the entire removal.

Three things it is careful about, all because the endpoint is public:

1. **It never says whether an address is already on the list.** A signup and a
   duplicate return the identical response, so the endpoint cannot be used to
   test whether somebody signed up.
2. **The list is write-only from outside.** The row goes in with the
   service-role key; migration 035 turns RLS on with no policies, so the anon
   key the browser holds cannot read a single row back.
3. **One address per IP per minute.** Not a real rate limiter — `cache.py` is
   per-worker and in-process — but enough that a bored visitor holding the
   button cannot write a thousand rows, which is the actual threat here.
"""

import logging
import re

from fastapi import HTTPException, Request
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field

import cache
from db import get_supabase

from . import router

_log = logging.getLogger("bgbuddy.waitlist")

_UNIQUE_VIOLATION = "23505"  # Postgres unique_violation

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$")
_MAX_EMAIL_CHARS = 254  # RFC 5321 practical ceiling

_THROTTLE_NS = "bgb.waitlist.ip"
_THROTTLE_SECONDS = 60
cache.configure(_THROTTLE_NS, max_entries=4096)


class WaitlistBody(BaseModel):
    email: str = Field(..., max_length=_MAX_EMAIL_CHARS)
    # Free-text label for where the signup came from, so a later campaign can
    # be told apart from the organic landing page. Never shown to the visitor.
    source: str | None = Field(None, max_length=64)


class WaitlistResponse(BaseModel):
    ok: bool


def _unavailable() -> HTTPException:
    """The write failed. Deliberately says nothing about why — the cause is in
    the server log, and a visitor can act on "try again" but not on a Postgres
    error code."""
    return HTTPException(status_code=503, detail="Could not save that right now.")


def _client_ip(request: Request) -> str:
    """Best-effort caller IP. Behind Cloudflare and uvicorn --proxy-headers
    this is the real client; without them it is the proxy, which only makes the
    throttle blunter, never wrong in a way that matters."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


@router.post(
    "/waitlist",
    response_model=WaitlistResponse,
    status_code=200,
    summary="Join the pre-launch waitlist",
)
async def join_waitlist(body: WaitlistBody, request: Request) -> WaitlistResponse:
    """Record an email address. No auth — the caller has no account yet.

    ok=true means the address IS on the list — whether this call put it there,
    a previous one did, or the throttle decided it already had one from this IP
    a moment ago. A duplicate and a fresh save are indistinguishable, so the
    endpoint cannot be used to probe who signed up.

    **ok=false means exactly one thing: the address itself is unusable.** A
    write that FAILS raises 503 instead, because the two need different words
    in front of the visitor and a single flag cannot carry both. Answering
    ok=false for an outage makes the landing view say "that address doesn't
    look right" to somebody who typed a perfectly good one — they blame
    themselves, retry, fail again and leave. The 503 reaches the view as a
    thrown error, which it already words as "couldn't reach the server, try
    again in a moment".

    This is not hypothetical: until migration 035 is applied the table does not
    exist, so EVERY signup is a write failure.
    """
    email = (body.email or "").strip()
    if not email or len(email) > _MAX_EMAIL_CHARS or not _EMAIL_RE.match(email):
        # The one case worth reporting: the address cannot be written to, so
        # saying ok would be a lie the visitor acts on by walking away.
        return WaitlistResponse(ok=False)

    ip = _client_ip(request)
    if cache.get(_THROTTLE_NS, ip) is not None:
        return WaitlistResponse(ok=True)
    cache.set(_THROTTLE_NS, ip, True, _THROTTLE_SECONDS)

    try:
        get_supabase().table("boardgamebuddy_waitlist").insert(
            {"email": email, "source": body.source}
        ).execute()
    except APIError as exc:
        # 23505 is uq_bgb_waitlist_email_lower: this address is already on the
        # list, so the visitor's statement about the world is true and ok=True
        # is the honest answer — identical to a fresh save, which is what keeps
        # the endpoint from being an enumeration oracle.
        if getattr(exc, "code", None) != _UNIQUE_VIOLATION:
            _log.error("waitlist insert failed: %s", exc)
            raise _unavailable() from exc
    except Exception as exc:
        # An outage must NOT come back as ok. Telling somebody they are on a
        # list they are not on is the one failure here with a lasting cost:
        # they walk away and never sign up again.
        _log.error("waitlist insert failed: %s", exc)
        raise _unavailable() from exc

    return WaitlistResponse(ok=True)
