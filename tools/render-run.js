// Throwaway: render a scripted acceleration run to WAV for spectrogram review.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const sandbox = { console, Math, Float32Array, Uint8Array, Object };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'cars.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'engine-dsp.js'), 'utf8'), sandbox);
  return sandbox;
}
const SR = 48000;
const sb = load();
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

function writeWav(file, chans, sr) {
  const n = chans[0].length, ch = chans.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, chans[c][i])) * 32767), o); o += 2;
  }
  fs.writeFileSync(file, buf);
}

for (const car of sb.ENGINESOUND_CARS) {
  const dsp = new sb.EngineDSP(SR, car.engine);
  const secs = 10;
  const total = SR * secs;
  const L = new Float32Array(total), R = new Float32Array(total);
  const blk = 128;
  const bL = new Float32Array(blk), bR = new Float32Array(blk);
  let t = 0;
  for (let i = 0; i + blk <= total; i += blk) {
    const sec = i / SR;
    let rpm, load, over = 0, cut = 0;
    if (sec < 0.8) { rpm = car.idle + 200; load = 0.08; }                 // idle
    else if (sec < 3.6) {                                                 // rev to redline
      const p = (sec - 0.8) / 2.8;
      rpm = car.idle + (car.redline * 0.97 - car.idle) * p;
      load = 0.9;
    } else if (sec < 5.2) { rpm = car.redline * 0.97; load = 0.95; }      // hold
    else if (sec < 7.2) {                                                 // lift off: overrun
      const p = 1 - (sec - 5.2) / 2.0;
      rpm = car.idle + (car.redline * 0.85 - car.idle) * p;
      load = 0.02; over = 1;
    } else { rpm = car.idle + 150; load = 0.06; }                         // back to idle
    dsp.setParams({ rpm, load, overrun: over, cut, character: 0.65, crackle: 0.65, whine: 0.45, volume: 0.75 });
    dsp.render(bL, bR, 0, blk);
    L.set(bL, i); R.set(bR, i);
  }
  writeWav(path.join(outDir, car.id + '-run.wav'), [L, R], SR);
  console.log('wrote', car.id + '-run.wav');
}
