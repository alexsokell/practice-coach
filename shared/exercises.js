// Exercises for Practice Coach: turns an ExerciseSpec (the JSON Claude or the starter library
// sends) into a concrete Exercise (the exact keys, names, fingers and beats the learner plays),
// validates exercises, cuts drills out of them and describes them for the coach.
// Pure and isomorphic: no DOM, no Node APIs, no top-level side effects.
//
// Notes and fingerings come from shared/theory.js. This module never makes a fingering up: where
// theory.js has no verified fingering the step fingers are null, and fingers written in a custom
// spec are passed through after a range and alignment check.

import { PIANO_HIGH, PIANO_LOW, nameToMidi, parseNoteName } from './midi.js';
import {
  arpeggioFingering,
  arpeggioNotes,
  chordFingering,
  chordNotes,
  parseChordSymbol,
  parseRoot,
  scaleFingering,
  scaleNotes,
} from './theory.js';

/**
 * One event the learner plays: a single note or several notes together.
 * @typedef {Object} Step
 * @property {number[]} notes  MIDI numbers, ascending, unique, 1..10 notes (empty = rest, custom type only)
 * @property {string[]} names  spelled names aligned with notes, e.g. ['Bb3', 'D4']
 * @property {(number|null)[]} fingers  aligned with notes, 1..5 (1 = thumb) or null when unknown
 * @property {('L'|'R')[]} hands  aligned with notes
 * @property {number} beats  length of the step in beats until the next step starts (0.25..8)
 * @property {string} [label]  optional text shown above the step, e.g. a chord symbol 'G7'
 */
/**
 * @typedef {Object} Exercise
 * @property {string} id  stable id derived from the musical content, e.g. 'scale:C:major:right:1:up_down:4'
 * @property {string} title
 * @property {string} goal
 * @property {'scale'|'arpeggio'|'five_finger'|'chords'|'custom'} type
 * @property {'right'|'left'|'both'} hand
 * @property {number} bpm  integer 30..200
 * @property {'wait'|'tempo'} mode
 * @property {number} beatsPerBar  2 | 3 | 4 | 6
 * @property {Step[]} steps  1..128 steps
 * @property {{tonic: string, mode: 'major'|'minor'}|null} key
 * @property {ExerciseSpec} spec  normalized copy of the spec this was built from (JSON-serializable)
 */
/**
 * Fields shared by every spec variant.
 * @typedef {Object} SpecCommon
 * @property {string} title
 * @property {string} goal
 * @property {'right'|'left'|'both'} hand
 * @property {number} bpm
 * @property {'wait'|'tempo'} mode
 */
/**
 * @typedef {SpecCommon & {type: 'scale', root: string,
 *   scale: 'major'|'natural_minor'|'harmonic_minor'|'melodic_minor'|'major_pentatonic'|'minor_pentatonic'|'blues'|'chromatic',
 *   octaves: 1|2, direction: 'up'|'down'|'up_down', start_octave: number, note_beats: number}} ScaleSpec
 */
/**
 * @typedef {SpecCommon & {type: 'arpeggio', root: string,
 *   quality: 'major'|'minor'|'diminished'|'augmented'|'dominant7'|'major7'|'minor7',
 *   octaves: 1|2, direction: 'up'|'down'|'up_down', start_octave: number, note_beats: number}} ArpeggioSpec
 */
/**
 * @typedef {SpecCommon & {type: 'five_finger', root: string, quality: 'major'|'minor',
 *   pattern: 'up_down'|'thirds'|'triad', start_octave: number, note_beats: number}} FiveFingerSpec
 */
/**
 * @typedef {SpecCommon & {type: 'chords', chords: string[], style: 'block'|'broken',
 *   voicing: 'root'|'smooth', start_octave: number, beats_per_chord: number}} ChordsSpec
 */
/**
 * @typedef {Object} CustomStepSpec
 * @property {string[]} right  right-hand note names played together, e.g. ['E4', 'G4']
 * @property {string[]} left   left-hand note names played together
 * @property {number} beats
 * @property {(number|null)[]|null} right_fingers  one finger per right-hand note, or null
 * @property {(number|null)[]|null} left_fingers   one finger per left-hand note, or null
 */
/**
 * @typedef {SpecCommon & {type: 'custom', beats_per_bar: 2|3|4|6, steps: CustomStepSpec[]}} CustomSpec
 */
/** @typedef {ScaleSpec|ArpeggioSpec|FiveFingerSpec|ChordsSpec|CustomSpec} ExerciseSpec */

const TYPES = ['scale', 'arpeggio', 'five_finger', 'chords', 'custom'];
const HANDS = ['right', 'left', 'both'];
const MODES = ['wait', 'tempo'];
const SCALES = ['major', 'natural_minor', 'harmonic_minor', 'melodic_minor', 'major_pentatonic', 'minor_pentatonic',
  'blues', 'chromatic'];
const DIRECTIONS = ['up', 'down', 'up_down'];
const OCTAVE_COUNTS = [1, 2];
const ARPEGGIO_QUALITIES = ['major', 'minor', 'diminished', 'augmented', 'dominant7', 'major7', 'minor7'];
const FIVE_FINGER_QUALITIES = ['major', 'minor'];
const FIVE_FINGER_PATTERNS = {
  up_down: [1, 2, 3, 4, 5, 4, 3, 2, 1],
  thirds: [1, 3, 2, 4, 3, 5, 4, 2, 1],
  triad: [1, 3, 5, 3, 1],
};
const CHORD_STYLES = ['block', 'broken'];
const CHORD_VOICINGS = ['root', 'smooth'];
const BEATS_PER_BAR = [2, 3, 4, 6];

const MIN_BPM = 30;
const MAX_BPM = 200;
const MIN_BEATS = 0.25;
const MAX_BEATS = 8;
const MAX_STEPS = 128;
const MAX_CHORDS = 16;
const MAX_HAND_NOTES = 5;
const MAX_HAND_SPAN = 14;
const MIN_START_OCTAVE = 0;
const MAX_START_OCTAVE = 8;
/** A smooth voicing keeps its lowest note within this many semitones of the first chord's lowest note. */
const SMOOTH_WINDOW = 7;
const MAX_TITLE = 100;
const MAX_GOAL = 240;
const MAX_ERRORS = 12;

const COMMON_FIELDS = ['type', 'title', 'goal', 'hand', 'bpm', 'mode'];
const TYPE_FIELDS = {
  scale: ['root', 'scale', 'octaves', 'direction', 'start_octave', 'note_beats'],
  arpeggio: ['root', 'quality', 'octaves', 'direction', 'start_octave', 'note_beats'],
  five_finger: ['root', 'quality', 'pattern', 'start_octave', 'note_beats'],
  chords: ['chords', 'style', 'voicing', 'start_octave', 'beats_per_chord'],
  custom: ['beats_per_bar', 'steps'],
};
const CUSTOM_STEP_FIELDS = ['right', 'left', 'beats', 'right_fingers', 'left_fingers'];

const HAND_LABELS = { right: 'right hand', left: 'left hand', both: 'hands together' };
const SCALE_LABELS = {
  major: 'major',
  natural_minor: 'natural minor',
  harmonic_minor: 'harmonic minor',
  melodic_minor: 'melodic minor',
  major_pentatonic: 'major pentatonic',
  minor_pentatonic: 'minor pentatonic',
  blues: 'blues',
  chromatic: 'chromatic',
};
/** Scale name -> mode of the key it is written in (chromatic has no key). */
const SCALE_KEY_MODES = {
  major: 'major',
  major_pentatonic: 'major',
  natural_minor: 'minor',
  harmonic_minor: 'minor',
  melodic_minor: 'minor',
  minor_pentatonic: 'minor',
  blues: 'minor',
};
const ARPEGGIO_LABELS = {
  major: 'major',
  minor: 'minor',
  diminished: 'diminished',
  augmented: 'augmented',
  dominant7: 'dominant 7th',
  major7: 'major 7th',
  minor7: 'minor 7th',
};
const ARPEGGIO_KEY_MODES = {
  major: 'major',
  augmented: 'major',
  dominant7: 'major',
  major7: 'major',
  minor: 'minor',
  diminished: 'minor',
  minor7: 'minor',
};

