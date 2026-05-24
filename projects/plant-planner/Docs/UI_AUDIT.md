# PlantPlanner Web UI Audit

A consistency audit of `projects/plant-planner/web/`. Every claim cites code as `path:line` so each finding can be jumped to and verified. The scope is the web frontend only; the React Native app under `app/` and the FastAPI routes under `shared-backend/routes/plant_planner/` are out of scope.

> **Status:** Initial audit produced 2026-05-24. This document is docs-only — no JS, CSS, or HTML was changed. The fix sequence in §9 is the executable plan for follow-up sessions.

> **Companion:** `Docs/ARCHITECTURE.md` — the object-oriented design view of the same codebase, with the target file layout.

---

## 1. Executive summary

PlantPlanner has a flat web layout — 15 JS files at the root of `web/`, no `ui/` / `views/` / `widgets/` / `domain/` split. The total surface is 4,919 lines of JS + 2,558 lines of CSS, dominated by four feature files: `gardens.js` (922), `helpers.js` (644), `browser.js` (568), `shopping.js` (515). The audit found four drivers of consistency debt:

1. **Three parallel Plant card renderers for the same domain object** — the central finding. `_renderShoppingCard` (`shopping.js:222`), `_renderBrowserCard` (`browser.js:249`), and `_renderLibraryCard` (`library.js:114`) all render a `plantplanner_plant_cache` row (image + name + scientific subline + bullets) but layer three different CSS class families on top: `.shopping-card`, `.shopping-card.browser-card`, and `.garden-card.library-card`. Image-source resolution is also duplicated three ways via `_shoppingImageFor` (`shopping.js:252`) + `_libraryImageFor`. See §4.
2. **Three parallel detail-panel hosts.** `#shopping-detail-panel` (`shopping.js:189`), `#library-detail-panel` (`library.js:59`), and `#browser-detail-panel` (`browser.js:183`) each have their own mount div and their own open/dismiss handlers (`shopping.js:364, :429`, `library.js:239, :442`, `browser.js:497, :566`). All three render `<aside class="shopping-detail-panel">` so the markup is half-shared — but each view owns its own machinery. See §4.
3. **No project-shared modal exists.** Destructive and error-state actions use browser `confirm()` / `alert()` at 16 sites (6 `confirm`, 10 `alert`) across `garden.js`, `gardens.js`, `shopping.js`, `library.js`, `browser.js`. This violates the `.claude/rules/web-frontend.md` "Destructive actions are confirmed" contract. See §5.
4. **Four files cross the 300-line modular threshold** from `.claude/rules/web-frontend.md`: `gardens.js` (922 lines — 4-step wizard + My-Gardens list), `helpers.js` (644), `browser.js` (568), `shopping.js` (515). See §7.

Things that already meet the standard and **should not be rewritten**:

- **Auth modal.** `auth.js:97–252` matches `.claude/rules/auth-ui.md` exactly: `.auth-oauth-btn*` + `.auth-divider` classes (`auth.js:123–129`), 999px pill radius (`styles.css:615`), "or use email" divider copy (`auth.js:129`), 4-color Google G + monochrome Apple SVG (`auth.js:104–114`).
- **Design tokens.** `styles.css:6–14` declares 7 `--pp-*` tokens scoped to the DaisyUI pastel theme. Only 40 hex literals total in CSS — modest cleanup, not a sweep.
- **Filter-chip helper.** `renderFilterChipRow` (`helpers.js:212`) is already reused on 3 surfaces: Plant Browser, New-Garden wizard, Plant Import view (7 call sites total). One naming inconsistency vs the canonical name in boardgame-buddy + post-audit sauceboss (`renderFilterChips`) — a 1-line rename, not a refactor.
- **Plant info bullet helpers.** The cluster `_plantConditionsBullets` / `_plantFactsBullets` / `_plantCareBullets` / `_plantInfoSectionsHtml` / `_plantChipRowsHtml` / `_renderDetailBullets` (`helpers.js:262–525`) is already shared between all three detail panels. The duplication problem is in the panel **shell**, not the body.
- **Fill-progress runner.** `runFillStep` / `renderFillProgress` / `setFillStep` (`helpers.js:526–605`) are shared between the wizard's API-fill orchestration and the standalone Import view.

See §8 for the full "do not rewrite" list.

---

## 2. Screens & routes

The app is a single-page shell. `index.html:33` contains a single `<div id="app">` container; `render()` (`helpers.js:605`) rebuilds its `innerHTML` from a `currentView` switch on every tick. Bottom-of-page navbar (`#nav-right`) and a bottom-nav slot (`#bottom-nav`) live at `index.html:29` and `index.html:41`.

There are 8 top-level routes (`currentView` values). The default after sign-in is `library`.

