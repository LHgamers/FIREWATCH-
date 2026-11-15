# Browser & endpoint research

**Project:** FIREWATCH AI · **Researched:** 2026-11-14 (UTC) · **Researcher:** LH Studios build agent

This file records what was actually verified against live endpoints, not what a model remembers.
Every entry states the URL, the observed response, and the consequence for the product.

> Method note: research was performed with direct HTTPS requests to the official NASA hosts
> (documented `curl` probes and JSON inspection) rather than an interactive browser session,
> because the challenge sources are machine-readable APIs. Where a source could not be read,
> that limitation is recorded below instead of being papered over.

---

## 1. challenge definition

| Source | URL | Status | What it says / why it matters |
|---|---|---|---|
| NASA Space Apps Challenge | https://www.spaceappschallenge.org/ | reachable (site) | Official challenge hub. The 2026 challenge set is published there; this build targets *Harmonization of MODIS and VIIRS Hot Spots*. |
| FIRMS | https://firms.modaps.eosdis.nasa.gov/ | **200** | Official distribution point for MODIS and VIIRS active fire detections, NRT + archive. |
| FIRMS FAQ | https://firms.modaps.eosdis.nasa.gov/faq/ | reachable | States that FIRMS publishes detections within ~3 h of overpass and that detections are thermal anomalies, not confirmed fires. Used for the "what cannot be inferred" copy. |
| FIRMS Data API guide | https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_api_use.html | reachable | Documents the area API: `/api/area/csv/{MAP_KEY}/{SOURCE}/{W,S,E,N}/{DATE}`. **A free MAP_KEY is required.** |

**Consequence:** the product must work without a key and be explicit about the shorter horizon.

---

## 2. data access — what works without credentials

### 2.1 MODIS C6.1 rolling CSV (open)

```
GET https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_7d.csv
→ 200, 5,863,759 bytes, 76,068 lines (header + 76,067 detections)
```

Fields observed: `latitude, longitude, brightness, scan, track, acq_date, acq_time, satellite,
confidence, version, bright_t31, frp, daynight`. `satellite` is `T` (Terra) or `A` (Aqua);
`confidence` is an integer percentage; `version` is `6.1NRT`.

A 24 h variant (`..._Global_24h.csv`) also returns 200. A date-stamped archive variant, e.g.
`..._Global_2025-08-01.csv`, returns **404** — historical single-day files are not exposed on
this path.

**Consequence:** MODIS near-real-time is fully available; MODIS multi-year history requires the
keyed area API.

### 2.2 VIIRS 375 m via NASA's hosted ArcGIS feature service (open)

```
GET https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/
    Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity/FeatureServer/0?f=json
→ 200
```

Observed service metadata: `maxRecordCount: 16000`, `supportsPagination: true`, geometry
`esriGeometryPoint`, fields:

```
OBJECTID, latitude, longitude, bright_ti4, scan, track, acq_date, acq_time,
satellite, confidence, version, bright_ti5, frp, daynight, esritimeutc, hours_old
```

Query behaviour:
- `returnCountOnly=true` → **794,839** features at research time.
- min/max `esritimeutc` → **2026-11-07 → 2026-11-14** (a rolling ~7-day window).
- `confidence` is a string (`low` / `nominal` / `high`), **not** a percentage. This is the
  central harmonization trap and is preserved natively by the ingestion code.
- `acq_date` is a midnight timestamp, `acq_time` is a separate timestamp field, and
  `esritimeutc` is the authoritative acquisition instant. The ingest uses `esritimeutc`.

Paging detail: offset paging fails with `HTTP 400` on deep pages (observed at roughly page 20
of 16k records). A keyset cursor (`where=OBJECTID > last ORDER BY OBJECTID ASC`) is reliable and
was adopted; a full 7-day ingest completes in ~230 s at 8k records/page.

**Consequence:** VIIRS NRT is available; it dominates the detection count (~10× MODIS) for
footprint reasons documented in `SCIENTIFIC_METHODOLOGY.md`.

### 2.3 FIRMS archive (keyed)

```
GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/VIIRS_NOAA20_NRT/{W,S,E,N}/{DATE}[/days]
```

Implemented in `engine/app/sources.py::fetch_firms_archive`; enabled automatically when
`FIRMS_MAP_KEY` is present. Without the key the endpoint is not called and the UI reports
`archive.enabled = false` with an explanation. No example key or scraped key is used anywhere.

