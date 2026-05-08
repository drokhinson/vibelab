// Editor-only type declarations for the sauceboss web app.
//
// The web app loads JS via <script> tags and shares globals across files (no
// ES imports). This file declares those globals so files annotated with
// `// @ts-check` get type info from VS Code / Cursor / Claude without any
// runtime, build, or npm impact. The file is never shipped to the browser.
//
// Convention: see .claude/rules/typed-js.md.

import type {
  IngredientCategoryMap,
  SubstitutionMap,
  FoodRow,
} from "../shared/api.js";

declare global {
  // ── App-wide state ──────────────────────────────────────────────────────────
  // Most of `state` is still untyped — type fields here as the surface they
  // protect grows. The fields currently typed are the ones that have caused
  // (or could cause) shape-mismatch bugs between shared/api.js and consumers.
  interface AppState {
    ingredientCategories: IngredientCategoryMap;
    substitutions: SubstitutionMap;
    adminFoods: FoodRow[];
    adminFoodsLoading: boolean;
    screen: string;
    loading: string | null;
    builder:
      | null
      | {
          steps: Array<{ ingredients: Array<{ name: string }> }>;
          acStep: number | null;
          acIng: number | null;
          acResults: unknown[];
        };
    [key: string]: unknown;
  }
  let state: AppState;

  // ── Auth ────────────────────────────────────────────────────────────────────
  let supabaseClient: unknown;
  let session: { access_token?: string } | null;
  let currentUser:
    | null
    | { user_id: string; display_name?: string; is_admin?: boolean };

  // ── API fetcher shims (helpers.js) ──────────────────────────────────────────
  // The sauceboss web app exposes the shared client as `api` plus a fan of
  // `fetchX` aliases. Only the fetchers init.js actually calls are declared
  // here; add more as @ts-check rolls forward.
  function fetchInitialLoad(): Promise<{
    carbs: unknown[];
    proteins: unknown[];
    saladBases: unknown[];
  }>;
  function fetchIngredientCategories(): Promise<IngredientCategoryMap>;
  function fetchSubstitutions(): Promise<SubstitutionMap>;

  // ── Navigation + render ─────────────────────────────────────────────────────
  function render(): void;
  function navigate(
    screen: string,
    opts?: { push?: boolean; replace?: boolean },
  ): void;

  // ── Splash / supabase boot ─────────────────────────────────────────────────
  function initSupabase(): void;

  // ── Builder + ingredient interactions ──────────────────────────────────────
  function toggleIngredient(name: string): void;
  function builderHandleInput(target: HTMLElement): void;
  function builderPickAutocomplete(
    name: string,
    stepIndex: number,
    ingIndex: number,
  ): void;
  function builderClassifyIngredient(
    stepIndex: number,
    ingIndex: number,
    category: string,
  ): void;
  function isKnownIngredient(name: string): boolean;

  // ── Swipe handlers ─────────────────────────────────────────────────────────
  function installSwipeHandlers(rootEl: HTMLElement): void;

  // ── Constants exposed by shared-bridge.js ──────────────────────────────────
  const CATEGORY_ORDER: string[];
}

export {};
