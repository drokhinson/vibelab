"""account_deletion_service.py — everything `DELETE /profile` has to destroy.

Deleting an account used to be one statement: drop the
`boardgamebuddy_profiles` row and let the schema's cascades take the rest.
That left two things standing, and both of them made the deletion look like it
had not happened.

1. **The Identity Platform credential.** The rows went; the account at the
   provider did not. Signing in with Google afterwards succeeded, handed back
   the same uid, and `get_current_user` auto-created a fresh profile row — an
   emptied account, not a deleted one. Signing up again with the same address
   and a password failed with `auth/email-already-in-use`, which the sign-in
   screen words as "you already have an account". Either way the person is
   told their deleted account still exists, because it did.
2. **The play photos.** `object_store.py` had no delete, and the privacy
   policy said so in as many words — "deleting a play or your account removes
   the records but does not currently delete the stored image files ... We are
   fixing this." The URLs cascaded away with the plays; the objects stayed,
   public to anyone still holding the link.

And then fixing (1) exposed a third thing, which is the opposite problem:
deletion was destroying data that was never only the deleter's.

3. **Everybody else's game nights.** `plays.user_id` is ON DELETE CASCADE and
   `play_players.play_id` cascades off the play, so deleting the person who
   LOGGED a night deleted the night — and the seat of every other account at
   that table with it. They lost a play, a win, a "played with" edge and
   achievement progress, for an act they had no part in. Since migration 049
   such a play is HANDED OVER instead: it passes to the account that was
   seated earliest, and only a play nobody else was at still goes. That is
   `bgb_delete_account_rows`, and the reasoning for the heir, the collisions
   that would otherwise abort the whole delete, and what the heir gains lives
   in the migration.

ORDER IS THE DESIGN HERE, so read `delete_account` before changing it.
"""
import asyncio
import logging

import identity_admin
import object_store
from db import get_supabase

logger = logging.getLogger(__name__)

# The Supabase Storage bucket play photos used before the R2 cutover. The
# objects are STILL THERE: `Docs/RUNBOOK_R2_CUTOVER.md` §12 says in bold not to
# delete the Supabase buckets because they are the rollback, and `036` only
# rewrote the URLs — it copied nothing back and removed nothing. So after the
# cutover a pre-migration photo exists in both stores, and a deletion that
# cleared only R2 would leave a public copy of the same image on supabase.co.
#
# Kept as its own constant rather than imported from `play_routes` to avoid a
# routes -> routes import; the two must stay equal, and `test_account_deletion`
# asserts they do.
SUPABASE_PLAYS_BUCKET = "boardgamebuddy-plays"


class DeletionBlocked(RuntimeError):
    """A prerequisite is missing, and NOTHING has been deleted yet.

    The route answers 503. Distinct from a failure part-way through, which is
    `DeletionFailed` and leaves the account partly gone.
    """


class DeletionFailed(RuntimeError):
    """A step failed. What came before it is gone; retrying is safe.

    Every step in `delete_account` is idempotent, so the honest thing to tell
    the caller is "try again", and the honest thing for the caller to do is
    stay signed in so it can.
    """


def _purge_supabase_photos_sync(user_id: str) -> int:
    """Remove this account's objects from the retired Supabase Storage bucket.

    Blocking (the storage SDK is), so callers hand it to `asyncio.to_thread`.

    A MISSING BUCKET IS NOT A FAILURE. Local dev and any environment stood up
    after the cutover never created it, and refusing to delete an account
    because a bucket that was always empty is absent would be absurd. Anything
    else — a permissions error, a transport failure — raises, because those
    mean objects may still be there.
    """
    sb = get_supabase()
    try:
        entries = sb.storage.from_(SUPABASE_PLAYS_BUCKET).list(path=user_id)
    except Exception as exc:
        if _is_missing_bucket(exc):
            return 0
        raise DeletionFailed(f"listing Supabase play photos failed: {exc}") from exc

    # `list` returns one dict per object, named relative to `path`. The
    # placeholder row Supabase Storage puts in an empty folder has no id and
    # must not be handed to `remove`, which answers 400 for it.
    names = [
        f"{user_id}/{e['name']}"
        for e in (entries or [])
        if isinstance(e, dict) and e.get("name") and e.get("id")
    ]
    if not names:
        return 0
    try:
        sb.storage.from_(SUPABASE_PLAYS_BUCKET).remove(names)
    except Exception as exc:
        if _is_missing_bucket(exc):
            return 0
        raise DeletionFailed(f"removing Supabase play photos failed: {exc}") from exc
    return len(names)


def _is_missing_bucket(exc: Exception) -> bool:
    """Whether a storage error means "no such bucket" rather than "no".

    Matched on the message because supabase-py raises `StorageApiError` with
    the API's JSON folded into the string rather than a typed status. Narrow on
    purpose: `AccessDenied`, `Unauthorized` and a transport error all fall
    through to a raise, because each of them can hide objects that survived.
    """
    text = str(exc).lower()
    return "bucket not found" in text or "bucket_not_found" in text