| Route (`currentView`) | Renderer | File:line | How user reaches it | Primary content |
| --- | --- | --- | --- | --- |
| `auth` | `renderAuth` | `auth.js:97` | Signed-out boot | OAuth + email/password form (already canonical, see §1) |
| `library` | `_renderLibraryShell` | `library.js:55` | Default after sign-in; "My Plants" nav | Status filter tabs + plant grid + slide-in detail |
| `browser` | `_renderBrowserShell` | `browser.js:181` | "Plant Browser" nav | Search row + filter dropdown + plant grid + slide-in detail |
| `import` | `renderImportView` | `import.js:15` | Browser → "Import" button | Filter chips + 2-step API-fill orchestration |
| `gardens` | `renderGardens` | `gardens.js:?` | "My Gardens" nav | Garden list + "+ New Garden" |
| `wizard` | `renderGardenWizard*` | `gardens.js` (5 functions) | "+ New Garden" → 4-step flow | Filters → Planter → Catalog source → Review |
| `shopping` | `renderShopping` | `shopping.js:?` | Wizard confirm → `openShoppingForGarden` | Pinterest-style plant grid + shortlist + detail panel |
| `garden` (builder) | `renderBuilder` | `garden.js:?` | Shopping → "Continue to placement" / `openGarden(id)` | Top-down 2D bed + draggable shortlist sidebar + Save |

There is no auth-gated modal route — the auth screen is the boot screen. Once signed in, no view returns to it unless the session expires.

---

## 3. Reusable components

Components are global functions attached to `window` via implicit script-tag scope (no module system). The codebase has a small set of genuinely-shared helpers (already in §3.1–3.4 below) and a much larger set of view-local rendering that **should** be shared (the duplication problem in §4).

### 3.1 `renderFilterChipRow` — `helpers.js:212`

- **Returns:** HTML string (a `<div class="filter-chip-row">`).
- **Reuse count: 7 call sites** across 3 files.
  - `browser.js:198, :199, :200` — Plant Browser filter dropdown (Sunlight / Watering / Cycle)
  - `gardens.js:638, :639, :640` — New-Garden wizard step 1 (Light / Water / Season)
  - `import.js:75, :76, :77` — Plant Import view (Light / Water / Season)
- **Companion:** `bindFilterChipRow` (`helpers.js:231`) — wires `click` handlers for each chip group.
- **Note:** This is the closest plant-planner has to a canonical filter UI. Per the post-audit sauceboss pattern, this should be renamed to `renderFilterChips` for cross-project consistency.

### 3.2 `_plant*` info-bullet cluster — `helpers.js:262–525`

A family of `_plantConditionsBullets`, `_plantFactsBullets`, `_plantCareBullets`, `_plantPropertiesChipsHtml`, `_plantDescriptionHtml`, `_plantChipRowsHtml`, `_plantSourceHtml`, `_renderDetailBullets`, `_plantInfoSectionsHtml`, `_plantRefreshButtonHtml`.

- **Reuse:** Consumed by all three detail-panel openers (`shopping.js:364`, `browser.js:497`, `library.js:239`).
- **Note:** This is the **shared body** of every detail panel. The duplication problem is **not** in the bullet rendering — it's in the panel shell / mount / open / dismiss surrounding it. See §4.

### 3.3 `renderFillProgress` / `setFillStep` — `helpers.js:533, :578`

- **Reuse:** Shopping flow (wizard fill orchestration) + Import view (standalone fill).
- **Companion:** `_fillStepIcon` (`helpers.js:526`).
- **Note:** Per `STRUCTURE.md` Active Development Notes (2026-05-10), these were extracted out of `web/shopping.js` into `web/helpers.js` so both views share one runner. Good example of canonical-extraction-after-duplication.

### 3.4 `renderAuth` — `auth.js:97`

- **Returns:** Mutates `#app` `innerHTML` directly with the auth screen.
- **Reuse count: 8 internal call sites** for state-change rerenders (`auth.js:175, :182, :196, :208, :221, :226, :239, :244`).
- **Visual style:** 4-color Google G + monochrome Apple SVG OAuth buttons, "or use email" divider, login/signup tab toggle, email/password form.
- **`.claude/rules/auth-ui.md` compliance:** ✅ **Full.** Classes are the canonical `.auth-oauth-btn` / `.auth-oauth-google` / `.auth-oauth-apple` / `.auth-oauth-logo` / `.auth-divider` (`auth.js:123–129`); button radius is the canonical `999px` pill (`styles.css:615`); divider copy is the canonical "or use email" (`auth.js:129`).
- **Note:** This is the reference implementation for the OAuth pattern in the repo. Do not rewrite. See §8.

### 3.5 Per-view renderers (one per screen — single-purpose)

The remaining `render*` and `_render*Shell` functions are single-screen renderers that compose the helpers above. Listed for completeness:

| Function | File:line | Screen |
| --- | --- | --- |
| `_renderLibraryShell` | `library.js:55` | My Plants library |
| `_renderBrowserShell` | `browser.js:181` | Plant Browser |
| `renderImportView` | `import.js:15` | Plant Import |
| `renderGardens` | `gardens.js` | My Gardens list |
| `renderGardenWizard{Filters,Planter,Source,Review}` | `gardens.js` | 4-step wizard |
| `renderShopping` | `shopping.js` | Plant shopping for a planter |
| `renderBuilder` | `garden.js` | Garden builder shell |

---

