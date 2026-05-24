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
from . import play_routes      # noqa: F401, E402
from . import buddy_routes     # noqa: F401, E402
from . import session_routes   # noqa: F401, E402
from . import feed_routes      # noqa: F401, E402
from . import stats_routes     # noqa: F401, E402
from . import search_routes    # noqa: F401, E402
from . import chapter_routes   # noqa: F401, E402
from . import expansion_routes  # noqa: F401, E402
from . import profile_routes   # noqa: F401, E402
from . import bgg_link_routes  # noqa: F401, E402
from . import bootstrap_routes  # noqa: F401, E402
