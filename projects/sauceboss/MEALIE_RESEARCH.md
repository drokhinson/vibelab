# Mealie Research Findings for SauceBoss

**Source repo:** https://github.com/mealie-recipes/mealie
**Research date:** 2026-03-25
**Purpose:** Inform SauceBoss schema improvements and future "import sauce from URL" feature

---

## 1. Mealie Overview (What's Relevant)

Mealie is a full-stack recipe manager (FastAPI + PostgreSQL + Vue). It handles:
- Importing recipes from any URL via web scraping
- Structured ingredient parsing (quantity + unit + food name)
- Metric/imperial unit conversion
- Multi-user recipe libraries with Supabase-style RLS

The patterns below are directly applicable to SauceBoss's roadmap.

---

## 2. Database Schema

### Ingredient Architecture (3-table pattern)

Mealie separates what SauceBoss currently stores inline (`name TEXT, amount REAL, unit TEXT`) into three distinct entities:

**`IngredientUnitModel`** — the unit itself:
```
id, name, plural_name, abbreviation, plural_abbreviation
use_abbreviation (bool)
fraction (bool)           -- display as fractions (1/2 cup)
standard_quantity (float) -- conversion factor
standard_unit (string)    -- canonical unit name: "milliliter", "gram"
name_normalized           -- GIN-indexed for fuzzy search
```

**`IngredientFoodModel`** — the ingredient food item:
```
id, name, plural_name, description
name_normalized           -- GIN-indexed for fuzzy search
```

**`IngredientUnitAliasModel` / `IngredientFoodAliasModel`** — alternate names:
```
-- Maps "tablespoon" → tbsp, "T" → tbsp, etc.
-- Critical for NLP parsing where input text varies wildly
```

**`RecipeIngredientModel`** — junction linking recipe + food + unit:
```
recipe_id, unit_id (FK), food_id (FK)
quantity (float)
position (int)         -- ordering within recipe
original_text (text)   -- raw scraped string, e.g. "1/2 cup finely chopped onion"
note (text)            -- preparation notes, e.g. "finely chopped"
title (text)           -- section headers between ingredient groups
```

### Key Schema Patterns

- **`standard_unit`** field is the bridge between display units and conversion logic. Every unit points to a canonical Pint-compatible string.
- **`original_text`** preservation is critical for URL import — you save the raw string alongside the parsed result so users can verify/correct.
- **GIN trigram indices** on `name_normalized` fields enable fast fuzzy-match queries (`pg_trgm` extension). Pattern: `LOWER(REGEXP_REPLACE(name, '[^a-z0-9]', '', 'gi'))`.
- Recipes have `recipe_yield`, `recipe_yield_quantity`, `recipe_servings` — SauceBoss sauces have none of these.

---

## 3. URL Scraping Pipeline

### Strategy Cascade (3 layers, tried in order)

**Layer 1 — `recipe-scrapers` Python library (primary)**
- Handles 500+ cooking websites via schema.org JSON-LD structured data
- `pip install recipe-scrapers`
- Returns structured: title, ingredients list, instructions, servings, times
- Validates: requires both ingredients AND instructions to pass
- Calls `clean_ingredients()` on raw output before use

**Layer 2 — OpenAI fallback**
- Triggered when Layer 1 returns no ingredients/instructions
- Converts raw HTML → plain text
- Sends to GPT with prompt to extract recipe as JSON
- Re-wraps response as JSON-LD so Layer 1's parser can process it
- Bridges the gap for sites without structured data

**Layer 3 — Open Graph meta tags (last resort)**
- Uses `extruct` library to pull `og:title`, `og:description`, `og:image`
- Provides minimal scaffold (name + image only, no ingredients)
- Flags the recipe as needing manual completion

### Ingredient Cleaning (post-scrape)

Before any parsing, raw ingredient strings are cleaned:
1. Strip HTML tags (`<b>`, `<span>`, etc. — common in scraped content)
2. Collapse multiple spaces → single space
3. Strip leading/trailing whitespace
4. Split by newline if a single string was returned instead of a list

### NLP Ingredient Parser

After cleaning, each ingredient string like `"1/2 cup finely chopped onion"` is parsed:

```
"1/2 cup finely chopped onion"
  → quantity: 0.5
  → unit: "cup"
  → food: "onion"
  → note: "finely chopped"
  → confidence: 0.87
```

Uses `ingredient-parser-nlp` Python library with confidence scoring.
**BruteForce fallback:** regex pattern matching when NLP confidence < threshold.

### Fuzzy Matching to DB

After NLP parsing, resolved strings are matched against the ingredient/unit databases:
- **Food matching:** 85% similarity threshold (RapidFuzz)
- **Unit matching:** 70% similarity threshold (more lenient — "tablespoons" → "tbsp")
- Unmatched items are saved as-is and flagged for user review

---

## 4. Metric vs Imperial Conversion

### Core: Pint Python Library

