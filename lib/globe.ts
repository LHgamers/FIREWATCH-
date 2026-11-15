/**
 * Globe and geodetic math for the interactive Earth (FIREWATCH AI, Phase 4).
 *
 * Deliberately dependency-free: no three.js import, no DOM access. GlobeEarth.tsx
 * maps these primitives onto `THREE.Vector3`, and the module can therefore be
 * imported and executed by a plain Node script (see PHASE_4_TEST_REPORT.md,
 * "pixel → lat/lon math test") without a bundler or a browser.
 *
 * ── Sphere ↔ texture convention ──────────────────────────────────────────────
 * `THREE.SphereGeometry` places its texture seam at local −X and wraps the
 * equirectangular map around +Y:
 *
 *   x = −r · cos(φ) · cos(lat)     φ = (lon + 180°) in radians
 *   y =  r · sin(lat)
 *   z =  r · sin(φ) · cos(lat)
 *
 * so `u = 0` is lon −180°, `u = 0.5` is lon 0° (prime meridian, +X), `u = 0.25`
 * is lon −90° (+Z), `v = 0` is the north pole. Inverse: φ = atan2(z, −x).
 *
 * `vector3ToLatLon` is implemented against a point already expressed in the
 * sphere's LOCAL frame. Callers get that frame from `Object3D.worldToLocal()`,
 * which inverts every parent transform (the Earth group's own rotation and any
 * ancestor), so a rotated sphere still reports the correct geography. That is
 * the whole "undo the rotation" problem, solved once, here, and asserted by the
 * rotation table in the test report.
 *
 * Convention: latitude/longitude in decimal degrees, longitude in [−180, 180).
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface LatLon {
  lat: number;
  lon: number;
}

/** Mean Earth radius (IUGG), km. Same constant the engine uses. */
export const EARTH_RADIUS_KM = 6371.0088;

/** Engine bounds for /api/ask-the-earth (Field(..., ge=-89.9, le=89.9)). */
export const LAT_LIMIT = 89.9;

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Wrap a longitude into (−180, 180]. */
export function wrapLon(lon: number): number {
  if (!Number.isFinite(lon)) return 0;
  const x = ((lon + 180) % 360 + 360) % 360 - 180;
  return x === -180 ? 180 : x;
}

/** Clamp latitude to the engine's accepted band. */
export function clampLat(lat: number): number {
  if (!Number.isFinite(lat)) return 0;
  return clamp(lat, -LAT_LIMIT, LAT_LIMIT);
}

export function normalizeLatLon(lat: number, lon: number): LatLon {
  return { lat: clampLat(lat), lon: wrapLon(lon) };
}

/* -------------------------------------------------------------------------- */
/* Sphere geometry                                                            */
/* -------------------------------------------------------------------------- */

/** Geographic coordinate → local sphere position. */
export function latLonToVector3(lat: number, lon: number, radius = 1): Vec3 {
  const phi = (lon + 180) * DEG;
  const theta = lat * DEG;
  const c = Math.cos(theta);
  return {
    x: -radius * Math.cos(phi) * c,
    y: radius * Math.sin(theta),
    z: radius * Math.sin(phi) * c,
  };
}

/**
 * Local sphere position → geographic coordinate.
 * Points inside the sphere (numerical drift from a scale) are handled: the
 * direction is normalised, so only the bearing of the point is used.
 */
export function vector3ToLatLon(v: Vec3): LatLon {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (!(len > 0) || !Number.isFinite(len)) return { lat: 0, lon: 0 };
  const y = clamp(v.y / len, -1, 1); // direction, not magnitude
  const lat = Math.asin(y) * RAD;
  // atan2(0, 0) is 0, which maps to lon −180; a real point at a pole has no
  // longitude anyway, so leave it there rather than inventing one.
  const phi = Math.atan2(v.z / len, -v.x / len);
  return { lat, lon: wrapLon(phi * RAD - 180) };
}

/** Geographic coordinate → texture UV on the equirectangular map. */
export function latLonToUv(lat: number, lon: number): { u: number; v: number } {
  return { u: ((wrapLon(lon) + 180) / 360), v: (90 - clampLat(lat)) / 180 };
}

/** Texture UV → geographic coordinate. */
export function uvToLatLon(u: number, v: number): LatLon {
  const lat = 90 - clamp(v, 0, 1) * 180;
  const lon = wrapLon(clamp(u, 0, 1) * 360 - 180);
  return { lat, lon };
}

/* -------------------------------------------------------------------------- */
/* Rotations (used by the tests to prove worldToLocal-equivalence)             */
/* -------------------------------------------------------------------------- */

export function rotateX(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c };
}

export function rotateY(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}

export function rotateZ(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}

