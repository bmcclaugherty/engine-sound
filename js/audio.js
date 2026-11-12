/*
 * audio.js — audio graph and transport to the engine synth.
 *
 * Prefers an AudioWorklet (DSP on the audio thread, immune to UI jank); falls
 * back to a ScriptProcessorNode running the same code on the main thread where
 * AudioWorklet is unavailable.
 *
 * Mobile browsers — iOS especially — will silently leave an AudioContext
 * "suspended" or "interrupted" after a lock screen, a phone call or a tab
 * switch, and refuse to resume it without a fresh user gesture. So `start()`
 * verifies the context really reached "running" and, when it did not, arms a
 * one-shot gesture handler instead of pretending the engine is running.
 */
(function (G) {
  'use strict';

  var WORKLET_URL = 'js/engine-dsp.js';
  var UNLOCK_EVENTS = ['pointerdown', 'touchstart', 'keydown', 'mousedown'];

  function EngineAudio() {
    this.ctx = null;
    this.node = null;
    this.worklet = false;
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

  /**
   * Arm a one-shot gesture handler that resumes a suspended context. iOS only
   * allows resume from a real touch, so this is the recovery path after the
   * page has been backgrounded, locked or interrupted.
   */
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

  EngineAudio.prototype.start = async function (cfg) {
    var ctx = this.ensureContext();
    // Resume inside the gesture, before any await: iOS needs it there.
    requestPlaybackSession();
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch (e) { /* checked below */ }
    }
    this.cfg = cfg;

    if (!this.node) {
      var ok = false;
      if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function') {
        try {
          await ctx.audioWorklet.addModule(WORKLET_URL);
          this.node = new AudioWorkletNode(ctx, 'engine-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { cfg: cfg, params: this.lastParams }
          });
          this.worklet = true;
          ok = true;
        } catch (e) {
          this.node = null;
          this.worklet = false;
        }
      }
      if (!ok) {
        if (typeof G.EngineDSP !== 'function') throw new Error('engine DSP missing');
        var dsp = new G.EngineDSP(ctx.sampleRate, cfg);
        var sp = ctx.createScriptProcessor(1024, 0, 2);
        sp.ondsp = dsp;
        sp.onaudioprocess = function (ev) {
          var out = ev.outputBuffer;
          dsp.render(out.getChannelData(0), out.getChannelData(1), 0, out.length);
        };
        this.node = sp;
        this.worklet = false;
      }
      this.node.connect(this.duck);
    }

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
    return { worklet: this.worklet, sampleRate: ctx.sampleRate, state: ctx.state };
  };

  EngineAudio.prototype.send = function (msg) {
    if (!this.node) return;
    if (this.worklet) this.node.port.postMessage(msg);
    else if (msg.type === 'params' && this.node.ondsp) this.node.ondsp.setParams(msg.params);
    else if (msg.type === 'config' && this.node.ondsp) this.node.ondsp.setConfig(msg.cfg);
  };

  /**
   * Push engine state. Values are quantised so a 60 Hz UI loop does not flood
   * the audio thread with redundant messages.
   */
  EngineAudio.prototype.setParams = function (p) {
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

  EngineAudio.prototype.applyGain = function () {
    if (!this.ctx || !this.duck) return;
    var t = this.ctx.currentTime;
    var g = this.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.muted ? 0 : 1, t + 0.08);
  };

  EngineAudio.prototype.setCar = function (cfg) {
    this.cfg = cfg;
    if (!this.started || !this.node || !this.ctx) return;
    var self = this;
    var token = ++this.swapToken;
    var now = this.ctx.currentTime;
    var g = this.duck.gain;
    // Duck, swap the voice, come back up: avoids a click on the config swap.
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.06);
    // A newer swap invalidates this timer, so two quick clicks cannot leave the
    // duck ramped down (which reads as "no sound until I press something").
    setTimeout(function () {
      if (token !== self.swapToken) return;
      self.send({ type: 'config', cfg: cfg });
      self.applyGain();
    }, 70);
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