// ---------------------------------------------------------------- small helpers

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMissing(value) {
  return value === undefined || value === null;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** JSON copy of a spec, or the value itself when it cannot be serialized. */
function cloneJson(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? value : JSON.parse(text);
  } catch {
    return value;
  }
}

/** Short, safe rendering of any value for an error message. */
function show(value) {
  let text;
  try {
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'symbol') text = String(value);
    else text = JSON.stringify(value) ?? String(value);
  } catch {
    text = 'an unreadable value';
  }
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function quoted(values) {
  return values.map((value) => (typeof value === 'string' ? `"${value}"` : String(value))).join(', ');
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** Shortest plain rendering of a beat count: 1, 0.5, 1.333. */
function beatText(beats) {
  return String(Number(beats.toFixed(3)));
}

function cleanText(text, maxLength) {
  return text.replace(/\s+/g, ' ').trim().slice(0, maxLength).trim();
}

function clampBpm(bpm) {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)));
}

function isFinger(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

/** A fingering from theory.js is used only when it lines up exactly with the notes. */
function alignedFingers(fingers, length) {
  return Array.isArray(fingers) && fingers.length === length && fingers.every(isFinger) ? fingers : null;
}

function handOfSteps(steps) {
  let left = false;
  let right = false;
  for (const step of steps) {
    for (const tag of step.hands) {
      if (tag === 'L') left = true;
      else if (tag === 'R') right = true;
    }
  }
  if (left && right) return 'both';
  if (left) return 'left';
  return right ? 'right' : null;
}

/** Build a step from note entries { midi, name, finger, hand }, lowest note first. */
function stepFromEntries(entries, beats, label) {
  const sorted = entries.slice().sort((a, b) => a.midi - b.midi);
  const step = {
    notes: sorted.map((entry) => entry.midi),
    names: sorted.map((entry) => entry.name),
    fingers: sorted.map((entry) => entry.finger),
    hands: sorted.map((entry) => entry.hand),
    beats,
  };
  if (label) step.label = label;
  return step;
}

function copyStep(step) {
  const copy = {
    notes: step.notes.slice(),
    names: step.names.slice(),
    fingers: step.fingers.slice(),
    hands: step.hands.slice(),
    beats: step.beats,
  };
  if (typeof step.label === 'string') copy.label = step.label;
  return copy;
}

/** The notes one hand plays in a step, lowest first. */
function handPart(step, tag) {
  const part = { notes: [], names: [], fingers: [] };
  step.hands.forEach((hand, i) => {
    if (hand !== tag) return;
    part.notes.push(step.notes[i]);
    part.names.push(step.names[i]);
    part.fingers.push(step.fingers[i]);
  });
  return part;
}

/** A custom spec that builds exactly these steps (labels are not part of a custom spec). */
function customSpecFromSteps({ title, goal, hand, bpm, mode, beatsPerBar }, steps) {
  return {
    type: 'custom',
    title,
    goal,
    hand,
    bpm,
    mode,
    beats_per_bar: beatsPerBar,
    steps: steps.map((step) => {
      const right = handPart(step, 'R');
      const left = handPart(step, 'L');
      return {
        right: right.names,
        left: left.names,
        beats: step.beats,
        right_fingers: right.fingers.some((finger) => finger !== null) ? right.fingers : null,
        left_fingers: left.fingers.some((finger) => finger !== null) ? left.fingers : null,
      };
    }),
  };
}

/** 53-bit string hash (cyrb53), base 36. Used for the id of custom exercises. */
function hashText(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// ---------------------------------------------------------------- reading spec fields

/** Enum fields are compared without regard to letter case or surrounding spaces. */
function readEnum(source, field, allowed, errors, fallback, where = '') {
  const raw = source[field];
  if (isMissing(raw)) {
    if (fallback !== undefined) return fallback;
    errors.push(`${where}${field}: required, one of ${quoted(allowed)}`);
    return null;
  }
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : raw;
  if (allowed.includes(value)) return value;
  errors.push(`${where}${field}: ${show(raw)} is not valid, use one of ${quoted(allowed)}`);
  return null;
}

function readText(spec, field, maxLength, errors) {
  const raw = spec[field];
  if (isMissing(raw)) return '';
  if (typeof raw === 'string') return cleanText(raw, maxLength);
  errors.push(`${field}: must be a string, got ${show(raw)}`);
  return '';
}

function readBpm(spec, errors) {
  const raw = spec.bpm;
  if (typeof raw === 'number' && Number.isFinite(raw)) return clampBpm(raw);
  errors.push(`bpm: ${isMissing(raw) ? 'required' : `${show(raw)} is not valid`}, use a number from ${MIN_BPM} to ${MAX_BPM}`);
  return null;
}

function readBeats(source, field, fallback, errors, where = '') {
  const raw = source[field];
  if (isMissing(raw)) {
    if (fallback !== undefined) return fallback;
    errors.push(`${where}${field}: required, a number of beats from ${MIN_BEATS} to ${MAX_BEATS}`);
    return null;
  }
  if (typeof raw === 'number' && raw >= MIN_BEATS && raw <= MAX_BEATS) return raw;
  errors.push(`${where}${field}: ${show(raw)} is not valid, use a number of beats from ${MIN_BEATS} to ${MAX_BEATS}`);
  return null;
}

function readRoot(spec, errors) {
  const raw = spec.root;
  const root = parseRoot(raw);
  if (root) return root;
  const problem = isMissing(raw) ? 'required' : `${show(raw)} is not a note name`;
  errors.push(`root: ${problem}, use a letter A to G with an optional # or b and no octave, e.g. "C", "F#", "Bb"`);
  return null;
}

function readStartOctave(spec, hand, errors) {
  const raw = spec.start_octave;
  if (isMissing(raw)) return hand === 'left' ? 3 : 4;
  if (Number.isInteger(raw) && raw >= MIN_START_OCTAVE && raw <= MAX_START_OCTAVE) return raw;
  errors.push(`start_octave: ${show(raw)} is not valid, use a whole number from ${MIN_START_OCTAVE} to `
    + `${MAX_START_OCTAVE} (4 is the octave that starts on middle C, usual values are 2 to 5)`);
  return null;
}

function checkUnknownFields(source, allowed, errors, where, what) {
  for (const field of Object.keys(source)) {
    if (!allowed.includes(field)) {
      errors.push(`${where}${field}: unknown field, ${what} has only ${allowed.join(', ')}`);
    }
  }
}

function beatsSuffix(beats, usual) {
  return beats === usual ? '' : `:b${beatText(beats)}`;
}

// ---------------------------------------------------------------- scales, arpeggios, five-finger patterns

/**
 * Steps for a single melodic line played by one hand, or by both hands in parallel motion one
 * octave apart (left hand below, two notes per step).
 * @param {'right'|'left'|'both'} hand
 * @param {number} startOctave
 * @param {(side: 'right'|'left', octave: number) => {notes: {midi: number, name: string}[], fingers: number[]|null}} makeLine
 * @param {number} beats
 * @returns {Step[]|null} null when a line could not be built
 */
function lineSteps(hand, startOctave, makeLine, beats) {
  const lines = [];
  if (hand !== 'right') lines.push({ tag: 'L', ...makeLine('left', hand === 'both' ? startOctave - 1 : startOctave) });
  if (hand !== 'left') lines.push({ tag: 'R', ...makeLine('right', startOctave) });
  const length = lines[0].notes.length;
  if (length === 0 || lines.some((line) => line.notes.length !== length)) return null;
  for (const line of lines) line.fingers = alignedFingers(line.fingers, length);
  const steps = [];
  for (let i = 0; i < length; i++) {
    steps.push(stepFromEntries(lines.map((line) => ({
      midi: line.notes[i].midi,
      name: line.notes[i].name,
      finger: line.fingers ? line.fingers[i] : null,
      hand: line.tag,
    })), beats));
  }
  return steps;
}

function unspellable(root, what) {
  return `root: "${root.name}" ${what} cannot be written without triple accidentals, use the enharmonic root instead`;
}

function buildScale(spec, common, errors) {
  const root = readRoot(spec, errors);
  const scale = readEnum(spec, 'scale', SCALES, errors);
  const octaves = readEnum(spec, 'octaves', OCTAVE_COUNTS, errors, 1);
  const direction = readEnum(spec, 'direction', DIRECTIONS, errors, 'up_down');
  const startOctave = readStartOctave(spec, common.hand, errors);
  const noteBeats = readBeats(spec, 'note_beats', 1, errors);
  if (errors.length) return null;
  const { hand } = common;
  const steps = lineSteps(hand, startOctave, (side, octave) => ({
    notes: scaleNotes({ root: root.name, scale, startOctave: octave, octaves, direction }),
    fingers: scaleFingering({ root: root.name, scale, hand: side, octaves, direction }),
  }), noteBeats);
  if (!steps) {
    errors.push(unspellable(root, `${SCALE_LABELS[scale]} scale`));
    return null;
  }
  return {
    steps,
    hand,
    beatsPerBar: 4,
    key: SCALE_KEY_MODES[scale] ? { tonic: root.name, mode: SCALE_KEY_MODES[scale] } : null,
    id: `scale:${root.name}:${scale}:${hand}:${octaves}:${direction}:${startOctave}${beatsSuffix(noteBeats, 1)}`,
    autoTitle: `${root.name} ${SCALE_LABELS[scale]} scale, ${HAND_LABELS[hand]}`,
    rangeHint: { field: 'start_octave', value: startOctave },
    fields: { root: root.name, scale, octaves, direction, start_octave: startOctave, note_beats: noteBeats },
  };
}

function buildArpeggio(spec, common, errors) {
  const root = readRoot(spec, errors);
  const quality = readEnum(spec, 'quality', ARPEGGIO_QUALITIES, errors);
  const octaves = readEnum(spec, 'octaves', OCTAVE_COUNTS, errors, 1);
  const direction = readEnum(spec, 'direction', DIRECTIONS, errors, 'up_down');
  const startOctave = readStartOctave(spec, common.hand, errors);
  const noteBeats = readBeats(spec, 'note_beats', 1, errors);
  if (errors.length) return null;
  const { hand } = common;
  const steps = lineSteps(hand, startOctave, (side, octave) => ({
    notes: arpeggioNotes({ root: root.name, quality, startOctave: octave, octaves, direction }),
    fingers: arpeggioFingering({ root: root.name, quality, hand: side, octaves, direction }),
  }), noteBeats);
  if (!steps) {
    errors.push(unspellable(root, `${ARPEGGIO_LABELS[quality]} arpeggio`));
    return null;
  }
  return {
    steps,
    hand,
    beatsPerBar: 4,
    key: { tonic: root.name, mode: ARPEGGIO_KEY_MODES[quality] },
    id: `arpeggio:${root.name}:${quality}:${hand}:${octaves}:${direction}:${startOctave}${beatsSuffix(noteBeats, 1)}`,
    autoTitle: `${root.name} ${ARPEGGIO_LABELS[quality]} arpeggio, ${HAND_LABELS[hand]}`,
    rangeHint: { field: 'start_octave', value: startOctave },
    fields: { root: root.name, quality, octaves, direction, start_octave: startOctave, note_beats: noteBeats },
  };
}

function buildFiveFinger(spec, common, errors) {
  const root = readRoot(spec, errors);
  const quality = readEnum(spec, 'quality', FIVE_FINGER_QUALITIES, errors);
  const pattern = readEnum(spec, 'pattern', Object.keys(FIVE_FINGER_PATTERNS), errors);
  const startOctave = readStartOctave(spec, common.hand, errors);
  const noteBeats = readBeats(spec, 'note_beats', 1, errors);
  if (errors.length) return null;
  const { hand } = common;
  const degrees = FIVE_FINGER_PATTERNS[pattern];
  const scale = quality === 'major' ? 'major' : 'natural_minor';
  const steps = lineSteps(hand, startOctave, (side, octave) => {
    // The first five notes of the scale: one finger per key, the hand does not move.
    const position = scaleNotes({ root: root.name, scale, startOctave: octave, octaves: 1, direction: 'up' }).slice(0, 5);
    if (position.length < 5) return { notes: [], fingers: null };
    return {
      notes: degrees.map((degree) => position[degree - 1]),
      fingers: degrees.map((degree) => (side === 'right' ? degree : 6 - degree)),
    };
  }, noteBeats);
  if (!steps) {
    errors.push(unspellable(root, `${quality} five-finger pattern`));
    return null;
  }
  return {
    steps,
    hand,
    beatsPerBar: 4,
    key: { tonic: root.name, mode: quality },
    id: `five_finger:${root.name}:${quality}:${hand}:${pattern}:${startOctave}${beatsSuffix(noteBeats, 1)}`,
    autoTitle: `${root.name} ${quality} five-finger pattern, ${HAND_LABELS[hand]}`,
    rangeHint: { field: 'start_octave', value: startOctave },
    fields: { root: root.name, quality, pattern, start_octave: startOctave, note_beats: noteBeats },
  };
}

// ---------------------------------------------------------------- chords

/** How far the notes move between two chords (sum of semitone distances, nearest notes paired). */
function movement(previous, next) {
  if (previous.length === next.length) {
    return next.reduce((sum, midi, i) => sum + Math.abs(midi - previous[i]), 0);
  }
  const nearest = (midi, list) => Math.min(...list.map((other) => Math.abs(other - midi)));
  return next.reduce((sum, midi) => sum + nearest(midi, previous), 0)
    + previous.reduce((sum, midi) => sum + nearest(midi, next), 0);
}

function compareScores(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * The inversion and octave of a chord that moves the least from the previous chord, with its
 * lowest note kept within SMOOTH_WINDOW semitones of `home` so that a long progression cannot
 * drift away from the start octave. Ties go to the voicing nearest to home, then to the lower
 * inversion.
 * @returns {{midi: number, name: string}[]|null} null when no playable voicing lies in the window
 */
function smoothVoicing(symbol, toneCount, startOctave, previous, home) {
  let best = null;
  const seen = new Set();
  for (let octave = startOctave - 1; octave <= startOctave + 1; octave++) {
    for (let inversion = 0; inversion < toneCount; inversion++) {
      const notes = chordNotes(symbol, { octave, inversion });
      if (!notes) continue;
      const midis = notes.map((note) => note.midi);
      const id = midis.join(',');
      if (seen.has(id)) continue;
      seen.add(id);
      const low = midis[0];
      const span = midis[midis.length - 1] - low;
      if (Math.abs(low - home) > SMOOTH_WINDOW || span > MAX_HAND_SPAN || midis.length > MAX_HAND_NOTES) continue;
      const score = [movement(previous, midis), Math.abs(low - home), inversion, low];
      if (!best || compareScores(score, best.score) < 0) best = { notes, score };
    }
  }
  return best ? best.notes : null;
}

/** The bass note for the left hand: the named note in `octave`, moved down until it is below `ceiling`. */
function bassBelow(name, octave, ceiling) {
  let at = octave;
  let midi = nameToMidi(`${name}${at}`);
  while (midi !== null && midi >= ceiling) {
    at -= 1;
    midi = nameToMidi(`${name}${at}`);
  }
  return midi === null ? null : { midi, name: `${name}${at}` };
}

function readChordSymbols(spec, errors) {
  const raw = spec.chords;
  if (!Array.isArray(raw)) {
    errors.push(`chords: ${isMissing(raw) ? 'required' : `${show(raw)} is not valid`}, use a list of 1 to ${MAX_CHORDS} `
      + 'chord symbols such as ["C", "F", "G7", "C"]');
    return null;
  }
  if (raw.length < 1 || raw.length > MAX_CHORDS) {
    errors.push(`chords: has ${plural(raw.length, 'chord')}, use 1 to ${MAX_CHORDS}`);
    return null;
  }
  const parsed = raw.map((symbol, index) => {
    const chord = parseChordSymbol(symbol);
    if (!chord) {
      errors.push(`chords[${index}]: ${show(symbol)} is not a chord symbol this app knows, examples: "C", "Am", "G7", `
        + '"Fmaj7", "Bdim", "Dsus4", "F/A" (the root letter must be upper case)');
    }
    return chord;
  });
  return parsed.every(Boolean) ? parsed : null;
}

function buildChords(spec, common, errors) {
  const { hand } = common;
  const parsed = readChordSymbols(spec, errors);
  const style = readEnum(spec, 'style', CHORD_STYLES, errors, 'block');
  const voicing = readEnum(spec, 'voicing', CHORD_VOICINGS, errors, 'root');
  const startOctave = readStartOctave(spec, hand, errors);
  const beatsPerChord = readBeats(spec, 'beats_per_chord', 4, errors);
  if (errors.length) return null;
  if (style === 'broken' && beatsPerChord / 4 < MIN_BEATS) {
    errors.push(`beats_per_chord: ${beatText(beatsPerChord)} is too short for style "broken" (four notes per chord), `
      + `use 1 to ${MAX_BEATS}`);
    return null;
  }
  const side = hand === 'left' ? 'left' : 'right';
  const tag = hand === 'left' ? 'L' : 'R';
  const steps = [];
  let previous = null;
  let home = null;
  parsed.forEach((chord, index) => {
    // With both hands the left hand takes the bass (the root, or the note after the slash) and the
    // right hand plays the plain chord. With one hand a slash chord is voiced by theory.js.
    const symbol = hand === 'both' ? chord.symbol.split('/')[0] : chord.symbol;
    const rootPosition = chordNotes(symbol, { octave: startOctave, inversion: 0 });
    if (!rootPosition) {
      errors.push(`chords[${index}]: "${chord.symbol}" cannot be written without triple accidentals, use the `
        + 'enharmonic root instead');
      return;
    }
    let notes = rootPosition;
    if (voicing === 'smooth' && previous) {
      notes = smoothVoicing(symbol, chord.pcs.length, startOctave, previous, home) ?? rootPosition;
    }
    const midis = notes.map((note) => note.midi);
    if (home === null) home = midis[0];
    previous = midis;
    const fingers = alignedFingers(chordFingering({ hand: side, notes: midis }), midis.length);
    const upper = notes.map((note, i) => ({ midi: note.midi, name: note.name, finger: fingers ? fingers[i] : null, hand: tag }));
    let bass = null;
    if (hand === 'both') {
      const below = bassBelow(chord.bass ?? chord.root, startOctave - 1, midis[0]);
      if (!below) {
        errors.push(`start_octave: ${startOctave} leaves no room for the left-hand bass note of "${chord.symbol}", `
          + 'use a higher start_octave');
        return;
      }
      bass = { midi: below.midi, name: below.name, finger: null, hand: 'L' };
    }
    if (style === 'block') {
      steps.push(stepFromEntries(bass ? [bass, ...upper] : upper, beatsPerChord, chord.symbol));
      return;
    }
    const order = { 2: [0, 1, 0, 1], 3: [0, 1, 2, 1], 4: [0, 1, 2, 3] }[upper.length];
    if (!order) {
      errors.push(`chords[${index}]: "${chord.symbol}" has ${upper.length} notes in one hand, style "broken" works `
        + 'with chords of 2 to 4 notes: use style "block" for this chord');
      return;
    }
    order.forEach((pick, k) => {
      const entries = k === 0 && bass ? [bass, upper[pick]] : [upper[pick]];
      steps.push(stepFromEntries(entries, beatsPerChord / 4, k === 0 ? chord.symbol : undefined));
    });
  });
  if (errors.length) return null;
  const symbols = parsed.map((chord) => chord.symbol);
  const first = parsed[0];
  const shown = symbols.length > 6 ? `${symbols.slice(0, 6).join(' ')} ...` : symbols.join(' ');
  return {
    steps,
    hand,
    beatsPerBar: 4,
    key: first.quality === 'major' || first.quality === 'minor' ? { tonic: first.root, mode: first.quality } : null,
    id: `chords:${symbols.join('-')}:${style}:${voicing}:${hand}:${startOctave}${beatsSuffix(beatsPerChord, 4)}`,
    autoTitle: `Chords ${shown}, ${HAND_LABELS[hand]}`,
    rangeHint: { field: 'start_octave', value: startOctave },
    spanHint: hand === 'both' ? '' : ', use hand "both" so that the left hand takes the bass note',
    fields: { chords: symbols, style, voicing, start_octave: startOctave, beats_per_chord: beatsPerChord },
  };
}

// ---------------------------------------------------------------- custom

const NOTE_NAME_HELP = 'use a letter A to G, an optional # or b, and the octave, e.g. "C4" (middle C), "F#3", "Bb4"';

/** Parse the notes and fingers one hand plays in a custom step. Returns note entries or null. */
function readCustomHand(raw, side, where, errors) {
  const tag = side === 'right' ? 'R' : 'L';
  const fingerField = `${side}_fingers`;
  const names = isMissing(raw[side]) ? [] : raw[side];
  if (!Array.isArray(names)) {
    errors.push(`${where}${side}: ${show(names)} is not valid, use a list of note names such as ["E4", "G4"] or []`);
    return null;
  }
  if (names.length > MAX_HAND_NOTES) {
    errors.push(`${where}${side}: has ${names.length} notes, one hand plays at most ${MAX_HAND_NOTES} keys at once`);
    return null;
  }
  const fingers = isMissing(raw[fingerField]) ? null : raw[fingerField];
  let ok = true;
  if (fingers !== null) {
    if (!Array.isArray(fingers)) {
      errors.push(`${where}${fingerField}: ${show(fingers)} is not valid, use null or one finger number 1 to 5 per note`);
      ok = false;
    } else if (fingers.length !== names.length) {
      errors.push(`${where}${fingerField}: has ${plural(fingers.length, 'finger')} for ${plural(names.length, 'note')} `
        + `in "${side}", give one finger per note in the same order, or null`);
      ok = false;
    } else {
      fingers.forEach((finger, i) => {
        if (finger === null || isFinger(finger)) return;
        errors.push(`${where}${fingerField}[${i}]: ${show(finger)} is not a finger, use 1 (thumb) to 5 (little finger), or null`);
        ok = false;
      });
    }
  }
  const entries = [];
  names.forEach((name, i) => {
    const parsed = typeof name === 'string' ? parseNoteName(name) : null;
    if (!parsed) {
      errors.push(`${where}${side}[${i}]: ${show(name)} is not a note name, ${NOTE_NAME_HELP}`);
      ok = false;
      return;
    }
    const accidental = parsed.alter >= 0 ? '#'.repeat(parsed.alter) : 'b'.repeat(-parsed.alter);
    const spelled = `${parsed.letter}${accidental}${parsed.octave}`;
    if (parsed.midi < PIANO_LOW || parsed.midi > PIANO_HIGH) {
      errors.push(`${where}${side}[${i}]: "${spelled}" is not on the piano, the keys run from A0 to C8`);
      ok = false;
      return;
    }
    entries.push({ midi: parsed.midi, name: spelled, finger: fingers && ok ? fingers[i] : null, hand: tag });
  });
  if (!ok) return null;
  const written = entries.map((entry) => entry.midi);
  entries.sort((a, b) => a.midi - b.midi);
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].midi === entries[i - 1].midi) {
      errors.push(`${where}${side}: ${entries[i - 1].name} and ${entries[i].name} are the same key, list each key once`);
      return null;
    }
  }
  if (entries.length > 1) {
    const span = entries[entries.length - 1].midi - entries[0].midi;
    if (span > MAX_HAND_SPAN) {
      errors.push(`${where}${side}: ${entries[0].name} to ${entries[entries.length - 1].name} is ${span} semitones, `
        + `one hand reaches at most ${MAX_HAND_SPAN} (a ninth)`);
      return null;
    }
  }
  const given = entries.filter((entry) => entry.finger !== null);
  if (given.length) {
    // Fingers are never re-matched by guesswork: with fingers given, the notes must be listed low
    // to high, and the fingers must be playable together (rising in the right hand, falling in
    // the left hand).
    const lowToHigh = entries.map((entry) => entry.name).join(' ');
    if (written.some((midi, i) => midi !== entries[i].midi)) {
      errors.push(`${where}${side}: list the notes from low to high (${lowToHigh}) so that ${fingerField} lines up with them`);
      return null;
    }
    const direction = side === 'right' ? 1 : -1;
    for (let i = 1; i < given.length; i++) {
      if ((given[i].finger - given[i - 1].finger) * direction <= 0) {
        errors.push(`${where}${fingerField}: ${show(fingers)} cannot be played together on ${lowToHigh}, in the ${side} hand `
          + `the finger numbers ${side === 'right' ? 'rise' : 'fall'} from the lowest key to the highest: fix them or use null`);
        return null;
      }
    }
  }
  return entries;
}