## 4. Render-function duplication — the central finding

### 4a. Plant card — three parallel implementations

The Plant object is the single most-shown thing in the app. It surfaces on three grids: Shopping (in the wizard flow), Plant Browser, and My Plants library. Each grid has its own renderer with no shared base.

| Surface | Renderer | File:line | CSS class family | Action affordance |
| --- | --- | --- | --- | --- |
| Plant shopping | `_renderShoppingCard` | `shopping.js:222` | `.shopping-card` (+ `.picked` when shortlisted) | Single heart button (toggle shortlist) |
| Plant Browser | `_renderBrowserCard` | `browser.js:249` | `.shopping-card.browser-card` (+ `.picked` / `.favorite`) | Two-button action set: leaf "Add to plant list" + heart "Add to favorites" |
| My Plants library | `_renderLibraryCard` | `library.js:114` | `.garden-card.library-card` | "Details" button + "Remove" button + status pill + planter chips |

**The three renderers share this shape:**

```
{
  image (resolved via _shoppingImageFor / _libraryImageFor),
  common_name | scientific_name fallback,
  scientific_name subline (when different),
  bullets: [☀️ sunlight, 💧 watering, 🌱 cycle, Zone X–Y, 🥗 edible]
}
```

**They diverge on:**

1. **Outer class.** Shopping uses `.shopping-card`; Browser layers `.browser-card` on top; Library swaps to `.garden-card.library-card`. The Library variant doesn't even share the `.shopping-card` base.
2. **Image helper.** Shopping and Browser both call `_shoppingImageFor` (`shopping.js:252`). Library has its own `_libraryImageFor` doing the same job for its row shape.
3. **Body content.** Shopping + Browser show the same 5 bullets; Library shows a status pill (`_statusPillHtml`) + planter chips (`_planterChipsHtml`) instead.
4. **Action footer.** Shopping has a single heart. Browser has two buttons (leaf for "current", heart for "wishlist"). Library has explicit "Details" + "Remove" buttons.

**This is the textbook "same object, parallel implementations" failure mode from `.claude/rules/ui-object-design.md` §2.** A canonical `renderPlantCard(plant, { variant, entry, picked, gardens })` would collapse all three.

### 4b. Detail panel — three parallel hosts

Tapping a card opens a slide-in panel. Each grid has its own host div + open / dismiss handlers.

| Surface | Mount div | Open | Dismiss |
| --- | --- | --- | --- |
| Plant shopping | `#shopping-detail-panel` (`shopping.js:189`) | `_openShoppingDetailPanel` (`shopping.js:364`) | `_dismissShoppingDetail` (`shopping.js:429`) |
| Plant Browser | `#browser-detail-panel` (`browser.js:183`) | `_openBrowserDetailPanel` (`browser.js:497`) | `_dismissBrowserDetail` (`browser.js:566`) |
| My Plants library | `#library-detail-panel` (`library.js:59`) | `_openLibraryDetailPanel` (`library.js:239`) | `_closeLibraryDetail` (`library.js:442`) |

All three render `<aside class="shopping-detail-panel">` so the **inner markup** is shared. The **body** uses the same `_plant*` info-bullet helpers from §3.2 — that part is already canonical. The duplication is purely in the **shell**: each view owns its own mount div, its own open function, and its own dismiss function.

**Recommendation:** Collapse to one host (`#pp-plant-detail`), one open function (`openPlantDetailPanel(plant, { variant, userEntry, picked, gardens, onAction })`), one dismiss. The per-variant action footer (heart-only vs leaf+heart vs status-radio+qty+notes+planter-picker+remove) stays variant-specific; everything else is shared.

---

## 5. Destructive actions — 16 sites using browser `confirm()` / `alert()`

The `.claude/rules/web-frontend.md` rule states: *"Destructive actions are confirmed … Reuse the project's existing modal pattern — don't introduce per-screen ad-hoc dialogs."* Plant-planner has no project modal. Every destructive or error message uses `window.confirm()` or `window.alert()`.

| File:line | Type | Trigger | Severity |
| --- | --- | --- | --- |
| `garden.js:229` | `alert` | "Could not update zone: …" | Error |
| `garden.js:272` | `alert` | "Save failed: …" | Error |
| `garden.js:278` | `confirm` | "Reseed for next season? This will clear all current plants and save an empty garden." | Destructive (data loss) |
| `garden.js:289` | `alert` | "Reseed failed: …" | Error |
| `gardens.js:257` | `confirm` | "Discard this new garden?" (wizard cancel, path 1) | Destructive (data loss) |
| `gardens.js:806` | `confirm` | "Discard this new garden?" (wizard cancel, path 2) | Destructive (data loss) |
| `gardens.js:868` | `alert` | "Could not create garden: …" | Error |
| `gardens.js:909` | `confirm` | "Delete this garden?" | Destructive (irreversible) |
| `gardens.js:914` | `alert` | "Error: …" | Error |
| `library.js:215` | `confirm` | "Remove this plant from your library? Placements in your planters won't be affected." | Destructive (irreversible) |
| `library.js:221` | `alert` | "Could not remove: …" | Error |
| `library.js:411` | `alert` | "Could not add this plant to the planter: …" | Error |
| `library.js:462` | `alert` | "Could not save: …" | Error |
| `shopping.js:279` | `confirm` | "Leave shopping? Your shortlist so far will be saved." | Data-loss-adjacent (informational confirm before mid-flow exit) |
| `shopping.js:314` | `alert` | "Could not save shortlist: …" | Error |
| `browser.js:460` | `alert` | "Could not update your library: …" | Error |

