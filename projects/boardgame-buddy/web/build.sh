#!/bin/bash
# Generates config.js from Vercel environment variables at deploy time.
# For local dev, config.js is checked in with localhost defaults.
set -e

cat > config.js << EOF
// config.js — generated at build time from environment variables
window.APP_CONFIG = {
  apiBase: "${API_BASE:-https://vibelab-production-2119.up.railway.app}",
  project: "boardgame-buddy",
  supabaseUrl: "${SUPABASE_URL}",
  supabaseAnonKey: "${SUPABASE_ANON_KEY}"
};
EOF

echo "config.js generated."

# Copy the Guide Builder skill file into the web root so the Import screen can
# offer it as a download (/guide-from-rulebook.md).
if [ -f "../../../.claude/commands/guide-from-rulebook.md" ]; then
  cp "../../../.claude/commands/guide-from-rulebook.md" "./guide-from-rulebook.md"
  echo "guide-from-rulebook.md copied into web/."
fi
