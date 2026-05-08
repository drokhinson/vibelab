Iterate on the PlantPlanner project via a persona-driven multi-agent loop. Optional argument: $ARGUMENTS (max iterations as integer, default 6).

## Goal

PlantPlanner today is a single-feature 3D visualizer with a heavy filter sidebar. The redesign target is **one UI that serves three personas** — hobby, wildflower, and food gardener — without growing the filter sidebar. This skill runs an autonomous loop: persona agents critique the current state, a UI/UX agent picks the highest-impact bundle, a dev lead decomposes it, dev agents implement, the orchestrator commits, and the loop continues until all three personas signal ≥4/5 satisfaction or the iteration cap is reached. One commit per iteration on `claude/agentic-planter-redesign-9nClG`.

**Existing user data is disposable.** Migrations may freely `DROP TABLE ... CASCADE` and rebuild. No backfills, no compatibility shims.

---

## Phase 0 — Setup (orchestrator, sequential)

1. Parse `$ARGUMENTS` → `MAX_ITERATIONS` (integer, default 6, valid range 1–10).
2. Verify branch with `git branch --show-current`. If not on `claude/agentic-planter-redesign-9nClG`, run `git checkout -B claude/agentic-planter-redesign-9nClG` (create or switch).
3. Read these files in parallel and build a "current state brief" (≤400 words, plain text):
   - `projects/plant-planner/STRUCTURE.md`
   - `db/schema/plantplanner.sql`
   - `projects/plant-planner/ITERATIONS.md` (if exists; otherwise note "no prior iterations")
   - List of files under `projects/plant-planner/web/` and `shared-backend/routes/plant_planner/` (via `ls` or `find`).
4. The current state brief MUST include: what the app does today, the 3D/grid model, the data columns available, what's been shipped in prior iterations, and what each persona was still missing per the last log entry. Pass this brief verbatim into every Phase A–E agent so they share grounding.

If a previous run halted mid-iteration (uncommitted changes present), surface this to the user and stop. Do not auto-discard work.

---

## Phase A — Persona feedback (3 Explore agents, parallel, single message)

Spawn three `Agent` calls with `subagent_type=Explore` in **one message**. Each gets the current state brief plus the persona brief below.

**Shared output contract** (every persona returns this exact JSON shape, no prose):
```json
{
  "persona": "hobby|wildflower|food",
  "satisfaction": 1-5,
  "would_be_5_of_5": "one sentence",
  "unmet_needs": [
    {"title": "...", "why": "...", "success_criteria": "...", "priority": "high|med|low"}
  ]
}
```

**Persona briefs** (append after the shared output contract):

### Hobby gardener
> You are a casual home gardener. You want a pretty result and to understand what you've planted, without learning horticulture jargon. You optimize for: visual realism in the 3D preview, plain-language tooltips ("loves sun, drink weekly"), low cognitive load, friendly empty-states, sensible defaults. You don't care about hardiness zones, native species, or yield optimization in detail — but a "this won't grow well together" warning is welcome. Read the current state brief, browse `projects/plant-planner/web/` and the `GET /plants` response shape. List your top 3–5 unmet needs and rate satisfaction.

