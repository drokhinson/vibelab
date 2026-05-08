# PlantPlanner Iteration Log

Append-only log written by `/plant-planner-iterate`. One entry per iteration cycle. Persona ratings come from the Explore agents that critique the app state at the start (`pre`) and end (`post`) of each cycle.

## Personas

- **hobby** — casual home gardener; cares about visual realism and plain-language guidance
- **wildflower** — native-species + pollinator focus; cares about hardiness zones, monthly bloom calendar, year-over-year growth
- **food** — yield-focused vegetable gardener; cares about companion rules, days-to-harvest, real-radius placement, height for harvest reach, container types, succession/rotation

## Halt criteria

- All three personas rate ≥4/5 AND `still_unmet` empty → converged
- Iteration count reaches the cap (default 6) → cap reached
- Validation fails twice in one cycle → broken, halt for human

---

<!-- Iterations are appended below this line. Format:

## Iteration N — <title> — <short SHA>
Persona ratings (pre): hobby=X/5, wildflower=Y/5, food=Z/5
Persona ratings (post): hobby=X/5, wildflower=Y/5, food=Z/5
Shipped:
  - <bullet>
Hobby unmet: <bullets or "satisfied">
Wildflower unmet: <bullets or "satisfied">
Food unmet: <bullets or "satisfied">
Notes: <UI/UX rationale + deferred conflicts>

-->

## Iteration 1 — Compressed Catalog + Rich Plant Knowledge — ff16ec2
Persona ratings (pre): hobby=2/5, wildflower=1/5, food=2/5
Persona ratings (post): hobby=4/5, wildflower=2/5, food=2/5
Shipped:
  - Catalog filter sidebar: 3 dropdowns replaced with full-width search input + horizontally-scrolling chip row (`Native | Pollinators | Sun | Shade | Spring | Summer | Fall | Edible | Flower | Herb`). Sidebar header drops from ~144px to ~80px.
  - `plantplanner_plants` enriched with 6 columns: `bloom_months int[]`, `native bool`, `usda_zones int4range`, `pollinator_attracts text[]`, `water_need text` (low/medium/high check), `care_summary text`.
  - `plantplanner_gardens` gains `usda_zone text`. Garden header now shows a `Zone: 6b ▾` chip with a popover picker; selection persists via `PUT /gardens/{id}`.
  - Catalog reseeded with ~40 plants: 15 NA natives, 10 edibles, 15 ornamentals/herbs. All new columns populated.
  - `GET /plants` response shape extended; `usda_zones` serializes as `{min, max}` (parser normalizes Postgres int4range half-open form).
  - Plant tiles gain a native-leaf badge (top-left) and up to 3 pollinator icons (bottom-right). Click on tile opens a 320px slide-in plant detail panel: full name, plain-language care line, mini 12-dot bloom strip (J-D), pollinator row, "Hardy in zones X–Y", description. Esc / backdrop / close button dismiss.
  - "Native to your zone" filter combines the Native chip with the garden's `usda_zone` numeric portion against `usda_zones` range.
