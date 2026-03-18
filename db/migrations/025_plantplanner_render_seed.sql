-- PlantPlanner: seed render_params for all 50 plants (Three.js procedural geometry)
-- Each plant uses low segment counts (5-8) for faceted Cubirds-style geometry
-- Shapes: cylinder, sphere, cone, box | positions relative to plant center | heights normalized 0-1

-- ===================== VEGETABLES =====================

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.7,"radiusTop":0.04,"radiusBottom":0.05,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.55,0],"scale":[0.35,0.4,0.35],"color":"#4a9e3a","segments":6},
    {"shape":"sphere","position":[0.1,0.7,0.05],"scale":[0.15,0.15,0.15],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[-0.08,0.5,0.1],"scale":[0.09,0.09,0.09],"color":"#e63946"},
    {"shape":"sphere","position":[0.1,0.45,-0.05],"scale":[0.08,0.08,0.08],"color":"#e63946"},
    {"shape":"sphere","position":[0.0,0.6,0.08],"scale":[0.07,0.07,0.07],"color":"#e63946"}
  ]
}' WHERE name = 'Tomato';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.5,"radiusTop":0.04,"radiusBottom":0.05,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.4,0],"scale":[0.3,0.35,0.3],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"cone","position":[-0.06,0.3,0.08],"scale":[0.05,0.14,0.05],"color":"#e63946","segments":5},
    {"shape":"cone","position":[0.08,0.35,-0.04],"scale":[0.04,0.12,0.04],"color":"#cc2936","segments":5}
  ]
}' WHERE name = 'Pepper';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.12,"radiusTop":0.03,"radiusBottom":0.03,"color":"#8bc48a","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.12,0],"scale":[0.2,0.12,0.2],"color":"#6abf69","segments":6},
    {"shape":"sphere","position":[0.06,0.14,0.04],"scale":[0.15,0.1,0.15],"color":"#7dd87c","segments":6},
    {"shape":"sphere","position":[-0.05,0.13,-0.03],"scale":[0.14,0.09,0.14],"color":"#5cb85c","segments":6}
  ],
  "accents": []
}' WHERE name = 'Lettuce';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.15,"radiusTop":0.02,"radiusBottom":0.02,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.15,0],"scale":[0.15,0.08,0.15],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"cone","position":[0,-0.08,0],"scale":[0.06,0.2,0.06],"color":"#e87f35","segments":6,"rotation":[3.14,0,0]}
  ]
}' WHERE name = 'Carrot';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.3,"radiusTop":0.06,"radiusBottom":0.07,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.25,0],"scale":[0.4,0.25,0.4],"color":"#4a9e3a","segments":6},
    {"shape":"sphere","position":[0.15,0.2,0.1],"scale":[0.2,0.15,0.2],"color":"#5cb85c","segments":6}
  ],
  "accents": [
    {"shape":"cylinder","position":[0.12,0.1,0.05],"scale":[0.06,0.15,0.06],"color":"#5a8a2e","segments":6}
  ]
}' WHERE name = 'Zucchini';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.25,"radiusTop":0.03,"radiusBottom":0.04,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.2,0],"scale":[0.3,0.2,0.3],"color":"#5cb85c","segments":6}
  ],
  "accents": [
    {"shape":"cylinder","position":[0.08,0.1,0.06],"scale":[0.04,0.12,0.04],"color":"#2d6b1e","segments":6}
  ]
}' WHERE name = 'Cucumber';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.35,"radiusTop":0.05,"radiusBottom":0.06,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.35,0],"scale":[0.3,0.2,0.3],"color":"#2d8a3e","segments":6},
    {"shape":"sphere","position":[0.08,0.3,-0.05],"scale":[0.2,0.15,0.2],"color":"#3d9a4e","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0,0.4,0],"scale":[0.12,0.08,0.12],"color":"#4aad5e","segments":5}
  ]
}' WHERE name = 'Broccoli';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.1,"radiusTop":0.02,"radiusBottom":0.02,"color":"#6abf69","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.1,0],"scale":[0.15,0.08,0.15],"color":"#3d9a4e","segments":6},
    {"shape":"sphere","position":[0.04,0.11,0.03],"scale":[0.12,0.06,0.12],"color":"#4aad5e","segments":6}
  ],
  "accents": []
}' WHERE name = 'Spinach';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.35,"radiusTop":0.04,"radiusBottom":0.05,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.3,0],"scale":[0.25,0.2,0.25],"color":"#2d6b3e","segments":6},
    {"shape":"sphere","position":[0.08,0.25,-0.06],"scale":[0.18,0.22,0.18],"color":"#3d8a4e","segments":6},
    {"shape":"sphere","position":[-0.06,0.28,0.05],"scale":[0.16,0.18,0.16],"color":"#4a9e5a","segments":6}
  ],
  "accents": []
}' WHERE name = 'Kale';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.06,"radiusTop":0.02,"radiusBottom":0.02,"color":"#4a9e3a","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.08,0],"scale":[0.1,0.06,0.1],"color":"#5cb85c","segments":5}
  ],
  "accents": [
    {"shape":"sphere","position":[0,-0.03,0],"scale":[0.08,0.1,0.08],"color":"#d63447","segments":6}
  ]
}' WHERE name = 'Radish';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.3,"radiusTop":0.03,"radiusBottom":0.04,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.25,0],"scale":[0.2,0.18,0.2],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"box","position":[0.06,0.15,0.04],"scale":[0.04,0.06,0.03],"color":"#7a5c3a"},
    {"shape":"box","position":[-0.04,0.18,-0.05],"scale":[0.04,0.06,0.03],"color":"#8a6c4a"}
  ]
}' WHERE name = 'Bean (Bush)';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.9,"radiusTop":0.03,"radiusBottom":0.04,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.7,0],"scale":[0.2,0.25,0.2],"color":"#4a9e3a","segments":6},
    {"shape":"sphere","position":[0.05,0.5,0.03],"scale":[0.15,0.15,0.15],"color":"#5cb85c","segments":6}
  ],
  "accents": [
    {"shape":"box","position":[0.08,0.4,0.04],"scale":[0.04,0.08,0.03],"color":"#7a5c3a"},
    {"shape":"box","position":[-0.06,0.6,-0.03],"scale":[0.04,0.08,0.03],"color":"#8a6c4a"}
  ]
}' WHERE name = 'Bean (Pole)';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.65,"radiusTop":0.02,"radiusBottom":0.03,"color":"#5cb85c","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.5,0],"scale":[0.18,0.2,0.18],"color":"#4a9e3a","segments":6},
    {"shape":"sphere","position":[0.06,0.4,0.04],"scale":[0.12,0.12,0.12],"color":"#5cb85c","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0.04,0.35,0.02],"scale":[0.04,0.05,0.04],"color":"#8bc48a"}
  ]
}' WHERE name = 'Pea';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.25,"radiusTop":0.02,"radiusBottom":0.06,"color":"#5cb85c","segments":6},
  "foliage": [
    {"shape":"cone","position":[0,0.25,0],"scale":[0.08,0.35,0.08],"color":"#4a9e3a","segments":6}
  ],
  "accents": []
}' WHERE name = 'Onion';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.25,"radiusTop":0.015,"radiusBottom":0.05,"color":"#8bc48a","segments":6},
  "foliage": [
    {"shape":"cone","position":[0,0.25,0],"scale":[0.06,0.3,0.06],"color":"#5cb85c","segments":6}
  ],
  "accents": []
}' WHERE name = 'Garlic';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.35,"radiusTop":0.04,"radiusBottom":0.05,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.3,0],"scale":[0.25,0.2,0.25],"color":"#4a9e3a","segments":6},
    {"shape":"sphere","position":[0.1,0.25,0.06],"scale":[0.18,0.15,0.18],"color":"#5cb85c","segments":6}
  ],
  "accents": []
}' WHERE name = 'Potato';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.25,"radiusTop":0.04,"radiusBottom":0.05,"color":"#5cb85c","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.2,0],"scale":[0.3,0.15,0.3],"color":"#4a9e3a","segments":6},
    {"shape":"sphere","position":[0.12,0.15,0.08],"scale":[0.2,0.1,0.2],"color":"#6abf69","segments":6}
  ],
  "accents": []
}' WHERE name = 'Sweet Potato';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":1.0,"radiusTop":0.04,"radiusBottom":0.06,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"cone","position":[-0.12,0.6,0],"scale":[0.12,0.4,0.08],"color":"#4a9e3a","segments":5},
    {"shape":"cone","position":[0.12,0.5,0],"scale":[0.1,0.35,0.07],"color":"#5cb85c","segments":5}
  ],
  "accents": [
    {"shape":"cone","position":[0,0.85,0],"scale":[0.08,0.2,0.08],"color":"#f0c040","segments":6}
  ]
}' WHERE name = 'Corn';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.55,"radiusTop":0.04,"radiusBottom":0.05,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.45,0],"scale":[0.3,0.3,0.3],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0.05,0.3,0.08],"scale":[0.1,0.12,0.08],"color":"#5b2c8a"},
    {"shape":"sphere","position":[-0.08,0.35,-0.04],"scale":[0.08,0.1,0.07],"color":"#6b3c9a"}
  ]
}' WHERE name = 'Eggplant';

