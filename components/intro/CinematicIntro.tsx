"use client";

/**
 * FIREWATCH — cinematic opening sequence (10.6 s).
 *
 * Beats (seconds)
 *   0.00 – 2.20  THE VOID        near-black, drifting star dust, a light source
 *                                blooming out of nothing, slow parallax drift.
 *   2.00 – 4.90  LH STUDIOS      volumetric shaft + particles, the mark draws
 *                                itself (ring → orbit → ember core → satellite),
 *                                letterspaced wordmark resolves.
 *   4.70 – 6.60  TRANSITION      the logo dissolves into a procedural Earth:
 *                                GLSL fbm continents / clouds / fresnel
 *                                atmosphere, orbital arcs, thermal embers,
 *                                camera push-in.
 *   6.40 – 10.60 FIREWATCH       title + tagline + cyan accent sweep, hold,
 *                                fade to the app background, onComplete().
 *
 * The WebGL scene, the typographic overlay and the synthesised score are all
 * driven from one frame timeline so picture and sound stay frame-locked.
 * Self-contained: three.js + WebAudio + this CSS file, zero binary assets.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { Volume2, VolumeX } from "lucide-react";
import { createIntroAudio, type IntroAudioHandle } from "./audio";
import "./intro.css";

export interface CinematicIntroProps {
  muted: boolean;
  onToggleMute: () => void;
  onComplete: () => void;
  reducedMotion?: boolean;
}

const DURATION = 10.6;
const REDUCED_DURATION = 2.2;
const PHASES = ["SIGNAL ACQUIRED", "ORIGIN IDENTIFIED", "PLANETARY MESH", "THERMAL LAYER ONLINE"];

/* ------------------------------------------------------------------ maths */
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
const easeOut = (v: number) => 1 - Math.pow(1 - v, 3);
const easeIn = (v: number) => v * v * v;
const mix = (a: number, b: number, v: number) => a + (b - a) * v;

/** Literal sRGB triple — raw ShaderMaterial output is display-referred here. */
function rgb(hex: number): THREE.Vector3 {
  return new THREE.Vector3(
    ((hex >> 16) & 255) / 255,
    ((hex >> 8) & 255) / 255,
    (hex & 255) / 255,
  );
}

/* ---------------------------------------------------------------- shaders */

const STAR_VERT = /* glsl */ `
attribute float aPhase;
attribute float aSize;
uniform float uTime;
uniform float uOpacity;
uniform float uPixel;
varying float vA;

void main() {
  vec3 p = position;
  float ph = aPhase * 6.28318;
  p.x += sin(uTime * 0.09 + ph) * 0.24;
  p.y += cos(uTime * 0.07 + ph * 1.3) * 0.2;
  p.z += sin(uTime * 0.05 + ph * 0.7) * 0.16;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float twinkle = 0.4 + 0.6 * pow(0.5 + 0.5 * sin(uTime * (0.5 + aPhase * 1.9) + ph), 2.0);
  float depth = clamp(1.0 - (-mv.z) / 36.0, 0.16, 1.0);
  vA = twinkle * uOpacity * depth;
  gl_PointSize = max(1.0, aSize * uPixel * (26.0 / max(1.0, -mv.z)));
}
`;

const STAR_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uColor;
varying float vA;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = smoothstep(1.0, 0.0, d);
  a *= a;
  gl_FragColor = vec4(uColor, a * vA);
}
`;

const BLOOM_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BLOOM_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uIntensity;
uniform float uAspect;
uniform vec3 uColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  p.x *= uAspect;
  float r = length(p);
  float n = fbm(p * 2.6 + vec2(uTime * 0.04, -uTime * 0.07));

  // tight source, restrained halo — a lamp, not a starburst
  float core = exp(-r * r * 38.0);
  float halo = exp(-r * r * 4.2) * 0.26;

  // narrow vertical shaft of light standing behind the mark
  float shaft = exp(-p.x * p.x * 90.0) * (1.0 - smoothstep(0.12, 1.15, abs(p.y))) * 0.34;

  // very fine drifting filaments
  float ang = atan(p.y, p.x);
  float filaments = pow(0.5 + 0.5 * sin(ang * 13.0 + uTime * 0.05 + n * 1.6), 5.0);
  filaments *= 0.1 * (1.0 - smoothstep(0.08, 0.95, r));

  float glow = core + halo + shaft * (0.55 + 0.45 * n) + filaments * (0.6 + n);
  glow *= uIntensity;

  vec3 tint = mix(uColor, vec3(1.0, 0.89, 0.76), clamp(core * 0.55, 0.0, 1.0));
  gl_FragColor = vec4(tint, clamp(glow, 0.0, 1.0));
}
`;

const EARTH_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vObj;

