"""Push obeys the tier, prunes dead devices, and can never break a mutation.

Three properties, and each one is a promise made somewhere the caller cannot
see. push_service.send is queued as a BackgroundTasks job by eight write paths,
none of which check anything about the result — so a tier that leaked, a dead
subscription that stayed, or an exception that escaped would all surface
somewhere far from here.

WHAT IS NOT MOCKED. The encryption and the VAPID signing are pywebpush's, and
they are exercised for real against a local HTTP server rather than stubbed:
the request that comes out carries a genuine aes128gcm body a browser could
decrypt, so a change that broke the key handling would fail these tests rather
than fail silently against a real push service. Only Supabase is faked.
"""

import base64
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import asyncio

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid

_vapid = Vapid()
_vapid.generate_keys()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


from routes.boardgame_buddy.constants import PushEvent, PushTier, push_tier_admits
from routes.boardgame_buddy.services import push_service as P

# The keys are written onto the MODULE, not into os.environ, and that is not a
# shortcut — it is the only thing that works. push_service reads the three env
# vars into module constants at import time (the same pattern BGB_QR_SECRET
# uses), and by the time this file is collected another test module has usually
# already imported routes.boardgame_buddy, which imports push_routes, which
# imports push_service. Setting os.environ here would then be writing to a
# value nothing reads again, and every delivery test would silently assert
# against a feature that had switched itself off — passing alone, failing in
# the suite, for reasons nowhere near the failure.
P.BGB_VAPID_PUBLIC_KEY = _b64(
    _vapid.public_key.public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
)
P.BGB_VAPID_PRIVATE_KEY = _b64(
    _vapid.private_key.private_numbers().private_value.to_bytes(32, "big")
)
P.BGB_VAPID_SUBJECT = "mailto:test@example.com"
# Whatever an earlier import may have parsed (or failed to), from here on the
# signing key is derived from the pair above.
P._vapid_instance = None


# ── A push service that answers however a test tells it to ───────────────────


class _Handler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 (BaseHTTPRequestHandler's name)
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        self.server.received.append({"path": self.path, "body": body,
                                     "headers": dict(self.headers)})
        self.send_response(self.server.status)
        self.end_headers()

    def log_message(self, *args):
        pass


class FakePushService:
    """A real HTTP endpoint, so pywebpush actually encrypts and signs."""

    def __init__(self, status=201):
        self.httpd = HTTPServer(("127.0.0.1", 0), _Handler)
        self.httpd.status = status
        self.httpd.received = []
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    @property
    def endpoint(self):
        return f"http://127.0.0.1:{self.httpd.server_address[1]}/push/x"

    @property
    def received(self):
        return self.httpd.received

    def answers(self, status):
        self.httpd.status = status

    def stop(self):
        self.httpd.shutdown()


def _subscription(endpoint):
    """A subscription with real P-256 keys, as a browser would hand over."""
    key = ec.generate_private_key(ec.SECP256R1())
    return key, {
        "id": "sub-1",
        "user_id": "u1",
        "endpoint": endpoint,
        "p256dh": _b64(
            key.public_key().public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
            )
        ),
        "auth": _b64(os.urandom(16)),
    }


class FakeSupabase:
    """Just enough PostgREST to serve the three reads and two writes."""

    def __init__(self, tiers=None, subs=None):
        self._tiers = tiers or {}
        self._subs = subs or []
        self.deleted = []
        self.failures = []
        self._table = None
        self._op = None
        self._eq = {}

    def table(self, name):
        self._table, self._op, self._eq = name, None, {}
        return self

    def select(self, *_):
        self._op = "select"
        return self

    def delete(self):
        self._op = "delete"
        return self

    def update(self, *_):
        self._op = "update"
        return self

    def eq(self, col, val):
        self._eq[col] = val
        return self

    def in_(self, col, vals):
        self._eq[col] = list(vals)
        return self

    def rpc(self, name, args):
        self._op, self._table = "rpc", name
        self._eq = args
        return self

    def execute(self):
        class R:
            def __init__(self, data):
                self.data = data

        if self._op == "rpc":
            self.failures.append(self._eq.get("p_id"))
            return R(None)
        if self._op == "delete":
            self.deleted.append(self._eq.get("id"))
            return R([])
        if self._op == "update":
            return R([])
        if self._table == "boardgamebuddy_profiles":
            wanted = self._eq.get("id", [])
            return R([{"id": u, "push_tier": self._tiers.get(u, "none")} for u in wanted])
        if self._table == "boardgamebuddy_push_subscriptions":
            wanted = self._eq.get("user_id", [])
            return R([s for s in self._subs if s["user_id"] in wanted])
        return R([])


