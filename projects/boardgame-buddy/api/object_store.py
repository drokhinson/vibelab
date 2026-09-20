"""object_store.py — S3-compatible object storage (Cloudflare R2).

Replaces Supabase Storage for image objects. Image bytes are ~93% of this
app's egress and Supabase bills egress; **R2 never does, at any volume**, which
is the entire reason this module exists.

WHAT IS AND IS NOT HERE. Four operations: `put()`, `public_url()`, `usage()`
and `delete_prefix()`. No object read. Reads never come through the API at all
— the client loads an absolute URL straight from the row, so an image is an
`<img src>` and nothing more, and neither of the other two changes that:
`usage()` lists KEYS AND SIZES for the admin Usage spoke and `delete_prefix()`
lists keys to delete them, and neither ever fetches an object's bytes.

`delete_prefix()` arrived when account deletion stopped being rows-only. This
header used to say delete was absent "because nothing deletes an image today;
the privacy policy discloses that, and when it stops being true this module
gains a `delete()` rather than a caller reaching for boto3 itself" — which is
what happened. It is a PREFIX delete and not a `delete(key)` because the
plays layout is a directory per user (see below), so "everything this account
uploaded" is expressible as one prefix and needs no list of URLs gathered
before the rows cascade away. There is deliberately no single-object delete:
nothing needs one yet, and the same reasoning applies.

PATHS ARE UNCHANGED FROM THE SUPABASE LAYOUT.
  plays: `{user_id}/{uuid4hex}.{ext}`     games: `{bgg_id}_{kind}.{ext}`
That is deliberate and it is what makes the data migration cheap: the object
key is identical on both sides, so rewriting the stored URLs is one prefix
substitution per column (`036_r2_photo_urls.sql`) rather than a re-key. Do not
"tidy" these into a new shape — the tidying cost is a second data migration.

TWO BUCKETS, TWO HOSTNAMES, ON PURPOSE. Play photos are user content; cover
art is a cache of public BGG images. The privacy policy discloses that a play
photo's URL is effectively public to anyone holding the link, and the fix for
that is signed URLs — which means taking the public custom domain off the
plays bucket. Behind one shared bucket or one shared hostname, that fix costs
a re-key and a second URL rewrite. Split, it costs a console change to one
hostname and touches no cover art at all. The buckets and their public bases
are both env-driven, so which hostname serves which is an operator decision,
not a constant in here.

UNCONFIGURED IS A SUPPORTED STATE, NOT AN ERROR. `configured()` answers False
when the R2 variables are absent, and both call sites then use Supabase
Storage exactly as they did before this module existed. That buys two things:
the code can deploy before the buckets exist (no ordering constraint between a
merge and a console session), and unsetting one variable is a working rollback
after they do. Local dev has no R2 credentials and needs none.
"""
import logging
import os
import re
import threading
from urllib.parse import quote

logger = logging.getLogger(__name__)

# The two stores, named by role rather than by bucket: the bucket names are
# configuration, these are not.
PLAYS = "plays"
GAMES = "games"

# R2's S3 endpoint is account-scoped and region-less. "auto" is the literal
# region R2 expects in the SigV4 scope; it is not a placeholder.
#
# NOT the bucket's location hint. A bucket created in "US" or "Eastern North
# America" is still signed for `auto` — the hint decides where Cloudflare puts
# the bytes and never appears in the signature. Signing with a real region name
# is rejected outright.
_R2_REGION = "auto"

# A bucket created in a JURISDICTION is a different matter: it is not reachable
# on the account's default S3 host at all, and the jurisdiction goes in the
# hostname — `<account>.us.r2.cloudflarestorage.com`. The default jurisdiction
# has no segment.
#
# This cost an evening to find, because R2 reports it as `AccessDenied` on a
# bucket you can see in the dashboard and that your token is scoped to: from
# the default host the bucket simply is not there, and R2 will not say so.
# Neither the credentials nor the token scope are wrong, which is exactly what
# makes every other hypothesis look plausible first.
#
# Constrained to a hostname label because that is where it is interpolated. An
# unset value is the default jurisdiction and the endpoint we always built.
_JURISDICTION_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$")


class ObjectStoreError(RuntimeError):
    """An upload failed. Callers translate this into their own 502 or fallback."""


class NotConfigured(ObjectStoreError):
    """`put()` was called with no R2 credentials. Guard with `configured()`."""


