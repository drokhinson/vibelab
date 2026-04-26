Build a chunked BoardgameBuddy expansion reference guide for the base game: $ARGUMENTS

## Goal
For each major expansion of the given base game, produce one JSON bundle at `projects/boardgame-buddy/web/sample-guides/<expansion-slug>.json`. Each bundle uses only 5 chunk types — `setup`, `card_reference`, `player_turn`, `scoring`, `rulebook` — and every content chunk must **focus on what the expansion adds or changes relative to the base game**, not re-explain existing rules.

**Do NOT** write `tips` or `variant` chunks. **Do NOT** call the backend or write SQL migrations.

---

## Pipeline

### Phase A — Base Game + Expansion Discovery (serial, one Agent call)

Spawn **one** `Agent` with `subagent_type=general-purpose` (needs `WebFetch` + `WebSearch`). Give it this brief:

> You are the BGG sourcer for BoardgameBuddy. Input: base game name = `$ARGUMENTS`.
>
> Steps:
> 1. Search BGG: `https://boardgamegeek.com/xmlapi2/search?query=<url-encoded name>&type=boardgame`. Pick the best match by name similarity and BGG popularity (highest numvotes or ranks).
> 2. Fetch full detail: `https://boardgamegeek.com/xmlapi2/thing?id=<bgg_id>&stats=1`. Extract `bgg_id`, primary `name`, `yearpublished`, `minplayers`, `maxplayers`, `playingtime`.
> 3. Collect all expansion links on the `<item>` element: `<link type="boardgameexpansion" inbound="false" id="..." value="...">`. Each is an expansion FOR this base game.
> 4. Filter expansions: drop any whose name contains "promo", "Promo", "mini", "Mini", "pack", "Pack", or "errata". Drop any with year=null. If more than 6 remain, fetch stats for each via `https://boardgamegeek.com/xmlapi2/thing?id=<id>&stats=1` and rank by BGG average rating; keep the top 6.
> 5. Load base game guide for context: Read `projects/boardgame-buddy/web/sample-guides/<base-slug>.json` where `<base-slug>` is the kebab-case BGG primary name. If the file exists, join all chunk `content` fields with `\n\n---\n\n` as `base_game_guide_text`. If it does not exist, use the BGG description text as `base_game_guide_text`.
>
> Return ONLY a JSON object, no prose:
> ```json
> {
>   "base_game": {
>     "bgg_id": int,
>     "name": "primary name",
>     "slug": "kebab-case-slug",
>     "min_players": int|null,
>     "max_players": int|null,
>     "playing_time": int|null
>   },
>   "base_game_guide_text": "...",
>   "expansions": [
>     {"bgg_id": int, "name": "...", "year": int|null}
>   ]
> }
> ```
> If the base game cannot be found, return `{"error": "not_found", "reason": "<why>"}`.

**If Phase A returns `error: not_found`**, print the reason and stop.

---

### Phase B — Expansion Sourcing (parallel, one Agent per expansion, single message)

Spawn **all expansion sourcing agents in a single message** with multiple `Agent` tool calls (`subagent_type=general-purpose`). Each agent receives one expansion from Phase A's list.

For each expansion, give this brief (substitute actual values):

> You are the BGG sourcer for BoardgameBuddy. Input: bgg_id = `<expansion bgg_id>`, expansion name = `<expansion name>`, base game bgg_id = `<base bgg_id>`.
>
> Steps:
> 1. Fetch full detail: `https://boardgamegeek.com/xmlapi2/thing?id=<bgg_id>&stats=1`. Confirm `bgg_id`, `name`, `yearpublished`, `minplayers`, `maxplayers`, `playingtime`.
> 2. Find rulebook PDFs: WebFetch `https://boardgamegeek.com/boardgameexpansion/<bgg_id>/files` and collect any rulebook/rules PDF links. WebSearch `"<expansion name> rulebook pdf"` — prefer publisher copy over BGG Files.
> 3. WebFetch the best rulebook URL and capture its text in `raw_rules_text` (truncate to 40,000 chars).
> 4. If no rulebook is findable, fall back to the BGG description and record `missing: ["rulebook_pdf"]`.
>
> Return ONLY a JSON object:
> ```json
> {
>   "bgg_id": int,
>   "name": "primary name",
>   "year": int|null,
>   "min_players": int|null,
>   "max_players": int|null,
>   "playing_time": int|null,
>   "is_expansion": true,
>   "base_game_bgg_id": int,
>   "rulebook_urls": [{"url": "...", "label": "...", "source": "publisher|bgg_files"}],
>   "raw_rules_text": "...",
>   "bgg_page_url": "https://boardgamegeek.com/boardgame/<id>",
>   "missing": []
> }
> ```