# ── The tier ladder ──────────────────────────────────────────────────────────


def test_the_tier_ladder_is_cumulative_and_none_admits_nothing():
    actionable = [PushEvent.BUDDY_REQUEST, PushEvent.SESSION_INVITE,
                  PushEvent.PLAY_LINK, PushEvent.GHOST_CLAIM]
    informative = [PushEvent.BUDDY_ACCEPTED, PushEvent.ACHIEVEMENT]

    for event in actionable + informative:
        assert not push_tier_admits(PushTier.NONE, event)
        assert push_tier_admits(PushTier.ALL, event)
    for event in actionable:
        assert push_tier_admits(PushTier.ACTIONABLE, event)
    for event in informative:
        assert not push_tier_admits(PushTier.ACTIONABLE, event)


def test_an_unset_tier_reads_as_off():
    """A profile row written before migration 017 has no value at all.

    It must read as "off" rather than as anything else: push is opt-in, and a
    missing column silently meaning "yes" would notify every existing account
    the moment this shipped.
    """
    for missing in ("", None):
        assert not push_tier_admits(missing, PushEvent.BUDDY_REQUEST)


def test_willing_recipients_filters_by_each_persons_own_tier():
    sb = FakeSupabase(tiers={"a": "all", "b": "actionable", "c": "none"})
    assert P.willing_recipients(sb, ["a", "b", "c"], PushEvent.BUDDY_REQUEST) == ["a", "b"]
    assert P.willing_recipients(sb, ["a", "b", "c"], PushEvent.BUDDY_ACCEPTED) == ["a"]


# ── Delivery ─────────────────────────────────────────────────────────────────


def test_the_body_a_browser_receives_decrypts_to_what_was_sent():
    """The end-to-end property: encrypt here, decrypt as the subscription."""
    http_ece = pytest.importorskip("http_ece")
    svc = FakePushService()
    try:
        key, sub = _subscription(svc.endpoint)
        sb = FakeSupabase(tiers={"u1": "all"}, subs=[sub])
        payload = P.payload(
            event=PushEvent.BUDDY_ACCEPTED, title="You're buddies",
            body="Priya accepted your buddy request",
            url="/notifications", tag="buddy_accepted:priya",
        )
        asyncio.run(P.send(sb, ["u1"], PushEvent.BUDDY_ACCEPTED, payload, exclude="priya"))

        assert len(svc.received) == 1
        req = svc.received[0]
        assert req["headers"]["content-encoding"] == "aes128gcm"
        assert req["headers"]["authorization"].startswith("vapid ")

        plain = http_ece.decrypt(
            req["body"], private_key=key,
            auth_secret=base64.urlsafe_b64decode(sub["auth"] + "=="),
        )
        assert json.loads(plain) == payload
    finally:
        svc.stop()


def test_nothing_is_sent_to_the_actor_themselves():
    svc = FakePushService()
    try:
        _, sub = _subscription(svc.endpoint)
        sb = FakeSupabase(tiers={"u1": "all"}, subs=[sub])
        asyncio.run(P.send(sb, ["u1"], PushEvent.BUDDY_ACCEPTED,
                           P.payload(event=PushEvent.BUDDY_ACCEPTED, title="t", body="b",
                                     url="/", tag="x"),
                           exclude="u1"))
        assert svc.received == []
    finally:
        svc.stop()


def test_a_tier_that_refuses_the_event_sends_nothing():
    svc = FakePushService()
    try:
        _, sub = _subscription(svc.endpoint)
        sb = FakeSupabase(tiers={"u1": "actionable"}, subs=[sub])
        asyncio.run(P.send(sb, ["u1"], PushEvent.BUDDY_ACCEPTED,
                           P.payload(event=PushEvent.BUDDY_ACCEPTED, title="t", body="b",
                                     url="/", tag="x")))
        assert svc.received == []
        # ...and the same person still gets the actionable half.
        asyncio.run(P.send(sb, ["u1"], PushEvent.BUDDY_REQUEST,
                           P.payload(event=PushEvent.BUDDY_REQUEST, title="t", body="b",
                                     url="/", tag="x")))
        assert len(svc.received) == 1
    finally:
        svc.stop()


