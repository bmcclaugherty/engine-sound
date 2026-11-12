/*
 * gps.js — speed from the device's location.
 *
 * Uses coords.speed when the platform provides it and falls back to distance
 * over time between fixes. Readings are smoothed with a short exponential
 * average and rejected when they are physically impossible, because a single
 * bad fix would otherwise make the engine scream for a moment.
 */
(function (G) {
  'use strict';

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLon = (lon2 - lon1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function GPS() {
    this.watchId = null;
    this.state = 'idle';
    this.speed = 0;          // m/s, smoothed
    this.accuracy = null;
    this.lastFix = 0;
    this.prev = null;        // previous position
    this.onUpdate = null;
    this.onState = null;
    this.staleTimer = null;
  }

  GPS.prototype.supported = function () {
    return !!(navigator.geolocation && (window.isSecureContext !== false));
  };

  GPS.prototype.setState = function (s, detail) {
    if (this.state === s) return;
    this.state = s;
    if (this.onState) this.onState(s, detail || '');
  };

  GPS.prototype.start = function (onUpdate, onState) {
    var self = this;
    this.onUpdate = onUpdate;
    this.onState = onState;
    if (!this.supported()) {
      this.setState('unavailable');
      return false;
    }
    if (this.watchId != null) return true;
    this.setState('requesting');
    this.watchId = navigator.geolocation.watchPosition(
      function (pos) { self.handle(pos); },
      function (err) {
        if (err && err.code === 1) self.setState('denied', err.message);
        else self.setState('error', (err && err.message) || 'location error');
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
    return true;
  };

  GPS.prototype.handle = function (pos) {
    var c = pos.coords;
    var now = pos.timestamp || Date.now();
    var raw = null;

    var reported = (typeof c.speed === 'number' && isFinite(c.speed) && c.speed > 0.4) ? c.speed : null;
    var derived = null;
    if (this.prev) {
      var dt = (now - this.prev.t) / 1000;
      if (dt > 0.2 && dt < 30) {
        derived = haversine(this.prev.lat, this.prev.lon, c.latitude, c.longitude) / dt;
      }
    }
    // Some platforms report speed as 0 even while moving, so fall back to the
    // distance between fixes whenever the reported value looks like a stall.
    raw = reported != null ? reported : (derived != null && derived > 0.4 ? derived : null);
    if (raw == null && derived != null) raw = derived;
    this.prev = { lat: c.latitude, lon: c.longitude, t: now };
    this.accuracy = c.accuracy;

    if (raw != null && isFinite(raw)) {
      // Reject impossible jumps (a bad fix can report hundreds of m/s).
      var jump = Math.abs(raw - this.speed);
      var plausible = jump < 18 || raw < 1.5;
      if (plausible) {
        var k = 0.35;
        this.speed += (raw - this.speed) * k;
        if (this.speed < 0.35) this.speed = 0;
      }
    }

    this.lastFix = Date.now();
    this.setState('active', (c.accuracy ? Math.round(c.accuracy) + ' m' : ''));
    if (this.onUpdate) this.onUpdate(this.speed, this);
  };

  GPS.prototype.stop = function () {
    if (this.watchId != null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this.speed = 0;
    this.prev = null;
    this.setState('idle');
  };

  GPS.prototype.age = function () {
    return this.lastFix ? (Date.now() - this.lastFix) / 1000 : Infinity;
  };

  G.GPS = GPS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
