// plant-models.js — Procedural 3D plant geometry descriptors and mesh builder

// Bloom colors for flower category (fallback when no per-plant override)
var FLOWER_COLORS = {
  "Marigold": "#FF8F00", "Zinnia": "#E91E63", "Petunia": "#CE93D8",
  "Cosmos": "#F48FB1", "Nasturtium": "#FF6D00", "Dahlia": "#AD1457",
  "Pansy": "#7B1FA2", "Impatiens": "#EF5350", "Snapdragon": "#FF7043",
  "Black-Eyed Susan": "#FFC107", "Coneflower": "#AB47BC", "Geranium": "#E53935"
};

// Per-plant 3D descriptors for visually distinctive plants
// All positions/scales are normalized (height scaling applied separately)
var PLANT_MODELS = {
  "Sunflower": {
    stem: { shape: "cylinder", height: 0.7, radius: 0.05, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.55, 0], scale: [0.12, 0.04, 0.12], color: "#2E7D32" },
      { shape: "sphere", position: [0, 0.35, 0], scale: [0.10, 0.03, 0.10], color: "#388E3C" }
    ],
    accents: [
      { shape: "sphere", position: [0, 0.75, 0], scale: [0.28, 0.06, 0.28], color: "#FFD600" },
      { shape: "sphere", position: [0, 0.76, 0], scale: [0.12, 0.05, 0.12], color: "#5D4037" }
    ]
  },
  "Corn": {
    stem: { shape: "cylinder", height: 0.75, radius: 0.04, color: "#558B2F" },
    foliage: [
      { shape: "box", position: [0.12, 0.45, 0], scale: [0.22, 0.02, 0.06], color: "#66BB6A", rotation: [0, 0, -0.4] },
      { shape: "box", position: [-0.12, 0.35, 0], scale: [0.22, 0.02, 0.06], color: "#66BB6A", rotation: [0, 0, 0.4] },
      { shape: "box", position: [0, 0.55, 0.12], scale: [0.06, 0.02, 0.22], color: "#66BB6A", rotation: [0.4, 0, 0] }
    ],
    accents: [
      { shape: "cone", position: [0, 0.82, 0], scale: [0.04, 0.1, 0.04], color: "#F9A825" }
    ]
  },
  "Tomato": {
    stem: { shape: "cylinder", height: 0.45, radius: 0.04, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.45, 0], scale: [0.25, 0.22, 0.25], color: "#388E3C" },
      { shape: "sphere", position: [0.08, 0.5, 0.06], scale: [0.15, 0.14, 0.15], color: "#43A047" }
    ],
    accents: [
      { shape: "sphere", position: [0.12, 0.38, 0.1], scale: [0.06, 0.06, 0.06], color: "#E53935" },
      { shape: "sphere", position: [-0.08, 0.42, -0.06], scale: [0.055, 0.055, 0.055], color: "#EF5350" },
      { shape: "sphere", position: [0.02, 0.35, 0.14], scale: [0.05, 0.05, 0.05], color: "#C62828" }
    ]
  },
  "Pepper": {
    stem: { shape: "cylinder", height: 0.4, radius: 0.035, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.42, 0], scale: [0.22, 0.2, 0.22], color: "#388E3C" }
    ],
    accents: [
      { shape: "box", position: [0.1, 0.3, 0.05], scale: [0.04, 0.08, 0.04], color: "#F44336" },
      { shape: "box", position: [-0.06, 0.32, -0.08], scale: [0.035, 0.07, 0.035], color: "#4CAF50" }
    ]
  },
  "Carrot": {
    stem: { shape: "cylinder", height: 0.08, radius: 0.02, color: "#4a7c3f" },
    foliage: [
      { shape: "cone", position: [0, 0.22, 0], scale: [0.18, 0.18, 0.18], color: "#66BB6A" },
      { shape: "cone", position: [0.04, 0.26, 0.03], scale: [0.12, 0.14, 0.12], color: "#81C784" }
    ],
    accents: [
      { shape: "cone", position: [0, -0.04, 0], scale: [0.05, 0.14, 0.05], color: "#FF6D00", rotation: [Math.PI, 0, 0] }
    ]
  },
  "Radish": {
    stem: { shape: "cylinder", height: 0.06, radius: 0.015, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.14, 0], scale: [0.16, 0.1, 0.16], color: "#66BB6A" }
    ],
    accents: [
      { shape: "sphere", position: [0, -0.02, 0], scale: [0.07, 0.09, 0.07], color: "#E91E63" }
    ]
  },
  "Lavender": {
    stem: { shape: "cylinder", height: 0.3, radius: 0.015, color: "#6D8764" },
    foliage: [
      { shape: "cylinder", height: 0.25, radius: 0.012, color: "#6D8764", position: [0.06, 0.12, 0.03] },
      { shape: "cylinder", height: 0.22, radius: 0.012, color: "#6D8764", position: [-0.05, 0.11, -0.04] },
      { shape: "cylinder", height: 0.2, radius: 0.012, color: "#6D8764", position: [0.02, 0.1, -0.06] }
    ],
    accents: [
      { shape: "cone", position: [0, 0.48, 0], scale: [0.04, 0.1, 0.04], color: "#9C27B0" },
      { shape: "cone", position: [0.06, 0.42, 0.03], scale: [0.035, 0.08, 0.035], color: "#AB47BC" },
      { shape: "cone", position: [-0.05, 0.4, -0.04], scale: [0.035, 0.08, 0.035], color: "#AB47BC" },
      { shape: "cone", position: [0.02, 0.38, -0.06], scale: [0.03, 0.07, 0.03], color: "#9C27B0" }
    ]
  },
  "Strawberry": {
    stem: { shape: "cylinder", height: 0.05, radius: 0.02, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.08, 0], scale: [0.2, 0.08, 0.2], color: "#388E3C" },
      { shape: "sphere", position: [0.08, 0.07, 0.06], scale: [0.12, 0.06, 0.12], color: "#43A047" }
    ],
    accents: [
      { shape: "sphere", position: [0.1, 0.04, 0.08], scale: [0.04, 0.035, 0.03], color: "#E53935" },
      { shape: "sphere", position: [-0.06, 0.04, 0.1], scale: [0.035, 0.03, 0.025], color: "#C62828" },
      { shape: "sphere", position: [0.04, 0.03, -0.09], scale: [0.04, 0.035, 0.03], color: "#EF5350" }
    ]
  },
  "Watermelon": {
    stem: { shape: "cylinder", height: 0.06, radius: 0.02, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.08, 0], scale: [0.25, 0.05, 0.25], color: "#388E3C" },
      { shape: "sphere", position: [-0.12, 0.06, 0.08], scale: [0.12, 0.04, 0.1], color: "#43A047" }
    ],
    accents: [
      { shape: "sphere", position: [0.08, 0.04, 0.06], scale: [0.14, 0.1, 0.1], color: "#2E7D32" }
    ]
  },
  "Pumpkin": {
    stem: { shape: "cylinder", height: 0.06, radius: 0.02, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.1, 0], scale: [0.25, 0.06, 0.25], color: "#388E3C" }
    ],
    accents: [
      { shape: "sphere", position: [0.06, 0.05, 0.04], scale: [0.12, 0.09, 0.12], color: "#FF6D00" },
      { shape: "cylinder", position: [0.06, 0.11, 0.04], scale: [0.02, 0.04, 0.02], color: "#4a7c3f" }
    ]
  },
  "Hosta": {
    stem: { shape: "cylinder", height: 0.04, radius: 0.02, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.12, 0], scale: [0.25, 0.12, 0.25], color: "#4CAF50" },
      { shape: "sphere", position: [0.06, 0.14, 0.04], scale: [0.18, 0.1, 0.18], color: "#66BB6A" },
      { shape: "sphere", position: [-0.04, 0.1, -0.05], scale: [0.16, 0.09, 0.16], color: "#388E3C" }
    ],
    accents: []
  },
  "Basil": {
    stem: { shape: "cylinder", height: 0.25, radius: 0.025, color: "#4a7c3f" },
    foliage: [
      { shape: "sphere", position: [0, 0.32, 0], scale: [0.18, 0.14, 0.18], color: "#43A047" },
      { shape: "sphere", position: [0.06, 0.28, 0.04], scale: [0.12, 0.1, 0.12], color: "#4CAF50" },
      { shape: "sphere", position: [-0.05, 0.26, -0.03], scale: [0.1, 0.09, 0.1], color: "#388E3C" }
    ],
    accents: []
  },
  "Rosemary": {
    stem: { shape: "cylinder", height: 0.3, radius: 0.03, color: "#5D4037" },
    foliage: [
      { shape: "cone", position: [0, 0.4, 0], scale: [0.12, 0.25, 0.12], color: "#558B2F" },
      { shape: "cone", position: [0.07, 0.35, 0.04], scale: [0.08, 0.2, 0.08], color: "#689F38" },
      { shape: "cone", position: [-0.05, 0.33, -0.05], scale: [0.07, 0.18, 0.07], color: "#558B2F" }
    ],
    accents: []
  },
  "Dill": {
    stem: { shape: "cylinder", height: 0.55, radius: 0.02, color: "#66BB6A" },
    foliage: [
      { shape: "sphere", position: [0.05, 0.35, 0], scale: [0.06, 0.02, 0.08], color: "#81C784" },
      { shape: "sphere", position: [-0.05, 0.25, 0.03], scale: [0.05, 0.02, 0.07], color: "#81C784" }
    ],
    accents: [
      { shape: "sphere", position: [0, 0.6, 0], scale: [0.12, 0.03, 0.12], color: "#C0CA33" }
    ]
  },
  "Blueberry": {
    stem: { shape: "cylinder", height: 0.35, radius: 0.04, color: "#5D4037" },
    foliage: [
      { shape: "sphere", position: [0, 0.4, 0], scale: [0.22, 0.2, 0.22], color: "#388E3C" },
      { shape: "sphere", position: [0.08, 0.45, 0.06], scale: [0.14, 0.13, 0.14], color: "#43A047" }
    ],
    accents: [
      { shape: "sphere", position: [0.1, 0.32, 0.08], scale: [0.035, 0.035, 0.035], color: "#283593" },
      { shape: "sphere", position: [-0.06, 0.35, -0.09], scale: [0.03, 0.03, 0.03], color: "#1A237E" },
      { shape: "sphere", position: [0.04, 0.3, -0.1], scale: [0.035, 0.035, 0.035], color: "#303F9F" }
    ]
  },
  "Raspberry": {
    stem: { shape: "cylinder", height: 0.35, radius: 0.03, color: "#5D4037" },
    foliage: [
      { shape: "sphere", position: [0, 0.4, 0], scale: [0.2, 0.18, 0.2], color: "#388E3C" },
      { shape: "sphere", position: [0.06, 0.44, 0.05], scale: [0.13, 0.12, 0.13], color: "#43A047" }
    ],
    accents: [
      { shape: "sphere", position: [0.09, 0.33, 0.07], scale: [0.035, 0.035, 0.035], color: "#C62828" },
      { shape: "sphere", position: [-0.07, 0.35, -0.08], scale: [0.03, 0.03, 0.03], color: "#D32F2F" },
      { shape: "sphere", position: [0.03, 0.31, -0.1], scale: [0.035, 0.035, 0.035], color: "#B71C1C" }
    ]
  }
};

