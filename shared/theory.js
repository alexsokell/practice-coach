// Music theory for Practice Coach: scale and chord spelling, standard piano fingerings,
// chord detection, key estimation and key-aware note naming.
// Pure and isomorphic: no DOM, no Node APIs, no top-level side effects.
//
// Fingering policy: a fingering is only returned when it is a standard, published fingering that
// was checked against several piano pedagogy sources (see FINGERING SOURCES below). Everything
// else returns null. A wrong finger number teaches a bad habit, a missing one does not.

import { pitchClass } from './midi.js';

/**
 * @typedef {Object} Root
 * @property {string} name    normalized spelling, e.g. 'F#' or 'Bb'
 * @property {string} letter  'A'..'G'
 * @property {number} alter   -1 (flat), 0 (natural) or 1 (sharp)
 * @property {number} pc      pitch class 0..11 (C = 0)
 */
/**
 * @typedef {Object} SpelledNote
 * @property {number} midi  MIDI note number
 * @property {string} name  spelled name with octave, e.g. 'Bb3', 'E#4', 'F##4'
 */
/**
 * @typedef {'major'|'natural_minor'|'harmonic_minor'|'melodic_minor'|'major_pentatonic'|'minor_pentatonic'|'blues'|'chromatic'} ScaleName
 */
/** @typedef {'up'|'down'|'up_down'} Direction */
/**
 * @typedef {Object} ChordSymbol
 * @property {string} root       spelled root, e.g. 'F#'
 * @property {string} quality    'major' | 'minor' | 'diminished' | 'augmented' | 'sus2' | 'sus4' | 'power' |
 *   'dominant7' | 'major7' | 'minor7' | 'half_diminished7' | 'diminished7' | 'major6' | 'minor6' |
 *   'minor_major7' | 'dominant7sus4' | 'add9' | 'minor_add9' | 'dominant9' | 'major9' | 'minor9'
 * @property {number[]} pcs      pitch classes of the chord tones, root first
 * @property {number[]} intervals semitones above the root for each chord tone (14 = a ninth)
 * @property {string|null} bass  slash bass note name ('E' for 'C/E'), null when there is none
 * @property {string} symbol     normalized symbol, e.g. 'Cmin7' -> 'Cm7'
 */
/**
 * @typedef {Object} DetectedChord
 * @property {string} name       e.g. 'C', 'Am7', 'C/E'
 * @property {string} root       e.g. 'C'
 * @property {string} quality    same vocabulary as ChordSymbol.quality
 * @property {string} bass       name of the lowest note, e.g. 'E'
 * @property {number} inversion  0 = root in the bass, 1 = second chord tone in the bass, and so on
 */
/**
 * @typedef {Object} KeyEstimate
 * @property {string} tonic  e.g. 'C', 'F#', 'Bb'
 * @property {'major'|'minor'} mode
 * @property {number} confidence 0..1
 */
/**
 * @typedef {Object} KeySignature
 * @property {number} sharps   number of sharps (0..7)
 * @property {number} flats    number of flats (0..7)
 * @property {Object<string, number>} accidentals  letter -> +1 (sharp) or -1 (flat), e.g. { B: -1 }
 */

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PCS = [0, 2, 4, 5, 7, 9, 11];
/** pitch class -> [letter index, alter] using sharps and using flats */
const SHARP_SPELL = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]];
const FLAT_SPELL = [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0], [3, 0], [4, -1], [4, 0], [5, -1], [5, 0], [6, -1], [6, 0]];
const BLACK_PC = [false, true, false, true, false, false, true, false, true, false, true, false];
const DIRECTIONS = ['up', 'down', 'up_down'];
const MAX_OCTAVES = 4;

function mod(n, m) {
  return ((n % m) + m) % m;
}

function accidentalText(alter) {
  return alter >= 0 ? '#'.repeat(alter) : 'b'.repeat(-alter);
}

/**
 * Spell a MIDI note with a given letter. The octave number follows the letter, so that
 * nameToMidi(name) === midi (MIDI 60 as a B sharp is 'B#3').
 * @returns {SpelledNote|null} null when the spelling would need more than a double accidental
 */
function spellWithLetter(midi, letterIndex) {
  const alter = mod(midi - LETTER_PCS[letterIndex] + 6, 12) - 6;
  if (alter < -2 || alter > 2) return null;
  const octave = Math.floor((midi - alter) / 12) - 1;
  return { midi, name: `${LETTERS[letterIndex]}${accidentalText(alter)}${octave}` };
}

function spellPlain(midi, flats) {
  return spellWithLetter(midi, (flats ? FLAT_SPELL : SHARP_SPELL)[pitchClass(midi)][0]);
}

function isOctaveCount(octaves) {
  return Number.isInteger(octaves) && octaves >= 1 && octaves <= MAX_OCTAVES;
}

function isStartOctave(octave) {
  return Number.isInteger(octave) && octave >= -1 && octave <= 9;
}

function normalizeHand(hand) {
  if (hand === 'right' || hand === 'R') return 'right';
  if (hand === 'left' || hand === 'L') return 'left';
  return null;
}

// ---------------------------------------------------------------- roots and scales

/** Semitone offsets of every supported scale, one octave, without the repeated tonic. */
export const SCALE_INTERVALS = Object.freeze({
  major: Object.freeze([0, 2, 4, 5, 7, 9, 11]),
  natural_minor: Object.freeze([0, 2, 3, 5, 7, 8, 10]),
  harmonic_minor: Object.freeze([0, 2, 3, 5, 7, 8, 11]),
  melodic_minor: Object.freeze([0, 2, 3, 5, 7, 9, 11]),
  major_pentatonic: Object.freeze([0, 2, 4, 7, 9]),
  minor_pentatonic: Object.freeze([0, 3, 5, 7, 10]),
  blues: Object.freeze([0, 3, 5, 6, 7, 10]),
  chromatic: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
});

