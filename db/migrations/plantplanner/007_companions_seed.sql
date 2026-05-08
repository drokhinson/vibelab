-- ─────────────────────────────────────────────────────────────────────────────
-- plantplanner — companion-planting seed (iteration 2). ~30 high-confidence
-- pairs. Names must match those in 005_seed_enriched.sql exactly.
-- Bidirectional symmetry is implicit (clients expand both directions) —
-- store ordered pair only.
-- ─────────────────────────────────────────────────────────────────────────────

WITH p AS (SELECT id, name FROM public.plantplanner_plants)
INSERT INTO public.plantplanner_companions (plant_a_id, plant_b_id, relationship, reason)
-- ── GOOD pairs ──────────────────────────────────────────────────────────────
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Improves flavor + repels hornworms'
  FROM p a, p b WHERE a.name = 'Tomato' AND b.name = 'Basil'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Marigolds deter nematodes'
  FROM p a, p b WHERE a.name = 'Tomato' AND b.name = 'Marigold'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Deters whiteflies'
  FROM p a, p b WHERE a.name = 'Pepper' AND b.name = 'Marigold'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Repels aphids and thrips'
  FROM p a, p b WHERE a.name = 'Pepper' AND b.name = 'Basil'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Shared shallow roots, mutual shade'
  FROM p a, p b WHERE a.name = 'Lettuce' AND b.name = 'Strawberry'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Lettuce shades carrots, slows bolting'
  FROM p a, p b WHERE a.name = 'Lettuce' AND b.name = 'Carrot'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Mint deters carrot fly'
  FROM p a, p b WHERE a.name = 'Mint' AND b.name = 'Carrot'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Three-sisters: beans fix nitrogen for squash'
  FROM p a, p b WHERE a.name = 'Bush Bean' AND b.name = 'Zucchini'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Thyme deters strawberry pests'
  FROM p a, p b WHERE a.name = 'Strawberry' AND b.name = 'Thyme'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Repels squash bugs'
  FROM p a, p b WHERE a.name = 'Marigold' AND b.name = 'Zucchini'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Repels bean beetles'
  FROM p a, p b WHERE a.name = 'Marigold' AND b.name = 'Bush Bean'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Deters slugs'
  FROM p a, p b WHERE a.name = 'Marigold' AND b.name = 'Strawberry'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Yarrow attracts beneficial predators'
  FROM p a, p b WHERE a.name = 'Yarrow (Achillea)' AND b.name = 'Tomato'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Repels moths'
  FROM p a, p b WHERE a.name = 'Lavender' AND b.name = 'Tomato'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Repels aphids'
  FROM p a, p b WHERE a.name = 'Catmint (Nepeta)' AND b.name = 'Tomato'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Mutual pest deterrence'
  FROM p a, p b WHERE a.name = 'Basil' AND b.name = 'Lettuce'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Repels slugs near lettuce'
  FROM p a, p b WHERE a.name = 'Mint' AND b.name = 'Lettuce'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'good', 'Improves strawberry flavor'
  FROM p a, p b WHERE a.name = 'Strawberry' AND b.name = 'Mint'
-- ── BAD pairs ───────────────────────────────────────────────────────────────
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Mint stunts tomato growth'
  FROM p a, p b WHERE a.name = 'Tomato' AND b.name = 'Mint'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Mint inhibits bean growth'
  FROM p a, p b WHERE a.name = 'Bush Bean' AND b.name = 'Mint'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Sage stunts beans'
  FROM p a, p b WHERE a.name = 'Bush Bean' AND b.name = 'Sage'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Beans shade peppers, lower yield'
  FROM p a, p b WHERE a.name = 'Pepper' AND b.name = 'Bush Bean'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Brassicas stunt strawberries'
  FROM p a, p b WHERE a.name = 'Kale' AND b.name = 'Strawberry'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Sage shades lettuce, bitters leaves'
  FROM p a, p b WHERE a.name = 'Lettuce' AND b.name = 'Sage'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Mint disrupts squash pollinators'
  FROM p a, p b WHERE a.name = 'Zucchini' AND b.name = 'Mint'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Sage stunts tomato growth'
  FROM p a, p b WHERE a.name = 'Tomato' AND b.name = 'Sage'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Sage repels pepper pollinators'
  FROM p a, p b WHERE a.name = 'Pepper' AND b.name = 'Sage'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Sage shades carrots'
  FROM p a, p b WHERE a.name = 'Carrot' AND b.name = 'Sage'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Lavender prefers dry, beans like wet'
  FROM p a, p b WHERE a.name = 'Lavender' AND b.name = 'Bush Bean'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Same dryness conflict'
  FROM p a, p b WHERE a.name = 'Lavender' AND b.name = 'Lettuce'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Conflicting water needs'
  FROM p a, p b WHERE a.name = 'Basil' AND b.name = 'Sage'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Conflicting water needs'
  FROM p a, p b WHERE a.name = 'Rosemary' AND b.name = 'Basil'
UNION ALL
SELECT LEAST(a.id, b.id), GREATEST(a.id, b.id), 'bad', 'Mint overruns thyme'
  FROM p a, p b WHERE a.name = 'Thyme' AND b.name = 'Mint'
ON CONFLICT DO NOTHING;
