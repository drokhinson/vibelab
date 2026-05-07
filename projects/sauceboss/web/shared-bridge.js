// Shared-layer bridge for the web app.
//
// The web/ prototype uses vanilla <script> tags and globals (no bundler). The
// shared/ folder is consumed directly by the React Native app via Metro, but
// can also be loaded by browsers as native ES modules. This file imports the
// pieces of shared/ that the web globals used to declare locally and
// re-publishes them on `window` so existing call sites in state.js,
// helpers.js, builder.js, etc. keep working unchanged.
//
// Loaded as <script type="module" src="shared-bridge.js"></script> at the top
// of index.html, BEFORE the deferred classic <script> tags. Module scripts
// and deferred classic scripts both run after parsing, in document order, so
// these globals are guaranteed to exist by the time state.js executes.
//
// Scope (intentionally narrow for the first pass):
//   • shared/constants.js — CUISINES, UNITS, COLOR_SWATCHES, SAUCE_TYPES,
//     PALETTE, ING_COLOR, STEP_OUTPUT_COLOR, TO_TSP, VOLUME_TO_ML, WEIGHT_TO_G,
//     COUNT_UNITS, CATEGORY_ORDER, ITEM_FLOW_META, flowMetaFor
//   • shared/units.js — toTsp, cumulativeStepTsp, tspToDisplay, convertUnit,
//     formatAmount, scaleAmount
//
// Future passes will bridge colors, families, filter, fuzzy, pieMath, and
// validation. prepareItems intentionally stays in helpers.js — the web
// version reads servings/unitSystem from `state` directly, while the shared
// version takes them as parameters.

import * as constants from './shared/constants.js';
import * as units from './shared/units.js';

Object.assign(window, constants, units);
