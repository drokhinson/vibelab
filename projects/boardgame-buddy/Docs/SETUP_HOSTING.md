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
3. **Settings → Deploy → Custom Start Command.** Paste exactly this:

   ```
   uvicorn main:app --host 0.0.0.0 --port $PORT
   ```

   **Never put a filename in that field.** `railway.toml` is a config file, not
   a script — it is mode 644 and bash cannot execute it. A start command of
   `railway.toml` produces
   `/bin/bash: line 1: ./railway.toml: Permission denied`, restarting forever,
   which the edge reports as a 502 "Application failed to respond" with nothing
   about the real cause. There is no Python in that log at all.

   The repo does ship `railway.toml` (and a `Procfile`) declaring the same
   command, and Railway may pick one up on its own — but **set the field
   explicitly anyway.** Config-file discovery depends on the Root Directory and
   the config-path setting, and an explicit command works either way. When the
   field is set, `railway.toml`'s `healthcheckPath` and `restartPolicy` may not
   be applied, so set **Healthcheck Path** to `/api/v1/health` by hand in the
   same screen.
4. **Settings → Networking → Generate Domain** for a `*.up.railway.app` URL to
   test against, then **Custom Domain** → `api.bgbuddy.app`. Railway gives you a
   CNAME target; add it in Cloudflare (§3.1) as **DNS-only (grey cloud)** for
   now — proxying an API through Cloudflare is fine later, but one variable at a
   time.

   **Set the target port on every domain to match what uvicorn bound**, which
   the startup line names: `Uvicorn running on http://0.0.0.0:8080` means 8080.
   Each domain carries its own port and Railway guesses it — a wrong guess
   yields a 502 that looks identical to a dead app, because the *internal*
   healthcheck does not go through the edge and keeps passing. Both domains
   need it set, not just the custom one.

   **The internal-200 / external-502 split is the whole diagnostic.** A
   `GET /api/v1/health 200` from a `100.64.x.x` client in the deploy log beside
   a 502 from curl means the app is fine and the edge is dialling the wrong
   port. Read it that way rather than going back through the app's env vars.
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
2. **Read the Record type column it shows you — it differs by domain shape, and
   guessing costs a day.** For a **subdomain** like `auth.bgbuddy.app` the flow
   gives a single **CNAME** whose value is the site's own hostname
   (`<site-id>.web.app`); that one record both verifies ownership and serves the
   handler. An **apex** domain instead gets a `hosting-site=<site-id>` **TXT**
   to verify, followed by A/AAAA records to go live.

   For the CNAME case: Host `auth`, value `<site-id>.web.app`.

   **Do not leave a TXT record on the same name as the CNAME.** A CNAME may not
   coexist with other record types at one name — resolution becomes undefined,
   and Firebase's check can keep failing even after the CNAME is right. Most DNS
   panels will let you create both without warning. Delete the TXT first.

3. **Set the record to DNS-only (grey cloud)** if DNS is in Cloudflare. Firebase
   provisions its own certificate and Cloudflare proxying in front of that
   challenge fails it. This is the one record that must not be proxied.
4. Verify the record resolves before clicking Verify:
   `nslookup -type=CNAME auth.bgbuddy.app 8.8.8.8`. A short TTL makes this
   minutes rather than the 24 hours the console's failure message quotes.
5. Wait for Firebase to report the domain **Connected** and the certificate
   issued. This is usually under an hour but can take up to 24.

   **Never delete the record Firebase asked for**, after verification or ever.
   It is what authorises certificate renewal, not just the initial check —
   removing it breaks SSL months later, in a way that is miserable to diagnose.
6. GCP console → **Identity Platform → Settings → Authorized Domains** → add
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
(add it in Cloudflare). This is what lets `bgbuddy.app` be an Authorized domain
in §2.4 at all, so it gates the branding form rather than the sign-in.

Then in the OAuth consent screen, **submit for verification**.

