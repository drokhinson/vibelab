"""Deleting an account deletes the credential, not just the rows.

THE BUG THESE PIN. `DELETE /profile` used to drop the
`boardgamebuddy_profiles` row and stop. The Identity Platform account stayed,
so signing back in with Google handed back the same uid and `get_current_user`
auto-created a fresh profile — an emptied account wearing the deleted one's
identity — and signing up again with the same address and a password answered
`auth/email-already-in-use`. Both outcomes tell the user the deletion did not
take, and both were right.

Migration 049 then added a third failure to the list, in the other direction:
deleting an account CASCADEd `plays.user_id`, so deleting the person who
LOGGED a game night deleted the night and every other account's seat on it.
Such a play is handed over now. **The handover itself is SQL and is not
exercised here** — these tests drive the service with a fake PostgREST and
there is no Postgres in this suite — so what they pin at this layer is that
the service calls `bgb_delete_account_rows` and never a direct table delete,
which is what keeps the handover and the profile delete in one transaction.
`db/tests/049_account_deletion_handover.sql` is the behavioural half.

Four properties carry the fix, and each one is a way it could silently regress:

  1. **The provider uid is not the app uid.** `jwt_auth` rewrites `sub` to the
     `app_uid` claim, and `accounts:delete` answers `USER_NOT_FOUND` — which
     this code treats as success — for a uid that never existed. Delete with
     the wrong field and every deletion reports success while every credential
     survives. That is the original bug with a passing test over it, so
     `test_the_credential_is_deleted_by_the_provider_uid` is the load-bearing
     one in this file.
  2. **Unconfigured refuses instead of half-deleting.** No service account
     means no way to delete the credential, and the only alternative is the
     old behaviour. Nothing may be destroyed in that case.
  3. **The order survives.** Photos, then rows, then credential — so a failure
     anywhere leaves a signed-in caller holding a token and a retry that works.
  4. **A prefix delete cannot reach a sibling.** `delete_prefix` is the one
     call here that can destroy another account's data, and the trailing slash
     is all that stops `uid` from matching `uid2/photo.jpg`.
"""

import asyncio
import base64
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

import pytest

import identity_admin
import object_store
from routes.services import account_deletion_service as S

APP_UID = "076e625a-5250-58bd-ab52-c7df3a062914"
PROVIDER_UID = "kJ8fHs2mNpQr4TvW6XyZaBcDeFg"

R2_ENV = {
    "R2_ACCOUNT_ID": "acct123",
    "R2_ACCESS_KEY_ID": "key",
    "R2_SECRET_ACCESS_KEY": "secret",
    "R2_PLAYS_BUCKET": "bgb-plays",
    "R2_GAMES_BUCKET": "bgb-games",
    "R2_PLAYS_PUBLIC_BASE": "https://img.bgbuddy.app",
    "R2_GAMES_PUBLIC_BASE": "https://covers.bgbuddy.app",
}


# ── Fakes ────────────────────────────────────────────────────────────────────

class _FakeS3:
    """Just enough S3 for `delete_prefix`: a keyed store, paged in twos.

    Pages deliberately small so the batching path is exercised by a handful of
    keys rather than needing a thousand.
    """

    PAGE = 2

    def __init__(self, keys, delete_errors=None, page_size=None):
        self.keys = list(keys)
        self.deleted = []
        self.delete_errors = delete_errors or []
        self.listed_prefixes = []
        self.page_size = page_size or self.PAGE

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        return self

    def paginate(self, Bucket=None, Prefix=None):
        self.listed_prefixes.append(Prefix)
        matched = [k for k in self.keys if k.startswith(Prefix or "")]
        for i in range(0, len(matched), self.page_size):
            yield {"Contents": [{"Key": k, "Size": 1} for k in matched[i:i + self.page_size]]}

    def delete_objects(self, Bucket=None, Delete=None):
        objs = Delete["Objects"]
        if self.delete_errors:
            return {"Errors": self.delete_errors}
        for o in objs:
            self.deleted.append(o["Key"])
            if o["Key"] in self.keys:
                self.keys.remove(o["Key"])
        return {}