void main() {
  vObj = position;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPosW = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const EARTH_FRAG = /* glsl */ `
precision highp float;

varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vObj;

uniform vec3  uSun;
uniform float uTime;
uniform float uOpacity;
uniform float uDetail;
uniform vec3  uDeep;
uniform vec3  uOcean;
uniform vec3  uLand;
uniform vec3  uLandWarm;
uniform vec3  uCloud;
uniform vec3  uRim;
uniform vec3  uEmber;

float hash31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z);
}

float fbm3(vec3 p, int oct) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

vec3 rotY(vec3 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

void main() {
  vec3 n = normalize(vObj);
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  vec3 L = normalize(uSun);

  int oct = int(3.0 + uDetail * 2.0);

  // ---- continents: domain-warped fbm sampled in object space (no UV seam)
  vec3 warp = vec3(
    fbm3(n * 2.1 + vec3(11.3, 3.7, 9.1), 2),
    fbm3(n * 2.1 + vec3(4.1, 19.7, 2.3), 2),
    fbm3(n * 2.1 + vec3(7.9, 1.1, 15.5), 2)
  ) - 0.5;

  vec3 q = n * 2.35 + warp * 0.55;
  float h = fbm3(q, oct);

  float land = smoothstep(0.478, 0.545, h);
  float shelf = smoothstep(0.44, 0.505, h) * (1.0 - land);
  float relief = fbm3(q * 3.1 + vec3(21.0), 3);

  // ---- clouds drift independently of the surface
  vec3 cq = rotY(n, uTime * 0.013) * 3.25 + vec3(37.0, 5.0, 23.0);
  float cl = fbm3(cq, 3);
  float clouds = smoothstep(0.455, 0.665, cl) * 0.95;
  float cirrus = smoothstep(0.56, 0.82, fbm3(cq * 2.4 + vec3(9.0), 2)) * 0.3;

  // ---- albedo
  vec3 ocean = mix(uDeep, uOcean, clamp(0.22 + shelf * 0.75 + (1.0 - h) * 0.5, 0.0, 1.0));
  vec3 landCol = mix(uLand, uLandWarm, smoothstep(0.42, 0.78, relief));
  landCol *= 0.82 + 0.36 * relief;
  vec3 albedo = mix(ocean, landCol, land);
  albedo = mix(albedo, uCloud, clouds);
  albedo = mix(albedo, uCloud * 1.04, cirrus * 0.5);

  // ---- sun
  float ndl = dot(N, L);
  float day = smoothstep(-0.12, 0.42, ndl);
  float lam = clamp(ndl, 0.0, 1.0);
  float terminator = smoothstep(-0.26, 0.02, ndl) * (1.0 - smoothstep(0.02, 0.34, ndl));

  vec3 col = albedo * (0.05 + 1.3 * pow(lam, 0.78));
  col += uRim * 0.05 * day;

  vec3 H = normalize(L + V);
  float spec = pow(clamp(dot(N, H), 0.0, 1.0), 64.0) * (1.0 - land) * (1.0 - clouds * 0.7);
  col += vec3(0.62, 0.84, 1.0) * spec * 0.55;

  // ---- atmosphere: tight fresnel at the limb only, so the surface keeps contrast
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.4);
  col += uRim * fres * (0.2 + 0.95 * day);
  col += uRim * 0.3 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.3) * max(ndl, 0.0);
  col += mix(uRim, uEmber, 0.3) * terminator * 0.1;

  // ---- night side: faint warm landmass + sparse ember hotspots
  float night = 1.0 - day;
  float hotspots = smoothstep(0.69, 0.88, fbm3(n * 11.0 + vec3(3.0), 3));
  col += uEmber * night * land * hotspots * 0.34;
  col += uEmber * night * land * 0.025;

  gl_FragColor = vec4(col, uOpacity);
}
`;

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
precision highp float;
varying vec3 vNormalW;
varying vec3 vPosW;
uniform vec3 uSun;
uniform vec3 uRim;
uniform float uOpacity;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  vec3 L = normalize(uSun);
  float rim = pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 2.7);
  float sun = 0.35 + 0.85 * max(dot(N, L), 0.0);
  float a = rim * sun * uOpacity;
  gl_FragColor = vec4(uRim * (0.75 + 0.7 * max(dot(N, L), 0.0)), a);
}
`;

const SPARK_VERT = /* glsl */ `
attribute float aPhase;
attribute float aScale;
uniform float uTime;
uniform float uOpacity;
uniform float uPixel;
varying float vA;
varying float vHue;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float pulse = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(uTime * (1.6 + aPhase * 2.6) + aPhase * 6.28), 2.0);
  vA = uOpacity * pulse * (0.35 + 0.65 * aPhase);
  vHue = aPhase;
  gl_PointSize = max(1.0, uPixel * (aScale * 300.0) / max(0.55, -mv.z));
}
`;

const SPARK_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uEmber;
uniform vec3 uFire;
varying float vA;
varying float vHue;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = smoothstep(1.0, 0.0, d);
  a = pow(a, 1.7);
  vec3 col = mix(uEmber, uFire, vHue);
  col = mix(col, vec3(1.0, 0.94, 0.82), pow(smoothstep(0.75, 0.0, d), 3.0));
  gl_FragColor = vec4(col, a * vA);
}
`;

/* ------------------------------------------------------------- scene types */

type NumUniform = { value: number };

interface SceneState {
  planet: THREE.Group;
  earth: THREE.Mesh;
  earthTex: THREE.Mesh;
  earthTexMat: THREE.MeshStandardMaterial;
  clouds: THREE.Mesh;
  cloudMat: THREE.MeshStandardMaterial;
  atmosphere: THREE.Mesh;
  sparks: THREE.Points;
  stars: THREE.Points;
  bloom: THREE.Mesh;
  ringMats: Array<{ material: THREE.LineBasicMaterial | THREE.LineDashedMaterial; base: number }>;
  u: {
    starTime: NumUniform;
    starOpacity: NumUniform;
    bloomTime: NumUniform;
    bloomIntensity: NumUniform;
    earthTime: NumUniform;
    earthOpacity: NumUniform;
    ringOpacity: NumUniform;
    sparkOpacity: NumUniform;
  };
}

const SUN = new THREE.Vector3(-0.62, 0.36, 0.7).normalize();

