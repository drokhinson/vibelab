-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — Evo game entry + guide seed
-- Migration 036
-- Adds Evo (bgg_id 1159) to boardgamebuddy_games, then inserts six guide
-- chunks: setup, player_turn, card_reference, scoring, tips, rulebook.
-- ─────────────────────────────────────────────────────────────────────────────

-- Add Evo to the game catalog (idempotent via ON CONFLICT).
INSERT INTO public.boardgamebuddy_games
  (bgg_id, name, year_published, min_players, max_players, playing_time,
   bgg_rank, bgg_rating, categories, mechanics, theme_color)
VALUES
  (1159, 'Evo', 2001, 3, 5, 90,
   NULL, NULL,
   ARRAY['Animals', 'Prehistoric', 'Territory Building'],
   ARRAY['Auction/Bidding', 'Area Control', 'Dice Rolling', 'Hand Management'],
   '#2e7d32')
ON CONFLICT (bgg_id) DO NOTHING;

-- ── Guide chunks ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_game_id UUID;
BEGIN
  SELECT id INTO v_game_id
    FROM public.boardgamebuddy_games
   WHERE bgg_id = 1159; -- Evo

  IF v_game_id IS NULL THEN
    RAISE NOTICE 'Evo (bgg_id 1159) not found — skipping guide seed.';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.boardgamebuddy_guide_chunks WHERE game_id = v_game_id
  ) THEN
    RAISE NOTICE 'Evo guide chunks already exist — skipping.';
    RETURN;
  END IF;

  INSERT INTO public.boardgamebuddy_guide_chunks
    (game_id, chunk_type, title, created_by, layout, content)
  VALUES

  -- ── SETUP ────────────────────────────────────────────────────────────────
  (v_game_id, 'setup', 'Evo Setup', NULL, 'text',
$CONTENT$## Components per player
- 1 player board (tracks your six mutation levels)
- 8 dinosaur tokens in your color
- Score marker placed at **10** on the victory point track
- 3 Event cards dealt from the shuffled event deck
- Starting mutations already printed on your board: 1 Tail, 1 Leg, 0 Horns, 1 Egg, 1 Fur, 1 Parasol

## Board Assembly — changes with player count
The island board consists of two reversible double-sided sections. Assemble them as follows:

| Players | Board Configuration |
|---------|---------------------|
| 3 | Small + Small |
| 4 | Small + Large |
| 5 | Large + Large |

The larger the board, the more hexes are available and the more room species have to spread.

## Terrain types
Four terrain types appear on every board: **Desert** (extremely hot), **Plains** (warm), **Hills** (cool), and **Mountains** (cold). Climate shifts each round, so zones that are safe today may become deadly next round.

## Starting positions
Each player places **2 dinosaur tokens** on the hexes nearest their starting edge (or randomly assigned). Remaining dinosaur tokens are held in reserve.

## No 2-player variant
Evo requires at least 3 players. The published rules do not include an official 2-player mode.$CONTENT$
  ),

  -- ── PLAYER TURN ──────────────────────────────────────────────────────────
  (v_game_id, 'player_turn', 'Round Structure & Actions', NULL, 'text',
$CONTENT$Each round proceeds through **six phases in order**. Players act in initiative order (determined in Phase 1) within each phase.

---

## Phase 1 — Initiative
Rank all players by their current **Tail** mutation level (highest = first). Ties broken by: most dinosaurs on the board → then a die roll.

Initiative order applies to all remaining phases this round.

## Phase 2 — Climate
Roll the climate die. Move the climate marker according to the result. This shifts which terrain zones are **Hot**, **Warm**, **Cool**, or **Cold** — affecting which dinosaurs survive in Phase 5.

## Phase 3 — Movement
In initiative order, each player may move their dinosaurs.
- Each dinosaur can move **1 hex per Leg mutation** you own.
- Split movement freely among any of your dinosaurs.
- **Combat** triggers immediately if a dinosaur enters a hex occupied by an opponent (see Card Reference for combat rules).

## Phase 4 — Reproduction
Each player adds **1 new dinosaur** token to the board per **Egg mutation** they own.
- New dinosaurs must be placed **adjacent** to one of your existing dinosaurs.
- If you have no dinosaurs on the board, you may not reproduce.

## Phase 5 — Survival
Dinosaurs in extreme climate zones die unless protected:
- **Hot zone:** Each of your dinosaurs there needs 1 **Parasol** mutation to survive.
- **Cold zone:** Each of your dinosaurs there needs 1 **Fur** mutation to survive.
- **Deadly zone:** All dinosaurs die — no mutation can save them.

After removals, **gain 1 VP for every dinosaur still alive on the board**.

## Phase 6 — Evolution (Bidding)
In initiative order, each player bids VPs to purchase gene upgrades.
- Announce a bid amount and which gene you want to upgrade.
- The bid is subtracted from your VP total immediately.
- You may pass instead of bidding.
- Players can also bid for extra Event cards.
- After all bids, the meteor marker advances one space toward Earth.

**The game ends immediately** when the meteor reaches Earth (typically round 9–11).$CONTENT$
  ),

  -- ── CARD REFERENCE ───────────────────────────────────────────────────────
  (v_game_id, 'card_reference', 'Mutations & Combat', NULL, 'text',
$CONTENT$## The Six Mutation Tracks
Each player board tracks six mutation levels. Every upgrade costs VPs bid during Phase 6.

| Mutation | Effect | Starting Level |
|----------|--------|----------------|
| **Tail** | Determines initiative order — higher Tail acts first each round | 1 |
| **Leg** | Each Leg = 1 hex of movement per round, split across all your dinosaurs | 1 |
| **Horn** | Improves combat odds when attacking or defending | 0 |
| **Egg** | Each Egg = 1 new dinosaur added during Reproduction (Phase 4) | 1 |
| **Fur** | Each Fur = 1 dinosaur protected in a Cold zone during Survival (Phase 5) | 1 |
| **Parasol** | Each Parasol = 1 dinosaur protected in a Hot zone during Survival (Phase 5) | 1 |

Fur and Parasol protection is **not** cumulative — 1 Fur protects exactly 1 dinosaur in the cold, regardless of how extreme the cold is.

---

## Combat
Combat occurs when a dinosaur moves into a hex occupied by an opponent. Roll a d6 and consult the Horn differential:

| Attacker's Horn advantage | Attacker wins on d6 |
|---------------------------|---------------------|
| +2 or more | 1–5 |
| +1 | 1–4 |
| Equal (0) | 1–2 |
| −1 (defender has 1 more) | 1 only |
| −2 or more | Cannot attack |

- **Winner:** the loser's dinosaur is removed from the board.
- Combat is **mandatory** — you cannot move into an occupied hex without fighting.
- A dinosaur eliminated in combat does not count toward survival VPs this round.

---

## Event Cards
Event cards provide one-time special actions or rule exceptions. Each player starts with 3 and can bid for more during Phase 6.$CONTENT$
  ),

  -- ── SCORING ──────────────────────────────────────────────────────────────
  (v_game_id, 'scoring', 'Scoring & End Game', NULL, 'text',
$CONTENT$## Victory Points are your score
Your VP total on the scoring track is simultaneously your score **and** your bidding currency. Every bid you make reduces your score.

## Earning VPs
- **Start:** score marker placed at 10 VP.
- **Each round (Phase 5):** gain **1 VP per surviving dinosaur** after climate deaths.
- No other source of VP exists — survival is everything.

## Spending VPs
- **Phase 6 (Evolution):** bid any amount to upgrade a mutation or acquire Event cards.
- Bids are deducted from your VP total immediately.
- Your score can drop to 0; you cannot bid more VPs than you currently have.

## Net score formula
```
Final VP = 10 (start) + Σ survival VPs each round − Σ all gene bids
```

## End condition
The game ends **immediately** when the meteor marker reaches Earth during Phase 6. There is no warning round — it can happen as early as round 9 or as late as round 11+ depending on die rolls.

## Tiebreaker
If two or more players are tied on VP at game end:
1. **Most dinosaurs on the board** wins.
2. If still tied — shared victory.$CONTENT$
  ),

  -- ── TIPS ─────────────────────────────────────────────────────────────────
  (v_game_id, 'tips', 'Strategy Tips', NULL, 'text',
$CONTENT$## Your VPs are your bids — spend carefully
Every gene you buy costs you points. Overspending on mutations early leaves you behind players who banked VPs through efficient survival. Only buy what you'll use before the meteor hits.

## Eggs are the engine
More eggs mean more dinosaurs each round, which means more survival VPs. Upgrading Egg early compounds over every remaining round — it's usually the highest-value mutation in the game.

## Tails control everything
Acting first in movement, reproduction, and bidding is a massive advantage. Going first in the evolution auction means you get first pick of genes and can outbid opponents for the one they need.

## Match Fur and Parasol to the climate, not maximums
The climate die is random — don't over-invest in cold or heat protection unless the track is locked near an extreme. Two or three of each is usually enough; the rest of your VP is better spent on Eggs.

## Legs let you escape disaster
When the climate shifts unexpectedly, Legs let you move dinosaurs out of deadly zones before Survival. One or two Legs are enough; going deep rarely pays off unless the board is crowded.

## Horns are only worth it if you fight
Combat is optional — you never have to move into an occupied hex. If you're playing a spread-and-survive strategy, Horns give you nothing. Only invest if you plan to actively contest territory.

## Watch the meteor track
Once the meteor is two or three spaces away, expensive gene bids rarely pay back. Shift into survival mode: stop bidding, keep your dinosaurs alive, and cash in those last few rounds of VPs.

## Don't bunch up
Clustering all your dinosaurs in one region looks safe but makes you vulnerable to a single climate shift. Spread across multiple terrain types so one bad die roll can't wipe out your entire population.$CONTENT$
  ),

  -- ── RULEBOOK ─────────────────────────────────────────────────────────────
  (v_game_id, 'rulebook', 'Official Rulebook', NULL, 'text',
$CONTENT$The original Evo rulebook (2001 Eurogames edition) is available in the **Files** section on BoardGameGeek for Evo (BGG ID 1159).

Search BoardGameGeek: "Evo 2001 rulebook" under the Files tab for the English and French PDF versions.

A revised edition (Evo 2nd Edition, 2011, Days of Wonder) also has its rulebook freely available on the Days of Wonder support site and on BGG under that edition's listing.$CONTENT$
  );

  RAISE NOTICE 'Inserted 6 guide chunks for Evo.';
END $$;
