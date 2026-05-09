# PlantPlanner — API Reference Notes

## Cascade Order
Trefle (open source, free) → Flora API (US plants, paid) → Perenual (garden-focused, freemium)

Companion planting: bundled static JSON → Claude AI fallback (no external API needed)

---

## 1. Trefle

**URL:** https://trefle.io  
**Docs:** https://docs.trefle.io  
**Cost:** Free  
**Auth:** Token as query param `?token=YOUR_TOKEN`  
**Get key:** https://trefle.io/profile  
**Status:** Open source / community maintained — data completeness varies, no SLA

### Endpoints

```
GET https://trefle.io/api/v1/plants/search?q={query}&token={token}
GET https://trefle.io/api/v1/plants/{id}?token={token}
GET https://trefle.io/api/v1/species/search?q={query}&token={token}
```

### Key Response Fields

| Field | Path | Notes |
|---|---|---|
| Name | `common_name` | May be null — fall back to `scientific_name` |
| Scientific | `scientific_name` | Always present |
| Image | `image_url` | CC licensed |
| Light | `growth.light` | Scale 0–10; ≥7 = full sun, 4–6 = part shade |
| Days to harvest | `growth.days_to_harvest` | Integer |
| Soil pH | `growth.ph_minimum` / `growth.ph_maximum` | Float |
| Sowing guide | `growth.sowing` | Text description |
| Height (avg) | `specifications.average_height.cm` | Integer cm |
| Height (max) | `specifications.maximum_height.cm` | Integer cm |
| Growth rate | `specifications.growth_rate` | slow / moderate / rapid |
| Toxicity | `specifications.toxicity` | none / low / medium / high |
| Nitrogen fixation | `specifications.nitrogen_fixation` | Boolean — useful for companion logic |
| Edible | `edible` | Boolean |
| Vegetable | `vegetable` | Boolean |
| Duration | `duration` | Array: ["annual"], ["perennial"], etc. |
| Distribution | `distribution` | Native/introduced by region |

### Notes
- CORS supported for browser requests
- No hardiness zone data — this field must come from Flora or Perenual
- Data completeness is inconsistent for rare/non-commercial species
- Pagination via `?page=N`; each page returns up to 30 results
- Search covers ~400,000 species

---

## 2. Flora API

**URL:** https://floraapi.com  
**Cost:** Paid (check floraapi.com for current pricing)  
**Auth:** `api_key` query param  
**Get key:** https://floraapi.com  
**Coverage:** 29,000+ US plant species

### Endpoints (approximate — verify against their docs)

```
GET https://floraapi.com/api/plants?search={query}&api_key={key}&limit=20
GET https://floraapi.com/api/plants/{id}?api_key={key}
```

### Key Response Fields (verify shape against live docs)

| Field | Notes |
|---|---|
| `common_name` / `name` | Display name |
| `scientific_name` | Botanical name |
| `family` | Plant family |
| `image_url` | Photo |
| `hardiness_zone` | USDA zone string |
| `sun_exposure` / `sunlight` | Light requirements |
| `water_needs` / `watering` | Watering level |
| `duration` / `lifecycle` | annual / perennial etc. |
| `height_max` | Float in unspecified units — verify |
| `edible` | Boolean |
| `toxicity` | Text |

### Notes
- Best source for US-native and regional species data
- County-level distribution data available
- Native vs. invasive flags — useful for region-appropriate recommendations
- Response shape not fully documented publicly — inspect live response and normalize accordingly
- No companion planting data

---

## 3. Perenual

**URL:** https://perenual.com  
**Docs:** https://perenual.com/docs/api  
**Cost:** Freemium — first 3,000 species free; full 10,000+ requires paid plan  
**Auth:** `key` query param  
**Get key:** https://perenual.com/user/developer

### Endpoints

```
GET https://perenual.com/api/v2/species-list?key={key}&q={query}
GET https://perenual.com/api/v2/species/details/{id}?key={key}
GET https://perenual.com/api/v2/species-care-guide-list?key={key}&species_id={id}
```

### Key Response Fields