@pytest.mark.parametrize("status", [404, 410])
def test_a_gone_endpoint_is_deleted_rather_than_retried_forever(status):
    svc = FakePushService(status=status)
    try:
        _, sub = _subscription(svc.endpoint)
        sb = FakeSupabase(tiers={"u1": "all"}, subs=[sub])
        asyncio.run(P.send(sb, ["u1"], PushEvent.BUDDY_ACCEPTED,
                           P.payload(event=PushEvent.BUDDY_ACCEPTED, title="t", body="b",
                                     url="/", tag="x")))
        assert sb.deleted == ["sub-1"]
        assert sb.failures == []
    finally:
        svc.stop()


@pytest.mark.parametrize("status", [429, 500, 503])
def test_a_transient_failure_counts_but_keeps_the_device(status):
    """A phone off for a fortnight looks exactly like one never coming back.

    Guessing wrong means silently unsubscribing somebody who did nothing, so
    only a definitive 404/410 prunes.
    """
    svc = FakePushService(status=status)
    try:
        _, sub = _subscription(svc.endpoint)
        sb = FakeSupabase(tiers={"u1": "all"}, subs=[sub])
        asyncio.run(P.send(sb, ["u1"], PushEvent.BUDDY_ACCEPTED,
                           P.payload(event=PushEvent.BUDDY_ACCEPTED, title="t", body="b",
                                     url="/", tag="x")))
        assert sb.deleted == []
        assert sb.failures == ["sub-1"]
    finally:
        svc.stop()


def test_send_never_raises_whatever_happens():
    """The property every write path depends on without checking.

    A push failure must not be able to turn "your play was logged" into a 500 —
    the play IS logged by the time this runs.
    """
    _, sub = _subscription("http://127.0.0.1:1/dead")   # nothing listening
    sb = FakeSupabase(tiers={"u1": "all"}, subs=[sub])
    asyncio.run(P.send(sb, ["u1"], PushEvent.BUDDY_ACCEPTED,
                       P.payload(event=PushEvent.BUDDY_ACCEPTED, title="t", body="b",
                                 url="/", tag="x")))

    class Exploding(FakeSupabase):
        def execute(self):
            raise RuntimeError("supabase is down")

    asyncio.run(P.send(Exploding(), ["u1"], PushEvent.BUDDY_ACCEPTED,
                       P.payload(event=PushEvent.BUDDY_ACCEPTED, title="t", body="b",
                                 url="/", tag="x")))


def test_one_person_named_twice_is_notified_once():
    """A roster can name the same account twice — a ghost linked to someone
    already seated. Two buzzes for one event is what people switch this off
    over."""
    svc = FakePushService()
    try:
        _, sub = _subscription(svc.endpoint)
        sb = FakeSupabase(tiers={"u1": "all"}, subs=[sub])
        asyncio.run(P.send(sb, ["u1", "u1", "u1"], PushEvent.PLAY_LINK,
                           P.payload(event=PushEvent.PLAY_LINK, title="t", body="b",
                                     url="/", tag="x")))
        assert len(svc.received) == 1
    finally:
        svc.stop()


def test_the_whole_feature_is_inert_without_keys(monkeypatch):
    """Local dev, and the regression gate: with no VAPID keys nothing is read,
    nothing is sent, and no caller can tell the difference."""
    monkeypatch.setattr(P, "BGB_VAPID_PUBLIC_KEY", "")
    monkeypatch.setattr(P, "BGB_VAPID_PRIVATE_KEY", "")
    assert P.enabled() is False

    svc = FakePushService()
    try:
        _, sub = _subscription(svc.endpoint)
        sb = FakeSupabase(tiers={"u1": "all"}, subs=[sub])
        asyncio.run(P.send(sb, ["u1"], PushEvent.BUDDY_REQUEST,
                           P.payload(event=PushEvent.BUDDY_REQUEST, title="t", body="b",
                                     url="/", tag="x")))
        assert svc.received == []
        assert P.willing_recipients(sb, ["u1"], PushEvent.BUDDY_REQUEST) == []
    finally:
        svc.stop()


# ── A key that is present but wrong ──────────────────────────────────────────
#
# The failure this guards against was live: BGB_VAPID_PUBLIC_KEY held something
# that was not an uncompressed P-256 point, enabled() asked only whether the
# string was non-empty, GET /push/config said yes, and the first person to reach
# for the setting got `Failed to execute 'subscribe' on 'PushManager': The
# provided applicationServerKey is not valid` — a deploy-time mistake surfaced
# as a DOM exception in somebody else's browser. The server had everything it
# needed to know better.


