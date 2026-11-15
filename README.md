# FIREWATCH AI

FIREWATCH AI is a satellite fire intelligence platform for exploring NASA FIRMS thermal anomaly observations with evidence-grounded analysis. It combines a Next.js frontend, a FastAPI scientific engine, and an optional local AI/runtime layer for on-device assistance.

## What it includes

- **Interactive fire map** with region-aware AOI inspection, filters, and observation details
- **Ask the Earth** evidence panel and assistant interface grounded in engine-computed AOI data
- **Scientific engine** for regional summaries, timelines, comparison, harmonization, baselines, and report-oriented outputs
- **Data/status views** for freshness, coverage, and transparency
- **Optional local runtime integration** (device-local, no hosted AI dependency required for core evidence features)

## Architecture

- **Frontend:** Next.js (App Router), React, TypeScript, Tailwind, MapLibre/Globe views
- **Engine:** Python FastAPI (`engine/`) serving `/api/*` scientific and AI-evidence endpoints
- **Local AI/runtime:** `local_ai/` and Yorichi integration hooks for local, evidence-grounded phrasing (when configured)

## Prerequisites

- Node.js 18+ and npm
- Python 3.11+ (3.12+ recommended)
- Git

## Quick start

### 1. Install frontend dependencies

```bash
npm install
```

### 2. Install engine dependencies

```bash
cd engine
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cd ..
```

### 3. Run the scientific engine

```bash
python engine/run.py
```

Default engine URL: `http://127.0.0.1:8010`

### 4. Run the frontend

```bash
npm run dev
```

Default frontend URL: `http://127.0.0.1:3000`

The frontend proxies `/api/*` to the engine (see `next.config.ts`).

## Data and freshness

- The engine reads ingested FIRMS data from `data/` (SQLite) when available.
- Freshness and source status are exposed via engine endpoints and surfaced in the UI.
- If data or a service is unavailable, the UI should show explicit unavailable/error states rather than fabricated values.

## AI and scientific integrity

- Evidence and statistics are computed by the engine; language models must not invent measurements.
- AI responses should be grounded in selected AOI evidence, clearly labeled, and include uncertainty/limitations where relevant.
- Local inference is optional and device-local when configured; core map/evidence functionality should remain usable without it.

## Development checks

```bash
npm run lint
npm run build
cd engine && pytest
```

(Additional frontend/unit tests may be added under project conventions.)

## Production notes

- Review environment/config for engine URL, data paths, and any local runtime settings before deployment.
- Do not commit `.next/`, `node_modules/`, virtualenvs, databases, or model/bundle artifacts.
- Validate map load performance, API correctness, and report/export outputs against real engine responses.

## License / attribution

Satellite thermal anomaly data: NASA FIRMS (MODIS/VIIRS). This project is an independent visualization and analysis interface; verify critical decisions with authoritative sources.
