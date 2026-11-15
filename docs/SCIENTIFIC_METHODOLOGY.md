# Scientific methodology

**FIREWATCH AI — Harmonization of MODIS and VIIRS Hot Spots**
LH Studios · NASA Space Apps Challenge 2026
Version 1.0 · 2026-11-14

This document describes exactly how the platform turns two dissimilar satellite products into
comparable quantities, how uncertainty is expressed, and where the method stops being valid.

---

## 1. The problem

MODIS and VIIRS both detect thermal anomalies, but a "hotspot" is not a common unit:

| Property | MODIS C6.1 | VIIRS 375 m |
|---|---|---|
| Nominal pixel | 1 km | 375 m (0.140625 km²) |
| Platforms in this build | Terra + Aqua | Suomi-NPP, NOAA-20, NOAA-21 |
| Overpasses per day | ~4 (day + night, two platforms) | ~6 (day + night, three platforms) |
| Confidence field | percentage 0–100 | ordinal low / nominal / high |
| Effective detection limit | larger fires | smaller / cooler fires |
| Saturation behaviour | 4 µm channel can saturate on large fires | different saturation and aggregation |

Consequences:

1. One MODIS detection may be several VIIRS detections over the same fire.
2. FRP is integrated over the pixel footprint, so **FRP values are not comparable per detection**.
3. Confidence classes are **not interchangeable** and no conversion is published.
4. VIIRS has more observation opportunities, so counts are inflated by sampling, not only by fire.

The platform therefore never converts MODIS to "VIIRS-equivalent" or the reverse. It computes
quantities that are defined independently of pixel size, and it reports the sensor ratio as an
observation, not a correction factor.

---

## 2. Ingestion and normalisation

`engine/app/sources.py`

1. **Fetch** – MODIS rolling 7-day CSV (open), VIIRS 375 m feature service (open, keyset paging),
   optional FIRMS area API (keyed) for archive windows.
2. **Preserve native fields** – `confidence` is stored both raw (`confidence_raw`) and, for MODIS
   only, as a percentage (`confidence_pct`). VIIRS percentage is never synthesised.
3. **Shared confidence view** – `confidence_class ∈ {low, nominal, high}`:
   - MODIS: `<30 → low`, `30–79.99 → nominal`, `≥80 → high` (the conventional FIRMS reading of
     the percentage).
   - VIIRS: native category.
   This is a *display and filtering view*. It is labelled as such in the UI.
4. **Time normalisation** – all times converted to UTC epoch milliseconds. VIIRS uses
   `esritimeutc` (the authoritative instant) rather than the midnight `acq_date` field.
5. **Deduplication** – identity is `sensor:satellite:lat(4dp):lon(4dp):timestamp`. Repeated
   ingestion of the same window is idempotent.
6. **No silent removal** – rows with unparseable coordinates or timestamps are dropped and
   counted; rows with missing FRP keep `NULL` (never `0`).

Stored as of this build: **871,357 detections** (76,114 MODIS + 795,243 VIIRS),
2026-11-07 → 2026-11-14.

---

## 3. Spatial and temporal alignment

- **Temporal:** aggregations are done on UTC dates. A day is *observed* for a sensor when
  product-delivery evidence exists for that sensor-day, and *verified zero* when the product was
  delivered and no detection was recorded. A day with no delivery evidence is **unknown** and its
  counts are `null` in every payload — never `0`. Only days with delivery evidence can be read as
  zero.
- **Spatial:** comparison uses a fixed graticule (0.1° / 0.25° / 0.5°, chosen per request), indexed
  by the shifted floor `floor((lat + 90)/cell), floor((lon + 180)/cell)` so cells never straddle
  0° and negative coordinates are not truncated toward zero. Cell area is the **exact spherical
  zone area** `R² · Δλ · (sin φ₂ − sin φ₁)` in km², not a flat `cos(lat)` approximation; on the
  Amazon window the two differ by about 0.5 %, which is small but systematic.
- **Overpass suppression:** for each `(cell, day, sensor)` the **maximum** reported FRP is kept.
  Summing overpasses would multiply the same fire by the number of times a satellite passed.
  The maximum is a conservative estimate of the cell-day's peak radiative power.

---

## 4. HFAI-v1 — experimental harmonized fire intensity

**Definition**

For a region `R` and window `D` (days):

```
HFAI = Σ_{cell-day ∈ A} max(FRP_MODIS, FRP_VIIRS) / (A_active × |D|)
```

where `A_active` is the union of 0.25° cells that reported at least one detection (weighted by
their true area), and the numerator sums the per-cell-day maximum across sensors so a fire seen
by both instruments is counted once.

**Units:** MW km⁻² day⁻¹ — radiant power per unit area of actively burning ground per day.

**Why this quantity**

- It is **independent of pixel size**: both sensors contribute MW, and area is the common
  denominator.
- It is **independent of overpass count** at first order, because of the per-cell-day maximum.
- It stays interpretable at any zoom: it is an intensity over burning area, not a sum over the
  globe that would be dominated by unburned land.

