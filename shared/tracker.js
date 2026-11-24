// The "ears" of Practice Coach: AttemptTracker follows one play-through of an exercise (wait mode
// or tempo mode) and FreePlayAnalyzer summarizes free playing phrase by phrase.
// Pure and isomorphic: no DOM, no Node built-ins, no top-level side effects. Nothing here throws
// on bad input from a device or from the model: bad notes are ignored, bad numbers fall back.

import { pitchClass } from './midi.js';
import { detectChord, estimateKey, spellMidi } from './theory.js';

/** @typedef {'pending'|'current'|'ok'|'error'|'missed'} StepState */

/** @typedef {Object} NoteJudgement
 * @property {'correct'|'wrong'|'extra'|'ignored'} kind
 * @property {number} stepIndex      0-based step the note was judged against
 * @property {boolean} stepCompleted true when this note completed that step
 * @property {boolean} finished      true when the attempt is over
 * @property {number[]} expected     MIDI notes of that step
 * @property {number|null} offsetMs  tempo mode, matched notes only: signed, positive = late
 */

/** @typedef {Object} StepResult
 * @property {number} index
 * @property {StepState} state
 * @property {number[]} wrong        MIDI numbers. Wait mode: wrong keys pressed while the step was
 *   current. Tempo mode: unmatched keys charged to this step: its own key struck outside the
 *   window, or any other key played nearest to it (at most 32 are kept).
 * @property {number[]} missed       expected MIDI notes that were never hit (tempo mode)
 * @property {number|null} ioiMs     time since the previous played step
 * @property {number|null} offsetMs  tempo mode: mean signed offset of the matched notes
 * @property {number|null} velocity  mean velocity of the strikes that made the step
 * @property {number|null} chordSpreadMs  multi-note steps: last strike minus first strike
 */

/** @typedef {Object} AttemptResult
 * @property {string} exerciseId
 * @property {'wait'|'tempo'} mode
 * @property {number} bpm
 * @property {boolean} completed
 * @property {number} durationMs
 * @property {StepResult[]} steps    one entry per exercise step, rests included
 * @property {{steps: number, played: number, clean: number, wrongNotes: number, mistimed: number, missed: number,
 *   extra: number, accuracy: number}} totals   steps = playable steps (rests are not counted);
 *   missed = expected notes never hit; extra = tempo-mode notes outside the exercise's time span;
 *   accuracy = clean / steps, 0..1
 * @property {{estBpm: number|null, evennessCv: number|null,
 *   hesitations: {index: number, factor: number}[], meanOffsetMs: number|null,
 *   offsetSdMs: number|null, driftMsPerBeat: number|null}} timing
 * @property {{mean: number|null, sd: number|null, min: number|null, max: number|null}} dynamics
 * @property {{index: number, names: string[],
 *   reason: 'wrong_notes'|'hesitation'|'missed'|'late'|'early'}[]} troubleSpots
 */

/** @typedef {Object} PhraseSummary
 * @property {number} startMs
 * @property {number} durationMs
 * @property {number} noteCount
 * @property {{midi: number, name: string, onMs: number, durMs: number, velocity: number|null}[]} notes
 * @property {{low: number, high: number}} range
 * @property {{name: string, atMs: number}[]} chords
 * @property {{tonic: string, mode: string, confidence: number}|null} key
 * @property {{bpm: number, confidence: number}|null} tempo
 * @property {number|null} evennessCv
 * @property {{mean: number|null, sd: number|null, min: number|null, max: number|null}} dynamics
 * @property {number} maxPolyphony
 * @property {boolean} pedalUsed
 */

// ---------------------------------------------------------------- tuning constants

/** Tempo mode: a note counts for a step when it lands within this many ms of the step's time. */
const WINDOW_MAX_MS = 300;
/** ...and within this share of the gap to the closest neighboring step. */
const WINDOW_GAP_SHARE = 0.45;
/** tick() waits this long past a window before calling a note missed: a Bluetooth note can be
 *  delivered up to about 80 ms after the time it is stamped with. */
const TICK_GRACE_MS = 120;
/** A later note resolves earlier windows by itself, with a margin for timestamps that go back a few ms. */
const NOTE_RESOLVE_MARGIN_MS = 25;
/** Wrong notes kept per step (the count itself is not capped). */
const MAX_WRONG_KEPT = 32;
const HESITATION_FACTOR = 1.8;
const HESITATION_MIN_OVER_MS = 250;
const MAX_TROUBLE_SPOTS = 5;
/** Tempo mode: a matched step is a 'late' or 'early' trouble spot beyond this share of the gap... */
const OFF_BEAT_GAP_SHARE = 0.15;
/** ...clamped to this range in ms. */
const OFF_BEAT_MIN_MS = 60;
const OFF_BEAT_MAX_MS = 120;

