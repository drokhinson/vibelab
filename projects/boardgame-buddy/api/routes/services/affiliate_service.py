"""Affiliate partners — retailer links under a game, and the switch that keeps
them off until an operator has set them up.

THE LIVE RULE IS THE WHOLE MODULE. A partner renders only when

    enabled AND (tracking_tag OR wrapper_template)

and it is applied in exactly one place (`AffiliatePartner.live`, read by
`list_live`), so a game page, the Discover footer and the admin list cannot
disagree about whether a retailer is on. Every seeded row (migration 046) is
disabled with no credential; `set_enabled(True)` refuses a row with neither.

ONE URL WRITER. `build_url` is the only code that turns a partner row and a
game into a link: {query} and {tag} substituted into the store URL, a
dangling `tag=` stripped when there is no tag, then the whole thing wrapped
in the network redirect when there is one. The admin editor's Preview calls
the same function, so what the operator checks is what a reader gets.

THE CLICK LOG CARRIES NO USER. Privacy §5 promises usage records carry no
account identifier; a retailer tap is one. partner + game + surface + time.
"""

from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote, quote_plus

from fastapi import HTTPException
from supabase import Client

import cache

from ..constants import AffiliateSurface
from ..models import (
    AffiliateClickCount,
    AffiliateClickSummary,
    AffiliateLink,
    AffiliateLinkListResponse,
    AffiliateLinkPreview,
    AffiliatePartner,
    AffiliatePartnerPatchRequest,
)

_TABLE = "boardgamebuddy_affiliate_partners"
_CLICKS = "boardgamebuddy_affiliate_clicks"
_COLUMNS = (
    "id,label,url_template,wrapper_template,tracking_tag,disclosure,notes,"
    "display_order,enabled,updated_at"
)

# The partner list is read on every game page. Ten minutes in-process, and
# every admin write clears it, so a toggle lands on the next page open rather
# than the next deploy.
_NS = "affiliate.partners"
_TTL_S = 10 * 60
_KEY = "all"
cache.configure(_NS, max_entries=2)


def _row(raw: dict[str, Any]) -> AffiliatePartner:
    return AffiliatePartner(**{k: raw.get(k) for k in AffiliatePartner.model_fields})


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── The URL writer ────────────────────────────────────────────────────────────

def _strip_empty_tag(url: str) -> str:
    """Drop a `tag=` parameter left empty by a missing tracking tag.

    `…/s?k=Catan&tag=` → `…/s?k=Catan`; `…?tag=&k=Catan` → `…?k=Catan`. A
    partner with a wrapper but no tag would otherwise send Amazon a blank tag,
    which reads as a malformed link rather than an untracked one.
    """
    if "tag=" not in url:
        return url
    base, _, query = url.partition("?")
    if not query:
        return url
    parts = [p for p in query.split("&") if p and p != "tag="]
    return base + ("?" + "&".join(parts) if parts else "")


def build_url(partner: AffiliatePartner, *, game_name: str) -> str:
    """The link a pill carries. Pure; the editor's preview calls it too."""
    query = quote_plus((game_name or "").strip())
    tag = (partner.tracking_tag or "").strip()
    resolved = partner.url_template.replace("{query}", query).replace("{tag}", quote_plus(tag))
    if not tag:
        resolved = _strip_empty_tag(resolved)
    wrapper = (partner.wrapper_template or "").strip()
    if wrapper:
        if "{url}" in wrapper:
            return wrapper.replace("{url}", quote(resolved, safe=""))
        # A wrapper with no {url} is a bare tracking link that lands on the
        # store's front page — still a valid affiliate link, so honour it.
        return wrapper
    return resolved


# ── Reads ─────────────────────────────────────────────────────────────────────

def list_all(sb: Client) -> list[AffiliatePartner]:
    """Every partner, live or not, in display order — the admin list."""
    cached = cache.get(_NS, _KEY)
    if cached is not None:
        return cached
    res = (
        sb.table(_TABLE)
        .select(_COLUMNS)
        .order("display_order")
        .order("id")
        .execute()
    )
    rows = [_row(r) for r in (res.data or [])]
    cache.set(_NS, _KEY, rows, ttl_seconds=_TTL_S)
    return rows


def list_live(sb: Client) -> list[AffiliatePartner]:
    return [p for p in list_all(sb) if p.live]


def get(sb: Client, partner_id: str) -> AffiliatePartner:
    for p in list_all(sb):
        if p.id == partner_id:
            return p
    raise HTTPException(status_code=404, detail="Affiliate partner not found")


def _game_name(sb: Client, game_id: str) -> str | None:
    res = sb.table("boardgamebuddy_games").select("id,name").eq("id", game_id).limit(1).execute()
    rows = res.data or []
    return rows[0].get("name") if rows else None