class _FakeBucket:
    """supabase-py's storage bucket handle, for the retired Supabase origin."""

    def __init__(self, entries, list_exc=None, remove_exc=None):
        self.entries = entries
        self.list_exc = list_exc
        self.remove_exc = remove_exc
        self.removed = None
        self.listed_path = None

    def list(self, path=None):
        self.listed_path = path
        if self.list_exc:
            raise self.list_exc
        return self.entries

    def remove(self, names):
        if self.remove_exc:
            raise self.remove_exc
        self.removed = names


class _FakeStorage:
    def __init__(self, bucket):
        self.bucket = bucket
        self.asked_for = None

    def from_(self, name):
        self.asked_for = name
        return self.bucket


class _FakeRpc:
    """The one RPC this service calls, recording the name and args it got."""

    def __init__(self, log, name, params, fail=False, data=None):
        self.log, self.name, self.params = log, name, params
        self.fail = fail
        self.data = data if data is not None else {
            "plays_reassigned": 2, "plays_deleted": 1,
            "photos_unlinked": 1, "names_backfilled": 0,
        }

    def execute(self):
        if self.fail:
            raise RuntimeError("postgrest exploded")
        self.log.append(("rows-delete", self.name, self.params))
        return type("R", (), {"data": self.data})()


class _FakeSupabase:
    def __init__(self, log, bucket, rpc_fails=False, rpc_data=None):
        self.log = log
        self.storage = _FakeStorage(bucket)
        self._rpc_fails = rpc_fails
        self._rpc_data = rpc_data
        self.rpcs = []

    def rpc(self, name, params):
        self.rpcs.append((name, params))
        return _FakeRpc(
            self.log, name, params, fail=self._rpc_fails, data=self._rpc_data
        )

    def table(self, name):  # pragma: no cover - a regression guard, see below
        raise AssertionError(
            "account deletion must go through bgb_delete_account_rows, not a "
            f"direct table write ({name}). The handover and the profile delete "
            "have to be one transaction — see migration 049."
        )


@pytest.fixture
def wired(monkeypatch):
    """A configured world with every destructive step recorded in one list.

    The single ordered `log` is the point: the ordering assertions below read
    it directly rather than inferring sequence from separate spies.
    """
    log = []
    bucket = _FakeBucket([{"name": "a.jpg", "id": "1"}, {"name": "b.jpg", "id": "2"}])
    sb = _FakeSupabase(log, bucket)

    monkeypatch.setattr(S, "get_supabase", lambda: sb)
    monkeypatch.setattr(identity_admin, "configured", lambda: True)
    monkeypatch.setattr(S.identity_admin, "configured", lambda: True)

    def fake_r2(kind, prefix):
        log.append(("r2-delete", kind, prefix))
        return 3

    monkeypatch.setattr(object_store, "configured", lambda kind=None: True)
    monkeypatch.setattr(object_store, "delete_prefix", fake_r2)

    deleted_uids = []

    async def fake_delete_user(uid):
        log.append(("credential-delete", uid))
        deleted_uids.append(uid)

    monkeypatch.setattr(S.identity_admin, "delete_user", fake_delete_user)

    # The real `remove` records on the fake bucket; mirror it into the log so
    # ordering is visible in one place.
    original_remove = bucket.remove

    def remove(names):
        log.append(("supabase-delete", tuple(names)))
        return original_remove(names)

    bucket.remove = remove
    return type("W", (), {
        "log": log, "sb": sb, "bucket": bucket, "deleted_uids": deleted_uids,
    })()


def _run(app_uid=APP_UID, provider_uid=PROVIDER_UID):
    return asyncio.run(S.delete_account(app_uid=app_uid, provider_uid=provider_uid))


