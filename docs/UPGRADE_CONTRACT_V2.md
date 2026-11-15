# STATUS: IMPLEMENTED (2026-11-14)

# FIREWATCH AI — Coverage, Calendar and AI contract (v2)

This file is the contract for the v2 upgrade. The engine is the source of truth; the UI must
consume these fields rather than inventing its own availability logic.

## 1. Observation states

Every (day, sensor) pair resolves to exactly one state:

| state | meaning | evidence required |
|---|---|---|
| `observed` | product delivered **and** ≥1 detection in the selected area | global product delivery for that sensor-day + area count > 0 |
| `observed_zero` | product delivered, **0** detections in the selected area | global product delivery + area count = 0 |
| `unknown` | product delivery cannot be established | no coverage row, ingest failed, or date outside the stored window |

Combined day state: `observed` (any sensor observed), `observed_zero` (all delivered sensors are
zero and none unknown), `partial` (at least one observed or zero, at least one unknown),
`unknown` (no sensor delivery known).

**Delivery evidence.** For the keyless NRT feeds the only defensible signal is product delivery:
a global sensor-day with at least one record anywhere on Earth proves the swath/product exists.
If the product delivered nothing anywhere, delivery is UNKNOWN — never assumed zero.

`coverage_days` (materialised from observations at ingest and on startup):

```
sensor TEXT, satellite TEXT, acq_date TEXT, records INTEGER, source TEXT,
first_seen INTEGER, last_seen INTEGER,
PRIMARY KEY (sensor, satellite, acq_date)
```

Archive windows (future, requires `FIRMS_MAP_KEY`) add area-scoped evidence:

```
coverage_windows(id, source, sensor, satellite, start_date, end_date, bbox,
                 requested_at, records, status, message)
```

## 2. `GET /api/calendar`

Query: `region` | `bbox`, `year`, `period=day|week|month|season`, plus the standard filters
(`sensor`, `confidence`, `satellites`, `min_frp`, `daynight`).

```jsonc
{
  "year": 2026,
  "period": "day",
  "region": "amazon",
  "bbox": [-74, -14, -44, 5],
  "coverage": {
    "first": "2026-11-07",
    "last": "2026-11-14",
    "sensorDays": { "modis": 8, "viirs": 8 },
    "archiveEnabled": false,
    "archiveNote": "Archive needs FIRMS_MAP_KEY; dates outside the window are UNKNOWN.",
    "deliveryMethod": "global product delivery per sensor-day"
  },
  "days": [{
    "date": "2026-11-07",
    "doy": 311,
    "state": "observed",
    "total": 14851,
    "modis": 1234, "viirs": 13617,
    "modisFrp": 8123.4, "viirsFrp": 20444.1,
    "sensors": {
      "modis": { "state": "observed", "count": 1234, "frp": 8123.4,
                 "satellites": { "Terra": 700, "Aqua": 534 },
                 "evidence": "global delivery: 12,345 records" },
      "viirs": { "state": "observed", "count": 13617, "frp": 20444.1,
                 "satellites": { "NOAA-20": 7000, "NOAA-21": 6617 },
                 "evidence": "global delivery: 96,123 records" }
    },
    "baseline": null
  }],
  "summary": {
    "observedDays": 8, "zeroDays": 0, "partialDays": 0, "unknownDays": 357,
    "totalDetections": 73215,
    "unknownReason": "outside_window",
    "note": "Unknown is not zero."
  },
  "buckets": [{
    "key": "2026-W45", "label": "Week 45", "start": "2026-11-02", "end": "2026-11-08",
    "state": "observed", "modis": 0, "viirs": 0, "total": 0,
    "observedDays": 2, "unknownDays": 5
  }],
  "baseline": {
    "available": false,
    "reason": "A climatological baseline needs archive years; only 8 days are stored.",
    "method": "robust median/MAD over observed days only"
  }
}
```

Backward-compatible fields kept: `available` (= state != `unknown`), `modis`, `viirs`, `total`,
`modisFrp`, `viirsFrp`, `availableDays`.

Rules:
- Aggregates never treat `unknown` as zero. `zeroDays` only counts `observed_zero` days.
- Baseline statistics use **observed days only** and are suppressed below 7 observed days.
- `period=week` uses ISO weeks; `month` uses calendar months; `season` uses DJF/MAM/JJA/SON.

## 3. `GET /api/day/{date}`

