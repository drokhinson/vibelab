# BoardgameBuddy — Environment Variables

Every variable this project uses, grouped by where the value is **stored**. The
Source column is where you go to read or rotate it. Update this file in the same
commit that adds, renames or removes a variable.

Supersedes the root `ENV.md` for anything BoardgameBuddy. Domain: **bgbuddy.app**.

## 1. API host — Railway service, Root Directory `projects/boardgame-buddy/api`

| Variable | Source | Purpose |
|---|---|---|
| `SUPABASE_URL` | Supabase → Settings → API | Project URL. Also the JWKS base `jwt_auth.py` derives. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API | Bypasses RLS. **Server only, never the frontend.** |
| `ALLOWED_ORIGINS` | Hand-maintained | CORS allowlist, comma-separated, **no trailing slash**. See §4. |
| `ADMIN_API_KEY` | Hand-generated | Bearer token for the admin endpoints. |
| `BGB_QR_SECRET` | `python -c "import secrets; print(secrets.token_urlsafe(32))"` | Signs add-a-buddy QR tokens. ≥32 bytes. **Rotating it is the revocation lever** — the tokens carry no server-side state, so rotation invalidates every outstanding code at once. Never rotate during a migration. |
| `BGB_VAPID_PUBLIC_KEY` | generated with the private half, one run | The half clients hold; served by `GET /push/config`. **87 base64url chars, starts `B`.** Unset = push feature off, which is the intended local-dev state. |
| `BGB_VAPID_PRIVATE_KEY` | same run as the public half | Signs the VAPID header. **43 base64url chars.** A mismatched pair fails every send. **Rotating the pair invalidates every existing subscription** — old rows keep looking valid and silently stop delivering, so rotation means setting both, then `TRUNCATE boardgamebuddy_push_subscriptions`. |
| `BGB_VAPID_SUBJECT` | hand-set | `mailto:`/`https:` contact the Web Push spec requires. Set a real address before relying on push. |
| `BGG_API_TOKEN` | boardgamegeek.com/applications | Rate-limit headroom. |
| `BGG_CREDENTIAL_KEY` | `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` | Fernet key encrypting linked users' BGG passwords. Rotating it orphans every stored credential. |
| `BGG_PUSH_DRY_RUN` | hand-set (`true`) | Logs the BgB→BGG collection-write payload and sends nothing. BGG has no write API and the form fields are reverse-engineered — **leave this on** until confirmed against a throwaway BGG account. |
| `BGG_WEB_USER_AGENT` | hand-set | UA for boardgamegeek.com's own web endpoints (not xmlapi2). Those sit behind Cloudflare, which screens POSTs on how browser-shaped they look; the UA that gets through is a moving target, hence env-tunable. |
| `BGG_THROTTLE_SECONDS` | hand-set (default `1.5`) | Seconds between BGG collection *reads* in a sweep. |
| `BGG_PUSH_THROTTLE_SECONDS` | hand-set (default `2.0`) | Seconds between BGG collection *writes*. Higher because BGG's write limits are undocumented. |
| `GEMINI_API_KEY` | aistudio.google.com → API Keys | Chapter drafting and play-note import. Missing key → those two endpoints 502; nothing else breaks. |

### Added by the migration (see `Docs/MIGRATION_PLAN.md`)

| Variable | Stage | Purpose |
|---|---|---|
| `R2_ACCOUNT_ID` | 4 | Cloudflare account, for the S3 endpoint |
| `R2_ACCESS_KEY_ID` | 4 | R2 API token |
| `R2_SECRET_ACCESS_KEY` | 4 | R2 API token |
| `R2_PLAYS_BUCKET` | 4 | Play photos (was Supabase `boardgamebuddy-plays`) |
| `R2_GAMES_BUCKET` | 4 | Cover-art cache (was Supabase `boardgamebuddy-games`) |
| `R2_PUBLIC_BASE` | 4 | `https://img.bgbuddy.app` — the origin stored URLs are built from |
| `GCP_PROJECT_ID` | 3-ALT | `boardgamebuddy-508716`. Read by `api/jwt_auth.py` as the Firebase token `aud`, with the issuer derived as `https://securetoken.google.com/<id>`. **Set it on the Railway service before the frontend swap.** Until it is set, the verifier still accepts Supabase tokens normally but answers 500 to any Identity Platform token — deliberately, since an unset value is an operator error, not a bad credential. Must equal `BGB_FIREBASE_PROJECT_ID`. |

