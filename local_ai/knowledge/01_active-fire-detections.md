---
title: What an active-fire detection is
source: LH STUDIOS summary of NASA FIRMS / MODIS / VIIRS product documentation
url: https://firms.modaps.eosdis.nasa.gov/
version: 2026-11
license: LH STUDIOS original text (redistributable)
---

# What an active-fire detection is

An active-fire product reports **thermal anomalies**: pixels whose mid-infrared
brightness temperature exceeds a contextual threshold derived from neighbouring
pixels. Each record is a detection at a location and time, with a brightness
temperature, an estimated fire radiative power where the sensor supports it, and
a confidence value.

A detection is **not** a confirmed wildfire. The same retrieval responds to
agricultural burning, land clearing, gas flares, volcanic heat and some
industrial sources. Confirming a wildfire requires additional evidence such as
burned-area mapping, incident reports or airborne observation.

A detection is also **not** a burned-area measurement. Burned-area products map
the scar left after a fire; active-fire products record heat at the moment of an
overpass. The two answer different questions and are not interchangeable.

## Why absence is not zero

Polar-orbiting sensors sample a location a few times per day at most, and cloud,
smoke, terrain and satellite geometry can all prevent a detection. An empty
result inside a delivered product means "no detection was recorded for this
area in the delivered data". It does not prove that nothing burned.

## FIREWATCH coverage states

- `DETECTIONS_RECORDED` — the product delivered and the area has at least one detection.
- `COVERAGE_CONFIRMED_ZERO_DETECTIONS` — the product delivered and the area
  reported none. This is a *conditional* zero: global delivery proves the
  product existed, not that this specific area was imaged cloud-free.
- `COVERAGE_UNKNOWN` — delivery cannot be established. Never render as zero.
- `PRODUCT_UNAVAILABLE` — a request for that date failed or was rejected.
- `COVERAGE_PARTIAL` — at least one sensor is known, at least one is not.

## Sources

- NASA FIRMS: https://firms.modaps.eosdis.nasa.gov/
- NASA FIRMS FAQ and product documentation (accessed 2026-11).