def _purge_r2_photos_sync(user_id: str) -> int:
    """Remove this account's objects from R2. Blocking; run in a thread.

    An unconfigured R2 returns 0 rather than raising. That is the one place
    this module accepts "not configured" as done, and it is sound because the
    two stores are exclusive on the WRITE path: `play_routes` uploads to R2
    when it is configured and to Supabase Storage when it is not, so with R2
    absent every object this account owns is in the bucket the other purge
    just covered.
    """
    if not object_store.configured(object_store.PLAYS):
        return 0
    # The trailing slash is load-bearing — see `object_store.delete_prefix`,
    # which rejects a prefix without one precisely so this call cannot reach a
    # uid that merely starts with this one.
    try:
        return object_store.delete_prefix(object_store.PLAYS, f"{user_id}/")
    except object_store.ObjectStoreError as exc:
        raise DeletionFailed(f"removing R2 play photos failed: {exc}") from exc


async def delete_account(app_uid: str, provider_uid: str) -> dict:
    """Delete one account completely: its photos, then its rows, then its login.

    `app_uid` is `SupabaseUser.sub` — the UUID every table keys on.
    `provider_uid` is `SupabaseUser.provider_uid` — the Identity Platform uid.
    They are equal only for the 23 migrated accounts; see `jwt_auth.py`.

    THE ORDER IS PHOTOS, ROWS, CREDENTIAL, and each boundary is a decision.
    "Rows" is one RPC rather than one DELETE since migration 049 — the
    handover and the profile delete have to be the same transaction — but the
    three steps and their boundaries are unchanged:

    * **Photos first, and a failure here aborts before anything is
      destroyed.** The keys are derived from the uid, not read from the rows,
      so this step does not depend on the profile still existing — but doing
      it first means a flaky object store costs the user a retry instead of
      costing them their photos with the records that referenced them already
      gone. Nothing is unrecoverable until step two.
    * **The credential last.** If it went first, a failure in the row delete
      would leave an account that cannot sign in, orphan rows nobody can reach,
      and no token left to retry with. Last, a failure leaves the person signed
      in, holding a valid token, with a retry that works: the profile row is
      already gone, `DELETE /profile` does not auto-create one (it depends on
      `get_current_supabase_user`, not `get_current_user`), and both purges and
      `accounts:delete` are no-ops the second time.
    * **Configuration is checked before step one.** `identity_admin` being
      unconfigured is the only way to reach the old behaviour — rows deleted,
      login intact — so the route refuses up front rather than discovering it
      after the cascade. This is why `identity_admin.configured()` is False
      rather than silently no-op.

    Returns a count per step for the log line — the photo counts this function
    gathered, plus whatever `bgb_delete_account_rows` reports about the rows.
    Raises `DeletionBlocked` when nothing was touched, `DeletionFailed` when
    something was.
    """
    if not identity_admin.configured():
        # The operator-facing reason goes to the log; the caller gets a generic
        # 503 from the route, because `config_error()` names an env var and can
        # quote a parse error off a secret.
        logger.error(
            "account deletion refused: identity admin unconfigured (%s)",
            identity_admin.config_error(),
        )
        raise DeletionBlocked("Account deletion is temporarily unavailable")

    r2_count = await asyncio.to_thread(_purge_r2_photos_sync, app_uid)
    supabase_count = await asyncio.to_thread(_purge_supabase_photos_sync, app_uid)

    sb = get_supabase()
    # ONE RPC, ONE TRANSACTION (migration 049). This was a direct
    # `.table("boardgamebuddy_profiles").delete()` until plays started
    # surviving their logger, and it cannot be one any more: the handover
    # decides an heir, clears the photo links, backfills the names the FK is
    # about to null, and deletes the profile — and a failure between any two of
    # those would leave plays owned by other people while the account they were
    # taken from is still signed in and still holds them in its own log.
    #
    # What the DELETE inside it still cascades: collections, the plays nobody
    # else was at, buddies, buddy_edges, sessions, participants, achievements,
    # push subscriptions, pending imports, feedback, BGA links. Chapters the
    # account authored keep their text with `created_by` set NULL, and seats on
    # the plays that were handed over keep theirs with `player_user_id` set
    # NULL — a named ghost, which every reader already renders.
    try:
        result = await asyncio.to_thread(
            sb.rpc("bgb_delete_account_rows", {"p_user": app_uid}).execute
        )
    except Exception as exc:
        raise DeletionFailed(f"deleting the account rows failed: {exc}") from exc
    counts = result.data if isinstance(getattr(result, "data", None), dict) else {}

    try:
        await identity_admin.delete_user(provider_uid)
    except identity_admin.IdentityAdminError as exc:
        # The rows are gone and the login is not. Say so loudly: this is the
        # exact state the whole module exists to prevent, and the only route
        # back to it. The user is told to retry, and a retry reaches
        # `accounts:delete` again with the row delete already a no-op.
        logger.error(
            "account %s: rows deleted but credential NOT deleted: %s", app_uid, exc
        )
        raise DeletionFailed("Your data was deleted but your login was not") from exc

    logger.info(
        "account %s deleted: %d R2 photo(s), %d Supabase photo(s), "
        "%s play(s) handed over, %s play(s) deleted, credential",
        app_uid,
        r2_count,
        supabase_count,
        counts.get("plays_reassigned", "?"),
        counts.get("plays_deleted", "?"),
    )
    return {
        "r2_photos": r2_count,
        "supabase_photos": supabase_count,
        **counts,
    }