# ── 1. The credential, and the id it is deleted by ───────────────────────────

def test_the_credential_is_deleted_by_the_provider_uid(wired):
    """THE regression test. `sub` is the app_uid after `jwt_auth` rewrites it;
    the provider only knows the raw token sub. Handing the provider the app
    uid of a post-migration account addresses nothing, and `accounts:delete`
    answers USER_NOT_FOUND, which `delete_user` reports as success — so the
    wrong field here is invisible everywhere except this assertion."""
    _run()
    assert wired.deleted_uids == [PROVIDER_UID]
    assert APP_UID not in wired.deleted_uids


def test_the_rows_are_deleted_by_the_app_uid(wired):
    """The mirror image: the schema is keyed on the UUID, not the Firebase uid.
    Swapping the two arguments must not quietly work."""
    _run()
    assert ("rows-delete", "bgb_delete_account_rows", {"p_user": APP_UID}) in wired.log
    assert wired.sb.rpcs == [("bgb_delete_account_rows", {"p_user": APP_UID})]


def test_the_rows_go_through_the_handover_rpc_not_a_direct_delete(wired):
    """The profile delete lives INSIDE bgb_delete_account_rows so the handover
    and the delete are one transaction. A direct `.table(...).delete()` here
    would reassign plays to other people and then be able to fail before the
    account is gone. The fake asserts on `.table` being touched at all."""
    _run()
    assert [name for name, _ in wired.sb.rpcs] == ["bgb_delete_account_rows"]


def test_the_rpc_counts_are_reported_back(wired):
    """The route logs them and the caller returns them, so a handover that
    silently moved nothing is visible in the log rather than only in the DB."""
    result = _run()
    assert result["plays_reassigned"] == 2
    assert result["plays_deleted"] == 1


# ── 2. Unconfigured refuses rather than half-deleting ────────────────────────

def test_unconfigured_identity_admin_deletes_nothing(wired, monkeypatch):
    """Without a service account the credential cannot go, and rows-only is
    exactly the bug. So this refuses BEFORE touching anything — the assertion
    that matters is the empty log, not the exception."""
    monkeypatch.setattr(S.identity_admin, "configured", lambda: False)
    monkeypatch.setattr(S.identity_admin, "config_error", lambda: "not set")
    with pytest.raises(S.DeletionBlocked):
        _run()
    assert wired.log == []


def test_identity_admin_is_unconfigured_without_the_secret(monkeypatch):
    monkeypatch.delenv("GCP_SERVICE_ACCOUNT_JSON", raising=False)
    identity_admin.reload()
    try:
        assert identity_admin.configured() is False
        assert "GCP_SERVICE_ACCOUNT_JSON" in identity_admin.config_error()
    finally:
        identity_admin.reload()


# ── 3. Order, and what each failure leaves behind ────────────────────────────

def test_photos_go_before_rows_and_the_credential_goes_last(wired):
    """Photos first so a flaky object store costs a retry rather than the
    photos; the credential last so any failure leaves a valid token in the
    caller's hands and a retry that finishes the job."""
    _run()
    kinds = [entry[0] for entry in wired.log]
    assert kinds.index("r2-delete") < kinds.index("rows-delete")
    assert kinds.index("supabase-delete") < kinds.index("rows-delete")
    assert kinds[-1] == "credential-delete"


def test_a_photo_failure_aborts_before_any_row_is_touched(wired, monkeypatch):
    def boom(kind, prefix):
        raise object_store.ObjectStoreError("R2 said no")

    monkeypatch.setattr(object_store, "delete_prefix", boom)
    with pytest.raises(S.DeletionFailed):
        _run()
    assert [e[0] for e in wired.log] == []


