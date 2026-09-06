"""Reactions — "Good game" on a play.

The UI puts one button under a whole game night; the rows are per PLAY. That is
not a compromise, it is the only thing available: a feed session is grouped
client-side off `played_at | participants`, and `participants` is filtered per
viewer by bgb_feed_plays, so two people looking at the same night compute
different keys. There is no session identity to key on — see migration 016.

So one tap covers N plays, and the two things that follow live here:

  * every row a tap writes shares one `reaction_group_id`, so the write can be
    read back as a single act — which is what the notification arm added in
    migration 017 groups on, rather than announcing a three-game night three
    times, and
  * the caller's OWN plays are dropped before the insert. You do not
    congratulate yourself, the same way Strava will not let you kudos your own
    ride, and a session can legitimately contain plays logged by several people
    because the grouping keys on participants rather than on the logger.
"""

import uuid
from typing import Any, NamedTuple

from supabase import Client

TABLE = "boardgamebuddy_play_reactions"


class ReactionWrite(NamedTuple):
    """What one tap did, for the caller AND for the notification arm.

    `play_ids` and `group_id` are the API's answer. `owner_ids` and `game_name`
    exist only so the route can notify without re-reading plays it has already
    looked at — a night can span several loggers, so owner_ids can hold more
    than one person, and game_name is populated only when the tap covered a
    single play (naming one game out of three would claim the reactor singled
    it out).
    """

    play_ids: list[str]
    group_id: str
    owner_ids: list[str]
    game_name: str | None


def _reactable(
    sb: Client, viewer_id: str, play_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """play_id -> {owner, game_name}, for the plays the viewer may react to.

    One query, not one per play: the caller hands us a whole night. Unknown ids
    fall out for free — they simply do not come back from the select — so a
    stale client cannot write rows pointing at deleted plays.

    Returns the OWNER alongside the id rather than the id alone, because the
    same select already reads `user_id` to drop the viewer's own plays and
    migration 017 needs that value on the row. See `add` for why the column
    exists at all. game_name rides along for the notification copy — it is a
    denormalized column on the row this query already fetches, so it is free.
    """
    if not play_ids:
        return {}
    rows = (
        sb.table("boardgamebuddy_plays")
        .select("id, user_id, game_name")
        .in_("id", play_ids)
        .execute()
    ).data or []
    return {
        r["id"]: {"owner": r["user_id"], "game_name": r.get("game_name")}
        for r in rows
        if r.get("user_id") != viewer_id
    }


def add(sb: Client, viewer_id: str, play_ids: list[str]) -> ReactionWrite:
    """React to every play in `play_ids` the viewer is allowed to react to.

    Idempotent: the table's
    (play_id, user_id) primary key means a double tap re-writes nothing, so the
    client can fire without checking first.

    WHY THE ROW CARRIES play_owner_id. It is a copy of plays.user_id, which the
    repo would normally refuse — except that the recipient of a reaction is the
    one thing this table cannot answer, and migration 017 made "who reacted to
    MY plays" a read on every app boot (bgb_notifications_unread, via
    /bootstrap). No index can be (recipient, time) while the recipient lives in
    another table, so without the column that read is one PK probe per play the
    viewer has ever logged. The copy cannot drift because no write path in this
    codebase updates plays.user_id — a play's logger is its logger forever —
    and the column is NOT NULL so forgetting it here fails loudly rather than
    silently emptying somebody's bell.
    """
    plays = _reactable(sb, viewer_id, play_ids)
    ids = list(plays)
    group_id = str(uuid.uuid4())
    if not ids:
        return ReactionWrite([], group_id, [], None)
    payload: list[dict[str, Any]] = [
        {
            "play_id": pid,
            "user_id": viewer_id,
            "reaction_group_id": group_id,
            "play_owner_id": plays[pid]["owner"],
        }
        for pid in ids
    ]
    # ignore_duplicates keeps an existing row's original group id and created_at
    # rather than re-stamping them — re-reacting to a night you already reacted
    # to should not move it to the top of anyone's notifications.
    sb.table(TABLE).upsert(
        payload, on_conflict="play_id,user_id", ignore_duplicates=True
    ).execute()
    # Order-preserving unique, so a night logged by two people notifies each of
    # them once rather than once per play they own.
    owner_ids = list(dict.fromkeys(p["owner"] for p in plays.values()))
    game_name = plays[ids[0]]["game_name"] if len(ids) == 1 else None
    return ReactionWrite(ids, group_id, owner_ids, game_name)


def remove(sb: Client, viewer_id: str, play_ids: list[str]) -> list[str]:
    """Drop the viewer's reactions on these plays. Returns the ids touched.

    Deliberately NOT filtered through _reactable: this only ever deletes
    rows whose user_id is the caller, so there is nothing to authorize, and a
    play deleted since the page loaded should still let its stale row go.
    """
    if not play_ids:
        return []
    sb.table(TABLE).delete().eq("user_id", viewer_id).in_("play_id", play_ids).execute()
    return list(play_ids)
