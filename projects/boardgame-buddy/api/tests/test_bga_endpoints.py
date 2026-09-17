"""Pin the Board Game Arena wire format.

`routes/bga_endpoints.py` is a quarantine module: everything this codebase
believes about BGA's URLs and response shapes lives there, reconstructed rather
than documented, because BGA has no public API. These tests are what turn a
change in that belief into a visible diff.

They are PURE — no network, no Supabase, no FastAPI — which is what lets them
run in CI against a site CI cannot reach. Every input comes from
`tests/fixtures/bga/`; see that directory's README for how to replace the
placeholders with real captures.

Three behaviours get more attention than the rest, because each is a way BGA
differs from BoardGameGeek and each would fail silently:

  * A REJECTED LOGIN IS HTTP 200. Reading the status code first reports success
    and stores a session that was never granted.
  * TWO-FACTOR IS UNRECOVERABLE, and must not be reported as a bad password —
    that sends the user round a loop they cannot exit.
  * A SIGNED-OUT SESSION ANSWERS WITH A PAGE, not a 401. Parsing that as data
    is how an importer cheerfully reports "you have no plays".
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from routes import bga_endpoints as bga

FIXTURES = Path(__file__).parent / "fixtures" / "bga"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# ── URLs ─────────────────────────────────────────────────────────────────────


def test_urls_are_built_off_one_base():
    """Every path hangs off BGA_BASE, so BGA_BASE_URL can redirect them all."""
    assert bga.url(bga.LOGIN_PATH).endswith("/account/account/login.html")
    assert bga.url(bga.GAMESTATS_PATH).endswith("/gamestats/gamestats/getGames.html")
    assert bga.url(bga.TABLEINFO_PATH).endswith("/table/table/tableinfos.html")
    for path in (bga.LOGIN_PATH, bga.GAMESTATS_PATH, bga.TABLEINFO_PATH):
        assert bga.url(path).startswith(bga.BGA_BASE)


def test_user_agent_is_honest():
    """NOT a browser spoof.

    `bgg_client._web_headers` sends a Chrome UA to get past Cloudflare
    screening ordinary traffic. BGA's terms name automated access itself, so a
    bot screen that turns us away is a control working as designed — and
    pretending to be Chrome to defeat it is a different act from reading your
    own data. If somebody "fixes" the UA to get past a block, this fails and
    makes them say so out loud.
    """
    assert "vibelab" in bga.BGA_USER_AGENT.lower()
    assert "mozilla" not in bga.BGA_USER_AGENT.lower()
    assert "chrome" not in bga.BGA_USER_AGENT.lower()


# ── Login ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "html",
    [
        '<input type="hidden" name="request_token" value="tok-123" />',
        '<input value="tok-123" name="request_token">',
        'var config = {"request_token": "tok-123"};',
    ],
)
def test_request_token_is_found_in_every_spelling(html):
    """Three spellings have been seen and none is documented."""
    assert bga.parse_request_token(html) == "tok-123"


def test_request_token_absent_is_not_an_error():
    assert bga.parse_request_token("<html><body>nothing here</body></html>") is None
    assert bga.parse_request_token("") is None


def test_login_form_carries_the_token_only_when_there_is_one():
    with_token = bga.login_form("me", "pw", "tok")
    assert with_token["request_token"] == "tok"
    assert with_token["email"] == "me"
    assert with_token["password"] == "pw"
    assert "request_token" not in bga.login_form("me", "pw", None)


def test_a_good_login_is_ok_and_yields_the_player_id():
    result = bga.login_result(200, fixture("login_ok.json"), {"PHPSESSID": "abc"})
    assert result.outcome is bga.BgaLoginOutcome.OK
    assert result.player_id == "88421735"


def test_a_rejected_password_is_http_200():
    """The single most important difference from BGG.

    A status-first reading of this response says 'success' and stores a
    session that was never granted.
    """
    result = bga.login_result(200, fixture("login_bad.json"), {"PHPSESSID": "abc"})
    assert result.outcome is bga.BgaLoginOutcome.BAD_CREDENTIALS


def test_two_factor_is_its_own_outcome():
    """Not BAD_CREDENTIALS.

    An importer cannot answer a second factor, so 'check your password' sends
    somebody with 2FA on round a loop with no exit.
    """
    result = bga.login_result(200, fixture("login_2fa.json"), {})
    assert result.outcome is bga.BgaLoginOutcome.NEEDS_2FA


def test_a_grant_with_no_cookie_is_not_a_grant():
    result = bga.login_result(200, '{"status": 1}', {})
    assert result.outcome is bga.BgaLoginOutcome.BAD_CREDENTIALS


def test_rate_limiting_is_distinguished_from_a_bad_password():
    assert bga.login_result(429, "{}", {}).outcome is bga.BgaLoginOutcome.THROTTLED
    assert (
        bga.login_result(200, '{"status":"0","error":"Too many attempts"}', {}).outcome
        is bga.BgaLoginOutcome.THROTTLED
    )


def test_an_unreadable_body_does_not_crash_the_classifier():
    result = bga.login_result(500, "<html>gateway error</html>", {})
    assert result.outcome is bga.BgaLoginOutcome.UNKNOWN


# ── Signed-out detection ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "status,body",
    [
        (401, ""),
        (403, ""),
        (200, "<form id='loginform'>"),
        (200, '{"error": "You must be logged in"}'),
    ],
)
def test_signed_out_is_detected_without_a_status_code(status, body):
    assert bga.looks_signed_out(status, body) is True


def test_real_data_does_not_read_as_signed_out():
    assert bga.looks_signed_out(200, fixture("gamestats.json")) is False


# ── Game history ─────────────────────────────────────────────────────────────


def test_gamestats_params():
    params = bga.gamestats_params("77", page=3)
    assert params["player"] == "77"
    assert params["page"] == "3"
    assert params["finished"] == "1"
    # Page is clamped rather than sent as 0, which BGA reads as "page 1" on a
    # good day and as an error on a bad one.
    assert bga.gamestats_params("77", page=0)["page"] == "1"


def test_a_history_page_parses_into_stubs():
    rows, has_more = bga.parse_table_page(fixture("gamestats.json"))
    assert has_more is False
    assert [r.table_id for r in rows] == [555000123, 555000456]
    assert rows[0].game_name == "Azul"
    # BGA sends unix seconds; the exact converted day is asserted rather than
    # "it is a date", because a timezone slip here imports every evening game
    # on the wrong day.
    assert rows[0].ended_at == date(2026, 3, 2)
    assert rows[1].ended_at == date(2026, 3, 1)


def test_ai_seats_are_dropped():
    """A bot is not a person.

    Left in, it becomes a ghost player on somebody's play — one that shows up
    in their buddy suggestions and that nobody can ever claim.
    """
    rows, _ = bga.parse_table_page(fixture("gamestats.json"))
    hanabi = rows[1]
    assert [s.handle for s in hanabi.seats] == ["me_bga", "Tiggy_42"]
    assert all(s.is_ai is False for s in hanabi.seats)


def test_scores_and_ranks_survive_being_strings():
    rows, _ = bga.parse_table_page(fixture("gamestats.json"))
    seat = rows[0].seats[0]
    assert seat.score == 88
    assert seat.rank == 1


def test_a_page_carrying_rosters_needs_no_detail_call():
    """The fact that decides whether a full history costs 5 requests or 500."""
    rows, _ = bga.parse_table_page(fixture("gamestats.json"))
    assert all(r.needs_detail is False for r in rows)
    promoted = bga.table_from_stub(rows[0])
    assert promoted is not None and promoted.table_id == 555000123


def test_a_page_without_rosters_asks_for_detail():
    body = json.dumps({"tables": [{"table_id": 1, "game_name": "Azul"}]})
    rows, _ = bga.parse_table_page(body)
    assert rows[0].needs_detail is True
    assert bga.table_from_stub(rows[0]) is None


def test_an_empty_page_reports_no_more():
    assert bga.parse_table_page('{"tables": []}') == ([], False)


def test_has_more_defaults_to_the_page_being_full():
    """Safe direction.

    An extra empty request costs one throttled round trip; a premature stop
    silently drops the rest of somebody's history.
    """
    body = json.dumps({"tables": [{"table_id": 9, "game_name": "Azul"}]})
    _, has_more = bga.parse_table_page(body)
    assert has_more is True


def test_a_row_with_no_table_id_is_skipped_not_fatal():
    body = json.dumps({"tables": [{"game_name": "Azul"}, {"table_id": 5, "game_name": "Azul"}]})
    rows, _ = bga.parse_table_page(body)
    assert [r.table_id for r in rows] == [5]


def test_garbage_parses_to_nothing_rather_than_raising():
    assert bga.parse_table_page("not json at all") == ([], False)
    assert bga.parse_table_page("") == ([], False)


# ── Table detail ─────────────────────────────────────────────────────────────


def test_table_info_parses():
    table = bga.parse_table_info(fixture("tableinfo.json"))
    assert table is not None
    assert table.table_id == 555000789
    assert table.ended_at == date(2026, 2, 28)
    assert table.game_name == "Wingspan"
    assert {s.handle for s in table.seats} == {"me_bga", "Tiggy_42"}
    winner = [s for s in table.seats if s.rank == 1]
    assert len(winner) == 1 and winner[0].handle == "Tiggy_42"


def test_table_info_falls_back_to_the_stub_for_what_it_lacks():
    stub = bga.BgaTableStub(
        table_id=42, game_name="Azul", bga_game_id="1032", ended_at=date(2026, 1, 1),
        seats=(bga.BgaSeat(handle="Tiggy_42", rank=1),),
    )
    table = bga.parse_table_info('{"data": {}}', fallback=stub)
    assert table is not None
    assert table.table_id == 42
    assert table.game_name == "Azul"
    assert table.ended_at == date(2026, 1, 1)


def test_a_table_with_nobody_at_it_is_dropped():
    """bgb_log_play answers this with {"error": "no_players"} anyway.

    Dropping it here means the user is never offered a play that cannot be
    written, rather than meeting the refusal in the import's failure count.
    """
    assert bga.parse_table_info('{"data": {"table_id": 7, "result": []}}') is None
    assert bga.parse_table_info("{}") is None


# ── Dry run ──────────────────────────────────────────────────────────────────


def test_dry_run_defaults_on(monkeypatch):
    """Nothing reaches boardgamearena.com until somebody says so on purpose."""
    monkeypatch.delenv("BGA_DRY_RUN", raising=False)
    assert bga.dry_run_enabled() is True


@pytest.mark.parametrize("value,expected", [
    ("false", False), ("0", False), ("no", False),
    ("true", True), ("anything", True),
])
def test_dry_run_flag_parsing(monkeypatch, value, expected):
    monkeypatch.setenv("BGA_DRY_RUN", value)
    assert bga.dry_run_enabled() is expected


def test_fixture_lookup_returns_none_when_unconfigured(monkeypatch):
    monkeypatch.delenv("BGA_FIXTURE_DIR", raising=False)
    assert bga.fixture("gamestats") is None


def test_fixture_lookup_reads_the_file(monkeypatch, tmp_path):
    (tmp_path / "gamestats.json").write_text('{"tables": []}', encoding="utf-8")
    monkeypatch.setenv("BGA_FIXTURE_DIR", str(tmp_path))
    assert bga.fixture("gamestats") == '{"tables": []}'
    assert bga.fixture("nope") is None
