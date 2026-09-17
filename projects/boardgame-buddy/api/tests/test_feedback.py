"""Tests for the Dev feedback board.

Four things are worth pinning here:

  1. **A non-admin can never reach the resolved half.** Resolving is what takes
     an item off everyone else's board, so a `?status=resolved` honoured from a
     non-admin would undo the whole feature. The frontend hides the control, but
     that is chrome — this is the gate.
  2. **A like is idempotent and keeps its original timestamp.** The composite PK
     makes the write a no-op on a re-tap, which is what lets the endpoint return
     200 rather than 201 and what lets the client tap freely.
  3. **A new item lands at 1, liked by its author.** That is the deliberate
     departure from reactions (where you cannot kudos yourself), and a board
     sorted by likes reads very differently if it is wrong.
  4. **Reopening clears `resolved_by`.** A reopened item still naming the admin
     who closed it reads as resolved to anyone looking at the row.

The fake below is just enough PostgREST for those writes, plus a hand-rolled
`bgb_feedback_list` so the RPC's own contract — that `want_id` overrides the
status filter — is exercised rather than assumed. It also carries test_export's
ambiguous-embed guard: boardgamebuddy_feedback has TWO FKs into
boardgamebuddy_profiles (`user_id` and `resolved_by`), so any select embedding
profiles without naming the FK is a PGRST201 in production and must not pass here.
"""

import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest

from routes.services import feedback_service as S


ME = "user-me"
THEM = "user-them"
ADMIN = "user-admin"

_NAMES = {ME: "Me", THEM: "Them", ADMIN: "Admin"}

# What the fake substitutes for the "now()" literal the service writes.
_NOW = "2026-09-17T12:00:00Z"

_TYPES = [
    {"id": "bug", "label": "Bug", "icon": "alert-triangle", "display_order": 10},
    {"id": "feature", "label": "Feature request", "icon": "sparkles", "display_order": 20},
]
_TOPICS = [
    {"id": "feed", "label": "Feed", "icon": "home", "display_order": 10},
    {"id": "play", "label": "Play", "icon": "dices", "display_order": 20},
]

# Same reasoning as test_export's copy. boardgamebuddy_feedback reaches
# boardgamebuddy_profiles through user_id AND resolved_by, so an unqualified
# embed matches two relationships and the real PostgREST answers PGRST201.
_AMBIGUOUS_EMBEDS = {"boardgamebuddy_feedback": {"boardgamebuddy_profiles"}}


# ── Fakes ────────────────────────────────────────────────────────────────────

class _Q:
    """Just enough of the PostgREST builder for the feedback writes."""

    def __init__(self, table, db):
        self.table, self.db = table, db
        self.eqs = []
        self.order_by = None
        self.counting, self.head = False, False
        self._op, self._payload = None, None

    # -- reads --
    def select(self, *cols, count=None, head=None):
        self._reject_ambiguous_embeds(" ".join(str(c) for c in cols))
        self._op = "select"
        self.counting = count is not None
        self.head = bool(head)
        return self

    def _reject_ambiguous_embeds(self, clause):
        for embed in _AMBIGUOUS_EMBEDS.get(self.table, ()):
            for match in re.finditer(rf"{embed}(!?)", clause):
                if not match.group(1):
                    raise RuntimeError(
                        f"PGRST201: more than one relationship between "
                        f"{self.table!r} and {embed!r} — name the FK"
                    )

    def eq(self, col, val):
        self.eqs.append((col, val))
        return self

    def order(self, col, desc=False):
        self.order_by = (col, desc)
        return self

    # -- writes --
    def insert(self, payload):
        self._op, self._payload = "insert", payload
        return self

    def upsert(self, payload, on_conflict=None, ignore_duplicates=False):
        self._op, self._payload = "upsert", payload
        self._ignore_duplicates = ignore_duplicates
        return self

    def update(self, payload):
        self._op, self._payload = "update", payload
        return self

    def delete(self):
        self._op = "delete"
        return self

    # -- run --
    def _matches(self, row):
        return all(row.get(c) == v for c, v in self.eqs)

    def execute(self):
        rows = self.db.setdefault(self.table, [])
        if self._op == "select":
            hits = [r for r in rows if self._matches(r)]
            if self.order_by:
                col, desc = self.order_by
                hits = sorted(hits, key=lambda r: r[col], reverse=desc)
            return _Res([] if self.head else hits, count=len(hits) if self.counting else None)
        if self._op == "insert":
            row = dict(self._payload)
            row.setdefault("id", f"fb-{len(rows) + 1}")
            row.setdefault("status", "open")
            row.setdefault("resolved_by", None)
            row.setdefault("resolved_at", None)
            row.setdefault("created_at", f"2026-09-17T00:0{len(rows)}:00Z")
            rows.append(row)
            return _Res([dict(row)])
        if self._op == "upsert":
            row = dict(self._payload)
            key = ("feedback_id", "user_id")
            for existing in rows:
                if all(existing.get(k) == row.get(k) for k in key):
                    # ignore_duplicates: the original row, timestamp and all,
                    # survives a re-tap untouched.
                    return _Res([dict(existing)])
            row.setdefault("created_at", "2026-09-17T00:00:00Z")
            rows.append(row)
            return _Res([dict(row)])
        if self._op == "update":
            hits = [r for r in rows if self._matches(r)]
            # "now()" is the repo-wide idiom for "stamp this server-side" —
            # chapter_routes:1046 and four others write it, and Postgres
            # evaluates it on the way in. A fake that stored the literal string
            # would let a response model that cannot parse it pass here.
            payload = {
                k: (_NOW if v == "now()" else v) for k, v in self._payload.items()
            }
            for r in hits:
                r.update(payload)
            return _Res([dict(r) for r in hits])
        if self._op == "delete":
            keep = [r for r in rows if not self._matches(r)]
            gone = [r for r in rows if self._matches(r)]
            self.db[self.table] = keep
            return _Res([dict(r) for r in gone])
        raise AssertionError(f"unsupported op {self._op}")