class _Config:
    """The env-derived settings, read once and re-readable by `reload()`."""

    __slots__ = (
        "account_id",
        "access_key_id",
        "secret_access_key",
        "buckets",
        "bases",
        "jurisdiction",
        "jurisdiction_valid",
    )

    def __init__(self) -> None:
        env = os.environ.get
        self.account_id = (env("R2_ACCOUNT_ID") or "").strip()
        # Optional, and empty means the default jurisdiction. A value that is
        # not a hostname label is dropped rather than interpolated: the result
        # would be an unresolvable or — worse — an attacker-chosen host, and
        # `ready()` below then reports the store unusable so the API keeps
        # writing to Supabase instead of somewhere unintended.
        juris = (env("R2_JURISDICTION") or "").strip().lower()
        self.jurisdiction_valid = not juris or bool(_JURISDICTION_RE.match(juris))
        if not self.jurisdiction_valid:
            logger.error(
                "R2_JURISDICTION=%r is not a hostname label; R2 left unconfigured", juris
            )
        self.jurisdiction = juris if self.jurisdiction_valid else ""
        self.access_key_id = (env("R2_ACCESS_KEY_ID") or "").strip()
        self.secret_access_key = (env("R2_SECRET_ACCESS_KEY") or "").strip()
        self.buckets = {
            PLAYS: (env("R2_PLAYS_BUCKET") or "").strip(),
            GAMES: (env("R2_GAMES_BUCKET") or "").strip(),
        }
        # Trailing slash stripped here so `public_url` can join with exactly
        # one. A base is a scheme and host — `https://img.bgbuddy.app` — and a
        # path prefix on it would work too, which is why nothing validates the
        # shape beyond emptiness.
        self.bases = {
            PLAYS: (env("R2_PLAYS_PUBLIC_BASE") or "").strip().rstrip("/"),
            GAMES: (env("R2_GAMES_PUBLIC_BASE") or "").strip().rstrip("/"),
        }

    def ready(self, kind: str) -> bool:
        """Whether `kind` has everything needed to both write and be read back.

        The public base is part of this. Credentials without it would upload
        successfully and then store an unusable URL, which is worse than not
        uploading: the bytes are in the right place and the row points nowhere.
        """
        return bool(
            self.account_id
            and self.access_key_id
            and self.secret_access_key
            and self.buckets.get(kind)
            and self.bases.get(kind)
            and self.jurisdiction_valid
        )

    def endpoint(self) -> str:
        """The S3 host to sign for. See _JURISDICTION_RE for why this varies."""
        label = f".{self.jurisdiction}" if self.jurisdiction else ""
        return f"https://{self.account_id}{label}.r2.cloudflarestorage.com"


_lock = threading.Lock()
_cfg = _Config()
_client = None


def reload() -> None:
    """Re-read the environment and drop the cached client.

    Exists for tests, which need to flip between configured and unconfigured
    in one process. A real config change arrives as a service restart.
    """
    global _cfg, _client
    with _lock:
        _cfg = _Config()
        _client = None


def configured(kind: str | None = None) -> bool:
    """Whether R2 is usable — for one store, or for both if `kind` is None."""
    if kind is None:
        return all(_cfg.ready(k) for k in (PLAYS, GAMES))
    return _cfg.ready(kind)


def _s3():
    """The shared boto3 S3 client, built on first use.

    Imported here rather than at module scope so an unconfigured process —
    local dev, or a deploy that predates the buckets — never pays for
    boto3's import and does not require it to be installed at all.

    One client, shared across threads: botocore clients are safe to call
    concurrently, and each one costs a session, a credential resolution and a
    loaded service model. The uploads run under `asyncio.to_thread`, so this
    is reached from several threads at once and the lock covers construction
    only.
    """
    global _client
    with _lock:
        if _client is None:
            import boto3
            from botocore.config import Config

            _client = boto3.client(
                "s3",
                endpoint_url=_cfg.endpoint(),
                aws_access_key_id=_cfg.access_key_id,
                aws_secret_access_key=_cfg.secret_access_key,
                region_name=_R2_REGION,
                config=Config(
                    region_name=_R2_REGION,
                    signature_version="s3v4",
                    # Virtual-host addressing would resolve
                    # `<bucket>.<account>.r2.cloudflarestorage.com`, which R2
                    # does not serve. Path style is not a preference here.
                    s3={"addressing_style": "path"},
                    # botocore ≥1.36 adds a CRC32 checksum to every PUT by
                    # default. R2 accepts it, but it buys nothing over the TLS
                    # and SigV4 integrity already on the wire and has been a
                    # recurring source of breakage across S3-compatible
                    # providers. Off unless an operation requires it.
                    request_checksum_calculation="when_required",
                    response_checksum_validation="when_required",
                    retries={"max_attempts": 3, "mode": "standard"},
                    # A request thread is a FastAPI worker thread. Bounded so a
                    # sulking endpoint fails the upload instead of holding the
                    # thread for the client's default 60s.
                    connect_timeout=5,
                    read_timeout=20,
                ),
            )
    return _client


