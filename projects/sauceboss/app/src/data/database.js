import { CARBS } from './carbs';
import { SAUCES } from './sauces';

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS carbs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    emoji       TEXT NOT NULL,
    description TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sauces (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    cuisine       TEXT NOT NULL,
    cuisine_emoji TEXT NOT NULL,
    color         TEXT NOT NULL,
    description   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sauce_carbs (
    sauce_id TEXT NOT NULL,
    carb_id  TEXT NOT NULL,
    PRIMARY KEY (sauce_id, carb_id)
  );
  CREATE TABLE IF NOT EXISTS sauce_steps (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sauce_id   TEXT    NOT NULL,
    step_order INTEGER NOT NULL,
    title      TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS step_ingredients (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    step_id INTEGER NOT NULL,
    name    TEXT    NOT NULL,
    amount  REAL    NOT NULL,
    unit    TEXT    NOT NULL
  );
`;

// ─── Seed ─────────────────────────────────────────────────────────────────────

export async function seedDatabase(db) {
  await db.execAsync(SCHEMA);

  const { count } = await db.getFirstAsync('SELECT COUNT(*) AS count FROM carbs');
  if (count > 0) return; // already seeded

  for (const carb of CARBS) {
    await db.runAsync(
      'INSERT OR REPLACE INTO carbs (id, name, emoji, description) VALUES (?, ?, ?, ?)',
      carb.id, carb.name, carb.emoji, carb.desc
    );
  }

  for (const sauce of SAUCES) {
    await db.runAsync(
      'INSERT OR REPLACE INTO sauces (id, name, cuisine, cuisine_emoji, color, description) VALUES (?, ?, ?, ?, ?, ?)',
      sauce.id, sauce.name, sauce.cuisine, sauce.cuisineEmoji, sauce.color, sauce.description
    );

    for (const carbId of sauce.compatibleCarbs) {
      await db.runAsync(
        'INSERT OR REPLACE INTO sauce_carbs (sauce_id, carb_id) VALUES (?, ?)',
        sauce.id, carbId
      );
    }

    for (let order = 0; order < sauce.steps.length; order++) {
      const step = sauce.steps[order];
      const result = await db.runAsync(
        'INSERT INTO sauce_steps (sauce_id, step_order, title) VALUES (?, ?, ?)',
        sauce.id, order, step.title
      );
      const stepId = result.lastInsertRowId;
      for (const ing of step.ingredients) {
        await db.runAsync(
          'INSERT INTO step_ingredients (step_id, name, amount, unit) VALUES (?, ?, ?, ?)',
          stepId, ing.name, ing.amount, ing.unit
        );
      }
    }
  }
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Returns all carbs with the count of sauces available for each.
 * Shape: [{ id, name, emoji, desc, sauceCount }]
 */
export async function getCarbs(db) {
  const rows = await db.getAllAsync(`
    SELECT c.id, c.name, c.emoji, c.description AS desc,
           COUNT(sc.sauce_id) AS sauceCount
    FROM carbs c
    LEFT JOIN sauce_carbs sc ON sc.carb_id = c.id
    GROUP BY c.id
    ORDER BY c.rowid
  `);
  return rows;
}

/**
 * Returns fully assembled sauce objects compatible with carbId.
 * Each sauce has the same shape as SAUCES entries:
 *   { id, name, cuisine, cuisineEmoji, color, description,
 *     compatibleCarbs[], ingredients[], steps[{ title, ingredients[] }] }
 */
export async function getSaucesForCarb(db, carbId) {
  // 1. Base sauce rows
  const sauceRows = await db.getAllAsync(`
    SELECT s.id, s.name, s.cuisine, s.cuisine_emoji AS cuisineEmoji,
           s.color, s.description
    FROM sauces s
    JOIN sauce_carbs sc ON sc.sauce_id = s.id
    WHERE sc.carb_id = ?
    ORDER BY s.cuisine, s.name
  `, carbId);

  if (sauceRows.length === 0) return [];

  const sauceIds = sauceRows.map(s => s.id);
  const placeholders = sauceIds.map(() => '?').join(',');

  // 2. Compatible carbs for these sauces
  const carbRows = await db.getAllAsync(
    `SELECT sauce_id, carb_id FROM sauce_carbs WHERE sauce_id IN (${placeholders})`,
    ...sauceIds
  );

  // 3. All steps + ingredients for these sauces (one query, assembled in JS)
  const ingRows = await db.getAllAsync(`
    SELECT ss.sauce_id, ss.id AS step_id, ss.step_order, ss.title,
           si.name, si.amount, si.unit
    FROM sauce_steps ss
    JOIN step_ingredients si ON si.step_id = ss.id
    WHERE ss.sauce_id IN (${placeholders})
    ORDER BY ss.sauce_id, ss.step_order, si.rowid
  `, ...sauceIds);

  // Build lookup maps
  const carbsMap = {};
  for (const row of carbRows) {
    if (!carbsMap[row.sauce_id]) carbsMap[row.sauce_id] = [];
    carbsMap[row.sauce_id].push(row.carb_id);
  }

  const stepsMap = {};
  const ingNamesMap = {};
  for (const row of ingRows) {
    if (!stepsMap[row.sauce_id]) stepsMap[row.sauce_id] = {};
    const steps = stepsMap[row.sauce_id];
    if (!steps[row.step_id]) {
      steps[row.step_id] = { _order: row.step_order, title: row.title, ingredients: [] };
    }
    steps[row.step_id].ingredients.push({ name: row.name, amount: row.amount, unit: row.unit });

    if (!ingNamesMap[row.sauce_id]) ingNamesMap[row.sauce_id] = new Set();
    ingNamesMap[row.sauce_id].add(row.name);
  }

  return sauceRows.map(sauce => {
    const stepsById = stepsMap[sauce.id] ?? {};
    const steps = Object.values(stepsById)
      .sort((a, b) => a._order - b._order)
      .map(({ title, ingredients }) => ({ title, ingredients }));

    // Flat deduped ingredient list (order of first appearance across steps)
    const seen = new Set();
    const ingredients = [];
    for (const step of steps) {
      for (const ing of step.ingredients) {
        if (!seen.has(ing.name)) {
          seen.add(ing.name);
          ingredients.push(ing);
        }
      }
    }

    return {
      id: sauce.id,
      name: sauce.name,
      cuisine: sauce.cuisine,
      cuisineEmoji: sauce.cuisineEmoji,
      color: sauce.color,
      description: sauce.description,
      compatibleCarbs: carbsMap[sauce.id] ?? [],
      ingredients,
      steps,
    };
  });
}

/**
 * Returns a sorted list of unique ingredient names for all sauces compatible
 * with carbId. Used to populate the ingredient filter panel.
 */
export async function getIngredientsForCarb(db, carbId) {
  const rows = await db.getAllAsync(`
    SELECT DISTINCT si.name
    FROM step_ingredients si
    JOIN sauce_steps ss ON ss.id = si.step_id
    JOIN sauce_carbs sc ON sc.sauce_id = ss.sauce_id
    WHERE sc.carb_id = ?
    ORDER BY si.name
  `, carbId);
  return rows.map(r => r.name);
}
