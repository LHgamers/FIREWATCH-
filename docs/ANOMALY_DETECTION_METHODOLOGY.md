# Anomaly Detection Methodology

An anomaly is a statement about a *number*, not about a fire. This document
fixes the vocabulary: what is compared, what is refused, and what a result may
be called.

Implementation: `baseline.anomaly`, `scientific.anomaly`, `baseline.window_baseline`.

---

## 1. Two methods, one selector

`GET /api/baseline?date=YYYY-MM-DD&method=auto|climatology|window`

`auto` prefers the multi-year climatology and falls back to the stored-window
baseline, always reporting which was used (`selected`) and why
(`reason`, `climatology.reason`).

| selected | when | meaning of the result |
| --- | --- | --- |
| `climatology` | ≥ 3 distinct delivery years contribute | deviation from the same calendar window across years |
| `window_baseline` | < 3 years, but ≥ 7 observed days in the stored window | deviation from other days inside this window |
| `none` | neither applies | no anomaly is reported at all |

## 2. Robust z-score

```
M    = median(reference values)
MAD  = median(|x − M|)
σ    = 1.4826 × MAD            (consistent with σ for normal data)
z    = (x − M) / σ             if σ > 0, else null
p    = share of reference values ≤ x   (percentile, reported alongside)
```

MAD is used because daily fire counts are heavy-tailed: a single large day
would inflate a mean/σ baseline and make everything else look "below normal".

Worked example (window baseline, Amazon, target 2026-11-10, 7 reference days):
`x = 7,067` detections vs `M = 8,342`, `MAD = 1,259`, `σ = 1,866.6` ⇒
`absolute −1,275`, `relative −0.153`, `robustZ −0.68` →
"near the stored-window baseline" — correct, because |z| = 0.68 is unremarkable. The
language thresholds below start at 2.

## 3. Language mapping

| condition | permitted wording |
| --- | --- |
| `\|z\| < 2` | "at / near the baseline" |
| `2 ≤ \|z\| < 3` | "higher/lower than the baseline" |
| `\|z\| ≥ 3` | "unusual relative to the available observations" |
| insufficient sample | "insufficient data for comparison" |

Forbidden anywhere in the product: "emergency", "disaster", "outbreak",
"forecast", "will spread", "confirmed wildfire". A statistical deviation is not
an official alert, and no alert product is ingested.

## 4. Sample requirements

| requirement | value | reason |
| --- | --- | --- |
| minimum window-baseline days | 7 | fewer cannot form a stable median/MAD |
| minimum climatology years | 3 | two years cannot separate "unusual" from "different" |
| minimum contributing days per year | 1 | the year must actually appear in the window |
| target day must be an observed day | required | an unknown day has no defensible count |

A target date with `COVERAGE_UNKNOWN` returns
`available: false, reason: "target date is not an observed day"` — it is never
silently treated as zero.

## 5. What is not done

* No forecasting, trend fitting or extrapolation.
* No anomaly on unknown days, and no zero-filling of missing days.
* No comparison of 8 days against a "normal year" — there is no normal year.
* No attribution (climate, El Niño, land use). The data cannot support it.
* No spatial clustering of anomalies into "events".

## 6. Result contract

```json
{
  "selected": "window_baseline",
  "result": {
    "kind": "window_baseline",
    "available": true,
    "sampleDays": 7,
    "baseline": {"median": 8342.0, "mad": 1259.0, "robustSigma": 1866.59},
    "deviation": {"absolute": -1275.0, "relative": -0.153, "robustZ": -0.68},
    "language": "lower than the stored-window baseline",
    "notClimatology": true
  },
  "climatology": {"available": false, "reason": "insufficient_history"},
  "validationStatus": "not_independently_validated"
}
```

Reports and the UI read `language` and `notClimatology` rather than composing
their own sentence, so the wording cannot drift from the method.
