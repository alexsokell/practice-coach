// Sound for the browser app: a small piano-like synth (for the on-screen keys and
// the "Listen" demo) and a metronome whose beat times can be compared with note times.
//
// Everything is silent and harmless until resume() has been called from a user
// gesture, because browsers block audio before that.

const MAX_VOICES = 24;
const LOOKAHEAD_SEC = 0.12; // how far ahead clicks and demo notes are scheduled
const TICK_MS = 25;

/**
 * @typedef {Object} Voice
 * @property {number} midi
 * @property {number} start        engine-clock time the note sounds
 * @property {boolean} released
 * @property {GainNode} gain
 * @property {OscillatorNode[]} oscillators
 */

export class AudioEngine {
  /** @param {{AudioContextClass?: typeof AudioContext}} [options] */
  constructor({ AudioContextClass } = {}) {
    this._Context = AudioContextClass ?? globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null;
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    /** @type {Voice[]} */
    this.voices = [];
    this._resuming = null;
    this._metronome = null;
  }

  /** True once sound can actually be produced. */
  get ready() {
    return Boolean(this.ctx && this.ctx.state === 'running');
  }

  /** Delay between scheduling a sound and hearing it, in ms (0 when the browser does not say). */
  get outputLatencyMs() {
    if (!this.ctx) return 0;
    const seconds = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
  }

  /**
   * Create or wake the AudioContext. Call from a click, key press or touch.
   * Safe to call as often as you like. Resolves to `ready`.
   */
  async resume() {
    if (!this._Context) return false;
    if (this.ready) return true;
    if (this._resuming) return this._resuming;
    this._resuming = (async () => {
      try {
        if (!this.ctx || this.ctx.state === 'closed') this.#build();
        if (this.ctx.state !== 'running') await this.ctx.resume();
      } catch {
        // Autoplay policy or no audio device: stay silent.
      }
      return this.ready;
    })();
    try {
      return await this._resuming;
    } finally {
      this._resuming = null;
    }
  }

  setVolume(value) {
    const v = Math.max(0, Math.min(1, Number(value)));
    this.volume = Number.isFinite(v) ? v : this.volume;
    if (this.master) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  /**
   * Start a note. `whenSec` is a time on the AudioContext clock; leave it out for "now".
   * @param {number} midi  @param {number} [velocity]  @param {number} [whenSec]
   */
  noteOn(midi, velocity = 80, whenSec) {
    if (!this.ready || !Number.isFinite(midi)) return null;
    const ctx = this.ctx;
    const t = Math.max(ctx.currentTime, whenSec ?? ctx.currentTime);
    const vel = Math.max(1, Math.min(127, velocity || 1)) / 127;
    const freq = 440 * 2 ** ((midi - 69) / 12);

    this.#makeRoom();

    // Body: a mellow triangle plus two quiet sine partials, brighter when struck harder.
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(11000, Math.max(700, freq * (2.5 + 6 * vel))), t);
    filter.Q.value = 0.4;

    const partials = [
      { type: 'triangle', ratio: 1, level: 1 },
      { type: 'sine', ratio: 2.001, level: 0.28 + 0.25 * vel },
      { type: 'sine', ratio: 3.002, level: 0.06 + 0.14 * vel },
    ];
    const oscillators = partials.map(({ type, ratio, level }) => {
      const osc = ctx.createOscillator();
      const partialGain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq * ratio, t);
      partialGain.gain.value = level;
      osc.connect(partialGain).connect(filter);
      osc.start(t);
      return osc;
    });
    filter.connect(gain).connect(this.master);

