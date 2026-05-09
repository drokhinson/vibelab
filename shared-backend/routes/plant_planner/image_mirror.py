"""Mirror plant images from third-party CDNs into Supabase Storage.

Each cache row carries up to three sizes (thumbnail / medium / regular).
Sources:
  - Trefle: returns a single `image_url` → mirror as `regular`.
  - Perenual: returns `default_image.{thumbnail, medium_url, regular_url}` →
    mirror each available size into the matching column.

The UI loads from `image_*_path` (Supabase Storage public URL); the `image_*_url`
columns retain the original CDN URL for re-mirroring if a sync goes stale.

Bucket: `plantplanner-plants` (public read). Object key:
  plants/<scientific_name_slug>/<size>.<ext>
"""

from __future__ import annotations

import logging
import mimetypes
import re
from typing import Any, Dict, Optional

import httpx

from api_logger import log_external_call
from db import get_supabase

logger = logging.getLogger(__name__)

BUCKET = "plantplanner-plants"
SIZE_FIELDS = ("thumbnail", "medium", "regular")
HTTP_TIMEOUT = 10.0


def _slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "plant"


def _ext_from_url(url: str, default: str = "jpg") -> str:
    path = url.split("?", 1)[0].lower()
    for ext in ("jpg", "jpeg", "png", "webp", "gif"):
        if path.endswith(f".{ext}"):
            return ext
    return default


async def _download(url: str) -> Optional[tuple[bytes, str]]:
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT, follow_redirects=True) as client:
            async with log_external_call(
                app="plant-planner", api_name="image-mirror",
                method="GET", url=url,
            ) as record:
                resp = await client.get(url)
                # Record status + size, but skip body_excerpt — these are binary
                # image bytes, not useful as text.
                record.status_code = resp.status_code
                try:
                    record.response_size_bytes = len(resp.content)
                except Exception:
                    record.response_size_bytes = None
            if resp.status_code != 200:
                logger.info("Image fetch %s -> %s", url, resp.status_code)
                return None
            content_type = resp.headers.get("content-type", "")
            if not content_type.startswith("image/"):
                # Some CDNs return HTML 200 for missing images.
                ext = _ext_from_url(url)
                guessed = mimetypes.types_map.get(f".{ext}", "image/jpeg")
                return resp.content, guessed
            return resp.content, content_type
    except httpx.HTTPError as exc:
        logger.info("Image fetch error %s: %s", url, exc)
        return None


async def _upload(object_key: str, blob: bytes, content_type: str) -> Optional[str]:
    """Upload a blob to Supabase Storage. Returns the public URL or None on failure."""
    sb = get_supabase()
    try:
        sb.storage.from_(BUCKET).upload(
            path=object_key,
            file=blob,
            file_options={"content-type": content_type, "upsert": "true"},
        )
    except Exception as exc:  # supabase-py raises on duplicate; upsert flag handles it
        logger.warning("Storage upload failed for %s: %s", object_key, exc)
        return None
    try:
        return sb.storage.from_(BUCKET).get_public_url(object_key)
    except Exception:
        return f"{BUCKET}/{object_key}"


async def mirror_image(scientific_name: str, size: str, source_url: str) -> Optional[str]:
    """Download `source_url` and store under a deterministic key. Returns storage URL or None."""
    if size not in SIZE_FIELDS:
        return None
    if not source_url:
        return None

    fetched = await _download(source_url)
    if fetched is None:
        return None
    blob, content_type = fetched
    ext = _ext_from_url(source_url, default="jpg")
    object_key = f"plants/{_slugify(scientific_name)}/{size}.{ext}"
    return await _upload(object_key, blob, content_type)


async def mirror_all_sizes(cache_row: Dict[str, Any]) -> Dict[str, Optional[str]]:
    """Mirror every available size for a cache row. Returns a dict of `image_<size>_path` → url.

    Only sizes whose `image_<size>_url` is populated and whose `image_<size>_path`
    is empty are mirrored. Already-mirrored sizes are skipped.
    """
    name = cache_row.get("scientific_name") or cache_row.get("common_name") or "plant"
    updates: Dict[str, Optional[str]] = {}
    for size in SIZE_FIELDS:
        url = cache_row.get(f"image_{size}_url")
        existing = cache_row.get(f"image_{size}_path")
        if not url or existing:
            continue
        path = await mirror_image(name, size, url)
        if path:
            updates[f"image_{size}_path"] = path
    return updates
