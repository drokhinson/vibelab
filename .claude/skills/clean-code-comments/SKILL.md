---
name: clean-code-comments
description: Comment-hygiene pass over a file, a directory, or the current diff. Deletes narration, change-log commentary, stale claims and bloated rationale; keeps the comments that carry a non-obvious why. Use when asked to clean, tidy, prune, audit or review comments, when a file reads as over-commented or "AI-written", or before opening a PR.
---

# Clean Code Comments

Code already shows **how**. A comment earns its place only by carrying **why** — a
non-obvious constraint, a deliberate deviation, a gotcha, a workaround, the reason
the tempting simpler version is wrong.

Everything else is restatement, and restatement rots. It drifts out of sync with the
code it describes, it adds diff noise on every edit, and it trains readers to skim
past comments entirely — including the three that mattered.

## Scope

**Edit comments only. Never change code in this pass.** This holds even when a comment
exists because the code beneath it is unclear: that is a refactor, it belongs in its own
commit, and it goes in the flags list instead. A comment pass that also moves code is
unreviewable.

Default target, in order of what the request names: the named file or directory, else
the working-tree diff (`git diff` + staged), else ask. Do not sweep the whole repo
unprompted.

## The six rules

Run them in order over each file.

### 1 — Narration

Delete comments that restate the code, a name, a type, a signature, or that label a
block the reader can already see.

```js
// loop over the accounts            ← delete
for (const account of accounts) {

// returns the user's id             ← delete
function userId(user) {

// --- helpers ---                   ← keep (navigation, not narration)
```

This is the bulk of what a comment pass removes.

### 2 — Change narration

Delete commentary addressed to a diff rather than to a reader. `// updated to the v2
client`, `// fixed per review feedback`, `// was 300, bumped for the seed data` — none
of it means anything to someone opening the file fresh six months from now. Git carries
the history.

The exception is when the *old* behaviour is the why: `// 300ms, not 150 — Supabase
rate-limits the burst below that` is a constraint, not a change log. Keep it, and make
sure it reads as a constraint.

### 3 — Moving-target references

Delete pointers to artifacts that will move or die: a spec section number, "see the
design doc", "per the requirements". Keep durable breadcrumbs — an issue ID, a
permalinked source, a maintained doc in this repo (`STRUCTURE.md`, `.claude/rules/*.md`,
`ENV.md`).

When a pointer carries real information, rewrite it to encode the substance rather than
point at it. `// see section 4.2` becomes `// dates are stored UTC; the client localizes`.

### 4 — Bloated rationale

For comments that do carry a why: trim the throat-clearing, the restated context, and
the mechanism the code already shows. Put the comment next to the line it explains, not
at the top of the function. A system-level narrative belongs in `STRUCTURE.md` or a
`.claude/rules/` file, not in a source comment.

"Carries real rationale" and "is minimally worded" are independent judgments — a comment
can pass the first and still need cutting in half.

### 5 — Staleness

Delete or correct comments describing code that no longer exists, behaviour that has
changed, or a plan that was abandoned. Verify against the current code before rewriting;
a corrected-but-still-wrong comment is worse than none.

### 6 — Keep

Preserve, and do not re-churn:

- non-obvious constraints and the reason a simpler version fails
- cross-file consistency pointers ("mirrored in `app/src/api/client.js` — keep in step")
- semantics of a data literal that the literal cannot express (units, timezone, ordering)
- presentation contracts a caller depends on
- anything already minimal — a short, correct why-comment is done, leave it alone

## Special cases

- **TODOs** stay unless the work they describe is visibly complete. Keep the issue ID
  if one is attached.
- **Docstrings** go through all six rules, but a one-line summary on a public API or an
  exported route handler is fine even if it restates the signature.
- **Section banners** (`// --- routes ---`) are navigation. Keep them in long files;
  drop them from short ones where they outnumber the code.
- **FastAPI / Pydantic docstrings** that surface in the generated OpenAPI docs are user-
  facing output, not internal comments — hold them to the API's voice, not to rule 1.
- **Licence and attribution headers** are never touched.

## Output

Report per file:

- counts — deleted / rewritten / kept
- flags — places where a comment existed only because the code is unclear, listed as
  refactor candidates for a separate commit
- judgment calls — anything you cut that a reader might want back, so the call can be
  overridden

Then stop. Let the user review before committing; when they ask for the commit, follow
this repo's `[project-name] description` format.
