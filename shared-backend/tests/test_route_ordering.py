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

import importlib
import os
import pkgutil
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest
from fastapi import APIRouter
from fastapi.routing import APIRoute

import routes


def _router_names():
    """Every module or package under routes/ that exports an APIRouter."""
    names = []
    for mod in pkgutil.iter_modules(routes.__path__):
        module = importlib.import_module(f"routes.{mod.name}")
        if isinstance(getattr(module, "router", None), APIRouter):
            names.append(mod.name)
    return names


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


@pytest.mark.parametrize("name", _router_names())
def test_no_route_is_shadowed_by_an_earlier_parameterised_path(name):
    router = importlib.import_module(f"routes.{name}").router
    seen: list[tuple[str, str, str]] = []
    problems: list[str] = []
    for route in router.routes:
        if not isinstance(route, APIRoute):
            continue
        for method in sorted(route.methods):
            for prev_method, prev_path, prev_name in seen:
                if prev_method == method and _shadows(prev_path, route.path):
                    problems.append(
                        f"{method} {route.path} ({route.name}) is unreachable — "
                        f"{prev_method} {prev_path} ({prev_name}) is declared first. "
                        f"Declare the literal path first — move its handler up, "
                        f"or its module's import up in routes/{name}'s __init__."
                    )
            seen.append((method, route.path, route.name))
    assert not problems, "\n".join(problems)
