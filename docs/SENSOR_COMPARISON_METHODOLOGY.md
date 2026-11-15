# Sensor Comparison Methodology

Two kinds of comparison are implemented, and they answer different questions:

1. **Cell-day comparison** (`/api/harmonization/v2`) — do the sensors report
   activity in the same cells on the same days, and how intense is it?
2. **Matched-pair comparison** (`/api/comparison`) — given explicit spatial and
   temporal tolerances, how close are individual detections, and how do their
   FRP values relate?

Neither establishes ground truth. `validationStatus` is
`not_independently_validated` in both.

---

## 1. Matching rules (explicit, never implied)

| parameter | default | meaning |
| --- | --- | --- |
| `maxKm` | 2.0 km | great-circle distance between a MODIS and a VIIRS detection |
| `windowHours` | 24 h | absolute acquisition-time difference, UTC |
| assignment | greedy one-to-one | candidates sorted by distance; each detection used once |
| sweep | 0.5, 1, 2, 5, 10 km × {0 h, 24 h} | one factor at a time, so the effect of the choice is visible |

A matched pair is **coincident**, not the same fire:

* two independent fires can fall inside 2 km;
* one large fire's detections can be farther apart than 2 km;
* a 1 km MODIS pixel and a 375 m VIIRS pixel can never be the same *measurement*.

The payload states this in `matching.rules`.

## 2. Results on the reference window

Amazon bbox `-74,-14,-44,5` · `2026-11-07 → 2026-11-14` · deterministic 50 %
sample (4,467 MODIS, 32,189 VIIRS from 73,311 rows; `sampled: true`, step 2).

### At the primary setting (2 km, 24 h)

| metric | value |
| --- | --- |
| matched pairs | 3,140 |
| median pair distance | 0.414 km |
| p90 pair distance | 1.123 km |
| MODIS detections matched | 70.3 % |
| VIIRS detections matched | 9.8 % |
| median FRP ratio (MODIS / VIIRS) | 3.459 |
| mean log₁₀ ratio → ratio | 3.547 (CI 3.380 – 3.734) |
| Spearman ρ (paired FRP) | 0.136 |

### Effect of the tolerance

| maxKm (24 h) | pairs | MODIS matched | VIIRS matched | median FRP ratio |
| --- | --- | --- | --- | --- |
| 0.5 | 1,832 | 41.0 % | 5.7 % | 3.563 |
| 1.0 | 2,727 | 61.0 % | 8.5 % | 3.492 |
| 2.0 | 3,140 | 70.3 % | 9.8 % | 3.459 |
| 5.0 | 3,457 | 77.4 % | 10.7 % | 3.452 |
| 10.0 | 3,775 | 84.5 % | 11.7 % | 3.399 |
| 2.0 km, 0 h window | 2,063 | 46.2 % | 6.4 % | 4.272 |

Reading it: loosening the radius raises the match rate and barely moves the FRP
ratio (3.56 → 3.40), which suggests the ratio is not an artefact of the
tolerance. Restricting to the exact same UTC day *does* change the ratio
(3.46 → 4.27), so the 24 h window materially matters and is therefore reported.

### By native VIIRS confidence

| VIIRS class | pairs | median FRP ratio | median MODIS FRP | median VIIRS FRP |
| --- | --- | --- | --- | --- |
| low | 120 | 1.344 | 14.75 MW | 11.26 MW |
| nominal | 2,908 | 3.711 | 14.62 MW | 3.95 MW |
| high | 112 | 1.236 | 21.51 MW | 18.73 MW |

At nominal confidence the two sensors disagree by a factor of ~3.7; where VIIRS
is *high* or *low* confidence they nearly agree. The class is a retrieval
statement, not a probability, and this table is descriptive.

### FRP distributions

Two-sample Kolmogorov–Smirnov on native FRP (MW): **D = 0.4542**, n = 4,467 vs
32,189. The distributions are clearly different — expected, given footprint and
algorithm differences. With samples this large the p-value is ~0 and carries no
useful information; the effect size (D) is the number to read.

## 3. What this comparison can and cannot establish

**Can:** how often detections coincide at a stated tolerance, how their reported
intensities relate, whether those results are sensitive to the tolerance, and
whether the sensors' confidence classes correlate with disagreement.

**Cannot:** that a pair is one fire; the true FRP of any fire; a conversion
factor; detection completeness; whether an unmatched detection is a missed fire
or an artefact. No burned-area, perimeter or airborne reference is stored, so
none of this is validated against physical fire extent.

## 4. Why not compare "same day totals"?

Because a day contains 6 VIIRS overpasses and 4 MODIS overpasses over different
ground tracks. Daily totals confound sensor sensitivity with sampling geometry.
The cell-day reduction narrows that; the one-to-one match narrows it further.
Neither removes it, and the platform opportunity block says so (`adjusted:
false`).

## 5. Independent validation: not performed

Candidates and their status:

| candidate | measures | status in this build |
| --- | --- | --- |
| MCD64A1 / VNP64A1 burned area | post-fire reflectance change, monthly | not ingested |
| Fire perimeters (e.g. agency GIS) | mapped extent | not ingested |
| Airborne FRP | radiometric fire power | not available |

Active-fire detections and burned area measure different phenomena over
different timescales; even if MCD64A1 were ingested it would be contextual
evidence, not ground truth for a hotspot count. Until one of these is stored,
`not_independently_validated` stands.
