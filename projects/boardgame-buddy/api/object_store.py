"""object_store.py — S3-compatible object storage (Cloudflare R2).

Replaces Supabase Storage for image objects. Image bytes are ~93% of this
app's egress and Supabase bills egress; **R2 never does, at any volume**, which
is the entire reason this module exists.

WHAT IS AND IS NOT HERE. Two operations: `put()` and `public_url()`. No read,
no list, no delete. Reads never come through the API at all — the client loads
an absolute URL straight from the row, so an image is an `<img src>` and
nothing more. Delete is absent because nothing deletes an image today; the
privacy policy discloses that, and when it stops being true this module gains
a `delete()` rather than a caller reaching for boto3 itself.

PATHS ARE UNCHANGED FROM THE SUPABASE LAYOUT.
  plays: `{user_id}/{uuid4hex}.{ext}`     games: `{bgg_id}_{kind}.{ext}`
That is deliberate and it is what makes the data migration cheap: the object
key is identical on both sides, so rewriting the stored URLs is one prefix
substitution per column (`038_r2_photo_urls.sql`) rather than a re-key. Do not
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
import threading
from urllib.parse import quote

logger = logging.getLogger(__name__)

# The two stores, named by role rather than by bucket: the bucket names are
# configuration, these are not.
PLAYS = "plays"
GAMES = "games"

# R2's S3 endpoint is account-scoped and region-less. "auto" is the literal
# region R2 expects in the SigV4 scope; it is not a placeholder.
_R2_REGION = "auto"


class ObjectStoreError(RuntimeError):
    """An upload failed. Callers translate this into their own 502 or fallback."""


class NotConfigured(ObjectStoreError):
    """`put()` was called with no R2 credentials. Guard with `configured()`."""


class _Config:
    """The env-derived settings, read once and re-readable by `reload()`."""

    __slots__ = ("account_id", "access_key_id", "secret_access_key", "buckets", "bases")

    def __init__(self) -> None:
        env = os.environ.get
        self.account_id = (env("R2_ACCOUNT_ID") or "").strip()
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
        )


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
                endpoint_url=f"https://{_cfg.account_id}.r2.cloudflarestorage.com",
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
        raise ObjectStoreError(f"R2 put failed for {kind}/{path}: {exc}") from exc
    return public_url(kind, path)
