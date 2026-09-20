"""identity_admin.py — privileged operations against GCP Identity Platform.

ONE OPERATION: `delete_user()`. This module exists because deleting an account
has to delete the *credential*, not just the rows — and nothing else in this
service holds an admin credential for the identity provider.

WHY IT IS NOT THE FIREBASE ADMIN SDK. `firebase-admin` pulls in `google-auth`,
`google-api-core`, `google-cloud-core` and their transitive set to do, for our
purposes, two HTTP calls. Both are specified protocols we already have the
pieces for: PyJWT signs the service-account assertion (RS256, via the
`cryptography` that `BGG_CREDENTIAL_KEY`'s Fernet already requires) and httpx
makes the calls. Zero new entries in `requirements.txt` for ~120 lines.

WHY NOT THE USER'S OWN ID TOKEN. Identity Toolkit's `accounts:delete` also
accepts an `idToken` with just the web API key, which would need no secret at
all. It refuses one whose `auth_time` is more than a few minutes old
(`CREDENTIAL_TOO_OLD_LOGIN_AGAIN` — the server-side half of the SDK's
`auth/requires-recent-login`), so every deletion by someone who had been
signed in a while would have to bounce through a re-authentication. The
service-account path has no such condition: it is the provider's admin API and
it deletes on the first try, every time.

UNCONFIGURED IS AN ERROR HERE, and that is the opposite of `object_store.py`'s
stance on purpose. An unconfigured R2 has a working fallback — the bytes land
in Supabase Storage instead. An unconfigured identity admin has no fallback:
the only thing `DELETE /profile` could do is delete the rows and leave the
credential standing, which is precisely the bug this module was added to fix.
So `configured()` is False and the route refuses rather than half-deleting.

Local dev therefore cannot delete accounts unless `GCP_SERVICE_ACCOUNT_JSON`
is set, and that is the intended state: the endpoint answers 503 with an
operator-shaped message rather than pretending.
"""
import asyncio
import base64
import binascii
import json
import logging
import os
import time

import httpx
import jwt

logger = logging.getLogger(__name__)

# Least privilege. `cloud-platform` also works and is what most examples show;
# this one is the single scope Identity Toolkit's admin surface actually
# checks, so a key that leaks cannot reach the rest of the project.
_SCOPE = "https://www.googleapis.com/auth/identitytoolkit"

_DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
_IDENTITY_TOOLKIT = "https://identitytoolkit.googleapis.com/v1"

# The assertion's lifetime. Google caps it at an hour and rejects anything
# longer outright; the access token it buys back carries its own expiry, which
# is what `_TokenCache` tracks.
_ASSERTION_TTL_S = 3600

# Re-mint this many seconds before the access token actually lapses, so a
# deletion never races the expiry it checked a moment ago.
_TOKEN_SKEW_S = 60

# Both calls run inside a user-facing request that is already deleting rows.
# Short enough that a sulking Google surfaces as a retryable 502 rather than
# holding the single uvicorn worker's request open.
_HTTP_TIMEOUT_S = 15.0


class IdentityAdminError(RuntimeError):
    """Any failure deleting the credential. The route maps this to a 500.

    Deliberately NOT raised for a uid the provider has never heard of — see
    `delete_user`, where that outcome is a success.
    """


class NotConfigured(IdentityAdminError):
    """`GCP_SERVICE_ACCOUNT_JSON` is absent or unusable. Guard with `configured()`."""