function buildCustom(spec, common, errors) {
  const beatsPerBar = readEnum(spec, 'beats_per_bar', BEATS_PER_BAR, errors, 4);
  const rawSteps = spec.steps;
  if (!Array.isArray(rawSteps)) {
    errors.push(`steps: ${isMissing(rawSteps) ? 'required' : `${show(rawSteps)} is not valid`}, use a list of 1 to `
      + `${MAX_STEPS} steps like {"right": ["E4"], "left": [], "beats": 1, "right_fingers": [3], "left_fingers": null}`);
    return null;
  }
  if (rawSteps.length < 1 || rawSteps.length > MAX_STEPS) {
    errors.push(`steps: has ${plural(rawSteps.length, 'step')}, an exercise needs 1 to ${MAX_STEPS}`);
    return null;
  }
  const steps = [];
  rawSteps.forEach((raw, index) => {
    const where = `step ${index + 1}: `;
    if (!isPlainObject(raw)) {
      errors.push(`${where}${show(raw)} is not valid, a step is an object with right, left, beats, right_fingers, left_fingers`);
      return;
    }
    checkUnknownFields(raw, CUSTOM_STEP_FIELDS, errors, where, 'a step');
    const right = readCustomHand(raw, 'right', where, errors);
    const left = readCustomHand(raw, 'left', where, errors);
    const beats = readBeats(raw, 'beats', undefined, errors, where);
    if (!right || !left || beats === null) return;
    const shared = right.find((note) => left.some((other) => other.midi === note.midi));
    if (shared) {
      errors.push(`${where}${shared.name} is in both hands, a key can be played by one hand only`);
      return;
    }
    steps.push(stepFromEntries([...left, ...right], beats));
  });
  if (errors.length) return null;
  const hand = handOfSteps(steps);
  if (!hand) {
    errors.push('steps: every step is a rest, an exercise needs at least one note');
    return null;
  }
  const content = steps.map((step) => `${handPart(step, 'L').notes.join(',')}/${handPart(step, 'R').notes.join(',')}/${beatText(step.beats)}`);
  return {
    steps,
    hand,
    beatsPerBar,
    key: null,
    id: `custom:${hashText(`${beatsPerBar}|${content.join(';')}`)}`,
    autoTitle: 'Custom exercise',
    rangeHint: null,
    fields: null,
  };
}