Totals: **6 `confirm()` (3 destructive, 3 data-loss/interrupt) + 10 `alert()` (all errors)**.

**Not addressed in this audit** — fixing this requires designing the modal first. Tracked in §9 PR 4 + PR 5 as the highest-priority UX win.

---

## 6. CSS class inventory

`styles.css` is 2,558 lines and declares **425 top-level class selectors** (`grep -c "^\.[a-zA-Z]" styles.css = 425`) plus **324 `var(--…)` usages** (`grep -c "var(--" styles.css = 324`). The base palette comes from DaisyUI's pastel theme; plant-planner declares 7 custom tokens on top:

### 6.1 Design tokens — already declared

`styles.css:6–14` declares the `--pp-*` family:

```css
[data-theme="pastel"] {
  --pp-accent:       #E8856C;
  --pp-lavender:     #B8A9D4;
  --pp-sage:         #7BAE7F;
  --pp-cream:        #FBF8F3;
  --pp-warm-border:  rgba(0, 0, 0, 0.06);
  --pp-shadow:       0 2px 12px rgba(0,0,0,0.05);
  --pp-shadow-lg:    0 6px 24px rgba(0,0,0,0.08);
}
```

Plus the DaisyUI semantic tokens (`oklch(var(--bc))`, `oklch(var(--b1))`, `oklch(var(--p))`, etc.) used at 324 sites. **This is the standard already; do not introduce parallel tokens.**

**One token missing for §9 PR 4:** `--pp-danger: #dc2626` (the destructive accent for the new project modal). Today `#dc2626` is hardcoded 2 times in CSS.

### 6.2 Hex-literal frequencies — top 10

```
7× #6b7280   (gray-500 — sub-bullet text; should use oklch(var(--bc) / 0.55) or similar)
4× #e5e7eb   (gray-200 — borders; should use var(--pp-warm-border))
4× #16a34a   (green-600 — success/leaf accents; DaisyUI fallback exists via --su)
2× #f0f0f0   (light gray — placeholder backgrounds; should use oklch(var(--b1)))
2× #dc2626   (red-600 — destructive; becomes --pp-danger in §9 PR 4)
2× #FBF8F3   (cream — duplicates --pp-cream)
2× #7BAE7F   (sage — duplicates --pp-sage)
1× #fee2e2   (red-100 — soft danger)
1× #fed7aa   (orange-200 — warning)
1× #fca5a5   (red-300 — soft danger)
```

40 hex literals total — modest cleanup. Strategy: sweep the top 4 frequencies (`#6b7280`, `#e5e7eb`, `#f0f0f0`, `#dc2626`) and the cream/sage duplicates; leave the per-data accents alone.

### 6.3 CSS class families for the three Plant cards

The duplication from §4a manifests in `styles.css` as three overlapping class families:

| Family | Lines | What it owns |
| --- | --- | --- |
| `.shopping-card*` (`:1797–1907`) | ~110 | The Pinterest-grid card used by Shopping + Browser. Subclasses: `.shopping-card-media`, `.shopping-card-body`, `.shopping-card-title`, `.shopping-card-sub`, `.shopping-card-bullets`, `.shopping-card-heart`, `.shopping-card-img-placeholder` |
| `.browser-card*` (`:1907+`) | partial | Adds `.browser-card-actions` + per-button styling on top of `.shopping-card` |
| `.library-card*` (`:2410+`) | ~50 | Library-specific media + pill rows. Shares `.garden-card` as base, NOT `.shopping-card`. Subclasses: `.library-card-media`, `.library-card-body`, `.library-card-row`, `.library-card-planters`, `.library-card-img`, `.library-pill*`, `.library-planter-chip` |

A canonical `renderPlantCard` (§9 PR 6) collapses these to one `.plant-card*` family. The class-family cleanup is a follow-up after the JS migration is verified.

### 6.4 Detail-panel class family

| Family | Lines | What it owns |
| --- | --- | --- |
| `.shopping-detail-panel*` / `.shopping-detail-overlay` (`:2024–2070+`) | ~90 | The slide-in panel chrome — used by all three detail views even though they have distinct mount divs. `.shopping-detail-close`, `.shopping-detail-hero`, `.shopping-detail-body`, `.shopping-detail-bullets` |
| `.browser-detail-actions` (`:1931+`) | small | Browser-specific footer actions |

The class family is already half-shared (all three views render `<aside class="shopping-detail-panel">`). The duplication is in the JS mount/open/dismiss, not the CSS.

---

## 7. File-size violations

