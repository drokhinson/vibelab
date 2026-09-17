"""The play importer's BoardGameGeek source — one read, no writes.

BoardGameGeek plays used to arrive as a side effect of POST /bgg/sync, which
inserted them into boardgamebuddy_plays directly. They come through the play
importer now, so the wizard needs to be able to ASK what is waiting without
anything landing: this endpoint answers that and writes nothing at all.

WHY A POST FOR A READ. Two reasons, and both already decided the same question
for POST /bgg/check:

  * It spends twenty to forty seconds inside the handler walking a paginated
    third-party API. A GET invites the browser, the service worker and every
    intermediary to retry and prefetch it, which is how one user press becomes
    four BoardGameGeek page walks.
  * It writes the in-process read cache and it holds the shared BGG session, so
    it is a call that has to be serialised against the other BGG jobs rather
    than one that can be replayed freely.

The response is the importer's whole input: the plays, who was at them, and the
catalog row for each game we already have. Games we do not have come back
unresolved — the wizard's Games step imports those on demand, so a user only
spends BoardGameGeek's budget on the games whose plays they are bringing over.
"""

import logging

from fastapi import Depends

from db import get_supabase

from . import router
from .bgg_client import linked_bgg_username
from .dependencies import CurrentUser, get_current_user
from .models import BggPendingPlaysResponse
from .services import bgg_plays_service
from .services._helpers import reject_if_import_running, reject_if_push_running

logger = logging.getLogger(__name__)


@router.post(
    "/bgg/plays/pending",
    response_model=BggPendingPlaysResponse,
    status_code=200,
    summary="BoardGameGeek plays this account has not imported yet",
)
async def pending_bgg_plays(
    user: CurrentUser = Depends(get_current_user),
) -> BggPendingPlaysResponse:
    """Preview the BGG plays missing from BgB. Nothing is written."""
    sb = get_supabase()
    username = linked_bgg_username(sb, user.user_id)

    # Every BGG job drives one shared session, and this walk is long enough to
    # overlap either of the others. Enforced here, not only in the UI: two
    # tabs, two devices. Both are 409s the client renders as "wait for the run
    # that is already going".
    await reject_if_push_running(sb, user.user_id)
    await reject_if_import_running(sb, user.user_id)

    return await bgg_plays_service.pending_plays(sb, user.user_id, username)