// ---------------------------------------------------------------- buildExercise

const BUILDERS = {
  scale: buildScale,
  arpeggio: buildArpeggio,
  five_finger: buildFiveFinger,
  chords: buildChords,
  custom: buildCustom,
};

function failure(errors) {
  const unique = [...new Set(errors)];
  const shown = unique.slice(0, MAX_ERRORS);
  if (unique.length > MAX_ERRORS) shown.push(`and ${plural(unique.length - MAX_ERRORS, 'more problem')}`);
  return { ok: false, errors: shown };
}

/** Limits every built exercise must respect, whatever produced its steps. */
function checkBuiltSteps(built, errors) {
  const { steps, rangeHint, spanHint = '' } = built;
  if (steps.length < 1 || steps.length > MAX_STEPS) {
    errors.push(`the exercise would have ${plural(steps.length, 'step')}, the limit is 1 to ${MAX_STEPS}`);
  }
  let tooLow = false;
  let tooHigh = false;
  steps.forEach((step, index) => {
    const where = `step ${index + 1}${step.label ? ` (${step.label})` : ''}`;
    step.notes.forEach((midi, i) => {
      if (midi < PIANO_LOW && !tooLow) {
        tooLow = true;
        const fix = rangeHint ? `${rangeHint.field} ${rangeHint.value} is too low, use a higher ${rangeHint.field}` : 'use a higher octave';
        errors.push(`${where}: ${step.names[i]} is below the lowest piano key (A0): ${fix}`);
      } else if (midi > PIANO_HIGH && !tooHigh) {
        tooHigh = true;
        const fix = rangeHint ? `${rangeHint.field} ${rangeHint.value} is too high, use a lower ${rangeHint.field}` : 'use a lower octave';
        errors.push(`${where}: ${step.names[i]} is above the highest piano key (C8): ${fix}`);
      }
    });
    for (const tag of ['L', 'R']) {
      const part = handPart(step, tag);
      const side = tag === 'L' ? 'left' : 'right';
      if (part.notes.length > MAX_HAND_NOTES) {
        errors.push(`${where}: the ${side} hand would play ${part.notes.length} keys at once (${part.names.join(' ')}), `
          + `the limit is ${MAX_HAND_NOTES}${spanHint}`);
      } else if (part.notes.length > 1 && part.notes[part.notes.length - 1] - part.notes[0] > MAX_HAND_SPAN) {
        errors.push(`${where}: the ${side} hand would have to reach ${part.notes[part.notes.length - 1] - part.notes[0]} `
          + `semitones (${part.names.join(' ')}), the limit is ${MAX_HAND_SPAN}${spanHint}`);
      }
    }
    if (!(step.beats >= MIN_BEATS && step.beats <= MAX_BEATS)) {
      errors.push(`${where}: lasts ${show(step.beats)} beats, a step lasts ${MIN_BEATS} to ${MAX_BEATS} beats`);
    }
  });
}

