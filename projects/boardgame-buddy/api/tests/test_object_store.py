"""Image uploads go to R2 when it is configured, Supabase Storage when it is not.

The fallback is the whole point of the design and it is the half worth pinning:
it lets the R2 code deploy before the buckets exist and lets one unset variable
roll it back afterwards. What must NOT happen is the fallback catching a
configured-but-failing R2 — that would write a supabase.co URL into a play
after the migration has rewritten every other row, quietly splitting the data
across two origins. So a configured R2 that fails is a 502 on the play path and
the original BGG URL on the cover path, never a silent second attempt.

Also pinned: the public URL is built from the env-driven base rather than from
the S3 endpoint (the S3 endpoint is not publicly readable), and the object key
is byte-identical to the Supabase layout, which is what makes
036_r2_photo_urls.sql a prefix substitution instead of a re-key.
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest
from fastapi import HTTPException

import object_store
from routes import game_routes as G
from routes import play_routes as P

R2_ENV = {
    "R2_ACCOUNT_ID": "acct123",
    "R2_ACCESS_KEY_ID": "key",
    "R2_SECRET_ACCESS_KEY": "secret",
    "R2_PLAYS_BUCKET": "bgb-plays",
    "R2_GAMES_BUCKET": "bgb-games",
    "R2_PLAYS_PUBLIC_BASE": "https://img.bgbuddy.app",
    "R2_GAMES_PUBLIC_BASE": "https://covers.bgbuddy.app",
}


@pytest.fixture
def unconfigured(monkeypatch):
    for name in R2_ENV:
        monkeypatch.delenv(name, raising=False)
    object_store.reload()
    yield
    object_store.reload()


@pytest.fixture
def configured(monkeypatch):
    for name, value in R2_ENV.items():
        monkeypatch.setenv(name, value)
    object_store.reload()
    yield
    object_store.reload()


class _FakeS3:
    """Stand-in for the boto3 client: records the call, or raises."""

    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[dict] = []

    def put_object(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return {"ETag": '"deadbeef"'}


@pytest.fixture
def fake_s3(monkeypatch):
    """Replace the client factory so no test ever opens a socket."""

    def install(error: Exception | None = None) -> _FakeS3:
        client = _FakeS3(error)
        monkeypatch.setattr(object_store, "_s3", lambda: client)
        return client

    return install


# ── object_store itself ──────────────────────────────────────────────────────

def test_unconfigured_is_a_state_not_an_error(unconfigured):
    assert object_store.configured() is False
    assert object_store.configured(object_store.PLAYS) is False


def test_configured_when_every_variable_is_present(configured):
    assert object_store.configured() is True
    assert object_store.configured(object_store.PLAYS) is True
    assert object_store.configured(object_store.GAMES) is True


@pytest.mark.parametrize("missing", sorted(R2_ENV))
def test_one_missing_variable_is_unconfigured(monkeypatch, missing):
    """Including the public base.

    Credentials without a base would upload happily and then store a URL
    nobody can load — the bytes in the right place and the row pointing
    nowhere, which is worse than not having uploaded at all.
    """
    for name, value in R2_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv(missing)
    object_store.reload()
    try:
        kind = object_store.GAMES if "GAMES" in missing else object_store.PLAYS
        assert object_store.configured(kind) is False
        assert object_store.configured() is False
    finally:
        object_store.reload()


# ── The jurisdiction in the endpoint host ────────────────────────────────────
# A bucket created in a jurisdiction is not reachable on the account's default
# S3 host, and R2 reports that as AccessDenied on a bucket the dashboard shows
# and the token is scoped to. These pin the host so the next person debugging
# that has the answer in a test rather than in an evening.


def test_endpoint_has_no_jurisdiction_segment_by_default(configured):
    assert object_store._cfg.endpoint() == "https://acct123.r2.cloudflarestorage.com"


def test_endpoint_carries_the_jurisdiction_when_set(monkeypatch):
    for name, value in R2_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("R2_JURISDICTION", "us")
    object_store.reload()
    try:
        assert object_store._cfg.endpoint() == "https://acct123.us.r2.cloudflarestorage.com"
        assert object_store.configured() is True
    finally:
        object_store.reload()


def test_jurisdiction_is_case_and_space_insensitive(monkeypatch):
    """Operators paste what the dashboard shows, which is 'US'."""
    for name, value in R2_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("R2_JURISDICTION", "  US  ")
    object_store.reload()
    try:
        assert object_store._cfg.endpoint() == "https://acct123.us.r2.cloudflarestorage.com"
    finally:
        object_store.reload()


@pytest.mark.parametrize(
    "bad", ["us/../evil", "us.evil.com", "-us", "us-", "e vil", "us_1", "a" * 64]
)
def test_a_jurisdiction_that_is_not_a_hostname_label_disables_r2(monkeypatch, bad):
    """It is interpolated into a host, so garbage fails closed, not open.

    Reporting the store unconfigured sends uploads back to Supabase Storage —
    the designed fallback — rather than signing for a host nobody chose.
    """
    for name, value in R2_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("R2_JURISDICTION", bad)
    object_store.reload()
    try:
        assert object_store.configured() is False
        assert object_store.configured(object_store.PLAYS) is False
        assert object_store._cfg.endpoint() == "https://acct123.r2.cloudflarestorage.com"
    finally:
        object_store.reload()


def test_put_failure_names_the_bucket_and_jurisdiction(monkeypatch):
    """An AccessDenied with no context is three different bugs at once."""
    for name, value in R2_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("R2_JURISDICTION", "us")
    object_store.reload()

    class _Boom:
        def put_object(self, **kwargs):
            raise RuntimeError("Access Denied")

    monkeypatch.setattr(object_store, "_s3", lambda: _Boom())
    try:
        with pytest.raises(object_store.ObjectStoreError) as err:
            object_store.put(object_store.PLAYS, "uid-1/x.jpg", b"x", "image/jpeg")
        message = str(err.value)
        assert "bucket=bgb-plays" in message
        assert "jurisdiction=us" in message
    finally:
        object_store.reload()


def test_put_failure_says_default_when_no_jurisdiction_is_set(configured, monkeypatch):
    """`(default)` is the reading that means "the env var is missing"."""

    class _Boom:
        def put_object(self, **kwargs):
            raise RuntimeError("Access Denied")

    monkeypatch.setattr(object_store, "_s3", lambda: _Boom())
    with pytest.raises(object_store.ObjectStoreError) as err:
        object_store.put(object_store.GAMES, "13_cover.jpg", b"x", "image/jpeg")
    assert "jurisdiction=(default)" in str(err.value)
    assert "bucket=bgb-games" in str(err.value)


def test_public_url_is_the_base_plus_the_key(configured):
    assert (
        object_store.public_url(object_store.PLAYS, "uid-1/deadbeef.jpg")
        == "https://img.bgbuddy.app/uid-1/deadbeef.jpg"
    )
    assert (
        object_store.public_url(object_store.GAMES, "13_cover.png")
        == "https://covers.bgbuddy.app/13_cover.png"
    )


def test_public_url_never_doubles_or_drops_the_separator(monkeypatch):
    """A base pasted with a trailing slash is the likeliest operator typo."""
    for name, value in R2_ENV.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("R2_PLAYS_PUBLIC_BASE", "https://img.bgbuddy.app/")
    object_store.reload()
    try:
        assert (
            object_store.public_url(object_store.PLAYS, "/uid-1/a.jpg")
            == "https://img.bgbuddy.app/uid-1/a.jpg"
        )
    finally:
        object_store.reload()


def test_put_sends_the_key_unchanged(configured, fake_s3):
    client = fake_s3()
    url = object_store.put(
        object_store.PLAYS,
        "uid-1/deadbeef.jpg",
        b"bytes",
        "image/jpeg",
        cache_control="public, max-age=31536000, immutable",
    )
    assert url == "https://img.bgbuddy.app/uid-1/deadbeef.jpg"
    (call,) = client.calls
    assert call["Bucket"] == "bgb-plays"
    # The migration's prefix substitution depends on this being the same key
    # Supabase held. No prefix, no rename, no bucket name in the path.
    assert call["Key"] == "uid-1/deadbeef.jpg"
    assert call["ContentType"] == "image/jpeg"
    assert call["CacheControl"] == "public, max-age=31536000, immutable"
    # R2 has no per-object ACLs; passing one is an error rather than a no-op.
    assert "ACL" not in call


def test_put_omits_cache_control_when_none_is_given(configured, fake_s3):
    client = fake_s3()
    object_store.put(object_store.GAMES, "13_cover.png", b"x", "image/png")
    assert "CacheControl" not in client.calls[0]


def test_put_without_configuration_raises_rather_than_guessing(unconfigured):
    with pytest.raises(object_store.NotConfigured):
        object_store.put(object_store.PLAYS, "a/b.jpg", b"x", "image/jpeg")


def test_a_boto_failure_surfaces_as_objectstoreerror(configured, fake_s3):
    fake_s3(error=RuntimeError("SignatureDoesNotMatch"))
    with pytest.raises(object_store.ObjectStoreError) as caught:
        object_store.put(object_store.PLAYS, "a/b.jpg", b"x", "image/jpeg")
    assert "SignatureDoesNotMatch" in str(caught.value)


# ── the play-photo call site ─────────────────────────────────────────────────

class _Bucket:
    def __init__(self, name, log):
        self.name, self.log = name, log

    def upload(self, path, data, opts):
        self.log.append(("upload", self.name, path, opts))

    def get_public_url(self, path):
        return f"https://example.supabase.co/storage/v1/object/public/{self.name}/{path}"


class _Storage:
    def __init__(self):
        self.log = []

    def from_(self, name):
        return _Bucket(name, self.log)


class _FakeSupabase:
    def __init__(self):
        self.storage = _Storage()


def test_play_photo_goes_to_r2_when_configured(configured, fake_s3):
    client = fake_s3()
    sb = _FakeSupabase()
    res = P._upload_play_photo_sync(sb, "uid-1/deadbeef.jpg", b"img", "image/jpeg")
    assert res.photo_url == "https://img.bgbuddy.app/uid-1/deadbeef.jpg"
    assert client.calls, "nothing reached R2"
    assert sb.storage.log == [], "Supabase Storage was written to as well"


def test_play_photo_falls_back_to_supabase_when_r2_is_absent(unconfigured):
    sb = _FakeSupabase()
    res = P._upload_play_photo_sync(sb, "uid-1/deadbeef.jpg", b"img", "image/jpeg")
    assert res.photo_url == (
        "https://example.supabase.co/storage/v1/object/public/"
        "boardgamebuddy-plays/uid-1/deadbeef.jpg"
    )
    assert sb.storage.log[0][0] == "upload"


def test_a_failing_r2_is_a_502_not_a_supabase_write(configured, fake_s3):
    """The fallback is for an UNCONFIGURED R2, never a broken one.

    Falling back here would write a supabase.co URL into a play after the
    migration rewrote every other row — new data quietly landing on the origin
    the whole stage exists to leave.
    """
    fake_s3(error=RuntimeError("503 Slow Down"))
    sb = _FakeSupabase()
    with pytest.raises(HTTPException) as caught:
        P._upload_play_photo_sync(sb, "uid-1/deadbeef.jpg", b"img", "image/jpeg")
    assert caught.value.status_code == 502
    assert sb.storage.log == []


# ── the cover-art call site ──────────────────────────────────────────────────

class _Resp:
    def __init__(self, content=b"jpegbytes", content_type="image/jpeg"):
        self.content = content
        self.headers = {"content-type": content_type}

    def raise_for_status(self):
        return None


class _FakeAsyncClient:
    """Enough of httpx.AsyncClient for `_upload_to_storage`'s download half."""

    resp = _Resp()

    def __init__(self, *_a, **_k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    async def get(self, _url):
        return self.resp


@pytest.fixture
def fake_download(monkeypatch):
    monkeypatch.setattr(G.httpx, "AsyncClient", _FakeAsyncClient)


def test_cover_goes_to_r2_when_configured(configured, fake_s3, fake_download):
    client = fake_s3()
    sb = _FakeSupabase()
    url = asyncio.run(
        G._upload_to_storage(sb, 13, "https://cf.geekdo-images.com/x.jpg", "cover")
    )
    assert url == "https://covers.bgbuddy.app/13_cover.jpg"
    assert client.calls[0]["Key"] == "13_cover.jpg"
    # A cover path is reused on re-import, so it must NOT carry the photos'
    # immutable year.
    assert client.calls[0]["CacheControl"] == "public, max-age=86400"
    assert sb.storage.log == []


def test_cover_falls_back_to_supabase_when_r2_is_absent(unconfigured, fake_download):
    sb = _FakeSupabase()
    url = asyncio.run(
        G._upload_to_storage(sb, 13, "https://cf.geekdo-images.com/x.jpg", "cover")
    )
    assert url == (
        "https://example.supabase.co/storage/v1/object/public/"
        "boardgamebuddy-games/13_cover.jpg"
    )


def test_a_failing_r2_cover_keeps_the_bgg_url(configured, fake_s3, fake_download):
    """Unchanged from the Supabase behaviour: an import never fails over art."""
    fake_s3(error=RuntimeError("AccessDenied"))
    bgg = "https://cf.geekdo-images.com/x.jpg"
    url = asyncio.run(G._upload_to_storage(_FakeSupabase(), 13, bgg, "cover"))
    assert url == bgg
