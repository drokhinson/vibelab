# bgbuddy.app — GCP, Cloudflare and CORS setup

Console-by-console setup for BoardgameBuddy's own hosting. Everything here is
work in a web UI or a dashboard — nothing in this file is done by a commit.

Domain: **bgbuddy.app**. Written 2026-09-15, cutover completed 2026-09-16.

> **This is now a record, not a runbook.** Every section below has been done:
> the app serves from Cloudflare Pages at `bgbuddy.app`, the API from its own
> Railway service at `api.bgbuddy.app`, auth from GCP Identity Platform at
> `auth.bgbuddy.app`, and the retired Vercel origin serves the static notice in
> `projects/boardgame-buddy/moved/`. The pre-launch `COMING_SOON` gate is gone.
>
> Two things are still open, and neither is a hosting step:
>
> * **§3.8 Email Routing.** `privacy@` and `support@` have no MX behind them,
>   so both bounce — and the privacy policy points deletion requests at one of
>   them. The Cloudflare panel did not offer Email Routing on this zone;
>   ImprovMX or Zoho on the same DNS is the fallback.
> * **The waitlist.** `boardgamebuddy_waitlist` still holds the addresses of
>   people who asked to be told at launch, and the privacy policy says that
>   list is deleted after the launch email. The table, `waitlist_routes.py` and
>   its test come out together once that mail has gone.
>
> Read it for *why* a thing is the way it is — most sections carry the
> correction that doing it for real produced. Do not read it as a to-do list.

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
   worse than no MX at all. **Cloudflare Email Routing** replaces it (§3.8) with
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
| `@` | MX × 3 | the three `*.mx.cloudflare.net` hosts Email Routing picks | n/a |
| `@` | TXT | `v=spf1 include:_spf.mx.cloudflare.net ~all` | n/a |
| `_dmarc` | TXT | `v=DMARC1; p=reject; …` (§3.8) | n/a |

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

**Mail on the domain is §3.8**, and it is not optional: both legal pages print
`privacy@bgbuddy.app` and `support@bgbuddy.app`, and with no MX at the apex both
of those bounce.

### 3.6 Do NOT touch yet

Leave **Auto Minify**, **Rocket Loader** and **Mirage** off. `bgb-bundle.mjs`
already minifies and content-hashes, and Rocket Loader defers scripts in a way
that breaks the pre-paint inline theme/layout boot in `index.html`.

### 3.7 SSL — two settings, and neither is on by default

**SSL/TLS → Overview → encryption mode** must be **Full (strict)**.

`Flexible` is the one to avoid, and its symptom is that there is no symptom:
the browser still shows a padlock, because browser→Cloudflare is genuinely
HTTPS. What it does is make Cloudflare→origin plain HTTP, so every request
crosses the public internet unencrypted on the far side of the edge while
looking perfectly secure in the address bar. Full (strict) is correct for
Pages, and for anything on Railway, because both present a valid certificate.

**SSL/TLS → Edge Certificates → Always Use HTTPS** must be **On**.

Off is the default on a new zone. With it off, `http://bgbuddy.app` is served
over HTTP rather than redirected, and the browser marks the page **Not
secure** — which is what a bare `bgbuddy.app` typed into an address bar can
still resolve to. Turn on **Automatic HTTPS Rewrites** in the same panel while
you are there.

Neither setting reaches `api` or `auth`. Both are DNS-only (§3.1), so their
traffic never touches the Cloudflare edge — Railway and Firebase Hosting each
issue their own certificate and do their own HTTP→HTTPS redirect. That is
expected, not a gap.

**Leave HSTS off for now.** It is the one setting here that is genuinely hard
to undo: browsers cache the policy for its full max-age and will refuse to
load the domain over HTTP at all, including any hostname you later want to
serve differently. Worth enabling once the domain has been stable for a while,
not during a cutover.

---

### 3.8 Email Routing — free, receive-only, and that last word matters

Both legal pages print an address (`privacy-view.js` → `privacy@bgbuddy.app`,
`terms-view.js` → `support@bgbuddy.app`). Until this is done the apex has no MX
at all, so both bounce — a privacy policy naming a contact that rejects mail is
worse than one naming none.

**Cloudflare dashboard → the `bgbuddy.app` zone → Email → Email Routing.**

