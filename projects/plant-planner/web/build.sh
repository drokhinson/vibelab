#!/bin/bash
# Pre-deploy step run by .github/workflows/deploy-frontend-all.yml.
# Generates config.js from Vercel/GitHub Actions environment variables.
# For local dev, config.js is checked in with blank Supabase fields — fill them
# from the shared Supabase project before running locally.
set -e

cat > config.js << EOF
// config.js — generated at build time from environment variables
window.APP_CONFIG = {
  apiBase: "${API_BASE:-https://vibelab-production-2119.up.railway.app}",
  project: "plant-planner",
  supabaseUrl: "${SUPABASE_URL}",
  supabaseAnonKey: "${SUPABASE_ANON_KEY}"
};
EOF
echo "config.js generated."
