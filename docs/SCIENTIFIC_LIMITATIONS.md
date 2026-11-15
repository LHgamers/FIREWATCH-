# Scientific Limitations

Written to be read by a judge, a scientist, or a firefighter deciding whether to
trust a number. Every limitation below is real in this build. None of them is
worked around by inventing data.

---

## 1. What a detection is not

| Not this | Why |
| --- | --- |
| Not a wildfire | A thermal anomaly is a hot pixel. Gas flares, industrial stacks, volcanoes, open burning and solar farms all trigger it. The feed carries no `type` field we can rely on for every row. |
| Not a fire perimeter | No geometry beyond a pixel footprint. Nothing here is a burned-area boundary. |
| Not burned area | Burned area comes from reflectance change over days (MCD64A1 / VNP64A1). Those products are not ingested and cannot be derived from FRP. |
| Not fire size | A 1 km MODIS pixel can hold a campfire or a 10,000 ha front. `scan`/`track` give the footprint, not the fire. |
| Not severity | No dNBR, no post-fire reflectance, no soil burn severity. |
| Not emissions | FRP → emissions needs a biome-specific emissions factor and a combustion completeness model. None is applied; the platform reports FRP as measured power. |
| Not a probability | MODIS `confidence` is retrieval confidence; VIIRS `l/n/h` are retrieval categories. Neither is P(fire). |

## 2. Cross-sensor harmonization is bounded

* **Footprint:** MODIS integrates 1 km², VIIRS 375 m × 375 m (≈0.14 km²). One
  MODIS pixel overlaps ≈7 VIIRS pixels. Co-location at a grid cell is not
  co-measurement, and no resampling can recover the missing spatial detail.
* **Saturation:** MODIS band 31 and the VIIRS I-5 channel saturate in intense
  fires, so peak FRP is biased low for the largest events — precisely where the
  number matters most.
* **Overpasses:** MODIS sees the surface 4×/day, VIIRS 6×/day, at different
  times. A VIIRS-only count is not "more fire"; it is more looks.
* **Retrieval algorithms differ** (contextual thresholding vs. the VIIRS
  active-fire algorithm). Equal FRP values from the two sensors do not carry
  equal uncertainty.
* **HFAI-v1/v2 are unvalidated.** They are labelled `experimental` with
  `validation: none in this build` in every payload. There is no airborne
  radiometer, no perimeter, no ground truth in the workspace. HFAI is reported,
  never used as a correction factor.

## 3. Coverage and the zero problem

* Zero detections is reported as `COVERAGE_CONFIRMED_ZERO_DETECTIONS` **only**
  when product delivery is established, and even then it is conditional: cloud,
  smoke, off-nadir viewing and threshold effects can all hide a real fire.
* Delivery is inferred from *global* product presence, not from AOI geometry.
  Keyless feeds publish detections, not granule footprints.
* `PRODUCT_UNAVAILABLE` is request-relative: it records what we asked for and
  what failed, not a NASA-wide outage.
* Everything outside `2026-11-07 → 2026-11-14` is `COVERAGE_UNKNOWN` without a
  `FIRMS_MAP_KEY`. There is **no** multi-year climatology in this build, so no
  statement about "above normal" fire activity is supportable. The baseline in
  the product is a median/MAD over the stored window and is labelled indicative.

## 4. Temporal and spatial resolution

* One day, UTC, as the finest unit. Diurnal cycles, overnight vs. afternoon
  burning, and multi-overpass flare-ups are not resolvable.
* Grid analysis at 0.1° / 0.25° / 0.5°. Density changes ~8× between 0.1° and
  0.5° on the same data because the active-area denominator changes; densities
  from different grids are never comparable.
* No sub-pixel fire size, no spread rate, no direction of travel.

## 5. Detection artefacts that survive into the data

| artefact | effect |
| --- | --- |
| Gas flares | Persistent, high-FRP, non-wildfire pixels inflate counts and FRP |
| Volcanoes | Hot lava produces detections with no vegetation fire |
| Industrial heat | Smelters, kilns, power plants |
| Sun glint / desert hot surfaces | False positives in low-latitude deserts at certain geometries |
| Cloud edges | Partial cloud can mimic or mask a hot pixel |
| Bow-tie / duplication at swath edges | Same fire reported twice within seconds; collapsed by identity, but not always |
| Water/coastline | VIIRS occasionally reports boats and coastal industry |
| `frp = 0` rows | 89 pre-existing rows store FRP exactly 0 — preserved, not "fixed" |

## 6. Imagery is not evidence

* GIBS true colour trails the fire feeds. The composite shown can be **days older
  than the newest detection**; the UI prints both dates side by side.
* Imagery is a visual context layer only. No pixel of it feeds a statistic.
* GIBS serves HTTP 200 with a placeholder frame for missing dates, so imagery
  availability is decided by a decoded-tile test (`coverage ≥ 0.5`, `mean ≥ 60`),
  never by status code.
* GIBS *vector* thermal tiles are unusable in this build (`TILEMATRIXSET is
  invalid for LAYER`, `_Level8` 404s) and are not used.

## 7. Model layer

* FIREWATCH AI local runtime (Ollama base model `phi4-mini:latest`, 3.8B, Q4) on an RTX 3050 with 4 GB VRAM.
  An 8B model does not fit; ~24 s per answer is the realistic budget.
* The model **may not compute** anything. The deterministic analyst produces the
  answer, evidence and citations first; the model only rephrases. Every number
  in its prose is checked against the evidence JSON, and ungrounded output is
  rejected wholesale (`grounding.status = "rejected"`).
* With Ollama absent the platform falls back to the deterministic answer and
  says so (`mode: deterministic`). No answer is ever fabricated.

## 8. Engineering limits

* Single-tenant, local-first: SQLite, one engine process, no auth layer. It is
  not a hardened multi-user service.
* Scale ceiling: ~874k rows answers in milliseconds thanks to SQL-side
  aggregation and a 900 s cache, but a multi-year global archive would need a
  columnar store.
* The map basemap stays night-toned in both themes; a light basemap was not
  available offline and mismatched the imagery layer.
* `next build` with the full intro requires WebGL at runtime; no-JS clients get
  the app shell without data.
* Mid-animation screenshots are not capturable by the automated harness
  (WebGL + 15 s snapshot timeout); visual proof of the intro was obtained from a
  static probe page rendering the same scene.

## 9. What would remove each limitation

| limitation | needs |
| --- | --- |
| No history / no climatology | `FIRMS_MAP_KEY` + a backfill campaign (schema and checkpoints are ready) |
| Conditional zeros | granule footprint metadata, or a keyed per-AOI coverage product |
| Unvalidated HFAI | airborne FRP + perimeter ground truth for calibration |
| No burned area | ingest MCD64A1 / VNP64A1 (different product family, weeks of latency) |
| Flare/volcano contamination | a persistent-source mask (VIIRS Nightfire, or a static flare inventory) |
| No sub-daily dynamics | per-overpass ingestion (feeds publish pre-aggregated days) |
| Model quality | ≥8 GB VRAM or a quantised 7–8B model at ~2 tok/s |
