// plant-models.js — Plant descriptor resolution and mesh building
// Reads MODEL_TEMPLATES and PLANT_MODELS from plant-data.js

// Category fallback descriptors (used when no per-plant or template match)
var CATEGORY_DEFAULTS = {
  vegetable: {
    stem: { shape: "cylinder", height: 0.4, radius: 0.04, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.4, 0], scale: [0.22, 0.2, 0.22], color: "#2E7D32" },
      { shape: "sphere", position: [0.06, 0.44, 0.04], scale: [0.14, 0.13, 0.14], color: "#388E3C" }
    ],
    accents: []
  },
  herb: {
    stem: { shape: "cylinder", height: 0.2, radius: 0.025, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.26, 0], scale: [0.2, 0.12, 0.2], color: "#66BB6A" }
    ],
    accents: []
  },
  flower: {
    stem: { shape: "cylinder", height: 0.45, radius: 0.025, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.3, 0], scale: [0.06, 0.03, 0.06], color: "#388E3C" }
    ],
    accents: [
      { shape: "sphere", position: [0, 0.52, 0], scale: [0.14, 0.1, 0.14], color: "#E91E63" }
    ]
  },
  fruit: {
    stem: { shape: "cylinder", height: 0.15, radius: 0.03, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.16, 0], scale: [0.22, 0.1, 0.22], color: "#388E3C" },
      { shape: "sphere", position: [0.06, 0.14, 0.05], scale: [0.14, 0.08, 0.14], color: "#43A047" }
    ],
    accents: [
      { shape: "sphere", position: [0.08, 0.1, 0.06], scale: [0.05, 0.05, 0.05], color: "#FF6D00" }
    ]
  },
  other: {
    stem: { shape: "cylinder", height: 0.3, radius: 0.035, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.35, 0], scale: [0.18, 0.15, 0.18], color: "#4CAF50" }
    ],
    accents: []
  }
};

function _deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Apply colors from a color map onto a cloned geometry template
function _applyColors(desc, colors) {
  if (!colors) return desc;
  if (colors.stem && desc.stem) desc.stem.color = colors.stem;
  if (colors.foliage && desc.foliage) {
    for (var i = 0; i < desc.foliage.length && i < colors.foliage.length; i++) {
      desc.foliage[i].color = colors.foliage[i];
    }
  }
  if (colors.accents && desc.accents) {
    for (var j = 0; j < desc.accents.length && j < colors.accents.length; j++) {
      desc.accents[j].color = colors.accents[j];
    }
  }
  return desc;
}

function getPlantDescriptor(plant) {
  // Tier 0: DB-provided render data (render_params + render_colors)
  if (plant.render_params) {
    var dbDesc = _deepClone(plant.render_params);
    if (plant.render_colors) _applyColors(dbDesc, plant.render_colors);
    return dbDesc;
  }
  // Tier 1: per-plant entry in PLANT_MODELS
  var entry = PLANT_MODELS[plant.name];
  if (entry) {
    if (entry._template && MODEL_TEMPLATES[entry._template]) {
      var desc = _deepClone(MODEL_TEMPLATES[entry._template]);
      return _applyColors(desc, entry.colors);
    }
    // Inline descriptor (no template)
    return _deepClone(entry);
  }
  // Tier 2: category fallback
  var cat = plant.category || "other";
  return _deepClone(CATEGORY_DEFAULTS[cat] || CATEGORY_DEFAULTS.other);
}

function buildPlantMesh(plant, style) {
  var group;

  if (style === "realistic") {
    group = buildBillboardMesh(plant);
  } else {
    var desc = getPlantDescriptor(plant);
    group = new THREE.Group();

    if (desc.stem) group.add(buildShapeMesh(desc.stem, style));
    if (desc.foliage) {
      for (var i = 0; i < desc.foliage.length; i++) group.add(buildShapeMesh(desc.foliage[i], style));
    }
    if (desc.accents) {
      for (var j = 0; j < desc.accents.length; j++) group.add(buildShapeMesh(desc.accents[j], style));
    }
  }

  // Proportional height scaling — plants are correctly sized relative to each other
  // Multipliers make plants bigger in relation to grid squares
  var heightInches = plant.height_inches || 12;
  var ratio = heightInches / 84;
  var yScale = Math.max(0.25, ratio) * 1.5;
  var xzScale = Math.max(0.55, 0.5 + ratio * 0.5) * 1.4;
  group.scale.set(xzScale, yScale, xzScale);
  return group;
}
