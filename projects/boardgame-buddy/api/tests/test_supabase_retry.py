"""A Supabase round trip killed on the wire is retried — and only when it's safe.

Supabase's edge recycles pooled connections underneath postgrest-py's long-lived
HTTP/2 client. The request riding one of those connections dies with
`httpx.RemoteProtocolError` before a single response byte arrives, which used to
surface as a 500 on a perfectly healthy database — seven of them inside two
minutes of ordinary BoardgameBuddy browsing.

`db._RetryingTransport` repeats those. The half worth pinning is the half that
does NOT repeat: PostgREST sends every RPC as a POST (bgb_plays_page reads,
bgb_log_play writes), so "retry reads only" cannot be read off the method, and a
blanket retry would double-write plays.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import httpx
import pytest

import db

# The two renderings of a connection the peer shut down cleanly, verbatim from
# Railway's logs, and the one that says nothing about whether the request ran.
GOAWAY = httpx.RemoteProtocolError(
    "<ConnectionTerminated error_code:0, last_stream_id:3, additional_data:None>"
)
GOAWAY_ENUM = httpx.RemoteProtocolError(
    "<ConnectionTerminated error_code:ErrorCodes.NO_ERROR, last_stream_id:3>"
)
DISCONNECT = httpx.RemoteProtocolError("Server disconnected")
RESET = httpx.RemoteProtocolError(
    "<ConnectionTerminated error_code:2, last_stream_id:7, additional_data:None>"
)


class _Scripted:
    """Stand-in for the real socket: raises its script, then answers 200."""

    def __init__(self, *failures: Exception) -> None:
        self.failures = list(failures)
        self.calls: list[bytes] = []

    # Assigned onto the class as a plain object, so it is not a descriptor and
    # never gets a `self` transport bound in — the signature is (request,).
    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request.content)
        if self.failures:
            raise self.failures.pop(0)
        return httpx.Response(200, json={"ok": True})


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    """The backoff is real in production and pointless in a test."""
    monkeypatch.setattr(db.time, "sleep", lambda _s: None)


def _run(monkeypatch, script: _Scripted, method: str = "GET", **kwargs):
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", script)
    transport = db._RetryingTransport()
    request = httpx.Request(method, "https://example.supabase.co/rest/v1/t", **kwargs)
    return transport.handle_request(request)


def test_read_survives_a_recycled_connection(monkeypatch):
    script = _Scripted(GOAWAY)
    assert _run(monkeypatch, script).status_code == 200
    assert len(script.calls) == 2


def test_read_gives_up_after_three_attempts(monkeypatch):
    script = _Scripted(GOAWAY, DISCONNECT, GOAWAY)
    with pytest.raises(httpx.RemoteProtocolError):
        _run(monkeypatch, script)
    assert len(script.calls) == 3


def test_read_retries_a_mid_flight_disconnect(monkeypatch):
    """h11's flavour of the same failure — safe to repeat for a read."""
    script = _Scripted(DISCONNECT)
    assert _run(monkeypatch, script).status_code == 200
    assert len(script.calls) == 2


@pytest.mark.parametrize("goaway", [GOAWAY, GOAWAY_ENUM])
def test_write_retries_only_a_graceful_goaway(monkeypatch, goaway):
    """The peer refusing further streams means this one never ran."""
    script = _Scripted(goaway)
    res = _run(monkeypatch, script, method="POST", json={"a": 1})
    assert res.status_code == 200
    assert len(script.calls) == 2
    # The retry re-sent the body rather than an empty one.
    assert script.calls[0] == script.calls[1] == b'{"a":1}'


def test_write_gets_one_retry_not_two(monkeypatch):
    script = _Scripted(GOAWAY, GOAWAY)
    with pytest.raises(httpx.RemoteProtocolError):
        _run(monkeypatch, script, method="POST", json={"a": 1})
    assert len(script.calls) == 2


@pytest.mark.parametrize("failure", [DISCONNECT, RESET])
def test_write_is_never_repeated_on_an_ambiguous_failure(monkeypatch, failure):
    """It may already have landed — a repeat would double-write the play."""
    script = _Scripted(failure)
    with pytest.raises(httpx.RemoteProtocolError):
        _run(monkeypatch, script, method="POST", json={"a": 1})
    assert len(script.calls) == 1


def test_write_retries_when_the_connection_never_opened(monkeypatch):
    """Nothing was sent, so repeating it cannot duplicate anything."""
    script = _Scripted(httpx.ConnectError("connection refused"))
    res = _run(monkeypatch, script, method="POST", json={"a": 1})
    assert res.status_code == 200
    assert len(script.calls) == 2


@pytest.mark.parametrize(
    "failure",
    [httpx.ReadTimeout("too slow"), httpx.PoolTimeout("pool full")],
)
def test_a_slow_query_is_not_retried(monkeypatch, failure):
    """The query is genuinely slow; a second copy only deepens the hole."""
    script = _Scripted(failure)
    with pytest.raises(httpx.TimeoutException):
        _run(monkeypatch, script)
    assert len(script.calls) == 1


def test_installed_session_keeps_postgrest_addressable(monkeypatch):
    """The swap must not change where or how postgrest sends its requests."""
    stock = httpx.Client(
        base_url="https://example.supabase.co/rest/v1/",
        headers={"apikey": "k", "Authorization": "Bearer k"},
    )
    session = db._retrying_session(stock)
    assert str(session.base_url) == "https://example.supabase.co/rest/v1/"
    assert session.headers["apikey"] == "k"
    assert session.headers["Authorization"] == "Bearer k"
    assert isinstance(session._transport, db._RetryingTransport)
    stock.close()
    session.close()


def test_postgrest_goes_through_the_retrying_session(monkeypatch):
    """End to end: a swapped-in session still speaks PostgREST correctly.

    The swap replaces a library-owned object, so the risk it carries is not the
    retry logic but the plumbing around it — a lost apikey header or a request
    sent to the wrong URL would break every app in the monorepo at once. One
    real `create_client` → `.table().select().execute()` round trip pins both,
    with the first attempt killed by a recycled connection for good measure.
    """
    seen: list[httpx.Request] = []

    # A plain function assigned onto the class IS a descriptor, so it is bound
    # and does receive the transport — unlike the `_Scripted` instance above.
    def handle(_transport, request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if len(seen) == 1:
            raise GOAWAY
        return httpx.Response(
            200, json=[{"id": 1}], headers={"content-type": "application/json"}
        )

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", handle)
    client = db.create_client("https://example.supabase.co", "service-key")
    db._install_retrying_session(client)
    assert isinstance(client.postgrest.session._transport, db._RetryingTransport)

    res = client.table("boardgamebuddy_plays").select("id").limit(1).execute()

    assert res.data == [{"id": 1}]
    assert len(seen) == 2
    for request in seen:
        assert str(request.url).startswith(
            "https://example.supabase.co/rest/v1/boardgamebuddy_plays"
        )
        assert request.headers["apikey"] == "service-key"
        assert request.headers["Authorization"] == "Bearer service-key"
