# Burning Calendar Methodology

The calendar is the primary product of Phase 2. Every cell answers one question:
*what do we know about burning on this day, and how do we know it?*

Implementation: `scientific.calendar` + `cov.day_states` + `harmonize.daily`.

---

## 1. Cell content

Each day carries:

| field | meaning |
| --- | --- |
| `state` | `observed` · `observed_zero` · `partial` · `unknown` · `unavailable` |
| `stateCode` | `DETECTIONS_RECORDED` · `COVERAGE_CONFIRMED_ZERO_DETECTIONS` · `COVERAGE_PARTIAL` · `COVERAGE_UNKNOWN` · `PRODUCT_UNAVAILABLE` |
| `available` | `false` for unknown/unavailable — the UI must not color these as activity |
| `modis`, `viirs` | raw detection counts for that sensor-day (0 where none) |
| `modisFrp`, `viirsFrp` | Σ reported FRP (MW) — "total reported", not a density |
| `sensors.{modis,viirs}` | per-sensor state, code, evidence string, basis, satellites |
| `derived` | cell-based indicator for the day (see §3), or `null` |
| `baseline` | stored-window ratio / robust z for observed days only, or `null` |

## 2. State logic

```
delivered(sensor-day) from coverage_days (global product presence)
count(sensor-day)     from observations in the AOI

no delivery, no stored failure  → unknown      (COVERAGE_UNKNOWN)
no delivery, stored failure     → unavailable  (PRODUCT_UNAVAILABLE)
delivery, count ≥ 1             → observed     (DETECTIONS_RECORDED)
delivery, count = 0             → observed_zero (COVERAGE_CONFIRMED_ZERO_DETECTIONS)

day level:
both sensors known → observed | observed_zero
one known          → partial
none known         → unavailable | unknown
```

`partial` outranks `observed`: a day where MODIS reported and VIIRS never
delivered is incomplete, and calling it "observed" would hide a missing sensor.

`observed_zero` is a **conditional zero**: global delivery proves the product
existed, not that the AOI was imaged cloud-free. The wording is fixed in
`coverage.STATE_CODES` and repeated in the payload's `note`.

## 3. Derived indicator per day

```
cells_s(day) = { (cell) : max FRP from s in that cell-day }
Area_s(day)  = Σ exact spherical cell area over cells_s(day)
D_s(day)     = Σ max FRP / Area_s(day)                    [MW km⁻²]
D_all(day)   = Σ max(FRP_m, FRP_v) over union cells / Area_union
```

CI: percentile bootstrap over cell values (800 draws, seed fixed), suppressed
below 12 values. The day's derived block is `null` when there is no reduction —
never zero. `summary.derivedDays` counts days that actually carry one.

Measured (Amazon, 2026-11-07): MODIS 0.054995 (CI 0.046490 – 0.064680) over
366,279.7 km², VIIRS 0.004845 (CI 0.004295 – 0.005498) over 526,422.0 km²,
combined 0.031092 (CI 0.026543 – 0.036206) over 682,449.9 km². The daily
indicator is *not* the window density divided by days: it is computed per day
from that day's cells, so its uncertainty reflects that day's cell spread.

## 4. Buckets (week / month / season)

`_bucket` maps each day to its ISO week, calendar month or meteorological
season. A bucket carries `modis`, `viirs`, `total`, FRP sums, and
`observedDays`, `zeroDays`, `unknownDays`, `unavailableDays`. A bucket with
`observedDays == 0` has no meaningful total and is reported with state
`unknown`/`unavailable` rather than a zero.

## 5. Year comparison

`/api/calendar/compare?years=2025,2026` and
`/api/calendar?year=2026&compareYear=2025`.

* Only years with delivered observations are usable (`availableYears`).
* A bucket is compared only when both years have it; missing buckets are omitted,
  never zero-filled.
* With one year in the database the payload returns
  `comparisonAvailable: false` and the reason. It does not fabricate 2025.

Measured: `availableYears: [2026]`, reason "needs at least two years … contains 1".

## 6. What the colours mean (UI contract)

| state | visual | label |
| --- | --- | --- |
| observed | heat ramp, log-scaled | "Observed" |
| observed_zero | hollow ring on neutral fill | "Verified zero" |
| partial | ember half-tint | "Partial" |
| unknown | dashed border, no fill | "Unknown" |
| unavailable | dashed border, fallback to unknown styling | "Product unavailable" (API) |

Unknown is never the lowest activity colour; it is a different visual channel
(dashed, unfilled). The calendar legend states this explicitly.

## 7. Limits

1. A day is a UTC day; local fire days differ.
2. Zero is conditional on delivery, not on cloud-free imaging.
3. Derived density is experimental and grid-dependent.
4. The stored window covers 8 days of one month; seasonal and yearly views are
   descriptive, not climatological.
5. Detection counts are detections, not fires: one fire can produce dozens.