class _Res:
    def __init__(self, data, count=None):
        self.data, self.count = data, count


class _SB:
    """A Supabase client stand-in, with bgb_feedback_list implemented in Python."""

    def __init__(self):
        self.db = {
            "boardgamebuddy_feedback": [],
            "boardgamebuddy_feedback_likes": [],
            "boardgamebuddy_feedback_types": [dict(t) for t in _TYPES],
            "boardgamebuddy_feedback_topics": [dict(t) for t in _TOPICS],
            # get_current_admin re-reads is_admin from here rather than trusting
            # the cached CurrentUser, so the route tests below can drive the real
            # dependency instead of stubbing past the thing they are testing.
            "boardgamebuddy_profiles": [
                {"id": ME, "is_admin": False},
                {"id": THEM, "is_admin": False},
                {"id": ADMIN, "is_admin": True},
            ],
        }

    def table(self, name):
        return _Q(name, self.db)

    def rpc(self, name, params):
        assert name == "bgb_feedback_list", name
        return _Rpc(self.db, params)


class _Rpc:
    """A faithful-enough bgb_feedback_list: same filters, same ordering."""

    def __init__(self, db, params):
        self.db, self.p = db, params

    def execute(self):
        likes = self.db["boardgamebuddy_feedback_likes"]
        types = {t["id"]: t for t in self.db["boardgamebuddy_feedback_types"]}
        topics = {t["id"]: t for t in self.db["boardgamebuddy_feedback_topics"]}
        want_id = self.p.get("want_id")
        out = []
        for f in self.db["boardgamebuddy_feedback"]:
            if want_id is not None:
                if f["id"] != want_id:
                    continue
            # The status filter is skipped entirely on an id lookup — the whole
            # point of want_id, since a resolve has just moved the row across it.
            elif f["status"] != self.p["want_status"]:
                continue
            if self.p.get("want_type") and f["feedback_type"] != self.p["want_type"]:
                continue
            if self.p.get("want_topic") and f["topic"] != self.p["want_topic"]:
                continue
            mine = [l for l in likes if l["feedback_id"] == f["id"]]
            ft, tp = types[f["feedback_type"]], topics[f["topic"]]
            out.append({
                "id": f["id"],
                "user_id": f["user_id"],
                "author_name": _NAMES.get(f["user_id"]),
                "feedback_type": f["feedback_type"],
                "feedback_type_label": ft["label"],
                "feedback_type_icon": ft["icon"],
                "topic": f["topic"],
                "topic_label": tp["label"],
                "topic_icon": tp["icon"],
                "body": f["body"],
                "status": f["status"],
                "resolved_at": f["resolved_at"],
                "resolver_name": _NAMES.get(f["resolved_by"]),
                "created_at": f["created_at"],
                "like_count": len(mine),
                "viewer_liked": any(l["user_id"] == self.p["viewer_id"] for l in mine),
            })
        out.sort(key=lambda r: (-r["like_count"], r["created_at"]), reverse=False)
        out.sort(key=lambda r: r["like_count"], reverse=True)
        return _Res(out)