`pip install pint`

Pint provides dimensional analysis — units aren't just strings, they have physical dimensionality:
- Volume: `[length]^3` (tsp, tbsp, cup, ml, L, fl oz)
- Weight: `[mass]` (g, kg, oz, lb)
- Count: dimensionless (clove, piece, pinch)

### How Conversion Works

Each `IngredientUnitModel` has a `standard_unit` string that maps to a Pint-compatible unit name:

| SauceBoss unit | `standard_unit` | Pint dimension |
|---------------|-----------------|----------------|
| `tsp`  | `teaspoon`       | `[length]^3`   |
| `tbsp` | `tablespoon`     | `[length]^3`   |
| `cup`  | `cup`            | `[length]^3`   |
| `oz`   | `fluid_ounce`*   | `[length]^3`   |
| `g`    | `gram`           | `[mass]`       |
| `ml`   | `milliliter`     | `[length]^3`   |

*Special case: Mealie resolves "oz" to `fluid_ounce` (volume) when it appears alongside other volume units — because in recipes "5 oz water" almost always means 5 fl oz, not 5 oz by weight.

### Conversion Logic

```python
from pint import UnitRegistry
ureg = UnitRegistry()

def can_convert(source, target):
    # Only convert if same dimension (both volume or both weight)
    return ureg.parse_expression(source).dimensionality == \
           ureg.parse_expression(target).dimensionality

def convert(quantity, source_unit, target_unit):
    q = ureg.Quantity(quantity, source_unit)
    return q.to(target_unit).magnitude
```

Metric toggle (e.g. cups → ml):
- `1 cup` → `240 ml`
- `1 tbsp` → `15 ml`
- `1 tsp` → `5 ml`
- `1 oz (weight)` → `28 g`

---

## 5. ML vs Grams (Volume vs Weight)

This is the core wet/dry distinction for sauce ingredients.

### The Problem

`1 cup flour` ≠ `240 ml flour` in practice — flour by volume ≠ flour by weight. Mealie handles this by:

