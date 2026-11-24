import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  renderAttempt,
  renderChat,
  renderFreePlay,
  renderHint,
  renderNext,
  renderSessionStart,
} from '../shared/summary.js';
import { AttemptTracker, FreePlayAnalyzer } from '../shared/tracker.js';
import { buildExercise, describeExercise, STARTER_EXERCISES, withTempo } from '../shared/exercises.js';
import { midiToName } from '../shared/midi.js';

// ---------------------------------------------------------------- fixtures
// Hand-built Exercise and AttemptResult objects (the shapes of the build contract), so that the
// expected texts below depend only on summary.js.

function step(notes, { beats = 1, fingers = null, hands = null, names = null, label = null } = {}) {
  const made = {
    notes,
    names: names ?? notes.map((midi) => midiToName(midi)),
    fingers: fingers ?? notes.map(() => null),
    hands: hands ?? notes.map(() => 'R'),
    beats,
  };
  if (label) made.label = label;
  return made;
}

const SCALE_NOTES = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60];
const SCALE_FINGERS = [1, 2, 3, 1, 2, 3, 4, 5, 4, 3, 2, 1, 3, 2, 1];

const SCALE = {
  id: 'scale:C:major:right:1:up_down:4',
  title: 'C major scale, right hand',
  goal: 'Keep the thumb crossing smooth.',
  type: 'scale',
  hand: 'right',
  bpm: 60,
  mode: 'wait',
  beatsPerBar: 4,
  steps: SCALE_NOTES.map((midi, i) => step([midi], { fingers: [SCALE_FINGERS[i]] })),
  key: { tonic: 'C', mode: 'major' },
  spec: { type: 'scale', root: 'C', scale: 'major' },
};

const CHORDS = {
  id: 'chords:C-F-G-C',
  title: 'C, F and G chords',
  goal: 'Land all three notes together.',
  type: 'chords',
  hand: 'right',
  bpm: 60,
  mode: 'tempo',
  beatsPerBar: 4,
  steps: [
    step([60, 64, 67], { beats: 4, fingers: [1, 3, 5], label: 'C' }),
    step([60, 65, 69], { beats: 4, fingers: [1, 3, 5], label: 'F' }),
    step([59, 62, 67], { beats: 4, fingers: [1, 2, 5], label: 'G' }),
    step([60, 64, 67], { beats: 4, fingers: [1, 3, 5], label: 'C' }),
  ],
  key: { tonic: 'C', mode: 'major' },
  spec: { type: 'chords' },
};

const BOTH = {
  id: 'scale:F:major:both',
  title: 'F major, hands together',
  goal: 'Both hands land together.',
  type: 'scale',
  hand: 'both',
  bpm: 50,
  mode: 'wait',
  beatsPerBar: 4,
  steps: [
    step([53, 65], { hands: ['L', 'R'], fingers: [5, 1], names: ['F3', 'F4'] }),
    step([55, 67], { hands: ['L', 'R'], fingers: [4, 2], names: ['G3', 'G4'] }),
    step([57, 69], { hands: ['L', 'R'], fingers: [3, 3], names: ['A3', 'A4'] }),
    step([58, 70], { hands: ['L', 'R'], fingers: [2, 4], names: ['Bb3', 'Bb4'] }),
  ],
  key: { tonic: 'F', mode: 'major' },
  spec: { type: 'scale' },
};

/** AttemptResult.steps with sensible defaults and per-index overrides. */
function stepResults(count, overrides = {}, defaults = {}) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    state: 'ok',
    wrong: [],
    missed: [],
    ioiMs: index === 0 ? null : 1040,
    offsetMs: null,
    velocity: 64,
    chordSpreadMs: null,
    ...defaults,
    ...(overrides[index] ?? {}),
  }));
}

const WAIT_RESULT = {
  exerciseId: SCALE.id,
  mode: 'wait',
  bpm: 60,
  completed: true,
  durationMs: 16420,
  steps: stepResults(15, {
    3: { state: 'error', wrong: [64, 67] },
    8: { ioiMs: 2700 },
    12: { state: 'error', wrong: [65] },
  }),
  totals: { steps: 15, played: 15, clean: 13, wrongNotes: 3, missed: 0, extra: 0, accuracy: 0.8667 },
  timing: {
    estBpm: 57.7, evennessCv: 0.094, hesitations: [{ index: 8, factor: 2.6 }],
    meanOffsetMs: null, offsetSdMs: null, driftMsPerBeat: null,
  },
  dynamics: { mean: 64.3, sd: 9.2, min: 48, max: 82 },
  troubleSpots: [
    { index: 3, names: ['F4'], reason: 'wrong_notes' },
    { index: 12, names: ['E4'], reason: 'wrong_notes' },
    { index: 8, names: ['B4'], reason: 'hesitation' },
  ],
};

const WAIT_PREVIOUS = {
  exerciseId: SCALE.id,
  mode: 'wait',
  bpm: 60,
  completed: true,
  durationMs: 19800,
  steps: stepResults(15),
  totals: { steps: 15, played: 15, clean: 11, wrongNotes: 5, missed: 0, extra: 0, accuracy: 0.7333 },
  timing: {
    estBpm: 52.2, evennessCv: 0.151, hesitations: [{ index: 3, factor: 2.1 }, { index: 8, factor: 3 }],
    meanOffsetMs: null, offsetSdMs: null, driftMsPerBeat: null,
  },
  dynamics: { mean: 61, sd: 11, min: 40, max: 85 },
  troubleSpots: [],
};

const TEMPO_RESULT = {
  exerciseId: SCALE.id,
  mode: 'tempo',
  bpm: 72,
  completed: true,
  durationMs: 11960,
  steps: stepResults(15, {
    3: { offsetMs: 142.4 },
    6: { state: 'error', wrong: [70], offsetMs: 31 },
    9: { offsetMs: -128 },
    12: { state: 'missed', wrong: [65], missed: [64], offsetMs: null, velocity: null, ioiMs: null },
  }, { offsetMs: 30, ioiMs: 833 }),
  totals: { steps: 15, played: 14, clean: 13, wrongNotes: 2, missed: 1, extra: 1, accuracy: 0.8667 },
  timing: {
    estBpm: 71.6, evennessCv: 0.08, hesitations: [],
    meanOffsetMs: 34.4, offsetSdMs: 41.2, driftMsPerBeat: 2.83,
  },
  dynamics: { mean: 70.2, sd: 6.4, min: 58, max: 81 },
  troubleSpots: [
    { index: 12, names: ['E4'], reason: 'missed' },
    { index: 6, names: ['B4'], reason: 'wrong_notes' },
    { index: 3, names: ['F4'], reason: 'late' },
    { index: 9, names: ['A4'], reason: 'early' },
  ],
};