/** Free play: note-ons this close to the first one of a group count as played together. */
const GROUP_MS = 60;
const MAX_PHRASE_NOTES = 400;
const MAX_PHRASE_MS = 90000;
/** Free play: with a key still down (a stuck or lost note-off) the phrase closes this long after the gap. */
const STUCK_KEY_MS = 10000;
const MAX_QUEUED_PHRASES = 8;
/** Free play key estimate: each note weighs its length, clamped to this range in ms. */
const KEY_WEIGHT_MIN_MS = 60;
const KEY_WEIGHT_MAX_MS = 2000;

// ---------------------------------------------------------------- small helpers

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isMidi(value) {
  return Number.isInteger(value) && value >= 0 && value <= 127;
}

/** Round to a number of decimals, never returning -0. */
function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor + 0;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

/** MIDI velocity 1..127, or null when the device sent something that is not a number. */
function cleanVelocity(value) {
  return isNum(value) ? clamp(Math.round(value), 1, 127) : null;
}

function mean(values) {
  let sum = 0;
  for (const v of values) sum += v;
  return values.length ? sum / values.length : null;
}

/** Population standard deviation. */
function stdDev(values) {
  if (!values.length) return null;
  const m = mean(values);
  let sum = 0;
  for (const v of values) sum += (v - m) ** 2;
  return Math.sqrt(sum / values.length);
}

/**
 * Median that is always one of the values: for an even count, the lower of the two middle ones.
 * Pauses only ever make a gap longer, so the lower middle value is the better "usual pace".
 */