`.claude/rules/web-frontend.md`: *"Split once any file exceeds ~300 lines or has 3+ distinct feature areas."* Four files cross the threshold:

| File | Lines | Concerns mixed into one file | Recommended split |
| --- | --- | --- | --- |
| `gardens.js` | 922 | My-Gardens list rendering + 4-step new-garden wizard (5 step renderers + step state machine + submit handler) + location-step interop | `widgets/garden-wizard.js` (~600) + `views/gardens-list-view.js` (~250) — see §9 PR 10 |
| `helpers.js` | 644 | `apiFetch` + nav + theme + 25+ `_plant*` formatters + `renderFilterChipRow` + `renderFillProgress` + `render()` dispatcher + `validatePlacement` | Carve `_plant*` into `ui/plant-info.js`, filter into `ui/filter-chips.js`, fill into `ui/fill-progress.js`. Goal: ~200 lines residual — see §9 PR 3 |
| `browser.js` | 568 | Browser grid + filter panel + detail panel open/dismiss + search + 1 modal site | Extract detail panel + filter dropdown to view-local helpers; keep grid + search — addressed implicitly by §9 PR 7 + PR 11 |
| `shopping.js` | 515 | Shopping grid + detail panel + shortlist sidebar + fill orchestration interop | Extract detail panel; keep grid + orchestration — addressed implicitly by §9 PR 7 + PR 11 |

The carve-outs in §9 (Phase 5) are not refactors of the inside-the-file logic — they're filename/path changes that put the right concerns in the right directories. Inside-file refactoring is incidental.

---

## 8. Things that already meet the standard — do not rewrite

Future audit-fix passes must respect these. Each is listed because it would be tempting to "clean up" but is already correct per the rules.

### 8.1 Auth modal — fully canonical

`auth.js:97–252` matches `.claude/rules/auth-ui.md` exactly:

| Aspect | Plant-planner | Canonical | Citation |
| --- | --- | --- | --- |
| OAuth classes | `.auth-oauth-btn`, `.auth-oauth-google`, `.auth-oauth-apple`, `.auth-oauth-logo` | Same | `auth.js:123, :126` |
| Divider class | `.auth-divider` | Same | `auth.js:129` |
| Divider copy | "or use email" | Same | `auth.js:129` |
| Button radius | `border-radius: 999px` | Same | `styles.css:615` |
| Google logo | 4-color G as `<path>` | Same | `auth.js:104–109` |
| Apple logo | Monochrome path | Same | `auth.js:110–114` |

**No PR needed for auth.** The audit-fix sequence's PR 11 will rename `auth.js` → `views/auth-view.js` as part of the file-layout pass, but the content is unchanged.

### 8.2 Design tokens — already declared

The `--pp-*` block (`styles.css:6–14`) is the project's token system. DaisyUI semantic tokens are layered on top via `oklch(var(--bc))` etc. at 324 sites. **No `:root` block needs to be added; the only missing token is `--pp-danger` which lands in §9 PR 4.**

### 8.3 Filter-chip helper — already shared

`renderFilterChipRow` (`helpers.js:212`) + `bindFilterChipRow` (`helpers.js:231`) are used by 3 surfaces (Browser, wizard, Import) at 7 call sites. The only change in §9 is the rename → `renderFilterChips` for cross-project consistency.

### 8.4 Plant info-bullet cluster — already shared

`_plantConditionsBullets`, `_plantFactsBullets`, `_plantCareBullets`, `_plantPropertiesChipsHtml`, `_plantDescriptionHtml`, `_plantChipRowsHtml`, `_plantSourceHtml`, `_renderDetailBullets`, `_plantInfoSectionsHtml` (`helpers.js:262–525`) are consumed by all three detail-panel openers (`shopping.js:364`, `browser.js:497`, `library.js:239`). This is the shared body of every detail panel. **The duplication problem is in the panel shell (§4b), not the body.**

### 8.5 Fill-progress runner — already shared

`renderFillProgress` / `setFillStep` / `_fillStepIcon` / the implicit `runFillStep` (`helpers.js:526–605`) are shared between the wizard fill orchestration and the standalone Import view. Per `STRUCTURE.md` Active Development Notes (2026-05-10), this extraction is explicitly cited as canonical. **Do not undo.**

### 8.6 Modular runtime helpers

- `apiFetch`, `showView`, `updateNav`, `_initIcons`, `_qs`, `render()` (`helpers.js`) — already global, keep as utilities.
- `validatePlacement` (`helpers.js:633`) — moves into `domain/placement.js` in §9 PR 12 but logic stays unchanged.
- `garden-units.js` (61 lines) — the JS half of the canonical units helper, mirrors `shared-backend/routes/plant_planner/garden_units.py`. Per `STRUCTURE.md`, this is the unit-system source of truth; leave it alone.

---

## 9. Recommended fix sequence

Twelve PRs in five phases. Each is independently shippable. Phases run sequentially; PRs within a phase can run in parallel where noted. Total scope mirrors the post-audit sauceboss sequence on `claude/boardgamebuddy-ui-audit-7zdmP` — fewer PRs because plant-planner is in better shape going in.

