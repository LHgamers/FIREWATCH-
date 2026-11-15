# HFAI Methodology

**Status: experimental. `validationStatus: not_independently_validated`.**
No reference product or ground truth exists in this build, so nothing here is
calibrated against observed fire size, intensity or burned area.

HFAI does **not** convert MODIS into VIIRS or vice versa. It produces two
dimensionally explicit, grid-dependent indicators over *reported* FRP, and
reports sensor-specific values before any combination.

---

## 0. The three categories, kept apart

| category | example | status |
| --- | --- | --- |
| 1. Raw observation | one MODIS detection at 1 km, FRP 12.4 MW | as delivered by NASA |
| 2. Comparable derived indicator | HFAI-v1 density at 0.25°, MW km⁻² day⁻¹ | experimental, this document |
| 3. Validated sensor-equivalent measurement | — | **does not exist in this build** |

Category 2 is never presented as category 3.

---

## 1. HFAI-v1 (revised in Phase 2)

### Formula

For sensor *s* over AOI *A*, window *W*, grid *g*:

```
F_s      = Σ_{cell-day k of s}  max FRP reported by s in k        [MW]
C_s      = set of grid cells with ≥1 detection from s              [cells]
Area_s   = Σ_{c in C_s}  R² · Δλ · (sin φ_north(c) − sin φ_south(c))   [km²]
D_s      = F_s / Area_s / N_s                                       [MW km⁻² day⁻¹]
```

where:

* `Δλ` = cell longitude width in radians (0.1°, 0.25° or 0.5°);
* `φ` = cell latitude edges; `R = 6371.0088 km`;
* `N_s` = number of days on which sensor *s*'s product was delivered in the
  window (`coverage_days`), not the number of days with a detection;
* the **cell-day maximum** is the reduction: repeated overpasses over one fire
  cannot inflate the numerator.

Combined descriptive value:

```
K        = union of cell-days from either sensor
F_all    = Σ_{k in K}  max(FRP_modis(k), FRP_viirs(k))     [MW]
Area_all = Σ_{c in union of active cells}  cell area          [km²]
D_all    = F_all / Area_all / N_both,  N_both = days both products delivered
```

`max()` per cell-day means a fire seen by both sensors is counted once. It is
an upper bound on shared activity, not a calibrated total.

### Worked example (real records)

AOI: Amazon bbox `-74,-14,-44,5` · window `2026-11-07 → 2026-11-14` (8 days,
both products delivered all 8) · grid `0.25°`.

| quantity | MODIS | VIIRS |
| --- | --- | --- |
| cell-days | 2,833 | 8,296 |
| active area (km²) | 1,060,600.1 | 2,185,378.8 |
| Σ max FRP (MW) | 121,941.84 | 141,997.60 |
| `N` (delivery days) | 8 | 8 |
| **D (MW km⁻² day⁻¹)** | **0.014372** | **0.008122** |
| bootstrap 95% CI | 0.013271 – 0.015527 | 0.007813 – 0.008463 |

Combined: 9,218 cell-days, 2,956 cells, 2,265,436.5 km², 236,421.55 MW →
**D_all = 0.013045** (CI 0.012458 – 0.013670).

Reproduce: `GET /api/harmonization/v2?region=amazon&start=2026-11-07&end=2026-11-14&grid=0.25&sensitivity=true`.

Note that MODIS has *fewer* detections (8,937 vs 64,374) yet a *higher* density:
its active cells are fewer and its per-cell FRP is larger. Detection counts
alone would have said the opposite. That is why both are reported.

### Uncertainty

Percentile bootstrap over cell-day maximum FRP values, 800 draws, fixed seed
(`20261114`), 800 × n resampling. The cell-day is the resampling unit because it
is the observation the mean is computed from. **Below 12 cell-days no interval
is reported** — the payload says so explicitly rather than showing a false
precision.

### Grid dependence (measured, same data)

| grid | D_modis | D_viirs | D_combined | ratio (v2) | paired cell-days | Jaccard cells |
| --- | --- | --- | --- | --- | --- | --- |
| 0.1° | 0.058632 | 0.028463 | 0.044684 | 2.255 | 2,182 | 0.307 |
| 0.25° | 0.014372 | 0.008122 | 0.013045 | 2.118 | 1,911 | 0.432 |
| 0.5° | 0.005829 | 0.003424 | 0.005680 | 1.941 | 1,423 | 0.537 |

