# Coverage Methodology

**The one rule:** an empty result is not evidence of absence. A day with no
stored detections is only "zero" when the product is known to have been
delivered; otherwise it is unknown, and the API says so.

This document defines the state model, how delivery is inferred, what each state
does and does not license you to say, and the known weaknesses.

---

## 1. States

| API `state` | `code` | meaning | may you say "no fire"? |
| --- | --- | --- | --- |
| `observed` | `DETECTIONS_RECORDED` | product delivered for that sensor-day; area reports ≥ 1 detection | no — fires were detected |
| `observed_zero` | `COVERAGE_CONFIRMED_ZERO_DETECTIONS` | product delivered for that sensor-day; area reports 0 detections | **only conditionally** — no detection was reported |
| `partial` | `COVERAGE_PARTIAL` | at least one sensor known, at least one not | no |
| `unknown` | `COVERAGE_UNKNOWN` | delivery cannot be established | **never** |
| `unavailable` | `PRODUCT_UNAVAILABLE` | a request for that date failed at the source | **never** |

Ancillary fields returned with each sensor state:

* `count` — detections in the selected area (0 for `unknown`/`unavailable`;
  meaningless there, which is why `state` is authoritative).
* `evidence` — the concrete justification, e.g.
  `"global delivery: 11,022 records, 0 in this area"`.
* `basis` — the claim the evidence supports.
* `satellites` — per-platform counts for that day.
* `code` — the stable machine-readable state code.

## 2. How delivery is inferred

`coverage_days` holds `(sensor, satellite, acq_date, records)` counted from
`observations`. For a given sensor-day:

* any stored row ⇒ the product delivered on that date;
* no stored row ⇒ **nothing is inferred**.

A polar-orbiting sensor that delivered records anywhere proves its product and
swaths existed on that date. It does **not** prove that a particular area was
imaged cloud-free, or imaged at all — hence `observed_zero.basis` reads
"global product delivery, conditional zero for this area".

Verification from this build (`GET /api/coverage`):

```
first 2026-11-07 · last 2026-11-14 · sensorDays {modis: 8, viirs: 8}
```

and per-day evidence, e.g. `2026-11-10` MODIS `global delivery: 11,022 records`,
VIIRS `global delivery: 117,855 records`.

## 3. When a day is `PRODUCT_UNAVAILABLE`

Only with a **stored failure** that names the date:

* a `coverage_windows` row with a failure status (`auth`, `rate_limited`,
  `invalid`, `unavailable`, `error`) covering that date, or
* an `ingest_checkpoints` row with a failure status for that date.

A date nobody requested stays `unknown`. That asymmetry is intentional: we would
rather under-claim. Verified behaviour — with no `FIRMS_MAP_KEY`, every date
outside the stored window reports `unknown` with
`unknownReason: outside_window`, and `unavailableDays: 0`, because no archive
request was made to fail.

## 4. Day-level aggregation

```
both sensors known           → observed  (any detections) | observed_zero (none)
one sensor known, one not    → partial
nothing known, all failed    → unavailable
nothing known                → unknown
```

`partial` deliberately outranks `observed`: a day where MODIS reported and
VIIRS never delivered is incomplete, and labelling it "observed" would hide a
missing sensor. `unavailable` only wins when nothing at all is known; a real
detection always outranks a failure marker.

## 5. Where this is surfaced

* `/api/coverage` → `coverage` (window + `states` legend) and `windows`.
* `/api/calendar` → per-day `state`, `stateCode`, `stateLegend`, and
  `summary.observedDays / zeroDays / partialDays / unknownDays /
  unavailableDays / unknownReason`.
* `/api/day/{date}` → per-sensor `state`, `code`, `evidence`, `basis`.
* `/calendar` page → the four-card state strip (observed / verified zero /
  partial / unknown) and per-day badges. A `PRODUCT_UNAVAILABLE` day currently
  renders with the unknown styling and label (the API payload and the count
  strip still distinguish it); the cell falls back rather than breaking.
* Baseline and anomaly math uses **observed days only**; unknown days never
  enter the sample, and a baseline is suppressed below 7 observed days.

## 6. `unknownReason` values

| value | when |
| --- | --- |
| `before_window` | date precedes the first stored delivery |
| `after_window` | date follows the last stored delivery but is not in the future |
| `future` | date is later than today (UTC) |
| `source_gap` | date is inside the window but that sensor-day has no delivery |
| `outside_window` | the earliest and latest unresolved dates disagree |
| `no_ingest` | nothing has ever been ingested |

Both ends of the unresolved run are evaluated; if they disagree the reported
reason is `outside_window` rather than picking one boundary. (An earlier
implementation probed only one end and mis-reported `before_window`.)

## 7. Weaknesses, stated plainly

1. **Global delivery is a proxy for coverage.** A day can pass the test while
   the AOI itself was cloudy, off-swath, or obscured by smoke. `observed_zero`
   is therefore conditional, never absolute.
2. **No per-swath geometry.** Keyless feeds publish detections, not granule
   footprints, so true AOI coverage cannot be computed without a key or granule
   metadata.
3. **Cloud and smoke mask fires.** A zero can mean "no thermal anomaly exceeded
   threshold through the cloud deck".
4. **Daily resolution only.** Sub-daily overpasses are aggregated into a day;
   two detections hours apart are one day.
5. **Overpass count is nominal.** Actual revisits depend on swath overlap,
   latitude and scheduling.
6. **`PRODUCT_UNAVAILABLE` is request-relative.** It reflects what *we* asked
   for and what failed, not a NASA-wide outage record.
7. **No backfill without a key.** Historical coverage outside the stored window
   is unknown by construction, and the UI says so.
