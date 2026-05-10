// Shared-layer bridge for the web app.
//
// The web/ prototype uses vanilla <script> tags and globals (no bundler). The
// shared/ folder is consumed directly by the React Native app via Metro, but
// can also be loaded by browsers as native ES modules. This file imports the
// shared modules and re-publishes them on `window` so existing call sites in
// state.js, helpers.js, builder.js, etc. keep working.
//
// Loaded as <script type="module" src="shared-bridge.js"></script> at the top
// of index.html, BEFORE the deferred classic <script> tags. Module scripts
// and deferred classic scripts both run after parsing, in document order, so
// these globals are guaranteed to exist by the time state.js executes.
//
// Exposure strategy:
//   • Functions with identical signatures across web and native land as flat
//     globals (e.g. `ingColor`, `arcPath`, `levenshtein`, `buildSauceFamilies`)
//     — web's duplicate copies were deleted and call sites use the bridged
//     globals directly.
//   • Functions whose web version reads from the global `state`/`currentUser`
//     while the shared version takes them as parameters live under
//     `window.SBShared.<module>.<name>` (e.g. `SBShared.filter.isSauceAvailable`).
//     web/helpers.js then keeps a one-line shim that injects the right state
//     slice — the wrapper's only job is to bind state, the logic lives in
//     shared/.

import * as constants from './shared/constants.js';
import * as units from './shared/units.js';
import * as colors from './shared/colors.js';
import * as families from './shared/families.js';
import * as filter from './shared/filter.js';
import * as fuzzy from './shared/fuzzy.js';
import * as pieMath from './shared/pieMath.js';
import * as builderHelpers from './shared/builder.js';
import * as apiFactory from './shared/api.js';

// Flat globals — exact same signature as web's old versions.
Object.assign(window, constants, units, colors, pieMath);
window.buildSauceFamilies = families.buildSauceFamilies;
window.pickDisplayedFromFamily = families.pickDisplayedFromFamily;
window.withIngredientNames = filter.withIngredientNames;
window.levenshtein = fuzzy.levenshtein;

// Namespaced — web wrappers in helpers.js / sauces.js / builder.js call these
// after binding the relevant state slice (favorites, currentUser, etc.) or
// API config (auth token getter, base URL).
window.SBShared = {
  families,
  filter,
  fuzzy,
  builder: builderHelpers,
  api: apiFactory,
};