## 2. GitHub Actions

Settings → Secrets and variables → Actions.

| Name | Kind | Purpose |
|---|---|---|
| `VIBELAB_SUPABASE_URL` | secret | Baked into `web/config.js` by `build.sh` |
| `VIBELAB_SUPABASE_ANON_KEY` | secret | Baked into `web/config.js` by `build.sh` |
| `CLOUDFLARE_API_TOKEN` | secret | `wrangler pages deploy`. Scope: **Cloudflare Pages: Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Same |
| `BGB_API_BASE` | **variable** | API origin baked into `config.js`. A variable, not a secret, so the backend can be re-pointed without editing a workflow. No trailing slash. |
| `BGB_COMING_SOON` | **variable** | `true` serves `views/landing-view.js` (waitlist) instead of the app. Unset or anything else boots normally. Going live is flipping this and re-running the workflow, not a commit. `?preview=1` bypasses it for one tab — see `init.js`. |
| `BGB_FIREBASE_API_KEY` | **variable** | GCP Identity Platform. **Not a secret** — it identifies the project and authorizes nothing; access is decided by Authorized Domains and the provider config. |
| `BGB_FIREBASE_AUTH_DOMAIN` | **variable** | `auth.bgbuddy.app`. The whole point of the custom-domain work: this field is what decides the hostname the user sees during Google sign-in. Left at `<project-id>.firebaseapp.com` the branding is unbranded. |
| `BGB_FIREBASE_PROJECT_ID` | **variable** | `boardgamebuddy-508716`. Must equal the API host's `GCP_PROJECT_ID` and the project ID given to Supabase third-party auth — it is the token `aud`, so a mismatch fails every request. |
| `BGB_FIREBASE_APP_ID` | **variable** | From Firebase → Project settings → Your apps. |

`storageBucket` and `messagingSenderId` from the Firebase snippet are
deliberately **not** carried: photos go to Supabase Storage and then R2, and web
push uses this project's own VAPID keypair rather than FCM. Wiring either in
would add a backend nothing reads.

`build.sh` emits all four Firebase values or none. `deploy-bgb-web.yml` **fails**
on a partial set and only **warns** on an empty one — an empty set is the correct
state until the frontend swaps off the Supabase Auth SDK (Stage 3-ALT.4), while
three-of-four looks configured and breaks at sign-in.

Actions secrets are **repo-wide** — these sit in the same store as the other
apps'. That is not a security boundary, and it is the one real argument for
eventually splitting this project into its own repository.

## 3. Local dev

`api/.env` (gitignored) mirrors §1. Defaults baked into the code
(`dev-admin-key`, `dev-secret-change-me`) let you run with an empty file.
Production-equivalent secrets must never be committed.
`web/config.js` is gitignored and generated.

## 4. `ALLOWED_ORIGINS` — what belongs in it

Browser origins only; scheme + host + optional port, **no path, no trailing
slash**, comma-separated. React Native needs no entry (not a browser origin),
and neither does `auth.bgbuddy.app` or `img.bgbuddy.app` — those are not
origins the app's JS is served from.

```
https://bgbuddy.app,https://www.bgbuddy.app,https://bgbuddy.pages.dev,http://localhost:5500,http://127.0.0.1:5500
```

During the Vercel→Pages window, **keep the old Vercel origin in the list** until
that project is deleted, or the first client on stale DNS gets an opaque
"Failed to fetch". Drop it afterwards.

## 5. Not a secret, and not normally set

`BGB_JS_GZIP_BUDGET` overrides the gzipped-size ceiling
`scripts/bgb-bundle.mjs` enforces on the deploy bundle (default 460800, i.e.
450 KB). It exists so the gate is raised deliberately and visibly, in a commit
with a reason, rather than by someone editing the script. Set it as a
workflow-level `env:` in `deploy-bgb-web.yml` if that day comes.