function buildChecked(spec) {
  if (!isPlainObject(spec)) {
    return failure([`the exercise spec must be a JSON object with a "type" field (${quoted(TYPES)}), got ${show(spec)}`]);
  }
  const type = typeof spec.type === 'string' ? spec.type.trim().toLowerCase() : spec.type;
  if (!TYPES.includes(type)) {
    const problem = isMissing(spec.type) ? 'required' : `${show(spec.type)} is not valid`;
    return failure([`type: ${problem}, use one of ${quoted(TYPES)}`]);
  }
  const errors = [];
  checkUnknownFields(spec, [...COMMON_FIELDS, ...TYPE_FIELDS[type]], errors, '', `a "${type}" exercise`);
  const common = {
    title: readText(spec, 'title', MAX_TITLE, errors),
    goal: readText(spec, 'goal', MAX_GOAL, errors),
    // The hand of a custom exercise is derived from its steps; a hand written in the spec is only
    // checked for being a valid value.
    hand: type === 'custom' && isMissing(spec.hand) ? null : readEnum(spec, 'hand', HANDS, errors),
    bpm: readBpm(spec, errors),
    mode: readEnum(spec, 'mode', MODES, errors),
  };
  const built = BUILDERS[type](spec, common, errors);
  if (!built || errors.length) return failure(errors.length ? errors : ['the exercise could not be built']);
  checkBuiltSteps(built, errors);
  if (errors.length) return failure(errors);

  const shared = {
    title: common.title || built.autoTitle,
    goal: common.goal,
    hand: built.hand,
    bpm: common.bpm,
    mode: common.mode,
  };
  const exercise = {
    id: built.id,
    title: shared.title,
    goal: shared.goal,
    type,
    hand: shared.hand,
    bpm: shared.bpm,
    mode: shared.mode,
    beatsPerBar: built.beatsPerBar,
    steps: built.steps,
    key: built.key,
    spec: built.fields
      ? { type, ...shared, ...built.fields }
      : customSpecFromSteps({ ...shared, beatsPerBar: built.beatsPerBar }, built.steps),
  };
  const problems = validateExercise(exercise);
  return problems.length ? failure(problems) : { ok: true, exercise };
}

/**
 * Turn an exercise spec into a concrete exercise. Never throws: anything that is wrong with the
 * spec comes back as a list of messages that name the field, the bad value and what is allowed.
 *
 * bpm is rounded and clamped to 30..200, enum values are matched without regard to letter case,
 * and a few fields have defaults when missing (start_octave 4, or 3 for the left hand; note_beats 1;
 * octaves 1; direction 'up_down'; beats_per_chord 4; style 'block'; voicing 'root'; beats_per_bar 4;
 * title derived from the content; goal ''). Everything musically wrong is rejected, never fixed,
 * and so are fields the spec type does not have (a misspelled field would otherwise silently fall
 * back to its default).
 *
 * In a custom step, notes may be listed in any order when no fingers are given. With fingers the
 * notes must be listed low to high and the fingers must be playable together (rising in the right
 * hand, falling in the left hand), so a finger can never end up on the wrong note.
 *
 * The returned exercise carries a normalized copy of the spec (defaults filled in, names and
 * symbols normalized, bpm clamped): building that copy again gives the same exercise.
 *
 * @param {ExerciseSpec} spec
 * @returns {{ok: true, exercise: Exercise}|{ok: false, errors: string[]}}
 */
