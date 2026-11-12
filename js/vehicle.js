/*
 * vehicle.js — drivetrain simulation.
 *
 * Turns a throttle / brake input into speed, and speed into engine rpm through
 * a gearbox, so the synthesizer gets the rpm and the load that go with what the
 * car is actually doing: pulling, cruising, engine braking or bouncing off the
 * limiter. In GPS mode the speed comes from the phone / car instead of the
 * simulation and only the gearbox and rpm are simulated.
 */
(function (G) {
  'use strict';

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  // Normalised torque: soft off idle, peak around 55% of redline, tapering.
  function torqueFactor(rpm, c) {
    var peak = c.idle + (c.redline - c.idle) * 0.55;
    if (rpm < peak) return 0.62 + 0.38 * clamp((rpm - c.idle) / (peak - c.idle), 0, 1);
    return 1 - 0.30 * clamp((rpm - peak) / (c.redline - peak), 0, 1);
  }

  function Vehicle(cfg) {
    this.cfg = cfg;
    this.reset();
  }

  Vehicle.prototype.reset = function () {
    this.speed = 0;          // m/s
    this.rpm = this.cfg.idle;
    this.gear = 1;
    this.shiftTimer = 0;
    this.prevSpeed = 0;
    this.cut = 0;
  };

  Vehicle.prototype.rpmAt = function (speed, gear) {
    var c = this.cfg;
    var wheelRpm = (Math.abs(speed) / (2 * Math.PI * c.wheelR)) * 60;
    return wheelRpm * c.gears[gear - 1] * c.finalDrive;
  };

  Vehicle.prototype.shiftLogic = function (gearRpm, throttle) {
    var c = this.cfg;
    if (this.shiftTimer > 0) return;
    if (this.gear < c.gears.length && gearRpm > c.shiftUp && throttle > 0.25) {
      this.gear++;
      this.shiftTimer = 0.17;
    } else if (this.gear > 1 && gearRpm < c.shiftDown && throttle < 0.5) {
      this.gear--;
      this.shiftTimer = 0.13;
    }
  };

  /**
   * Simulated drive cycle.
   * @param {number} dt seconds
   * @param {{throttle:number, brake:number, intensity:number}} input
   */
  Vehicle.prototype.update = function (dt, input) {
    var c = this.cfg;
    var throttle = clamp(input.throttle || 0, 0, 1);
    var brake = clamp(input.brake || 0, 0, 1);
    var intensity = input.intensity == null ? 1 : input.intensity;

    if (this.shiftTimer > 0) this.shiftTimer = Math.max(0, this.shiftTimer - dt);

    var gearRpm = this.rpmAt(this.speed, this.gear);
    if (this.speed > 0.8) this.shiftLogic(gearRpm, throttle);

    // ---- longitudinal forces ---------------------------------------------
    var torque = torqueFactor(gearRpm, c);
    var drive = throttle * torque * c.maxAccel * intensity;
    var resist = c.drag * this.speed * this.speed + (this.speed > 0.15 ? c.roll : 0);
    var braking = brake * c.brakeAccel;
    // Closed throttle above idle: engine braking through the driveline.
    var engineBrake = throttle < 0.06 && this.speed > 1 ? 0.9 * torque : 0;
    this.speed = Math.max(0, this.speed + (drive - resist - braking - engineBrake) * dt);

    // ---- rpm --------------------------------------------------------------
    var free = c.idle + throttle * (c.redline * 0.58 - c.idle);
    var slip = clamp(1 - this.speed / 3.2, 0, 1);      // clutch slip off the line
    var target;
    if (this.shiftTimer > 0) target = Math.max(c.idle, gearRpm * 0.90);
    else target = gearRpm * (1 - slip) + free * slip;

    var limiter = target > c.redline ? c.redline : target;
    var tau = limiter > this.rpm ? 0.075 / intensity : 0.11;
    this.rpm += (limiter - this.rpm) * (1 - Math.exp(-dt / tau));
    this.rpm = clamp(this.rpm, c.idle * 0.9, c.redline);

    // ---- combustion state --------------------------------------------------
    var onLimiter = this.rpm >= c.redline - 25 && throttle > 0.3;
    this.cut = this.shiftTimer > 0 || onLimiter ? 1 : 0;
    var overrun = throttle < 0.07 && this.rpm > c.idle + 450 ? 1 : 0;
    var load = throttle * (0.72 + 0.28 * torque);
    if (this.shiftTimer > 0) load *= 0.0;

    return {
      speed: this.speed,
      rpm: this.rpm,
      gear: this.gear,
      load: this.cut ? load * 0.0 : load,
      overrun: overrun,
      cut: this.cut,
      throttle: throttle
    };
  };

  /**
   * GPS / external speed mode: the car supplies the speed, we supply the
   * gearbox, the rpm and an estimated throttle from how fast speed is changing.
   */
  Vehicle.prototype.updateFromSpeed = function (dt, speed, intensity) {
    var c = this.cfg;
    intensity = intensity == null ? 1 : intensity;
    speed = Math.max(0, speed || 0);

    if (this.shiftTimer > 0) this.shiftTimer = Math.max(0, this.shiftTimer - dt);

    var accel = dt > 0 ? (speed - this.prevSpeed) / dt : 0;
    this.prevSpeed = speed;
    this.speed = speed;

    var gearRpm = this.rpmAt(speed, this.gear);
    this.shiftLogic(gearRpm, accel > 0.2 ? 1 : 0);

    var target = gearRpm;
    if (this.shiftTimer > 0) target = Math.max(c.idle, gearRpm * 0.92);
    if (speed < 1.2) target = c.idle;
    this.rpm += (clamp(target, c.idle, c.redline) - this.rpm) * (1 - Math.exp(-dt / 0.12));

    var throttle = clamp(accel * 0.28 * intensity, 0, 1);
    if (speed < 0.5) throttle = 0;
    var overrun = throttle < 0.07 && this.rpm > c.idle + 450 ? 1 : 0;
    var onLimiter = this.rpm >= c.redline - 25;
    this.cut = this.shiftTimer > 0 || onLimiter ? 1 : 0;

    return {
      speed: speed,
      rpm: this.rpm,
      gear: this.gear,
      load: this.cut ? 0 : throttle,
      overrun: overrun,
      cut: this.cut,
      throttle: throttle
    };
  };

  G.Vehicle = Vehicle;
})(typeof globalThis !== 'undefined' ? globalThis : this);