**This review is not a launch blocker, and an earlier version of this file said
it was.** BoardgameBuddy requests only non-sensitive scopes (email, profile,
openid). An app with those scopes, published to production, serves unlimited
users with no verification step and does *not* show the "unverified app"
warning — that screen is for sensitive and restricted scopes (Gmail, Drive,
contacts). What the review actually gates here is **brand verification**, which
uploading a logo triggers: until it clears, the consent screen renders without
the logo.

So submit it and carry on. It takes days, it costs nothing to have running, and
nothing downstream waits on it. Only add a sensitive scope after re-reading
this section — that is the change that would turn the review into a real gate.

### 2.6 Get the client config

This one is the **Firebase** console, not the GCP console — §2.3 was GCP, and
the web-app config only exists on the Firebase side.

**Project settings** (gear next to Project Overview) → **General** → scroll to
**Your apps**. If a web app is already listed, open it and pick the **Config**
radio rather than adding a second one. Otherwise **`</>`** → nickname
`bgbuddy-web` → Register.

**Leave "Also set up Firebase Hosting for this app" unchecked** — Hosting is
already configured for `auth.bgbuddy.app` in §2.2, and checking it can
provision a second site with the auth handler on only one of them.

Four of the six values it prints are the ones that matter:

```js
{ apiKey, authDomain: "auth.bgbuddy.app", projectId, appId }
```

`authDomain` should already read `auth.bgbuddy.app` — once Hosting has a
connected custom domain, the console substitutes it into the snippet. **Check
it anyway.** If it still reads `<project-id>.firebaseapp.com`, override it by
hand: that field alone decides the hostname the user sees during Google
sign-in, and leaving it at the default wastes the whole of §2.2.

`apiKey` is **not** a secret — it identifies the project and authorizes nothing
(Authorized Domains and the provider config are what gate access), so all four
live in `config.js` as repo **variables**, not secrets.

**Do not carry `storageBucket` or `messagingSenderId`.** The first is Firebase
Storage, and photos live on Supabase Storage today and R2 after Stage 4 — a
third storage backend nobody reads. The second is FCM, and BoardgameBuddy does
web push directly with its own VAPID keypair, which is why `BGB_VAPID_*` must be
copied verbatim and never regenerated.

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

### 3.1 DNS — moving the zone to Cloudflare

Transferring the *registration* is optional. Moving the *DNS* is not, and not
only for the apex:

| Need | Possible on a registrar's own DNS? |
|---|---|
| apex → Pages | only via an `ALIAS`/`ANAME` record, off the documented path |
| **§3.5 www→apex redirect rule** | **No** — Redirect Rules exist only for zones on Cloudflare |
| **`img.bgbuddy.app` → R2 (Stage 4)** | **No** — an R2 custom domain requires the zone in the same account |

The last one settles it. R2's $0 egress *on a custom domain* is the whole
economic argument for this stack, and the fallback (`r2.dev`) is rate-limited
and not for production use.

**The risk is the flip, not the destination.** The moment the nameservers
change, Cloudflare is authoritative and **any record not already in Cloudflare
stops resolving**. By this point `auth` and `api` are both live and load-bearing.
Cloudflare's import scan usually catches them, but it is not guaranteed, and it
defaults CNAMEs to **proxied** — which is wrong for both, and for `auth` breaks
the certificate challenge.

Order, and step 4 is the one that matters:

1. **Inventory the registrar's records first** — every host, type and value.
   That list is both the checklist for step 4 and the rollback reference.
2. **Find out whether mail is live, and do not trust the registrar's DNS panel
   to tell you.** Namecheap's Advanced DNS list shows only the forwarder's SPF
   `TXT` while its Email Forwarding preset is on; the five
   `eforward*.registrar-servers.com` **MX records are not in that list** and
   surface only in Cloudflare's scan. Reading the panel alone says "no mail on
   this domain", which is wrong.

   Then **do not carry those MX records over.** A registrar's free forwarding
   requires the domain to be on *its* nameservers, so moving the records moves
   the records and not the service: mail resolves and then vanishes, which is
   worse than no MX at all. **Cloudflare Email Routing** replaces it (§3.5) with
   no nameserver dependency.

   Before flipping, open the registrar's **Email Forwarding** tab and write down
   every alias and its destination — that config does not come across, and
   after the flip the panel is no longer the place it lives.
