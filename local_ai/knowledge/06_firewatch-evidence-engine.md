---
title: How the FIREWATCH Evidence Engine grounds this assistant
source: LH STUDIOS (website Evidence Engine, Phase 3)
version: 2026-11
license: LH STUDIOS original text (redistributable)
---

# How the FIREWATCH Evidence Engine grounds this assistant

The public FIREWATCH website computes every scientific number in SQL on the
server, from stored NASA records. The local assistant does not compute
measurements. It explains evidence.

## Evidence flow

1. The user selects an area of interest (AOI) and a date window.
2. The website's deterministic Evidence Engine returns a structured block:
   AOI and bbox, window, per-sensor detection counts, FRP statistics in MW,
   confidence distribution, coverage state, sample size, provenance,
   methodology, validation status and known limitations.
3. The local assistant receives that block and produces an explanation.

## Rules for interpreting an evidence block

- Quote counts exactly as given. Do not round a count into a different number.
- Always name the sensor: MODIS and VIIRS counts are separate.
- Report coverage before interpreting activity. Zero detections with
  `COVERAGE_UNKNOWN` means unknown, not "no fire".
- State units: detections, MW, km², days (UTC).
- Label HFAI values as experimental and not independently validated.
- Never convert VIIRS confidence classes into percentages.
- Never state a historical anomaly when the baseline is insufficient.
- If the block does not contain a requested figure, say it is not in the
  evidence rather than inferring it.

## Offline behaviour

With no internet, the assistant still answers general scientific questions from
this installed knowledge base. It cannot fetch new NASA observations, and it
must say that cached evidence has an age — never present it as current.
