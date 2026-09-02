Polish the UI for project: $ARGUMENTS

This skill is used AFTER the prototype is functionally working. Do not add features — only improve the visual and interaction quality.

The rules in `.claude/rules/` are the standard this skill enforces. Read `theming.md`, `overlays.md`, `mobile-web.md`, `web-frontend.md` and `ui-object-design.md` before starting; everything below is the order to apply them in, not a substitute for them.

## Steps

1. **Read `STRUCTURE.md`**, `Docs/ARCHITECTURE.md` and `Docs/UI_AUDIT.md` if they exist, and the current `projects/$ARGUMENTS/web/` files.

2. **Audit against the paradigm.** Work the checklist in §4. Write down what is off before changing anything — a `/ui-polish` pass that only fixes what it happened to notice first is how projects drift.

3. **Apply improvements**, smallest blast radius first: tokens, then shared components, then individual screens. A change to a token beats the same change made at twenty call sites.

4. **Paradigm checklist** — every item, in this order:

   - [ ] **Themes.** Does the project ship light *and* dark? If not, that is the largest single win available and it comes first: add the token blocks, the pre-paint boot and the controller per `.claude/rules/theming.md`. If it does, render **both** and check every screen in each.
   - [ ] **Tokens, not literals.** Grep the stylesheet and the JS for hex literals and `rgba(`. Every one that is not a data-derived accent or a `var(--token, #fallback)` belt-and-braces is a bug in one of the two themes. Shadows especially: `rgba(0,0,0,…)` is invisible on a dark ground.
   - [ ] **Surfaces.** For each card, sheet and overlay, is it ground, paper or chrome? Grep its CSS for `oklch(var(--b` and `--accent-hover` and re-point per the substitution table. This is the single most common source of a 1.6:1 label.
   - [ ] **Contrast.** State the ratio for every colour pair you touch, in both themes. Record the minimum you achieved in the commit message.
   - [ ] **Choice lists.** Any `position: absolute` list hung off an input becomes a bottom sheet (`.claude/rules/overlays.md`), unless it is already inside a fixed, viewport-sized panel. If a dropdown needs a fit pass or a z-index override to survive, that is the argument for a sheet.
   - [ ] **Overlay dismissal.** Every sheet, modal and popup closes four ways, all running one close path: the ×, a tap **outside the card** (test `!target.closest(".card-class")`, never `target === backdrop` — chrome parked beside the card is outside it too), Escape, and the phone's back button. Open each overlay and press back: if the page behind it moves, it is missing a back guard (`.claude/rules/overlays.md` §8).
   - [ ] **No autofocus on open.** No overlay focuses a text input as it opens — it throws a keyboard over the thing the user opened. Focus a row, the checked option, or the panel itself (`tabindex="-1"`); seed the list rather than the field (`.claude/rules/overlays.md` §5).
   - [ ] **Tap targets.** 44px floor, 52px commit buttons, 56px list rows. Enlarge hit areas with a negatively-inset `::before`, not by inflating the control. Every touch surface has an `:active` state — touch has no hover.
   - [ ] **Chrome and layering.** One documented z-index ladder. Heights as tokens with offsets derived by `calc()`. `body { overflow-x: clip }`, never `hidden`. Docked bars are `position: fixed`, not sticky. A globally-reachable screen closes; a child screen goes back.
   - [ ] **Loading / empty / error.** Three states, three branches. Never paint an empty state while a fetch is in flight; never paint one on a failed fetch — that needs its own branch with a retry and an automatic retry on reconnect.
   - [ ] **Icons.** Vendored into the project, never a CDN. Phosphor over Lucide. Built through `DOMParser`, not `innerHTML` on an SVG element. Sizing floor wrapped in `:where()`. A name that can come from the database falls back to a neutral glyph.
   - [ ] **No emoji anywhere in the UI** — not as chrome, not as data marks, not in copy. Content/data marks are custom SVG sprites under `web/assets/sprites/` per `.claude/rules/assets.md`. Migrate any emoji this pass touches.
   - [ ] **Illustrations.** Every empty state, loading screen and hero gets an SVG illustration under `web/assets/illustrations/`, checked on both grounds (`.claude/rules/assets.md`).
   - [ ] **One object, one component.** Did this pass create a second implementation of something `ui/` already renders? Fold it back (`.claude/rules/ui-object-design.md` §4).
   - [ ] **Responsive.** Works at 375px (iPhone SE). Max width 480px single-column, 900px dashboards.

5. **Polish JS render functions** if needed:
   - Loading → content transitions are smooth; slow connections get skeletons, not a blank screen.
   - Mutations paint optimistically and re-render surgically — a single-item change must not tear down the whole screen (`.claude/rules/web-frontend.md` § Interaction).
   - Re-run the icon pass after every `innerHTML` patch, including inside sheets and modals.

6. **Update the docs you invalidated.** If the project has a `Docs/UI_AUDIT.md`, add a pass entry: what changed, what CSS and JS was deleted, what is still open. If token values or the file map moved, fix `Docs/ARCHITECTURE.md` in the same commit. A stale design doc proposes itself to the next contributor as current.

7. **Review the landing page card** — update `registry.json` if the status should change (e.g. wip → prototype).

## Motion Reference

```css
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}

.card-list > *,
.card-grid > * {
  animation: fadeUp 200ms ease both;
  animation-delay: calc(var(--i, 0) * 40ms);
}

/* Press feedback is :active — touch has no hover. */
.card-lift { transition: transform 0.15s, box-shadow 0.15s; }
.card-lift:active { transform: translateY(0) scale(0.995); }

/* Hover lift is an enhancement on pointer devices, never the only feedback.
   The shadow comes from the theme ramp so it survives a dark ground. */
@media (hover: hover) {
  .card-lift:hover { transform: translateY(-2px); box-shadow: var(--sh-3); }
}
```

In JS render functions, add `style="--i:${index}"` to each list item element.

## Migrating a project onto the design system

For a project still on Pico.css or a single fixed DaisyUI theme:

1. Add the token blocks and the theme lever first (`.claude/rules/theming.md` §1–5). Nothing else can be done correctly before the vocabulary exists.
2. Swap the Pico CDN for the DaisyUI + Tailwind pair; keep `data-theme` frozen at a neutral value and drive light/dark from the project attribute.
3. Replace literals with tokens, file by file, checking both themes as you go.
4. Split `styles.css` and any file over ~300 lines per `.claude/rules/web-frontend.md`.

Do not add new API calls, new features, or change the app's data model. Visual and interaction improvements only.
