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
