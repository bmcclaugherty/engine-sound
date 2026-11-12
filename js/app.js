/*
 * app.js — wiring: one animation loop reads the input (pedals, demo run or
 * GPS), runs the drivetrain model, pushes rpm/load to the synth and paints the
 * gauge. UI is painted at half the audio-parameter rate to keep layout work
 * off the critical path.
 */
(function () {
  'use strict';

  var CARS = window.ENGINESOUND_CARS || [];
  var $ = function (id) { return document.getElementById(id); };
  var clamp = function (x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; };

  // ---------------------------------------------------------------- state ---
  var S = {
    carIndex: 0,
    running: false,
    source: 'demo',
    unit: 'mph',
    volume: 0.72,
    intensity: 0.60,
    character: 0.45,
    crackle: 0.55,
    whine: 0.35,
    gas: 0,
    gasTarget: 0,
    brake: 0,
    brakeTarget: 0,
    cruise: null,
    silentTicks: 0,
    audioWarned: false,
    revUntil: 0,
    demo: null,
    rpm: 0,
    speed: 0,
    gear: 1,
    load: 0,
    overrun: 0,
    cut: 0,
    throttle: 0
  };

  var audio = new window.EngineAudio();
  var gps = new window.GPS();
  var vehicle = new window.Vehicle(CARS[0].vehicle);
  var last = performance.now();
  var uiTick = 0;
  var wakeLock = null;

  // ------------------------------------------------------------ persistence -
  var STORE = 'enginesound.v1';
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        car: CARS[S.carIndex].id, unit: S.unit, volume: S.volume, intensity: S.intensity,
        character: S.character, crackle: S.crackle, whine: S.whine, source: S.source
      }));
    } catch (e) { /* private mode */ }
  }
  function load() {
    var raw;
    try { raw = localStorage.getItem(STORE); } catch (e) { return; }
    if (!raw) return;
    try {
      var o = JSON.parse(raw);
      var idx = CARS.findIndex(function (c) { return c.id === o.car; });
      if (idx >= 0) S.carIndex = idx;
      if (o.unit === 'kmh' || o.unit === 'mph') S.unit = o.unit;
      ['volume', 'intensity', 'character', 'crackle', 'whine'].forEach(function (k) {
        if (typeof o[k] === 'number') S[k] = clamp(o[k], 0, 1);
      });
      if (o.source === 'gps' || o.source === 'demo') S.source = o.source;
    } catch (e) { /* ignore bad json */ }
  }

  // ------------------------------------------------------------------ gauge -
  var CX = 200, CY = 200, R = 150, A0 = 135, A1 = 405;

  function polar(deg, r) {
    var a = (deg - 90) * Math.PI / 180;
    return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
  }
  function arcPath(a0, a1, r) {
    var p0 = polar(a0, r), p1 = polar(a1, r);
    var large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    return 'M' + p0[0].toFixed(2) + ' ' + p0[1].toFixed(2) +
      ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p1[0].toFixed(2) + ' ' + p1[1].toFixed(2);
  }

  var arcValueLen = 0;

  function buildGauge() {
    var car = CARS[S.carIndex];
    var track = $('arcTrack'), red = $('arcRed'), val = $('arcValue'), ticks = $('gaugeTicks');
    var steps = Math.max(6, Math.ceil(car.redline / 1000));
    var maxRpm = steps * 1000;

    track.setAttribute('d', arcPath(A0, A1, R));
    val.setAttribute('d', arcPath(A0, A1, R));
    arcValueLen = val.getTotalLength();
    val.style.strokeDasharray = arcValueLen;
    val.style.strokeDashoffset = arcValueLen;
    red.setAttribute('d', arcPath(A0 + (A1 - A0) * (car.redline / maxRpm), A1, R));

    var html = '';
    for (var i = 0; i <= steps; i++) {
      var frac = i / steps;
      var deg = A0 + (A1 - A0) * frac;
      var p1 = polar(deg, R - 14), p2 = polar(deg, R - (i % 2 === 0 ? 26 : 20));
      var lp = polar(deg, R - 44);
      var major = i % 2 === 0 ? ' class="major"' : '';
      html += '<line x1="' + p1[0].toFixed(1) + '" y1="' + p1[1].toFixed(1) + '" x2="' + p2[0].toFixed(1) + '" y2="' + p2[1].toFixed(1) + '"' + major + '/>';
      if (i % 2 === 0) {
        html += '<text x="' + lp[0].toFixed(1) + '" y="' + lp[1].toFixed(1) + '">' + i + '</text>';
      }
    }
    ticks.innerHTML = html;
    $('specRedline').textContent = car.redline;
    $('specGears').textContent = car.vehicle.gears.length + '-speed';
    paintGauge(0);
  }

  function paintGauge(rpm) {
    var car = CARS[S.carIndex];
    var maxRpm = Math.max(6, Math.ceil(car.redline / 1000)) * 1000;
    var frac = clamp(rpm / maxRpm, 0, 1);
    var deg = A0 + (A1 - A0) * frac;
    $('needle').style.transform = 'rotate(' + deg.toFixed(2) + 'deg)';
    $('arcValue').style.strokeDashoffset = (arcValueLen * (1 - frac)).toFixed(1);
    $('rpmValue').textContent = Math.round(rpm / 10) * 10;
  }

  // ------------------------------------------------------------------ chips -
  function chip(id, text, state) {
    var node = $(id);
    if (text != null) node.textContent = text;
    if (state) node.setAttribute('data-state', state);
    else node.removeAttribute('data-state');
  }

  function setStatus(text, cls) {
    var node = $('status');
    node.textContent = text;
    node.className = 'status' + (cls ? ' ' + cls : '');
  }

  // ------------------------------------------------------------- car picker -
  function buildCars() {
    var wrap = $('carPicker');
    wrap.innerHTML = '';
    CARS.forEach(function (car, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'car';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(i === S.carIndex));
      b.setAttribute('aria-label', car.name + ' — ' + car.tag);
      b.innerHTML = '<span class="car-name">' + car.name + '</span><span class="car-tag">' + car.tag + '</span>';
      b.addEventListener('click', function () { selectCar(i); });
      wrap.appendChild(b);
    });
  }

  function selectCar(i) {
    if (i === S.carIndex) return;
    var prev = S.carIndex;
    stopDemo();
    S.cruise = null;
    S.carIndex = i;
    var car = CARS[i];
    vehicle = new window.Vehicle(car.vehicle);
    S.rpm = car.idle;
    S.speed = 0;
    S.gear = 1;
    buildGauge();
    Array.prototype.forEach.call($('carPicker').children, function (b, j) {
      b.setAttribute('aria-checked', String(j === i));
    });
    chip('chipGear', 'N');
    audio.setCar(car.engine).then(function () {
      setStatus(car.name + ' loaded — ' + car.blurb, '');
      save();
    }).catch(function (err) {
      // Sample missing (e.g. the recording is not bundled): fall back.
      S.carIndex = prev;
      var p = CARS[prev];
      vehicle = new window.Vehicle(p.vehicle);
      S.rpm = p.idle;
      S.speed = 0;
      S.gear = 1;
      buildGauge();
      Array.prototype.forEach.call($('carPicker').children, function (b, j) {
        b.setAttribute('aria-checked', String(j === prev));
      });
      audio.setCar(p.engine).catch(function () { /* ignore */ });
      chip('chipGear', 'N');
      setStatus("Couldn't load the recording for " + car.name + ' — it is not bundled with this build. Kept ' + p.name + '.', 'err');
      save();
    });
  }

  // ---------------------------------------------------------------- pedals --
  function bindPedal(node, apply) {
    var pressed = false;

    function depth(e) {
      var r = node.getBoundingClientRect();
      if (!r.height) return 0.5;
      return clamp((e.clientY - r.top) / r.height, 0, 1);
    }

    node.addEventListener('pointerdown', function (e) {
      pressed = true;
      node.classList.add('active');
      try { node.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      apply(depth(e), true);
      e.preventDefault();
    });
    node.addEventListener('pointermove', function (e) {
      if (!pressed) return;
      apply(depth(e), true);
      e.preventDefault();
    });
    function release(e) {
      if (!pressed) return;
      pressed = false;
      node.classList.remove('active');
      apply(0, false);
      if (e) e.preventDefault();
    }
    node.addEventListener('pointerup', release);
    node.addEventListener('pointercancel', release);
    node.addEventListener('lostpointercapture', release);
    // iOS: a long press otherwise selects the label and pops the callout menu,
    // which also cancels the pointer stream mid-press.
    node.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    node.addEventListener('selectstart', function (e) { e.preventDefault(); });
  }

  function syncPedalVisual(node, amount) {
    node.style.setProperty('--fill', (amount * 100).toFixed(1) + '%');
  }

  // ---------------------------------------------------------------- sliders -
  function bindSlider(id, key, digits) {
    var input = $(id), out = $(id + 'Out');
    input.value = Math.round(S[key] * 100);
    out.textContent = input.value;
    input.addEventListener('input', function () {
      S[key] = parseFloat(input.value) / 100;
      out.textContent = input.value;
      save();
    });
  }

  // ------------------------------------------------------------- demo drive -
  var DEMO = [
    { d: 1.2, gas: 0.00, brake: 0 },   // idle
    { d: 0.35, gas: 1.00, brake: 0 },  // blip
    { d: 0.40, gas: 0.00, brake: 0 },
    { d: 8.6, gas: 0.95, brake: 0 },   // pull through the gears
    { d: 1.6, gas: 0.00, brake: 0 },   // lift: overrun crackle
    { d: 2.2, gas: 0.00, brake: 0.55 },// brake
    { d: 1.4, gas: 0.00, brake: 0 }    // settle to idle
  ];

  function startDemo() {
    var car = CARS[S.carIndex];
    vehicle = new window.Vehicle(car.vehicle);
    S.cruise = null;
    S.gas = 0; S.gasTarget = 0; S.brake = 0; S.brakeTarget = 0;
    S.demo = { i: 0, t: 0 };
    $('demoBtn').classList.add('on');
    setStatus('Demo run: idle, pull through the gears, lift off, brake.', '');
  }

  function stopDemo() {
    S.demo = null;
    $('demoBtn').classList.remove('on');
  }

  function demoInput(dt) {
    var d = S.demo;
    d.t += dt;
    while (d.i < DEMO.length && d.t > DEMO[d.i].d) {
      d.t -= DEMO[d.i].d;
      d.i++;
    }
    if (d.i >= DEMO.length) { stopDemo(); return { gas: 0, brake: 0 }; }
    return DEMO[d.i];
  }

  // ------------------------------------------------------------------- loop -
  function frame(now) {
    var dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    uiTick++;

    if (S.running) {
      var gas = 0, brake = 0;

      // Pedals ramp instead of snapping: a released pedal is a lift-off, not a
      // switch, and the smoothing is what makes a blip sound like a blip.
      var gasRate = 1 - Math.exp(-dt / 0.09);
      var brakeRate = 1 - Math.exp(-dt / 0.07);
      S.gas += (S.gasTarget - S.gas) * gasRate;
      S.brake += (S.brakeTarget - S.brake) * brakeRate;
      if (S.gas < 0.005) S.gas = 0;
      if (S.brake < 0.005) S.brake = 0;

      if (S.source === 'gps') {
        var st = vehicle.updateFromSpeed(dt, gps.speed, 0.6 + S.intensity);
        S.speed = st.speed; S.rpm = st.rpm; S.gear = st.gear;
        S.load = st.load; S.overrun = st.overrun; S.cut = st.cut; S.throttle = st.throttle;
      } else {
        if (S.demo) {
          var d = demoInput(dt);
          gas = d.gas; brake = d.brake;
          $('gasPedal').classList.toggle('active', gas > 0.02);
          $('brakePedal').classList.toggle('active', brake > 0.02);
        } else {
          gas = S.gas;
          brake = S.brake;
          // Top of the pedal is a cruise control: hold the speed it was pressed at.
          if (S.cruise) {
            var err = S.cruise.target - vehicle.speed;
            gas = clamp(0.10 + err * 0.6, 0, 0.85);
          }
        }
        var revving = now < S.revUntil;
        if (revving) {
          // Free rev only when stationary; on the move it is just a throttle blip.
          gas = S.speed < 1.2 ? Math.max(gas, 1) : Math.min(1, gas + 0.3);
        }

        st = vehicle.update(dt, { throttle: gas, brake: brake, intensity: 0.55 + S.intensity * 0.9 });
        S.speed = st.speed; S.rpm = st.rpm; S.gear = st.gear;
        S.load = st.load; S.overrun = st.overrun; S.cut = st.cut; S.throttle = st.throttle;
      }

      var engine = CARS[S.carIndex].engine;
      if (engine.type === 'sample') {
        audio.setRate(S.rpm / engine.nativeRpm);
      } else {
        audio.setParams({
          rpm: S.rpm,
          load: S.load,
          overrun: S.overrun,
          cut: S.cut,
          character: S.character,
          crackle: S.crackle,
          whine: S.whine,
          volume: S.volume
        });
      }
    } else {
      if (CARS[S.carIndex].engine.type === 'sample') audio.setRate(0);
      S.rpm += (CARS[S.carIndex].idle * 0.0 - S.rpm) * 0.2;
      S.speed = 0;
      S.load = 0;
      S.overrun = 0;
      S.cut = 0;
      S.throttle = 0;
    }

    // ---- audio watchdog (every ~0.5 s) ------------------------------------
    if (uiTick % 30 === 0 && S.running) watchdog();

    // ---- paint (half rate) ------------------------------------------------
    if (uiTick % 2 === 0) {
      paintGauge(S.rpm);
      $('speedValue').textContent = Math.round(speedInUnit(S.speed));
      $('throttleFill').style.width = (S.throttle * 100).toFixed(0) + '%';
      var gearText = S.running ? (S.speed < 0.6 && S.rpm < CARS[S.carIndex].idle + 400 ? 'N' : 'D' + S.gear) : 'N';
      if ($('chipGear').textContent !== gearText) $('chipGear').textContent = gearText;
    }

    requestAnimationFrame(frame);
  }

  /*
   * Two failures look identical to the user and both mean "no sound": the
   * browser suspended the context (iOS after backgrounding, a call or the lock
   * screen) or it is running but silent. Say which, and try to fix it.
   */
  function watchdog() {
    var st = audio.stateNow();
    if (st !== 'running') {
      chip('chipAudio', 'Audio paused', 'warn');
      setStatus('The browser paused the audio. Tap anywhere on the page to bring the engine back.', 'warn');
      audio.resume();
      return;
    }
    var idle = CARS[S.carIndex].idle;
    var expectSound = S.throttle > 0.12 || S.rpm > idle + 350;
    var lvl = audio.level();
    if (expectSound && lvl < 0.002) {
      S.silentTicks++;
      if (S.silentTicks >= 2 && !S.audioWarned) {
        S.audioWarned = true;
        chip('chipAudio', 'Audio silent', 'warn');
        setStatus('No sound is coming out — check the volume and the silent switch, or tap here to retry audio.', 'warn');
        audio.resume();
      }
    } else {
      S.silentTicks = 0;
      if (S.audioWarned) {
        S.audioWarned = false;
        chip('chipAudio', audio.worklet ? 'Audio live' : 'Audio live (basic)', 'ok');
        setStatus('Audio is back.', '');
      }
    }
  }

  function speedInUnit(ms) {
    return S.unit === 'mph' ? ms * 2.2369362920544 : ms * 3.6;
  }

  // ------------------------------------------------------------------- GPS --
  function gpsState(s, detail) {
    var map = {
      idle: ['GPS idle', null],
      requesting: ['GPS asking…', 'warn'],
      active: ['GPS lock ' + (detail || ''), 'ok'],
      denied: ['GPS blocked', 'err'],
      error: ['GPS error', 'err'],
      unavailable: ['No GPS', 'err']
    };
    var m = map[s] || ['GPS ' + s, null];
    chip('chipGps', m[0], m[1]);
    if (s === 'denied') {
      setStatus('Location is blocked. Without GPS speed there is no engine — allow location for this site, then pick GPS speed again. Test drive still works.', 'err');
      if (S.source === 'gps') setSource('demo');
    } else if (s === 'unavailable') {
      setStatus('This browser has no location API (or the page is not on HTTPS). Test drive still works.', 'err');
      if (S.source === 'gps') setSource('demo');
    } else if (s === 'active' && S.source === 'gps') {
      setStatus('GPS speed is driving the engine. Keep this page in the foreground.', '');
    }
  }

  function setSource(src) {
    S.source = src;
    Array.prototype.forEach.call($('sourceSeg').children, function (b) {
      b.setAttribute('aria-checked', String(b.dataset.source === src));
    });
    var gpsOn = src === 'gps';
    $('pedalsGroup').style.display = gpsOn ? 'none' : '';
    $('specSource').textContent = gpsOn ? 'GPS speed' : 'Test drive';
    if (gpsOn) {
      stopDemo();
      vehicle = new window.Vehicle(CARS[S.carIndex].vehicle);
      gps.start(null, gpsState);
      if (S.running) setStatus('Waiting for a GPS fix — the engine needs your speed.', 'warn');
    } else {
      gps.stop();
      if (S.running) setStatus('Test drive: press the pedals. The lower you press, the harder.', '');
    }
    save();
  }

  // ------------------------------------------------------------------ start -
  async function startEngine() {
    var car = CARS[S.carIndex];
    $('startBtn').setAttribute('aria-pressed', 'true');
    $('startLabel').textContent = 'Stop engine';
    setStatus('Starting…', '');
    try {
      var info = await audio.start(car.engine);
      S.running = true;
      vehicle = new window.Vehicle(car.vehicle);
      audio.setParams({
        rpm: car.idle, load: 0, overrun: 0, cut: 0,
        character: S.character, crackle: S.crackle, whine: S.whine, volume: S.volume
      });
      if (info.state === 'running') {
        chip('chipAudio', info.worklet ? 'Audio live' : 'Audio live (basic)', 'ok');
        if (S.source === 'gps') {
          gps.start(null, gpsState);
          setStatus('Waiting for a GPS fix — the engine follows your speed.', 'warn');
        } else {
          setStatus('Engine running. Press the gas pedal — or hit Rev.', '');
        }
      } else {
        // iOS: the context stayed suspended. One tap anywhere resumes it.
        chip('chipAudio', 'Tap to enable audio', 'warn');
        setStatus('The browser started the engine paused. Tap anywhere on the page to hear it.', 'warn');
      }
      keepAwake();
    } catch (err) {
      S.running = false;
      $('startBtn').setAttribute('aria-pressed', 'false');
      $('startLabel').textContent = 'Start engine';
      chip('chipAudio', 'Audio failed', 'err');
      setStatus('Could not start audio: ' + (err && err.message ? err.message : 'unknown error') + '. Tap Start engine again, or check the browser audio permission.', 'err');
    }
  }

  function stopEngine() {
    audio.stop();
    S.running = false;
    stopDemo();
    S.cruise = null;
    S.gas = 0; S.gasTarget = 0; S.brake = 0; S.brakeTarget = 0;
    $('startBtn').setAttribute('aria-pressed', 'false');
    $('startLabel').textContent = 'Start engine';
    chip('chipAudio', 'Audio idle', null);
    chip('chipGear', 'N');
    $('gasPedal').classList.remove('active');
    $('brakePedal').classList.remove('active');
    setStatus('Engine stopped.', '');
    releaseAwake();
  }

  // -------------------------------------------------------------- wake lock -
  async function keepAwake() {
    try {
      if ('wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', function () { wakeLock = null; });
      }
    } catch (e) { /* not supported / denied */ }
  }
  function releaseAwake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
  }

  // ------------------------------------------------------------------- init -
  function init() {
    load();

    buildCars();
    buildGauge();
    setSource(S.source);
    Array.prototype.forEach.call($('unitSeg').children, function (b) {
      b.setAttribute('aria-checked', String(b.dataset.unit === S.unit));
    });
    $('speedUnit').textContent = S.unit === 'mph' ? 'mph' : 'km/h';

    bindSlider('volume', 'volume');
    bindSlider('intensity', 'intensity');
    bindSlider('character', 'character');
    bindSlider('crackle', 'crackle');
    bindSlider('whine', 'whine');

    bindPedal($('gasPedal'), function (depth, pressed) {
      if (!pressed) {
        S.gasTarget = 0;
        S.cruise = null;
        syncPedalVisual($('gasPedal'), 0);
        return;
      }
      if (depth < 0.24) {
        // Top of the pedal: hold the speed it was pressed at, like a cruise.
        if (!S.cruise) S.cruise = { target: Math.max(vehicle.speed, 2.5) };
        S.gasTarget = 0.4;
      } else {
        S.cruise = null;
        S.gasTarget = 0.12 + 0.88 * depth;
      }
      syncPedalVisual($('gasPedal'), depth);
    });
    bindPedal($('brakePedal'), function (depth, pressed) {
      S.brakeTarget = pressed ? 0.12 + 0.88 * depth : 0;
      if (!pressed) S.cruise = null;
      syncPedalVisual($('brakePedal'), pressed ? depth : 0);
    });

    $('startBtn').addEventListener('click', function () {
      if (S.running) stopEngine(); else startEngine();
    });

    $('revBtn').addEventListener('click', function () {
      var blip = function () { S.revUntil = performance.now() + 420; };
      if (!S.running) { startEngine().then(blip); return; }
      blip();
    });

    $('demoBtn').addEventListener('click', function () {
      if (S.demo) { stopDemo(); setStatus('Demo stopped.', ''); return; }
      if (S.source === 'gps') setSource('demo');
      if (!S.running) { startEngine(); }
      startDemo();
    });

    Array.prototype.forEach.call($('sourceSeg').children, function (b) {
      b.addEventListener('click', function () { setSource(b.dataset.source); });
    });

    Array.prototype.forEach.call($('unitSeg').children, function (b) {
      b.addEventListener('click', function () {
        S.unit = b.dataset.unit;
        Array.prototype.forEach.call($('unitSeg').children, function (o) {
          o.setAttribute('aria-checked', String(o.dataset.unit === S.unit));
        });
        $('speedUnit').textContent = S.unit === 'mph' ? 'mph' : 'km/h';
        save();
      });
    });

    $('helpLink').addEventListener('click', function (e) {
      e.preventDefault();
      var h = document.querySelector('.help');
      h.open = !h.open;
      if (h.open) h.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    document.addEventListener('keydown', function (e) {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (e.code === 'Space' || e.key === 'r') { e.preventDefault(); S.revUntil = performance.now() + 420; }
    });

    /*
     * Backgrounding: the browser suspends the audio context anyway, so pause
     * explicitly to keep state honest. Coming back needs a resume that iOS may
     * refuse without a gesture — resume() arms a one-tap handler if so.
     */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (S.running) audio.pause();
      } else {
        last = performance.now();
        keepAwake();
        if (S.running) audio.resume();
      }
    });
    window.addEventListener('pageshow', function () {
      last = performance.now();
      if (S.running && audio.stateNow() !== 'running') audio.resume();
    });

    // Audio status -> chip, wherever the change came from.
    audio.onState = function (s) {
      if (s === 'running' || s === 'resumed') {
        chip('chipAudio', audio.worklet ? 'Audio live' : 'Audio live (basic)', 'ok');
      } else if (s === 'suspended') {
        chip('chipAudio', 'Tap to enable audio', 'warn');
      } else if (s === 'idle') {
        chip('chipAudio', 'Audio idle', null);
      }
    };

    document.addEventListener('contextmenu', function (e) {
      if (e.target && e.target.closest && e.target.closest('.pedal, .start, .mini, .car')) e.preventDefault();
    });

    gps.onState = gpsState;

    if (/[?&]debug/.test(location.search)) {
      window.__engine = { state: S, audio: audio, gps: gps, vehicle: function () { return vehicle; }, CARS: CARS };
    }

    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
