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

### B2. The function is already written

`projects/boardgame-buddy/functions/index.js`, committed. Read it before
deploying — the comments say why it is `beforeUserSignedIn` rather than
`beforeUserCreated`, why it returns both `customClaims` and `sessionClaims`,
and why it must never throw.

The short version of that last one: **a blocking function that errors blocks
the sign-in it is attached to.** A bug in there does not degrade the app, it
locks every user out of it. So the body is wrapped in try/catch and returns
nothing on failure — failing open costs one account its claim until its next
sign-in repairs it.

`firebase.json` and `.firebaserc` sit beside it in `projects/boardgame-buddy/`,
with the project pinned to `boardgamebuddy-508716` so a deploy cannot land on
the wrong one.

### B3. Install the CLI and deploy

From **`projects/boardgame-buddy`** — the Firebase CLI reads `firebase.json`
from the working directory, and the one that matters is there, not at the repo
root:

```
npm install -g firebase-tools
firebase login
cd projects\boardgame-buddy
cd functions && npm install && cd ..
firebase deploy --only functions
```

`firebase login` opens a browser; sign in as the Google account that owns the
GCP project. Deploying a `beforeUserSignedIn` function registers the blocking
trigger as part of the deploy — there is no separate registration step.

Confirm it afterwards under Firebase console → **Authentication → Settings →
Blocking functions**. `supabaseRole` should be listed against *Before sign-in*.

> **Not automated, deliberately.** Every other deploy in this project runs from
> a GitHub workflow. This one does not, because it changes approximately never
> and automating it would mean parking a credential for the auth project in CI
> — a much larger standing risk than a manual deploy nobody has to repeat.

`functions/package-lock.json` is generated by the `npm install` above and
**should be committed** (`.gitignore` has an exception for it), so a later
deploy installs the same versions this one did.

### B3b. If the first deploy fails with "container failed to start"

```
Could not create or update Cloud Run service supabaserole, Container
Healthcheck failed. The user-provided container failed to start and listen on
the port defined provided by the PORT=8080 environment variable within the
allocated timeout.
```

**Run the deploy again before debugging anything.** On a project that has
never had a Cloud Function, that same deploy enables five APIs on the way
through — `artifactregistry`, `cloudbuild`, `run`, `eventarc`,
`firebaseextensions` — and mints service identities for two of them. Those
grants propagate asynchronously, so the build can finish and produce an image
that the Cloud Run service account cannot yet pull. The container then never
starts, and the symptom is a healthcheck timeout that says nothing about
permissions. A retry a few minutes later usually just works, and the CLI is
idempotent.

It is worth knowing that the code is almost certainly not the problem here:
the deploy's own `Loading and analyzing source code` step (`Serving at port
8172` in its output) already loaded the module without error, and that step is
the one that catches a broken `index.js`.

If a second attempt fails the same way, get the actual reason from the
container rather than guessing — the Logs URL the CLI printed, or:

```
gcloud run services logs read supabaserole --region us-central1 --limit 50 --project boardgamebuddy-508716
```

The two causes worth knowing:

* **A missing role on the compute service account.** A first-ever deploy
  sometimes leaves `<project-number>-compute@developer.gserviceaccount.com`
  without **Artifact Registry Reader**, so it cannot pull its own image. Grant
  it in IAM and redeploy.
* **The runtime.** `functions/package.json` pins `engines.node` to `22`.
  It was briefly `20`, which the deploy itself warned about —
  *"Runtime Node.js 20 was deprecated on 2026-04-30 and will be decommissioned
  on 2026-10-30"* — so a function deployed on it would have stopped building
  within weeks. If you see that warning again, the pin has regressed.

Node 22 also means a local `npm install` on Node 24 prints
`EBADENGINE ... required: { node: '22' }`. Harmless: `engines.node` here
selects the **cloud** runtime, and is not a constraint on your machine.

### B4. Verify with a throwaway account

Sign up a new account, then decode its token as in A5 and confirm
`role === "authenticated"`. Because the function returns `sessionClaims` as
well as `customClaims`, the claim should be in the **first** token, with no
refresh needed — that is what `sessionClaims` is for. If it is missing there
but present after a forced refresh, the session-claims half is not taking
effect; the account still works from its second token on, so this is worth
knowing rather than urgent.

Then delete the throwaway account.

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