1. **Destination address** — the real mailbox the aliases forward to:
   `dev.rokhinson@gmail.com`. Cloudflare emails it a verification link and
   forwards *nothing* until that link is clicked; the link expires, and the
   resend button lives under **Email Routing → Destination addresses**.
2. **Enable** — Cloudflare offers to add the DNS records itself. Take that: it
   writes three `MX` at the apex and the `TXT` SPF record
   `v=spf1 include:_spf.mx.cloudflare.net ~all`. Hand-adding them is how you end
   up with two SPF records at one name, which is itself a broken state.
3. **Custom addresses** — create `privacy@` and `support@`, both → the
   destination above. Two aliases, one mailbox.
4. **Catch-all: leave it off.** These two addresses are about to be printed on
   two public web pages, which is exactly the input a dictionary spam run wants.
   Off means anything else addressed to the domain is rejected at Cloudflare;
   on means it lands in a personal Gmail inbox.

**Why the MX records are legal here at all.** §3.1 spends a page on the fact
that a `CNAME` at the apex excludes every other type at that name — and §3.3
puts the Pages record on the apex. Both are true, and mail still works, because
Cloudflare **flattens** an apex CNAME: it resolves the target itself and answers
`bgbuddy.app` with `A`/`AAAA` records, so there is no CNAME in the response and
`MX`, SPF `TXT` and the Search Console token coexist beside it normally. On a
registrar's own DNS, with a literal CNAME at the apex, adding MX would be the
RFC 1034 violation. One more thing the zone move bought.

**Receive-only is the part to decide now, not on the first reply.** Email
Routing forwards inbound mail and cannot send. Hitting reply in Gmail answers
from `dev.rokhinson@gmail.com` — it does not look like `support@bgbuddy.app`,
and it discloses a personal address to whoever wrote in. Two ways out:

* **Accept it.** Reversible, costs nothing, and for a pre-launch app answering a
  handful of mails a week it is a defensible choice. Just make it knowingly.
* **Send as the alias.** Gmail → Settings → Accounts → *Send mail as* needs SMTP
  credentials for a relay that will authenticate for the domain (Resend,
  Postmark, SES). That relay's SPF `include:` goes into the **existing** SPF
  record as a second `include:`, never as a second record, and its DKIM keys get
  their own `CNAME`s.

**DMARC, while the domain sends nothing.** Publish `_dmarc` as `TXT`:

```
v=DMARC1; p=reject; rua=mailto:dev.rokhinson@gmail.com
```

`p=reject` is the correct posture for a domain with no legitimate sender — it
tells every receiver to discard mail claiming to be from `bgbuddy.app`, which is
the whole spoofing surface of a brand-new domain.

Cloudflare's **DMARC Management** wizard, one item below Email Routing in the
same **Email** section, writes the record and gives you a dashboard of who is
sending as the domain. Two notes on it:

* **Run it after Email Routing is enabled**, not before. It ingests the
  aggregate reports through a routing rule, so with routing off it has nowhere
  to deliver them.
* It writes the policy as `p=none` — report-only, the right default for a domain
  that already has senders to discover. This one has none, so edit the `_dmarc`
  TXT record to `p=reject` afterwards and keep the `rua=` value the wizard
  generated.

The third item in that section, **Email Security**, is the paid Area 1 product:
inbound threat filtering for mailboxes you host yourself. It cannot protect a
Gmail inbox and has nothing to do with forwarding. Skip it.

The trap is in the future: the day a transactional sender is added (password
resets, session invites — the app has none today and will), `p=reject` rejects
*your own* mail until that sender's SPF include and DKIM are aligned. Get those
in place before the first send, not after the first support ticket about a
missing email.

**Verify before moving on.** `nslookup -type=mx bgbuddy.app 8.8.8.8` should list
three `*.mx.cloudflare.net` hosts, and a test message sent from an unrelated
account to `support@bgbuddy.app` should arrive in the destination inbox. Email
Routing's **Overview** tab logs every forward and every rejection, which is the
first place to look if it does not.

