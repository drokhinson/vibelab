"""
boardgame_buddy — Board game collection, play logging, and quick-reference guides.
"""

from fastapi import APIRouter

router = APIRouter(
    prefix="/api/v1/boardgame_buddy",
    tags=["boardgame_buddy"],
)

# Import sub-modules so their routes register on the router
from . import game_routes      # noqa: F401, E402
from . import collection_routes  # noqa: F401, E402
from . import play_routes      # noqa: F401, E402
from . import chunk_routes     # noqa: F401, E402
from . import expansion_routes  # noqa: F401, E402
from . import guide_import_routes  # noqa: F401, E402
from . import profile_routes   # noqa: F401, E402
