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
// IMPORT THE NARROW PATH, NEVER `firebase-functions/v2`. That barrel eagerly
// requires every v2 provider, including firestore.js -> firebase-admin's
// firestore -> `@google-cloud/firestore`, which is an OPTIONAL peer of
// firebase-admin. A local `npm install` pulls optional peers in, so the module
// loads on a laptop and in the CLI's own source analysis; the deployed image
// installs without them, so it dies at load with:
//
//   Error: Cannot find module '@google-cloud/firestore'
//   Require stack: ... firebase-functions/lib/v2/index.js - /workspace/index.js
//
// which Cloud Run reports as "the user-provided container failed to start and
// listen on the port" — a message that names neither the module nor the
// import. Cost: three failed deploys. `firebase-functions/v2/identity` pulls
// in none of it.
const { beforeUserSignedIn } = require("firebase-functions/v2/identity");
const { createHash } = require("node:crypto");

const ROLE_CLAIM = "role";
const ROLE_VALUE = "authenticated";

// ── The app's user id ───────────────────────────────────────────────────────
//
// SECOND JOB, ADDED AFTER THE FIRST NEW ACCOUNT 500ed EVERY ENDPOINT. The 23
// accounts migrated from Supabase kept their original UUIDs as their
// Identity Platform uid, so `sub` was always a UUID and the whole schema —
// 35 columns, 58 RPC parameters — is typed `uuid`. A brand-new account gets a
// Firebase-generated uid instead: 28 characters, no dashes, not a UUID. Every
// query naming that user then dies on `invalid input syntax for type uuid`,
// which the API returns as a 500 on literally every authenticated endpoint.
//
// So the token carries the id the app should use, and nothing downstream has
// to care where it came from:
//
//   * uid already a UUID  -> that UUID, unchanged. The migrated accounts keep
//     the id every play, buddy edge, achievement and session row hangs off.
//   * anything else       -> uuid5(NAMESPACE, uid). Deterministic, so the
//     same account resolves to the same id on every sign-in, forever,
//     without storing a mapping anywhere.
//
// NEVER CHANGE THE NAMESPACE. It is the input to every derived id; a new one
// re-keys every non-migrated account and orphans all of their data.
const APP_UID_CLAIM = "app_uid";
const NAMESPACE = "f61fb828-5954-4b75-b2cb-ab1a0b1cd211";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RFC 4122 v5 (SHA-1, name-based). Hand-rolled on node:crypto rather than
 * pulling in the `uuid` package: this file's last outage was a dependency it
 * did not need being loaded at import time, and a built-in cannot repeat it.
 */
function uuid5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([ns, Buffer.from(String(name), "utf8")]))
    .digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return [
    h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20),
  ].join("-");
}

/** The UUID this account is known by inside the app. */
function appUid(uid) {
  const id = String(uid || "");
  return UUID_RE.test(id) ? id.toLowerCase() : uuid5(id, NAMESPACE);
}

exports.appUid = appUid; // for tools/check-auth-claims.mjs

// Region as a per-function option rather than setGlobalOptions(), which lives
// in that same poisoned barrel. Blocking functions only run in certain
// regions, and an unset region takes whatever default the CLI holds, so it is
// pinned either way.
exports.supabaseRole = beforeUserSignedIn({ region: "us-central1" }, (event) => {
  try {
    // `event.data` is optional in the SDK's own types, so it is read
    // defensively rather than trusted.
    const existing = (event.data && event.data.customClaims) || {};
    const uid = (event.data && event.data.uid) || "";
    const wanted = appUid(uid);
    if (
      existing[ROLE_CLAIM] === ROLE_VALUE &&
      existing[APP_UID_CLAIM] === wanted
    ) {
      return;
    }

    const claims = {
      [ROLE_CLAIM]: ROLE_VALUE,
      [APP_UID_CLAIM]: wanted,
    };

    return {
      // Persisted to the user record, so every token from here on carries it
      // even when this function does not run. MERGED, not replaced: the
      // return value overwrites the stored claims wholesale, so spreading
      // `existing` is what stops this from deleting any other claim an
      // account has.
      customClaims: { ...existing, ...claims },
      // Added to the token being minted for THIS sign-in. Without it the
      // first token of a brand-new account would predate the claim being
      // stored, and that account's first session would fail exactly the way
      // this function exists to prevent — for one session, invisibly.
      sessionClaims: claims,
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
