"""Fixed value sets for the person (personal page) API."""

from enum import StrEnum


class TripStatus(StrEnum):
    """Where a trip is in its life.

    Mirrors the CHECK constraint on person_trips.status
    (db/migrations/person/006_trip_status.sql). Drives the about-page card
    treatment and the trip page's default stop order — see
    landing/about-travel.js and landing/trip-stops.js.
    """

    UPCOMING = "upcoming"  # announced, not started — greyed-out card, not clickable
    LIVE = "live"          # happening now — live bubble, stops default newest-first
    COMPLETE = "complete"  # over — plain card, stops default 01-first


class TripTheme(StrEnum):
    """Which colour preset a trip wears.

    These are SLUGS, not colours. The four palettes are defined once, as
    [data-trip-theme="…"] custom-property blocks in landing/person-travel.css —
    the only stylesheet both the about page and the trip page load. Keeping the
    hex out of the database is what lets a palette be retuned without a data
    migration; it also mirrors the CHECK constraint in
    db/migrations/person/007_trip_theme.sql.
    """

    ENAMEL = "enamel"          # deep blue + gold — the section's original look
    TERRACOTTA = "terracotta"  # warm clay + sand
    PINE = "pine"              # forest green + brass
    PLUM = "plum"              # dusk aubergine + blush
