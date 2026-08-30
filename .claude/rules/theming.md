---
paths:
  - "projects/*/web/**"
  - "projects/*/app/**"
---

# Theming — Two Themes, One Token Vocabulary

Every vibelab app ships **light and dark as equal first-class themes**, driven
by one semantic token set. Not a DaisyUI mood theme picked once at scaffold
time, and not a dark-only branch bolted onto a light design.

The canonical implementation is boardgame-buddy: `web/styles.css:14–308`
(tokens), `web/index.html` "Theme boot" (pre-paint), `web/domain/theme.js`
(the controller). Read those three before writing a theme anywhere else.

---

## 1. The lever

Put the mode on `<html>` as a **project-owned attribute**, not on DaisyUI's:

```html
<html lang="en" data-theme="luxury" data-bgb="dark">
```

- `data-theme` is DaisyUI's own attribute. It stays **frozen** at whatever the
  project picked — it is not the light/dark lever, and flipping it would swap
  30-odd component colours out from under every rule at once.
- `data-<prefix>` (`data-bgb`, `data-pp`, …) is the lever. All theme rules
  select `:root[data-<prefix>="dark"]` / `="light"`.

**Override DaisyUI's oklch base inside each theme block.** This is the single
highest-leverage line in the whole system:

```css
:root, :root[data-bgb="dark"] { --b1: 12% .014 48; --b2: 9% .012 48; --b3: 18% .016 48; --bc: 90% .014 82; }
:root[data-bgb="light"]       { --b1: 96% .010 85; --b2: 99% .005 85; --b3: 89% .014 80; --bc: 24% .020 60; }
```

Every rule already painting with `oklch(var(--b*))` — ~158 of them in
boardgame-buddy — re-themes without being touched.

## 2. Boot before first paint

An inline, dependency-free IIFE in `<head>`, **before** the stylesheet link.
`init.js` is far too late; the user sees a flash of the wrong theme.

```html
<script>
  (function () {
    var stored = null;
    try { stored = localStorage.getItem("bgb.theme"); } catch (e) {}
    var mode = stored === "light" || stored === "dark"
      ? stored
      : (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light" : "dark");
    document.documentElement.setAttribute("data-bgb", mode);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", mode === "light" ? "#F7F0E1" : "#1A1310");
  })();
</script>
```

Resolution order is always: **explicit stored choice → OS preference → the
project's default mode.**

## 3. Auto is the absence of a stored key

Do not store `"auto"`. `isAuto()` is `localStorage.getItem(key) === null`, and
"switch to Auto" is `removeItem`. Storing a third value means two sources of
truth that drift.

Consequently the Settings control is a **three-way segmented control**
(Light / Dark / Auto), never a sun/moon toggle — a two-position switch cannot
express "follow the OS". Label the current resolution underneath:
`Following your device — currently dark.` / `Always light.`

## 4. Following the OS is not just a `change` listener

`matchMedia("(prefers-color-scheme: light)").addEventListener("change", …)` is
necessary and **not sufficient** on iOS. Changing appearance means leaving the
app, so the page is hidden, frozen or in the bfcache, and WebKit does not
reliably deliver a media-query change to a page in that state — the same is
true of the automatic sunrise/sunset switch. On return `matches` is already
correct but no listener ever ran.

Re-derive on every foreground event instead of depending on the event:

```js
document.addEventListener("visibilitychange", () => { if (!document.hidden) resync(); });
window.addEventListener("pageshow", resync);   // bfcache restore
window.addEventListener("focus", resync);      // standalone PWA
```

**Hold the `MediaQueryList` at module scope.** A list held only by a function
local can be garbage-collected in WebKit while its `change` listener is still
registered, and the listener then silently stops firing.

Also: an explicit choice outranks the OS — the `change` handler must no-op when
a stored value exists.

## 5. The token vocabulary

This is the repo's canonical vocabulary. Use these names in new work.

**Theme-independent** — declare in bare `:root`, above both theme blocks:
layout heights (`--nav-height`, `--header-height`), `scroll-padding-top`,
type roles (`--font-sans`, `--font-display`, `--font-score`), the spacing scale
(`--s-1`…`--s-7`, 4px base), the radius scale (`--r-xs`…`--r-pill`), `--ease`,
and any ink that sits on a surface which is light in *both* themes.

**Per-theme** — declare in each theme block, and `color-scheme: dark|light`
with them so form controls and scrollbars follow:

