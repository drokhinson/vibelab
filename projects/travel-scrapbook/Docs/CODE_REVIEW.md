# Travel Scrapbook — Code Review: Dead Code & Entry-Point Discoverability

A review of `projects/travel-scrapbook/web/` (frontend) and
`shared-backend/routes/travel_scrapbook/` (backend) for dead / unreachable code
and for feature entry points that are hard for a user to find. Every claim cites
code as `path:line` so it can be jumped to and verified.

> **Status:** Reviewed and cleaned up 2026-07-18. All confirmed-dead code
> deleted, the orphaned route RPCs dropped (migration 022), and the timeline's
> hidden actions given a visible affordance. See the **Cleanup log** at the
> bottom for the exact set of changes. Findings left as flag-only (no code
> change) are called out inline.

The app evolved quickly: route optimization moved from a backend endpoint + a
conditional "Route panel" to an always-on, client-computed Timeline; manual
place entry was removed; and the trip-bundle RPC absorbed several standalone
reads. Each migration left orphans behind. This review swept them up.

---

## 1. The "only visible with 2+ plans" element

The element the reviewer remembered — an entry point that only appeared once a
trip had two or more plans — was the **old Route panel** and its **"Sort my
route" button** (`ui/route-panel.js`, gated `if (geocodedCount < 2 && !route)
return ''`). It was replaced by the always-on, auto-computed **Timeline** and
fully deleted from the tree back in the "Unified route timeline" change; it now
lives only in git history (last present at commit `c80de06^`). So there was
nothing left to delete here — the migration was already complete.

Its last cosmetic vestige was the route-summary line in `ui/trip-timeline.js`,
gated `stopCount >= 2`. That gate is softened (§4) so a one-stop trip still shows
a banner.

---

## 2. Dead / unreachable frontend code (removed)

| Finding | Location | Disposition |
|---|---|---|
| `NotePopup` widget + its 3 `action==='notes'` handler branches | `widgets/note-popup.js`; `views/trip-view.js`, `inbox-view.js`, `visited-view.js` | **Deleted.** No card renders `data-action="notes"` — note editing moved into the editor / `PlanPopup`. |
| Inbox `action==='assign'` branch | `views/inbox-view.js` | **Deleted.** `data-action="assign"` is emitted only by the `candidate` card variant (`ui/scrap-card.js:255`), which the inbox never renders. |
| `renderTripCard` `variant:'row'` branch | `ui/trip-card.js` | **Deleted.** Only ever called with the default `'card'` (`views/trips-view.js`). |
| Grouped-list system: `renderGroupedList` / `renderScrapGroups` / `renderGroupByToggle` / `availableGroupDims` / `bindScrapGroups` / `GROUP_DIMS` | `ui/scrap-groups.js` | **Deleted.** No external callers. Only `groupScraps` + `GROUP_NONE` survive — used by `ui/plan-zones.js`. |
| `renderCategoryBadge` | `ui/category-badge.js` | **Deleted.** `TypeBubble` in the same file is live (`ui/scrap-card.js:122`) and stays. |
| `RouteDomain.downloadCsv` | `domain/route.js` | **Deleted.** `ExportMenu` calls `ExportDomain.downloadCsv` directly. `RouteDomain.mapsLinks` is live and stays. |
| `api.getScrap` / `api.listScraps` / `api.tripCandidates` / `api.tripTimeline` | `domain/api.js` | **Deleted** (paired with the backend endpoint removals in §3). `api.health` kept. |
| Orphaned CSS: `.scrap-group*`, `.category-badge`, dead `.note-chip__plus` / `.note-chip:hover` | `styles.css` | **Deleted.** `.note-chip` base / `.is-filled` / `span.note-chip` kept (live read-only chip). |

**Investigated and KEPT (looked dead, isn't):**

- `_renderRatingBadge` (`ui/scrap-card.js:59`) + `.rating-badge*` CSS — reachable
  via `variant:'select'` cards in the add-plans picker (`widgets/add-plans.js`),
  where a rated Wander-List place shows its read-only badge.
- `services/optimizer.py` — see §3; still imported by `services/places.py`.

---

## 3. Dead / unreachable backend code (removed)

The web app talks to the backend only through `web/domain/api.js`; only the iOS
Shortcut hits the backend directly, and only via `POST /capture`. Endpoints the
web app never calls and that no other client needs were removed.

| Endpoint / symbol | Location | Disposition |
|---|---|---|
| `POST /trips/{id}/route/optimize` | `route_routes.py` (whole file) | **Deleted.** Route ordering is client-side (`web/domain/route-plan.js`). |
| ↳ exclusive service | `services/route_planner.py` | **Deleted** (imported only by the above). |
| `GET /trips/{id}/timeline` | `timeline_routes.py` (whole file) | **Deleted.** Timeline math is client-side (`web/domain/timeline.js`). |
| ↳ exclusive service + models | `services/timeline.py`, `models/timeline.py` | **Deleted.** |
| `GET /trips/{id}/scraps`, `GET /trips/{id}/candidates` | `plan_routes.py` | **Deleted.** The trip-bundle RPC delivers plans + candidates inline. The now-orphaned `_dismissed_scrap_ids` helper went too. |
| `GET /scraps/{id}` | `scrap_routes.py` | **Deleted.** |
| Route/timeline models | `models/trip.py` (`RouteOptimize*`, `RouteLeg`), `models/timeline.py` | **Deleted** + pruned from `models/__init__.py`. |
| `geo_facets`, `geo_match` | `services/places.py` | **Deleted.** Zero callers (filtering moved into SQL RPCs). |
| `ScrapRating = TripVibe` alias | `constants.py` | **Deleted.** Never imported. |
| Unused imports | `services/hydrate.py` (`Optional`), `source_routes.py` (`CapturedVia`, `MembershipStatus`), `community_routes.py` (`MembershipStatus`) | **Deleted.** |

**KEPT:** `GET /health` (liveness probe); `services/optimizer.py` (imported by
`places.py`); all shared helpers (`get_owned_scrap`, `_hydrated_scrap`,
`membership_rows_to_scraps`, `checkpoint_category_slugs`, `_trip_memberships`,
`_trip_scrap_ids`, `_record_dismissals`) confirmed still used elsewhere.

**Deferred (flag-only):** `ScrapStatus.INBOX` (`constants.py`) — no code assigns
it, but removing the enum member risks a validation error if a legacy
`scraps.status='inbox'` row is ever deserialized. Drop it in a separate change
gated on `SELECT DISTINCT status` returning no `inbox` rows.

### Dead database objects (migration 022)

- `travelscrapbook_set_route_plan(UUID, JSONB)` — only caller was the deleted
  `/route/optimize` endpoint.
- `travelscrapbook_set_route_positions(JSONB)` — superseded by `set_route_plan`
  back in migration 017; dead since.

Both **dropped** in `db/migrations/travelscrapbook/022_drop_route_rpcs.sql`;
`db/functions/travelscrapbook.sql` inventory updated. The `route_position`
column and its readers are untouched — only the unused write path is gone.

---

## 4. Hard-to-find feature entry points

| Feature | Where the entry point was | Assessment / disposition |
|---|---|---|
| Timeline **schedule / move-to-day / un-anchor** | Gesture-only: swipe + press-and-hold on the drag grip (`widgets/timeline-gestures.js`); the grip's only hint was a hamburger `menu` glyph (`ui/timeline-row.js:96`) that did nothing on tap. | **Fixed.** The grip is now a visible ⋮ (`ellipsis-vertical`) actions button wired to the existing `open-plan` handler → `PlanPopup`, which already exposes day/time (anchor), the day picker (move-to-day), notes, and "Let the route decide" (un-anchor). Press-and-hold still drags. |
| Timeline **route summary** | Shown only at `stopCount >= 2` (`ui/trip-timeline.js`). | **Fixed.** A one-stop trip now shows "1 stop · times are estimates"; the `Route ≈ N km` distance still needs ≥2 located stops to measure between. |
| "Open in Google Maps" directions | Disabled below 2 pins (`widgets/export-menu.js:72`). | **Flag-only, no change.** Correct — directions need two points; the hint copy already reads true. |
| Community search | Nested behind the add-plans modal's segmented toggle (`widgets/add-plans.js:76`). | **Flag-only.** Acceptable; a future enhancement could surface a "Search community" hint on the empty Wander-List state. |
| Geo "zones" grouping of plans | Auto-activates only when a dimension yields ≥2 groups (`ui/plan-zones.js:52`); otherwise a plain grid. | **Flag-only.** Intended, silent behavior. |

Other count/state-gated surfaces that are working as designed (shared-trip vibe
chips, the "Needs review" staging section, "Suggested plans", checkpoint gap
placeholders) were reviewed and left as-is — each is a legitimately
context-dependent surface, not a hidden entry point.

---

## 5. Cleanup log (2026-07-18)

Commits on `claude/travel-scrapbook-code-review-nflvcu`:

1. **remove dead frontend code** — §2 deletions (NotePopup, dead handler
   branches, grouped-list system, `renderCategoryBadge`, `RouteDomain.downloadCsv`,
   4 `api.js` methods, orphaned CSS) + the `note-popup.js` `<script>` tag.
2. **remove dead backend code** — §3 deletions (route/optimize + timeline
   endpoints & their exclusive services/models, `/scraps` + `/candidates` +
   `/scraps/{id}`, `geo_facets`/`geo_match`, `ScrapRating`, unused imports),
   de-registered in `__init__.py`.
3. **drop orphaned route-write RPCs (migration 022)** — §3 database objects.
4. **surface hidden timeline actions via a visible ⋮ button** — §4 timeline
   entry-point fix + route-summary gate.

**Verification:** grep gates confirm zero live references to every deleted
symbol/module; `py_compile` passes on the whole backend package; `node --check`
passes on every changed JS file; a sandbox render test of `_tlPlanRow` confirms
the new ⋮ button (open-plan action, `ellipsis-vertical` icon, accessible label,
balanced tags) and that read-only rows omit it. Migration 022 must be run in the
Supabase SQL editor to take effect in the shared DB.