function lowerMedian(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function dynamicsOf(velocities) {
  if (!velocities.length) return { mean: null, sd: null, min: null, max: null };
  return {
    mean: roundTo(mean(velocities), 1),
    sd: roundTo(stdDev(velocities), 1),
    min: Math.min(...velocities),
    max: Math.max(...velocities),
  };
}

/** Least-squares slope of y against x, or null when x does not vary. */
function slope(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den > 0 ? num / den : null;
}

// ---------------------------------------------------------------- AttemptTracker

/**
 * Turn whatever arrived as exercise.steps into clean internal records. Notes become unique
 * ascending MIDI integers with their names kept aligned; a bad beat length becomes 1.
 */
function buildRecords(exercise) {
  const steps = Array.isArray(exercise.steps) ? exercise.steps : [];
  const records = [];
  let beatOffset = 0;
  steps.forEach((raw, index) => {
    const step = raw && typeof raw === 'object' ? raw : {};
    const rawNotes = Array.isArray(step.notes) ? step.notes : [];
    const rawNames = Array.isArray(step.names) ? step.names : [];
    const seen = new Set();
    const pairs = [];
    rawNotes.forEach((midi, i) => {
      if (!isMidi(midi) || seen.has(midi)) return;
      seen.add(midi);
      const name = typeof rawNames[i] === 'string' && rawNames[i] ? rawNames[i] : spellMidi(midi, exercise.key ?? null);
      pairs.push({ midi, name });
    });
    pairs.sort((a, b) => a.midi - b.midi);
    const beats = isNum(step.beats) && step.beats > 0 ? step.beats : 1;
    records.push({
      index,
      notes: pairs.map((p) => p.midi),
      names: pairs.map((p) => p.name),
      beatOffset,
      rest: pairs.length === 0,
      slots: pairs.map((p) => ({
        note: p.midi, // the expected MIDI note
        hit: false,
        midi: null, // the key that was actually struck (differs with anyOctave)
        timeMs: null,
        velocity: null,
        held: false,
        offsetMs: null,
        missed: false,
      })),
      wrong: [],
      wrongCount: 0,
      ownStray: 0, // tempo mode: +1 / -1 when the step's own key was struck too late / too early to count
      mistimedCount: 0, // tempo mode: how often the step's own key was struck outside its window
      resolved: false,
      timeMs: null, // wait mode: when the step was completed
      relDueMs: 0, // tempo mode: time of the step after beat 0
      windowMs: WINDOW_MAX_MS,
      gapMs: Infinity,
    });
    beatOffset += beats;
  });
  return records;
}

export class AttemptTracker {
  #exerciseId;
  #mode;
  #bpm;
  #beatMs;
  #anyOctave;
  #latencyMs;
  #recs;
  /** Indexes of the steps that have notes (not rests). */
  #playable;
  /** First unresolved playable step, or the number of steps when everything is resolved. */
  #cursor = 0;
  #finished = false;
  /** Wait mode: time of the first correct note. Tempo mode: beat 0 as passed to start(). */
  #startMs = null;
  #endMs = null;
  #lastNoteMs = null;
  #lastSeenMs = null;
  #touched = false;
  /** Tempo mode: notes played before the first window or after the last one. */
  #strayExtras = 0;
  #missedQueue = [];

  /**
   * @param {Object} exercise  an Exercise as defined by the build contract (id, mode, bpm, steps)
   * @param {{mode?: 'wait'|'tempo', bpm?: number, anyOctave?: boolean, latencyMs?: number}} [options]
   *   mode and bpm default to the exercise's own. anyOctave: a note in any octave counts.
   *   latencyMs: tempo mode, shifts the expected times later (output plus input delay).
   */
  constructor(exercise, options) {
    const ex = exercise && typeof exercise === 'object' ? exercise : {};
    const opts = options && typeof options === 'object' ? options : {};
    this.#exerciseId = typeof ex.id === 'string' ? ex.id : '';
    this.#mode = (opts.mode ?? ex.mode) === 'tempo' ? 'tempo' : 'wait';
    const bpm = [opts.bpm, ex.bpm].find((value) => isNum(value) && value > 0) ?? 60;
    this.#bpm = clamp(bpm, 10, 400);
    this.#beatMs = 60000 / this.#bpm;
    this.#anyOctave = opts.anyOctave === true;
    this.#latencyMs = isNum(opts.latencyMs) ? opts.latencyMs : 0;
    this.#recs = buildRecords(ex);
    this.#playable = this.#recs.filter((rec) => !rec.rest).map((rec) => rec.index);

    // Tempo-mode grid: when each step is due after beat 0 and how wide its window is.
    this.#playable.forEach((index, at) => {
      const rec = this.#recs[index];
      rec.relDueMs = rec.beatOffset * this.#beatMs;
      const gaps = [];
      if (at > 0) gaps.push(rec.beatOffset - this.#recs[this.#playable[at - 1]].beatOffset);
      if (at < this.#playable.length - 1) gaps.push(this.#recs[this.#playable[at + 1]].beatOffset - rec.beatOffset);
      if (gaps.length) {
        rec.gapMs = Math.min(...gaps) * this.#beatMs;
        rec.windowMs = Math.min(WINDOW_MAX_MS, WINDOW_GAP_SHARE * rec.gapMs);
      }
    });
    this.#advance();
    if (this.#cursor >= this.#recs.length) this.#finished = true; // nothing to play
  }

  /**
   * Tempo mode: the time of beat 0 (after the count-in). Without it the first note played is
   * taken as beat 0. Wait mode: optional and without effect, the first correct note starts the clock.
   * @param {number} timeMs
   */
  start(timeMs) {
    if (!isNum(timeMs)) return;
    this.#see(timeMs);
    if (this.#mode === 'tempo' && !this.#touched) this.#startMs = timeMs;
  }

  /**
   * @param {number} midi
   * @param {number} velocity 1..127
   * @param {number} timeMs
   * @returns {NoteJudgement}
   */
  noteOn(midi, velocity, timeMs) {
    if (!isMidi(midi)) return this.#reply('ignored', this.#cursor, false, null);
    const t = this.#noteTime(timeMs);
    if (this.#finished) return this.#reply('ignored', this.#cursor, false, null);
    return this.#mode === 'tempo'
      ? this.#tempoNoteOn(midi, cleanVelocity(velocity), t)
      : this.#waitNoteOn(midi, cleanVelocity(velocity), t);
  }

  /**
   * @param {number} midi
   * @param {number} timeMs
   */
  noteOff(midi, timeMs) {
    if (!isMidi(midi)) return;
    this.#noteTime(timeMs);
    if (this.#finished || this.#mode !== 'wait') return;
    const rec = this.#recs[this.#cursor];
    for (const slot of rec.slots) {
      if (slot.midi === midi) slot.held = false;
    }
  }

  /**
   * Tempo mode: resolves the steps whose window has passed (their unplayed notes become missed)
   * and ends the attempt after the last window. Wait mode: nothing to resolve.
   * @param {number} timeMs
   * @returns {{ missed: number[], finished: boolean }} missed = indexes of the steps that were
   *   resolved with missed notes since the previous call
   */
  tick(timeMs) {
    if (isNum(timeMs)) {
      this.#see(timeMs);
      if (this.#mode === 'tempo' && !this.#finished && this.#startMs !== null) {
        this.#resolveOverdue(timeMs - TICK_GRACE_MS);
      }
    }
    const missed = this.#missedQueue;
    this.#missedQueue = [];
    return { missed, finished: this.#finished };
  }

  /** Wait mode: the current step. Tempo mode: the first unresolved step. Step count when done. */
  get stepIndex() {
    return this.#cursor;
  }

  /** @returns {StepState[]} aligned with exercise.steps */
  get stepStates() {
    return this.#recs.map((rec) => this.#stateOf(rec));
  }

  get finished() {
    return this.#finished;
  }

  /**
   * Notes still needed for the current step, as written in the exercise (for key highlighting).
   * Wait mode includes notes of a chord that were struck and let go again, because every note
   * has to be down at the same moment.
   * @returns {number[]}
   */
  pendingNotes() {
    if (this.#finished) return [];
    const rec = this.#recs[this.#cursor];
    if (!rec) return [];
    const wait = this.#mode === 'wait';
    return rec.slots.filter((slot) => !slot.hit || (wait && !slot.held)).map((slot) => slot.note);
  }

  /**
   * The attempt so far. Cheap, and callable at any time: `completed` is false until the attempt
   * has finished, and steps not reached yet are 'pending'.
   * @returns {AttemptResult}
   */
  result() {
    const tempo = this.#mode === 'tempo';
    const steps = [];
    const sequence = []; // played steps in order, for the gaps between them
    const velocities = [];
    const offsets = [];
    const offsetBeats = [];
    let played = 0;
    let clean = 0;
    let wrongNotes = 0;
    let mistimedNotes = 0;
    let missedNotes = 0;

    for (const rec of this.#recs) {
      const state = this.#stateOf(rec);
      const hits = rec.slots.filter((slot) => slot.hit);
      const counted = !rec.rest && (tempo ? hits.length > 0 : rec.resolved);
      const missed = rec.slots.filter((slot) => slot.missed).map((slot) => slot.note);
      const step = {
        index: rec.index,
        state,
        wrong: rec.wrong.slice(),
        missed,
        mistimed: rec.mistimedCount,
        ioiMs: null,
        offsetMs: null,
        velocity: null,
        chordSpreadMs: null,
      };
      wrongNotes += rec.wrongCount;
      mistimedNotes += rec.mistimedCount;
      missedNotes += missed.length;
      if (counted) {
        played += 1;
        const times = hits.map((slot) => slot.timeMs);
        const stepVelocities = hits.map((slot) => slot.velocity).filter((v) => v !== null);
        velocities.push(...stepVelocities);
        if (stepVelocities.length) step.velocity = roundTo(mean(stepVelocities), 1);
        if (rec.notes.length > 1 && hits.length > 1) {
          step.chordSpreadMs = roundTo(Math.max(...times) - Math.min(...times), 1);
        }
        if (tempo) {
          const stepOffsets = hits.map((slot) => slot.offsetMs);
          step.offsetMs = roundTo(mean(stepOffsets), 1);
          for (const offset of stepOffsets) {
            offsets.push(offset);
            offsetBeats.push(rec.beatOffset);
          }
        }
        sequence.push({ rec, step, timeMs: tempo ? mean(times) : rec.timeMs });
      }
      if (!rec.rest && state === 'ok') clean += 1;
      steps.push(step);
    }

    // Gaps between consecutive played steps, and the pace they imply (ms per beat).
    const paces = [];
    for (let i = 1; i < sequence.length; i++) {
      const prev = sequence[i - 1];
      const here = sequence[i];
      const ioi = Math.max(0, here.timeMs - prev.timeMs);
      here.step.ioiMs = roundTo(ioi, 1);
      const beats = here.rec.beatOffset - prev.rec.beatOffset;
      if (beats > 0) paces.push({ index: here.rec.index, ioi, beats, pace: ioi / beats });
    }
    const paceValues = paces.map((p) => p.pace);
    const usualPace = lowerMedian(paceValues);
    const estBpm = usualPace !== null && usualPace > 0 ? roundTo(60000 / usualPace, 1) : null;
    const hesitations = [];
    if (!tempo && usualPace !== null && usualPace > 0) {
      for (const p of paces) {
        const factor = p.pace / usualPace;
        if (factor > HESITATION_FACTOR && p.ioi - usualPace * p.beats >= HESITATION_MIN_OVER_MS) {
          hesitations.push({ index: p.index, factor: roundTo(factor, 2) });
        }
      }
    }
    // Evenness describes the flow between pauses: a gap already reported as a hesitation is left
    // out, or one stop would make an otherwise steady run read as uneven.
    let evennessCv = null;
    const paused = new Set(hesitations.map((h) => h.index));
    const flowing = paces.filter((p) => !paused.has(p.index)).map((p) => p.pace);
    if (sequence.length >= 4 && flowing.length >= 3) {
      const paceMean = mean(flowing);
      if (paceMean > 0) evennessCv = roundTo(stdDev(flowing) / paceMean, 3);
    }

    let driftMsPerBeat = null;
    if (offsets.length >= 3) {
      const drift = slope(offsetBeats, offsets);
      if (drift !== null) driftMsPerBeat = roundTo(drift, 2);
    }

    const total = this.#playable.length;
    return {
      exerciseId: this.#exerciseId,
      mode: this.#mode,
      bpm: this.#bpm,
      completed: this.#finished,
      durationMs: this.#durationMs(),
      steps,
      totals: {
        steps: total,
        played,
        clean,
        wrongNotes,
        mistimed: mistimedNotes,
        missed: missedNotes,
        extra: this.#strayExtras,
        accuracy: total ? roundTo(clean / total, 4) : 0,
      },
      timing: {
        estBpm,
        evennessCv,
        hesitations,
        meanOffsetMs: offsets.length ? roundTo(mean(offsets), 1) : null,
        offsetSdMs: offsets.length >= 2 ? roundTo(stdDev(offsets), 1) : null,
        driftMsPerBeat,
        // What the drift is based on, so a reader can tell a trend from scatter.
        offsetCount: offsets.length,
        offsetSpanBeats: offsetBeats.length ? roundTo(Math.max(...offsetBeats) - Math.min(...offsetBeats), 2) : null,
      },
      dynamics: dynamicsOf(velocities),
      troubleSpots: this.#troubleSpots(steps, hesitations),
    };
  }

  // -------------------------------------------------------------- internals

  #see(timeMs) {
    if (this.#lastSeenMs === null || timeMs > this.#lastSeenMs) this.#lastSeenMs = timeMs;
  }

  /** Clean the time of a note event. In wait mode time never runs backwards (a BLE clock can jitter). */
  #noteTime(timeMs) {
    let t = isNum(timeMs) ? timeMs : (this.#lastNoteMs ?? this.#lastSeenMs ?? 0);
    if (this.#mode === 'wait' && this.#lastNoteMs !== null && t < this.#lastNoteMs) t = this.#lastNoteMs;
    if (this.#lastNoteMs === null || t > this.#lastNoteMs) this.#lastNoteMs = t;
    this.#see(t);
    return t;
  }

  #reply(kind, stepIndex, stepCompleted, offsetMs) {
    const rec = this.#recs[stepIndex];
    return {
      kind,
      stepIndex,
      stepCompleted,
      finished: this.#finished,
      expected: rec ? rec.notes.slice() : [],
      offsetMs,
    };
  }

  #matches(expected, midi) {
    return expected === midi || (this.#anyOctave && pitchClass(expected) === pitchClass(midi));
  }

  /** Move the cursor past rests and resolved steps. */
  #advance() {
    while (this.#cursor < this.#recs.length) {
      const rec = this.#recs[this.#cursor];
      if (!rec.rest && !rec.resolved) break;
      rec.resolved = true;
      this.#cursor += 1;
    }
  }

  #stateOf(rec) {
    if (rec.rest) return rec.index < this.#cursor ? 'ok' : 'pending';
    if (!rec.resolved) return rec.index === this.#cursor && !this.#finished ? 'current' : 'pending';
    const hits = rec.slots.reduce((count, slot) => count + (slot.hit ? 1 : 0), 0);
    if (hits === 0) return 'missed';
    return hits === rec.slots.length && rec.wrongCount === 0 && rec.mistimedCount === 0 ? 'ok' : 'error';
  }

  #recordWrong(rec, midi) {
    rec.wrongCount += 1;
    if (rec.wrong.length < MAX_WRONG_KEPT) rec.wrong.push(midi);
  }

  #waitNoteOn(midi, velocity, t) {
    const index = this.#cursor;
    const rec = this.#recs[index];
    const matching = rec.slots.filter((slot) => this.#matches(slot.note, midi));
    if (!matching.length) {
      this.#recordWrong(rec, midi);
      return this.#reply('wrong', index, false, null);
    }
    // A note of the step that was not struck yet (the exact key first, for octave doublings)...
    let slot = matching.find((s) => !s.hit && s.note === midi) ?? matching.find((s) => !s.hit);
    const fresh = Boolean(slot);
    // ...or one that was struck, let go, and is now pressed again.
    if (!slot) slot = matching.find((s) => !s.held && s.midi === midi) ?? matching.find((s) => !s.held);
    if (!slot) return this.#reply('ignored', index, false, null);

    slot.hit = true;
    slot.midi = midi;
    slot.timeMs = t;
    slot.velocity = velocity;
    slot.held = true;
    if (this.#startMs === null) this.#startMs = t;

    const done = rec.slots.every((s) => s.hit && s.held);
    if (done) {
      rec.resolved = true;
      rec.timeMs = t;
      this.#advance();
      if (this.#cursor >= this.#recs.length) {
        this.#finished = true;
        this.#endMs = t;
      }
    }
    return this.#reply(fresh || done ? 'correct' : 'ignored', index, done, null);
  }

  /** Tempo mode: the local time of beat 0 as the learner hears and plays it. */
  #origin() {
    return this.#startMs + this.#latencyMs;
  }

  /** Tempo mode: resolve every step whose window ended before limitMs. */
  #resolveOverdue(limitMs) {
    const origin = this.#origin();
    for (const index of this.#playable) {
      const rec = this.#recs[index];
      if (rec.resolved) continue;
      if (origin + rec.relDueMs + rec.windowMs >= limitMs) break;
      let missed = false;
      for (const slot of rec.slots) {
        if (!slot.hit) {
          slot.missed = true;
          missed = true;
        }
      }
      rec.resolved = true;
      if (missed) this.#missedQueue.push(index);
    }
    this.#advance();
    if (this.#cursor >= this.#recs.length && !this.#finished) {
      this.#finished = true;
      const last = this.#recs[this.#playable[this.#playable.length - 1]];
      this.#endMs = origin + last.relDueMs + last.windowMs;
    }
  }

  #tempoNoteOn(midi, velocity, t) {
    if (this.#startMs === null) this.#startMs = t - this.#latencyMs; // no start(): this note is beat 0
    this.#touched = true;
    this.#resolveOverdue(t - NOTE_RESOLVE_MARGIN_MS);
    if (this.#finished) {
      // Played after the last window had passed.
      this.#strayExtras += 1;
      return this.#reply('extra', this.#cursor, false, null);
    }
    const origin = this.#origin();
    let best = null;
    let nearest = null;
    let before = null; // the last step due at or before this note
    let after = null; // the first step due after it
    for (const index of this.#playable) {
      const rec = this.#recs[index];
      const offset = t - (origin + rec.relDueMs);
      const distance = Math.abs(offset);
      if (!nearest || distance < nearest.distance) nearest = { rec, distance };
      if (offset >= 0) before = rec;
      else if (!after) after = rec;
      if (distance > rec.windowMs || (best && distance >= best.distance)) continue;
      const open = rec.slots.filter((s) => !s.hit && !s.missed && this.#matches(s.note, midi));
      const slot = open.find((s) => s.note === midi) ?? open[0];
      if (slot) best = { rec, slot, offset, distance };
    }

    if (best) {
      const { rec, slot, offset } = best;
      slot.hit = true;
      slot.midi = midi;
      slot.timeMs = t;
      slot.velocity = velocity;
      slot.offsetMs = offset;
      const done = rec.slots.every((s) => s.hit);
      if (done) {
        rec.resolved = true;
        this.#advance();
        if (this.#cursor >= this.#recs.length) {
          this.#finished = true;
          this.#endMs = t;
        }
      }
      return this.#reply('correct', rec.index, done, roundTo(offset, 1));
    }

    // No expected note of this pitch is open at this time. Before the first window or after the
    // last the note is stray. Inside the time span of the exercise it is charged to a step: to the
    // neighboring step that still waits for this very key (the right key, too late or too early
    // to count), else to the nearest step.
    const first = this.#recs[this.#playable[0]];
    const last = this.#recs[this.#playable[this.#playable.length - 1]];
    const inside = t >= origin + first.relDueMs - first.windowMs && t <= origin + last.relDueMs + last.windowMs;
    if (inside && nearest) {
      const owns = (rec) => Boolean(rec) && rec.slots.some((s) => !s.hit && this.#matches(s.note, midi));
      let target = nearest.rec;
      if (owns(before) !== owns(after)) target = owns(before) ? before : after;
      if (owns(target)) {
        // The right key at the wrong time is a timing fault, not a wrong note.
        if (target.ownStray === 0) target.ownStray = t >= origin + target.relDueMs ? 1 : -1;
        target.mistimedCount += 1;
      } else {
        this.#recordWrong(target, midi);
      }
      return this.#reply('extra', target.index, false, null);
    }
    this.#strayExtras += 1;
    return this.#reply('extra', this.#cursor, false, null);
  }

  #durationMs() {
    if (this.#startMs === null) return 0;
    const end = this.#finished ? this.#endMs : this.#mode === 'tempo' ? this.#lastSeenMs : this.#lastNoteMs;
    return isNum(end) ? Math.max(0, roundTo(end - this.#startMs, 1)) : 0;
  }

  /** At most five steps that went wrong, worst first. One entry per step, with its main reason. */
  #troubleSpots(steps, hesitations) {
    const hesitationFactor = new Map(hesitations.map((h) => [h.index, h.factor]));
    const spots = [];
    for (const index of this.#playable) {
      const rec = this.#recs[index];
      const step = steps[index];
      let reason = null;
      let score = 0;
      if (step.missed.length) {
        // Nothing of the step landed in its window. If its own key was struck outside the window,
        // the step was not forgotten but badly late or early.
        reason = step.state === 'missed' && rec.ownStray !== 0 ? (rec.ownStray > 0 ? 'late' : 'early') : 'missed';
        score = 3000 + Math.min(step.missed.length, 10) * 10 + Math.min(rec.wrongCount, 9);
      } else if (rec.wrongCount) {
        reason = 'wrong_notes';
        score = 2000 + Math.min(rec.wrongCount, 99) * 10;
      } else if (rec.mistimedCount) {
        // Hit in its window, but the same key was also struck well off the beat.
        reason = rec.ownStray > 0 ? 'late' : 'early';
        score = 1500 + Math.min(rec.mistimedCount, 99);
      } else if (hesitationFactor.has(index)) {
        reason = 'hesitation';
        score = 1000 + Math.min(999, hesitationFactor.get(index) * 10);
      } else if (step.offsetMs !== null) {
        const limit = clamp(OFF_BEAT_GAP_SHARE * rec.gapMs, OFF_BEAT_MIN_MS, OFF_BEAT_MAX_MS);
        if (Math.abs(step.offsetMs) >= limit) {
          reason = step.offsetMs > 0 ? 'late' : 'early';
          score = Math.min(999, Math.abs(step.offsetMs));
        }
      }
      if (reason) spots.push({ index, names: rec.names.slice(), reason, score });
    }
    spots.sort((a, b) => b.score - a.score || a.index - b.index);
    return spots.slice(0, MAX_TROUBLE_SPOTS).map(({ index, names, reason }) => ({ index, names, reason }));
  }
}

// ---------------------------------------------------------------- FreePlayAnalyzer

/** Group notes (sorted by onset) whose onsets fall within GROUP_MS of the group's first note. */
function groupOnsets(notes) {
  const groups = [];
  for (const note of notes) {
    const group = groups[groups.length - 1];
    if (group && note.on - group.atMs <= GROUP_MS) group.notes.push(note);
    else groups.push({ atMs: note.on, notes: [note] });
  }
  return groups;
}

/** How many units long a gap is, to the nearest half unit (at least half a unit). */
function snapToGrid(gapMs, unitMs) {
  return Math.max(1, Math.round((2 * gapMs) / unitMs)) / 2;
}

/**
 * Tempo from the gaps between onsets: the usual gap is taken as one beat and folded into
 * 40..200 bpm by doubling or halving. Confidence is 1 when every gap is a whole or half multiple
 * of that beat and 0 when the gaps are no closer to the grid than random ones would be.
 */
function estimateTempo(groups) {
  if (groups.length < 6) return null;
  const gaps = [];
  for (let i = 1; i < groups.length; i++) gaps.push(groups[i].atMs - groups[i - 1].atMs);
  const unit = lowerMedian(gaps);
  if (!(unit > 0)) return null;
  let bpm = 60000 / unit;
  while (bpm > 200) bpm /= 2;
  while (bpm < 40) bpm *= 2;
  const errors = gaps.map((gap) => Math.min(0.25, Math.abs(gap / unit - snapToGrid(gap, unit))));
  return { bpm: roundTo(bpm, 1), confidence: roundTo(clamp(1 - mean(errors) / 0.125, 0, 1), 2) };
}

/**
 * Steadiness of single-note playing: the coefficient of variation of the gaps between consecutive
 * single notes, each gap first divided by the number of beats it spans (to the nearest half of the
 * usual gap), so that a correctly played long note does not count as uneven.
 */
function estimateEvenness(groups) {
  const gaps = [];
  for (let i = 1; i < groups.length; i++) {
    if (groups[i].notes.length === 1 && groups[i - 1].notes.length === 1) {
      gaps.push(groups[i].atMs - groups[i - 1].atMs);
    }
  }
  if (gaps.length < 3) return null;
  const unit = lowerMedian(gaps);
  if (!(unit > 0)) return null;
  const paces = gaps.map((gap) => gap / (snapToGrid(gap, unit) * unit));
  const paceMean = mean(paces);
  return paceMean > 0 ? roundTo(stdDev(paces) / paceMean, 3) : null;
}

/** @returns {PhraseSummary} */
function summarizePhrase(phrase, endMs) {
  const start = phrase.startMs;
  const raw = phrase.notes.map((note) => {
    const off = note.offMs ?? Math.max(endMs, note.onMs);
    return { midi: note.midi, on: note.onMs - start, dur: Math.max(0, off - note.onMs), velocity: note.velocity };
  });
  let end = 0;
  let low = Infinity;
  let high = -Infinity;
  const pcWeights = new Array(12).fill(0);
  const pcs = new Set();
  for (const note of raw) {
    end = Math.max(end, note.on + note.dur);
    low = Math.min(low, note.midi);
    high = Math.max(high, note.midi);
    pcs.add(pitchClass(note.midi));
    pcWeights[pitchClass(note.midi)] += clamp(note.dur, KEY_WEIGHT_MIN_MS, KEY_WEIGHT_MAX_MS);
  }

  let key = null;
  if (raw.length >= 8 && pcs.size >= 5) {
    const estimate = estimateKey(pcWeights);
    if (estimate) key = { tonic: estimate.tonic, mode: estimate.mode, confidence: roundTo(estimate.confidence, 2) };
  }

  const groups = groupOnsets(raw);
  const chords = [];
  for (const group of groups) {
    const midis = group.notes.map((note) => note.midi);
    if (new Set(midis.map((midi) => pitchClass(midi))).size < 3) continue;
    const chord = detectChord(midis);
    if (!chord || (chords.length && chords[chords.length - 1].name === chord.name)) continue;
    chords.push({ name: chord.name, atMs: Math.round(group.atMs) });
  }

  return {
    startMs: start,
    durationMs: Math.round(end),
    noteCount: raw.length,
    notes: raw.map((note) => ({
      midi: note.midi,
      name: spellMidi(note.midi, key),
      onMs: Math.round(note.on),
      durMs: Math.round(note.dur),
      velocity: note.velocity,
    })),
    range: { low, high },
    chords,
    key,
    tempo: estimateTempo(groups),
    evennessCv: estimateEvenness(groups),
    dynamics: dynamicsOf(raw.map((note) => note.velocity).filter((v) => v !== null)),
    maxPolyphony: phrase.maxPolyphony,
    pedalUsed: phrase.pedalUsed,
  };
}

export class FreePlayAnalyzer {
  #gapMs;
  #minNotes;
  #phrase = null;
  #queue = [];
  #pedalDown = false;
  #lastMs = 0;

  /**
   * @param {{phraseGapMs?: number, minNotes?: number}} [options] a phrase ends after phraseGapMs
   *   with no key down and no new note; phrases with fewer than minNotes notes are dropped
   */
  constructor(options) {
    const opts = options && typeof options === 'object' ? options : {};
    this.#gapMs = isNum(opts.phraseGapMs) && opts.phraseGapMs > 0 ? opts.phraseGapMs : 1800;
    this.#minNotes = isNum(opts.minNotes) && opts.minNotes >= 1 ? Math.floor(opts.minNotes) : 4;
  }

  /**
   * @param {number} midi
   * @param {number} velocity 1..127
   * @param {number} timeMs
   */
  noteOn(midi, velocity, timeMs) {
    if (!isMidi(midi)) return;
    const t = this.#noteTime(timeMs);
    let phrase = this.#phrase;
    if (phrase) {
      if (phrase.open.size === 0 && t - phrase.lastEventMs >= this.#gapMs) {
        // The gap passed without a tick(): the old phrase is over, this note starts a new one.
        this.#close(phrase, phrase.lastEventMs);
        phrase = null;
      } else if (phrase.notes.length >= MAX_PHRASE_NOTES || t - phrase.startMs >= MAX_PHRASE_MS) {
        this.#close(phrase, t);
        phrase = null;
      }
    }
    if (!phrase) {
      phrase = { startMs: t, notes: [], open: new Map(), lastEventMs: t, maxPolyphony: 0, pedalUsed: this.#pedalDown };
      this.#phrase = phrase;
    }
    const sounding = phrase.open.get(midi);
    if (sounding) sounding.offMs = t; // struck again without a note-off in between
    const note = { midi, onMs: t, offMs: null, velocity: cleanVelocity(velocity) };
    phrase.notes.push(note);
    phrase.open.set(midi, note);
    phrase.maxPolyphony = Math.max(phrase.maxPolyphony, phrase.open.size);
    phrase.lastEventMs = t;
  }

  /**
   * @param {number} midi
   * @param {number} timeMs
   */
  noteOff(midi, timeMs) {
    if (!isMidi(midi)) return;
    const phrase = this.#phrase;
    const note = phrase?.open.get(midi);
    if (!note) return; // a note-off for a note that was never on
    const t = this.#noteTime(timeMs);
    note.offMs = t;
    phrase.open.delete(midi);
    phrase.lastEventMs = t;
  }

  /**
   * Sustain pedal changes.
   * @param {boolean} down
   * @param {number} timeMs
   */
  pedal(down, timeMs) {
    if (isNum(timeMs) && timeMs > this.#lastMs) this.#lastMs = timeMs;
    this.#pedalDown = Boolean(down);
    if (this.#pedalDown && this.#phrase) this.#phrase.pedalUsed = true;
  }

  /**
   * Call regularly. Returns each finished phrase exactly once, else null.
   * @param {number} timeMs
   * @returns {PhraseSummary|null}
   */
  tick(timeMs) {
    const phrase = this.#phrase;
    if (phrase && isNum(timeMs)) {
      const idle = timeMs - phrase.lastEventMs;
      if (phrase.open.size === 0) {
        if (idle >= this.#gapMs) this.#close(phrase, phrase.lastEventMs);
      } else if (idle >= this.#gapMs + STUCK_KEY_MS || timeMs - phrase.startMs >= MAX_PHRASE_MS) {
        this.#close(phrase, timeMs);
      }
    }
    return this.#queue.length ? this.#queue.shift() : null;
  }

  /**
   * The phrase in progress, with notes still held counted up to timeMs. Does not end the phrase.
   * @param {number} timeMs
   * @returns {PhraseSummary|null} null when nothing is being played
   */
  snapshot(timeMs) {
    const phrase = this.#phrase;
    if (!phrase || !phrase.notes.length) return null;
    return summarizePhrase(phrase, isNum(timeMs) ? Math.max(timeMs, phrase.lastEventMs) : phrase.lastEventMs);
  }

  #noteTime(timeMs) {
    let t = isNum(timeMs) ? timeMs : this.#lastMs;
    const phrase = this.#phrase;
    if (phrase && t < phrase.lastEventMs) t = phrase.lastEventMs; // time never runs backwards
    if (t > this.#lastMs) this.#lastMs = t;
    return t;
  }

  #close(phrase, endMs) {
    this.#phrase = null;
    if (phrase.notes.length < this.#minNotes) return;
    this.#queue.push(summarizePhrase(phrase, endMs));
    if (this.#queue.length > MAX_QUEUED_PHRASES) this.#queue.shift();
  }
}
