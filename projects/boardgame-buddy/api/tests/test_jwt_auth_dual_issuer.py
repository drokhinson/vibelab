"""The verifier accepts Supabase AND Identity Platform tokens, and only those.

Both issuers are live simultaneously through the auth migration, so the
interesting cases are not "does a good token work" but the ways a dual-issuer
verifier goes wrong:

  * Every Firebase project on earth signs with the SAME Google keys. A verifier
    that checks the signature and skips `aud`/`iss` therefore accepts a token
    minted by any stranger's Firebase project — a full authentication bypass,
    and one that passes a naive "valid signature" test. Two cases below mint
    exactly that token and require a 401.

  * The issuer is read UNVERIFIED to choose a verifier. That is only safe
    because the chosen verifier re-checks it under the signature. A test mints
    a token that lies about `iss` to make sure it is rejected rather than
    routed somewhere lenient.

Tokens are really signed with a throwaway RSA key and the JWKS lookup is
stubbed, so these exercise the actual pyjwt claim validation rather than a
mock of it.

jwt_auth reads GCP_PROJECT_ID at import, so the module is reloaded after the
environment is set — otherwise an earlier test importing main() would have
already frozen it as empty and every Firebase case would 500.
"""

import asyncio
import importlib
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
os.environ["GCP_PROJECT_ID"] = "boardgamebuddy-508716"

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException

import jwt_auth

jwt_auth = importlib.reload(jwt_auth)

PROJECT_ID = "boardgamebuddy-508716"
FB_ISSUER = f"https://securetoken.google.com/{PROJECT_ID}"
UID = "8f14e45f-ceea-467a-9f0e-3b4f0a1d2c3b"

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _sign(claims):
    return jwt.encode(claims, _KEY, algorithm="RS256")


class _FakeJWKS:
    """Stands in for PyJWKClient: hands back the one key we signed with."""

    def __init__(self, key):
        self._key = key

    def get_signing_key_from_jwt(self, _token):
        return type("Key", (), {"key": self._key})()


@pytest.fixture(autouse=True)
def _stub_jwks(monkeypatch):
    fake = _FakeJWKS(_KEY.public_key())
    monkeypatch.setattr(jwt_auth, "_fb_jwks_client", fake)
    monkeypatch.setattr(jwt_auth, "_jwks_client", fake)


def _verify(token):
    return asyncio.run(
        jwt_auth.get_current_supabase_user(authorization=f"Bearer {token}")
    )


def _firebase_claims(**over):
    claims = {
        "sub": UID,
        "email": "player@example.com",
        "aud": PROJECT_ID,
        "iss": FB_ISSUER,
        "exp": 9999999999,
    }
    claims.update(over)
    return claims


def _supabase_claims(**over):
    claims = {
        "sub": UID,
        "email": "player@example.com",
        "aud": "authenticated",
        "role": "authenticated",
        "exp": 9999999999,
    }
    claims.update(over)
    return claims


# --- the two happy paths -----------------------------------------------------

def test_firebase_token_verifies():
    user = _verify(_sign(_firebase_claims()))
    assert user.sub == UID
    assert user.email == "player@example.com"


def test_firebase_token_has_no_role_and_that_is_fine():
    """Firebase mints no `role`. Nothing in the API reads it — checked by grep
    across api/ — and BGB's admin gate reads the profile row, not the claim."""
    assert _verify(_sign(_firebase_claims())).role == ""


def test_supabase_token_still_verifies():
    """The whole point of dual-issuer: the swap must not 401 live sessions."""
    user = _verify(_sign(_supabase_claims()))
    assert user.sub == UID
    assert user.role == "authenticated"


# --- the bypass this design exists to prevent --------------------------------

def test_token_from_another_firebase_project_is_rejected():
    """Signed by Google's keys, well-formed, and NOT ours. Anyone can mint one
    by creating a free Firebase project, so `aud` is the only thing standing
    between that and a valid session."""
    token = _sign(_firebase_claims(aud="someone-elses-project"))
    with pytest.raises(HTTPException) as e:
        _verify(token)
    assert e.value.status_code == 401


def test_token_claiming_another_projects_issuer_is_rejected():
    token = _sign(
        _firebase_claims(iss="https://securetoken.google.com/someone-elses-project")
    )
    with pytest.raises(HTTPException) as e:
        _verify(token)
    assert e.value.status_code == 401


def test_firebase_audience_does_not_satisfy_the_supabase_path():
    """A token with Supabase's `aud` but Firebase's `iss` must not slip through
    whichever verifier is more permissive."""
    token = _sign(_firebase_claims(aud="authenticated"))
    with pytest.raises(HTTPException) as e:
        _verify(token)
    assert e.value.status_code == 401


def test_supabase_token_is_not_accepted_as_firebase():
    token = _sign(_supabase_claims(aud=PROJECT_ID))
    with pytest.raises(HTTPException) as e:
        _verify(token)
    assert e.value.status_code == 401


# --- routing ------------------------------------------------------------------

@pytest.mark.parametrize(
    "iss,expected",
    [
        (FB_ISSUER, True),
        ("https://securetoken.google.com/other", True),
        ("https://example.supabase.co/auth/v1", False),
        ("", False),
    ],
)
def test_issuer_routing(iss, expected):
    assert jwt_auth._is_firebase_token(_sign({"sub": UID, "iss": iss})) is expected


def test_garbage_routes_to_the_supabase_path_and_401s():
    """A malformed token must not blow up the router before verification."""
    assert jwt_auth._is_firebase_token("not-a-jwt") is False
    with pytest.raises(HTTPException) as e:
        _verify("not-a-jwt")
    assert e.value.status_code == 401


# --- misconfiguration --------------------------------------------------------

def test_firebase_token_without_gcp_project_id_is_500_not_401(monkeypatch):
    """An unset GCP_PROJECT_ID is an operator error, not a bad credential.
    401 would send a correctly signed-in user to the login screen and hide the
    real cause; 500 surfaces it."""
    monkeypatch.setattr(jwt_auth, "_fb_jwks_client", None)
    with pytest.raises(HTTPException) as e:
        _verify(_sign(_firebase_claims()))
    assert e.value.status_code == 500
    assert "GCP_PROJECT_ID" in e.value.detail


def test_expired_firebase_token_is_401():
    token = _sign(_firebase_claims(exp=1000000000))
    with pytest.raises(HTTPException) as e:
        _verify(token)
    assert e.value.status_code == 401
