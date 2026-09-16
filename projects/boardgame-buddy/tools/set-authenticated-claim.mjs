#!/usr/bin/env node
// set-authenticated-claim.mjs — give every Identity Platform user the
// `role: "authenticated"` custom claim Supabase's RLS needs.
//
//     npm install firebase-admin          # not a repo dependency; see below
//     export GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/sa.json
//     node projects/boardgame-buddy/tools/set-authenticated-claim.mjs --dry-run
//     node projects/boardgame-buddy/tools/set-authenticated-claim.mjs --apply
//
// WHY THIS IS NEEDED. Every RLS policy on the live-session tables is declared
// `TO authenticated`. A request's role comes from the JWT's `role` claim, and
// a Firebase ID token has none — so browser-direct requests resolve to `anon`,
// match no policy, and are refused. The API is unaffected because it is
// service-role and bypasses RLS entirely, which is why this failed as "live
// scores don't work" rather than as "nothing works". Supabase's own
// Third-Party Auth panel states the requirement:
//
//   "you'll need to add custom code to set the authenticated role to all your
//    present and future users"
//
// PRESENT USERS ARE THIS SCRIPT. FUTURE USERS ARE NOT. `importUsers()` set no
// custom claims, so the imported accounts have none, and this backfills them.
// It does nothing for the next person who signs up — that needs the blocking
// function in Docs/RUNBOOK_AUTH_ROLE_CLAIM.md. Running only this script leaves
// a bug that reappears for every new account, which is the same shape of
// failure it is fixing.
//
// THE CREDENTIAL IS A SECRET AND IT IS NOT A REPO FILE. A service-account key
// for this project can mint a token for any user. Pass it by absolute path
// through GOOGLE_APPLICATION_CREDENTIALS, keep it outside the tree, and delete
// it when you are done — `.gitignore` covers `*.sa.json` as a backstop, not as
// permission. firebase-admin is deliberately not in any package.json here:
// nothing at runtime uses it, and a dependency that only a one-off operator
// script needs should not be installed on a deploy.
//
// Idempotent, and safe to re-run: a user who already has the claim is skipped,
// and any other claims they carry are preserved.

// firebase-admin is imported DYNAMICALLY, inside main() and after --self-test
// has had its chance to run. A static import is evaluated before any of this
// file's own code, which would make `--self-test` — the one mode that needs no
// credentials and no SDK — fail with a module-not-found on a machine that has
// not installed anything.

const ROLE_CLAIM = "role";
const ROLE_VALUE = "authenticated";
const PAGE = 1000;

/**
 * What this user's claims should become, or null if nothing needs changing.
 *
 * setCustomUserClaims REPLACES the whole object, so a merge is not a nicety:
 * returning `{role}` alone would silently drop every other claim the account
 * carries. Exported logic rather than inline so --self-test can cover it.
 */
export function nextClaims(existing) {
  const claims = existing && typeof existing === "object" ? existing : {};
  if (claims[ROLE_CLAIM] === ROLE_VALUE) return null;
  return { ...claims, [ROLE_CLAIM]: ROLE_VALUE };
}

function selfTest() {
  const cases = [
    [undefined, { role: "authenticated" }],
    [null, { role: "authenticated" }],
    [{}, { role: "authenticated" }],
    [{ role: "authenticated" }, null],                       // already done
    [{ role: "anon" }, { role: "authenticated" }],           // wrong value
    [{ admin: true }, { admin: true, role: "authenticated" }], // MERGES
    [{ admin: true, role: "authenticated" }, null],
  ];
  let bad = 0;
  for (const [input, want] of cases) {
    const got = nextClaims(input);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      bad++;
      console.log(`FAIL ${JSON.stringify(input)} -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }
  console.log(`self-test: ${cases.length - bad}/${cases.length} passed`);
  process.exit(bad ? 1 : 0);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) selfTest();

  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run");
  if (apply === dryRun) {
    console.error("Pass exactly one of --dry-run or --apply.");
    process.exit(2);
  }
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error("GOOGLE_APPLICATION_CREDENTIALS is not set. See the header.");
    process.exit(2);
  }

  let initializeApp, applicationDefault, getAuth;
  try {
    ({ initializeApp, applicationDefault } = await import("firebase-admin/app"));
    ({ getAuth } = await import("firebase-admin/auth"));
  } catch (err) {
    console.error(
      "firebase-admin is not installed. It is deliberately not a repo\n" +
      "dependency — nothing at runtime uses it. Install it just for this run:\n" +
      "  npm install firebase-admin\n"
    );
    process.exit(2);
  }

  initializeApp({ credential: applicationDefault() });
  const auth = getAuth();

  let pageToken;
  let total = 0;
  let already = 0;
  const changed = [];
  const failed = [];

  do {
    const page = await auth.listUsers(PAGE, pageToken);
    for (const user of page.users) {
      total++;
      const next = nextClaims(user.customClaims);
      if (!next) {
        already++;
        continue;
      }
      if (!apply) {
        changed.push(user.uid);
        continue;
      }
      try {
        await auth.setCustomUserClaims(user.uid, next);
        changed.push(user.uid);
      } catch (err) {
        failed.push([user.uid, err && err.message]);
      }
    }
    pageToken = page.pageToken;
  } while (pageToken);

  const verb = apply ? "updated" : "would update";
  console.log(`\n${total} users, ${already} already correct, ${verb} ${changed.length}`);
  for (const uid of changed) console.log(`  ${verb}: ${uid}`);
  if (failed.length) {
    console.log(`\n${failed.length} FAILED:`);
    for (const [uid, msg] of failed) console.log(`  ${uid}: ${msg}`);
  }

  if (apply && changed.length) {
    console.log(
      "\nClaims are on the user records. They reach a signed-in browser only on\n" +
      "its NEXT token refresh — up to an hour, or immediately via sign out and\n" +
      "back in, or `await firebase.auth().currentUser.getIdToken(true)` in the\n" +
      "console. Until then that session still sends a role-less token."
    );
  }
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