**Sensor-specific densities** (`modisDensity`, `viirsDensity`) are the same expression restricted
to one sensor's cell-days and divided by the same active area, so the two are directly comparable
within the region.

**Ratio**

On cell-days observed by **both** sensors, `r = 10^mean(log10 FRP_MODIS − log10 FRP_VIIRS)`.
A 95% bootstrap interval is produced by resampling the paired log-differences 600 times when at
least 12 paired cell-days exist. With fewer than 12, the point estimate is reported and the
interval is `null` — the platform does not manufacture precision.

**Observed values (global, 2026-11-07 → 2026-11-14)**

```
HFAI combined            408 MW km⁻² day⁻¹ over active area
MODIS mean cell FRP      ~43 MW
VIIRS mean cell FRP      ~17 MW
MODIS/VIIRS ratio        1.47  (95% CI 1.44 – 1.49, 17,520 paired cell-days)
co-detection share       17.6% of active cell-days
```

Interpretation: for the same 0.25° cell-day, MODIS reports roughly 1.5× the FRP of VIIRS, as
expected when a 1 km pixel integrates ~7× the area of a 375 m pixel. The substantial
non-coincidence (82%) reflects footprint, timing and detection-threshold differences.

**Status:** *experimental*. It is not a calibrated equivalent, it is not validated against
burned-area or ground data here, and the ratio is region- and window-specific. Any reuse outside
this dataset must re-derive it.

---

## 5. Anomaly detection

```
robust z = (x − median(baseline)) / (1.4826 × MAD(baseline))
percentile = share of baseline days ≤ x
```

- The baseline is every stored day for the region except the target day.
- MAD is used because daily fire counts are heavy-tailed; a mean and standard deviation would be
  dominated by single large days.
- If `MAD = 0` no z-score is reported (division by zero would be meaningless).
- Baseline quality:
  - `adequate` ≥ 14 days
  - `limited` 7–13 days
  - `insufficient` < 7 days (no z-score is shown at all)
- With the current 8-day near-real-time window, results are `limited` at best, and the UI says so
  on every card.

An anomaly is a statistical statement about detection counts. It is **not** an emergency, a
forecast, or a statement about fire severity.

---

## 6. Missing data

Three distinct states are preserved end-to-end:

| State | Meaning | Presentation |
|---|---|---|
| `available: true, count > 0` | detections recorded | normal colour scale |
| `available: true, count = 0` | sensor reported, nothing detected in the region | hollow cell, explicitly zero |
| `available: false` | no satellite coverage stored for that day | hatched / blank, "no data" |

Conflating the last two would turn gaps in the record into apparent fire-free days. Cloud, smoke,
aerosol, sun glint and saturation can all suppress a detection, so an absent detection is never
treated as evidence of absence.

---

## 7. Validation

Automated (`python -m pytest engine/tests`, 16 tests, all passing):

- spatial area computation against known spherical geometry;
- MODIS confidence mapping and VIIRS ordinal mapping;
- CSV parsing: malformed rows dropped, missing FRP kept `null`, satellite identity preserved;
- sensor counts and bbox exclusion of a distant detection;
- missing days represented as unavailable, not zero;
- harmonization on a synthetic dataset where MODIS FRP is exactly 2× VIIRS: ratio recovers 2.0,
  paired cell-days counted correctly, MODIS-only day detected, active-cell and area accounting;
- anomaly detection on a controlled spike, plus explicit refusal when the requested date is
  outside coverage;
- haversine distance and radius filtering.

What is **not** validated here, and would be required before publication:

1. Comparison against mapped burned area (e.g. MCD64A1 or GFED) to test whether HFAI tracks
   actual combustion.
2. Cross-calibration against the official MODIS/VIIRS FRP intercomparison literature.
3. Sensitivity analysis on grid size (0.1° / 0.25° / 0.5°) and on the cell-day maximum rule.
4. Multi-season, multi-biome evaluation; the current window is eight days in November.

---

## 8. Non-claims

- A thermal anomaly is not a confirmed wildfire.
- Cause, area burned, rate of spread and suppression status cannot be derived from these records.
- The platform does not issue warnings and is not an emergency service.
- FRP is not fire size; it is radiant power at the moment of acquisition.
- Confidence is a retrieval property, not a probability that a fire exists.

---

## 9. Reproducibility

```bash
python -m engine.app.ingest --modis          # 76k rows, ~10 s
python -m engine.app.ingest --viirs          # 795k rows, ~230 s
python -m pytest engine/tests -q             # 16 passing
curl "http://127.0.0.1:8010/api/harmonization?region=global"
curl "http://127.0.0.1:8010/api/report.csv?region=amazon" -o report.csv
```

The report CSV embeds the region, bbox, window, coverage, per-sensor statistics, HFAI value,
ratio and interval, the full method text, every limitation, and up to 5,000 raw detections with
their provenance.

---

## 10. Imagery availability and performance

**Why a date cannot be trusted from an HTTP status.** GIBS WMTS answers `200 OK` with a
near-black placeholder JPEG for dates whose true-colour composite does not exist yet. Requesting
the newest fire date therefore produced a black basemap while every request looked successful.
The engine now decodes one z2 tile (Africa/Europe) per candidate date with Pillow and measures the
fraction of pixels brighter than grey 25 and the tile mean:

