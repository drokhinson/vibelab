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
