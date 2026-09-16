"""The verifier accepts Identity Platform tokens for THIS project, and nothing else.

Was `test_jwt_auth_dual_issuer.py`. The Supabase Auth verifier is gone, so the
cases that asserted a Supabase token still worked are inverted here: a Supabase
token is now exactly as unwelcome as a stranger's, and the test that proves it
is the one that would catch the verifier being quietly re-added.

The interesting cases are not "does a good token work":

  * Every Firebase project on earth signs with the SAME Google keys. A verifier
    that checks the signature and skips `aud`/`iss` therefore accepts a token
    minted by any stranger's free Firebase project — a full authentication
    bypass that passes a naive "valid signature" test. Two cases below mint
    exactly that token and require a 401.

  * The accepted algorithm list is RS256 alone. Identity Platform signs with
    RS256; Supabase signed with ES256. Leaving ES256 in would keep a second
    algorithm alive for no issuer, which is how algorithm-confusion bugs get
    their foothold.

Tokens are really signed with throwaway keys and the JWKS lookup is stubbed, so
these exercise pyjwt's actual claim validation rather than a mock of it.

jwt_auth reads GCP_PROJECT_ID at import, so the module is reloaded after the
environment is set — otherwise an earlier test importing main() would have
frozen it as empty and every case here would 500.
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
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi import HTTPException

import jwt_auth

jwt_auth = importlib.reload(jwt_auth)

PROJECT_ID = "boardgamebuddy-508716"
FB_ISSUER = f"https://securetoken.google.com/{PROJECT_ID}"
UID = "8f14e45f-ceea-467a-9f0e-3b4f0a1d2c3b"

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_EC_KEY = ec.generate_private_key(ec.SECP256R1())


def _sign(claims, key=_KEY, algorithm="RS256"):
    return jwt.encode(claims, key, algorithm=algorithm)


class _FakeJWKS:
    """Stands in for PyJWKClient: hands back the one key we signed with."""

    def __init__(self, key):
        self._key = key

    def get_signing_key_from_jwt(self, _token):
        return type("Key", (), {"key": self._key})()


@pytest.fixture(autouse=True)
def _stub_jwks(monkeypatch):
    monkeypatch.setattr(jwt_auth, "_fb_jwks_client", _FakeJWKS(_KEY.public_key()))


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
        "iss": "https://example.supabase.co/auth/v1",
        "role": "authenticated",
        "exp": 9999999999,
    }
    claims.update(over)
    return claims


# --- the one happy path ------------------------------------------------------

def test_identity_platform_token_verifies():
    user = _verify(_sign(_firebase_claims()))
    assert user.sub == UID
    assert user.email == "player@example.com"


def test_token_has_no_role_and_that_is_fine():
    """Identity Platform's `role` claim exists for Supabase's RLS policies, not
    for this API. Nothing here reads it — checked by grep across api/ — and the
    admin gate reads the profile row, not the claim."""
    assert _verify(_sign(_firebase_claims())).role == ""


# --- the issuer that used to work --------------------------------------------

def test_a_supabase_token_is_now_rejected():
    """The removal, asserted. This is the test that fails if the second
    verifier is ever quietly re-added."""
    with pytest.raises(HTTPException) as e:
        _verify(_sign(_supabase_claims()))
    assert e.value.status_code == 401


def test_a_supabase_token_wearing_our_audience_is_still_rejected():
    """`aud` alone is not what saves us — `iss` is enforced too."""
    with pytest.raises(HTTPException) as e:
        _verify(_sign(_supabase_claims(aud=PROJECT_ID)))
    assert e.value.status_code == 401


# --- the bypass this design exists to prevent --------------------------------

def test_token_from_another_firebase_project_is_rejected():
    """Signed by Google's keys, well-formed, and NOT ours. Anyone can mint one
    by creating a free Firebase project, so `aud` is the only thing standing
    between that and a valid session."""
    with pytest.raises(HTTPException) as e:
        _verify(_sign(_firebase_claims(aud="someone-elses-project")))
    assert e.value.status_code == 401


def test_token_claiming_another_projects_issuer_is_rejected():
    with pytest.raises(HTTPException) as e:
        _verify(
            _sign(
                _firebase_claims(
                    iss="https://securetoken.google.com/someone-elses-project"
                )
            )
        )
    assert e.value.status_code == 401


def test_an_es256_token_is_rejected():
    """Supabase signed ES256 and Identity Platform does not. One issuer, one
    algorithm — a spare algorithm is attack surface with no user."""
    token = _sign(_firebase_claims(), key=_EC_KEY, algorithm="ES256")
    with pytest.raises(HTTPException) as e:
        _verify(token)
    assert e.value.status_code == 401


def test_garbage_is_a_401_not_a_crash():
    with pytest.raises(HTTPException) as e:
        _verify("not-a-jwt")
    assert e.value.status_code == 401


def test_an_unsigned_token_is_rejected():
    """`alg: none`, the oldest trick there is."""
    token = jwt.encode(_firebase_claims(), key=None, algorithm="none")
    with pytest.raises(HTTPException) as e:
        _verify(token)
    assert e.value.status_code == 401


# --- misconfiguration --------------------------------------------------------

def test_missing_gcp_project_id_is_500_not_401(monkeypatch):
    """An unset GCP_PROJECT_ID is an operator error, not a bad credential.
    401 would send a correctly signed-in user to the login screen and hide the
    real cause; 500 surfaces it."""
    monkeypatch.setattr(jwt_auth, "_fb_jwks_client", None)
    with pytest.raises(HTTPException) as e:
        _verify(_sign(_firebase_claims()))
    assert e.value.status_code == 500
    assert "GCP_PROJECT_ID" in e.value.detail


def test_expired_token_is_401():
    with pytest.raises(HTTPException) as e:
        _verify(_sign(_firebase_claims(exp=1000000000)))
    assert e.value.status_code == 401
