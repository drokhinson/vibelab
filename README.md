# vibelab

A Claude-driven ideation → prototype → native app pipeline. Every idea becomes a web prototype (HTML/CSS/JS + Python FastAPI + Supabase), then optionally a cross-platform React Native app.

## Project Index

See [registry.json](landing/registry.json) for the machine-readable list, or visit the [landing page](landing/) to browse all projects.

| Project | Status | Web | Native |
|---|---|---|---|
| [SauceBoss](projects/sauceboss/) 🍲 | 🔧 WIP | [sauceboss-omega.vercel.app](https://sauceboss-omega.vercel.app) | Expo |
| [WealthMate](projects/wealthmate/) 💰 | 🔧 WIP | [vibelab-jusv.vercel.app](https://vibelab-jusv.vercel.app) | — |
| [SpotMe](projects/spotme/) 📍 | 🔧 WIP | [vibelab-spotme.vercel.app](https://vibelab-spotme.vercel.app) | — |
| [Day Word Play](projects/daywordplay/) 📖 | 🔧 WIP | [vibelab-daywordplay.vercel.app](https://vibelab-daywordplay.vercel.app) | — |
| [PlantPlanner](projects/plant-planner/) 🌱 | 🔧 WIP | [vibelab-plantplanner.vercel.app](https://vibelab-plantplanner.vercel.app) | — |
| [Admin](projects/admin/) 🛠️ | 🔧 WIP | [vibelab-admintool.vercel.app](https://vibelab-admintool.vercel.app) | — |

## Stack

- **Frontend**: Vanilla HTML/CSS/JS + [DaisyUI v4](https://daisyui.com) (no build step; older projects on Pico.css)
- **Backend**: Python FastAPI (single shared service on Railway)
- **Database**: Supabase (PostgreSQL, one shared project)
- **Frontend hosting**: Vercel
- **Native apps**: React Native / Expo

## Pipeline

```
Idea → scaffold.sh → STRUCTURE.md → web/ + shared-backend/ → native/
```

See [CLAUDE.md](CLAUDE.md) for full pipeline instructions.

## Creating a New Project

```bash
bash scaffold.sh my-app "My App" "One sentence description"
```

## Development

```bash
# Shared backend (all projects)
cd shared-backend
python -m venv .venv && source .venv/Scripts/activate
pip install -r requirements.txt
cp .env.example .env   # fill in Supabase credentials
uvicorn main:app --reload --port 8000

# Web prototype (no build step)
# Open projects/[name]/web/index.html in browser, or:
npx serve projects/[name]/web

# React Native app
cd projects/[name]/app
npm install
npx expo start
```