### Phase 1 — Foundation

**PR 1 — Hex-literal sweep + `--pp-danger` token**
- Add `--pp-danger: #dc2626` to the `[data-theme="pastel"]` block in `styles.css:6–14`.
- Sweep the top hex-literal frequencies: 7× `#6b7280` → `oklch(var(--bc) / 0.55)`; 4× `#e5e7eb` → `var(--pp-warm-border)`; 2× `#f0f0f0` → `oklch(var(--b1))`; 2× `#FBF8F3` → `var(--pp-cream)`; 2× `#7BAE7F` → `var(--pp-sage)`; 2× `#dc2626` → `var(--pp-danger)`. Leave the 4× `#16a34a` (success accent — touch in the DaisyUI migration), the 1×`#fee2e2`/`#fed7aa`/`#fca5a5` (one-off soft accents).
- Verification: `grep -cE "#[0-9A-Fa-f]{6}" projects/plant-planner/web/styles.css` drops from 40 → ~20.

**PR 2 — Rename `renderFilterChipRow` → `renderFilterChips`**
- Pure rename in `helpers.js:212` and its 7 call sites (`browser.js:198–200`, `gardens.js:638–640`, `import.js:75–77`). Also rename `bindFilterChipRow` → `bindFilterChips` (`helpers.js:231`).
- Verification: `grep -rn renderFilterChipRow projects/plant-planner/web` returns 0; `grep -rn renderFilterChips` returns 8 (def + 7 calls).

### Phase 2 — Introduce `ui/` + shared modal

**PR 3 — Introduce `web/ui/`; extract canonical components from `helpers.js`**
- Create `projects/plant-planner/web/ui/`.
- Extract into new files (each still uses implicit `window.foo = foo` globals):
  - `ui/filter-chips.js` ← `renderFilterChips` + `bindFilterChips` (`helpers.js:212, :231`)
  - `ui/plant-info.js` ← the `_plant*Bullets` / `_plantInfoSectionsHtml` / `_plantChipRowsHtml` / `_plantSourceHtml` / `_renderDetailBullets` / `_plantRefreshButtonHtml` cluster (`helpers.js:262–525`)
  - `ui/fill-progress.js` ← `_fillStepIcon`, `renderFillProgress`, `setFillStep` (`helpers.js:526–605`)
- Add `<script defer src="ui/<file>.js">` tags to `index.html` between `helpers.js` and the feature files.
- `helpers.js` keeps: `showView`, `updateNav`, `showThemeSettings`, `yearScale`, `sunlightLabel`/`Icon`, `_initIcons`, `_qs`, `apiFetch` (if present), `render()`, `validatePlacement`. Goal: drop `helpers.js` from 644 → ~200 lines.
- Verification: `wc -l helpers.js` drops; total JS line count unchanged; DevTools console clean on hard reload.

**PR 4 — Build `ui/pp-modal.js` with `.show` / `.confirm` / `.alert` / `.dismiss`**
- New file: `web/ui/pp-modal.js`. Parallels boardgame-buddy's `PolaroidPopup` (`projects/boardgame-buddy/web/ui/polaroid-popup.js`, 483 lines — reference for the lifecycle) and post-audit sauceboss's `SauceBossPopup` (`projects/sauceboss/web/ui/sauce-popup.js`).
- API:
  - `PPModal.show({ title, body, buttons, dismissable })` → mounts a backdrop + card into `#pp-modal` host div.
  - `PPModal.confirm({ title, body, confirmLabel, cancelLabel, destructive })` → returns `Promise<boolean>`.
  - `PPModal.alert({ title, body })` → returns `Promise<void>` on dismiss.
  - `PPModal.dismiss()` → close current.
- CSS family `.pp-modal*` lives in `styles.css` in a dedicated section. Uses `var(--pp-accent)` / `var(--pp-cream)` / `var(--pp-shadow-lg)` tokens; `destructive` styling uses the new `var(--pp-danger)` from PR 1.
- Add `<div id="pp-modal"></div>` to `index.html` as a sibling of the navbar.
- Verification: from DevTools console, `PPModal.confirm({ title: "Test", body: "Hi" }).then(console.log)` opens the modal and resolves a boolean.

**PR 5 — Migrate all 16 `confirm()` / `alert()` sites to `PPModal`**
- 6 confirm sites: `garden.js:278` (reseed — destructive), `gardens.js:257`, `:806` (discard wizard — data-loss), `gardens.js:909` (delete garden — destructive), `library.js:215` (remove from library — destructive), `shopping.js:279` (leave shopping — informational).
- 10 alert sites: listed in §5 above.
- Each call site goes from `if (!confirm("…")) return;` to `if (!(await PPModal.confirm({...}))) return;`. Enclosing functions become `async`.
- Use `destructive: true` on PPModal.confirm for reseed, delete garden, remove from library. Wizard-discard + shopping-leave are data-loss but not irreversible — `destructive: false`.
- Verification: `grep -nE '\bconfirm\(|\balert\(' projects/plant-planner/web/*.js | grep -v //` returns 0. Manually trigger one destructive on each affected surface: reseed in builder, discard during wizard, delete a garden, remove a library plant, leave shopping mid-shortlist.

