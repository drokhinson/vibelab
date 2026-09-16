#!/usr/bin/env node
//
// import-users-to-firebase.mjs — move Supabase Auth accounts into GCP Identity
// Platform without making anybody reset a password.
//
// Supabase stores passwords as bcrypt in auth.users.encrypted_password, and
// Firebase's importUsers() accepts bcrypt hashes directly, so the hash moves
// across verbatim and existing passwords keep working.
//
// THE ONE THING THAT MATTERS MOST
// -------------------------------
// The Supabase UUID becomes the Firebase uid, unchanged. boardgamebuddy_profiles.id
// IS that UUID, and every play, buddy edge, achievement and session row hangs
// off it. A regenerated uid does not fail loudly — it creates a second, empty
// account for a person whose data is all still there under the old id. Verify
// with --verify before trusting a run.
//
// USAGE
// -----
//   1. Export the accounts. In the Supabase dashboard -> SQL Editor, run the
//      query printed by:
//
//        node import-users-to-firebase.mjs --sql
//
//      It returns ONE cell. Copy it into users.json. auth.users is not
//      reachable over PostgREST, which is why this is a manual export.
//
//   2. Dry run. Needs no key and no npm install — it reads the export, reports
//      what it found, and calls nothing:
//
//        node import-users-to-firebase.mjs --users ./users.json
//
//   3. Get a service-account key: Firebase console -> Project settings ->
//      Service accounts -> Generate new private key. Then:
//
//        npm install firebase-admin
//
//   4. Commit to it:
//
//        node import-users-to-firebase.mjs --users ./users.json --key ./sa.json --commit
//
//   5. Confirm every uid landed with its email intact:
//
//        node import-users-to-firebase.mjs --users ./users.json --key ./sa.json --verify
//
// BOTH FILES ARE SECRETS. users.json carries password hashes; sa.json can mint
// tokens for any user in the project. Keep them outside the repo and delete
// them when the migration is done. `.gitignore` covers *.users.json and
// *.sa.json as a backstop, not as permission to put them here.
//
// RE-RUNNING IS SAFE, WITH ONE CAVEAT
// -----------------------------------
// importUsers() upserts by uid, so running it twice imports the same accounts
// to the same ids. What it does NOT do is dedupe on email: an account created
// through the app's own signup between the export and the import gets a fresh
// Firebase uid, and this script then writes a SECOND account with the same
// email under the Supabase uid. That is why BGB_COMING_SOON stays on until the
// import is done — the gate is what makes this a non-issue rather than a
// cleanup job.

import { readFileSync } from "node:fs";

// Returns the whole export as ONE JSON cell rather than a row per user.
// The SQL editor's own JSON download has moved around between Supabase
// versions (and sometimes only offers CSV, which mangles the nested identities
// array), whereas copying a single cell works in every version of it.
const EXPORT_SQL = `-- Accounts to migrate, with their bcrypt hashes and linked providers.
-- Supabase -> SQL Editor -> Run, then copy the single result cell into a file.
select jsonb_pretty(coalesce(jsonb_agg(t), '[]'::jsonb)) as users
from (
  select
    u.id,
    u.email,
    u.encrypted_password,
    u.email_confirmed_at,
    coalesce(
      jsonb_agg(
        jsonb_build_object('provider', i.provider, 'sub', i.identity_data->>'sub')
      ) filter (where i.provider is not null and i.provider <> 'email'),
      '[]'::jsonb
    ) as identities
  from auth.users u
  left join auth.identities i on i.user_id = u.id
  where u.deleted_at is null
  group by u.id
  order by u.created_at
) t;`;

// Supabase's provider slugs are not Firebase's provider ids.
const PROVIDER_IDS = {
  google: "google.com",
  apple: "apple.com",
  github: "github.com",
  facebook: "facebook.com",
};

