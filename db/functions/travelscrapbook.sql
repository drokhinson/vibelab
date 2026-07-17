-- ─────────────────────────────────────────────────────────────────────────────
-- Travel Scrapbook — RPC function inventory
-- Last updated: 2026-07-17 (015 perf RPCs: single-round-trip reads + bulk writes)
-- FOR REFERENCE ONLY — apply changes via db/migrations/
-- ─────────────────────────────────────────────────────────────────────────────

-- travelscrapbook__scrap_place_json(p_place_id UUID)
--   → JSONB {place_name, place_city, place_region, place_country, category,
--            lat, lng, geocode_confidence, geocode_display_name, maps_url,
--            og_image_url, sources[]}
--   Defined in: db/migrations/travelscrapbook/015_perf_rpcs.sql
--   Called by:  (internal helper — composed by the bundle RPCs below)
--   Purpose:    Flattened place fields + source chips for one scrap, exactly
--               mirroring services/hydrate.py's per-scrap place block.

-- travelscrapbook__membership_vibes_json(p_membership_id UUID)
--   → JSONB [{user_id, display_name, level}]
--   Defined in: db/migrations/travelscrapbook/015_perf_rpcs.sql
--   Called by:  (internal helper — composed by the bundle RPCs below)
--   Purpose:    One membership's raw vibe rows with traveler display names;
--               the consensus roll-up stays in Python (hydrate.attach_consensus).

-- travelscrapbook_trip_bundle(p_trip_id UUID, p_viewer UUID)
--   → JSONB {trip, role, owner_display_name, anchors[], scraps[], members[],
--            candidates[]} | NULL when the viewer has no access
--   Defined in: db/migrations/travelscrapbook/015_perf_rpcs.sql
--   Called by:  shared-backend/routes/travel_scrapbook/trip_routes.py (get_trip)
--   Purpose:    The whole trip screen in ONE round trip (was 6–9 sequential
--               queries + 3 extra endpoints). Access (owner or accepted
--               member) is enforced inside since service role bypasses RLS.

-- travelscrapbook_trips_list(p_viewer UUID)
--   → JSONB [trip row + owner_user_id, owner_display_name, role, scrap_count]
--   Defined in: db/migrations/travelscrapbook/015_perf_rpcs.sql
--   Called by:  shared-backend/routes/travel_scrapbook/trip_routes.py (list_trips)
--   Purpose:    Owned + accepted-shared trips, newest first, with counts and
--               roles — the trips landing screen in one round trip (was 4).

-- travelscrapbook_scrap_card(p_scrap_id UUID, p_trip_id UUID)
--   → JSONB one hydrated membership-scoped scrap | NULL when not on that trip
--   Defined in: db/migrations/travelscrapbook/015_perf_rpcs.sql
--   Called by:  shared-backend/routes/travel_scrapbook/scrap_routes.py
--               (_hydrated_membership — the echo for assign/approve/schedule/
--               vibe endpoints)
--   Purpose:    Cheap single-scrap echo after membership mutations (was a
--               ~6-round-trip Python hydration). Callers check trip access
--               BEFORE the mutation.

-- travelscrapbook_inbox_bundle(p_viewer UUID, p_region TEXT, p_country TEXT,
--                              p_city TEXT, p_limit INT, p_offset INT)
--   → JSONB {scraps[] (+trip_ids), total, unvisited_count, facets,
--            processing_sources[], failed_sources[], geocoded_trips[]}
--   Defined in: db/migrations/travelscrapbook/015_perf_rpcs.sql
--   Called by:  shared-backend/routes/travel_scrapbook/source_routes.py (get_inbox)
--   Purpose:    The Wander List screen in one round trip: SQL-side filter/
--               facets/pagination (was fetch-all + Python paging) plus the
--               geocoded trips that feed Python-side suggestions (was one
--               trips query PER SCRAP on the page).

-- travelscrapbook_visited_page(p_viewer UUID, p_region TEXT, p_country TEXT,
--                              p_city TEXT, p_limit INT, p_offset INT)
--   → JSONB {scraps[], total, facets}
--   Defined in: db/migrations/travelscrapbook/015_perf_rpcs.sql
--   Called by:  shared-backend/routes/travel_scrapbook/scrap_routes.py (list_visited)
--   Purpose:    One filtered page of visited places with facets, paginated in
--               SQL.

-- travelscrapbook_community_places(p_q TEXT, p_region TEXT, p_country TEXT,
--                                  p_city TEXT, p_category TEXT,
--                                  p_limit INT, p_offset INT)
--   → JSONB {places[], total, facets}
--   Defined in: db/migrations/travelscrapbook/015_perf_rpcs.sql
--   Called by:  shared-backend/routes/travel_scrapbook/community_routes.py
--               (list_community_places)
--   Purpose:    The community catalog page in one round trip: group by OSM
--               identity (else normalized name + country), pick the most
--               complete representative, count distinct savers, filter/facet/
--               paginate, attach deduped source chips for the page only.
--               Replaces a 2000-row fetch + Python aggregation.

-- travelscrapbook_set_route_positions(p_positions JSONB)
--   → VOID   (p_positions: [{"id": "<scrap_trip uuid>", "pos": 1}, ...])
--   Defined in: db/migrations/travelscrapbook/015_perf_rpcs.sql
--   Called by:  shared-backend/routes/travel_scrapbook/route_routes.py
--               (optimize_route)
--   Purpose:    Persist an optimized route order in one UPDATE (was one per
--               stop). The calling route verifies trip write access first.
