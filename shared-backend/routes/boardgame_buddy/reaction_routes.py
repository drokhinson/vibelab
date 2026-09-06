"""Reaction endpoints — saying "Good game" to a play.

Its own module rather than two more routes on play_routes.py, which is already
past twice the ~300-line ceiling, and for the same reason notification_routes.py
is its own: this is its own object with its own lifecycle.

Both routes take a LIST of play ids because the surface is the session footer —
one tap covers a whole game night. One play is a list of one, which is what a
per-card control would send if one ever ships. The counts and the avatar stack
come back on the feed payload (bgb_feed_plays, migration 016), not from here, so
there is no GET: reacting never costs the client a read.
"""

from fastapi import BackgroundTasks, Depends

from db import get_supabase

from . import router
from .dependencies import CurrentUser, get_current_user
from .models import PlayReactionRequest, PlayReactionResponse
from .services import push_notify, reaction_service


@router.post(
    "/plays/reactions",
    response_model=PlayReactionResponse,
    status_code=200,
    summary='Say "Good game" to every play in a session',
)
async def add_reactions(
    payload: PlayReactionRequest,
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(get_current_user),
) -> PlayReactionResponse:
    """React to the given plays; returns the ones actually affected."""
    sb = get_supabase()
    # 200 rather than 201: the write is idempotent, so a second tap creates
    # nothing and "Created" would be a lie half the time.
    write = reaction_service.add(sb, user.user_id, payload.play_ids)
    # One push per owner for the whole tap, matching the single bell row
    # migration 017 collapses these into. Idempotency is not re-checked here: a
    # repeat tap over plays already reacted to writes nothing but still
    # notifies, and the payload's tag makes that a refreshed notification on
    # the device rather than a second one — the same treatment a repeated buddy
    # request gets.
    push_notify.reaction(
        background_tasks, sb, user, write.owner_ids, len(write.play_ids), write.game_name
    )
    # `play_ids` can be shorter than what was sent — the caller's own plays are
    # dropped — so the client reconciles against this rather than assuming its
    # optimistic patch covered everything.
    return PlayReactionResponse(
        play_ids=write.play_ids, reacted=True, reaction_group_id=write.group_id
    )


@router.delete(
    "/plays/reactions",
    response_model=PlayReactionResponse,
    status_code=200,
    summary="Take back a Good game",
)
async def remove_reactions(
    payload: PlayReactionRequest,
    user: CurrentUser = Depends(get_current_user),
) -> PlayReactionResponse:
    """Remove the caller's reactions from the given plays."""
    ids = reaction_service.remove(get_supabase(), user.user_id, payload.play_ids)
    return PlayReactionResponse(play_ids=ids, reacted=False, reaction_group_id=None)
