"""A release notice reaches everyone it should, once, and nobody it shouldn't.

Four properties, and each one is a bug that would ship silently if it broke —
a notice nobody sees looks identical to a release nobody cared about.

  DRAFTS DO NOT ESCAPE. `published_at IS NULL` is the only draft flag, so every
  user-facing read has to carry the predicate itself. There is no status column
  to fall back on.

  `through` IS PASSED THROUGH. The watermark write takes the newest
  published_at the client was SHOWN, never now(). Substituting now() would mark
  a notice published between /bootstrap and the dismissal as seen without it
  ever having been on screen — and since the admin publishes from inside this
  same app, that race is ordinary rather than contrived. This is the property
  most likely to be "simplified" away by someone who reads the parameter as
  redundant.

  THE ORDERING IS THE RPC'S. bgb_release_notices_unseen returns the NEWEST
  `limit` notices sorted oldest-first, so the popup reads as a chronology while
  an account six releases behind still gets the recent ones. A re-sort in
  Python would quietly turn that into the five oldest.

  EVERY ADMIN ROUTE IS GATED. Walked from the router rather than asserted
  route-by-route, so a ninth admin endpoint added later cannot forget.

The new-account rule ("a fresh signup does not see the backlog") is NOT pinned
here, because it is not expressible at this layer: it lives entirely in the
column default `release_notices_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()`
from migration 042. What is pinned is the shape that makes the default
sufficient — the watermark is read in SQL, so no Python caller can bypass it.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

from datetime import datetime, timezone  # noqa: E402

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

import routes  # noqa: E402
from routes.constants import ReleaseNoticeStatus  # noqa: E402
from routes.dependencies import get_current_admin  # noqa: E402
from routes.models import ReleaseNoticePatchRequest  # noqa: E402
from routes.services import release_notice_service as S  # noqa: E402


def _dt(day):
    return datetime(2026, 9, day, 12, 0, tzinfo=timezone.utc)


def _notice(day, title, published=True):
    return {
        "id": f"n{day}",
        "title": title,
        "body_md": f"# {title}",
        "link_route": None,
        "link_label": None,
        "published_at": _dt(day).isoformat() if published else None,
        "created_at": _dt(day).isoformat(),
        "updated_at": _dt(day).isoformat(),
    }


class _Query:
    """PostgREST builder double: records the predicates, filters the rows."""

    def __init__(self, rows, log):
        self.rows, self.log = rows, log
        self._op = "select"
        self._payload = None
        self._filters = []
        self._orders = []

    def select(self, *_a, **_k):
        return self

    def insert(self, payload):
        self._op, self._payload = "insert", payload
        return self

    def update(self, payload):
        self._op, self._payload = "update", payload
        return self

    def delete(self):
        self._op = "delete"
        return self

    def eq(self, col, val):
        self._filters.append(("eq", col, val))
        return self

    def is_(self, col, val):
        self._filters.append(("is", col, val))
        return self

    @property
    def not_(self):
        outer = self

        class _Not:
            def is_(self, col, val):
                outer._filters.append(("not.is", col, val))
                return outer

        return _Not()

    def order(self, col, **kw):
        self._orders.append((col, kw))
        return self

    def limit(self, *_a):
        return self

    def execute(self):
        self.log.append((self._op, list(self._filters), self._payload, list(self._orders)))
        if self._op == "insert":
            return type("R", (), {"data": [dict(_notice(9, "new", False), **self._payload)]})()
        if self._op in ("update", "delete"):
            ids = [v for (op, c, v) in self._filters if op == "eq" and c == "id"]
            hit = [r for r in self.rows if not ids or r["id"] in ids]
            if not hit:
                return type("R", (), {"data": []})()
            merged = dict(hit[0], **(self._payload or {}))
            return type("R", (), {"data": [merged]})()
        rows = self.rows
        for op, col, _val in self._filters:
            if op == "is" and col == "published_at":
                rows = [r for r in rows if r.get("published_at") is None]
            elif op == "not.is" and col == "published_at":
                rows = [r for r in rows if r.get("published_at") is not None]
        return type("R", (), {"data": rows})()


class _SB:
    def __init__(self, rows=None, rpc_data=None):
        self.rows = rows or []
        self.rpc_data = rpc_data
        self.log = []
        self.rpc_calls = []

    def table(self, name):
        assert name == "boardgamebuddy_release_notices"
        return _Query(self.rows, self.log)

    def rpc(self, name, params):
        self.rpc_calls.append((name, params))
        data = self.rpc_data
        return type("R", (), {"execute": lambda _s=None: type("X", (), {"data": data})()})()


# ── Drafts do not escape ─────────────────────────────────────────────────────

def test_archive_lists_only_published():
    sb = _SB(rows=[_notice(1, "Shipped"), _notice(2, "Secret", published=False)])
    items = S.list_published(sb)
    assert [n.title for n in items] == ["Shipped"]
    # The predicate has to be on the query, not applied afterwards in Python —
    # otherwise a LIMIT would be spent on rows that get thrown away.
    ops = [f for (_op, f, _p, _o) in sb.log for f in f]
    assert ("not.is", "published_at", "null") in ops


def test_admin_list_filters_map_to_the_right_predicate():
    rows = [_notice(1, "Shipped"), _notice(2, "Secret", published=False)]

    assert [n.title for n in S.list_all(_SB(rows), ReleaseNoticeStatus.DRAFT)] == ["Secret"]
    assert [n.title for n in S.list_all(_SB(rows), ReleaseNoticeStatus.PUBLISHED)] == ["Shipped"]
    assert len(S.list_all(_SB(rows), ReleaseNoticeStatus.ALL)) == 2

    # Drafts first: that is where the admin is working, the published ones are done.
    sb = _SB(rows)
    S.list_all(sb, ReleaseNoticeStatus.ALL)
    orders = sb.log[0][3]
    assert orders[0][0] == "published_at"
    assert orders[0][1].get("nullsfirst") is True


def test_published_flag_is_derived_from_the_timestamp():
    """There is no status column, here or in the table."""
    sb = _SB(rows=[_notice(1, "Shipped"), _notice(2, "Secret", published=False)])
    by_title = {n.title: n for n in S.list_all(sb, ReleaseNoticeStatus.ALL)}
    assert by_title["Shipped"].published is True
    assert by_title["Secret"].published is False


# ── The watermark ────────────────────────────────────────────────────────────

def test_mark_seen_passes_the_clients_timestamp_through():
    """Never now(). A notice published mid-session must survive to next visit."""
    shown_through = _dt(3)
    sb = _SB(rpc_data=shown_through.isoformat())

    res = S.mark_seen(sb, "viewer-1", shown_through)

    name, params = sb.rpc_calls[0]
    assert name == "bgb_mark_release_notices_seen"
    assert params["p_viewer"] == "viewer-1"
    assert params["p_through"] == shown_through.isoformat()
    assert res.seen_at == shown_through


def test_mark_seen_defers_to_the_rpc_when_the_client_sent_nothing():
    """None stays None so the RPC's own now() default applies — the server
    must not invent a timestamp the client never saw."""
    sb = _SB(rpc_data=_dt(4).isoformat())
    S.mark_seen(sb, "viewer-1", None)
    assert sb.rpc_calls[0][1]["p_through"] is None


# ── The unseen list ──────────────────────────────────────────────────────────

def test_unseen_reads_the_watermark_in_sql_not_in_python():
    """Only the viewer id and a cap go over; the comparison lives in the RPC,
    so no caller can accidentally widen it."""
    sb = _SB(rpc_data=[_notice(2, "B"), _notice(3, "C")])
    S.unseen(sb, "viewer-1")
    name, params = sb.rpc_calls[0]
    assert name == "bgb_release_notices_unseen"
    assert set(params) == {"p_viewer", "p_limit"}
    assert params["p_viewer"] == "viewer-1"


def test_unseen_keeps_the_rpcs_order():
    """Oldest-first, as the RPC hands it back. A Python re-sort here would turn
    'the newest five, read as a chronology' into 'the five oldest'."""
    sb = _SB(rpc_data=[_notice(2, "B"), _notice(3, "C"), _notice(9, "I")])
    assert [n.title for n in S.unseen(sb, "v")] == ["B", "C", "I"]


def test_unseen_is_empty_when_there_is_nothing_new():
    sb = _SB(rpc_data=[])
    assert S.unseen(sb, "v") == []


# ── Publish / unpublish ──────────────────────────────────────────────────────

def test_publish_stamps_and_unpublish_clears():
    sb = _SB(rows=[_notice(1, "Shipped", published=False)])
    S.set_published(sb, "n1", True)
    written = sb.log[0][2]
    assert written["published_at"] is not None

    sb2 = _SB(rows=[_notice(1, "Shipped")])
    S.set_published(sb2, "n1", False)
    assert sb2.log[0][2]["published_at"] is None


def test_publish_never_takes_a_caller_supplied_timestamp():
    """A backdated notice would sort behind watermarks users already hold and be
    invisible to exactly the people it was written for."""
    import inspect

    assert "published_at" not in inspect.signature(S.set_published).parameters
    from routes.models import ReleaseNoticeWriteRequest

    assert "published_at" not in ReleaseNoticeWriteRequest.model_fields
    assert "published_at" not in ReleaseNoticePatchRequest.model_fields


def test_editing_a_live_notice_does_not_move_its_publish_stamp():
    """A typo fix must not re-interrupt everyone who already read it."""
    sb = _SB(rows=[_notice(1, "Shipped")])
    S.update(sb, "n1", ReleaseNoticePatchRequest(title="Shipped (fixed)"))
    assert "published_at" not in sb.log[0][2]


def test_clear_link_is_distinguishable_from_leaving_it_alone():
    """None is also the absent value, so without the flag a link could be set
    but never removed."""
    sb = _SB(rows=[_notice(1, "Shipped")])
    S.update(sb, "n1", ReleaseNoticePatchRequest(title="x"))
    assert "link_route" not in sb.log[0][2]

    sb2 = _SB(rows=[_notice(1, "Shipped")])
    S.update(sb2, "n1", ReleaseNoticePatchRequest(clear_link=True))
    assert sb2.log[0][2]["link_route"] is None
    assert sb2.log[0][2]["link_label"] is None


def test_an_empty_patch_is_refused():
    with pytest.raises(ValueError):
        ReleaseNoticePatchRequest()


def test_missing_notice_404s_rather_than_returning_none():
    sb = _SB(rows=[])
    for call in (
        lambda: S.get(sb, "nope"),
        lambda: S.set_published(sb, "nope", True),
        lambda: S.delete(sb, "nope"),
        lambda: S.update(sb, "nope", ReleaseNoticePatchRequest(title="x")),
    ):
        with pytest.raises(HTTPException) as e:
            call()
        assert e.value.status_code == 404


# ── The admin gate ───────────────────────────────────────────────────────────

def test_every_release_notice_admin_route_requires_an_admin():
    """Walked from the router so a ninth admin endpoint cannot forget."""
    admin_routes = [
        r
        for r in routes.router.routes
        if "/release-notices/admin" in getattr(r, "path", "")
    ]
    assert len(admin_routes) == 6, "route list changed — check the gate still holds"

    for route in admin_routes:
        calls = [d.call for d in route.dependant.dependencies]
        assert get_current_admin in calls, f"{route.path} is not admin-gated"


def test_the_two_reader_routes_are_not_admin_gated():
    """The archive and the watermark write are for everyone; gating them would
    make the popup admin-only and look like 'the feature does nothing'."""
    for path in ("/release-notices", "/release-notices/seen"):
        route = next(
            r
            for r in routes.router.routes
            if getattr(r, "path", "").endswith(path)
            and "/admin" not in getattr(r, "path", "")
        )
        calls = [d.call for d in route.dependant.dependencies]
        assert get_current_admin not in calls
