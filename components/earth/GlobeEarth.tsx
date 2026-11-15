"use client";

/**
 * GlobeEarth — the interactive 3D Earth for "Ask the Earth".
 *
 * Design rules this component obeys (Phase 4 contract):
 *
 * 1. **Nothing on this sphere is data.** It is NASA Blue Marble (day), Black
 *    Marble (night lights) and a cloud alpha map, used as a geographic index.
 *    Fire detections are never painted onto the globe from a client-side list;
 *    every number on the page comes from the engine for the selected AOI.
 * 2. **The click is pure geometry.** `worldToLocal()` inverts the Earth group's
 *    rotation (and any ancestor transform) before `vector3ToLatLon`, so the
 *    reported coordinate cannot drift when the planet is rotated. The mapping is
 *    asserted by 60 assertions in PHASE_4_TEST_REPORT.md.
 * 3. **No fake progress.** Texture bytes are reported only when the server sends
 *    `Content-Length`; otherwise the label stays qualitative.
 * 4. **Reduced motion is respected**: idle auto-rotation is off when
 *    `prefers-reduced-motion: reduce`, and the camera jumps instead of easing.
 * 5. **Graceful failure**: no WebGL / lost context / a texture that never
 *    decodes ⇒ an informative panel, never a blank canvas. Coordinate entry
 *    keeps working because it lives in the page, not here.
 * 6. **Everything is disposed** on unmount: geometries, materials, textures,
 *    renderer, controls, observers, listeners and the animation frame.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Globe2, Keyboard, MousePointerClick, RotateCcw } from "lucide-react";
import {
  RAD,
  clampLat,
  clampPolar,
  earthRotationYForLongitude,
  formatLat,
  formatLon,
  latLonToVector3,
  circleOnSphere,
  positionFromSpherical,
  sphericalFromPosition,
  vector3ToLatLon,
  wrapLon,
  DEG,
} from "@/lib/globe";
import { cn } from "@/lib/format";

/**
 * One stored fire detection, placed at its **original** coordinates.
 * The parent supplies these from the engine's /api/observations response; the
 * globe never generates a point of its own.
 */
export interface GlobeObservation {
  lat: number;
  lon: number;
  sensor: "modis" | "viirs";
  frp?: number | null;
  id?: string;
  /** Metadata shown when a point is clicked. Recorded values only. */
  satellite?: string;
  acqDate?: string;
  acqTime?: string;
  confidence?: string | number | null;
  confidenceClass?: "low" | "nominal" | "high" | null;
}

export interface GlobeEarthProps {
  lat: number;
  lon: number;
  /** Search radius: drawn as a true small circle on the sphere. */
  radiusKm?: number;
  /** Real detections to draw. Empty/absent means no fire layer is shown. */
  observations?: GlobeObservation[];
  /** Legend text; states the source of the points without inventing one. */
  observationsNote?: string;
  /**
   * Fired on every selection: the clicked detection, or null when the click
   * landed on bare Earth. Lets the parent keep a detail card in sync.
   */
  onPickObservation?: (item: GlobeObservation | null) => void;
  /** Click / tap / Enter. The parent owns the coordinate state. */
  onSelect: (lat: number, lon: number) => void;
  /**
   * Increment to ask the globe to recentre on `lat`/`lon` (external selection,
   * e.g. the coordinate form or a quick pick). Clicks on the globe itself never
   * move the camera.
   */
  focusToken?: number;
  /** Canvas height in CSS pixels (explicit: a percentage cannot resolve here). */
  height?: number;
  className?: string;
}

type Status = "init" | "ready" | "fallback";

interface SceneApi {
  setSelection: (lat: number, lon: number, radiusKm: number) => void;
  setPoints: (items: GlobeObservation[]) => void;
  focus: (lat: number, lon: number) => void;
  nudge: (dTheta: number, dPhi: number) => void;
  selectCentre: () => void;
}

