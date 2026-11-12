/*
 * engine-dsp.js — procedurally synthesized combustion-engine voice.
 *
 * Model, per audio sample:
 *   crank position -> evenly spaced firing events (one per cylinder per 720
 *   degrees) -> each event injects a short, deterministic exhaust pressure
 *   pulse into its cylinder bank -> per-bank exhaust voicing (a resonant body
 *   low-pass, a pipe-resonance peak and two formant band-passes) -> stereo
 *   mix -> intake roar, mechanical noise, supercharger / gear whine and
 *   afterfire pops -> muffler low-pass -> soft saturation -> DC blocker.
 *
 * The pulse is deterministic from firing to firing on purpose: the engine note
 * is the harmonic series of the firing rate, so randomising each pulse would
 * smear it into noise. Texture comes from the continuous noise layers and from
 * a little amplitude scatter between firings.
 *
 * Filters are biquads rather than delay-line waveguides: a feedback comb with
 * realistic (high) feedback has very narrow peaks and wide notches, which
 * guts the harmonic series whenever the firing rate lands between two
 * resonances. Resonant low-pass / peak / band-pass stages colour the tone
 * without removing harmonics.
 *
 * The module is loaded twice, so it stays side-effect free at load time:
 *   1. in an AudioWorklet, where it registers "engine-processor";
 *   2. as a classic script, where it exposes globalThis.EngineDSP for the
 *      ScriptProcessorNode fallback.
 * No DOM access, no imports, no allocation inside the render loop.
 */