---

## 3. imagery — NASA GIBS (open)

| Layer | Probe | Result |
|---|---|---|
| VIIRS true colour, WMTS JPEG | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/2024-08-01/GoogleMapsCompatible_Level9/3/3/2.jpg` | **200**, `image/jpeg` |
| VIIRS true colour, WMS GetMap | `.../wms/epsg4326/best/wms.cgi?...LAYERS=VIIRS_SNPP_CorrectedReflectance_TrueColor...&TIME=2026-11-13` | **200**, 1024×512 JPEG |
| Thermal-anomaly *raster* WMTS | `.../VIIRS_SNPP_Thermal_Anomalies_375m_All/.../{z}/{y}/{x}.png` | **400 / 404** — the thermal anomaly layers are published as vector tiles only; the advertised `GoogleMapsCompatible_Level9` matrix does not serve them as raster |

**Consequence:** GIBS is used for the *imagery* basemap and the dashboard Earth view (real NASA
data, any date, no key). It is **not** used as a source of hotspot counts — that would have been
an unverifiable derived statistic.

---

## 4. supporting reference material used for the knowledge base

| Topic | Source | Use |
|---|---|---|
| MODIS active fire product & confidence semantics | https://firms.modaps.eosdis.nasa.gov/descriptions/FIRMS_MODIS_Active_Fire_Products.html | Field explanations, confidence percentage |
| VIIRS 375 m product | https://firms.modaps.eosdis.nasa.gov/descriptions/FIRMS_VIIRS_Active_Fire_Products.html | 375 m footprint, low/nominal/high confidence |
| FRP definition | Wooster et al. (2003); Kaufman et al. (1998) — cited, not redistributed | FRP units and interpretation |
| Retrieval algorithms | Giglio et al. (2016) MODIS C6; Schroeder et al. (2014) VIIRS 375 m | Basis for "not interchangeable" claim |
| MapLibre GL JS | https://maplibre.org/maplibre-gl-js/docs/ | Map implementation |
| GIBS WMTS capabilities | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml` | Confirmed layer identifiers and time extents (VIIRS thermal anomalies: 2012-01-20 → 2026-11-02, with gaps) |

---

## 5. sources that were NOT usable in this environment

| Source | Issue | Handling |
|---|---|---|
| FIRMS archive API | Requires a MAP_KEY issued after registration; no key present | Archive path implemented and gated; UI states the limitation |
| GIBS thermal-anomaly raster tiles | Served as vector only; raster matrix rejected | Not used for counts; only imagery is used |
| Earthdata Login-protected products (e.g. MCD14ML via LAADS) | Requires user authentication | Out of scope; designated in the UI as requiring a key |
| Local inference server | No Ollama / llama.cpp endpoint detected on :11434 at build time | Deterministic analyst is the default; the LLM path is implemented and probed at runtime |

---

## 6. hardware profile (as inspected, not assumed)

```
GPU          NVIDIA GeForce RTX 3050 Laptop GPU
VRAM total   4,096 MiB (4 GB) — matches the "4 GB profile" in the brief
VRAM used    0 MiB at inspection
Driver       610.88
Node         v26.7.0 · npm 11.19.0
Python       3.14.5
```

The brief anticipates an RTX 5090 and a 4 GB profile. Only the 4 GB device is present, so the
AI configuration defaults to "no model" and the product runs on the deterministic evidence
engine. Any 1–4B quantised model served over an OpenAI-compatible or Ollama endpoint can be
enabled with `AI_PROVIDER` / `AI_BASE_URL` / `AI_MODEL`; the prompt restricts it to rephrasing
evidence that Python already computed.

---

## 7. verified ingest result

```
source              records   window
MODIS C6.1 (7d)      76,114   2026-11-07 → 2026-11-14
VIIRS 375 m (NRT)   795,243   2026-11-07 → 2026-11-14
total               871,357
```

Daily MODIS counts: 11,966 / 11,964 / 9,620 / 11,022 / 11,147 / 9,252 / 9,089 / 2,054 (partial day).
Daily VIIRS counts: 92,608 – 128,987. The ratio is discussed and explained in the methodology;
it is never used as a conversion factor.