### Phase 3 — Canonical Plant object

**PR 6 — Build `ui/plant-card.js` with `renderPlantCard(plant, { variant })`**

The headline win. One canonical render function that all three current renderers collapse into.

- New file: `web/ui/plant-card.js`.
- Opts: `variant: "shopping" | "browser" | "library"`, plus `entry` (user_plants row, for browser/library), `picked` (shortlist flag, for shopping), `index` (for `--i` stagger), `gardens` (for library "In: <name>" chips), `editMode`.
- Behavior unification:
  - `variant: "shopping"` → renders today's `.shopping-card` shape (image, title, scientific subline, bullets, heart button). Replaces `_renderShoppingCard` (`shopping.js:222`).
  - `variant: "browser"` → renders today's `.shopping-card.browser-card` shape (same body + 2-button action set: leaf "Add to plant list" / heart "Add to favorites"). Replaces `_renderBrowserCard` (`browser.js:249`).
  - `variant: "library"` → renders today's `.garden-card.library-card` shape (status pill + planter chips replace bullets, plus Details/Remove action buttons). Replaces `_renderLibraryCard` (`library.js:114`).
- `_plantBullets(plant)` private helper for the 5-bullet row (sunlight/watering/cycle/zone/edible) used by shopping + browser variants.
- `_plantImageFor(plant, preferredSize)` consolidates `_shoppingImageFor` (`shopping.js:252`) + `_libraryImageFor`.
- Verification:
  - `grep -rn '_renderShoppingCard\|_renderBrowserCard\|_renderLibraryCard\|_shoppingImageFor\|_libraryImageFor' projects/plant-planner/web` returns 0 (or only definition + comment).
  - Walk the three surfaces: Shopping grid (in wizard flow), Plant Browser grid, My Plants library grid. Visual parity with pre-PR.
- This is the central duplication finding (§4a) resolved.

**PR 7 — Build `ui/plant-detail-panel.js` with `renderPlantDetailPanel(plant, opts)`**
- New file: `web/ui/plant-detail-panel.js`. One function that mounts the slide-in panel into a single host div.
- Opts: `variant: "shopping" | "browser" | "library"`, `userEntry`, `picked`, `gardens`, `onAction(actionId)`.
- Unifies the three detail-panel openers from §4b:
  - Shopping (`shopping.js:364` open, `:429` dismiss)
  - Browser (`browser.js:497` open, `:566` dismiss)
  - Library (`library.js:239` open, `:442` dismiss)
- The panel **body** uses `ui/plant-info.js` (already shared post-PR 3).
- Action footer differs per variant (shopping: heart; browser: leaf+heart; library: status radio + qty + notes + add-to-planter picker + remove). Each variant declares its own footer; the body + slide-in chrome are shared.
- Reduce 3 host divs to 1 (`#pp-plant-detail` in `index.html`) since only one panel is open at a time.
- Verification: each detail panel still opens with the same affordance (card tap), the slide-in animation is unchanged, the same actions work end-to-end on each surface.

### Phase 4 — Polish