const ATMO_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vPosW;
void main() {
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPosW = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const ATMO_FRAG = /* glsl */ `
uniform vec3 uRim;
uniform float uStrength;
varying vec3 vNormalW;
varying vec3 vPosW;
void main() {
  vec3 viewDir = normalize(cameraPosition - vPosW);
  float rim = pow(1.0 - abs(dot(viewDir, normalize(vNormalW))), 3.4);
  gl_FragColor = vec4(uRim, rim * uStrength);
}
`;

function webglSupported(): boolean {
  try {
    const probe = document.createElement("canvas");
    const gl =
      probe.getContext("webgl2") ||
      probe.getContext("webgl") ||
      probe.getContext("experimental-webgl");
    if (!gl) return false;
    const lose = (gl as WebGLRenderingContext).getExtension("WEBGL_lose_context");
    lose?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export function GlobeEarth({ lat, lon, radiusKm = 60, observations, observationsNote, onSelect, onPickObservation, focusToken, height = 340, className }: GlobeEarthProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<SceneApi | null>(null);
  // Kept in a ref so the mount-only scene effect can draw the first frame of
  // points without re-running when the observation list changes.
  const observationsRef = useRef<GlobeObservation[] | undefined>(observations);
  observationsRef.current = observations;
  const onPickRef = useRef<((item: GlobeObservation | null) => void) | undefined>(onPickObservation);
  onPickRef.current = onPickObservation;
  const [status, setStatus] = useState<Status>("init");
  const [reason, setReason] = useState<string | null>(null);
  const [hover, setHover] = useState<{ lat: number; lon: number } | null>(null);
  const [load, setLoad] = useState<{ label: string; loaded: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");

  /* ------------------------------------------------------------ selection */
  useEffect(() => {
    apiRef.current?.setSelection(lat, lon, radiusKm);
  }, [lat, lon, radiusKm]);

  // Real detections only. An undefined list means "no fire layer", never "zero
  // fires": the empty list is rendered as nothing and the legend is hidden.
  useEffect(() => {
    apiRef.current?.setPoints(observations ?? []);
  }, [observations]);

  useEffect(() => {
    if (focusToken === undefined) return;
    apiRef.current?.focus(lat, lon);
    // The camera move is a response to an external selection only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusToken]);

  /* --------------------------------------------------------------- render */
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    if (!webglSupported()) {
      setStatus("fallback");
      setReason(
        "This browser did not provide a WebGL context, so the 3D globe is not rendered. " +
          "Coordinate entry and every engine query below still work.",
      );
      return;
    }

    let disposed = false;
    let raf = 0;
    let renderer: THREE.WebGLRenderer | null = null;
    let controls: OrbitControls | null = null;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    const group = new THREE.Group();
    scene.add(group);

    const disposables: Array<{ dispose: () => void }> = [];
    const register = <T extends { dispose: () => void }>(d: T): T => {
      disposables.push(d);
      return d;
    };

    /* ------------------------------------------------------------- canvas */
    const canvas = document.createElement("canvas");
    canvas.className = "block h-full w-full cursor-grab active:cursor-grabbing";
    canvas.setAttribute("aria-hidden", "true");
    mount.appendChild(canvas);

    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: (window.devicePixelRatio || 1) < 1.6,
        alpha: true,
        powerPreference: "high-performance",
        stencil: false,
      });
    } catch (err) {
      setStatus("fallback");
      setReason(
        `The WebGL renderer could not start (${err instanceof Error ? err.message : "unknown error"}). ` +
          "Coordinate entry and the engine queries below are unaffected.",
      );
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      return;
    }
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);

    const startPos = positionFromSpherical(3.0, 0, 88 * DEG);
    camera.position.set(startPos.x, startPos.y, startPos.z);
    camera.lookAt(0, 0, 0);

    /* ------------------------------------------------------ earth surface */
    // 96×64 keeps the silhouette smooth at ~2° per segment without a heavy draw.
    const earthGeo = register(new THREE.SphereGeometry(1, 96, 64));
    const earthMat = register(
      // Unlit on purpose: this sphere is an atlas, not a physical render. A lit
      // globe would show a terminator computed from the wall clock, which reads as
      // a claim about the data window — and it hides half the click target.
      new THREE.MeshBasicMaterial({ color: 0x0d1b2e }),
    );
    const earth = new THREE.Mesh(earthGeo, earthMat);
    // Texture alignment: the group is rotated so the selected meridian faces the
    // default camera (+Z, world lon −90). The camera then starts at azimuth 0, and
    // every later recentre adds this offset back (see `focus`), never twice.
    const rotDeg = earthRotationYForLongitude(lon) * RAD;
    // Rotate the GROUP, not the mesh: the clouds, atmosphere, marker, AOI ring and
    // the sun are siblings, and they must share one frame with the texture. A mesh
    // rotation would leave the marker pointing at the wrong geography.
    group.rotation.y = earthRotationYForLongitude(lon);
    group.add(earth);

    const cloudGeo = register(new THREE.SphereGeometry(1.006, 72, 48));
    const cloudMat = register(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    const clouds = new THREE.Mesh(cloudGeo, cloudMat);
    group.add(clouds);

    const atmoGeo = register(new THREE.SphereGeometry(1.035, 72, 48));
    const atmoMat = register(
      new THREE.ShaderMaterial({
        uniforms: {
          uRim: { value: new THREE.Color(0x39c8f2) },
          uStrength: { value: 0.62 },
        },
        vertexShader: ATMO_VERT,
        fragmentShader: ATMO_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
      }),
    );
    const atmosphere = new THREE.Mesh(atmoGeo, atmoMat);
    group.add(atmosphere);

    /* ------------------------------------------------- night-lights overlay */
    // Additive, low opacity: the Black Marble composite is a real NASA product but
    // it is NOT time-matched to the detection window, so it is a faint texture
    // layer, never a claim that the visible side is in darkness.
    const nightGeo = register(new THREE.SphereGeometry(1.001, 72, 48));
    const nightMat = register(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const nightLayer = new THREE.Mesh(nightGeo, nightMat);
    group.add(nightLayer);

    /* ------------------------------------------------------------- marker */
    const markerGroup = new THREE.Group();
    group.add(markerGroup);
    // Small enough not to swallow the detections around it: a 60 km AOI spans
    // only ~0.009 globe radii, so a 0.013 marker sphere hid every point at the
    // default zoom.
    const markerGeo = register(new THREE.SphereGeometry(0.0045, 16, 12));
    const markerMat = register(new THREE.MeshBasicMaterial({ color: 0x39c8f2 }));
    const marker = new THREE.Mesh(markerGeo, markerMat);
    markerGroup.add(marker);

    const ringGeo = register(new THREE.RingGeometry(0.012, 0.018, 40));
    const ringMat = register(
      new THREE.MeshBasicMaterial({
        color: 0x39c8f2,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const ring = new THREE.Mesh(ringGeo, ringMat);
    markerGroup.add(ring);

    const aoiGeo = register(new THREE.BufferGeometry());
    const aoiMat = register(
      new THREE.LineBasicMaterial({ color: 0xff9d42, transparent: true, opacity: 0.75 }),
    );
    const aoi = new THREE.LineLoop(aoiGeo, aoiMat);
    group.add(aoi);

    /* --------------------------------------------------------- fire layer */
    // One Points object for every stored detection in the AOI. Colours encode
    // the sensor (MODIS orange-red, VIIRS crimson) so the two are never merged
    // into an impression of "more fire pixels": a nearby pair is still two
    // independent observations.
    const fireGeo = register(new THREE.BufferGeometry());
    fireGeo.setAttribute("position", new THREE.Float32BufferAttribute([], 3));
    fireGeo.setAttribute("aColor", new THREE.Float32BufferAttribute([], 3));
    // A shader point, not PointsMaterial: the default world-space size collapsed
    // to well under a CSS pixel at this camera distance, so the layer was present
    // but invisible. This keeps every detection at least 3 CSS px, draws a round
    // dot with a hot core, and scales up when the camera zooms in.
    const fireMat = register(
      new THREE.ShaderMaterial({
        uniforms: {
          uScale: { value: height * 0.5 },
          uDpr: { value: dpr },
        },
        vertexShader: /* glsl */ `
          attribute vec3 aColor;
          uniform float uScale;
          uniform float uDpr;
          varying vec3 vColor;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = clamp(0.03 * uScale / max(0.8, -mv.z), 4.0, 10.0) * uDpr;
            vColor = aColor;
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec3 vColor;
          void main() {
            vec2 c = gl_PointCoord * 2.0 - 1.0;
            float d = length(c);
            if (d > 1.0) discard;
            float alpha = smoothstep(1.0, 0.55, d);
            vec3 col = mix(vec3(1.0), vColor, smoothstep(0.0, 0.65, d));
            gl_FragColor = vec4(col, alpha);
          }
        `,
        transparent: true,
        depthWrite: false,
      }),
    );
    const firePoints = new THREE.Points(fireGeo, fireMat);
    firePoints.frustumCulled = false;
    firePoints.renderOrder = 3;
    group.add(firePoints);
    const pointCoords: { lat: number; lon: number }[] = [];
    let pointItems: GlobeObservation[] = [];
    const MODIS_COLOR = new THREE.Color(0xff8a3d);
    const VIIRS_COLOR = new THREE.Color(0xff3b30);
    const MAX_POINTS = 60_000;

    const setPoints = (items: GlobeObservation[]) => {
      const n = Math.min(items.length, MAX_POINTS);
      const pos = new Float32Array(n * 3);
      const col = new Float32Array(n * 3);
      pointCoords.length = n;
      pointItems = items.slice(0, n);
      for (let i = 0; i < n; i += 1) {
        const item = items[i];
        const v = latLonToVector3(item.lat, item.lon, 1.022);
        const c = item.sensor === "viirs" ? VIIRS_COLOR : MODIS_COLOR;
        pos[i * 3] = v.x;
        pos[i * 3 + 1] = v.y;
        pos[i * 3 + 2] = v.z;
        col[i * 3] = c.r;
        col[i * 3 + 1] = c.g;
        col[i * 3 + 2] = c.b;
        pointCoords[i] = { lat: clampLat(item.lat), lon: wrapLon(item.lon) };
      }
      fireGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      fireGeo.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
      fireGeo.computeBoundingSphere();
      firePoints.visible = n > 0;
    };

    /* ------------------------------------------------------------- textures */
    const loader = new THREE.TextureLoader();
    const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const loadTexture = (
      url: string,
      srgb: boolean,
      onDone: (t: THREE.Texture) => void,
      label: string,
    ) => {
      const tex = loader.load(
        url,
        (t) => {
          if (disposed) {
            t.dispose();
            return;
          }
          t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          t.anisotropy = maxAniso;
          t.wrapS = THREE.RepeatWrapping;
          t.wrapT = THREE.ClampToEdgeWrapping;
          onDone(t);
        },
        (event) => {
          if (disposed) return;
          const total = "total" in event && Number.isFinite(event.total) ? event.total : 0;
          setLoad({ label, loaded: event.loaded, total });
        },
        () => {
          if (disposed) return;
          // A missing map is not fatal: the sphere stays and the panel says so.
          setLoad(null);
          setStatus("ready");
          setNote(
            `The ${label} texture did not load, so that layer is missing from the globe. ` +
              "Coordinates and the engine queries below are unaffected.",
          );
        },
      );
      register(tex);
      return tex;
    };

    // Day map first (it is the only one that changes the silhouette), then the
    // two overlays. Progressive by construction: each map appears when decoded.
    loadTexture("/textures/earth-day.jpg", true, (tex) => {
      earthMat.map = tex;
      earthMat.color.set(0xffffff);
      earthMat.needsUpdate = true;
      setLoad(null);
      setStatus("ready");
      setReason(null);
      loadTexture("/textures/earth-night.jpg", true, (night) => {
        nightMat.map = night;
        nightMat.opacity = 0.22;
        nightMat.needsUpdate = true;
      }, "night-lights");
      loadTexture("/textures/earth-clouds.png", false, (alpha) => {
        cloudMat.alphaMap = alpha;
        cloudMat.opacity = 0.3;
        cloudMat.needsUpdate = true;
      }, "cloud");
    }, "Blue Marble");

    /* ------------------------------------------------------------- controls */
    controls = new OrbitControls(camera, canvas);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.9;
    controls.minDistance = 1.32;
    controls.maxDistance = 6;
    controls.autoRotateSpeed = 0.28;

    let interacting = false;
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = motionQuery.matches;
    const applyMotion = () => {
      reduced = motionQuery.matches;
      if (controls) controls.autoRotate = !reduced && !interacting;
    };
    applyMotion();
    motionQuery.addEventListener?.("change", applyMotion);

    /* ---------------------------------------------------------- selection */
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    raycaster.params.Points = { threshold: 0.007 };

    const localPointAt = (
      nx: number,
      ny: number,
    ): { lat: number; lon: number; obs?: GlobeObservation } | null => {
      ndc.set(nx, ny);
      raycaster.setFromCamera(ndc, camera);
      // A click on a detection returns that detection's exact recorded
      // coordinate and its metadata, so the panel describes the observed pixel
      // rather than an arbitrary nearby point on the sphere.
      if (pointCoords.length) {
        const pointHit = raycaster.intersectObject(firePoints, false)[0];
        if (pointHit && typeof pointHit.index === "number") {
          const coord = pointCoords[pointHit.index];
          if (coord) return { ...coord, obs: pointItems[pointHit.index] };
        }
      }
      const hit = raycaster.intersectObject(earth, false)[0];
      if (!hit) return null;
      // The Earth group is rotated: convert the world hit into the sphere's own
      // frame before reading the equirectangular UV convention.
      const local = earth.worldToLocal(hit.point.clone());
      const ll = vector3ToLatLon({ x: local.x, y: local.y, z: local.z });
      return { lat: clampLat(ll.lat), lon: wrapLon(ll.lon) };
    };

    let focusTarget: { theta: number; phi: number } | null = null;

    const setSelection = (la: number, lo: number, radius: number) => {
      const v = latLonToVector3(la, lo, 1.014);
      markerGroup.position.set(v.x, v.y, v.z);
      markerGroup.lookAt(0, 0, 0);
      ring.position.set(0, 0, 0);
      const pts = circleOnSphere(la, lo, radius, 128, 1.012).map(
        (p) => new THREE.Vector3(p.x, p.y, p.z),
      );
      aoiGeo.setFromPoints(pts);
      aoiGeo.computeBoundingSphere();
    };

    // A local meridian `lo` sits at world longitude `lo + rotDeg`, and the camera
    // azimuth that centres world longitude W is W + 90. Hence lo + rotDeg + 90.
    const focusTheta = (lo: number) => (wrapLon(lo) + rotDeg + 90) * DEG;
    const focus = (la: number, lo: number) => {
      if (reduced) {
        const target = positionFromSpherical(
          camera.position.length(),
          focusTheta(lo),
          (90 - clampLat(la)) * DEG,
        );
        camera.position.set(target.x, target.y, target.z);
        camera.lookAt(0, 0, 0);
        controls?.update();
        focusTarget = null;
        return;
      }
      focusTarget = { theta: focusTheta(lo), phi: clampPolar((90 - clampLat(la)) * DEG) };
    };

    const nudge = (dTheta: number, dPhi: number) => {
      const s = sphericalFromPosition({
        x: camera.position.x, y: camera.position.y, z: camera.position.z,
      });
      const next = positionFromSpherical(s.radius, s.theta + dTheta, clampPolar(s.phi + dPhi));
      camera.position.set(next.x, next.y, next.z);
      camera.lookAt(0, 0, 0);
      controls?.update();
      focusTarget = null;
    };

    const selectCentre = () => {
      const ll = localPointAt(0, 0);
      if (ll) emit(ll.lat, ll.lon, ll.obs);
    };

    /* ---------------------------------------------------------- interaction */
    let pointerId: number | null = null;
    let downX = 0;
    let downY = 0;
    let downAt = 0;
    let maxMove = 0;
    let hoverKey = "";

    const emit = (la: number, lo: number, obs?: GlobeObservation) => {
      setAnnounce(`Selected ${formatLat(la, 2)}, ${formatLon(lo, 2)}`);
      onPickRef.current?.(obs ?? null);
      onSelect(la, lo);
    };

    const onPointerDown = (event: PointerEvent) => {
      pointerId = event.pointerId;
      downX = event.clientX;
      downY = event.clientY;
      downAt = performance.now();
      maxMove = 0;
      interacting = true;
      if (controls) controls.autoRotate = false;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (pointerId !== null && event.pointerId === pointerId) {
        maxMove = Math.max(
          maxMove,
          Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY),
        );
      }
      // Hover readout only for devices with a real pointer: on touch, "hover" is
      // a half-finished drag and would be noise.
      if (event.pointerType === "touch") return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      const ll = localPointAt(nx, ny);
      const key = ll ? `${ll.lat.toFixed(2)},${ll.lon.toFixed(2)}` : "";
      if (key !== hoverKey) {
        hoverKey = key;
        setHover(ll);
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      const wasDrag = maxMove > 6 || performance.now() - downAt > 900;
      const same = pointerId === event.pointerId;
      pointerId = null;
      interacting = false;
      if (controls) controls.autoRotate = !reduced;
      if (wasDrag || !same) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      const ll = localPointAt(nx, ny);
      if (ll) emit(ll.lat, ll.lon, ll.obs);
    };

    const onPointerLeave = () => {
      pointerId = null;
      interacting = false;
      if (controls) controls.autoRotate = !reduced;
      hoverKey = "";
      setHover(null);
    };

    const onControlsStart = () => {
      interacting = true;
      focusTarget = null;
    };
    const onControlsEnd = () => {
      interacting = false;
      if (controls) controls.autoRotate = !reduced;
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      if (disposed) return;
      setStatus("fallback");
      setReason(
        "The WebGL context was lost (this usually means the GPU was reset or the tab was " +
          "backgrounded for a long time). Coordinate entry and the engine queries still work; " +
          "reload the page to bring the globe back.",
      );
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerLeave);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("webglcontextlost", onContextLost);
    controls.addEventListener("start", onControlsStart);
    controls.addEventListener("end", onControlsEnd);

    /* --------------------------------------------------------------- resize */
    const resize = () => {
      const rect = mount.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      renderer?.setPixelRatio(pixelRatio);
      renderer?.setSize(w, h, false);
      (fireMat.uniforms.uDpr as { value: number }).value = pixelRatio;
      (fireMat.uniforms.uScale as { value: number }).value = h * 0.5;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    /* ----------------------------------------------------------------- loop */
    let last = performance.now();
    const frame = (now: number) => {
      raf = 0;
      if (disposed) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (focusTarget) {
        const s = sphericalFromPosition({
          x: camera.position.x, y: camera.position.y, z: camera.position.z,
        });
        const k = 1 - Math.pow(0.001, dt); // frame-rate independent easing
        const theta = s.theta + shortestAngle(s.theta, focusTarget.theta) * k;
        const phi = s.phi + (focusTarget.phi - s.phi) * k;
        const p = positionFromSpherical(s.radius, theta, clampPolar(phi));
        camera.position.set(p.x, p.y, p.z);
        camera.lookAt(0, 0, 0);
        if (
          Math.abs(shortestAngle(s.theta, focusTarget.theta)) < 0.002 &&
          Math.abs(focusTarget.phi - s.phi) < 0.002
        ) {
          focusTarget = null;
        }
      }
      controls?.update();
      renderer?.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onVisibility = () => {
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (!raf && !disposed) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    setSelection(lat, lon, radiusKm);
    focus(lat, lon);

    setPoints(observationsRef.current ?? []);
    apiRef.current = { setSelection, setPoints, focus, nudge, selectCentre };

    /* --------------------------------------------------------------- cleanup */
    return () => {
      disposed = true;
      apiRef.current = null;
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      motionQuery.removeEventListener?.("change", applyMotion);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerLeave);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      controls?.removeEventListener("start", onControlsStart);
      controls?.removeEventListener("end", onControlsEnd);
      controls?.dispose();
      controls = null;
      disposables.forEach((d) => {
        try {
          d.dispose();
        } catch {
          /* already disposed */
        }
      });
      scene.clear();
      renderer?.dispose();
      renderer?.forceContextLoss();
      renderer = null;
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    };
    // Mount-only: lat/lon/radius are pushed in through the effects above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------- keyboard */
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const api = apiRef.current;
    if (!api) return;
    const step = (event.shiftKey ? 15 : 5) * DEG;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        api.nudge(-step, 0);
        break;
      case "ArrowRight":
        event.preventDefault();
        api.nudge(step, 0);
        break;
      case "ArrowUp":
        event.preventDefault();
        api.nudge(0, -step);
        break;
      case "ArrowDown":
        event.preventDefault();
        api.nudge(0, step);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        api.selectCentre();
        break;
      case "Home":
        event.preventDefault();
        api.focus(lat, lon);
        break;
      default:
        break;
    }
  }, [lat, lon]);

  const showFallback = status === "fallback";

  return (
    // The root carries the height: in a column flex container `flex-basis: 0`
    // would otherwise override any height set on the child.
    <div className={cn("flex min-h-0 flex-col", className)} style={{ height }}>
      <div className="relative min-h-0 flex-1 touch-none overflow-hidden rounded-lg border border-line/60 bg-void">
        <div
          ref={mountRef}
          role="application"
          tabIndex={0}
          aria-label="Interactive 3D Earth. Drag to rotate, scroll to zoom. Arrow keys rotate the view, Enter selects the point at the centre, Home recentres on the current selection."
          onKeyDown={onKeyDown}
          className={cn(
            "absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-cyan/60",
            showFallback && "hidden",
          )}
        />

        {showFallback ? (
          <div className="flex h-full flex-col items-start gap-2 p-4">
            <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-ember">
              <Globe2 size={11} /> 3D globe unavailable
            </span>
            <p className="text-[12px] leading-relaxed text-ink">
              The interactive Earth needs WebGL, which this browser session did not provide.
            </p>
            <p className="max-w-lg text-[11.5px] leading-relaxed text-muted">{reason}</p>
            <p className="mt-1 font-mono text-[10.5px] text-muted/80">
              Current selection · {formatLat(lat, 2)}, {formatLon(lon, 2)} · radius {radiusKm} km
            </p>
          </div>
        ) : null}

        {/* Hover readout: geometry only, never a data value. */}
        {!showFallback ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-void/90 to-transparent px-2.5 pb-2 pt-6">
            <span className="font-mono text-[10px] text-cyan/90">
              {hover
                ? `cursor ${formatLat(hover.lat, 2)}, ${formatLon(hover.lon, 2)}`
                : "drag to orbit · scroll to zoom"}
            </span>
          </div>
        ) : null}

        {!showFallback ? (
          <div className="pointer-events-none absolute right-2.5 top-2.5 max-w-[70%] truncate rounded border border-line/60 bg-panel/85 px-2 py-1 text-right font-mono text-[9px] uppercase tracking-[0.14em] text-muted/80">
            {load
              ? load.total
                ? `${load.label} ${Math.round(load.loaded / 1024)} / ${Math.round(load.total / 1024)} KB`
                : `${load.label} · loading`
              : status === "ready"
                ? "NASA Blue Marble · Black Marble"
                : "initialising"}
          </div>
        ) : null}
      </div>

      {note ? (
        <p className="mt-2 text-[10.5px] leading-snug text-ember/90">{note}</p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 font-mono text-[9px] uppercase tracking-[0.13em] text-muted/70">
          <span className="inline-flex items-center gap-1"><MousePointerClick size={10} /> click to select</span>
          <span className="inline-flex items-center gap-1"><Keyboard size={10} /> arrows + enter</span>
          {observations && observations.length ? (
            <span className="inline-flex items-center gap-2" title={observationsNote}>
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ff8a3d]" /> MODIS
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-[#ff3b30]" /> VIIRS
              </span>
              <span className="text-muted/50">· {observations.length.toLocaleString("en-US")} shown</span>
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => apiRef.current?.focus(lat, lon)}
          className="inline-flex items-center gap-1 rounded border border-line bg-elevated/40 px-1.5 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-muted transition-colors hover:border-cyan/40 hover:text-cyan"
          disabled={showFallback}
        >
          <RotateCcw size={9} /> recentre
        </button>
      </div>
      <p className="sr-only" aria-live="polite">{announce}</p>
    </div>
  );
}

/** Signed shortest angular difference, in radians, from a to b. */
function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
