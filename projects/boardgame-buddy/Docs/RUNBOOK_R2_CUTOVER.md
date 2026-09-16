# Stage 4 runbook — photos and covers onto Cloudflare R2

The code is already in the tree and inert: with the `R2_*` variables unset the
API writes to Supabase Storage exactly as it always has. Everything below is
console work, one data copy and one migration.

**Why bother.** Image bytes are ~93% of this app's egress, Supabase bills
egress, and R2 does not — at any volume. This is the only cost line that grows
with success.

**How long.** About an hour of clicking plus however long the copy takes. The
copy is incremental and re-runnable, so it is not a window: nothing is
user-visible until step 9, and steps 1–8 can be abandoned at any point with no
trace.

**What you need open:** the Cloudflare dashboard, the Supabase dashboard,
Railway, and a terminal with `rclone` installed.

---

## Before you start: two values to write down

| Value | Where |
|---|---|
| Cloudflare **Account ID** | Cloudflare dashboard → R2 → the right-hand sidebar |
| Supabase **project ref** | the `abcdefgh` in your `SUPABASE_URL` |

The project ref is the one you will paste into the migration in step 10.

---

## 1. Create the two buckets

Cloudflare dashboard → **R2** → Create bucket, twice:

* `bgb-plays`
* `bgb-games`

Location hint: leave it automatic. Default storage class: Standard.

**Two buckets, not one with `plays/` and `games/` prefixes.** A play photo is
user content; a cover is a cache of public BGG images. The privacy policy
discloses that a play photo's URL is open to anyone holding the link, and the
fix for that is signed URLs — i.e. taking the public domain off `bgb-plays`.
Split, that is a console change. Behind one shared bucket it would be a re-key
and a second URL rewrite.

## 2. Attach a custom domain to each

R2 → the bucket → **Settings** → Public access → Custom domains → Connect
domain:

| Bucket | Domain |
|---|---|
| `bgb-plays` | `img.bgbuddy.app` |
| `bgb-games` | `covers.bgbuddy.app` |

Because `bgbuddy.app` is already in this Cloudflare account, the DNS record is
created for you and proxied. Wait for both to read **Active**.

**Do not** enable the `r2.dev` development subdomain instead. It is
rate-limited and explicitly not for production, and its hostname would end up
baked into every row in the database.

**Do not touch the `auth` record** while you are in the DNS panel. It is
DNS-only on purpose — it authorises certificate renewal for Identity Platform,
not just the original verification.

> **Check before moving on.** Upload any small file to `bgb-plays` through the
> R2 web UI and open `https://img.bgbuddy.app/<that file>` in a browser. If it
> does not load, nothing below will work. Delete the file afterwards.

## 3. Create the API token

R2 → **Manage R2 API Tokens** → Create API token.

* Permissions: **Object Read & Write**
* Specify buckets: `bgb-plays` and `bgb-games` only
* TTL: forever

Copy the **Access Key ID** and **Secret Access Key** now — the secret is shown
once.

## 4. Get Supabase S3 credentials for the copy

Supabase dashboard → **Storage** → Settings (or S3 Connection). The page shows
the **S3 endpoint** and the **region** for your project, and has a button to
create S3 access keys. Create one and copy both halves.

Note the endpoint and region **as the page states them** rather than from
memory — they are project-specific, and a wrong endpoint fails at step 6 with
an authentication error that looks like a credentials problem.

> **If there is no S3 connection page**, the S3 protocol is not available on
> this project and `rclone` cannot read Supabase directly. The fallback needs
> no new credentials: a script that lists the two buckets through the Storage
> REST API with the service-role key you already have, downloads each object
> and `put_object`s it into R2 with `boto3` (already a dependency of the API).
> Roughly fifty lines, and the verifier in step 7 checks its work the same
> way. Ask for it rather than hand-rolling it — the part worth getting right
> is paging the object listing, which is the same trap `verify-r2-mirror.py`
> documents.

## 5. Configure rclone

Two remotes. Fill in the bracketed values from steps 3 and 4:

