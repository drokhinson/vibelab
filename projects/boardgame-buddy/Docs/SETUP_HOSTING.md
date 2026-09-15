# bgbuddy.app — GCP, Cloudflare and CORS setup

Console-by-console setup for BoardgameBuddy's own hosting. Everything here is
work in a web UI or a dashboard — nothing in this file is done by a commit.

Domain: **bgbuddy.app**. Written 2026-09-15.

> **Read this first.** The isolation commits removed BoardgameBuddy from
> `shared-backend`. The moment they merge to `main`, Railway redeploys that
> service **without BoardgameBuddy's routes**, and the live app on Vercel breaks
> — every request 404s.
>
> So do **§1 (the Railway service) and §5.1 (`BGB_API_BASE`) before merging.**
> Nothing else in this file is time-critical; those two are.

---

## 0. The four hostnames

| Host | Serves | Set up in |
|---|---|---|
| `bgbuddy.app` | the web app, Cloudflare Pages | §3 |
| `www.bgbuddy.app` | redirect to apex | §3.5 |
| `api.bgbuddy.app` | the FastAPI service | §1.4 |
| `auth.bgbuddy.app` | GCP Identity Platform's auth handler | §2 |
| `img.bgbuddy.app` | R2 photos and cover art | later — Stage 4 |

DNS for all of them lives in Cloudflare (§3.1). Do that first if the domain is
registered elsewhere.

---

## 1. Railway — BoardgameBuddy's own API service

**Do this before merging.** The new service runs beside the existing
`shared-backend` one, from the same repo, at a different root.

1. Railway → the project → **+ New** → **GitHub Repo** → `drokhinson/vibelab`.
2. The new service → **Settings → Source**:
   - **Root Directory**: `projects/boardgame-buddy/api`
   - **Branch**: `main`
3. **Settings → Deploy**: confirm it picked up `railway.toml` — start command
   `uvicorn main:app --host 0.0.0.0 --port $PORT`, healthcheck
   `/api/v1/health`. Set the start command by hand if not.
4. **Settings → Networking → Generate Domain** for a `*.up.railway.app` URL to
   test against, then **Custom Domain** → `api.bgbuddy.app`. Railway gives you a
   CNAME target; add it in Cloudflare (§3.1) as **DNS-only (grey cloud)** for
   now — proxying an API through Cloudflare is fine later, but one variable at a
   time.
5. **Variables** — copy every value from the existing service, and **do not
   regenerate any of them**:

   | Variable | Note |
   |---|---|
   | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | same project for now |
   | `ADMIN_API_KEY` | |
   | `BGB_QR_SECRET` | **copy, never regenerate** — it is the revocation lever for every outstanding add-a-buddy QR code |
   | `BGB_VAPID_PUBLIC_KEY`, `BGB_VAPID_PRIVATE_KEY` | **copy both, never regenerate** — they are one keypair, and a new pair silently stops delivery to every existing push subscription |
   | `BGB_VAPID_SUBJECT` | |
   | `BGG_API_TOKEN`, `BGG_CREDENTIAL_KEY` | `BGG_CREDENTIAL_KEY` is the Fernet key for stored BGG passwords — copying it is what keeps them decryptable |
   | `BGG_PUSH_DRY_RUN` | **leave set to `true`** |
   | `BGG_WEB_USER_AGENT`, `BGG_THROTTLE_SECONDS`, `BGG_PUSH_THROTTLE_SECONDS` | |
   | `GEMINI_API_KEY` | |
   | `ALLOWED_ORIGINS` | see §5 — this one is **not** a straight copy |

6. Verify: `curl https://api.bgbuddy.app/api/v1/health` → `{"status":"ok","service":"bgbuddy"}`,
   and `https://api.bgbuddy.app/docs` lists only BoardgameBuddy + analytics.

