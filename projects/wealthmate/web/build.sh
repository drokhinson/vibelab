#!/bin/bash
# Pre-deploy step run by .github/workflows/deploy-frontend*.yml.
# Generates config.js from GitHub Actions environment variables.
set -e

cat > config.js << EOF
// config.js — generated at build time from environment variables
window.APP_CONFIG = {
  apiBase: "${API_BASE:-https://vibelab-production-2119.up.railway.app}",
  project: "wealthmate",
  supabaseUrl: "${SUPABASE_URL}",
  supabaseAnonKey: "${SUPABASE_ANON_KEY}"
};
EOF
echo "config.js generated."
