"""What BoardgameBuddy actually notifies about.

push_service knows how to deliver a notification; this knows which ones exist,
who each is for, and what it says. The split matters because the second list is
the one that changes — a new feature adds a line here and nothing at all there
— and because .claude/rules/backend-python.md wants route files to stay thin
adapters rather than accumulate copy and recipient arithmetic.

Every function takes `background_tasks` and queues the send rather than
awaiting it. The mutation has already succeeded by the time any of this runs,
and nothing here is allowed to change that: push_service.send swallows
everything, and the work happens after the response either way.

THE COPY IS SECOND PERSON AND NAMES THE ACTOR FIRST. "Dave added you to Catan",
not "New play". A notification is read on a lock screen, out of context, next to
fifteen others — the two facts worth spending the line on are who did it and
what it was.

"Good game" is deliberately absent. It is the lightest thing that happens in the
app and it lives on the feed card that earned it — no bell row, no push.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Iterable

from fastapi import BackgroundTasks
from supabase import Client

from ..constants import PushEvent
from ..dependencies import CurrentUser
from ..models import (
    AchievementItem,
    BuddyRequestResponse,
    PlayResponse,
    SessionResponse,
)
from . import achievement_service, push_service

logger = logging.getLogger(__name__)

# How recently a badge must have been unlocked for the sweep below to treat it
# as "just now". Generous next to the milliseconds actually involved, because
# the alternative failure is worse: too tight a window and a slow write silently
# drops the badge push, with nothing anywhere to say it happened.
_ACHIEVEMENT_FRESH = timedelta(minutes=1)


def _queue(
    background_tasks: BackgroundTasks,
    sb: Client,
    recipients: Iterable[str],
    event: PushEvent,
    *,
    title: str,
    body: str,
    url: str,
    tag: str,
    actor_id: str | None,
) -> None:
    """One place that touches BackgroundTasks, so every call site is uniform."""
    ids = [r for r in recipients if r]
    if not ids or not push_service.enabled():
        return
    background_tasks.add_task(
        push_service.send,
        sb,
        ids,
        event,
        push_service.payload(event=event, title=title, body=body, url=url, tag=tag),
        exclude=actor_id,
    )


# ── Buddies ──────────────────────────────────────────────────────────────────


def buddy_request_outcome(
    background_tasks: BackgroundTasks,
    sb: Client,
    user: CurrentUser,
    result: BuddyRequestResponse,
) -> None:
    """Notify whichever of the two things send_request actually did.

    `direction` is the tell, and it is exact. "outgoing" means the edge is
    pending with the caller as requester, so the TARGET has something waiting on
    them — actionable. "incoming" means the other party had already asked and
    this call auto-accepted it, so what happened is that THEIR request landed —
    informative, and addressed to them rather than to the person who just
    tapped.

    A repeat of a request already sent takes the "outgoing" branch and pushes
    again. Deliberate rather than tolerated: the tag collapses it on the device,
    so the recipient sees one notification refreshed rather than two stacked,
    which is a fair reading of somebody asking twice.
    """
    if result.direction == "outgoing":
        _queue(
            background_tasks, sb, [result.other_user_id], PushEvent.BUDDY_REQUEST,
            title="Buddy request",
            body=f"{user.display_name} wants to be your buddy",
            url="/notifications",
            tag=f"buddy_request:{user.user_id}",
            actor_id=user.user_id,
        )
    else:
        buddy_accepted(background_tasks, sb, user, result.other_user_id)


def buddy_accepted(
    background_tasks: BackgroundTasks,
    sb: Client,
    user: CurrentUser,
    other_id: str,
) -> None:
    """Tell the requester their request landed.

    Informative, not actionable: there is nothing left to do, which is exactly
    why it is worth sending — the person who asked has been waiting, and
    otherwise finds out only by opening the app and checking.
    """
    _queue(
        background_tasks, sb, [other_id], PushEvent.BUDDY_ACCEPTED,
        title="You're buddies",
        body=f"{user.display_name} accepted your buddy request",
        url="/notifications",
        tag=f"buddy_accepted:{user.user_id}",
        actor_id=user.user_id,
    )


def ghost_linked(
    background_tasks: BackgroundTasks,
    sb: Client,
    user: CurrentUser,
    target_user_id: str,
    rows: int,
) -> None:
    """ONE push for a whole retroactive link, however many plays it touched.

    A link across forty old plays is one act by one person. The bell already
    collapses it into a single entry for exactly this reason (NotificationKind's
    ACT grouping), and forty notifications would be the worst thing this feature
    could do to somebody.
    """
    if rows <= 0:
        return
    plays = "play" if rows == 1 else "plays"
    _queue(
        background_tasks, sb, [target_user_id], PushEvent.PLAY_LINK,
        title="You were in these games",
        body=f"{user.display_name} added you to {rows} {plays}",
        url="/notifications",
        tag=f"play_link:{user.user_id}",
        actor_id=user.user_id,
    )


def ghost_claim(
    background_tasks: BackgroundTasks,
    sb: Client,
    user: CurrentUser,
    owner_id: str,
    ghost_name: str,
) -> None:
    """"Is this you?" — somebody says one of your ghost players is their account.

    Actionable, and the most consequential of the actionable set: accepting
    rewrites who a run of past plays belongs to. It goes to the plays' owner,
    who is the only person who can answer.
    """
    _queue(
        background_tasks, sb, [owner_id], PushEvent.GHOST_CLAIM,
        title="Is this them?",
        body=f"{user.display_name} says they're “{ghost_name}” in your plays",
        url="/profile/buddies",
        tag=f"ghost_claim:{user.user_id}",
        actor_id=user.user_id,
    )


# ── Sessions and plays ───────────────────────────────────────────────────────


def session_invite(
    background_tasks: BackgroundTasks,
    sb: Client,
    user: CurrentUser,
    session: SessionResponse,
    target_user_id: str | None,
) -> None:
    """The host put somebody in a lobby that is open right now.

    The most time-critical notification in the app, and the reason
    SESSION_INVITE is its own event rather than riding play_link: the game is
    starting NOW, in a room the recipient may not be sitting in, and the push
    carries the join URL so a tap lands them in the lobby rather than on a list
    of things that have already happened.

    Nothing to send for a ghost — that is a name the host typed, with nobody on
    the other end of it.
    """
    if not target_user_id:
        return
    game = session.game.name if session.game else None
    _queue(
        background_tasks, sb, [target_user_id], PushEvent.SESSION_INVITE,
        title="You're in the game",
        body=(
            f"{user.display_name} added you to {game}"
            if game
            else f"{user.display_name} added you to a game"
        ),
        url=f"/play/{session.code}",
        # Tagged on the SESSION, not the actor: being removed and re-added is
        # the same invitation to the same table, and should replace rather
        # than stack.
        tag=f"session:{session.code}",
        actor_id=user.user_id,
    )


def play_logged(
    background_tasks: BackgroundTasks,
    sb: Client,
    user: CurrentUser,
    play: PlayResponse,
) -> None:
    """Somebody logged a play and seated other people in it.

    ONLY THE INTERACTIVE WRITE PATHS CALL THIS. services/notification_service
    warns that play links are written by four paths — live save, offline flush,
    note importer, BGG sync — and are "correct only if all four remember". That
    is an argument against events, and it applies here: the two importers are
    deliberately silent. A 214-play backfill seating six buddies must not fire
    six phones, and the bell already collapses it into one entry, which is the
    right surface for a bulk fact.

    The achievement sweep rides along because this is the moment badges become
    earnable — see achievements_after_play.
    """
    seated = [p.user_id for p in play.players if p.user_id and p.user_id != user.user_id]
    if not seated:
        return
    _queue(
        background_tasks, sb, seated, PushEvent.PLAY_LINK,
        title="You were in a game",
        body=f"{user.display_name} added you to {play.game_name}",
        url="/notifications",
        tag=f"play_link:{user.user_id}",
        actor_id=user.user_id,
    )
    background_tasks.add_task(
        achievements_after_play, sb, seated + [user.user_id]
    )


# ── Achievements ─────────────────────────────────────────────────────────────


async def achievements_after_play(sb: Client, user_ids: list[str]) -> None:
    """Push any badge that a just-written play unlocked. Never raises.

    WHY THIS IS NOT SIMPLY A READ. bgb_sync_achievements is the only thing that
    unlocks a badge, and until now it ran in exactly one place: when somebody
    opened the Achievements screen. A badge push driven off that would arrive
    while the recipient was already looking at the badge, which is not a
    notification. Calling the sweep HERE — right after the write that made the
    badge earnable — is what turns "unlocked" into a moment there is something
    to announce.

    THE TIER IS CHECKED BEFORE THE WORK, not after. The sweep recomputes twelve
    metrics per person, so a six-player table is six of them; asking who would
    even accept the push first means a table of people on `actionable` costs one
    query rather than six recomputations thrown away. That ordering is the whole
    reason push_service.willing_recipients is public.

    Everything is swallowed. A badge that fails to announce itself is a missed
    notification; a badge that raises would be a 500 on somebody's logged play.
    """
    try:
        if not push_service.enabled():
            return
        wanted = await asyncio.to_thread(
            push_service.willing_recipients, sb, user_ids, PushEvent.ACHIEVEMENT
        )
        if not wanted:
            return
        cutoff = datetime.now(timezone.utc) - _ACHIEVEMENT_FRESH
        for user_id in wanted:
            fresh = await asyncio.to_thread(_newly_earned, sb, user_id, cutoff)
            for badge in fresh:
                await push_service.send(
                    sb,
                    [user_id],
                    PushEvent.ACHIEVEMENT,
                    push_service.payload(
                        event=PushEvent.ACHIEVEMENT,
                        title="Achievement unlocked",
                        body=f"{badge.name} — {badge.tagline}",
                        url="/profile/achievements",
                        # Per badge, so unlocking two at once shows two.
                        tag=f"achievement:{badge.id}",
                    ),
                )
    except Exception:
        logger.exception("push: achievement sweep failed")


def _newly_earned(sb: Client, user_id: str, cutoff: datetime) -> list[AchievementItem]:
    """Run the sweep for one account and return what it just unlocked.

    `unlocked_at` is written by the RPC itself, so "newer than cutoff" means
    "this call earned it" — a badge earned last week comes back earned with an
    old stamp and is filtered out here rather than announced again.
    """
    payload = achievement_service.fetch_achievements(sb, user_id)
    out: list[AchievementItem] = []
    for badge in payload.achievements:
        if not badge.earned or badge.unlocked_at is None:
            continue
        stamp = badge.unlocked_at
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=timezone.utc)
        if stamp >= cutoff:
            out.append(badge)
    return out