1. **Storing unit type** via `standard_unit` (milliliter vs gram)
2. **Not auto-converting** between volume and weight (they're different dimensions in Pint)
3. **Preserving the original measurement** — if a recipe says "1 cup", it stays as volume

### Volume Units (wet-safe)
`tsp, tbsp, cup, fl oz, ml, L` — all dimensionality `[length]^3`

### Weight Units (dry-safe)
`g, kg, oz (weight), lb` — all dimensionality `[mass]`

### Count Units (neither — never convert)
`clove, cloves, piece, pieces, pinch` — dimensionless

### Sauce-Specific Insight

For SauceBoss sauces, most liquid ingredients (soy sauce, olive oil, vinegar) are volume-measured, while some dry ingredients (spices, peanut butter by weight) could be either. The current `unit TEXT` field doesn't encode this — the frontend `TO_TSP` hack treats grams and tsp uniformly for pie chart proportions, which works but loses precision.

---

## 6. SauceBoss Schema Improvements

### Priority 1 — Add `unit_type` to Ingredient Data

The most impactful single change. Lets the backend and frontend know how to handle conversion correctly without JS hacks.

```sql
-- Migration: add unit_type to step ingredients
ALTER TABLE public.sauceboss_step_ingredients
  ADD COLUMN unit_type TEXT NOT NULL DEFAULT 'volume'
  CHECK (unit_type IN ('volume', 'weight', 'count'));

-- Backfill based on current units
UPDATE public.sauceboss_step_ingredients
  SET unit_type = 'count'
  WHERE unit IN ('clove', 'cloves', 'piece', 'pieces', 'pinch');

UPDATE public.sauceboss_step_ingredients
  SET unit_type = 'weight'
  WHERE unit = 'g';

-- Default 'volume' covers: tsp, tbsp, cup, oz
```

### Priority 2 — Add Source URL to Sauces

Required for the "import from URL" feature. Track where a sauce came from.

```sql
ALTER TABLE public.sauceboss_sauces
  ADD COLUMN source_url  TEXT,
  ADD COLUMN source_name TEXT;  -- e.g. "Serious Eats", "NYT Cooking"
```

### Priority 3 — Add Servings/Yield to Sauces

Mealie tracks `recipe_servings` and `recipe_yield`. SauceBoss currently has none. Useful for scaling sauce amounts.

```sql
ALTER TABLE public.sauceboss_sauces
  ADD COLUMN servings       INT,   -- number of servings
  ADD COLUMN yield_quantity REAL,  -- e.g. 2.0
  ADD COLUMN yield_unit     TEXT;  -- e.g. "cups", "oz"
```

### Priority 4 — Add `original_text` to Imported Ingredients

When a sauce is imported from a URL, preserve the raw scraped ingredient string alongside the parsed result. Lets users verify/correct parsing errors.

```sql
ALTER TABLE public.sauceboss_step_ingredients
  ADD COLUMN original_text TEXT;  -- e.g. "3 tbsp soy sauce, low-sodium"
```

### Priority 5 — Consider `standard_unit` for Backend Conversion

Currently, metric conversion lives entirely in frontend JS. Adding `standard_unit` to the unit system enables backend-side conversion (useful for the API + future native app).

```sql
-- Optional: Create a units reference table
CREATE TABLE public.sauceboss_units (
  abbreviation    TEXT PRIMARY KEY,   -- 'tsp', 'tbsp', 'cup', 'oz', 'g', etc.
  display_name    TEXT NOT NULL,      -- 'teaspoon'
  unit_type       TEXT NOT NULL CHECK (unit_type IN ('volume', 'weight', 'count')),
  standard_unit   TEXT NOT NULL,      -- Pint-compatible: 'teaspoon', 'milliliter', 'gram'
  to_ml           REAL,               -- conversion factor (NULL for weight/count)
  to_g            REAL                -- conversion factor (NULL for volume/count)
);

INSERT INTO public.sauceboss_units VALUES
  ('tsp',    'teaspoon',     'volume', 'teaspoon',      5.0,  NULL),
  ('tbsp',   'tablespoon',   'volume', 'tablespoon',   15.0,  NULL),
  ('cup',    'cup',          'volume', 'cup',          240.0,  NULL),
  ('oz',     'fluid ounce',  'volume', 'fluid_ounce',  29.6,  NULL),
  ('ml',     'milliliter',   'volume', 'milliliter',    1.0,  NULL),
  ('g',      'gram',         'weight', 'gram',          NULL,   1.0),
  ('clove',  'clove',        'count',  'clove',         NULL,  NULL),
  ('piece',  'piece',        'count',  'piece',         NULL,  NULL),
  ('pinch',  'pinch',        'count',  'pinch',         NULL,  NULL);
```

### Lower Priority — Ingredient Food Table

Mealie's separate `IngredientFoodModel` enables fuzzy matching, substitution lookup, and normalized search. For SauceBoss, this is overhead unless the ingredient count grows significantly (currently ~50). The existing `sauceboss_ingredient_categories` and `sauceboss_ingredient_substitutions` tables cover the most important use cases without the complexity of a full normalized food table.

**Recommendation:** Skip for now. Add if URL import results in hundreds of unique ingredient names that need deduplication.

---

## 7. URL Import Feature — Architecture Recommendations

### Python Libraries to Use

```
recipe-scrapers==14.x    # Primary scraper, 500+ site support
ingredient-parser-nlp    # NLP extraction of qty/unit/food from strings
pint                     # Unit dimensional analysis
rapidfuzz                # Fuzzy string matching for unit/food resolution
beautifulsoup4           # HTML cleaning fallback
```

### Suggested Endpoint

```
POST /api/v1/sauceboss/import-url
Body: { "url": "https://..." }
Response: {
  "name": "...",
  "description": "...",
  "servings": 4,
  "source_url": "https://...",
  "source_name": "Serious Eats",
  "steps": [...],           -- auto-organized by NLP
  "raw_ingredients": [...], -- original strings for user review
  "confidence": 0.87        -- overall parse confidence
}
```

### Suggested Flow

```
URL
  → fetch HTML (requests + httpx)
  → recipe-scrapers (Layer 1)
  → if fail: OpenAI extraction (Layer 2)
  → if fail: OpenGraph minimal (Layer 3)
  → clean ingredient strings
  → ingredient-parser-nlp → (qty, unit, food, note) per ingredient
  → fuzzy match units against sauceboss_units table
  → fuzzy match foods against sauceboss_ingredient_categories
  → group ingredients into steps (heuristic: by instruction paragraph)
  → return draft sauce for user review before saving
```

### Key Design Decision: Human-in-the-Loop

Mealie shows the user a parsed recipe and lets them correct it before saving. SauceBoss should do the same — return a draft that the user reviews/edits in the UI, then confirms. Don't auto-save URL imports.

---

## 8. Files Referenced

| File | Purpose |
|------|---------|
| `mealie/db/models/recipe/ingredient.py` | IngredientUnitModel, IngredientFoodModel, RecipeIngredientModel |
| `mealie/db/models/recipe/recipe.py` | RecipeModel with yield/servings fields |
| `mealie/services/scraper/scraper.py` | Orchestrator with 3-strategy cascade |
| `mealie/services/scraper/scraper_strategies.py` | RecipeScraperPackage, OpenAI, OpenGraph |
| `mealie/services/parser_services/ingredient_parser.py` | NLPParser + BruteForceParser |
| `mealie/services/parser_services/parser_utils/unit_utils.py` | UnitConverter with Pint |
| `projects/sauceboss/app/src/utils/units.js` | Current SauceBoss unit conversion (frontend-only) |
| `db/schema/sauceboss.sql` | Current SauceBoss schema (migration 026) |
