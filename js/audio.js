/*
 * audio.js — audio graph and transport to the engine voice.
 *
 * Two voice types share one graph (duck → limiter → analyser → master →
 * destination):
 *   - synthesized engines run the engine-dsp.js AudioWorklet;
 *   - sampled engines (type 'sample') fetch a short recording, decode it and
 *     play it in a varispeed loop (sample-dsp.js) pitched by rpm.
 *
 * Prefers AudioWorklet, falls back to a ScriptProcessorNode running the same
 * DSP on the main thread. Mobile browsers — iOS especially — leave the
 * AudioContext suspended after a lock screen, a call or a tab switch and refuse
 * to resume it without a fresh gesture, so `start()` verifies the context
 * really reached "running" and arms a one-shot gesture handler when it did not.
 */
(function (G) {
  'use strict';

  var WORKLET_URL = 'js/engine-dsp.js';
  var SAMPLE_WORKLET_URL = 'js/sample-dsp.js';
  var UNLOCK_EVENTS = ['pointerdown', 'touchstart', 'keydown', 'mousedown'];

  function EngineAudio() {
    this.ctx = null;
    this.node = null;
    this.worklet = false;
    this.mode = null;          // 'synth' | 'sample' | null
    this.master = null;
    this.duck = null;
    this.limiter = null;
    this.analyser = null;
    this.anBuf = null;
    this.cfg = null;
    this.started = false;
    this.muted = false;
    this.lastParams = {};
    this.swapToken = 0;
    this.onState = null;
    this._unlock = null;
  }

  EngineAudio.prototype.state = function (s, detail) {
    if (this.onState) this.onState(s, detail || '');
  };

  EngineAudio.prototype.ensureContext = function () {
    if (this.ctx) return this.ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('no Web Audio in this browser');
    this.ctx = new AC({ latencyHint: 'interactive' });

    this.duck = this.ctx.createGain();
    this.duck.gain.value = 1;
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;

    // Inline analyser, never a floating tap: a node that cannot reach the
    // destination is not pulled and always reads silence.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.anBuf = new Float32Array(this.analyser.fftSize);

    this.duck.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(this.master);
    this.master.connect(this.ctx.destination);
    return this.ctx;
  };

  // Ask Safari for the playback audio session: without it the hardware mute
  // switch silences Web Audio on iOS.
  function requestPlaybackSession() {
    try {
      if (navigator.audioSession && navigator.audioSession.type !== 'playback') {
        navigator.audioSession.type = 'playback';
      }
    } catch (e) { /* older Safari */ }
  }

  EngineAudio.prototype.ensureRunning = async function () {
    var ctx = this.ensureContext();
    requestPlaybackSession();
    if (ctx.state === 'running') return 'running';
    try { await ctx.resume(); } catch (e) { /* needs a gesture */ }
    return ctx.state;
  };

  EngineAudio.prototype.armUnlock = function () {
    if (this._unlock) return;
    var self = this;
    var handler = async function () {
      var st = await self.ensureRunning();
      if (st !== 'running') return;
      self.disarmUnlock();
      self.applyGain();
      if (self.started) self.state('running', self.worklet ? 'worklet' : 'fallback');
      self.state('resumed', 'gesture');
    };
    this._unlock = handler;
    UNLOCK_EVENTS.forEach(function (ev) {
      document.addEventListener(ev, handler, { passive: true, capture: true });
    });
  };

  EngineAudio.prototype.disarmUnlock = function () {
    if (!this._unlock) return;
    var h = this._unlock;
    UNLOCK_EVENTS.forEach(function (ev) {
      document.removeEventListener(ev, h, { capture: true });
    });
    this._unlock = null;
  };

  EngineAudio.prototype._disposeNode = function () {
    if (this.node) {
      try { this.node.disconnect(); } catch (e) { /* ignore */ }
      if (this.worklet && this.node.port) {
        try { this.node.port.postMessage({ type: 'stop' }); } catch (e) { /* ignore */ }
      }
      this.node = null;
    }
    this.mode = null;
    this.worklet = false;
  };

  EngineAudio.prototype._buildSynth = async function (ctx, cfg) {
    if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function') {
      try {
        await ctx.audioWorklet.addModule(WORKLET_URL);
        var n = new AudioWorkletNode(ctx, 'engine-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: { cfg: cfg, params: this.lastParams }
        });
        this.worklet = true;
        return n;
      } catch (e) {
        this.worklet = false;
      }
    }
    if (typeof G.EngineDSP !== 'function') throw new Error('engine DSP missing');
    var dsp = new G.EngineDSP(ctx.sampleRate, cfg);
    var sp = ctx.createScriptProcessor(1024, 0, 2);
    sp.ondsp = dsp;
    sp.onaudioprocess = function (ev) {
      var out = ev.outputBuffer;
      dsp.render(out.getChannelData(0), out.getChannelData(1), 0, out.length);
    };
    return sp;
  };

  EngineAudio.prototype._decodeSample = async function (cfg) {
    var resp = await fetch(cfg.sampleUrl, { cache: 'no-store' });
    if (!resp.ok) throw new Error('sample not found (' + resp.status + ')');
    var bytes = await resp.arrayBuffer();
    var audioBuf = await this.ctx.decodeAudioData(bytes);
    var n = audioBuf.length;
    var mono = new Float32Array(n);
    if (audioBuf.numberOfChannels > 1) {
      var L = audioBuf.getChannelData(0), R = audioBuf.getChannelData(1);
      for (var i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;
    } else {
      mono.set(audioBuf.getChannelData(0));
    }
    return mono;
  };

  EngineAudio.prototype._buildSample = async function (ctx, cfg) {
    var mono = await this._decodeSample(cfg);
    var opts = {
      left: mono,
      loopStart: cfg.loopStart || 0,
      loopEnd: cfg.loopEnd || 0,
      fade: cfg.fade,
      gain: cfg.gain
    };
    if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function') {
      try {
        await ctx.audioWorklet.addModule(SAMPLE_WORKLET_URL);
        var n = new AudioWorkletNode(ctx, 'sample-processor', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          processorOptions: opts
        });
        this.worklet = true;
        return n;
      } catch (e) {
        this.worklet = false;
      }
    }
    if (typeof G.SampleDSP !== 'function') throw new Error('sample DSP missing');
    var dsp = new G.SampleDSP(ctx.sampleRate, opts);
    var sp = ctx.createScriptProcessor(1024, 0, 2);
    sp.ondsp = dsp;
    sp.onaudioprocess = function (ev) {
      var out = ev.outputBuffer;
      dsp.render(out.getChannelData(0), out.getChannelData(1), 0, out.length);
    };
    return sp;
  };

  EngineAudio.prototype._buildNode = async function (cfg) {
    this._disposeNode();
    var ctx = this.ensureContext();
    var node;
    if (cfg && cfg.type === 'sample') {
      node = await this._buildSample(ctx, cfg);
      this.mode = 'sample';
    } else {
      node = await this._buildSynth(ctx, cfg);
      this.mode = 'synth';
    }
    this.node = node;
    this.cfg = cfg;
    node.connect(this.duck);
    return node;
  };

  EngineAudio.prototype.start = async function (cfg) {
    var ctx = this.ensureContext();
    // Resume inside the gesture, before any await: iOS needs it there.
    requestPlaybackSession();
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch (e) { /* checked below */ }
    }
    this.cfg = cfg;
    if (!this.node) await this._buildNode(cfg);

    // addModule and node construction are async: on iOS the context can drop
    // back to suspended across those awaits.
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch (e) { /* checked below */ }
    }

    this.started = true;
    this.applyGain();
    var running = ctx.state === 'running';
    this.state(running ? 'running' : 'suspended', this.worklet ? 'worklet' : 'fallback');
    if (!running) this.armUnlock();
    return { worklet: this.worklet, sampleRate: ctx.sampleRate, state: ctx.state, mode: this.mode };
  };

  EngineAudio.prototype.send = function (msg) {
    if (!this.node || this.mode !== 'synth') return;
    if (this.worklet) this.node.port.postMessage(msg);
    else if (msg.type === 'params' && this.node.ondsp) this.node.ondsp.setParams(msg.params);
    else if (msg.type === 'config' && this.node.ondsp) this.node.ondsp.setConfig(msg.cfg);
  };

  /**
   * Push engine state. Values are quantised so a 60 Hz UI loop does not flood
   * the audio thread with redundant messages. (Synth voices only.)
   */
  EngineAudio.prototype.setParams = function (p) {
    if (this.mode !== 'synth' || !this.node) return;
    var last = this.lastParams;
    var q = {
      rpm: Math.round(p.rpm * 0.5) * 2,
      load: Math.round(p.load * 50) / 50,
      overrun: p.overrun > 0.5 ? 1 : 0,
      cut: p.cut > 0.5 ? 1 : 0,
      character: Math.round(p.character * 100) / 100,
      crackle: Math.round(p.crackle * 100) / 100,
      whine: Math.round(p.whine * 100) / 100,
      volume: Math.round(p.volume * 100) / 100
    };
    var changed = false, k;
    for (k in q) {
      if (last[k] !== q[k]) { changed = true; last[k] = q[k]; }
    }
    if (changed) this.send({ type: 'params', params: q });
  };

  // rpm → playback rate for a sampled engine.
  EngineAudio.prototype.setRate = function (rate) {
    if (this.mode !== 'sample' || !this.node) return;
    if (this.worklet) this.node.port.postMessage({ type: 'rate', rate: rate });
    else if (this.node.ondsp) this.node.ondsp.setRate(rate);
  };

  EngineAudio.prototype.applyGain = function () {
    if (!this.ctx || !this.duck) return;
    var t = this.ctx.currentTime;
    var g = this.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.muted ? 0 : 1, t + 0.08);
  };

  /**
   * Switch voice. Synth → synth is a config message; anything involving a
   * sample (or a different sample) tears the node down and rebuilds it. The
   * promise rejects if a sample cannot be loaded (e.g. the recording is not
   * bundled), so the caller can revert.
   */
  EngineAudio.prototype.setCar = async function (cfg) {
    var want = cfg && cfg.type === 'sample' ? 'sample' : 'synth';
    var same = this.started && this.node && this.mode === want &&
      (want !== 'sample' || (this.cfg && cfg.sampleUrl === this.cfg.sampleUrl));
    this.cfg = cfg;
    if (same) {
      if (this.mode === 'synth') this.send({ type: 'config', cfg: cfg });
      return;
    }
    var token = ++this.swapToken;
    if (this.ctx) {
      var now = this.ctx.currentTime;
      var g = this.duck.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + 0.05);
    }
    try {
      await this._buildNode(cfg);
    } catch (err) {
      if (token === this.swapToken) this.applyGain();
      throw err;
    }
    if (token === this.swapToken) this.applyGain();
  };

  EngineAudio.prototype.mute = function (on) {
    this.muted = !!on;
    this.applyGain();
  };

  // RMS of the last ~20 ms, for the in-app silence watchdog.
  EngineAudio.prototype.level = function () {
    if (!this.analyser || !this.anBuf) return 0;
    this.analyser.getFloatTimeDomainData(this.anBuf);
    var sum = 0;
    for (var i = 0; i < this.anBuf.length; i++) sum += this.anBuf[i] * this.anBuf[i];
    return Math.sqrt(sum / this.anBuf.length);
  };

  EngineAudio.prototype.stateNow = function () {
    return this.ctx ? this.ctx.state : 'none';
  };

  // Page hidden: browsers suspend the context anyway; doing it explicitly means
  // we know to ask for a resume when the page comes back.
  EngineAudio.prototype.pause = async function () {
    if (!this.ctx || !this.started) return;
    this.mute(true);
    try { await this.ctx.suspend(); } catch (e) { /* ignore */ }
  };

  EngineAudio.prototype.resume = async function () {
    if (!this.started) return this.stateNow();
    var st = await this.ensureRunning();
    if (st === 'running') {
      this.disarmUnlock();
      this.mute(false);
      this.state('running', this.worklet ? 'worklet' : 'fallback');
    } else {
      this.armUnlock();
      this.state('suspended', 'needs-gesture');
    }
    return st;
  };

  EngineAudio.prototype.stop = async function () {
    this.started = false;
    this.state('idle');
    this.disarmUnlock();
    if (this.ctx && this.ctx.state === 'running') {
      try { await this.ctx.suspend(); } catch (e) { /* ignore */ }
    }
  };

  G.EngineAudio = EngineAudio;
})(typeof globalThis !== 'undefined' ? globalThis : this);