// Category fallback descriptors
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

function getPlantDescriptor(plant) {
  // Tier 1: exact name match
  if (PLANT_MODELS[plant.name]) return PLANT_MODELS[plant.name];
  // Tier 2: category fallback (with flower color override)
  var cat = plant.category || "other";
  var desc = CATEGORY_DEFAULTS[cat] || CATEGORY_DEFAULTS.other;
  // For flowers, override accent color with per-flower color
  if (cat === "flower" && FLOWER_COLORS[plant.name] && desc.accents && desc.accents.length > 0) {
    desc = JSON.parse(JSON.stringify(desc)); // clone to avoid mutation
    desc.accents[0].color = FLOWER_COLORS[plant.name];
  }
  return desc;
}

function buildPlantMesh(plant, style) {
  var desc = getPlantDescriptor(plant);
  var group = new THREE.Group();

  // Stem
  if (desc.stem) {
    group.add(buildShapeMesh(desc.stem, style));
  }
  // Foliage
  if (desc.foliage) {
    for (var i = 0; i < desc.foliage.length; i++) {
      group.add(buildShapeMesh(desc.foliage[i], style));
    }
  }
  // Accents
  if (desc.accents) {
    for (var j = 0; j < desc.accents.length; j++) {
      group.add(buildShapeMesh(desc.accents[j], style));
    }
  }

  // Y-dominant scaling: height varies dramatically, width stays readable
  // Small plants get boosted so they're visible; tall plants stay proportional
  var heightInches = plant.height_inches || 12;
  var ratio = heightInches / 84;
  var yScale = Math.max(0.35, ratio);
  var xzScale = Math.max(0.5, 0.45 + ratio * 0.55);
  group.scale.set(xzScale, yScale, xzScale);
  return group;
}