const TEMPO_PREVIOUS = {
  exerciseId: SCALE.id,
  mode: 'tempo',
  bpm: 72,
  completed: true,
  durationMs: 11960,
  steps: stepResults(15),
  totals: { steps: 15, played: 12, clean: 11, wrongNotes: 1, missed: 3, extra: 0, accuracy: 0.7333 },
  timing: { estBpm: 70, evennessCv: 0.12, hesitations: [], meanOffsetMs: 61.3, offsetSdMs: 55.5, driftMsPerBeat: 6.1 },
  dynamics: { mean: 66, sd: 8, min: 50, max: 80 },
  troubleSpots: [],
};

const EM_DASH = String.fromCharCode(0x2014);
const EVENT_TAG = /^\[event: (session_start|attempt|free_play|chat|hint|next)\]$/;

/** Checks every renderer output has to pass. */
function assertWellFormed(text, tag) {
  assert.equal(typeof text, 'string');
  const lines = text.split('\n');
  assert.match(lines[0], EVENT_TAG);
  if (tag) assert.equal(lines[0], `[event: ${tag}]`);
  assert.doesNotMatch(text, /undefined|NaN|null|Infinity|\[object/);
  assert.equal(text.includes(EM_DASH), false, 'em dash in the text');
  for (const l of lines) {
    assert.notEqual(l.trim(), '', `empty line in:\n${text}`);
    assert.doesNotMatch(l, /\|\s*$|:\s*\|| \| \| /, `dangling separator in: ${l}`);
  }
}

// ---------------------------------------------------------------- renderAttempt

describe('renderAttempt', () => {
  test('wait mode: exact text', () => {
    const text = renderAttempt({ exercise: SCALE, result: WAIT_RESULT, attemptNumber: 2, previous: WAIT_PREVIOUS });
    assert.equal(text, [
      '[event: attempt]',
      'Exercise: "C major scale, right hand" (right hand, 15 steps)',
      'Try 2 | wait mode, no metronome, suggested tempo 60 bpm',
      'Result: completed | 13 of 15 steps clean (87%) | wrong notes 3',
      'Timing (estimated from the gaps between notes): about 58 bpm | evenness 91% (100% = equal gaps) | 1 hesitation | took 16.4 s',
      'Loudness (MIDI velocity 1-127): mean 64 | spread (sd) 9 | softest 48 | loudest 82',
      'Trouble spots (worst first):',
      '- step 4, F4 (finger 1): wrong notes, pressed E4, G4 before the right key',
      '- step 13, E4 (finger 3): wrong notes, pressed F4 before the right key',
      '- step 9, B4 (finger 4): hesitation, 2.7 s gap before it (2.6x the usual)',
      'Change from the previous try: clean 73% -> 87% | wrong notes 5 -> 3 | pace 52 -> 58 bpm | evenness 85% -> 91% | hesitations 2 -> 1',
    ].join('\n'));
    assertWellFormed(text, 'attempt');
  });

  test('tempo mode: exact text', () => {
    const exercise = { ...SCALE, mode: 'tempo', bpm: 72 };
    const text = renderAttempt({ exercise, result: TEMPO_RESULT, attemptNumber: 3, previous: TEMPO_PREVIOUS });
    assert.equal(text, [
      '[event: attempt]',
      'Exercise: "C major scale, right hand" (right hand, 15 steps)',
      'Try 3 | tempo mode, metronome at 72 bpm',
      'Result: completed | 13 of 15 steps clean (87%) | wrong notes 2 | missed notes 1 | extra notes 1 (before the first step or after the last)',
      'Timing against the click: mean 34 ms late | spread (sd) 41 ms | drift +2.8 ms per beat (no clear trend)',
      'Loudness (MIDI velocity 1-127): mean 70 | spread (sd) 6 | softest 58 | loudest 81',
      'Trouble spots (worst first):',
      '- step 13, E4 (finger 3): missed, not played in time; played F4 instead',
      '- step 7, B4 (finger 4): wrong notes, also played A#4',
      '- step 4, F4 (finger 1): 142 ms late',
      '- step 10, A4 (finger 3): 128 ms early',
      'Change from the previous try: clean 73% -> 87% | wrong notes 1 -> 2 | missed notes 3 -> 1 | mean offset 61 ms late -> 34 ms late | spread 56 -> 41 ms',
    ].join('\n'));
    assertWellFormed(text, 'attempt');
  });

  test('a clean first try: no trouble spots and no change line', () => {
    const result = {
      ...WAIT_RESULT,
      steps: stepResults(15),
      totals: { steps: 15, played: 15, clean: 15, wrongNotes: 0, missed: 0, extra: 0, accuracy: 1 },
      timing: { ...WAIT_RESULT.timing, evennessCv: 0.04, hesitations: [] },
      troubleSpots: [],
    };
    const text = renderAttempt({ exercise: SCALE, result, attemptNumber: 1, previous: null });
    assert.equal(text, [
      '[event: attempt]',
      'Exercise: "C major scale, right hand" (right hand, 15 steps)',
      'Try 1 | wait mode, no metronome, suggested tempo 60 bpm',
      'Result: completed | 15 of 15 steps clean (100%) | wrong notes 0',
      'Timing (estimated from the gaps between notes): about 58 bpm | evenness 96% (100% = equal gaps) | 0 hesitations | took 16.4 s',
      'Loudness (MIDI velocity 1-127): mean 64 | spread (sd) 9 | softest 48 | loudest 82',
      'Trouble spots: none',
    ].join('\n'));
  });

  test('an abandoned wait-mode try says where it stopped', () => {
    const result = {
      ...WAIT_RESULT,
      completed: false,
      durationMs: 5200,
      steps: stepResults(15, {
        5: { state: 'current', wrong: [68, 70, 68], ioiMs: null, velocity: null },
        ...Object.fromEntries([6, 7, 8, 9, 10, 11, 12, 13, 14].map((i) => [i, { state: 'pending', ioiMs: null, velocity: null }])),
      }),
      totals: { steps: 15, played: 5, clean: 5, wrongNotes: 3, missed: 0, extra: 0, accuracy: 0.3333 },
      timing: { estBpm: 57.7, evennessCv: 0.05, hesitations: [], meanOffsetMs: null, offsetSdMs: null, driftMsPerBeat: null },
      troubleSpots: [{ index: 5, names: ['A4'], reason: 'wrong_notes' }],
    };
    const text = renderAttempt({ exercise: SCALE, result, attemptNumber: 4, previous: null });
    const lines = text.split('\n');
    assert.equal(lines[3], 'Result: not completed, stopped at step 6 of 15 | 5 of 15 steps clean (33%) | wrong notes 3');
    assert.equal(lines[7], '- step 6, A4 (finger 3): wrong notes, pressed G#4, A#4, G#4 and the attempt stopped here');
    assertWellFormed(text, 'attempt');
  });

  test('a try where nothing was played', () => {
    const result = {
      exerciseId: SCALE.id, mode: 'wait', bpm: 60, completed: false, durationMs: 0,
      steps: stepResults(15, { 0: { state: 'current' } }, { state: 'pending', ioiMs: null, velocity: null }),
      totals: { steps: 15, played: 0, clean: 0, wrongNotes: 0, missed: 0, extra: 0, accuracy: 0 },
      timing: { estBpm: null, evennessCv: null, hesitations: [], meanOffsetMs: null, offsetSdMs: null, driftMsPerBeat: null },
      dynamics: { mean: null, sd: null, min: null, max: null },
      troubleSpots: [],
    };
    const text = renderAttempt({ exercise: SCALE, result, attemptNumber: 1, previous: null });
    assert.equal(text, [
      '[event: attempt]',
      'Exercise: "C major scale, right hand" (right hand, 15 steps)',
      'Try 1 | wait mode, no metronome, suggested tempo 60 bpm',
      'Result: not completed, stopped at step 1 of 15 | no step was played | 0 of 15 steps clean (0%) | wrong notes 0',
      'Timing: too few notes to measure',
      'Trouble spots: none',
    ].join('\n'));
  });

  test('chords in tempo mode: a partly missed chord names the missing note', () => {
    const result = {
      exerciseId: CHORDS.id, mode: 'tempo', bpm: 60, completed: true, durationMs: 12300,
      steps: stepResults(4, {
        1: { state: 'error', missed: [65], offsetMs: 45, chordSpreadMs: 60 },
        2: { state: 'missed', missed: [59, 62, 67], offsetMs: null, velocity: null },
      }, { offsetMs: 12, chordSpreadMs: 18, ioiMs: 4000 }),
      totals: { steps: 4, played: 3, clean: 2, wrongNotes: 0, missed: 4, extra: 0, accuracy: 0.5 },
      timing: { estBpm: 60, evennessCv: null, hesitations: [], meanOffsetMs: 0.2, offsetSdMs: 20, driftMsPerBeat: -0.4 },
      dynamics: { mean: 55, sd: 4, min: 50, max: 62 },
      troubleSpots: [
        { index: 2, names: ['B3', 'D4', 'G4'], reason: 'missed' },
        { index: 1, names: ['C4', 'F4', 'A4'], reason: 'missed' },
      ],
    };
    const text = renderAttempt({ exercise: CHORDS, result, attemptNumber: 1, previous: null });
    assert.equal(text, [
      '[event: attempt]',
      'Exercise: "C, F and G chords" (right hand, 4 steps)',
      'Try 1 | tempo mode, metronome at 60 bpm',
      'Result: completed | 2 of 4 steps clean (50%) | wrong notes 0 | missed notes 4 | extra notes 0',
      'Timing against the click: mean 0 ms (on the click) | spread (sd) 20 ms | drift -0.4 ms per beat (too few notes to tell a trend)',
      'Loudness (MIDI velocity 1-127): mean 55 | spread (sd) 4 | softest 50 | loudest 62',
      'Trouble spots (worst first):',
      '- step 3, G = [B3 D4 G4] (fingers 1 2 5): missed, not played in time',
      '- step 2, F = [C4 F4 A4] (fingers 1 3 5): missed F4, the rest was hit',
    ].join('\n'));
  });

  test('the right key outside the timing window is reported as too late or too early, not as forgotten', () => {
    const result = {
      ...TEMPO_RESULT,
      steps: stepResults(15, {
        5: { state: 'missed', wrong: [69], missed: [69], offsetMs: null, velocity: null, ioiMs: null },
        9: { state: 'missed', wrong: [68, 69], missed: [69], offsetMs: null, velocity: null, ioiMs: null },
      }, { offsetMs: 10, ioiMs: 833 }),
      troubleSpots: [
        { index: 5, names: ['A4'], reason: 'late' },
        { index: 9, names: ['A4'], reason: 'early' },
      ],
    };
    const lines = renderAttempt({ exercise: SCALE, result, attemptNumber: 1 }).split('\n');
    assert.equal(lines[7], '- step 6, A4 (finger 3): played too late, outside the timing window (counted as missed)');
    assert.equal(lines[8], '- step 10, A4 (finger 3): played too early, outside the timing window (counted as missed); also played G#4');
  });

  test('drift wording follows the sign', () => {
    const drifting = (driftMsPerBeat, meanOffsetMs) => renderAttempt({
      exercise: SCALE,
      result: { ...TEMPO_RESULT, timing: { ...TEMPO_RESULT.timing, driftMsPerBeat, meanOffsetMs } },
    }).split('\n')[4];
    assert.equal(drifting(-3.3, -40.2), 'Timing against the click: mean 40 ms early | spread (sd) 41 ms | drift -3.3 ms per beat (getting further ahead)');
    assert.equal(drifting(0, 0), 'Timing against the click: mean 0 ms (on the click) | spread (sd) 41 ms | drift 0 ms per beat (no clear trend)');
    assert.equal(drifting(12, 90), 'Timing against the click: mean 90 ms late | spread (sd) 41 ms | drift +12 ms per beat (falling further behind)');
  });

  test('both-hands steps show which hand plays what, and wrong keys are spelled in the key of the exercise', () => {
    const result = {
      exerciseId: BOTH.id, mode: 'wait', bpm: 50, completed: true, durationMs: 6000,
      steps: stepResults(4, { 3: { state: 'error', wrong: [59, 71, 63], ioiMs: 3900 } }),
      totals: { steps: 4, played: 4, clean: 3, wrongNotes: 3, missed: 0, extra: 0, accuracy: 0.75 },
      timing: { estBpm: 57.7, evennessCv: 0.7, hesitations: [{ index: 3, factor: 3.75 }], meanOffsetMs: null, offsetSdMs: null, driftMsPerBeat: null },
      dynamics: { mean: 64, sd: 3, min: 60, max: 70 },
      troubleSpots: [{ index: 3, names: ['Bb3', 'Bb4'], reason: 'wrong_notes' }],
    };
    const text = renderAttempt({ exercise: BOTH, result, attemptNumber: 2, previous: null });
    const lines = text.split('\n');
    assert.equal(lines[1], 'Exercise: "F major, hands together" (both hands, 4 steps)');
    assert.equal(
      lines[7],
      '- step 4, L Bb3 (finger 2) + R Bb4 (finger 4): wrong notes, pressed B3, B4, Eb4 before the right key; 3.9 s gap before it (3.8x the usual)',
    );
  });

  test('a long list of wrong keys is cut, and unclean steps beyond the five trouble spots are listed by number', () => {
    const wrongOn = [1, 3, 5, 7, 9, 11, 13];
    const result = {
      ...WAIT_RESULT,
      steps: stepResults(15, Object.fromEntries(wrongOn.map((i) => [i, { state: 'error', wrong: i === 3 ? [50, 51, 52, 53, 54, 55, 56, 57, 58] : [61] }]))),
      totals: { steps: 15, played: 15, clean: 8, wrongNotes: 15, missed: 0, extra: 0, accuracy: 0.5333 },
      timing: { ...WAIT_RESULT.timing, hesitations: [] },
      troubleSpots: [3, 1, 5, 7, 9].map((index) => ({ index, names: [midiToName(SCALE_NOTES[index])], reason: 'wrong_notes' })),
    };
    const lines = renderAttempt({ exercise: SCALE, result, attemptNumber: 1 }).split('\n');
    assert.equal(lines[7], '- step 4, F4 (finger 1): wrong notes, pressed D3, D#3, E3, F3, F#3, G3 and 3 more before the right key');
    assert.equal(lines[12], 'Other steps not clean: 12, 14');
    assert.equal(lines.length, 13);
  });

  test('the change line says when the previous try was in another mode or tempo, or was not completed', () => {
    const tempoNow = renderAttempt({ exercise: SCALE, result: TEMPO_RESULT, attemptNumber: 3, previous: WAIT_PREVIOUS });
    assert.equal(
      tempoNow.split('\n').at(-1),
      'Change from the previous try: clean 73% -> 87% | wrong notes 5 -> 2 (previous try was wait mode, no metronome, suggested tempo 60 bpm)',
    );
    const faster = renderAttempt({
      exercise: SCALE, result: TEMPO_RESULT, attemptNumber: 3, previous: { ...TEMPO_PREVIOUS, bpm: 66, completed: false },
    });
    assert.match(faster.split('\n').at(-1), / \(previous try was tempo mode, metronome at 66 bpm; previous try was not completed\)$/);
  });

  test('works without the exercise: trouble spots fall back to the names in the result', () => {
    const text = renderAttempt({ exercise: null, result: WAIT_RESULT, attemptNumber: 2, previous: null });
    const lines = text.split('\n');
    assert.equal(lines[1], 'Exercise: "untitled exercise"');
    assert.equal(lines[2], 'Try 2 | wait mode, no metronome, suggested tempo 60 bpm');
    assert.equal(lines[7], '- step 4, F4: wrong notes, pressed E4, G4 before the right key');
    assertWellFormed(text, 'attempt');
  });

  test('stays compact: a typical attempt is well under 500 tokens', () => {
    const text = renderAttempt({ exercise: SCALE, result: TEMPO_RESULT, attemptNumber: 3, previous: TEMPO_PREVIOUS });
    assert.ok(text.length < 1500, `${text.length} characters`); // about 4 characters per token
  });
});

// ---------------------------------------------------------------- the other renderers

describe('renderSessionStart', () => {
  test('exact text with a loaded exercise', () => {
    const text = renderSessionStart({
      profile: { name: 'Sam', level: 'beginner', goals: 'Play simple songs with both hands', about: 'Played a little as a child' },
      notes: 'Hesitates at the thumb crossing in the right hand.\nComfortable at 60 bpm.',
      progress: {
        sessions: 3,
        minutes: 42,
        lastPracticed: '2026-11-20',
        recent: ['C major scale, right hand: 93% clean at about 66 bpm', 'C five-finger pattern, right hand: 100% clean at about 72 bpm'],
      },
      exercise: SCALE,
    });
    assert.equal(text, [
      '[event: session_start]',
      'Learner: Sam | level: beginner | goals: Play simple songs with both hands | about: Played a little as a child',
      'Your notes from earlier sessions: Hesitates at the thumb crossing in the right hand. Comfortable at 60 bpm.',
      'Progress: 3 sessions | 42 minutes practiced | last practiced 2026-11-20',
      'Recent results, newest first:',
      '- C major scale, right hand: 93% clean at about 66 bpm',
      '- C five-finger pattern, right hand: 100% clean at about 72 bpm',
      `Exercise loaded: ${describeExercise(SCALE)}`,
    ].join('\n'));
    assert.match(text, /1:C4\(1\)/); // the step list from describeExercise is in there
    assertWellFormed(text, 'session_start');
  });

  test('a brand new learner', () => {
    const text = renderSessionStart({
      profile: { level: 'beginner', goals: '' },
      notes: '',
      progress: { sessions: 1, minutes: 0, lastPracticed: null, recent: [] },
      exercise: null,
    });
    assert.equal(text, [
      '[event: session_start]',
      'Learner: level: beginner',
      'Your notes from earlier sessions: none yet',
      'Progress: 1 session | 0 minutes practiced',
      'Exercise loaded: none',
    ].join('\n'));
  });

  test('an exercise that describeExercise cannot handle still gets a line', () => {
    const text = renderSessionStart({ profile: null, notes: null, progress: null, exercise: { title: 'Odd one', steps: 'broken', bpm: 80, mode: 'tempo' } });
    assertWellFormed(text, 'session_start');
    assert.match(text.split('\n').at(-1), /^Exercise loaded: .*Odd one/);
  });

  test('only the eight newest results are shown', () => {
    const recent = Array.from({ length: 12 }, (_, i) => `Result ${i + 1}`);
    const lines = renderSessionStart({ profile: { level: 'x' }, notes: '', progress: { sessions: 2, minutes: 5, recent }, exercise: null }).split('\n');
    assert.equal(lines.filter((l) => l.startsWith('- ')).length, 8);
    assert.ok(lines.includes('- Result 8'));
    assert.ok(!lines.includes('- Result 9'));
  });
});

describe('renderFreePlay', () => {
  const PHRASE = {
    startMs: 123456,
    durationMs: 6240,
    noteCount: 11,
    notes: [
      { midi: 67, name: 'G4', onMs: 0, durMs: 450, velocity: 60 },
      { midi: 69, name: 'A4', onMs: 500, durMs: 440, velocity: 64 },
      { midi: 71, name: 'B4', onMs: 1000, durMs: 460, velocity: 70 },
      { midi: 74, name: 'D5', onMs: 1500, durMs: 950, velocity: 76 },
      { midi: 78, name: 'F#5', onMs: 2500, durMs: 240, velocity: 72 },
      { midi: 79, name: 'G5', onMs: 2750, durMs: 230, velocity: 80 },
      { midi: 55, name: 'G3', onMs: 3000, durMs: 1400, velocity: 58 },
      { midi: 59, name: 'B3', onMs: 3012, durMs: 1380, velocity: 55 },
      { midi: 62, name: 'D4', onMs: 3020, durMs: 1390, velocity: 57 },
      { midi: 74, name: 'D5', onMs: 3500, durMs: 480, velocity: 66 },
      { midi: 67, name: 'G4', onMs: 4500, durMs: 1740, velocity: 52 },
    ],
    range: { low: 55, high: 79 },
    chords: [{ name: 'G', atMs: 3000 }],
    key: { tonic: 'G', mode: 'major', confidence: 0.72 },
    tempo: { bpm: 120, confidence: 0.84 },
    evennessCv: 0.062,
    dynamics: { mean: 64.5, sd: 8.7, min: 52, max: 80 },
    maxPolyphony: 3,
    pedalUsed: true,
  };

  test('exact text', () => {
    const text = renderFreePlay({ phrase: PHRASE });
    assert.equal(text, [
      '[event: free_play]',
      'Phrase: 6.2 s | 11 notes | range G3 to G5 | up to 3 notes at once | sustain pedal used',
      'Key guess: G major (confidence 0.72 of 1)',
      'Tempo guess: about 120 bpm (the most common gap counted as one beat, could be double or half, confidence 0.84 of 1)',
      'Evenness of single notes: 94% (100% = perfectly steady)',
      'Loudness (MIDI velocity 1-127): mean 65 | spread (sd) 9 | softest 52 | loudest 80',
      'Chords in order: G',
      'Notes in order (name:seconds held, [ ] = struck together): G4:0.5 A4:0.4 B4:0.5 D5:1.0 F#5:0.2 G5:0.2 [G3 B3 D4]:1.4 D5:0.5 G4:1.7',
    ].join('\n'));
    assertWellFormed(text, 'free_play');
  });

  test('a short unclear phrase', () => {
    const text = renderFreePlay({
      phrase: {
        ...PHRASE, noteCount: 4, notes: PHRASE.notes.slice(0, 4), durationMs: 2450, range: { low: 67, high: 74 },
        chords: [], key: null, tempo: null, evennessCv: null, maxPolyphony: 1, pedalUsed: false,
      },
    });
    assert.equal(text, [
      '[event: free_play]',
      'Phrase: 2.5 s | 4 notes | range G4 to D5 | up to 1 note at once | no sustain pedal',
      'Key guess: none (too few notes or unclear)',
      'Tempo guess: none (too few notes)',
      'Loudness (MIDI velocity 1-127): mean 65 | spread (sd) 9 | softest 52 | loudest 80',
      'Chords in order: none detected',
      'Notes in order (name:seconds held, [ ] = struck together): G4:0.5 A4:0.4 B4:0.5 D5:1.0',
    ].join('\n'));
  });

  test('long phrases show about the last 60 notes with a marker for the rest', () => {
    const notes = Array.from({ length: 150 }, (_, i) => ({
      midi: 60 + (i % 12), name: midiToName(60 + (i % 12)), onMs: i * 200, durMs: 150, velocity: 64,
    }));
    const text = renderFreePlay({ phrase: { ...PHRASE, noteCount: 150, notes, chords: [] } });
    const last = text.split('\n').at(-1);
    assert.ok(last.includes(': (first 90 omitted) F#4:0.2 G4:0.2 '), last);
    assert.equal(last.split(' omitted) ')[1].split(' ').length, 60);
    assert.ok(last.endsWith(' E4:0.2 F4:0.2'));
    assertWellFormed(text, 'free_play');
  });

  test('a real phrase from FreePlayAnalyzer renders cleanly', () => {
    const analyzer = new FreePlayAnalyzer();
    let t = 0;
    for (const midi of [65, 67, 69, 70, 72, 74, 76, 77, 76, 74, 72, 70, 69, 67, 65]) {
      analyzer.noteOn(midi, 70, t);
      analyzer.noteOff(midi, t + 300);
      t += 400;
    }
    const text = renderFreePlay({ phrase: analyzer.tick(t + 5000) });
    assertWellFormed(text, 'free_play');
    const lines = text.split('\n');
    assert.equal(lines[1], 'Phrase: 5.9 s | 15 notes | range F4 to F5 | up to 1 note at once | no sustain pedal');
    assert.match(lines[2], /^Key guess: F major \(confidence \d\.\d\d of 1\)$/);
    assert.match(lines[3], /^Tempo guess: about 150 bpm /);
    assert.equal(lines[4], 'Evenness of single notes: 100% (100% = perfectly steady)');
    assert.match(lines.at(-1), / Bb4:0\.3 /);
  });
});

describe('renderChat', () => {
  test('during an attempt', () => {
    const text = renderChat({
      text: 'Why do I keep  missing the F?\nIs it my "thumb"?',
      exercise: SCALE,
      trackerState: { stepIndex: 4, steps: 15 },
    });
    assert.equal(text, [
      '[event: chat]',
      'Learner says: "Why do I keep missing the F? Is it my "thumb"?"',
      'Context: exercise "C major scale, right hand" (right hand, 15 steps) on screen | wait mode, no metronome, suggested tempo 60 bpm | attempt in progress, on step 5 of 15',
    ].join('\n'));
    assertWellFormed(text, 'chat');
  });

  test('between attempts, and with no exercise on screen', () => {
    assert.equal(renderChat({ text: 'Can I try something harder?', exercise: { ...SCALE, mode: 'tempo', bpm: 84 }, trackerState: null }), [
      '[event: chat]',
      'Learner says: "Can I try something harder?"',
      'Context: exercise "C major scale, right hand" (right hand, 15 steps) on screen | tempo mode, metronome at 84 bpm | no attempt in progress',
    ].join('\n'));
    assert.equal(renderChat({ text: 'What chord was that?', exercise: null, trackerState: null }), [
      '[event: chat]',
      'Learner says: "What chord was that?"',
      'Context: no exercise on screen',
    ].join('\n'));
  });

  test('very long messages are cut and an empty one is marked', () => {
    const long = renderChat({ text: 'la '.repeat(2000), exercise: null, trackerState: null });
    assert.ok(long.length < 2200);
    assert.match(long.split('\n')[1], /\.\.\."$/);
    assert.equal(renderChat({ text: '   ', exercise: null }).split('\n')[1], 'Learner says: (empty message)');
  });
});

describe('renderHint', () => {
  test('exact text: the step, the step before it, the wrong keys and the idle time', () => {
    const text = renderHint({ exercise: SCALE, stepIndex: 3, wrongNotes: [64, 67, 66], idleMs: 6400 });
    assert.equal(text, [
      '[event: hint]',
      'Exercise: "C major scale, right hand" (right hand, 15 steps) | wait mode, no metronome, suggested tempo 60 bpm',
      'Stuck on step 4 of 15: F4 (finger 1)',
      'Step before it (3): E4 (finger 3) | from there: up 1 semitone (minor 2nd)',
      'Wrong keys pressed on this step so far: E4, G4, F#4',
      'No key pressed for 6 s',
    ].join('\n'));
    assertWellFormed(text, 'hint');
  });

  test('the first step, going down, and a repeated key', () => {
    assert.equal(renderHint({ exercise: SCALE, stepIndex: 0, wrongNotes: [], idleMs: 0 }), [
      '[event: hint]',
      'Exercise: "C major scale, right hand" (right hand, 15 steps) | wait mode, no metronome, suggested tempo 60 bpm',
      'Stuck on step 1 of 15: C4 (finger 1)',
      'Step before it: none, this is the first note',
      'Wrong keys pressed on this step so far: none',
    ].join('\n'));
    assert.equal(
      renderHint({ exercise: SCALE, stepIndex: 11, wrongNotes: [], idleMs: 900 }).split('\n')[3],
      'Step before it (11): G4 (finger 2) | from there: down 2 semitones (major 2nd)',
    );
    const repeated = { ...SCALE, steps: [step([64]), step([64])] };
    assert.equal(renderHint({ exercise: repeated, stepIndex: 1 }).split('\n')[3], 'Step before it (1): E4 | the same key again');
  });

  test('chords and both-hands steps', () => {
    assert.deepEqual(renderHint({ exercise: CHORDS, stepIndex: 1, wrongNotes: [62], idleMs: 2500 }).split('\n').slice(2), [
      'Stuck on step 2 of 4: F = [C4 F4 A4] (fingers 1 3 5)',
      'Step before it (1): C = [C4 E4 G4] (fingers 1 3 5)',
      'Wrong keys pressed on this step so far: D4',
      'No key pressed for 3 s',
    ]);
    assert.deepEqual(renderHint({ exercise: BOTH, stepIndex: 3, wrongNotes: [70, 46], idleMs: 12000 }).split('\n').slice(2), [
      'Stuck on step 4 of 4: L Bb3 (finger 2) + R Bb4 (finger 4)',
      'Step before it (3): L A3 (finger 3) + R A4 (finger 3)',
      'Wrong keys pressed on this step so far: Bb4, Bb2',
      'No key pressed for 12 s',
    ]);
  });

  test('rests before the step are skipped, unknown fingers are left out', () => {
    const exercise = { ...SCALE, steps: [step([60]), step([]), step([67, 72], { fingers: [1, null] })] };
    assert.deepEqual(renderHint({ exercise, stepIndex: 2, wrongNotes: [] }).split('\n').slice(2, 4), [
      'Stuck on step 3 of 3: [G4 C5] (fingers 1 ?)',
      'Step before it (1): C4',
    ]);
  });

  test('no current step (the attempt just finished)', () => {
    const text = renderHint({ exercise: SCALE, stepIndex: 15, wrongNotes: [], idleMs: 200 });
    assert.equal(text.split('\n')[2], 'Stuck on: no current step (the attempt is over or has not started)');
    assertWellFormed(text, 'hint');
  });
});

describe('renderNext', () => {
  test('exact text', () => {
    assert.equal(renderNext({ exercise: SCALE, reason: 'The learner pressed "Next exercise".' }), [
      '[event: next]',
      'Reason: The learner pressed "Next exercise".',
      'Current exercise: "C major scale, right hand" (right hand, 15 steps) | wait mode, no metronome, suggested tempo 60 bpm',
    ].join('\n'));
    assert.equal(renderNext({ exercise: null, reason: '' }), [
      '[event: next]',
      'Reason: the learner asked for a new exercise',
      'Current exercise: none',
    ].join('\n'));
  });
});

// ---------------------------------------------------------------- robustness

describe('sparse and malformed input', () => {
  const junk = [undefined, null, {}, [], 0, NaN, '', 'text', { steps: null }, { steps: [null, {}, { notes: [NaN, 'x', 999] }] }];
  const sparseResult = {
    exerciseId: undefined,
    mode: null,
    bpm: NaN,
    completed: undefined,
    durationMs: NaN,
    steps: [null, {}, { index: 2, state: 'error', wrong: [NaN, null, 300, 61], missed: null, ioiMs: NaN, offsetMs: undefined }],
    totals: { steps: NaN, played: null, clean: undefined, wrongNotes: NaN, missed: null, extra: undefined, accuracy: NaN },
    timing: { estBpm: NaN, evennessCv: null, hesitations: [null, { index: NaN, factor: NaN }], meanOffsetMs: undefined, offsetSdMs: NaN, driftMsPerBeat: null },
    dynamics: { mean: NaN, sd: null, min: undefined, max: NaN },
    troubleSpots: [null, {}, { index: NaN }, { index: 2, names: [null, undefined], reason: 'wrong_notes' }, { index: 7, names: null, reason: 'late' },
      { index: 1, reason: 'missed' }, { index: 0, reason: 'hesitation' }, { index: 5, reason: 'something_new' }],
  };

  test('renderAttempt never throws and never prints a placeholder', () => {
    for (const exercise of [...junk, SCALE]) {
      for (const result of [...junk, sparseResult, { ...sparseResult, mode: 'tempo' }, { ...WAIT_RESULT, timing: null, totals: null, dynamics: null }]) {
        for (const previous of [undefined, null, {}, sparseResult, WAIT_PREVIOUS]) {
          for (const attemptNumber of [undefined, null, NaN, 0, 3]) {
            assertWellFormed(renderAttempt({ exercise, result, attemptNumber, previous }), 'attempt');
          }
        }
      }
    }
    assertWellFormed(renderAttempt(), 'attempt');
    assertWellFormed(renderAttempt(null), 'attempt');
  });

  test('renderSessionStart', () => {
    for (const profile of [...junk, { name: null, level: undefined, goals: NaN, about: 7 }]) {
      for (const progress of [...junk, { sessions: NaN, minutes: null, lastPracticed: undefined, recent: [null, undefined, NaN, '', 'ok'] }]) {
        for (const exercise of [...junk, SCALE]) {
          assertWellFormed(renderSessionStart({ profile, notes: profile, progress, exercise }), 'session_start');
        }
      }
    }
    assertWellFormed(renderSessionStart(), 'session_start');
  });

  test('renderFreePlay', () => {
    const sparsePhrase = {
      startMs: NaN, durationMs: null, noteCount: undefined,
      notes: [null, {}, { midi: NaN }, { midi: 60, name: null, onMs: NaN, durMs: undefined, velocity: null }],
      range: { low: null, high: NaN }, chords: [null, {}, { name: undefined }], key: { tonic: null, mode: undefined, confidence: NaN },
      tempo: { bpm: NaN, confidence: null }, evennessCv: NaN, dynamics: { mean: null }, maxPolyphony: NaN, pedalUsed: undefined,
    };
    for (const phrase of [...junk, sparsePhrase, { ...sparsePhrase, key: { tonic: 'G', mode: 'major' }, tempo: { bpm: 100 }, range: { low: Infinity, high: -Infinity } }]) {
      assertWellFormed(renderFreePlay({ phrase }), 'free_play');
    }
    assertWellFormed(renderFreePlay(), 'free_play');
  });

  test('renderChat, renderHint and renderNext', () => {
    for (const exercise of [...junk, SCALE]) {
      for (const other of junk) {
        assertWellFormed(renderChat({ text: other, exercise, trackerState: other }), 'chat');
        assertWellFormed(renderChat({ text: 'hi', exercise, trackerState: { stepIndex: other, steps: other } }), 'chat');
        assertWellFormed(renderHint({ exercise, stepIndex: other, wrongNotes: other, idleMs: other }), 'hint');
        assertWellFormed(renderHint({ exercise, stepIndex: 2, wrongNotes: [other, 61, 400, -1], idleMs: 5000 }), 'hint');
        assertWellFormed(renderNext({ exercise, reason: other }), 'next');
      }
    }
    assertWellFormed(renderChat(), 'chat');
    assertWellFormed(renderHint(), 'hint');
    assertWellFormed(renderNext(), 'next');
  });
});

// ---------------------------------------------------------------- with the real modules

describe('tracker results rendered for the starter exercises', () => {
  const built = STARTER_EXERCISES.map((spec) => buildExercise(spec));

  test('every starter exercise builds', () => {
    assert.ok(built.length >= 10);
    for (const b of built) assert.equal(b.ok, true);
  });

  test('a slightly messy wait-mode run of each starter exercise renders cleanly', () => {
    for (const { exercise } of built) {
      const tracker = new AttemptTracker(exercise, { mode: 'wait' });
      let t = 1000;
      exercise.steps.forEach((s, i) => {
        if (i % 4 === 2 && s.notes.length) {
          tracker.noteOn(s.notes[0] + 1, 70, (t += 300)); // a wrong neighbor key first
          tracker.noteOff(s.notes[0] + 1, t + 80);
        }
        t += i === 5 ? 2600 : 600 * s.beats;
        s.notes.forEach((midi, k) => tracker.noteOn(midi, 60 + ((i * 7 + k) % 30), t + k * 8));
        s.notes.forEach((midi) => tracker.noteOff(midi, t + 200));
      });
      assert.equal(tracker.finished, true, exercise.title);
      const result = tracker.result();
      const text = renderAttempt({ exercise, result, attemptNumber: 1, previous: null });
      assertWellFormed(text, 'attempt');
      assert.ok(text.length < 2000, `${exercise.title}: ${text.length} characters`);
      assert.match(text, /Result: completed \| \d+ of \d+ steps clean \(\d+%\) \| wrong notes \d+/);
      for (const match of text.matchAll(/^- step (\d+),/gm)) {
        const n = Number(match[1]);
        assert.ok(n >= 1 && n <= exercise.steps.length, `step ${n} of ${exercise.steps.length}`);
      }
      // The same run again gives a change line with no change.
      const again = renderAttempt({ exercise, result, attemptNumber: 2, previous: result });
      assert.match(again, /\nChange from the previous try: clean (\d+%) -> \1 \| wrong notes (\d+) -> \2/);
      // Hints for every step.
      exercise.steps.forEach((_, i) => assertWellFormed(renderHint({ exercise, stepIndex: i, wrongNotes: [61], idleMs: 4000 }), 'hint'));
      assertWellFormed(renderSessionStart({ profile: { level: 'beginner' }, notes: '', progress: null, exercise }), 'session_start');
    }
  });

  test('a tempo-mode run of each starter exercise renders cleanly', () => {
    for (const { exercise: base } of built) {
      const exercise = withTempo(base, { bpm: 72, mode: 'tempo' });
      const tracker = new AttemptTracker(exercise);
      const beatMs = 60000 / exercise.bpm;
      tracker.start(5000);
      let beat = 0;
      exercise.steps.forEach((s, i) => {
        const due = 5000 + beat * beatMs;
        beat += s.beats;
        tracker.tick(due - 10);
        if (i % 6 === 4) return; // skip a step now and then
        s.notes.forEach((midi, k) => tracker.noteOn(midi, 64, due + ((i * 37) % 90) - 30 + k * 5));
      });
      tracker.tick(5000 + (beat + 4) * beatMs);
      assert.equal(tracker.finished, true, exercise.title);
      const text = renderAttempt({ exercise, result: tracker.result(), attemptNumber: 2, previous: null });
      assertWellFormed(text, 'attempt');
      assert.match(text, /\nTry 2 \| tempo mode, metronome at 72 bpm\n/);
      assert.match(text, /\nTiming against the click: mean \d+ ms/);
      assert.match(text, /missed notes \d+ \| extra notes 0/);
    }
  });

  // The two examples below are the ones quoted in the README: real tracker runs, exact text.
  const scale = () => buildExercise(STARTER_EXERCISES.find((spec) => spec.title === 'C major scale, right hand')).exercise;

  /** Wait mode: script entries are [midi, ms since the previous key, velocity]. */
  function waitRun(exercise, script) {
    const tracker = new AttemptTracker(exercise);
    let t = 1000;
    for (const [midi, gap, velocity] of script) {
      t += gap;
      tracker.noteOn(midi, velocity, t);
      tracker.noteOff(midi, t + 120);
    }
    return tracker.result();
  }

  test('the realistic wait-mode example: two wrong notes at the thumb crossing, one hesitation', () => {
    const exercise = scale();
    const notes = exercise.steps.map((s) => s.notes[0]);
    // First try: slower, wrong keys before steps 4 and 13.
    const first = [];
    notes.forEach((midi, i) => {
      if (i === 3) first.push([64, 900, 60], [67, 500, 62]);
      if (i === 12) first.push([65, 700, 58]);
      first.push([midi, i === 0 ? 0 : [1150, 1090, 1210, 1120][i % 4], 55 + ((i * 7) % 20)]);
    });
    // Second try: E and G before the F of step 4 (the thumb crossing), a long wait before step 9.
    const second = [];
    notes.forEach((midi, i) => {
      if (i === 3) second.push([64, 700, 71], [67, 450, 66]);
      const gap = i === 0 ? 0 : i === 3 ? 600 : i === 8 ? 2350 : [1010, 960, 1050, 990][i % 4];
      second.push([midi, gap, 58 + ((i * 11) % 24)]);
    });
    const previous = waitRun(exercise, first);
    const text = renderAttempt({ exercise, result: waitRun(exercise, second), attemptNumber: 2, previous });
    assert.equal(text, [
      '[event: attempt]',
      'Exercise: "C major scale, right hand" (right hand, 15 steps)',
      'Try 2 | wait mode, no metronome, suggested tempo 60 bpm',
      'Result: completed | 14 of 15 steps clean (93%) | wrong notes 2',
      'Timing (estimated from the gaps between notes): about 59 bpm | evenness 81% (100% = equal gaps) | 1 hesitation | took 16.1 s',
      'Loudness (MIDI velocity 1-127): mean 69 | spread (sd) 7 | softest 58 | loudest 81',
      'Trouble spots (worst first):',
      '- step 4, F4 (finger 1): wrong notes, pressed E4, G4 before the right key',
      '- step 9, B4 (finger 4): hesitation, 2.4 s gap before it (2.3x the usual)',
      'Change from the previous try: clean 87% -> 93% | wrong notes 3 -> 2 | pace 52 -> 59 bpm | evenness 84% -> 81% | hesitations 1 -> 1',
    ].join('\n'));
    assertWellFormed(text, 'attempt');
  });

  test('the realistic tempo-mode example: dragging behind the click, one wrong key', () => {
    const exercise = withTempo(scale(), { bpm: 72, mode: 'tempo' });
    const notes = exercise.steps.map((s) => s.notes[0]);
    const beatMs = 60000 / 72;
    /** offsets: ms after the click for each step. skip: steps not played. wrongAt: a wrong key played instead. */
    const tempoRun = (offsets, { skip = [], wrongAt = {} } = {}) => {
      const tracker = new AttemptTracker(exercise);
      tracker.start(20000);
      notes.forEach((midi, i) => {
        const t = 20000 + i * beatMs + offsets[i];
        tracker.tick(t - 1);
        if (wrongAt[i]) tracker.noteOn(wrongAt[i], 60, t);
        if (!skip.includes(i)) {
          tracker.noteOn(midi, 60 + ((i * 5) % 18), t);
          tracker.noteOff(midi, t + 300);
        }
      });
      tracker.tick(20000 + 16 * beatMs);
      return tracker.result();
    };
    const previous = tempoRun([10, 35, 60, 95, 70, 110, 140, 150, 120, 160, 150, 190, 170, 180, 210], { skip: [7, 11] });
    const result = tempoRun([-12, 8, 25, 140, 30, 22, 48, 61, 40, 55, 72, 66, 58, 90, 84], { skip: [12], wrongAt: { 12: 65 } });
    assert.equal(result.completed, true);
    const text = renderAttempt({ exercise, result, attemptNumber: 3, previous });
    assert.equal(text, [
      '[event: attempt]',
      'Exercise: "C major scale, right hand" (right hand, 15 steps)',
      'Try 3 | tempo mode, metronome at 72 bpm',
      'Result: completed | 14 of 15 steps clean (93%) | wrong notes 1 | missed notes 1 | extra notes 0',
      'Timing against the click: mean 52 ms late | spread (sd) 37 ms | drift +4.7 ms per beat (falling further behind)',
      'Loudness (MIDI velocity 1-127): mean 69 | spread (sd) 6 | softest 60 | loudest 77',
      'Trouble spots (worst first):',
      '- step 13, E4 (finger 3): missed, not played in time; played F4 instead',
      '- step 4, F4 (finger 1): 140 ms late',
      'Change from the previous try: clean 87% -> 93% | wrong notes 0 -> 1 | missed notes 2 -> 1 | mean offset 116 ms late -> 52 ms late | spread 58 -> 37 ms',
    ].join('\n'));
    assertWellFormed(text, 'attempt');
  });
});

describe('house rules', () => {
  test('no em dash in the module sources', () => {
    for (const file of ['../shared/tracker.js', '../shared/summary.js', './tracker.test.js', './summary.test.js']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      assert.equal(source.includes(EM_DASH), false, file);
    }
  });
});
