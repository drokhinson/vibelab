---
paths:
  - "shared-backend/routes/**"
  - "projects/*/web/**"
---

# Performance — Data Flow & Query Optimization

When working on an existing project, proactively review the data flow from the database through the API to the frontend. The goal is to eliminate unnecessary round-trips, reduce query count, and ensure the UI never blocks on data it already has.

**General rules:**
- Prefer fetching related data in one query over multiple sequential queries (use Supabase foreign key expansion or RPCs).
- Count or aggregate in the database (SQL), not in Python loops — Python-side aggregation over large result sets does not scale.
- Avoid N+1 patterns: never fetch a list of IDs then loop to fetch details one-by-one.
- For endpoints called on every page load or group switch, profile the number of DB round-trips and reduce to the minimum needed.

**Frontend caching:**
- Repeated fetches for data that doesn't change mid-session (today's word, leaderboard, yesterday's sentences) should be cached client-side with a TTL.
- Cache pattern: `cache.js` with a `dwpCache`-style object — `get(type, key)`, `set(type, key, data)`, `clear()`. Default TTL: 10 minutes.
- Bulk-load data for all groups in parallel on login/first visit rather than fetching one group at a time.
- On tab/group switch: serve from cache immediately, then optionally fire a lightweight refresh in the background for fields that change frequently (e.g. vote counts).
- Invalidate cache selectively after mutations (e.g. after submitting a sentence, invalidate today's cache for that group only).

**Check in with the user before implementing caching or bulk queries.**
These are architectural decisions that affect perceived freshness, complexity, and server load. Before writing code:
1. Describe the current data flow and where the bottleneck is.
2. Propose the caching or batching strategy (TTL, invalidation rules, new endpoints needed).
3. **Ask the user to confirm the approach** before proceeding — they may have context about acceptable staleness, server costs, or edge cases that change the design.
