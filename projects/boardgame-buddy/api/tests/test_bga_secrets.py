"""No Board Game Arena credential ever leaves the server.

This feature stores a third party's password because BGA has no API and no app
passwords, which makes "we accidentally put it in a response model" a live
possibility rather than a theoretical one — and it is exactly the kind of
mistake that reads fine in review, because it looks like copying a field
across with its neighbours.

So it gets a gate, in the same spirit as `test_object_store.py`'s guard around
the R2 fallback: the invariant is stated once, in code, where a future change
has to argue with it.

Two invariants:

  1. No `/bga/*` response model has a field that could carry the encrypted
     password or the session cookies.
  2. The login call redacts the password AND the CSRF token before anything
     reaches `api_logs`. The token is redacted too — it is a session-bound
     capability, and the log table is not the place for it.
"""

from __future__ import annotations

import inspect

import pytest

from routes import bga_credentials, bga_routes, models

# Anything whose name suggests it holds a credential. Matched as substrings so
# a renamed column (bga_password_enc -> bga_secret) is still caught.
FORBIDDEN_SUBSTRINGS = ("password", "passwd", "secret", "cookie", "session_id", "token")

# The models every /bga/* route answers with.
RESPONSE_MODELS = [
    models.BgaLinkStatus,
    models.BgaFetchResponse,
    models.BgaFetchProgressResponse,
    models.BgaRememberResponse,
    models.BgaDraftTable,
    models.BgaDraftSeat,
    models.BgaHandleMatch,
    models.BgaFetchStep,
]


@pytest.mark.parametrize("model", RESPONSE_MODELS, ids=lambda m: m.__name__)
def test_no_bga_response_model_carries_a_credential(model):
    """A response model is a promise about what leaves the process."""
    for name in model.model_fields:
        lowered = name.lower()
        for bad in FORBIDDEN_SUBSTRINGS:
            assert bad not in lowered, (
                f"{model.__name__}.{name} looks like a credential field. "
                f"BGA passwords and session cookies stay on boardgamebuddy_profiles."
            )


def test_the_request_model_holds_the_password_as_a_secret():
    """SecretStr, so an accidental repr of the request body prints nothing."""
    body = models.BgaLinkRequest(username="me", password="hunter2")
    assert "hunter2" not in repr(body)
    assert "hunter2" not in str(body.password)
    # And it is still readable where it is actually needed.
    assert body.password.get_secret_value() == "hunter2"


def test_login_redacts_the_password_and_the_token():
    """The redaction list is the only thing between a password and api_logs.

    Asserted against the source because `log_external_call` is a context
    manager wrapping a live request — the cheap, stable check is that the call
    names both fields.
    """
    src = inspect.getsource(bga_credentials.login_to_bga)
    assert 'redact_params=("password", "request_token")' in src, (
        "login_to_bga must redact BOTH the password and the CSRF token"
    )
    # Passed as `params`, not as a pre-encoded body string: redaction only
    # reaches structured params, so a string body would log the password whole.
    assert "params=form" in src


def test_the_link_status_helper_drops_the_password_column():
    """`_status_from` reads bga_password_enc to decide the auth state, and must
    not carry it across into the response."""
    src = inspect.getsource(bga_routes._status_from)
    assert "bga_password_enc" not in src.split("return")[-1]


def test_cross_account_lookup_does_not_echo_the_handle_back():
    """Matching an opponent to an account reveals that SOME account linked that
    handle — the same class of disclosure the app-wide people search already
    makes. It must not also hand back the account's own stored handle."""
    from routes.services import bga_import_service

    src = inspect.getsource(bga_import_service._cross_account)
    built = src.split("out[key] = {")[-1]
    assert "bga_username" not in built