**It is not the consent screen's support email.** An earlier draft of this file
said to finish Email Routing before submitting the OAuth consent screen because
"Google checks the support address". That was wrong on both counts: Google's
support-email field is a **dropdown of addresses attached to the signed-in
Google account** — the account's own address, or a Google Group it owns — so a
forwarded alias on a domain cannot be selected there at all, and verification
went through on the Gmail address with no MX on the domain whatsoever. The
deadline for this section is the legal pages going public, not §2.

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

### 5.1 What the Railway service carries

```
https://bgbuddy.app,https://www.bgbuddy.app,https://bgbuddy.pages.dev,http://localhost:5500,http://127.0.0.1:5500
```

Line by line:

| Entry | Why |
|---|---|
| `https://bgbuddy.app` | the app |
| `https://www.bgbuddy.app` | the redirect in §3.5 is a 301, but a preflight can still arrive on this host before it |
| `https://bgbuddy.pages.dev` | the Pages URL — how you test a deploy without touching DNS |
| `http://localhost:5500` `http://127.0.0.1:5500` | local dev; both, because they are different origins to a browser |

**The old Vercel origin has been dropped**, and the reason it could go is worth
keeping: it was in the list so that a client on stale DNS got a debuggable CORS
error rather than an opaque "Failed to fetch". What replaced the app on that
origin is a static notice that makes **no API calls at all** — nothing there
can produce a preflight, so the entry stopped protecting anything the day the
notice went up.

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

### The merge was the dangerous step. It is not any more.

Merging changes `shared-backend/**`, so Railway redeploys that service
**without BoardgameBuddy's routes**. When this section was written that was
the whole problem: `bgbuddy.app` did not exist yet, the Vercel deployment WAS
production, and its `config.js` had the old shared Railway origin baked in —
so the merge pointed the live app at an API that no longer served it, with no
path to push a corrected `config.js` (`deploy-frontend.yml` no longer builds
this project).

The advice was to **turn off auto-deploy on `shared-backend` before merging**,
keeping BoardgameBuddy's routes alive in the running image.

**That is now optional, and the reason it was needed is gone.** `bgbuddy.app`
serves from Pages against `api.bgbuddy.app` — a different Railway service,
untouched by anything that happens to `shared-backend`. The only casualty of
the redeploy is the old Vercel app, which the same cutover replaces with a
static notice (`projects/boardgame-buddy/moved/`).

Two things to hold onto rather than the pause:

- **Dispatch the moved notice right after the merge.** Between the merge and
  that dispatch, the old origin serves a live-looking app whose every request
  404s. Pausing auto-deploy only widens that window; shipping the notice closes
  it.
- **Watch `shared-backend`'s own redeploy.** It is shared with six other
  projects, so the failure that would actually hurt is that service not booting
  — not BoardgameBuddy's routes leaving it. `shared-backend/main.py` imports
  and registers seven routers, none of them BoardgameBuddy, and nothing else
  under `shared-backend/*.py` references the project outside comments, so it
  should come up clean. Hit one other app's health endpoint and confirm.

```
ALREADY DONE — kept here because the order is the argument, not a checklist
   1. §1   The BGB Railway service (Root Directory projects/boardgame-buddy/api),
          every variable copied, the VAPID pair / BGB_QR_SECRET /
          BGG_CREDENTIAL_KEY carried across rather than regenerated.
   2. §4   BGB_API_BASE, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID. Without
          these the web workflow fails on the merge commit — harmless, but it
          means no Pages deploy.
   3. §3.2 The Pages project, named exactly `bgbuddy`.
   4. §5.1 ALLOWED_ORIGINS on the NEW service, old Vercel origin included.
   5. §2.5 Search Console domain verification. Started first: it is days of
          queue nobody here controls.
   6. §2.1-2.4 Identity Platform, auth.bgbuddy.app, branding.
   7. §3.1 DNS in Cloudflare, nameservers first.
   8. §2.7 Supabase third-party auth + the TP-MAU billing line.
   9. §3.3 bgbuddy.app and www pointed at Pages, §3.7 SSL set.
  10. The auth migration and the user import (MIGRATION_PLAN.md 3-ALT): dual
      issuer live, 23/23 accounts imported under their original UUIDs.

STILL OPEN
  11. §3.8 Email Routing. privacy@ and support@ bounce until it exists, and
      the privacy policy points deletion requests at one of them.

THE CUTOVER — one sitting, in this order
  12. Merge. CI deploys web → Pages (live, ungated) and runs the API tests.
  13. Switch the BGB Railway service's source branch from the feature branch to
      `main`. Not before: `main` has no projects/boardgame-buddy/api until the
      merge lands, so an early switch deploys nothing.
  14. Dispatch `deploy-bgb-moved-notice.yml`. This is time-sensitive — see
      below.
  15. Let `shared-backend` redeploy (or re-enable Auto Deploy if you paused it)
      and confirm ANOTHER project's health endpoint. That service is shared
      with six apps; it losing BGB's routes is expected, it failing to boot is
      the thing to catch.
  16. Delete the BGB_COMING_SOON repo variable, `deploy-bgb-web-vercel.yml`,
      and the BGB_*/BGG_* variables on the old Railway service. Drop the Vercel
      origin from ALLOWED_ORIGINS.
```

