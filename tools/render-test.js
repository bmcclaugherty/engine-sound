// Offline test harness: renders the DSP to WAV files and reports level/spectral
// sanity checks. Run: node tools/render-test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'engine-dsp.js'), 'utf8');
const carsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'cars.js'), 'utf8');
const sandbox = { console, Math, Float32Array, Uint8Array, Object };
vm.createContext(sandbox);
vm.runInContext(carsSrc, sandbox);
vm.runInContext(src, sandbox);
const EngineDSP = sandbox.EngineDSP;
if (!EngineDSP) throw new Error('EngineDSP not exported');

const presets = sandbox.ENGINESOUND_CARS;
if (!presets || !presets.length) throw new Error('cars not exported');
const SR = 48000;

function goertzel(buf, from, len, freq, sr) {
  const w = 2 * Math.PI * freq / sr;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < len; i++) {
    const s0 = buf[from + i] + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / len;
}

function writeWav(file, chans, sr) {
  const n = chans[0].length, ch = chans.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      let v = Math.max(-1, Math.min(1, chans[c][i]));
      buf.writeInt16LE(Math.round(v * 32767), o); o += 2;
    }
  }
  fs.writeFileSync(file, buf);
}

const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

const rows = [];
for (const preset of presets) {
  for (const [label, rpm, load, over] of [
    ['idle', preset.idle, 0.06, 0],
    ['mid', Math.round((preset.idle + preset.redline) / 2), 0.9, 0],
    ['redline', Math.round(preset.redline * 0.97), 1, 0],
    ['overrun', Math.round(preset.redline * 0.7), 0.0, 1],
  ]) {
    const { left, right } = EngineDSP.renderOffline(SR, preset.engine, {
      rpm, load, overrun: over, cut: 0, character: 0.6, crackle: 0.6, whine: 0.5, volume: 0.75
    }, 2.0);
    const name = `${preset.id}-${label}`;
    writeWav(path.join(outDir, name + '.wav'), [left, right], SR);

    let peak = 0, sum = 0, nan = 0, dc = 0;
    for (let i = 0; i < left.length; i++) {
      const v = left[i];
      if (!isFinite(v)) { nan++; continue; }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
      dc += v;
    }
    const rms = Math.sqrt(sum / left.length);
    const dcMean = dc / left.length;
    // expected firing frequency and its first harmonics
    const ncyl = preset.engine.firing.length;
    const fFire = rpm / 60 * ncyl / 2;
    const from = SR; // skip the first second
    const len = Math.min(SR, left.length - from);
    const h = [1, 2, 3, 4].map(k => +goertzel(left, from, len, fFire * k, SR).toFixed(5));
    rows.push({
      name, rpm, peak: +peak.toFixed(3), rms: +rms.toFixed(4),
      dc: +dcMean.toFixed(5), nan, fFire: +fFire.toFixed(1), harmonics: h
    });
  }
}

console.log(JSON.stringify(rows, null, 1));
const bad = rows.filter(r => r.nan > 0 || r.peak < 0.05 || r.peak > 0.999 || r.rms < 0.01 || Math.abs(r.dc) > 0.02);
console.log(bad.length ? 'PROBLEMS: ' + bad.map(b => b.name).join(', ') : 'all levels in range');
