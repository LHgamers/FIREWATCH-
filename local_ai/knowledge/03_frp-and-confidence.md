---
title: Fire Radiative Power and confidence, interpreted correctly
source: LH STUDIOS summary of Wooster et al. (2003), Giglio et al. (2016), Schroeder et al. (2014)
url: https://firms.modaps.eosdis.nasa.gov/
version: 2026-11
license: LH STUDIOS original text (redistributable)
---

# Fire Radiative Power and confidence

## Fire Radiative Power (FRP)

FRP estimates the radiative energy released per unit time by the burning
material in a pixel, reported in **megawatts (MW)**. It is derived from the
mid-infrared radiance after subtracting a background estimate.

Key cautions:

- FRP is a **rate** (energy per second), not a total, and not an area.
- A high-FRP detection can come from a small very hot fire; a low-FRP detection
  can come from a large smouldering area. FRP is not burned area.
- Sensor footprint, saturation, viewing geometry and background temperature all
  affect the retrieval, so FRP is not directly comparable between MODIS and
  VIIRS without an explicit, validated method.
- Summing FRP over repeated overpasses double-counts the same fire. FIREWATCH
  therefore uses the **maximum FRP per cell-day** before aggregation.

## Confidence

- **MODIS**: a percentage produced by the algorithm, reflecting how confidently
  the pixel was classified as fire.
- **VIIRS**: categorical classes — low, nominal, high.

Confidence is **not** a probability that a wildfire exists. It describes the
retrieval's confidence in its thermal-anomaly classification. Converting VIIRS
classes into percentages, or MODIS percentages into VIIRS classes, would invent
information. FIREWATCH displays each in its native form.

## Practical interpretation

A retrieval with low confidence in cloudy conditions may still be a real fire;
a high-confidence detection may be a flare. Confidence ranks detection quality,
not fire severity.

## Sources

- Wooster, M.J., Zhukov, B., Oertel, D. (2003). Fire radiative energy for
  quantitative study of biomass burning. Remote Sensing of Environment.
- Giglio et al. (2016); Schroeder et al. (2014).
