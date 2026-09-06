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
from typing import Any

from supabase import Client

TABLE = "boardgamebuddy_play_reactions"


def _reactable_owners(
    sb: Client, viewer_id: str, play_ids: list[str]
) -> dict[str, str]:
    """play_id -> owner, for the subset of `play_ids` the viewer may react to.

    One query, not one per play: the caller hands us a whole night. Unknown ids
    fall out for free — they simply do not come back from the select — so a
    stale client cannot write rows pointing at deleted plays.

    Returns the OWNER alongside the id rather than the id alone, because the
    same select already reads `user_id` to drop the viewer's own plays and
    migration 017 needs that value on the row. See `add` for why the column
    exists at all.
    """
    if not play_ids:
        return {}
    rows = (
        sb.table("boardgamebuddy_plays")
        .select("id, user_id")
        .in_("id", play_ids)
        .execute()
    ).data or []
    return {
        r["id"]: r["user_id"] for r in rows if r.get("user_id") != viewer_id
    }


def add(sb: Client, viewer_id: str, play_ids: list[str]) -> tuple[list[str], str]:
    """React to every play in `play_ids` the viewer is allowed to react to.

    Returns (affected_ids, reaction_group_id). Idempotent: the table's
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
    owners = _reactable_owners(sb, viewer_id, play_ids)
    ids = list(owners)
    group_id = str(uuid.uuid4())
    if not ids:
        return [], group_id
    payload: list[dict[str, Any]] = [
        {
            "play_id": pid,
            "user_id": viewer_id,
            "reaction_group_id": group_id,
            "play_owner_id": owners[pid],
        }
        for pid in ids
    ]
    # ignore_duplicates keeps an existing row's original group id and created_at
    # rather than re-stamping them — re-reacting to a night you already reacted
    # to should not move it to the top of anyone's notifications.
    sb.table(TABLE).upsert(
        payload, on_conflict="play_id,user_id", ignore_duplicates=True
    ).execute()
    return ids, group_id


def remove(sb: Client, viewer_id: str, play_ids: list[str]) -> list[str]:
    """Drop the viewer's reactions on these plays. Returns the ids touched.

    Deliberately NOT filtered through _reactable_owners: this only ever deletes
    rows whose user_id is the caller, so there is nothing to authorize, and a
    play deleted since the page loaded should still let its stale row go.
    """
    if not play_ids:
        return []
    sb.table(TABLE).delete().eq("user_id", viewer_id).in_("play_id", play_ids).execute()
    return list(play_ids)