class _Config:
    """The env-derived service account, parsed once and re-readable by `reload()`."""

    __slots__ = ("client_email", "private_key", "token_uri", "project_id", "error")

    def __init__(self) -> None:
        self.client_email = ""
        self.private_key = ""
        self.token_uri = _DEFAULT_TOKEN_URI
        self.project_id = ""
        self.error = ""

        raw = (os.environ.get("GCP_SERVICE_ACCOUNT_JSON") or "").strip()
        if not raw:
            self.error = "GCP_SERVICE_ACCOUNT_JSON is not set"
            return

        # Base64 accepted alongside raw JSON because the key is a multi-line
        # PEM inside a JSON string, and more than one dashboard has been known
        # to helpfully reflow a pasted blob. A leading `{` is unambiguous —
        # base64 has no such character in its alphabet.
        if not raw.startswith("{"):
            try:
                raw = base64.b64decode(raw, validate=True).decode("utf-8")
            except (binascii.Error, UnicodeDecodeError, ValueError):
                self.error = (
                    "GCP_SERVICE_ACCOUNT_JSON is neither JSON (no leading '{') "
                    "nor valid base64"
                )
                return

        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            self.error = f"GCP_SERVICE_ACCOUNT_JSON is not valid JSON: {exc}"
            return
        if not isinstance(data, dict):
            self.error = "GCP_SERVICE_ACCOUNT_JSON is not a JSON object"
            return

        self.client_email = str(data.get("client_email") or "").strip()
        self.private_key = str(data.get("private_key") or "")
        self.token_uri = str(data.get("token_uri") or "").strip() or _DEFAULT_TOKEN_URI
        self.project_id = str(data.get("project_id") or "").strip()

        missing = [
            name
            for name, value in (
                ("client_email", self.client_email),
                ("private_key", self.private_key),
            )
            if not value
        ]
        if missing:
            self.error = (
                "GCP_SERVICE_ACCOUNT_JSON is missing " + ", ".join(missing)
                + " — is it a service account key rather than an OAuth client?"
            )

    def ready(self) -> bool:
        return not self.error


_cfg = _Config()
_client: httpx.AsyncClient | None = None
_token: tuple[str, float] | None = None  # (access_token, expires_at_monotonic)
_token_lock = asyncio.Lock()


def reload() -> None:
    """Re-read the environment and drop the cached token and client.

    For tests, which flip between configured and unconfigured in one process.
    A real config change arrives as a service restart.
    """
    global _cfg, _client, _token
    _cfg = _Config()
    _client = None
    _token = None


def configured() -> bool:
    """Whether a usable service account is present."""
    return _cfg.ready()


def config_error() -> str:
    """Why `configured()` is False — for an operator-facing log line. "" when ready.

    Never returned to a caller over HTTP: it names an environment variable and
    can quote a parse error off a secret, and neither belongs in a response
    body a browser can read.
    """
    return _cfg.error


def target_project_id() -> str:
    """The project `delete_user` will address.

    `GCP_PROJECT_ID` is authoritative — it is the `aud` every ID token is
    verified against (`jwt_auth.py`), so it is by definition the project the
    account being deleted lives in. The key's own `project_id` is the
    fallback, and a mismatch between the two is logged at call time rather
    than being made fatal: an operator who points a key at the right project
    under a different name should not have account deletion refuse.
    """
    return (os.environ.get("GCP_PROJECT_ID") or "").strip() or _cfg.project_id


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=_HTTP_TIMEOUT_S)
    return _client


def _assertion(now: int) -> str:
    """A signed JWT claiming `_SCOPE` on behalf of the service account itself.

    `sub` equals `iss` — this is the service account acting as itself, not
    domain-wide delegation impersonating a user. Setting `sub` to anything
    else makes Google demand a delegation grant we have not configured and
    answer `unauthorized_client`.
    """
    try:
        return jwt.encode(
            {
                "iss": _cfg.client_email,
                "sub": _cfg.client_email,
                "aud": _cfg.token_uri,
                "scope": _SCOPE,
                "iat": now,
                "exp": now + _ASSERTION_TTL_S,
            },
            _cfg.private_key,
            algorithm="RS256",
        )
    except Exception as exc:
        # A malformed PEM fails here, not at config parse: `_Config` only
        # checks the field is non-empty, because loading the key eagerly would
        # mean every worker paying for it whether or not anyone deletes an
        # account.
        raise NotConfigured(
            f"GCP_SERVICE_ACCOUNT_JSON private_key could not sign: {exc}"
        ) from exc


