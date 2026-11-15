/**
 * FIREWATCH — original cinematic sound design, synthesised at runtime.
 *
 * Nothing is loaded from disk: every voice is an oscillator or procedurally
 * generated pink/brown noise inside a single WebAudio graph. Peak output is
 * deliberately modest (0.12 linear before the compressor) so the opening can
 * never startle a user who left their volume up.
 *
 * Score (aligned to the 10.6 s picture timeline)
 *   0.00  noise bed + 27.5/55/82.4/110 Hz sub drone swell in from silence
 *   1.40  airy band-passed riser climbs into the logo hit
 *   2.95  logo impact — sub-boom (76 → 33 Hz) + filtered noise crack
 *   3.90  drone settles, bed opens slightly
 *   5.05  earth shimmer — five high partials + air noise through a band-pass
 *   6.55  title bloom — soft 220/330 Hz pad under the wordmark
 *   8.70  low pedal tail
 *   9.95  master fade to silence as the picture fades to the app
 *
 * Browsers block an AudioContext created without a gesture, so the handle
 * defers scheduling until the context is running and re-aligns the remaining
 * cues against the picture (passed in through `getElapsed`).
 */

export interface IntroAudioOptions {
  muted: boolean;
  reducedMotion?: boolean;
  /** Elapsed picture time in seconds — lets late audio unlocks land on-beat. */
  getElapsed?: () => number;
}

export interface IntroAudioHandle {
  start(): void;
  setMuted(muted: boolean): void;
  resume(): void;
  stop(): void;
  dispose(): void;
}

const PEAK = 0.12;
const REDUCED_PEAK = 0.075;
const PICTURE_END = 10.6;
const REDUCED_END = 2.2;

type AudioCtor = typeof AudioContext;

function getAudioCtor(): AudioCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

const NOOP: IntroAudioHandle = {
  start() {},
  setMuted() {},
  resume() {},
  stop() {},
  dispose() {},
};

/** Pink-ish noise with a brown rumble floor, cross-faded so the loop has no click. */
function makeNoiseBuffer(ctx: AudioContext, seconds = 3): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buffer = ctx.createBuffer(1, len, rate);
  const data = buffer.getChannelData(0);

  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let brown = 0;

  for (let i = 0; i < len; i += 1) {
    const white = Math.random() * 2 - 1;
    // Paul Kellet's economical pink filter.
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    const pink = (b0 + b1 + b2 + white * 0.1848) * 0.22;
    brown = (brown + pink * 0.02) / 1.02;
    data[i] = Math.max(-1, Math.min(1, pink * 0.62 + brown * 2.4));
  }

  // Seam smoothing: blend the tail into the head so the loop point is silent.
  const fade = Math.min(Math.floor(rate * 0.06), Math.floor(len / 4));
  for (let i = 0; i < fade; i += 1) {
    const k = i / fade;
    data[i] = data[i] * k + data[len - fade + i] * (1 - k);
  }
  return buffer;
}