/** Letter steps above the root letter for each scale degree (chromatic is spelled separately). */
const SCALE_LETTER_STEPS = {
  major: [0, 1, 2, 3, 4, 5, 6],
  natural_minor: [0, 1, 2, 3, 4, 5, 6],
  harmonic_minor: [0, 1, 2, 3, 4, 5, 6],
  melodic_minor: [0, 1, 2, 3, 4, 5, 6],
  major_pentatonic: [0, 1, 2, 4, 5],
  minor_pentatonic: [0, 2, 3, 4, 6],
  blues: [0, 2, 3, 4, 4, 6],
};

function hasOwn(object, key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Parse a root / tonic name. Accepts sharps and flats (also the unicode signs) and any letter case:
 * 'F#' | 'Gb' | 'c' | 'bb'. Double accidentals are not roots.
 * @param {string} text
 * @returns {Root|null}
 */
export function parseRoot(text) {
  if (typeof text !== 'string') return null;
  const m = /^\s*([A-Ga-g])([#b♯♭]?)\s*$/.exec(text);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const alter = m[2] === '' ? 0 : m[2] === '#' || m[2] === '♯' ? 1 : -1;
  const letterIndex = LETTERS.indexOf(letter);
  return {
    name: `${letter}${accidentalText(alter)}`,
    letter,
    alter,
    pc: mod(LETTER_PCS[letterIndex] + alter, 12),
  };
}

function rootLetterIndex(root) {
  return LETTERS.indexOf(root.letter);
}

function rootMidiAt(root, octave) {
  return (octave + 1) * 12 + LETTER_PCS[rootLetterIndex(root)] + root.alter;
}

/**
 * One ascending run of a scale including the final tonic.
 * `descending` selects the form used on the way down: natural minor for melodic minor, and flats
 * for the chromatic scale. The list itself is always returned in ascending order.
 * @returns {SpelledNote[]|null}
 */
function ascendingScaleRun(root, scale, rootMidi, octaves, descending) {
  const form = scale === 'melodic_minor' && descending ? 'natural_minor' : scale;
  const semis = SCALE_INTERVALS[form];
  const size = semis.length;
  const rootLetter = rootLetterIndex(root);
  const notes = [];
  for (let i = 0; i <= size * octaves; i++) {
    const degree = i % size;
    const midi = rootMidi + 12 * Math.floor(i / size) + semis[degree];
    let note;
    if (form === 'chromatic') {
      // The tonic keeps the spelling it was given, the other notes use sharps going up and
      // flats coming down.
      note = degree === 0 ? spellWithLetter(midi, rootLetter) : spellPlain(midi, descending);
    } else {
      const steps = SCALE_LETTER_STEPS[form];
      note = spellWithLetter(midi, (rootLetter + steps[degree]) % 7);
      if (form === 'blues' && degree === 3 && (!note || /bb/.test(note.name))) {
        // The blue note is a lowered fifth. Where that would need a double flat (E flat blues:
        // B double flat) it is written as the raised fourth instead (A natural).
        note = spellWithLetter(midi, (rootLetter + 3) % 7);
      }
    }
    if (!note) return null;
    notes.push(note);
  }
  return notes;
}

/**
 * Notes of a scale, correctly spelled from the root as given (F major has Bb, F# major has E#,
 * G# harmonic minor has F##). The root is never re-spelled: 'C#' and 'Db' give different names
 * for the same keys.
 *
 * startOctave is the octave of the lowest note (the starting tonic for 'up' and 'up_down', the
 * final tonic for 'down'). 'up_down' does not repeat the top note. Melodic minor goes up melodic
 * and comes down natural. The chromatic scale uses sharps going up and flats coming down.
 * No range check is applied: callers decide which MIDI range is playable.
 *
 * @param {{root: string, scale: ScaleName, startOctave?: number, octaves?: number, direction?: Direction}} options
 * @returns {SpelledNote[]} empty array when the root, scale, octave count (1..4), start octave
 *   (-1..9) or direction is not valid
 */
export function scaleNotes(options) {
  const { root, scale, startOctave = 4, octaves = 1, direction = 'up' } = options ?? {};
  const parsed = parseRoot(root);
  if (!parsed || !hasOwn(SCALE_INTERVALS, scale) || !isOctaveCount(octaves) || !isStartOctave(startOctave)
    || !DIRECTIONS.includes(direction)) {
    return [];
  }
  const rootMidi = rootMidiAt(parsed, startOctave);
  const up = direction === 'down' ? [] : ascendingScaleRun(parsed, scale, rootMidi, octaves, false);
  const down = direction === 'up' ? [] : ascendingScaleRun(parsed, scale, rootMidi, octaves, true);
  if (!up || !down) return [];
  down.reverse();
  if (direction === 'up') return up;
  if (direction === 'down') return down;
  return up.concat(down.slice(1));
}

// ---------------------------------------------------------------- fingerings
//
// FINGERING SOURCES (checked November 2026). A fingering is encoded only where at least two of
// these agree on the whole one-octave pattern:
//   [PS]  pianoscales.org: major.html, minor.html, minor-harmonic.html
//   [MTG] musicteacherguide.com: piano-major-scales, piano-harmonic-minor-scales,
//         piano-natural-minor-scales, piano-melodic-minor-scales, piano-major-arpeggios,
//         piano-minor-arpeggios
//   [CMA] cantonmusicacademy.com/piano-scale-fingering
//   [BAY] Baylor University "Piano Basics" open textbook (openbooks.library.baylor.edu/pianobasics)
//   [KEL] R. T. Kelley, keyboard scale and arpeggio fingering charts (robertkelleyphd.com)
//   [MAN] Mansfield (Commonwealth University) piano handout for new students
//   [EVA] University of Evansville, "Scale and Arpeggio Fingerings" (faculty.evansville.edu/gu2)
//   [CIM] colorinmypiano.com, "Scale & Arpeggio Fingerings for Piano (2 Octave)"
//
// Model: each entry is [one-octave ascending fingering including the top tonic, finger used on the
// tonic when the run continues through it]. Two or more octaves repeat the pattern, descending is
// the ascending fingering reversed, up_down omits the repeated top note. This is how every source
// above extends its charts ([CMA], [CIM], [MAN] print the two-octave forms; "reverse the fingerings
// for descending scales").
//
// Where charts differ only in the finger that starts a black-key scale, the more widely printed
// start is used: B flat scales start on 2 in the right hand ([PS], [MTG], [CMA]; [BAY]: "most
// prefer finger 2"; [KEL] prints the strict pattern finger 4), and C#, F#, G# minor start 3-4
// ([MTG], [CMA], [KEL]; [PS] prints 2-3 for some of them). The thumb positions are identical in
// all of these variants.

const WHITE_R = ['12312345', 1]; // C, G, D, A, E, B major and their parallel minors
const WHITE_L = ['54321321', 1];
const F_R = ['12341234', 1];
const B_L = ['43214321', 1];
const FLAT_L = ['32143213', 3]; // B flat, E flat, A flat, D flat major
const FSHARP_L = ['43213214', 4];
const SHARP_MINOR_R = ['34123123', 3]; // C#, F#, G# minor
const BFLAT_R = ['21231234', 4];
const EFLAT_R = ['31234123', 3];
const BFLAT_MINOR_L = ['21321432', 2];
const EFLAT_MINOR_L = ['21432132', 2];

/** Indexed by pitch class of the tonic: C, C#/Db, D, D#/Eb, E, F, F#/Gb, G, G#/Ab, A, A#/Bb, B. */
const MAJOR_FINGERING = {
  right: [WHITE_R, ['23123412', 2], WHITE_R, EFLAT_R, WHITE_R, F_R, ['23412312', 2], WHITE_R,
    ['34123123', 3], WHITE_R, BFLAT_R, WHITE_R],
  left: [WHITE_L, FLAT_L, WHITE_L, FLAT_L, WHITE_L, WHITE_L, FSHARP_L, WHITE_L,
    FLAT_L, WHITE_L, FLAT_L, B_L],
};
const HARMONIC_MINOR_FINGERING = {
  right: [WHITE_R, SHARP_MINOR_R, WHITE_R, EFLAT_R, WHITE_R, F_R, SHARP_MINOR_R, WHITE_R,
    SHARP_MINOR_R, WHITE_R, BFLAT_R, WHITE_R],
  left: [WHITE_L, FLAT_L, WHITE_L, EFLAT_MINOR_L, WHITE_L, WHITE_L, FSHARP_L, WHITE_L,
    FLAT_L, WHITE_L, BFLAT_MINOR_L, B_L],
};
// Natural minor: same as harmonic minor except the left hand of G sharp minor, where the thumb
// cannot take F sharp ([PS], [KEL]; [CMA] notes the same single exception).
const NATURAL_MINOR_FINGERING = {
  right: HARMONIC_MINOR_FINGERING.right,
  left: HARMONIC_MINOR_FINGERING.left.map((entry, pc) => (pc === 8 ? ['32132143', 3] : entry)),
};
// Melodic minor: only the white-key tonics, where every form of the minor scale keeps the
// fingering of the parallel major in both directions ([BAY], [MTG]). On black-key tonics the
// ascending and descending forms need different fingerings and the charts do not agree: null.
const MELODIC_MINOR_FINGERING = {
  right: HARMONIC_MINOR_FINGERING.right.map((entry, pc) => (BLACK_PC[pc] ? null : entry)),
  left: HARMONIC_MINOR_FINGERING.left.map((entry, pc) => (BLACK_PC[pc] ? null : entry)),
};
const SCALE_FINGERING = {
  major: MAJOR_FINGERING,
  natural_minor: NATURAL_MINOR_FINGERING,
  harmonic_minor: HARMONIC_MINOR_FINGERING,
  melodic_minor: MELODIC_MINOR_FINGERING,
};

// Root position triad arpeggios. [BAY]: white-key tonics and G flat major use right hand 1235;
// left hand 5421 when one white key lies between root and third (C, F, G major, every white-key
// minor), 5321 when two do (D, A, E, B major). [MAN], [CIM], [MTG] agree. Black-key tonics:
// left hand 2142 ([KEL], [EVA], [MAN]), right hand 4-1-2-4 pattern started on 2 ([KEL], [MTG];
// [BAY]: most pianists begin with 2; [EVA], [MAN] print the strict 4). B flat major left hand
// 3213 ([BAY], [MAN], [KEL], [MTG]). B flat minor 2312 / 3213 ([KEL], [MTG], [EVA] right hand).
// F sharp major 1235 / 5321 and E flat minor 1235 / 5421 ([MTG], [KEL]).
const ARP_WHITE_R = ['1235', 1];
const ARP_BLACK_R = ['2124', 4];
const ARP_4_L = ['5421', 1];
const ARP_3_L = ['5321', 1];
const ARP_BLACK_L = ['2142', 2];
const ARP_BFLAT_L = ['3213', 3];
const ARPEGGIO_FINGERING = {
  major: {
    right: [ARP_WHITE_R, ARP_BLACK_R, ARP_WHITE_R, ARP_BLACK_R, ARP_WHITE_R, ARP_WHITE_R, ARP_WHITE_R,
      ARP_WHITE_R, ARP_BLACK_R, ARP_WHITE_R, ARP_BLACK_R, ARP_WHITE_R],
    left: [ARP_4_L, ARP_BLACK_L, ARP_3_L, ARP_BLACK_L, ARP_3_L, ARP_4_L, ARP_3_L,
      ARP_4_L, ARP_BLACK_L, ARP_3_L, ARP_BFLAT_L, ARP_3_L],
  },
  minor: {
    right: [ARP_WHITE_R, ARP_BLACK_R, ARP_WHITE_R, ARP_WHITE_R, ARP_WHITE_R, ARP_WHITE_R, ARP_BLACK_R,
      ARP_WHITE_R, ARP_BLACK_R, ARP_WHITE_R, ['2312', 2], ARP_WHITE_R],
    left: [ARP_4_L, ARP_BLACK_L, ARP_4_L, ARP_4_L, ARP_4_L, ARP_4_L, ARP_BLACK_L,
      ARP_4_L, ARP_BLACK_L, ARP_4_L, ARP_BFLAT_L, ARP_4_L],
  },
};

/** Expand a one-octave pattern over several octaves, ascending. */
function expandPattern([pattern, join], octaves) {
  const fingers = Array.from(pattern, Number);
  const inner = fingers.slice(1, -1);
  const out = [fingers[0]];
  for (let o = 0; o < octaves; o++) {
    if (o > 0) out.push(join);
    out.push(...inner);
  }
  out.push(fingers[fingers.length - 1]);
  return out;
}

function applyDirection(ascending, direction) {
  if (direction === 'up') return ascending;
  const descending = ascending.slice().reverse();
  if (direction === 'down') return descending;
  return ascending.concat(descending.slice(1));
}

/**
 * Standard chromatic fingering: 3 on every black key, thumb on the white keys, and 2 on the
 * upper key of each white pair in the right hand (C, F) or the lower one in the left hand (E, B).
 * Right hand from C starts with the thumb (1 3 1 3 1 2 3 1 3 1 3 1 2); left hand from C is
 * 1 3 1 3 2 1 3 1 3 1 3 2 1. Start notes that the published charts do not settle return null:
 * right hand from F, left hand from E or B.
 */
function chromaticFingering(rootPc, hand, octaves) {
  if (hand === 'right' ? rootPc === 5 : rootPc === 4 || rootPc === 11) return null;
  const two = hand === 'right' ? [0, 5] : [4, 11];
  const out = [];
  for (let i = 0; i <= 12 * octaves; i++) {
    const pc = (rootPc + i) % 12;
    out.push(BLACK_PC[pc] ? 3 : two.includes(pc) ? 2 : 1);
  }
  if (hand === 'right' && rootPc === 0) out[0] = 1;
  return out;
}

/**
 * Standard fingering for a scale, aligned index for index with scaleNotes() called with the same
 * root, scale, octaves and direction.
 *
 * Encoded: major, natural minor and harmonic minor in all 12 keys; melodic minor on white-key
 * tonics; chromatic (except right hand from F, left hand from E or B). Everything else
 * (pentatonic, blues, melodic minor on black-key tonics) returns null.
 *
 * @param {{root: string, scale: ScaleName, hand: 'right'|'left', octaves?: number, direction?: Direction}} options
 * @returns {number[]|null} fingers 1..5 (1 = thumb), or null when there is no verified standard fingering
 */
export function scaleFingering(options) {
  const { root, scale, hand, octaves = 1, direction = 'up' } = options ?? {};
  const parsed = parseRoot(root);
  const side = normalizeHand(hand);
  if (!parsed || !side || !hasOwn(SCALE_INTERVALS, scale) || !isOctaveCount(octaves)
    || !DIRECTIONS.includes(direction)) {
    return null;
  }
  let ascending = null;
  if (scale === 'chromatic') {
    ascending = chromaticFingering(parsed.pc, side, octaves);
  } else if (hasOwn(SCALE_FINGERING, scale)) {
    const entry = SCALE_FINGERING[scale][side][parsed.pc];
    ascending = entry ? expandPattern(entry, octaves) : null;
  }
  return ascending ? applyDirection(ascending, direction) : null;
}

// ---------------------------------------------------------------- chords

/**
 * Chord vocabulary. tones: [semitones above the root, letter steps above the root letter].
 * The order of this table is the preference order of detectChord (simpler chords first).
 */
const CHORDS = {
  major: { suffix: '', tones: [[0, 0], [4, 2], [7, 4]] },
  minor: { suffix: 'm', tones: [[0, 0], [3, 2], [7, 4]] },
  power: { suffix: '5', tones: [[0, 0], [7, 4]] },
  diminished: { suffix: 'dim', tones: [[0, 0], [3, 2], [6, 4]] },
  augmented: { suffix: 'aug', tones: [[0, 0], [4, 2], [8, 4]] },
  sus4: { suffix: 'sus4', tones: [[0, 0], [5, 3], [7, 4]] },
  sus2: { suffix: 'sus2', tones: [[0, 0], [2, 1], [7, 4]] },
  dominant7: { suffix: '7', tones: [[0, 0], [4, 2], [7, 4], [10, 6]] },
  major7: { suffix: 'maj7', tones: [[0, 0], [4, 2], [7, 4], [11, 6]] },
  minor7: { suffix: 'm7', tones: [[0, 0], [3, 2], [7, 4], [10, 6]] },
  half_diminished7: { suffix: 'm7b5', tones: [[0, 0], [3, 2], [6, 4], [10, 6]] },
  diminished7: { suffix: 'dim7', tones: [[0, 0], [3, 2], [6, 4], [9, 6]] },
  major6: { suffix: '6', tones: [[0, 0], [4, 2], [7, 4], [9, 5]] },
  minor6: { suffix: 'm6', tones: [[0, 0], [3, 2], [7, 4], [9, 5]] },
  minor_major7: { suffix: 'mMaj7', tones: [[0, 0], [3, 2], [7, 4], [11, 6]] },
  dominant7sus4: { suffix: '7sus4', tones: [[0, 0], [5, 3], [7, 4], [10, 6]] },
  add9: { suffix: 'add9', tones: [[0, 0], [4, 2], [7, 4], [14, 8]] },
  minor_add9: { suffix: 'madd9', tones: [[0, 0], [3, 2], [7, 4], [14, 8]] },
  dominant9: { suffix: '9', tones: [[0, 0], [4, 2], [7, 4], [10, 6], [14, 8]] },
  major9: { suffix: 'maj9', tones: [[0, 0], [4, 2], [7, 4], [11, 6], [14, 8]] },
  minor9: { suffix: 'm9', tones: [[0, 0], [3, 2], [7, 4], [10, 6], [14, 8]] },
};
const CHORD_ORDER = Object.keys(CHORDS);

/** Normalized suffix -> quality. Suffixes are normalized by normalizeChordSuffix first. */
const SUFFIX_QUALITY = {
  '': 'major',
  maj: 'major',
  m: 'minor',
  5: 'power',
  dim: 'diminished',
  aug: 'augmented',
  sus4: 'sus4',
  sus: 'sus4',
  sus2: 'sus2',
  7: 'dominant7',
  dom7: 'dominant7',
  maj7: 'major7',
  m7: 'minor7',
  m7b5: 'half_diminished7',
  dim7: 'diminished7',
  6: 'major6',
  maj6: 'major6',
  m6: 'minor6',
  mmaj7: 'minor_major7',
  '7sus4': 'dominant7sus4',
  '7sus': 'dominant7sus4',
  add9: 'add9',
  add2: 'add9',
  madd9: 'minor_add9',
  madd2: 'minor_add9',
  9: 'dominant9',
  dom9: 'dominant9',
  maj9: 'major9',
  m9: 'minor9',
};

/**
 * Bring the many ways of writing a chord quality to one form: 'min7' -> 'm7', 'M7' -> 'maj7',
 * '+' -> 'aug', 'm7(b5)' -> 'm7b5'. Upper case M means major, lower case m means minor.
 */
function normalizeChordSuffix(text) {
  let s = text.replace(/[\s(),]/g, '');
  s = s.replace(/♭/g, 'b').replace(/♯/g, '#').replace(/\u2212/g, '-');
  s = s.replace(/[°º]/g, 'dim').replace(/ø/g, 'm7b5').replace(/Δ/g, 'maj7');
  s = s.replace(/^m7b57$/, 'm7b5').replace(/^maj77$/, 'maj7');
  // Whole words first, in any letter case. After this the only capital M left means major.
  s = s.replace(/diminished|dim/gi, 'dim').replace(/augmented|aug/gi, 'aug').replace(/suspended|sus/gi, 'sus')
    .replace(/dominant|dom/gi, 'dom').replace(/add/gi, 'add');
  s = s.replace(/major|maj/gi, 'maj').replace(/minor|min/gi, 'm');
  s = s.replace(/M/g, 'maj');
  if (s === '+') s = 'aug';
  if (s.startsWith('-')) s = `m${s.slice(1)}`;
  if (s === 'o') s = 'dim';
  if (s === 'o7') s = 'dim7';
  return s;
}

/** Spell every tone of a chord from its root. Returns null when a tone cannot be spelled. */
function chordToneLetters(root, quality) {
  const rootLetter = rootLetterIndex(root);
  const out = [];
  for (const [semis, steps] of CHORDS[quality].tones) {
    const letterIndex = (rootLetter + steps) % 7;
    const alter = mod(root.pc + semis - LETTER_PCS[letterIndex] + 6, 12) - 6;
    if (alter < -2 || alter > 2) return null;
    out.push({ semis, letterIndex, alter, name: `${LETTERS[letterIndex]}${accidentalText(alter)}` });
  }
  return out;
}

/**
 * Parse a chord symbol: 'C', 'Cm', 'Cmin', 'F#m7', 'Bbmaj7', 'CM7', 'G7', 'Ddim', 'Caug', 'C+',
 * 'Csus2', 'Csus4', 'C6', 'Cm6', 'Cm7b5', 'Cdim7', 'Cadd9', 'C5', 'C9', 'Cmaj9', 'Cm9', 'C7sus4',
 * 'CmMaj7' and slash chords such as 'C/E' or 'F/G'. The root letter must be upper case.
 * @param {string} symbol
 * @returns {ChordSymbol|null} null for anything that is not a supported chord symbol
 */
export function parseChordSymbol(symbol) {
  if (typeof symbol !== 'string' || symbol.length > 24) return null;
  const m = /^\s*([A-G][#b♯♭]?)([^/]*)(?:\/(.*))?$/.exec(symbol);
  if (!m) return null;
  const root = parseRoot(m[1]);
  const suffix = normalizeChordSuffix(m[2]);
  if (!root || !hasOwn(SUFFIX_QUALITY, suffix)) return null;
  const quality = SUFFIX_QUALITY[suffix];
  let bass = null;
  if (m[3] !== undefined) {
    const bassText = m[3].trim();
    if (!/^[A-G][#b♯♭]?$/.test(bassText)) return null;
    const parsedBass = parseRoot(bassText);
    if (parsedBass.pc !== root.pc) bass = parsedBass.name;
  }
  const tones = CHORDS[quality].tones;
  return {
    root: root.name,
    quality,
    pcs: tones.map(([semis]) => (root.pc + semis) % 12),
    intervals: tones.map(([semis]) => semis),
    bass,
    symbol: `${root.name}${CHORDS[quality].suffix}${bass ? `/${bass}` : ''}`,
  };
}

/** Raise the lowest note by an octave and keep the list ascending (one step of inversion). */
function rotateUp(notes) {
  const [lowest, ...rest] = notes;
  return rest.concat({ midi: lowest.midi + 12, letterIndex: lowest.letterIndex }).sort((a, b) => a.midi - b.midi);
}

/**
 * Notes of a chord, ascending and correctly spelled from its root.
 * octave is the octave of the root in root position (C4 = middle C). inversion k raises the lowest
 * note by an octave k times (0 = root position, 1 = first inversion, ...); chords with a ninth are
 * folded into close position by this. A slash bass that is a chord tone selects the inversion
 * with that note at the bottom ('C/E' is E G C) and overrides `inversion`; any other slash bass
 * is added below the chord ('F/G' is G F A C).
 * @param {string} symbol
 * @param {{octave?: number, inversion?: number}} [options]
 * @returns {SpelledNote[]|null} null for an unknown symbol, an octave outside -1..9 or an
 *   inversion outside 0..(notes - 1)
 */
export function chordNotes(symbol, options) {
  const { octave = 4, inversion = 0 } = options ?? {};
  const chord = parseChordSymbol(symbol);
  if (!chord || !isStartOctave(octave)) return null;
  const root = parseRoot(chord.root);
  const letters = chordToneLetters(root, chord.quality);
  if (!letters) return null;
  if (!Number.isInteger(inversion) || inversion < 0 || inversion >= letters.length) return null;
  const rootMidi = rootMidiAt(root, octave);
  let notes = letters.map((tone) => ({ midi: rootMidi + tone.semis, letterIndex: tone.letterIndex }));
  let extraBass = null;
  if (chord.bass) {
    const bass = parseRoot(chord.bass);
    if (chord.pcs.includes(bass.pc)) {
      for (let i = 0; i < 2 * notes.length && pitchClass(notes[0].midi) !== bass.pc; i++) notes = rotateUp(notes);
      const drop = 12 * Math.floor((notes[0].midi - rootMidi) / 12);
      notes = notes.map((note) => ({ ...note, midi: note.midi - drop }));
    } else {
      extraBass = bass;
    }
  }
  if (!chord.bass || extraBass) {
    for (let i = 0; i < inversion; i++) notes = rotateUp(notes);
  }
  if (extraBass) {
    let midi = notes[0].midi - 1;
    while (pitchClass(midi) !== extraBass.pc) midi -= 1;
    notes = [{ midi, letterIndex: rootLetterIndex(extraBass) }].concat(notes);
  }
  const spelled = notes.map((note) => spellWithLetter(note.midi, note.letterIndex));
  return spelled.every(Boolean) ? spelled : null;
}

/**
 * Which standard block shape a list of ascending MIDI notes forms. Triads: 0 = stacked thirds
 * (root position), 1 = third plus fourth (first inversion), 2 = fourth plus third (second
 * inversion). Four notes: 0 = stacked thirds. Anything else: -1. A tritone counts as a fourth so
 * that diminished triads keep the triad fingerings.
 */
function blockShape(notes) {
  if (!Array.isArray(notes) || !notes.every(Number.isInteger)) return -1;
  const gaps = [];
  for (let i = 1; i < notes.length; i++) gaps.push(notes[i] - notes[i - 1]);
  const third = (gap) => gap === 3 || gap === 4;
  const fourth = (gap) => gap === 5 || gap === 6;
  if (notes.length === 4) return gaps.every(third) ? 0 : -1;
  if (notes.length !== 3) return -1;
  if (third(gaps[0]) && third(gaps[1])) return 0;
  if (third(gaps[0]) && fourth(gaps[1])) return 1;
  if (fourth(gaps[0]) && third(gaps[1])) return 2;
  return -1;
}

/**
 * Standard block-chord fingering by pitch order (lowest note first).
 * Triads: right hand 1-3-5 (root position), 1-2-5 (first inversion), 1-3-5 (second inversion);
 * left hand 5-3-1, 5-3-1, 5-2-1. Four-note chords in root position: right 1-2-3-5, left 5-3-2-1.
 * Inversions of four-note chords are not agreed between sources and return null, as do all other
 * note counts.
 *
 * Optional `notes` (ascending MIDI numbers of the chord) makes the answer stricter: the shape is
 * then read from the notes themselves (stacked thirds, third plus fourth, fourth plus third) and
 * `inversion` is ignored. Shapes the standard fingerings do not cover (sus chords, sixth chords,
 * add9, inverted seventh chords, wide voicings) give null.
 *
 * @param {{noteCount?: number, hand: 'right'|'left', inversion?: number, notes?: number[]}} options
 * @returns {number[]|null}
 */
export function chordFingering(options) {
  const { noteCount, hand, inversion = 0, notes } = options ?? {};
  const side = normalizeHand(hand);
  if (!side) return null;
  let count = noteCount;
  let shape = inversion;
  if (notes !== undefined && notes !== null) {
    shape = blockShape(notes);
    if (shape < 0 || (noteCount !== undefined && noteCount !== notes.length)) return null;
    count = notes.length;
  }
  if (count === 3 && (shape === 0 || shape === 1 || shape === 2)) {
    return (side === 'right' ? [[1, 3, 5], [1, 2, 5], [1, 3, 5]] : [[5, 3, 1], [5, 3, 1], [5, 2, 1]])[shape].slice();
  }
  if (count === 4 && shape === 0) return side === 'right' ? [1, 2, 3, 5] : [5, 3, 2, 1];
  return null;
}

// ---------------------------------------------------------------- arpeggios

function isArpeggioQuality(quality) {
  return hasOwn(CHORDS, quality) && CHORDS[quality].tones.every(([semis]) => semis < 12);
}

/**
 * Notes of a root position arpeggio: the chord tones in each octave plus the tonic on top
 * (C E G C for one octave of C major). Direction and octaves work as in scaleNotes.
 * quality: 'major' | 'minor' | 'diminished' | 'augmented' | 'dominant7' | 'major7' | 'minor7'
 * (the other chord qualities whose tones fit inside one octave are accepted as well).
 * @param {{root: string, quality: string, startOctave?: number, octaves?: number, direction?: Direction}} options
 * @returns {SpelledNote[]} empty array for invalid arguments
 */
export function arpeggioNotes(options) {
  const { root, quality, startOctave = 4, octaves = 1, direction = 'up' } = options ?? {};
  const parsed = parseRoot(root);
  if (!parsed || !isArpeggioQuality(quality) || !isOctaveCount(octaves) || !isStartOctave(startOctave)
    || !DIRECTIONS.includes(direction)) {
    return [];
  }
  const letters = chordToneLetters(parsed, quality);
  if (!letters) return [];
  const rootMidi = rootMidiAt(parsed, startOctave);
  const up = [];
  for (let i = 0; i <= letters.length * octaves; i++) {
    const tone = letters[i % letters.length];
    up.push(spellWithLetter(rootMidi + 12 * Math.floor(i / letters.length) + tone.semis, tone.letterIndex));
  }
  return applyDirection(up, direction);
}

/**
 * Standard fingering for a root position arpeggio, aligned index for index with arpeggioNotes().
 * Encoded: major and minor triads in all 12 keys, both hands. Every other quality (diminished,
 * augmented, seventh chords) returns null.
 * @param {{root: string, quality: string, hand: 'right'|'left', octaves?: number, direction?: Direction}} options
 * @returns {number[]|null}
 */
export function arpeggioFingering(options) {
  const { root, quality, hand, octaves = 1, direction = 'up' } = options ?? {};
  const parsed = parseRoot(root);
  const side = normalizeHand(hand);
  if (!parsed || !side || !hasOwn(ARPEGGIO_FINGERING, quality) || !isOctaveCount(octaves)
    || !DIRECTIONS.includes(direction)) {
    return null;
  }
  return applyDirection(expandPattern(ARPEGGIO_FINGERING[quality][side][parsed.pc], octaves), direction);
}

// ---------------------------------------------------------------- chord detection

/** 12-bit set of pitch classes. */
function pcMask(pcs) {
  let mask = 0;
  for (const pc of pcs) mask |= 1 << mod(pc, 12);
  return mask;
}

function transposeMask(mask, semitones) {
  return ((mask << semitones) | (mask >> (12 - semitones))) & 0xfff;
}

/** Seventh chords are still named when the fifth is left out (C E Bb is C7). */
const NO_FIFTH = ['dominant7', 'major7', 'minor7'];
/** Pitch class sets of every chord on C, in preference order. */
const CHORD_TEMPLATES = CHORD_ORDER.map((quality, rank) => {
  const semis = CHORDS[quality].tones.map(([s]) => s);
  return {
    quality,
    rank,
    mask: pcMask(semis),
    noFifthMask: NO_FIFTH.includes(quality) ? pcMask(semis.filter((s) => s !== 7)) : 0,
  };
});
/** Spelling used for a black-key root when sharp and flat spellings are equally simple. */
const DEFAULT_BLACK_ROOT = { 1: 'Db', 3: 'Eb', 6: 'F#', 8: 'Ab', 10: 'Bb' };

/** Pick the root spelling that gives the chord the fewest accidentals. */
function chordRootFor(rootPc, quality) {
  const sharp = SHARP_SPELL[rootPc];
  if (sharp[1] === 0) return parseRoot(LETTERS[sharp[0]]);
  const flat = FLAT_SPELL[rootPc];
  const options = [parseRoot(`${LETTERS[sharp[0]]}#`), parseRoot(`${LETTERS[flat[0]]}b`)];
  const cost = options.map((root) => {
    const letters = chordToneLetters(root, quality);
    return letters ? letters.reduce((sum, tone) => sum + Math.abs(tone.alter), 0) : Infinity;
  });
  if (cost[0] !== cost[1]) return cost[0] < cost[1] ? options[0] : options[1];
  return options.find((root) => root.name === DEFAULT_BLACK_ROOT[rootPc]);
}

/**
 * Name the chord formed by a set of sounding notes (any order, any octave doubling). The lowest
 * note is the bass. Simpler chords win over exotic readings, a reading with the root in the bass
 * wins over an inversion, and inversions are named as slash chords ('C/E'). Two different pitch
 * classes are named only when they form a fifth (power chord, 'C5'). Clusters and anything that
 * does not match the chord vocabulary return null.
 * @param {Iterable<number>} midiNotes
 * @returns {DetectedChord|null}
 */
export function detectChord(midiNotes) {
  if (midiNotes === null || midiNotes === undefined || typeof midiNotes[Symbol.iterator] !== 'function'
    || typeof midiNotes === 'string') {
    return null;
  }
  const notes = [...midiNotes].filter((n) => Number.isInteger(n) && n >= 0 && n <= 127);
  if (notes.length < 2) return null;
  const bassPc = pitchClass(Math.min(...notes));
  const mask = pcMask(notes);
  let best = null;
  const consider = (rootPc, quality, rank) => {
    const tones = CHORDS[quality].tones;
    const inversion = tones.findIndex(([semis]) => (rootPc + semis) % 12 === bassPc);
    if (inversion < 0) return;
    const score = (inversion === 0 ? 0 : 1000) + rank * 10 + inversion;
    if (!best || score < best.score) best = { rootPc, quality, inversion, score };
  };
  for (let rootPc = 0; rootPc < 12; rootPc++) {
    for (const template of CHORD_TEMPLATES) {
      if (transposeMask(template.mask, rootPc) === mask) consider(rootPc, template.quality, template.rank);
    }
  }
  if (!best) {
    for (let rootPc = 0; rootPc < 12; rootPc++) {
      for (const template of CHORD_TEMPLATES) {
        if (template.noFifthMask && transposeMask(template.noFifthMask, rootPc) === mask) {
          consider(rootPc, template.quality, template.rank);
        }
      }
    }
  }
  if (!best) return null;
  const root = chordRootFor(best.rootPc, best.quality);
  const letters = chordToneLetters(root, best.quality);
  if (!letters) return null;
  const bass = letters[best.inversion].name;
  const symbol = `${root.name}${CHORDS[best.quality].suffix}`;
  return {
    name: best.inversion === 0 ? symbol : `${symbol}/${bass}`,
    root: root.name,
    quality: best.quality,
    bass,
    inversion: best.inversion,
  };
}

// ---------------------------------------------------------------- keys

// Krumhansl-Kessler probe tone profiles (Krumhansl and Kessler 1982), tonic first.
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
/** Conventional tonic spelling for each pitch class: the key with at most six sharps or flats. */
const MAJOR_TONICS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_TONICS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
/** Gap between the best and the second best correlation that counts as full confidence. */
const KEY_GAP_FOR_FULL_CONFIDENCE = 0.2;

function pearson(a, b) {
  const n = a.length;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i] / n;
    meanB += b[i] / n;
  }
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - meanA) * (b[i] - meanB);
    varA += (a[i] - meanA) ** 2;
    varB += (b[i] - meanB) ** 2;
  }
  return varA > 0 && varB > 0 ? cov / Math.sqrt(varA * varB) : 0;
}

/**
 * Estimate the key from how much each pitch class was played (Krumhansl-Schmuckler: correlate the
 * weights with the 24 rotated Krumhansl-Kessler profiles). Weights are typically summed note
 * durations or note counts per pitch class, index 0 = C.
 * confidence is the gap between the best and the second best correlation, scaled so that a gap of
 * 0.2 or more is 1, and 0 when even the best key does not correlate positively.
 * @param {ArrayLike<number>} pcWeights  12 non-negative numbers
 * @returns {KeyEstimate|null} null when the input is not 12 numbers or carries no information
 *   (all zero, or all equal)
 */
export function estimateKey(pcWeights) {
  if (pcWeights === null || pcWeights === undefined || typeof pcWeights !== 'object' || pcWeights.length !== 12) {
    return null;
  }
  const weights = Array.from({ length: 12 }, (_, i) => {
    const value = pcWeights[i];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  });
  if (weights.every((value) => value === weights[0])) return null;
  const results = [];
  for (const [mode, profile, tonics] of [['major', KK_MAJOR, MAJOR_TONICS], ['minor', KK_MINOR, MINOR_TONICS]]) {
    for (let tonicPc = 0; tonicPc < 12; tonicPc++) {
      const rotated = weights.map((_, i) => weights[(i + tonicPc) % 12]);
      results.push({ tonic: tonics[tonicPc], mode, r: pearson(rotated, profile) });
    }
  }
  results.sort((a, b) => b.r - a.r);
  const [best, second] = results;
  const gap = Math.max(0, best.r - second.r);
  const confidence = best.r > 0 ? Math.min(1, gap / KEY_GAP_FOR_FULL_CONFIDENCE) : 0;
  return { tonic: best.tonic, mode: best.mode, confidence };
}

const FIFTHS_OF_LETTER = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const MINOR_MODES = ['minor', 'natural_minor', 'harmonic_minor', 'melodic_minor', 'minor_pentatonic', 'blues'];
const MAJOR_MODES = ['major', 'major_pentatonic'];

/**
 * @returns {{root: Root, minor: boolean, fifths: number}|null} fifths: sharps (positive) or flats
 *   (negative) of the key, which can exceed 7 for theoretical keys such as G sharp major
 */
function keyInfo(tonic, mode) {
  const root = parseRoot(tonic);
  const minor = MINOR_MODES.includes(mode);
  if (!root || (!minor && !MAJOR_MODES.includes(mode))) return null;
  return { root, minor, fifths: FIFTHS_OF_LETTER[root.letter] + 7 * root.alter - (minor ? 3 : 0) };
}

/**
 * Key signature of a major or minor key. All 15 major keys (C, G, D, A, E, B, F#, C#, F, Bb, Eb,
 * Ab, Db, Gb, Cb) and 15 minor keys (A, E, B, F#, C#, G#, D#, A#, D, G, C, F, Bb, Eb, Ab).
 * mode also accepts the scale names ('harmonic_minor', 'major_pentatonic', ...).
 * A key that has no conventional signature (G sharp major would need 8 sharps) and invalid input
 * give the empty signature, so that every accidental is written out next to its note.
 * @param {string} tonic
 * @param {string} mode  'major' | 'minor'
 * @returns {KeySignature}
 */
export function keySignature(tonic, mode) {
  const info = keyInfo(tonic, mode);
  const fifths = info && Math.abs(info.fifths) <= 7 ? info.fifths : 0;
  const accidentals = {};
  const order = fifths > 0 ? SHARP_ORDER : FLAT_ORDER;
  for (let i = 0; i < Math.abs(fifths); i++) accidentals[order[i]] = fifths > 0 ? 1 : -1;
  return { sharps: Math.max(0, fifths), flats: Math.max(0, -fifths), accidentals };
}

/**
 * Name a MIDI note the way it is written in a key: in F major MIDI 70 is 'Bb4', in D major
 * MIDI 66 is 'F#4'. Notes of the key's scale use the scale spelling; in minor keys the raised
 * sixth and seventh do too (C# in D minor, F## in G# minor). Any other note uses sharps in sharp
 * keys and flats in flat keys. Without a key (null, or one that cannot be parsed) and in C major
 * and A minor the fallback is sharps.
 * @param {number} midi
 * @param {{tonic: string, mode: string}|null} [key]
 * @returns {string} '' when midi is not an integer
 */
export function spellMidi(midi, key) {
  if (!Number.isInteger(midi)) return '';
  const info = key && typeof key === 'object' ? keyInfo(key.tonic, key.mode) : null;
  if (!info) return spellPlain(midi, false).name;
  const pc = pitchClass(midi);
  const rootLetter = rootLetterIndex(info.root);
  const semis = SCALE_INTERVALS[info.minor ? 'natural_minor' : 'major'];
  const degrees = semis.map((s, degree) => [s, degree]);
  if (info.minor) degrees.push([11, 6], [9, 5]);
  for (const [s, degree] of degrees) {
    if ((info.root.pc + s) % 12 === pc) {
      const spelled = spellWithLetter(midi, (rootLetter + degree) % 7);
      if (spelled) return spelled.name;
    }
  }
  return spellPlain(midi, info.fifths < 0).name;
}

// ---------------------------------------------------------------- intervals

const SIMPLE_INTERVALS = ['unison', 'minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd', 'perfect 4th', 'tritone',
  'perfect 5th', 'minor 6th', 'major 6th', 'minor 7th', 'major 7th', 'octave'];
const COMPOUND_INTERVALS = { 13: 'minor 9th', 14: 'major 9th', 15: 'minor 10th', 16: 'major 10th',
  17: 'perfect 11th', 19: 'perfect 12th', 20: 'minor 13th', 21: 'major 13th' };

/**
 * Plain name of an interval: 4 -> 'major 3rd', 7 -> 'perfect 5th', 12 -> 'octave', 14 -> 'major 9th'.
 * The sign is ignored (direction does not change the name). Larger intervals are described as
 * octaves plus a simple interval: 26 -> '2 octaves + major 2nd'.
 * @param {number} semitones
 * @returns {string} '' when semitones is not a finite number
 */
export function intervalName(semitones) {
  if (typeof semitones !== 'number' || !Number.isFinite(semitones)) return '';
  const size = Math.abs(Math.round(semitones));
  if (size <= 12) return SIMPLE_INTERVALS[size];
  if (hasOwn(COMPOUND_INTERVALS, String(size))) return COMPOUND_INTERVALS[size];
  const octaves = Math.floor(size / 12);
  const rest = size % 12;
  const octaveText = octaves === 1 ? 'octave' : `${octaves} octaves`;
  return rest === 0 ? octaveText : `${octaveText} + ${SIMPLE_INTERVALS[rest]}`;
}
