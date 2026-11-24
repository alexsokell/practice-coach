import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as exercisesModule from '../shared/exercises.js';
import {
  buildExercise,
  validateExercise,
  sliceExercise,
  withTempo,
  describeExercise,
  STARTER_EXERCISES,
  EXERCISE_SPEC_JSON_SCHEMA,
} from '../shared/exercises.js';
import { nameToMidi } from '../shared/midi.js';
import { SCALE_INTERVALS } from '../shared/theory.js';

// ---------------------------------------------------------------- helpers

// Built from code points so that this file stays plain ASCII.
const EM_DASH = String.fromCharCode(0x2014);
const FLAT = String.fromCharCode(0x266d);
const SHARP = String.fromCharCode(0x266f);

const COMMON = { title: 'Test title', goal: 'Test goal.', hand: 'right', bpm: 72, mode: 'wait' };

const scaleSpec = (extra = {}) => ({
  type: 'scale', ...COMMON, root: 'C', scale: 'major', octaves: 1, direction: 'up_down', start_octave: 4, note_beats: 1, ...extra,
});
const arpeggioSpec = (extra = {}) => ({
  type: 'arpeggio', ...COMMON, root: 'C', quality: 'major', octaves: 1, direction: 'up_down', start_octave: 4, note_beats: 1, ...extra,
});
const fiveFingerSpec = (extra = {}) => ({
  type: 'five_finger', ...COMMON, root: 'C', quality: 'major', pattern: 'up_down', start_octave: 4, note_beats: 1, ...extra,
});
const chordsSpec = (extra = {}) => ({
  type: 'chords', ...COMMON, chords: ['C', 'F', 'G', 'C'], style: 'block', voicing: 'root', start_octave: 4, beats_per_chord: 4, ...extra,
});
const customStep = (right, left = [], beats = 1, rightFingers = null, leftFingers = null) => ({
  right, left, beats, right_fingers: rightFingers, left_fingers: leftFingers,
});
const customSpec = (steps, extra = {}) => ({ type: 'custom', ...COMMON, beats_per_bar: 4, steps, ...extra });

/** Build a spec that must succeed. Every successful build is also checked for the invariants below. */
function build(spec) {
  const result = buildExercise(spec);
  assert.equal(result.ok, true, `expected the spec to build, got: ${JSON.stringify(result.errors)}`);
  const { exercise } = result;
  assert.deepEqual(validateExercise(exercise), [], 'a built exercise passes validateExercise');
  // The stored spec is normalized: building it again gives exactly the same exercise.
  const again = buildExercise(exercise.spec);
  assert.equal(again.ok, true, `the normalized spec builds again: ${JSON.stringify(again.errors)}`);
  assert.deepEqual(again.exercise, exercise);
  // Exercises travel through JSON (localStorage, the HTTP API) and stay valid and unchanged.
  const revived = JSON.parse(JSON.stringify(exercise));
  assert.deepEqual(revived, exercise);
  assert.deepEqual(validateExercise(revived), []);
  return exercise;
}

/** Build a spec that must be rejected and return its error messages. */
function errorsOf(spec) {
  const result = buildExercise(spec);
  assert.equal(result.ok, false, 'expected the spec to be rejected');
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, 'a rejection lists at least one error');
  for (const message of result.errors) {
    assert.equal(typeof message, 'string');
    assert.ok(message.length > 0 && message.length < 400, `error message has a sane length: ${message}`);
  }
  assert.equal('exercise' in result, false);
  return result.errors;
}

/** The spec must be rejected with at least one message matching each pattern. */
function rejects(spec, ...patterns) {
  const errors = errorsOf(spec);
  for (const pattern of patterns) {
    assert.ok(errors.some((message) => pattern.test(message)), `no error matches ${pattern}: ${JSON.stringify(errors)}`);
  }
  return errors;
}

const midis = (exercise) => exercise.steps.map((step) => step.notes);
const names = (exercise) => exercise.steps.map((step) => step.names);
const fingers = (exercise) => exercise.steps.map((step) => step.fingers);
const hands = (exercise) => exercise.steps.map((step) => step.hands);
const beats = (exercise) => exercise.steps.map((step) => step.beats);
const labels = (exercise) => exercise.steps.map((step) => step.label);
const single = (exercise, field) => exercise.steps.map((step) => {
  assert.equal(step[field].length, 1, 'expected single-note steps');
  return step[field][0];
});
const words = (text) => text.split(' ');
const numbers = (text) => text.split(' ').map(Number);

/** Total distance the notes travel between consecutive block chords. */
function totalMovement(exercise) {
  let total = 0;
  for (let i = 1; i < exercise.steps.length; i++) {
    const a = exercise.steps[i - 1].notes;
    const b = exercise.steps[i].notes;
    assert.equal(a.length, b.length);
    total += b.reduce((sum, midi, k) => sum + Math.abs(midi - a[k]), 0);
  }
  return total;
}

// ---------------------------------------------------------------- module surface