/**
 * Y-rotation for an Earth group that should bring `lon` to the point facing
 * the camera (+Z in world space).
 *
 * A Y-rotation by θ adds θ to the apparent longitude (local L → world L + θ),
 * and the camera looks at world lon −90°, so θ = −(L + 90°).
 * Asserted in the test report against `rotateY(latLonToVector3(0, L), θ)`.
 */
export function earthRotationYForLongitude(lon: number): number {
  return wrapLon(-(lon + 90)) * DEG;
}

/** Meridian (apparent longitude) currently centred in front of the camera. */
export function longitudeAtRotationY(rotationY: number): number {
  return wrapLon(-90 - rotationY * RAD);
}

/* -------------------------------------------------------------------------- */
/* Camera helpers (OrbitControls keeps the Earth still and moves the camera)   */
/* -------------------------------------------------------------------------- */

/**
 * World-space geographic point at the centre of the viewport for an orbiting
 * camera: the sub-camera point, i.e. the surface point nearest the camera,
 * which is `normalize(cameraPos)` — not `−cameraPos` (that is what the camera
 * is aiming at through the planet, and it is the antipode).
 *
 * GlobeEarth's keyboard "Enter" does not use this: it casts a ray through the
 * screen centre and applies `worldToLocal`, so a rotated Earth group is exact.
 */
export function cameraToLatLon(camera: Vec3): LatLon {
  return vector3ToLatLon({ x: camera.x, y: camera.y, z: camera.z });
}

/**
 * Spherical offset for arrow-key orbiting. `theta` is the azimuth around +Y,
 * `phi` the polar angle from +Y (OrbitControls' own convention after
 * `camera.position` is converted by `Vector3.setFromSpherical`).
 */
export function sphericalFromPosition(v: Vec3): { radius: number; theta: number; phi: number } {
  const radius = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  const phi = radius > 0 ? Math.acos(clamp(v.y / radius, -1, 1)) : 0;
  const theta = Math.atan2(v.x, v.z);
  return { radius, theta, phi };
}

export function positionFromSpherical(radius: number, theta: number, phi: number): Vec3 {
  const sp = Math.sin(phi);
  return { x: radius * sp * Math.sin(theta), y: radius * Math.cos(phi), z: radius * sp * Math.cos(theta) };
}

/** Keep the polar angle inside the range OrbitControls would allow. */
export function clampPolar(phi: number): number {
  return clamp(phi, 18 * DEG, 162 * DEG);
}

/* -------------------------------------------------------------------------- */
/* Distance / AOI                                                             */
/* -------------------------------------------------------------------------- */

/** Great-circle distance in km (haversine, mean Earth radius). */
export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * s2 * s2;
  return 2 * EARTH_RADIUS_KM * Math.asin(clamp(Math.sqrt(h), 0, 1));
}

/**
 * Square AOI around a point for a search radius, in the engine's
 * `w,s,e,n` bbox convention. Longitude span widens with latitude
 * (1° lon ≈ 111.32·cos(lat) km) and is clamped so it never becomes infinite at
 * the poles. Latitude is clamped to the FIRMS product extent used everywhere
 * else in the engine (−60 … 75), so a polar selection degrades to the delivered
 * product rather than to an empty box nobody can explain.
 */
export function radiusToBbox(lat: number, lon: number, radiusKm: number): [number, number, number, number] {
  const dLat = radiusKm / 111.32;
  const cos = Math.max(0.15, Math.cos(clamp(lat, -85, 85) * DEG));
  const dLon = radiusKm / (111.32 * cos);
  const s = Math.max(-60, lat - dLat);
  const n = Math.min(75, lat + dLat);
  const w = wrapLon(lon - dLon);
  const e = wrapLon(lon + dLon);
  return [round4(w), round4(s), round4(e), round4(n)];
}

export function bboxCenter(box: [number, number, number, number]): LatLon {
  const [w, s, e, n] = box;
  const lonSpan = e >= w ? e - w : e + 360 - w;
  return { lat: (s + n) / 2, lon: wrapLon(w + lonSpan / 2) };
}

export function bboxContains(box: [number, number, number, number], lat: number, lon: number): boolean {
  const [w, s, e, n] = box;
  if (lat < s || lat > n) return false;
  const l = wrapLon(lon);
  return e >= w ? l >= w && l <= e : l >= w || l <= e;
}

/**
 * Spherical area of a lat/lon box in km² — identical formula to the engine's
 * `regions.bbox_area_km2`, so a UI label can never disagree with the API.
 */
export function bboxAreaKm2(box: [number, number, number, number]): number {
  const [w, s, e, n] = box;
  const lonSpan = e >= w ? e - w : e + 360 - w;
  const lonRad = clamp(lonSpan, 0, 360) * DEG;
  const area = lonRad * EARTH_RADIUS_KM * EARTH_RADIUS_KM *
    (Math.sin(clamp(n, -90, 90) * DEG) - Math.sin(clamp(s, -90, 90) * DEG));
  return Math.abs(area);
}