3. **Add the site to Cloudflare** (Add a site → Free plan → it scans).
4. **Audit the scan against the inventory and set the proxy flags**, *before*
   touching the nameservers. `auth` and `api` both grey. Fixing this afterwards
   means an outage window you chose not to avoid.

   The scan marks CNAMEs **Proxied**, which draws *"This hostname is not covered
   by a certificate"* on both. That warning is about the proxy, not the record:
   a proxied hostname needs Cloudflare to hold a cert for it, and Universal SSL
   is not issued until the zone is Active. Setting the record to **DNS only**
   retires the question — Cloudflare then never terminates TLS and the origin
   serves its own certificate. (Universal SSL's `*.<zone>` does cover a
   single-level host like `api`, so proxying later is available; it is just one
   more variable than a cutover needs.)
5. **Change the nameservers at the registrar** to the two Cloudflare supplies.
6. **Wait for Cloudflare to report the zone Active.**
7. **Re-verify** before moving on — both CNAMEs resolve via `8.8.8.8`, the API
   health endpoint answers, and `https://auth.bgbuddy.app` still serves the
   Firebase handler rather than a certificate error. A cert error there means
   the record got proxied.
8. **Leave the old records at the registrar.** They are inert once the
   nameservers move, and they are the written record of what was there.

**Do not carry every record across — three kinds must be dropped.** The
registrar's zone accumulates records for hosts that are moving to a different
provider, and carrying them forward is how the apex ends up claimed by two
services at once:

| Drop | Why |
|---|---|
| any record at the **apex** pointing somewhere other than Pages | §3.3 writes the apex itself; a leftover CNAME there wins |
| `_acme-challenge` for a host that is moving | it delegates certificate validation to the OLD provider, which can block the new one from issuing |
| the registrar's own SPF (`include:spf.*.registrar-servers.com` and friends) | it authorizes a forwarder that is no longer in the path, and Email Routing writes its own — two SPF records at one name is itself broken |

Carry anything that proves ownership of a host that is **staying**, which is
easy to overlook because it is not the record doing the serving: Railway issues
a `TXT _railway-verify.<host>` alongside the CNAME, and losing it un-verifies
the custom domain.

**A CNAME at the apex is the specific thing to look for.** A `CNAME @`
**cannot legally coexist with the `TXT @`** that SPF or a Search Console token
needs — RFC 1034: a CNAME excludes every other type at that name. Registrar
panels create both without complaint, and resolution is then undefined. The
live zone had exactly that, plus a matching `_acme-challenge` CNAME, both
pointing at the Firebase site.

**Check what actually claims such a record before assuming.** The obvious
reading — that the apex had been added to Firebase Hosting — was wrong:
Hosting → Domains listed only `auth.bgbuddy.app`, so both records were orphans
from an earlier round of setup with nothing renewing against them. One glance
at the provider's own domain list settles it, and the answer changes the work:
an orphan needs no de-registration, a live claim does.

Either way the records do not come across, and Cloudflare's scan skips an apex
CNAME on its own. Two consequences worth knowing: the illegal `CNAME @` is also
why the scan cannot see `TXT @` (it reads as undefined), and §2.5's apex TXT
cannot be added until that CNAME is gone.

§3.2, §3.3 and §3.5 all require the zone to be Active. Do not start them early.

Records you will end up with:

| Name | Type | Target | Proxy |
|---|---|---|---|
| `bgbuddy.app` | CNAME | the Pages project | **Proxied** (orange) |
| `www` | CNAME | the Pages project | **Proxied** |
| `api` | CNAME | Railway's target | **DNS only** (grey) at first |
| `auth` | **CNAME** (subdomain flow) | `<site-id>.web.app` | **DNS only** — required |
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

