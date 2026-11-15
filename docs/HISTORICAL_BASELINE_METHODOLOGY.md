# Historical Baseline Methodology

A baseline is only as good as the years behind it. The stored record contains
**one** year and **eight** days, so every multi-year method here returns
`insufficient` with a reason. The machinery is implemented and tested so it
starts working when an archive is ingested — without code changes and without a
synthetic value ever standing in for a missing year.

Implementation: `engine/app/baseline.py`.

---

## 1. Availability report (`GET /api/baseline`)

Reported from stored rows only:

| field | example (Amazon) |
| --- | --- |
| `first`, `last` | 2026-11-07, 2026-11-14 |
| `distinctDays` | 8 |
| `years` | `["2026"]` |
| `deliveryYears` | `["2026"]` |
| `perSensor.*.distinctDays` | MODIS 8, VIIRS 8 |
| `perSensor.*.gaps` | `[]` (no interior gaps) |
| `climatologyPossible` | `false` |
| `climatologyRequirement` | "3 distinct years of delivered observations" |

The application never implies a continuous record; `first`/`last` and the
`historicalNote` are shown next to any historical claim.

## 2. Two baselines, never confused

| | window baseline | multi-year climatology |
| --- | --- | --- |
| reference | observed days inside the stored window | same calendar window across distinct years |
| minimum sample | 7 observed days | **3 distinct years** |
| label | `window_baseline`, `notClimatology: true` | `climatology` |
| endpoint | `/api/anomaly` (legacy), `/api/baseline` | `/api/baseline?method=climatology` |
| language | "higher/lower than the stored-window baseline" | "higher/lower than the multi-year baseline" |

A seven-day comparison is a seven-day comparison. It is never called
climatology, and the payload carries `notClimatology: true` so a client cannot
mislabel it either.

## 3. Climatology formula (when ≥ 3 years exist)

```
For target date t (year Y, day-of-year d):
  For each other year y: mean daily count over days within ±w days of d
    (only days with delivered observations; w default 15)
  Require ≥ 1 contributing day per year and ≥ 3 distinct years
  M  = median over yearly means
  MAD = median(|x_y − M|)
  σ  = 1.4826 × MAD
  z  = (observed(t) − M) / σ          (only if σ > 0)
```

A month-of-year variant (`method=month`) uses all days of that month per year.
Robust statistics are used because daily fire counts are heavy-tailed and
non-normal; a mean/σ baseline would be dominated by a single large day.

### Why 3 years, and why that is not arbitrary

Two years cannot distinguish "unusual" from "different". Three is the smallest
count for which a median is not just the midpoint of two arbitrary values, and
it matches the standard practice for a minimum climatological normal. The
threshold lives in one constant (`MIN_YEARS = 3`) and is reported in every
refusal, so it can be audited rather than guessed.

## 4. Refusal payload (current state)

```json
{
  "available": false,
  "reason": "insufficient_history",
  "detail": "A climatology needs observations from at least 3 distinct years;
             the stored record contains 1 (2026).",
  "yearsAvailable": ["2026"],
  "deliveryYears": ["2026"],
  "minYears": 3
}
```

No baseline value, no z-score, no "normal" band is returned.

## 5. Window baseline (current, valid within its limits)

Amazon, target 2026-11-10: median of the other 7 observed days, MAD, robust
σ; result `absolute −1,275`, `relative −0.153`, `robustZ −0.68`, language
"lower than the stored-window baseline". Seven days is the minimum; with fewer,
the payload returns `available: false` and `minimumSample: 7`.

## 6. Year comparison

`compare_years(bbox, [y1, y2], period)` compares only buckets present in both
years and only years with delivered observations. With one year it returns
`comparisonAvailable: false`, `availableYears: ["2026"]`, and the missing years
are absent — never zero, never interpolated, never synthesised.

## 7. Limits

1. Eight days in one month cannot support seasonality, month-of-year normals or
   any statement about "typical" activity.
2. Delivery coverage is global product presence, so a year "with data" may still
   have gaps over the AOI.
3. A baseline built later from a 3-year archive will describe those 3 years, not
   a long-term normal. The payload will always report `yearsUsed`.
4. No detrending, no trend test, no attribution. Unusual ≠ emergency.