Leave the old service running and still serving the other eight apps. Once
BoardgameBuddy's variables are live on the new service, delete the `BGB_*` and
`BGG_*` ones from the old one.

---

## 2. GCP Identity Platform — branded auth on `auth.bgbuddy.app`

Free for the first 50,000 monthly active users on tier-1 providers (email,
phone, social). **Start §2.5 on day one** — Google's brand review is the only
step here with a queue you do not control, and it takes business days.

### 2.1 Project and API

1. Google Cloud console → create a project, e.g. `bgbuddy`. Note the **project
   ID** — it becomes the JWT `aud`, so the backend needs it as `GCP_PROJECT_ID`.
2. **Identity Platform** → **Enable**. (If it offers "Identity Platform" vs
   "Firebase Authentication with Identity Platform", either is fine — they are
   the same backend; Identity Platform is the GCP-console face of it.)
3. **Providers → Add provider**:
   - **Email/Password** — enable. Turn on email verification.
   - **Google** — enable. It creates an OAuth client, or lets you pick one.

### 2.2 The auth handler domain — this is the branded bit

Enabling Identity Platform auto-creates a Firebase Hosting site at
`<project-id>.firebaseapp.com`, and by default **that** is the host in the OAuth
redirect — which is the unbranded string you are trying to get rid of. Replace
it:

1. **Firebase console** (same project) → **Hosting** → **Add custom domain** →
   `auth.bgbuddy.app`.
2. It gives you a TXT record to verify ownership, then an A/AAAA or CNAME target.
   Add both in Cloudflare (§3.1). **Set these records to DNS-only (grey
   cloud)** — Firebase provisions its own certificate and Cloudflare proxying in
   front of that fails the challenge.
3. Wait for Firebase to report the domain **Connected** and the certificate
   issued. This is usually under an hour but can take up to 24.
4. GCP console → **Identity Platform → Settings → Authorized Domains** → add
   `auth.bgbuddy.app` and `bgbuddy.app`.

Firebase Hosting's free tier covers this — it is serving one auth handler, not a
site.

### 2.3 Point the OAuth client at your domain

**Check for an existing client first.** Enabling the Google provider in §2.1
auto-creates a web OAuth client — look in **APIs & Services → Credentials** for
*"Web client (auto created by Google Service)"* and edit that one. Creating a
second leaves you with two client IDs and no clear answer about which is
canonical.

If you do create one: **Application type = Web application.** Not Android — the
package-name and SHA-1-fingerprint fields only appear under Android, and
BoardgameBuddy is a PWA with no native app. A web client must never be used for
a native app later either; each platform gets its own (see §2.8).

**Name**: `bgbuddy-web`. This is an **internal label** that users never see —
the name on the consent screen is the App name in §2.4. Naming it per-platform
keeps it straight once `bgbuddy-android` exists.

**Authorized JavaScript origins**:

```
https://bgbuddy.app
https://www.bgbuddy.app
https://bgbuddy.pages.dev
http://localhost:5500
```

**Authorized redirect URIs**:

```
https://auth.bgbuddy.app/__/auth/handler
```

Keep the auto-created `https://<project-id>.firebaseapp.com/__/auth/handler`
alongside it until the custom domain is confirmed working — it is the fallback
while `auth.bgbuddy.app` is still provisioning.

### 2.4 Branding

**APIs & Services → OAuth consent screen** (newer consoles: **Google Auth
Platform → Branding**):

- App name: `BoardgameBuddy` — this is the string on the consent screen
- Logo: `web/assets/brand/bgb-logo.svg` rasterised to PNG (120×120 min)
- Support email, app home page `https://bgbuddy.app`, privacy policy and terms
  URLs — **Google requires these two to be reachable**, so they gate the review
- Authorized domain: `bgbuddy.app`
- User type: **External**, then **Publish app**

### 2.5 Domain verification — start this first