function parseArgs(argv) {
  const out = { commit: false, verify: false, sql: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--commit") out.commit = true;
    else if (a === "--verify") out.verify = true;
    else if (a === "--sql") out.sql = true;
    else if (a === "--users") out.users = argv[++i];
    else if (a === "--key") out.key = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

/**
 * Turn one exported row into an importUsers() record.
 *
 * Two shapes come out of Supabase and both have to survive:
 *
 *   * A password account has a bcrypt hash and no linked provider.
 *   * A Google account has NO usable password (encrypted_password is null, or
 *     occasionally a non-bcrypt placeholder) and one identity row. Its
 *     providerData has to carry the Google `sub`, because that is what Firebase
 *     matches on at sign-in — without it the user signs in with Google and
 *     Firebase mints a BRAND NEW uid, orphaning their profile exactly the way a
 *     regenerated UUID would.
 */
function toFirebaseUser(row) {
  const user = {
    uid: row.id,
    email: row.email,
    emailVerified: !!row.email_confirmed_at,
  };

  const hash = row.encrypted_password;
  // Supabase writes bcrypt, which always starts $2a$/$2b$/$2y$. Anything else
  // is a placeholder for a provider-only account, and passing it to
  // importUsers as BCRYPT would be rejected for the whole batch.
  if (hash && /^\$2[aby]\$/.test(hash)) {
    user.passwordHash = Buffer.from(hash);
  }

  const identities = Array.isArray(row.identities) ? row.identities : [];
  const providerData = identities
    .filter((i) => i && i.sub && PROVIDER_IDS[i.provider])
    .map((i) => ({
      uid: i.sub,
      providerId: PROVIDER_IDS[i.provider],
      email: row.email,
    }));
  if (providerData.length) user.providerData = providerData;

  return user;
}

/**
 * Accept the export however the SQL editor handed it over.
 *
 * The query returns one cell, so copying it gives a bare array — but "copy as
 * JSON" on the result GRID wraps that in a row object, as
 * `[{ "users": [ ... ] }]`, and a copied cell can arrive as a JSON string of
 * the array. All three are the same data and all three are easy to produce by
 * accident, so none of them should be a confusing parse error.
 */
function unwrap(parsed) {
  if (typeof parsed === "string") return unwrap(JSON.parse(parsed));
  if (!Array.isArray(parsed)) return parsed;
  if (parsed.length === 1 && parsed[0] && !parsed[0].id) {
    const values = Object.values(parsed[0]);
    if (values.length === 1) return unwrap(values[0]);
  }
  return parsed;
}

function classify(users) {
  const password = users.filter((u) => u.passwordHash).length;
  const federated = users.filter((u) => u.providerData).length;
  const neither = users.filter((u) => !u.passwordHash && !u.providerData);
  return { password, federated, neither };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.sql) {
    console.log(EXPORT_SQL);
    return;
  }
  if (!args.users) {
    console.error("Need --users <export.json>.");
    console.error("Run with --sql for the export query, or read the header.");
    process.exit(2);
  }
  // A key is only needed to talk to Firebase. Leaving it optional is what lets
  // the dry run check the export before anything is installed or downloaded.
  if ((args.commit || args.verify) && !args.key) {
    console.error("--commit and --verify need --key <service-account.json>.");
    process.exit(2);
  }

  const rows = unwrap(JSON.parse(readFileSync(args.users, "utf8")));
  if (!Array.isArray(rows) || !rows.length) {
    console.error("Export is empty, or not a JSON array of accounts.");
    process.exit(1);
  }

  // A row with no id would be imported under a uid Firebase generates, which
  // is the orphaning case. Refuse the whole run rather than import most of it.
  const missing = rows.filter((r) => !r.id || !r.email);
  if (missing.length) {
    console.error(`${missing.length} row(s) have no id or no email. Aborting.`);
    console.error(JSON.stringify(missing.slice(0, 3), null, 2));
    process.exit(1);
  }

  const users = rows.map(toFirebaseUser);
  const { password, federated, neither } = classify(users);

  console.log(`Accounts in export:      ${users.length}`);
  console.log(`  with a bcrypt password: ${password}`);
  console.log(`  with a linked provider: ${federated}`);
  if (neither.length) {
    console.log(`  with NEITHER:           ${neither.length}`);
    console.log("");
    console.log("Those accounts cannot sign in after the import — no password");
    console.log("to check and no provider to match. They need a password reset");
    console.log("email, or to be left behind deliberately:");
    for (const u of neither) console.log(`    ${u.uid}  ${u.email}`);
  }
  console.log("");

  if (!args.commit && !args.verify) {
    console.log("Dry run — nothing was written and Firebase was not contacted.");
    console.log("Re-run with --key <sa.json> --commit when the numbers look right.");
    return;
  }

  const { default: admin } = await import("firebase-admin");
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(readFileSync(args.key, "utf8"))),
  });
  const auth = admin.auth();

  if (args.verify) {
    let ok = 0;
    const problems = [];
    for (const u of users) {
      try {
        const got = await auth.getUser(u.uid);
        // The uid matching is the whole point; email is checked too because a
        // mismatch there means the export and the project have drifted.
        if (got.email === u.email) ok += 1;
        else problems.push(`${u.uid}: email is ${got.email}, expected ${u.email}`);
      } catch (e) {
        problems.push(`${u.uid} (${u.email}): ${e.code || e.message}`);
      }
    }
    console.log(`Verified ${ok}/${users.length} accounts present under their original UUID.`);
    for (const p of problems) console.log(`  FAIL ${p}`);
    process.exit(problems.length ? 1 : 0);
  }

  // importUsers caps at 1000 per call. "A handful" will never hit this, but a
  // silent truncation at 1001 is not a failure mode worth leaving open.
  const BATCH = 1000;
  let successCount = 0;
  const failures = [];
  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH);
    const result = await auth.importUsers(batch, {
      hash: { algorithm: "BCRYPT" },
    });
    successCount += result.successCount;
    // result.errors indexes into THIS batch, so the offset matters once there
    // is more than one.
    for (const err of result.errors) {
      const u = batch[err.index];
      failures.push(`${u.uid} (${u.email}): ${err.error.message}`);
    }
  }

  console.log(`Imported ${successCount}/${users.length}.`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log("");
  console.log("Now run --verify, then sign in as an existing user with their");
  console.log("existing password and confirm their play count is intact.");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
