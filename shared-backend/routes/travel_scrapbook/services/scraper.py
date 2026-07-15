"""Fetch a saved URL and extract page metadata (og: tags + visible text).

Instagram/Reddit/Pinterest frequently refuse non-browser clients or serve a
login wall; callers treat any ScrapeError as "proceed with URL-only context"
rather than a hard failure.
"""

from dataclasses import dataclass
from enum import StrEnum
from typing import Optional

import httpx
from bs4 import BeautifulSoup

from api_logger import log_external_call

from ..constants import APP_NAME

HTTP_TIMEOUT = 15.0
TEXT_EXCERPT_CHARS = 1500

_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


class ScrapeErrorKind(StrEnum):
    NETWORK = "network"   # DNS/timeout/connection failure
    BLOCKED = "blocked"   # 4xx/5xx or login wall — the site refused us


class ScrapeError(Exception):
    def __init__(self, kind: ScrapeErrorKind, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


@dataclass
class PageContent:
    title: Optional[str] = None
    og_title: Optional[str] = None
    og_description: Optional[str] = None
    og_image: Optional[str] = None
    text_excerpt: Optional[str] = None


def _meta(soup: BeautifulSoup, prop: str) -> Optional[str]:
    tag = soup.find("meta", attrs={"property": prop}) or soup.find(
        "meta", attrs={"name": prop}
    )
    if tag and tag.get("content"):
        return tag["content"].strip() or None
    return None


def _visible_text(soup: BeautifulSoup) -> Optional[str]:
    for tag in soup(["script", "style", "noscript", "svg", "nav", "footer"]):
        tag.decompose()
    text = " ".join(soup.get_text(separator=" ").split())
    return text[:TEXT_EXCERPT_CHARS] or None


async def fetch_page(url: str) -> PageContent:
    """Fetch the URL and parse metadata. Raises ScrapeError on failure."""
    async with log_external_call(
        app=APP_NAME,
        api_name="page-fetch",
        method="GET",
        url=url,
    ) as record:
        try:
            async with httpx.AsyncClient(
                timeout=HTTP_TIMEOUT,
                follow_redirects=True,
                headers={"User-Agent": _BROWSER_UA, "Accept-Language": "en"},
            ) as client:
                resp = await client.get(url)
        except httpx.HTTPError as exc:
            raise ScrapeError(ScrapeErrorKind.NETWORK, f"fetch failed: {exc}") from exc

        record.attach_response(resp)
        if resp.status_code >= 400:
            raise ScrapeError(
                ScrapeErrorKind.BLOCKED, f"HTTP {resp.status_code} from {url}"
            )

        content_type = resp.headers.get("content-type", "")
        if "html" not in content_type and "xml" not in content_type:
            raise ScrapeError(
                ScrapeErrorKind.BLOCKED, f"non-HTML content-type: {content_type}"
            )

    soup = BeautifulSoup(resp.text, "html.parser")
    page = PageContent(
        title=(soup.title.get_text().strip() if soup.title else None) or None,
        og_title=_meta(soup, "og:title"),
        og_description=_meta(soup, "og:description"),
        og_image=_meta(soup, "og:image"),
        text_excerpt=_visible_text(soup),
    )
    return page
