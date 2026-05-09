// garden-units.js — frontend mirror of backend `garden_units.py`. Single
// source of truth for the storage invariant introduced in migration 012:
//
//   grid_width / grid_height columns store INCHES when garden_type is one of
//     { indoor_pot, indoor_planter_box, outdoor_pot, outdoor_planter_box }
//   and FEET otherwise. pos_x / pos_y / radius_feet are ALWAYS feet.
//
// Loaded before gardens.js / render2d.js / garden.js. Keep these constants
// in lockstep with `shared-backend/routes/plant_planner/garden_units.py`.

var INCH_UNIT_GARDEN_TYPES = {
  indoor_pot: true,
  indoor_planter_box: true,
  outdoor_pot: true,
  outdoor_planter_box: true
};

var CLIMATE_CONTROLLED_GARDEN_TYPES = {
  indoor_pot: true,
  indoor_planter_box: true,
  greenhouse: true
};

function gardenTypeUsesInches(t) {
  return !!(t && INCH_UNIT_GARDEN_TYPES[t]);
}

function gardenTypeIsClimateControlled(t) {
  return !!(t && CLIMATE_CONTROLLED_GARDEN_TYPES[t]);
}

// Normalize a stored grid_width / grid_height value to feet for any garden_type.
function gridDimToFeet(value, gardenType) {
  if (value == null) return null;
  if (gardenTypeUsesInches(gardenType)) return value / 12;
  return Number(value);
}

// Display unit suffix for a garden type — "in" or "ft".
function gardenTypeUnitLabel(t) {
  return gardenTypeUsesInches(t) ? 'in' : 'ft';
}

// Pot rows store grid_width = RADIUS and grid_height = HEIGHT (vertical).
// The placement floor's planar footprint is 2r × 2r (the circle's bounding
// square) — NOT (grid_width, grid_height). Mirrors backend `floor_dims_feet`.
var POT_GARDEN_TYPES = { indoor_pot: true, outdoor_pot: true };

function gardenTypeIsPot(t) { return !!(t && POT_GARDEN_TYPES[t]); }

function floorDimsFeet(gridWidth, gridHeight, gardenType) {
  if (gardenTypeIsPot(gardenType)) {
    var radiusFt = gridDimToFeet(gridWidth, gardenType) || 0;
    var diameterFt = Math.max(0, 2 * radiusFt);
    return { width: diameterFt, length: diameterFt };
  }
  return {
    width:  gridDimToFeet(gridWidth,  gardenType) || 0,
    length: gridDimToFeet(gridHeight, gardenType) || 0
  };
}