Hobby unmet: companion-planting warnings (deferred to iter 2 — hobby's only remaining ask).
Wildflower unmet: full 12-month bloom calendar strip aligned under the 3D render (mini strip ships in detail panel only); year 1 / 2 / 3+ growth timeline.
Food unmet: companion-planting rules with adjacency warnings (iter 2); real-radius placement with spread-circle rendering (iter 3).
Notes: UI/UX picked the bundle that touched the most personas at once — the filter compression (hobby+wildflower) and the data-model enrichment (all three) both centered on the catalog sidebar surface. Companion rules and radius placement explicitly deferred since each is a self-contained feature that warrants its own iteration. Filter sidebar constraint honored: ~80px header < the 144px legacy stack. Existing user data was wiped per the disposability decision.

## Iteration 2 — Companion Planting Warnings — 30b369f
Persona ratings (pre): hobby=4/5, wildflower=2/5, food=2/5
Persona ratings (post): hobby=5/5 (satisfied), wildflower=2/5, food=3/5
Shipped:
  - New table `plantplanner_companions(id, plant_a_id<plant_b_id, relationship, reason)` with unique-pair + ordering constraints; ~30 high-confidence pairs seeded (tomato↔basil good, tomato↔fennel-replacement-sage bad, marigold↔most-vegetables good, etc.).
  - New backend route `GET /api/v1/plant_planner/companions` returns the symmetric-stored rows; client expands bidirectionally.
  - `plantplanner_gardens.settings_json jsonb` column for per-garden state. `PUT /gardens/{id}` accepts it (used for `dismissed_companion_warnings`).
  - Floating chips in the 3D scene: yellow `alert-triangle` for cells with a 4-connected bad neighbor (diagonals ignored); green `sparkles` for cells with only good neighbors. `requestAnimationFrame` keeps positions in sync as the camera orbits.
  - Tap chip → popover with thumbnail + name + relationship pill + reason. Bad rows have a "Dismiss for this garden" button that adds the canonical pair-key (smaller-uuid:larger-uuid) to a Set persisted via PUT.
  - Catalog tile gets ~12px badges (top-left): green leaf if good companion to anything placed; red dot if bad. `aria-label` lists the affected plants. Filter sidebar HEIGHT is unchanged — no new chip in the filter row.
  - Plant detail panel adds a Companions section under Pollinators: "Grows well with" + "Avoid planting near" rows (≤6 chips each). Tapping a chip swaps the detail panel to that partner.
  - Placement is never blocked. UI is fail-soft: if `/companions` errors, no chips render and detail Companions section hides.
Hobby unmet: SATISFIED. Hobby gardener is no longer driving iterations.
Wildflower unmet: full Jan–Dec bloom calendar strip aligned under 3D render; year 1/2/3 growth preview. (Iter 2 didn't touch wildflower — queued for iters 4 / 5+.)
Food unmet: real-radius placement (spread-circle, not 1×1 grid) — iter 3; height-aware shading — later.
Notes: UI/UX paired food's #1 (companion rules) with hobby's only remaining ask (companion warnings) into one bundle. Wildflower deliberately not advanced — their next ask (full bloom calendar) is queued for iter 4. New companions table is symmetric-stored (one row per pair, `plant_a_id < plant_b_id`) so the unique constraint actually enforces uniqueness and the API returns half the rows it would otherwise; client expands. Dismissals live per-garden (not per-user) so dismissing in Garden A doesn't mute the warning in Garden B.

## Iteration 3 — Real-Radius Placement — 1a8e264
Persona ratings (pre): hobby=5/5 (satisfied), wildflower=2/5, food=3/5
Persona ratings (post): hobby=5/5, wildflower=2/5, food=4/5
Shipped:
  - Migration 008 dropped+recreated `plantplanner_garden_plants` with `(pos_x REAL, pos_y REAL, radius_feet REAL)` floats. The grid_x/grid_y INT + UNIQUE(garden_id, grid_x, grid_y) cell model is gone; overlap is now allowed.
  - Backend: `PlantPlacement` Pydantic model uses `pos_x/pos_y/radius_feet` floats; `save_garden_plants` validates 0 ≤ pos ≤ grid bounds with HTTP 422.
  - Frontend state: `gridPlacements` map → `placements` array of `{id, plantId, plant, pos_x, pos_y, radius_feet}`. Touched 8 web files (state, render3d, plant-drag, garden, gardens, catalog, companions, touch-drag, plus auth/helpers cleanup) + STRUCTURE.md.
  - Drag-from-catalog: a translucent disk preview (radius = `spread_inches/24` ft) follows the cursor at soil level. Green = ok; amber = overlaps another plant; red = outside bed (oob). Out-of-bed drop falls back to the existing toss-to-ground animation; in-bed drop is never blocked even on overlap.
  - Each placed plant renders a permanent 25%-opacity disk on the soil at `radius_feet`, plant-tinted. Plant mesh sits at disk center.
  - Companion adjacency rule changed from "4-connected grid neighbor" to "disk centers within `r_a + r_b + 0.5 ft`". Iter 2's chips, popover, and detail-panel Companions section all keep working with the new geometric definition.
  - New "crowded" yellow chip fires when disks overlap by more than 6 inches. Per-pair "It's fine, dismiss" button stores `crowd:<placementA>:<placementB>` alongside companion dismissals. Companion dismissal keys now use a `companion:<plantA>:<plantB>` prefix; legacy unprefixed entries are treated as `companion:` for grace.
  - Long-hold pickup, drag-to-move, click-to-remove, and reseed all preserved with continuous coordinates.
Hobby unmet: SATISFIED. Disk realism actually nudged the "looks pretty" criterion up; companion + crowded chips not noisy.
Wildflower unmet: full Jan–Dec bloom calendar strip; year 1/2/3 growth preview. (Iter 3 didn't address wildflower needs — disk realism gave a marginal visual win for spreading natives.) Iter 4 target: bloom calendar.
Food unmet: height-aware shading/occlusion. (Real-radius — their #1 — fully delivered; +1 to satisfaction.)
Notes: Single-agent ownership of the 8-file frontend slice was correct — the `gridPlacements` → `placements` migration touched scene rendering, drag plumbing, save flow, hydration on garden open, and companion warning geometry simultaneously. Backend validation is 422 on out-of-bounds; overlap is never rejected by the server. The `_isDismissed` helper in companions.js handles the legacy → prefixed dismissal-key migration so iter 2 dismissals carry over cleanly.

## Iteration 4 — Garden-Wide Bloom Calendar Strip — c8fb9f2
Persona ratings (pre): hobby=5/5 (satisfied), wildflower=2/5, food=4/5
Persona ratings (post): hobby=5/5, wildflower=4/5, food=4/5
Shipped:
  - New full-width `<section id="bloom-calendar-strip">` directly under the 3D pane in `.builder-main`. Always visible whenever the builder view is open.
  - **Aggregate header row** (always visible, ~40px): chevron toggle + "Bloom Calendar" title + count chip ("3 plants · 7 mo") + 12 month columns (J F M A M J J A S O N D) with opacity-scaled intensity bars (more plants blooming that month → more opaque).
  - **Body** (collapsible, default open on desktop / collapsed on mobile): one row per unique placed plant (duplicates grouped: "Black-Eyed Susan ×2"), with thumbnail + name + 12 dot cells filled per `bloom_months`. Plants with empty `bloom_months` (most veggies/herbs) are omitted from rows.
  - Empty placements: header shows outline-only aggregate cells with "Add plants to see their bloom calendar" message.
  - All-empty bloom_months: body shows "None of the placed plants have bloom data — try adding a flowering plant from the catalog."
  - Reactive: `renderBloomCalendar()` called from `init3DScene` / `bind3DDragDrop.onDrop` / `bind3DClick` (remove) / `reseedGarden`. No drag-to-move hook needed (move doesn't change which plants are present).
  - Mobile (<600px): horizontally scrollable strip with sticky-left plant-name column; default collapsed.
  - Reuses iter 1's `MONTH_LETTERS` and the `.bloom-dot` visual idiom (scoped via new `.bloom-calendar .bloom-dot` rules so the detail-panel mini-strip is untouched).
  - NO data model or backend changes — `bloom_months int[]` was already added in iter 1's enrichment migration; `GET /plants` already returns it.
  - Filter sidebar pixel height is unchanged (no edits to `.catalog-sidebar` rules); detail-panel mini bloom strip is visually identical.
Hobby unmet: SATISFIED. Calendar didn't crowd the 3D pane (lives below, collapses on mobile, sidebar untouched).
Wildflower unmet: year 1/2/3 growth preview (last remaining need — queued for iter 5).
Food unmet: height-aware shading/occlusion for dense beds (last remaining need — queued for iter 6).
Notes: Pure-frontend feature, no DB or backend churn — `bloom_months` was already in place since iter 1. The combined-shape (aggregate header + per-plant rows) was chosen so the strip works as both a quick "where are my bloom gaps" scanner AND a per-plant timeline. The strip is always visible (not hidden in the detail panel) per Wildflower's spec — that's the key change vs iter 1's mini-strip.

## Iteration 5 — Year-by-Year Growth Preview — 3783128
Persona ratings (pre): hobby=5/5 (satisfied), wildflower=4/5, food=4/5
Persona ratings (post): hobby=5/5, wildflower=5/5 (satisfied), food=4/5
Shipped:
  - Migration 009 adds `lifecycle text` (annual|biennial|perennial, default 'perennial') and `years_to_maturity int` (1–5, default 3) to `plantplanner_plants`. Additive — `ADD COLUMN IF NOT EXISTS` so re-runnable.
  - Catalog seeded for all ~40 plants: 9 annuals (tomato, pepper, lettuce, carrot, basil, kale, bush bean, zucchini, marigold) at ytm=1; bulbs (tulip, daffodil) and strawberry at ytm=2; slow perennials (baptisia, peony, joe pye weed, hydrangea, blueberry) at ytm=5; rest perennials at ytm=3.
  - Backend: `Lifecycle` StrEnum in constants.py; `PlantResponse` extended with `lifecycle: str = 'perennial'` and `years_to_maturity: int = 3` (defaults so old shape still validates).
  - Frontend `yearScale(plant, year)` helper in helpers.js: annuals always 1.0; biennials 0.5 at Y1, 1.0 from Y2; perennials ramp from a 0.4 floor at Y1 to 1.0 at maturity.
  - Year scrubber pills in the 3D pane header (`Y1 | Y2 | Y3+`), right-aligned, default Y3+. Clicking persists `pp_preview_year` to localStorage and triggers `sync3DView` + `renderCompanionChips`.
  - `syncSceneWithPlacements` applies `s = yearScale(plant, previewYear)` per placement: `mesh.scale.set(s, s, s)` on the plant group AND rebuilds the translucent disk geometry at `radius_feet * s`. Spread + height handled in one knob.
  - Companion warnings + crowded chips re-evaluate at the selected year (multiplied radii). Bloom calendar untouched (year-independent).
  - Drag-drop preview disk and placement bounds-validation always use mature radius — preview is view-only; saves are never year-aware.
Hobby unmet: SATISFIED. Default Y3+ preserves prior visual; scrubber is unobtrusive opt-in chrome.
Wildflower unmet: SATISFIED. Last remaining need (multi-year growth preview) fully delivered. Joe Pye Weed at ytm=5 / Y3 = 0.6× scale — visibly smaller, matches reality.
Food unmet: height-aware shading/occlusion (LAST remaining need — queued for iter 6, the cap iteration).
Notes: Chose lifecycle + years_to_maturity (option C from the design) over per-year explicit columns — cleaner data model with sensible defaults and a deterministic curve. Preview is intentionally view-only so users can scrub years without affecting placement validation or saved state. Annuals stay full-size every year (would look broken otherwise). Tooltip on the scrubber clarifies "Preview only — placement is saved at mature size."

## Iteration 6 — Height-Aware Shading Warnings — 8c44ad0
Persona ratings (pre): hobby=5/5 (satisfied), wildflower=5/5 (satisfied), food=4/5
Persona ratings (post): hobby=5/5, wildflower=5/5, food=5/5  **— CONVERGED**
Shipped:
  - New `projects/plant-planner/web/shading.js` (no schema, no backend changes — `height_inches` and `sunlight` already existed since iter 0).
  - Coordinate convention frozen: **+y = north** (northern hemisphere default). Solar-noon shadows extend in the −y / south direction.
  - `shadowZoneFor(placement, year)` computes the shadow box: shadow length = `(height_inches/12) * yearScale * 0.7` ft (mid-latitude rule of thumb); shadow width = `radius_feet * yearScale`.
  - `computeShadeConflicts(placements, year)` returns `{shadedPlacementId: [{type:'shade', shadingPlacementId, ...}]}`. Threshold: shading plant must be ≥1.2× the shaded plant's effective height; shaded plant must have `sunlight === 'full_sun'` (so partial/shade plants stay quiet — wildflower no-regression).
  - 3D scene: each placed plant gets a translucent dark ground-shadow disk (`MeshBasicMaterial`, `opacity 0.18`) on the soil south of its base. Skips heights <0.5 ft to suppress noise. Rebuilt by `updateShadowMeshes(handle, placements, previewYear)` at the end of `syncSceneWithPlacements` (so it tracks placements + the year scrubber automatically).
  - Warning chip merged into the existing iter 2/3 chip layer: single chip per placement, with `warning > good` precedence over the union of bad-companion + crowd + shade conflicts. No double-render.
  - Popover row: thumbnail + name + orange "Shaded" pill + reason text quoting `height_inches` of the shading plant; per-pair "It's fine, dismiss" stored as `shade:<shadedId>:<shadingId>` in `dismissedCompanionWarnings`. Reuses `canonicalPairKey` and `_isDismissed` plumbing from iter 2/3 unchanged.
  - Year-aware: shrinks with the year scrubber automatically (heights × `yearScale`).
  - Sunlight-aware: only `full_sun` plants get warned. Hosta/Coral Bells/Wild Columbine (partial-sun natives) shaded by tall neighbors → no chip. Wildflower 5/5 preserved.
Hobby unmet: SATISFIED. Ground shadows subtle, no new sidebar controls.
Wildflower unmet: SATISFIED. Partial/shade-loving natives (Wild Columbine, Cardinal Flower, Coral Bells, Hosta) explicitly NOT warned because they have `sunlight='partial'|'shade'`.
Food unmet: SATISFIED. Full-sun veggies (tomato, pepper, zucchini, strawberry, blueberry, carrot, bush bean) WILL get shade warnings when overhead by a tall neighbor; lettuce/kale (partial) correctly skipped per horticulture.
Notes: Cap iteration. The shading model is single-shadow (solar noon, mid-latitude, +y=north); intentionally no time-of-day animation, no hemisphere toggle, no per-month seasonality. The shadow disk is informational (shown unconditionally for tall plants) while the chip is conditional (only on shading-vs-sunlight conflict). The shared chip/popover infrastructure from iter 2 has now absorbed three warning sources (companion + crowd + shade) under one precedence rule with one popover.
