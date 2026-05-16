"""Service layer for BoardgameBuddy.

Each service file owns a single domain concept (feed, buddy graph, sessions,
stats, search, profile). Route files in the parent package are thin adapters
that parse request bodies, call into a service, and return Pydantic models.
"""