**Step 14 is the one with a clock on it.** The old Vercel app's `config.js`
carries the shared Railway origin, so the moment step 15's redeploy lands, that
app is serving a live-looking UI whose every request 404s. The notice in
`projects/boardgame-buddy/moved/` is what a returning visitor gets instead —
and it is also the only thing that shuts down the service worker still
registered on that origin, which otherwise keeps booting the old shell from
cache for anyone who installed the app. Read `moved/sw.js` before changing
either file.

**The Vercel project is not deleted.** Deleting it answers every bookmark,
shared session link and installed PWA with Vercel's DEPLOYMENT_NOT_FOUND page,
and gives up that service-worker shutdown. Retire it by replacing what it
serves, not by removing it.

**There is no COMING_SOON flag any more.** It existed to hide the app during
the DNS and auth cutover, and to stop a signup racing the user import
(`importUsers` does not dedupe on email, so a pre-import signup becomes a
duplicate identity). Both jobs are finished, so the merge lands the app live.
What replaces it as an abort switch: **Cloudflare Pages keeps every deployment
with one-click rollback**, and an auth-specific problem still rolls back by
unsetting the four `BGB_FIREBASE_*` variables and re-running the web workflow.
Both are better than showing users a waitlist form.

### The Vercel bridge, and why there is no dress rehearsal

`deploy-bgb-web.yml` carries a `workflow_dispatch` trigger, and on its own that
does **not** let you deploy Pages before merging: GitHub offers the Run workflow
button only for a workflow whose file exists on the *default* branch, so while
this work sits on a feature branch the workflow is invisible in the Actions list.

That is what the separate `claude/bgb-pages-workflow-on-main` PR exists for — it
lands a dispatch-only copy of the same workflow on `main`, which makes the
button appear; dispatching it against this branch then builds *this* branch's
tree. So there IS a rehearsal, and it has been run: `bgbuddy.pages.dev` and the
custom domains were live well before the cutover merge.

Two consequences. The copy on `main` must stay **dispatch-only** while `main`
still feeds Vercel: with a `push:` trigger, any commit to `main` touching
`projects/boardgame-buddy/web/**` would publish main's tree to Pages production
and replace a good deploy with one built before the privacy and terms routes
existed. And the cutover merge will raise an **add/add conflict on this one
file** — resolve it by taking the feature branch's version wholesale, since that
is the copy with the real triggers.

`deploy-bgb-web-vercel.yml` is the counterweight: the same four build steps
ending at Vercel instead of Pages, dispatch-only. Between step 12 and step 14
it is the only path left that can ship a frontend fix to the old host, because
that same merge removes boardgame-buddy from `deploy-frontend.yml`'s change
detection and moves the bundler to `projects/boardgame-buddy/scripts/`. It must
never gain a push trigger — two hosts building the same commit is not a
fallback, it is a coin flip.

Step 14 is what retires it: once `deploy-bgb-moved-notice.yml` has overwritten
that project's production deployment with the static notice, there is no longer
an old app to ship a fix to. Delete the bridge then (step 16), not before — it
is the escape hatch for the one window where Pages is production and the notice
has not gone up yet.

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

- **They resolve for a signed-out stranger**, which is not incidental: the
  consent screen links to both permanently, so they are loaded by people with
  no account and no session. They sit above the auth gate for that reason —
  moving them behind it, or into Settings, breaks the consent screen's links.
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
