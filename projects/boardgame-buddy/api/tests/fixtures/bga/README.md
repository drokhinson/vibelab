# Board Game Arena fixtures

Captured response bodies, standing in for a site nobody in CI can reach.

**These are placeholders until somebody verifies them.** Board Game Arena has
no public API; the shapes in `api/routes/bga_endpoints.py` are reconstructed,
and the files here were written to match that reconstruction rather than
recorded off the wire. They pin the parsers against *a* shape, which is what
makes a later change to the real shape a visible diff instead of a silent
behaviour change — but they do not prove the shape is right.

## Replacing them with the real thing

Open Board Game Arena in a browser with devtools on the Network tab, sign in,
and open your Game history page. Save:

| File | Where it comes from |
|---|---|
| `login_ok.json` | the `POST /account/account/login.html` response on a good password |
| `login_bad.json` | the same, on a wrong one |
| `login_2fa.json` | the same, on an account with two-factor turned on |
| `gamestats.json` | `GET /gamestats/gamestats/getGames.html` |
| `tableinfo.json` | `GET /table/table/tableinfos.html?id=…` |

**Scrub before committing.** Real captures carry the account's own handle,
email, player ids and sometimes a session cookie. Replace them the way these
files do — invented handles, small ids — and check the whole file, not just the
fields the parser reads.

Then run `python -m pytest api/tests/test_bga_endpoints.py`. A failure there is
the reconstruction being wrong, which is exactly what this is for; fix
`bga_endpoints.py` and nothing else.

`BGA_FIXTURE_DIR` also points at a directory of this shape for dry runs, but it
wants bare `login.json` / `gamestats.json` / `tableinfo.json` names — see
`bga_endpoints.fixture()`.
