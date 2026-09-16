/**
 * BoardgameBuddy — the Identity Platform blocking function that makes RLS work.
 *
 * ONE JOB, AND THE APP IS BROKEN WITHOUT IT. Every row-level security policy
 * on the live-session tables is declared `TO authenticated`. A request's role
 * comes from its JWT's `role` claim, and an Identity Platform ID token does
 * not have one — so a browser talking directly to Supabase resolves to `anon`,
 * matches no policy, and is refused. This function is what puts the claim
 * there. Supabase's own Third-Party Auth panel states the requirement:
 *
 *   "you'll need to add custom code to set the authenticated role to all your
 *    present and future users"
 *
 * This is the "future users" half. The present-users half was a one-off
 * backfill, `tools/set-authenticated-claim.mjs`.
 *
 * DO NOT DELETE THIS BECAUSE IT LOOKS UNUSED. Nothing in the repo imports it
 * and no test covers it; it runs inside Google's auth flow, not in our
 * process. Removing it breaks live scoring and both Realtime channels for
 * every account created afterwards, and breaks them SILENTLY — the API is
 * service-role and bypasses RLS, so the app keeps working everywhere except
 * the browser-direct paths. That failure took a live game and a Supabase log
 * dive to identify. See Docs/RUNBOOK_AUTH_ROLE_CLAIM.md.
 *
 * WHY beforeUserSignedIn AND NOT beforeUserCreated. Sign-in fires on every
 * session, so this also repairs any account that somehow lacks the claim —
 * including every account that predates this function. beforeUserCreated
 * would fire once, at signup, and leave a user created during an outage
 * broken forever.
 */
const { setGlobalOptions } = require("firebase-functions/v2");
const { beforeUserSignedIn } = require("firebase-functions/v2/identity");

// Blocking functions only run in certain regions, and an unset region picks up
// whatever global default the CLI has. Pinned so a deploy cannot land somewhere
// Identity Platform will not call.
setGlobalOptions({ region: "us-central1" });

const ROLE_CLAIM = "role";
const ROLE_VALUE = "authenticated";

exports.supabaseRole = beforeUserSignedIn((event) => {
  try {
    // `event.data` is optional in the SDK's own types, so it is read
    // defensively rather than trusted.
    const existing = (event.data && event.data.customClaims) || {};
    if (existing[ROLE_CLAIM] === ROLE_VALUE) return;

    return {
      // Persisted to the user record, so every token from here on carries it
      // even when this function does not run. MERGED, not replaced: the
      // return value overwrites the stored claims wholesale, so spreading
      // `existing` is what stops this from deleting any other claim an
      // account has.
      customClaims: { ...existing, [ROLE_CLAIM]: ROLE_VALUE },
      // Added to the token being minted for THIS sign-in. Without it the
      // first token of a brand-new account would predate the claim being
      // stored, and that account's first session would fail exactly the way
      // this function exists to prevent — for one session, invisibly.
      sessionClaims: { [ROLE_CLAIM]: ROLE_VALUE },
    };
  } catch (err) {
    // NEVER THROW. A blocking function that errors blocks the sign-in it is
    // attached to, so a bug in here does not degrade the app, it locks every
    // user out of it. Failing open costs one account its claim until the next
    // sign-in repairs it; failing closed costs everyone their account.
    console.error("supabaseRole: leaving claims untouched", err);
    return;
  }
});
