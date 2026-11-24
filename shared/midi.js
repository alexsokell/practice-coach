// Core MIDI helpers shared by the browser app, the server and the tests.
// Pure functions only: no DOM, no Node APIs.

/** Middle C is C4 = MIDI 60 (scientific pitch notation) everywhere in this project. */
export const MIDDLE_C = 60;
export const PIANO_LOW = 21; // A0
export const PIANO_HIGH = 108; // C8

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];

/** Pitch class 0..11 (C = 0) of a MIDI note number. */
export function pitchClass(midi) {
  return ((midi % 12) + 12) % 12;
}

export function isBlackKey(midi) {
  return BLACK[pitchClass(midi)];
}

/** Octave number in scientific pitch notation (MIDI 60 -> 4). */
export function octaveOf(midi) {
  return Math.floor(midi / 12) - 1;
}

/**
 * MIDI number -> note name such as "C#4" (or "Db4" with {flats: true}).
 * This is a context-free spelling; use the names stored on exercise steps
 * when a key-aware spelling matters.
 */
export function midiToName(midi, { flats = false, octave = true } = {}) {
  if (!Number.isInteger(midi)) return '';
  const name = (flats ? FLAT_NAMES : SHARP_NAMES)[pitchClass(midi)];
  return octave ? `${name}${octaveOf(midi)}` : name;
}

/**
 * Note name -> MIDI number, or null when the text is not a note name.
 * Accepts "C4", "c#4", "Db3", "E#4", "Cb5", "F##2", "Bbb3" and the unicode
 * accidentals. The octave is required.
 */
export function nameToMidi(name) {
  if (typeof name !== 'string') return null;
  const m = /^\s*([A-Ga-g])([#b♯♭x]{0,2})(-?\d)\s*$/.exec(name);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  let alter = 0;
  for (const ch of m[2]) {
    if (ch === '#' || ch === '♯') alter += 1;
    else if (ch === 'b' || ch === '♭') alter -= 1;
    else if (ch === 'x') alter += 2;
  }
  const octave = Number(m[3]);
  const midi = (octave + 1) * 12 + LETTER_PC[letter] + alter;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/**
 * Split a spelled note name into its parts, or null.
 * "Bb3" -> { letter: "B", alter: -1, octave: 3, midi: 58 }
 */
export function parseNoteName(name) {
  const midi = nameToMidi(name);
  if (midi === null) return null;
  const m = /^\s*([A-Ga-g])([#b♯♭x]{0,2})(-?\d)\s*$/.exec(name);
  let alter = 0;
  for (const ch of m[2]) {
    if (ch === '#' || ch === '♯') alter += 1;
    else if (ch === 'b' || ch === '♭') alter -= 1;
    else if (ch === 'x') alter += 2;
  }
  return { letter: m[1].toUpperCase(), alter, octave: Number(m[3]), midi };
}

/**
 * Decode one complete MIDI message (status byte first).
 * Note-on with velocity 0 is reported as note-off, as the MIDI spec allows.
 * @param {ArrayLike<number>} bytes
 * @returns {{type: string, channel?: number, note?: number, velocity?: number,
 *   controller?: number, value?: number, program?: number, raw: ArrayLike<number>}}
 */
export function decodeMidiMessage(bytes) {
  const status = bytes[0];
  if (status === undefined || status < 0x80) return { type: 'invalid', raw: bytes };
  if (status >= 0xf0) {
    const system = {
      0xf0: 'sysex',
      0xf1: 'timecode',
      0xf2: 'songposition',
      0xf3: 'songselect',
      0xf6: 'tunerequest',
      0xf8: 'clock',
      0xfa: 'start',
      0xfb: 'continue',
      0xfc: 'stop',
      0xfe: 'activesensing',
      0xff: 'reset',
    };
    return { type: system[status] ?? 'other', raw: bytes };
  }
  const kind = status & 0xf0;
  const channel = status & 0x0f;
  const d1 = bytes[1] ?? 0;
  const d2 = bytes[2] ?? 0;
  switch (kind) {
    case 0x90:
      return d2 === 0
        ? { type: 'noteoff', channel, note: d1, velocity: 0, raw: bytes }
        : { type: 'noteon', channel, note: d1, velocity: d2, raw: bytes };
    case 0x80:
      return { type: 'noteoff', channel, note: d1, velocity: d2, raw: bytes };
    case 0xa0:
      return { type: 'polyaftertouch', channel, note: d1, value: d2, raw: bytes };
    case 0xb0:
      return { type: 'cc', channel, controller: d1, value: d2, raw: bytes };
    case 0xc0:
      return { type: 'programchange', channel, program: d1, raw: bytes };
    case 0xd0:
      return { type: 'aftertouch', channel, value: d1, raw: bytes };
    case 0xe0:
      return { type: 'pitchbend', channel, value: ((d2 << 7) | d1) - 8192, raw: bytes };
    default:
      return { type: 'other', raw: bytes };
  }
}

/** Number of data bytes that follow a channel/system-common status byte. */
export function midiDataLength(status) {
  if (status >= 0xf8) return 0; // realtime
  if (status >= 0xf0) {
    if (status === 0xf1 || status === 0xf3) return 1;
    if (status === 0xf2) return 2;
    return 0; // F0 (sysex, variable), F4, F5, F6, F7
  }
  const kind = status & 0xf0;
  return kind === 0xc0 || kind === 0xd0 ? 1 : 2;
}

export const CC_SUSTAIN = 64;
export const CC_SOSTENUTO = 66;
export const CC_SOFT = 67;
