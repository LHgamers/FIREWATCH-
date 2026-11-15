# Validation Report

**Conclusion up front: the HFAI harmonization indicators in this build are
`not_independently_validated`.** No independent reference product, ground truth,
or airborne measurement is stored. The historical calendar has a separate
occupied-cell-day index that may apply an AOI- and date-range-specific VIIRS
factor only after a later-year holdout improves its error against MODIS. That is
internal temporal validation, not independent sensor calibration or ground
truth.

This report separates what *was* checked (reproducibility, internal consistency,
sensitivity) from what *was not* (agreement with physical fire extent or
intensity).

---

## 1. Validation status by component

| component | status | basis |
| --- | --- | --- |
| Raw detections | as delivered by NASA/FIRMS | provenance fields per row; no transformation |
| FRP values | as reported (MW) | no conversion applied anywhere in code |
| Confidence | native per sensor | MODIS % preserved; VIIRS categorical; `confidence_pct` NULL |
| HFAI-v1 density | `experimental`, `not_independently_validated` | reproducible formula, bootstrap CI, no ground truth |
| HFAI-v2 paired ratio | `experimental`, `not_independently_validated` | bootstrap CI, no ground truth |
| Matched comparison | descriptive only | explicit tolerance rules; no ground truth |
| Coverage states | evidence-based | delivery inference documented; conditional zero stated |
| Baselines / anomalies | gated on sample size | climatology refuses below 3 years |
| Calendar | descriptive | states, not estimates |
| Monthly common-scale activity | experimental, conditional | median factor from paired positive months; later-year holdout vs unadjusted VIIRS; no external reference |

## 2. What was verified internally

### 2.1 Reproducibility

Every derived number is recomputable from stored rows:

```
python -m pytest engine/tests -q      → 137 passed
```

Phase 2 tests assert formulas rather than snapshots:

* `test_hfai_v1_formula_is_reproducible` recomputes
  `Σ max FRP / Σ exact cell area / delivery days` from first principles and
  compares with the payload.
* `test_hfai_v2_ratio_matches_the_paired_cell_days` builds a seeded case where
  MODIS FRP is exactly 2× VIIRS and asserts `ratio == 2.0` and
  `pairedCellDays == 20`.
* `test_grid_sensitivity_reports_every_grid_and_density_changes` asserts the
  three grids produce different densities — i.e. the grid dependence is visible,
  not hidden.
* `test_grid_sql_matches_python_floor` proves the SQL grid assignment equals
  `math.floor` at boundaries including 0° and ±90°.
* `test_polygon_area_matches_bbox_for_rectangle` proves the spherical ring area
  equals the exact zone area for a rectangle.
* `test_antimeridian_polygon_filters_correctly` proves a wrapping ring selects
  both sides of ±180° and excludes the far side of the globe.
* `test_calendar_polygon_is_exact_not_bbox_surrogate` proves a polygon AOI
  returns fewer detections than the enclosing bbox.

### 2.2 Cross-endpoint consistency

For the same AOI/window, the payloads agree — checked on the live engine:

| check | result |
| --- | --- |
| `/api/platforms` MODIS detections vs `/api/summary` MODIS | equal |
| VIIRS platform rows (NOAA-20 + NOAA-21) sum vs VIIRS total | 64,374 vs 64,374 (Amazon) |
| `/api/calendar` day totals vs `/api/day/{date}` totals | equal |
| `/api/harmonization/v2` paired cell-days vs `/api/comparison` pairs | different by design (cell-day vs detection matching), both reported |
| coverage `observedDays` per sensor vs delivery days | 8 vs 8 |
| dataset records vs `COUNT(*)` | equal after reconciliation |

### 2.3 Sensitivity (does a defensible choice change the answer?)

| choice | effect | disclosed? |
| --- | --- | --- |
| grid 0.1° vs 0.5° | density 10× | yes — grid printed with every value |
| matching radius 0.5 vs 10 km | MODIS match share 41 % → 84.5 %; FRP ratio 3.56 → 3.40 | yes — full sweep in payload |
| temporal window 0 h vs 24 h | pairs −34 %; FRP ratio 3.46 → 4.27 | yes — sweep in payload |
| area denominator (active vs AOI) | 5× difference | documented; only active-area density published |

The FRP ratio is *stable* under radius changes and *sensitive* to the time
window. That is a finding, not a defect, and it is stated.

## 3. What was not validated, and why

| missing reference | consequence |
| --- | --- |
| Burned area (MCD64A1 / VNP64A1) | cannot test whether detections correspond to burned pixels |
| Fire perimeters | cannot test spatial accuracy of aggregation |
| Airborne FRP | cannot test the FRP magnitude |
| Cloud/quality masks per overpass | cannot compute per-pixel detection probability |
| Granule footprints | cannot compute true AOI coverage (only global delivery) |

Without these, the honest claim is: *the numbers are reproducible, dimensionally
explicit, sensitivity-tested and clearly labelled — not validated.*

## 4. Failed or rejected validation ideas

| idea | why rejected |
| --- | --- |
| Treat VIIRS as truth and calibrate MODIS to it | assumes the sensor with more detections is correct; unsupported |
| Fit a MODIS→VIIRS FRP factor from the 8-day window | one window, one AOI, no ground truth; a fitted constant would be a fabricated calibration |
| Use burned area as ground truth for hotspot counts | different phenomenon, different latency; contextual at best |
| Declare agreement "good" because ratios are near 2 | a ratio is not accuracy; agreement of two sensors can be shared bias |

## 5. Conditions under which validation could be claimed

1. Ingest MCD64A1 (or VNP64A1) and compare detected cell-days against burned
   pixels within a stated lag — reported as *contextual agreement*, not accuracy.
2. Obtain airborne FRP (e.g. a research campaign dataset) for at least one
   region-day and compare per-fire FRP distributions.
3. Obtain granule footprints to compute per-AOI coverage and re-derive states.
4. Only then may `validationStatus` change — and each claim must name its
   reference, region, window and uncertainty.

Until then, every payload keeps:

```json
{"status": "experimental", "validationStatus": "not_independently_validated"}
```