def test_a_credential_failure_still_reports_failure_after_the_rows_went(wired, monkeypatch):
    """The one path back to the original broken state. It must not be reported
    as success: the rows are gone and the login is not, and only an error
    keeps the client signed in so the user can retry into it."""
    async def boom(uid):
        raise identity_admin.IdentityAdminError("identitytoolkit said no")

    monkeypatch.setattr(S.identity_admin, "delete_user", boom)
    with pytest.raises(S.DeletionFailed):
        _run()
    assert ("rows-delete", "bgb_delete_account_rows", {"p_user": APP_UID}) in wired.log


def test_a_row_failure_never_reaches_the_credential(wired, monkeypatch):
    """Deleting the login while the rows survive would strand them behind an
    account nobody can sign into and no token can retry."""
    monkeypatch.setattr(S, "get_supabase", lambda: _FakeSupabase(
        wired.log, wired.bucket, rpc_fails=True
    ))
    with pytest.raises(S.DeletionFailed):
        _run()
    assert wired.deleted_uids == []


# ── 4. The two photo stores ──────────────────────────────────────────────────

def test_both_photo_stores_are_purged(wired):
    """After the R2 cutover a pre-migration photo exists in BOTH places —
    `036` rewrote URLs and the runbook says in bold not to delete the Supabase
    buckets. Clearing only R2 leaves a public copy on supabase.co."""
    result = _run()
    assert ("r2-delete", object_store.PLAYS, f"{APP_UID}/") in wired.log
    assert ("supabase-delete", (f"{APP_UID}/a.jpg", f"{APP_UID}/b.jpg")) in wired.log
    assert result["r2_photos"] == 3
    assert result["supabase_photos"] == 2


def test_the_supabase_bucket_name_matches_the_upload_path():
    """The constant is duplicated to avoid a routes -> routes import; if the
    two drift, deletion silently purges a bucket nothing writes to."""
    from routes import play_routes

    assert S.SUPABASE_PLAYS_BUCKET == play_routes.PLAYS_BUCKET


def test_a_missing_supabase_bucket_is_not_a_failure(monkeypatch):
    """Environments stood up after the cutover never created it, and an empty
    bucket that does not exist is nothing to delete."""
    bucket = _FakeBucket([], list_exc=RuntimeError("Bucket not found"))
    monkeypatch.setattr(S, "get_supabase", lambda: _FakeSupabase([], bucket))
    assert S._purge_supabase_photos_sync(APP_UID) == 0


def test_a_denied_supabase_bucket_is_a_failure(monkeypatch):
    """The narrowness of the tolerated case is the point: `AccessDenied` can
    hide objects that survived, so it must not pass for "nothing there"."""
    bucket = _FakeBucket([], list_exc=RuntimeError("AccessDenied"))
    monkeypatch.setattr(S, "get_supabase", lambda: _FakeSupabase([], bucket))
    with pytest.raises(S.DeletionFailed):
        S._purge_supabase_photos_sync(APP_UID)


def test_the_empty_folder_placeholder_is_not_sent_to_remove(monkeypatch):
    """Supabase Storage lists a row with a null id for an empty folder, and
    `remove` answers 400 for it."""
    bucket = _FakeBucket([
        {"name": ".emptyFolderPlaceholder", "id": None},
        {"name": "real.jpg", "id": "1"},
    ])
    monkeypatch.setattr(S, "get_supabase", lambda: _FakeSupabase([], bucket))
    assert S._purge_supabase_photos_sync(APP_UID) == 1
    assert bucket.removed == [f"{APP_UID}/real.jpg"]


def test_an_unconfigured_r2_is_nothing_to_do(monkeypatch):
    """Exclusive on the write path: with R2 absent `play_routes` uploaded to
    Supabase Storage, which the other purge covers."""
    monkeypatch.setattr(object_store, "configured", lambda kind=None: False)
    assert S._purge_r2_photos_sync(APP_UID) == 0


# ── 5. delete_prefix cannot reach a sibling ──────────────────────────────────

@pytest.fixture
def r2(monkeypatch):
    for k, v in R2_ENV.items():
        monkeypatch.setenv(k, v)
    object_store.reload()
    yield
    object_store.reload()


