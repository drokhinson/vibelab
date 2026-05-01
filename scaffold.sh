#!/usr/bin/env bash
# scaffold.sh — Create a new project from the _templates directory
# Usage: bash scaffold.sh <project-id> "<Project Title>" "<Short description>"
# Example: bash scaffold.sh my-app "My App" "Does something cool"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATES_DIR="$REPO_ROOT/_templates"
PROJECTS_DIR="$REPO_ROOT/projects"

# ── Argument validation ────────────────────────────────────────────────────────
if [[ $# -lt 3 ]]; then
  echo "Usage: bash scaffold.sh <project-id> \"<Project Title>\" \"<Short description>\""
  echo "  project-id: lowercase-hyphenated, e.g. my-cool-app"
  exit 1
fi

PROJECT_ID="$1"
PROJECT_TITLE="$2"
PROJECT_DESC="$3"
PROJECT_DIR="$PROJECTS_DIR/$PROJECT_ID"
TODAY=$(date +%Y-%m-%d)

# ── Guard: project must not already exist ─────────────────────────────────────
if [[ -d "$PROJECT_DIR" ]]; then
  echo "Error: $PROJECT_DIR already exists. Aborting."
  exit 1
fi

# ── Guard: project-id must be lowercase alphanumeric + hyphens ────────────────
if [[ ! "$PROJECT_ID" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "Error: project-id must be lowercase alphanumeric with optional hyphens (e.g. my-app)"
  exit 1
fi

echo "Scaffolding project: $PROJECT_ID ($PROJECT_TITLE)"

# ── Copy template tree ─────────────────────────────────────────────────────────
cp -r "$TEMPLATES_DIR" "$PROJECT_DIR"

# ── String substitution in template files ─────────────────────────────────────
find "$PROJECT_DIR" -type f | while read -r file; do
  sed -i \
    "s/{{PROJECT_ID}}/$PROJECT_ID/g; \
     s/{{PROJECT_TITLE}}/$PROJECT_TITLE/g; \
     s/{{PROJECT_DESC}}/$PROJECT_DESC/g; \
     s/{{TODAY}}/$TODAY/g" \
    "$file"
done

# ── Add route stub to shared-backend ─────────────────────────────────────────
ROUTE_FILE="$REPO_ROOT/shared-backend/routes/${PROJECT_ID//-/_}.py"
if [[ ! -f "$ROUTE_FILE" ]]; then
  cat > "$ROUTE_FILE" << PYEOF
from fastapi import APIRouter

router = APIRouter(prefix="/api/v1/${PROJECT_ID//-/_}", tags=["${PROJECT_ID}"])

@router.get("/health")
async def health():
    return {"project": "${PROJECT_ID}", "status": "ok"}
PYEOF
  echo "Created route stub: $ROUTE_FILE"
  echo ""
  echo "IMPORTANT: Register the new router in shared-backend/main.py:"
  echo "  from routes.${PROJECT_ID//-/_} import router as ${PROJECT_ID//-/_}_router"
  echo "  app.include_router(${PROJECT_ID//-/_}_router)"
fi

# ── Update registry.json ──────────────────────────────────────────────────────
node - <<EOF
const fs = require('fs');
const path = require('path');
const registryPath = path.join('$REPO_ROOT', 'landing', 'registry.json');
const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

const newEntry = {
  id: '$PROJECT_ID',
  name: '$PROJECT_TITLE',
  description: '$PROJECT_DESC',
  status: 'wip',
  tags: [],
  webUrl: null,
  backendUrl: null,
  hasNativeApp: false,
  expoSlug: null,
  createdAt: '$TODAY',
  icon: '🔧'
};

if (!registry.projects.find(p => p.id === '$PROJECT_ID')) {
  registry.projects.push(newEntry);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  console.log('registry.json updated');
} else {
  console.log('registry.json: entry already exists, skipping');
}
EOF

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "✓ Project scaffolded at: $PROJECT_DIR"
echo ""
PREFIX="${PROJECT_ID//-/}"
echo "Next steps:"
echo "  1. Edit $PROJECT_DIR/STRUCTURE.md — fill in all sections"
echo "  2. Add migration SQL to db/migrations/${PREFIX}/001_baseline.sql"
echo "     - Include CREATE ROLE ${PREFIX}_role LOGIN PASSWORD '...' NOINHERIT;"
echo "       GRANT USAGE ON SCHEMA public TO ${PREFIX}_role;"
echo "       and GRANT SELECT ON public.${PREFIX}_<table> TO ${PREFIX}_role;"
echo "       after every CREATE TABLE. (See db/migrations/_shared/003_project_roles.sql"
echo "       and any existing app's 001_baseline.sql for reference.)"
echo "  3. Run migration in Supabase dashboard SQL editor"
echo "  4. Implement shared-backend/routes/${PROJECT_ID//-/_}.py"
echo "  5. Register the router in shared-backend/main.py"
echo "  6. Build the web prototype in $PROJECT_DIR/web/"
echo "  7. Update registry.json: set icon, tags, description"
echo "  8. Push to main — GitHub Actions will deploy automatically"
echo ""
echo "Dev commands:"
echo "  Backend:  cd shared-backend && uvicorn main:app --reload"
echo "  Web:      open $PROJECT_DIR/web/index.html"
echo "  App:      cd $PROJECT_DIR/app && npx expo start"