-- ===================== HERBS =====================

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.25,"radiusTop":0.03,"radiusBottom":0.03,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.22,0],"scale":[0.2,0.15,0.2],"color":"#2d8a2e","segments":6},
    {"shape":"sphere","position":[0.06,0.18,0.04],"scale":[0.12,0.1,0.12],"color":"#3d9a3e","segments":6},
    {"shape":"sphere","position":[-0.05,0.2,-0.03],"scale":[0.1,0.08,0.1],"color":"#4aad4e","segments":6}
  ],
  "accents": []
}' WHERE name = 'Basil';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.18,"radiusTop":0.02,"radiusBottom":0.02,"color":"#5cb85c","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.16,0],"scale":[0.15,0.1,0.15],"color":"#4a9e3a","segments":6},
    {"shape":"sphere","position":[0.05,0.14,0.03],"scale":[0.1,0.08,0.1],"color":"#6abf69","segments":6}
  ],
  "accents": []
}' WHERE name = 'Cilantro';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.18,"radiusTop":0.02,"radiusBottom":0.02,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.16,0],"scale":[0.16,0.1,0.16],"color":"#3d9a3e","segments":6},
    {"shape":"sphere","position":[0.04,0.14,0.04],"scale":[0.12,0.08,0.12],"color":"#4aad4e","segments":6}
  ],
  "accents": []
}' WHERE name = 'Parsley';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.5,"radiusTop":0.04,"radiusBottom":0.05,"color":"#6b4e2a","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.4,0],"scale":[0.25,0.25,0.25],"color":"#2d6b3e","segments":6},
    {"shape":"sphere","position":[0.1,0.35,0.06],"scale":[0.15,0.18,0.15],"color":"#3d7a4e","segments":6},
    {"shape":"sphere","position":[-0.08,0.38,-0.04],"scale":[0.12,0.15,0.12],"color":"#4a8a5e","segments":6}
  ],
  "accents": []
}' WHERE name = 'Rosemary';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.1,"radiusTop":0.02,"radiusBottom":0.03,"color":"#6b4e2a","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.1,0],"scale":[0.18,0.08,0.18],"color":"#3d7a2e","segments":6},
    {"shape":"sphere","position":[0.06,0.09,0.04],"scale":[0.12,0.06,0.12],"color":"#4a8a3e","segments":6}
  ],
  "accents": []
}' WHERE name = 'Thyme';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.25,"radiusTop":0.03,"radiusBottom":0.04,"color":"#5cb85c","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.22,0],"scale":[0.25,0.15,0.25],"color":"#2d9a3e","segments":6},
    {"shape":"sphere","position":[0.08,0.18,0.06],"scale":[0.18,0.12,0.18],"color":"#3daa4e","segments":6},
    {"shape":"sphere","position":[-0.06,0.2,-0.04],"scale":[0.15,0.1,0.15],"color":"#4aba5e","segments":6}
  ],
  "accents": []
}' WHERE name = 'Mint';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.5,"radiusTop":0.02,"radiusBottom":0.03,"color":"#5cb85c","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.4,0],"scale":[0.2,0.15,0.2],"color":"#4a9e3a","segments":6},
    {"shape":"sphere","position":[0,0.5,0],"scale":[0.12,0.06,0.12],"color":"#e8d44d","segments":5}
  ],
  "accents": []
}' WHERE name = 'Dill';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.16,"radiusTop":0.02,"radiusBottom":0.02,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.14,0],"scale":[0.14,0.1,0.14],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0,0.18,0],"scale":[0.06,0.06,0.06],"color":"#9b59b6","segments":5}
  ]
}' WHERE name = 'Chives';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.16,"radiusTop":0.03,"radiusBottom":0.04,"color":"#6b4e2a","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.14,0],"scale":[0.2,0.1,0.2],"color":"#3d7a2e","segments":6},
    {"shape":"sphere","position":[0.06,0.12,0.04],"scale":[0.14,0.08,0.14],"color":"#4a8a3e","segments":6}
  ],
  "accents": []
}' WHERE name = 'Oregano';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.35,"radiusTop":0.04,"radiusBottom":0.05,"color":"#6b4e2a","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.3,0],"scale":[0.22,0.18,0.22],"color":"#8a9e7a","segments":6},
    {"shape":"sphere","position":[0.08,0.25,0.05],"scale":[0.15,0.12,0.15],"color":"#9aae8a","segments":6}
  ],
  "accents": []
}' WHERE name = 'Sage';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.35,"radiusTop":0.03,"radiusBottom":0.04,"color":"#6b4e2a","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.25,0],"scale":[0.2,0.18,0.2],"color":"#5a7a5e","segments":6}
  ],
  "accents": [
    {"shape":"cone","position":[0,0.38,0],"scale":[0.06,0.12,0.06],"color":"#9b59b6","segments":5},
    {"shape":"cone","position":[0.06,0.35,0.04],"scale":[0.05,0.1,0.05],"color":"#8e44ad","segments":5}
  ]
}' WHERE name = 'Lavender';