export function buildExercise(spec) {
  try {
    return buildChecked(spec);
  } catch (error) {
    return failure([`the exercise spec could not be read (${error instanceof Error ? error.message : 'unexpected value'})`]);
  }
}

// ---------------------------------------------------------------- validateExercise

function stepProblems(step, index, type, problems) {
  const where = `steps[${index}]`;
  if (!isPlainObject(step)) {
    problems.push(`${where} must be an object`);
    return;
  }
  const { notes, names, fingers, hands } = step;
  if (!Array.isArray(notes) || !Array.isArray(names) || !Array.isArray(fingers) || !Array.isArray(hands)) {
    problems.push(`${where} needs notes, names, fingers and hands arrays`);
    return;
  }
  if (names.length !== notes.length || fingers.length !== notes.length || hands.length !== notes.length) {
    problems.push(`${where}: names, fingers and hands must have one entry per note`);
    return;
  }
  if (notes.length > 2 * MAX_HAND_NOTES) problems.push(`${where} has ${notes.length} notes, the limit is ${2 * MAX_HAND_NOTES}`);
  if (notes.length === 0 && type !== 'custom') problems.push(`${where} is a rest, only custom exercises may contain rests`);
  notes.forEach((midi, i) => {
    if (!Number.isInteger(midi) || midi < PIANO_LOW || midi > PIANO_HIGH) {
      problems.push(`${where}.notes[${i}] must be a MIDI number from ${PIANO_LOW} to ${PIANO_HIGH}`);
    } else if (i > 0 && !(midi > notes[i - 1])) {
      problems.push(`${where}.notes must be ascending without repeats`);
    }
    if (typeof names[i] !== 'string' || nameToMidi(names[i]) !== midi) {
      problems.push(`${where}.names[${i}] must be the spelled name of notes[${i}]`);
    }
    if (fingers[i] !== null && !isFinger(fingers[i])) problems.push(`${where}.fingers[${i}] must be 1..5 or null`);
    if (hands[i] !== 'L' && hands[i] !== 'R') problems.push(`${where}.hands[${i}] must be 'L' or 'R'`);
  });
  for (const tag of ['L', 'R']) {
    const part = notes.filter((midi, i) => hands[i] === tag && Number.isInteger(midi));
    if (part.length > MAX_HAND_NOTES) problems.push(`${where} has ${part.length} notes in one hand, the limit is ${MAX_HAND_NOTES}`);
    if (part.length > 1 && Math.max(...part) - Math.min(...part) > MAX_HAND_SPAN) {
      problems.push(`${where} spans more than ${MAX_HAND_SPAN} semitones in one hand`);
    }
  }
  if (typeof step.beats !== 'number' || !(step.beats >= MIN_BEATS && step.beats <= MAX_BEATS)) {
    problems.push(`${where}.beats must be a number from ${MIN_BEATS} to ${MAX_BEATS}`);
  }
  if (step.label !== undefined && typeof step.label !== 'string') problems.push(`${where}.label must be a string when present`);
}

function exerciseProblems(exercise) {
  if (!isPlainObject(exercise)) return ['exercise must be an object'];
  const problems = [];
  if (typeof exercise.id !== 'string' || exercise.id === '') problems.push('id must be a non-empty string');
  if (typeof exercise.title !== 'string' || exercise.title === '') problems.push('title must be a non-empty string');
  if (typeof exercise.goal !== 'string') problems.push('goal must be a string');
  if (!TYPES.includes(exercise.type)) problems.push(`type must be one of ${quoted(TYPES)}`);
  if (!HANDS.includes(exercise.hand)) problems.push(`hand must be one of ${quoted(HANDS)}`);
  if (!Number.isInteger(exercise.bpm) || exercise.bpm < MIN_BPM || exercise.bpm > MAX_BPM) {
    problems.push(`bpm must be an integer from ${MIN_BPM} to ${MAX_BPM}`);
  }
  if (!MODES.includes(exercise.mode)) problems.push(`mode must be one of ${quoted(MODES)}`);
  if (!BEATS_PER_BAR.includes(exercise.beatsPerBar)) problems.push(`beatsPerBar must be one of ${quoted(BEATS_PER_BAR)}`);
  const { key } = exercise;
  if (key !== null && !(isPlainObject(key) && parseRoot(key.tonic) && (key.mode === 'major' || key.mode === 'minor'))) {
    problems.push("key must be null or { tonic, mode: 'major'|'minor' }");
  }
  if (!isPlainObject(exercise.spec)) problems.push('spec must be an object');
  const { steps } = exercise;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) {
    problems.push(`steps must be an array of 1 to ${MAX_STEPS} steps`);
    return problems;
  }
  for (let i = 0; i < steps.length && problems.length < 20; i++) stepProblems(steps[i], i, exercise.type, problems);
  if (problems.length === 0) {
    const hand = handOfSteps(steps);
    if (!hand) problems.push('steps must contain at least one note');
    else if (hand !== exercise.hand) problems.push(`hand is '${exercise.hand}' but the steps use ${HAND_LABELS[hand]}`);
  }
  return problems;
}

/**
 * Check the invariants of a concrete Exercise (for example one read back from storage).
 * @param {Exercise} exercise
 * @returns {string[]} problems found, empty when the exercise is valid. Never throws.
 */
export function validateExercise(exercise) {
  try {
    return exerciseProblems(exercise);
  } catch {
    return ['exercise could not be checked'];
  }
}

// ---------------------------------------------------------------- drills and tempo changes

/**
 * Cut a drill out of an exercise: the steps fromStep..toStep (0-based, inclusive).
 * The drill keeps the type, tempo, mode and key; its id is the parent id plus ':from-to', its title
 * is 'Drill: <parent title>, steps a to b' (1-based, as shown to the learner), its hand is the hand
 * the kept steps really use, and its spec is a custom spec that builds exactly the kept steps.
 * @param {Exercise} exercise
 * @param {number} fromStep
 * @param {number} toStep
 * @returns {Exercise}
 * @throws {RangeError} when the range is not inside the exercise, holds only rests, or there is no exercise
 */
export function sliceExercise(exercise, fromStep, toStep) {
  if (!isPlainObject(exercise) || !Array.isArray(exercise.steps)) {
    throw new RangeError('sliceExercise: there is no exercise to cut a drill from');
  }
  const count = exercise.steps.length;
  if (!Number.isInteger(fromStep) || !Number.isInteger(toStep) || fromStep < 0 || toStep >= count || fromStep > toStep) {
    throw new RangeError(`sliceExercise: steps ${show(fromStep)} to ${show(toStep)} are not a range inside 0..${count - 1}`);
  }
  const steps = exercise.steps.slice(fromStep, toStep + 1).map(copyStep);
  const hand = handOfSteps(steps);
  if (!hand) throw new RangeError(`sliceExercise: steps ${fromStep} to ${toStep} contain only rests`);
  const parentTitle = String(exercise.title ?? '').replace(/^Drill: /, '');
  const title = `Drill: ${parentTitle}, ${fromStep === toStep ? `step ${fromStep + 1}` : `steps ${fromStep + 1} to ${toStep + 1}`}`;
  const drill = {
    id: `${exercise.id}:${fromStep}-${toStep}`,
    title,
    goal: exercise.goal,
    type: exercise.type,
    hand,
    bpm: exercise.bpm,
    mode: exercise.mode,
    beatsPerBar: exercise.beatsPerBar,
    steps,
    key: isPlainObject(exercise.key) ? { ...exercise.key } : null,
  };
  drill.spec = customSpecFromSteps(drill, steps);
  return drill;
}

/**
 * The same exercise at another tempo and/or in another mode. bpm is rounded and clamped to
 * 30..200. A bpm that is not a finite number, or a mode that is not 'wait' or 'tempo', leaves that
 * setting unchanged. The id does not change, so progress history carries over.
 * @param {Exercise} exercise
 * @param {{bpm?: number, mode?: 'wait'|'tempo'}} [changes]
 * @returns {Exercise} a new exercise, the argument is not modified
 * @throws {TypeError} when `exercise` is not an exercise object
 */
