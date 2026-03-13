Polish the UI for project: $ARGUMENTS

This skill is used AFTER the prototype is functionally working. Do not add features — only improve the visual and interaction quality.

## Steps

1. **Read STRUCTURE.md** and the current `projects/$ARGUMENTS/web/` files.

2. **Audit current UI** — Look for:
   - Missing loading states (show spinner while fetching)
   - Missing error states (show friendly message on network failure)
   - Missing empty states (show message when no data)
   - Inconsistent spacing (use Pico.css spacing vars)
   - Text that's hard to read (check contrast vs dark background)
   - Unresponsive layout on mobile (max-width 480px, padding 1rem)
   - Elements that are not tappable/clickable enough (min 44px touch targets)

3. **Apply improvements** in `projects/$ARGUMENTS/web/styles.css`:
   - Override Pico.css `--pico-primary` with an appropriate accent color for this app
   - Add smooth transitions for interactive elements (`transition: 0.15s`)
   - Add hover/active states for clickable cards
   - Ensure the layout works at 375px (iPhone SE) viewport width
   - Add a subtle entrance animation for content (opacity + translateY)

4. **Polish `app.js`** if needed:
   - Ensure loading → content transition is smooth
   - Add skeleton loading placeholders for slow connections
   - Add micro-interaction feedback on user actions

5. **Review the landing page card** — After polishing, update `registry.json` if the status should change (e.g., wip → prototype).

Do not add new API calls, new features, or change the app's data model. Visual improvements only.
