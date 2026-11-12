/*
 * audio.js — audio graph and transport to the engine synth.
 *
 * Prefers an AudioWorklet (DSP on the audio thread, immune to UI jank); falls
 * back to a ScriptProcessorNode running the same code on the main thread where
 * AudioWorklet is unavailable. A gain stage ducks the output while switching
 * cars and a compressor guards the output.
 */
(function (G) {
  'use strict';

  var WORKLET_URL = 'js/engine-dsp.js';

  function EngineAudio() {
    this.ctx = null;
    this.node = null;
    this.worklet = false;
    this.master = null;
    this.duck = null;
    this.limiter = null;
    this.cfg = null;
    this.started = false;
    this.lastParams = {};
    this.onState = null;
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

    this.duck.connect(this.limiter);
    this.limiter.connect(this.master);
    this.master.connect(this.ctx.destination);
    return this.ctx;
  };

  EngineAudio.prototype.start = async function (cfg) {
    var ctx = this.ensureContext();
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* ignore */ } }
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

    this.started = true;
    this.state('running', this.worklet ? 'worklet' : 'fallback');
    return { worklet: this.worklet, sampleRate: ctx.sampleRate };
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

  EngineAudio.prototype.setCar = function (cfg) {
    if (!this.started || !this.node) { this.cfg = cfg; return; }
    var self = this;
    var now = this.ctx.currentTime;
    // Duck, swap the voice, come back up: avoids a click on the config swap.
    this.duck.gain.cancelScheduledValues(now);
    this.duck.gain.setValueAtTime(this.duck.gain.value, now);
    this.duck.gain.linearRampToValueAtTime(0, now + 0.07);
    this.cfg = cfg;
    setTimeout(function () {
      self.send({ type: 'config', cfg: cfg });
      var t = self.ctx.currentTime;
      self.duck.gain.cancelScheduledValues(t);
      self.duck.gain.setValueAtTime(0, t);
      self.duck.gain.linearRampToValueAtTime(1, t + 0.12);
    }, 80);
  };

  EngineAudio.prototype.mute = function (on) {
    if (!this.ctx) return;
    var t = this.ctx.currentTime;
    this.duck.gain.cancelScheduledValues(t);
    this.duck.gain.setValueAtTime(this.duck.gain.value, t);
    this.duck.gain.linearRampToValueAtTime(on ? 0 : 1, t + 0.08);
  };

  EngineAudio.prototype.stop = async function () {
    this.started = false;
    this.state('idle');
    if (this.ctx && this.ctx.state === 'running') {
      try { await this.ctx.suspend(); } catch (e) { /* ignore */ }
    }
  };

  EngineAudio.prototype.resume = async function () {
    if (this.ctx && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch (e) { /* ignore */ }
    }
    if (this.started) this.state('running', this.worklet ? 'worklet' : 'fallback');
  };

  G.EngineAudio = EngineAudio;
})(typeof globalThis !== 'undefined' ? globalThis : this);
