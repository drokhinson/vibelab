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

## Iteration 1 — Compressed Catalog + Rich Plant Knowledge — pending
Persona ratings (pre): hobby=2/5, wildflower=1/5, food=2/5
Persona ratings (post): pending — Phase G re-poll
Shipped:
  - Catalog filter sidebar: 3 dropdowns replaced with full-width search input + horizontally-scrolling chip row (`Native | Pollinators | Sun | Shade | Spring | Summer | Fall | Edible | Flower | Herb`). Sidebar header drops from ~144px to ~80px.
  - `plantplanner_plants` enriched with 6 columns: `bloom_months int[]`, `native bool`, `usda_zones int4range`, `pollinator_attracts text[]`, `water_need text` (low/medium/high check), `care_summary text`.
  - `plantplanner_gardens` gains `usda_zone text`. Garden header now shows a `Zone: 6b ▾` chip with a popover picker; selection persists via `PUT /gardens/{id}`.
  - Catalog reseeded with ~40 plants: 15 NA natives, 10 edibles, 15 ornamentals/herbs. All new columns populated.
  - `GET /plants` response shape extended; `usda_zones` serializes as `{min, max}` (parser normalizes Postgres int4range half-open form).
  - Plant tiles gain a native-leaf badge (top-left) and up to 3 pollinator icons (bottom-right). Click on tile opens a 320px slide-in plant detail panel: full name, plain-language care line, mini 12-dot bloom strip (J-D), pollinator row, "Hardy in zones X–Y", description. Esc / backdrop / close button dismiss.
  - "Native to your zone" filter combines the Native chip with the garden's `usda_zone` numeric portion against `usda_zones` range.
Hobby unmet: pending re-poll. Likely still wanting: tile name truncation in tiles themselves, garden_type 3D frame, 3D realism slider.
Wildflower unmet: pending re-poll. Deferred to later iterations: full Jan–Dec calendar strip aligned under 3D render (mini strip in detail panel ships now), year 1 / 2 / 3+ growth preview.
Food unmet: pending re-poll. Iteration 2 target: companion-planting rules + adjacency warnings. Iteration 3 target: real-radius placement + spread-circle rendering. Later: height-aware shading warnings, succession/rotation, container_tolerant flag.
Notes: UI/UX picked the bundle that touched the most personas at once — the filter compression (hobby+wildflower) and the data-model enrichment (all three) both centered on the catalog sidebar surface. Companion rules and radius placement explicitly deferred since each is a self-contained feature that warrants its own iteration. Filter sidebar constraint honored: ~80px header < the 144px legacy stack. Existing user data was wiped per the disposability decision.
