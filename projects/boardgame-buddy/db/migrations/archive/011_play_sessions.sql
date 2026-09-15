-- ─────────────────────────────────────────────────────────────────────────────
-- boardgamebuddy — Short-code play sessions
-- "Join a play in progress" flow. The host phone creates a session with a
-- short code; other phones join with that code and contribute their identity
-- before the host finalizes the session into a single boardgamebuddy_plays
-- row + N play_players rows.
--
-- Codes are 5-char base32 (Crockford); collision avoidance is done in the
-- service layer via retry. Sessions auto-expire after 2 hours.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  host_user_id UUID NOT NULL REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  game_id UUID REFERENCES public.boardgamebuddy_games(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'finalized', 'abandoned')),
  finalized_play_id UUID REFERENCES public.boardgamebuddy_plays(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '2 hours'),
  finalized_at TIMESTAMPTZ
);
-- Open codes must be globally unique; abandoned/finalized codes can be reused.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_play_sessions_open_code
  ON public.boardgamebuddy_play_sessions (code)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_bgb_play_sessions_host
  ON public.boardgamebuddy_play_sessions (host_user_id, status);
ALTER TABLE public.boardgamebuddy_play_sessions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_sessions TO boardgamebuddy_role;


CREATE TABLE IF NOT EXISTS public.boardgamebuddy_play_session_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.boardgamebuddy_play_sessions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.boardgamebuddy_profiles(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A given account can only appear once per session. Free-text guests (user_id
-- null) dedupe by display_name within a session.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_play_session_user_unique
  ON public.boardgamebuddy_play_session_participants (session_id, user_id)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bgb_play_session_guest_unique
  ON public.boardgamebuddy_play_session_participants (session_id, lower(display_name))
  WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_bgb_play_session_participants_session
  ON public.boardgamebuddy_play_session_participants (session_id);
ALTER TABLE public.boardgamebuddy_play_session_participants ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.boardgamebuddy_play_session_participants TO boardgamebuddy_role;
