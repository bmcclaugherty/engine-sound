// Throwaway: verify the seamless-loop construction removes the seam.
'use strict';
const fs = require('fs');

function loadWav(path) {
  const b = fs.readFileSync(path);
  const n = (b.length - 44) / 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768;
  return x;
}

function makeSeamless(x, F) {
  const N = x.length;
  if (F <= 0 || F >= N) return x;
  const out = x.slice(0, N - F);
  for (let i = 0; i < F; i++) {
    const w = i / F;
    out[i] = x[i] * w + x[N - F + i] * (1 - w);
  }
  return out;
}

const x = loadWav('/home/brian/devl/engine-sound/recordings/ftype-hold.wav');
const F = Math.round(48000 * 0.15); // 0.15 s

function maxDelta(buf, regionStart, regionLen) {
  let m = 0;
  for (let i = regionStart; i < regionStart + regionLen - 1 && i < buf.length - 1; i++) {
    const d = Math.abs(buf[i + 1] - buf[i]);
    if (d > m) m = d;
  }
  return m;
}

// raw loop: what's the delta across the wrap (last -> first sample)?
const rawWrap = Math.abs(x[0] - x[x.length - 1]);
// raw loop: typical sample-to-sample delta (mid-buffer, away from seams)
const rawTypical = maxDelta(x, 48000, 2000);

const seamless = makeSeamless(x, F);
const seamWrap = Math.abs(seamless[0] - seamless[seamless.length - 1]);
const seamTypical = maxDelta(seamless, 48000, 2000);
const seamAtHead = maxDelta(seamless, 0, F);       // the crossfaded head region
const seamAtEnd = maxDelta(seamless, seamless.length - F - 2, F);

console.log('raw       : wrap delta', rawWrap.toFixed(5), ' typical', rawTypical.toFixed(5));
console.log('seamless  : wrap delta', seamWrap.toFixed(5), ' typical', seamTypical.toFixed(5));
console.log('  head region delta', seamAtHead.toFixed(5), '  end region delta', seamAtEnd.toFixed(5));
console.log('loop length: raw', x.length, ' seamless', seamless.length);