export function withTempo(exercise, changes) {
  if (!isPlainObject(exercise) || !Array.isArray(exercise.steps)) {
    throw new TypeError('withTempo: the first argument must be an exercise');
  }
  const { bpm, mode } = isPlainObject(changes) ? changes : {};
  const nextBpm = typeof bpm === 'number' && Number.isFinite(bpm) ? clampBpm(bpm) : exercise.bpm;
  const nextMode = MODES.includes(mode) ? mode : exercise.mode;
  const spec = cloneJson(exercise.spec);
  return {
    ...exercise,
    bpm: nextBpm,
    mode: nextMode,
    steps: exercise.steps.map((step) => (isPlainObject(step) && Array.isArray(step.notes) ? copyStep(step) : step)),
    key: isPlainObject(exercise.key) ? { ...exercise.key } : exercise.key,
    spec: isPlainObject(spec) ? { ...spec, bpm: nextBpm, mode: nextMode } : spec,
  };
}

// ---------------------------------------------------------------- describeExercise

function describeNotes(names, fingers) {
  const known = fingers.some((finger) => finger !== null);
  if (names.length === 1) return known ? `${names[0]}(${fingers[0]})` : names[0];
  const fingerText = known ? `(${fingers.map((finger) => finger ?? '-').join(' ')})` : '';
  return `[${names.join(' ')}]${fingerText}`;
}

function describeStep(step, withHands) {
  if (step.notes.length === 0) return 'rest';
  if (!withHands) return describeNotes(step.names, step.fingers);
  const parts = [];
  for (const tag of ['L', 'R']) {
    const part = handPart(step, tag);
    if (part.notes.length) parts.push(`${tag} ${describeNotes(part.names, part.fingers)}`);
  }
  return parts.join(' + ');
}

/**
 * Compact text for the coach: one header line, then every step on a second line.
 *
 *   C major scale, right hand (scale, right hand). 72 bpm, wait mode, 15 steps of 1 beat.
 *   1:C4(1) 2:D4(2) 3:E4(3) ...
 *
 * Step numbers are 1-based. A finger follows its note in round brackets and is left out when it is
 * unknown. Notes played together by one hand are written '[C4 E4 G4](1 3 5)'. Exercises for both
 * hands mark each hand: '1:L C3(5) + R C4(1)'. A chord symbol comes before the notes: '1:C=[C4 E4 G4](1 3 5)'.
 * A rest is 'rest'. When steps differ in length, those that are not the usual length carry their
 * beats in curly brackets: '13:E4(3){1.5}'.
 * @param {Exercise} exercise
 * @returns {string} '' when the argument is not an exercise
 */
