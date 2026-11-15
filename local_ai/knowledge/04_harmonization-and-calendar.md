---
title: Harmonization indicators and the Burning Activity Calendar
source: LH STUDIOS FIREWATCH methodology (docs/HFAI_METHODOLOGY.md, docs/BURNING_CALENDAR_METHODOLOGY.md)
url: https://gibs.earthdata.nasa.gov/ ; https://firms.modaps.eosdis.nasa.gov/
version: 2026-11
license: LH STUDIOS original text (redistributable)
---

# Harmonization indicators and the Burning Activity Calendar

## Why harmonization is hard

MODIS and VIIRS differ in footprint (≈1 km versus 375 m), overpass schedule,
spectral bands, saturation behaviour and confidence scale. Their records cannot
be added together as if they were the same instrument. Any harmonization must be
explicit about what it preserves and what it estimates.

## FIREWATCH indicators

**Cell-days.** Detections are grouped into grid cells (0.1°, 0.25° or 0.5°) per
acquisition day, keeping the maximum FRP in each cell-day. This reduces repeated
overpasses of one fire to one value and is the unit of every indicator.

**HFAI-v1 — active-fire density.** Sum of per-cell-day maximum FRP divided by the
exact spherical area of the reported cells and by the number of delivered days.
Unit: MW km⁻² day⁻¹. A bootstrap 95% confidence interval accompanies it, and it
is suppressed below a small sample. Status: **experimental, not independently
validated**.

**HFAI-v2 — paired cell-day ratio.** On cell-days where both sensors report, the
geometric mean of the MODIS/VIIRS FRP ratio. It bounds the footprint difference;
it does not correct it. Status: **experimental**.

**Matched comparison.** One-to-one pairing of MODIS and VIIRS detections within a
stated distance and time tolerance, with a sensitivity sweep. A match is a
coincidence in space and time, not proof of the same physical fire.

## Burning Activity Calendar

The calendar aggregates the same cell-days by day, week, month or season for a
selected area of interest. Each day carries a coverage state, so the calendar
shows *when activity was recorded* and *when coverage is unknown*, side by side.

Rules:

- Missing coverage is never drawn as zero activity.
- A short stored window cannot support seasonal or year-over-year claims. The UI
  refuses those comparisons instead of extrapolating.
- Historical comparison requires an adequate baseline; with fewer than three
  distinct years FIREWATCH reports `insufficient_history`.

## Sources

- NASA FIRMS; NASA EOSDIS GIBS.
- FIREWATCH methodology documents shipped with the project.