    // Piano-like envelope: fast attack, then a decay that is longer for low notes.
    const peak = 0.05 + 0.3 * vel ** 1.5;
    const decay = 0.35 + 1.4 * 2 ** (-(midi - 36) / 24);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.006);
    gain.gain.setTargetAtTime(peak * 0.02, t + 0.006, decay);
    // Darken the tone as it rings on, like a real string.
    filter.frequency.setTargetAtTime(Math.max(500, freq * 1.6), t + 0.02, decay * 0.8);

    /** @type {Voice} */
    const voice = { midi, start: t, released: false, gain, oscillators };
    oscillators[0].onended = () => {
      const at = this.voices.indexOf(voice);
      if (at !== -1) this.voices.splice(at, 1);
      gain.disconnect();
    };
    // Safety net: nothing rings forever, even if a note-off never arrives.
    for (const osc of oscillators) osc.stop(t + decay * 6 + 1);
    this.voices.push(voice);
    return voice;
  }

  /** Release the oldest sounding voice of this pitch. */
  noteOff(midi, whenSec) {
    if (!this.ctx) return;
    const t = Math.max(this.ctx.currentTime, whenSec ?? this.ctx.currentTime);
    const voice = this.voices.find((v) => v.midi === midi && !v.released && v.start <= t + 0.001);
    if (voice) this.#release(voice, t, 0.07);
  }

  allNotesOff() {
    if (!this.ctx) return;
    for (const voice of [...this.voices]) this.#release(voice, this.ctx.currentTime, 0.03);
  }

  /**
   * Play an exercise's steps as a demo.
   * onStep(index) fires on the main thread as each step sounds.
   * Works without sound too (before resume), so the visual walk-through still runs.
   * @param {{notes: number[], beats: number}[]} steps
   * @param {{bpm?: number, onStep?: (index: number) => void, velocity?: number}} [options]
   * @returns {{stop(): void, done: Promise<void>}}
   */
  playSteps(steps, { bpm = 60, onStep, velocity = 76 } = {}) {
    const beatSec = 60 / Math.max(20, Math.min(300, bpm || 60));
    const list = Array.isArray(steps) ? steps : [];
    const origin = this.#now() + 0.1;
    const starts = [];
    let cursor = origin;
    for (const step of list) {
      starts.push(cursor);
      cursor += Math.max(0.05, (Number(step?.beats) || 1) * beatSec);
    }
    const end = cursor;

    const timers = new Set();
    const voices = [];
    let next = 0;
    let finished = false;
    let resolveDone;
    const done = new Promise((resolve) => (resolveDone = resolve));

    const later = (fn, atSec) => {
      const id = setTimeout(() => {
        timers.delete(id);
        if (!finished) fn();
      }, Math.max(0, (atSec - this.#now()) * 1000));
      timers.add(id);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(interval);
      for (const id of timers) clearTimeout(id);
      timers.clear();
      resolveDone();
    };
    const schedule = () => {
      const horizon = this.#now() + LOOKAHEAD_SEC * 2;
      while (next < list.length && starts[next] <= horizon) {
        const index = next;
        const step = list[index];
        const at = starts[index];
        const length = (index + 1 < list.length ? starts[index + 1] : end) - at;
        for (const midi of step?.notes ?? []) {
          const voice = this.noteOn(midi, velocity, at);
          if (voice) {
            voices.push(voice);
            this.#release(voice, at + length * 0.9, 0.08);
          }
        }
        later(() => onStep?.(index), at);
        next += 1;
      }
      if (next >= list.length && !timers.size) later(finish, end);
    };
    const interval = setInterval(schedule, TICK_MS * 2);
    schedule();
    if (!list.length) finish();

    return {
      stop: () => {
        if (finished) return;
        if (this.ctx) for (const voice of voices) this.#release(voice, this.ctx.currentTime, 0.03, true);
        finish();
      },
      done,
    };
  }

  /**
   * Start the metronome. Clicks are scheduled on the audio clock a little ahead of time.
   * onBeat(beatIndex, perfTimeMs) reports each click with the performance.now() time at
   * which it is HEARD. beatIndex starts at -countInBeats; beat 0 is the first beat of the exercise.
   * @param {{bpm: number, beatsPerBar?: number, countInBeats?: number, onBeat?: (beatIndex: number, perfTimeMs: number) => void}} options
   * @returns {{startPerfMs: number, stop(): void}}  startPerfMs = heard time of beat 0
   */
  startMetronome({ bpm, beatsPerBar = 4, countInBeats = 4, onBeat } = {}) {
    this.stopMetronome();
    const beatSec = 60 / Math.max(20, Math.min(300, bpm || 60));
    const bar = Math.max(1, Math.round(beatsPerBar) || 4);
    const countIn = Math.max(0, Math.round(countInBeats) || 0);
    const origin = this.#now() + 0.15; // engine-clock time of the first click
    const toPerf = this.#perfMapper();
    let beat = -countIn;
    let stopped = false;

    const timeOf = (index) => origin + (index + countIn) * beatSec;
    const tick = () => {
      if (stopped) return;
      const horizon = this.#now() + LOOKAHEAD_SEC;
      while (timeOf(beat) <= horizon) {
        const at = timeOf(beat);
        const downbeat = ((beat % bar) + bar) % bar === 0;
        this.#click(at, downbeat);
        try {
          onBeat?.(beat, toPerf(at));
        } catch {
          // A broken listener must not stop the click.
        }
        beat += 1;
      }
    };
    const interval = setInterval(tick, TICK_MS);
    const handle = {
      startPerfMs: toPerf(timeOf(0)),
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(interval);
        if (this._metronome === handle) this._metronome = null;
      },
    };
    this._metronome = handle;
    tick();
    return handle;
  }

  stopMetronome() {
    this._metronome?.stop();
  }

  // ---------------------------------------------------------------- internals

  #build() {
    const ctx = new this._Context({ latencyHint: 'interactive' });
    const master = ctx.createGain();
    master.gain.value = this.volume;
    // A gentle limiter so chords never clip.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 12;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    master.connect(limiter).connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
    this.voices = [];
  }

  /** Engine clock in seconds: the audio clock when sound is on, else the performance clock. */
  #now() {
    return this.ready ? this.ctx.currentTime : performance.now() / 1000;
  }

  /** Returns a function mapping engine-clock seconds to performance.now() ms at which that moment is heard. */
  #perfMapper() {
    if (!this.ready) return (seconds) => seconds * 1000;
    const ctx = this.ctx;
    const stamp = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    if (stamp && stamp.contextTime > 0 && stamp.performanceTime > 0) {
      // getOutputTimestamp pairs "sample leaving the speakers" with wall time, so latency is already included.
      return (seconds) => stamp.performanceTime + (seconds - stamp.contextTime) * 1000;
    }
    const perfNow = performance.now();
    const ctxNow = ctx.currentTime;
    const latency = this.outputLatencyMs;
    return (seconds) => perfNow + (seconds - ctxNow) * 1000 + latency;
  }

  #click(atSec, accent) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = Math.max(ctx.currentTime, atSec);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(accent ? 1760 : 1175, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(accent ? 0.55 : 0.35, t + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.05);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.07);
    osc.onended = () => gain.disconnect();
  }

  /** Fade a voice out. `hard` also silences a voice that has not started sounding yet. */
  #release(voice, atSec, timeConstant, hard = false) {
    if (voice.released && !hard) return;
    voice.released = true;
    const ctx = this.ctx;
    const t = Math.max(ctx.currentTime, hard ? ctx.currentTime : atSec);
    const param = voice.gain.gain;
    if (typeof param.cancelAndHoldAtTime === 'function') param.cancelAndHoldAtTime(t);
    else param.cancelScheduledValues(t);
    param.setTargetAtTime(0, t, timeConstant);
    const stopAt = t + timeConstant * 8 + 0.02;
    for (const osc of voice.oscillators) {
      try {
        osc.stop(stopAt);
      } catch {
        // already stopped
      }
    }
  }

  /** Voice stealing: when too many notes ring, fade the oldest. */
  #makeRoom() {
    const sounding = this.voices.filter((v) => !v.released);
    for (let i = 0; i <= sounding.length - MAX_VOICES; i += 1) {
      this.#release(sounding[i], this.ctx.currentTime, 0.02);
    }
  }
}