**Email Routing, while you are here.** §2.4 needs a reachable support address
and both legal pages name `privacy@bgbuddy.app` and `support@bgbuddy.app`. With
the zone on Cloudflare, **Email Routing** (free) creates both as forwards to a
real mailbox and writes the MX records itself. Do it before submitting the
consent screen — Google checks the support address, and a bounce is a rejection
for a reason that has nothing to do with the app.

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
| `BGB_COMING_SOON` | `true` until launch — serves the waitlist landing instead of the app |
| `BGB_FIREBASE_API_KEY` | from §2.6 |
| `BGB_FIREBASE_AUTH_DOMAIN` | `auth.bgbuddy.app` |
| `BGB_FIREBASE_PROJECT_ID` | from §2.6 |
| `BGB_FIREBASE_APP_ID` | from §2.6 |

The four `BGB_FIREBASE_*` values are variables rather than secrets because none
of them is one — see §2.6. Set **all four or none**: the workflow fails on a
partial set, because three-of-four looks configured and breaks at sign-in. An
empty set only warns, since the app still uses the Supabase Auth SDK until the
frontend swap.

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

### The Vercel bridge, and why there is no dress rehearsal

`deploy-bgb-web.yml` carries a `workflow_dispatch` trigger, but that does
**not** let you deploy Pages before merging. GitHub only offers the Run
workflow button for a workflow whose file exists on the *default* branch, so
while this work sits on a feature branch the workflow is invisible in the
Actions list — it has never run and it is not on `main`. Step 11 is therefore
the first Pages deploy, with no rehearsal.

`deploy-bgb-web-vercel.yml` is the counterweight: the same four build steps
ending at Vercel instead of Pages, dispatch-only. After step 11 it is the only
path left that can ship a frontend fix to the old host, because that same merge
removes boardgame-buddy from `deploy-frontend.yml`'s change detection and moves
the bundler to `projects/boardgame-buddy/scripts/`. It must never gain a push
trigger — two hosts building the same commit is not a fallback, it is a
coin flip. Delete it at step 15 alongside the Vercel project.

### One local-only caveat

`pip install` of `pywebpush` fails in some sandboxes with
`AttributeError: install_layout` while building `http-ece`, which ships no
wheel. That is Debian's patched setuptools, not a packaging problem — GitHub
Actions and Railway both build it fine, which the existing shared-backend
deploys already prove. If you hit it locally, install the rest of
`requirements.txt` without `pywebpush`; only the push tests need it.

Still to come, and not in this file: R2 (`img.bgbuddy.app`), the frontend swap
from the Supabase Auth SDK to Firebase, and the user import. See
`MIGRATION_PLAN.md`.

### The two pages Google's review needs

§2.4 asks for a privacy policy and terms URL, and **Google gates the brand
review on both actually resolving.** That makes the real critical path:

```
Pages live (§3.2-3.3) -> /privacy + /terms resolve -> submit §2.4 -> days of queue
```

The Search Console TXT in §2.5 can go in today, since it needs only DNS. The
consent-screen *submission* cannot — it needs the pages on a live host.

Both now exist, at `https://bgbuddy.app/privacy` and `https://bgbuddy.app/terms`
(`web/views/privacy-view.js` and `terms-view.js`, sharing `legal-view.js`). Two
things about them:

- **They resolve while `BGB_COMING_SOON` is on.** The pre-launch gate in
  `init.js` lets exactly these two routes through instead of redirecting to the
  waitlist. Without that, the reviewer would see the waitlist and read it as
  "no policy". Do not "simplify" that branch.
- **`terms-view.js` will not publish cleanly until `JURISDICTION` is set.** It
  is empty on purpose and the page renders a warning banner where the
  governing-law clause belongs, so an unset value is visible rather than
  silent. Set it to the state or country whose law applies.

Two facts in the privacy policy are disclosures of current behaviour rather
than of intent, and both should be **fixed in code** rather than left described:

| Disclosed | The code | Fix |
|---|---|---|
| Play photos are readable by anyone with the link | `play_routes.py` uses `get_public_url()` on an unguessable `uuid4` path | signed URLs, or a private bucket behind the API |
| Deleting a play or an account leaves the image file | `delete_play` / `delete_profile` remove rows only; no `storage.remove()` exists anywhere | delete the object alongside the row |

When either lands, simplify the matching paragraph in §4 or §7 of the policy —
not before.