**PR 8 — Build `ui/plant-grid.js` to unify the three grid hosts**
- Tiny wrapper: `renderPlantGrid(plants, { variant, ... })` produces `<div class="<gridClass>"> ${plants.map(p => renderPlantCard(p, { variant, ... })).join('')} </div>` so the three views stop reaching into `_renderShopping` / `_renderBrowser` / `_renderLibrary` grid loops directly.
- Touches `shopping.js:189`, `browser.js:183`, `library.js:106`. Each view passes `variant` + the items array.
- Verification: 3 grids render identically. Empty-state placeholder logic stays in the views (today it's inlined into each grid loop).

**PR 9 — Tap-target audit + fixes**
- `.claude/rules/web-frontend.md` requires ≥44×44 px hit areas. Spot-check the heart button on shopping cards (currently visually ~32×32 per CSS inspection), the leaf/heart pair on browser cards, the close-X on detail panels, the chevron in the filter disclosure (`browser.js`), the kebab in the garden toolbar (`garden.js`).
- Fix any <44px tap target by padding the wrapping button — keep the glyph size visually unchanged. CSS-only change in `styles.css`.
- Verification: DevTools "Show layout" overlay confirms ≥44×44 on every audited element.

### Phase 5 — Structural carve-out

**PR 10 — Introduce `web/widgets/`; extract the New-Garden wizard from `gardens.js`**
- Create `web/widgets/` directory.
- Extract the 4-step wizard (was 7-step, now 4 after the 2026-05-10 consolidation per `STRUCTURE.md` Active Development Notes) from `gardens.js` (922 lines) into `widgets/garden-wizard.js`:
  - `renderGardenWizard*` phase renderers (Filters, Planter, Catalog source, Review)
  - `submitGardenWizard`, `_wizardNext`, `_wizardBack`, `_validateWizardStep`
  - `_toChipOptions` and other wizard-only lookup helpers
  - Modal sites at `gardens.js:257, :806` (wizard cancel paths) — these become `PPModal.confirm` calls via PR 5
- Also extract `web/location.js` (270 lines, ZIP / geolocation picker — used only from the wizard's step 4 + the builder's "Change zone" kebab) into `widgets/location-picker.js`.
- `gardens.js` thins to just the My-Gardens list renderer + delete handler (drops to ~250 lines).
- Update `<script defer>` tags in `index.html` between `ui/` and the feature files.
- Verification: `wc -l gardens.js` drops from 922 → ~250; widget files account for the rest. Wizard end-to-end still works (open from My Gardens, step through, save, land in shopping).

**PR 11 — Introduce `web/views/`; rename per-screen files**
- Create `web/views/` directory.
- Rename (one per screen):
  - `gardens.js` → `views/gardens-list-view.js`
  - `shopping.js` → `views/shopping-view.js`
  - `browser.js` → `views/browser-view.js`
  - `library.js` → `views/library-view.js`
  - `import.js` → `views/import-view.js`
  - `garden.js` → `views/garden-builder-view.js`
  - `auth.js` → `views/auth-view.js`
- Also tuck the two renderers into a peer `web/renderers/`:
  - `render2d.js` → `renderers/render2d.js`
  - `preview3d.js` → `renderers/preview3d.js`
- Update `<script defer>` tags in `index.html`. Load order: state → helpers → ui/ → widgets/ → renderers/ → views/ → init.
- Verification: app routes work identically. `state.currentView` dispatch in `helpers.js` `render()` is unchanged because functions stay global.

**PR 12 — Introduce `web/domain/`; extract per-object state shims**
- Create `web/domain/` directory.
- Three files matching the core objects:
  - `domain/plant.js` — Plant shape (cache row), library-status helpers (`isInLibrary`, `libraryStatusFor`), shortlist helpers (`isInShortlist`). Today these are inline in `browser.js` / `library.js` / `shopping.js`.
  - `domain/garden.js` — Garden shape, conditions formatter (`formatConditionsLabel`). The per-type geometry helpers stay in `garden-units.js` (canonical per `STRUCTURE.md`).
  - `domain/placement.js` — Placement shape + the `validatePlacement` function currently at `helpers.js:633`.
- Optionally create `web/types.d.ts` declaring the cross-file globals (`state`, the fetch shims, `render`) and importing typedefs from `domain/*.js` (per `.claude/rules/typed-js.md`). Mark this file's creation as optional — the project doesn't have one today and adding it is editor-only.
- Update `<script defer>` tag order in `index.html`: state → domain → helpers → ui → widgets → renderers → views → init.
- Update `Docs/ARCHITECTURE.md` §1 "Object set" to point at the new `domain/` files.
- Verification: app behaves identically. The final layout matches `.claude/rules/ui-object-design.md` §6:

  ```
  web/
  ├── domain/       plant.js, garden.js, placement.js
  ├── ui/           filter-chips, plant-info, fill-progress, pp-modal,
  │                 plant-card, plant-detail-panel, plant-grid
  ├── widgets/      garden-wizard, location-picker
  ├── renderers/    render2d, preview3d
  ├── views/        auth-view, gardens-list-view, garden-builder-view,
  │                 shopping-view, browser-view, library-view, import-view
  ├── helpers.js, init.js, state.js, theme.js, garden-units.js
  └── index.html, styles.css, build.sh, config.js
  ```

---

## 10. Cleanup log

### Pass 1 (initial audit) — 2026-05-24

Inventory only; no code changes. This document + `Docs/ARCHITECTURE.md` produced; fix sequence in §9 is the executable follow-up plan.

Future passes append their entries below (one per audit-fix PR or PR cluster).

---

## Appendix — How this audit was produced

Every component count, dead-code claim, and `confirm`/`alert` citation in this document is `grep`-verified. Key commands:

```
# Render function definitions
grep -n "^function " projects/plant-planner/web/*.js

# Plant card renderer call sites
grep -rn "_renderShoppingCard\|_renderBrowserCard\|_renderLibraryCard" projects/plant-planner/web

# Detail panel mount divs + open functions
grep -rn "detail-panel\|_openDetail\|_dismissDetail\|_closeLibraryDetail" projects/plant-planner/web

# Destructive action sites
grep -nE '\bconfirm\(|\balert\(' projects/plant-planner/web/*.js | grep -v '//'

# Dynamic CSS class builds (sanity check)
grep -nE 'class="[^"]*\$\{' projects/plant-planner/web/*.js

# Hex literal counts in CSS
grep -oE "#[0-9A-Fa-f]{6}" projects/plant-planner/web/styles.css | sort | uniq -c | sort -rn

# Top-level class selectors
grep -c "^\.[a-zA-Z]" projects/plant-planner/web/styles.css

# var() usage (sanity check on design tokens)
grep -c "var(--" projects/plant-planner/web/styles.css

# File sizes
wc -l projects/plant-planner/web/*.js
```

To reproduce or extend: re-run those greps after any refactor and update the counts in §3 and §4. Each "Pass N" entry in §10 should re-run the relevant grep gates and report any drift.
