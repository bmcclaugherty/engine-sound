/*
 * sample-dsp.js — varispeed looped sample playback (proof of concept).
 *
 * Plays one mono buffer in a loop at a playback rate set from outside (the app
 * maps engine rpm onto `rate = rpm / nativeRpm`). Catmull-Rom cubic
 * interpolation keeps the fractional playhead smooth when the rate moves —
 * linear interpolation audibly aliases, especially when slowed down. The
 * buffer is expected to already be seamless: audio.js crossfades the clip's
 * tail into its head at load time, so a naive wrap is click-free and no
 * runtime crossfade is needed. No DOM, no imports, no allocation in the loop.
 *
 * Loaded twice, like engine-dsp.js: as an AudioWorklet module it registers
 * "sample-processor", as a classic script it exposes globalThis.SampleDSP for
 * the ScriptProcessorNode fallback.
 */
(function (G) {
  'use strict';

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  // Catmull-Rom cubic read, indices clamped to the buffer. Allocation-free.
  function cubic(buf, last, p) {
    var i = p | 0;
    var f = p - i;
    var im = i > 0 ? i - 1 : 0;
    var ip1 = i < last ? i + 1 : last;
    var ip2 = i + 1 < last ? i + 2 : last;
    var x0 = buf[im], x1 = buf[i], x2 = buf[ip1], x3 = buf[ip2];
    var a = 0.5 * (3 * (x1 - x2) - x0 + x3);
    var b = 0.5 * (2 * x0 - 5 * x1 + 4 * x2 - x3);
    var c = 0.5 * (x2 - x0);
    return ((a * f + b) * f + c) * f + x1;
  }

  function SampleDSP(sampleRate, data) {
    this.sr = sampleRate > 0 ? sampleRate : 48000;
    this.buf = data.left || new Float32Array(0);
    var len = this.buf.length;
    this.loopStart = clamp(data.loopStart || 0, 0, Math.max(0, len - 2));
    this.loopEnd = (data.loopEnd || len) > this.loopStart ? Math.min(data.loopEnd || len, len) : len;
    this.loopLen = this.loopEnd - this.loopStart;
    this.pos = this.loopStart;
    this.rate = 0;
    this.target = 0;
    this.gain = data.gain != null ? data.gain : 1;
  }

  SampleDSP.prototype.setRate = function (r) { this.target = clamp(r, 0, 8); };
  SampleDSP.prototype.setGain = function (g) { this.gain = g; };

  SampleDSP.prototype.render = function (outL, outR, offset, count) {
    var buf = this.buf;
    var len = this.loopEnd, start = this.loopStart;
    var loopLen = this.loopLen;
    if (loopLen <= 0 || !buf.length) {
      for (var z = 0; z < count; z++) { outL[offset + z] = 0; if (outR) outR[offset + z] = 0; }
      return;
    }

    var pos = this.pos, rate = this.rate, target = this.target, gain = this.gain;
    // Long glide: a pitch change tracks rpm over ~70 ms instead of zippering,
    // which is the difference between a smooth pull and a staircase.
    rate += (target - rate) * 0.045;
    if (rate < 0.0005) rate = 0;

    var last = buf.length - 1;
    var s, x;

    for (s = 0; s < count; s++) {
      x = rate === 0 ? 0 : cubic(buf, last, pos) * gain;
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
