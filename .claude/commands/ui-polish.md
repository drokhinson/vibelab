Polish the UI for project: $ARGUMENTS

This skill is used AFTER the prototype is functionally working. Do not add features — only improve the visual and interaction quality.

## Steps

1. **Read STRUCTURE.md** and the current `projects/$ARGUMENTS/web/` files.

2. **Audit current UI** — Look for:
   - Missing loading states (show spinner while fetching)
   - Missing error states (show friendly message on network failure)
   - Missing empty states (show message when no data)
   - Inconsistent spacing (use CSS custom property spacing vars)
   - Text that's hard to read (check contrast vs background)
   - Unresponsive layout on mobile (max-width 480px, padding 1rem)
   - Elements that are not tappable/clickable enough (min 44px touch targets)

3. **Apply improvements** in `projects/$ARGUMENTS/web/styles.css`:
   - Set the project accent color via CSS custom properties
   - Add smooth transitions for interactive elements (`transition: 0.15s`)
   - Add hover/active states for clickable cards
   - Ensure the layout works at 375px (iPhone SE) viewport width
   - Add entrance animations (see Motion section below)

4. **Visual Richness Checklist** — Apply all of the following:
   - [ ] **Icons:** Replace emoji used as UI chrome (back buttons, nav icons, action icons) with Lucide SVG icons. Keep content/data emojis (food, plants, etc). Add Lucide CDN if not already present: `<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>` and call `lucide.createIcons()` after render.
   - [ ] **Illustrations:** Add an SVG illustration to each empty state and the app's home/hero screen. Source from undraw.co (free, MIT license). Download SVG, inline it in the relevant JS render function, set its primary fill color to the project accent.
   - [ ] **Motion — entrance:** Add `@keyframes fadeUp` to styles.css and apply to card/list containers. Cards should fade in and slide up 12px over 200ms.
   - [ ] **Motion — stagger:** On list items rendered in JS, set `style="--i: ${index}"` and apply `animation-delay: calc(var(--i) * 40ms)` in CSS so items cascade in.
   - [ ] **Motion — hover lift:** Cards and clickable rows get `transform: translateY(-2px)` + increased shadow on hover.
   - [ ] **DaisyUI migration:** If the project is on Pico.css, migrate it to DaisyUI v4. Add to `<head>`: `<link href="https://cdn.jsdelivr.net/npm/daisyui@4/dist/full.min.css" rel="stylesheet">` and `<script src="https://cdn.tailwindcss.com"></script>`. Assign a named DaisyUI theme in `<html data-theme="[theme]">` that matches the project's mood (e.g. "autumn" for warm/food, "garden" for nature, "night" for finance/dark, "retro" for playful). Remove the Pico CDN link. Refactor custom CSS classes to DaisyUI equivalents where possible.

5. **Polish JS render functions** if needed:
   - Ensure loading → content transition is smooth
   - Add skeleton loading placeholders for slow connections
   - Add micro-interaction feedback on user actions
   - Call `lucide.createIcons()` at the end of each render function that outputs Lucide icon `<i>` tags

6. **Review the landing page card** — After polishing, update `registry.json` if the status should change (e.g., wip → prototype).

## Motion Reference

Add to `styles.css`:
```css
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}

.card-list .card,
.card-grid .card {
  animation: fadeUp 200ms ease both;
  animation-delay: calc(var(--i, 0) * 40ms);
}

.card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
  transition: transform 0.15s, box-shadow 0.15s;
}
```

In JS render functions, add `style="--i:${index}"` to each list item element.

## DaisyUI Theme Reference

| Project mood | DaisyUI theme |
|---|---|
| Food / warm / orange | `autumn` |
| Nature / garden / green | `garden` |
| Finance / dark / serious | `night` |
| Outdoor / adventure | `forest` |
| Playful / word games | `retro` |
| Default / neutral dark | `dark` |

Do not add new API calls, new features, or change the app's data model. Visual improvements only.
