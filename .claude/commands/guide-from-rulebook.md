Build a chunked BoardgameBuddy guide for the board game: $ARGUMENTS

## Goal
Produce a numbered SQL migration that seeds `boardgamebuddy_guide_chunks` for the target game, covering setup (with player-count variations), player turn actions, card/component types, end-game scoring, strategy tips, and a rulebook pointer.

---

## Steps

### 1. Identify the game
- Confirm the game exists in `boardgamebuddy_games` by searching for its name.
- Note its `id` (UUID) and `bgg_id`.
- If it's missing, add it first via the BGG search endpoint or a manual INSERT.

### 2. Research the rules
Gather accurate rules from any available source:
- A rulebook PDF the user has provided or linked
- BGG Files tab for the game
- Publisher website
- Ask the user if rules are unclear or contested

Focus on these six areas (one chunk each):

| Chunk type | What to extract |
|---|---|
| `setup` | Per-player components, coin starting amount, card dealing procedure, **player-count differences** (especially 2-player variants), hand-pass direction |
| `player_turn` | Every legal action a player may take on their turn, with exact costs, coin amounts, and any special cases |
| `card_reference` | Every card/component category (color, type, suit), what each produces or does, any interaction rules between types |
| `scoring` | Every VP source at end of game, calculation method, tiebreaker |
| `tips` | 5–8 concrete, actionable strategy tips for new players |
| `rulebook` | Where to find the official rulebook (publisher site, BGG) — do **not** fabricate URLs |

### 3. Write the migration
- Determine the next migration number: `ls db/migrations/ | sort | tail -1` then increment.
- Create `db/migrations/NNN_boardgamebuddy_<slug>_guide.sql` following the pattern in `035_boardgamebuddy_sevenwonders_guide.sql`.
- Use a `DO $$` block that:
  1. Selects `game_id` from `boardgamebuddy_games` by `bgg_id`
  2. Returns early with a NOTICE if no game found
  3. Returns early with a NOTICE if chunks already exist (idempotent)
  4. Inserts all six chunks with `created_by = NULL` and `layout = 'text'`
  5. Raises a NOTICE on success

Content rules:
- Write in clear markdown inside `$CONTENT$ ... $CONTENT$` dollar-quoting.
- For the **player_turn** chunk: state the **exact coin amount** for any discard/sell action.
- For the **setup** chunk: call out every rule that changes with player count in its own labeled section.
- Keep each chunk focused and scannable — use headers, lists, and tables where they help.

### 4. Update the schema snapshot
Edit `db/schema/boardgamebuddy.sql` — update the `Last updated` comment at the top to reference the new migration number.

### 5. Verify
After writing the files:
```sql
-- Paste into Supabase SQL Editor to test
SELECT chunk_type, title
  FROM boardgamebuddy_guide_chunks
 WHERE game_id = (SELECT id FROM boardgamebuddy_games WHERE bgg_id = <bgg_id>)
 ORDER BY created_at;
-- Expect 6 rows
```
Re-running the migration should produce a NOTICE and insert nothing (idempotent guard).

### 6. Commit
```bash
git add db/migrations/NNN_boardgamebuddy_<slug>_guide.sql db/schema/boardgamebuddy.sql
git commit -m "[boardgame-buddy] add <Game Name> guide seed (migration NNN)"
git push -u origin <branch>
```
