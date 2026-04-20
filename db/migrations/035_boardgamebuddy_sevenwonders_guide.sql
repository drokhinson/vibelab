-- ─────────────────────────────────────────────────────────────────────────────
-- BoardgameBuddy — Seven Wonders guide seed
-- Migration 035
-- Inserts six guide chunks for 7 Wonders (bgg_id 68448):
--   setup, player_turn, card_reference, scoring, tips, rulebook
-- ─────────────────────────────────────────────────────────────────────────────

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
  ),

  -- ── RULEBOOK ───────────────────────────────────────────────────────────────
  (v_game_id, 'rulebook', 'Official Rulebook', NULL, 'text',
$CONTENT$The official 7 Wonders rulebook (English) is available as a free PDF on the **Repos Production** publisher website and on **BoardGameGeek** under the Files tab for 7 Wonders (bgg_id 68448).

Search: "7 Wonders rulebook PDF Repos Production" to find the current edition.$CONTENT$
  );

  RAISE NOTICE 'Inserted 6 guide chunks for 7 Wonders.';
END $$;