**Google Search Console** → add `bgbuddy.app` as a property → verify by DNS TXT
(add it in Cloudflare). Until this is verified, the consent screen keeps showing
an unverified-app warning no matter what else is configured.

Then in the OAuth consent screen, **submit for verification**. Because this only
uses basic scopes (email, profile, openid) it should clear quickly — but "quickly"
is still days, which is why it goes first.

### 2.6 Get the client config

Firebase console → **Project settings → General → Your apps → Add app → Web**.
It gives you the config the frontend needs:

```js
{ apiKey, authDomain: "auth.bgbuddy.app", projectId, appId }
```

Set `authDomain` to `auth.bgbuddy.app`, **not** the default
`<project-id>.firebaseapp.com` — that field is what decides the host the user
sees. `apiKey` is not a secret (it identifies the project; it authorizes
nothing), so it can live in `config.js`.

### 2.7 Wire it into Supabase — not optional

Three RLS policies on the live play-session tables use `auth.uid()`, and the
client reads those tables directly with the anon key. Under a Google-issued JWT
they fail closed and **the spectator mirror goes blank with nothing else looking
wrong**.

Supabase dashboard → **Authentication → Third-party Auth** → add a **Firebase**
integration with the GCP project ID. Then check what Supabase bills as
**TP-MAU** (third-party monthly active users) — it is metered separately from
its own auth MAU, and it is the one line that could stop this path from being
$0 on the Supabase side.

---

### 2.8 When native apps arrive

Each platform needs its **own** OAuth client; the web one is not reused as the
app's client — though it *is* still needed, because Firebase's Google Sign-In on
Android passes the **web** client ID as its `serverClientId`.

**Android** asks for two things the web client does not:

- **Package name** — `app.bgbuddy`, the reverse-DNS of the domain. Choose it
  once: it is **immutable after the first Play release**.
- **SHA-1 certificate fingerprint** — one per signing certificate that will ever
  produce a build, and all of them must be registered:

  | Certificate | Where to get it |
  |---|---|
  | Debug keystore (local dev) | `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android` |
  | Upload key | `eas credentials`, if Expo manages the keystore |
  | **Play App Signing certificate** | Play Console → Test and release → Setup → App signing |

  The last one is the trap: **Google re-signs the AAB**, so the certificate on
  users' devices is Google's, not the upload key's. Register only the upload key
  and Google Sign-In works perfectly in development and fails for every real
  user in production.

**iOS** asks for a bundle ID (`app.bgbuddy`) and no fingerprint.

## 3. Cloudflare — DNS and Pages

### 3.1 DNS

If `bgbuddy.app` is registered elsewhere, add the site to Cloudflare first
(**Add a site** → it reads your existing records → change the nameservers at
your registrar). Transferring the registration is optional; only the DNS has to
be here.

Records you will end up with:

| Name | Type | Target | Proxy |
|---|---|---|---|
| `bgbuddy.app` | CNAME | the Pages project | **Proxied** (orange) |
| `www` | CNAME | the Pages project | **Proxied** |
| `api` | CNAME | Railway's target | **DNS only** (grey) at first |
| `auth` | per Firebase | Firebase Hosting | **DNS only** — required |
| `@` | TXT | Google Search Console token | n/a |

Pages adds the apex and `www` records itself in §3.3.

### 3.2 Create the Pages project

Cloudflare dashboard → **Workers & Pages → Create → Pages → Upload assets**.

- Project name: **`bgbuddy`** — this must match `--project-name` in
  `.github/workflows/deploy-bgb-web.yml`.
- Upload anything to create it (a single `index.html` is fine). The real deploys
  come from CI.

**Use Direct Upload, not the Git integration.** The artifact is built by three
steps that must run in order — Tailwind precompile, bundle, then stamp `sw.js`
— and Cloudflare's own build step cannot reproduce them. If you connect Git
here, Cloudflare will also deploy on every push and race the CI deploys.

### 3.3 Custom domain

