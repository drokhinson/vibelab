// PlantPlanner shading model — northern hemisphere default.
// Coordinate convention: bed runs along x (grid_width) and y (grid_height) in feet.
// We treat +y = NORTH. Solar-noon sun shadows extend in the -y (south) direction.
// To support southern hemisphere, flip the sign in shadowZoneFor() and update this block.

function shadowZoneFor(placement, year) {
  if (!placement || !placement.plant) return null;
  var s = (typeof yearScale === 'function') ? yearScale(placement.plant, year) : 1.0;
  var heightFt = ((placement.plant.height_inches || 12) / 12) * s;
  var halfWidth = (placement.radius_feet || 0.5) * s;
  return {
    cx: placement.pos_x,
    yNorth: placement.pos_y,
    ySouth: placement.pos_y - heightFt * 0.7,
    halfWidth: halfWidth,
    heightFt: heightFt
  };
}

function pointInShadow(zone, x_b, y_b, r_b) {
  if (!zone) return false;
  if (Math.abs(x_b - zone.cx) > zone.halfWidth + (r_b || 0) * 0.5) return false;
  if (y_b > zone.yNorth) return false;
  if (y_b < zone.ySouth) return false;
  return true;
}

function computeShadeConflicts(placements, year) {
  // Returns { [shadedPlacementId]: [{type:'shade', shadedPlacementId, shadingPlacementId, shadingPlantId}, ...] }
  var result = {};
  if (!placements || placements.length === 0) return result;
  var year_ = year || (typeof previewYear !== 'undefined' ? previewYear : 3);
  for (var i = 0; i < placements.length; i++) {
    var tall = placements[i];
    var shortIdx;
    var ts = (typeof yearScale === 'function') ? yearScale(tall.plant, year_) : 1.0;
    var tallH = ((tall.plant.height_inches || 12) / 12) * ts;
    var zone = shadowZoneFor(tall, year_);
    if (!zone) continue;
    for (shortIdx = 0; shortIdx < placements.length; shortIdx++) {
      if (shortIdx === i) continue;
      var short = placements[shortIdx];
      if (short.plant && short.plant.sunlight !== 'full_sun') continue;
      var ss = (typeof yearScale === 'function') ? yearScale(short.plant, year_) : 1.0;
      var shortH = ((short.plant.height_inches || 12) / 12) * ss;
      if (tallH < shortH * 1.2) continue;
      var sr = (short.radius_feet || 0.5) * ss;
      if (!pointInShadow(zone, short.pos_x, short.pos_y, sr)) continue;
      (result[short.id] = result[short.id] || []).push({
        type: 'shade',
        shadedPlacementId: short.id,
        shadingPlacementId: tall.id,
        shadingPlantId: tall.plantId
      });
    }
  }
  return result;
}
