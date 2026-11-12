/*
 * cars.js — engine + drivetrain presets.
 *
 * `engine` feeds engine-dsp.js: the firing pattern (one entry per cylinder per
 * 720-degree cycle, 0 = left bank, 1 = right bank), where the exhaust pipes
 * resonate, the exhaust formants, intake level, whine, muffler cutoff and how
 * lively the afterfire is.
 *
 * `vehicle` feeds vehicle.js: gear ratios, final drive, wheel radius, how hard
 * the car pulls, drag, shift points and how fast the engine revs.
 *
 * To add a car, copy an entry and change the numbers.
 */
(function (G) {
  'use strict';

  var CARS = [
    {
      id: 'v8',
      name: 'V8 Muscle',
      tag: 'Cross-plane V8 · 6.2 L · dual exhaust',
      blurb: 'Uneven firing per bank, deep burble, heavy overrun crackle.',
      idle: 700,
      redline: 6600,
      engine: {
        idle: 700,
        redline: 6600,
        // 1-8-4-3-6-5-7-2, odd cylinders in the left bank
        firing: [0, 1, 1, 0, 1, 0, 0, 1],
        pipeFreq: 52,
        pipeRatio: 1.04,
        formants: [{ f: 175, q: 1.15 }, { f: 430, q: 1.35 }, { f: 1080, q: 1.2 }],
        bodyFreq: 130,
        intake: 0.55,
        whine: 0.05,
        whineOrders: 5,
        muffler: 2300,
        pulseMs: 6,
        pulseDecay: 0.0022,
        popBase: 0.00038
      },
      vehicle: {
        gears: [3.5, 2.15, 1.45, 1.0, 0.8, 0.64],
        finalDrive: 3.42,
        wheelR: 0.34,
        maxAccel: 6.4,
        brakeAccel: 9.0,
        drag: 0.0022,
        roll: 0.35,
        shiftUp: 5900,
        shiftDown: 2300,
        revRate: 15,
        revFallRate: 9
      }
    },
    {
      id: 'v12',
      name: 'V12',
      tag: 'Flat-plane V12 · 6.5 L · naturally aspirated',
      blurb: 'Even firing, tight harmonics, a scream instead of a rumble.',
      idle: 950,
      redline: 8700,
      engine: {
        idle: 950,
        redline: 8700,
        firing: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
        pipeFreq: 96,
        pipeRatio: 1.05,
        formants: [{ f: 330, q: 1.35 }, { f: 820, q: 1.6 }, { f: 1500, q: 1.4 }],
        bodyFreq: 340,
        bodyQ: 1.2,
        intake: 0.45,
        whine: 0.22,
        whineOrders: 4.5,
        muffler: 4200,
        pulseMs: 4.5,
        pulseDecay: 0.0013,
        popBase: 0.00018
      },
      vehicle: {
        gears: [3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69],
        finalDrive: 3.55,
        wheelR: 0.345,
        maxAccel: 7.0,
        brakeAccel: 9.5,
        drag: 0.0019,
        roll: 0.32,
        shiftUp: 8200,
        shiftDown: 3300,
        revRate: 22,
        revFallRate: 13
      }
    },
    {
      id: 'flat6',
      name: 'Flat-six',
      tag: 'Boxer six · 4.0 L · sport exhaust',
      blurb: 'Raspy and metallic, with the flat-six warble at part throttle.',
      idle: 850,
      redline: 7800,
      engine: {
        idle: 850,
        redline: 7800,
        firing: [0, 1, 0, 1, 0, 1],
        pipeFreq: 66,
        pipeRatio: 1.06,
        formants: [{ f: 245, q: 1.05 }, { f: 610, q: 1.25 }, { f: 1320, q: 1.2 }],
        bodyFreq: 155,
        intake: 0.62,
        whine: 0.10,
        whineOrders: 3,
        muffler: 3200,
        pulseMs: 5,
        pulseDecay: 0.0016,
        popBase: 0.00042
      },
      vehicle: {
        gears: [3.6, 2.12, 1.52, 1.18, 0.96, 0.78],
        finalDrive: 3.9,
        wheelR: 0.335,
        maxAccel: 7.4,
        brakeAccel: 9.5,
        drag: 0.0020,
        roll: 0.33,
        shiftUp: 7400,
        shiftDown: 2800,
        revRate: 19,
        revFallRate: 11
      }
    },
    {
      id: '911',
      name: '911',
      tag: 'Air-cooled boxer 6 · 3.8 L',
      blurb: 'The classic flat-six warble: uneven bank firing and a metallic rasp.',
      idle: 900,
      redline: 6800,
      engine: {
        // 1-6-3-2-5-4: the odd per-bank rhythm is what makes the 911 warble.
        firing: [0, 1, 0, 0, 1, 0],
        pipeFreq: 58,
        pipeRatio: 1.05,
        formants: [{ f: 300, q: 1.2 }, { f: 820, q: 1.5 }, { f: 1600, q: 1.6 }],
        bodyFreq: 130,
        bodyQ: 1.3,
        intake: 0.5,
        whine: 0.06,
        whineOrders: 3,
        muffler: 3000,
        pulseMs: 6,
        pulseDecay: 0.0016,
        popBase: 0.00042
      },
      vehicle: {
        gears: [3.5, 2.1, 1.5, 1.1, 0.86, 0.68],
        finalDrive: 3.44,
        wheelR: 0.33,
        maxAccel: 6.0,
        brakeAccel: 9.5,
        drag: 0.0020,
        roll: 0.33,
        shiftUp: 6500,
        shiftDown: 2500
      }
    },
    {
      id: 'f1-v12',
      name: 'F1 V12',
      tag: '1990s F1 · 3.5 L · 18,500 rpm',
      blurb: 'The last V12 era — a howling twelve-cylinder scream up to 18,500 rpm.',
      idle: 4200,
      redline: 18500,
      engine: {
        firing: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
        pipeFreq: 150,
        pipeRatio: 1.03,
        formants: [{ f: 1100, q: 1.1 }, { f: 2800, q: 1.3 }, { f: 5200, q: 1.6 }],
        bodyFreq: 700,
        bodyQ: 0.9,
        intake: 0.35,
        whine: 0.34,
        whineOrders: 3,
        muffler: 10000,
        // Pulse shorter than the 27-sample firing period at redline: a longer
        // one overlaps its neighbours and the overlapping pulses cancel, which
        // reads as an 11 dB level drop at the top of the rev range.
        pulseMs: 1.5,
        pulseDecay: 0.0004,
        popBase: 0.00008
      },
      vehicle: {
        gears: [3.2, 2.5, 2.0, 1.7, 1.4, 1.2, 1.05, 0.9],
        finalDrive: 4.4,
        wheelR: 0.33,
        maxAccel: 12.0,
        brakeAccel: 20.0,
        drag: 0.0040,
        roll: 0.6,
        shiftUp: 17500,
        shiftDown: 9000
      }
    },
    {
      id: 'v10',
      name: 'V10',
      tag: 'Naturally aspirated 4.8 L · 9,500 rpm',
      blurb: 'The even-fire V10 howl — smooth at idle, a wail at the top.',
      idle: 1200,
      redline: 9500,
      engine: {
        firing: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
        pipeFreq: 108,
        pipeRatio: 1.04,
        formants: [{ f: 380, q: 1.3 }, { f: 1100, q: 1.7 }, { f: 2100, q: 2.0 }],
        bodyFreq: 240,
        bodyQ: 1.1,
        intake: 0.45,
        whine: 0.26,
        whineOrders: 5,
        muffler: 5600,
        pulseMs: 4,
        pulseDecay: 0.0009,
        popBase: 0.00020
      },
      vehicle: {
        gears: [3.3, 2.2, 1.6, 1.25, 1.0, 0.82],
        finalDrive: 3.9,
        wheelR: 0.34,
        maxAccel: 7.5,
        brakeAccel: 9.5,
        drag: 0.0022,
        roll: 0.34,
        shiftUp: 9000,
        shiftDown: 3800
      }
    },
    {
      id: 'turbo4',
      name: 'Turbo four',
      tag: '2.0 L inline-4 · turbo · anti-lag',
      blurb: 'Turbo whistle and off-throttle pops, like a rally stage.',
      idle: 900,
      redline: 7000,
      engine: {
        firing: [0, 1, 0, 1],
        pipeFreq: 72,
        pipeRatio: 1.04,
        formants: [{ f: 220, q: 1.1 }, { f: 560, q: 1.35 }, { f: 1300, q: 1.4 }],
        bodyFreq: 150,
        bodyQ: 1.2,
        intake: 0.5,
        whine: 0.5,
        whineOrders: 10,
        muffler: 3400,
        pulseMs: 5,
        pulseDecay: 0.0012,
        popBase: 0.0005
      },
      vehicle: {
        gears: [3.4, 2.0, 1.4, 1.05, 0.85, 0.7],
        finalDrive: 3.7,
        wheelR: 0.32,
        maxAccel: 6.8,
        brakeAccel: 9.5,
        drag: 0.0021,
        roll: 0.32,
        shiftUp: 6600,
        shiftDown: 2500
      }
    },
    {
      id: 'rotary',
      name: 'Rotary',
      tag: 'Twin-rotor 13B · 9,000 rpm',
      blurb: 'Buzzy, spinning, and happy to rev to the moon.',
      idle: 1000,
      redline: 9000,
      engine: {
        firing: [0, 1, 0, 1],
        pipeFreq: 120,
        pipeRatio: 1.05,
        formants: [{ f: 850, q: 1.3 }, { f: 2400, q: 1.7 }, { f: 4800, q: 2.1 }],
        bodyFreq: 320,
        bodyQ: 1.0,
        intake: 0.4,
        whine: 0.24,
        whineOrders: 2.5,
        muffler: 8000,
        pulseMs: 3,
        pulseDecay: 0.0007,
        popBase: 0.00022
      },
      vehicle: {
        gears: [3.5, 2.1, 1.5, 1.15, 0.9, 0.73],
        finalDrive: 4.1,
        wheelR: 0.32,
        maxAccel: 7.0,
        brakeAccel: 9.5,
        drag: 0.0021,
        roll: 0.33,
        shiftUp: 8500,
        shiftDown: 3400
      }
    },
    {
      id: 'diesel6',
      name: 'Diesel six',
      tag: '3.0 L straight-six · turbo',
      blurb: 'Low, clattery idle and a long, torquey pull.',
      idle: 700,
      redline: 4500,
      engine: {
        firing: [0, 1, 0, 1, 0, 1],
        pipeFreq: 42,
        pipeRatio: 1.03,
        formants: [{ f: 110, q: 1.0 }, { f: 340, q: 1.1 }, { f: 760, q: 1.2 }],
        bodyFreq: 90,
        bodyQ: 1.2,
        intake: 0.4,
        whine: 0.22,
        whineOrders: 5,
        muffler: 1800,
        pulseMs: 2.5,
        pulseDecay: 0.0008,
        popBase: 0.00008
      },
      vehicle: {
        gears: [4.0, 2.4, 1.5, 1.0, 0.75, 0.6],
        finalDrive: 3.6,
        wheelR: 0.36,
        maxAccel: 4.2,
        brakeAccel: 9.0,
        drag: 0.0022,
        roll: 0.36,
        shiftUp: 4200,
        shiftDown: 1600
      }
    },
    {
      // Proof of concept: a real recording played back pitched by rpm. The
      // audio lives under recordings/ and is NOT committed (see .gitignore) —
      // replace it with your own or a licensed clip before any real use.
      id: 'ftype-v8',
      name: 'F-Type V8 (sample)',
      tag: 'Real recording · supercharged 5.0 V8',
      blurb: 'A real V8 clip, varispeed-pitched by rpm. Proof of concept.',
      idle: 700,
      redline: 6500,
      engine: {
        type: 'sample',
        sampleUrl: 'recordings/ftype-hold.wav',
        nativeRpm: 2850,
        fade: 1440,
        gain: 0.9
      },
      vehicle: {
        gears: [3.5, 2.15, 1.45, 1.0, 0.8, 0.64],
        finalDrive: 3.42,
        wheelR: 0.34,
        maxAccel: 6.4,
        brakeAccel: 9.0,
        drag: 0.0022,
        roll: 0.35,
        shiftUp: 5900,
        shiftDown: 2300
      }
    }
  ];

  // idle/redline live on the car; both the synth and the drivetrain need them,
  // so copy them into each block once instead of repeating the numbers.
  for (var i = 0; i < CARS.length; i++) {
    CARS[i].engine.idle = CARS[i].idle;
    CARS[i].engine.redline = CARS[i].redline;
    CARS[i].vehicle.idle = CARS[i].idle;
    CARS[i].vehicle.redline = CARS[i].redline;
  }

  G.ENGINESOUND_CARS = CARS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