export function createIntroAudio(opts: IntroAudioOptions): IntroAudioHandle {
  const Ctor = getAudioCtor();
  if (!Ctor) return NOOP;

  let ctx: AudioContext;
  try {
    ctx = new Ctor({ latencyHint: "interactive" });
  } catch {
    return NOOP;
  }

  const reduced = Boolean(opts.reducedMotion);
  const peak = reduced ? REDUCED_PEAK : PEAK;
  const pictureEnd = reduced ? REDUCED_END : PICTURE_END;
  const getElapsed = opts.getElapsed ?? (() => 0);

  const graph: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];

  const keep = <T extends AudioNode>(node: T): T => {
    graph.push(node);
    return node;
  };
  const voice = <T extends AudioScheduledSourceNode>(node: T): T => {
    sources.push(node);
    return node;
  };

  // master = the intro's own envelope, mute = the user's switch, limiter protects.
  const master = keep(ctx.createGain());
  const mute = keep(ctx.createGain());
  const limiter = keep(ctx.createDynamicsCompressor());
  limiter.threshold.value = -16;
  limiter.knee.value = 8;
  limiter.ratio.value = 3.5;
  limiter.attack.value = 0.006;
  limiter.release.value = 0.28;

  master.gain.value = 0.0001;
  mute.gain.value = opts.muted ? 0.0001 : 1;
  master.connect(mute);
  mute.connect(limiter);
  limiter.connect(ctx.destination);

  const noise = makeNoiseBuffer(ctx, 3);

  let scheduled = false;
  let muted = opts.muted;
  let disposed = false;
  let fadeTimer = 0;

  const noiseSource = (): AudioBufferSourceNode => {
    const node = voice(ctx.createBufferSource());
    node.buffer = noise;
    node.loop = true;
    return node;
  };

  /** Builds the whole score. `t0` is the first audible sample, `elapsed` the picture time. */
  const build = (t0: number, elapsed: number) => {
    const at = (cue: number) => t0 + Math.max(0, cue - elapsed);
    const ahead = (cue: number) => cue > elapsed + 0.12;
    const endAt = t0 + Math.max(0.25, pictureEnd - elapsed);

    // ---- master envelope: long fade in, fade out with the picture
    master.gain.cancelScheduledValues(t0);
    master.gain.setValueAtTime(0.0001, t0);
    master.gain.exponentialRampToValueAtTime(peak, t0 + (reduced ? 0.28 : 1.1));
    const fadeStart = Math.max(t0 + 0.3, endAt - (reduced ? 0.35 : 0.55));
    master.gain.setValueAtTime(peak, fadeStart);
    master.gain.exponentialRampToValueAtTime(0.0001, endAt);

    // ---- 1. noise bed ------------------------------------------------------
    const bedFilter = keep(ctx.createBiquadFilter());
    bedFilter.type = "lowpass";
    bedFilter.frequency.value = reduced ? 700 : 430;
    bedFilter.Q.value = 0.7;
    const bedGain = keep(ctx.createGain());
    bedGain.gain.setValueAtTime(0.0001, t0);
    bedGain.gain.exponentialRampToValueAtTime(reduced ? 0.16 : 0.24, t0 + (reduced ? 0.5 : 2.6));
    if (!reduced) {
      bedGain.gain.linearRampToValueAtTime(0.27, Math.min(fadeStart, at(5.4)));
      bedGain.gain.linearRampToValueAtTime(0.2, fadeStart);
    }
    const bed = noiseSource();
    bed.connect(bedFilter);
    bedFilter.connect(bedGain);
    bedGain.connect(master);
    bed.start(t0);
    bed.stop(endAt + 0.1);

    // slow filter drift so the bed breathes
    const bedLfo = voice(ctx.createOscillator());
    bedLfo.type = "sine";
    bedLfo.frequency.value = 0.055;
    const bedLfoGain = keep(ctx.createGain());
    bedLfoGain.gain.value = 120;
    bedLfo.connect(bedLfoGain);
    bedLfoGain.connect(bedFilter.frequency);
    bedLfo.start(t0);
    bedLfo.stop(endAt + 0.1);

    // ---- 2. sub drone ------------------------------------------------------
    const droneGain = keep(ctx.createGain());
    droneGain.gain.setValueAtTime(0.0001, t0);
    droneGain.gain.exponentialRampToValueAtTime(reduced ? 0.14 : 0.19, t0 + (reduced ? 0.3 : 2.8));
    if (!reduced) {
      droneGain.gain.linearRampToValueAtTime(0.23, Math.min(fadeStart, at(5.6)));
      droneGain.gain.linearRampToValueAtTime(0.25, Math.min(fadeStart, at(7.2)));
      droneGain.gain.linearRampToValueAtTime(0.19, fadeStart);
    }
    const droneFilter = keep(ctx.createBiquadFilter());
    droneFilter.type = "lowpass";
    droneFilter.frequency.value = 270;
    droneFilter.Q.value = 0.9;
    droneFilter.connect(droneGain);
    droneGain.connect(master);

    const partials: Array<[number, OscillatorType, number, number]> = [
      [27.5, "sine", 0.34, 0],
      [55, "sine", 0.5, 0],
      [82.407, "sine", 0.26, 4],
      [110, "triangle", 0.16, -7],
    ];
    for (const [freq, type, level, detune] of partials) {
      const osc = voice(ctx.createOscillator());
      osc.type = type;
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const gain = keep(ctx.createGain());
      gain.gain.value = level;
      osc.connect(gain);
      gain.connect(droneFilter);
      osc.start(t0);
      osc.stop(endAt + 0.1);
    }

    if (reduced) {
      // A single soft pad instead of the full score, and nothing percussive.
      const pad = voice(ctx.createOscillator());
      pad.type = "sine";
      pad.frequency.value = 220;
      const padGain = keep(ctx.createGain());
      padGain.gain.setValueAtTime(0.0001, t0 + 0.05);
      padGain.gain.exponentialRampToValueAtTime(0.05, t0 + 0.55);
      padGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.75);
      pad.connect(padGain);
      padGain.connect(master);
      pad.start(t0 + 0.05);
      pad.stop(t0 + 1.9);
      return;
    }

    // ---- 3. riser into the logo hit ---------------------------------------
    if (ahead(1.35)) {
      const start = at(1.35);
      const dur = Math.min(1.6, Math.max(0.2, at(2.95) - start));
      const riserFilter = keep(ctx.createBiquadFilter());
      riserFilter.type = "bandpass";
      riserFilter.Q.value = 1.4;
      riserFilter.frequency.setValueAtTime(240, start);
      riserFilter.frequency.exponentialRampToValueAtTime(2600, start + dur);
      const riserGain = keep(ctx.createGain());
      riserGain.gain.setValueAtTime(0.0001, start);
      riserGain.gain.exponentialRampToValueAtTime(0.12, start + dur * 0.82);
      riserGain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      const riser = noiseSource();
      riser.connect(riserFilter);
      riserFilter.connect(riserGain);
      riserGain.connect(master);
      riser.start(start);
      riser.stop(start + dur + 0.05);
    }

    // ---- 4. logo impact: sub-boom + noise crack ---------------------------
    if (ahead(2.95)) {
      const hit = at(2.95);
      const sub = voice(ctx.createOscillator());
      sub.type = "sine";
      sub.frequency.setValueAtTime(76, hit);
      sub.frequency.exponentialRampToValueAtTime(33, hit + 1.55);
      const subGain = keep(ctx.createGain());
      subGain.gain.setValueAtTime(0.0001, hit);
      subGain.gain.exponentialRampToValueAtTime(0.6, hit + 0.022);
      subGain.gain.exponentialRampToValueAtTime(0.0001, hit + 1.75);
      sub.connect(subGain);
      subGain.connect(master);
      sub.start(hit);
      sub.stop(hit + 1.9);

      const crackFilter = keep(ctx.createBiquadFilter());
      crackFilter.type = "bandpass";
      crackFilter.frequency.value = 190;
      crackFilter.Q.value = 1.1;
      const crackGain = keep(ctx.createGain());
      crackGain.gain.setValueAtTime(0.0001, hit);
      crackGain.gain.exponentialRampToValueAtTime(0.24, hit + 0.014);
      crackGain.gain.exponentialRampToValueAtTime(0.0001, hit + 0.62);
      const crack = noiseSource();
      crack.connect(crackFilter);
      crackFilter.connect(crackGain);
      crackGain.connect(master);
      crack.start(hit);
      crack.stop(hit + 0.7);
    }

    // ---- 5. earth shimmer -------------------------------------------------
    if (ahead(5.05)) {
      const shimmerAt = at(5.05);
      const tones: Array<[number, number]> = [
        [1046.5, 0.05],
        [1568, 0.042],
        [2093, 0.032],
        [2637, 0.024],
        [3136, 0.016],
      ];
      const airLift = keep(ctx.createBiquadFilter());
      airLift.type = "highpass";
      airLift.frequency.value = 620;
      const shimmerBus = keep(ctx.createGain());
      shimmerBus.gain.value = 0.9;
      airLift.connect(shimmerBus);
      shimmerBus.connect(master);

      tones.forEach(([freq, level], index) => {
        const osc = voice(ctx.createOscillator());
        osc.type = index % 2 === 0 ? "sine" : "triangle";
        osc.frequency.value = freq;
        osc.detune.value = index * 2 - 4;
        const gain = keep(ctx.createGain());
        gain.gain.setValueAtTime(0.0001, shimmerAt);
        gain.gain.exponentialRampToValueAtTime(level, shimmerAt + 0.9 + index * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.0001, shimmerAt + 3.1);
        osc.connect(gain);
        gain.connect(airLift);
        osc.start(shimmerAt);
        osc.stop(shimmerAt + 3.3);
      });

      const airFilter = keep(ctx.createBiquadFilter());
      airFilter.type = "bandpass";
      airFilter.frequency.value = 3800;
      airFilter.Q.value = 0.6;
      const airGain = keep(ctx.createGain());
      airGain.gain.setValueAtTime(0.0001, shimmerAt);
      airGain.gain.exponentialRampToValueAtTime(0.055, shimmerAt + 1.1);
      airGain.gain.exponentialRampToValueAtTime(0.0001, shimmerAt + 2.9);
      const air = noiseSource();
      air.connect(airFilter);
      airFilter.connect(airGain);
      airGain.connect(master);
      air.start(shimmerAt);
      air.stop(shimmerAt + 3.1);
    }

    // ---- 6. title bloom ---------------------------------------------------
    if (ahead(6.55)) {
      const bloomAt = at(6.55);
      const padFilter = keep(ctx.createBiquadFilter());
      padFilter.type = "lowpass";
      padFilter.frequency.value = 900;
      padFilter.Q.value = 0.6;
      const padBus = keep(ctx.createGain());
      padBus.gain.value = 0.85;
      padFilter.connect(padBus);
      padBus.connect(master);

      const notes: Array<[number, number, number]> = [
        [220, 0.055, 0],
        [330, 0.038, 0.16],
        [440, 0.022, 0.3],
      ];
      notes.forEach(([freq, level, offset]) => {
        const osc = voice(ctx.createOscillator());
        osc.type = "sine";
        osc.frequency.value = freq;
        osc.detune.value = 3;
        const gain = keep(ctx.createGain());
        gain.gain.setValueAtTime(0.0001, bloomAt + offset);
        gain.gain.exponentialRampToValueAtTime(level, bloomAt + offset + 0.55);
        gain.gain.exponentialRampToValueAtTime(0.0001, bloomAt + offset + 2.6);
        osc.connect(gain);
        gain.connect(padFilter);
        osc.start(bloomAt + offset);
        osc.stop(bloomAt + offset + 2.75);
      });
    }

    // ---- 7. tail pedal ----------------------------------------------------
    if (ahead(8.7)) {
      const tailAt = at(8.7);
      const tailFilter = keep(ctx.createBiquadFilter());
      tailFilter.type = "lowpass";
      tailFilter.frequency.value = 520;
      const tailBus = keep(ctx.createGain());
      tailBus.gain.value = 0.9;
      tailFilter.connect(tailBus);
      tailBus.connect(master);

      const notes: Array<[number, number]> = [
        [91.7, 0.06],
        [137.5, 0.035],
      ];
      notes.forEach(([freq, level]) => {
        const osc = voice(ctx.createOscillator());
        osc.type = "sine";
        osc.frequency.value = freq;
        const gain = keep(ctx.createGain());
        gain.gain.setValueAtTime(0.0001, tailAt);
        gain.gain.exponentialRampToValueAtTime(level, tailAt + 0.75);
        gain.gain.exponentialRampToValueAtTime(0.0001, Math.min(fadeStart + 0.2, endAt));
        osc.connect(gain);
        gain.connect(tailFilter);
        osc.start(tailAt);
        osc.stop(endAt + 0.1);
      });
    }
  };

  const begin = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    build(ctx.currentTime + 0.03, getElapsed());
  };

  const resume = () => {
    if (disposed) return;
    if (ctx.state === "running") {
      begin();
      return;
    }
    void ctx
      .resume()
      .then(() => {
        begin();
      })
      .catch(() => {
        /* still blocked — the next gesture will try again */
      });
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (fadeTimer) {
      window.clearTimeout(fadeTimer);
      fadeTimer = 0;
    }
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    for (const node of graph) {
      try {
        node.disconnect();
      } catch {
        /* noop */
      }
    }
    sources.length = 0;
    graph.length = 0;
    try {
      void ctx.close();
    } catch {
      /* noop */
    }
  };

  return {
    start() {
      if (disposed) return;
      if (ctx.state === "running") {
        begin();
      } else {
        // Autoplay policy: stay silent-but-ready until a gesture unlocks us.
        void ctx.resume().catch(() => {});
      }
    },
    setMuted(next: boolean) {
      if (disposed) return;
      muted = next;
      const now = ctx.currentTime;
      mute.gain.cancelScheduledValues(now);
      mute.gain.setTargetAtTime(next ? 0.0001 : 1, now, 0.06);
      if (!next) resume();
    },
    resume,
    stop() {
      if (disposed) return;
      const now = ctx.currentTime;
      try {
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), now);
        master.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
      } catch {
        /* noop */
      }
      if (!fadeTimer) fadeTimer = window.setTimeout(dispose, 320);
    },
    dispose,
  };
}
