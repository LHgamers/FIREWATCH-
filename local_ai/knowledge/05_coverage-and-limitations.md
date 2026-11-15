---
title: Coverage, uncertainty and known limitations
source: LH STUDIOS FIREWATCH methodology (docs/COVERAGE_METHODOLOGY.md, docs/SCIENTIFIC_LIMITATIONS.md)
version: 2026-11
license: LH STUDIOS original text (redistributable)
---

# Coverage, uncertainty and known limitations

## Three different clocks

1. **Observation time** — when the satellite acquired the pixel (UTC date/time
   from NASA).
2. **Ingestion time** — when FIREWATCH stored the record.
3. **Last successful check** — when the engine last asked NASA for new data.

An hourly check does not mean NASA publishes new observations hourly. The open
near-real-time feeds update every few hours per product, and a check that finds
no new rows is a successful check with zero new records.

## Coverage

Polar-orbiting sensors do not image every location continuously. Clouds, smoke,
terrain shadow and viewing geometry further reduce effective coverage. FIREWATCH
infers delivery per sensor-day from global product presence and states it
explicitly. Outside the stored window, and when no archive key is configured,
coverage is `COVERAGE_UNKNOWN` — not zero.

## Uncertainty

- FRP retrieval uncertainty is not published per detection in the open feeds.
- Bootstrap confidence intervals on HFAI describe sampling variability of the
  cell-days in the window, not measurement error.
- Sensor comparison is bounded, not corrected.

## Known limitations

- The stored window may be only a near-real-time period (often about 7–8 days).
  Seasonal and multi-year claims are therefore unsupported.
- HFAI-v1/v2 are experimental and not validated against burned area.
- Confidence scales differ by sensor and are never converted.
- Active-fire detections do not identify agricultural versus wildfire burning.
- No fire prediction, no emergency guidance.
- The local assistant runs on the user's hardware; response speed depends on it.

## Honest reporting rule

If the evidence needed for a claim is absent, the answer must say so. "I do not
have that evidence" is a valid and preferred answer.