def links_for_game(sb: Client, game_id: str) -> AffiliateLinkListResponse:
    """What a game page renders. Empty and `live: false` until a partner is on."""
    live = list_live(sb)
    if not live:
        return AffiliateLinkListResponse(game_id=game_id, links=[], live=False)
    name = _game_name(sb, game_id)
    if not name:
        raise HTTPException(status_code=404, detail="Game not found")
    return AffiliateLinkListResponse(
        game_id=game_id,
        links=[
            AffiliateLink(
                partner_id=p.id,
                label=p.label,
                url=build_url(p, game_name=name),
                disclosure=(p.disclosure or "").strip() or None,
            )
            for p in live
        ],
        live=True,
    )


def preview(sb: Client, partner_id: str, game_id: str | None) -> AffiliateLinkPreview:
    """The editor's check: the URL as it stands, whether or not the row is live."""
    p = get(sb, partner_id)
    name = (_game_name(sb, game_id) if game_id else None) or "Wingspan"
    return AffiliateLinkPreview(
        partner_id=p.id, game_name=name, url=build_url(p, game_name=name), live=p.live
    )


# ── Admin writes ──────────────────────────────────────────────────────────────

def _invalidate() -> None:
    cache.clear(_NS)


def update(sb: Client, partner_id: str, patch: AffiliatePartnerPatchRequest) -> AffiliatePartner:
    """Edit the templates, credentials and copy. Never touches `enabled`."""
    changes: dict[str, Any] = {"updated_at": _now()}
    if patch.label is not None:
        changes["label"] = patch.label.strip()
    if patch.url_template is not None:
        changes["url_template"] = patch.url_template.strip()
    if patch.notes is not None:
        changes["notes"] = patch.notes.strip() or None
    if patch.display_order is not None:
        changes["display_order"] = patch.display_order
    if patch.clear_tag:
        changes["tracking_tag"] = None
    elif patch.tracking_tag is not None:
        changes["tracking_tag"] = patch.tracking_tag.strip() or None
    if patch.clear_wrapper:
        changes["wrapper_template"] = None
    elif patch.wrapper_template is not None:
        changes["wrapper_template"] = patch.wrapper_template.strip() or None
    if patch.clear_disclosure:
        changes["disclosure"] = None
    elif patch.disclosure is not None:
        changes["disclosure"] = patch.disclosure.strip() or None

    res = sb.table(_TABLE).update(changes).eq("id", partner_id).execute()
    rows = res.data or []
    _invalidate()
    if not rows:
        raise HTTPException(status_code=404, detail="Affiliate partner not found")
    return _row(rows[0])


def set_enabled(sb: Client, partner_id: str, enabled: bool) -> AffiliatePartner:
    """The switch. Turning a partner ON without a credential is refused —
    an enabled row with no tag and no wrapper would render an untracked link,
    which is the one outcome worse than no link."""
    current = get(sb, partner_id)
    if enabled and not current.has_credential:
        raise HTTPException(
            status_code=422,
            detail="Add a tracking tag or a wrapper link before enabling this partner.",
        )
    res = (
        sb.table(_TABLE)
        .update({"enabled": enabled, "updated_at": _now()})
        .eq("id", partner_id)
        .execute()
    )
    rows = res.data or []
    _invalidate()
    if not rows:
        raise HTTPException(status_code=404, detail="Affiliate partner not found")
    return _row(rows[0])


# ── Clicks ────────────────────────────────────────────────────────────────────

def log_click(sb: Client, partner_id: str, game_id: str | None, surface: AffiliateSurface) -> None:
    """Count a tap. Silently ignores a partner that is not live: a stale page
    can still show a pill for a partner switched off a minute ago, and that
    tap is not a conversion anyone will be paid for."""
    if not any(p.id == partner_id for p in list_live(sb)):
        return
    row: dict[str, Any] = {"partner_id": partner_id, "surface": surface.value}
    if game_id:
        row["game_id"] = game_id
    sb.table(_CLICKS).insert(row).execute()


def click_summary(sb: Client, days: int = 30) -> AffiliateClickSummary:
    """Per-partner tap counts over a window — the admin list's one number."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    res = (
        sb.table(_CLICKS)
        .select("partner_id")
        .gte("clicked_at", since)
        .execute()
    )
    counts: dict[str, int] = {}
    for r in res.data or []:
        counts[r["partner_id"]] = counts.get(r["partner_id"], 0) + 1
    labels = {p.id: p.label for p in list_all(sb)}
    by_partner = [
        AffiliateClickCount(partner_id=pid, label=labels.get(pid, pid), clicks=n)
        for pid, n in sorted(counts.items(), key=lambda kv: -kv[1])
    ]
    return AffiliateClickSummary(days=days, total=sum(counts.values()), by_partner=by_partner)
