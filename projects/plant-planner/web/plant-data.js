// plant-data.js — Model templates and per-plant 3D geometry descriptors
// Shared geometry templates let multiple plants reuse the same shape with different colors.
// Per-plant entries reference a template via _template and supply color overrides.

var MODEL_TEMPLATES = {
  // Sunflower: tall stem, small leaf pairs, large flower head + center
  sunflower: {
    stem: { shape: "cylinder", height: 0.7, radius: 0.05 },
    foliage: [
      { shape: "sphere", position: [0, 0.55, 0], scale: [0.12, 0.04, 0.12] },
      { shape: "sphere", position: [0, 0.35, 0], scale: [0.10, 0.03, 0.10] }
    ],
    accents: [
      { shape: "sphere", position: [0, 0.75, 0], scale: [0.28, 0.06, 0.28] },
      { shape: "sphere", position: [0, 0.76, 0], scale: [0.12, 0.05, 0.12] }
    ]
  },
  // Corn: tall stalk, blade-like leaves, tassel top
  corn: {
    stem: { shape: "cylinder", height: 0.75, radius: 0.04 },
    foliage: [
      { shape: "box", position: [0.12, 0.45, 0], scale: [0.22, 0.02, 0.06], rotation: [0, 0, -0.4] },
      { shape: "box", position: [-0.12, 0.35, 0], scale: [0.22, 0.02, 0.06], rotation: [0, 0, 0.4] },
      { shape: "box", position: [0, 0.55, 0.12], scale: [0.06, 0.02, 0.22], rotation: [0.4, 0, 0] }
    ],
    accents: [
      { shape: "cone", position: [0, 0.82, 0], scale: [0.04, 0.1, 0.04] }
    ]
  },
  // Tomato/Pepper-type: medium stem, bushy foliage, small fruit accents
  bush_fruit: {
    stem: { shape: "cylinder", height: 0.45, radius: 0.04 },
    foliage: [
      { shape: "sphere", position: [0, 0.45, 0], scale: [0.25, 0.22, 0.25] },
      { shape: "sphere", position: [0.08, 0.5, 0.06], scale: [0.15, 0.14, 0.15] }
    ],
    accents: [
      { shape: "sphere", position: [0.12, 0.38, 0.1], scale: [0.06, 0.06, 0.06] },
      { shape: "sphere", position: [-0.08, 0.42, -0.06], scale: [0.055, 0.055, 0.055] },
      { shape: "sphere", position: [0.02, 0.35, 0.14], scale: [0.05, 0.05, 0.05] }
    ]
  },
  // Pepper: slightly smaller bush with hanging fruit
  pepper: {
    stem: { shape: "cylinder", height: 0.4, radius: 0.035 },
    foliage: [
      { shape: "sphere", position: [0, 0.42, 0], scale: [0.22, 0.2, 0.22] }
    ],
    accents: [
      { shape: "box", position: [0.1, 0.3, 0.05], scale: [0.04, 0.08, 0.04] },
      { shape: "box", position: [-0.06, 0.32, -0.08], scale: [0.035, 0.07, 0.035] }
    ]
  },
  // Root veggie: short above-ground, feathery top, root below
  root_veggie: {
    stem: { shape: "cylinder", height: 0.08, radius: 0.02 },
    foliage: [
      { shape: "cone", position: [0, 0.22, 0], scale: [0.18, 0.18, 0.18] },
      { shape: "cone", position: [0.04, 0.26, 0.03], scale: [0.12, 0.14, 0.12] }
    ],
    accents: [
      { shape: "cone", position: [0, -0.04, 0], scale: [0.05, 0.14, 0.05], rotation: [Math.PI, 0, 0] }
    ]
  },
  // Small root (radish-like): tiny top, round root
  small_root: {
    stem: { shape: "cylinder", height: 0.06, radius: 0.015 },
    foliage: [
      { shape: "sphere", position: [0, 0.14, 0], scale: [0.16, 0.1, 0.16] }
    ],
    accents: [
      { shape: "sphere", position: [0, -0.02, 0], scale: [0.07, 0.09, 0.07] }
    ]
  },
  // Leafy green: low mounded foliage clusters
  leafy_green: {
    stem: { shape: "cylinder", height: 0.1, radius: 0.025 },
    foliage: [
      { shape: "sphere", position: [0, 0.12, 0], scale: [0.2, 0.12, 0.2] },
      { shape: "sphere", position: [0.06, 0.14, 0.04], scale: [0.15, 0.1, 0.15] },
      { shape: "sphere", position: [-0.05, 0.13, -0.03], scale: [0.14, 0.09, 0.14] }
    ],
    accents: []
  },
  // Bush herb: medium rounded herb bush
  bush_herb: {
    stem: { shape: "cylinder", height: 0.25, radius: 0.025 },
    foliage: [
      { shape: "sphere", position: [0, 0.32, 0], scale: [0.18, 0.14, 0.18] },
      { shape: "sphere", position: [0.06, 0.28, 0.04], scale: [0.12, 0.1, 0.12] },
      { shape: "sphere", position: [-0.05, 0.26, -0.03], scale: [0.1, 0.09, 0.1] }
    ],
    accents: []
  },
  // Woody herb: short woody stem, compact foliage (rosemary, sage)
  woody_herb: {
    stem: { shape: "cylinder", height: 0.3, radius: 0.03 },
    foliage: [
      { shape: "cone", position: [0, 0.4, 0], scale: [0.12, 0.25, 0.12] },
      { shape: "cone", position: [0.07, 0.35, 0.04], scale: [0.08, 0.2, 0.08] },
      { shape: "cone", position: [-0.05, 0.33, -0.05], scale: [0.07, 0.18, 0.07] }
    ],
    accents: []
  },
  // Low woody herb: very short woody stem (thyme-like)
  low_woody: {
    stem: { shape: "cylinder", height: 0.1, radius: 0.025 },
    foliage: [
      { shape: "sphere", position: [0, 0.1, 0], scale: [0.18, 0.08, 0.18] },
      { shape: "sphere", position: [0.06, 0.09, 0.04], scale: [0.12, 0.06, 0.12] }
    ],
    accents: []
  },
  // Lavender: multi-stem with cone flower spikes
  lavender: {
    stem: { shape: "cylinder", height: 0.3, radius: 0.015 },
    foliage: [
      { shape: "cylinder", height: 0.25, radius: 0.012, position: [0.06, 0.12, 0.03] },
      { shape: "cylinder", height: 0.22, radius: 0.012, position: [-0.05, 0.11, -0.04] },
      { shape: "cylinder", height: 0.2, radius: 0.012, position: [0.02, 0.1, -0.06] }
    ],
    accents: [
      { shape: "cone", position: [0, 0.48, 0], scale: [0.04, 0.1, 0.04] },
      { shape: "cone", position: [0.06, 0.42, 0.03], scale: [0.035, 0.08, 0.035] },
      { shape: "cone", position: [-0.05, 0.4, -0.04], scale: [0.035, 0.08, 0.035] },
      { shape: "cone", position: [0.02, 0.38, -0.06], scale: [0.03, 0.07, 0.03] }
    ]
  },
  // Allium: upright narrow cone leaves (onion, garlic, chives)
  allium: {
    stem: { shape: "cylinder", height: 0.2, radius: 0.02 },
    foliage: [
      { shape: "cone", position: [0, 0.25, 0], scale: [0.08, 0.35, 0.08] }
    ],
    accents: []
  },
  // Vine crop: spreading foliage + visible fruit
  vine_crop: {
    stem: { shape: "cylinder", height: 0.06, radius: 0.02 },
    foliage: [
      { shape: "sphere", position: [0, 0.08, 0], scale: [0.25, 0.05, 0.25] },
      { shape: "sphere", position: [-0.12, 0.06, 0.08], scale: [0.12, 0.04, 0.1] }
    ],
    accents: [
      { shape: "sphere", position: [0.08, 0.04, 0.06], scale: [0.14, 0.1, 0.1] }
    ]
  },
  // Bush crop: medium bush with optional accents (potato, eggplant, broccoli)
  bush_crop: {
    stem: { shape: "cylinder", height: 0.35, radius: 0.04 },
    foliage: [
      { shape: "sphere", position: [0, 0.35, 0], scale: [0.25, 0.2, 0.25] },
      { shape: "sphere", position: [0.08, 0.3, -0.05], scale: [0.18, 0.15, 0.18] }
    ],
    accents: [
      { shape: "sphere", position: [0, 0.42, 0], scale: [0.12, 0.08, 0.12] }
    ]
  },
  // Climbing plant: tall thin stem + leaf clusters
  climbing: {
    stem: { shape: "cylinder", height: 0.65, radius: 0.025 },
    foliage: [
      { shape: "sphere", position: [0, 0.5, 0], scale: [0.18, 0.2, 0.18] },
      { shape: "sphere", position: [0.06, 0.35, 0.04], scale: [0.12, 0.12, 0.12] }
    ],
    accents: [
      { shape: "box", position: [0.06, 0.25, 0.04], scale: [0.04, 0.06, 0.03] },
      { shape: "box", position: [-0.04, 0.4, -0.05], scale: [0.04, 0.06, 0.03] }
    ]
  },
  // Bush bean: shorter climbing
  bush_bean: {
    stem: { shape: "cylinder", height: 0.3, radius: 0.03 },
    foliage: [
      { shape: "sphere", position: [0, 0.25, 0], scale: [0.2, 0.18, 0.2] }
    ],
    accents: [
      { shape: "box", position: [0.06, 0.15, 0.04], scale: [0.04, 0.06, 0.03] },
      { shape: "box", position: [-0.04, 0.18, -0.05], scale: [0.04, 0.06, 0.03] }
    ]
  },
  // Berry bush: woody stem + full bush + small berry accents
  berry_bush: {
    stem: { shape: "cylinder", height: 0.35, radius: 0.04 },
    foliage: [
      { shape: "sphere", position: [0, 0.4, 0], scale: [0.22, 0.2, 0.22] },
      { shape: "sphere", position: [0.08, 0.45, 0.06], scale: [0.14, 0.13, 0.14] }
    ],
    accents: [
      { shape: "sphere", position: [0.1, 0.32, 0.08], scale: [0.035, 0.035, 0.035] },
      { shape: "sphere", position: [-0.06, 0.35, -0.09], scale: [0.03, 0.03, 0.03] },
      { shape: "sphere", position: [0.04, 0.3, -0.1], scale: [0.035, 0.035, 0.035] }
    ]
  },
  // Strawberry: ground-hugging with small fruits
  strawberry: {
    stem: { shape: "cylinder", height: 0.05, radius: 0.02 },
    foliage: [
      { shape: "sphere", position: [0, 0.08, 0], scale: [0.2, 0.08, 0.2] },
      { shape: "sphere", position: [0.08, 0.07, 0.06], scale: [0.12, 0.06, 0.12] }
    ],
    accents: [
      { shape: "sphere", position: [0.1, 0.04, 0.08], scale: [0.04, 0.035, 0.03] },
      { shape: "sphere", position: [-0.06, 0.04, 0.1], scale: [0.035, 0.03, 0.025] },
      { shape: "sphere", position: [0.04, 0.03, -0.09], scale: [0.04, 0.035, 0.03] }
    ]
  },
  // Pumpkin/melon: spreading vine + large round fruit
  pumpkin: {
    stem: { shape: "cylinder", height: 0.06, radius: 0.02 },
    foliage: [
      { shape: "sphere", position: [0, 0.1, 0], scale: [0.25, 0.06, 0.25] }
    ],
    accents: [
      { shape: "sphere", position: [0.06, 0.05, 0.04], scale: [0.12, 0.09, 0.12] },
      { shape: "cylinder", position: [0.06, 0.11, 0.04], scale: [0.02, 0.04, 0.02] }
    ]
  },
  // Tall flower: tall stem + bloom head
  tall_flower: {
    stem: { shape: "cylinder", height: 0.55, radius: 0.025 },
    foliage: [
      { shape: "sphere", position: [0, 0.35, 0], scale: [0.12, 0.08, 0.12] }
    ],
    accents: [
      { shape: "sphere", position: [0, 0.58, 0], scale: [0.14, 0.1, 0.14] },
      { shape: "sphere", position: [0, 0.56, 0], scale: [0.06, 0.04, 0.06] }
    ]
  },
  // Low flower: short + bloom cluster
  low_flower: {
    stem: { shape: "cylinder", height: 0.12, radius: 0.025 },
    foliage: [
      { shape: "sphere", position: [0, 0.1, 0], scale: [0.18, 0.08, 0.18] }
    ],
    accents: [
      { shape: "sphere", position: [0, 0.16, 0], scale: [0.1, 0.06, 0.1] },
      { shape: "sphere", position: [0.04, 0.15, 0.03], scale: [0.08, 0.05, 0.08] }
    ]
  },
  // Daisy-like: medium stem + flat petals + raised center
  daisy_like: {
    stem: { shape: "cylinder", height: 0.45, radius: 0.025 },
    foliage: [
      { shape: "sphere", position: [0, 0.3, 0], scale: [0.12, 0.06, 0.12] }
    ],
    accents: [
      { shape: "sphere", position: [0, 0.48, 0], scale: [0.14, 0.05, 0.14] },
      { shape: "sphere", position: [0, 0.5, 0], scale: [0.06, 0.05, 0.06] }
    ]
  },
  // Snapdragon: vertical flower spikes
  snapdragon: {
    stem: { shape: "cylinder", height: 0.45, radius: 0.025 },
    foliage: [
      { shape: "sphere", position: [0, 0.3, 0], scale: [0.1, 0.08, 0.1] }
    ],
    accents: [
      { shape: "cone", position: [0, 0.45, 0], scale: [0.06, 0.12, 0.06] },
      { shape: "cone", position: [0, 0.38, 0], scale: [0.05, 0.08, 0.05] },
      { shape: "cone", position: [0, 0.32, 0], scale: [0.05, 0.06, 0.05] }
    ]
  },
  // Dahlia: tall stem + layered bloom
  dahlia: {
    stem: { shape: "cylinder", height: 0.55, radius: 0.03 },
    foliage: [
      { shape: "sphere", position: [0, 0.4, 0], scale: [0.15, 0.12, 0.15] }
    ],
    accents: [
      { shape: "sphere", position: [0, 0.58, 0], scale: [0.15, 0.1, 0.15] },
      { shape: "sphere", position: [0, 0.56, 0], scale: [0.12, 0.08, 0.12] },
      { shape: "sphere", position: [0, 0.54, 0], scale: [0.08, 0.06, 0.08] }
    ]
  },
  // Hosta: shade-loving foliage mound
  hosta: {
    stem: { shape: "cylinder", height: 0.04, radius: 0.02 },
    foliage: [
      { shape: "sphere", position: [0, 0.12, 0], scale: [0.25, 0.12, 0.25] },
      { shape: "sphere", position: [0.06, 0.14, 0.04], scale: [0.18, 0.1, 0.18] },
      { shape: "sphere", position: [-0.04, 0.1, -0.05], scale: [0.16, 0.09, 0.16] }
    ],
    accents: []
  },
  // Dill: tall thin stems with feathery umbrella top
  dill: {
    stem: { shape: "cylinder", height: 0.55, radius: 0.02 },
    foliage: [
      { shape: "sphere", position: [0.05, 0.35, 0], scale: [0.06, 0.02, 0.08] },
      { shape: "sphere", position: [-0.05, 0.25, 0.03], scale: [0.05, 0.02, 0.07] }
    ],
    accents: [
      { shape: "sphere", position: [0, 0.6, 0], scale: [0.12, 0.03, 0.12] }
    ]
  },
  // Eggplant: bushy with hanging purple fruit
  eggplant: {
    stem: { shape: "cylinder", height: 0.45, radius: 0.04 },
    foliage: [
      { shape: "sphere", position: [0, 0.45, 0], scale: [0.25, 0.22, 0.25] }
    ],
    accents: [
      { shape: "sphere", position: [0.08, 0.3, 0.06], scale: [0.06, 0.1, 0.06] },
      { shape: "sphere", position: [-0.06, 0.32, -0.05], scale: [0.055, 0.09, 0.055] }
    ]
  }
};

