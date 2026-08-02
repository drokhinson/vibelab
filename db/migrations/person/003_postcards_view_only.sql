-- ─────────────────────────────────────────────────────────────────────────────
-- person — make the Slovenian Arrow postcards view-only
--
-- The seeded stop postcards (person_trip_stops.html_content, loaded from
-- landing/travel/postcards/*.html via seed_postcards.py) shipped with an
-- editable message: the <p class="message"> was contenteditable, the flip
-- handler deliberately ignored taps on it, and a hint invited visitors to
-- rewrite it. Non-admins should only VIEW postcards — admins edit them through
-- the admin editor. This migration rewrites the already-seeded rows to:
--   • drop contenteditable/spellcheck on the message (view-only),
--   • flip the card on ANY tap (no message-swallowing),
--   • remove the "the message is yours to rewrite" hint,
--   • drop the now-dead .message:focus style.
--
-- Idempotent: each REPLACE targets the exact original substring, so re-running
-- (or running after a fresh seed from the fixed files) is a no-op. Scoped to the
-- slovenian-arrow trip's stops. Mirrors the edits made to the source files under
-- landing/travel/postcards/.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.person_trip_stops AS s
SET html_content =
  REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                s.html_content,
                -- 1. message → view-only
                '<p class="message" id="msg" contenteditable="true" spellcheck="false">',
                '<p class="message" id="msg">'
              ),
              -- 2. drop the "message is yours to rewrite" hint
              'Tap the card to <b>turn it over</b> · the message is yours to rewrite',
              'Tap the card to <b>turn it over</b>'
            ),
            -- 3. drop the dead .message:focus rule
            E'outline:none; margin:0; }\n  .message:focus{ background:rgba(255,255,255,.5); }',
            'outline:none; margin:0; }'
          ),
          -- 4. msg reference no longer needed
          'const card = document.getElementById("card"), msg = document.getElementById("msg");',
          'const card = document.getElementById("card");'
        ),
        -- 5. flip on any tap
        'card.addEventListener("click", e => { if (e.target !== msg) flip(); });',
        'card.addEventListener("click", flip);'
      ),
      -- 6. keyboard flip everywhere (drop the msg guard)
      E'card.addEventListener("keydown", e => {\n  if (e.target === msg) return;\n  if (e.key === "Enter"',
      E'card.addEventListener("keydown", e => {\n  if (e.key === "Enter"'
    ),
    -- 7. drop the message click stopPropagation
    E'\nmsg.addEventListener("click", e => e.stopPropagation());',
    ''
  )
FROM public.person_trips t
WHERE s.trip_id = t.id
  AND t.slug = 'slovenian-arrow';
