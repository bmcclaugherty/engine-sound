# Engine Sound

A gas-engine sound for your EV, synthesized live in the browser from your speed.
A cross-plane V8, a V12 or a flat-six, revving with your actual GPS speed through
a gearbox model and played out of the car's speakers. It runs in the Tesla
browser (or any modern browser), needs no app and no account, and it is free —
there is no daily limit, paywall or tracking here.

Live: https://bmcclaugherty.github.io/engine-sound/

**Use it in the car:** park, open the page in the car browser, bookmark it, press
*Start engine*, allow location, turn the media volume up. Keep the page in the
foreground — the sound stops when the browser goes to the background. Play
Spotify or the radio as usual; the engine mixes in on top.

**Use it anywhere else:** press *Start engine*, pick *Test drive* and work the
on-screen pedals (press lower for more throttle, the top of the gas pedal holds
your speed), or hit *Rev* / *Demo run*.

## How it works

Everything is generated per sample; there are no audio files.

- **Firing events.** One 4-stroke cycle is 720° of crank, and the synth walks a
  crank phase and fires one cylinder at a time around that cycle. Firing
  frequency is therefore `rpm / 60 × cylinders / 2` — 200 Hz for a V8 at
  3000 rpm, 300 Hz for a V12.
- **Exhaust pulse.** Each firing injects a short deterministic pressure pulse
  (fast attack, short decay, a smaller valve-close bump) into its cylinder
  bank. It is deterministic on purpose: the engine note *is* the harmonic
  series of the firing rate, so randomising each pulse would smear it into
  noise. Texture comes from continuous noise layers plus a little scatter
  between firings.
- **Voicing.** Per bank: a resonant body low-pass, a pipe-resonance peak and up
  to three formant band-passes. Biquads rather than delay-line waveguides — a
  comb with realistic feedback has narrow peaks and wide notches and guts the
  harmonic series whenever the firing rate lands between resonances.
- **The rest of the engine.** Intake roar, mechanical noise, supercharger /
  gear whine and afterfire pops, then a muffler low-pass, soft saturation and a
  DC blocker. Ignition cut (shifts, rev limiter) replaces the bang with an
  unburnt hiss, which is what makes a limiter sound like a limiter.
- **Drivetrain.** Throttle and brake drive a simple longitudinal model; speed
  goes through gear ratios, final drive and wheel radius to give rpm, with
  clutch slip off the line, automatic shifts with ignition cut, engine braking
  and overrun (which is what turns the crackle on). In GPS mode the car
  supplies the speed and the drivetrain infers gear, rpm and throttle from how
  fast that speed is changing.

The DSP runs in an `AudioWorklet` (falling back to a `ScriptProcessorNode` where
worklets are unavailable), so UI jank cannot interrupt the sound.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | the whole app: gauge, pedals, controls, help |
| `css/style.css` | dark instrument-cluster styling, responsive |
| `js/engine-dsp.js` | the synthesizer; loads both as a worklet and as a classic script |
| `js/cars.js` | engine + drivetrain presets (firing pattern, pipes, formants, gearbox) |
| `js/vehicle.js` | gearbox, clutch slip, shifts, limiter, overrun |
| `js/gps.js` | location speed with smoothing and bad-fix rejection |
| `js/audio.js` | audio graph, worklet transport, car-switch ducking |
| `js/app.js` | input loop, gauge painting, UI wiring |
| `tools/render-test.js` | offline render + level/DC/NaN sanity check |

## Adding an engine

Add an entry to `js/cars.js`. `firing` is one entry per cylinder per 720° cycle,
`0` for the left bank and `1` for the right, in firing order. `pipeFreq` is where
the exhaust pipe resonates, `formants` shapes the note, `muffler` is the
cutoff. Lower `q` values give a broader, less vocal tone. Idle and redline are
set on the car and copied into both blocks.

## Local development

```sh
python3 -m http.server 8899      # then open http://127.0.0.1:8899
node tools/render-test.js        # renders test tones, reports levels and DC
```

Location needs `https://` or `localhost`; on plain `http://` from another host
the browser will refuse GPS and the app will say so.

## Deploying

Static files, no build step. Push to `main` and GitHub Pages serves the repo
root; `.nojekyll` keeps Jekyll out of the way.