| Token | Means |
|---|---|
| `--bg-0` / `--bg-1` / `--bg-2` | app ground / raised / elevated |
| `--ink` / `--ink-muted` / `--ink-faint` | the foreground ramp |
| `--line` / `--line-strong` | hairlines |
| `--accent` / `--accent-hover` / `--accent-quiet` | brand colour **on the ground**, and its wash |
| `--accent-ink` | the brand colour **as text on a card or paper surface** |
| `--accent-fill` / `--on-accent` | a solid brand chip, and what is legible on top of it |
| `--win` / `--ok` / `--warn` / `--rust` | status colours (`--rust` is destructive) |
| `--paper` / `--paper-ink` / `--paper-muted` / `--paper-line` | the photo-paper surface (see §6) |
| `--well` | a field sunk *into* a card, one step below it |
| `--card-border` | `transparent` in dark, a real hairline in light |
| `--card-emboss` | top highlight on a raised strip |
| `--shadow-c` + `--sh-1/2/3` | the shadow ramp |

**`--accent` and `--accent-ink` are genuinely different colours, in both
themes.** A gold tuned to glow on an espresso ground is 1.6:1 on a cream card;
a gold that survives a white card is muddy on the ground. Do not collapse them.
Likewise `--accent-fill` may differ from `--accent`: in boardgame-buddy's light
theme, white on `--accent` (`#A87215`) is only 4.1:1, so the solid chip fills
with the darker `#8E5F10` instead.

### Legacy aliases

Older projects use an earlier vocabulary. It is not wrong, it is **superseded** —
map it when you touch the file, or alias it at `:root` if a full rename is out
of scope (travel-scrapbook already ships exactly this shim):

| Legacy | Canonical |
|---|---|
| `--bg` | `--bg-0` |
| `--bg-card` | `--bg-1` (or `--paper` if the surface is a photograph) |
| `--text-primary` | `--ink` |
| `--text-muted` | `--ink-muted` |
| `--border` | `--line` |

## 6. Three kinds of surface — the actual trap

Dark-vs-light is the easy half. The hard half is **what kind of surface this
is**:

| Surface | What it is | Light | Dark |
|---|---|---|---|
| **Ground** (`--b*`, `--bg-*`, `--ink*`, `--line*`) | the page itself | light | dark |
| **Paper** (`--paper*`, and any alias family pointed at it) | things that are *photographs* — play cards, polaroids, a parchment scroll | light | **light** |
| **Chrome** (`--sheet-*`, `--well`) | plain UI cards — a profile hub, a spoke screen, Settings | light | dark |

**Paper is light in both themes, because photo paper is light in any light.**
Point a ground token at a paper surface and it inverts: `oklch(var(--b2))`
becomes a black box on cream, `--accent-hover` becomes pale gold text at 1.6:1.
Both of those shipped before the rule existed.

On a paper **or** chrome surface, substitute:

| Ground token | Surface equivalent |
|---|---|
| `oklch(var(--b1))`, `oklch(var(--b2))` | `--polaroid-bg`, `--polaroid-bg-soft`, `--sheet-card` |
| `oklch(var(--bc))`, `--ink` | `--polaroid-ink` |
| `--ink-muted` | `--polaroid-muted` |
| `--line`, `oklch(var(--b3))` | `--polaroid-line`, `--sheet-line` |
| `--accent`, `--accent-hover` *as text* | `--accent-ink` |
| `--accent` *as a solid fill* | `--accent-fill` + `--on-accent` |

**Rule of thumb:** before placing any element on a paper or chrome surface,
grep its CSS for `oklch(var(--b` and `--accent-hover`. If either is there,
re-point it at the surface column.

This is not just an input problem. Anything whose default styles reach for the
DaisyUI base palette hits it — inputs, textareas, selects, menus, suggestion
rows, autocomplete items, list rows — as does a card written for the dark feed
and then rendered inside a light spoke screen.

## 7. A re-point block must be theme-agnostic

Re-skinning a whole screen by re-pointing the alias tokens it already reads is
the right move — it re-themes ~50 rules without editing any of them. But:

**Every value in a re-point must be a `var()` onto the ground tokens, so both
themes work by construction.** Reserve a `[data-<prefix>="dark"]` branch for the
handful of values that genuinely differ by theme.

```css
/* Theme-agnostic: each theme supplies its own values. */
:is(.set-card, .preview-card, .bgb-spoke-screen, [data-view="log-play"]) {
  --polaroid-bg:   var(--bg-1);
  --polaroid-ink:  var(--ink);
  --polaroid-line: var(--line);
  --paper:         var(--bg-1);
  --card-border:   var(--line);
  --well:          var(--bg-0);
}

/* Only what a var() cannot supply. */
:root[data-bgb="dark"] :is(.set-card, .preview-card, .bgb-spoke-screen, [data-view="log-play"]) {
  --accent-ink: var(--accent);   /* the paper gold is 1.5:1 here */
  --ok:         #6FBF7F;         /* #1F6B2E is 1.4:1 here */
}
```