### Wildflower gardener
> You plant for pollinators and prefer regional natives. You optimize for: a `native: true/false` flag and filter, a hardiness-zone (USDA) selector that filters the catalog, a monthly bloom-calendar visualization (Jan–Dec strip showing what's flowering), and a year-1 / year-2 / year-3+ growth preview because perennials look very different over time. You do not care about food yield. Read the current state brief, the schema (`db/schema/plantplanner.sql`), and `render3d.js`. List your top 3–5 unmet needs and rate satisfaction.

### Food gardener
> You grow vegetables for actual harvest. You optimize for: companion-planting rules (tomato↔basil good, tomato↔fennel bad), days-to-harvest, frost dates by zone, **real-radius placement** (plants placed by spacing-circle, not grid cell), plant **height** so you can reach to harvest (don't trap a short plant behind a tall one), **container/plot type** (greenhouse, raised bed, planter, in-ground), and **succession/rotation** across the season. You don't care about decorative flowers (except as companions). Read the current state brief, schema, and `garden.js`/`render3d.js` to see how placement currently works (grid_x/grid_y). List your top 3–5 unmet needs and rate satisfaction.

---

## Phase B — UI/UX synthesis (1 general-purpose agent, sequential)

Spawn one `Agent` with `subagent_type=general-purpose`. Pass: the current state brief + all three Phase A JSON reports + the iteration log.

**Brief:**
> You are the UI/UX lead for PlantPlanner. The product mandate is **one UI that serves all three personas** — no per-persona modes. Pick **one** highest-impact feature bundle for this cycle that advances the most personas with the least UI growth.
>
> Hard constraints:
> - The filter sidebar (`web/catalog.js`) cannot grow in pixel height. Any new filtering must compress, replace, or fold into existing UI surface (chip rows, collapsible accordions, contextual reveal, search-as-filter).
> - Vanilla HTML/JS, CDN-only, no build step (per `.claude/rules/web-frontend.md`).
> - Each iteration must be demoable in a browser by the end.
>
> Output a single design spec in this exact markdown shape:
> ```
> # Iteration <N>: <Title>
> Pitch: <one sentence>
> Personas served: <hobby/wildflower/food, with which need each addresses>
>
> ## UI changes
> <component-level description; ASCII mockup if a layout shifts>
>
> ## Data model changes
> <columns/tables to add or replace; explicit list of dropped tables/columns>
>
> ## Backend changes
> <endpoints added or response-shape changes>
>
> ## Acceptance criteria
> <bulleted, testable>
>
> ## Files to touch
> <bulleted absolute paths>
>
> ## Non-goals this cycle
> <bulleted>
> ```

If multiple persona needs conflict (e.g., hobby wants grid simplicity while food wants radius placement), the UI/UX agent must explicitly call out the conflict in `Non-goals` and pick the path that keeps a single UI.

---

## Phase C — Dev lead decomposition (1 general-purpose agent, sequential)

Spawn one `Agent` with `subagent_type=general-purpose`. Pass the design spec from Phase B.

**Brief:**
> You are the dev lead. Convert the design spec into an ordered task list grouped by domain. Output JSON:
> ```json
> {
>   "db": [{"file": "db/migrations/plantplanner/00N_<slug>.sql", "instructions": "..."}],
>   "backend": [{"file": "shared-backend/routes/plant_planner/<file>.py", "instructions": "..."}],
>   "frontend": [{"file": "projects/plant-planner/web/<file>.js", "instructions": "..."}],
>   "schema_snapshot": {"file": "db/schema/plantplanner.sql", "instructions": "regenerate from new migration state"},
>   "dependencies": ["db before backend", "backend before frontend if response shape changed"],
>   "parallelizable": ["frontend can run in parallel with backend if no API change"]
> }
> ```
> Determine the next migration number by checking existing files under `db/migrations/plantplanner/`. Existing data is disposable — migrations may DROP and recreate.

---

## Phase D — Implementation (general-purpose agents, mixed parallel/sequential)

Run in this order, respecting `dependencies` from Phase C:

1. **DB agent** (if `db` tasks exist) — sequential, runs first. One agent writes the migration AND updates `db/schema/plantplanner.sql` to match.
2. **Backend agent** + **Frontend agent** — spawn in parallel (single message, two `Agent` calls) if `parallelizable` says so; otherwise sequential.

Each dev agent's brief includes:
- The full Phase B design spec (for context)
- Their domain-specific task slice from Phase C
- This standing instruction:
  > Vibelab's `.claude/rules/*.md` auto-load by file path — follow them. Specifically: vanilla HTML/JS no-build (web), Pydantic models + async + enums (backend), per-app migration counter + RLS + grant + schema snapshot in sync (db). Keep files under ~300 lines; split modules if needed. Do not write tests, comments-for-the-task, or PRs. Make the change, save, return a summary diff.

After all dev agents complete, the orchestrator reads the diff (`git diff --stat`) and confirms the files listed in the design spec were actually modified. If any expected file is untouched, surface to the user and stop.

---

## Phase E — Validation (1 general-purpose agent, sequential)

Spawn one `Agent` with `subagent_type=general-purpose`.

**Brief:**
> Validate this iteration's changes:
> 1. `git diff --stat` — sanity check.
> 2. For each modified `.py` file: `python -m py_compile <file>`.
> 3. If any backend route changed: `cd shared-backend && source .venv/bin/activate && uvicorn main:app --port 8765 &` (background), wait briefly, then `curl -s http://localhost:8765/api/v1/plant_planner/health` and `curl -s http://localhost:8765/api/v1/plant_planner/plants | head -c 500`. Kill the uvicorn process when done.
> 4. For frontend changes: read `projects/plant-planner/web/index.html` end-to-end and verify all `<script src=...>` files exist.
> 5. For schema changes: confirm `db/schema/plantplanner.sql` mentions every table referenced in the migration.
> Return: `{"status": "pass|fail", "blockers": [...], "notes": "..."}`.

If `fail`, the orchestrator may launch **one** retry round: feed blockers back to the relevant dev agent. After one retry, if still failing, halt the loop and surface to the user. Do not commit a broken state.

---

## Phase F — Commit & log

Once validation passes:

1. `git add` only the files that were actually modified (do not blanket `git add -A`).
2. Commit with HEREDOC, message format:
   ```
   [plant-planner] <design spec title>
   ```
   No Claude-Code attribution line in commit messages — vibelab convention is bare `[project] description`.
3. Push to `claude/agentic-planter-redesign-9nClG` with `git push -u origin claude/agentic-planter-redesign-9nClG`. On network failure, retry up to 4 times with 2s/4s/8s/16s backoff (per repo git rules).
4. Append to `projects/plant-planner/ITERATIONS.md`:
   ```
   ## Iteration N — <title> — <short SHA>
   Persona ratings (pre): hobby=X/5, wildflower=Y/5, food=Z/5
   Shipped: <bullets from acceptance criteria>
   Hobby unmet: <bullets>  (or "satisfied")
   Wildflower unmet: <bullets>
   Food unmet: <bullets>
   Notes: <UI/UX rationale + any deferred conflicts>
   ```
5. Do NOT open a PR.

---

## Phase G — Loop check (3 Explore agents, parallel, lightweight)

Re-poll personas against the new state. Same Explore agents as Phase A but with the briefer prompt:
> Given the new current state (read the file diff and the latest ITERATIONS.md entry), re-rate satisfaction 1–5 and list at most 2 still-unmet needs. JSON only:
> ```json
> {"persona": "...", "satisfaction": N, "still_unmet": ["..."]}
> ```

Update the ITERATIONS.md entry's "Persona ratings" line with `(post)` ratings.

**Halt conditions:**
- All three personas rate ≥4/5 AND each `still_unmet` list is empty → **converged**, summarize and exit.
- Iteration count = `MAX_ITERATIONS` → **cap reached**, summarize and exit with remaining gaps listed.
- Phase E failed twice → **broken**, surface and exit.

Otherwise: increment iteration counter, loop back to Phase A with the freshly updated current state.

---

## Final output (after halt)

Print a summary to the user:
```
PlantPlanner iteration loop complete (<reason>).
Iterations run: N (cap was MAX)
Commits:
  - <sha> [plant-planner] <title>  (h=X/5 w=Y/5 f=Z/5)
  - ...
Final persona ratings: hobby=X/5, wildflower=Y/5, food=Z/5
Remaining gaps:
  - hobby: <bullets or "none">
  - wildflower: ...
  - food: ...
Branch: claude/agentic-planter-redesign-9nClG (pushed)
Log: projects/plant-planner/ITERATIONS.md
```

Then ask the user whether to open a PR (do not open one without confirmation).

---

## Guardrails

- **Never run on `main`.** Phase 0 must verify the branch.
- **One commit per iteration.** Don't squash multiple iterations into a single commit; the log relies on 1:1 mapping.
- **Don't skip hooks.** No `--no-verify`. If a hook fails, fix the underlying issue and create a new commit.
- **Don't open PRs autonomously.** Only at the user's explicit request after the loop ends.
- **Don't preserve old data via shims.** Migrations are destructive by design this iteration cycle.
- **Don't grow the filter sidebar.** This is the founding UX constraint; the UI/UX agent owns enforcing it, but the orchestrator should reject a Phase B spec that violates it (one retry to revise).
- **Persona agents are read-only (Explore).** Never grant them write access — their job is critique, not implementation.
- **No backwards-compat code.** Per CLAUDE.md: just change the code.
- **`raw_rules_text`-style truncation does not apply here** — this skill works on a real codebase, not external content.

## Input validation

If `$ARGUMENTS` is non-empty and not a valid integer in 1–10, ask the user to clarify before starting. If empty, default to 6 and proceed silently.
