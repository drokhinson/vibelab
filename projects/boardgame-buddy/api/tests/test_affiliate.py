"""Affiliate partners stay OFF until an operator switches one on, and the
link every pill carries is built by exactly one function.

Five properties, each a bug that would ship silently:

  NOTHING IS LIVE BY DEFAULT. The seeded rows are disabled with no credential,
  and `live` needs both. GET /affiliate/links answers `{links: [], live: false}`
  until then — which is what every reader-facing surface renders nothing from.

  ENABLING WITHOUT A CREDENTIAL IS REFUSED. An enabled row with no tag and no
  wrapper would render an UNTRACKED link, which is the one outcome worse than
  no link. 422, and the row stays off.

  ONE URL WRITER. {query} is URL-encoded, {tag} is substituted, a dangling
  `tag=` is stripped when there is no tag, and the wrapper takes the resolved
  URL percent-encoded. The editor's preview calls the same function.

  THE CLICK LOG CARRIES NO USER, and a tap on a partner that is not live is
  dropped rather than counted.

  EVERY ADMIN ROUTE IS GATED, walked from the router so a ninth cannot forget;
  the two reader routes are not.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import cache  # noqa: E402
import routes  # noqa: E402
from routes import affiliate_routes  # noqa: E402
from routes.constants import AffiliateSurface  # noqa: E402
from routes.dependencies import CurrentUser, get_current_admin  # noqa: E402
from routes.models import AffiliatePartner, AffiliatePartnerPatchRequest  # noqa: E402
from routes.services import affiliate_service as S  # noqa: E402


def _partner(pid="amazon", **over):
    row = {
        "id": pid, "label": pid.title(), "url_template": "https://www.amazon.com/s?k={query}&tag={tag}",
        "wrapper_template": None, "tracking_tag": None, "disclosure": None, "notes": None,
        "display_order": 10, "enabled": False, "updated_at": None,
    }
    row.update(over)
    return row


class _Query:
    """PostgREST builder double over one table's rows, recording writes."""

    def __init__(self, name, rows, log):
        self.name, self.rows, self.log = name, rows, log
        self._op, self._payload, self._eq = "select", None, {}

    def select(self, *_a, **_k):
        return self

    def insert(self, payload):
        self._op, self._payload = "insert", payload
        return self

    def update(self, payload):
        self._op, self._payload = "update", payload
        return self

    def eq(self, col, val):
        self._eq[col] = val
        return self

    def gte(self, *_a):
        return self

    def order(self, *_a, **_k):
        return self

    def limit(self, *_a):
        return self

    def execute(self):
        if self._op == "insert":
            self.log.append(("insert", self.name, self._payload))
            return type("R", (), {"data": [self._payload]})()
        if self._op == "update":
            self.log.append(("update", self.name, dict(self._eq), self._payload))
            hit = [r for r in self.rows if all(r.get(c) == v for c, v in self._eq.items())]
            if not hit:
                return type("R", (), {"data": []})()
            hit[0].update(self._payload)
            return type("R", (), {"data": [dict(hit[0])]})()
        rows = [r for r in self.rows if all(r.get(c) == v for c, v in self._eq.items())]
        return type("R", (), {"data": rows})()


class _SB:
    def __init__(self, partners, games=None, clicks=None):
        self.tables = {
            "boardgamebuddy_affiliate_partners": partners,
            "boardgamebuddy_games": games or [{"id": "g1", "name": "Brass: Birmingham & Co"}],
            "boardgamebuddy_affiliate_clicks": clicks or [],
        }
        self.log = []

    def table(self, name):
        return _Query(name, self.tables[name], self.log)


@pytest.fixture(autouse=True)
def _fresh_cache():
    cache.clear(S._NS)
    yield
    cache.clear(S._NS)


# ── Off by default ───────────────────────────────────────────────────────────

def test_seeded_rows_are_not_live_and_links_are_empty():
    sb = _SB([_partner("amazon"), _partner("miniature-market", url_template="https://mm.example/?q={query}")])
    assert all(not p.live for p in S.list_all(sb))
    res = S.links_for_game(sb, "g1")
    assert res.links == [] and res.live is False
    # And no catalog read was spent finding the game's name for nothing.
    assert not any(e[1] == "boardgamebuddy_games" for e in sb.log)


def test_enabled_without_credential_is_not_live_and_enabling_is_refused():
    sb = _SB([_partner("amazon", enabled=True)])
    assert S.list_live(sb) == []
    with pytest.raises(HTTPException) as exc:
        S.set_enabled(sb, "amazon", True)
    assert exc.value.status_code == 422
    assert not any(e[0] == "update" for e in sb.log)


def test_tag_then_enable_makes_it_live_and_disable_is_instant():
    sb = _SB([_partner("amazon")])
    S.update(sb, "amazon", AffiliatePartnerPatchRequest(tracking_tag="bgbuddy-20"))
    on = S.set_enabled(sb, "amazon", True)
    assert on.live is True
    links = S.links_for_game(sb, "g1")
    assert links.live is True and [l.partner_id for l in links.links] == ["amazon"]
    off = S.set_enabled(sb, "amazon", False)
    assert off.live is False
    assert S.links_for_game(sb, "g1").links == []