def public_base(kind: str) -> str:
    """The origin `public_url` builds on for `kind`, or "" when unconfigured.

    For callers that want to SHORTEN a stored URL back to its key rather than
    build one — the search index strips this prefix off every cover so a
    thousand rows do not each carry the same forty-character origin.
    """
    return _cfg.bases.get(kind) or ""


def public_url(kind: str, path: str) -> str:
    """The URL a browser loads for `path` — what gets stored in the row.

    `quote` keeps `/` intact (the plays layout is a directory per user) and
    escapes anything else that would be ambiguous in a URL. Today's keys are
    hex, digits and underscores, so this is insurance rather than a fix.
    """
    base = _cfg.bases.get(kind)
    if not base:
        raise NotConfigured(f"No public base configured for {kind!r}")
    return f"{base}/{quote(path.lstrip('/'), safe='/')}"


def put(
    kind: str,
    path: str,
    data: bytes,
    content_type: str,
    cache_control: str | None = None,
) -> str:
    """Upload `data` to `kind` at `path`; returns the URL to store.

    Overwrites, matching the Supabase call it replaces (`upsert: true`). Both
    layouts rely on it: a cover re-import rewrites `{bgg_id}_{kind}.{ext}`, and
    a retried photo upload rewrites its own uuid path with identical bytes.

    No ACL argument. R2 has no per-object ACLs — an object is public because a
    custom domain is attached to its bucket, and passing `ACL=` to R2 is an
    error, not a no-op.
    """
    if not _cfg.ready(kind):
        raise NotConfigured(f"R2 is not configured for {kind!r}")

    extra = {"ContentType": content_type}
    if cache_control:
        extra["CacheControl"] = cache_control
    try:
        _s3().put_object(
            Bucket=_cfg.buckets[kind],
            Key=path.lstrip("/"),
            Body=data,
            **extra,
        )
    except Exception as exc:  # botocore raises ClientError, BotoCoreError, …
        # The bucket and the jurisdiction ride along because without them an
        # `AccessDenied` here is unactionable: it is the same error for a
        # mis-scoped token, a bucket that does not exist, and a jurisdiction
        # bucket addressed on the default host — and the last of those is a
        # missing env var, not a Cloudflare problem. Naming what was actually
        # signed for turns three hypotheses into one line.
        #
        # The account id is deliberately NOT in here. It would make the
        # message a complete endpoint and this string ends up pasted into bug
        # reports; the jurisdiction is the part that varies and the part that
        # has been wrong.
        raise ObjectStoreError(
            f"R2 put failed for {kind}/{path} "
            f"[bucket={_cfg.buckets[kind]} jurisdiction={_cfg.jurisdiction or '(default)'}]"
            f": {exc}"
        ) from exc
    return public_url(kind, path)


# An account can hold a lot of photos but not an unbounded number, and a
# TRUNCATED DELETE IS THE FAILURE THIS FUNCTION EXISTS TO PREVENT — it would
# report success over objects it left behind, on the one path where "we
# deleted your data" is a promise rather than a status. So `delete_prefix`
# takes no page ceiling, unlike `usage()`, which can honestly report a floor.
# The bound that does apply is S3's: 1000 keys per DeleteObjects call.
_DELETE_BATCH = 1000


def delete_prefix(kind: str, prefix: str) -> int:
    """Delete every object under `prefix` in `kind`; returns how many went.

    The one caller is account deletion, which passes `f"{user_id}/"` against
    PLAYS — the plays layout is `{user_id}/{uuid4hex}.{ext}`, so that prefix
    is exactly one account's photos and nothing else. GAMES is a cache of
    public cover art keyed by BGG id, shared across every account, and must
    never be handed a prefix from a user id.

    THE TRAILING SLASH IS REQUIRED, and this is the whole safety story. S3
    prefix matching is a string prefix, not a path prefix: `"abc"` also
    matches `abcdef/photo.jpg`, so a caller that forgot the slash would delete
    another account's photos whenever one uid happened to prefix another. An
    empty prefix would match the entire bucket. Both raise rather than run.

    Raises `NotConfigured` when R2 is not set up for `kind` — callers that
    treat that as "nothing to do" must check `configured()` first, because
    here it means the delete did not happen and the objects may still exist.
    Any other failure raises `ObjectStoreError`; a partial delete is reported
    as a failure with the count that did land in the message, since the caller
    can safely re-run it.
    """
    if not _cfg.ready(kind):
        raise NotConfigured(f"R2 is not configured for {kind!r}")

    key_prefix = (prefix or "").lstrip("/")
    if not key_prefix or not key_prefix.endswith("/"):
        raise ObjectStoreError(
            f"delete_prefix refuses {prefix!r}: a prefix must be non-empty and "
            "end in '/' so it cannot match a sibling key"
        )

    bucket = _cfg.buckets[kind]
    deleted = 0
    try:
        s3 = _s3()
        batch: list[dict] = []
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=bucket, Prefix=key_prefix):
            for obj in page.get("Contents") or ():
                batch.append({"Key": obj["Key"]})
                if len(batch) >= _DELETE_BATCH:
                    deleted += _delete_batch(s3, bucket, batch)
                    batch = []
        if batch:
            deleted += _delete_batch(s3, bucket, batch)
    except ObjectStoreError:
        raise
    except Exception as exc:
        # Same error shape as put(): name the bucket and the jurisdiction,
        # never the account id. `AccessDenied` here is most likely a token
        # scoped to read and write but not delete.
        raise ObjectStoreError(
            f"R2 delete failed under {kind}/{key_prefix} after {deleted} object(s) "
            f"[bucket={bucket} jurisdiction={_cfg.jurisdiction or '(default)'}]"
            f": {exc}"
        ) from exc
    return deleted


