/*
 * sample-dsp.js — varispeed looped sample playback (proof of concept).
 *
 * Plays one mono buffer in a loop at a playback rate set from outside (the app
 * maps engine rpm onto `rate = rpm / nativeRpm`). Linear interpolation keeps
 * the fractional playhead smooth, and a short crossfade around the loop seam
 * hides the join. No DOM, no imports, no allocation in the loop.
 *
 * Loaded twice, like engine-dsp.js: as an AudioWorklet module it registers
 * "sample-processor", as a classic script it exposes globalThis.SampleDSP for
 * the ScriptProcessorNode fallback.
 */
(function (G) {
  'use strict';

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  function SampleDSP(sampleRate, data) {
    this.sr = sampleRate > 0 ? sampleRate : 48000;
    this.buf = data.left || new Float32Array(0);
    var len = this.buf.length;
    this.loopStart = clamp(data.loopStart || 0, 0, Math.max(0, len - 2));
    this.loopEnd = (data.loopEnd || len) > this.loopStart ? Math.min(data.loopEnd || len, len) : len;
    var loopLen = this.loopEnd - this.loopStart;
    var fade = data.fade || Math.round(this.sr * 0.03);
    this.fade = clamp(fade, 0, Math.floor(loopLen * 0.45));
    this.pos = this.loopStart;
    this.rate = 0;
    this.target = 0;
    this.gain = data.gain != null ? data.gain : 1;
  }

  SampleDSP.prototype.setRate = function (r) { this.target = clamp(r, 0, 8); };
  SampleDSP.prototype.setGain = function (g) { this.gain = g; };

  SampleDSP.prototype.render = function (outL, outR, offset, count) {
    var buf = this.buf;
    var len = this.loopEnd, start = this.loopStart, fade = this.fade;
    var loopLen = len - start;
    if (loopLen <= 0 || !buf.length) {
      for (var z = 0; z < count; z++) { outL[offset + z] = 0; if (outR) outR[offset + z] = 0; }
      return;
    }

    var pos = this.pos, rate = this.rate, target = this.target, gain = this.gain;
    // Smooth the rate so rpm changes glide instead of zippering.
    rate += (target - rate) * 0.12;
    if (rate < 0.0005) rate = 0;

    var last = buf.length - 1;
    var s, i0, f, x, x2, a, tail, i1, v;

    for (s = 0; s < count; s++) {
      if (rate === 0) {
        x = 0;
      } else {
        i0 = pos | 0;
        f = pos - i0;
        i1 = i0 + 1 < buf.length ? i0 + 1 : last;
        x = buf[i0] + (buf[i1] - buf[i0]) * f;

        // Crossfade the loop tail into the loop head over `fade` samples.
        tail = len - pos;
        if (tail < fade) {
          v = start + (pos - (len - fade));
          i0 = v | 0;
          f = v - i0;
          i1 = i0 + 1 < buf.length ? i0 + 1 : last;
          x2 = buf[i0] + (buf[i1] - buf[i0]) * f;
          a = tail / fade;               // 1 at the tail, 0 at the seam
          x = x * a + x2 * (1 - a);
        }
        x *= gain;
      }

      outL[offset + s] = x;
      if (outR) outR[offset + s] = x;

      pos += rate;
      if (pos >= len) pos -= loopLen;
    }

    this.pos = pos;
    this.rate = rate;
  };

  G.SampleDSP = SampleDSP;

  if (typeof registerProcessor === 'function' && typeof AudioWorkletProcessor === 'function') {
    class SampleProcessor extends AudioWorkletProcessor {
      constructor(options) {
        super();
        var opts = (options && options.processorOptions) || {};
        this.dsp = new SampleDSP(sampleRate, opts);
        this.alive = true;
        var self = this;
        this.port.onmessage = function (e) {
          var d = e.data || {};
          if (d.type === 'rate') self.dsp.setRate(d.rate);
          else if (d.type === 'gain') self.dsp.setGain(d.gain);
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
    registerProcessor('sample-processor', SampleProcessor);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