function buildScene(
  scene: THREE.Scene,
  register: (disposable: { dispose(): void }) => void,
): SceneState {
  const width = window.innerWidth;
  const small = width < 720;

  /* ---------------------------------------------------------- star dust */
  const starCount = width < 520 ? 260 : width < 900 ? 560 : width < 1400 ? 820 : 1100;
  const starPos = new Float32Array(starCount * 3);
  const starPhase = new Float32Array(starCount);
  const starSize = new Float32Array(starCount);

  for (let i = 0; i < starCount; i += 1) {
    const radius = 9 + Math.pow(Math.random(), 0.55) * 21;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    starPos[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    starPos[i * 3 + 1] = radius * Math.cos(phi) * 0.72;
    starPos[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    starPhase[i] = Math.random();
    // a handful of brighter "near" motes
    starSize[i] = 0.7 + Math.pow(Math.random(), 3) * 2.4;
  }

  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute("aPhase", new THREE.BufferAttribute(starPhase, 1));
  starGeo.setAttribute("aSize", new THREE.BufferAttribute(starSize, 1));
  register(starGeo);

  const starOpacity: NumUniform = { value: 0 };
  const starTime: NumUniform = { value: 0 };
  const starMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: starTime,
      uOpacity: starOpacity,
      uPixel: { value: Math.min(window.devicePixelRatio || 1, 1.75) },
      uColor: { value: new THREE.Vector3(0.83, 0.93, 1) },
    },
    vertexShader: STAR_VERT,
    fragmentShader: STAR_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  register(starMat);
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  stars.renderOrder = 0;
  scene.add(stars);

  /* --------------------------------------------------- volumetric bloom */
  const bloomGeo = new THREE.PlaneGeometry(17, 17);
  register(bloomGeo);
  const bloomIntensity: NumUniform = { value: 0 };
  const bloomTime: NumUniform = { value: 0 };
  const bloomMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: bloomTime,
      uIntensity: bloomIntensity,
      uAspect: { value: window.innerWidth / window.innerHeight },
      uColor: { value: new THREE.Vector3(0.22, 0.78, 0.95) },
    },
    vertexShader: BLOOM_VERT,
    fragmentShader: BLOOM_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  register(bloomMat);
  const bloom = new THREE.Mesh(bloomGeo, bloomMat);
  bloom.position.set(0, 0, -3);
  bloom.frustumCulled = false;
  bloom.renderOrder = 1;
  scene.add(bloom);

  /* --------------------------------------------------------- planet rig */
  const planet = new THREE.Group();
  scene.add(planet);

  const segments = small ? 72 : 128;
  const earthGeo = new THREE.SphereGeometry(1, segments, Math.max(32, Math.round(segments / 2)));
  register(earthGeo);

  const earthTime: NumUniform = { value: 0 };
  const earthOpacity: NumUniform = { value: 0 };
  const earthMat = new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: SUN },
      uTime: earthTime,
      uOpacity: earthOpacity,
      uDetail: { value: small ? 0.35 : 1 },
      uDeep: { value: rgb(0x061524) },
      uOcean: { value: rgb(0x14425f) },
      uLand: { value: rgb(0x47553f) },
      uLandWarm: { value: rgb(0x7a5a34) },
      uCloud: { value: rgb(0xeaf3fb) },
      uRim: { value: rgb(0x39c8f2) },
      uEmber: { value: rgb(0xff9d42) },
    },
    vertexShader: EARTH_VERT,
    fragmentShader: EARTH_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  });
  register(earthMat);
  const earth = new THREE.Mesh(earthGeo, earthMat);
  earth.renderOrder = 2;
  earth.frustumCulled = false;
  planet.add(earth);

  /* Real NASA GIBS true-colour texture. The procedural shader stays as the
     fallback until the image decodes, then fades out so the planet is lit
     imagery rather than a painted sphere. */
  const earthTexMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.84, metalness: 0.04,
    emissive: new THREE.Color(0xffdcae), emissiveIntensity: 0.38,
    transparent: true, opacity: 0, depthWrite: false, depthTest: false,
  });
  const earthTex = new THREE.Mesh(earthGeo, earthTexMat);
  earthTex.renderOrder = 2;
  earthTex.frustumCulled = false;
  earthTex.visible = false;
  planet.add(earthTex);

  const sunLight = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sunLight.position.copy(SUN).multiplyScalar(6);
  scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0x1b2a3d, 1.1));

  /* Cloud shell: a second sphere a hair above the surface, driven by a luminance
     alpha map, drifting slightly faster than the crust. */
  const cloudGeo = new THREE.SphereGeometry(1.014, Math.max(48, segments / 2), Math.max(24, segments / 4));
  register(cloudGeo);
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
    transparent: true, opacity: 0, depthWrite: false, depthTest: false,
  });
  register(cloudMat);
  const clouds = new THREE.Mesh(cloudGeo, cloudMat);
  clouds.renderOrder = 3;
  clouds.frustumCulled = false;
  clouds.visible = false;
  planet.add(clouds);

  /* NASA Blue Marble (day) + Black Marble night lights (emissive) + cloud alpha.
     The procedural shader stays as the fallback until the day map decodes. */
  const loader = new THREE.TextureLoader();
  const useMap = (path: string, srgb: boolean, apply: (tex: THREE.Texture) => void) =>
    loader.load(
      path,
      (tex) => {
        if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        tex.wrapS = THREE.RepeatWrapping;
        apply(tex);
      },
      undefined,
      () => { /* keep the procedural planet if a map is unavailable */ },
    );

  useMap("/textures/earth-day.jpg", true, (tex) => {
    earthTexMat.map = tex;
    earthTexMat.needsUpdate = true;
    earthTex.visible = true;
  });
  useMap("/textures/earth-night.jpg", true, (tex) => {
    earthTexMat.emissiveMap = tex;
    earthTexMat.needsUpdate = true;
  });
  useMap("/textures/earth-clouds.png", false, (tex) => {
    cloudMat.alphaMap = tex;
    cloudMat.needsUpdate = true;
    clouds.visible = true;
  });

  const atmoGeo = new THREE.SphereGeometry(1.055, Math.max(48, segments / 2), Math.max(24, segments / 4));
  register(atmoGeo);
  const atmoMat = new THREE.ShaderMaterial({
    uniforms: {
      uSun: { value: SUN },
      uRim: { value: rgb(0x39c8f2) },
      uOpacity: earthOpacity,
    },
    vertexShader: ATMO_VERT,
    fragmentShader: ATMO_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
  });
  register(atmoMat);
  const atmosphere = new THREE.Mesh(atmoGeo, atmoMat);
  atmosphere.renderOrder = 3;
  atmosphere.frustumCulled = false;
  planet.add(atmosphere);

  /* -------------------------------------------------------- orbital arcs */
  const ringOpacity: NumUniform = { value: 0 };
  const ringMats: SceneState["ringMats"] = [];
  const orbits: Array<[number, number, number, number, number]> = [
    [1.22, 0.34, 0.4, 0x39c8f2, 0.5],
    [1.4, -0.24, 1.15, 0x39c8f2, 0.3],
    [1.62, 0.13, 2.2, 0xff9d42, 0.24],
    [1.12, 0.95, 0.7, 0x39c8f2, 0.34],
  ];
  orbits.forEach(([radius, tilt, spin, color, base], index) => {
    const curve = new THREE.EllipseCurve(0, 0, radius, radius, 0, Math.PI * 2, false, 0);
    const points = curve.getPoints(index === 2 ? 96 : 160).map((p) => new THREE.Vector3(p.x, 0, p.y));
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    register(geo);
    const dashed = index !== 1;
    const material = dashed
      ? new THREE.LineDashedMaterial({
          color,
          transparent: true,
          opacity: base,
          dashSize: 0.09,
          gapSize: 0.07,
          depthWrite: false,
          depthTest: false,
          blending: THREE.AdditiveBlending,
        })
      : new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: base,
          depthWrite: false,
          depthTest: false,
          blending: THREE.AdditiveBlending,
        });
    register(material);
    const line = new THREE.Line(geo, material);
    if (dashed) line.computeLineDistances();
    line.rotation.set(tilt, spin, tilt * 0.35);
    line.renderOrder = 4;
    line.frustumCulled = false;
    planet.add(line);
    ringMats.push({ material, base });
  });

  /* --------------------------------------------------- thermal embers */
  const sparkCount = small ? 18 : 34;
  const sparkPos = new Float32Array(sparkCount * 3);
  const sparkPhase = new Float32Array(sparkCount);
  const sparkScale = new Float32Array(sparkCount);
  for (let i = 0; i < sparkCount; i += 1) {
    const radius = i < sparkCount * 0.7 ? 1.0 + Math.random() * 0.02 : 1.16 + Math.random() * 0.32;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    sparkPos[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    sparkPos[i * 3 + 1] = radius * Math.cos(phi);
    sparkPos[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    sparkPhase[i] = Math.random();
    sparkScale[i] = 0.016 + Math.random() * 0.05;
  }
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute("aPhase", new THREE.BufferAttribute(sparkPhase, 1));
  sparkGeo.setAttribute("aScale", new THREE.BufferAttribute(sparkScale, 1));
  register(sparkGeo);

  const sparkOpacity: NumUniform = { value: 0 };
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: earthTime,
      uOpacity: sparkOpacity,
      uPixel: { value: Math.min(window.devicePixelRatio || 1, 1.75) },
      uEmber: { value: rgb(0xff9d42) },
      uFire: { value: rgb(0xff633d) },
    },
    vertexShader: SPARK_VERT,
    fragmentShader: SPARK_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  register(sparkMat);
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.renderOrder = 5;
  sparks.frustumCulled = false;
  planet.add(sparks);

  planet.visible = false;
  atmosphere.visible = false;
  sparks.visible = false;
  ringMats.forEach((r) => {
    r.material.visible = false;
  });

  return {
    planet,
    earth,
    earthTex,
    earthTexMat,
    clouds,
    cloudMat,
    atmosphere,
    sparks,
    stars,
    bloom,
    ringMats,
    u: {
      starTime,
      starOpacity,
      bloomTime,
      bloomIntensity,
      earthTime,
      earthOpacity,
      ringOpacity,
      sparkOpacity,
    },
  };
}

