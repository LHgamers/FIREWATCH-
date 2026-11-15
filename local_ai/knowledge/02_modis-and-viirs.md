---
title: MODIS and VIIRS active-fire products compared
source: LH STUDIOS summary of Giglio et al. (2016), Schroeder et al. (2014), NASA product documentation
url: https://modis.gsfc.nasa.gov/ ; https://www.nesdis.noaa.gov/our-satellites/currently-flying/joint-polar-satellite-system
version: 2026-11
license: LH STUDIOS original text (redistributable)
---

# MODIS and VIIRS active-fire products compared

## MODIS (Collection 6.1)

- Instruments: MODIS on Terra (morning) and Aqua (afternoon).
- Active-fire product: MOD14/MYD14, nominal 1 km detection footprint.
- Confidence: a percentage (0–100) derived from the retrieval algorithm.
- Overpasses: roughly two per day per platform at mid-latitudes.

## VIIRS 375 m

- Instruments: VIIRS on Suomi-NPP, NOAA-20 and NOAA-21.
- Active-fire product: VNP14IMG (and equivalents), 375 m I-band footprint.
- Confidence: categorical classes (low, nominal, high), **not** a percentage.
- Overpasses: roughly two per day per platform; three platforms are often
  aggregated in near-real-time feeds.

## Why the numbers differ

A smaller footprint resolves smaller and cooler fires and reduces the chance that
a fire is diluted by surrounding cold ground. More platforms increase the number
of observation opportunities. Different overpass times catch fires at different
stages. Different saturation behaviour changes how bright cores are reported.

Consequently, **a higher VIIRS detection count does not prove that VIIRS observed
more of the same fires than MODIS**. Detection counts are not a like-for-like
measurement across sensors.

## What FIREWATCH does about it

- Native fields are preserved: VIIRS confidence is never converted into a
  percentage, and MODIS confidence is not reclassified into VIIRS classes.
- Detections are reduced to cell-days using per-cell-day maximum FRP so that
  repeated overpasses do not multiply one fire.
- HFAI-v1 (density) and HFAI-v2 (paired cell-day FRP ratio) are computed as
  **experimental** indicators with bootstrap confidence intervals. They have not
  been validated against burned area.

## Sources

- Giglio, L., Schroeder, W., Justice, C.O. (2016). The Collection 6 MODIS active
  fire detection algorithm and fire products. Remote Sensing of Environment.
- Schroeder, W. et al. (2014). The New VIIRS 375 m active fire detection data
  product. Remote Sensing of Environment.
- NASA FIRMS product documentation (accessed 2026-11).
