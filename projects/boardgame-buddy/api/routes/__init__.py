"""
boardgame_buddy — Board game collection, play logging, and quick-reference guides.
"""

from fastapi import APIRouter

router = APIRouter(
    prefix="/api/v1/boardgame_buddy",
    tags=["boardgame_buddy"],
)

# Import sub-modules so their routes register on the router. The OOP/Strava
# redesign added the buddy / feed / session / stats / search modules; the
# existing modules are still served while the new frontend cuts over.
from . import game_routes      # noqa: F401, E402
from . import collection_routes  # noqa: F401, E402
# Ahead of play_routes, and this is load-bearing: FastAPI resolves in
# declaration order, and `DELETE /plays/reactions` would otherwise be
# swallowed by `DELETE /plays/{play_id}` with play_id="reactions". Same
# hazard the buddy_suggestion_routes ordering below exists for.
from . import reaction_routes  # noqa: F401, E402
# Ahead of play_routes for the same reason: `GET /plays/imports` would
# otherwise be swallowed by `GET /plays/{play_id}` with play_id="imports",
# which reaches Supabase as an invalid-uuid cast (22P02) and 500s.
from . import import_routes  # noqa: F401, E402
from . import play_routes      # noqa: F401, E402
# Ahead of buddy_routes: literal `/buddies/suggested…` paths before the
# parameterised `/buddies/{edge_id}` ones, which FastAPI resolves in
# declaration order.
from . import buddy_suggestion_routes  # noqa: F401, E402
from . import buddy_routes     # noqa: F401, E402
from . import ghost_claim_routes  # noqa: F401, E402
from . import notification_routes  # noqa: F401, E402
# No ordering constraint: `/release-notices` is a prefix nothing else touches,
# and within the module the literal `/seen` and `/admin` paths are declared
# ahead of the parameterised `/admin/{notice_id}` ones. Sits beside
# notification_routes because both are "things the app is telling you".
from . import release_notice_routes  # noqa: F401, E402
from . import session_routes   # noqa: F401, E402
from . import feed_routes      # noqa: F401, E402
# No ordering constraint: `/discover` is a literal path under its own prefix,
# with no parameterised sibling to be swallowed by.
from . import discovery_routes  # noqa: F401, E402
from . import stats_routes     # noqa: F401, E402
from . import achievement_routes  # noqa: F401, E402
from . import search_routes    # noqa: F401, E402
from . import chapter_routes   # noqa: F401, E402
# The wizard's two AI drafting endpoints. No ordering constraint against
# chapter_routes: every path here is a literal `/chapters/generate…` under a
# game id, which no parameterised route in that module can swallow.
from . import chapter_ai_routes  # noqa: F401, E402
# The admin's rulebook-link queue (migration 052). No ordering constraint
# against chapter_routes: every path here is a literal under
# `/admin/rulebook-links`, which no parameterised route in that module reaches.
from . import rulebook_admin_routes  # noqa: F401, E402
from . import expansion_routes  # noqa: F401, E402
from . import profile_routes   # noqa: F401, E402
# No ordering constraint: every path here is a literal under /push/.
from . import push_routes      # noqa: F401, E402
from . import bgg_link_routes  # noqa: F401, E402
from . import bgg_push_routes  # noqa: F401, E402
# No ordering constraint: `/bgg/plays/pending` is a literal path and nothing in
# the two modules above takes a parameter that could swallow it.
from . import bgg_plays_routes  # noqa: F401, E402
# No ordering constraint: every path here is a literal under /bga/, with no
# parameterised sibling to be swallowed by. The BGA importer's WRITE is not
# here — it goes through POST /plays/import like every other source.
from . import bga_routes       # noqa: F401, E402
from . import bootstrap_routes  # noqa: F401, E402
from . import export_routes  # noqa: F401, E402
from . import admin_routes  # noqa: F401, E402
# The admin run logs. No ordering constraint against admin_routes: every path
# here is three segments (`/admin/runs`, `/admin/runs/{tool}`) and every path
# there is two, and test_route_ordering only flags a shadow between paths of
# EQUAL segment count. Within this module the literal `/admin/runs` is declared
# ahead of the parameterised `/admin/runs/{tool}`, which is a different
# segment count again and so could not have been swallowed either way.
from . import admin_run_routes  # noqa: F401, E402
# The admin Usage spoke. Both paths are literal, so nothing here can shadow or
# be shadowed: `/admin/usage` is two segments against admin_routes' two, but a
# shadow needs a PARAMETERISED path to swallow a literal one and neither module
# has any. `/admin/usage/buckets` is three, against admin_run_routes'
# `/admin/runs/{tool}` — same count, but the second segment differs on a
# literal, so no request can match both.
from . import usage_routes  # noqa: F401, E402
# No ordering constraint. `/feedback` is one segment and
# `/feedback/{id}/like` is three, and no single-segment `/{x}` route exists in
# this package for either to be swallowed by — test_route_ordering only flags a
# shadow between paths of EQUAL segment count. The two lookup endpoints are
# top-level literals (`/feedback-types`, `/feedback-topics`) rather than
# `/feedback/types`, mirroring `/chapter-types`, which is what keeps that true
# if a `GET /feedback/{id}` ever lands.
from . import feedback_routes  # noqa: F401, E402
# No ordering constraint: `/affiliate` is a prefix nothing else touches, and
# within the module every literal (`/links`, `/click`, `/admin/partners`,
# `/admin/clicks`) is declared ahead of the parameterised
# `/admin/partners/{partner_id}…` forms. Last because it is the newest and
# the least entangled — nothing here reads anything but its own two tables
# and a game's name.
from . import affiliate_routes  # noqa: F401, E402