```jsonc
{
  "date": "2026-11-08",
  "state": "observed",
  "region": "amazon",
  "sensors": { "modis": {…}, "viirs": {…} },
  "confidence": { "modis": {"low":0,"nominal":0,"high":0}, "viirs": {…} },
  "frp": { "modis": {"median":..,"p90":..,"max":..}, "viirs": {…} },
  "observations": [ { "id": "...", "sensor": "viirs", "satellite": "NOAA-20",
                      "lat": -3.2, "lon": -62.1, "time": "2026-11-08T17:51:00Z",
                      "frp": 12.3, "confidence": "nominal", "daynight": "D" } ],
  "provenance": { "sources": [...], "ingestedAt": "..." },
  "method": "text"
}
```

## 4. `GET /api/harmonization`

Adds `gridSensitivity` and a defensible `methods` ladder. Existing fields stay.

```jsonc
{
  "grid": 0.25,
  "methods": [
    { "id": "A", "name": "Native MODIS statistics", "unit": "detections / MW",
      "formula": "…", "inputs": "…", "sample": {"days": 8, "detections": 76114},
      "assumptions": ["…"], "limitations": ["…"],
      "uncertainty": "…", "validation": "descriptive", "headline": false },
    { "id": "B", "name": "Native VIIRS statistics", … },
    { "id": "C", "name": "Common-grid descriptive comparison", … },
    { "id": "D", "name": "HFAI-v1 (experimental)", "validation": "experimental", "headline": false },
    { "id": "E", "name": "HFAI-v2 opportunity-weighted density", "validation": "experimental", "headline": true }
  ],
  "gridSensitivity": [
    { "grid": 0.1, "activeCells": 0, "pairedCellDays": 0, "ratio": 0, "ratioCi95": [0,0],
      "modisDensity": 0, "viirsDensity": 0, "combinedDensity": 0, "runtimeMs": 0 }
  ]
}
```

`/api/harmonization?grid=0.1|0.25|0.5` controls the comparison grid.

## 5. AI (Ollama)

- `GET /api/ai/status?probe=1` → provider (`ollama` | `deterministic`), reachable, model,
  models list, latency, note. Never claims availability when the server is down.
- `GET /api/ai/models` → installed models with size, family, parameter count, quantization and a
  hardware-fit judgement for 4 GB VRAM.
- `POST /api/intelligence` → adds `mode` (`deterministic` | `ollama`), `model`, `latencyMs`,
  `grounding` (`{checked: n, violations: []}`), `phrasedBy`.
- Deterministic analysis is always computed first; the model may only rephrase it.
- If the model output introduces numbers absent from the evidence, the engine rejects it and
  returns the deterministic text with `grounding.violations`.
- `POST /api/intelligence/stream` (SSE) streams the model text when available; the UI must label
  the mode at all times and never fake typing in deterministic mode.

## 6. Non-negotiables

- No unknown-as-zero anywhere: backend, UI, exports, tests.
- No invented VIIRS confidence percentages; confidence classes are a display convention.
- HFAI stays labelled experimental and out of the headline KPI strip.
- Imagery date is shown separately from the fire window.
- Reports embed methodology version + coverage states.


---

## Implementation status

| Contract item | Status | Where |
|---|---|---|
| Three observation states | done | `engine/app/coverage.py`, `scientific.calendar`, `scientific.day_detail` |
| `coverage_days` materialisation | done | `db.rebuild_coverage`, refreshed after ingest |
| `GET /api/calendar` v2 (periods, states, baseline) | done | `engine/app/main.py`, `app/calendar/page.tsx` |
| `GET /api/day/{date}` | done | `scientific.day_detail`, day drawer |
| Grid parameter + sensitivity | done | `scientific.harmonization(grid=, sensitivity=)` |
| HFAI-v2 paired cell-day metric | done | `hfaiV2` in `/api/harmonization` |
| Methods ladder A–E | done | `methods[]` in `/api/harmonization` |
| AI status / models / mode / grounding | done | `analyst.ai_status`, `ai_models`, `_grounding` |
| SSE stream | done | `POST /api/intelligence/stream` |
| Dark/light theme | done | `lib/theme.ts`, `ThemeProvider`, `ThemeToggle`, CSS variables |
| Banner logo + textured Earth in intro | done | `components/intro/CinematicIntro.tsx`, `public/brand/lh-studios-mark.png`, `public/textures/earth-2k.jpg` |
| Calendar exports (CSV/JSON/print) | done | `app/calendar/page.tsx` |
| Unknown never zero | done | enforced in `coverage.combine_states` + tests |
