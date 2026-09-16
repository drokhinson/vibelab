# Runbook — the `role: "authenticated"` claim

**Symptom this fixes.** Live scores never reach spectators. The host types
numbers and sees them; the spectator sees phase changes, roster edits and even
a new player's column appear, but the score cells stay empty forever. The
Supabase log shows, on the host's device:

```
401   POST /rest/v1/boardgamebuddy_play_session_scores
42501 new row violates row-level security policy for table "boardgamebuddy_play_session_scores"
```

**Cause.** Every RLS policy on the live-session tables is declared
`TO authenticated`. A request's role comes from its JWT's `role` claim, and a
Firebase / Identity Platform ID token has no such claim — so browser-direct
requests resolve to `anon`, match no policy, and are refused. Supabase's
Third-Party Auth panel says so under the Firebase integration: *"you'll need to
add custom code to set the `authenticated` role to all your present and future
users."* Enabling the provider is only half the step.

Everything that still works does so because it goes through the API, which is
service-role and bypasses RLS entirely. That is why this reads as "live scoring
is broken" rather than "the app is broken", and it is also why **all Realtime is
currently dead** — both channels authenticate the same way.

**Two parts, and you need both.** Part A fixes the 23 existing accounts now.
Part B covers everyone who signs up later. Doing only A leaves a bug that
comes back for every new user.

---

## Part A — backfill the existing users

### A1. Get a service-account key

GCP console → **IAM & Admin → Service Accounts**, for project
`boardgamebuddy-508716`. Use the existing `firebase-adminsdk-…` account (it
already holds the Firebase Authentication Admin role) → **Keys → Add key →
Create new key → JSON**.

> **This file can mint a token for any user in the project.** Save it outside
> the repo, use it, then delete it. `.gitignore` covers `*.sa.json` as a
> backstop, not as permission. This is the same credential the user import
> needed and the same reason that one was deleted afterwards.

### A2. Install the SDK and point at the key

`firebase-admin` is deliberately not a repo dependency — nothing at runtime
uses it. Install it for this run only, from the repo root:

```
npm install --no-save firebase-admin
```

`--no-save` matters: this repo has no root `package.json`, and a plain
`npm install` would create one. With `--no-save` the only thing written is
`node_modules/`, which `.gitignore` already covers.

Then set the credential path. **Pick your shell** — `export` is bash-only and
fails on Windows with *"'export' is not recognized as an internal or external
command"*:

| Shell | Command |
|---|---|
| cmd.exe | `set GOOGLE_APPLICATION_CREDENTIALS=C:/path/to/sa.json` |
| PowerShell | `$env:GOOGLE_APPLICATION_CREDENTIALS = "C:/path/to/sa.json"` |
| bash / zsh | `export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/sa.json` |

In **cmd** specifically: no quotes around the value (cmd keeps them as part of
the string) and no spaces around `=`. Forward slashes are fine on Windows —
Node accepts them. The variable lives only in that terminal window, which is a
feature here: close it and the credential is no longer in any environment.

Check it took before blaming the script: `echo %GOOGLE_APPLICATION_CREDENTIALS%`
in cmd, `$env:GOOGLE_APPLICATION_CREDENTIALS` in PowerShell, or
`echo $GOOGLE_APPLICATION_CREDENTIALS` in bash.

### A2b. Dry-run the backfill

```
node projects/boardgame-buddy/tools/set-authenticated-claim.mjs --dry-run
```

It prints how many users it found, how many already have the claim, and which
uids it would change. Nothing is written.

Expect roughly `23 users, 0 already correct, would update 23`.

### A3. Apply it

```
node projects/boardgame-buddy/tools/set-authenticated-claim.mjs --apply
```

Idempotent and re-runnable: a user who already has the claim is skipped, and
any other claims an account carries are preserved (`setCustomUserClaims`
replaces the whole object, so the script merges rather than overwrites). It
exits non-zero if any account failed, and names them.

### A4. Delete the key

| Shell | Commands |
|---|---|
| cmd.exe | `set GOOGLE_APPLICATION_CREDENTIALS=` then `del C:\path\to\sa.json` |
| PowerShell | `Remove-Item Env:\GOOGLE_APPLICATION_CREDENTIALS` then `Remove-Item C:\path\to\sa.json` |
| bash / zsh | `unset GOOGLE_APPLICATION_CREDENTIALS` then `rm /absolute/path/to/sa.json` |

In cmd, `set VAR=` with nothing after the `=` is how you clear a variable.
Closing the window does it too. The file is the part that matters — the
variable is just a pointer at it.

