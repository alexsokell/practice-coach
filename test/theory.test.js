import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { nameToMidi, isBlackKey, pitchClass } from '../shared/midi.js';
import {
  SCALE_INTERVALS,
  parseRoot,
  scaleNotes,
  scaleFingering,
  arpeggioNotes,
  arpeggioFingering,
  parseChordSymbol,
  chordNotes,
  chordFingering,
  detectChord,
  estimateKey,
  spellMidi,
  intervalName,
  keySignature,
} from '../shared/theory.js';

const names = (notes) => notes.map((n) => n.name);
const midis = (notes) => notes.map((n) => n.midi);
/** 'Bb4' -> 'Bb' */
const bare = (name) => name.replace(/-?\d+$/, '');
const bareNames = (notes) => notes.map((n) => bare(n.name)).join(' ');
const digits = (fingers) => (fingers === null ? null : fingers.join(''));

const TWELVE_ROOTS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const ALL_ROOTS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'Fb', 'E#', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#',
  'Bb', 'B', 'Cb', 'B#'];
const SCALES = Object.keys(SCALE_INTERVALS);
const DIRECTIONS = ['up', 'down', 'up_down'];
const HANDS = ['right', 'left'];

// ---------------------------------------------------------------- parseRoot

describe('parseRoot', () => {
  test('parses naturals, sharps and flats in any letter case', () => {
    assert.deepEqual(parseRoot('F#'), { name: 'F#', letter: 'F', alter: 1, pc: 6 });
    assert.deepEqual(parseRoot('Gb'), { name: 'Gb', letter: 'G', alter: -1, pc: 6 });
    assert.deepEqual(parseRoot('c'), { name: 'C', letter: 'C', alter: 0, pc: 0 });
    assert.deepEqual(parseRoot('bb'), { name: 'Bb', letter: 'B', alter: -1, pc: 10 });
    assert.deepEqual(parseRoot('b'), { name: 'B', letter: 'B', alter: 0, pc: 11 });
    assert.deepEqual(parseRoot(' Eb '), { name: 'Eb', letter: 'E', alter: -1, pc: 3 });
    assert.deepEqual(parseRoot('B#'), { name: 'B#', letter: 'B', alter: 1, pc: 0 });
    assert.deepEqual(parseRoot('Cb'), { name: 'Cb', letter: 'C', alter: -1, pc: 11 });
    assert.deepEqual(parseRoot('E♭'), { name: 'Eb', letter: 'E', alter: -1, pc: 3 });
    assert.deepEqual(parseRoot('F♯'), { name: 'F#', letter: 'F', alter: 1, pc: 6 });
  });

  test('rejects everything else', () => {
    for (const bad of ['', 'H', 'C##', 'Bbb', 'C4', 'Cm', 'do', '#', 'C #', null, undefined, 3, {}, [], ['C']]) {
      assert.equal(parseRoot(bad), null, `parseRoot(${JSON.stringify(bad)})`);
    }
  });
});

// ---------------------------------------------------------------- scales: spelling