/* ---------------------------------------------------------- public pieces */

export function CinematicIntro(props: CinematicIntroProps) {
  if (props.reducedMotion) return <ReducedIntro {...props} />;
  return <CinematicSequence {...props} />;
}

/* --------------------------------------------------------- reduced motion */
/** 2.2 s static branding card: logo + title + tagline, no camera, no particles. */
function ReducedIntro({ muted, onToggleMute, onComplete }: CinematicIntroProps) {
  const doneRef = useRef(false);
  const mutedRef = useRef(muted);
  const audioRef = useRef<IntroAudioHandle | null>(null);
  const [visible, setVisible] = useState(false);

  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    audioRef.current?.stop();
    onCompleteRef.current();
  }, []);

  useEffect(() => {
    const audio = createIntroAudio({ muted: mutedRef.current, reducedMotion: true });
    audioRef.current = audio;
    audio.start();

    const showTimer = window.setTimeout(() => setVisible(true), 40);
    const endTimer = window.setTimeout(finish, REDUCED_DURATION * 1000);
    const unlock = () => audio.resume();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish();
    };

    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    window.addEventListener("keydown", onKey);

    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(endTimer);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("keydown", onKey);
      audio.stop();
      audio.dispose();
      audioRef.current = null;
    };
  }, [finish]);

  useEffect(() => {
    mutedRef.current = muted;
    audioRef.current?.setMuted(muted);
  }, [muted]);

  return (
    <div
      className="fw-intro fw-reduced"
      role="dialog"
      aria-modal="true"
      aria-label="FIREWATCH by LH Studios"
    >
      <div className="fw-progress" aria-hidden="true">
        <div className="fw-progress-bar fw-progress-bar-static" />
      </div>

      <div className="fw-reduced-inner" data-visible={visible ? "true" : "false"}>
        <div className="fw-mark-wrap" style={{ width: "clamp(46px, 7vmin, 68px)" }}>
          <div className="fw-mark-glow" style={{ opacity: 0.5 }} aria-hidden="true" />
          <BrandGlyph />
        </div>
        <div className="fw-sublabel">
          LH STUDIOS <em>·</em> EARTH OBSERVATION
        </div>
        <h1 className="fw-reduced-title">
          FIREWATCH
        </h1>
        <p className="fw-reduced-tagline">
          See the patterns. Understand the fires. Protect the future.
        </p>
      </div>

      <div className="fw-hud">
        <div className="fw-hud-left">
          <div className="fw-microcopy">LH STUDIOS · EARTH OBSERVATION</div>
        </div>
        <div className="fw-controls">
          <MuteButton muted={muted} onToggleMute={onToggleMute} />
          <button type="button" className="fw-btn fw-btn-primary" onClick={finish}>
            <span className="fw-btn-label">Skip intro</span>
            <span className="fw-btn-arrow" aria-hidden="true">
              →
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- full intro */

function CinematicSequence({ muted, onToggleMute, onComplete }: CinematicIntroProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const phaseRef = useRef<HTMLSpanElement>(null);
  const logoLayerRef = useRef<HTMLDivElement>(null);
  const markGlowRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  const orbitRef = useRef<SVGEllipseElement>(null);
  const coreRef = useRef<SVGPathElement>(null);
  const innerRef = useRef<SVGPathElement>(null);
  const ticksRef = useRef<SVGGElement>(null);
  const satRef = useRef<SVGCircleElement>(null);
  const satHaloRef = useRef<SVGCircleElement>(null);
  const wordRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const titleLayerRef = useRef<HTMLDivElement>(null);
  const titleBlockRef = useRef<HTMLDivElement>(null);
  const kickerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const taglineRef = useRef<HTMLParagraphElement>(null);
  const sweepRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const cssBloomRef = useRef<HTMLDivElement>(null);
  const cssPlanetRef = useRef<HTMLDivElement>(null);

  const [fallback, setFallback] = useState(false);
  const doneRef = useRef(false);
  const audioRef = useRef<IntroAudioHandle | null>(null);
  const mutedRef = useRef(muted);
  const onCompleteRef = useRef(onComplete);
  const phaseIndexRef = useRef(-1);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    audioRef.current?.stop();
    onCompleteRef.current();
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const startTime = performance.now();
    let pausedTotal = 0;
    // If the tab is already hidden at mount, start the pause clock immediately;
    // otherwise the first visible frame would jump straight to the end.
    let hidden = document.hidden;
    let pauseStart = hidden ? performance.now() : 0;
    let raf = 0;
    let disposed = false;

    function elapsed(): number {
      const now = performance.now();
      const paused = hidden ? now - pauseStart : 0;
      return Math.max(0, (now - startTime - pausedTotal - paused) / 1000);
    }

    /* ------------------------------------------------------------- audio */
    const audio = createIntroAudio({
      muted: mutedRef.current,
      reducedMotion: false,
      getElapsed: elapsed,
    });
    audioRef.current = audio;
    audio.start();

    /* ------------------------------------------------------------- WebGL */
    const disposables: Array<{ dispose(): void }> = [];
    let renderer: THREE.WebGLRenderer | null = null;
    let scene: THREE.Scene | null = null;
    let camera: THREE.PerspectiveCamera | null = null;
    let state: SceneState | null = null;
    let contextLost = false;
    let canvas: HTMLCanvasElement | null = null;
    // kept in scope so cleanup can detach it: renderer.forceContextLoss() in the
    // cleanup fires this asynchronously, and a late call would otherwise mount the
    // CSS fallback on top of a perfectly healthy canvas (StrictMode remount).
    let onContextLost: ((event: Event) => void) | null = null;

    try {
      canvas = document.createElement("canvas");
      canvas.className = "fw-canvas";
      canvas.setAttribute("aria-hidden", "true");
      stage.appendChild(canvas);
      renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: (window.devicePixelRatio || 1) < 1.5,
        powerPreference: "high-performance",
        stencil: false,
      });
      renderer.setClearColor(0x000000, 0);
      const dpr = Math.min(window.devicePixelRatio || 1, window.innerWidth < 700 ? 1.4 : 1.75);
      renderer.setPixelRatio(dpr);
      renderer.setSize(window.innerWidth, window.innerHeight, false);

      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 140);
      camera.position.set(0, 0, 6.8);
      state = buildScene(scene, (d) => disposables.push(d));

      onContextLost = (event) => {
        event.preventDefault();
        if (disposed) return;
        contextLost = true;
        setFallback(true);
        // the CSS cosmos takes over; drop the dead canvas so the two never stack
        if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      };
      canvas.addEventListener("webglcontextlost", onContextLost);
      // a previous (discarded) mount may have left the flag set
      setFallback(false);
    } catch {
      renderer = null;
      scene = null;
      camera = null;
      state = null;
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      canvas = null;
      setFallback(true);
    }

    /* ---------------------------------------------------- pointer parallax */
    let pointerX = 0;
    let pointerY = 0;
    let targetX = 0;
    let targetY = 0;
    const finePointer = window.matchMedia("(pointer: fine)").matches;
    const onPointerMove = (event: PointerEvent) => {
      if (!finePointer) return;
      targetX = (event.clientX / window.innerWidth) * 2 - 1;
      targetY = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onPointerMove, { passive: true });

    /* ------------------------------------------------------- DOM painting */
    const paintDom = (t: number) => {
      /* --- logo lockup ------------------------------------------------- */
      const logoIn = seg(t, 2.0, 3.35);
      const logoOut = seg(t, 4.85, 5.7);
      const logoEase = easeOut(logoIn);
      const logoLayer = logoLayerRef.current;
      if (logoLayer) {
        logoLayer.style.opacity = String(logoEase * (1 - easeIn(logoOut)));
        logoLayer.style.transform =
          `translate3d(0, ${((1 - logoEase) * 18 - logoOut * 16).toFixed(2)}px, 0) ` +
          `scale(${(0.94 + 0.06 * logoEase + 0.1 * logoOut).toFixed(4)})`;
      }

      const glow = markGlowRef.current;
      if (glow) {
        const glowIn = seg(t, 2.5, 4.0);
        glow.style.opacity = String(
          0.52 * glowIn * (0.82 + 0.18 * Math.sin(t * 2.1)) * (1 - logoOut),
        );
        glow.style.transform = `scale(${(0.85 + 0.3 * seg(t, 2.4, 4.3)).toFixed(3)})`;
      }

      const ringDraw = easeOut(seg(t, 2.15, 3.15));
      if (ringRef.current) ringRef.current.style.strokeDashoffset = (1 - ringDraw).toFixed(4);

      const orbitDraw = easeOut(seg(t, 2.5, 3.55));
      if (orbitRef.current) orbitRef.current.style.strokeDashoffset = (1 - orbitDraw).toFixed(4);

      const coreP = easeOut(seg(t, 2.95, 3.6));
      if (coreRef.current) {
        coreRef.current.style.opacity = String(coreP);
        const scale = 0.8 + 0.2 * coreP;
        coreRef.current.setAttribute(
          "transform",
          `translate(20 20) scale(${scale.toFixed(3)}) translate(-20 -20)`,
        );
      }
      if (innerRef.current) innerRef.current.style.opacity = String(seg(t, 3.15, 3.75));
      if (ticksRef.current) ticksRef.current.style.opacity = String(0.55 * seg(t, 3.0, 4.15));

      const satP = seg(t, 3.05, 3.7);
      if (satRef.current && satHaloRef.current) {
        const angle = 0.18 + Math.max(0, t - 3.05) * 0.34;
        const rx = 15.12;
        const ry = 5.9;
        const ex = 20 + rx * Math.cos(angle);
        const ey = 20 + ry * Math.sin(angle);
        const rot = (-28 * Math.PI) / 180;
        const dx = ex - 20;
        const dy = ey - 20;
        const cx = 20 + dx * Math.cos(rot) - dy * Math.sin(rot);
        const cy = 20 + dx * Math.sin(rot) + dy * Math.cos(rot);
        for (const el of [satRef.current, satHaloRef.current]) {
          el.setAttribute("cx", cx.toFixed(2));
          el.setAttribute("cy", cy.toFixed(2));
          el.style.opacity = String(satP);
        }
      }

      const word = wordRef.current;
      if (word) {
        const wp = easeOut(seg(t, 2.8, 3.7));
        const tracking = mix(0.62, 0.3, easeOut(seg(t, 2.8, 4.5)));
        word.style.opacity = String(wp * (1 - logoOut * 0.9));
        word.style.letterSpacing = `${tracking.toFixed(3)}em`;
        word.style.marginRight = `-${tracking.toFixed(3)}em`;
        word.style.transform = `translate3d(0, ${((1 - wp) * 16).toFixed(2)}px, 0)`;
      }

      const sub = subRef.current;
      if (sub) {
        const sp = easeOut(seg(t, 3.35, 4.2));
        sub.style.opacity = String(sp * 0.92 * (1 - logoOut * 0.9));
        sub.style.transform = `translate3d(0, ${((1 - sp) * 10).toFixed(2)}px, 0)`;
        sub.style.letterSpacing = `${mix(0.5, 0.34, sp).toFixed(3)}em`;
      }

      /* --- title ------------------------------------------------------- */
      const scrim = scrimRef.current;
      if (scrim) {
        // keeps the type legible wherever the planet happens to sit behind it
        scrim.style.opacity = String(0.92 * easeOut(seg(t, 6.35, 7.7)));
      }

      const blockP = easeOut(seg(t, 6.5, 7.6));
      if (titleBlockRef.current) {
        titleBlockRef.current.style.transform =
          `translate3d(0, ${(56 + (1 - blockP) * 26).toFixed(2)}px, 0) scale(${(0.985 + 0.015 * blockP).toFixed(4)})`;
      }

      if (kickerRef.current) {
        kickerRef.current.style.opacity = String(easeOut(seg(t, 6.42, 7.12)));
        kickerRef.current.style.transform = `translate3d(0, ${((1 - easeOut(seg(t, 6.42, 7.12))) * 8).toFixed(2)}px, 0)`;
      }

      const title = titleRef.current;
      if (title) {
        const tp = easeOut(seg(t, 6.55, 7.6));
        title.style.opacity = String(tp);
        title.style.letterSpacing = `${mix(0.15, -0.02, easeOut(seg(t, 6.55, 8.1))).toFixed(4)}em`;
        title.style.filter = tp < 0.999 ? `blur(${((1 - tp) * 6).toFixed(2)}px)` : "none";
      }

      const line = lineRef.current;
      if (line) {
        const lp = easeOut(seg(t, 7.2, 8.25));
        line.style.opacity = String(seg(t, 7.12, 7.5));
        line.style.transform = `scaleX(${lp.toFixed(4)})`;
      }

      const tagline = taglineRef.current;
      if (tagline) {
        const gp = easeOut(seg(t, 7.3, 8.3));
        tagline.style.opacity = String(gp * 0.86);
        tagline.style.transform = `translate3d(0, ${((1 - gp) * 12).toFixed(2)}px, 0)`;
      }

      const sweep = sweepRef.current;
      if (sweep) {
        const sp = seg(t, 7.45, 8.65);
        sweep.style.opacity = String(Math.sin(Math.PI * sp) * 0.95);
        sweep.style.transform = `translate3d(${mix(-70, 210, sp).toFixed(2)}%, 0, 0)`;
      }

      /* --- HUD / chrome ------------------------------------------------ */
      if (hudRef.current) hudRef.current.style.opacity = String(easeOut(seg(t, 0.5, 1.7)));

      const phaseIndex = t < 2.0 ? 0 : t < 4.8 ? 1 : t < 6.45 ? 2 : 3;
      if (phaseRef.current && phaseIndexRef.current !== phaseIndex) {
        phaseIndexRef.current = phaseIndex;
        phaseRef.current.textContent = PHASES[phaseIndex];
      }

      if (progressRef.current) {
        progressRef.current.style.transform = `scaleX(${clamp01(t / DURATION).toFixed(4)})`;
      }

      /* --- CSS fallback cosmos ---------------------------------------- */
      if (cssBloomRef.current) {
        const inP = seg(t, 0.3, 2.4);
        cssBloomRef.current.style.opacity = String(0.85 * inP * (1 - seg(t, 4.6, 6.2)));
        cssBloomRef.current.style.transform = `scale(${(0.55 + 0.6 * inP).toFixed(3)})`;
      }
      if (cssPlanetRef.current) {
        const ep = seg(t, 4.7, 6.6);
        cssPlanetRef.current.style.opacity = String(easeOut(ep));
        cssPlanetRef.current.style.transform = `scale(${mix(0.72, 1, easeOut(ep)).toFixed(4)})`;
      }

      /* --- cut to and from the app ------------------------------------ */
      if (veilRef.current) {
        const intro = 1 - seg(t, 0, 0.75);
        const outro = easeIn(seg(t, 9.9, 10.5));
        veilRef.current.style.opacity = Math.max(intro, outro).toFixed(3);
      }
    };

    /* ------------------------------------------------------ scene painting */
    const paintScene = (t: number, s: SceneState, cam: THREE.PerspectiveCamera) => {
      const push = easeIn(seg(t, 4.7, 9.7));

      pointerX += (targetX - pointerX) * 0.045;
      pointerY += (targetY - pointerY) * 0.045;

      cam.position.x = mix(pointerX * 0.2, pointerX * 0.07, push) + Math.sin(t * 0.21) * 0.05;
      cam.position.y = mix(-pointerY * 0.13, -pointerY * 0.05, push) + Math.cos(t * 0.17) * 0.035;
      cam.position.z = mix(6.8, 3.35, push);
      cam.lookAt(0, 0, 0);

      s.u.starTime.value = t;
      s.u.starOpacity.value = 0.9 * (1 - 0.55 * seg(t, 4.9, 6.6));

      s.u.bloomTime.value = t;
      s.u.bloomIntensity.value =
        seg(t, 0.35, 2.5) * (0.3 + 0.26 * seg(t, 2.1, 3.2)) * (1 - seg(t, 4.85, 5.9));

      const earthP = seg(t, 4.75, 6.6);
      const earthOn = earthP > 0.002;
      s.u.earthTime.value = t;
      s.u.earthOpacity.value = earthOn ? easeOut(earthP) : 0;
      s.u.ringOpacity.value = easeOut(seg(t, 5.15, 6.9));
      s.u.sparkOpacity.value = easeOut(seg(t, 5.35, 6.7));

      s.planet.visible = earthOn;
      s.earth.visible = earthOn && !s.earthTexMat.map;
      s.earthTexMat.opacity = s.u.earthOpacity.value;
      s.clouds.visible = earthOn && !!s.cloudMat.alphaMap;
      s.cloudMat.opacity = s.u.earthOpacity.value * 0.66;
      s.clouds.rotation.y = 0.9 + Math.max(0, t - 4.7) * 0.021;
      s.atmosphere.visible = earthOn;
      s.sparks.visible = t > 5.3;
      s.ringMats.forEach(({ material, base }) => {
        material.visible = t > 5.1;
        material.opacity = base * s.u.ringOpacity.value;
      });

      // the planet rises as the title lands, so the type sits over the dark lower limb
      s.planet.position.y = 0.52 * easeOut(seg(t, 6.3, 8.8));

      s.planet.rotation.y = 0.45 + Math.max(0, t - 4.7) * 0.05;
      s.planet.rotation.z = -0.12;
      s.planet.rotation.x = -0.05 + Math.sin(t * 0.13) * 0.01;

      const bloomMaterial = s.bloom.material as THREE.ShaderMaterial;
      bloomMaterial.uniforms.uAspect.value = cam.aspect;
      const starMaterial = s.stars.material as THREE.ShaderMaterial;
      starMaterial.uniforms.uPixel.value = renderer ? renderer.getPixelRatio() : 1;
      const sparkMaterial = s.sparks.material as THREE.ShaderMaterial;
      sparkMaterial.uniforms.uPixel.value = renderer ? renderer.getPixelRatio() : 1;
    };

    /* ------------------------------------------------------------- events */
    const loop = () => {
      if (disposed) return;
      const t = elapsed();
      paintDom(t);

      if (renderer && scene && camera && state && !contextLost) {
        paintScene(t, state, camera);
        renderer.render(scene, camera);
      }

      if (t >= DURATION) {
        finish();
        return;
      }
      raf = requestAnimationFrame(loop);
    };

    const onVisibility = () => {
      const now = performance.now();
      if (document.hidden) {
        if (!hidden) {
          hidden = true;
          pauseStart = now;
          if (raf) cancelAnimationFrame(raf);
          raf = 0;
        }
      } else if (hidden) {
        hidden = false;
        pausedTotal += now - pauseStart;
        if (!raf && !disposed) raf = requestAnimationFrame(loop);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const onResize = () => {
      if (!renderer || !camera) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, w < 700 ? 1.4 : 1.75);
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (state) {
        (state.bloom.material as THREE.ShaderMaterial).uniforms.uAspect.value = w / h;
      }
    };
    window.addEventListener("resize", onResize);

    const unlockAudio = () => audio.resume();
    const onKeyDown = (event: KeyboardEvent) => {
      unlockAudio();
      if (event.key === "Escape") finish();
    };
    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("touchstart", unlockAudio, { passive: true });
    window.addEventListener("keydown", onKeyDown);

    paintDom(0);
    raf = requestAnimationFrame(loop);

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("touchstart", unlockAudio);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("visibilitychange", onVisibility);

      audio.stop();
      audio.dispose();
      if (audioRef.current === audio) audioRef.current = null;

      for (const disposable of disposables) {
        try {
          disposable.dispose();
        } catch {
          /* noop */
        }
      }
      disposables.length = 0;

      if (canvas && onContextLost) {
        canvas.removeEventListener("webglcontextlost", onContextLost);
      }
      onContextLost = null;

      if (renderer) {
        try {
          renderer.dispose();
        } catch {
          /* noop */
        }
        try {
          renderer.forceContextLoss();
        } catch {
          /* noop */
        }
      }
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      if (scene) {
        scene.clear();
      }
      renderer = null;
      scene = null;
      camera = null;
      state = null;
      canvas = null;
    };
  }, [finish]);

  useEffect(() => {
    mutedRef.current = muted;
    audioRef.current?.setMuted(muted);
  }, [muted]);

  return (
    <div
      className="fw-intro"
      role="dialog"
      aria-modal="true"
      aria-label="FIREWATCH — LH Studios. See the patterns. Understand the fires. Protect the future."
    >
      <div ref={stageRef} className="fw-stage" aria-hidden="true" />

      {fallback ? (
        <div className="fw-css-cosmos" aria-hidden="true">
          <div ref={cssBloomRef} className="fw-css-bloom" />
          <div ref={cssPlanetRef} className="fw-css-planet">
            <div className="fw-css-ring fw-css-ring-b" />
            <div className="fw-css-ring" />
            <div className="fw-css-planet-core" />
            <div className="fw-css-rim" />
          </div>
        </div>
      ) : null}

      <div className="fw-vignette" aria-hidden="true" />
      <div className="fw-grain" aria-hidden="true" />

      {/* ---------------- beat 2: LH STUDIOS ---------------- */}
      <div ref={logoLayerRef} className="fw-layer" style={{ opacity: 0 }} aria-hidden="true">
        <div className="fw-lockup">
          <img
            className="fw-trio"
            src="/brand/lh-trio.png"
            alt=""
            draggable={false}
            aria-hidden="true"
          />
          <div className="fw-mark-wrap">
            <div ref={markGlowRef} className="fw-mark-glow" style={{ opacity: 0 }} />
            <BrandGlyph
              ringRef={ringRef}
              orbitRef={orbitRef}
              coreRef={coreRef}
              innerRef={innerRef}
              ticksRef={ticksRef}
              satRef={satRef}
              satHaloRef={satHaloRef}
            />
          </div>
          <div ref={wordRef} className="fw-wordmark" style={{ opacity: 0 }}>
            LH Studios
          </div>
          <div ref={subRef} className="fw-sublabel" style={{ opacity: 0 }}>
            Earth observation <em>·</em> Thermal intelligence
          </div>
        </div>
      </div>

      {/* ---------------- beat 4: FIREWATCH ---------------- */}
      <div ref={titleLayerRef} className="fw-layer" aria-hidden="false">
        <div ref={scrimRef} className="fw-scrim" aria-hidden="true" />
        <div ref={sweepRef} className="fw-sweep" aria-hidden="true" />
        <div ref={titleBlockRef} className="fw-title-block">
          <div ref={kickerRef} className="fw-title-kicker" style={{ opacity: 0 }}>
            Satellite fire intelligence
          </div>
          <h1 ref={titleRef} className="fw-hero" style={{ opacity: 0 }}>
            Firewatch
          </h1>
          <div ref={lineRef} className="fw-accent-line" />
          <p ref={taglineRef} className="fw-tagline" style={{ opacity: 0 }}>
            See the patterns. Understand the fires. Protect the future.
          </p>
        </div>
      </div>

      {/* ---------------- chrome ---------------- */}
      <div className="fw-progress" aria-hidden="true">
        <div ref={progressRef} className="fw-progress-bar" />
      </div>

      <div ref={hudRef} className="fw-hud" style={{ opacity: 0 }}>
        <div className="fw-hud-left">
          <div className="fw-microcopy">LH Studios · Earth observation</div>
          <div className="fw-microcopy fw-microcopy-dim">Firewatch — 2026</div>
        </div>
        <div className="fw-hud-center" aria-hidden="true">
          <span ref={phaseRef} className="fw-phase">
            Signal acquired
          </span>
        </div>
        <div className="fw-controls">
          <MuteButton muted={muted} onToggleMute={onToggleMute} />
          <button type="button" className="fw-btn fw-btn-primary" onClick={finish}>
            <span className="fw-btn-label">Skip intro</span>
            <span className="fw-btn-arrow" aria-hidden="true">
              →
            </span>
          </button>
        </div>
      </div>

      <div ref={veilRef} className="fw-veil" style={{ opacity: 1 }} aria-hidden="true" />
    </div>
  );
}