describe('module surface', () => {
  test('exports exactly the contract names', () => {
    assert.deepEqual(Object.keys(exercisesModule).sort(), [
      'EXERCISE_SPEC_JSON_SCHEMA',
      'STARTER_EXERCISES',
      'buildExercise',
      'describeExercise',
      'sliceExercise',
      'validateExercise',
      'withTempo',
    ]);
  });

  test('the source is isomorphic and follows the project rules', () => {
    const source = readFileSync(new URL('../shared/exercises.js', import.meta.url), 'utf8');
    const testSource = readFileSync(new URL('./exercises.test.js', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(imports.sort(), ['./midi.js', './theory.js']);
    assert.doesNotMatch(source, /\b(document|window|process|globalThis|navigator|localStorage)\s*[.[]|\brequire\s*\(|node:|\bimport\s*\(/);
    assert.equal(source.includes(EM_DASH), false, 'no em dash in shared/exercises.js');
    assert.equal(testSource.includes(EM_DASH), false, 'no em dash in test/exercises.test.js');
    for (const [name, text] of [['shared/exercises.js', source], ['test/exercises.test.js', testSource]]) {
      assert.ok([...text].every((ch) => ch.charCodeAt(0) < 128), `${name} is plain ASCII`);
    }
  });
});

// ---------------------------------------------------------------- scales

describe('scale', () => {
  test('C major, right hand, one octave up and down: exact steps', () => {
    const exercise = build(scaleSpec());
    assert.equal(exercise.steps.length, 15);
    assert.deepEqual(single(exercise, 'notes'), [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60]);
    assert.deepEqual(single(exercise, 'names'), words('C4 D4 E4 F4 G4 A4 B4 C5 B4 A4 G4 F4 E4 D4 C4'));
    assert.deepEqual(single(exercise, 'fingers'), numbers('1 2 3 1 2 3 4 5 4 3 2 1 3 2 1'));
    assert.deepEqual(single(exercise, 'hands'), Array(15).fill('R'));
    assert.deepEqual(beats(exercise), Array(15).fill(1));
    assert.deepEqual(labels(exercise), Array(15).fill(undefined));
    assert.ok(exercise.steps.every((step) => !('label' in step)));
  });

  test('exercise fields come from the spec', () => {
    const exercise = build(scaleSpec());
    assert.equal(exercise.id, 'scale:C:major:right:1:up_down:4');
    assert.equal(exercise.title, 'Test title');
    assert.equal(exercise.goal, 'Test goal.');
    assert.equal(exercise.type, 'scale');
    assert.equal(exercise.hand, 'right');
    assert.equal(exercise.bpm, 72);
    assert.equal(exercise.mode, 'wait');
    assert.equal(exercise.beatsPerBar, 4);
    assert.deepEqual(exercise.key, { tonic: 'C', mode: 'major' });
    assert.deepEqual(exercise.spec, scaleSpec());
    assert.deepEqual(Object.keys(exercise), ['id', 'title', 'goal', 'type', 'hand', 'bpm', 'mode', 'beatsPerBar', 'steps', 'key', 'spec']);
  });

  test('left hand: default start octave 3 and the left-hand fingering', () => {
    const spec = scaleSpec({ hand: 'left' });
    delete spec.start_octave;
    const exercise = build(spec);
    assert.deepEqual(single(exercise, 'notes'), [48, 50, 52, 53, 55, 57, 59, 60, 59, 57, 55, 53, 52, 50, 48]);
    assert.deepEqual(single(exercise, 'fingers'), numbers('5 4 3 2 1 3 2 1 2 3 1 2 3 4 5'));
    assert.deepEqual(single(exercise, 'hands'), Array(15).fill('L'));
    assert.equal(exercise.spec.start_octave, 3);
    assert.equal(exercise.id, 'scale:C:major:left:1:up_down:3');
  });

  test('directions: up has 8 steps, down starts at the top, up_down does not repeat the top note', () => {
    const up = build(scaleSpec({ direction: 'up' }));
    assert.deepEqual(single(up, 'notes'), [60, 62, 64, 65, 67, 69, 71, 72]);
    assert.deepEqual(single(up, 'fingers'), numbers('1 2 3 1 2 3 4 5'));
    const down = build(scaleSpec({ direction: 'down' }));
    assert.deepEqual(single(down, 'notes'), [72, 71, 69, 67, 65, 64, 62, 60]);
    assert.deepEqual(single(down, 'fingers'), numbers('5 4 3 2 1 3 2 1'));
    const upDown = build(scaleSpec({ direction: 'up_down' }));
    assert.equal(upDown.steps.length, 15);
    assert.equal(upDown.steps.filter((step) => step.notes[0] === 72).length, 1);
  });

  test('two octaves', () => {
    const up = build(scaleSpec({ octaves: 2, direction: 'up' }));
    assert.equal(up.steps.length, 15);
    assert.deepEqual(single(up, 'fingers'), numbers('1 2 3 1 2 3 4 1 2 3 1 2 3 4 5'));
    assert.equal(up.steps[14].notes[0], 84);
    const upDown = build(scaleSpec({ octaves: 2 }));
    assert.equal(upDown.steps.length, 29);
    assert.equal(upDown.id, 'scale:C:major:right:2:up_down:4');
    const leftDown = build(scaleSpec({ hand: 'left', octaves: 2, direction: 'down', start_octave: 3 }));
    assert.deepEqual(single(leftDown, 'names'), words('C5 B4 A4 G4 F4 E4 D4 C4 B3 A3 G3 F3 E3 D3 C3'));
    assert.deepEqual(single(leftDown, 'fingers'), numbers('1 2 3 1 2 3 4 1 2 3 1 2 3 4 5'));
  });

  test("hand 'both': two notes per step, one octave apart, left hand below", () => {
    const exercise = build(scaleSpec({ hand: 'both' }));
    assert.equal(exercise.hand, 'both');
    assert.equal(exercise.steps.length, 15);
    for (const step of exercise.steps) {
      assert.equal(step.notes.length, 2);
      assert.equal(step.notes[1] - step.notes[0], 12);
      assert.deepEqual(step.hands, ['L', 'R']);
    }
    assert.deepEqual(exercise.steps[0], { notes: [48, 60], names: ['C3', 'C4'], fingers: [5, 1], hands: ['L', 'R'], beats: 1 });
    assert.deepEqual(exercise.steps[3], { notes: [53, 65], names: ['F3', 'F4'], fingers: [2, 1], hands: ['L', 'R'], beats: 1 });
    assert.deepEqual(exercise.steps[7], { notes: [60, 72], names: ['C4', 'C5'], fingers: [1, 5], hands: ['L', 'R'], beats: 1 });
    assert.deepEqual(exercise.steps.map((step) => step.fingers[0]), numbers('5 4 3 2 1 3 2 1 2 3 1 2 3 4 5'));
    assert.deepEqual(exercise.steps.map((step) => step.fingers[1]), numbers('1 2 3 1 2 3 4 5 4 3 2 1 3 2 1'));
    assert.equal(exercise.id, 'scale:C:major:both:1:up_down:4');
  });

  test('key-aware spelling: F major has B flat, G major has F sharp', () => {
    const f = build(scaleSpec({ root: 'F', direction: 'up' }));
    assert.deepEqual(single(f, 'names'), words('F4 G4 A4 Bb4 C5 D5 E5 F5'));
    assert.deepEqual(single(f, 'fingers'), numbers('1 2 3 4 1 2 3 4'));
    assert.deepEqual(f.key, { tonic: 'F', mode: 'major' });
    const g = build(scaleSpec({ root: 'G', direction: 'up' }));
    assert.deepEqual(single(g, 'names'), words('G4 A4 B4 C5 D5 E5 F#5 G5'));
    const fSharp = build(scaleSpec({ root: 'F#', direction: 'up' }));
    assert.deepEqual(single(fSharp, 'names'), words('F#4 G#4 A#4 B4 C#5 D#5 E#5 F#5'));
    const gFlat = build(scaleSpec({ root: 'Gb', direction: 'up' }));
    assert.deepEqual(single(gFlat, 'names'), words('Gb4 Ab4 Bb4 Cb5 Db5 Eb5 F5 Gb5'));
    assert.deepEqual(single(gFlat, 'notes'), single(fSharp, 'notes'));
    assert.notEqual(gFlat.id, fSharp.id);
  });

  test('melodic minor goes up melodic and comes down natural', () => {
    const exercise = build(scaleSpec({ root: 'A', scale: 'melodic_minor' }));
    assert.deepEqual(single(exercise, 'names'), words('A4 B4 C5 D5 E5 F#5 G#5 A5 G5 F5 E5 D5 C5 B4 A4'));
    assert.deepEqual(single(exercise, 'notes'), [69, 71, 72, 74, 76, 78, 80, 81, 79, 77, 76, 74, 72, 71, 69]);
    assert.deepEqual(single(exercise, 'fingers'), numbers('1 2 3 1 2 3 4 5 4 3 2 1 3 2 1'));
    assert.deepEqual(exercise.key, { tonic: 'A', mode: 'minor' });
  });

  test('harmonic minor', () => {
    const exercise = build(scaleSpec({ root: 'A', scale: 'harmonic_minor', direction: 'up' }));
    assert.deepEqual(single(exercise, 'names'), words('A4 B4 C5 D5 E5 F5 G#5 A5'));
    assert.deepEqual(exercise.key, { tonic: 'A', mode: 'minor' });
  });

  test('fingers are null where theory has no verified fingering, never invented', () => {
    for (const scale of ['major_pentatonic', 'minor_pentatonic', 'blues']) {
      const exercise = build(scaleSpec({ scale }));
      assert.ok(exercise.steps.every((step) => step.fingers.length === 1 && step.fingers[0] === null), scale);
    }
    const blackKeyMelodic = build(scaleSpec({ root: 'C#', scale: 'melodic_minor' }));
    assert.ok(single(blackKeyMelodic, 'fingers').every((finger) => finger === null));
    assert.deepEqual(single(blackKeyMelodic, 'names'), words('C#4 D#4 E4 F#4 G#4 A#4 B#4 C#5 B4 A4 G#4 F#4 E4 D#4 C#4'));
  });

  test('a fingering known for one hand only stays null for the other hand', () => {
    // theory.js has no verified left-hand chromatic fingering starting on E.
    const exercise = build(scaleSpec({ root: 'E', scale: 'chromatic', hand: 'both', direction: 'up' }));
    assert.equal(exercise.steps.length, 13);
    assert.ok(exercise.steps.every((step) => step.fingers[0] === null));
    assert.deepEqual(exercise.steps.map((step) => step.fingers[1]), numbers('1 2 3 1 3 1 3 1 2 3 1 3 1'));
  });

  test('pentatonic, blues and chromatic notes', () => {
    assert.deepEqual(single(build(scaleSpec({ scale: 'major_pentatonic', direction: 'up' })), 'names'), words('C4 D4 E4 G4 A4 C5'));
    assert.deepEqual(single(build(scaleSpec({ root: 'A', scale: 'minor_pentatonic', direction: 'up' })), 'names'), words('A4 C5 D5 E5 G5 A5'));
    assert.deepEqual(single(build(scaleSpec({ root: 'A', scale: 'blues', direction: 'up' })), 'names'), words('A4 C5 D5 Eb5 E5 G5 A5'));
    const chromatic = build(scaleSpec({ scale: 'chromatic', direction: 'up' }));
    assert.deepEqual(single(chromatic, 'notes'), [60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72]);
    assert.deepEqual(single(chromatic, 'fingers'), numbers('1 3 1 3 1 2 3 1 3 1 3 1 2'));
    assert.equal(build(scaleSpec({ scale: 'chromatic' })).steps.length, 25);
  });

  test('key: major or minor parent, null for chromatic', () => {
    const keyOf = (scale) => build(scaleSpec({ root: 'D', scale })).key;
    assert.deepEqual(keyOf('major'), { tonic: 'D', mode: 'major' });
    assert.deepEqual(keyOf('major_pentatonic'), { tonic: 'D', mode: 'major' });
    assert.deepEqual(keyOf('natural_minor'), { tonic: 'D', mode: 'minor' });
    assert.deepEqual(keyOf('harmonic_minor'), { tonic: 'D', mode: 'minor' });
    assert.deepEqual(keyOf('melodic_minor'), { tonic: 'D', mode: 'minor' });
    assert.deepEqual(keyOf('minor_pentatonic'), { tonic: 'D', mode: 'minor' });
    assert.deepEqual(keyOf('blues'), { tonic: 'D', mode: 'minor' });
    assert.equal(keyOf('chromatic'), null);
  });

  test('every scale name of the contract exists in theory.js and builds', () => {
    const scaleField = EXERCISE_SPEC_JSON_SCHEMA.anyOf[0].properties.scale;
    assert.deepEqual([...scaleField.enum].sort(), Object.keys(SCALE_INTERVALS).sort());
    for (const scale of scaleField.enum) build(scaleSpec({ scale }));
  });

  test('note_beats sets the step length and is part of the id only when it is not 1', () => {
    const exercise = build(scaleSpec({ note_beats: 0.5 }));
    assert.deepEqual(beats(exercise), Array(15).fill(0.5));
    assert.equal(exercise.id, 'scale:C:major:right:1:up_down:4:b0.5');
    assert.equal(build(scaleSpec({ note_beats: 8 })).steps[0].beats, 8);
    assert.equal(build(scaleSpec({ note_beats: 0.25 })).steps[0].beats, 0.25);
  });

  test('defaults for a hand-written spec', () => {
    const exercise = build({ type: 'scale', hand: 'right', bpm: 60, mode: 'wait', root: 'C', scale: 'major' });
    assert.equal(exercise.steps.length, 15, 'one octave up and down');
    assert.equal(exercise.steps[0].notes[0], 60, 'right hand starts in octave 4');
    assert.equal(exercise.steps[0].beats, 1);
    assert.equal(exercise.title, 'C major scale, right hand');
    assert.equal(exercise.goal, '');
    assert.deepEqual(exercise.spec, {
      type: 'scale', title: 'C major scale, right hand', goal: '', hand: 'right', bpm: 60, mode: 'wait',
      root: 'C', scale: 'major', octaves: 1, direction: 'up_down', start_octave: 4, note_beats: 1,
    });
    const nulls = build({ type: 'scale', title: null, goal: null, hand: 'both', bpm: 60, mode: 'wait', root: 'C', scale: 'major',
      octaves: null, direction: null, start_octave: null, note_beats: null });
    assert.equal(nulls.steps[0].notes[1], 60, 'both hands: the right hand starts in octave 4');
    assert.equal(nulls.title, 'C major scale, hands together');
  });

  test('root spelling and enum values are normalized, not rejected', () => {
    const exercise = build(scaleSpec({ root: 'bb', scale: ' Natural_Minor ', direction: 'UP', mode: 'Tempo', hand: 'Right' }));
    assert.equal(exercise.spec.root, 'Bb');
    assert.equal(exercise.spec.scale, 'natural_minor');
    assert.equal(exercise.spec.direction, 'up');
    assert.equal(exercise.mode, 'tempo');
    assert.equal(exercise.hand, 'right');
    assert.deepEqual(single(exercise, 'names'), words('Bb4 C5 Db5 Eb5 F5 Gb5 Ab5 Bb5'));
    assert.equal(build(scaleSpec({ root: `E${FLAT}` })).spec.root, 'Eb');
    assert.equal(build(scaleSpec({ root: `F${SHARP}` })).spec.root, 'F#');
    assert.equal(build({ ...scaleSpec(), type: ' SCALE ' }).type, 'scale');
  });

  test('theoretical roots are spelled from the root as written', () => {
    const exercise = build(scaleSpec({ root: 'E#', direction: 'up' }));
    assert.deepEqual(single(exercise, 'names'), words('E#4 F##4 G##4 A#4 B#4 C##5 D##5 E#5'));
    assert.deepEqual(single(exercise, 'notes'), [65, 67, 69, 70, 72, 74, 76, 77]);
  });
});

// ---------------------------------------------------------------- arpeggios

describe('arpeggio', () => {
  test('C major, right hand, one octave up and down: exact steps', () => {
    const exercise = build(arpeggioSpec());
    assert.deepEqual(single(exercise, 'notes'), [60, 64, 67, 72, 67, 64, 60]);
    assert.deepEqual(single(exercise, 'names'), words('C4 E4 G4 C5 G4 E4 C4'));
    assert.deepEqual(single(exercise, 'fingers'), numbers('1 2 3 5 3 2 1'));
    assert.deepEqual(single(exercise, 'hands'), Array(7).fill('R'));
    assert.deepEqual(beats(exercise), Array(7).fill(1));
    assert.equal(exercise.id, 'arpeggio:C:major:right:1:up_down:4');
    assert.equal(exercise.type, 'arpeggio');
    assert.deepEqual(exercise.key, { tonic: 'C', mode: 'major' });
    assert.deepEqual(exercise.spec, arpeggioSpec());
  });

  test('left hand uses 5 4 2 1 for C major and defaults to octave 3', () => {
    const spec = arpeggioSpec({ hand: 'left', direction: 'up' });
    delete spec.start_octave;
    const exercise = build(spec);
    assert.deepEqual(single(exercise, 'names'), words('C3 E3 G3 C4'));
    assert.deepEqual(single(exercise, 'fingers'), numbers('5 4 2 1'));
    assert.deepEqual(single(exercise, 'hands'), Array(4).fill('L'));
  });

  test('two octaves and minor quality', () => {
    const exercise = build(arpeggioSpec({ root: 'A', quality: 'minor', octaves: 2, direction: 'up' }));
    assert.deepEqual(single(exercise, 'names'), words('A4 C5 E5 A5 C6 E6 A6'));
    assert.deepEqual(single(exercise, 'fingers'), numbers('1 2 3 1 2 3 5'));
    assert.deepEqual(exercise.key, { tonic: 'A', mode: 'minor' });
    assert.equal(build(arpeggioSpec({ octaves: 2 })).steps.length, 13);
    assert.equal(build(arpeggioSpec({ direction: 'down' })).steps[0].notes[0], 72);
  });

  test('seventh, diminished and augmented arpeggios have notes but null fingers', () => {
    const dominant = build(arpeggioSpec({ quality: 'dominant7', direction: 'up' }));
    assert.deepEqual(single(dominant, 'names'), words('C4 E4 G4 Bb4 C5'));
    assert.ok(single(dominant, 'fingers').every((finger) => finger === null));
    assert.deepEqual(single(build(arpeggioSpec({ quality: 'major7', direction: 'up' })), 'names'), words('C4 E4 G4 B4 C5'));
    assert.deepEqual(single(build(arpeggioSpec({ quality: 'minor7', direction: 'up' })), 'names'), words('C4 Eb4 G4 Bb4 C5'));
    assert.deepEqual(single(build(arpeggioSpec({ quality: 'diminished', direction: 'up' })), 'names'), words('C4 Eb4 Gb4 C5'));
    assert.deepEqual(single(build(arpeggioSpec({ quality: 'augmented', direction: 'up' })), 'names'), words('C4 E4 G#4 C5'));
    for (const quality of ['diminished', 'augmented', 'major7', 'minor7']) {
      assert.ok(single(build(arpeggioSpec({ quality })), 'fingers').every((finger) => finger === null), quality);
    }
  });

  test("hand 'both': parallel motion one octave apart with each hand's fingering", () => {
    const exercise = build(arpeggioSpec({ root: 'D', hand: 'both', direction: 'up' }));
    assert.deepEqual(names(exercise), [['D3', 'D4'], ['F#3', 'F#4'], ['A3', 'A4'], ['D4', 'D5']]);
    assert.deepEqual(fingers(exercise), [[5, 1], [3, 2], [2, 3], [1, 5]]);
    assert.deepEqual(hands(exercise), Array(4).fill(['L', 'R']));
    assert.ok(exercise.steps.every((step) => step.notes[1] - step.notes[0] === 12));
  });

  test('key follows the quality', () => {
    const keyOf = (quality) => build(arpeggioSpec({ root: 'E', quality })).key;
    for (const quality of ['major', 'augmented', 'dominant7', 'major7']) assert.deepEqual(keyOf(quality), { tonic: 'E', mode: 'major' });
    for (const quality of ['minor', 'diminished', 'minor7']) assert.deepEqual(keyOf(quality), { tonic: 'E', mode: 'minor' });
  });
});

// ---------------------------------------------------------------- five-finger patterns

describe('five_finger', () => {
  test('up_down: degrees 1 2 3 4 5 4 3 2 1, right-hand finger = degree', () => {
    const exercise = build(fiveFingerSpec());
    assert.deepEqual(single(exercise, 'notes'), [60, 62, 64, 65, 67, 65, 64, 62, 60]);
    assert.deepEqual(single(exercise, 'names'), words('C4 D4 E4 F4 G4 F4 E4 D4 C4'));
    assert.deepEqual(single(exercise, 'fingers'), numbers('1 2 3 4 5 4 3 2 1'));
    assert.deepEqual(single(exercise, 'hands'), Array(9).fill('R'));
    assert.deepEqual(beats(exercise), Array(9).fill(1));
    assert.equal(exercise.id, 'five_finger:C:major:right:up_down:4');
    assert.equal(exercise.type, 'five_finger');
    assert.deepEqual(exercise.key, { tonic: 'C', mode: 'major' });
    assert.deepEqual(exercise.spec, fiveFingerSpec());
  });

  test('thirds: degrees 1 3 2 4 3 5 4 2 1', () => {
    const exercise = build(fiveFingerSpec({ pattern: 'thirds' }));
    assert.deepEqual(single(exercise, 'names'), words('C4 E4 D4 F4 E4 G4 F4 D4 C4'));
    assert.deepEqual(single(exercise, 'fingers'), numbers('1 3 2 4 3 5 4 2 1'));
    assert.equal(exercise.id, 'five_finger:C:major:right:thirds:4');
  });

  test('triad: degrees 1 3 5 3 1', () => {
    const exercise = build(fiveFingerSpec({ pattern: 'triad' }));
    assert.deepEqual(single(exercise, 'names'), words('C4 E4 G4 E4 C4'));
    assert.deepEqual(single(exercise, 'fingers'), numbers('1 3 5 3 1'));
  });

  test('left hand: finger = 6 - degree, default octave 3', () => {
    const spec = fiveFingerSpec({ hand: 'left' });
    delete spec.start_octave;
    const exercise = build(spec);
    assert.deepEqual(single(exercise, 'names'), words('C3 D3 E3 F3 G3 F3 E3 D3 C3'));
    assert.deepEqual(single(exercise, 'fingers'), numbers('5 4 3 2 1 2 3 4 5'));
    assert.deepEqual(single(exercise, 'hands'), Array(9).fill('L'));
    const thirds = build(fiveFingerSpec({ hand: 'left', root: 'Bb', pattern: 'thirds', start_octave: 3 }));
    assert.deepEqual(single(thirds, 'names'), words('Bb3 D4 C4 Eb4 D4 F4 Eb4 C4 Bb3'));
    assert.deepEqual(single(thirds, 'fingers'), numbers('5 3 4 2 3 1 2 4 5'));
  });

  test('minor quality uses the first five notes of the minor scale', () => {
    const exercise = build(fiveFingerSpec({ quality: 'minor' }));
    assert.deepEqual(single(exercise, 'names'), words('C4 D4 Eb4 F4 G4 F4 Eb4 D4 C4'));
    assert.deepEqual(exercise.key, { tonic: 'C', mode: 'minor' });
    assert.deepEqual(single(build(fiveFingerSpec({ root: 'D' })), 'names'), words('D4 E4 F#4 G4 A4 G4 F#4 E4 D4'));
  });

  test("hand 'both': two notes per step one octave apart", () => {
    const exercise = build(fiveFingerSpec({ hand: 'both', quality: 'minor', pattern: 'triad' }));
    assert.deepEqual(names(exercise), [['C3', 'C4'], ['Eb3', 'Eb4'], ['G3', 'G4'], ['Eb3', 'Eb4'], ['C3', 'C4']]);
    assert.deepEqual(fingers(exercise), [[5, 1], [3, 3], [1, 5], [3, 3], [5, 1]]);
    assert.deepEqual(hands(exercise), Array(5).fill(['L', 'R']));
    assert.deepEqual(midis(exercise), [[48, 60], [51, 63], [55, 67], [51, 63], [48, 60]]);
  });
});

// ---------------------------------------------------------------- chords

describe('chords', () => {
  test('block chords in root position, right hand: exact steps', () => {
    const exercise = build(chordsSpec());
    assert.deepEqual(exercise.steps, [
      { notes: [60, 64, 67], names: ['C4', 'E4', 'G4'], fingers: [1, 3, 5], hands: ['R', 'R', 'R'], beats: 4, label: 'C' },
      { notes: [65, 69, 72], names: ['F4', 'A4', 'C5'], fingers: [1, 3, 5], hands: ['R', 'R', 'R'], beats: 4, label: 'F' },
      { notes: [67, 71, 74], names: ['G4', 'B4', 'D5'], fingers: [1, 3, 5], hands: ['R', 'R', 'R'], beats: 4, label: 'G' },
      { notes: [60, 64, 67], names: ['C4', 'E4', 'G4'], fingers: [1, 3, 5], hands: ['R', 'R', 'R'], beats: 4, label: 'C' },
    ]);
    assert.equal(exercise.id, 'chords:C-F-G-C:block:root:right:4');
    assert.equal(exercise.type, 'chords');
    assert.equal(exercise.hand, 'right');
    assert.equal(exercise.beatsPerBar, 4);
    assert.deepEqual(exercise.key, { tonic: 'C', mode: 'major' });
    assert.deepEqual(exercise.spec, chordsSpec());
  });

  test('left hand: default octave 3 and left-hand fingering', () => {
    const spec = chordsSpec({ hand: 'left', chords: ['C', 'Am'] });
    delete spec.start_octave;
    const exercise = build(spec);
    assert.deepEqual(exercise.steps, [
      { notes: [48, 52, 55], names: ['C3', 'E3', 'G3'], fingers: [5, 3, 1], hands: ['L', 'L', 'L'], beats: 4, label: 'C' },
      { notes: [57, 60, 64], names: ['A3', 'C4', 'E4'], fingers: [5, 3, 1], hands: ['L', 'L', 'L'], beats: 4, label: 'Am' },
    ]);
  });

  test('broken triads: low-mid-high-mid, four steps per chord of beats_per_chord / 4', () => {
    const exercise = build(chordsSpec({ chords: ['C', 'F'], style: 'broken' }));
    assert.equal(exercise.steps.length, 8);
    assert.deepEqual(single(exercise, 'names'), words('C4 E4 G4 E4 F4 A4 C5 A4'));
    assert.deepEqual(single(exercise, 'fingers'), numbers('1 3 5 3 1 3 5 3'));
    assert.deepEqual(beats(exercise), Array(8).fill(1));
    assert.deepEqual(labels(exercise), ['C', undefined, undefined, undefined, 'F', undefined, undefined, undefined]);
    assert.equal(exercise.id, 'chords:C-F:broken:root:right:4');
    const quick = build(chordsSpec({ chords: ['C'], style: 'broken', beats_per_chord: 2 }));
    assert.deepEqual(beats(quick), [0.5, 0.5, 0.5, 0.5]);
    assert.equal(quick.id, 'chords:C:broken:root:right:4:b2');
  });

  test('broken four-note chords: low-2nd-3rd-top; two-note chords alternate', () => {
    const exercise = build(chordsSpec({ chords: ['G7', 'C5'], style: 'broken' }));
    assert.deepEqual(single(exercise, 'names'), words('G4 B4 D5 F5 C4 G4 C4 G4'));
    assert.deepEqual(single(exercise, 'fingers'), [1, 2, 3, 5, null, null, null, null]);
    assert.deepEqual(labels(exercise), ['G7', undefined, undefined, undefined, 'C5', undefined, undefined, undefined]);
  });

  test('block versus broken: same notes, different steps', () => {
    const block = build(chordsSpec({ chords: ['Am', 'Dm'] }));
    const broken = build(chordsSpec({ chords: ['Am', 'Dm'], style: 'broken' }));
    assert.equal(block.steps.length, 2);
    assert.equal(broken.steps.length, 8);
    assert.ok(block.steps.every((step) => step.notes.length === 3 && step.beats === 4));
    assert.ok(broken.steps.every((step) => step.notes.length === 1 && step.beats === 1));
    assert.deepEqual([...new Set(broken.steps.slice(0, 4).map((step) => step.notes[0]))].sort(), block.steps[0].notes);
    assert.notEqual(block.id, broken.id);
  });

  test("voicing 'smooth' picks the nearest inversion: C Am F G", () => {
    const exercise = build(chordsSpec({ chords: ['C', 'Am', 'F', 'G'], voicing: 'smooth' }));
    assert.deepEqual(names(exercise), [['C4', 'E4', 'G4'], ['C4', 'E4', 'A4'], ['C4', 'F4', 'A4'], ['B3', 'D4', 'G4']]);
    assert.deepEqual(midis(exercise), [[60, 64, 67], [60, 64, 69], [60, 65, 69], [59, 62, 67]]);
    assert.deepEqual(fingers(exercise), [[1, 3, 5], [1, 2, 5], [1, 3, 5], [1, 2, 5]]);
    assert.deepEqual(labels(exercise), ['C', 'Am', 'F', 'G']);
    assert.equal(exercise.id, 'chords:C-Am-F-G:block:smooth:right:4');
  });

  test('smooth voicing moves less than root voicing', () => {
    for (const chords of [['C', 'Am', 'F', 'G'], ['C', 'F', 'G', 'C'], ['Am', 'Dm', 'E', 'Am'], ['D', 'G', 'A', 'Bm', 'G', 'D']]) {
      const root = build(chordsSpec({ chords, voicing: 'root' }));
      const smooth = build(chordsSpec({ chords, voicing: 'smooth' }));
      assert.ok(totalMovement(smooth) < totalMovement(root), `${chords.join(' ')}: ${totalMovement(smooth)} < ${totalMovement(root)}`);
      // Same pitch classes in every chord, whatever the inversion.
      smooth.steps.forEach((step, i) => {
        assert.deepEqual([...new Set(step.notes.map((n) => n % 12))].sort(), [...new Set(root.steps[i].notes.map((n) => n % 12))].sort());
      });
    }
    // Two voicings of E move equally far from D (6 semitones): the one nearer the first chord wins.
    assert.deepEqual(names(build(chordsSpec({ chords: ['C', 'D', 'E'], voicing: 'smooth' }))),
      [['C4', 'E4', 'G4'], ['D4', 'F#4', 'A4'], ['B3', 'E4', 'G#4']]);
    assert.equal(totalMovement(build(chordsSpec({ chords: ['C', 'Am', 'F', 'G'], voicing: 'smooth' }))), 9);
    assert.equal(totalMovement(build(chordsSpec({ chords: ['C', 'Am', 'F', 'G'], voicing: 'root' }))), 43);
  });

  test('smooth voicing starts in root position and never drifts away from the start octave', () => {
    const chords = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'A', 'B', 'C', 'D'];
    const exercise = build(chordsSpec({ chords, voicing: 'smooth' }));
    assert.equal(exercise.steps.length, 16);
    assert.deepEqual(exercise.steps[0].notes, [60, 64, 67]);
    for (const step of exercise.steps) {
      assert.ok(Math.abs(step.notes[0] - 60) <= 7, `lowest note ${step.names[0]} stays near C4`);
      assert.ok(step.notes[2] - step.notes[0] <= 12);
    }
    // A chromatic climb: the nearest voicing is always one semitone up, so without a limit the
    // chords would walk away from the start octave (root voicing ends 15 semitones higher).
    const climb = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B', 'C', 'Db', 'D', 'Eb'];
    const climbing = build(chordsSpec({ chords: climb, voicing: 'smooth' }));
    for (const step of climbing.steps) {
      assert.ok(Math.abs(step.notes[0] - 60) <= 7, `${step.label}: lowest note ${step.names[0]} stays within a fifth of C4`);
    }
    assert.deepEqual(names(climbing).slice(0, 9), [
      ['C4', 'E4', 'G4'], ['Db4', 'F4', 'Ab4'], ['D4', 'F#4', 'A4'], ['Eb4', 'G4', 'Bb4'], ['E4', 'G#4', 'B4'], ['F4', 'A4', 'C5'],
      ['Gb4', 'Bb4', 'Db5'], ['G4', 'B4', 'D5'], ['Eb4', 'Ab4', 'C5'],
    ]);
    assert.ok(Math.max(...build(chordsSpec({ chords: climb })).steps.map((step) => step.notes[0])) - 60 > 7);
    const left = build(chordsSpec({ hand: 'left', start_octave: 3, chords: ['Am', 'Dm', 'E', 'Am'], voicing: 'smooth' }));
    assert.deepEqual(names(left), [['A3', 'C4', 'E4'], ['A3', 'D4', 'F4'], ['G#3', 'B3', 'E4'], ['A3', 'C4', 'E4']]);
    assert.deepEqual(fingers(left), [[5, 3, 1], [5, 2, 1], [5, 3, 1], [5, 3, 1]]);
  });

  test('inverted seventh chords and non-triad shapes get null fingers', () => {
    const exercise = build(chordsSpec({ chords: ['C', 'G7', 'Am7'], voicing: 'smooth' }));
    assert.deepEqual(names(exercise), [['C4', 'E4', 'G4'], ['B3', 'D4', 'F4', 'G4'], ['A3', 'C4', 'E4', 'G4']]);
    assert.deepEqual(fingers(exercise), [[1, 3, 5], [null, null, null, null], [1, 2, 3, 5]]);
    const shapes = build(chordsSpec({ chords: ['Dsus4', 'C5', 'G7'] }));
    assert.deepEqual(names(shapes), [['D4', 'G4', 'A4'], ['C4', 'G4'], ['G4', 'B4', 'D5', 'F5']]);
    assert.deepEqual(fingers(shapes), [[null, null, null], [null, null], [1, 2, 3, 5]]);
  });

  test("hand 'both': left hand plays the root one octave below, finger null", () => {
    const exercise = build(chordsSpec({ hand: 'both', chords: ['C', 'G7'] }));
    assert.deepEqual(exercise.steps, [
      { notes: [48, 60, 64, 67], names: ['C3', 'C4', 'E4', 'G4'], fingers: [null, 1, 3, 5], hands: ['L', 'R', 'R', 'R'], beats: 4, label: 'C' },
      { notes: [55, 67, 71, 74, 77], names: ['G3', 'G4', 'B4', 'D5', 'F5'], fingers: [null, 1, 2, 3, 5], hands: ['L', 'R', 'R', 'R', 'R'], beats: 4, label: 'G7' },
    ]);
    assert.equal(exercise.hand, 'both');
    assert.equal(exercise.id, 'chords:C-G7:block:root:both:4');
  });

  test("hand 'both', broken: the bass sounds with the first note of each chord", () => {
    const exercise = build(chordsSpec({ hand: 'both', chords: ['C', 'F/A'], style: 'broken' }));
    assert.deepEqual(names(exercise), [['C3', 'C4'], ['E4'], ['G4'], ['E4'], ['A3', 'F4'], ['A4'], ['C5'], ['A4']]);
    assert.deepEqual(hands(exercise), [['L', 'R'], ['R'], ['R'], ['R'], ['L', 'R'], ['R'], ['R'], ['R']]);
    assert.deepEqual(fingers(exercise), [[null, 1], [3], [5], [3], [null, 1], [3], [5], [3]]);
    assert.deepEqual(labels(exercise), ['C', undefined, undefined, undefined, 'F/A', undefined, undefined, undefined]);
  });

  test("hand 'both': the bass is always below the right-hand chord, also with smooth voicing", () => {
    const progressions = [['B', 'E', 'F#', 'B'], ['C', 'F/A', 'G7', 'Am7', 'C'], ['A', 'D', 'E', 'A'], ['G', 'C', 'D', 'Em', 'C', 'G']];
    for (const chords of progressions) {
      for (const voicing of ['root', 'smooth']) {
        const exercise = build(chordsSpec({ hand: 'both', chords, voicing }));
        for (const step of exercise.steps) {
          assert.equal(step.hands.filter((hand) => hand === 'L').length, 1);
          assert.equal(step.hands[0], 'L');
          assert.equal(step.fingers[0], null);
          assert.ok(step.notes[0] < step.notes[1], `${step.names.join(' ')}: bass below the chord`);
        }
      }
    }
    const slash = build(chordsSpec({ hand: 'both', chords: ['C', 'F/A', 'G7', 'Am7', 'C'], voicing: 'smooth' }));
    assert.deepEqual(names(slash), [
      ['C3', 'C4', 'E4', 'G4'], ['A3', 'C4', 'F4', 'A4'], ['G3', 'B3', 'D4', 'F4', 'G4'], ['A2', 'A3', 'C4', 'E4', 'G4'], ['C3', 'C4', 'E4', 'G4'],
    ]);
  });

  test('slash chords in one hand: a chord-tone bass picks the inversion', () => {
    const exercise = build(chordsSpec({ chords: ['C/E', 'C/G'] }));
    assert.deepEqual(names(exercise), [['E4', 'G4', 'C5'], ['G4', 'C5', 'E5']]);
    assert.deepEqual(fingers(exercise), [[1, 2, 5], [1, 3, 5]]);
    assert.deepEqual(labels(exercise), ['C/E', 'C/G']);
  });

  test('chord symbols are normalized in labels, spec and id', () => {
    const exercise = build(chordsSpec({ chords: ['Cmin7', 'FM7', 'Bb'] }));
    assert.deepEqual(labels(exercise), ['Cm7', 'Fmaj7', 'Bb']);
    assert.deepEqual(exercise.spec.chords, ['Cm7', 'Fmaj7', 'Bb']);
    assert.equal(exercise.id, 'chords:Cm7-Fmaj7-Bb:block:root:right:4');
    assert.deepEqual(exercise.steps[0].names, ['C4', 'Eb4', 'G4', 'Bb4']);
    assert.deepEqual(exercise.steps[2].names, ['Bb4', 'D5', 'F5']);
  });

  test('key: the first chord when it is major or minor, else null', () => {
    assert.deepEqual(build(chordsSpec({ chords: ['Am', 'G'] })).key, { tonic: 'A', mode: 'minor' });
    assert.deepEqual(build(chordsSpec({ chords: ['Bb', 'F'] })).key, { tonic: 'Bb', mode: 'major' });
    assert.deepEqual(build(chordsSpec({ chords: ['C/E', 'F'] })).key, { tonic: 'C', mode: 'major' });
    assert.equal(build(chordsSpec({ chords: ['G7', 'C'] })).key, null);
    assert.equal(build(chordsSpec({ chords: ['Dsus4', 'D'] })).key, null);
  });

  test('1 and 16 chords build; a default title names the chords', () => {
    assert.equal(build(chordsSpec({ chords: ['C'] })).steps.length, 1);
    const sixteen = build(chordsSpec({ chords: Array(16).fill('C'), style: 'broken' }));
    assert.equal(sixteen.steps.length, 64);
    const untitled = chordsSpec({ chords: ['C', 'G7'] });
    delete untitled.title;
    assert.equal(build(untitled).title, 'Chords C G7, right hand');
  });

  test('chord errors', () => {
    rejects(chordsSpec({ chords: ['C', 'H7'] }), /chords\[1\]: "H7" is not a chord symbol.*"Am"/);
    rejects(chordsSpec({ chords: ['am'] }), /chords\[0\]: "am".*upper case/);
    rejects(chordsSpec({ chords: ['C', 42, null] }), /chords\[1\]: 42/, /chords\[2\]: null/);
    rejects(chordsSpec({ chords: [] }), /chords: has 0 chords, use 1 to 16/);
    rejects(chordsSpec({ chords: Array(17).fill('C') }), /chords: has 17 chords, use 1 to 16/);
    rejects(chordsSpec({ chords: 'C F G' }), /chords: "C F G" is not valid, use a list/);
    rejects(chordsSpec({ chords: undefined }), /chords: required/);
    rejects(chordsSpec({ style: 'arpeggiated' }), /style: "arpeggiated" is not valid, use one of "block", "broken"/);
    rejects(chordsSpec({ voicing: 'open' }), /voicing: "open" is not valid, use one of "root", "smooth"/);
    rejects(chordsSpec({ beats_per_chord: 9 }), /beats_per_chord: 9 is not valid.*0\.25 to 8/);
    rejects(chordsSpec({ beats_per_chord: 0 }), /beats_per_chord: 0 is not valid/);
    rejects(chordsSpec({ style: 'broken', beats_per_chord: 0.5 }), /beats_per_chord: 0\.5 is too short for style "broken".*1 to 8/);
    rejects(chordsSpec({ chords: ['C9'], style: 'broken' }), /chords\[0\]: "C9" has 5 notes.*"block"/);
    rejects(chordsSpec({ chords: ['Cbdim7'] }), /chords\[0\]: "Cbdim7" cannot be written/);
  });

  test('a chord one hand cannot reach is rejected with a way out', () => {
    // F/G in one hand is G3 F4 A4 C5: 17 semitones.
    rejects(chordsSpec({ chords: ['C', 'F/G'] }), /step 2 \(F\/G\): the right hand would have to reach 17 semitones \(G3 F4 A4 C5\), the limit is 14.*hand "both"/);
    const both = build(chordsSpec({ hand: 'both', chords: ['C', 'F/G'] }));
    assert.deepEqual(both.steps[1].names, ['G3', 'F4', 'A4', 'C5']);
    assert.deepEqual(both.steps[1].hands, ['L', 'R', 'R', 'R']);
    // A ninth chord is exactly 14 semitones and 5 notes: allowed.
    assert.deepEqual(build(chordsSpec({ chords: ['C9'] })).steps[0].names, ['C4', 'E4', 'G4', 'Bb4', 'D5']);
  });
});

// ---------------------------------------------------------------- custom

describe('custom', () => {
  test('both hands, chords and rests: exact steps', () => {
    const exercise = build(customSpec([
      customStep(['C4', 'E4', 'G4'], ['C3'], 2, [1, 3, 5], [5]),
      customStep([], [], 1),
      customStep(['D4'], [], 0.5, [2]),
      customStep([], ['G2', 'D3'], 1.5, null, [5, 1]),
    ], { beats_per_bar: 3 }));
    assert.deepEqual(exercise.steps, [
      { notes: [48, 60, 64, 67], names: ['C3', 'C4', 'E4', 'G4'], fingers: [5, 1, 3, 5], hands: ['L', 'R', 'R', 'R'], beats: 2 },
      { notes: [], names: [], fingers: [], hands: [], beats: 1 },
      { notes: [62], names: ['D4'], fingers: [2], hands: ['R'], beats: 0.5 },
      { notes: [43, 50], names: ['G2', 'D3'], fingers: [5, 1], hands: ['L', 'L'], beats: 1.5 },
    ]);
    assert.equal(exercise.type, 'custom');
    assert.equal(exercise.hand, 'both');
    assert.equal(exercise.beatsPerBar, 3);
    assert.equal(exercise.key, null);
    assert.match(exercise.id, /^custom:[0-9a-z]+$/);
    assert.equal(exercise.title, 'Test title');
    assert.equal(exercise.bpm, 72);
  });

  test('the hand is derived from the steps, whatever the spec says', () => {
    assert.equal(build(customSpec([customStep(['C4'])], { hand: 'left' })).hand, 'right');
    assert.equal(build(customSpec([customStep([], ['C3'])], { hand: 'right' })).hand, 'left');
    assert.equal(build(customSpec([customStep(['C4']), customStep([], ['C3'])], { hand: 'right' })).hand, 'both');
    assert.equal(build(customSpec([customStep(['C4'], ['C3'])], { hand: 'left' })).hand, 'both');
    const noHand = customSpec([customStep(['C4'])]);
    delete noHand.hand;
    const exercise = build(noHand);
    assert.equal(exercise.hand, 'right');
    assert.equal(exercise.spec.hand, 'right');
    assert.equal(build(customSpec([customStep(['C4'])], { hand: 'left' })).spec.hand, 'right');
  });

  test('note names are normalized to ASCII sharps and flats and keep their spelling', () => {
    const exercise = build(customSpec([
      customStep(['c4']), customStep([`E${FLAT}4`]), customStep([`F${SHARP}4`]), customStep(['Fx4']), customStep(['Bbb4']), customStep([' G4 ']),
      customStep(['B#3']), customStep(['Cb5']),
    ]));
    assert.deepEqual(single(exercise, 'names'), ['C4', 'Eb4', 'F#4', 'F##4', 'Bbb4', 'G4', 'B#3', 'Cb5']);
    assert.deepEqual(single(exercise, 'notes'), [60, 63, 66, 67, 69, 67, 60, 71]);
    assert.deepEqual(exercise.spec.steps[1].right, ['Eb4']);
  });

  test('fingers: null gives nulls, a list may leave single fingers out', () => {
    const exercise = build(customSpec([
      customStep(['C4', 'E4'], ['C3', 'G3']),
      customStep(['C4', 'E4', 'G4'], [], 1, [1, null, 5]),
      customStep([], ['C3'], 1, [], [null]),
    ]));
    assert.deepEqual(fingers(exercise), [[null, null, null, null], [1, null, 5], [null]]);
    assert.deepEqual(exercise.spec.steps[0], { right: ['C4', 'E4'], left: ['C3', 'G3'], beats: 1, right_fingers: null, left_fingers: null });
    assert.deepEqual(exercise.spec.steps[1].right_fingers, [1, null, 5]);
    assert.equal(exercise.spec.steps[2].left_fingers, null);
  });

  test('missing right, left and finger fields mean empty and unknown', () => {
    const exercise = build({ type: 'custom', bpm: 80, mode: 'tempo', steps: [{ right: ['E4'], beats: 1 }, { beats: 2 }, { left: ['C3'], beats: 1 }] });
    assert.deepEqual(midis(exercise), [[64], [], [48]]);
    assert.equal(exercise.hand, 'both');
    assert.equal(exercise.beatsPerBar, 4);
    assert.equal(exercise.title, 'Custom exercise');
    assert.equal(exercise.goal, '');
  });

  test('notes without fingers may be listed in any order and are sorted', () => {
    const exercise = build(customSpec([customStep(['G4', 'C4', 'E4'], ['G3', 'C3'])]));
    assert.deepEqual(exercise.steps[0].names, ['C3', 'G3', 'C4', 'E4', 'G4']);
    assert.deepEqual(exercise.steps[0].hands, ['L', 'L', 'R', 'R', 'R']);
  });

  test('with fingers the notes must be low to high, so fingers are never matched by guesswork', () => {
    rejects(customSpec([customStep(['E4', 'C4'], [], 1, [3, 1])]), /step 1: right: list the notes from low to high \(C4 E4\).*right_fingers/);
    rejects(customSpec([customStep([], ['G3', 'C3'], 1, null, [1, 5])]), /step 1: left: list the notes from low to high \(C3 G3\).*left_fingers/);
  });

  test('fingers that cannot be played together are rejected', () => {
    rejects(customSpec([customStep(['C4', 'E4', 'G4'], [], 1, [5, 3, 1])]), /step 1: right_fingers: \[5,3,1\] cannot be played together on C4 E4 G4.*rise.*null/);
    rejects(customSpec([customStep(['C4', 'E4'], [], 1, [2, 2])]), /right_fingers: \[2,2\] cannot be played together/);
    rejects(customSpec([customStep([], ['C3', 'E3', 'G3'], 1, null, [1, 3, 5])]), /step 1: left_fingers: \[1,3,5\] cannot be played together on C3 E3 G3.*fall/);
    build(customSpec([customStep(['C4', 'E4', 'G4'], ['C3', 'E3', 'G3'], 1, [1, 2, 5], [5, 3, 1])]));
    build(customSpec([customStep(['C4', 'E4', 'G4'], [], 1, [1, null, 3])]));
  });

  test('hands may cross: the step stays sorted by pitch', () => {
    const exercise = build(customSpec([customStep(['C4'], ['E4'], 1, [2], [2])]));
    assert.deepEqual(exercise.steps[0], { notes: [60, 64], names: ['C4', 'E4'], fingers: [2, 2], hands: ['R', 'L'], beats: 1 });
  });

  test('limits that still build: 128 steps, five notes per hand, a span of 14, the piano edges', () => {
    assert.equal(build(customSpec(Array.from({ length: 128 }, () => customStep(['C4'])))).steps.length, 128);
    const full = build(customSpec([customStep(['C4', 'D4', 'E4', 'F4', 'G4'], ['C3', 'D3', 'E3', 'F3', 'G3'], 1, [1, 2, 3, 4, 5], [5, 4, 3, 2, 1])]));
    assert.equal(full.steps[0].notes.length, 10);
    build(customSpec([customStep(['C4', 'D5'])]));
    const edges = build(customSpec([customStep(['C8'], ['A0'], 8), customStep(['C4'], [], 0.25)]));
    assert.deepEqual(edges.steps[0].notes, [21, 108]);
  });

  test('step structure errors', () => {
    rejects(customSpec(undefined), /steps: required.*list of 1 to 128 steps/);
    rejects(customSpec('E4 F4'), /steps: "E4 F4" is not valid/);
    rejects(customSpec([]), /steps: has 0 steps, an exercise needs 1 to 128/);
    rejects(customSpec(Array.from({ length: 129 }, () => customStep(['C4']))), /steps: has 129 steps, an exercise needs 1 to 128/);
    rejects(customSpec([customStep(['C4']), 'E4', null, ['C4']]), /step 2: "E4" is not valid/, /step 3: null is not valid/, /step 4: \["C4"\] is not valid/);
    rejects(customSpec([{ ...customStep(['C4']), finger: 1 }]), /step 1: finger: unknown field, a step has only right, left, beats, right_fingers, left_fingers/);
    rejects(customSpec([customStep([], [], 1), customStep([], [], 2)]), /steps: every step is a rest/);
    rejects(customSpec([customStep(['C4'])], { beats_per_bar: 5 }), /beats_per_bar: 5 is not valid, use one of 2, 3, 4, 6/);
    rejects(customSpec([customStep(['C4'])], { hand: 'feet' }), /hand: "feet" is not valid/);
    for (const beatsPerBar of [2, 3, 4, 6]) assert.equal(build(customSpec([customStep(['C4'])], { beats_per_bar: beatsPerBar })).beatsPerBar, beatsPerBar);
  });

  test('note errors name the step, the hand and the bad value', () => {
    rejects(customSpec([customStep(['C4']), customStep(['E4', 'H4'])]), /step 2: right\[1\]: "H4" is not a note name.*"C4" \(middle C\)/);
    rejects(customSpec([customStep(['C'])]), /step 1: right\[0\]: "C" is not a note name/);
    rejects(customSpec([customStep([60])]), /step 1: right\[0\]: 60 is not a note name/);
    rejects(customSpec([customStep([], ['C3', null])]), /step 1: left\[1\]: null is not a note name/);
    rejects(customSpec([customStep('C4')]), /step 1: right: "C4" is not valid, use a list of note names/);
    rejects(customSpec([customStep(['C9'])]), /step 1: right\[0\]: "C9" is not on the piano.*A0 to C8/);
    rejects(customSpec([customStep(['C#8'])]), /step 1: right\[0\]: "C#8" is not on the piano/);
    rejects(customSpec([customStep([], ['G#0'])]), /step 1: left\[0\]: "G#0" is not on the piano/);
    rejects(customSpec([customStep(['C4', 'D4', 'E4', 'F4', 'G4', 'A4'])]), /step 1: right: has 6 notes, one hand plays at most 5/);
    rejects(customSpec([customStep(['C#4', 'Db4'])]), /step 1: right: C#4 and Db4 are the same key/);
    rejects(customSpec([customStep(['C4', 'E4'], ['G3', 'C4'])]), /step 1: C4 is in both hands/);
    rejects(customSpec([customStep(['C4', 'D#5'])]), /step 1: right: C4 to D#5 is 15 semitones, one hand reaches at most 14/);
    rejects(customSpec([customStep([], ['C2', 'E3'])]), /step 1: left: C2 to E3 is 16 semitones/);
  });

  test('finger errors', () => {
    rejects(customSpec([customStep(['C4', 'E4'], [], 1, [1])]), /step 1: right_fingers: has 1 finger for 2 notes in "right"/);
    rejects(customSpec([customStep(['C4'], [], 1, [1, 2])]), /step 1: right_fingers: has 2 fingers for 1 note in "right"/);
    rejects(customSpec([customStep([], [], 1, [1])]), /step 1: right_fingers: has 1 finger for 0 notes/);
    rejects(customSpec([customStep(['C4'], [], 1, [0])]), /step 1: right_fingers\[0\]: 0 is not a finger.*1 \(thumb\) to 5/);
    rejects(customSpec([customStep(['C4'], [], 1, [6])]), /step 1: right_fingers\[0\]: 6 is not a finger/);
    rejects(customSpec([customStep(['C4'], [], 1, [1.5])]), /step 1: right_fingers\[0\]: 1\.5 is not a finger/);
    rejects(customSpec([customStep(['C4'], [], 1, ['1'])]), /step 1: right_fingers\[0\]: "1" is not a finger/);
    rejects(customSpec([customStep([], ['C3'], 1, null, [9])]), /step 1: left_fingers\[0\]: 9 is not a finger/);
    rejects(customSpec([customStep(['C4'], [], 1, 3)]), /step 1: right_fingers: 3 is not valid, use null or one finger number/);
    rejects(customSpec([customStep([], ['C3'], 1, null, '5')]), /step 1: left_fingers: "5" is not valid/);
  });

  test('beats errors', () => {
    rejects(customSpec([{ right: ['C4'], left: [] }]), /step 1: beats: required.*0\.25 to 8/);
    rejects(customSpec([customStep(['C4'], [], 0.2)]), /step 1: beats: 0\.2 is not valid.*0\.25 to 8/);
    rejects(customSpec([customStep(['C4'], [], 9)]), /step 1: beats: 9 is not valid/);
    rejects(customSpec([customStep(['C4'], [], 0)]), /step 1: beats: 0 is not valid/);
    rejects(customSpec([customStep(['C4'], [], -1)]), /step 1: beats: -1 is not valid/);
    rejects(customSpec([customStep(['C4'], [], NaN)]), /step 1: beats: NaN is not valid/);
    rejects(customSpec([customStep(['C4'], [], Infinity)]), /step 1: beats: Infinity is not valid/);
    rejects(customSpec([customStep(['C4'], [], '1')]), /step 1: beats: "1" is not valid/);
  });

  test('all the problems of a spec are reported together, up to a limit', () => {
    const errors = rejects(customSpec([customStep(['H4'], [], 0), customStep(['C4'], ['X1'], 1, [7])]),
      /step 1: right\[0\]/, /step 1: beats/, /step 2: left\[0\]/, /step 2: right_fingers\[0\]/);
    assert.equal(errors.length, 4);
    const many = errorsOf(customSpec(Array.from({ length: 100 }, (_, i) => customStep([`H${i}`]))));
    assert.equal(many.length, 13);
    assert.match(many[12], /^and 88 more problems$/);
  });
});

// ---------------------------------------------------------------- validation shared by all types

describe('buildExercise validation', () => {
  test('anything that is not a spec object is rejected', () => {
    for (const value of [null, undefined, 0, 42, NaN, '', 'scale', true, [], [scaleSpec()], () => {}]) {
      const errors = errorsOf(value);
      assert.match(errors[0], /must be a JSON object with a "type" field/);
    }
    rejects(null, /got null/);
    rejects('scale', /got "scale"/);
  });

  test('type', () => {
    rejects({}, /type: required, use one of "scale", "arpeggio", "five_finger", "chords", "custom"/);
    rejects({ ...scaleSpec(), type: 'scales' }, /type: "scales" is not valid, use one of "scale"/);
    rejects({ ...scaleSpec(), type: 7 }, /type: 7 is not valid/);
    rejects({ ...scaleSpec(), type: null }, /type: required/);
  });

  test('hand', () => {
    rejects(scaleSpec({ hand: undefined }), /hand: required, one of "right", "left", "both"/);
    rejects(scaleSpec({ hand: 'rh' }), /hand: "rh" is not valid, use one of "right", "left", "both"/);
    rejects(chordsSpec({ hand: 3 }), /hand: 3 is not valid/);
    rejects(fiveFingerSpec({ hand: null }), /hand: required/);
    rejects(arpeggioSpec({ hand: ['right'] }), /hand: \["right"\] is not valid/);
  });

  test('mode', () => {
    rejects(scaleSpec({ mode: undefined }), /mode: required, one of "wait", "tempo"/);
    rejects(scaleSpec({ mode: 'metronome' }), /mode: "metronome" is not valid, use one of "wait", "tempo"/);
    rejects(customSpec([customStep(['C4'])], { mode: false }), /mode: false is not valid/);
  });

  test('bpm must be a finite number', () => {
    rejects(scaleSpec({ bpm: undefined }), /bpm: required, use a number from 30 to 200/);
    rejects(scaleSpec({ bpm: '72' }), /bpm: "72" is not valid, use a number from 30 to 200/);
    rejects(scaleSpec({ bpm: NaN }), /bpm: NaN is not valid/);
    rejects(scaleSpec({ bpm: Infinity }), /bpm: Infinity is not valid/);
    rejects(scaleSpec({ bpm: null }), /bpm: required/);
  });

  test('title and goal', () => {
    rejects(scaleSpec({ title: 42 }), /title: must be a string, got 42/);
    rejects(scaleSpec({ goal: ['a'] }), /goal: must be a string, got \["a"\]/);
    const tidy = build(scaleSpec({ title: '  C major\n scale  ', goal: 'Line one.\nLine two.' }));
    assert.equal(tidy.title, 'C major scale');
    assert.equal(tidy.goal, 'Line one. Line two.');
    const long = build(scaleSpec({ title: 'x'.repeat(500), goal: 'y'.repeat(2000) }));
    assert.equal(long.title.length, 100);
    assert.equal(long.goal.length, 240);
    const blank = build(scaleSpec({ title: '   ', hand: 'left', root: 'Eb', scale: 'harmonic_minor' }));
    assert.equal(blank.title, 'Eb harmonic minor scale, left hand');
    assert.equal(build(arpeggioSpec({ title: '', quality: 'dominant7', hand: 'both' })).title, 'C dominant 7th arpeggio, hands together');
    assert.equal(build(fiveFingerSpec({ title: '', quality: 'minor' })).title, 'C minor five-finger pattern, right hand');
  });

  test('unknown fields are rejected by name', () => {
    rejects({ ...scaleSpec(), tempo: 80 }, /tempo: unknown field, a "scale" exercise has only type, title, goal, hand, bpm, mode, root, scale, octaves, direction, start_octave, note_beats/);
    rejects({ ...scaleSpec(), startOctave: 3 }, /startOctave: unknown field/);
    rejects({ ...scaleSpec(), quality: 'major' }, /quality: unknown field/);
    rejects({ ...chordsSpec(), root: 'C' }, /root: unknown field, a "chords" exercise has only/);
    rejects({ ...fiveFingerSpec(), octaves: 1 }, /octaves: unknown field/);
    rejects({ ...customSpec([customStep(['C4'])]), start_octave: 4 }, /start_octave: unknown field, a "custom" exercise has only/);
    rejects({ ...arpeggioSpec(), scale: 'major' }, /scale: unknown field/);
  });

  test('root', () => {
    rejects(scaleSpec({ root: undefined }), /root: required.*"C", "F#", "Bb"/);
    rejects(scaleSpec({ root: 'H' }), /root: "H" is not a note name/);
    rejects(scaleSpec({ root: 'C4' }), /root: "C4" is not a note name.*no octave/);
    rejects(scaleSpec({ root: 'C##' }), /root: "C##" is not a note name/);
    rejects(arpeggioSpec({ root: 60 }), /root: 60 is not a note name/);
    rejects(fiveFingerSpec({ root: '' }), /root: "" is not a note name/);
  });

  test('scale, quality, pattern, octaves, direction', () => {
    rejects(scaleSpec({ scale: undefined }), /scale: required, one of "major", "natural_minor"/);
    rejects(scaleSpec({ scale: 'minor' }), /scale: "minor" is not valid, use one of "major", "natural_minor", "harmonic_minor", "melodic_minor", "major_pentatonic", "minor_pentatonic", "blues", "chromatic"/);
    rejects(scaleSpec({ scale: 'toString' }), /scale: "toString" is not valid/);
    rejects(arpeggioSpec({ quality: undefined }), /quality: required/);
    rejects(arpeggioSpec({ quality: 'sus4' }), /quality: "sus4" is not valid, use one of "major", "minor", "diminished", "augmented", "dominant7", "major7", "minor7"/);
    rejects(fiveFingerSpec({ quality: 'diminished' }), /quality: "diminished" is not valid, use one of "major", "minor"$/);
    rejects(fiveFingerSpec({ pattern: undefined }), /pattern: required, one of "up_down", "thirds", "triad"/);
    rejects(fiveFingerSpec({ pattern: 'zigzag' }), /pattern: "zigzag" is not valid/);
    rejects(fiveFingerSpec({ pattern: 'constructor' }), /pattern: "constructor" is not valid/);
    rejects(scaleSpec({ octaves: 3 }), /octaves: 3 is not valid, use one of 1, 2/);
    rejects(scaleSpec({ octaves: 0 }), /octaves: 0 is not valid/);
    rejects(scaleSpec({ octaves: '2' }), /octaves: "2" is not valid/);
    rejects(arpeggioSpec({ octaves: 1.5 }), /octaves: 1\.5 is not valid/);
    rejects(scaleSpec({ direction: 'updown' }), /direction: "updown" is not valid, use one of "up", "down", "up_down"/);
    rejects(arpeggioSpec({ direction: 1 }), /direction: 1 is not valid/);
  });

  test('start_octave and note_beats', () => {
    rejects(scaleSpec({ start_octave: 4.5 }), /start_octave: 4\.5 is not valid, use a whole number from 0 to 8.*middle C/);
    rejects(scaleSpec({ start_octave: '4' }), /start_octave: "4" is not valid/);
    rejects(scaleSpec({ start_octave: -1 }), /start_octave: -1 is not valid/);
    rejects(chordsSpec({ start_octave: 9 }), /start_octave: 9 is not valid/);
    rejects(fiveFingerSpec({ start_octave: NaN }), /start_octave: NaN is not valid/);
    rejects(scaleSpec({ note_beats: 0 }), /note_beats: 0 is not valid, use a number of beats from 0\.25 to 8/);
    rejects(scaleSpec({ note_beats: 0.2 }), /note_beats: 0\.2 is not valid/);
    rejects(arpeggioSpec({ note_beats: 8.5 }), /note_beats: 8\.5 is not valid/);
    rejects(fiveFingerSpec({ note_beats: 'one' }), /note_beats: "one" is not valid/);
  });

  test('several bad fields are all reported', () => {
    const errors = rejects({ type: 'scale', hand: 'up', bpm: 'fast', mode: 'go', root: 'X', scale: 'y', octaves: 9, direction: 'z', start_octave: 'a', note_beats: -1, extra: 1 },
      /^extra:/, /^hand:/, /^bpm:/, /^mode:/, /^root:/, /^scale:/, /^octaves:/, /^direction:/, /^start_octave:/, /^note_beats:/);
    assert.equal(errors.length, 10);
  });

  test('range guard: every note must be on the piano, the fix is start_octave', () => {
    rejects(scaleSpec({ start_octave: 8 }), /step 2: D8 is above the highest piano key \(C8\): start_octave 8 is too high, use a lower start_octave/);
    rejects(scaleSpec({ start_octave: 7, octaves: 2 }), /above the highest piano key.*start_octave 7 is too high/);
    rejects(scaleSpec({ start_octave: 0 }), /step 1: C0 is below the lowest piano key \(A0\): start_octave 0 is too low, use a higher start_octave/);
    rejects(scaleSpec({ hand: 'both', start_octave: 1 }), /step 1: C0 is below the lowest piano key/);
    rejects(arpeggioSpec({ start_octave: 8 }), /above the highest piano key/);
    rejects(fiveFingerSpec({ hand: 'both', start_octave: 0 }), /below the lowest piano key/);
    rejects(chordsSpec({ start_octave: 8 }), /step 1 \(C\): E8 is above the highest piano key.*start_octave 8 is too high/);
    rejects(chordsSpec({ hand: 'both', start_octave: 0 }), /below the lowest piano key.*use a higher start_octave/);
    const errors = errorsOf(scaleSpec({ start_octave: 8, octaves: 2 }));
    assert.equal(errors.length, 1, 'one message, not one per note');
    // The edges themselves are fine.
    assert.deepEqual(single(build(scaleSpec({ root: 'A', start_octave: 0, direction: 'up' })), 'notes')[0], 21);
    assert.deepEqual(single(build(scaleSpec({ start_octave: 7, direction: 'up' })), 'notes')[7], 108);
    assert.deepEqual(build(chordsSpec({ hand: 'both', chords: ['A'], start_octave: 1 })).steps[0].names, ['A0', 'A1', 'C#2', 'E2']);
  });

  test('never throws, whatever it is given', () => {
    const circular = { type: 'custom', bpm: 60, mode: 'wait' };
    circular.steps = [circular];
    const hostile = [
      Symbol('spec'), 10n, new Date(), new Map(), Object.create(null),
      new Proxy({}, { get() { throw new Error('boom'); } }),
      new Proxy({}, { ownKeys() { throw new Error('boom'); } }),
      { get type() { throw new Error('boom'); } },
      { type: { toString() { throw new Error('boom'); } } },
      { type: 'scale', get root() { throw new Error('boom'); } },
      circular,
      { ...scaleSpec(), root: Symbol('C') },
      { ...scaleSpec(), root: 10n },
      { ...scaleSpec(), bpm: 10n },
      { ...scaleSpec(), scale: { toString: null } },
      { ...scaleSpec(), start_octave: { valueOf() { throw new Error('boom'); } } },
      { ...scaleSpec(), title: { length: 3 } },
      { ...chordsSpec(), chords: [10n, Symbol('C'), {}, []] },
      { ...chordsSpec(), chords: { length: 2, 0: 'C', 1: 'F' } },
      { ...chordsSpec(), chords: ['C'.repeat(5000)] },
      { ...customSpec([]), steps: new Array(1000000) },
      { ...customSpec([]), steps: { length: 1 } },
      customSpec([{ right: [Symbol('C4')], left: [10n], beats: 1n, right_fingers: [1n], left_fingers: {} }]),
      customSpec([{ right: { length: 1 }, left: new Map(), beats: {}, right_fingers: 'x', left_fingers: 1 }]),
      customSpec([Object.create(null)]),
      customSpec([new Proxy({}, { get() { throw new Error('boom'); } })]),
      { __proto__: null, type: 'chords' },
    ];
    for (const value of hostile) {
      let result;
      assert.doesNotThrow(() => { result = buildExercise(value); });
      assert.equal(result.ok, false);
      assert.ok(result.errors.length > 0 && result.errors.every((message) => typeof message === 'string' && message.length > 0));
    }
  });

  test('the spec passed in is never modified, and the stored spec is a separate copy', () => {
    const spec = customSpec([customStep(['C4', 'E4'], [], 1, [1, 3])]);
    const frozen = JSON.parse(JSON.stringify(spec));
    const exercise = build(Object.freeze(spec));
    assert.deepEqual(spec, frozen);
    exercise.spec.steps[0].right.push('G4');
    exercise.steps[0].notes.push(99);
    assert.deepEqual(spec, frozen);
    const chordSpecInput = chordsSpec();
    const built = build(chordSpecInput);
    built.spec.chords.push('Am');
    assert.deepEqual(chordSpecInput.chords, ['C', 'F', 'G', 'C']);
  });
});

// ---------------------------------------------------------------- bpm clamping

describe('bpm clamping', () => {
  test('bpm is rounded and clamped to 30..200', () => {
    const bpmOf = (bpm) => build(scaleSpec({ bpm })).bpm;
    assert.equal(bpmOf(10), 30);
    assert.equal(bpmOf(0), 30);
    assert.equal(bpmOf(-50), 30);
    assert.equal(bpmOf(29.4), 30);
    assert.equal(bpmOf(30), 30);
    assert.equal(bpmOf(72.4), 72);
    assert.equal(bpmOf(72.5), 73);
    assert.equal(bpmOf(200), 200);
    assert.equal(bpmOf(200.4), 200);
    assert.equal(bpmOf(500), 200);
    assert.equal(bpmOf(1e9), 200);
  });

  test('the stored spec carries the clamped tempo', () => {
    const exercise = build(chordsSpec({ bpm: 999 }));
    assert.equal(exercise.bpm, 200);
    assert.equal(exercise.spec.bpm, 200);
    assert.equal(build(customSpec([customStep(['C4'])], { bpm: 3 })).spec.bpm, 30);
  });
});

// ---------------------------------------------------------------- ids

describe('id', () => {
  test('does not depend on title, goal, bpm or mode', () => {
    for (const make of [scaleSpec, arpeggioSpec, fiveFingerSpec, chordsSpec, (extra) => customSpec([customStep(['C4'], ['C3'], 1, [1], [5])], extra)]) {
      const id = build(make()).id;
      assert.equal(build(make({ title: 'Another name' })).id, id);
      assert.equal(build(make({ goal: 'Another goal.' })).id, id);
      assert.equal(build(make({ bpm: 120 })).id, id);
      assert.equal(build(make({ mode: 'tempo' })).id, id);
      assert.equal(build(make()).id, id, 'deterministic');
    }
  });

  test('changes with the musical content', () => {
    const ids = [
      scaleSpec(), scaleSpec({ root: 'D' }), scaleSpec({ scale: 'natural_minor' }), scaleSpec({ hand: 'left' }), scaleSpec({ hand: 'both' }),
      scaleSpec({ octaves: 2 }), scaleSpec({ direction: 'up' }), scaleSpec({ start_octave: 5 }), scaleSpec({ note_beats: 2 }),
      arpeggioSpec(), arpeggioSpec({ quality: 'minor' }), arpeggioSpec({ octaves: 2 }), arpeggioSpec({ note_beats: 0.5 }),
      fiveFingerSpec(), fiveFingerSpec({ quality: 'minor' }), fiveFingerSpec({ pattern: 'triad' }), fiveFingerSpec({ start_octave: 3 }),
      chordsSpec(), chordsSpec({ chords: ['C', 'F', 'G'] }), chordsSpec({ style: 'broken' }), chordsSpec({ voicing: 'smooth' }),
      chordsSpec({ hand: 'both' }), chordsSpec({ start_octave: 3 }), chordsSpec({ beats_per_chord: 2 }),
      customSpec([customStep(['C4'])]), customSpec([customStep(['D4'])]), customSpec([customStep(['C4'], [], 2)]),
      customSpec([customStep([], ['C4'])]), customSpec([customStep(['C4']), customStep(['C4'])]),
      customSpec([customStep(['C4'])], { beats_per_bar: 3 }), customSpec([customStep(['C4']), customStep([], [], 1)]),
    ].map((spec) => build(spec).id);
    assert.equal(new Set(ids).size, ids.length, `ids must differ: ${ids.join(' ')}`);
  });

  test('a custom id ignores fingering and enharmonic spelling', () => {
    const id = build(customSpec([customStep(['C#4', 'E4'], [], 1, [1, 3])])).id;
    assert.equal(build(customSpec([customStep(['C#4', 'E4'], [], 1, null)])).id, id);
    assert.equal(build(customSpec([customStep(['Db4', 'E4'], [], 1, [2, 4])])).id, id);
    assert.equal(build(customSpec([customStep(['E4', 'C#4'])])).id, id);
  });

  test('ids are plain strings that contain the type', () => {
    for (const spec of [scaleSpec(), arpeggioSpec(), fiveFingerSpec(), chordsSpec(), customSpec([customStep(['C4'])])]) {
      const exercise = build(spec);
      assert.ok(exercise.id.startsWith(`${exercise.type}:`));
      assert.doesNotMatch(exercise.id, /\s/);
    }
  });
});

// ---------------------------------------------------------------- sliceExercise

describe('sliceExercise', () => {
  test('cuts an inclusive 0-based range and keeps the rest of the exercise', () => {
    const parent = build(scaleSpec({ bpm: 88, mode: 'tempo' }));
    const drill = sliceExercise(parent, 2, 5);
    assert.deepEqual(drill.steps, parent.steps.slice(2, 6));
    assert.equal(drill.steps.length, 4);
    assert.equal(drill.id, 'scale:C:major:right:1:up_down:4:2-5');
    assert.equal(drill.title, 'Drill: Test title, steps 3 to 6');
    assert.equal(drill.goal, parent.goal);
    assert.equal(drill.type, 'scale');
    assert.equal(drill.hand, 'right');
    assert.equal(drill.bpm, 88);
    assert.equal(drill.mode, 'tempo');
    assert.equal(drill.beatsPerBar, 4);
    assert.deepEqual(drill.key, { tonic: 'C', mode: 'major' });
    assert.deepEqual(validateExercise(drill), []);
    assert.deepEqual(validateExercise(JSON.parse(JSON.stringify(drill))), []);
    assert.deepEqual(Object.keys(drill).sort(), Object.keys(parent).sort());
  });

  test('whole range, first step, last step', () => {
    const parent = build(scaleSpec());
    assert.deepEqual(sliceExercise(parent, 0, 14).steps, parent.steps);
    const first = sliceExercise(parent, 0, 0);
    assert.equal(first.steps.length, 1);
    assert.equal(first.title, 'Drill: Test title, step 1');
    assert.equal(first.id, `${parent.id}:0-0`);
    const last = sliceExercise(parent, 14, 14);
    assert.deepEqual(last.steps, [parent.steps[14]]);
    assert.deepEqual(validateExercise(last), []);
  });

  test('the drill is a deep copy and the parent is not modified', () => {
    const parent = build(chordsSpec());
    const snapshot = JSON.parse(JSON.stringify(parent));
    const drill = sliceExercise(parent, 1, 2);
    drill.steps[0].notes.push(100);
    drill.steps[0].fingers[0] = 4;
    drill.steps[0].label = 'changed';
    drill.key.tonic = 'D';
    assert.deepEqual(JSON.parse(JSON.stringify(parent)), snapshot);
    assert.notEqual(drill.steps[1], parent.steps[2]);
  });

  test('chord drills keep their labels', () => {
    const drill = sliceExercise(build(chordsSpec()), 1, 2);
    assert.deepEqual(labels(drill), ['F', 'G']);
    assert.equal(drill.type, 'chords');
  });

  test('the drill spec is a custom spec that builds the same steps', () => {
    const parent = build(scaleSpec({ hand: 'both', bpm: 64 }));
    const drill = sliceExercise(parent, 3, 6);
    assert.equal(drill.spec.type, 'custom');
    assert.equal(drill.spec.bpm, 64);
    assert.equal(drill.spec.title, drill.title);
    const rebuilt = build(drill.spec);
    assert.deepEqual(rebuilt.steps, drill.steps);
    assert.equal(rebuilt.hand, 'both');
    // Labels are not part of a custom spec; everything else survives.
    const chordDrill = sliceExercise(build(chordsSpec({ hand: 'both' })), 0, 1);
    const rebuiltChords = build(chordDrill.spec);
    assert.deepEqual(midis(rebuiltChords), midis(chordDrill));
    assert.deepEqual(fingers(rebuiltChords), fingers(chordDrill));
  });

  test('a drill of a drill extends the id and does not repeat the prefix', () => {
    const parent = build(scaleSpec());
    const drill = sliceExercise(sliceExercise(parent, 4, 10), 1, 2);
    assert.deepEqual(drill.steps, parent.steps.slice(5, 7));
    assert.equal(drill.id, 'scale:C:major:right:1:up_down:4:4-10:1-2');
    assert.equal(drill.title, 'Drill: Test title, steps 5 to 11, steps 2 to 3');
    assert.deepEqual(validateExercise(drill), []);
  });

  test('the hand of a drill is the hand its steps use; rests are kept', () => {
    const parent = build(customSpec([customStep(['C4'], ['C3']), customStep(['D4']), customStep([], [], 1), customStep(['E4']), customStep([], ['G2'])]));
    assert.equal(parent.hand, 'both');
    const right = sliceExercise(parent, 1, 3);
    assert.equal(right.hand, 'right');
    assert.deepEqual(midis(right), [[62], [], [64]]);
    assert.deepEqual(validateExercise(right), []);
    assert.equal(sliceExercise(parent, 4, 4).hand, 'left');
    assert.equal(sliceExercise(parent, 0, 1).hand, 'both');
    assert.equal(sliceExercise(parent, 3, 4).hand, 'both');
    assert.deepEqual(build(right.spec).steps, right.steps);
  });

  test('throws RangeError on a bad range', () => {
    const parent = build(scaleSpec());
    const bad = [[-1, 3], [0, 15], [5, 4], [15, 15], [0.5, 3], [0, 2.5], [NaN, 3], [0, NaN], ['0', 3], [0, '3'], [undefined, 3], [0, undefined],
      [null, null], [0, Infinity], [-Infinity, 2]];
    for (const [from, to] of bad) {
      assert.throws(() => sliceExercise(parent, from, to), RangeError, `${String(from)}..${String(to)}`);
    }
    assert.throws(() => sliceExercise(parent), RangeError);
  });

  test('throws RangeError for a range of rests only, and when there is no exercise', () => {
    const parent = build(customSpec([customStep(['C4']), customStep([], [], 1), customStep([], [], 1), customStep(['D4'])]));
    assert.throws(() => sliceExercise(parent, 1, 2), /only rests/);
    assert.throws(() => sliceExercise(parent, 1, 2), RangeError);
    for (const value of [null, undefined, 'exercise', 7, [], {}, { steps: 'none' }]) {
      assert.throws(() => sliceExercise(value, 0, 0), RangeError);
    }
  });
});

// ---------------------------------------------------------------- withTempo

describe('withTempo', () => {
  test('changes bpm and mode, keeps everything else', () => {
    const exercise = build(scaleSpec());
    const changed = withTempo(exercise, { bpm: 96, mode: 'tempo' });
    assert.equal(changed.bpm, 96);
    assert.equal(changed.mode, 'tempo');
    assert.equal(changed.id, exercise.id);
    assert.equal(changed.title, exercise.title);
    assert.deepEqual(changed.steps, exercise.steps);
    assert.deepEqual(changed.key, exercise.key);
    assert.deepEqual(changed.spec, { ...exercise.spec, bpm: 96, mode: 'tempo' });
    assert.deepEqual(validateExercise(changed), []);
    assert.deepEqual(build(changed.spec), changed);
  });

  test('only bpm, only mode, or nothing', () => {
    const exercise = build(scaleSpec());
    assert.deepEqual(withTempo(exercise, { bpm: 100 }), { ...exercise, bpm: 100, spec: { ...exercise.spec, bpm: 100 } });
    assert.deepEqual(withTempo(exercise, { mode: 'tempo' }), { ...exercise, mode: 'tempo', spec: { ...exercise.spec, mode: 'tempo' } });
    assert.deepEqual(withTempo(exercise, {}), exercise);
    assert.deepEqual(withTempo(exercise), exercise);
    assert.deepEqual(withTempo(exercise, null), exercise);
    assert.deepEqual(withTempo(exercise, { bpm: undefined, mode: undefined }), exercise);
  });

  test('bpm is rounded and clamped', () => {
    const exercise = build(scaleSpec());
    assert.equal(withTempo(exercise, { bpm: 5 }).bpm, 30);
    assert.equal(withTempo(exercise, { bpm: 1000 }).bpm, 200);
    assert.equal(withTempo(exercise, { bpm: 80.6 }).bpm, 81);
    assert.equal(withTempo(exercise, { bpm: -Infinity }).bpm, 72);
    assert.equal(withTempo(exercise, { bpm: 1000 }).spec.bpm, 200);
  });

  test('values that make no sense leave the setting unchanged', () => {
    const exercise = build(scaleSpec());
    for (const bpm of [NaN, Infinity, '90', null, {}, [], true]) assert.equal(withTempo(exercise, { bpm }).bpm, 72, String(bpm));
    for (const mode of ['fast', 'TEMPO', 1, null, {}, true]) assert.equal(withTempo(exercise, { mode }).mode, 'wait', String(mode));
    assert.deepEqual(validateExercise(withTempo(exercise, { bpm: 'x', mode: 'y' })), []);
  });

  test('returns a deep copy and does not modify its argument', () => {
    const exercise = build(chordsSpec());
    const snapshot = JSON.parse(JSON.stringify(exercise));
    const changed = withTempo(exercise, { bpm: 100, mode: 'tempo' });
    changed.steps[0].notes.push(100);
    changed.steps[0].label = 'changed';
    changed.key.tonic = 'D';
    changed.spec.chords.push('Am');
    assert.deepEqual(JSON.parse(JSON.stringify(exercise)), snapshot);
    assert.notEqual(changed, exercise);
  });

  test('works on drills and on exercises revived from JSON', () => {
    const drill = sliceExercise(build(chordsSpec()), 1, 2);
    const changed = withTempo(JSON.parse(JSON.stringify(drill)), { bpm: 50, mode: 'tempo' });
    assert.equal(changed.id, drill.id);
    assert.equal(changed.bpm, 50);
    assert.deepEqual(labels(changed), ['F', 'G']);
    assert.deepEqual(validateExercise(changed), []);
  });

  test('throws TypeError when there is no exercise', () => {
    for (const value of [null, undefined, 'x', 3, [], {}]) assert.throws(() => withTempo(value, { bpm: 60 }), TypeError);
  });
});

// ---------------------------------------------------------------- describeExercise

describe('describeExercise', () => {
  test('a scale: header line and numbered steps with fingers', () => {
    const text = describeExercise(build(scaleSpec({ title: 'C major scale, right hand' })));
    assert.equal(text, 'C major scale, right hand (scale, right hand). 72 bpm, wait mode, 15 steps of 1 beat.\n'
      + '1:C4(1) 2:D4(2) 3:E4(3) 4:F4(1) 5:G4(2) 6:A4(3) 7:B4(4) 8:C5(5) 9:B4(4) 10:A4(3) 11:G4(2) 12:F4(1) 13:E4(3) 14:D4(2) 15:C4(1)');
  });

  test('chords are written in square brackets with their symbol', () => {
    const text = describeExercise(build(chordsSpec({ chords: ['C', 'Am', 'Dsus4'], voicing: 'smooth', mode: 'tempo', bpm: 60 })));
    assert.equal(text, 'Test title (chords, right hand). 60 bpm, tempo mode, 3 steps of 4 beats.\n'
      + '1:C=[C4 E4 G4](1 3 5) 2:Am=[C4 E4 A4](1 2 5) 3:Dsus4=[D4 G4 A4]');
  });

  test('both hands are marked L and R', () => {
    const scale = describeExercise(build(scaleSpec({ hand: 'both', direction: 'up', title: 'Together' })));
    assert.equal(scale, 'Together (scale, both hands). 72 bpm, wait mode, 8 steps of 1 beat.\n'
      + '1:L C3(5) + R C4(1) 2:L D3(4) + R D4(2) 3:L E3(3) + R E4(3) 4:L F3(2) + R F4(1) 5:L G3(1) + R G4(2) 6:L A3(3) + R A4(3) '
      + '7:L B3(2) + R B4(4) 8:L C4(1) + R C5(5)');
    const chords = describeExercise(build(chordsSpec({ hand: 'both', chords: ['C'], style: 'broken' })));
    assert.equal(chords.split('\n')[1], '1:C=L C3 + R C4(1) 2:R E4(3) 3:R G4(5) 4:R E4(3)');
  });

  test('rests, unknown fingers, partly known fingers and uneven beats', () => {
    const exercise = build(customSpec([
      customStep(['C4', 'E4', 'G4'], [], 1, [1, null, 5]),
      customStep([], [], 1),
      customStep(['D4'], [], 1.5),
      customStep(['E4'], [], 0.5, [3]),
      customStep(['C4', 'E4'], [], 2),
    ], { title: 'Mixed', bpm: 90, beats_per_bar: 3 }));
    assert.equal(describeExercise(exercise), 'Mixed (custom, right hand). 90 bpm, wait mode, 5 steps, 1 beat each unless marked {beats}.\n'
      + '1:[C4 E4 G4](1 - 5) 2:rest 3:D4{1.5} 4:E4(3){0.5} 5:[C4 E4]{2}');
  });

  test('five-finger type is written in words; pentatonic scale has no finger marks', () => {
    assert.match(describeExercise(build(fiveFingerSpec())), /^Test title \(five finger, right hand\)\. 72 bpm, wait mode, 9 steps of 1 beat\.\n1:C4\(1\) /);
    assert.equal(describeExercise(build(scaleSpec({ scale: 'major_pentatonic', direction: 'up' }))).split('\n')[1], '1:C4 2:D4 3:E4 4:G4 5:A4 6:C5');
  });

  test('output shape for every starter exercise and for drills', () => {
    const exercises = STARTER_EXERCISES.map((spec) => build(spec));
    exercises.push(sliceExercise(exercises[4], 2, 5), withTempo(exercises[6], { bpm: 40 }));
    for (const exercise of exercises) {
      const text = describeExercise(exercise);
      const lines = text.split('\n');
      assert.equal(lines.length, 2, 'two lines');
      assert.ok(lines[0].startsWith(`${exercise.title} (`));
      assert.ok(lines[0].includes(`${exercise.bpm} bpm, ${exercise.mode} mode, ${exercise.steps.length} steps`));
      const steps = lines[1].split(/ (?=\d+:)/);
      assert.equal(steps.length, exercise.steps.length);
      steps.forEach((stepText, i) => {
        assert.ok(stepText.startsWith(`${i + 1}:`));
        for (const name of exercise.steps[i].names) assert.ok(stepText.includes(name));
      });
      assert.ok(text.length < 1500, 'compact');
    }
  });

  test("returns '' for anything that is not an exercise", () => {
    for (const value of [null, undefined, 5, 'x', [], {}, { steps: [] }, { steps: 'x' }, { steps: [null] }, { title: 'x', steps: [{}] }]) {
      assert.equal(describeExercise(value), '');
    }
  });
});

// ---------------------------------------------------------------- validateExercise

describe('validateExercise', () => {
  const valid = () => build(chordsSpec({ hand: 'both' }));
  const mutated = (change) => {
    const exercise = JSON.parse(JSON.stringify(valid()));
    change(exercise);
    return validateExercise(exercise);
  };

  test('accepts built exercises of every type', () => {
    for (const spec of [scaleSpec(), arpeggioSpec(), fiveFingerSpec(), chordsSpec(), customSpec([customStep(['C4']), customStep([], [], 1)])]) {
      assert.deepEqual(validateExercise(build(spec)), []);
    }
  });

  test('rejects things that are not exercises without throwing', () => {
    for (const value of [null, undefined, 0, 'exercise', [], () => {}, Symbol('x'), {}, { steps: [] },
      new Proxy({}, { get() { throw new Error('boom'); } })]) {
      let problems;
      assert.doesNotThrow(() => { problems = validateExercise(value); });
      assert.ok(Array.isArray(problems) && problems.length > 0);
      assert.ok(problems.every((problem) => typeof problem === 'string' && problem.length > 0));
    }
    assert.deepEqual(validateExercise(null), ['exercise must be an object']);
  });

  test('top-level invariants', () => {
    const cases = [
      [(e) => { e.id = ''; }, /id must be a non-empty string/],
      [(e) => { e.id = 5; }, /id must be/],
      [(e) => { delete e.id; }, /id must be/],
      [(e) => { e.title = ''; }, /title must be a non-empty string/],
      [(e) => { e.title = null; }, /title must be/],
      [(e) => { e.goal = 5; }, /goal must be a string/],
      [(e) => { delete e.goal; }, /goal must be a string/],
      [(e) => { e.type = 'etude'; }, /type must be one of/],
      [(e) => { e.hand = 'R'; }, /hand must be one of/],
      [(e) => { e.bpm = 20; }, /bpm must be an integer from 30 to 200/],
      [(e) => { e.bpm = 201; }, /bpm must be/],
      [(e) => { e.bpm = 72.5; }, /bpm must be/],
      [(e) => { e.bpm = '72'; }, /bpm must be/],
      [(e) => { e.mode = 'listen'; }, /mode must be one of/],
      [(e) => { e.beatsPerBar = 5; }, /beatsPerBar must be one of 2, 3, 4, 6/],
      [(e) => { delete e.beatsPerBar; }, /beatsPerBar must be/],
      [(e) => { delete e.key; }, /key must be null or/],
      [(e) => { e.key = 'C'; }, /key must be null or/],
      [(e) => { e.key = { tonic: 'H', mode: 'major' }; }, /key must be null or/],
      [(e) => { e.key = { tonic: 'C', mode: 'dorian' }; }, /key must be null or/],
      [(e) => { e.key = []; }, /key must be null or/],
      [(e) => { delete e.spec; }, /spec must be an object/],
      [(e) => { e.spec = 'scale'; }, /spec must be an object/],
      [(e) => { e.spec = null; }, /spec must be an object/],
      [(e) => { e.steps = []; }, /steps must be an array of 1 to 128 steps/],
      [(e) => { e.steps = 'none'; }, /steps must be an array/],
      [(e) => { delete e.steps; }, /steps must be an array/],
      [(e) => { e.steps = Array.from({ length: 129 }, () => e.steps[0]); }, /steps must be an array of 1 to 128 steps/],
      [(e) => { e.hand = 'right'; }, /hand is 'right' but the steps use hands together/],
      [(e) => { e.hand = 'left'; }, /hand is 'left' but the steps use hands together/],
    ];
    for (const [change, pattern] of cases) {
      const problems = mutated(change);
      assert.ok(problems.some((problem) => pattern.test(problem)), `${change}: ${JSON.stringify(problems)}`);
    }
    assert.deepEqual(mutated((e) => { e.key = null; }), []);
    assert.deepEqual(mutated((e) => { e.goal = ''; }), []);
  });

  test('step invariants', () => {
    const cases = [
      [(s) => { s.notes = 'C4'; }, /needs notes, names, fingers and hands arrays/],
      [(s) => { delete s.names; }, /needs notes, names, fingers and hands arrays/],
      [(s) => { s.fingers.pop(); }, /one entry per note/],
      [(s) => { s.hands.push('R'); }, /one entry per note/],
      [(s) => { s.names.pop(); }, /one entry per note/],
      [(s) => { s.notes[1] = 20; s.notes[0] = 12; }, /notes\[0\] must be a MIDI number from 21 to 108/],
      [(s) => { s.notes[3] = 109; }, /notes\[3\] must be a MIDI number/],
      [(s) => { s.notes[1] = 60.5; }, /notes\[1\] must be a MIDI number/],
      [(s) => { s.notes[1] = '60'; }, /notes\[1\] must be a MIDI number/],
      [(s) => { [s.notes[1], s.notes[2]] = [s.notes[2], s.notes[1]]; [s.names[1], s.names[2]] = [s.names[2], s.names[1]]; }, /notes must be ascending without repeats/],
      [(s) => { s.notes[2] = s.notes[1]; s.names[2] = s.names[1]; }, /notes must be ascending without repeats/],
      [(s) => { s.names[1] = 'C#4'; }, /names\[1\] must be the spelled name of notes\[1\]/],
      [(s) => { s.names[1] = 'C'; }, /names\[1\] must be the spelled name/],
      [(s) => { s.names[1] = 60; }, /names\[1\] must be the spelled name/],
      [(s) => { s.fingers[1] = 0; }, /fingers\[1\] must be 1\.\.5 or null/],
      [(s) => { s.fingers[1] = 6; }, /fingers\[1\] must be 1\.\.5 or null/],
      [(s) => { s.fingers[1] = 2.5; }, /fingers\[1\] must be 1\.\.5 or null/],
      [(s) => { s.fingers[1] = '1'; }, /fingers\[1\] must be 1\.\.5 or null/],
      [(s) => { s.hands[1] = 'right'; }, /hands\[1\] must be 'L' or 'R'/],
      [(s) => { s.beats = 0.1; }, /beats must be a number from 0\.25 to 8/],
      [(s) => { s.beats = 9; }, /beats must be a number/],
      [(s) => { s.beats = '1'; }, /beats must be a number/],
      [(s) => { delete s.beats; }, /beats must be a number/],
      [(s) => { s.label = 5; }, /label must be a string when present/],
      [(s) => { s.label = null; }, /label must be a string when present/],
      [(s) => { s.notes = []; s.names = []; s.fingers = []; s.hands = []; }, /is a rest, only custom exercises may contain rests/],
      [(s) => { s.notes = [60, 62, 64, 65, 67, 69]; s.names = ['C4', 'D4', 'E4', 'F4', 'G4', 'A4']; s.fingers = Array(6).fill(null); s.hands = Array(6).fill('R'); }, /has 6 notes in one hand, the limit is 5/],
      [(s) => { s.notes = [60, 75]; s.names = ['C4', 'D#5']; s.fingers = [null, null]; s.hands = ['R', 'R']; }, /spans more than 14 semitones in one hand/],
      [(s) => { s.notes = Array.from({ length: 11 }, (_, i) => 40 + i); s.names = s.notes.map(() => 'C4'); s.fingers = s.notes.map(() => null); s.hands = s.notes.map((_, i) => (i < 5 ? 'L' : 'R')); }, /has 11 notes, the limit is 10/],
    ];
    for (const [change, pattern] of cases) {
      const problems = mutated((e) => change(e.steps[1]));
      assert.ok(problems.some((problem) => pattern.test(problem) && problem.includes('steps[1]')), `${change}: ${JSON.stringify(problems)}`);
    }
    assert.ok(mutated((e) => { e.steps[2] = null; }).some((problem) => /steps\[2\] must be an object/.test(problem)));
    assert.deepEqual(mutated((e) => { e.steps[1].fingers[1] = null; }), []);
    assert.deepEqual(mutated((e) => { delete e.steps[1].label; }), []);
  });

  test('rests are fine in custom exercises, but an exercise needs a note', () => {
    const exercise = build(customSpec([customStep(['C4']), customStep([], [], 1)]));
    assert.deepEqual(validateExercise(exercise), []);
    exercise.steps = [exercise.steps[1]];
    assert.deepEqual(validateExercise(exercise), ['steps must contain at least one note']);
  });

  test('a huge broken exercise gives a bounded list of problems', () => {
    const exercise = build(customSpec(Array.from({ length: 128 }, () => customStep(['C4']))));
    for (const step of exercise.steps) step.beats = 0;
    const problems = validateExercise(exercise);
    assert.ok(problems.length >= 1 && problems.length <= 25);
  });
});

// ---------------------------------------------------------------- starter library

describe('STARTER_EXERCISES', () => {
  const built = () => STARTER_EXERCISES.map((spec) => build(spec));

  test('about a dozen specs, every one builds and validates', () => {
    assert.ok(STARTER_EXERCISES.length >= 12 && STARTER_EXERCISES.length <= 16);
    for (const spec of STARTER_EXERCISES) {
      const result = buildExercise(spec);
      assert.equal(result.ok, true, `${spec.title}: ${JSON.stringify(result.errors)}`);
      assert.deepEqual(validateExercise(result.exercise), []);
    }
  });

  test('the path, in order', () => {
    const ids = built().map((exercise) => exercise.id);
    assert.match(ids[3], /^custom:/);
    ids[3] = 'custom';
    assert.deepEqual(ids, [
      'five_finger:C:major:right:up_down:4',
      'five_finger:C:major:left:up_down:3',
      'five_finger:C:major:right:thirds:4',
      'custom',
      'scale:C:major:right:1:up_down:4',
      'scale:C:major:left:1:up_down:3',
      'scale:G:major:right:1:up_down:4',
      'scale:F:major:right:1:up_down:4',
      'arpeggio:C:major:right:1:up_down:4',
      'chords:C-F-G-C:block:root:right:4',
      'chords:C-Am-F-G:block:smooth:right:4',
      'scale:A:harmonic_minor:right:1:up_down:4',
      // Hands together is the hardest item, so it comes last.
      'scale:C:major:both:1:up_down:4',
    ]);
  });

  test('ids and titles are unique; titles and goals are short plain lines', () => {
    const exercises = built();
    assert.equal(new Set(exercises.map((exercise) => exercise.id)).size, exercises.length);
    assert.equal(new Set(exercises.map((exercise) => exercise.title)).size, exercises.length);
    for (const exercise of exercises) {
      assert.ok(exercise.title.length >= 8 && exercise.title.length <= 60, exercise.title);
      assert.ok(exercise.goal.length >= 20 && exercise.goal.length <= 130, exercise.goal);
      assert.doesNotMatch(exercise.goal, /\n/);
      assert.match(exercise.goal, /[.!]$/);
      assert.doesNotMatch(`${exercise.title} ${exercise.goal}`, /[#*_`]|[^\x20-\x7e]/, 'plain words, no markup');
    }
  });

  test('specs are complete and already normalized: the stored spec equals the starter spec', () => {
    STARTER_EXERCISES.forEach((spec, i) => {
      assert.deepEqual(built()[i].spec, spec, spec.title);
    });
  });

  test('beginner settings: slow, wait mode, starting around middle C', () => {
    for (const exercise of built()) {
      assert.equal(exercise.mode, 'wait');
      assert.ok(exercise.bpm >= 50 && exercise.bpm <= 72, `${exercise.title}: ${exercise.bpm}`);
      for (const step of exercise.steps) {
        for (const midi of step.notes) assert.ok(midi >= 48 && midi <= 84, `${exercise.title}: ${midi}`);
      }
    }
    const first = built()[0];
    assert.deepEqual(first.steps[0], { notes: [60], names: ['C4'], fingers: [1], hands: ['R'], beats: 1 });
    const cMajor = built()[4];
    assert.equal(cMajor.title, 'C major scale, right hand');
    assert.equal(cMajor.bpm, 60);
    assert.equal(cMajor.steps.length, 15);
  });

  test('every generated starter exercise has complete fingering', () => {
    for (const exercise of built()) {
      for (const step of exercise.steps) assert.ok(step.fingers.every((finger) => finger !== null), exercise.title);
    }
  });

  test('Ode to Joy: the opening phrase in C position', () => {
    const ode = built()[3];
    assert.equal(ode.title, 'Ode to Joy, opening phrase');
    assert.equal(ode.type, 'custom');
    assert.equal(ode.hand, 'right');
    assert.equal(ode.beatsPerBar, 4);
    assert.equal(ode.key, null);
    assert.deepEqual(single(ode, 'names'), words('E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4 D4 D4'));
    assert.deepEqual(single(ode, 'notes'), [64, 64, 65, 67, 67, 65, 64, 62, 60, 60, 62, 64, 64, 62, 62]);
    assert.deepEqual(single(ode, 'fingers'), numbers('3 3 4 5 5 4 3 2 1 1 2 3 3 2 2'));
    assert.deepEqual(beats(ode), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, 0.5, 2]);
    assert.equal(beats(ode).reduce((sum, value) => sum + value, 0), 16, 'four full bars');
    // One finger per key: the hand never leaves the five-finger position.
    for (const step of ode.steps) assert.equal(step.fingers[0], { 60: 1, 62: 2, 64: 3, 65: 4, 67: 5 }[step.notes[0]]);
  });

  test('the two chord exercises', () => {
    const [block, smooth] = [built()[9], built()[10]];
    assert.deepEqual(names(block), [['C4', 'E4', 'G4'], ['F4', 'A4', 'C5'], ['G4', 'B4', 'D5'], ['C4', 'E4', 'G4']]);
    assert.deepEqual(names(smooth), [['C4', 'E4', 'G4'], ['C4', 'E4', 'A4'], ['C4', 'F4', 'A4'], ['B3', 'D4', 'G4']]);
    assert.deepEqual(labels(smooth), ['C', 'Am', 'F', 'G']);
  });

  test('the library is frozen', () => {
    assert.ok(Object.isFrozen(STARTER_EXERCISES));
    assert.ok(STARTER_EXERCISES.every((spec) => Object.isFrozen(spec)));
    assert.ok(Object.isFrozen(STARTER_EXERCISES[3].steps[0].right));
    assert.throws(() => { STARTER_EXERCISES[0].bpm = 100; }, TypeError);
  });
});

// ---------------------------------------------------------------- JSON schema

const FORBIDDEN_KEYWORDS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'contains', 'minContains', 'maxContains', 'prefixItems',
  'minProperties', 'maxProperties', 'patternProperties', 'propertyNames', 'dependentRequired', 'dependentSchemas',
  'unevaluatedProperties', 'unevaluatedItems', 'oneOf', 'allOf', 'not', 'if', 'then', 'else', '$ref', '$defs', 'definitions',
  '$id', '$schema', '$anchor', '$dynamicRef', 'default', 'examples', 'nullable'];
const ALLOWED_KEYWORDS = ['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf'];
const BASIC_TYPES = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];

/** Visit every schema node (the schema itself, property schemas, items, anyOf branches). */
function walkSchema(schema, visit, path = '$') {
  visit(schema, path);
  if (schema.properties) {
    for (const [key, child] of Object.entries(schema.properties)) walkSchema(child, visit, `${path}.${key}`);
  }
  if (schema.items) walkSchema(schema.items, visit, `${path}[]`);
  if (schema.anyOf) schema.anyOf.forEach((child, i) => walkSchema(child, visit, `${path}|${i}`));
}

/** A small JSON Schema checker for the keywords the spec schema uses. Returns problems. */
function conforms(schema, value, path = '$') {
  if (schema.anyOf) {
    const attempts = schema.anyOf.map((branch) => conforms(branch, value, path));
    return attempts.some((problems) => problems.length === 0) ? [] : [`${path}: matches no anyOf branch (${attempts.map((a) => a[0]).join(' / ')})`];
  }
  const problems = [];
  const typeOk = {
    object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    array: (v) => Array.isArray(v),
    string: (v) => typeof v === 'string',
    integer: (v) => Number.isInteger(v),
    number: (v) => typeof v === 'number' && Number.isFinite(v),
    boolean: (v) => typeof v === 'boolean',
    null: (v) => v === null,
  }[schema.type];
  if (!typeOk(value)) return [`${path}: expected ${schema.type}`];
  if ('const' in schema && value !== schema.const) problems.push(`${path}: expected ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${path}: ${value} not in enum`);
  if (schema.type === 'object') {
    for (const key of schema.required) {
      if (!(key in value)) problems.push(`${path}: missing ${key}`);
    }
    for (const key of Object.keys(value)) {
      if (!(key in schema.properties)) problems.push(`${path}: extra ${key}`);
      else problems.push(...conforms(schema.properties[key], value[key], `${path}.${key}`));
    }
  }
  if (schema.type === 'array') value.forEach((item, i) => problems.push(...conforms(schema.items, item, `${path}[${i}]`)));
  return problems;
}

describe('EXERCISE_SPEC_JSON_SCHEMA', () => {
  const schema = EXERCISE_SPEC_JSON_SCHEMA;

  test('is a union of five object variants told apart by a constant type', () => {
    assert.deepEqual(Object.keys(schema).sort(), ['anyOf', 'description']);
    assert.equal(schema.anyOf.length, 5);
    assert.deepEqual(schema.anyOf.map((variant) => variant.properties.type.const), ['scale', 'arpeggio', 'five_finger', 'chords', 'custom']);
    for (const variant of schema.anyOf) {
      assert.equal(variant.type, 'object');
      assert.deepEqual(variant.properties.type, { type: 'string', const: variant.properties.type.const });
      assert.deepEqual(Object.keys(variant.properties).slice(0, 6), ['type', 'title', 'goal', 'hand', 'bpm', 'mode']);
      assert.deepEqual(variant.properties.hand.enum, ['right', 'left', 'both']);
      assert.deepEqual(variant.properties.mode.enum, ['wait', 'tempo']);
      assert.equal(variant.properties.bpm.type, 'integer');
      assert.equal(variant.properties.title.type, 'string');
      assert.equal(variant.properties.goal.type, 'string');
    }
  });

  test('the variants list exactly the contract fields, in order', () => {
    const fields = Object.fromEntries(schema.anyOf.map((variant) => [variant.properties.type.const, Object.keys(variant.properties).slice(6)]));
    assert.deepEqual(fields, {
      scale: ['root', 'scale', 'octaves', 'direction', 'start_octave', 'note_beats'],
      arpeggio: ['root', 'quality', 'octaves', 'direction', 'start_octave', 'note_beats'],
      five_finger: ['root', 'quality', 'pattern', 'start_octave', 'note_beats'],
      chords: ['chords', 'style', 'voicing', 'start_octave', 'beats_per_chord'],
      custom: ['beats_per_bar', 'steps'],
    });
    const [scale, arpeggio, fiveFinger, chords, custom] = schema.anyOf.map((variant) => variant.properties);
    assert.deepEqual(scale.scale.enum, ['major', 'natural_minor', 'harmonic_minor', 'melodic_minor', 'major_pentatonic', 'minor_pentatonic', 'blues', 'chromatic']);
    assert.deepEqual(scale.octaves, { type: 'integer', enum: [1, 2], description: scale.octaves.description });
    assert.deepEqual(scale.direction.enum, ['up', 'down', 'up_down']);
    assert.equal(scale.start_octave.type, 'integer');
    assert.equal(scale.note_beats.type, 'number');
    assert.equal(scale.root.type, 'string');
    assert.deepEqual(arpeggio.quality.enum, ['major', 'minor', 'diminished', 'augmented', 'dominant7', 'major7', 'minor7']);
    assert.deepEqual(arpeggio.octaves.enum, [1, 2]);
    assert.deepEqual(fiveFinger.quality.enum, ['major', 'minor']);
    assert.deepEqual(fiveFinger.pattern.enum, ['up_down', 'thirds', 'triad']);
    assert.equal(chords.chords.type, 'array');
    assert.equal(chords.chords.items.type, 'string');
    assert.deepEqual(chords.style.enum, ['block', 'broken']);
    assert.deepEqual(chords.voicing.enum, ['root', 'smooth']);
    assert.equal(chords.beats_per_chord.type, 'number');
    assert.deepEqual(custom.beats_per_bar.enum, [2, 3, 4, 6]);
    assert.equal(custom.beats_per_bar.type, 'integer');
    assert.equal(custom.steps.type, 'array');
    const step = custom.steps.items;
    assert.deepEqual(Object.keys(step.properties), ['right', 'left', 'beats', 'right_fingers', 'left_fingers']);
    assert.deepEqual([step.properties.right.type, step.properties.right.items.type], ['array', 'string']);
    assert.deepEqual([step.properties.left.type, step.properties.left.items.type], ['array', 'string']);
    assert.equal(step.properties.beats.type, 'number');
    for (const field of ['right_fingers', 'left_fingers']) {
      assert.deepEqual(step.properties[field].anyOf, [{ type: 'array', items: { type: 'integer' } }, { type: 'null' }]);
    }
  });

  test('structural self-check: strict structured-output limits hold on every node', () => {
    let objects = 0;
    let nodes = 0;
    walkSchema(schema, (node, path) => {
      nodes += 1;
      assert.ok(node !== null && typeof node === 'object' && !Array.isArray(node), `${path} is a schema object`);
      for (const key of Object.keys(node)) {
        assert.ok(!FORBIDDEN_KEYWORDS.includes(key), `${path}: forbidden keyword ${key}`);
        assert.ok(ALLOWED_KEYWORDS.includes(key), `${path}: unexpected keyword ${key}`);
      }
      if ('anyOf' in node) {
        // A union may only carry annotations next to anyOf: no type, properties, items, enum, const.
        assert.deepEqual(Object.keys(node).filter((key) => key !== 'description').sort(), ['anyOf'], `${path}: anyOf stands alone`);
        assert.ok(Array.isArray(node.anyOf) && node.anyOf.length >= 2, `${path}: anyOf has branches`);
        return;
      }
      assert.equal(typeof node.type, 'string', `${path}: type is a single name, never a list`);
      assert.ok(BASIC_TYPES.includes(node.type), `${path}: type ${node.type}`);
      if (node.type === 'object') {
        objects += 1;
        assert.equal(node.additionalProperties, false, `${path}: additionalProperties must be false`);
        assert.ok(node.properties && Object.keys(node.properties).length > 0, `${path}: has properties`);
        assert.deepEqual(node.required, Object.keys(node.properties), `${path}: every property is required`);
      } else {
        for (const key of ['properties', 'required', 'additionalProperties']) assert.ok(!(key in node), `${path}: ${key} only on objects`);
      }
      if (node.type === 'array') assert.ok(node.items && typeof node.items === 'object', `${path}: arrays declare items`);
      else assert.ok(!('items' in node), `${path}: items only on arrays`);
      if ('enum' in node) {
        assert.ok(Array.isArray(node.enum) && node.enum.length >= 2, `${path}: enum has values`);
        for (const value of node.enum) assert.equal(typeof value, node.type === 'string' ? 'string' : 'number', `${path}: enum value type`);
        // Structured outputs do not guarantee the letter case of enum values: no two may differ by case only.
        const folded = node.enum.map((value) => String(value).toLowerCase());
        assert.equal(new Set(folded).size, folded.length, `${path}: enum values are distinct ignoring case`);
        assert.deepEqual(folded, node.enum.map(String), `${path}: enum values are lower case`);
      }
      if ('const' in node) assert.equal(typeof node.const, 'string', `${path}: const is a string`);
      if ('description' in node) assert.ok(typeof node.description === 'string' && node.description.length > 0, `${path}: description`);
    });
    assert.equal(objects, 6, 'five variants and the custom step');
    assert.ok(nodes > 50 && nodes < 120, `a small schema (${nodes} nodes)`);
  });

  test('stays inside the documented complexity limits', () => {
    let unions = 0;
    let optional = 0;
    walkSchema(schema, (node) => {
      if ('anyOf' in node || Array.isArray(node.type)) unions += 1;
      if (node.type === 'object') optional += Object.keys(node.properties).filter((key) => !node.required.includes(key)).length;
    });
    // Documented limits per request: 16 parameters with union types, 24 optional parameters.
    assert.equal(unions, 3, 'the variant union and the two nullable finger lists');
    assert.equal(optional, 0);
    assert.ok(JSON.stringify(schema).length < 16000);
  });

  test('no recursion and no shared nodes: the schema is a plain JSON tree', () => {
    const seen = new Set();
    const visit = (value, path) => {
      if (value === null || typeof value !== 'object') return;
      assert.ok(!seen.has(value), `${path} appears twice`);
      seen.add(value);
      assert.ok(Object.isFrozen(value), `${path} is frozen`);
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    };
    visit(schema, '$');
    assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema);
    assert.doesNotMatch(JSON.stringify(schema), /\$ref/);
    assert.equal(JSON.stringify(schema).includes(EM_DASH), false);
  });

  test('descriptions tell the model how to spell roots, octaves and notes', () => {
    const [scale, , , chords, custom] = schema.anyOf.map((variant) => variant.properties);
    assert.match(scale.root.description, /"F#".*"Bb"/);
    assert.match(scale.root.description, /no octave/);
    assert.match(scale.start_octave.description, /middle C \(C4\)/);
    assert.match(scale.start_octave.description, /one octave below/);
    assert.match(scale.bpm.description, /30 to 200/);
    assert.match(chords.chords.items.description, /"Am".*"G7"/);
    const step = custom.steps.items.properties;
    assert.match(step.right.items.description, /C4 = middle C/);
    assert.match(step.left.items.description, /C4 = middle C/);
    assert.match(step.right_fingers.description, /1 = thumb.*null/);
    assert.match(step.beats.description, /0\.25 to 8/);
    for (const variant of schema.anyOf) {
      assert.ok(variant.description.length > 0);
      for (const [key, property] of Object.entries(variant.properties)) {
        if (key !== 'type') assert.ok(typeof property.description === 'string' && property.description.length > 10, `${variant.properties.type.const}.${key}`);
      }
    }
  });

  test('complete specs conform to the schema and build', () => {
    const samples = [
      ...STARTER_EXERCISES,
      scaleSpec(), scaleSpec({ hand: 'both', root: 'F#', scale: 'blues', octaves: 2, direction: 'down', note_beats: 0.5 }),
      arpeggioSpec(), arpeggioSpec({ quality: 'minor7', hand: 'left', start_octave: 2 }),
      fiveFingerSpec(), fiveFingerSpec({ pattern: 'triad', quality: 'minor' }),
      chordsSpec(), chordsSpec({ hand: 'both', chords: ['Am', 'F/A', 'G7'], style: 'broken', voicing: 'smooth' }),
      customSpec([customStep(['C4', 'E4'], ['C3'], 2, [1, 3], [5]), customStep([], [], 1)]),
    ];
    for (const spec of samples) {
      assert.deepEqual(conforms(schema, spec), [], spec.title);
      const exercise = build(spec);
      assert.deepEqual(conforms(schema, JSON.parse(JSON.stringify(exercise.spec))), [], `normalized spec of ${spec.title}`);
    }
  });

  test('every enum value the schema offers is accepted by buildExercise', () => {
    const [scale, arpeggio, fiveFinger, chords, custom] = schema.anyOf.map((variant) => variant.properties);
    for (const hand of scale.hand.enum) {
      for (const mode of scale.mode.enum) build(scaleSpec({ hand, mode }));
    }
    for (const value of scale.scale.enum) build(scaleSpec({ scale: value }));
    for (const octaves of scale.octaves.enum) {
      for (const direction of scale.direction.enum) {
        build(scaleSpec({ octaves, direction }));
        build(arpeggioSpec({ octaves, direction }));
      }
    }
    for (const quality of arpeggio.quality.enum) build(arpeggioSpec({ quality }));
    for (const quality of fiveFinger.quality.enum) {
      for (const pattern of fiveFinger.pattern.enum) build(fiveFingerSpec({ quality, pattern }));
    }
    for (const style of chords.style.enum) {
      for (const voicing of chords.voicing.enum) {
        for (const hand of chords.hand.enum) build(chordsSpec({ style, voicing, hand }));
      }
    }
    for (const beatsPerBar of custom.beats_per_bar.enum) build(customSpec([customStep(['C4'])], { beats_per_bar: beatsPerBar }));
  });

  test('the schema checker used here does reject what it should', () => {
    assert.notDeepEqual(conforms(schema, { ...scaleSpec(), extra: 1 }), []);
    const missing = scaleSpec();
    delete missing.note_beats;
    assert.notDeepEqual(conforms(schema, missing), []);
    assert.notDeepEqual(conforms(schema, scaleSpec({ octaves: 3 })), []);
    assert.notDeepEqual(conforms(schema, scaleSpec({ bpm: 72.5 })), []);
    assert.notDeepEqual(conforms(schema, { ...scaleSpec(), type: 'etude' }), []);
    assert.notDeepEqual(conforms(schema, customSpec([{ right: ['C4'], left: [], beats: 1, right_fingers: [1] }])), []);
    assert.notDeepEqual(conforms(schema, customSpec([customStep(['C4'], [], 1, 'x')])), []);
    assert.notDeepEqual(conforms(schema, null), []);
  });
});

// ---------------------------------------------------------------- names and MIDI stay consistent everywhere

describe('names always spell their notes', () => {
  test('across all roots, scales, arpeggios and chords', () => {
    const roots = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B', 'Cb', 'E#', 'Fb', 'B#'];
    let builtCount = 0;
    const check = (spec) => {
      const result = buildExercise(spec);
      if (!result.ok) {
        // A rejection must explain itself; it is acceptable only for spellings needing triple accidentals.
        assert.ok(result.errors.every((message) => /triple accidentals/.test(message)), JSON.stringify(result.errors));
        return;
      }
      builtCount += 1;
      assert.deepEqual(validateExercise(result.exercise), []);
      for (const step of result.exercise.steps) {
        step.names.forEach((name, i) => assert.equal(nameToMidi(name), step.notes[i]));
        for (let i = 1; i < step.notes.length; i++) assert.ok(step.notes[i] > step.notes[i - 1]);
      }
    };
    for (const root of roots) {
      for (const scale of Object.keys(SCALE_INTERVALS)) {
        for (const hand of ['right', 'left', 'both']) check(scaleSpec({ root, scale, hand, octaves: 2 }));
      }
      for (const quality of ['major', 'minor', 'diminished', 'augmented', 'dominant7', 'major7', 'minor7']) {
        check(arpeggioSpec({ root, quality, hand: 'both' }));
      }
      for (const quality of ['major', 'minor']) check(fiveFingerSpec({ root, quality, hand: 'both', pattern: 'thirds' }));
      for (const voicing of ['root', 'smooth']) {
        for (const hand of ['right', 'left', 'both']) {
          check(chordsSpec({ chords: [root, `${root}m`, `${root}7`, `${root}maj7`, `${root}dim`, `${root}m7`], voicing, hand }));
        }
      }
    }
    assert.ok(builtCount > 700, `most combinations build (${builtCount})`);
  });
});