def _delete_batch(s3, bucket: str, batch: list[dict]) -> int:
    """One DeleteObjects call; returns how many keys it removed.

    `Quiet=True` suppresses the per-key success entries and leaves `Errors`,
    which is the only part worth reading. A DeleteObjects that reports errors
    comes back HTTP 200, so not inspecting them is how a partial delete gets
    counted as a whole one.
    """
    resp = s3.delete_objects(
        Bucket=bucket, Delete={"Objects": batch, "Quiet": True}
    )
    errors = resp.get("Errors") or ()
    if errors:
        first = errors[0]
        raise ObjectStoreError(
            f"{len(errors)} of {len(batch)} key(s) would not delete; first: "
            f"{first.get('Key')} ({first.get('Code')} {first.get('Message')})"
        )
    return len(batch)


# The page ceiling on `usage()`. 100 pages x 1000 keys is 100k objects, which
# is far above either bucket today and still only ~100 round trips in the worst
# case. Past it the walk stops and reports what it has as a FLOOR rather than
# running until the request times out — the admin screen renders "≥ N" for a
# truncated bucket, which is a true statement, where a silent partial sum is
# not.
_USAGE_MAX_PAGES = 100


def usage() -> dict:
    """Object count and total bytes per bucket, for the admin Usage spoke.

    The module header says there are two operations and no list. This is the
    third, and it is a read of METADATA only — `ListObjectsV2` returns keys and
    sizes, never bytes — so the argument there (reads never come through the
    API; an image is an `<img src>` and nothing more) is untouched. What this
    answers is "how much are we storing", which nothing else could.

    Returns, per store key (`plays` / `games`):

        {"configured": bool, "objects": int, "bytes": int,
         "truncated": bool, "error": str | None}

    Three deliberate shapes:

    * **Unconfigured is not an error.** `configured: False` with zeroes, the
      same stance as `configured()` and `put()`'s Supabase fallback — local dev
      has no R2 credentials and needs none, and the screen renders a "not
      configured" state rather than a failure.
    * **A failure is PER BUCKET.** Cover art and play photos are separate
      buckets with separate permissions, so a token that cannot list one can
      still list the other. Raising would hide the number that did come back.
    * **It needs `ListBucket` on the token.** An R2 "Object Read & Write" token
      has it; a write-only one does not, and R2 reports the difference as
      `AccessDenied` — the same string a missing `R2_JURISDICTION` produces
      (see `put()`), so the error text names the bucket it was signing for.

    Synchronous and blocking, like `put()`: callers hand it to
    `asyncio.to_thread`. The result is cached by the caller, not here — this
    module holds no clock.
    """
    out: dict[str, dict] = {}
    for kind in (PLAYS, GAMES):
        entry = {
            "configured": False,
            "objects": 0,
            "bytes": 0,
            "truncated": False,
            "error": None,
        }
        out[kind] = entry
        # `ready()` also demands a public base, which listing does not need —
        # but a bucket whose contents cannot be served is not a bucket this app
        # is using, so reporting its size would be misleading rather than
        # helpful. Same gate as every other caller, deliberately.
        if not _cfg.ready(kind):
            continue
        entry["configured"] = True
        bucket = _cfg.buckets[kind]
        try:
            paginator = _s3().get_paginator("list_objects_v2")
            pages = 0
            for page in paginator.paginate(Bucket=bucket):
                pages += 1
                for obj in page.get("Contents") or ():
                    entry["objects"] += 1
                    entry["bytes"] += obj.get("Size") or 0
                if pages >= _USAGE_MAX_PAGES:
                    entry["truncated"] = True
                    break
        except Exception as exc:
            # Same reasoning as put()'s error text: name the bucket and the
            # jurisdiction, never the account id.
            entry["error"] = (
                f"list failed [bucket={bucket} "
                f"jurisdiction={_cfg.jurisdiction or '(default)'}]: {exc}"
            )
            logger.warning("R2 usage() failed for %s: %s", kind, exc)
    return out