-- ===================== FLOWERS =====================

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.9,"radiusTop":0.04,"radiusBottom":0.05,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"cone","position":[-0.1,0.5,0],"scale":[0.1,0.3,0.06],"color":"#4a9e3a","segments":5},
    {"shape":"cone","position":[0.1,0.4,0],"scale":[0.08,0.25,0.05],"color":"#5cb85c","segments":5}
  ],
  "accents": [
    {"shape":"sphere","position":[0,0.9,0],"scale":[0.2,0.06,0.2],"color":"#f0c040","segments":8},
    {"shape":"sphere","position":[0,0.88,0],"scale":[0.1,0.06,0.1],"color":"#6b4e2a","segments":6}
  ]
}' WHERE name = 'Sunflower';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.18,"radiusTop":0.02,"radiusBottom":0.03,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.14,0],"scale":[0.15,0.1,0.15],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0,0.2,0],"scale":[0.1,0.06,0.1],"color":"#f0a030","segments":6},
    {"shape":"sphere","position":[0.04,0.19,0.03],"scale":[0.08,0.05,0.08],"color":"#e8901d","segments":6}
  ]
}' WHERE name = 'Marigold';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.45,"radiusTop":0.03,"radiusBottom":0.03,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.35,0],"scale":[0.15,0.12,0.15],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0,0.45,0],"scale":[0.12,0.08,0.12],"color":"#e84393","segments":6},
    {"shape":"sphere","position":[0,0.44,0],"scale":[0.06,0.04,0.06],"color":"#fd79a8","segments":5}
  ]
}' WHERE name = 'Zinnia';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.12,"radiusTop":0.02,"radiusBottom":0.03,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.1,0],"scale":[0.18,0.08,0.18],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"cone","position":[0,0.14,0],"scale":[0.1,0.06,0.1],"color":"#e84393","segments":5},
    {"shape":"cone","position":[0.05,0.13,0.03],"scale":[0.08,0.05,0.08],"color":"#fd79a8","segments":5}
  ]
}' WHERE name = 'Petunia';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.65,"radiusTop":0.02,"radiusBottom":0.03,"color":"#5cb85c","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.5,0],"scale":[0.15,0.12,0.15],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0,0.6,0],"scale":[0.1,0.05,0.1],"color":"#fd79a8","segments":6},
    {"shape":"sphere","position":[0.05,0.58,0.03],"scale":[0.04,0.03,0.04],"color":"#e84393","segments":5}
  ]
}' WHERE name = 'Cosmos';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.15,"radiusTop":0.03,"radiusBottom":0.04,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.12,0],"scale":[0.2,0.1,0.2],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0,0.16,0],"scale":[0.08,0.05,0.08],"color":"#e87830","segments":6},
    {"shape":"sphere","position":[0.05,0.15,0.04],"scale":[0.06,0.04,0.06],"color":"#d06828","segments":5}
  ]
}' WHERE name = 'Nasturtium';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.65,"radiusTop":0.04,"radiusBottom":0.05,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.5,0],"scale":[0.2,0.15,0.2],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0,0.62,0],"scale":[0.15,0.1,0.15],"color":"#e84393","segments":7},
    {"shape":"sphere","position":[0,0.6,0],"scale":[0.12,0.08,0.12],"color":"#d63384","segments":6},
    {"shape":"sphere","position":[0,0.58,0],"scale":[0.08,0.06,0.08],"color":"#c0246e","segments":5}
  ]
}' WHERE name = 'Dahlia';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.1,"radiusTop":0.02,"radiusBottom":0.02,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.08,0],"scale":[0.1,0.06,0.1],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0,0.12,0],"scale":[0.08,0.05,0.08],"color":"#9b59b6","segments":6},
    {"shape":"sphere","position":[0,0.11,0],"scale":[0.04,0.03,0.04],"color":"#f0c040","segments":5}
  ]
}' WHERE name = 'Pansy';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.15,"radiusTop":0.03,"radiusBottom":0.03,"color":"#5cb85c","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.12,0],"scale":[0.18,0.1,0.18],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0,0.16,0],"scale":[0.08,0.05,0.08],"color":"#e84393","segments":6},
    {"shape":"sphere","position":[0.04,0.15,0.03],"scale":[0.06,0.04,0.06],"color":"#fd79a8","segments":5},
    {"shape":"sphere","position":[-0.03,0.15,-0.02],"scale":[0.06,0.04,0.06],"color":"#e84393","segments":5}
  ]
}' WHERE name = 'Impatiens';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.15,"radiusTop":0.04,"radiusBottom":0.05,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.2,0],"scale":[0.3,0.15,0.3],"color":"#3d8a3e","segments":6},
    {"shape":"sphere","position":[0.1,0.18,0.06],"scale":[0.2,0.12,0.2],"color":"#4a9e4a","segments":6},
    {"shape":"sphere","position":[-0.08,0.19,-0.05],"scale":[0.22,0.13,0.22],"color":"#2d7a2e","segments":6}
  ],
  "accents": []
}' WHERE name = 'Hosta';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.45,"radiusTop":0.03,"radiusBottom":0.03,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.3,0],"scale":[0.12,0.1,0.12],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"cone","position":[0,0.42,0],"scale":[0.06,0.12,0.06],"color":"#e84393","segments":5},
    {"shape":"cone","position":[0,0.38,0],"scale":[0.05,0.08,0.05],"color":"#d63384","segments":5},
    {"shape":"cone","position":[0,0.34,0],"scale":[0.05,0.06,0.05],"color":"#fd79a8","segments":5}
  ]
}' WHERE name = 'Snapdragon';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.45,"radiusTop":0.03,"radiusBottom":0.03,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.35,0],"scale":[0.15,0.12,0.15],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0,0.45,0],"scale":[0.12,0.05,0.12],"color":"#f0c040","segments":7},
    {"shape":"sphere","position":[0,0.43,0],"scale":[0.06,0.05,0.06],"color":"#6b4e2a","segments":6}
  ]
}' WHERE name = 'Black-Eyed Susan';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.5,"radiusTop":0.03,"radiusBottom":0.03,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.4,0],"scale":[0.15,0.12,0.15],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0,0.5,0],"scale":[0.12,0.06,0.12],"color":"#9b59b6","segments":7},
    {"shape":"cone","position":[0,0.48,0],"scale":[0.06,0.08,0.06],"color":"#6b4e2a","segments":5}
  ]
}' WHERE name = 'Coneflower';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.25,"radiusTop":0.03,"radiusBottom":0.04,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.2,0],"scale":[0.2,0.12,0.2],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0,0.25,0],"scale":[0.1,0.06,0.1],"color":"#e63946","segments":6},
    {"shape":"sphere","position":[0.04,0.24,0.03],"scale":[0.08,0.05,0.08],"color":"#d62836","segments":5}
  ]
}' WHERE name = 'Geranium';