| Date | Mean grey | Pixels > 25 | Verdict |
|---|---|---|---|
| 2026-10-31 | 124.0 | 0.90 | imagery present |
| 2026-11-01 | 133.0 | 0.90 | imagery present |
| 2026-11-02 | 41.6 | 0.25 | partial frame, rejected |
| 2026-11-03 | — | — | HTTP 404 |

A date is accepted when coverage ≥ 0.50 and mean ≥ 60. `/api/imagery/latest` walks back at most
45 days, caches each probe, and reports `probed[]` so the UI can state the lag explicitly
(`requested 2026-11-14 → composite 2026-11-01`). The map never presents imagery as simultaneous
with the fire window; the composite date is shown next to the layer name.

**Aggregation cost.** The stored window holds 871,357 rows (≈316 MB SQLite). Early versions
materialised rows as Python dicts, costing 30 s for a global summary and 110 s for harmonization.
Aggregates are now computed by SQLite in a single `GROUP BY sensor, satellite, acq_date,
confidence_class, daynight` scan; only the FRP column is streamed for percentiles. Cold global
summary: ~9.5 s; warm (cached): ~0.03 s. `summary`, `timeseries` and `harmonization` share a 900 s
in-process cache that ingestion invalidates, and a background thread warms global, Amazon and
Congo at startup so the first page view is not the slow one.

## 11. Observation states — unknown is never zero

The v1 calendar treated "a detection exists" as "the day is available". That silently converts
missing coverage into zero activity, which is the single most common error in fire dashboards.
v2 resolves three states per sensor-day from **product-delivery evidence**:

| State | Meaning | Evidence |
|---|---|---|
| `observed` | product delivered and the area reported ≥ 1 detection | global delivery + local count > 0 |
| `observed_zero` | product delivered, the area reported exactly 0 detections | global delivery + local count = 0 |
| `unknown` | delivery cannot be established | no global record for that sensor-day |

A day is `partial` when at least one sensor has delivery evidence and at least one does not.
`partial` takes precedence over `observed`: a day where MODIS reported but VIIRS never delivered
is incomplete, and calling it "observed" would hide that.

Delivery is materialised in `coverage_days (sensor, satellite, acq_date, records, source,
first_seen, last_seen)` by one `GROUP BY` over `observations`. A polar-orbiting sensor that
delivered any record anywhere on a date proves its swath and product existed for that date. If it
delivered nothing anywhere, delivery is **unknown**, not zero — the conservative direction. The
assumption is stated in the UI: near-global daily coverage is expected from these platforms, but
clouds, smoke and saturation can still mask fires, so `observed_zero` means "no detection was
reported", never "no fire burned".

Baselines use observed days only. Unknown days never enter the sample, and a deviation is only
reported when at least **seven** observed days exist; below that the API returns
`quality.level = "insufficient"` and no z-score. The calendar baseline is a robust median/MAD over
the stored window, explicitly labelled as indicative rather than climatological.

## 12. HFAI-v2 and grid sensitivity

HFAI-v1 divides combined cell-day FRP by the union of active cells and by the number of
observation days. Its denominator is sensitive to which sensor saw a cell and to the grid size.

HFAI-v2 restricts the comparison to **paired cell-days** — cells and dates reported by both
sensors — and reports the mean FRP per paired cell-day for each sensor plus their ratio. This
removes unequal overpass counts (VIIRS has three satellites, MODIS two) but not footprint size,
saturation or cloud effects. It is labelled `experimental` with `validation: none in this build`;
no airborne or perimeter ground truth is available, so neither HFAI variant is calibrated.

Grid size is a first-class parameter (`0.1°`, `0.25°`, `0.5°`). Because the active-area
denominator changes with the grid, density changes too. Measured on the Amazon window
(2026-11-07 → 2026-11-14):

| Grid | HFAI-v1 density (MW km⁻² day⁻¹) | Active cells | Paired cell-days | Ratio |
|---|---|---|---|---|
| 0.1° | 0.0444 | — | — | 2.262 |
| 0.25° | 0.0130 | — | 1,866 | 2.139 |
| 0.5° | 0.0056 | — | — | 1.978 |

The density varies by ~8× across grids while the ratio stays near 2.1. The UI therefore always
prints the grid next to the number and never compares densities computed on different grids.

## 13. Language-model grounding

The deterministic analyst always runs first and produces the answer, evidence list, limitations
and citations. A local model (Ollama, `phi4-mini:latest`, 3.8B Q4_K_M, ~2.5 GB) may only rephrase
that payload. Every number in the model's prose is extracted and checked against the evidence
JSON; if any number cannot be grounded, the model output is **rejected** and the deterministic
answer is returned with `grounding.status = "rejected"`. The response always states
`mode` (`llm` or `deterministic`), `modeLabel`, `latencyMs` and the grounding result, so a reader
can tell which layer produced the text. No typing animation is used: deterministic sections are
emitted whole.