async def _access_token() -> str:
    """A cached OAuth access token for `_SCOPE`, minted on demand.

    The lock is not about throughput — deletions are rare — it is so two
    concurrent callers on a cold cache mint one token rather than two, and so
    the second sees the first's result instead of a half-written global.
    """
    global _token
    if not _cfg.ready():
        raise NotConfigured(_cfg.error)

    async with _token_lock:
        cached = _token
        if cached and cached[1] > time.monotonic():
            return cached[0]

        now = int(time.time())
        try:
            resp = await _get_client().post(
                _cfg.token_uri,
                data={
                    "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                    "assertion": _assertion(now),
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        except httpx.HTTPError as exc:
            raise IdentityAdminError(f"token endpoint unreachable: {exc}") from exc

        if resp.status_code != 200:
            # `error_description` is Google's own words on a bad key — "Invalid
            # JWT Signature", "Invalid grant: account not found". It names the
            # operator's actual mistake, and it is logged rather than returned.
            raise IdentityAdminError(
                f"token endpoint returned {resp.status_code}: "
                f"{_error_message(resp) or resp.text[:200]}"
            )

        try:
            payload = resp.json()
        except ValueError as exc:
            raise IdentityAdminError("token endpoint returned non-JSON") from exc

        token = str(payload.get("access_token") or "")
        if not token:
            raise IdentityAdminError("token endpoint returned no access_token")

        # `expires_in` is documented as always present; the default is here so
        # a missing one re-mints every call rather than caching forever.
        expires_in = int(payload.get("expires_in") or 0)
        _token = (token, time.monotonic() + max(expires_in - _TOKEN_SKEW_S, 0))
        return token


def _error_message(resp: httpx.Response) -> str:
    """Google's error string out of either of the two shapes it uses."""
    try:
        body = resp.json()
    except ValueError:
        return ""
    if not isinstance(body, dict):
        return ""
    err = body.get("error")
    if isinstance(err, dict):
        return str(err.get("message") or "")
    # The OAuth token endpoint uses flat `error` / `error_description`.
    if isinstance(err, str):
        desc = body.get("error_description")
        return f"{err}: {desc}" if desc else err
    return ""


async def delete_user(local_id: str) -> None:
    """Delete one Identity Platform account by its provider uid.

    `local_id` is the ID token's raw `sub` — `SupabaseUser.provider_uid`, NOT
    `SupabaseUser.sub`. Passing the app_uid of a post-migration account
    addresses a uid that never existed, which the provider answers
    `USER_NOT_FOUND` to, which this function treats as success. That
    combination fails silently and completely, so the caller's job is to pass
    the right field; there is nothing this function can check.

    IDEMPOTENT BY DESIGN. `USER_NOT_FOUND` returns rather than raising,
    because the state it describes is the state being asked for — and because
    the route retries this step after a partial failure, where the credential
    may already be gone.

    Raises `NotConfigured` when no service account is present, and
    `IdentityAdminError` for anything else, both of which the route turns into
    a refusal that leaves the account intact enough to retry.
    """
    uid = (local_id or "").strip()
    if not uid:
        raise IdentityAdminError("no provider uid on the token to delete")

    project = target_project_id()
    if not project:
        raise NotConfigured("GCP_PROJECT_ID is not set and the key names no project")
    if _cfg.project_id and _cfg.project_id != project:
        logger.warning(
            "identity_admin: GCP_PROJECT_ID=%s but the service account key belongs "
            "to %s; deleting against the former",
            project,
            _cfg.project_id,
        )

    token = await _access_token()
    try:
        resp = await _get_client().post(
            f"{_IDENTITY_TOOLKIT}/projects/{project}/accounts:delete",
            json={"localId": uid},
            headers={"Authorization": f"Bearer {token}"},
        )
    except httpx.HTTPError as exc:
        raise IdentityAdminError(f"identitytoolkit unreachable: {exc}") from exc

    if resp.status_code == 200:
        return

    message = _error_message(resp) or resp.text[:200]
    # Already gone is the outcome we wanted. Identity Toolkit reports it as a
    # 400 with this exact code, not a 404.
    if "USER_NOT_FOUND" in message:
        logger.info("identity_admin: uid already absent, treating delete as done")
        return
    raise IdentityAdminError(
        f"accounts:delete returned {resp.status_code}: {message}"
    )
