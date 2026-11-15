# Temporal Aggregation

How acquisition time becomes a day, and what that choice hides.

---

## 1. Time conventions

| field | storage | notes |
| --- | --- | --- |
| `ts` | INTEGER, UTC epoch **milliseconds** | the only field used for matching |
| `acq_date` | TEXT `YYYY-MM-DD`, UTC | the day dimension for every aggregate |
| `acq_time` | TEXT `HH:MM`, UTC, as reported | never timezone-shifted |
| `ingested_at` | INTEGER, epoch ms | when *we* wrote the row — never used in analysis |
| `ingest_runs.started_at/finished_at` | epoch ms | operational history only |

Acquisition time and ingestion time are separate columns and are never mixed.
The feeds publish UTC; no local-time conversion is applied anywhere, and the UI
labels times with `Z`.

## 2. Daily boundary

A detection belongs to the UTC calendar day of its acquisition timestamp.

* `acq_date` is computed once at parse time from the source's date + time and is
  immutable thereafter.
* Day boundaries are UTC midnight, not local midnight and not "a 24 h window
  ending now". This matters for regions with large UTC offsets (e.g. Amazon
  local time = UTC−4/−5): a fire at 22:30 local is *the next UTC day*.
* Consequence: a "day" in the calendar is a UTC day. The UI states this.

## 3. Overpasses and double counting

MODIS Terra/Aqua each cross twice a day (ascending + descending), VIIRS on three
platforms up to six times. Without a reduction, one fire would be counted 4–6
times per day.

Implemented reductions:

1. **Cell-day maximum** (`harmonize.cell_days`) — `max(FRP)` per
   (cell, day, sensor). Used by HFAI-v1/v2 and the calendar's derived layer.
2. **One-to-one matching** (`compare.comparison`) — each detection used at most
   once, greedy by distance.
3. **Daily counts** — raw detection counts per sensor-day are reported as counts
   of *detections*, explicitly not as counts of fires.

Nothing in the pipeline sums FRP across overpasses for a density metric; a
`SUM(frp)` appears only where the label says "total reported FRP".

## 4. Aggregation levels

| level | definition | where |
| --- | --- | --- |
| detection | one row in `observations` | `/api/observations` |
| cell-day | cell × UTC day × sensor, max FRP | `harmonize` |
| sensor-day | all cells for one sensor on one UTC day | calendar `modis`/`viirs` |
| day | both sensors on one UTC day, with a coverage state | `/api/calendar` |
| week / month / season | buckets over the day list, derived, never re-queried | `_bucket` |
| year | one calendar year of days | `/api/calendar?year=` |

Week = ISO week (Monday start). Month = calendar month. Season = meteorological
(`DJF, MAM, JJA, SON`). A bucket inherits `observedDays`, `zeroDays`,
`unknownDays`; it is never assigned a total from a partially covered period
without those counts.

## 5. Historical monthly common-scale activity

`/api/calendar/history` also reports raw detection-record counts and FRP sums
per sensor and year-month. Its experimental common-scale series is different:
it counts occupied `0.25°` cell-days per month, with MODIS as the reference.
This is an activity index, not FRP, fire intensity, burned area, or a sensor
conversion.

For a selected AOI and date range, the engine forms monthly MODIS/VIIRS ratios
only where both sensors have positive occupied-cell-day counts. It trains on
the earlier paired years and holds out the latest 20% of paired years (at
least one year). The minimum is three training years, twelve training months,
and three holdout months. The API returns the candidate median ratio and
holdout metrics for audit, but exposes an applicable factor for VIIRS
substitution only if it reduces holdout mean absolute error against MODIS
compared with unadjusted VIIRS. The API also returns raw and adjusted MAE,
MAPE, and relative bias.

This is temporal internal validation against another sensor, not independent
validation against a common reference or fire-perimeter ground truth. If the
sample or holdout improvement requirement is not met, VIIRS-only months remain
unknown in this index; raw MODIS and VIIRS views remain separate. Same-month
anomalies require values from at least three other years.

## 6. Overpass opportunity (reported, not corrected)

Each platform-day has a nominal 2 overpasses. The payload reports
`nominalOpportunities = observedDays × 2` and
`detectionsPerNominalOpportunity`, with `adjusted: false`.

Why not divide by it: the real number of looks depends on swath overlap,
latitude, duty cycle and scheduling, none of which the keyless feeds publish.
Dividing by a nominal constant would create a false precision — the same mistake
as assuming three VIIRS platforms give exactly 1.5× the coverage of two.

The paired cell-day restriction (HFAI-v2) is the only opportunity control
applied, and it is a *restriction*, not a correction.

## 7. Missing days

A day is never interpolated, filled forward, or created from a neighbouring day.
Absent delivery ⇒ the day carries `COVERAGE_UNKNOWN` (or `PRODUCT_UNAVAILABLE`),
and derived values are `null`, not `0`. Series built for baselines include only
delivered days (`observed_only`), and the sample size is reported.

## 8. Known temporal limitations

1. One day is the finest published resolution; sub-daily fire growth is invisible.
2. UTC days do not align with local fire-management days.
3. Two detections hours apart are one day; a fire that starts at 23:00 UTC and
   peaks at 01:00 UTC is split across two days.
4. The stored window is 8 consecutive days (2026-11-07 → 2026-11-14). Weekly,
   monthly and seasonal views are *descriptive views of that window*, not
   climatology, and the calendar says so.
5. Acquisition times are as reported by the feed; no geolocation-dependent
   overpass model is applied.
