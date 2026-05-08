---
paths:
  - "projects/*/shared/**/*.js"
  - "projects/*/web/**/*.js"
  - "projects/*/web/**/*.d.ts"
---

# Type Contracts for Vanilla JS

The vibelab web prototypes ship as vanilla JS — no npm, no bundler, no build step (see `web-frontend.md`). That rules out TypeScript proper, Zod, and io-ts. The pragmatic substitute is **JSDoc `@typedef` + `// @ts-check`**: comment-only annotations that VS Code, Cursor, and Claude all honor as a free editor-side type checker. Zero runtime cost, nothing to install, nothing to ship.

This rule exists because of a real bug class: the shared API client at `projects/<app>/shared/api.js` reshapes some backend responses (e.g. arrays → dicts) before handing them to consumers. When a consumer was written against the array shape and the client switched to dict, neither side complained — the bug surfaced as silent fallback behavior in the UI ("everything is uncategorized").

## Where to put types

**`shared/api.js`** — declare the shapes your client returns. Add `// @ts-check` to the top of the file, then `@typedef` blocks for any post-normalization shape, and `@returns {Promise<X>}` JSDoc on every method whose return shape differs from the raw backend response.

```js
// @ts-check

/**
 * @typedef {Object<string, string>} IngredientCategoryMap
 *   Lowercased ingredient name → category label.
 */

const api = {
  /** @returns {Promise<IngredientCategoryMap>} */
  ingredientCategories: async () => { ... },
};
```

**`projects/<app>/web/types.d.ts`** — the web app uses `<script>`-tag globals, not ES imports, so JSDoc on `shared/api.js` doesn't reach the consumer files. Add a `types.d.ts` next to the JS files that:

1. `import type { ... } from "../shared/api.js"` to pull the shared shapes in.
2. `declare global { ... }` to type the cross-file globals (`state`, the `fetch*` shims, `render`, etc.) that your `// @ts-check`-enabled files will reference.
3. Ends with `export {};` so it's treated as a module.

The `.d.ts` is type-info only; it never ships to the browser.

**Consumer files** (`init.js`, feature files) — opt in by adding `// @ts-check` at the top. The editor will surface mismatches against the `types.d.ts` declarations without affecting the runtime.

## Minimum viable checklist

When adding or editing a `shared/api.js` (or any module that transforms a backend response):

- [ ] Add `// @ts-check` to the file.
- [ ] Declare `@typedef` for every non-trivial return shape (anything that isn't `string`/`number`/a backend mirror).
- [ ] Add `@returns {Promise<X>}` to each method that reshapes the response.
- [ ] If the project has a `web/types.d.ts`, re-export the new typedef there so consumers can reference it.

## Backend complement

The frontend types are only as honest as the backend's. Per `backend-python.md`, every FastAPI route should declare `response_model=`. RPC pass-through endpoints (`return result.data`) are easy to forget; wrap them in a Pydantic row model so OpenAPI matches reality. If you find a route that skips `response_model=`, fix it in the same change as the JS-side typedef.

## Rollout

Apply incrementally:

1. Type `shared/api.js` first — it's the contract the rest of the bug class depends on.
2. Add `web/types.d.ts` covering the globals the smallest consumer file uses (usually `init.js`).
3. Add `// @ts-check` to that one file as the canary.
4. Expand to other consumers (`helpers.js`, feature files) as the `types.d.ts` grows. Don't try to type everything at once — long files like `settings.js` are noisy until the global declarations catch up.

## What this is *not*

- **No CI gate, no `tsc` step.** Editor-only. If we ever want CI enforcement, `npx -y typescript tsc --noEmit --allowJs --checkJs` against `projects/<app>/{shared,web}` is a clean future upgrade.
- **No runtime validation.** This catches mismatches at edit time, not at request time. If a backend silently changes shape in production, this won't help — backend `response_model=` and integration tests do.
- **Not a replacement for inline comments** that explain *why* a shape is what it is. The existing normalization comments in `shared/api.js` should stay; JSDoc is the structured form alongside them.