def test_delete_prefix_leaves_a_sibling_uid_alone(r2, monkeypatch):
    """S3 prefix matching is a STRING prefix. Without the trailing slash `u1`
    also matches `u10/`, so one account's deletion would take another's
    photos with it."""
    s3 = _FakeS3([f"{APP_UID}/a.jpg", f"{APP_UID}2/keep.jpg", "other/keep.jpg"])
    monkeypatch.setattr(object_store, "_s3", lambda: s3)
    n = object_store.delete_prefix(object_store.PLAYS, f"{APP_UID}/")
    assert n == 1
    assert s3.deleted == [f"{APP_UID}/a.jpg"]
    assert f"{APP_UID}2/keep.jpg" in s3.keys


@pytest.mark.parametrize("bad", ["", "/", APP_UID, f"/{APP_UID}"])
def test_delete_prefix_refuses_a_prefix_without_a_trailing_slash(r2, monkeypatch, bad):
    s3 = _FakeS3(["anything/x.jpg"])
    monkeypatch.setattr(object_store, "_s3", lambda: s3)
    with pytest.raises(object_store.ObjectStoreError):
        object_store.delete_prefix(object_store.PLAYS, bad)
    assert s3.deleted == []


def test_delete_prefix_walks_every_page(r2, monkeypatch):
    keys = [f"{APP_UID}/{i}.jpg" for i in range(7)]
    s3 = _FakeS3(list(keys))
    monkeypatch.setattr(object_store, "_s3", lambda: s3)
    assert object_store.delete_prefix(object_store.PLAYS, f"{APP_UID}/") == 7
    assert sorted(s3.deleted) == sorted(keys)


def test_delete_prefix_raises_when_keys_would_not_delete(r2, monkeypatch):
    """DeleteObjects reports per-key failures inside an HTTP 200. Not reading
    `Errors` is how a partial delete gets counted as a whole one."""
    s3 = _FakeS3(
        [f"{APP_UID}/a.jpg"],
        delete_errors=[{"Key": f"{APP_UID}/a.jpg", "Code": "AccessDenied", "Message": "no"}],
    )
    monkeypatch.setattr(object_store, "_s3", lambda: s3)
    with pytest.raises(object_store.ObjectStoreError) as exc:
        object_store.delete_prefix(object_store.PLAYS, f"{APP_UID}/")
    assert "AccessDenied" in str(exc.value)


def test_delete_prefix_on_an_unconfigured_store_is_an_error_not_a_no_op(monkeypatch):
    """The opposite of `put()`'s stance, because here "not configured" means
    the objects may still be there."""
    for name in R2_ENV:
        monkeypatch.delenv(name, raising=False)
    object_store.reload()
    try:
        with pytest.raises(object_store.NotConfigured):
            object_store.delete_prefix(object_store.PLAYS, f"{APP_UID}/")
    finally:
        object_store.reload()


# ── 6. identity_admin's own contract ─────────────────────────────────────────

