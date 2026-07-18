"""Recognize trail/route sites (Komoot, AllTrails, Strava, …) so their captures
land as hikes.

A page from one of these hosts is a trail/route, not a restaurant or a sight —
but the LLM, working from scraped text, often mislabels it. `is_trail_url`
lets the enrichment pipeline force the resulting place(s) into the ``hike``
category while still geocoding the trailhead the normal way. This is
domain-dispatch config, like ``gmaps._MAPS_HOSTS`` — a fixed set of hostnames,
not product data.
"""

from urllib.parse import urlparse

# Matched against the URL's hostname: a host matches an entry when it equals it
# or is a subdomain of it ("www.alltrails.com" matches "alltrails.com"). The
# suffix must be dot-delimited so "alltrails.com.evil.com" does NOT match.
_TRAIL_HOSTS = (
    "alltrails.com",
    "strava.com",
    "wikiloc.com",
    "outdooractive.com",
    "gaiagps.com",
    "hikingproject.com",
    "ridewithgps.com",
)


def is_trail_url(url: str) -> bool:
    """True for a Komoot/AllTrails/Strava/etc. trail or route link."""
    if not url:
        return False
    host = (urlparse(url.strip()).hostname or "").lower()
    if not host:
        return False
    # Komoot ships one domain per country (komoot.com, komoot.de, komoot.fr…),
    # so match on the registrable label ("komoot" second-to-last) rather than a
    # prefix — that way a subdomain like "komoot.evil.com" is rejected.
    labels = host.split(".")
    if len(labels) >= 2 and labels[-2] == "komoot":
        return True
    return any(host == h or host.endswith("." + h) for h in _TRAIL_HOSTS)