@pytest.fixture()
def sb():
    return _SB()


# ── Service: submit ──────────────────────────────────────────────────────────

def test_submitting_lands_at_one_like_from_its_author(sb):
    row = S.create(sb, ME, "bug", "feed", "The feed is slow")
    assert row["like_count"] == 1
    assert row["viewer_liked"] is True
    assert row["author_name"] == "Me"
    assert row["status"] == "open"
    # The like really is a row, not a computed +1.
    assert sb.db["boardgamebuddy_feedback_likes"] == [
        {"feedback_id": row["id"], "user_id": ME, "created_at": "2026-09-17T00:00:00Z"}
    ]


def test_an_unknown_type_or_topic_is_a_400_not_a_foreign_key_500(sb):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as bad_type:
        S.create(sb, ME, "nonsense", "feed", "hi")
    assert bad_type.value.status_code == 400

    with pytest.raises(HTTPException) as bad_topic:
        S.create(sb, ME, "bug", "nonsense", "hi")
    assert bad_topic.value.status_code == 400

    assert sb.db["boardgamebuddy_feedback"] == []


# ── Service: likes ───────────────────────────────────────────────────────────

def test_liking_twice_writes_once_and_keeps_the_original_row(sb):
    item = S.create(sb, ME, "feature", "play", "Sort by weight")
    assert S.like(sb, THEM, item["id"]) == 2
    # The second tap is the one that matters: idempotent, which is what lets the
    # endpoint answer 200 instead of 201.
    assert S.like(sb, THEM, item["id"]) == 2
    rows = [l for l in sb.db["boardgamebuddy_feedback_likes"] if l["user_id"] == THEM]
    assert len(rows) == 1


def test_unliking_removes_only_the_callers_own_row(sb):
    item = S.create(sb, ME, "bug", "feed", "Broken")
    S.like(sb, THEM, item["id"])
    assert S.unlike(sb, THEM, item["id"]) == 1
    remaining = sb.db["boardgamebuddy_feedback_likes"]
    assert [l["user_id"] for l in remaining] == [ME]


def test_the_author_may_take_back_their_own_like(sb):
    # The deliberate difference from reaction_service, which drops the caller's
    # own plays outright. Here the author is a voter like anyone else.
    item = S.create(sb, ME, "bug", "feed", "Never mind")
    assert S.unlike(sb, ME, item["id"]) == 0


def test_liking_something_that_does_not_exist_is_a_404(sb):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        S.like(sb, ME, "fb-nope")
    assert e.value.status_code == 404


# ── Service: resolve / reopen ────────────────────────────────────────────────

def test_resolving_then_reopening_leaves_no_stale_resolver(sb):
    item = S.create(sb, ME, "bug", "feed", "Broken")

    resolved = S.set_status(sb, ADMIN, item["id"], True)
    assert resolved["status"] == "resolved"
    assert resolved["resolver_name"] == "Admin"

    reopened = S.set_status(sb, ADMIN, item["id"], False)
    assert reopened["status"] == "open"
    # Both, not just the status: an item that still names who closed it reads as
    # resolved to anyone looking at the row.
    assert reopened["resolver_name"] is None
    assert reopened["resolved_at"] is None


def test_a_resolved_item_leaves_the_open_board_and_joins_the_resolved_one(sb):
    item = S.create(sb, ME, "bug", "feed", "Broken")
    S.set_status(sb, ADMIN, item["id"], True)

    assert S.list_feedback(sb, ME, "open") == []
    assert [r["id"] for r in S.list_feedback(sb, ME, "resolved")] == [item["id"]]


# ── Service: the board's ordering and filters ────────────────────────────────

def test_the_board_is_ordered_by_likes(sb):
    quiet = S.create(sb, ME, "bug", "feed", "One voice")
    popular = S.create(sb, THEM, "feature", "play", "Everyone wants this")
    S.like(sb, ME, popular["id"])
    S.like(sb, ADMIN, popular["id"])

    board = S.list_feedback(sb, ME, "open")
    assert [r["id"] for r in board] == [popular["id"], quiet["id"]]
    assert [r["like_count"] for r in board] == [3, 1]