def test_enabled_is_not_a_patch_field():
    assert "enabled" not in AffiliatePartnerPatchRequest.model_fields
    with pytest.raises(ValueError):
        AffiliatePartnerPatchRequest()


# ── One URL writer ───────────────────────────────────────────────────────────

def _p(**over):
    return AffiliatePartner(**_partner(**over))


def test_query_is_encoded_and_tag_substituted():
    url = S.build_url(_p(tracking_tag="bgbuddy-20"), game_name="Brass: Birmingham & Co")
    assert url == "https://www.amazon.com/s?k=Brass%3A+Birmingham+%26+Co&tag=bgbuddy-20"


def test_missing_tag_leaves_a_clean_url_not_a_blank_parameter():
    assert S.build_url(_p(), game_name="Catan") == "https://www.amazon.com/s?k=Catan"
    assert S.build_url(
        _p(url_template="https://x.example/s?tag={tag}&k={query}"), game_name="Catan"
    ) == "https://x.example/s?k=Catan"


def test_wrapper_takes_the_resolved_url_encoded():
    p = _p(
        pid="miniature-market",
        url_template="https://www.miniaturemarket.com/searchresults/?q={query}",
        wrapper_template="https://miniaturemarket.sjv.io/c/1/2/3?u={url}",
    )
    assert S.build_url(p, game_name="Ark Nova") == (
        "https://miniaturemarket.sjv.io/c/1/2/3?u="
        "https%3A%2F%2Fwww.miniaturemarket.com%2Fsearchresults%2F%3Fq%3DArk%2BNova"
    )


def test_preview_uses_the_same_writer_while_disabled():
    sb = _SB([_partner("amazon", tracking_tag="bgbuddy-20")])
    pv = S.preview(sb, "amazon", "g1")
    assert pv.live is False
    assert pv.url == S.build_url(_p(tracking_tag="bgbuddy-20"), game_name="Brass: Birmingham & Co")


def test_disclosure_rides_the_link_only_when_set():
    sb = _SB([
        _partner("amazon", tracking_tag="t", enabled=True, disclosure="As an Amazon Associate, BoardgameBuddy earns from qualifying purchases."),
        _partner("gamenerdz", url_template="https://gn.example/?q={query}", tracking_tag="x", enabled=True),
    ])
    links = S.links_for_game(sb, "g1").links
    assert links[0].disclosure.startswith("As an Amazon Associate")
    assert links[1].disclosure is None


# ── Clicks ───────────────────────────────────────────────────────────────────

def test_click_row_has_no_user_and_a_dead_partner_is_dropped():
    sb = _SB([_partner("amazon", tracking_tag="t", enabled=True), _partner("noble-knight")])
    S.log_click(sb, "amazon", "g1", AffiliateSurface.GAME_DETAIL)
    inserts = [e for e in sb.log if e[0] == "insert"]
    assert len(inserts) == 1
    assert inserts[0][2] == {"partner_id": "amazon", "surface": "game_detail", "game_id": "g1"}
    assert "user_id" not in inserts[0][2]
    S.log_click(sb, "noble-knight", "g1", AffiliateSurface.DISCOVER)   # not live
    assert len([e for e in sb.log if e[0] == "insert"]) == 1


# ── The gate ─────────────────────────────────────────────────────────────────

def test_every_affiliate_admin_route_requires_an_admin():
    admin_routes = [r for r in routes.router.routes if "/affiliate/admin" in getattr(r, "path", "")]
    assert len(admin_routes) == 6, "route list changed — check the gate still holds"
    for route in admin_routes:
        calls = [d.call for d in route.dependant.dependencies]
        assert get_current_admin in calls, f"{route.path} is not admin-gated"


def test_reader_routes_are_not_admin_gated_and_work_anonymously(monkeypatch):
    readers = [r for r in routes.router.routes
               if getattr(r, "path", "") in ("/api/v1/boardgame_buddy/affiliate/links",
                                              "/api/v1/boardgame_buddy/affiliate/click")]
    assert len(readers) == 2
    for route in readers:
        assert get_current_admin not in [d.call for d in route.dependant.dependencies]

    sb = _SB([_partner("amazon")])
    monkeypatch.setattr(affiliate_routes, "get_supabase", lambda: sb)
    app = FastAPI()
    app.include_router(routes.router)
    c = TestClient(app)
    r = c.get("/api/v1/boardgame_buddy/affiliate/links", params={"game_id": "g1"})
    assert r.status_code == 200 and r.json() == {"game_id": "g1", "links": [], "live": False}
    assert c.post("/api/v1/boardgame_buddy/affiliate/click",
                  json={"partner_id": "amazon", "game_id": "g1", "surface": "game_detail"}).status_code == 204


def test_enable_route_surfaces_the_refusal(monkeypatch):
    sb = _SB([_partner("amazon")])
    monkeypatch.setattr(affiliate_routes, "get_supabase", lambda: sb)
    app = FastAPI()
    app.include_router(routes.router)
    app.dependency_overrides[get_current_admin] = lambda: CurrentUser(
        user_id="a", display_name="A", username="a", is_admin=True
    )
    r = TestClient(app).post("/api/v1/boardgame_buddy/affiliate/admin/partners/amazon/enable")
    assert r.status_code == 422
    assert "tracking tag" in r.json()["detail"]