describe('SCALE_INTERVALS', () => {
  test('has the eight scales of the contract', () => {
    assert.deepEqual(SCALES.sort(), ['blues', 'chromatic', 'harmonic_minor', 'major', 'major_pentatonic',
      'melodic_minor', 'minor_pentatonic', 'natural_minor']);
    assert.deepEqual([...SCALE_INTERVALS.major], [0, 2, 4, 5, 7, 9, 11]);
    assert.deepEqual([...SCALE_INTERVALS.natural_minor], [0, 2, 3, 5, 7, 8, 10]);
    assert.deepEqual([...SCALE_INTERVALS.harmonic_minor], [0, 2, 3, 5, 7, 8, 11]);
    assert.deepEqual([...SCALE_INTERVALS.melodic_minor], [0, 2, 3, 5, 7, 9, 11]);
    assert.deepEqual([...SCALE_INTERVALS.major_pentatonic], [0, 2, 4, 7, 9]);
    assert.deepEqual([...SCALE_INTERVALS.minor_pentatonic], [0, 3, 5, 7, 10]);
    assert.deepEqual([...SCALE_INTERVALS.blues], [0, 3, 5, 6, 7, 10]);
    assert.deepEqual([...SCALE_INTERVALS.chromatic], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  test('cannot be modified by a caller', () => {
    assert.ok(Object.isFrozen(SCALE_INTERVALS));
    assert.ok(Object.isFrozen(SCALE_INTERVALS.major));
  });
});

describe('scaleNotes spelling', () => {
  const MAJOR = {
    C: 'C D E F G A B C',
    G: 'G A B C D E F# G',
    D: 'D E F# G A B C# D',
    A: 'A B C# D E F# G# A',
    E: 'E F# G# A B C# D# E',
    B: 'B C# D# E F# G# A# B',
    'F#': 'F# G# A# B C# D# E# F#',
    'C#': 'C# D# E# F# G# A# B# C#',
    F: 'F G A Bb C D E F',
    Bb: 'Bb C D Eb F G A Bb',
    Eb: 'Eb F G Ab Bb C D Eb',
    Ab: 'Ab Bb C Db Eb F G Ab',
    Db: 'Db Eb F Gb Ab Bb C Db',
    Gb: 'Gb Ab Bb Cb Db Eb F Gb',
    Cb: 'Cb Db Eb Fb Gb Ab Bb Cb',
  };
  const HARMONIC_MINOR = {
    A: 'A B C D E F G# A',
    E: 'E F# G A B C D# E',
    B: 'B C# D E F# G A# B',
    'F#': 'F# G# A B C# D E# F#',
    'C#': 'C# D# E F# G# A B# C#',
    'G#': 'G# A# B C# D# E F## G#',
    'D#': 'D# E# F# G# A# B C## D#',
    'A#': 'A# B# C# D# E# F# G## A#',
    D: 'D E F G A Bb C# D',
    G: 'G A Bb C D Eb F# G',
    C: 'C D Eb F G Ab B C',
    F: 'F G Ab Bb C Db E F',
    Bb: 'Bb C Db Eb F Gb A Bb',
    Eb: 'Eb F Gb Ab Bb Cb D Eb',
    Ab: 'Ab Bb Cb Db Eb Fb G Ab',
  };

  test('all 15 major scales are spelled as written in their key', () => {
    for (const [root, expected] of Object.entries(MAJOR)) {
      assert.equal(bareNames(scaleNotes({ root, scale: 'major' })), expected, `${root} major`);
    }
  });

  test('all 15 harmonic minor scales raise the seventh with the right letter', () => {
    for (const [root, expected] of Object.entries(HARMONIC_MINOR)) {
      assert.equal(bareNames(scaleNotes({ root, scale: 'harmonic_minor' })), expected, `${root} harmonic minor`);
    }
  });

  test('the examples named in the brief', () => {
    assert.ok(names(scaleNotes({ root: 'F', scale: 'major' })).includes('Bb4'));
    assert.ok(names(scaleNotes({ root: 'F#', scale: 'major' })).includes('E#5'));
    assert.ok(names(scaleNotes({ root: 'Gb', scale: 'major' })).includes('Cb5'));
    assert.ok(names(scaleNotes({ root: 'A', scale: 'harmonic_minor' })).includes('G#5'));
    assert.ok(names(scaleNotes({ root: 'D', scale: 'harmonic_minor' })).includes('C#5'));
    assert.ok(names(scaleNotes({ root: 'G#', scale: 'harmonic_minor' })).includes('F##5'));
  });

  test('every seven-note scale on every root uses each letter once and the right pitch classes', () => {
    for (const root of ALL_ROOTS) {
      const parsed = parseRoot(root);
      for (const scale of ['major', 'natural_minor', 'harmonic_minor', 'melodic_minor']) {
        const notes = scaleNotes({ root, scale });
        const label = `${root} ${scale}`;
        assert.equal(notes.length, 8, label);
        const letters = notes.slice(0, 7).map((n) => n.name[0]);
        assert.equal(new Set(letters).size, 7, `${label}: letters ${letters.join('')}`);
        assert.equal(bare(notes[0].name), parsed.name, `${label}: starts on the root as given`);
        assert.equal(bare(notes[7].name), parsed.name, `${label}: ends on the root as given`);
        assert.deepEqual(
          notes.slice(0, 7).map((n) => (n.midi - notes[0].midi)),
          [...SCALE_INTERVALS[scale]],
          `${label}: intervals`,
        );
        assert.equal(pitchClass(notes[0].midi), parsed.pc, label);
        assert.equal(notes[7].midi, notes[0].midi + 12, label);
        for (const note of notes) {
          assert.equal(nameToMidi(note.name), note.midi, `${label}: ${note.name} names MIDI ${note.midi}`);
        }
      }
    }
  });

  test('the root is spelled as given, never re-rooted', () => {
    assert.equal(bareNames(scaleNotes({ root: 'C#', scale: 'major' })), 'C# D# E# F# G# A# B# C#');
    assert.equal(bareNames(scaleNotes({ root: 'Db', scale: 'major' })), 'Db Eb F Gb Ab Bb C Db');
    assert.deepEqual(
      midis(scaleNotes({ root: 'C#', scale: 'major' })),
      midis(scaleNotes({ root: 'Db', scale: 'major' })),
    );
    assert.equal(bareNames(scaleNotes({ root: 'G#', scale: 'major' })), 'G# A# B# C# D# E# F## G#');
    assert.equal(bareNames(scaleNotes({ root: 'c', scale: 'major' })), 'C D E F G A B C');
  });

  test('natural and melodic minor', () => {
    assert.equal(bareNames(scaleNotes({ root: 'A', scale: 'natural_minor' })), 'A B C D E F G A');
    assert.equal(bareNames(scaleNotes({ root: 'C', scale: 'natural_minor' })), 'C D Eb F G Ab Bb C');
    assert.equal(bareNames(scaleNotes({ root: 'F#', scale: 'natural_minor' })), 'F# G# A B C# D E F#');
    assert.equal(bareNames(scaleNotes({ root: 'A', scale: 'melodic_minor' })), 'A B C D E F# G# A');
    assert.equal(bareNames(scaleNotes({ root: 'C', scale: 'melodic_minor' })), 'C D Eb F G A B C');
    assert.equal(bareNames(scaleNotes({ root: 'G#', scale: 'melodic_minor' })), 'G# A# B C# D# E# F## G#');
  });

  test('melodic minor goes up melodic and comes down natural', () => {
    assert.equal(
      names(scaleNotes({ root: 'A', scale: 'melodic_minor', direction: 'up_down' })).join(' '),
      'A4 B4 C5 D5 E5 F#5 G#5 A5 G5 F5 E5 D5 C5 B4 A4',
    );
    assert.equal(
      names(scaleNotes({ root: 'A', scale: 'melodic_minor', direction: 'down' })).join(' '),
      'A5 G5 F5 E5 D5 C5 B4 A4',
    );
    assert.equal(
      names(scaleNotes({ root: 'D', scale: 'melodic_minor', direction: 'up_down', startOctave: 3 })).join(' '),
      'D3 E3 F3 G3 A3 B3 C#4 D4 C4 Bb3 A3 G3 F3 E3 D3',
    );
  });

  test('pentatonic scales follow their parent scale', () => {
    assert.equal(bareNames(scaleNotes({ root: 'C', scale: 'major_pentatonic' })), 'C D E G A C');
    assert.equal(bareNames(scaleNotes({ root: 'F#', scale: 'major_pentatonic' })), 'F# G# A# C# D# F#');
    assert.equal(bareNames(scaleNotes({ root: 'Gb', scale: 'major_pentatonic' })), 'Gb Ab Bb Db Eb Gb');
    assert.equal(bareNames(scaleNotes({ root: 'Bb', scale: 'major_pentatonic' })), 'Bb C D F G Bb');
    assert.equal(bareNames(scaleNotes({ root: 'A', scale: 'minor_pentatonic' })), 'A C D E G A');
    assert.equal(bareNames(scaleNotes({ root: 'C', scale: 'minor_pentatonic' })), 'C Eb F G Bb C');
    assert.equal(bareNames(scaleNotes({ root: 'C#', scale: 'minor_pentatonic' })), 'C# E F# G# B C#');
    assert.equal(bareNames(scaleNotes({ root: 'Eb', scale: 'minor_pentatonic' })), 'Eb Gb Ab Bb Db Eb');
  });

  test('blues scale: lowered fifth, written as a raised fourth only to avoid a double flat', () => {
    assert.equal(bareNames(scaleNotes({ root: 'C', scale: 'blues' })), 'C Eb F Gb G Bb C');
    assert.equal(bareNames(scaleNotes({ root: 'A', scale: 'blues' })), 'A C D Eb E G A');
    assert.equal(bareNames(scaleNotes({ root: 'E', scale: 'blues' })), 'E G A Bb B D E');
    assert.equal(bareNames(scaleNotes({ root: 'G', scale: 'blues' })), 'G Bb C Db D F G');
    assert.equal(bareNames(scaleNotes({ root: 'F#', scale: 'blues' })), 'F# A B C C# E F#');
    assert.equal(bareNames(scaleNotes({ root: 'F', scale: 'blues' })), 'F Ab Bb Cb C Eb F');
    assert.equal(bareNames(scaleNotes({ root: 'Eb', scale: 'blues' })), 'Eb Gb Ab A Bb Db Eb');
  });

  test('pentatonic and blues notes have the right pitches on every root', () => {
    for (const root of ALL_ROOTS) {
      for (const scale of ['major_pentatonic', 'minor_pentatonic', 'blues']) {
        const notes = scaleNotes({ root, scale });
        const size = SCALE_INTERVALS[scale].length;
        assert.equal(notes.length, size + 1, `${root} ${scale}`);
        assert.deepEqual(notes.slice(0, size).map((n) => n.midi - notes[0].midi), [...SCALE_INTERVALS[scale]]);
        for (const note of notes) assert.equal(nameToMidi(note.name), note.midi, `${root} ${scale} ${note.name}`);
      }
    }
  });

  test('chromatic scale uses sharps going up and flats coming down', () => {
    assert.equal(
      names(scaleNotes({ root: 'C', scale: 'chromatic', direction: 'up' })).join(' '),
      'C4 C#4 D4 D#4 E4 F4 F#4 G4 G#4 A4 A#4 B4 C5',
    );
    assert.equal(
      names(scaleNotes({ root: 'C', scale: 'chromatic', direction: 'down' })).join(' '),
      'C5 B4 Bb4 A4 Ab4 G4 Gb4 F4 E4 Eb4 D4 Db4 C4',
    );
    assert.equal(
      names(scaleNotes({ root: 'C', scale: 'chromatic', direction: 'up_down' })).join(' '),
      'C4 C#4 D4 D#4 E4 F4 F#4 G4 G#4 A4 A#4 B4 C5 B4 Bb4 A4 Ab4 G4 Gb4 F4 E4 Eb4 D4 Db4 C4',
    );
  });

  test('chromatic scale keeps the spelling of its starting note', () => {
    assert.equal(
      names(scaleNotes({ root: 'Eb', scale: 'chromatic', direction: 'up_down' })).join(' '),
      'Eb4 E4 F4 F#4 G4 G#4 A4 A#4 B4 C5 C#5 D5 Eb5 D5 Db5 C5 B4 Bb4 A4 Ab4 G4 Gb4 F4 E4 Eb4',
    );
    const fromFSharpDown = names(scaleNotes({ root: 'F#', scale: 'chromatic', direction: 'down' }));
    assert.equal(fromFSharpDown[0], 'F#5');
    assert.equal(fromFSharpDown.at(-1), 'F#4');
    assert.equal(fromFSharpDown[1], 'F5');
    assert.equal(fromFSharpDown[2], 'E5');
    assert.equal(fromFSharpDown[3], 'Eb5');
    for (const root of ALL_ROOTS) {
      for (const direction of DIRECTIONS) {
        for (const note of scaleNotes({ root, scale: 'chromatic', direction, octaves: 2 })) {
          assert.equal(nameToMidi(note.name), note.midi, `${root} chromatic ${note.name}`);
        }
      }
    }
  });

  test('octave numbers follow the written letter (B sharp, C flat)', () => {
    assert.deepEqual(scaleNotes({ root: 'B#', scale: 'major', startOctave: 3 })[0], { midi: 60, name: 'B#3' });
    assert.deepEqual(scaleNotes({ root: 'Cb', scale: 'major', startOctave: 4 })[0], { midi: 59, name: 'Cb4' });
    assert.deepEqual(scaleNotes({ root: 'C#', scale: 'major' })[6], { midi: 72, name: 'B#4' });
  });
});

describe('scaleNotes direction, octaves and bad input', () => {
  test('defaults: one octave up from octave 4', () => {
    assert.deepEqual(scaleNotes({ root: 'C', scale: 'major' }), [
      { midi: 60, name: 'C4' }, { midi: 62, name: 'D4' }, { midi: 64, name: 'E4' }, { midi: 65, name: 'F4' },
      { midi: 67, name: 'G4' }, { midi: 69, name: 'A4' }, { midi: 71, name: 'B4' }, { midi: 72, name: 'C5' },
    ]);
  });

  test('up_down plays the top note once: 15 steps for one octave', () => {
    const notes = scaleNotes({ root: 'C', scale: 'major', direction: 'up_down' });
    assert.equal(names(notes).join(' '), 'C4 D4 E4 F4 G4 A4 B4 C5 B4 A4 G4 F4 E4 D4 C4');
    assert.equal(notes.length, 15);
    assert.equal(scaleNotes({ root: 'C', scale: 'major', direction: 'up_down', octaves: 2 }).length, 29);
  });

  test('down starts at the top and ends on the start octave', () => {
    assert.equal(
      names(scaleNotes({ root: 'C', scale: 'major', direction: 'down', octaves: 2, startOctave: 3 })).join(' '),
      'C5 B4 A4 G4 F4 E4 D4 C4 B3 A3 G3 F3 E3 D3 C3',
    );
  });

  test('start octave is the octave of the lowest note', () => {
    assert.equal(scaleNotes({ root: 'G', scale: 'major', startOctave: 2 })[0].name, 'G2');
    assert.equal(scaleNotes({ root: 'G', scale: 'major', startOctave: 2 })[0].midi, 43);
    assert.equal(scaleNotes({ root: 'A', scale: 'major', startOctave: 0 })[0].midi, 21);
  });

  test('note counts for every scale, octave count and direction', () => {
    for (const root of TWELVE_ROOTS) {
      for (const scale of SCALES) {
        const size = SCALE_INTERVALS[scale].length;
        for (const octaves of [1, 2, 3, 4]) {
          const up = scaleNotes({ root, scale, octaves, direction: 'up' });
          const down = scaleNotes({ root, scale, octaves, direction: 'down' });
          const upDown = scaleNotes({ root, scale, octaves, direction: 'up_down' });
          const label = `${root} ${scale} x${octaves}`;
          assert.equal(up.length, size * octaves + 1, label);
          assert.equal(down.length, size * octaves + 1, label);
          assert.equal(upDown.length, 2 * size * octaves + 1, label);
          assert.deepEqual(upDown.slice(0, up.length), up, label);
          assert.deepEqual(upDown.slice(up.length - 1), down, label);
          for (let i = 1; i < up.length; i++) assert.ok(up[i].midi > up[i - 1].midi, `${label} ascends`);
          for (let i = 1; i < down.length; i++) assert.ok(down[i].midi < down[i - 1].midi, `${label} descends`);
          assert.equal(up[0].midi, down.at(-1).midi, label);
          assert.equal(up.at(-1).midi, up[0].midi + 12 * octaves, label);
          if (scale !== 'melodic_minor' && scale !== 'chromatic') {
            assert.deepEqual(down, up.slice().reverse(), `${label}: down mirrors up`);
          }
        }
      }
    }
  });

  test('invalid input gives an empty array and never throws', () => {
    const bad = [
      undefined,
      {},
      { root: 'H', scale: 'major' },
      { root: 'C', scale: 'lydian' },
      { root: 'C', scale: 'toString' },
      { root: 'C', scale: 'major', octaves: 0 },
      { root: 'C', scale: 'major', octaves: 5 },
      { root: 'C', scale: 'major', octaves: 1.5 },
      { root: 'C', scale: 'major', octaves: '2' },
      { root: 'C', scale: 'major', direction: 'sideways' },
      { root: 'C', scale: 'major', startOctave: 2.5 },
      { root: 'C', scale: 'major', startOctave: 12 },
      { root: 'C', scale: 'major', startOctave: NaN },
      { root: null, scale: null },
      { root: 4, scale: 5 },
    ];
    for (const options of bad) assert.deepEqual(scaleNotes(options), [], JSON.stringify(options));
  });

  test('returns fresh objects on every call', () => {
    const first = scaleNotes({ root: 'C', scale: 'major' });
    first[0].midi = 0;
    first.length = 2;
    assert.equal(scaleNotes({ root: 'C', scale: 'major' })[0].midi, 60);
    assert.equal(scaleNotes({ root: 'C', scale: 'major' }).length, 8);
  });
});

// ---------------------------------------------------------------- scale fingerings

// Expected fingerings, typed here independently of the tables in the module.
// [right hand, left hand], one octave ascending.
const MAJOR_1 = {
  C: ['12312345', '54321321'],
  G: ['12312345', '54321321'],
  D: ['12312345', '54321321'],
  A: ['12312345', '54321321'],
  E: ['12312345', '54321321'],
  B: ['12312345', '43214321'],
  'F#': ['23412312', '43213214'],
  Db: ['23123412', '32143213'],
  Ab: ['34123123', '32143213'],
  Eb: ['31234123', '32143213'],
  Bb: ['21231234', '32143213'],
  F: ['12341234', '54321321'],
};
const MAJOR_2 = {
  C: ['123123412312345', '543213214321321'],
  G: ['123123412312345', '543213214321321'],
  D: ['123123412312345', '543213214321321'],
  B: ['123123412312345', '432143213214321'],
  'F#': ['234123123412312', '432132143213214'],
  Db: ['231234123123412', '321432132143213'],
  Ab: ['341231234123123', '321432132143213'],
  Eb: ['312341231234123', '321432132143213'],
  Bb: ['212312341231234', '321432132143213'],
  F: ['123412312341234', '543213214321321'],
};
const HARMONIC_MINOR_1 = {
  A: ['12312345', '54321321'],
  E: ['12312345', '54321321'],
  D: ['12312345', '54321321'],
  G: ['12312345', '54321321'],
  C: ['12312345', '54321321'],
  B: ['12312345', '43214321'],
  F: ['12341234', '54321321'],
  'F#': ['34123123', '43213214'],
  'C#': ['34123123', '32143213'],
  'G#': ['34123123', '32143213'],
  Eb: ['31234123', '21432132'],
  Bb: ['21231234', '21321432'],
};
const HARMONIC_MINOR_2 = {
  A: ['123123412312345', '543213214321321'],
  D: ['123123412312345', '543213214321321'],
  E: ['123123412312345', '543213214321321'],
  C: ['123123412312345', '543213214321321'],
  B: ['123123412312345', '432143213214321'],
  F: ['123412312341234', '543213214321321'],
  'F#': ['341231234123123', '432132143213214'],
  'C#': ['341231234123123', '321432132143213'],
  Eb: ['312341231234123', '214321321432132'],
  Bb: ['212312341231234', '213214321321432'],
};

describe('scaleFingering: encoded standard fingerings', () => {
  test('all 12 major scales, one octave, both hands', () => {
    assert.equal(Object.keys(MAJOR_1).length, 12);
    for (const [root, [right, left]] of Object.entries(MAJOR_1)) {
      assert.equal(digits(scaleFingering({ root, scale: 'major', hand: 'right' })), right, `${root} major RH`);
      assert.equal(digits(scaleFingering({ root, scale: 'major', hand: 'left' })), left, `${root} major LH`);
    }
  });

  test('major scales, two octaves, both hands', () => {
    for (const [root, [right, left]] of Object.entries(MAJOR_2)) {
      assert.equal(digits(scaleFingering({ root, scale: 'major', hand: 'right', octaves: 2 })), right, `${root} RH`);
      assert.equal(digits(scaleFingering({ root, scale: 'major', hand: 'left', octaves: 2 })), left, `${root} LH`);
    }
  });

  test('all 12 harmonic minor scales, one octave, both hands', () => {
    assert.equal(Object.keys(HARMONIC_MINOR_1).length, 12);
    for (const [root, [right, left]] of Object.entries(HARMONIC_MINOR_1)) {
      const base = { root, scale: 'harmonic_minor' };
      assert.equal(digits(scaleFingering({ ...base, hand: 'right' })), right, `${root} harmonic minor RH`);
      assert.equal(digits(scaleFingering({ ...base, hand: 'left' })), left, `${root} harmonic minor LH`);
    }
  });

  test('harmonic minor scales, two octaves, both hands', () => {
    for (const [root, [right, left]] of Object.entries(HARMONIC_MINOR_2)) {
      const base = { root, scale: 'harmonic_minor', octaves: 2 };
      assert.equal(digits(scaleFingering({ ...base, hand: 'right' })), right, `${root} harmonic minor RH`);
      assert.equal(digits(scaleFingering({ ...base, hand: 'left' })), left, `${root} harmonic minor LH`);
    }
  });

  test('natural minor matches harmonic minor except the left hand of G sharp minor', () => {
    for (const [root, [right, left]] of Object.entries(HARMONIC_MINOR_1)) {
      const base = { root, scale: 'natural_minor' };
      assert.equal(digits(scaleFingering({ ...base, hand: 'right' })), right, `${root} natural minor RH`);
      const expectedLeft = root === 'G#' ? '32132143' : left;
      assert.equal(digits(scaleFingering({ ...base, hand: 'left' })), expectedLeft, `${root} natural minor LH`);
    }
    assert.equal(
      digits(scaleFingering({ root: 'G#', scale: 'natural_minor', hand: 'left', octaves: 2 })),
      '321321432132143',
    );
  });

  test('melodic minor: white-key tonics use the parallel major fingering, black-key tonics are null', () => {
    for (const root of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      for (const hand of HANDS) {
        for (const direction of DIRECTIONS) {
          assert.deepEqual(
            scaleFingering({ root, scale: 'melodic_minor', hand, octaves: 2, direction }),
            scaleFingering({ root, scale: 'major', hand, octaves: 2, direction }),
            `${root} melodic minor ${hand} ${direction}`,
          );
        }
      }
    }
    for (const root of ['C#', 'Db', 'D#', 'Eb', 'F#', 'Gb', 'G#', 'Ab', 'A#', 'Bb']) {
      for (const hand of HANDS) {
        assert.equal(scaleFingering({ root, scale: 'melodic_minor', hand }), null, `${root} melodic minor ${hand}`);
      }
    }
  });

  test('descending is the ascending fingering reversed; up_down omits the repeated top note', () => {
    assert.equal(digits(scaleFingering({ root: 'C', scale: 'major', hand: 'right', direction: 'down' })), '54321321');
    assert.equal(digits(scaleFingering({ root: 'C', scale: 'major', hand: 'left', direction: 'down' })), '12312345');
    assert.equal(
      digits(scaleFingering({ root: 'C', scale: 'major', hand: 'right', direction: 'up_down' })),
      '123123454321321',
    );
    assert.equal(
      digits(scaleFingering({ root: 'C', scale: 'major', hand: 'left', direction: 'up_down' })),
      '543213212312345',
    );
    assert.equal(
      digits(scaleFingering({ root: 'C', scale: 'major', hand: 'right', octaves: 2, direction: 'up_down' })),
      '12312341231234543213214321321',
    );
    assert.equal(
      digits(scaleFingering({ root: 'Bb', scale: 'major', hand: 'right', direction: 'up_down' })),
      '212312343213212',
    );
    for (const root of TWELVE_ROOTS) {
      for (const scale of ['major', 'natural_minor', 'harmonic_minor', 'chromatic']) {
        for (const hand of HANDS) {
          for (const octaves of [1, 2, 3]) {
            const up = scaleFingering({ root, scale, hand, octaves, direction: 'up' });
            const down = scaleFingering({ root, scale, hand, octaves, direction: 'down' });
            const upDown = scaleFingering({ root, scale, hand, octaves, direction: 'up_down' });
            if (up === null) {
              assert.equal(down, null);
              assert.equal(upDown, null);
              continue;
            }
            assert.deepEqual(down, up.slice().reverse(), `${root} ${scale} ${hand}`);
            assert.deepEqual(upDown, up.concat(up.slice().reverse().slice(1)), `${root} ${scale} ${hand}`);
          }
        }
      }
    }
  });

  test('three and four octaves keep repeating the pattern', () => {
    assert.equal(
      digits(scaleFingering({ root: 'C', scale: 'major', hand: 'right', octaves: 3 })),
      '1231234123123412312345',
    );
    assert.equal(
      digits(scaleFingering({ root: 'Eb', scale: 'major', hand: 'left', octaves: 4 })),
      '32143213214321321432132143213',
    );
  });

  test('enharmonic spellings of a tonic share one fingering', () => {
    for (const hand of HANDS) {
      for (const scale of ['major', 'natural_minor', 'harmonic_minor', 'chromatic']) {
        for (const [a, b] of [['C#', 'Db'], ['D#', 'Eb'], ['F#', 'Gb'], ['G#', 'Ab'], ['A#', 'Bb'], ['B', 'Cb'],
          ['C', 'B#'], ['E', 'Fb'], ['F', 'E#']]) {
          assert.deepEqual(scaleFingering({ root: a, scale, hand }), scaleFingering({ root: b, scale, hand }));
        }
      }
    }
  });

  test('hand accepts R and L as well', () => {
    assert.deepEqual(
      scaleFingering({ root: 'C', scale: 'major', hand: 'R' }),
      scaleFingering({ root: 'C', scale: 'major', hand: 'right' }),
    );
    assert.deepEqual(
      scaleFingering({ root: 'C', scale: 'major', hand: 'L' }),
      scaleFingering({ root: 'C', scale: 'major', hand: 'left' }),
    );
  });

  test('returns a fresh array on every call', () => {
    const first = scaleFingering({ root: 'C', scale: 'major', hand: 'right' });
    first[0] = 9;
    first.reverse();
    assert.equal(digits(scaleFingering({ root: 'C', scale: 'major', hand: 'right' })), '12312345');
  });
});

describe('scaleFingering: chromatic scale', () => {
  test('from C: the standard pattern in both hands', () => {
    assert.equal(digits(scaleFingering({ root: 'C', scale: 'chromatic', hand: 'right' })), '1313123131312');
    assert.equal(digits(scaleFingering({ root: 'C', scale: 'chromatic', hand: 'left' })), '1313213131321');
    assert.equal(
      digits(scaleFingering({ root: 'C', scale: 'chromatic', hand: 'right', octaves: 2 })),
      '1313123131312313123131312',
    );
    assert.equal(
      digits(scaleFingering({ root: 'C', scale: 'chromatic', hand: 'right', direction: 'down' })),
      '2131313213131',
    );
  });

  test('from D and A flat (the mirror points of the keyboard)', () => {
    assert.equal(digits(scaleFingering({ root: 'D', scale: 'chromatic', hand: 'right' })), '1312313131231');
    assert.equal(digits(scaleFingering({ root: 'D', scale: 'chromatic', hand: 'left' })), '1321313132131');
    assert.equal(digits(scaleFingering({ root: 'Ab', scale: 'chromatic', hand: 'right' })), '3131231312313');
    assert.equal(digits(scaleFingering({ root: 'Ab', scale: 'chromatic', hand: 'left' })), '3132131321313');
  });

  test('left hand from A, as printed in chromatic scale charts', () => {
    assert.equal(digits(scaleFingering({ root: 'A', scale: 'chromatic', hand: 'left' })), '1321313213131');
  });

  test('3 on every black key, thumb or 2 on white keys, 2 only on C and F (right) or E and B (left)', () => {
    for (const root of TWELVE_ROOTS) {
      for (const hand of HANDS) {
        const fingers = scaleFingering({ root, scale: 'chromatic', hand, octaves: 2 });
        if (fingers === null) continue;
        const notes = scaleNotes({ root, scale: 'chromatic', octaves: 2 });
        assert.equal(fingers.length, notes.length);
        notes.forEach((note, i) => {
          const label = `${root} chromatic ${hand} note ${note.name}`;
          if (isBlackKey(note.midi)) {
            assert.equal(fingers[i], 3, label);
          } else {
            assert.ok(fingers[i] === 1 || fingers[i] === 2, label);
            if (fingers[i] === 2) {
              const allowed = hand === 'right' ? [0, 5] : [4, 11];
              assert.ok(allowed.includes(pitchClass(note.midi)), label);
            }
          }
        });
      }
    }
  });

  test('start notes the published charts do not settle are null', () => {
    assert.equal(scaleFingering({ root: 'F', scale: 'chromatic', hand: 'right' }), null);
    assert.equal(scaleFingering({ root: 'E', scale: 'chromatic', hand: 'left' }), null);
    assert.equal(scaleFingering({ root: 'B', scale: 'chromatic', hand: 'left' }), null);
    assert.notEqual(scaleFingering({ root: 'F', scale: 'chromatic', hand: 'left' }), null);
    assert.notEqual(scaleFingering({ root: 'E', scale: 'chromatic', hand: 'right' }), null);
    assert.notEqual(scaleFingering({ root: 'B', scale: 'chromatic', hand: 'right' }), null);
  });
});

describe('scaleFingering: null instead of a guess', () => {
  test('pentatonic and blues scales have no encoded fingering', () => {
    for (const root of ALL_ROOTS) {
      for (const scale of ['major_pentatonic', 'minor_pentatonic', 'blues']) {
        for (const hand of HANDS) {
          for (const direction of DIRECTIONS) {
            assert.equal(scaleFingering({ root, scale, hand, direction }), null, `${root} ${scale} ${hand}`);
          }
        }
      }
    }
  });

  test('invalid arguments give null and never throw', () => {
    const bad = [
      undefined,
      {},
      { root: 'C', scale: 'major' },
      { root: 'C', scale: 'major', hand: 'both' },
      { root: 'C', scale: 'major', hand: 'RIGHT' },
      { root: 'H', scale: 'major', hand: 'right' },
      { root: 'C', scale: 'dorian', hand: 'right' },
      { root: 'C', scale: 'constructor', hand: 'right' },
      { root: 'C', scale: 'major', hand: 'right', octaves: 0 },
      { root: 'C', scale: 'major', hand: 'right', octaves: 5 },
      { root: 'C', scale: 'major', hand: 'right', octaves: 2.5 },
      { root: 'C', scale: 'major', hand: 'right', direction: 'round' },
      { root: null, scale: null, hand: null },
    ];
    for (const options of bad) assert.equal(scaleFingering(options), null, JSON.stringify(options));
  });
});

describe('scale fingerings line up with the notes and are playable', () => {
  test('same length as scaleNotes for every root, scale, hand, octave count and direction', () => {
    let encoded = 0;
    for (const root of ALL_ROOTS) {
      for (const scale of SCALES) {
        for (const hand of HANDS) {
          for (const octaves of [1, 2, 3, 4]) {
            for (const direction of DIRECTIONS) {
              const fingers = scaleFingering({ root, scale, hand, octaves, direction });
              if (fingers === null) continue;
              encoded += 1;
              const notes = scaleNotes({ root, scale, octaves, direction });
              const label = `${root} ${scale} ${hand} x${octaves} ${direction}`;
              assert.equal(fingers.length, notes.length, label);
              for (const finger of fingers) assert.ok(Number.isInteger(finger) && finger >= 1 && finger <= 5, label);
            }
          }
        }
      }
    }
    assert.ok(encoded > 1500, `expected many encoded fingerings, got ${encoded}`);
  });

  test('the thumb never plays a black key and finger 5 only ends a scale', () => {
    for (const root of TWELVE_ROOTS) {
      for (const scale of ['major', 'natural_minor', 'harmonic_minor', 'melodic_minor']) {
        for (const hand of HANDS) {
          const fingers = scaleFingering({ root, scale, hand, octaves: 2 });
          if (fingers === null) continue;
          const notes = scaleNotes({ root, scale, octaves: 2 });
          const label = `${root} ${scale} ${hand}`;
          notes.forEach((note, i) => {
            if (fingers[i] === 1) assert.ok(!isBlackKey(note.midi), `${label}: thumb on ${note.name}`);
            if (fingers[i] === 5) {
              assert.equal(i, hand === 'right' ? notes.length - 1 : 0, `${label}: finger 5 on ${note.name}`);
            }
          });
        }
      }
    }
  });

  test('every step is the next finger or a thumb crossing', () => {
    for (const root of TWELVE_ROOTS) {
      for (const scale of ['major', 'natural_minor', 'harmonic_minor', 'melodic_minor']) {
        for (const hand of HANDS) {
          const fingers = scaleFingering({ root, scale, hand, octaves: 2 });
          if (fingers === null) continue;
          for (let i = 1; i < fingers.length; i++) {
            const from = fingers[i - 1];
            const to = fingers[i];
            const label = `${root} ${scale} ${hand}: ${from} then ${to} at ${i}`;
            if (hand === 'right') {
              assert.ok(to === from + 1 || (to === 1 && from >= 2 && from <= 4), label);
            } else {
              assert.ok(to === from - 1 || (from === 1 && to >= 2 && to <= 4), label);
            }
          }
        }
      }
    }
  });

  test('each octave of a seven-note scale uses the fourth finger exactly once', () => {
    for (const root of TWELVE_ROOTS) {
      for (const scale of ['major', 'natural_minor', 'harmonic_minor']) {
        for (const hand of HANDS) {
          const fingers = scaleFingering({ root, scale, hand, octaves: 3 });
          // look at the middle octave only, where there are no start or end exceptions
          const middle = fingers.slice(7, 14);
          assert.equal(middle.filter((f) => f === 4).length, 1, `${root} ${scale} ${hand}: ${middle.join('')}`);
          assert.equal(middle.filter((f) => f === 1).length, 2, `${root} ${scale} ${hand}: ${middle.join('')}`);
          assert.deepEqual(fingers.slice(7, 14), fingers.slice(14, 21), `${root} ${scale} ${hand}: octaves repeat`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------- arpeggios

describe('arpeggioNotes', () => {
  test('triads and seventh chords, correctly spelled', () => {
    assert.equal(names(arpeggioNotes({ root: 'C', quality: 'major' })).join(' '), 'C4 E4 G4 C5');
    assert.equal(names(arpeggioNotes({ root: 'C', quality: 'minor' })).join(' '), 'C4 Eb4 G4 C5');
    assert.equal(names(arpeggioNotes({ root: 'B', quality: 'diminished' })).join(' '), 'B4 D5 F5 B5');
    assert.equal(names(arpeggioNotes({ root: 'C', quality: 'augmented' })).join(' '), 'C4 E4 G#4 C5');
    assert.equal(names(arpeggioNotes({ root: 'G', quality: 'dominant7', startOctave: 3 })).join(' '), 'G3 B3 D4 F4 G4');
    assert.equal(names(arpeggioNotes({ root: 'F', quality: 'major7' })).join(' '), 'F4 A4 C5 E5 F5');
    assert.equal(names(arpeggioNotes({ root: 'D', quality: 'minor7' })).join(' '), 'D4 F4 A4 C5 D5');
    assert.equal(names(arpeggioNotes({ root: 'F#', quality: 'major' })).join(' '), 'F#4 A#4 C#5 F#5');
    assert.equal(names(arpeggioNotes({ root: 'Gb', quality: 'major' })).join(' '), 'Gb4 Bb4 Db5 Gb5');
    assert.equal(names(arpeggioNotes({ root: 'Eb', quality: 'minor' })).join(' '), 'Eb4 Gb4 Bb4 Eb5');
    assert.equal(names(arpeggioNotes({ root: 'D#', quality: 'minor' })).join(' '), 'D#4 F#4 A#4 D#5');
    assert.equal(names(arpeggioNotes({ root: 'C#', quality: 'major' })).join(' '), 'C#4 E#4 G#4 C#5');
  });

  test('octaves and directions', () => {
    assert.equal(
      names(arpeggioNotes({ root: 'C', quality: 'major', octaves: 2 })).join(' '),
      'C4 E4 G4 C5 E5 G5 C6',
    );
    assert.equal(
      names(arpeggioNotes({ root: 'C', quality: 'major', direction: 'up_down' })).join(' '),
      'C4 E4 G4 C5 G4 E4 C4',
    );
    assert.equal(
      names(arpeggioNotes({ root: 'A', quality: 'minor', direction: 'down', octaves: 2, startOctave: 2 })).join(' '),
      'A4 E4 C4 A3 E3 C3 A2',
    );
    assert.equal(arpeggioNotes({ root: 'C', quality: 'dominant7', octaves: 2, direction: 'up_down' }).length, 17);
  });

  test('every note name matches its MIDI number', () => {
    for (const root of ALL_ROOTS) {
      for (const quality of ['major', 'minor', 'diminished', 'augmented', 'dominant7', 'major7', 'minor7']) {
        const notes = arpeggioNotes({ root, quality, octaves: 2, direction: 'up_down' });
        for (const note of notes) assert.equal(nameToMidi(note.name), note.midi, `${root} ${quality} ${note.name}`);
        if (notes.length) assert.equal(pitchClass(notes[0].midi), parseRoot(root).pc);
      }
    }
  });

  test('invalid input gives an empty array', () => {
    assert.deepEqual(arpeggioNotes(), []);
    assert.deepEqual(arpeggioNotes({}), []);
    assert.deepEqual(arpeggioNotes({ root: 'C', quality: 'jazzy' }), []);
    assert.deepEqual(arpeggioNotes({ root: 'C', quality: 'add9' }), []);
    assert.deepEqual(arpeggioNotes({ root: 'X', quality: 'major' }), []);
    assert.deepEqual(arpeggioNotes({ root: 'C', quality: 'major', octaves: 9 }), []);
    assert.deepEqual(arpeggioNotes({ root: 'C', quality: 'major', direction: 'x' }), []);
    assert.deepEqual(arpeggioNotes({ root: 'C', quality: 'major', startOctave: 'four' }), []);
    assert.deepEqual(arpeggioNotes({ root: 'C', quality: 'hasOwnProperty' }), []);
  });
});

// [right hand, left hand], one octave ascending, typed independently of the module tables.
const ARP_MAJOR_1 = {
  C: ['1235', '5421'],
  G: ['1235', '5421'],
  F: ['1235', '5421'],
  D: ['1235', '5321'],
  A: ['1235', '5321'],
  E: ['1235', '5321'],
  B: ['1235', '5321'],
  'F#': ['1235', '5321'],
  Db: ['2124', '2142'],
  Eb: ['2124', '2142'],
  Ab: ['2124', '2142'],
  Bb: ['2124', '3213'],
};
const ARP_MINOR_1 = {
  A: ['1235', '5421'],
  E: ['1235', '5421'],
  D: ['1235', '5421'],
  G: ['1235', '5421'],
  C: ['1235', '5421'],
  F: ['1235', '5421'],
  B: ['1235', '5421'],
  Eb: ['1235', '5421'],
  'C#': ['2124', '2142'],
  'F#': ['2124', '2142'],
  'G#': ['2124', '2142'],
  Bb: ['2312', '3213'],
};
const ARP_2 = {
  'C major': ['1231235', '5421421'],
  'F major': ['1231235', '5421421'],
  'D major': ['1231235', '5321321'],
  'B major': ['1231235', '5321321'],
  'F# major': ['1231235', '5321321'],
  'Eb major': ['2124124', '2142142'],
  'Ab major': ['2124124', '2142142'],
  'Db major': ['2124124', '2142142'],
  'Bb major': ['2124124', '3213213'],
  'A minor': ['1231235', '5421421'],
  'C minor': ['1231235', '5421421'],
  'Eb minor': ['1231235', '5421421'],
  'C# minor': ['2124124', '2142142'],
  'F# minor': ['2124124', '2142142'],
  'G# minor': ['2124124', '2142142'],
  'Bb minor': ['2312312', '3213213'],
};

describe('arpeggioFingering', () => {
  test('major triads in all 12 keys, one octave', () => {
    assert.equal(Object.keys(ARP_MAJOR_1).length, 12);
    for (const [root, [right, left]] of Object.entries(ARP_MAJOR_1)) {
      assert.equal(digits(arpeggioFingering({ root, quality: 'major', hand: 'right' })), right, `${root} RH`);
      assert.equal(digits(arpeggioFingering({ root, quality: 'major', hand: 'left' })), left, `${root} LH`);
    }
  });

  test('minor triads in all 12 keys, one octave', () => {
    assert.equal(Object.keys(ARP_MINOR_1).length, 12);
    for (const [root, [right, left]] of Object.entries(ARP_MINOR_1)) {
      assert.equal(digits(arpeggioFingering({ root, quality: 'minor', hand: 'right' })), right, `${root}m RH`);
      assert.equal(digits(arpeggioFingering({ root, quality: 'minor', hand: 'left' })), left, `${root}m LH`);
    }
  });

  test('two octaves', () => {
    for (const [key, [right, left]] of Object.entries(ARP_2)) {
      const [root, quality] = key.split(' ');
      assert.equal(digits(arpeggioFingering({ root, quality, hand: 'right', octaves: 2 })), right, `${key} RH`);
      assert.equal(digits(arpeggioFingering({ root, quality, hand: 'left', octaves: 2 })), left, `${key} LH`);
    }
  });

  test('directions and more octaves are derived from the ascending pattern', () => {
    assert.equal(digits(arpeggioFingering({ root: 'C', quality: 'major', hand: 'right', direction: 'down' })), '5321');
    assert.equal(
      digits(arpeggioFingering({ root: 'C', quality: 'major', hand: 'right', direction: 'up_down' })),
      '1235321',
    );
    assert.equal(
      digits(arpeggioFingering({ root: 'C', quality: 'major', hand: 'left', octaves: 2, direction: 'up_down' })),
      '5421421241245',
    );
    assert.equal(
      digits(arpeggioFingering({ root: 'Eb', quality: 'major', hand: 'right', octaves: 3 })),
      '2124124124',
    );
    assert.equal(
      digits(arpeggioFingering({ root: 'C', quality: 'major', hand: 'right', octaves: 4 })),
      '1231231231235',
    );
  });

  test('lines up with arpeggioNotes for every key, hand, octave count and direction', () => {
    for (const root of ALL_ROOTS) {
      for (const quality of ['major', 'minor']) {
        for (const hand of HANDS) {
          for (const octaves of [1, 2, 3, 4]) {
            for (const direction of DIRECTIONS) {
              const fingers = arpeggioFingering({ root, quality, hand, octaves, direction });
              const notes = arpeggioNotes({ root, quality, octaves, direction });
              const label = `${root} ${quality} ${hand} x${octaves} ${direction}`;
              assert.ok(Array.isArray(fingers), label);
              assert.equal(fingers.length, notes.length, label);
              for (const finger of fingers) assert.ok(Number.isInteger(finger) && finger >= 1 && finger <= 5, label);
            }
            const up = arpeggioFingering({ root, quality, hand, octaves, direction: 'up' });
            assert.deepEqual(
              arpeggioFingering({ root, quality, hand, octaves, direction: 'down' }),
              up.slice().reverse(),
            );
            assert.deepEqual(
              arpeggioFingering({ root, quality, hand, octaves, direction: 'up_down' }),
              up.concat(up.slice().reverse().slice(1)),
            );
          }
        }
      }
    }
  });

  test('playable: thumb on white keys (unless the chord has none), finger 5 only at the outer end', () => {
    for (const root of TWELVE_ROOTS) {
      for (const quality of ['major', 'minor']) {
        const notes = arpeggioNotes({ root, quality, octaves: 2 });
        const allBlack = notes.every((note) => isBlackKey(note.midi));
        for (const hand of HANDS) {
          const fingers = arpeggioFingering({ root, quality, hand, octaves: 2 });
          const label = `${root} ${quality} ${hand} ${fingers.join('')}`;
          notes.forEach((note, i) => {
            if (fingers[i] === 1 && !allBlack) assert.ok(!isBlackKey(note.midi), `${label}: thumb on ${note.name}`);
            if (fingers[i] === 5) assert.equal(i, hand === 'right' ? notes.length - 1 : 0, label);
          });
          for (let i = 1; i < fingers.length; i++) {
            const from = fingers[i - 1];
            const to = fingers[i];
            if (hand === 'right') assert.ok(to > from || (to === 1 && from >= 2), `${label} at ${i}`);
            else assert.ok(to < from || (from === 1 && to >= 2), `${label} at ${i}`);
          }
        }
      }
    }
    // the two all-black-key triads
    assert.ok(arpeggioNotes({ root: 'F#', quality: 'major' }).every((n) => isBlackKey(n.midi)));
    assert.ok(arpeggioNotes({ root: 'Eb', quality: 'minor' }).every((n) => isBlackKey(n.midi)));
  });

  test('enharmonic roots share a fingering', () => {
    for (const hand of HANDS) {
      for (const quality of ['major', 'minor']) {
        for (const [a, b] of [['C#', 'Db'], ['D#', 'Eb'], ['F#', 'Gb'], ['G#', 'Ab'], ['A#', 'Bb']]) {
          assert.deepEqual(
            arpeggioFingering({ root: a, quality, hand, octaves: 2 }),
            arpeggioFingering({ root: b, quality, hand, octaves: 2 }),
          );
        }
      }
    }
  });

  test('null for qualities without a verified fingering and for invalid input', () => {
    for (const root of TWELVE_ROOTS) {
      for (const quality of ['diminished', 'augmented', 'dominant7', 'major7', 'minor7', 'sus4', 'nonsense']) {
        for (const hand of HANDS) {
          assert.equal(arpeggioFingering({ root, quality, hand }), null, `${root} ${quality} ${hand}`);
        }
      }
    }
    assert.equal(arpeggioFingering(), null);
    assert.equal(arpeggioFingering({}), null);
    assert.equal(arpeggioFingering({ root: 'C', quality: 'major' }), null);
    assert.equal(arpeggioFingering({ root: 'C', quality: 'major', hand: 'both' }), null);
    assert.equal(arpeggioFingering({ root: 'Q', quality: 'major', hand: 'left' }), null);
    assert.equal(arpeggioFingering({ root: 'C', quality: 'major', hand: 'left', octaves: 0 }), null);
    assert.equal(arpeggioFingering({ root: 'C', quality: 'major', hand: 'left', direction: 'x' }), null);
    assert.equal(arpeggioFingering({ root: 'C', quality: 'valueOf', hand: 'left' }), null);
  });

  test('returns a fresh array on every call', () => {
    const first = arpeggioFingering({ root: 'C', quality: 'major', hand: 'right' });
    first.fill(0);
    assert.equal(digits(arpeggioFingering({ root: 'C', quality: 'major', hand: 'right' })), '1235');
  });
});

// ---------------------------------------------------------------- chord fingering

describe('chordFingering', () => {
  test('triads, by pitch order', () => {
    assert.deepEqual(chordFingering({ noteCount: 3, hand: 'right' }), [1, 3, 5]);
    assert.deepEqual(chordFingering({ noteCount: 3, hand: 'right', inversion: 0 }), [1, 3, 5]);
    assert.deepEqual(chordFingering({ noteCount: 3, hand: 'right', inversion: 1 }), [1, 2, 5]);
    assert.deepEqual(chordFingering({ noteCount: 3, hand: 'right', inversion: 2 }), [1, 3, 5]);
    assert.deepEqual(chordFingering({ noteCount: 3, hand: 'left', inversion: 0 }), [5, 3, 1]);
    assert.deepEqual(chordFingering({ noteCount: 3, hand: 'left', inversion: 1 }), [5, 3, 1]);
    assert.deepEqual(chordFingering({ noteCount: 3, hand: 'left', inversion: 2 }), [5, 2, 1]);
  });

  test('four-note chords in root position', () => {
    assert.deepEqual(chordFingering({ noteCount: 4, hand: 'right' }), [1, 2, 3, 5]);
    assert.deepEqual(chordFingering({ noteCount: 4, hand: 'left' }), [5, 3, 2, 1]);
  });

  test('null for anything that is not a verified standard', () => {
    for (const hand of HANDS) {
      for (const inversion of [1, 2, 3]) assert.equal(chordFingering({ noteCount: 4, hand, inversion }), null);
      for (const noteCount of [0, 1, 2, 5, 6, 10, -1, 3.5, NaN, '3', null]) {
        assert.equal(chordFingering({ noteCount, hand }), null, `noteCount ${noteCount}`);
      }
      assert.equal(chordFingering({ noteCount: 3, hand, inversion: 3 }), null);
      assert.equal(chordFingering({ noteCount: 3, hand, inversion: -1 }), null);
      assert.equal(chordFingering({ noteCount: 3, hand, inversion: 0.5 }), null);
    }
    assert.equal(chordFingering(), null);
    assert.equal(chordFingering({}), null);
    assert.equal(chordFingering({ noteCount: 3 }), null);
    assert.equal(chordFingering({ noteCount: 3, hand: 'both' }), null);
  });

  test('optional notes make the answer stricter', () => {
    // C major triad and its inversions
    assert.deepEqual(chordFingering({ noteCount: 3, hand: 'right', notes: [60, 64, 67] }), [1, 3, 5]);
    assert.deepEqual(chordFingering({ hand: 'right', notes: [60, 64, 67] }), [1, 3, 5]);
    assert.deepEqual(chordFingering({ hand: 'right', inversion: 1, notes: [64, 67, 72] }), [1, 2, 5]);
    assert.deepEqual(chordFingering({ hand: 'left', inversion: 2, notes: [55, 60, 64] }), [5, 2, 1]);
    // B diminished first inversion (third plus tritone) is still the standard shape
    assert.deepEqual(chordFingering({ hand: 'right', inversion: 1, notes: [62, 65, 71] }), [1, 2, 5]);
    // the shape of the notes wins over the inversion label
    assert.deepEqual(chordFingering({ hand: 'right', inversion: 1, notes: [60, 64, 67] }), [1, 3, 5]);
    assert.deepEqual(chordFingering({ hand: 'right', inversion: 0, notes: [64, 67, 72] }), [1, 2, 5]);
    // every position of an augmented triad is a stack of thirds
    assert.deepEqual(chordFingering({ hand: 'left', inversion: 1, notes: [64, 68, 72] }), [5, 3, 1]);
    assert.deepEqual(chordFingering({ hand: 'right', notes: [60, 64, 67, 70] }), [1, 2, 3, 5]);
    // sus chords, an inverted seventh, sixth chord, add9, wide or unsorted voicings, wrong count: null
    assert.equal(chordFingering({ hand: 'right', notes: [60, 65, 67] }), null);
    assert.equal(chordFingering({ hand: 'right', notes: [60, 62, 67] }), null);
    assert.equal(chordFingering({ hand: 'right', inversion: 1, notes: [64, 67, 70, 72] }), null);
    assert.equal(chordFingering({ hand: 'right', notes: [60, 67, 76] }), null);
    assert.equal(chordFingering({ hand: 'right', notes: [67, 64, 60] }), null);
    assert.equal(chordFingering({ hand: 'right', notes: [60, 67] }), null);
    assert.equal(chordFingering({ hand: 'right', notes: [] }), null);
    assert.equal(chordFingering({ hand: 'right', notes: [60, 64, 67, 69] }), null);
    assert.equal(chordFingering({ hand: 'right', notes: [60, 64, 67, 74] }), null);
    assert.equal(chordFingering({ noteCount: 3, hand: 'right', notes: [60, 64, 67, 70] }), null);
    assert.equal(chordFingering({ hand: 'right', notes: 'CEG' }), null);
    assert.equal(chordFingering({ hand: 'right', notes: [60, 'E', 67] }), null);
  });

  test('agrees with chordNotes for plain triads and sevenths in every key', () => {
    for (const root of TWELVE_ROOTS) {
      for (const suffix of ['', 'm', 'dim', 'aug']) {
        for (const inversion of [0, 1, 2]) {
          const notes = midis(chordNotes(`${root}${suffix}`, { inversion }));
          assert.notEqual(chordFingering({ hand: 'right', inversion, notes }), null, `${root}${suffix} inv ${inversion}`);
          assert.notEqual(chordFingering({ hand: 'left', inversion, notes }), null, `${root}${suffix} inv ${inversion}`);
        }
      }
      for (const suffix of ['7', 'maj7', 'm7', 'm7b5', 'dim7']) {
        const notes = midis(chordNotes(`${root}${suffix}`));
        assert.deepEqual(chordFingering({ hand: 'right', notes }), [1, 2, 3, 5]);
        assert.deepEqual(chordFingering({ hand: 'left', notes }), [5, 3, 2, 1]);
      }
    }
  });

  test('returns a fresh array on every call', () => {
    chordFingering({ noteCount: 3, hand: 'right' }).push(9);
    assert.deepEqual(chordFingering({ noteCount: 3, hand: 'right' }), [1, 3, 5]);
  });
});

// ---------------------------------------------------------------- chord symbols

describe('parseChordSymbol', () => {
  const VALID = [
    ['C', 'C', 'major', [0, 4, 7]],
    ['CM', 'C', 'major', [0, 4, 7]],
    ['Cmaj', 'C', 'major', [0, 4, 7]],
    ['Cm', 'Cm', 'minor', [0, 3, 7]],
    ['Cmin', 'Cm', 'minor', [0, 3, 7]],
    ['C-', 'Cm', 'minor', [0, 3, 7]],
    ['Cminor', 'Cm', 'minor', [0, 3, 7]],
    ['Cdim', 'Cdim', 'diminished', [0, 3, 6]],
    ['C°', 'Cdim', 'diminished', [0, 3, 6]],
    ['Caug', 'Caug', 'augmented', [0, 4, 8]],
    ['C+', 'Caug', 'augmented', [0, 4, 8]],
    ['Csus2', 'Csus2', 'sus2', [0, 2, 7]],
    ['Csus4', 'Csus4', 'sus4', [0, 5, 7]],
    ['Csus', 'Csus4', 'sus4', [0, 5, 7]],
    ['C6', 'C6', 'major6', [0, 4, 7, 9]],
    ['Cm6', 'Cm6', 'minor6', [0, 3, 7, 9]],
    ['C7', 'C7', 'dominant7', [0, 4, 7, 10]],
    ['Cmaj7', 'Cmaj7', 'major7', [0, 4, 7, 11]],
    ['CM7', 'Cmaj7', 'major7', [0, 4, 7, 11]],
    ['CMaj7', 'Cmaj7', 'major7', [0, 4, 7, 11]],
    ['CMAJ7', 'Cmaj7', 'major7', [0, 4, 7, 11]],
    ['CΔ7', 'Cmaj7', 'major7', [0, 4, 7, 11]],
    ['Cm7', 'Cm7', 'minor7', [0, 3, 7, 10]],
    ['Cmin7', 'Cm7', 'minor7', [0, 3, 7, 10]],
    ['C-7', 'Cm7', 'minor7', [0, 3, 7, 10]],
    ['Cm7b5', 'Cm7b5', 'half_diminished7', [0, 3, 6, 10]],
    ['Cm7(b5)', 'Cm7b5', 'half_diminished7', [0, 3, 6, 10]],
    ['Cø', 'Cm7b5', 'half_diminished7', [0, 3, 6, 10]],
    ['Cdim7', 'Cdim7', 'diminished7', [0, 3, 6, 9]],
    ['C°7', 'Cdim7', 'diminished7', [0, 3, 6, 9]],
    ['Cadd9', 'Cadd9', 'add9', [0, 4, 7, 2]],
    ['C(add9)', 'Cadd9', 'add9', [0, 4, 7, 2]],
    ['C5', 'C5', 'power', [0, 7]],
    ['C9', 'C9', 'dominant9', [0, 4, 7, 10, 2]],
    ['Cmaj9', 'Cmaj9', 'major9', [0, 4, 7, 11, 2]],
    ['Cm9', 'Cm9', 'minor9', [0, 3, 7, 10, 2]],
    ['C7sus4', 'C7sus4', 'dominant7sus4', [0, 5, 7, 10]],
    ['CmMaj7', 'CmMaj7', 'minor_major7', [0, 3, 7, 11]],
    ['Cm(maj7)', 'CmMaj7', 'minor_major7', [0, 3, 7, 11]],
    ['Cmadd9', 'Cmadd9', 'minor_add9', [0, 3, 7, 2]],
    ['F#m7', 'F#m7', 'minor7', [6, 9, 1, 4]],
    ['Bbmaj7', 'Bbmaj7', 'major7', [10, 2, 5, 9]],
    ['G7', 'G7', 'dominant7', [7, 11, 2, 5]],
    ['Ddim', 'Ddim', 'diminished', [2, 5, 8]],
    ['Am', 'Am', 'minor', [9, 0, 4]],
    ['Bb', 'Bb', 'major', [10, 2, 5]],
    ['Bb5', 'Bb5', 'power', [10, 5]],
    ['Ebm', 'Ebm', 'minor', [3, 6, 10]],
    ['E♭m', 'Ebm', 'minor', [3, 6, 10]],
    [' G7 ', 'G7', 'dominant7', [7, 11, 2, 5]],
    ['C dim', 'Cdim', 'diminished', [0, 3, 6]],
  ];

  test('valid symbols', () => {
    for (const [input, symbol, quality, pcs] of VALID) {
      const parsed = parseChordSymbol(input);
      assert.ok(parsed, `parseChordSymbol(${JSON.stringify(input)})`);
      assert.equal(parsed.symbol, symbol, input);
      assert.equal(parsed.quality, quality, input);
      assert.deepEqual(parsed.pcs, pcs, input);
      assert.equal(parsed.bass, null, input);
      assert.equal(parsed.pcs[0], parseRoot(parsed.root).pc, input);
      assert.equal(parsed.intervals.length, parsed.pcs.length, input);
    }
  });

  test('result shape', () => {
    assert.deepEqual(parseChordSymbol('C'), {
      root: 'C', quality: 'major', pcs: [0, 4, 7], intervals: [0, 4, 7], bass: null, symbol: 'C',
    });
    assert.deepEqual(parseChordSymbol('Cadd9').intervals, [0, 4, 7, 14]);
  });

  test('slash chords', () => {
    assert.deepEqual(parseChordSymbol('C/E'), {
      root: 'C', quality: 'major', pcs: [0, 4, 7], intervals: [0, 4, 7], bass: 'E', symbol: 'C/E',
    });
    assert.equal(parseChordSymbol('Am7/G').bass, 'G');
    assert.equal(parseChordSymbol('Am7/G').symbol, 'Am7/G');
    assert.equal(parseChordSymbol('F/G').bass, 'G');
    assert.equal(parseChordSymbol('D/F#').bass, 'F#');
    assert.equal(parseChordSymbol('Ebmaj7/Bb').symbol, 'Ebmaj7/Bb');
    assert.equal(parseChordSymbol('Cmin/Eb').symbol, 'Cm/Eb');
    // a bass equal to the root is no slash chord at all
    assert.equal(parseChordSymbol('C/C').bass, null);
    assert.equal(parseChordSymbol('C/C').symbol, 'C');
  });

  test('the typographic minus sign is read as minor', () => {
    const minus = String.fromCharCode(0x2212);
    assert.equal(parseChordSymbol(`C${minus}7`).symbol, 'Cm7');
    assert.equal(parseChordSymbol(`A${minus}`).symbol, 'Am');
  });

  test('upper case M is major, lower case m is minor', () => {
    assert.equal(parseChordSymbol('CM7').quality, 'major7');
    assert.equal(parseChordSymbol('Cm7').quality, 'minor7');
    assert.equal(parseChordSymbol('CM').quality, 'major');
    assert.equal(parseChordSymbol('Cm').quality, 'minor');
    assert.equal(parseChordSymbol('CM9').quality, 'major9');
    assert.equal(parseChordSymbol('Cm9').quality, 'minor9');
    assert.equal(parseChordSymbol('CM7b5'), null);
    assert.equal(parseChordSymbol('CMadd9'), null);
  });

  test('garbage is rejected with null', () => {
    const bad = ['', ' ', 'H', 'c', 'cm', 'Cfoo', 'C/', 'C/X', 'C/e', 'C//E', 'C/E/G', 'Bbb', 'C##', 'C6/9', 'C13',
      'C7b9', 'C7#9', 'C+7', 'Cm7b9', 'X7', '7', 'm7', 'maj7', '/E', 'C4', 'Csus3', 'do', 'C major scale',
      'constructor', 'C__proto__', 'CtoString', 'C'.repeat(40), 'C\n7x', null, undefined, 7, {}, [], ['C'], true];
    for (const input of bad) {
      assert.equal(parseChordSymbol(input), null, `parseChordSymbol(${JSON.stringify(input)})`);
    }
  });

  test('normalized symbols parse to themselves', () => {
    for (const [input] of VALID) {
      const once = parseChordSymbol(input);
      const twice = parseChordSymbol(once.symbol);
      assert.deepEqual(twice, once, input);
    }
  });
});

describe('chordNotes', () => {
  const spelled = (symbol, options) => names(chordNotes(symbol, options)).join(' ');

  test('root position at octave 4 by default, correctly spelled', () => {
    assert.deepEqual(chordNotes('C'), [{ midi: 60, name: 'C4' }, { midi: 64, name: 'E4' }, { midi: 67, name: 'G4' }]);
    assert.equal(spelled('Cm'), 'C4 Eb4 G4');
    assert.equal(spelled('G7'), 'G4 B4 D5 F5');
    assert.equal(spelled('F'), 'F4 A4 C5');
    assert.equal(spelled('Am'), 'A4 C5 E5');
    assert.equal(spelled('Bbmaj7'), 'Bb4 D5 F5 A5');
    assert.equal(spelled('F#m7'), 'F#4 A4 C#5 E5');
    assert.equal(spelled('Ddim'), 'D4 F4 Ab4');
    assert.equal(spelled('Caug'), 'C4 E4 G#4');
    assert.equal(spelled('Csus2'), 'C4 D4 G4');
    assert.equal(spelled('Csus4'), 'C4 F4 G4');
    assert.equal(spelled('C6'), 'C4 E4 G4 A4');
    assert.equal(spelled('Cm6'), 'C4 Eb4 G4 A4');
    assert.equal(spelled('Cm7b5'), 'C4 Eb4 Gb4 Bb4');
    assert.equal(spelled('Cdim7'), 'C4 Eb4 Gb4 Bbb4');
    assert.equal(spelled('Bdim7'), 'B4 D5 F5 Ab5');
    assert.equal(spelled('Cadd9'), 'C4 E4 G4 D5');
    assert.equal(spelled('C5'), 'C4 G4');
    assert.equal(spelled('C9'), 'C4 E4 G4 Bb4 D5');
    assert.equal(spelled('Db'), 'Db4 F4 Ab4');
    assert.equal(spelled('C#'), 'C#4 E#4 G#4');
    assert.equal(spelled('E'), 'E4 G#4 B4');
    assert.equal(spelled('Abm'), 'Ab4 Cb5 Eb5');
  });

  test('octave option', () => {
    assert.equal(spelled('C', { octave: 3 }), 'C3 E3 G3');
    assert.equal(spelled('G7', { octave: 2 }), 'G2 B2 D3 F3');
    assert.deepEqual(midis(chordNotes('A', { octave: 0 })), [21, 25, 28]);
  });

  test('inversions raise the lowest notes by an octave', () => {
    assert.equal(spelled('C', { inversion: 0 }), 'C4 E4 G4');
    assert.equal(spelled('C', { inversion: 1 }), 'E4 G4 C5');
    assert.equal(spelled('C', { inversion: 2 }), 'G4 C5 E5');
    assert.equal(spelled('G7', { octave: 3, inversion: 1 }), 'B3 D4 F4 G4');
    assert.equal(spelled('G7', { octave: 3, inversion: 2 }), 'D4 F4 G4 B4');
    assert.equal(spelled('G7', { octave: 3, inversion: 3 }), 'F4 G4 B4 D5');
    assert.equal(spelled('Am', { octave: 3, inversion: 1 }), 'C4 E4 A4');
    assert.equal(spelled('Cadd9', { inversion: 1 }), 'E4 G4 C5 D5');
  });

  test('slash chords put the named note at the bottom', () => {
    assert.equal(spelled('C/E'), 'E4 G4 C5');
    assert.equal(spelled('C/G'), 'G4 C5 E5');
    assert.equal(spelled('C/E', { inversion: 2 }), 'E4 G4 C5');
    assert.equal(spelled('D/F#', { octave: 3 }), 'F#3 A3 D4');
    assert.equal(spelled('Am7/G', { octave: 3 }), 'G4 A4 C5 E5');
    assert.equal(spelled('Cadd9/D'), 'D4 E4 G4 C5');
    // a bass that is not a chord tone goes underneath
    assert.equal(spelled('F/G'), 'G3 F4 A4 C5');
    assert.equal(spelled('C/Bb'), 'Bb3 C4 E4 G4');
    assert.equal(spelled('C/D', { inversion: 1 }), 'D4 E4 G4 C5');
  });

  test('always ascending, unique, matching the parsed pitch classes, names match MIDI numbers', () => {
    const suffixes = ['', 'm', 'dim', 'aug', 'sus2', 'sus4', '5', '6', 'm6', '7', 'maj7', 'm7', 'm7b5', 'dim7', 'add9',
      'madd9', 'mMaj7', '7sus4', '9', 'maj9', 'm9'];
    for (const root of TWELVE_ROOTS.concat(['C#', 'G#', 'Gb'])) {
      for (const suffix of suffixes) {
        const symbol = `${root}${suffix}`;
        const parsed = parseChordSymbol(symbol);
        assert.ok(parsed, symbol);
        for (let inversion = 0; inversion < parsed.pcs.length; inversion++) {
          const notes = chordNotes(symbol, { inversion });
          if (notes === null) {
            // only chords that would need a triple accidental cannot be spelled
            assert.ok(/dim7/.test(symbol), `${symbol} should be spellable`);
            continue;
          }
          assert.equal(notes.length, parsed.pcs.length, symbol);
          for (let i = 1; i < notes.length; i++) assert.ok(notes[i].midi > notes[i - 1].midi, `${symbol} ascending`);
          assert.deepEqual(
            [...new Set(notes.map((n) => pitchClass(n.midi)))].sort((a, b) => a - b),
            [...parsed.pcs].sort((a, b) => a - b),
            symbol,
          );
          for (const note of notes) assert.equal(nameToMidi(note.name), note.midi, `${symbol} ${note.name}`);
          if (inversion === 0) assert.equal(pitchClass(notes[0].midi), parsed.pcs[0], symbol);
        }
      }
    }
  });

  test('null for unknown symbols and bad options', () => {
    assert.equal(chordNotes('H'), null);
    assert.equal(chordNotes(''), null);
    assert.equal(chordNotes(null), null);
    assert.equal(chordNotes(undefined), null);
    assert.equal(chordNotes('C', { inversion: 3 }), null);
    assert.equal(chordNotes('C', { inversion: -1 }), null);
    assert.equal(chordNotes('C', { inversion: 1.5 }), null);
    assert.equal(chordNotes('C7', { inversion: 4 }), null);
    assert.equal(chordNotes('C', { octave: 99 }), null);
    assert.equal(chordNotes('C', { octave: 'x' }), null);
    // C flat diminished seventh would need a triple flat
    assert.equal(chordNotes('Cbdim7'), null);
  });
});

// ---------------------------------------------------------------- chord detection

describe('detectChord', () => {
  test('major and minor triads in root position', () => {
    assert.deepEqual(detectChord([60, 64, 67]), { name: 'C', root: 'C', quality: 'major', bass: 'C', inversion: 0 });
    assert.deepEqual(detectChord([57, 60, 64]), { name: 'Am', root: 'A', quality: 'minor', bass: 'A', inversion: 0 });
    assert.equal(detectChord([65, 69, 72]).name, 'F');
    assert.equal(detectChord([67, 71, 74]).name, 'G');
    assert.equal(detectChord([62, 65, 69]).name, 'Dm');
    assert.equal(detectChord([64, 67, 71]).name, 'Em');
  });

  test('inversions are named as slash chords', () => {
    assert.deepEqual(detectChord([64, 67, 72]), { name: 'C/E', root: 'C', quality: 'major', bass: 'E', inversion: 1 });
    assert.deepEqual(detectChord([67, 72, 76]), { name: 'C/G', root: 'C', quality: 'major', bass: 'G', inversion: 2 });
    assert.equal(detectChord([60, 64, 69]).name, 'Am/C');
    assert.equal(detectChord([64, 69, 72]).name, 'Am/E');
    assert.equal(detectChord([66, 69, 74]).name, 'D/F#');
    assert.equal(detectChord([62, 65, 71]).name, 'Bdim/D');
  });

  test('order and octave doubling do not matter, the lowest note is the bass', () => {
    assert.equal(detectChord([67, 60, 64]).name, 'C');
    assert.equal(detectChord([76, 72, 67, 64]).name, 'C/E');
    assert.equal(detectChord([48, 55, 64, 72, 76]).name, 'C');
    assert.equal(detectChord([36, 60, 64, 67, 72]).name, 'C');
    assert.equal(detectChord([52, 60, 67, 72]).name, 'C/E');
    assert.equal(detectChord([60, 60, 64, 67, 67]).name, 'C');
    assert.equal(detectChord(new Set([64, 60, 67])).name, 'C');
    assert.equal(detectChord(new Uint8Array([60, 64, 67])).name, 'C');
    assert.equal(detectChord(new Map([[67, 1], [60, 1], [64, 1]]).keys()).name, 'C');
  });

  test('seventh chords and their inversions', () => {
    assert.equal(detectChord([60, 64, 67, 70]).name, 'C7');
    assert.equal(detectChord([60, 64, 67, 71]).name, 'Cmaj7');
    assert.equal(detectChord([60, 63, 67, 70]).name, 'Cm7');
    assert.equal(detectChord([55, 59, 62, 65]).name, 'G7');
    assert.deepEqual(detectChord([59, 62, 65, 67]), {
      name: 'G7/B', root: 'G', quality: 'dominant7', bass: 'B', inversion: 1,
    });
    assert.equal(detectChord([62, 65, 67, 71]).name, 'G7/D');
    assert.equal(detectChord([65, 67, 71, 74]).name, 'G7/F');
    assert.equal(detectChord([65, 67, 71, 74]).inversion, 3);
    assert.equal(detectChord([59, 62, 65, 69]).name, 'Bm7b5');
    assert.equal(detectChord([59, 62, 65, 68]).name, 'Bdim7');
    assert.equal(detectChord([60, 63, 67, 71]).name, 'CmMaj7');
  });

  test('a seventh chord without its fifth is still named', () => {
    assert.equal(detectChord([60, 64, 70]).name, 'C7');
    assert.equal(detectChord([60, 63, 70]).name, 'Cm7');
    assert.equal(detectChord([60, 64, 71]).name, 'Cmaj7');
    assert.equal(detectChord([58, 60, 64]).name, 'C7/Bb');
  });

  test('other qualities', () => {
    assert.equal(detectChord([59, 62, 65]).name, 'Bdim');
    assert.equal(detectChord([60, 64, 68]).name, 'Caug');
    assert.equal(detectChord([60, 65, 67]).name, 'Csus4');
    assert.equal(detectChord([60, 62, 67]).name, 'Csus2');
    assert.equal(detectChord([60, 62, 64, 67]).name, 'Cadd9');
    assert.equal(detectChord([60, 64, 67, 74]).name, 'Cadd9');
    assert.equal(detectChord([60, 64, 67, 70, 74]).name, 'C9');
    assert.equal(detectChord([60, 65, 67, 70]).name, 'C7sus4');
  });

  test('when two readings fit, the one with its root in the bass wins', () => {
    assert.equal(detectChord([60, 64, 67, 69]).name, 'C6');
    assert.equal(detectChord([57, 60, 64, 67]).name, 'Am7');
    assert.equal(detectChord([60, 63, 67, 69]).name, 'Cm6');
    assert.equal(detectChord([57, 60, 63, 67]).name, 'Am7b5');
    assert.equal(detectChord([67, 72, 74]).name, 'Gsus4');
    assert.equal(detectChord([60, 62, 67]).name, 'Csus2');
    // symmetric chords are named from their bass note
    assert.equal(detectChord([64, 68, 72]).name, 'Eaug');
    assert.equal(detectChord([62, 65, 68, 71]).name, 'Ddim7');
    // neither root in the bass: the simpler seventh chord wins over the sixth chord
    assert.equal(detectChord([64, 67, 69, 72]).name, 'Am7/E');
    // so the first inversion of a minor seventh is heard as a sixth chord, and of a half
    // diminished seventh as a minor sixth chord
    assert.equal(detectChord(midis(chordNotes('Am7', { inversion: 1 }))).name, 'C6');
    assert.equal(detectChord(midis(chordNotes('Cm7b5', { inversion: 1 }))).name, 'Ebm6');
    assert.equal(detectChord(midis(chordNotes('Cm7b5', { inversion: 2 }))).name, 'Cm7b5/Gb');
  });

  test('black-key roots get the simpler spelling', () => {
    assert.equal(detectChord([61, 65, 68]).name, 'Db');
    assert.equal(detectChord([61, 64, 68]).name, 'C#m');
    assert.equal(detectChord([63, 67, 70]).name, 'Eb');
    assert.equal(detectChord([63, 66, 70]).name, 'Ebm');
    assert.equal(detectChord([66, 70, 73]).name, 'F#');
    assert.equal(detectChord([66, 69, 73]).name, 'F#m');
    assert.equal(detectChord([68, 72, 75]).name, 'Ab');
    assert.equal(detectChord([68, 71, 75]).name, 'G#m');
    assert.equal(detectChord([70, 74, 77]).name, 'Bb');
    assert.equal(detectChord([70, 73, 77]).name, 'Bbm');
    assert.deepEqual(detectChord([65, 68, 73]), { name: 'Db/F', root: 'Db', quality: 'major', bass: 'F', inversion: 1 });
    assert.deepEqual(detectChord([68, 73, 76]), {
      name: 'C#m/G#', root: 'C#', quality: 'minor', bass: 'G#', inversion: 2,
    });
  });

  test('two notes: a power chord for a fifth, otherwise null', () => {
    assert.deepEqual(detectChord([60, 67]), { name: 'C5', root: 'C', quality: 'power', bass: 'C', inversion: 0 });
    assert.equal(detectChord([48, 55, 60]).name, 'C5');
    assert.deepEqual(detectChord([67, 72]), { name: 'C5/G', root: 'C', quality: 'power', bass: 'G', inversion: 1 });
    for (const interval of [1, 2, 3, 4, 6, 8, 9, 10, 11]) {
      assert.equal(detectChord([60, 60 + interval]), null, `interval of ${interval} semitones`);
    }
  });

  test('noise, clusters and too little input give null', () => {
    assert.equal(detectChord([60, 61, 62]), null);
    assert.equal(detectChord([60, 62, 64]), null);
    assert.equal(detectChord([60, 61, 62, 63, 64]), null);
    assert.equal(detectChord([60, 62, 64, 66, 68, 70]), null);
    assert.equal(detectChord([60, 61, 64, 67]), null);
    assert.equal(detectChord(Array.from({ length: 12 }, (_, i) => 60 + i)), null);
    assert.equal(detectChord([60]), null);
    assert.equal(detectChord([60, 72, 84]), null);
    assert.equal(detectChord([]), null);
  });

  test('bad input never throws', () => {
    for (const bad of [null, undefined, 60, 'CEG', {}, { length: 3 }, [null, 'x', 60.5], [NaN, Infinity], [200, 300, 400],
      [-5, 64, 67], true]) {
      assert.doesNotThrow(() => detectChord(bad));
    }
    assert.equal(detectChord(null), null);
    assert.equal(detectChord('CEG'), null);
    assert.equal(detectChord({}), null);
    assert.equal(detectChord([null, 'x', 60.5]), null);
    // invalid entries are ignored, the rest is still named
    assert.equal(detectChord([60, 'x', 64, null, 67, 999]).name, 'C');
  });

  test('names what chordNotes builds, for every quality and root', () => {
    const suffixes = { '': 'major', m: 'minor', dim: 'diminished', aug: 'augmented', sus2: 'sus2', sus4: 'sus4',
      5: 'power', 6: 'major6', m6: 'minor6', 7: 'dominant7', maj7: 'major7', m7: 'minor7', m7b5: 'half_diminished7',
      dim7: 'diminished7', add9: 'add9', madd9: 'minor_add9', mMaj7: 'minor_major7', '7sus4': 'dominant7sus4',
      9: 'dominant9', maj9: 'major9', m9: 'minor9' };
    for (const root of TWELVE_ROOTS) {
      for (const [suffix, quality] of Object.entries(suffixes)) {
        const symbol = `${root}${suffix}`;
        const notes = chordNotes(symbol);
        if (notes === null) continue;
        const detected = detectChord(midis(notes));
        assert.ok(detected, `${symbol} was not detected`);
        assert.equal(detected.quality, quality, symbol);
        assert.equal(parseRoot(detected.root).pc, parseRoot(root).pc, symbol);
        assert.equal(detected.inversion, 0, symbol);
        // the detected name is itself a valid chord symbol with the same notes
        const reparsed = parseChordSymbol(detected.name);
        assert.ok(reparsed, `${detected.name} should parse`);
        assert.deepEqual(reparsed.pcs, parseChordSymbol(symbol).pcs, symbol);
      }
    }
  });

  test('every inversion of every triad and seventh chord is named with the right root and bass', () => {
    for (const root of TWELVE_ROOTS) {
      for (const suffix of ['', 'm', 'dim', '7', 'maj7']) {
        const symbol = `${root}${suffix}`;
        const size = parseChordSymbol(symbol).pcs.length;
        for (let inversion = 1; inversion < size; inversion++) {
          const notes = chordNotes(symbol, { inversion });
          const detected = detectChord(midis(notes));
          assert.ok(detected, `${symbol} inversion ${inversion}`);
          assert.equal(parseRoot(detected.root).pc, parseRoot(root).pc, `${symbol} inversion ${inversion}`);
          assert.equal(detected.inversion, inversion, `${symbol} inversion ${inversion}`);
          assert.equal(parseRoot(detected.bass).pc, pitchClass(notes[0].midi), symbol);
          assert.ok(detected.name.endsWith(`/${detected.bass}`), detected.name);
          assert.equal(parseChordSymbol(detected.name).bass, detected.bass, detected.name);
        }
      }
    }
  });
});

// ---------------------------------------------------------------- key estimation

function histogram(notes, durations) {
  const weights = new Array(12).fill(0);
  notes.forEach((midi, i) => {
    weights[pitchClass(midi)] += durations ? durations[i] : 1;
  });
  return weights;
}
const transpose = (weights, semitones) => weights.map((_, i) => weights[(i - semitones + 120) % 12]);

describe('estimateKey', () => {
  // Twinkle Twinkle Little Star, first two phrases, with the long notes weighted double
  const TWINKLE = histogram([60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60], [1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2]);
  const C_CADENCE = histogram([60, 64, 67, 65, 69, 72, 67, 71, 74, 60, 64, 67]);
  const A_MINOR_CADENCE = histogram([57, 60, 64, 62, 65, 69, 64, 68, 71, 57, 60, 64]);
  const A_HARMONIC_MINOR = histogram([57, 59, 60, 62, 64, 65, 68, 69, 68, 65, 64, 62, 60, 59, 57]);

  test('clear C major material', () => {
    const melody = estimateKey(TWINKLE);
    assert.equal(melody.tonic, 'C');
    assert.equal(melody.mode, 'major');
    assert.ok(melody.confidence > 0.6, `confidence ${melody.confidence}`);
    const chords = estimateKey(C_CADENCE);
    assert.equal(chords.tonic, 'C');
    assert.equal(chords.mode, 'major');
    assert.ok(chords.confidence > 0.6, `confidence ${chords.confidence}`);
    assert.deepEqual(Object.keys(melody).sort(), ['confidence', 'mode', 'tonic']);
  });

  test('clear A minor material', () => {
    const chords = estimateKey(A_MINOR_CADENCE);
    assert.equal(chords.tonic, 'A');
    assert.equal(chords.mode, 'minor');
    assert.ok(chords.confidence > 0.6, `confidence ${chords.confidence}`);
    const scale = estimateKey(A_HARMONIC_MINOR);
    assert.equal(scale.tonic, 'A');
    assert.equal(scale.mode, 'minor');
    assert.ok(scale.confidence > 0.6, `confidence ${scale.confidence}`);
  });

  test('a major scale played up and down is heard in its own key', () => {
    const upDown = midis(scaleNotes({ root: 'C', scale: 'major', direction: 'up_down' }));
    assert.deepEqual(
      { tonic: estimateKey(histogram(upDown)).tonic, mode: estimateKey(histogram(upDown)).mode },
      { tonic: 'C', mode: 'major' },
    );
  });

  test('transposing the music transposes the answer and keeps the confidence', () => {
    const majorTonics = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    const minorTonics = ['A', 'Bb', 'B', 'C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#'];
    const majorBase = estimateKey(TWINKLE);
    const minorBase = estimateKey(A_MINOR_CADENCE);
    for (let shift = 0; shift < 12; shift++) {
      const major = estimateKey(transpose(TWINKLE, shift));
      assert.equal(major.tonic, majorTonics[shift]);
      assert.equal(major.mode, 'major');
      assert.ok(Math.abs(major.confidence - majorBase.confidence) < 1e-9);
      const minor = estimateKey(transpose(A_MINOR_CADENCE, shift));
      assert.equal(minor.tonic, minorTonics[shift]);
      assert.equal(minor.mode, 'minor');
      assert.ok(Math.abs(minor.confidence - minorBase.confidence) < 1e-9);
    }
  });

  test('confidence stays inside 0..1 and is low for ambiguous material', () => {
    const cases = [
      TWINKLE,
      C_CADENCE,
      histogram([60]),
      histogram([60, 61, 62]),
      histogram([60, 62, 64, 66, 68, 70]),
      histogram([60, 62, 64, 65, 67, 69, 71]),
      [5, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0],
      [1000, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1e-9, 0, 0, 0, 2e-9, 0, 0, 1e-9, 0, 0, 0, 0],
    ];
    for (const weights of cases) {
      const key = estimateKey(weights);
      assert.ok(key, JSON.stringify(weights));
      assert.ok(key.confidence >= 0 && key.confidence <= 1, `confidence ${key.confidence}`);
      assert.ok(key.mode === 'major' || key.mode === 'minor');
      assert.ok(parseRoot(key.tonic));
    }
    // one note, a cluster, a whole-tone scale: nothing a key can be heard in
    assert.ok(estimateKey(histogram([60])).confidence < 0.2);
    assert.ok(estimateKey(histogram([60, 61, 62])).confidence < 0.3);
    assert.ok(estimateKey(histogram([60, 62, 64, 66, 68, 70])).confidence < 0.1);
    // the bare white keys fit C major and A minor almost equally well
    assert.ok(estimateKey(histogram([60, 62, 64, 65, 67, 69, 71])).confidence < 0.5);
  });

  test('null when there is nothing to go on', () => {
    assert.equal(estimateKey(new Array(12).fill(0)), null);
    assert.equal(estimateKey(new Array(12).fill(3)), null);
    assert.equal(estimateKey([]), null);
    assert.equal(estimateKey([1, 2, 3]), null);
    assert.equal(estimateKey(new Array(13).fill(1)), null);
    assert.equal(estimateKey(null), null);
    assert.equal(estimateKey(undefined), null);
    assert.equal(estimateKey('CDEFGABCDEFG'), null);
    assert.equal(estimateKey(42), null);
    assert.equal(estimateKey({}), null);
    assert.equal(estimateKey(new Array(12).fill(NaN)), null);
    assert.equal(estimateKey(new Array(12).fill(-1)), null);
  });

  test('negative, missing and non-numeric weights count as zero', () => {
    const dirty = [...TWINKLE];
    dirty[1] = -4;
    dirty[3] = NaN;
    dirty[6] = undefined;
    dirty[8] = 'x';
    dirty[10] = Infinity;
    const key = estimateKey(dirty);
    assert.equal(key.tonic, 'C');
    assert.equal(key.mode, 'major');
  });

  test('accepts typed arrays and does not modify its input', () => {
    const typed = Float32Array.from(TWINKLE);
    assert.equal(estimateKey(typed).tonic, 'C');
    const copy = [...TWINKLE];
    estimateKey(TWINKLE);
    assert.deepEqual(TWINKLE, copy);
  });
});

// ---------------------------------------------------------------- key signatures and spelling

const MAJOR_KEYS = {
  C: [0, 0], G: [1, 0], D: [2, 0], A: [3, 0], E: [4, 0], B: [5, 0], 'F#': [6, 0], 'C#': [7, 0],
  F: [0, 1], Bb: [0, 2], Eb: [0, 3], Ab: [0, 4], Db: [0, 5], Gb: [0, 6], Cb: [0, 7],
};
const MINOR_KEYS = {
  A: [0, 0], E: [1, 0], B: [2, 0], 'F#': [3, 0], 'C#': [4, 0], 'G#': [5, 0], 'D#': [6, 0], 'A#': [7, 0],
  D: [0, 1], G: [0, 2], C: [0, 3], F: [0, 4], Bb: [0, 5], Eb: [0, 6], Ab: [0, 7],
};
const SHARPS_IN_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLATS_IN_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

function expectedSignature([sharps, flats]) {
  const accidentals = {};
  for (let i = 0; i < sharps; i++) accidentals[SHARPS_IN_ORDER[i]] = 1;
  for (let i = 0; i < flats; i++) accidentals[FLATS_IN_ORDER[i]] = -1;
  return { sharps, flats, accidentals };
}

describe('keySignature', () => {
  test('all 15 major keys', () => {
    assert.equal(Object.keys(MAJOR_KEYS).length, 15);
    for (const [tonic, counts] of Object.entries(MAJOR_KEYS)) {
      assert.deepStrictEqual(keySignature(tonic, 'major'), expectedSignature(counts), `${tonic} major`);
    }
  });

  test('all 15 minor keys', () => {
    assert.equal(Object.keys(MINOR_KEYS).length, 15);
    for (const [tonic, counts] of Object.entries(MINOR_KEYS)) {
      assert.deepStrictEqual(keySignature(tonic, 'minor'), expectedSignature(counts), `${tonic} minor`);
    }
  });

  test('spot checks', () => {
    assert.deepStrictEqual(keySignature('F', 'major'), { sharps: 0, flats: 1, accidentals: { B: -1 } });
    assert.deepStrictEqual(keySignature('D', 'major'), { sharps: 2, flats: 0, accidentals: { F: 1, C: 1 } });
    assert.deepStrictEqual(keySignature('C', 'minor'), { sharps: 0, flats: 3, accidentals: { B: -1, E: -1, A: -1 } });
    assert.deepStrictEqual(keySignature('C', 'major'), { sharps: 0, flats: 0, accidentals: {} });
    assert.deepStrictEqual(keySignature('A', 'minor'), { sharps: 0, flats: 0, accidentals: {} });
    assert.deepStrictEqual(keySignature('eb', 'major'), keySignature('Eb', 'major'));
  });

  test('the signature matches the accidentals of the scale itself', () => {
    for (const [keys, scale, mode] of [[MAJOR_KEYS, 'major', 'major'], [MINOR_KEYS, 'natural_minor', 'minor']]) {
      for (const tonic of Object.keys(keys)) {
        const fromScale = {};
        for (const note of scaleNotes({ root: tonic, scale }).slice(0, 7)) {
          const name = bare(note.name);
          if (name.length > 1) fromScale[name[0]] = name[1] === '#' ? 1 : -1;
        }
        assert.deepEqual(keySignature(tonic, mode).accidentals, fromScale, `${tonic} ${mode}`);
      }
    }
  });

  test('scale names are accepted as the mode', () => {
    assert.deepStrictEqual(keySignature('A', 'harmonic_minor'), keySignature('A', 'minor'));
    assert.deepStrictEqual(keySignature('D', 'natural_minor'), keySignature('D', 'minor'));
    assert.deepStrictEqual(keySignature('G', 'melodic_minor'), keySignature('G', 'minor'));
    assert.deepStrictEqual(keySignature('E', 'minor_pentatonic'), keySignature('E', 'minor'));
    assert.deepStrictEqual(keySignature('E', 'blues'), keySignature('E', 'minor'));
    assert.deepStrictEqual(keySignature('G', 'major_pentatonic'), keySignature('G', 'major'));
  });

  test('keys without a conventional signature and invalid input give the empty signature', () => {
    const empty = { sharps: 0, flats: 0, accidentals: {} };
    assert.deepStrictEqual(keySignature('G#', 'major'), empty);
    assert.deepStrictEqual(keySignature('Fb', 'major'), empty);
    assert.deepStrictEqual(keySignature('Db', 'minor'), empty);
    assert.deepStrictEqual(keySignature('H', 'major'), empty);
    assert.deepStrictEqual(keySignature('C', 'lydian'), empty);
    assert.deepStrictEqual(keySignature('C', 'chromatic'), empty);
    assert.deepStrictEqual(keySignature(), empty);
    assert.deepStrictEqual(keySignature(null, null), empty);
    assert.deepStrictEqual(keySignature(5, {}), empty);
  });
});

describe('spellMidi', () => {
  test('the examples of the brief', () => {
    assert.equal(spellMidi(70, { tonic: 'F', mode: 'major' }), 'Bb4');
    assert.equal(spellMidi(66, { tonic: 'D', mode: 'major' }), 'F#4');
    assert.equal(spellMidi(58, { tonic: 'F', mode: 'major' }), 'Bb3');
  });

  test('without a key it falls back to sharps', () => {
    assert.equal(spellMidi(60, null), 'C4');
    assert.equal(spellMidi(61, null), 'C#4');
    assert.equal(spellMidi(70, null), 'A#4');
    assert.equal(spellMidi(70), 'A#4');
    assert.equal(spellMidi(70, {}), 'A#4');
    assert.equal(spellMidi(70, { tonic: 'H', mode: 'major' }), 'A#4');
    assert.equal(spellMidi(70, { tonic: 'F', mode: 'mixolydian' }), 'A#4');
    assert.equal(spellMidi(70, 'F major'), 'A#4');
    assert.equal(spellMidi(21, null), 'A0');
    assert.equal(spellMidi(108, null), 'C8');
  });

  test('notes outside the key use sharps in sharp keys and flats in flat keys', () => {
    assert.equal(spellMidi(61, { tonic: 'F', mode: 'major' }), 'Db4');
    assert.equal(spellMidi(66, { tonic: 'F', mode: 'major' }), 'Gb4');
    assert.equal(spellMidi(63, { tonic: 'D', mode: 'major' }), 'D#4');
    assert.equal(spellMidi(70, { tonic: 'D', mode: 'major' }), 'A#4');
    assert.equal(spellMidi(68, { tonic: 'Eb', mode: 'major' }), 'Ab4');
    assert.equal(spellMidi(66, { tonic: 'Eb', mode: 'major' }), 'Gb4');
    assert.equal(spellMidi(61, { tonic: 'C', mode: 'major' }), 'C#4');
    assert.equal(spellMidi(70, { tonic: 'C', mode: 'major' }), 'A#4');
    assert.equal(spellMidi(63, { tonic: 'G', mode: 'minor' }), 'Eb4');
    assert.equal(spellMidi(61, { tonic: 'G', mode: 'minor' }), 'Db4');
  });

  test('minor keys spell the raised sixth and seventh as their scales do', () => {
    assert.equal(spellMidi(68, { tonic: 'A', mode: 'minor' }), 'G#4');
    assert.equal(spellMidi(66, { tonic: 'A', mode: 'minor' }), 'F#4');
    assert.equal(spellMidi(61, { tonic: 'D', mode: 'minor' }), 'C#4');
    assert.equal(spellMidi(66, { tonic: 'G', mode: 'minor' }), 'F#4');
    assert.equal(spellMidi(71, { tonic: 'C', mode: 'minor' }), 'B4');
    assert.equal(spellMidi(65, { tonic: 'F#', mode: 'minor' }), 'E#4');
    assert.equal(spellMidi(67, { tonic: 'G#', mode: 'minor' }), 'F##4');
    assert.equal(spellMidi(60, { tonic: 'C#', mode: 'minor' }), 'B#3');
  });

  test('octave numbers follow the letter', () => {
    assert.equal(spellMidi(71, { tonic: 'Gb', mode: 'major' }), 'Cb5');
    assert.equal(spellMidi(60, { tonic: 'C#', mode: 'major' }), 'B#3');
    assert.equal(spellMidi(65, { tonic: 'C#', mode: 'major' }), 'E#4');
    assert.equal(spellMidi(59, { tonic: 'Cb', mode: 'major' }), 'Cb4');
  });

  test('every note of a key gets the name its scale gives it', () => {
    for (const tonic of Object.keys(MAJOR_KEYS)) {
      for (const note of scaleNotes({ root: tonic, scale: 'major', octaves: 2, startOctave: 3 })) {
        assert.equal(spellMidi(note.midi, { tonic, mode: 'major' }), note.name, `${tonic} major`);
      }
    }
    for (const tonic of Object.keys(MINOR_KEYS)) {
      for (const scale of ['natural_minor', 'harmonic_minor', 'melodic_minor']) {
        for (const note of scaleNotes({ root: tonic, scale, octaves: 2, startOctave: 3 })) {
          assert.equal(spellMidi(note.midi, { tonic, mode: 'minor' }), note.name, `${tonic} ${scale}`);
          assert.equal(spellMidi(note.midi, { tonic, mode: scale }), note.name, `${tonic} ${scale} as mode`);
        }
      }
    }
  });

  test('every name it produces reads back as the same MIDI number', () => {
    const keys = [null];
    for (const tonic of ALL_ROOTS) keys.push({ tonic, mode: 'major' }, { tonic, mode: 'minor' });
    for (const key of keys) {
      for (let midi = 12; midi <= 119; midi++) {
        const name = spellMidi(midi, key);
        assert.equal(nameToMidi(name), midi, `${name} in ${key ? `${key.tonic} ${key.mode}` : 'no key'}`);
      }
    }
  });

  test('a note that is not an integer gives an empty string', () => {
    assert.equal(spellMidi(60.5, null), '');
    assert.equal(spellMidi(NaN, { tonic: 'C', mode: 'major' }), '');
    assert.equal(spellMidi('60', null), '');
    assert.equal(spellMidi(null, null), '');
    assert.equal(spellMidi(undefined), '');
  });
});

// ---------------------------------------------------------------- intervals

describe('intervalName', () => {
  test('simple intervals', () => {
    const expected = ['unison', 'minor 2nd', 'major 2nd', 'minor 3rd', 'major 3rd', 'perfect 4th', 'tritone',
      'perfect 5th', 'minor 6th', 'major 6th', 'minor 7th', 'major 7th', 'octave'];
    expected.forEach((name, semitones) => assert.equal(intervalName(semitones), name));
    assert.equal(intervalName(4), 'major 3rd');
  });

  test('direction does not change the name', () => {
    assert.equal(intervalName(-4), 'major 3rd');
    assert.equal(intervalName(-12), 'octave');
    assert.equal(intervalName(-0), 'unison');
  });

  test('compound intervals', () => {
    assert.equal(intervalName(13), 'minor 9th');
    assert.equal(intervalName(14), 'major 9th');
    assert.equal(intervalName(15), 'minor 10th');
    assert.equal(intervalName(16), 'major 10th');
    assert.equal(intervalName(17), 'perfect 11th');
    assert.equal(intervalName(18), 'octave + tritone');
    assert.equal(intervalName(19), 'perfect 12th');
    assert.equal(intervalName(24), '2 octaves');
    assert.equal(intervalName(26), '2 octaves + major 2nd');
    assert.equal(intervalName(36), '3 octaves');
    assert.equal(intervalName(87), '7 octaves + minor 3rd');
  });

  test('bad input gives an empty string, fractions are rounded', () => {
    assert.equal(intervalName(NaN), '');
    assert.equal(intervalName(Infinity), '');
    assert.equal(intervalName('4'), '');
    assert.equal(intervalName(null), '');
    assert.equal(intervalName(undefined), '');
    assert.equal(intervalName({}), '');
    assert.equal(intervalName(3.9), 'major 3rd');
  });
});

// ---------------------------------------------------------------- robustness

describe('no export throws on garbage', () => {
  const GARBAGE = [undefined, null, 0, -1, 3.7, NaN, Infinity, '', 'x', 'C', 'major', true, false, [], [1, 2, 3], {},
    { root: null }, { root: {}, scale: [], hand: 5, octaves: 'x', direction: 0, quality: null, startOctave: {} },
    { noteCount: {}, hand: [], inversion: 'x', notes: {} }, { tonic: 5, mode: [] }, () => 1, Symbol('s'), 10n,
    new Date(0), new Map(), new Set([1]), [Symbol('a'), 10n, {}, [], null], Object.create(null)];

  test('single-argument functions', () => {
    const functions = { parseRoot, scaleNotes, scaleFingering, arpeggioNotes, arpeggioFingering, parseChordSymbol,
      chordNotes, chordFingering, detectChord, estimateKey, spellMidi, intervalName, keySignature };
    for (const [name, fn] of Object.entries(functions)) {
      for (const value of GARBAGE) {
        assert.doesNotThrow(() => fn(value), `${name}(${typeof value})`);
      }
    }
  });

  test('two-argument functions', () => {
    for (const a of GARBAGE) {
      for (const b of GARBAGE) {
        assert.doesNotThrow(() => chordNotes(a, b));
        assert.doesNotThrow(() => chordNotes('C', b));
        assert.doesNotThrow(() => spellMidi(a, b));
        assert.doesNotThrow(() => spellMidi(60, b));
        assert.doesNotThrow(() => keySignature(a, b));
      }
    }
  });

  test('garbage in gives the documented empty answers', () => {
    assert.deepEqual(scaleNotes(null), []);
    assert.deepEqual(arpeggioNotes(null), []);
    assert.equal(scaleFingering(null), null);
    assert.equal(arpeggioFingering(null), null);
    assert.equal(chordFingering(null), null);
    assert.equal(chordNotes('C', null).length, 3);
    assert.equal(estimateKey([Symbol('a'), 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]).mode.length, 5);
  });

  test('options with a fractional or absurd note count never produce fingers', () => {
    for (const noteCount of [3.0000001, 2.999, '3', [3], { valueOf: () => 3 }]) {
      assert.equal(chordFingering({ noteCount, hand: 'right' }), null);
    }
  });
});

// ---------------------------------------------------------------- house rules

describe('module hygiene', () => {
  const source = readFileSync(new URL('../shared/theory.js', import.meta.url), 'utf8');
  const testSource = readFileSync(new URL(import.meta.url), 'utf8');

  test('no em dash anywhere', () => {
    const emDash = String.fromCharCode(0x2014);
    assert.equal(source.includes(emDash), false);
    assert.equal(testSource.includes(emDash), false);
  });

  test('shared/theory.js imports nothing but shared/midi.js', () => {
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ['./midi.js']);
    assert.equal(/\brequire\s*\(/.test(source), false);
    assert.equal(/\b(document|window|process|globalThis)\b/.test(source), false);
  });
});
