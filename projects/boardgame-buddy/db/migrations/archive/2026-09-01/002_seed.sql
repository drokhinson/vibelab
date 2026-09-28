-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — reference data seed
-- 1) Game catalog (collapsed from legacy 033; the bgg_rank + bgg_rating
--    columns were dropped in 044 so those values are intentionally not
--    carried forward. The 033_fix_image_urls patch is a no-op for this seed
--    since none of the seeded rows include image_url / thumbnail_url.).
-- 2) Evo (bgg_id 1159) game row + 6 guide chunks (legacy 036).
-- 3) Seven Wonders (bgg_id 68448) — 6 guide chunks (legacy 035).
--
-- Rulebook chunks from the original 035 / 036 seeds are intentionally NOT
-- inserted: migration 048 promoted rulebook URLs to a column on
-- boardgamebuddy_games and removed the 'rulebook' chunk_type. Their content
-- was prose pointing at where to find the official rulebook online, and the
-- rulebook_url column on the corresponding game rows is left NULL by default.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Game catalog ─────────────────────────────────────────────────────────────
INSERT INTO public.boardgamebuddy_games
  (bgg_id, name, year_published, min_players, max_players, playing_time,
   categories, mechanics, theme_color)
VALUES
  (174430, 'Gloomhaven',                    2017, 1, 4, 120,
   ARRAY['Adventure','Fantasy','Fighting'],
   ARRAY['Campaign','Hand Management','Modular Board'],
   '#2c3e50'),

  (224517, 'Brass: Birmingham',             2018, 2, 4,  60,
   ARRAY['Economic','Industry','Transportation'],
   ARRAY['Hand Management','Network Building','Route Building'],
   '#c0392b'),

  (161936, 'Pandemic Legacy: Season 1',     2015, 2, 4,  60,
   ARRAY['Medical','Cooperative'],
   ARRAY['Campaign','Hand Management','Variable Player Powers'],
   '#27ae60'),

  (162886, 'Spirit Island',                 2017, 1, 4, 120,
   ARRAY['Fantasy','Territory Building','Cooperative'],
   ARRAY['Area Control','Hand Management','Variable Player Powers'],
   '#16a085'),

  (182028, 'Through the Ages: A New Story', 2015, 2, 4, 120,
   ARRAY['Civilization','Card Game'],
   ARRAY['Card Drafting','Hand Management','Worker Placement'],
   '#8e44ad'),

  (12333,  'Twilight Struggle',             2005, 2, 2, 180,
   ARRAY['Political','Wargame','Card Game'],
   ARRAY['Area Control','Card Driven','Hand Management'],
   '#2980b9'),

  (84876,  'The Castles of Burgundy',       2011, 2, 4,  90,
   ARRAY['Medieval','Dice'],
   ARRAY['Dice Rolling','Set Collection','Tile Placement'],
   '#d35400'),

  (120677, 'Terra Mystica',                 2012, 2, 5, 150,
   ARRAY['Fantasy','Territory Building'],
   ARRAY['Area Control','Income','Variable Player Powers'],
   '#7f8c8d'),

  (31260,  'Agricola',                      2007, 1, 5,  90,
   ARRAY['Economic','Farming'],
   ARRAY['Hand Management','Worker Placement'],
   '#795548'),

  (266192, 'Wingspan',                      2019, 1, 5,  70,
   ARRAY['Animals','Card Game','Nature'],
   ARRAY['Card Drafting','Hand Management','Set Collection'],
   '#1abc9c'),

  (3076,   'Puerto Rico',                   2002, 3, 5,  90,
   ARRAY['Economic','City Building'],
   ARRAY['Role Selection','Variable Player Powers','Worker Placement'],
   '#f39c12'),

  (2651,   'Power Grid',                    2004, 2, 6, 120,
   ARRAY['Economic','Industry','City Building'],
   ARRAY['Auction','Network Building','Route Building'],
   '#e67e22'),

  (183394, 'Viticulture: Essential Edition',2015, 2, 6,  90,
   ARRAY['Economic','Farming'],
   ARRAY['Hand Management','Worker Placement'],
   '#8e44ad'),

  (37111,  'Race for the Galaxy',           2007, 2, 4,  45,
   ARRAY['Card Game','Science Fiction','Space'],
   ARRAY['Card Drafting','Hand Management','Simultaneous Action'],
   '#2980b9'),

  (68448,  '7 Wonders',                     2010, 2, 7,  30,
   ARRAY['Ancient','Card Game','Civilization'],
   ARRAY['Card Drafting','Hand Management','Set Collection'],
   '#f1c40f'),

  (36218,  'Dominion',                      2008, 2, 4,  30,
   ARRAY['Card Game','Medieval'],
   ARRAY['Deck Building','Hand Management'],
   '#2c3e50'),

  (9209,   'Ticket to Ride',                2004, 2, 5,  75,
   ARRAY['Trains','Route Building','Family'],
   ARRAY['Card Drafting','Hand Management','Route Building'],
   '#e74c3c'),

  (822,    'Carcassonne',                   2000, 2, 5,  45,
   ARRAY['Medieval','Territory Building','Family'],
   ARRAY['Area Control','Tile Placement'],
   '#9b59b6'),

  (30549,  'Pandemic',                      2008, 2, 4,  45,
   ARRAY['Medical','Cooperative','Family'],
   ARRAY['Hand Management','Role Selection','Variable Player Powers'],
   '#27ae60'),

  (13,     'Catan',                         1995, 3, 4,  90,
   ARRAY['Negotiation','Territory Building','Family'],
   ARRAY['Dice Rolling','Hand Management','Trading'],
   '#e67e22'),

  (50,     'Lost Cities',                   1999, 2, 2,  30,
   ARRAY['Card Game','Exploration'],
   ARRAY['Hand Management','Set Collection'],
   '#2980b9'),

  -- Evo (legacy 036)
  (1159,   'Evo',                           2001, 3, 5,  90,
   ARRAY['Animals','Prehistoric','Territory Building'],
   ARRAY['Auction/Bidding','Area Control','Dice Rolling','Hand Management'],
   '#2e7d32')