**Why this is a rule and not a preference:** in `e7dbf93`, two separate PRs each
shipped a dark-only re-point for "this screen is UI, not a photograph". They
targeted overlapping selectors at *identical* specificity (0,3,0), so the
cascade settled it on source order — leaving the profile screens rendering at
three different card tones with `--ok` defined twice in two different greens.
A dark-only branch is what let them drift. Collapsing to one theme-agnostic
block was −120 lines.

Two corollaries:

- **Custom properties substitute where they are declared, not where they are
  used.** A re-point restating an alias family has to restate every member it
  wants changed; the ones it omits keep resolving against the outer declaration.
- **A genuine photo surface must never be nested inside a re-pointed screen** —
  it will silently inherit the chrome values. Check before you nest.

## 8. Body-level overlays escape their opener's re-point

A sheet or modal appended to `<body>` lands **outside** the screen that opened
it, so it keeps the root aliases: tapping a control on a dark chrome screen
threw up a cream sheet. Fix it by naming the overlay's own class in the
re-point selector list — and say so in the comment, so the next one gets added:

```
Add the next searchable sheet to this list by name.
```

Name overlays **individually**, not by their shared base class. Some overlays
are deliberately paper in both themes (a radio group over a photo-like
surface); sweeping them in by base class is a silent redesign of an app-wide
control, not a fix.

## 9. Contrast, shadows and hairlines

- **State the ratio when you move a colour token**, and check both themes.
  Boardgame-buddy's theme commits carry lines like `#1F6B2E is 1.4:1 here` and
  `minimum ratio 4.82 dark, 4.54 light`. That is the standard.
- **Tint shadows to the ground, never pure black.** `rgba(12,5,0,.62)` on
  espresso, `rgba(120,88,44,.20)` on cream.
- **Dark needs no card border; light does.** `--card-border: transparent` in
  dark and a real hairline in light. Conversely a drop shadow does no work on a
  dark backdrop — there, the top edge carries the separation.
- **A fixed-brand third-party lockup** (a navy-on-white attribution mark) must
  not be recoloured or brightness-filtered. Give it the light plate it was drawn
  for. See `.claude/rules/assets.md`.

## 10. Never hardcode a colour in a view

Colours and fonts come from tokens. The **only** legitimate inline colour is
data-derived — a per-game theme colour, a per-expansion source colour — set as
a custom property on the element (`style="--game-accent: ${game.theme_color}"`),
never as a literal `color:` or `background:`.

A literal inside `var(--token, #fallback)` is belt-and-braces, not a source of
truth. A literal anywhere else is a bug in both themes; it just happens to be
invisible in the one you were looking at.

## Anti-patterns to refactor away when touching a project

Boardgame-buddy is currently the only project on this system. The rest are
single-theme with literal hex, and should migrate the next time they get
meaningful work — same framing as the routing anti-patterns in
`.claude/rules/web-frontend.md`:

- **`projects/sauceboss/web/styles.css`** — three CSS variables total, all
  animation state. `#E85D04` and `#FFF8F0` are hardcoded at 80+ sites. Also
  still on Pico.css.
- **`projects/plant-planner/web/styles.css`** — the `--pp-*` tokens are declared
  *inside* `[data-theme="pastel"]`, so the project's own `night` theme inherits
  none of them. Two named DaisyUI themes is not a light/dark system: there is no
  token parity and no OS following.
- **`projects/daywordplay`, `projects/travel-scrapbook`** — good `:root` sets,
  light-only, legacy vocabulary. Cheapest migrations: add the second theme block
  and rename per §5.
- **`projects/wealthmate`, `projects/admin`** — dark-only, hardcoded ground.
- **`projects/spotme`** — has a `[data-theme="light"]` block but no lever, no
  boot and no OS following.

## Related rules

- `.claude/rules/web-frontend.md` — vanilla-JS conventions, chrome and layering.
- `.claude/rules/overlays.md` — sheets and modals, which §8 above depends on.
- `.claude/rules/assets.md` — assets that have to read on both grounds.
- `.claude/rules/ui-object-design.md` — components read the *surface's* tokens.
- `projects/boardgame-buddy/Docs/ARCHITECTURE.md` §4 — the reference write-up.