/* ---------------------------------------------------------------- pieces */

function MuteButton({ muted, onToggleMute }: { muted: boolean; onToggleMute: () => void }) {
  return (
    <button
      type="button"
      className="fw-btn"
      onClick={onToggleMute}
      aria-pressed={!muted}
      aria-label={
        muted ? "Intro soundtrack is off — turn sound on" : "Intro soundtrack is on — mute sound"
      }
    >
      {muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
      <span className="fw-btn-label">{muted ? "Sound off" : "Sound on"}</span>
    </button>
  );
}

interface GlyphRefs {
  ringRef?: RefObject<SVGCircleElement | null>;
  orbitRef?: RefObject<SVGEllipseElement | null>;
  coreRef?: RefObject<SVGPathElement | null>;
  innerRef?: RefObject<SVGPathElement | null>;
  ticksRef?: RefObject<SVGGElement | null>;
  satRef?: RefObject<SVGCircleElement | null>;
  satHaloRef?: RefObject<SVGCircleElement | null>;
}

/**
 * Original LH Studios mark: an orbital ring, a -28° instrument orbit carrying a
 * satellite, and an ember teardrop core. Built to be drawn stroke-by-stroke.
 */
function BrandGlyph({
  ringRef,
  orbitRef,
  coreRef,
  innerRef,
  ticksRef,
  satRef,
  satHaloRef,
}: GlyphRefs) {
  return (
    <svg className="fw-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="fw-intro-ring" x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
          <stop stopColor="#B7EDFF" />
          <stop offset="0.45" stopColor="#39C8F2" />
          <stop offset="1" stopColor="#39C8F2" stopOpacity="0.16" />
        </linearGradient>
        <radialGradient id="fw-intro-core" cx="0.42" cy="0.3" r="0.78">
          <stop stopColor="#FFE3BC" />
          <stop offset="0.42" stopColor="#FF9D42" />
          <stop offset="1" stopColor="#FF633D" />
        </radialGradient>
      </defs>

      <circle
        ref={ringRef}
        cx="20"
        cy="20"
        r="15.6"
        pathLength={1}
        stroke="url(#fw-intro-ring)"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeDasharray="1"
        strokeDashoffset={1}
      />

      <ellipse
        ref={orbitRef}
        cx="20"
        cy="20"
        rx="15.12"
        ry="5.9"
        pathLength={1}
        transform="rotate(-28 20 20)"
        stroke="#39C8F2"
        strokeOpacity="0.55"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeDasharray="1"
        strokeDashoffset={1}
      />

      <g ref={ticksRef} stroke="#39C8F2" strokeOpacity="0.4" strokeWidth="0.7" style={{ opacity: 0 }}>
        <path d="M20 2.6v1.8" />
        <path d="M20 35.6v1.8" />
        <path d="M2.6 20h1.8" />
        <path d="M35.6 20h1.8" />
      </g>

      <path
        ref={coreRef}
        d="M20 12.1c3.5 3.4 5.4 6.6 5.4 9.7a5.4 5.4 0 1 1-10.8 0c0-3.1 1.9-6.3 5.4-9.7Z"
        fill="url(#fw-intro-core)"
        transform="translate(20 20) scale(0.8) translate(-20 -20)"
        style={{ opacity: 0 }}
      />
      <path
        ref={innerRef}
        d="M20 20.4c1.7 1.8 2.5 3.2 2.5 4.5a2.5 2.5 0 1 1-5 0c0-1.3.8-2.7 2.5-4.5Z"
        fill="#0B1220"
        fillOpacity="0.5"
        style={{ opacity: 0 }}
      />

      <circle ref={satHaloRef} cx="31.4" cy="12.2" r="3.5" stroke="#39C8F2" strokeOpacity="0.45" strokeWidth="0.8" style={{ opacity: 0 }} />
      <circle ref={satRef} cx="31.4" cy="12.2" r="1.85" fill="#EAF9FF" style={{ opacity: 0 }} />
    </svg>
  );
}