ON CONFLICT (bgg_id) DO NOTHING;


-- ── Seven Wonders guide chunks (legacy 035) ──────────────────────────────────
DO $$
DECLARE
  v_game_id UUID;
BEGIN
  SELECT id INTO v_game_id
    FROM public.boardgamebuddy_games
   WHERE bgg_id = 68448; -- 7 Wonders

  IF v_game_id IS NULL THEN
    RAISE NOTICE '7 Wonders (bgg_id 68448) not found — skipping guide seed.';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.boardgamebuddy_guide_chunks WHERE game_id = v_game_id
  ) THEN
    RAISE NOTICE '7 Wonders guide chunks already exist — skipping.';
    RETURN;
  END IF;

  INSERT INTO public.boardgamebuddy_guide_chunks
    (game_id, chunk_type, title, created_by, layout, content)
  VALUES

  -- ── SETUP ──────────────────────────────────────────────────────────────────
  (v_game_id, 'setup', 'Seven Wonders Setup', NULL, 'text',
$CONTENT$## Components per player
- 1 Wonder board (choose side A or B)
- 3 coins from the bank
- 7 Age I cards dealt from the shuffled Age I deck

Each age uses only the cards labeled for your player count or lower. Remove the rest before shuffling.

---

## 2 Players — Ghost City Variant
A third Wonder board is placed face up between the two players as the **Ghost City**. Before each turn, flip the top card of a separate shuffled ghost-city deck face up — the Ghost City "plays" that card for free.

- The Ghost City participates in military conflicts at the end of each age (compare shields normally; grant or receive tokens as usual).
- The Ghost City never builds a Wonder stage, never collects coins, and **never scores VP**.
- Pass your hand to the left in Ages I and III, to the right in Age II (same direction as standard).

## 3–7 Players — Standard
All players act simultaneously each turn. After selecting an action, everyone passes their remaining hand:
- **Left** after Ages I and III
- **Right** after Age II

Each age ends when every player has played 6 cards and discarded 1 (the last card in hand is discarded automatically with no coin reward).$CONTENT$
  ),

  -- ── PLAYER TURN ────────────────────────────────────────────────────────────
  (v_game_id, 'player_turn', 'Your Turn', NULL, 'text',
$CONTENT$Each turn, choose **exactly one** of the following actions, then pass your remaining hand to the next player.

---

## 1. Play a Card
Place a card from your hand face up in your play area.

- **Pay its cost** — printed resource symbols must be covered by your own production or purchased from neighbors; coin costs go to the bank.
- **Buying from neighbors:** Each resource you lack costs **2 coins** to buy from an adjacent player (paid to that player, not the bank). Yellow commercial cards can reduce this rate.
- **Free chains:** If you already own the card shown in the card's chain symbol (bottom-left), you may play it for free regardless of its printed cost.

## 2. Build a Wonder Stage
Place any card from your hand **face down** beneath your Wonder board to complete your next unbuilt stage.

- Pay the Wonder stage's printed cost (resources and/or coins).
- The identity of the card played does not matter — only the cost and stage effect.
- Stages must be built in order (left to right). Each stage can only be built once.
- Wonder effects apply immediately when built (extra turns, free cards, etc.).

## 3. Discard a Card
Place any card from your hand **face down** in the shared discard pile and take **3 coins** from the bank.

- You do not reveal which card you discarded.
- A reliable fallback when no card is affordable or worth playing.
- Coins count toward end-game scoring (1 VP per 3 coins) and fund future resource purchases.$CONTENT$
  ),

  -- ── CARD REFERENCE ─────────────────────────────────────────────────────────
  (v_game_id, 'card_reference', 'Card Types', NULL, 'text',
$CONTENT$## Brown — Raw Materials
Produce basic resources: **Wood, Stone, Ore, Clay**.
Neighbors may buy these resources from you for 2 coins each per turn (yellow cards can reduce this).

## Grey — Manufactured Goods
Produce luxury resources: **Papyrus, Loom, Glass**.
Only one of each symbol appears per age at most player counts — these are often scarce.

## Blue — Civic Structures
Score **victory points** directly. No ongoing resource or coin effect — pure end-game VP.

## Yellow — Commercial Structures
Provide coins, reduce the cost of buying resources from neighbors, or grant special VP at end of game. Some produce a resource of your choice each turn.

## Red — Military Structures
Add **shields** (⚔) to your military strength. At the end of each age, compare your shields with each neighbor separately:

| Result | Age I | Age II | Age III |
|--------|-------|--------|---------|
| Win    | +1 VP | +3 VP  | +5 VP   |
| Lose   | −1 VP | −1 VP  | −1 VP   |
| Tie    | 0     | 0      | 0       |

## Green — Scientific Structures
Produce one of three science symbols: **Gear ⚙, Compass 🧭, Tablet 📋**.

- **Identical sets:** Each symbol scores n² VP (e.g., 3 Gears = 9 VP, 4 Gears = 16 VP).
- **Complete sets:** Each full set of all three different symbols scores +7 VP.

## Purple — Guilds (Age III only)
Score VP based on cards built by you and/or your neighbors. Only a subset of guilds is used each game (player count + 2 cards). Each guild has unique scoring text — read carefully before drafting.$CONTENT$
  ),

  -- ── SCORING ────────────────────────────────────────────────────────────────
  (v_game_id, 'scoring', 'End Game Scoring', NULL, 'text',
$CONTENT$After Age III, count all VP in the following order and total them on the scoring pad.

1. **Military tokens** — Sum all victory tokens earned; subtract all defeat tokens (−1 each).
2. **Treasury** — 1 VP for every 3 coins remaining (round down).
3. **Wonder stages** — Each completed stage awards its printed VP value.
4. **Blue cards (Civic)** — Sum all printed VP values.
5. **Yellow cards (Commercial)** — Some score VP based on card counts or special conditions; apply each card's text.
6. **Purple cards (Guilds)** — Score each guild according to its individual text.
7. **Science (Green cards)**
   - For each symbol type, count how many you have (n) and add n² VP.
   - For each complete set of all three different symbols you own, add 7 VP.

## Tiebreaker
Compare total **coins** remaining. The player with more coins wins. If still tied, share the victory.$CONTENT$
  ),

  -- ── TIPS ───────────────────────────────────────────────────────────────────
  (v_game_id, 'tips', 'Strategy Tips', NULL, 'text',
$CONTENT$## Science compounds fast
Three identical symbols score 9 VP; four score 16 VP. Two full diverse sets score 14 VP. Going deep in science is one of the strongest strategies — don't ignore it unless neighbors are clearly racing for it too.

## Military is per-neighbor, not global
You only need to beat each adjacent player individually. One extra shield beats a neighbor with none. Spending heavily to win by a large margin rarely pays off compared to just passing the conflict.

## Free chains are free VP
A chained card costs nothing — always play it over paying coins for something else. Scan the chain symbols on Age II and III cards at the start of each age to spot upcoming free plays.

## The last card earns nothing
Each age's final card is discarded without a coin reward. If you can't use a card profitably in the second-to-last turn, discard early and take 3 coins instead.

## Yellow trading cards peak in Age I and II
A commercial card that reduces your neighbors' resource costs is most valuable when you still have many purchases ahead. Played in Age III, it rarely pays back its opportunity cost.

## Wonder stage timing matters
Some stages grant an extra free turn or let you play a card from the discard pile — these effects are worth far more when triggered early. Prioritize building impactful stages in Age I or II rather than waiting.$CONTENT$
  );

  -- Mark seeded chunks as default (matches the migration 045 backfill, which
  -- set is_default = true wherever created_by IS NULL).
  UPDATE public.boardgamebuddy_guide_chunks
     SET is_default = true
   WHERE game_id = v_game_id AND created_by IS NULL;

  RAISE NOTICE 'Inserted 5 guide chunks for 7 Wonders.';
END $$;


-- ── Evo guide chunks (legacy 036) ────────────────────────────────────────────
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
  );

  -- Mark seeded chunks as default (matches the migration 045 backfill).
  UPDATE public.boardgamebuddy_guide_chunks
     SET is_default = true
   WHERE game_id = v_game_id AND created_by IS NULL;

  RAISE NOTICE 'Inserted 5 guide chunks for Evo.';
END $$;