Pages project → **Custom domains → Set up a custom domain** → `bgbuddy.app`.
Since DNS is already in Cloudflare it wires the record itself and issues the
certificate. Add `www.bgbuddy.app` the same way.

### 3.4 API token for CI

**My Profile → API Tokens → Create Token → Custom token**:

- Permissions: **Account → Cloudflare Pages → Edit**
- Account Resources: your account
- No zone permissions needed for Pages deploys

Copy the token, and the **Account ID** from the dashboard sidebar.

### 3.5 www → apex redirect

**Rules → Redirect Rules → Create rule**: if hostname equals `www.bgbuddy.app`,
then dynamic redirect to
`concat("https://bgbuddy.app", http.request.uri.path)`, status 301, preserve
query string.

Serving the app on both hosts instead would mean two origins in
`ALLOWED_ORIGINS`, two service-worker registrations and split `localStorage`.
Redirect, don't serve.

### 3.6 Do NOT touch yet

Leave **Auto Minify**, **Rocket Loader** and **Mirage** off. `bgb-bundle.mjs`
already minifies and content-hashes, and Rocket Loader defers scripts in a way
that breaks the pre-paint inline theme/layout boot in `index.html`.

---

## 4. GitHub — secrets and the API base

Repo → **Settings → Secrets and variables → Actions**.

**Secrets** (New repository secret):

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | from §3.4 |
| `CLOUDFLARE_ACCOUNT_ID` | from §3.4 |

`VIBELAB_SUPABASE_URL` and `VIBELAB_SUPABASE_ANON_KEY` already exist and are
reused.

**Variables** tab (not Secrets):

| Name | Value |
|---|---|
| `BGB_API_BASE` | `https://api.bgbuddy.app` |

