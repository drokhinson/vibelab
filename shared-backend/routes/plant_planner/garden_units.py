"""Per-garden-type unit semantics. Single source of truth for the storage
invariant declared in migration 012:

    grid_width / grid_height store INCHES when garden_type is one of
    {indoor_pot, indoor_planter_box, outdoor_pot, outdoor_planter_box}
    and FEET otherwise. pos_x / pos_y / radius_feet are ALWAYS feet.

The frontend mirrors these sets in `web/garden-units.js`. Keep the two in
lockstep when adding a new garden_type.
"""

from typing import Optional

# Pots and planter boxes (indoor + outdoor) hold dimensions in inches —
# they're typically 8–48" objects measured by retailers in inches. Beds and
# greenhouses are structures measured in feet.
INCH_UNIT_TYPES = frozenset({
    "indoor_pot",
    "indoor_planter_box",
    "outdoor_pot",
    "outdoor_planter_box",
})

# Climate-controlled types skip the Location step in the wizard and default
# to indoor=True for catalog filtering. Outdoor pots are NOT in this set —
# they sit on a balcony in the user's actual hardiness zone.
CLIMATE_CONTROLLED_TYPES = frozenset({
    "indoor_pot",
    "indoor_planter_box",
    "greenhouse",
})


def garden_uses_inches(garden_type: Optional[str]) -> bool:
    return (garden_type or "") in INCH_UNIT_TYPES


def garden_is_climate_controlled(garden_type: Optional[str]) -> bool:
    return (garden_type or "") in CLIMATE_CONTROLLED_TYPES


def grid_dim_to_feet(value: Optional[int], garden_type: Optional[str]) -> Optional[float]:
    """Normalize a stored grid_width/grid_height int to feet for any garden_type."""
    if value is None:
        return None
    if garden_uses_inches(garden_type):
        return value / 12.0
    return float(value)