/** Angular radius (radians) of a ground distance, on the mean sphere. */
export function angleForRadiusKm(radiusKm: number): number {
  return clamp(radiusKm, 0, Math.PI * EARTH_RADIUS_KM) / EARTH_RADIUS_KM;
}

/**
 * Great-circle ring of constant ground distance around a point, as local sphere
 * positions. Used to draw the AOI radius honestly: the ring is a real small
 * circle on the sphere, not a screen-space circle.
 */
export function circleOnSphere(
  lat: number,
  lon: number,
  radiusKm: number,
  segments = 96,
  altitude = 1.002,
): Vec3[] {
  const ang = angleForRadiusKm(radiusKm);
  const d = latLonToVector3(lat, lon, 1);
  // Tangent basis at the point: e1 east-ish, e2 north-ish (any orthogonal pair works).
  const ref = Math.abs(d.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  // e1 = normalize(ref × d), e2 = d × e1
  const e1raw = {
    x: ref.y * d.z - ref.z * d.y,
    y: ref.z * d.x - ref.x * d.z,
    z: ref.x * d.y - ref.y * d.x,
  };
  const l1 = Math.hypot(e1raw.x, e1raw.y, e1raw.z) || 1;
  const e1 = { x: e1raw.x / l1, y: e1raw.y / l1, z: e1raw.z / l1 };
  const e2 = {
    x: d.y * e1.z - d.z * e1.y,
    y: d.z * e1.x - d.x * e1.z,
    z: d.x * e1.y - d.y * e1.x,
  };
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = (i / segments) * Math.PI * 2;
    const c = Math.cos(ang), s = Math.sin(ang);
    const ct = Math.cos(t), st = Math.sin(t);
    const p = {
      x: d.x * c + (e1.x * ct + e2.x * st) * s,
      y: d.y * c + (e1.y * ct + e2.y * st) * s,
      z: d.z * c + (e1.z * ct + e2.z * st) * s,
    };
    const l = Math.hypot(p.x, p.y, p.z) || 1;
    out.push({ x: (p.x / l) * altitude, y: (p.y / l) * altitude, z: (p.z / l) * altitude });
  }
  return out;
}

export function parseBbox(raw: string | null | undefined): [number, number, number, number] | null {
  if (!raw) return null;
  const parts = raw.split(",").map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [w, s, e, n] = parts;
  if (Math.abs(w) > 180 || Math.abs(e) > 180 || Math.abs(s) > 90 || Math.abs(n) > 90) return null;
  if (s >= n) return null;
  return [w, s, e, n];
}

export function formatBbox(box: [number, number, number, number]): string {
  return box.map((v) => round4(v).toFixed(4)).join(",");
}

/* -------------------------------------------------------------------------- */
/* Display                                                                    */
/* -------------------------------------------------------------------------- */

export function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

export function formatLat(lat: number, digits = 3): string {
  return `${Math.abs(lat).toFixed(digits)}° ${lat >= 0 ? "N" : "S"}`;
}

export function formatLon(lon: number, digits = 3): string {
  const l = wrapLon(lon);
  return `${Math.abs(l).toFixed(digits)}° ${l >= 0 ? "E" : "W"}`;
}

export function formatLatLon(lat: number, lon: number, digits = 3): string {
  return `${formatLat(lat, digits)}, ${formatLon(lon, digits)}`;
}

/** Parse user input like "-3.47", "3,47S", "62 21 W" leniently but honestly. */
export function parseCoordInput(raw: string): number | null {
  const t = raw.trim().toUpperCase();
  if (!t) return null;
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*([NSEW])?$/);
  if (m) {
    let n = Number(m[1]);
    const hemi = m[2];
    if (hemi === "S" || hemi === "W") n = -Math.abs(n);
    else if (hemi === "N" || hemi === "E") n = Math.abs(n);
    return Number.isFinite(n) ? n : null;
  }
  const comma = t.replace(",", ".").match(/^(-?\d+(?:\.\d+)?)\s*([NSEW])?$/);
  if (comma) return parseCoordInput(comma[1] + (comma[2] ?? ""));
  return null;
}

/* -------------------------------------------------------------------------- */
/* Self-check table (run by `node lib/globe.ts --self-test`)                   */
/* -------------------------------------------------------------------------- */

/**
 * Reference cases asserted in PHASE_4_TEST_REPORT.md.
 * Each row: [lat, lon, expected local x, y, z] on the unit sphere.
 */
export const SPHERE_REFERENCE: Array<[number, number, number, number, number]> = [
  [0, 0, 1, 0, 0],
  [0, 90, 0, 0, -1],
  [0, 180, -1, 0, 0],
  [0, -90, 0, 0, 1],
  [90, 0, 0, 1, 0],
  [-90, 0, 0, -1, 0],
];