-- ===================== FRUITS =====================

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.08,"radiusTop":0.02,"radiusBottom":0.03,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.08,0],"scale":[0.2,0.06,0.2],"color":"#4a9e3a","segments":6},
    {"shape":"sphere","position":[0.06,0.07,0.04],"scale":[0.12,0.05,0.12],"color":"#5cb85c","segments":6}
  ],
  "accents": [
    {"shape":"cone","position":[0.08,0.06,0.02],"scale":[0.04,0.06,0.04],"color":"#e63946","segments":5},
    {"shape":"cone","position":[-0.06,0.06,-0.04],"scale":[0.04,0.05,0.04],"color":"#e63946","segments":5}
  ]
}' WHERE name = 'Strawberry';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.6,"radiusTop":0.04,"radiusBottom":0.05,"color":"#6b4e2a","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.5,0],"scale":[0.3,0.3,0.3],"color":"#3d7a2e","segments":6},
    {"shape":"sphere","position":[0.1,0.4,0.06],"scale":[0.2,0.2,0.2],"color":"#4a8a3e","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0.08,0.35,0.08],"scale":[0.04,0.04,0.04],"color":"#2d3a8a"},
    {"shape":"sphere","position":[-0.06,0.4,-0.04],"scale":[0.04,0.04,0.04],"color":"#3d4a9a"},
    {"shape":"sphere","position":[0.04,0.45,0.06],"scale":[0.03,0.03,0.03],"color":"#2d3a8a"}
  ]
}' WHERE name = 'Blueberry';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.75,"radiusTop":0.03,"radiusBottom":0.04,"color":"#6b4e2a","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.6,0],"scale":[0.25,0.25,0.25],"color":"#4a9e3a","segments":6},
    {"shape":"sphere","position":[0.08,0.5,0.05],"scale":[0.18,0.18,0.18],"color":"#5cb85c","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0.1,0.45,0.06],"scale":[0.04,0.04,0.04],"color":"#c0246e"},
    {"shape":"sphere","position":[-0.05,0.5,-0.03],"scale":[0.04,0.04,0.04],"color":"#d63384"}
  ]
}' WHERE name = 'Raspberry';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.2,"radiusTop":0.04,"radiusBottom":0.05,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.15,0],"scale":[0.3,0.12,0.3],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0.1,0.05,0.08],"scale":[0.15,0.12,0.12],"color":"#4a8a2e"},
    {"shape":"sphere","position":[0.1,0.05,0.08],"scale":[0.14,0.11,0.11],"color":"#2d6b1e"}
  ]
}' WHERE name = 'Watermelon';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.3,"radiusTop":0.05,"radiusBottom":0.06,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.25,0],"scale":[0.3,0.15,0.3],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0.08,0.08,0.06],"scale":[0.15,0.12,0.15],"color":"#e8901d"},
    {"shape":"sphere","position":[0.08,0.08,0.06],"scale":[0.12,0.1,0.12],"color":"#d07010"}
  ]
}' WHERE name = 'Pumpkin';

UPDATE plantplanner_plants SET render_params = '{
  "stem": {"shape":"cylinder","height":0.2,"radiusTop":0.04,"radiusBottom":0.05,"color":"#3d7a2e","segments":6},
  "foliage": [
    {"shape":"sphere","position":[0,0.15,0],"scale":[0.25,0.1,0.25],"color":"#4a9e3a","segments":6}
  ],
  "accents": [
    {"shape":"sphere","position":[0.08,0.05,0.06],"scale":[0.12,0.1,0.1],"color":"#e8c44d"},
    {"shape":"sphere","position":[0.08,0.05,0.06],"scale":[0.1,0.08,0.08],"color":"#d0a030"}
  ]
}' WHERE name = 'Cantaloupe';
