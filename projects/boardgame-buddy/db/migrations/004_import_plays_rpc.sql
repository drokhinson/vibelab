-- 004_import_plays_rpc.sql — batch play writer for the Settings play importer.
--
-- The importer turns one pasted note into up to a few hundred plays. Sending
-- them one at a time through POST /plays is a few hundred round trips, so the
-- client chunks them and each chunk lands here as ONE call.
--
-- This function deliberately owns no insert logic of its own: it loops the
-- payload and calls bgb_log_play per element. That function already owns game
-- resolution, the denormalized game_name/game_thumbnail_url columns, the
-- client_key idempotency pre-check AND its unique_violation race branch, the
-- player and expansion inserts, and the {"error": "game_not_found"} envelope.
-- A second implementation of any of that is how the two drift apart.
--
-- One consequence worth stating: a play whose game_id is unknown returns its
-- error envelope in the results array and the rest of the chunk still lands.
-- A batch that aborted wholesale on one bad row would make a 300-play import
-- unfinishable over a single typo.

CREATE OR REPLACE FUNCTION public.bgb_import_plays(p_user uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_item     JSONB;
  v_result   JSONB;
  v_results  JSONB := '[]'::JSONB;
  v_index    INT := 0;
  v_imported INT := 0;
  v_dupes    INT := 0;
  v_failed   INT := 0;
BEGIN
  FOR v_item IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_payload->'plays', '[]'::JSONB))
  LOOP
    v_result := public.bgb_log_play(p_user, v_item);

    IF v_result ? 'error' THEN
      v_failed := v_failed + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'id', NULL, 'duplicate', false,
        'error', v_result->>'error'
      ));
    ELSIF COALESCE((v_result->>'duplicate')::BOOLEAN, false) THEN
      -- A client_key this user already holds a play for. The importer stamps
      -- one UUID per expanded play and re-sends it on a retry, so this is the
      -- branch that makes re-running a half-finished import safe.
      v_dupes := v_dupes + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'id', v_result->>'id', 'duplicate', true, 'error', NULL
      ));
    ELSE
      v_imported := v_imported + 1;
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_index, 'id', v_result->>'id', 'duplicate', false, 'error', NULL
      ));
    END IF;

    v_index := v_index + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'imported',  v_imported,
    'duplicate', v_dupes,
    'failed',    v_failed,
    'results',   v_results
  );
END;
$function$;
GRANT EXECUTE ON FUNCTION public.bgb_import_plays(p_user uuid, p_payload jsonb) TO boardgamebuddy_role;