---

### Phase C — Specialists (5 agents per expansion, parallel, one expansion at a time)

For each expansion (process one expansion per round), spawn all 5 specialists in **a single message** with 5 `Agent` tool calls (`subagent_type=general-purpose`). Each specialist receives the expansion's Phase B JSON and the base game context from Phase A.

**Shared contract** (every specialist receives this header):

> You extract QUICK REFERENCE chunks for BoardgameBuddy. You are analyzing an **expansion**, not a standalone game.
>
> BASE GAME CONTEXT (existing guide for the base game — use this to understand what's already standard, so you only describe what's NEW or DIFFERENT):
> ```
> <base_game_guide_text from Phase A>
> ```
>
> EXPANSION RULES (raw rulebook text):
> ```
> <raw_rules_text from Phase B>
> ```
>
> Your PRIMARY GOAL: clearly describe what this expansion **adds or changes** relative to the base game. Do NOT re-explain base game rules. Do NOT produce content about things the expansion leaves unchanged. Return `[]` if this chunk type has nothing new to add for this expansion.
>
> Output format: return ONLY a JSON array (no prose). Empty array = nothing new to add.
> ```json
> [
>   {"chunk_type": "<your type>", "title": "...", "content": "markdown...", "confidence": "high|low", "missing": []}
> ]
> ```
> Content rules: markdown only. Use `##`/`###` headers, GitHub-style pipe tables, bullets. No HTML. No code fences around the content itself. Titles must be distinct within your output.

**The five specialist prompts** (append each to the shared header):

1. **setup specialist** (`chunk_type: "setup"`):
   > Find setup rules that differ from the base game. Describe: new physical components added to the box (tiles, meeples, tokens, boards, etc.) and how they are shuffled in or placed during setup. Add a per-player-count chunk only if setup varies meaningfully by player count. If the expansion adds no setup changes, return `[]`.

2. **card_reference specialist** (`chunk_type: "card_reference"`):
   > Find rules tied to new cards, tiles, tokens, or other physical components introduced by the expansion. Split by category when useful. Prefer tables — one row per component/effect with name, description, and any special rule. If no new components exist, return `[]`.
   >
   > **Also consider:** if the expansion introduces new card types with a distinct physical layout (icons/zones that differ from the base game cards or that are unique to this expansion), produce one additional chunk with `"layout": "card_anatomy"` (instead of the default `"layout": "text"`). Title it **"How to Read a [New Card Type]"**. Use this exact content format — two sections separated by `[LEGEND]`:
   >
   > ```
   > [DIAGRAM]
   > ┌──────────────────────────┐
   > │ ①Cost        ②CardType  │
   > │──────────────────────────│
   > │                          │
   > │       ③Art / Symbol      │
   > │                          │
   > │──────────────────────────│
   > │ ④Effect text...    ⑤VP  │
   > └──────────────────────────┘
   >
   > [LEGEND]
   > ① Cost: Resources or coins required to play this card
   > ② Card Type: Category label printed on the card
   > ③ Art: Illustration — no game effect
   > ④ Effect: What the card does when played
   > ⑤ VP: Victory points scored at end of game
   > ```
   >
   > Rules: use Unicode box-drawing characters (`┌ ─ ┐ │ └ ┘`). Number each zone with circled numerals ①②③… and match them in the legend. Each legend line: `① Label: description`. Up to 8 zones; omit zones with no game-relevant meaning. Skip this chunk entirely if the new components are tiles without distinct card anatomy, or if the layout is self-explanatory.