| Field | Path | Notes |
|---|---|---|
| Name | `common_name` | |
| Scientific | `scientific_name` | Array — take `[0]` |
| Image | `default_image.regular_url` | Also: `.original_url`, `.medium_url`, `.thumbnail` |
| Sunlight | `sunlight` | Array: `["full_sun"]`, `["part_shade"]`, etc. |
| Watering | `watering` | `"frequent"` / `"average"` / `"minimum"` / `"none"` |
| Cycle | `cycle` | `"annual"` / `"perennial"` / `"biennial"` |
| Hardiness min | `hardiness.min` | USDA zone number (string) |
| Hardiness max | `hardiness.max` | USDA zone number (string) |
| Edible leaf | `edible_leaf` | Boolean |
| Poisonous to humans | `poisonous_to_humans` | 0 or 1 |
| Poisonous to pets | `poisonous_to_pets` | 0 or 1 |
| Indoor | `indoor` | Boolean |

### Care Guide Fields (detail endpoint)
- Watering description, frequency, benchmark
- Sunlight description
- Pruning month + description
- Fertilization details

### Notes
- Best image quality of the three APIs
- Best hardiness zone coverage
- No days-to-harvest or soil pH data — use Trefle for those
- Free tier silently returns upgrade prompts for species beyond limit — handle gracefully
- Pagination: `?page=N`

---

## 4. Companion Planting — No API Exists

OpenFarm (the only API that had companion data) **shut down in April 2025**.

### Current approach in PlantPlanner

**Layer 1 — Bundled static dataset**
30+ common vegetables and herbs with good/bad neighbor lists and tips. Zero API cost, always available, no latency.

**Layer 2 — Claude AI fallback**
When a plant isn't in the local dataset, call the Anthropic API:

```js
POST https://api.anthropic.com/v1/messages
{
  model: "claude-sonnet-4-20250514",
  max_tokens: 800,
  system: "Return ONLY valid JSON: {\"good\":[string],\"bad\":[string],\"tip\":string}",
  messages: [{ role: "user", content: "Companion planting for: {plantName}" }]
}
```

**Layer 3 — Community datasets (potential future)**
- GitHub: `GenevieveMilliken/companion_plants` — structured companion planting JSON, MIT licensed
- Can be bundled as a static import to replace/expand the hardcoded dataset

---

## 5. Planting Calendar — No Dedicated API

Neither Trefle, Flora, nor Perenual provides a planting calendar keyed to a user's location.

### Recommended approach

**Frost dates:** Use the Open-Meteo API (free, no key) for current weather, and a static NOAA frost date dataset (public domain) for last/first frost by zip code.

**Zone lookup:** USDA Plant Hardiness Zone map data is available as a static JSON lookup by zip code.

**Calendar computation:**
```
indoor_start  = last_frost_date - plant.weeks_before_frost_to_start_indoors
transplant    = last_frost_date + plant.weeks_after_frost_to_transplant
harvest_start = transplant + plant.days_to_harvest
harvest_end   = first_fall_frost - 2 weeks
```

Per-plant offset data (weeks before/after frost) must be stored locally or generated by Claude — it is not in any of the three APIs.

---

## 6. Supplementary APIs Worth Tracking

| API | Use Case | Cost |
|---|---|---|
| Open-Meteo | Current weather + forecast by lat/lon | Free, no key |
| OpenStreetMap Nominatim | Zip/city → lat/lon geocoding | Free, no key |
| USDA PLANTS Database | Official botanical data, native ranges | Free, no auth (no official API — use web scraping or static export) |
| Old Farmer's Almanac | Frost dates by zip | Scrape or static dataset |

---

## Normalization Target Shape

All three APIs normalize to this common object in PlantPlanner:

```js
{
  id: string,              // "{source}-{original_id}"
  source: "trefle" | "flora" | "perenual" | "demo",
  name: string,            // common name
  scientific: string,
  family: string | null,
  image: string | null,    // full-size URL
  thumbnail: string | null,
  emoji: string,           // fallback display
  hardiness: { min: number, max: number } | null,  // USDA zones
  sunlight: "full_sun" | "part_shade" | "full_shade" | null,
  watering: "frequent" | "average" | "minimum" | "none" | null,
  cycle: "annual" | "perennial" | "biennial" | null,
  height: { min: number, max: number } | null,  // cm
  daysToHarvest: number | null,
  edible: boolean | null,
  vegetable: boolean | null,
  toxicity: string | null,
  growthRate: "slow" | "moderate" | "rapid" | null,
  ph: { min: number, max: number } | null,
  sowing: string | null,   // text description
  nitrogen: boolean | null, // nitrogen fixation
  tags: string[],
}
```