(function (G) {
  'use strict';

  var TWO_PI = Math.PI * 2;
  var INJ_LEN = 8192;
  var INJ_MASK = INJ_LEN - 1;

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  // Rational tanh approximation: cheap, monotonic, gentle knee.
  function softClip(x) {
    if (x > 3) return 1;
    if (x < -3) return -1;
    var x2 = x * x;
    return x * (27 + x2) / (27 + 9 * x2);
  }

  // xorshift32 — deterministic, allocation free, range [-1, 1).
  function Rng(seed) { this.s = (seed >>> 0) || 0x2545f491; }
  Rng.prototype.next = function () {
    var x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.s = x;
    return x / 2147483648 - 1;
  };

  // Transposed direct form II biquad.
  function Biquad() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0;
    this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }
  Biquad.prototype.tick = function (x) {
    var y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  };
  Biquad.prototype.set = function (b0, b1, b2, a0, a1, a2) {
    var ia = 1 / a0;
    this.b0 = b0 * ia; this.b1 = b1 * ia; this.b2 = b2 * ia;
    this.a1 = a1 * ia; this.a2 = a2 * ia;
  };
  Biquad.prototype.clear = function () { this.z1 = 0; this.z2 = 0; };
  Biquad.prototype.lowpass = function (sr, f, q) {
    f = clamp(f, 10, sr * 0.45);
    var w = TWO_PI * f / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
    this.set((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
  };
  Biquad.prototype.highpass = function (sr, f, q) {
    f = clamp(f, 10, sr * 0.45);
    var w = TWO_PI * f / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
    this.set((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
  };
  Biquad.prototype.bandpass = function (sr, f, q) {
    f = clamp(f, 10, sr * 0.45);
    var w = TWO_PI * f / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
    this.set(al, 0, -al, 1 + al, -2 * cs, 1 - al);
  };
  // Peaking EQ (RBJ), gain in dB.
  Biquad.prototype.peaking = function (sr, f, q, db) {
    f = clamp(f, 10, sr * 0.45);
    var A = Math.pow(10, db / 40);
    var w = TWO_PI * f / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
    this.set(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
  };

  var DEFAULTS = {
    idle: 800,
    redline: 6500,
    n: 8,
    firing: [0, 1, 1, 0, 1, 0, 0, 1],
    pipeFreq: 55,
    pipeRatio: 1.03,
    formants: [{ f: 190, q: 1.5 }, { f: 460, q: 2.0 }],
    bodyFreq: 140,
    bodyQ: 1.4,
    intake: 0.5,
    whine: 0.12,
    whineOrders: 7.5,
    muffler: 2600,
    pulseMs: 5,
    pulseDecay: 0.0018,
    popBase: 0.00030
  };

  function merge(base, over) {
    var out = {}, k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    if (over) for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
    out.formants = (over && over.formants) || base.formants;
    return out;
  }

  // Exhaust pressure pulse: fast attack, short decay, plus a smaller valve-close
  // bump a couple of time constants later.
  function makeKernel(sr, c) {
    var len = Math.max(24, Math.round(sr * c.pulseMs / 1000));
    var raw = new Float32Array(len);
    var tau = c.pulseDecay;
    var rise = Math.max(1, sr * 0.00006);
    var i, t;
    for (i = 0; i < len; i++) {
      t = i / sr;
      var env = (1 - Math.exp(-i / rise)) * Math.exp(-t / tau);
      var tc = t - tau * 2.6;
      var lobe = tc > 0 ? Math.exp(-tc / (tau * 0.7)) * 0.30 : 0;
      raw[i] = env - lobe;
    }
    // Remove DC, normalise, and fade the tail so the kernel cannot click.
    var hp = new Biquad();
    hp.highpass(sr, 28, 0.7);
    var peak = 1e-6;
    for (i = 0; i < len; i++) {
      raw[i] = hp.tick(raw[i]);
      if (Math.abs(raw[i]) > peak) peak = Math.abs(raw[i]);
    }
    for (i = 0; i < len; i++) raw[i] /= peak;
    var fade = Math.min(64, len >> 2);
    for (i = 0; i < fade; i++) raw[len - 1 - i] *= i / fade;
    return raw;
  }

  function EngineDSP(sampleRate, cfg) {
    this.sr = sampleRate > 0 ? sampleRate : 48000;
    this.p = { rpm: 0, load: 0, overrun: 0, cut: 0, character: 0.5, crackle: 0.5, whine: 0.35, volume: 0.7 };
    this.tp = { rpm: 0, load: 0, overrun: 0, cut: 0, character: 0.5, crackle: 0.5, whine: 0.35, volume: 0.7 };
    this.setConfig(cfg);
  }

  EngineDSP.prototype.setParams = function (o) {
    var t = this.tp;
    if (!o) return;
    if (o.rpm != null) t.rpm = clamp(o.rpm, 0, 20000);
    if (o.load != null) t.load = clamp(o.load, 0, 1);
    if (o.overrun != null) t.overrun = clamp(o.overrun, 0, 1);
    if (o.cut != null) t.cut = clamp(o.cut, 0, 1);
    if (o.character != null) t.character = clamp(o.character, 0, 1);
    if (o.crackle != null) t.crackle = clamp(o.crackle, 0, 1);
    if (o.whine != null) t.whine = clamp(o.whine, 0, 1);
    if (o.volume != null) t.volume = clamp(o.volume, 0, 1);
  };

  EngineDSP.prototype.current = function () {
    var c = this.p;
    return { rpm: c.rpm, load: c.load, overrun: c.overrun, cut: c.cut };
  };

  EngineDSP.prototype.setConfig = function (cfg) {
    var c = merge(DEFAULTS, cfg);
    var sr = this.sr;
    this.cfg = c;

    this.n = clamp(c.firing && c.firing.length ? c.firing.length : c.n, 1, 16);
    this.firing = new Uint8Array(this.n);
    for (var i = 0; i < this.n; i++) {
      this.firing[i] = c.firing && c.firing.length ? (c.firing[i] ? 1 : 0) : (i & 1);
    }

    this.kernel = makeKernel(sr, c);
    this.injA = new Float32Array(INJ_LEN);
    this.injB = new Float32Array(INJ_LEN);
    this.injIdx = 0;

    this.bodyA = new Biquad(); this.bodyB = new Biquad();
    this.peakA = new Biquad(); this.peakB = new Biquad();
    this.fmA1 = new Biquad(); this.fmA2 = new Biquad(); this.fmA3 = new Biquad();
    this.fmB1 = new Biquad(); this.fmB2 = new Biquad(); this.fmB3 = new Biquad();
    this.bodyQ = c.bodyQ;
    this.bodyA.lowpass(sr, c.bodyFreq, c.bodyQ);
    this.bodyB.lowpass(sr, c.bodyFreq * 1.02, c.bodyQ);
    this.peakA.peaking(sr, c.pipeFreq, 2.6, 7);
    this.peakB.peaking(sr, c.pipeFreq * c.pipeRatio, 2.6, 7);
    this.fmA1.bandpass(sr, c.formants[0].f, c.formants[0].q);
    this.fmA2.bandpass(sr, c.formants[1].f, c.formants[1].q);
    this.fmB1.bandpass(sr, c.formants[0].f * 1.02, c.formants[0].q);
    this.fmB2.bandpass(sr, c.formants[1].f * 1.02, c.formants[1].q);
    // Optional third formant: fills the hollow band between the second formant
    // and the muffler cutoff at high rpm.
    if (c.formants[2]) {
      this.fmA3.bandpass(sr, c.formants[2].f, c.formants[2].q);
      this.fmB3.bandpass(sr, c.formants[2].f * 1.03, c.formants[2].q);
    }

    this.intake1 = new Biquad(); this.intake2 = new Biquad();
    this.mech = new Biquad(); this.mech.highpass(sr, 2200, 0.7);
    this.popF = new Biquad(); this.popF.highpass(sr, 620, 0.8);
    this.muffL = new Biquad(); this.muffR = new Biquad();
    this.dcL = new Biquad(); this.dcR = new Biquad();
    this.dcL.highpass(sr, 18, 0.7); this.dcR.highpass(sr, 18, 0.7);

    this.pos = 0;          // position inside the firing cycle, 0..1
    this.ev = 0;           // index of the current firing event
    this.whinePhase = 0;
    this.popEnv = 0;
    this.popPan = 0;
    this.lump = 0;
    this.lumpTarget = 0;
    this.lumpCount = 0;
    this.rand = new Rng(0x1234abcd);
    this.rand2 = new Rng(0x7f4a7c15);
    this.popRand = new Rng(0x2545f491);
  };

  EngineDSP.prototype.render = function (outL, outR, offset, count) {
    var sr = this.sr, p = this.p, tp = this.tp, c = this.cfg;
    if (!count) return;

    // ---- parameter smoothing (once per block) -----------------------------
    p.rpm += (tp.rpm - p.rpm) * 0.20;
    p.load += (tp.load - p.load) * 0.30;
    p.overrun += (tp.overrun - p.overrun) * 0.10;
    p.cut += (tp.cut - p.cut) * 0.45;
    p.character += (tp.character - p.character) * 0.12;
    p.crackle += (tp.crackle - p.crackle) * 0.12;
    p.whine += (tp.whine - p.whine) * 0.12;
    p.volume += (tp.volume - p.volume) * 0.20;

    var rpm = p.rpm, load = p.load, char = p.character;
    var rpmNorm = clamp((rpm - c.idle) / Math.max(1, c.redline - c.idle), 0, 1);

    // ---- derived block values --------------------------------------------
    var dPos = ((rpm / 60) * (this.n / 2)) / sr;

    // Character opens the exhaust: brighter, raspier, more drive.
    var g1 = 0.55 + 0.55 * char;          // lower formant
    var g2 = 0.22 + 0.70 * char;          // upper formant
    var g3f = c.formants[2] ? 0.08 + 0.42 * char : 0;   // optional third formant
    var gBody = 1.25 - 0.35 * char;
    var exGain = 1.15;
    var intakeGain = c.intake * (0.10 + 0.55 * load) * (0.35 + 0.65 * rpmNorm) * (0.5 + 0.5 * char);
    var mechGain = (0.004 + 0.014 * rpmNorm) * (0.3 + 0.7 * char);
    var whineGain = c.whine * p.whine * (0.12 + 0.88 * load) * 0.5;
    var whineInc = TWO_PI * (rpm / 60) * c.whineOrders / sr;
    if (whineInc > Math.PI * 0.45) whineInc = Math.PI * 0.45;

    var muffFc = c.muffler * (0.62 + 0.55 * char) * (0.70 + 0.40 * rpmNorm);
    this.muffL.lowpass(sr, muffFc, 1.1);
    this.muffR.lowpass(sr, muffFc * 1.02, 1.1);
    this.intake1.bandpass(sr, 300 + 900 * rpmNorm, 0.85);
    this.intake2.bandpass(sr, 900 + 2400 * rpmNorm, 1.4);

    var drive = 1.05 + 1.5 * char;
    var master = 0.95 * Math.pow(clamp(p.volume, 0, 1), 1.4);

    var rpmGain = 0.82 + 0.32 * rpmNorm;
    var popProb = c.popBase * p.crackle * p.overrun * (0.25 + 0.75 * rpmNorm) * (0.55 + 0.45 * char);
    var pulseAmp = (0.20 + 0.80 * load) * (1 - p.cut) + 0.06;
    var cutPuff = p.cut > 0.5 ? 0.05 : 0;

    // ---- state to locals --------------------------------------------------
    var iA = this.injA, iB = this.injB, injIdx = this.injIdx;
    var bodyA = this.bodyA, bodyB = this.bodyB, peakA = this.peakA, peakB = this.peakB;
    var fmA1 = this.fmA1, fmA2 = this.fmA2, fmA3 = this.fmA3;
    var fmB1 = this.fmB1, fmB2 = this.fmB2, fmB3 = this.fmB3;
    var int1 = this.intake1, int2 = this.intake2, mech = this.mech, popF = this.popF;
    var muffL = this.muffL, muffR = this.muffR, dcL = this.dcL, dcR = this.dcR;
    var kernel = this.kernel, klen = kernel.length, firing = this.firing, nEv = this.n;
    var pos = this.pos, ev = this.ev;
    var whinePhase = this.whinePhase;
    var popEnv = this.popEnv, popPan = this.popPan;
    var lump = this.lump, lumpTarget = this.lumpTarget, lumpCount = this.lumpCount;
    var rand = this.rand, rand2 = this.rand2, popRand = this.popRand;

    for (var s = 0; s < count; s++) {
      // ---- crank advance + firing events ---------------------------------
      pos += dPos;
      while (pos >= 1) {
        pos -= 1;
        var bank = firing[ev];
        ev = ev + 1; if (ev >= nEv) ev = 0;
        var amp = pulseAmp * (0.96 + 0.08 * rand.next());
        var tgt = bank ? iB : iA;
        var kk = 0, ii = injIdx;
        while (kk < klen) {
          tgt[(ii + kk) & INJ_MASK] += amp * kernel[kk];
          kk++;
        }
        if (cutPuff > 0) tgt[ii & INJ_MASK] += cutPuff * (0.5 + 0.5 * rand2.next());
      }

      // ---- exhaust injection this sample ---------------------------------
      var inA = iA[injIdx];
      var inB = iB[injIdx];
      iA[injIdx] = 0;
      iB[injIdx] = 0;
      injIdx = (injIdx + 1) & INJ_MASK;

      // ---- per-bank exhaust voicing ---------------------------------------
      var sigA = peakA.tick(inA) * 0.9 + bodyA.tick(inA) * gBody
        + fmA1.tick(inA) * g1 + fmA2.tick(inA) * g2;
      var sigB = peakB.tick(inB) * 0.9 + bodyB.tick(inB) * gBody
        + fmB1.tick(inB) * g1 + fmB2.tick(inB) * g2;
      if (g3f > 0) {
        sigA += fmA3.tick(inA) * g3f;
        sigB += fmB3.tick(inB) * g3f;
      }

      // ---- intake + mechanical noise --------------------------------------
      var nz = rand.next();
      var intake = (int1.tick(nz) + 0.55 * int2.tick(nz)) * intakeGain;
      var mechN = mech.tick(nz) * mechGain;

      // ---- supercharger / gear whine --------------------------------------
      whinePhase += whineInc;
      if (whinePhase > TWO_PI) whinePhase -= TWO_PI;
      var wh = (Math.sin(whinePhase) + 0.35 * Math.sin(whinePhase * 2)) * whineGain;

      // ---- slow combustion wander (lumpy idle) ----------------------------
      if (--lumpCount <= 0) {
        lumpTarget = rand2.next();
        lumpCount = Math.max(8, (sr * 0.012) | 0);
      }
      lump += (lumpTarget - lump) * 0.002;
      var wander = 1 + lump * 0.22 * (0.35 + 0.65 * char);

      // ---- afterfire pops -------------------------------------------------
      if (popProb > 0 && popRand.next() > 1 - popProb * 2) {
        popEnv = 0.45 + 0.55 * Math.abs(popRand.next());
        popPan = popRand.next();
      }
      var popSig = 0;
      if (popEnv > 0.0008) {
        popEnv *= 0.9997;
        popSig = popF.tick(rand2.next()) * popEnv * 0.5;
      }

      // ---- mix + stereo ----------------------------------------------------
      // Louder as the engine climbs, like the real thing.
      var exSum = (sigA * 0.88 + sigB * 0.30) * exGain * wander * rpmGain;
      var exSum2 = (sigB * 0.88 + sigA * 0.30) * exGain * wander * rpmGain;
      var l = exSum + intake + mechN + wh + popSig * (0.65 + 0.35 * (1 - popPan));
      var r = exSum2 + intake + mechN + wh + popSig * (0.65 + 0.35 * popPan);

      // ---- muffler, saturation, DC block, master --------------------------
      l = softClip(muffL.tick(l) * drive) * master;
      r = softClip(muffR.tick(r) * drive) * master;
      l = dcL.tick(l);
      r = dcR.tick(r);

      outL[offset + s] = l;
      if (outR) outR[offset + s] = r;
    }

    // ---- store state back -------------------------------------------------
    this.injIdx = injIdx;
    this.pos = pos;
    this.ev = ev;
    this.whinePhase = whinePhase;
    this.popEnv = popEnv;
    this.popPan = popPan;
    this.lump = lump;
    this.lumpTarget = lumpTarget;
    this.lumpCount = lumpCount;
  };

  // Offline render helper: used by the test harness and by the in-browser
  // self-check. Returns { left, right } Float32Arrays.
  EngineDSP.renderOffline = function (sampleRate, cfg, params, seconds, blockSize) {
    var dsp = new EngineDSP(sampleRate, cfg);
    dsp.setParams(params);
    var step = blockSize || 128;
    var warm = Math.round(sampleRate * 0.4);
    var wL = new Float32Array(step), wR = new Float32Array(step);
    var i;
    for (i = 0; i + step <= warm; i += step) dsp.render(wL, wR, 0, step);
    var total = Math.round(sampleRate * seconds);
    var L = new Float32Array(total), R = new Float32Array(total);
    for (i = 0; i + step <= total; i += step) dsp.render(L, R, i, step);
    return { left: L, right: R };
  };

  G.EngineDSP = EngineDSP;

  // ---- AudioWorklet registration -----------------------------------------
  // AudioWorkletProcessor is a real class in Chromium, so this has to be a
  // class too: calling it as a function throws and the processor outputs
  // silence. The class sits inside a guard, so the classic-script path never
  // evaluates it.
  if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor === 'function') {
    class EngineProcessor extends AudioWorkletProcessor {
      constructor(options) {
        super();
        var opts = (options && options.processorOptions) || {};
        this.dsp = new EngineDSP(sampleRate, opts.cfg || null);
        if (opts.params) this.dsp.setParams(opts.params);
        this.alive = true;
        var self = this;
        this.port.onmessage = function (e) {
          var d = e.data || {};
          if (d.type === 'params') self.dsp.setParams(d.params);
          else if (d.type === 'config') self.dsp.setConfig(d.cfg);
          else if (d.type === 'stop') self.alive = false;
        };
      }
      process(inputs, outputs) {
        var out = outputs[0];
        if (out && out.length) {
          this.dsp.render(out[0], out.length > 1 ? out[1] : null, 0, out[0].length);
        }
        return this.alive;
      }
    }
    registerProcessor('engine-processor', EngineProcessor);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