// Per-plant entries: _template + color overrides, or full inline descriptors for unique plants
var PLANT_MODELS = {
  // ── Unique models (kept inline) ──
  "Sunflower":   { _template: "sunflower", colors: { stem: "#4a7c3f", foliage: ["#2E7D32", "#388E3C"], accents: ["#FFD600", "#5D4037"] } },
  "Corn":        { _template: "corn", colors: { stem: "#558B2F", foliage: ["#66BB6A", "#66BB6A", "#66BB6A"], accents: ["#F9A825"] } },
  "Tomato":      { _template: "bush_fruit", colors: { stem: "#4a7c3f", foliage: ["#388E3C", "#43A047"], accents: ["#E53935", "#EF5350", "#C62828"] } },
  "Pepper":      { _template: "pepper", colors: { stem: "#4a7c3f", foliage: ["#388E3C"], accents: ["#F44336", "#4CAF50"] } },
  "Carrot":      { _template: "root_veggie", colors: { stem: "#4a7c3f", foliage: ["#66BB6A", "#81C784"], accents: ["#FF6D00"] } },
  "Radish":      { _template: "small_root", colors: { stem: "#4a7c3f", foliage: ["#66BB6A"], accents: ["#E91E63"] } },
  "Lavender":    { _template: "lavender", colors: { stem: "#6D8764", foliage: ["#6D8764", "#6D8764", "#6D8764"], accents: ["#9C27B0", "#AB47BC", "#AB47BC", "#9C27B0"] } },
  "Strawberry":  { _template: "strawberry", colors: { stem: "#4a7c3f", foliage: ["#388E3C", "#43A047"], accents: ["#E53935", "#C62828", "#EF5350"] } },
  "Watermelon":  { _template: "vine_crop", colors: { stem: "#4a7c3f", foliage: ["#388E3C", "#43A047"], accents: ["#2E7D32"] } },
  "Pumpkin":     { _template: "pumpkin", colors: { stem: "#4a7c3f", foliage: ["#388E3C"], accents: ["#FF6D00", "#4a7c3f"] } },
  "Hosta":       { _template: "hosta", colors: { stem: "#4a7c3f", foliage: ["#4CAF50", "#66BB6A", "#388E3C"], accents: [] } },
  "Basil":       { _template: "bush_herb", colors: { stem: "#4a7c3f", foliage: ["#43A047", "#4CAF50", "#388E3C"], accents: [] } },
  "Rosemary":    { _template: "woody_herb", colors: { stem: "#5D4037", foliage: ["#558B2F", "#689F38", "#558B2F"], accents: [] } },
  "Dill":        { _template: "dill", colors: { stem: "#66BB6A", foliage: ["#81C784", "#81C784"], accents: ["#C0CA33"] } },
  "Blueberry":   { _template: "berry_bush", colors: { stem: "#5D4037", foliage: ["#388E3C", "#43A047"], accents: ["#283593", "#1A237E", "#303F9F"] } },
  "Raspberry":   { _template: "berry_bush", colors: { stem: "#5D4037", foliage: ["#388E3C", "#43A047"], accents: ["#C62828", "#D32F2F", "#B71C1C"] } },

  // ── Vegetables using shared templates ──
  "Lettuce":     { _template: "leafy_green", colors: { stem: "#8bc48a", foliage: ["#6abf69", "#7dd87c", "#5cb85c"], accents: [] } },
  "Spinach":     { _template: "leafy_green", colors: { stem: "#6abf69", foliage: ["#3d9a4e", "#4aad5e", "#2d8a3e"], accents: [] } },
  "Kale":        { _template: "leafy_green", colors: { stem: "#3d7a2e", foliage: ["#2d6b3e", "#3d8a4e", "#4a9e5a"], accents: [] } },
  "Zucchini":    { _template: "vine_crop", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a", "#5cb85c"], accents: ["#5a8a2e"] } },
  "Cucumber":    { _template: "vine_crop", colors: { stem: "#3d7a2e", foliage: ["#5cb85c", "#43A047"], accents: ["#2d6b1e"] } },
  "Broccoli":    { _template: "bush_crop", colors: { stem: "#3d7a2e", foliage: ["#2d8a3e", "#3d9a4e"], accents: ["#4aad5e"] } },
  "Bean (Bush)": { _template: "bush_bean", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a"], accents: ["#7a5c3a", "#8a6c4a"] } },
  "Bean (Pole)": { _template: "climbing", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a", "#5cb85c"], accents: ["#7a5c3a", "#8a6c4a"] } },
  "Pea":         { _template: "climbing", colors: { stem: "#5cb85c", foliage: ["#4a9e3a", "#5cb85c"], accents: ["#8bc48a", "#8bc48a"] } },
  "Onion":       { _template: "allium", colors: { stem: "#5cb85c", foliage: ["#4a9e3a"], accents: [] } },
  "Garlic":      { _template: "allium", colors: { stem: "#8bc48a", foliage: ["#5cb85c"], accents: [] } },
  "Potato":      { _template: "bush_crop", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a", "#5cb85c"], accents: ["#8B6914"] } },
  "Sweet Potato": { _template: "vine_crop", colors: { stem: "#5cb85c", foliage: ["#4a9e3a", "#6abf69"], accents: ["#D2691E"] } },
  "Eggplant":    { _template: "eggplant", colors: { stem: "#3d7a2e", foliage: ["#388E3C"], accents: ["#5b2c8a", "#6b3c9a"] } },

  // ── Herbs using shared templates ──
  "Cilantro":    { _template: "bush_herb", colors: { stem: "#5cb85c", foliage: ["#4a9e3a", "#6abf69", "#5cb85c"], accents: [] } },
  "Parsley":     { _template: "bush_herb", colors: { stem: "#3d7a2e", foliage: ["#3d9a3e", "#4aad4e", "#388E3C"], accents: [] } },
  "Thyme":       { _template: "low_woody", colors: { stem: "#6b4e2a", foliage: ["#3d7a2e", "#4a8a3e"], accents: [] } },
  "Mint":        { _template: "bush_herb", colors: { stem: "#5cb85c", foliage: ["#2d9a3e", "#3daa4e", "#4aba5e"], accents: [] } },
  "Chives":      { _template: "allium", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a"], accents: [] } },
  "Oregano":     { _template: "low_woody", colors: { stem: "#6b4e2a", foliage: ["#3d7a2e", "#4a8a3e"], accents: [] } },
  "Sage":        { _template: "woody_herb", colors: { stem: "#5D4037", foliage: ["#8a9e7a", "#9aae8a", "#7a8e6a"], accents: [] } },

  // ── Flowers using shared templates ──
  "Marigold":       { _template: "low_flower", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a"], accents: ["#FF8F00", "#E88700"] } },
  "Zinnia":         { _template: "tall_flower", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a"], accents: ["#E91E63", "#fd79a8"] } },
  "Petunia":        { _template: "low_flower", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a"], accents: ["#CE93D8", "#E1BEE7"] } },
  "Cosmos":         { _template: "tall_flower", colors: { stem: "#5cb85c", foliage: ["#4a9e3a"], accents: ["#F48FB1", "#E91E63"] } },
  "Nasturtium":     { _template: "low_flower", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a"], accents: ["#FF6D00", "#E65100"] } },
  "Dahlia":         { _template: "dahlia", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a"], accents: ["#AD1457", "#C2185B", "#D81B60"] } },
  "Pansy":          { _template: "low_flower", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a"], accents: ["#7B1FA2", "#FFC107"] } },
  "Impatiens":      { _template: "low_flower", colors: { stem: "#5cb85c", foliage: ["#4a9e3a"], accents: ["#EF5350", "#E57373"] } },
  "Snapdragon":     { _template: "snapdragon", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a"], accents: ["#FF7043", "#FF5722", "#FF8A65"] } },
  "Black-Eyed Susan": { _template: "daisy_like", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a"], accents: ["#FFC107", "#5D4037"] } },
  "Coneflower":     { _template: "daisy_like", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a"], accents: ["#AB47BC", "#5D4037"] } },
  "Geranium":       { _template: "low_flower", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a"], accents: ["#E53935", "#EF5350"] } },

  // ── Fruits using shared templates ──
  "Cantaloupe":  { _template: "vine_crop", colors: { stem: "#3d7a2e", foliage: ["#4a9e3a", "#5cb85c"], accents: ["#E8C44D"] } }
};