`node_modules/` from A2 can stay or go; it is ignored either way.

### A5. Refresh a token and verify

The claim is on the user record, but a browser that is already signed in holds
a token without it until its next refresh — **up to an hour**. To see it now,
sign out and back in, or in the console:

```js
await window.firebase.auth().currentUser.getIdToken(true);   // force refresh
const t = await window.firebase.auth().currentUser.getIdToken();
console.log(JSON.parse(atob(t.split(".")[1])).role);         // "authenticated"
```

Then prove the write works, on the host's device, in a session in the Play
phase:

```js
const { error } = await window.supabaseClient
  .from("boardgamebuddy_play_session_scores")
  .upsert([{ session_id: "<session uuid>", participant_id: "<participant uuid>",
             round_index: 0, score: 1 }],
          { onConflict: "session_id,participant_id,round_index" });
console.log(error || "write accepted");
```

`null` means done. A 42501 here means the claim is not in the token yet — go
back to the forced refresh.

---

## Part B — cover every future user

A signup after Part A gets no claim, and live scoring breaks again for that
account only. The durable fix is an Identity Platform **blocking function**.

### B1. Check the prerequisite

Cloud Functions requires a billing account on the project (Blaze). Actual cost
here is nil — one invocation per sign-in, far inside the free tier — but the
account has to exist. Identity Platform itself usually already implies one; if
it does not, and attaching one is unacceptable, use the alternative in B5.

### B2. The function

`beforeUserSignedIn`, not `beforeUserCreated`. It fires on every sign-in, so it
also self-heals any account that somehow lacks the claim — including anyone
created before this function existed, which makes Part A a convenience rather
than a dependency.

```js
// functions/index.js
import { beforeUserSignedIn } from "firebase-functions/v2/identity";

export const supabaseRole = beforeUserSignedIn((event) => {
  try {
    const existing = (event.data && event.data.customClaims) || {};
    if (existing.role === "authenticated") return;
    // Merge: the return value REPLACES the stored claims.
    return { customClaims: { ...existing, role: "authenticated" } };
  } catch (_) {
    // NEVER let this throw. A blocking function that errors blocks the
    // sign-in it is attached to, so a bug here locks every user out of the
    // app. Failing open costs one account its claim until its next sign-in;
    // failing closed costs everyone their account.
    return;
  }
});
```

### B3. Deploy

```
firebase deploy --only functions
```

Deploying a `beforeUserSignedIn` function registers the blocking trigger.
Confirm it under Firebase console → **Authentication → Settings → Blocking
functions**.

### B4. Verify with a throwaway account

Sign up a new account, then decode its token as in A5 and confirm
`role === "authenticated"`. If the very first token after signup lacks it but a
forced refresh has it, the claim is landing one token late — acceptable, and
the client picks it up within the hour, but worth knowing before you debug it
as a failure. Delete the throwaway account afterwards.

### B5. Alternative, if you will not attach billing

Set the claim from the API instead. `GET /bootstrap` is called by every session
right after auth, so it is the natural hook: if the caller's token has no
`role`, call the Identity Toolkit REST API (`accounts:update` with
`customAttributes`) and have the client force-refresh once.

Honest trade-offs, because this is the worse option: it puts a
service-account credential into Railway permanently (the thing Part A goes out
of its way to delete), it makes a `GET` write, and the first token of every new
session still lacks the claim until the refresh lands. Prefer B2.

---

## Verification checklist

- [ ] A token decoded in the browser shows `role: "authenticated"`
- [ ] The host's direct upsert returns no error
- [ ] Host types a score → the spectator's grid shows it within a few seconds
- [ ] A **new** signup's token also carries the claim (Part B is live)
- [ ] No more `42501` on `boardgamebuddy_play_session_scores` in the Supabase log
- [ ] Realtime is back: the spectator updates in under a second, not on the
      4–10s poll cadence

## What not to do

**Do not use `sessionClaims` instead of `customClaims`.** Session claims are
not persisted to the user record, so they exist only for the session that
minted them and vanish on the next token refresh — which is exactly the moment
RLS starts failing again.

**Do not skip Part B because Part A fixed it.** The next signup reproduces the
whole outage for that account, and the failure is silent by design on every
screen except the host's toast (`views/play-flow-view.js`, added after this
incident — see `tools/check-live-scores.mjs` for what it guarantees).

**Do not widen the RLS policies to `anon` to make this go away.** Those
policies are what stop one table's session codes being listable; migration
`027_session_viewers.sql` explains why `USING (true)` for authenticated was
already too wide.