```
rclone config create sb s3 \
  provider=Other \
  access_key_id=<SUPABASE_S3_KEY_ID> \
  secret_access_key=<SUPABASE_S3_SECRET> \
  endpoint=<THE ENDPOINT SUPABASE SHOWED YOU> \
  region=<THE REGION SUPABASE SHOWED YOU>

rclone config create r2 s3 \
  provider=Cloudflare \
  access_key_id=<R2_ACCESS_KEY_ID> \
  secret_access_key=<R2_SECRET_ACCESS_KEY> \
  endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  region=auto
```

Prove both remotes work before copying anything:

```
rclone lsd sb:                      # should list boardgamebuddy-plays, -games
rclone lsd r2:                      # should list bgb-plays, bgb-games
rclone size sb:boardgamebuddy-plays # note this number
rclone size sb:boardgamebuddy-games # and this one
```

If `lsd` fails, the endpoint or the keys are wrong. Fix that here — every later
step assumes these two lines work.

## 6. Copy the objects

```
rclone copy sb:boardgamebuddy-plays r2:bgb-plays --progress --no-check-bucket
rclone copy sb:boardgamebuddy-games r2:bgb-games --progress --no-check-bucket
```

`--no-check-bucket` skips a bucket-creation probe R2 does not need and the
token is not scoped for.

**The object keys must stay identical.** `{user_id}/{uuid4hex}.{ext}` for
photos, `{bgg_id}_{kind}.{ext}` for covers. That is what makes step 10 a prefix
substitution instead of a re-key, so do not add a prefix or flatten anything.

Then compare against the numbers from step 5:

```
rclone size r2:bgb-plays
rclone size r2:bgb-games
```

## 7. Verify the copy against the database, not against itself

Matching byte counts prove the buckets agree. They do not prove that every URL
the app will ask for exists. This does:

```
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service role key> \
R2_PLAYS_PUBLIC_BASE=https://img.bgbuddy.app \
R2_GAMES_PUBLIC_BASE=https://covers.bgbuddy.app \
python3 projects/boardgame-buddy/tools/verify-r2-mirror.py
```

It reads every `photo_url`, `image_url` and `thumbnail_url` in the database,
reduces each to an object key, and HEADs it on the R2 domain. Read-only; no
third-party packages needed.

**Do not continue until it prints `every image URL in the database resolves on
R2`.** A miss here is free to fix (re-run step 6); the same miss discovered
after step 10 is a broken image in someone's play log.

Un-rehosted `cf.geekdo-images.com` covers are reported as skipped, which is
correct — those never lived in Supabase either.

## 8. Set the Railway variables

Railway → the **BoardgameBuddy API** service (Root Directory
`projects/boardgame-buddy/api`) → Variables. All seven:

```
R2_ACCOUNT_ID=<account id>
R2_ACCESS_KEY_ID=<from step 3>
R2_SECRET_ACCESS_KEY=<from step 3>
R2_PLAYS_BUCKET=bgb-plays
R2_GAMES_BUCKET=bgb-games
R2_PLAYS_PUBLIC_BASE=https://img.bgbuddy.app
R2_GAMES_PUBLIC_BASE=https://covers.bgbuddy.app
```

Seven or nothing, per store. `object_store.configured()` requires the account,
both token halves, the bucket **and** the public base; with any one missing the
API silently goes on writing to Supabase Storage, because that is the designed
fallback. Nothing will tell you.

The service restarts on save. That is the moment new uploads start landing in
R2.

## 9. Confirm new writes land on R2 — and that old reads still work

In the app: log a play with a photo. The photo should appear, and the URL
should be on `img.bgbuddy.app`.

Then open an **older** play, from before today. Its photo is still a
`supabase.co` URL and must still load.

> **This mixed state is the intended intermediate.** New rows on R2, old rows
> on Supabase, both working, because the client just loads whatever absolute
> URL the row holds and neither the API nor the frontend branches on the
> origin. Seeing both halves work is what says the variables are right *before*
> any existing row is rewritten.