def test_filters_narrow_both_axes_and_an_empty_string_means_no_filter(sb):
    bug = S.create(sb, ME, "bug", "feed", "A bug on the feed")
    S.create(sb, ME, "feature", "play", "A feature for play")

    assert [r["id"] for r in S.list_feedback(sb, ME, "open", "bug")] == [bug["id"]]
    assert [r["id"] for r in S.list_feedback(sb, ME, "open", None, "feed")] == [bug["id"]]
    # `?type=` from the client must mean "no filter", not "a type whose id is ''".
    assert len(S.list_feedback(sb, ME, "open", "", "")) == 2


# ── Routes: the non-admin gate ───────────────────────────────────────────────

@pytest.fixture()
def client(monkeypatch, sb):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import routes as bb
    from routes import dependencies as deps
    from routes import feedback_routes as fr
    from routes.dependencies import CurrentUser, get_current_user

    monkeypatch.setattr(fr, "get_supabase", lambda: sb)
    # Only get_current_user is overridden below. get_current_admin is left real
    # and pointed at the fake's profiles table, so the 403 test exercises the
    # actual guard — including its deliberate re-read of is_admin — rather than
    # a stub that would pass whatever it was told to.
    monkeypatch.setattr(deps, "get_supabase", lambda: sb)

    app = FastAPI()
    app.include_router(bb.router)

    state = {"admin": False}

    def _me():
        return CurrentUser(
            user_id=ADMIN if state["admin"] else ME,
            display_name="Admin" if state["admin"] else "Me",
            username="admin" if state["admin"] else "me",
            is_admin=state["admin"],
        )

    app.dependency_overrides[get_current_user] = _me
    c = TestClient(app)
    c.become_admin = lambda on=True: state.__setitem__("admin", on)
    return c


PREFIX = "/api/v1/boardgame_buddy"


def test_a_non_admin_asking_for_resolved_gets_the_open_board(client, sb):
    item = S.create(sb, ME, "bug", "feed", "Broken")
    S.set_status(sb, ADMIN, item["id"], True)
    S.create(sb, ME, "feature", "play", "Still open")

    # Not a 403 and not an error — the parameter is simply not theirs to set, so
    # it is overridden. A non-admin must never learn the resolved half exists.
    res = client.get(f"{PREFIX}/feedback", params={"status": "resolved"})
    assert res.status_code == 200
    assert [r["body"] for r in res.json()] == ["Still open"]


def test_an_admin_asking_for_resolved_gets_it(client, sb):
    item = S.create(sb, ME, "bug", "feed", "Broken")
    S.set_status(sb, ADMIN, item["id"], True)

    client.become_admin()
    res = client.get(f"{PREFIX}/feedback", params={"status": "resolved"})
    assert res.status_code == 200
    assert [r["id"] for r in res.json()] == [item["id"]]


def test_an_admin_sending_a_nonsense_status_gets_a_400(client):
    client.become_admin()
    res = client.get(f"{PREFIX}/feedback", params={"status": "sideways"})
    assert res.status_code == 400


def test_resolve_is_403_for_a_non_admin(client, sb):
    item = S.create(sb, ME, "bug", "feed", "Broken")
    res = client.post(f"{PREFIX}/feedback/{item['id']}/resolve")
    assert res.status_code == 403
    assert sb.db["boardgamebuddy_feedback"][0]["status"] == "open"


def test_submitting_through_the_route_returns_the_rendered_row(client):
    res = client.post(
        f"{PREFIX}/feedback",
        json={"feedback_type": "bug", "topic": "feed", "body": "  The feed is slow  "},
    )
    assert res.status_code == 201
    row = res.json()
    # Trimmed server-side rather than trusted from the client.
    assert row["body"] == "The feed is slow"
    assert row["like_count"] == 1
    assert row["feedback_type_label"] == "Bug"
    assert row["topic_icon"] == "home"


def test_a_body_of_whitespace_is_rejected(client):
    res = client.post(
        f"{PREFIX}/feedback",
        json={"feedback_type": "bug", "topic": "feed", "body": "     "},
    )
    assert res.status_code == 400


def test_the_like_endpoints_round_trip(client, sb):
    item = S.create(sb, THEM, "bug", "feed", "Broken")

    liked = client.post(f"{PREFIX}/feedback/{item['id']}/like")
    assert liked.status_code == 200
    assert liked.json() == {"feedback_id": item["id"], "liked": True, "like_count": 2}

    unliked = client.request("DELETE", f"{PREFIX}/feedback/{item['id']}/like")
    assert unliked.status_code == 200
    assert unliked.json()["like_count"] == 1