def _sa_key():
    """A throwaway RSA service-account key, generated per run."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    pem = rsa.generate_private_key(public_exponent=65537, key_size=2048).private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    return {
        "type": "service_account",
        "project_id": "boardgamebuddy-test",
        "client_email": "deleter@boardgamebuddy-test.iam.gserviceaccount.com",
        "private_key": pem,
        "token_uri": "https://oauth2.googleapis.com/token",
    }


class _FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


class _FakeHttp:
    def __init__(self, delete_response):
        self.delete_response = delete_response
        self.posts = []

    async def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        if url.endswith("/token"):
            return _FakeResponse(200, {"access_token": "at-1", "expires_in": 3600})
        return self.delete_response


@pytest.fixture
def sa(monkeypatch):
    monkeypatch.setenv("GCP_SERVICE_ACCOUNT_JSON", json.dumps(_sa_key()))
    monkeypatch.setenv("GCP_PROJECT_ID", "boardgamebuddy-test")
    identity_admin.reload()
    yield
    identity_admin.reload()


def test_a_base64_key_is_accepted(monkeypatch):
    """More than one dashboard reflows a pasted multi-line PEM."""
    raw = base64.b64encode(json.dumps(_sa_key()).encode()).decode()
    monkeypatch.setenv("GCP_SERVICE_ACCOUNT_JSON", raw)
    identity_admin.reload()
    try:
        assert identity_admin.configured() is True
    finally:
        identity_admin.reload()


def test_a_mangled_key_is_unconfigured_rather_than_a_crash(monkeypatch):
    monkeypatch.setenv("GCP_SERVICE_ACCOUNT_JSON", "{not json at all")
    identity_admin.reload()
    try:
        assert identity_admin.configured() is False
        assert "JSON" in identity_admin.config_error()
    finally:
        identity_admin.reload()


def test_delete_user_posts_the_local_id_to_the_right_project(sa, monkeypatch):
    http = _FakeHttp(_FakeResponse(200, {"kind": "identitytoolkit#DeleteAccountResponse"}))
    monkeypatch.setattr(identity_admin, "_get_client", lambda: http)
    asyncio.run(identity_admin.delete_user(PROVIDER_UID))
    url, kwargs = http.posts[-1]
    assert url.endswith("/projects/boardgamebuddy-test/accounts:delete")
    assert kwargs["json"] == {"localId": PROVIDER_UID}
    assert kwargs["headers"]["Authorization"] == "Bearer at-1"


def test_an_already_absent_account_is_success(sa, monkeypatch):
    """Idempotent on purpose: the route retries this step after a partial
    failure, where the credential may already be gone."""
    http = _FakeHttp(_FakeResponse(400, {"error": {"message": "USER_NOT_FOUND"}}))
    monkeypatch.setattr(identity_admin, "_get_client", lambda: http)
    asyncio.run(identity_admin.delete_user(PROVIDER_UID))


def test_a_refused_delete_raises(sa, monkeypatch):
    """A key without the Firebase Authentication Admin role gets this, and it
    must not read as a deletion."""
    http = _FakeHttp(_FakeResponse(403, {"error": {"message": "PERMISSION_DENIED"}}))
    monkeypatch.setattr(identity_admin, "_get_client", lambda: http)
    with pytest.raises(identity_admin.IdentityAdminError):
        asyncio.run(identity_admin.delete_user(PROVIDER_UID))


def test_an_empty_provider_uid_raises_rather_than_deleting_nothing(sa, monkeypatch):
    """A token with no `sub` would otherwise address no account, get
    USER_NOT_FOUND, and report the deletion as done."""
    http = _FakeHttp(_FakeResponse(200, {}))
    monkeypatch.setattr(identity_admin, "_get_client", lambda: http)
    with pytest.raises(identity_admin.IdentityAdminError):
        asyncio.run(identity_admin.delete_user(""))
    assert http.posts == []


def test_the_access_token_is_reused(sa, monkeypatch):
    http = _FakeHttp(_FakeResponse(200, {}))
    monkeypatch.setattr(identity_admin, "_get_client", lambda: http)
    asyncio.run(identity_admin.delete_user(PROVIDER_UID))
    asyncio.run(identity_admin.delete_user(PROVIDER_UID))
    token_posts = [p for p in http.posts if p[0].endswith("/token")]
    assert len(token_posts) == 1


def test_the_assertion_is_signed_for_the_token_endpoint(sa, monkeypatch):
    """`sub` must equal `iss` — the service account acting as itself. Anything
    else makes Google demand a delegation grant and answer
    `unauthorized_client`."""
    import jwt as pyjwt

    http = _FakeHttp(_FakeResponse(200, {}))
    monkeypatch.setattr(identity_admin, "_get_client", lambda: http)
    asyncio.run(identity_admin.delete_user(PROVIDER_UID))
    assertion = http.posts[0][1]["data"]["assertion"]
    claims = pyjwt.decode(assertion, options={"verify_signature": False}, audience=None)
    assert claims["iss"] == claims["sub"]
    assert claims["aud"] == "https://oauth2.googleapis.com/token"
    assert claims["scope"] == "https://www.googleapis.com/auth/identitytoolkit"


# ── 7. The token carries the provider uid at all ─────────────────────────────

def test_the_verifier_keeps_the_raw_sub(monkeypatch):
    """`jwt_auth` rewrites `sub` to the app uid; without `provider_uid` the
    Identity Platform id is gone by the time the route runs, and there is
    nothing to delete the credential by."""
    import jwt_auth

    payload = {"sub": PROVIDER_UID, "app_uid": APP_UID, "email": "a@b.c"}
    user = jwt_auth.SupabaseUser(
        sub=jwt_auth._app_uid(payload),
        email=payload["email"],
        provider_uid=payload["sub"],
    )
    assert user.sub == APP_UID
    assert user.provider_uid == PROVIDER_UID


# ── 8. The route's three answers ─────────────────────────────────────────────

# Filled by `_call_route` with every id the route dropped from the profile cache.
_INVALIDATED: list = []


def _call_route(monkeypatch, outcome):
    from fastapi import HTTPException

    import jwt_auth
    from routes import profile_routes

    async def fake(**kwargs):
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    _INVALIDATED.clear()
    monkeypatch.setattr(profile_routes.account_deletion_service, "delete_account", fake)
    monkeypatch.setattr(profile_routes, "invalidate_current_user", _INVALIDATED.append)
    su = jwt_auth.SupabaseUser(sub=APP_UID, email="a@b.c", provider_uid=PROVIDER_UID)
    try:
        return asyncio.run(profile_routes.delete_profile(su_user=su)), None
    except HTTPException as exc:
        return None, exc.status_code


def test_route_returns_200_on_success(monkeypatch):
    body, status = _call_route(monkeypatch, {"r2_photos": 0, "supabase_photos": 0})
    assert status is None and body.message == "Account deleted"


def test_route_answers_503_when_nothing_was_deleted(monkeypatch):
    """A 503 says "the account is intact, this will work later" — which is
    true, and which a 500 would not be."""
    _, status = _call_route(monkeypatch, S.DeletionBlocked("unavailable"))
    assert status == 503


def test_route_answers_500_when_something_was(monkeypatch):
    _, status = _call_route(monkeypatch, S.DeletionFailed("partly gone"))
    assert status == 500


def test_the_profile_cache_is_dropped_even_when_the_delete_failed(monkeypatch):
    """A DeletionFailed can mean the rows went and the credential did not, so
    a cached CurrentUser would serve a profile that no longer exists for up to
    a TTL on this worker."""
    _call_route(monkeypatch, S.DeletionFailed("partly gone"))
    assert _INVALIDATED == [APP_UID]


def test_the_profile_cache_is_left_alone_when_nothing_was_deleted(monkeypatch):
    """Nothing was touched on a 503, so the cached profile is still correct."""
    _call_route(monkeypatch, S.DeletionBlocked("unavailable"))
    assert _INVALIDATED == []


def test_the_profile_cache_is_dropped_on_success(monkeypatch):
    _call_route(monkeypatch, {"r2_photos": 0, "supabase_photos": 0})
    assert _INVALIDATED == [APP_UID]


def test_the_route_does_not_auto_create_a_profile(monkeypatch):
    """It must depend on `get_current_supabase_user`, never `get_current_user`
    — the latter creates a profile row for a caller who has none, which on a
    retry would resurrect the account just deleted."""
    import inspect

    from routes import profile_routes

    sig = inspect.signature(profile_routes.delete_profile)
    dep = sig.parameters["su_user"].default
    assert dep.dependency is profile_routes.get_current_supabase_user