Also confirm the EXIF stripping still holds — it is invariant #10 and this
step changed the thing on the other end of it. Download the photo you just
uploaded and run `exiftool -gps:all <file>`. It must print nothing.

## 10. Re-run the copy, then rewrite the URLs

Anything uploaded to Supabase between step 6 and step 8 is not in R2 yet. The
copy is incremental, so just run it again:

```
rclone copy sb:boardgamebuddy-plays r2:bgb-plays --progress --no-check-bucket
rclone copy sb:boardgamebuddy-games r2:bgb-games --progress --no-check-bucket
```

Re-run step 7's verifier. Then open
`projects/boardgame-buddy/db/migrations/036_r2_photo_urls.sql`, **edit the four
prefixes at the top**:

```sql
old_plays TEXT := 'https://<YOUR REF>.supabase.co/storage/v1/object/public/boardgamebuddy-plays/';
new_plays TEXT := 'https://img.bgbuddy.app/';
old_games TEXT := 'https://<YOUR REF>.supabase.co/storage/v1/object/public/boardgamebuddy-games/';
new_games TEXT := 'https://covers.bgbuddy.app/';
```

and run it in Supabase → SQL Editor. It refuses to run while a placeholder is
still there, and it is re-runnable: every UPDATE is guarded on the row still
carrying the old prefix.

It prints how many rows it touched:

```
NOTICE:  plays.photo_url: N rewritten
NOTICE:  games.image_url: N rewritten
NOTICE:  games.thumbnail_url: N rewritten
```

Order matters and only in one direction: **a rewritten URL whose object has not
copied yet is a broken image.** Copy first, always.

## 11. Acceptance

```sql
SELECT count(*) FROM public.boardgamebuddy_plays
 WHERE photo_url LIKE '%supabase.co/storage%';
SELECT count(*) FROM public.boardgamebuddy_games
 WHERE image_url LIKE '%supabase.co/storage%';
SELECT count(*) FROM public.boardgamebuddy_games
 WHERE thumbnail_url LIKE '%supabase.co/storage%';
```

All three must be **0**.

Then:

* Re-run step 7's verifier. It now checks the live URLs rather than derived
  ones. This is the real acceptance gate.
* Open the feed and a few play logs. Every photo loads.
* A photo-import run of 5+ photos writes plays whose photos all load.
* `curl -sI https://img.bgbuddy.app/<some key> | grep -i cf-cache-status`
  twice — the second should say `HIT`.
* Supabase → Reports → egress drops on the next cycle. That is the point of
  the stage.

## 12. What NOT to do next

**Do not delete the Supabase buckets.** They are the rollback, and they cost
storage only — the bill this stage was about was egress, which is now zero
from them. Leave them until R2 has been serving for a full billing cycle with
no complaints.

**Rollback, by where you got to:**

| Got to | Undo |
|---|---|
| step 9 | Unset the seven Railway variables. New uploads return to Supabase; the handful of rows written to R2 keep working, because R2 is still serving them. |
| step 10 | The same, plus run `036` again with `old_*` and `new_*` swapped. The objects are still in both places, so either direction works. |

---

## Two things that are deliberately unchanged

**No CORS policy on either bucket.** Nothing in the app `fetch()`es an image or
draws one to a canvas — photos are plain `<img src>` loads, which need no CORS
headers. Adding a policy would be harmless but it would also be cargo cult.
If a future feature does read image bytes (a client-side collage, a share-card
renderer), that is when a CORS rule becomes necessary.

**The service worker still ignores images.** `sw.js`'s `isBackend()` matches
`*.supabase.co` and returns early, so today's photos bypass the worker
entirely. The new hostnames are neither same-origin nor in `RUNTIME_ORIGINS`,
so they fall through every branch of the fetch handler and reach the network
untouched — the same behaviour by a different route. Photos are therefore not
available offline, which they were not before either. Adding the two hostnames
to `RUNTIME_ORIGINS` would cache them, at the cost of an unbounded cache full
of other people's play photos; that is a deliberate no.
