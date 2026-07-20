"""Best-effort caption recovery for social links that block server fetches.

Instagram/TikTok reels refuse our normal page fetch (a login wall), so without
this the LLM would see only a bare permalink and — told to name the place —
hallucinate a famous default (the "always Rome" bug). Before giving up we try to
recover the post's caption two cheap ways:

  1. the public **oEmbed** endpoints (TikTok's returns the caption as `title`;
     Instagram's usually needs a token now, but it's free to try), then
  2. a **mobile-UA refetch** reading the `og:title` / `og:description` meta tags
     that public reels still expose to a phone user-agent.

Every attempt is wrapped so any failure just returns ``None`` — the caller then
fails the import honestly rather than inventing a place. This never invents
anything; it only surfaces real caption text when a site will part with it.
"""

from typing import TYPE_CHECKING, Optional
from urllib.parse import quote, urlparse

import httpx
from bs4 import BeautifulSoup

from api_logger import log_external_call

from ..constants import APP_NAME
from .scraper import _meta  # reuse the og/meta parser

if TYPE_CHECKING:  # avoid a runtime import cycle; used for annotations only
    from .trace import ImportTrace

HTTP_TIMEOUT = 8.0

# Instagram's mobile web surfaces the caption in og: tags to this UA even
# behind the interstitial that blocks the desktop scraper.
_MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)

# Hosts whose blocked fetches are worth a caption-recovery attempt.
_RECOVERABLE_HOSTS = ("instagram.com", "tiktok.com")


def _host(url: str) -> str:
    return (urlparse(url).hostname or "").lower().removeprefix("www.")


def is_recoverable(url: str) -> bool:
    """True for social hosts whose caption we know how to try to recover."""
    host = _host(url)
    return any(host == h or host.endswith("." + h) for h in _RECOVERABLE_HOSTS)


async def _try_oembed(client: httpx.AsyncClient, url: str) -> Optional[str]:
    """Public oEmbed lookup — TikTok returns the caption in `title`."""
    host = _host(url)
    if "tiktok.com" in host:
        endpoint = "https://www.tiktok.com/oembed?url=" + quote(url, safe="")
    elif "instagram.com" in host:
        endpoint = "https://api.instagram.com/oembed/?url=" + quote(url, safe="")
    else:
        return None
    async with log_external_call(
        app=APP_NAME, api_name="oembed", method="GET", url=endpoint
    ) as record:
        resp = await client.get(endpoint, headers={"Accept": "application/json"})
        record.attach_response(resp)
    if resp.status_code != 200:
        return None
    data = resp.json()
    text = " ".join(
        str(x).strip() for x in (data.get("title"), data.get("author_name")) if x
    ).strip()
    return text or None


async def _try_mobile_og(client: httpx.AsyncClient, url: str) -> Optional[str]:
    """Refetch with a mobile UA and read og: meta — public reels leak the
    caption there ("<author> on Instagram: \"<caption>\"") even when the desktop
    fetch was blocked."""
    async with log_external_call(
        app=APP_NAME, api_name="caption-mobile-og", method="GET", url=url
    ) as record:
        resp = await client.get(
            url, headers={"User-Agent": _MOBILE_UA, "Accept-Language": "en"}
        )
        record.attach_response(resp)
    if resp.status_code >= 400:
        return None
    soup = BeautifulSoup(resp.text, "html.parser")
    parts = [_meta(soup, "og:title"), _meta(soup, "og:description")]
    text = " ".join(p for p in parts if p).strip()
    return text or None


async def recover_caption(
    url: str, trace: "Optional[ImportTrace]" = None
) -> Optional[str]:
    """Try, in order, to recover the post's caption. Returns the first non-empty
    result, or ``None`` when every attempt fails. Records each attempt on the
    trace when one is supplied."""
    attempts: list[dict[str, object]] = []
    caption: Optional[str] = None
    async with httpx.AsyncClient(
        timeout=HTTP_TIMEOUT, follow_redirects=True
    ) as client:
        for name, fn in (("oembed", _try_oembed), ("mobile_og", _try_mobile_og)):
            try:
                result = await fn(client, url)
            except Exception as exc:  # any network/parse failure → just skip it
                attempts.append({"method": name, "ok": False, "error": str(exc)[:200]})
                continue
            attempts.append({"method": name, "ok": bool(result), "caption": result})
            if result:
                caption = result
                break
    if trace is not None:
        trace.add(
            "caption_recovery",
            "Recover caption (site blocked the fetch)",
            {"recovered": bool(caption), "caption": caption, "attempts": attempts},
        )
    return caption
