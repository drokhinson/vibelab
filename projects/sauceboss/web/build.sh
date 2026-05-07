#!/bin/bash
# Pre-deploy step run by .github/workflows/deploy-frontend-all.yml.
#
# 1. Generates config.js from Vercel environment variables. For local dev,
#    config.js is checked in with localhost defaults.
# 2. Snapshots projects/sauceboss/shared/ into web/shared/ so the deployed
#    site can serve the shared modules consumed by shared-bridge.js. Vercel
#    only uploads files inside this directory, so the source of truth at
#    ../shared/ has to be copied in before deploy. web/shared/ is gitignored.
#
# Local dev: run `bash build.sh` once after pulling changes that touch
# ../shared/ so your local static server has the modules in place.
set -e

cat > config.js << EOF
// config.js — generated at build time from environment variables
window.APP_CONFIG = {
  apiBase: "${API_BASE:-https://vibelab-production-2119.up.railway.app}",
  project: "sauceboss",
  supabaseUrl: "${SUPABASE_URL}",
  supabaseAnonKey: "${SUPABASE_ANON_KEY}"
};
EOF
echo "config.js generated."

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../shared"
DEST="$HERE/shared"
if [ ! -d "$SRC" ]; then
  echo "[build.sh] expected shared modules at $SRC but the directory is missing" >&2
  exit 1
fi
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
echo "shared/ synced from ../shared/."