def _bad_public_keys() -> dict[str, str]:
    """Every wrong shape that reaches the browser as the same useless error."""
    pub = _vapid.public_key
    return {
        # By far the likeliest: what public_bytes(DER, SubjectPublicKeyInfo)
        # and most "export the public key" snippets hand you. 122 chars.
        "spki_der": _b64(
            pub.public_bytes(
                serialization.Encoding.DER,
                serialization.PublicFormat.SubjectPublicKeyInfo,
            )
        ),
        # 44 chars — one longer than the PRIVATE key, so it looks plausible.
        "compressed_point": _b64(
            pub.public_bytes(
                serialization.Encoding.X962, serialization.PublicFormat.CompressedPoint
            )
        ),
        # The pair, pasted the wrong way round.
        "private_key_in_public_slot": P.BGB_VAPID_PRIVATE_KEY,
        "pem": pub.public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode(),
        "not_base64_at_all": "paste your key here",
    }


@pytest.mark.parametrize("shape", sorted(_bad_public_keys()))
def test_a_malformed_public_key_switches_the_feature_off(shape, monkeypatch):
    """Not "configured", because a key the browser will refuse is not a key."""
    monkeypatch.setattr(P, "BGB_VAPID_PUBLIC_KEY", _bad_public_keys()[shape])
    # Each shape has its own complaint; let every one of them be logged.
    monkeypatch.setattr(P, "_complained", set())
    assert P.enabled() is False
    # And the client is never offered the value — /push/config reads this.
    assert P.public_key() == ""


def test_a_malformed_public_key_sends_nothing(monkeypatch):
    """The same inert path as having no keys at all, which is the honest
    description of a key that cannot be used."""
    monkeypatch.setattr(P, "BGB_VAPID_PUBLIC_KEY", _bad_public_keys()["spki_der"])
    monkeypatch.setattr(P, "_complained", set())
    svc = FakePushService()
    try:
        _, sub = _subscription(svc.endpoint)
        sb = FakeSupabase(tiers={"u1": "all"}, subs=[sub])
        asyncio.run(P.send(sb, ["u1"], PushEvent.BUDDY_REQUEST,
                           P.payload(event=PushEvent.BUDDY_REQUEST, title="t", body="b",
                                     url="/", tag="x")))
        assert svc.received == []
        assert P.willing_recipients(sb, ["u1"], PushEvent.BUDDY_REQUEST) == []
    finally:
        svc.stop()


def test_an_unparseable_private_key_switches_the_feature_off(monkeypatch):
    """The other half, which enabled() never used to consult: _vapid() logged
    and returned None while /push/config went on advertising the feature, so
    the setting worked, the subscription was stored, and every send silently
    did nothing."""
    monkeypatch.setattr(P, "BGB_VAPID_PRIVATE_KEY", "not-a-key")
    monkeypatch.setattr(P, "_complained", set())
    monkeypatch.setattr(P, "_vapid_instance", None)   # forget the memoised good one
    assert P._vapid() is None
    assert P.enabled() is False


def test_padding_and_whitespace_do_not_make_a_good_key_bad(monkeypatch):
    """An env var picks up a trailing newline and a paste keeps its '=' padding.
    Neither is the key being wrong, and rejecting them would be a worse bug than
    the one this check exists for."""
    for variant in (
        P.BGB_VAPID_PUBLIC_KEY + "\n",
        P.BGB_VAPID_PUBLIC_KEY + "=",
        " " + P.BGB_VAPID_PUBLIC_KEY + " ",
        P.BGB_VAPID_PUBLIC_KEY.replace("-", "+").replace("_", "/"),
    ):
        monkeypatch.setattr(P, "BGB_VAPID_PUBLIC_KEY", variant)
        assert P.enabled() is True, variant


def test_a_real_pair_is_enabled():
    """The gate is not simply always-false: the keys this module generated —
    87 base64url characters and 43 — are accepted."""
    assert len(P.BGB_VAPID_PUBLIC_KEY) == 87
    assert P.BGB_VAPID_PUBLIC_KEY.startswith("B")   # 0x04 leads, so base64 'B'
    assert len(P.BGB_VAPID_PRIVATE_KEY) == 43
    assert P.enabled() is True
