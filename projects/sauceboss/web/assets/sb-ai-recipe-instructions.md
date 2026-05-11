# AI Recipe Builder — SauceBoss Import Format

Use these instructions to convert any recipe into a JSON file that SauceBoss can import directly.

## Output Format

Return a single JSON object with the following structure:

```json
{
  "name": "Recipe Name",
  "description": "A short description of the recipe (1-2 sentences).",
  "sourceUrl": "https://original-recipe-url.com/recipe (optional)",
  "totalTimeMinutes": 30,
  "yieldServings": 4,
  "instructions": [
    "First instruction step as a plain text string.",
    "Second instruction step as a plain text string.",
    "Third instruction step..."
  ],
  "ingredients": [
    {
      "foodRaw": "olive oil",
      "quantity": 2,
      "unitRaw": "tbsp",
      "originalText": "2 tablespoons olive oil"
    },
    {
      "foodRaw": "garlic",
      "quantity": 3,
      "unitRaw": "clove",
      "originalText": "3 cloves garlic, minced"
    },
    {
      "foodRaw": "salt",
      "quantity": 0,
      "unitRaw": "to taste",
      "originalText": "salt to taste"
    }
  ]
}
```

## Field Reference

### Top-Level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Recipe/sauce name (max 80 characters) |
| `description` | string | No | Brief description |
| `sourceUrl` | string | No | URL of the original recipe |
| `totalTimeMinutes` | number | No | Total cook time in minutes |
| `yieldServings` | number | No | Number of servings |
| `instructions` | string[] | Yes | Ordered list of cooking steps as plain text |
| `ingredients` | object[] | Yes | List of ingredients (see below) |

### Ingredient Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `foodRaw` | string | Yes | Ingredient name (e.g., "garlic", "soy sauce") |
| `quantity` | number | Yes | Amount — use `0` for "to taste" items |
| `unitRaw` | string | Yes | Unit of measurement (see list below) |
| `originalText` | string | No | Original text line from the recipe |

### Supported Units

Use these exact unit values: `tsp`, `tbsp`, `cup`, `ml`, `l`, `oz`, `g`, `piece`, `clove`, `pinch`, `dash`, `bunch`, `can`, `slice`, `whole`, `sprig`, `stalk`, `to taste`

## Rules

1. **Instructions**: Each step should be a self-contained instruction. Reference ingredients by name in the instruction text so SauceBoss can auto-assign them to the correct step.
2. **Ingredients**: List every ingredient separately. If a recipe says "salt and pepper to taste", create two separate ingredient entries each with `quantity: 0` and `unitRaw: "to taste"`.
3. **Units**: Normalize units to the supported list. Convert "tablespoons" → "tbsp", "teaspoons" → "tsp", "cups" → "cup", etc.
4. **Quantities**: Use decimal numbers (e.g., `0.5` not `"1/2"`). For ranges like "2-3 cloves", use the lower number.
5. **Ingredient names**: Use the base ingredient name without preparation notes. "3 cloves garlic, minced" → `foodRaw: "garlic"`. Put the full text in `originalText`.

## Example Prompt

> Convert this recipe into the SauceBoss JSON import format. Follow the schema exactly. Return only the JSON, no other text.
>
> [paste recipe here]
