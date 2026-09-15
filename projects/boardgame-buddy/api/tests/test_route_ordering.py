"""No literal path is swallowed by a parameterised one declared before it.

FastAPI matches routes in declaration order, so `GET /plays/{play_id}` declared
ahead of `GET /plays/imports` answers the second URL with play_id="imports" —
which reaches Supabase as an invalid-uuid cast (22P02) and 500s. Nothing about
the shadowed module looks wrong when you read it: the bug lives entirely in the
order of the `from . import ...` lines in the package's __init__, which is why
those lines carry the ordering comments they do.

This has bitten twice (`DELETE /plays/reactions`, then `GET /plays/imports`),
so the property is pinned for every project router rather than for the two
paths that happened to break. A new module whose literal routes land after a
parameterised sibling fails here instead of in someone's request log.

Each project package builds ONE flat APIRouter that its sub-modules decorate on
import, so `router.routes` is the declaration order verbatim. That is read
directly rather than through `app.routes`: recent FastAPI wraps an included
router in an opaque `_IncludedRouter` and reorders parameterised paths into a
low-priority pass, which would make this test quietly vacuous on one version
and meaningful on another.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

from fastapi.routing import APIRoute

import routes


def _shadows(earlier: str, later: str) -> bool:
    """True if `earlier` matches every URL `later` does, via a path param."""
    a, b = earlier.strip("/").split("/"), later.strip("/").split("/")
    if len(a) != len(b):
        return False
    used_param = False
    for x, y in zip(a, b):
        if x.startswith("{"):
            # A param eats any single segment, including a literal one. Two
            # params in the same slot is the same route shape, not a shadow —
            # that would be a duplicate-path problem, not this one.
            if y.startswith("{"):
                return False
            used_param = True
        elif x != y:
            return False
    return used_param


def test_no_route_is_shadowed_by_an_earlier_parameterised_path():
    """Walk routes/__init__.py's declaration order and flag any shadowing."""
    seen: list[tuple[str, frozenset]] = []
    for route in routes.router.routes:
        if not isinstance(route, APIRoute):
            continue
        methods = frozenset(route.methods or ())
        for earlier_path, earlier_methods in seen:
            if not (methods & earlier_methods):
                continue
            assert not _shadows(earlier_path, route.path), (
                f"{sorted(methods)} {route.path} is shadowed by the earlier "
                f"{sorted(earlier_methods)} {earlier_path} — move its "
                f"`from . import ...` line above that module's in "
                f"routes/__init__.py"
            )
        seen.append((route.path, methods))