3. **player_turn specialist** (`chunk_type: "player_turn"`):
   > Find rules that alter the player turn sequence compared to the base game. Describe ONLY the changes — new mandatory steps, new optional actions, or modified existing steps (e.g., "After placing a tile, you may now also…"). If the expansion adds no changes to turn structure, return `[]`.

4. **scoring specialist** (`chunk_type: "scoring"`):
   > Find new or modified scoring rules introduced by the expansion. List every new VP source with exact point values. Use a table where possible. If the expansion adds no new scoring rules, return `[]`.

5. **rulebook specialist** (`chunk_type: "rulebook"`):
   > Return exactly **one** chunk. `title: "Official Rulebook (PDF)"`. `content` must be the plain URL string of the best official rulebook found in the expansion's Phase B data (prefer publisher over BGG Files). No markdown, no surrounding text. **Never fabricate URLs.** If no rulebook URL was found in Phase B, return `[]`.

---

### Phase D — Assembly (orchestrator)

For each expansion:

1. Collect all 5 specialist JSON arrays. Treat invalid JSON or non-arrays as `[]`.
2. Flatten into one `chunks` list. Drop any chunk where `content` is empty or whitespace.
3. Clamp each specialist's contribution to its top **2** chunks (by `confidence: high` first, then order).
4. Enforce distinct `(chunk_type, title)` pairs across the bundle. On collision, append ` (2)`, ` (3)`.
5. Compute `slug` = kebab-case of the BGG expansion primary name (lowercase, alphanumerics only, spaces → `-`).
6. Write the bundle with `Write` to `projects/boardgame-buddy/web/sample-guides/<slug>.json`:

```json
{
  "version": 1,
  "game": {
    "bgg_id": <int>,
    "name": "<expansion name>",
    "min_players": <int|null>,
    "max_players": <int|null>,
    "playing_time": <int|null>,
    "bgg_url": "https://boardgamegeek.com/boardgame/<bgg_id>",
    "is_expansion": true,
    "base_game_bgg_id": <int>
  },
  "source": {
    "generated_at": "<ISO timestamp>",
    "generator": "expansion-guide@1",
    "rulebook_urls": [{"url": "...", "label": "...", "source": "publisher|bgg_files"}],
    "missing": ["..."]
  },
  "chunks": [
    {"chunk_type": "setup", "title": "...", "content": "...", "layout": "text"},
    ...
  ]
}
```

Every chunk object must have: `chunk_type`, `title`, `content`, `layout`. Default `layout` is `"text"`; card anatomy chunks use `"card_anatomy"`. Valid `chunk_type` values: `setup`, `card_reference`, `player_turn`, `scoring`, `rulebook` only.

After writing all expansion bundles, print a summary:

```
✓ Generated X expansion guides for <Base Game Name>:

  <Expansion Name 1> → projects/boardgame-buddy/web/sample-guides/<slug>.json
    Chunks: setup=1, card_reference=2, player_turn=1, scoring=1, rulebook=1

  <Expansion Name 2> → projects/boardgame-buddy/web/sample-guides/<slug>.json
    Chunks: setup=0, card_reference=1, player_turn=0, scoring=1, rulebook=1

Next step: an admin uploads these files via the BoardgameBuddy web UI at ?admin=1 → header shield icon.
```

---

## Guardrails

- **Only 5 chunk types**: `setup`, `card_reference`, `player_turn`, `scoring`, `rulebook`. Never produce `tips` or `variant` chunks.
- **Empty is correct**: if an expansion doesn't change a particular aspect, the specialist returns `[]` — do not fabricate content.
- **Focus on differences**: every content chunk must describe what's new or changed, not re-explain the base game.
- **Never fabricate URLs.** The rulebook specialist returns `[]` rather than guess.
- **Don't hit the backend.** This skill only writes JSON files. Import is a separate admin action.
- **Cap at 6 expansions** per run. If Phase A finds more, take the top 6 by BGG rating.
- **BGG API rate limiting.** Each sourcing agent should make at most 3 BGG API calls.

## Input validation

If `$ARGUMENTS` is empty, ask the user for a base game name before invoking any agents.