Density spans **10×** between 0.1° and 0.5°. Densities from different grids are
never comparable; the UI prints the grid next to the number.

### Assumptions required for interpretation

1. A cell-day maximum is a defensible proxy for peak reported intensity.
2. Active area (cells with a detection) is the correct denominator — not the AOI.
3. "Both products delivered" is a delivery statement, not proof the AOI was
   imaged cloud-free.
4. Exact spherical cell area is the right physical normaliser for an equal-angle
   grid.

Breaking assumption 2 changes the number by orders of magnitude: normalising by
the AOI area (≈10.7 M km² for this bbox) would give 0.0028 instead of 0.0144.

---

## 2. HFAI-v2 — paired cell-day intensity

### Formula

```
P = { (cell, day) : both sensors reported ≥1 detection in that cell-day }
r_k = FRP_modis(k) / FRP_viirs(k)              for k in P with both > 0
R   = 10 ^ mean( log10 FRP_modis(k) − log10 FRP_viirs(k) )
```

CI: percentile bootstrap over the mean log-ratio (800 draws, seed 20261114).

### Result

`P` = 1,911 paired cell-days · MODIS mean 49.853 MW · VIIRS mean 25.492 MW →
**R = 2.118** (95% CI 1.977 – 2.268) · Spearman ρ = 0.141.

### What R is and is not

* It is a ratio of *reported* FRP on cell-days both sensors observed.
* It is **not** a conversion factor, not a calibration, not a correction to
  apply to VIIRS data, and not transferable to another AOI, window or grid.
* Restricting to paired cell-days removes unequal overpass counts; it does not
  remove footprint mismatch (1 km vs 375 m), saturation or cloud effects.
* Spearman ρ = 0.14 means the *ranking* of intensity within a cell-day is only
  weakly shared: the two sensors agree on "there is fire" far better than on
  "how intense". Any use that assumes rank agreement is wrong.

### Comparison with the detection-level ratio

Matched-pair comparison (2 km / 24 h, one-to-one) gives a per-detection median
FRP ratio of **3.547** (CI 3.380 – 3.734) — different from 2.118 because it uses
raw detections rather than cell-day maxima. Both are reported; neither is
"the" answer. See `SENSOR_COMPARISON_METHODOLOGY.md`.

---

## 3. Disagreement reporting

| metric | value | meaning |
| --- | --- | --- |
| MODIS-only cell-days | 922 | cells where only MODIS fired |
| VIIRS-only cell-days | 6,385 | cells where only VIIRS fired |
| paired cell-days | 1,911 | both fired in the same cell-day |
| coincidence share | 0.207 | paired / all active cell-days |
| Jaccard (cell sets) | 0.432 | overlap of active cell sets |

The asymmetry is expected: VIIRS has 8× more detections and a 7× smaller
footprint, so it activates many cells MODIS never resolves. It is **not**
evidence that VIIRS "sees more fire"; it is evidence of different sampling.

## 4. Retired / revised items (audit trail)

| item | Phase 1 behaviour | Phase 2 decision |
| --- | --- | --- |
| grid index | `CAST(lat/cell AS INT)` merged cells across 0° | **fixed**: shifted-floor, tested against Python floor |
| cell area | `(cell·111.32)²·cos(lat)` | **fixed**: exact spherical zone area |
| two HFAI implementations | `/api/harmonization` kept the pre-Phase-2 reduction (truncated grid, flat area, union-area denominator, detection-days) while `/api/harmonization/v2` used the corrected one, so one page showed two different "HFAI-v1" densities | **fixed (Phase 1 audit)**: `harmonize.indicator()` is the single implementation; `/api/harmonization` publishes its numbers and names that provenance in `hfai.provenance`. Verified: both endpoints return modis `0.014372`, viirs `0.008122`, combined `0.013045`, ratio `2.118` for the Amazon window |
| combined FRP | `max()` across sensors, unreported | **kept as a labelled descriptive upper bound**, with per-sensor values always present |
| uncertainty (v1) | none | **added**: bootstrap CI, suppressed under 12 cell-days |
| HFAI-v3 | — | **not created**. A version number is not evidence; the two existing indicators were repaired instead |

## 5. Validation status

```
validation_status: not_independently_validated
reference_product: none stored (no MCD64A1, no perimeters, no airborne FRP)
```

Nothing in this document should be read as a NASA-validated product. The
methodology is transparent and reproducible, which is not the same as validated.