A variable rather than a secret deliberately: it is not sensitive, and the
backend gets re-pointed several times across this migration (shared Railway →
BoardgameBuddy's Railway → Hetzner). `deploy-bgb-web.yml` fails loudly if it is
unset rather than shipping a `config.js` pointing nowhere.

**Set `BGB_API_BASE` before merging** — see the warning at the top.

---

## 5. `ALLOWED_ORIGINS` — the answer

This is a **browser-origin allowlist**, so it holds scheme + host (+ port) only:
no paths, **no trailing slashes**, comma-separated, no spaces.

### 5.1 During the cutover — put this on the new Railway service

```
https://bgbuddy.app,https://www.bgbuddy.app,https://bgbuddy.pages.dev,https://boardgame-buddy.vercel.app,http://localhost:5500,http://127.0.0.1:5500
```

Line by line:

| Entry | Why |
|---|---|
| `https://bgbuddy.app` | the app |
| `https://www.bgbuddy.app` | the redirect in §3.5 is a 301, but a preflight can still arrive on this host before it |
| `https://bgbuddy.pages.dev` | the Pages URL — this is how you test §3.2 before DNS is live |
| `https://boardgame-buddy.vercel.app` | **the old origin. Keep it until the Vercel project is deleted** — a client on stale DNS otherwise gets an opaque "Failed to fetch" rather than an error anyone can debug. Substitute your real Vercel hostname. |
| `http://localhost:5500` `http://127.0.0.1:5500` | local dev; both, because they are different origins to a browser |

### 5.2 After Vercel is deleted

```
https://bgbuddy.app,https://www.bgbuddy.app,https://bgbuddy.pages.dev,http://localhost:5500,http://127.0.0.1:5500
```

### 5.3 What does NOT belong in it

- **`api.bgbuddy.app`** — the API is the thing checking the header, not an
  origin the app's JS is served from.
- **`auth.bgbuddy.app`** and **`img.bgbuddy.app`** — not origins either. The
  auth handler is navigated to, and images load as `<img>`, neither of which is
  a CORS request against this API.
- **Anything with a path or trailing slash.** `main.py` splits on commas and
  strips whitespace but does not normalise a trailing slash, and the browser
  compares origins byte-for-byte — `https://bgbuddy.app/` silently matches
  nothing.
- **`*`.** `allow_credentials=False`, so a wildcard would technically work, but
  it would let any site's JS read every authenticated response body using a
  token it stole from somewhere else.

A preflight also has to survive the middleware order, which is why
`CORSMiddleware` sits inside `GZipMiddleware` and the `APIError` handler exists
— see `api/main.py`. If you get CORS errors on 500s specifically, that handler
is the thing to look at, not this list.

---

## 6. Order of operations

### Why the merge is the dangerous step

Merging changes `shared-backend/**`, so Railway redeploys that service **without
BoardgameBuddy's routes**. Meanwhile the live app is still the last build Vercel
received, and its `config.js` has the *old* Railway origin baked in. So at the
moment of merge, the live app points at an API that no longer serves it — and
because `deploy-frontend.yml` no longer builds this project, CI will not push a
corrected `config.js` to Vercel either.

**The fix is one switch: turn OFF auto-deploy on the existing `shared-backend`
Railway service before merging.** It then keeps serving its current image —
BoardgameBuddy routes included — until you deliberately redeploy it. That gives
you a window where old and new both work, and nothing is racing DNS.

```
BEFORE MERGING
  1. Railway → existing shared-backend service → Settings → disable Auto Deploy.
     It keeps running the image it has, still serving BGB. This is what makes
     the merge safe.
  2. §1  Create the BGB Railway service (Root Directory
         projects/boardgame-buddy/api), copy every variable, never regenerating
         the VAPID pair, BGB_QR_SECRET or BGG_CREDENTIAL_KEY.
  3. §4  Set BGB_API_BASE, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID.
         Without these the web workflow fails on the merge commit — harmless,
         but it means no Pages deploy.
  4. §3.2 Create the Pages project named exactly `bgbuddy`.
  5. §5.1 ALLOWED_ORIGINS on the NEW service, old Vercel origin included.
  6. Verify: curl https://api.bgbuddy.app/api/v1/health

ANY TIME — start §2.5 first, it is days of queue you do not control
  7. §2.5 Search Console domain verification
  8. §2.1-2.4 Identity Platform, auth.bgbuddy.app, branding
  9. §3.1 DNS in Cloudflare (nameservers first if the domain is elsewhere)
 10. §2.7 Supabase third-party auth + check the TP-MAU billing line

MERGE
 11. Merge. CI deploys web → Pages and runs the API tests.
 12. Verify on bgbuddy.pages.dev against the NEW api. The old Vercel app is
     still up and still working — that is the point of step 1.
 13. Point bgbuddy.app at Pages (§3.3). Watch 24h.

AFTER THE CUTOVER HOLDS
 14. Re-enable Auto Deploy on shared-backend and let it redeploy. It loses the
     BoardgameBuddy routes here, which is now fine — nothing points at it.
 15. Delete the Vercel project; drop its origin from ALLOWED_ORIGINS; delete
     the BGB_*/BGG_* variables from the old Railway service.
```

Steps 1 and 14 are a matched pair. If you skip step 1, you are relying on
finishing steps 11-13 faster than Railway finishes a deploy, which is not a
plan.

### One local-only caveat

`pip install` of `pywebpush` fails in some sandboxes with
`AttributeError: install_layout` while building `http-ece`, which ships no
wheel. That is Debian's patched setuptools, not a packaging problem — GitHub
Actions and Railway both build it fine, which the existing shared-backend
deploys already prove. If you hit it locally, install the rest of
`requirements.txt` without `pywebpush`; only the push tests need it.

Still to come, and not in this file: the landing view with the `COMING_SOON`
gate, R2 (`img.bgbuddy.app`), the frontend swap from the Supabase Auth SDK to
Firebase, and the user import. See `MIGRATION_PLAN.md`.