export function describeExercise(exercise) {
  try {
    if (!isPlainObject(exercise) || !Array.isArray(exercise.steps) || exercise.steps.length === 0) return '';
    const { steps } = exercise;
    const counts = new Map();
    for (const step of steps) counts.set(step.beats, (counts.get(step.beats) ?? 0) + 1);
    let usual = steps[0].beats;
    for (const [beats, count] of counts) {
      if (count > counts.get(usual)) usual = beats;
    }
    const usualText = `${beatText(usual)} ${usual === 1 ? 'beat' : 'beats'}`;
    const lengthText = counts.size === 1 ? ` of ${usualText}` : `, ${usualText} each unless marked {beats}`;
    const handText = exercise.hand === 'both' ? 'both hands' : `${exercise.hand} hand`;
    const header = `${exercise.title} (${String(exercise.type).replace(/_/g, ' ')}, ${handText}). ${exercise.bpm} bpm, `
      + `${exercise.mode} mode, ${plural(steps.length, 'step')}${lengthText}.`;
    const withHands = exercise.hand === 'both';
    const body = steps.map((step, index) => {
      const label = typeof step.label === 'string' && step.label ? `${step.label}=` : '';
      const length = step.beats === usual ? '' : `{${beatText(step.beats)}}`;
      return `${index + 1}:${label}${describeStep(step, withHands)}${length}`;
    });
    return `${header}\n${body.join(' ')}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- starter library

const C_POSITION_FINGERS = { C4: 1, D4: 2, E4: 3, F4: 4, G4: 5 };
/** Beethoven, Ode to Joy (1824, public domain), opening phrase in C position: [note, beats]. */
const ODE_TO_JOY = [['E4', 1], ['E4', 1], ['F4', 1], ['G4', 1], ['G4', 1], ['F4', 1], ['E4', 1], ['D4', 1],
  ['C4', 1], ['C4', 1], ['D4', 1], ['E4', 1], ['E4', 1.5], ['D4', 0.5], ['D4', 2]];

/**
 * A first-weeks path for an adult beginner, easiest first: five-finger patterns, a first tune,
 * the first scales (hands separately, then together), an arpeggio, chords and a first minor scale.
 * Every spec builds with buildExercise and matches EXERCISE_SPEC_JSON_SCHEMA.
 * @type {ReadonlyArray<ExerciseSpec>}
 */
export const STARTER_EXERCISES = deepFreeze([
  {
    type: 'five_finger',
    title: 'C five-finger pattern, right hand',
    goal: 'Put your thumb on middle C, keep one finger over each key, and walk up and back down evenly.',
    hand: 'right',
    bpm: 60,
    mode: 'wait',
    root: 'C',
    quality: 'major',
    pattern: 'up_down',
    start_octave: 4,
    note_beats: 1,
  },
  {
    type: 'five_finger',
    title: 'C five-finger pattern, left hand',
    goal: 'Start with your little finger on the C below middle C and keep every note the same length.',
    hand: 'left',
    bpm: 60,
    mode: 'wait',
    root: 'C',
    quality: 'major',
    pattern: 'up_down',
    start_octave: 3,
    note_beats: 1,
  },
  {
    type: 'five_finger',
    title: 'C five-finger pattern in thirds, right hand',
    goal: 'Up a skip, then back a step. Your hand stays still and only the fingers move.',
    hand: 'right',
    bpm: 60,
    mode: 'wait',
    root: 'C',
    quality: 'major',
    pattern: 'thirds',
    start_octave: 4,
    note_beats: 1,
  },
  {
    type: 'custom',
    title: 'Ode to Joy, opening phrase',
    goal: 'Your hand stays in one place with the thumb on middle C. Get the notes right first, the rhythm comes after.',
    hand: 'right',
    bpm: 66,
    mode: 'wait',
    beats_per_bar: 4,
    steps: ODE_TO_JOY.map(([note, beats]) => ({
      right: [note],
      left: [],
      beats,
      right_fingers: [C_POSITION_FINGERS[note]],
      left_fingers: null,
    })),
  },
  {
    type: 'scale',
    title: 'C major scale, right hand',
    goal: 'Going up, tuck your thumb under after finger 3. Coming down, cross finger 3 over your thumb.',
    hand: 'right',
    bpm: 60,
    mode: 'wait',
    root: 'C',
    scale: 'major',
    octaves: 1,
    direction: 'up_down',
    start_octave: 4,
    note_beats: 1,
  },
  {
    type: 'scale',
    title: 'C major scale, left hand',
    goal: 'Going up, cross finger 3 over your thumb after G. Coming down, tuck your thumb under after A.',
    hand: 'left',
    bpm: 60,
    mode: 'wait',
    root: 'C',
    scale: 'major',
    octaves: 1,
    direction: 'up_down',
    start_octave: 3,
    note_beats: 1,
  },
  {
    type: 'scale',
    title: 'G major scale, right hand',
    goal: 'Same fingering as C major, with one black key: F sharp, played by finger 4 just before the top.',
    hand: 'right',
    bpm: 60,
    mode: 'wait',
    root: 'G',
    scale: 'major',
    octaves: 1,
    direction: 'up_down',
    start_octave: 4,
    note_beats: 1,
  },
  {
    type: 'scale',
    title: 'F major scale, right hand',
    goal: 'Finger 4 plays B flat, then your thumb tucks under to C. The scale ends on finger 4, not 5.',
    hand: 'right',
    bpm: 60,
    mode: 'wait',
    root: 'F',
    scale: 'major',
    octaves: 1,
    direction: 'up_down',
    start_octave: 4,
    note_beats: 1,
  },
  {
    type: 'arpeggio',
    title: 'C major arpeggio, right hand',
    goal: 'Open your hand to reach each key and keep your wrist loose as you move up to the top C.',
    hand: 'right',
    bpm: 60,
    mode: 'wait',
    root: 'C',
    quality: 'major',
    octaves: 1,
    direction: 'up_down',
    start_octave: 4,
    note_beats: 1,
  },
  {
    type: 'chords',
    title: 'C, F and G chords, right hand',
    goal: 'Press all three keys of each chord at the same moment, then move your whole hand to the next chord.',
    hand: 'right',
    bpm: 60,
    mode: 'wait',
    chords: ['C', 'F', 'G', 'C'],
    style: 'block',
    voicing: 'root',
    start_octave: 4,
    beats_per_chord: 4,
  },
  {
    type: 'chords',
    title: 'C, A minor, F and G chords with smooth changes',
    goal: 'Each chord keeps the keys it shares with the one before. Move only the fingers that have to change.',
    hand: 'right',
    bpm: 60,
    mode: 'wait',
    chords: ['C', 'Am', 'F', 'G'],
    style: 'block',
    voicing: 'smooth',
    start_octave: 4,
    beats_per_chord: 4,
  },
  {
    type: 'scale',
    title: 'A harmonic minor scale, right hand',
    goal: 'Same fingering as C major. Listen for the wide step from F up to G sharp near the top.',
    hand: 'right',
    bpm: 60,
    mode: 'wait',
    root: 'A',
    scale: 'harmonic_minor',
    octaves: 1,
    direction: 'up_down',
    start_octave: 4,
    note_beats: 1,
  },
  {
    type: 'scale',
    title: 'C major scale, hands together',
    goal: 'Go slowly. The two hands change fingers at different moments, so let each hand keep its own fingering.',
    hand: 'both',
    bpm: 50,
    mode: 'wait',
    root: 'C',
    scale: 'major',
    octaves: 1,
    direction: 'up_down',
    start_octave: 4,
    note_beats: 1,
  },
]);

// ---------------------------------------------------------------- JSON schema

const NOTE_NAME_DESCRIPTION = 'Note name in scientific pitch notation: a letter A to G, an optional # or b, then the '
  + 'octave number. C4 = middle C, and the octave number changes at C, so the key just below middle C is B3. '
  + 'Examples: "C4", "F#3", "Bb4".';

function specSchema() {
  const string = (description) => ({ type: 'string', description });
  const choice = (type, values, description) => ({ type, enum: values.slice(), description });
  const object = (description, properties) => ({
    type: 'object',
    description,
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  const variant = (type, description, handDescription, properties) => object(description, {
    type: { type: 'string', const: type },
    title: string('Short name shown above the exercise, for example "G major scale, right hand".'),
    goal: string('One plain sentence to the learner about what to focus on.'),
    hand: choice('string', HANDS, handDescription),
    bpm: { type: 'integer', description: 'Tempo in beats per minute, 30 to 200. Beginners usually 50 to 80.' },
    mode: choice('string', MODES, '"wait": the app waits for each correct note, no metronome. "tempo": played in time '
      + 'with the metronome.'),
    ...properties,
  });
  const root = () => string('Root note: a letter A to G with an optional # or b, no octave. Examples: "C", "F#", '
    + '"Bb". The spelling is kept as written: "C#" and "Db" are the same keys with different note names.');
  const startOctave = () => ({
    type: 'integer',
    description: 'Octave of the lowest note of the right hand, or of the left hand when hand is "left". 4 is the '
      + 'octave that starts on middle C (C4). With hand "both" the left hand plays one octave below. Usual values: 4 '
      + 'for the right hand and for both hands, 3 or 2 for the left hand alone.',
  });
  const noteBeats = () => ({ type: 'number', description: 'Length of each note in beats, 0.25 to 8. Usually 1.' });
  const octaves = () => choice('integer', OCTAVE_COUNTS, 'How many octaves the pattern covers.');
  const direction = () => choice('string', DIRECTIONS, '"up_down" goes up and comes back down without repeating the '
    + 'top note.');
  const parallelHands = 'With "both" the hands play the same notes one octave apart.';
  const handNotes = (side) => ({
    type: 'array',
    items: string(NOTE_NAME_DESCRIPTION),
    description: `Keys the ${side} hand presses together in this step, low to high, at most 5. Empty when the ${side} `
      + 'hand does not play in this step.',
  });
  const handFingers = (side) => ({
    anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }],
    description: `One finger number for each note of "${side}", in the same order: 1 = thumb, 5 = little finger. `
      + 'null when you are not sure: never guess a fingering.',
  });
  return {
    description: 'One exercise for the learner. The "type" field selects the kind.',
    anyOf: [
      variant('scale', 'A scale. The app supplies the notes and the standard fingering.', parallelHands, {
        root: root(),
        scale: choice('string', SCALES, 'Finger numbers are shown for major, natural_minor, harmonic_minor and '
          + 'chromatic scales and for melodic_minor on white-key roots. Pentatonic and blues scales are shown without '
          + 'finger numbers.'),
        octaves: octaves(),
        direction: direction(),
        start_octave: startOctave(),
        note_beats: noteBeats(),
      }),
      variant('arpeggio', 'An arpeggio: the notes of a chord one at a time, with the root again on top.', parallelHands, {
        root: root(),
        quality: choice('string', ARPEGGIO_QUALITIES, 'Finger numbers are shown for major and minor only.'),
        octaves: octaves(),
        direction: direction(),
        start_octave: startOctave(),
        note_beats: noteBeats(),
      }),
      variant('five_finger', 'A five-finger pattern: the first five notes of a scale, one finger per key, the hand '
        + 'does not move.', parallelHands, {
        root: root(),
        quality: choice('string', FIVE_FINGER_QUALITIES, 'Major or minor five-finger position.'),
        pattern: choice('string', Object.keys(FIVE_FINGER_PATTERNS), 'Scale degrees played: up_down = 1 2 3 4 5 4 3 2 1, '
          + 'thirds = 1 3 2 4 3 5 4 2 1, triad = 1 3 5 3 1.'),
        start_octave: startOctave(),
        note_beats: noteBeats(),
      }),
      variant('chords', 'A chord progression.', 'With "both" the left hand plays one bass note (the chord root, or the '
        + 'note after the slash) and the right hand plays the chord.', {
        chords: {
          type: 'array',
          items: string('Chord symbol with an upper-case root, for example "C", "Am", "G7", "Fmaj7", "Bdim", "Dsus4", '
            + '"F/A".'),
          description: '1 to 16 chord symbols, played in order.',
        },
        style: choice('string', CHORD_STYLES, '"block": all notes of the chord together. "broken": one note at a time, '
          + 'four notes per chord.'),
        voicing: choice('string', CHORD_VOICINGS, '"root": every chord in root position. "smooth": each chord in the '
          + 'inversion nearest to the chord before it.'),
        start_octave: startOctave(),
        beats_per_chord: { type: 'number', description: 'Beats each chord lasts, 0.25 to 8 (at least 1 for style '
          + '"broken"). Usually 4.' },
      }),
      variant('custom', 'A tune or pattern written out step by step. Use it only when the other types cannot express '
        + 'the exercise.', 'The app works the hand out from the steps. Send the hand that plays ("both" when both do).', {
        beats_per_bar: choice('integer', BEATS_PER_BAR, 'Beats in each bar: 4 for 4/4 time, 3 for 3/4 time.'),
        steps: {
          type: 'array',
          description: '1 to 128 steps, played in order.',
          items: object('One step: the keys pressed at the same moment. Leave both "right" and "left" empty for a rest.', {
            right: handNotes('right'),
            left: handNotes('left'),
            beats: { type: 'number', description: 'Beats until the next step starts, 0.25 to 8. In 4/4 time 1 is a '
              + 'quarter note, 0.5 an eighth note, 2 a half note.' },
            right_fingers: handFingers('right'),
            left_fingers: handFingers('left'),
          }),
        },
      }),
    ],
  };
}

/**
 * JSON Schema for ExerciseSpec, written for Claude strict structured outputs: a union (anyOf) of
 * five object variants told apart by a constant "type"; every object lists all of its properties
 * as required and has additionalProperties false; nullable fields use anyOf with {type: 'null'};
 * no numeric, string or array constraints, no $ref and no recursion (so it can be embedded as a
 * property of a larger schema as is). It uses 3 union-typed parameters (the variant union and the
 * two nullable finger lists) and no optional parameters. Ranges are enforced by buildExercise.
 */
export const EXERCISE_SPEC_JSON_SCHEMA = deepFreeze(specSchema());
