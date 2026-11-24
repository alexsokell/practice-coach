import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { AttemptTracker, FreePlayAnalyzer } from '../shared/tracker.js';
import { midiToName } from '../shared/midi.js';

// ---------------------------------------------------------------- fixtures
// Exercises are built by hand here, following the Exercise and Step typedefs of the build
// contract, so that these tests do not depend on shared/exercises.js.

/** One Step. notes are MIDI numbers; everything is in the right hand unless hands is given. */
function step(notes, { beats = 1, fingers = null, hands = null, label = null } = {}) {
  const sorted = [...notes].sort((a, b) => a - b);
  const made = {
    notes: sorted,
    names: sorted.map((midi) => midiToName(midi)),
    fingers: fingers ?? sorted.map(() => null),
    hands: hands ?? sorted.map(() => 'R'),
    beats,
  };
  if (label) made.label = label;
  return made;
}

function exercise(steps, overrides = {}) {
  return {
    id: 'test:exercise',
    title: 'Test exercise',
    goal: 'Play it cleanly.',
    type: 'custom',
    hand: 'right',
    bpm: 60,
    mode: 'wait',
    beatsPerBar: 4,
    steps,
    key: null,
    spec: { type: 'custom' },
    ...overrides,
  };
}

const SCALE_NOTES = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60];
const SCALE_FINGERS = [1, 2, 3, 1, 2, 3, 4, 5, 4, 3, 2, 1, 3, 2, 1];

/** C major scale, right hand, one octave up and down: 15 single-note steps of one beat. */
function scaleExercise(overrides = {}) {
  return exercise(
    SCALE_NOTES.map((midi, i) => step([midi], { fingers: [SCALE_FINGERS[i]] })),
    { id: 'scale:C:major:right:1:up_down:4', title: 'C major scale, right hand', type: 'scale', key: { tonic: 'C', mode: 'major' }, ...overrides },
  );
}

/** Single-note steps from a list of MIDI numbers. */
function melody(notes, overrides = {}) {
  return exercise(notes.map((midi) => step([midi])), overrides);
}

/** Press and release one key. Returns what noteOn said. */
function tap(tracker, midi, timeMs, { velocity = 64, hold = 200 } = {}) {
  const judged = tracker.noteOn(midi, velocity, timeMs);
  tracker.noteOff(midi, timeMs + hold);
  return judged;
}

/** Play single-note steps in wait mode at the given times, each key let go 40 ms later. */
function playAt(tracker, notes, times) {
  return notes.map((midi, i) => tap(tracker, midi, times[i], { hold: 40 }));
}

function everyMs(count, gapMs, startMs = 1000) {
  return Array.from({ length: count }, (_, i) => startMs + i * gapMs);
}

// ---------------------------------------------------------------- wait mode

describe('AttemptTracker, wait mode', () => {
  test('a perfect run: every note correct, all steps ok, clean totals and timing', () => {
    const tracker = new AttemptTracker(scaleExercise());
    assert.equal(tracker.stepIndex, 0);
    assert.equal(tracker.finished, false);
    assert.deepEqual(tracker.pendingNotes(), [60]);
    assert.deepEqual(tracker.stepStates, ['current', ...new Array(14).fill('pending')]);

    const judged = playAt(tracker, SCALE_NOTES, everyMs(15, 500));
    judged.forEach((j, i) => {
      assert.equal(j.kind, 'correct');
      assert.equal(j.stepIndex, i);
      assert.equal(j.stepCompleted, true);
      assert.deepEqual(j.expected, [SCALE_NOTES[i]]);
      assert.equal(j.offsetMs, null);
      assert.equal(j.finished, i === 14);
    });
    assert.equal(tracker.finished, true);
    assert.equal(tracker.stepIndex, 15);
    assert.deepEqual(tracker.pendingNotes(), []);
    assert.deepEqual(tracker.stepStates, new Array(15).fill('ok'));

    const result = tracker.result();
    assert.equal(result.exerciseId, 'scale:C:major:right:1:up_down:4');
    assert.equal(result.mode, 'wait');
    assert.equal(result.bpm, 60);
    assert.equal(result.completed, true);
    assert.equal(result.durationMs, 7000);
    assert.equal(result.steps.length, 15);
    assert.deepEqual(result.steps[0], {
      index: 0, state: 'ok', wrong: [], missed: [], mistimed: 0, ioiMs: null, offsetMs: null, velocity: 64, chordSpreadMs: null,
    });
    for (const s of result.steps.slice(1)) assert.equal(s.ioiMs, 500);
    assert.deepEqual(result.totals, { steps: 15, played: 15, clean: 15, wrongNotes: 0, mistimed: 0, missed: 0, extra: 0, accuracy: 1 });
    assert.deepEqual(result.timing, {
      estBpm: 120, evennessCv: 0, hesitations: [], meanOffsetMs: null, offsetSdMs: null, driftMsPerBeat: null,
      offsetCount: 0, offsetSpanBeats: null,
    });
    assert.deepEqual(result.dynamics, { mean: 64, sd: 0, min: 64, max: 64 });
    assert.deepEqual(result.troubleSpots, []);
  });

  test('wrong notes do not advance; they are stored as MIDI numbers on the current step', () => {
    const tracker = new AttemptTracker(scaleExercise());
    playAt(tracker, [60, 62, 64], everyMs(3, 500));
    const wrong1 = tap(tracker, 64, 2500); // E again instead of F
    assert.equal(wrong1.kind, 'wrong');
    assert.equal(wrong1.stepIndex, 3);
    assert.equal(wrong1.stepCompleted, false);
    assert.deepEqual(wrong1.expected, [65]);
    const wrong2 = tap(tracker, 67, 2800);
    assert.equal(wrong2.kind, 'wrong');
    assert.equal(tracker.stepIndex, 3);
    assert.equal(tracker.stepStates[3], 'current');
    assert.deepEqual(tracker.result().steps[3].wrong, [64, 67]);

    const fixed = tap(tracker, 65, 3200);
    assert.equal(fixed.kind, 'correct');
    assert.equal(fixed.stepCompleted, true);
    assert.equal(tracker.stepStates[3], 'error');
    playAt(tracker, SCALE_NOTES.slice(4), everyMs(11, 500, 3700));

    const result = tracker.result();
    assert.equal(result.completed, true);
    assert.deepEqual(result.steps[3].wrong, [64, 67]);
    assert.equal(result.steps[3].state, 'error');
    assert.deepEqual(result.totals, {
      steps: 15, played: 15, clean: 14, wrongNotes: 2, mistimed: 0, missed: 0, extra: 0, accuracy: 0.9333,
    });
    assert.equal(result.troubleSpots[0].index, 3);
    assert.deepEqual(result.troubleSpots[0].names, ['F4']);
    assert.equal(result.troubleSpots[0].reason, 'wrong_notes');
  });

  test('a wrong note before the first right one counts against step 1 and does not start the clock', () => {
    const tracker = new AttemptTracker(scaleExercise());
    assert.equal(tracker.noteOn(61, 80, 500).kind, 'wrong');
    tracker.noteOff(61, 600);
    playAt(tracker, SCALE_NOTES, everyMs(15, 400, 2000));
    const result = tracker.result();
    assert.deepEqual(result.steps[0].wrong, [61]);
    assert.equal(result.steps[0].state, 'error');
    assert.equal(result.totals.wrongNotes, 1);
    assert.equal(result.totals.clean, 14);
    assert.equal(result.durationMs, 14 * 400);
  });

  test('a chord struck together completes on its last note; spread and velocity are measured', () => {
    const tracker = new AttemptTracker(exercise([step([60, 64, 67]), step([65, 69, 72])]));
    assert.deepEqual(tracker.pendingNotes(), [60, 64, 67]);
    const a = tracker.noteOn(64, 60, 1000);
    assert.equal(a.kind, 'correct');
    assert.equal(a.stepCompleted, false);
    assert.deepEqual(a.expected, [60, 64, 67]);
    assert.deepEqual(tracker.pendingNotes(), [60, 67]);
    assert.equal(tracker.noteOn(60, 70, 1010).stepCompleted, false);
    const c = tracker.noteOn(67, 80, 1025);
    assert.equal(c.kind, 'correct');
    assert.equal(c.stepCompleted, true);
    assert.equal(tracker.stepIndex, 1);
    for (const midi of [60, 64, 67]) tracker.noteOff(midi, 1500);
    for (const midi of [65, 69, 72]) tracker.noteOn(midi, 50, 2025);
    assert.equal(tracker.finished, true);

    const result = tracker.result();
    assert.equal(result.steps[0].chordSpreadMs, 25);
    assert.equal(result.steps[0].velocity, 70);
    assert.equal(result.steps[1].chordSpreadMs, 0);
    assert.equal(result.steps[1].ioiMs, 1000);
    assert.deepEqual(result.dynamics, { mean: 60, sd: 11.5, min: 50, max: 80 });
  });

  test('a chord struck one key at a time and held completes when the last key goes down', () => {
    const tracker = new AttemptTracker(exercise([step([60, 64, 67])]));
    assert.equal(tracker.noteOn(60, 64, 0).stepCompleted, false);
    assert.equal(tracker.noteOn(64, 64, 300).stepCompleted, false);
    const last = tracker.noteOn(67, 64, 600);
    assert.equal(last.stepCompleted, true);
    assert.equal(last.finished, true);
    assert.equal(tracker.result().steps[0].chordSpreadMs, 600);
    assert.equal(tracker.result().steps[0].state, 'ok');
  });

  test('a chord with one key released before the last is struck is not complete until it is pressed again', () => {
    const tracker = new AttemptTracker(exercise([step([60, 64, 67])]));
    tracker.noteOn(60, 64, 0);
    tracker.noteOn(64, 64, 100);
    tracker.noteOff(60, 150);
    const third = tracker.noteOn(67, 64, 200);
    assert.equal(third.kind, 'correct');
    assert.equal(third.stepCompleted, false);
    assert.equal(tracker.finished, false);
    assert.deepEqual(tracker.pendingNotes(), [60]);

    const again = tracker.noteOn(60, 90, 300);
    assert.equal(again.kind, 'correct');
    assert.equal(again.stepCompleted, true);
    assert.equal(again.finished, true);
    const result = tracker.result();
    assert.equal(result.steps[0].state, 'ok');
    assert.equal(result.steps[0].chordSpreadMs, 200); // E at 100, G at 200, C again at 300
    assert.equal(result.steps[0].velocity, 72.7); // (90 + 64 + 64) / 3
  });

  test('striking a chord note again is ignored unless it completes the chord', () => {
    const tracker = new AttemptTracker(exercise([step([60, 64, 67])]));
    assert.equal(tracker.noteOn(60, 64, 0).kind, 'correct');
    assert.equal(tracker.noteOn(60, 64, 50).kind, 'ignored'); // still held: a doubled note-on
    tracker.noteOff(60, 100);
    const restrike = tracker.noteOn(60, 64, 200); // let go and pressed again, chord still incomplete
    assert.equal(restrike.kind, 'ignored');
    assert.equal(restrike.stepCompleted, false);
    assert.deepEqual(tracker.pendingNotes(), [64, 67]);
    assert.equal(tracker.result().totals.wrongNotes, 0);
  });

  test('arpeggiating a block chord (never all keys down together) does not complete it', () => {
    const tracker = new AttemptTracker(exercise([step([60, 64, 67])]));
    tap(tracker, 60, 0, { hold: 80 });
    tap(tracker, 64, 100, { hold: 80 });
    const last = tap(tracker, 67, 200, { hold: 80 });
    assert.equal(last.stepCompleted, false);
    assert.equal(tracker.finished, false);
    assert.deepEqual(tracker.pendingNotes(), [60, 64, 67]);
  });

  test('repeated notes need a new strike each time', () => {
    const tracker = new AttemptTracker(melody([60, 60, 60]));
    assert.equal(tracker.noteOn(60, 64, 0).stepCompleted, true);
    assert.equal(tracker.stepIndex, 1);
    assert.deepEqual(tracker.pendingNotes(), [60]); // still holding the key does not count
    tracker.noteOff(60, 200);
    assert.equal(tracker.stepIndex, 1);
    assert.equal(tap(tracker, 60, 500).stepCompleted, true);
    const last = tap(tracker, 60, 1000);
    assert.equal(last.finished, true);
    assert.deepEqual(tracker.result().steps.map((s) => s.ioiMs), [null, 500, 500]);
  });

  test('a note shared with the previous chord has to be struck again', () => {
    const tracker = new AttemptTracker(exercise([step([60, 64, 67]), step([60, 65, 69])]));
    for (const midi of [60, 64, 67]) tracker.noteOn(midi, 64, 0);
    tracker.noteOff(64, 400);
    tracker.noteOff(67, 400);
    tracker.noteOn(65, 64, 500);
    const a = tracker.noteOn(69, 64, 500);
    assert.equal(a.stepCompleted, false); // C is still down from before, but was not struck for this step
    assert.deepEqual(tracker.pendingNotes(), [60]);
    tracker.noteOff(60, 600);
    assert.equal(tracker.noteOn(60, 64, 700).stepCompleted, true);
  });

  test('anyOctave off: the right note name in another octave is wrong', () => {
    const tracker = new AttemptTracker(melody([60, 64]));
    const judged = tap(tracker, 72, 0);
    assert.equal(judged.kind, 'wrong');
    assert.deepEqual(tracker.result().steps[0].wrong, [72]);
    assert.equal(tracker.stepIndex, 0);
  });

  test('anyOctave on: any octave of the expected note is accepted', () => {
    const tracker = new AttemptTracker(melody([60, 64]), { anyOctave: true });
    assert.equal(tap(tracker, 72, 0).kind, 'correct');
    assert.deepEqual(tracker.pendingNotes(), [64]); // as written in the exercise
    assert.equal(tap(tracker, 61, 300).kind, 'wrong');
    const last = tap(tracker, 40, 500);
    assert.equal(last.kind, 'correct');
    assert.equal(last.finished, true);
    assert.equal(tracker.result().totals.wrongNotes, 1);
  });

  test('anyOctave on: an octave doubling still needs two different keys', () => {
    const tracker = new AttemptTracker(exercise([step([48, 60])]), { anyOctave: true });
    assert.equal(tracker.noteOn(60, 64, 0).stepCompleted, false);
    assert.deepEqual(tracker.pendingNotes(), [48]);
    assert.equal(tracker.noteOn(72, 64, 20).stepCompleted, true);
  });

  test('anyOctave on: letting go of the key that was actually pressed un-holds its chord note', () => {
    const tracker = new AttemptTracker(exercise([step([60, 64])]), { anyOctave: true });
    tracker.noteOn(72, 64, 0); // C, an octave up
    tracker.noteOff(72, 100);
    assert.equal(tracker.noteOn(64, 64, 200).stepCompleted, false);
    assert.deepEqual(tracker.pendingNotes(), [60]);
    assert.equal(tracker.noteOn(48, 64, 300).stepCompleted, true);
  });

  test('an abandoned attempt: result() works at any time and says it is not completed', () => {
    const tracker = new AttemptTracker(scaleExercise());
    assert.equal(tracker.result().completed, false);
    assert.equal(tracker.result().durationMs, 0);
    assert.equal(tracker.result().totals.accuracy, 0);

    playAt(tracker, SCALE_NOTES.slice(0, 5), everyMs(5, 500));
    tap(tracker, 66, 3400); // one wrong try on step 6, then they give up
    const result = tracker.result();
    assert.equal(result.completed, false);
    assert.equal(tracker.finished, false);
    assert.equal(tracker.stepIndex, 5);
    assert.deepEqual(result.steps.map((s) => s.state), [
      'ok', 'ok', 'ok', 'ok', 'ok', 'current', ...new Array(9).fill('pending'),
    ]);
    assert.deepEqual(result.steps[5].wrong, [66]);
    assert.equal(result.steps[5].velocity, null);
    assert.equal(result.steps[6].ioiMs, null);
    assert.deepEqual(result.totals, {
      steps: 15, played: 5, clean: 5, wrongNotes: 1, mistimed: 0, missed: 0, extra: 0, accuracy: 0.3333,
    });
    assert.equal(result.durationMs, 2600); // first right note at 1000, last key event at 3600
    assert.equal(result.timing.estBpm, 120);
    assert.deepEqual(result.troubleSpots, [{ index: 5, names: ['A4'], reason: 'wrong_notes' }]);
  });

  test('a chord that was only partly struck when the learner stopped is not a played step', () => {
    const tracker = new AttemptTracker(exercise([step([60, 64, 67]), step([65, 69, 72])]));
    tracker.noteOn(60, 90, 0);
    tracker.noteOn(64, 80, 20);
    const result = tracker.result();
    assert.equal(result.completed, false);
    assert.equal(result.totals.played, 0);
    assert.equal(result.totals.clean, 0);
    assert.deepEqual(result.steps[0], {
      index: 0, state: 'current', wrong: [], missed: [], mistimed: 0, ioiMs: null, offsetMs: null, velocity: null, chordSpreadMs: null,
    });
    assert.deepEqual(result.dynamics, { mean: null, sd: null, min: null, max: null });
    assert.deepEqual(tracker.pendingNotes(), [67]);
  });

  test('a hesitation is a gap well over the usual pace', () => {
    const tracker = new AttemptTracker(scaleExercise());
    // 500 ms between notes, but 1500 ms before step 6 (index 5) and 700 ms before step 11 (index 10).
    const times = [];
    let t = 1000;
    SCALE_NOTES.forEach((_, i) => {
      if (i > 0) t += i === 5 ? 1500 : i === 10 ? 700 : 500;
      times.push(t);
    });
    playAt(tracker, SCALE_NOTES, times);
    const result = tracker.result();
    assert.deepEqual(result.timing.hesitations, [{ index: 5, factor: 3 }]);
    assert.equal(result.steps[5].ioiMs, 1500);
    assert.equal(result.timing.estBpm, 120);
    // The 1500 ms pause is reported as a hesitation and left out of evenness; the 700 ms gap still counts.
    assert.ok(result.timing.evennessCv > 0.05 && result.timing.evennessCv < 0.2);
    assert.deepEqual(result.troubleSpots, [{ index: 5, names: ['A4'], reason: 'hesitation' }]);
    assert.equal(result.totals.accuracy, 1); // a hesitation is not a wrong note
  });

  test('a long gap in fast playing is not a hesitation when it is under 250 ms over', () => {
    const tracker = new AttemptTracker(melody([60, 62, 64, 65, 67, 69]));
    playAt(tracker, [60, 62, 64, 65, 67, 69], [0, 100, 200, 500, 600, 700]); // 300 ms: 3x, but only 200 over
    assert.deepEqual(tracker.result().timing.hesitations, []);
    const slow = new AttemptTracker(melody([60, 62, 64, 65, 67, 69]));
    playAt(slow, [60, 62, 64, 65, 67, 69], [0, 100, 200, 550, 650, 750]); // 350 ms: 250 over
    assert.deepEqual(slow.result().timing.hesitations, [{ index: 3, factor: 3.5 }]);
  });

  test('with two hesitations in four gaps the usual pace is still the fluent one', () => {
    const tracker = new AttemptTracker(melody([60, 62, 64, 65, 67]));
    playAt(tracker, [60, 62, 64, 65, 67], [0, 500, 3500, 4020, 7120]);
    const result = tracker.result();
    assert.deepEqual(result.timing.hesitations.map((h) => h.index), [2, 4]);
    assert.equal(result.timing.estBpm, 115.4); // 60000 / 520
  });

  test('gaps are judged against the written note lengths', () => {
    const beats = [1, 1, 2, 1, 1, 2, 1];
    const notes = [60, 62, 64, 62, 60, 62, 64];
    const tracker = new AttemptTracker(exercise(notes.map((midi, i) => step([midi], { beats: beats[i] }))));
    const times = [];
    let t = 0;
    beats.forEach((b) => {
      times.push(t);
      t += b * 600;
    });
    playAt(tracker, notes, times);
    const result = tracker.result();
    assert.deepEqual(result.steps.map((s) => s.ioiMs), [null, 600, 600, 1200, 600, 600, 1200]);
    assert.equal(result.timing.estBpm, 100);
    assert.equal(result.timing.evennessCv, 0);
    assert.deepEqual(result.timing.hesitations, []);
  });

  test('evenness needs at least four played steps', () => {
    const three = new AttemptTracker(melody([60, 62, 64]));
    playAt(three, [60, 62, 64], [0, 500, 1100]);
    assert.equal(three.result().timing.evennessCv, null);
    assert.equal(three.result().timing.estBpm, 120);
    const four = new AttemptTracker(melody([60, 62, 64, 65]));
    playAt(four, [60, 62, 64, 65], [0, 400, 1000, 1500]);
    // paces 400, 600, 500: mean 500, population sd 81.65
    assert.equal(four.result().timing.evennessCv, 0.163);
  });

  test('rests are skipped and only add time', () => {
    const steps = [step([]), step([60]), step([], { beats: 2 }), step([62]), step([64]), step([])];
    const tracker = new AttemptTracker(exercise(steps));
    assert.equal(tracker.stepIndex, 1);
    assert.deepEqual(tracker.stepStates, ['ok', 'current', 'pending', 'pending', 'pending', 'pending']);
    assert.deepEqual(tracker.pendingNotes(), [60]);
    tap(tracker, 60, 0);
    assert.equal(tracker.stepIndex, 3);
    tap(tracker, 62, 1500); // 3 beats later (1 for the note, 2 for the rest)
    const last = tap(tracker, 64, 2000);
    assert.equal(last.finished, true);
    assert.equal(tracker.stepIndex, 6);
    assert.deepEqual(tracker.stepStates, ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    const result = tracker.result();
    assert.equal(result.steps.length, 6);
    assert.equal(result.totals.steps, 3);
    assert.equal(result.totals.played, 3);
    assert.equal(result.totals.accuracy, 1);
    assert.equal(result.steps[3].ioiMs, 1500);
    assert.equal(result.timing.estBpm, 120); // 500 ms per beat in both gaps
    assert.deepEqual(result.timing.hesitations, []);
  });

  test('both-hands steps need both notes', () => {
    const both = (low, high) => step([low, high], { hands: ['L', 'R'], fingers: [5, 1] });
    const tracker = new AttemptTracker(exercise([both(48, 60), both(50, 62), both(52, 64)], { hand: 'both' }));
    assert.equal(tracker.noteOn(60, 70, 0).stepCompleted, false);
    assert.deepEqual(tracker.pendingNotes(), [48]);
    assert.equal(tracker.noteOn(48, 50, 30).stepCompleted, true);
    tracker.noteOff(48, 300);
    tracker.noteOff(60, 300);
    tracker.noteOn(50, 50, 500);
    const wrong = tracker.noteOn(64, 70, 510); // right hand one step ahead
    assert.equal(wrong.kind, 'wrong');
    tracker.noteOff(64, 600);
    assert.equal(tracker.noteOn(62, 70, 700).stepCompleted, true);
    tracker.noteOff(50, 900);
    tracker.noteOff(62, 900);
    tracker.noteOn(52, 50, 1000);
    assert.equal(tracker.noteOn(64, 70, 1004).finished, true);
    const result = tracker.result();
    assert.deepEqual(result.steps.map((s) => s.state), ['ok', 'error', 'ok']);
    assert.deepEqual(result.steps.map((s) => s.chordSpreadMs), [30, 200, 4]);
    assert.deepEqual(result.steps[1].wrong, [64]);
    assert.deepEqual(result.troubleSpots, [{ index: 1, names: ['D3', 'D4'], reason: 'wrong_notes' }]);
  });

  test('after the attempt has finished every note is ignored', () => {
    const tracker = new AttemptTracker(melody([60]));
    assert.equal(tap(tracker, 60, 0).finished, true);
    const late = tracker.noteOn(62, 64, 500);
    assert.equal(late.kind, 'ignored');
    assert.equal(late.finished, true);
    assert.deepEqual(late.expected, []);
    assert.equal(tracker.result().totals.wrongNotes, 0);
    assert.equal(tracker.result().durationMs, 0);
  });

  test('a single-step exercise gives sane numbers', () => {
    const tracker = new AttemptTracker(melody([60]));
    tap(tracker, 60, 100, { velocity: 90 });
    const result = tracker.result();
    assert.equal(result.completed, true);
    assert.deepEqual(result.totals, { steps: 1, played: 1, clean: 1, wrongNotes: 0, mistimed: 0, missed: 0, extra: 0, accuracy: 1 });
    assert.deepEqual(result.timing, {
      estBpm: null, evennessCv: null, hesitations: [], meanOffsetMs: null, offsetSdMs: null, driftMsPerBeat: null,
      offsetCount: 0, offsetSpanBeats: null,
    });
    assert.deepEqual(result.dynamics, { mean: 90, sd: 0, min: 90, max: 90 });
  });

  test('an exercise of rests only (or with no steps, or no exercise at all) is finished at once and never throws', () => {
    for (const ex of [exercise([step([]), step([])]), exercise([]), null, undefined, 42, { steps: 'nope' }, { steps: [null, 7] }]) {
      const tracker = new AttemptTracker(ex);
      assert.equal(tracker.finished, true);
      assert.equal(tracker.noteOn(60, 64, 0).kind, 'ignored');
      tracker.noteOff(60, 10);
      tracker.start(0);
      assert.deepEqual(tracker.tick(100), { missed: [], finished: true });
      assert.deepEqual(tracker.pendingNotes(), []);
      const result = tracker.result();
      assert.equal(result.completed, true);
      assert.equal(result.totals.steps, 0);
      assert.equal(result.totals.accuracy, 0);
      assert.deepEqual(result.troubleSpots, []);
    }
  });

  test('bad device input is tolerated', () => {
    const tracker = new AttemptTracker(melody([60, 62, 64, 65]));
    for (const bad of [NaN, undefined, null, 'C4', 60.5, -1, 128, Infinity]) {
      const judged = tracker.noteOn(bad, 64, 0);
      assert.equal(judged.kind, 'ignored');
      assert.equal(judged.stepIndex, 0);
      tracker.noteOff(bad, 0);
    }
    tracker.noteOff(72, 0); // never on
    assert.equal(tracker.result().totals.wrongNotes, 0);

    assert.equal(tracker.noteOn(60, 300, 1000).kind, 'correct'); // velocity far too high
    tracker.noteOn(62, -5, 1500); // negative
    tracker.noteOn(64, NaN, 2000); // not a number: not counted in the loudness numbers
    tracker.noteOn(65, undefined, undefined); // no time: taken as the time of the last event
    const result = tracker.result();
    assert.equal(result.completed, true);
    assert.deepEqual(result.steps.map((s) => s.velocity), [127, 1, null, null]);
    assert.deepEqual(result.dynamics, { mean: 64, sd: 63, min: 1, max: 127 });
    assert.equal(result.steps[3].ioiMs, 0);
    assert.equal(result.durationMs, 1000);
  });

  test('time that goes back a few ms never gives a negative gap', () => {
    const tracker = new AttemptTracker(melody([60, 62, 64]));
    tracker.noteOn(60, 64, 1000);
    tracker.noteOn(62, 64, 995);
    tracker.noteOn(64, 64, 1500);
    assert.deepEqual(tracker.result().steps.map((s) => s.ioiMs), [null, 0, 500]);
  });

  test('tick() and start() are harmless in wait mode', () => {
    const tracker = new AttemptTracker(melody([60, 62]));
    tracker.start(0);
    assert.deepEqual(tracker.tick(999999), { missed: [], finished: false });
    assert.deepEqual(tracker.stepStates, ['current', 'pending']);
    playAt(tracker, [60, 62], [5000, 5500]);
    assert.deepEqual(tracker.tick(6000), { missed: [], finished: true });
    assert.equal(tracker.result().durationMs, 500); // from the first right note, not from start()
  });

  test('options override the mode and tempo of the exercise', () => {
    const ex = scaleExercise({ mode: 'tempo', bpm: 90 });
    assert.equal(new AttemptTracker(ex).result().mode, 'tempo');
    assert.equal(new AttemptTracker(ex).result().bpm, 90);
    const overridden = new AttemptTracker(ex, { mode: 'wait', bpm: 50 }).result();
    assert.equal(overridden.mode, 'wait');
    assert.equal(overridden.bpm, 50);
    assert.equal(new AttemptTracker(ex, { bpm: NaN }).result().bpm, 90);
    assert.equal(new AttemptTracker({ steps: [] }, { bpm: -3 }).result().bpm, 60);
  });

  test('trouble spots: at most five, the step with the most wrong notes first', () => {
    const tracker = new AttemptTracker(scaleExercise());
    const wrongPerStep = { 1: 1, 3: 4, 5: 2, 7: 1, 9: 3, 11: 1, 13: 2 };
    let t = 0;
    SCALE_NOTES.forEach((midi, i) => {
      for (let k = 0; k < (wrongPerStep[i] ?? 0); k++) tap(tracker, 30 + k, (t += 100), { hold: 20 });
      tap(tracker, midi, (t += 400));
    });
    const result = tracker.result();
    assert.equal(result.totals.wrongNotes, 14);
    assert.equal(result.totals.clean, 8);
    assert.deepEqual(result.troubleSpots.map((s) => s.index), [3, 9, 5, 13, 1]);
    assert.ok(result.troubleSpots.every((s) => s.reason === 'wrong_notes'));
    assert.deepEqual(result.steps[3].wrong, [30, 31, 32, 33]);
  });

  test('a flood of wrong notes is counted in full but only 32 are kept per step', () => {
    const tracker = new AttemptTracker(melody([60, 62]));
    for (let i = 0; i < 100; i++) tracker.noteOn(70 + (i % 5), 64, i * 10);
    const result = tracker.result();
    assert.equal(result.totals.wrongNotes, 100);
    assert.equal(result.steps[0].wrong.length, 32);
  });

  test('step fixtures with unsorted or duplicate notes are normalized', () => {
    const tracker = new AttemptTracker(exercise([{ notes: [67, 60, 64, 60], names: ['G4', 'C4', 'E4', 'C4'], beats: 0 }]));
    assert.deepEqual(tracker.pendingNotes(), [60, 64, 67]);
    for (const midi of [60, 64, 67]) tracker.noteOn(midi, 64, 0);
    assert.equal(tracker.finished, true);
  });
});

// ---------------------------------------------------------------- tempo mode

/** Four quarter notes at 120 bpm: one beat = 500 ms, window = 225 ms. */
function tempoTracker(notes = [60, 62, 64, 65], options = {}) {
  const tracker = new AttemptTracker(melody(notes, { mode: 'tempo', bpm: 120 }), options);
  tracker.start(10000);
  return tracker;
}

describe('AttemptTracker, tempo mode', () => {
  test('a run exactly on the click: offsets 0, every step ok, finished on the last note', () => {
    const tracker = new AttemptTracker(scaleExercise({ mode: 'tempo', bpm: 100 }));
    tracker.start(10000);
    assert.deepEqual(tracker.tick(9000), { missed: [], finished: false });
    assert.equal(tracker.stepStates[0], 'current');
    assert.deepEqual(tracker.pendingNotes(), [60]);
    SCALE_NOTES.forEach((midi, i) => {
      const judged = tracker.noteOn(midi, 64, 10000 + i * 600);
      assert.equal(judged.kind, 'correct');
      assert.equal(judged.stepIndex, i);
      assert.equal(judged.stepCompleted, true);
      assert.equal(judged.offsetMs, 0);
      assert.equal(judged.finished, i === 14);
      tracker.noteOff(midi, 10000 + i * 600 + 360);
    });
    assert.equal(tracker.finished, true);
    const result = tracker.result();
    assert.equal(result.mode, 'tempo');
    assert.equal(result.bpm, 100);
    assert.equal(result.completed, true);
    assert.equal(result.durationMs, 14 * 600);
    assert.deepEqual(result.totals, { steps: 15, played: 15, clean: 15, wrongNotes: 0, mistimed: 0, missed: 0, extra: 0, accuracy: 1 });
    assert.deepEqual(result.timing, {
      estBpm: 100, evennessCv: 0, hesitations: [], meanOffsetMs: 0, offsetSdMs: 0, driftMsPerBeat: 0,
      offsetCount: 15, offsetSpanBeats: 14,
    });
    assert.ok(result.steps.every((s) => s.state === 'ok' && s.offsetMs === 0));
    assert.deepEqual(result.troubleSpots, []);
  });

  test('early and late notes: exact signed offsets, positive = late', () => {
    const tracker = tempoTracker();
    assert.equal(tracker.noteOn(60, 64, 10000).offsetMs, 0);
    const late = tracker.noteOn(62, 64, 10540);
    assert.equal(late.kind, 'correct');
    assert.equal(late.stepIndex, 1);
    assert.equal(late.offsetMs, 40);
    const early = tracker.noteOn(64, 64, 10970);
    assert.equal(early.offsetMs, -30);
    const edge = tracker.noteOn(65, 64, 11725); // exactly at the end of its window
    assert.equal(edge.kind, 'correct');
    assert.equal(edge.offsetMs, 225);
    assert.equal(edge.finished, true);

    const result = tracker.result();
    assert.deepEqual(result.steps.map((s) => s.offsetMs), [0, 40, -30, 225]);
    assert.equal(result.timing.meanOffsetMs, 58.8); // 235 / 4
    assert.equal(result.timing.offsetSdMs, 99.1);
    assert.deepEqual(result.steps.map((s) => s.ioiMs), [null, 540, 430, 755]);
    assert.deepEqual(result.timing.hesitations, []);
    assert.deepEqual(result.troubleSpots, [{ index: 3, names: ['F4'], reason: 'late' }]);
  });

  test('the window is 45% of the gap to the nearest step', () => {
    const inside = tempoTracker();
    assert.equal(inside.noteOn(60, 64, 10225).kind, 'correct');
    const outside = tempoTracker();
    const judged = outside.noteOn(60, 64, 10226);
    assert.equal(judged.kind, 'extra');
    assert.equal(judged.offsetMs, null);
    const early = tempoTracker();
    assert.equal(early.noteOn(60, 64, 9775).offsetMs, -225);
    const tooEarly = tempoTracker();
    assert.equal(tooEarly.noteOn(60, 64, 9774).kind, 'extra');
  });

  test('the window is never wider than 300 ms', () => {
    const make = () => {
      const tracker = new AttemptTracker(melody([60, 62], { mode: 'tempo', bpm: 60 }));
      tracker.start(0);
      return tracker;
    };
    assert.equal(make().noteOn(60, 64, 300).kind, 'correct');
    assert.equal(make().noteOn(60, 64, 301).kind, 'extra');
    const single = new AttemptTracker(melody([60], { mode: 'tempo', bpm: 60 }));
    single.start(0);
    assert.equal(single.noteOn(60, 64, -300).offsetMs, -300);
  });

  test('a short step narrows the windows on both sides of it', () => {
    // beats 1, 0.5, 1 at 120 bpm: steps at 0, 500, 750 ms. Gaps 500 and 250.
    const steps = [step([60]), step([62], { beats: 0.5 }), step([64])];
    const make = () => {
      const tracker = new AttemptTracker(exercise(steps, { mode: 'tempo', bpm: 120 }));
      tracker.start(0);
      return tracker;
    };
    assert.equal(make().noteOn(60, 64, 225).kind, 'correct'); // 45% of 500
    assert.equal(make().noteOn(62, 64, 500 + 112).kind, 'correct'); // 45% of 250 = 112.5
    assert.equal(make().noteOn(62, 64, 500 - 113).kind, 'extra');
    assert.equal(make().noteOn(64, 64, 750 - 112).kind, 'correct');
    assert.equal(make().noteOn(64, 64, 750 + 113).kind, 'extra');
  });

  test('tick() marks a step missed once its window (plus a grace for late delivery) has passed', () => {
    const tracker = tempoTracker();
    tracker.noteOn(60, 64, 10000);
    assert.equal(tracker.stepIndex, 1);
    assert.deepEqual(tracker.tick(10725), { missed: [], finished: false }); // window just over
    assert.deepEqual(tracker.tick(10845), { missed: [], finished: false }); // grace not over
    assert.equal(tracker.stepStates[1], 'current');
    assert.deepEqual(tracker.tick(10846), { missed: [1], finished: false });
    assert.deepEqual(tracker.tick(10850), { missed: [], finished: false }); // reported once
    assert.equal(tracker.stepIndex, 2);
    assert.deepEqual(tracker.stepStates, ['ok', 'missed', 'current', 'pending']);
    assert.deepEqual(tracker.pendingNotes(), [64]);

    tracker.noteOn(64, 64, 11000);
    assert.deepEqual(tracker.tick(11400), { missed: [], finished: false });
    assert.deepEqual(tracker.tick(11900), { missed: [3], finished: true });
    assert.equal(tracker.finished, true);

    const result = tracker.result();
    assert.equal(result.completed, true);
    assert.deepEqual(result.steps.map((s) => s.state), ['ok', 'missed', 'ok', 'missed']);
    assert.deepEqual(result.steps[1].missed, [62]);
    assert.equal(result.steps[1].offsetMs, null);
    assert.deepEqual(result.totals, { steps: 4, played: 2, clean: 2, wrongNotes: 0, mistimed: 0, missed: 2, extra: 0, accuracy: 0.5 });
    assert.equal(result.durationMs, 1725); // to the end of the last window
    assert.equal(result.steps[2].ioiMs, 1000);
    assert.equal(result.timing.estBpm, 120); // 1000 ms over 2 beats
    assert.deepEqual(result.troubleSpots, [
      { index: 1, names: ['D4'], reason: 'missed' },
      { index: 3, names: ['F4'], reason: 'missed' },
    ]);
  });

  test('a note stamped inside its window still counts when a tick ran after the window closed', () => {
    const tracker = tempoTracker();
    assert.deepEqual(tracker.tick(10300), { missed: [], finished: false });
    const judged = tracker.noteOn(60, 64, 10220); // delivered late by Bluetooth, stamped in time
    assert.equal(judged.kind, 'correct');
    assert.equal(judged.offsetMs, 220);
  });

  test('without tick() a later note resolves the steps before it', () => {
    const tracker = tempoTracker();
    tracker.noteOn(60, 64, 10000);
    tracker.noteOn(64, 64, 11010); // step 2 was skipped
    assert.equal(tracker.stepStates[1], 'missed');
    assert.equal(tracker.stepIndex, 3);
    const last = tracker.noteOn(65, 64, 11490);
    assert.equal(last.finished, true);
    assert.deepEqual(tracker.tick(11500), { missed: [1], finished: true });
    assert.deepEqual(tracker.result().steps.map((s) => s.state), ['ok', 'missed', 'ok', 'ok']);
    assert.equal(tracker.result().totals.missed, 1);
  });

  test('a wrong key on the beat is extra, charged to that step, and the step is missed', () => {
    const tracker = tempoTracker();
    tracker.noteOn(60, 64, 10000);
    const judged = tracker.noteOn(63, 64, 10510);
    assert.equal(judged.kind, 'extra');
    assert.equal(judged.stepIndex, 1);
    assert.equal(judged.stepCompleted, false);
    assert.deepEqual(judged.expected, [62]);
    assert.equal(judged.offsetMs, null);
    tracker.noteOn(64, 64, 11000);
    tracker.noteOn(65, 64, 11500);
    const result = tracker.result();
    assert.deepEqual(result.steps[1].wrong, [63]);
    assert.deepEqual(result.steps[1].missed, [62]);
    assert.equal(result.steps[1].state, 'missed');
    assert.deepEqual(result.totals, { steps: 4, played: 3, clean: 3, wrongNotes: 1, mistimed: 0, missed: 1, extra: 0, accuracy: 0.75 });
    assert.deepEqual(result.troubleSpots, [{ index: 1, names: ['D4'], reason: 'missed' }]);
  });

  test('a second strike of a note already matched, or a stray key between beats, makes the nearest step not clean', () => {
    const tracker = tempoTracker();
    tracker.noteOn(60, 64, 10000);
    assert.equal(tracker.noteOn(60, 64, 10100).kind, 'extra'); // same key twice
    tracker.noteOn(62, 64, 10500);
    const stray = tracker.noteOn(70, 64, 10740); // outside every window, nearest to step 2
    assert.equal(stray.kind, 'extra');
    assert.equal(stray.stepIndex, 1);
    tracker.noteOn(64, 64, 11000);
    tracker.noteOn(65, 64, 11500);
    const result = tracker.result();
    assert.deepEqual(result.steps.map((s) => s.state), ['error', 'error', 'ok', 'ok']);
    assert.deepEqual(result.steps[0].wrong, [60]);
    assert.deepEqual(result.steps[1].wrong, [70]);
    assert.equal(result.totals.wrongNotes, 2);
    assert.equal(result.totals.extra, 0);
    assert.equal(result.totals.clean, 2);
    assert.equal(result.totals.accuracy, 0.5);
    assert.deepEqual(result.troubleSpots.map((s) => [s.index, s.reason]), [[0, 'wrong_notes'], [1, 'wrong_notes']]);
  });

  test('the right key outside its window is charged to its own step, which is then late or early, not forgotten', () => {
    const make = () => {
      const tracker = new AttemptTracker(melody([60, 62, 64, 65], { mode: 'tempo', bpm: 60 }));
      tracker.start(0);
      return tracker;
    };
    // D comes 400 ms late: outside the 300 ms window.
    const late = make();
    late.noteOn(60, 64, 0);
    const judged = late.noteOn(62, 64, 1400);
    assert.equal(judged.kind, 'extra');
    assert.equal(judged.stepIndex, 1);
    late.noteOn(64, 64, 2000);
    late.noteOn(65, 64, 3000);
    let result = late.result();
    assert.deepEqual(result.steps.map((s) => s.state), ['ok', 'missed', 'ok', 'ok']);
    // The right key at the wrong time is a timing fault, not a wrong note.
    assert.deepEqual(result.steps[1].wrong, []);
    assert.equal(result.steps[1].mistimed, 1);
    assert.deepEqual(result.steps[1].missed, [62]);
    assert.deepEqual(result.totals, { steps: 4, played: 3, clean: 3, wrongNotes: 0, mistimed: 1, missed: 1, extra: 0, accuracy: 0.75 });
    assert.deepEqual(result.troubleSpots, [{ index: 1, names: ['D4'], reason: 'late' }]);

    // D comes 650 ms late, closer to the E that follows: still D's mistake, E stays clean.
    const later = make();
    later.noteOn(60, 64, 0);
    assert.equal(later.noteOn(62, 64, 1650).stepIndex, 1);
    later.noteOn(64, 64, 2000);
    later.noteOn(65, 64, 3000);
    result = later.result();
    assert.deepEqual(result.steps.map((s) => s.state), ['ok', 'missed', 'ok', 'ok']);
    assert.deepEqual(result.steps[2].wrong, []);
    assert.deepEqual(result.troubleSpots, [{ index: 1, names: ['D4'], reason: 'late' }]);

    // E comes 400 ms early and is not played again.
    const early = make();
    early.noteOn(60, 64, 0);
    early.noteOn(62, 64, 1000);
    assert.equal(early.noteOn(64, 64, 1600).stepIndex, 2);
    early.noteOn(65, 64, 3000);
    result = early.result();
    assert.deepEqual(result.steps.map((s) => s.state), ['ok', 'ok', 'missed', 'ok']);
    assert.deepEqual(result.troubleSpots, [{ index: 2, names: ['E4'], reason: 'early' }]);

    // E comes early and then again on the beat: played twice, so not clean, but not missed.
    const twice = make();
    twice.noteOn(60, 64, 0);
    twice.noteOn(62, 64, 1000);
    twice.noteOn(64, 64, 1600);
    assert.equal(twice.noteOn(64, 64, 2010).kind, 'correct');
    twice.noteOn(65, 64, 3000);
    result = twice.result();
    assert.deepEqual(result.steps.map((s) => s.state), ['ok', 'ok', 'error', 'ok']);
    assert.equal(result.totals.wrongNotes, 0);
    assert.equal(result.totals.mistimed, 1);
    assert.deepEqual(result.troubleSpots, [{ index: 2, names: ['E4'], reason: 'early' }]);
  });

  test('notes before the first window or after the last are extra and belong to no step', () => {
    const tracker = tempoTracker();
    const warmup = tracker.noteOn(60, 64, 9000);
    assert.equal(warmup.kind, 'extra');
    assert.equal(warmup.stepIndex, 0);
    assert.equal(tracker.result().totals.extra, 1);
    assert.equal(tracker.result().totals.wrongNotes, 0);
    [60, 62, 64].forEach((midi, i) => tracker.noteOn(midi, 64, 10000 + i * 500));
    // The last step is never played; a key well after its window ends the attempt.
    const after = tracker.noteOn(65, 64, 12000);
    assert.equal(after.kind, 'extra');
    assert.equal(after.finished, true);
    const result = tracker.result();
    assert.equal(result.totals.extra, 2);
    assert.equal(result.totals.missed, 1);
    assert.deepEqual(result.steps.map((s) => s.state), ['ok', 'ok', 'ok', 'missed']);
    assert.ok(result.steps.every((s) => s.wrong.length === 0));
    assert.equal(tracker.noteOn(65, 64, 12100).kind, 'ignored');
    assert.equal(tracker.result().totals.extra, 2);
  });

  test('latencyMs shifts the whole grid later', () => {
    const tracker = tempoTracker([60, 62, 64, 65], { latencyMs: 80 });
    assert.equal(tracker.noteOn(60, 64, 10080).offsetMs, 0);
    assert.equal(tracker.noteOn(62, 64, 10560).offsetMs, -20);
    assert.equal(tracker.noteOn(64, 64, 11000 + 80 + 225).offsetMs, 225);
    assert.equal(tracker.noteOn(65, 64, 11500 + 80 + 226).kind, 'extra');
    const plain = tempoTracker();
    assert.equal(plain.noteOn(60, 64, 10080).offsetMs, 80);
  });

  test('drift: positive when the player falls further behind, negative when they pull ahead', () => {
    const notes = [60, 62, 64, 65, 67, 69, 71, 72];
    const dragging = tempoTracker(notes);
    notes.forEach((midi, i) => dragging.noteOn(midi, 64, 10000 + i * 500 + i * 6));
    const drag = dragging.result().timing;
    assert.equal(drag.driftMsPerBeat, 6);
    assert.equal(drag.meanOffsetMs, 21);
    assert.equal(drag.offsetSdMs, 13.7);
    assert.equal(dragging.result().timing.estBpm, 118.6); // 60000 / 506

    const rushing = tempoTracker(notes);
    notes.forEach((midi, i) => rushing.noteOn(midi, 64, 10000 + i * 500 - i * 4));
    assert.equal(rushing.result().timing.driftMsPerBeat, -4);
    assert.equal(rushing.result().timing.meanOffsetMs, -14);

    const steadyLate = tempoTracker(notes);
    notes.forEach((midi, i) => steadyLate.noteOn(midi, 64, 10000 + i * 500 + 35));
    assert.equal(steadyLate.result().timing.driftMsPerBeat, 0);
    assert.equal(steadyLate.result().timing.meanOffsetMs, 35);
    assert.equal(steadyLate.result().timing.offsetSdMs, 0);
  });

  test('drift is measured per beat, not per step', () => {
    const tracker = new AttemptTracker(
      exercise([60, 62, 64, 65].map((midi) => step([midi], { beats: 2 })), { mode: 'tempo', bpm: 120 }),
    );
    tracker.start(0);
    [60, 62, 64, 65].forEach((midi, i) => tracker.noteOn(midi, 64, i * 1000 + i * 10));
    assert.equal(tracker.result().timing.driftMsPerBeat, 5);
  });

  test('hesitations are a wait-mode measure: tempo mode reports late and early notes instead', () => {
    const notes = [60, 62, 64, 65, 67, 69];
    const tracker = tempoTracker(notes);
    // Step 2 as early and step 3 as late as the windows allow: 950 ms between them, 1.9 beats.
    const offsets = [0, -225, 225, 0, 0, 0];
    notes.forEach((midi, i) => tracker.noteOn(midi, 64, 10000 + i * 500 + offsets[i]));
    const result = tracker.result();
    assert.equal(result.steps[2].ioiMs, 950);
    assert.equal(result.timing.estBpm, 120);
    assert.deepEqual(result.timing.hesitations, []);
    assert.deepEqual(result.troubleSpots, [
      { index: 1, names: ['D4'], reason: 'early' },
      { index: 2, names: ['E4'], reason: 'late' },
    ]);
  });

  test('timing numbers need enough notes', () => {
    const one = tempoTracker();
    one.noteOn(60, 64, 10012);
    assert.equal(one.result().timing.meanOffsetMs, 12);
    assert.equal(one.result().timing.offsetSdMs, null);
    assert.equal(one.result().timing.driftMsPerBeat, null);
    const two = tempoTracker();
    two.noteOn(60, 64, 10010);
    two.noteOn(62, 64, 10530);
    assert.equal(two.result().timing.meanOffsetMs, 20);
    assert.equal(two.result().timing.offsetSdMs, 10);
    assert.equal(two.result().timing.driftMsPerBeat, null); // a line through two points says nothing
    const none = tempoTracker();
    assert.deepEqual(none.result().timing, {
      estBpm: null, evennessCv: null, hesitations: [], meanOffsetMs: null, offsetSdMs: null, driftMsPerBeat: null,
      offsetCount: 0, offsetSpanBeats: null,
    });
  });

  test('chords: every note has its own offset; a chord with a note missing is an error', () => {
    const steps = [step([60, 64, 67], { beats: 2 }), step([62, 65, 69], { beats: 2 })];
    const tracker = new AttemptTracker(exercise(steps, { mode: 'tempo', bpm: 120 }));
    tracker.start(1000);
    const a = tracker.noteOn(60, 60, 990);
    assert.equal(a.kind, 'correct');
    assert.equal(a.stepCompleted, false);
    assert.equal(a.offsetMs, -10);
    assert.deepEqual(tracker.pendingNotes(), [64, 67]);
    assert.equal(tracker.noteOn(64, 70, 1000).stepCompleted, false);
    const c = tracker.noteOn(67, 80, 1020);
    assert.equal(c.stepCompleted, true);
    assert.equal(c.offsetMs, 20);
    assert.equal(tracker.stepIndex, 1);

    tracker.noteOn(62, 64, 2000);
    tracker.noteOn(69, 64, 2040);
    assert.deepEqual(tracker.pendingNotes(), [65]);
    assert.deepEqual(tracker.tick(2300 + 121), { missed: [1], finished: true });

    const result = tracker.result();
    assert.deepEqual(result.steps.map((s) => s.state), ['ok', 'error']);
    assert.equal(result.steps[0].offsetMs, 3.3);
    assert.equal(result.steps[0].chordSpreadMs, 30);
    assert.equal(result.steps[0].velocity, 70);
    assert.equal(result.steps[1].offsetMs, 20);
    assert.equal(result.steps[1].chordSpreadMs, 40);
    assert.deepEqual(result.steps[1].missed, [65]);
    assert.deepEqual(result.totals, { steps: 2, played: 2, clean: 1, wrongNotes: 0, mistimed: 0, missed: 1, extra: 0, accuracy: 0.5 });
    assert.equal(result.timing.meanOffsetMs, 10); // (-10 + 0 + 20 + 0 + 40) / 5
    assert.deepEqual(result.troubleSpots, [{ index: 1, names: ['D4', 'F4', 'A4'], reason: 'missed' }]);
  });

  test('both-hands steps in tempo mode', () => {
    const both = (low, high) => step([low, high], { hands: ['L', 'R'] });
    const tracker = new AttemptTracker(exercise([both(48, 60), both(50, 62)], { hand: 'both', mode: 'tempo', bpm: 60 }));
    tracker.start(0);
    tracker.noteOn(60, 64, 10);
    tracker.noteOn(48, 64, 30);
    tracker.noteOn(62, 64, 1005);
    assert.deepEqual(tracker.tick(1300 + 121), { missed: [1], finished: true }); // left hand never arrived
    const result = tracker.result();
    assert.deepEqual(result.steps.map((s) => s.state), ['ok', 'error']);
    assert.deepEqual(result.steps[1].missed, [50]);
    assert.equal(result.steps[0].offsetMs, 20);
  });

  test('rests only add time', () => {
    // C (1 beat), rest (1 beat), D (1 beat), E: due at 0, 1000, 1500 ms at 120 bpm.
    const steps = [step([60]), step([]), step([62]), step([64])];
    const tracker = new AttemptTracker(exercise(steps, { mode: 'tempo', bpm: 120 }));
    tracker.start(0);
    assert.equal(tracker.noteOn(60, 64, 0).offsetMs, 0);
    assert.equal(tracker.stepIndex, 2);
    assert.deepEqual(tracker.stepStates, ['ok', 'ok', 'current', 'pending']);
    assert.equal(tracker.noteOn(62, 64, 500).kind, 'extra'); // played in the rest
    assert.equal(tracker.noteOn(62, 64, 1010).offsetMs, 10);
    assert.equal(tracker.noteOn(64, 64, 1500).finished, true);
    const result = tracker.result();
    assert.equal(result.totals.steps, 3);
    assert.equal(result.totals.wrongNotes, 0); // the early D was the right key at the wrong time
    assert.equal(result.totals.mistimed, 1);
    assert.equal(result.steps[2].ioiMs, 1010);
  });

  test('anyOctave applies in tempo mode too', () => {
    const strict = tempoTracker();
    assert.equal(strict.noteOn(72, 64, 10000).kind, 'extra');
    const loose = tempoTracker([60, 62, 64, 65], { anyOctave: true });
    const judged = loose.noteOn(72, 64, 10000);
    assert.equal(judged.kind, 'correct');
    assert.deepEqual(judged.expected, [60]);
  });

  test('without start() the first note played is beat 0', () => {
    const tracker = new AttemptTracker(melody([60, 62, 64], { mode: 'tempo', bpm: 120 }));
    assert.deepEqual(tracker.tick(5000), { missed: [], finished: false });
    assert.equal(tracker.noteOn(60, 64, 7000).offsetMs, 0);
    assert.equal(tracker.noteOn(62, 64, 7520).offsetMs, 20);
    tracker.start(99999); // too late to move the grid
    assert.equal(tracker.noteOn(64, 64, 7990).offsetMs, -10);
    assert.equal(tracker.finished, true);
  });

  test('the attempt ends by itself after the last window when nothing is played', () => {
    const tracker = tempoTracker();
    assert.deepEqual(tracker.tick(10000), { missed: [], finished: false });
    assert.deepEqual(tracker.tick(11725 + 120), { missed: [0, 1, 2], finished: false });
    assert.deepEqual(tracker.tick(11725 + 121), { missed: [3], finished: true });
    const result = tracker.result();
    assert.equal(result.completed, true);
    assert.deepEqual(result.totals, { steps: 4, played: 0, clean: 0, wrongNotes: 0, mistimed: 0, missed: 4, extra: 0, accuracy: 0 });
    assert.deepEqual(result.dynamics, { mean: null, sd: null, min: null, max: null });
    assert.equal(result.troubleSpots.length, 4);
    assert.equal(tracker.noteOn(60, 64, 12000).kind, 'ignored');
  });

  test('an abandoned tempo attempt: unresolved steps stay pending', () => {
    const tracker = tempoTracker();
    tracker.noteOn(60, 64, 10010);
    tracker.noteOn(62, 64, 10480);
    tracker.tick(10600);
    const result = tracker.result();
    assert.equal(result.completed, false);
    assert.deepEqual(result.steps.map((s) => s.state), ['ok', 'ok', 'current', 'pending']);
    assert.equal(result.totals.missed, 0);
    assert.equal(result.totals.accuracy, 0.5);
    assert.equal(result.durationMs, 600);
  });

  test('late and early trouble spots, the largest offset first', () => {
    // 60 bpm: gap 1000 ms, a step is a trouble spot from 120 ms off the click.
    const notes = [60, 62, 64, 65, 67, 69];
    const tracker = new AttemptTracker(melody(notes, { mode: 'tempo', bpm: 60 }));
    tracker.start(0);
    const offsets = [0, 130, -125, 100, -119, 200];
    notes.forEach((midi, i) => tracker.noteOn(midi, 64, i * 1000 + offsets[i]));
    const result = tracker.result();
    assert.equal(result.totals.accuracy, 1);
    assert.deepEqual(result.troubleSpots, [
      { index: 5, names: ['A4'], reason: 'late' },
      { index: 1, names: ['D4'], reason: 'late' },
      { index: 2, names: ['E4'], reason: 'early' },
    ]);
  });

  test('missed outranks wrong notes, which outrank timing', () => {
    const notes = [60, 62, 64, 65, 67];
    const tracker = new AttemptTracker(melody(notes, { mode: 'tempo', bpm: 60 }));
    tracker.start(0);
    tracker.noteOn(60, 64, 200); // late
    tracker.noteOn(62, 64, 1000);
    tracker.noteOn(63, 64, 1050); // extra key next to step 2
    // step 3 (index 2) not played
    tracker.noteOn(65, 64, 3000);
    tracker.noteOn(67, 64, 4000);
    assert.deepEqual(tracker.result().troubleSpots.map((s) => [s.index, s.reason]), [
      [2, 'missed'], [1, 'wrong_notes'], [0, 'late'],
    ]);
  });

  test('the scripted run of the end-to-end test: every note on the grid, held for 60% of its length', () => {
    const ex = scaleExercise({ mode: 'tempo', bpm: 61 });
    const tracker = new AttemptTracker(ex, { mode: ex.mode, bpm: ex.bpm, anyOctave: false, latencyMs: 0 });
    const start = 52341.7;
    tracker.start(start);
    const beatMs = 60000 / ex.bpm;
    let finished = false;
    SCALE_NOTES.forEach((midi, i) => {
      tracker.tick(start + i * beatMs - 5);
      const judged = tracker.noteOn(midi, 80, start + i * beatMs);
      finished = judged.finished;
      tracker.noteOff(midi, start + i * beatMs + beatMs * 0.6);
    });
    assert.equal(finished, true);
    const result = tracker.result();
    assert.equal(result.completed, true);
    assert.equal(result.totals.accuracy, 1);
    assert.ok(Math.abs(result.timing.meanOffsetMs) < 1);
    assert.ok(result.timing.offsetSdMs < 1);
  });

  test('bad input never throws in tempo mode', () => {
    const tracker = tempoTracker();
    tracker.start(NaN);
    tracker.start('soon');
    assert.deepEqual(tracker.tick(NaN), { missed: [], finished: false });
    assert.deepEqual(tracker.tick(undefined), { missed: [], finished: false });
    assert.equal(tracker.noteOn(NaN, 64, 10000).kind, 'ignored');
    assert.equal(tracker.noteOn(60, 'loud', 10000).kind, 'correct');
    tracker.noteOff(60, NaN);
    tracker.noteOff(99, 10100);
    assert.equal(tracker.result().steps[0].velocity, null);
    assert.equal(tracker.result().steps[0].offsetMs, 0);
  });
});

// ---------------------------------------------------------------- free play

/** Feed single notes: each entry is [midi, onMs, durMs, velocity]. */
function feed(analyzer, notes) {
  const events = [];
  for (const [midi, on, dur = 200, velocity = 64] of notes) {
    events.push({ t: on, on: true, midi, velocity });
    events.push({ t: on + dur, on: false, midi });
  }
  events.sort((a, b) => a.t - b.t || (a.on ? 1 : -1));
  for (const e of events) {
    if (e.on) analyzer.noteOn(e.midi, e.velocity, e.t);
    else analyzer.noteOff(e.midi, e.t);
  }
}

/** Evenly spaced single notes. */
function run(midis, gapMs, startMs = 0, durMs = null) {
  return midis.map((midi, i) => [midi, startMs + i * gapMs, durMs ?? Math.round(gapMs * 0.8)]);
}

describe('FreePlayAnalyzer', () => {
  test('a phrase ends after the gap and is returned exactly once', () => {
    const analyzer = new FreePlayAnalyzer();
    assert.equal(analyzer.tick(0), null);
    feed(analyzer, run([60, 62, 64, 65, 67], 300, 1000, 250)); // last note off at 2450
    assert.equal(analyzer.tick(2450 + 1799), null);
    const phrase = analyzer.tick(2450 + 1800);
    assert.ok(phrase);
    assert.equal(phrase.startMs, 1000);
    assert.equal(phrase.durationMs, 1450);
    assert.equal(phrase.noteCount, 5);
    assert.deepEqual(phrase.notes[0], { midi: 60, name: 'C4', onMs: 0, durMs: 250, velocity: 64 });
    assert.deepEqual(phrase.notes[4], { midi: 67, name: 'G4', onMs: 1200, durMs: 250, velocity: 64 });
    assert.deepEqual(phrase.range, { low: 60, high: 67 });
    assert.equal(phrase.maxPolyphony, 1);
    assert.equal(phrase.pedalUsed, false);
    assert.deepEqual(phrase.chords, []);
    assert.equal(analyzer.tick(2450 + 1801), null);
    assert.equal(analyzer.tick(99999), null);
  });

  test('two phrases separated by silence, with and without ticks in between', () => {
    const ticked = new FreePlayAnalyzer();
    feed(ticked, run([60, 62, 64, 65], 300, 0, 250));
    const first = ticked.tick(3000);
    assert.equal(first.noteCount, 4);
    feed(ticked, run([72, 71, 69, 67, 65], 300, 5000, 250));
    assert.equal(ticked.tick(5100 + 1200), null);
    const second = ticked.tick(9000);
    assert.equal(second.noteCount, 5);
    assert.equal(second.startMs, 5000);
    assert.equal(second.notes[0].name, 'C5');

    const lazy = new FreePlayAnalyzer();
    feed(lazy, run([60, 62, 64, 65], 300, 0, 250));
    feed(lazy, run([72, 71, 69, 67, 65], 300, 5000, 250)); // no tick during the silence
    const a = lazy.tick(6500);
    assert.equal(a.noteCount, 4);
    assert.equal(a.durationMs, 1150);
    assert.equal(lazy.tick(6600), null);
    const b = lazy.tick(9000);
    assert.equal(b.noteCount, 5);
    assert.equal(lazy.tick(9100), null);
  });

  test('phrases shorter than minNotes are dropped silently', () => {
    const analyzer = new FreePlayAnalyzer();
    feed(analyzer, run([60, 62, 64], 300));
    assert.equal(analyzer.tick(5000), null);
    feed(analyzer, run([60, 62, 64, 65], 300, 6000));
    assert.equal(analyzer.tick(10000).noteCount, 4);

    const strict = new FreePlayAnalyzer({ minNotes: 6 });
    feed(strict, run([60, 62, 64, 65, 67], 300));
    assert.equal(strict.tick(5000), null);
    const loose = new FreePlayAnalyzer({ minNotes: 1 });
    feed(loose, run([60], 300));
    assert.equal(loose.tick(5000).noteCount, 1);
  });

  test('the gap setting is respected, and a held key keeps the phrase open', () => {
    const quick = new FreePlayAnalyzer({ phraseGapMs: 500 });
    feed(quick, run([60, 62, 64, 65], 200, 0, 100)); // last off at 700
    assert.equal(quick.tick(1199), null);
    assert.equal(quick.tick(1200).noteCount, 4);

    const held = new FreePlayAnalyzer();
    feed(held, run([60, 62, 64], 300, 0, 250));
    held.noteOn(72, 64, 900); // long final note
    assert.equal(held.tick(6000), null);
    held.noteOff(72, 6500);
    assert.equal(held.tick(8299), null);
    const phrase = held.tick(8300);
    assert.equal(phrase.durationMs, 6500);
    assert.equal(phrase.notes[3].durMs, 5600);
  });

  test('a stuck key (lost note-off) cannot keep a phrase open for ever', () => {
    const analyzer = new FreePlayAnalyzer();
    feed(analyzer, run([60, 62, 64], 300, 0, 250));
    analyzer.noteOn(72, 64, 900);
    assert.equal(analyzer.tick(900 + 11799), null);
    const phrase = analyzer.tick(900 + 11800);
    assert.equal(phrase.noteCount, 4);
    // The stuck key is forgotten: the next phrase ends after the normal gap.
    feed(analyzer, run([60, 62, 64, 65], 300, 20000, 250));
    assert.equal(analyzer.tick(21150 + 1800).noteCount, 4);
  });

  test('block chords are named in order and consecutive repeats are collapsed', () => {
    const analyzer = new FreePlayAnalyzer();
    const chord = (midis, at) => midis.map((midi, i) => [midi, at + i * 12, 600]);
    feed(analyzer, [
      ...chord([60, 64, 67], 0),
      ...chord([60, 64, 67], 800),
      ...chord([65, 69, 72], 1600),
      ...chord([67, 71, 74, 77], 2400),
      ...chord([64, 67, 72], 3200),
    ]);
    const phrase = analyzer.tick(9000);
    assert.deepEqual(phrase.chords, [
      { name: 'C', atMs: 0 },
      { name: 'F', atMs: 1600 },
      { name: 'G7', atMs: 2400 },
      { name: 'C/E', atMs: 3200 },
    ]);
    assert.equal(phrase.maxPolyphony, 4);
    assert.equal(phrase.noteCount, 16);
    assert.equal(phrase.evennessCv, null); // no single-note gaps to judge
  });

  test('notes more than 60 ms apart are not one chord, and two-note groups are not named', () => {
    const analyzer = new FreePlayAnalyzer();
    feed(analyzer, [
      [60, 0, 900], [64, 100, 800], [67, 200, 700], // rolled slowly
      [60, 1000, 300], [67, 1010, 300], // a fifth
      [62, 1500, 300], [65, 1560, 300], [69, 1500, 300], // within 60 ms
    ]);
    assert.deepEqual(analyzer.tick(9000).chords, [{ name: 'Dm', atMs: 1500 }]);
  });

  test('the 60 ms rule is measured from the first note of the group', () => {
    const inside = new FreePlayAnalyzer();
    feed(inside, [[60, 0, 500], [64, 30, 500], [67, 60, 500], [72, 1000, 300]]);
    assert.deepEqual(inside.tick(9000).chords, [{ name: 'C', atMs: 0 }]);
    const outside = new FreePlayAnalyzer();
    feed(outside, [[60, 0, 500], [64, 61, 500], [67, 100, 500], [72, 1000, 300]]);
    assert.deepEqual(outside.tick(9000).chords, []);
  });

  test('key: long notes weigh more than short ones', () => {
    // Quick C major figures, then long A, E, C, A: by note count this is C major, by ear A minor.
    const quick = [60, 64, 67, 72, 67, 64, 60, 62, 64, 65, 67, 71, 72].map((midi) => [midi, 120]);
    const analyzer = new FreePlayAnalyzer({ phraseGapMs: 3000 });
    let t = 0;
    for (const [midi, dur] of [...quick, [69, 1900], [76, 1500], [72, 900], [69, 1900]]) {
      analyzer.noteOn(midi, 64, t);
      analyzer.noteOff(midi, t + dur);
      t += dur + 50;
    }
    const phrase = analyzer.tick(t + 5000);
    assert.deepEqual([phrase.key.tonic, phrase.key.mode], ['A', 'minor']);
  });

  test('key: estimated from eight or more notes with five or more different pitch classes', () => {
    const cMajor = new FreePlayAnalyzer();
    feed(cMajor, run(SCALE_NOTES, 300));
    const c = cMajor.tick(20000);
    assert.equal(c.key.tonic, 'C');
    assert.equal(c.key.mode, 'major');
    assert.ok(c.key.confidence > 0 && c.key.confidence <= 1);

    // G major scale with a long tonic at both ends.
    const gMajor = new FreePlayAnalyzer();
    const g = [67, 69, 71, 72, 74, 76, 78, 79, 78, 76, 74, 72, 71, 69, 67];
    feed(gMajor, g.map((midi, i) => [midi, i * 300, i === 0 || i === 14 ? 1200 : 250]));
    const gKey = gMajor.tick(20000);
    assert.deepEqual([gKey.key.tonic, gKey.key.mode], ['G', 'major']);
    assert.equal(gKey.notes[6].name, 'F#5');

    const few = new FreePlayAnalyzer();
    feed(few, run([60, 62, 64, 65, 67, 69, 71], 300)); // 7 notes
    assert.equal(few.tick(20000).key, null);
    const narrow = new FreePlayAnalyzer();
    feed(narrow, run([60, 62, 64, 65, 60, 62, 64, 65, 60, 62], 300)); // 4 pitch classes
    assert.equal(narrow.tick(20000).key, null);
  });

  test('note names follow the estimated key', () => {
    const analyzer = new FreePlayAnalyzer();
    // F major: the B flat must not come out as A sharp.
    const f = [65, 67, 69, 70, 72, 74, 76, 77, 76, 74, 72, 70, 69, 67, 65];
    feed(analyzer, f.map((midi, i) => [midi, i * 300, i === 0 || i === 14 ? 1200 : 250]));
    const phrase = analyzer.tick(20000);
    assert.deepEqual([phrase.key.tonic, phrase.key.mode], ['F', 'major']);
    assert.equal(phrase.notes[3].name, 'Bb4');
  });

  test('tempo: metronomic notes give the bpm with full confidence', () => {
    const analyzer = new FreePlayAnalyzer();
    feed(analyzer, run([60, 62, 64, 65, 67, 65, 64, 62], 500));
    const phrase = analyzer.tick(20000);
    assert.deepEqual(phrase.tempo, { bpm: 120, confidence: 1 });
    assert.equal(phrase.evennessCv, 0);
  });

  test('tempo: needs six onsets, and is folded into 40..200 bpm', () => {
    const five = new FreePlayAnalyzer();
    feed(five, run([60, 62, 64, 65, 67], 500));
    assert.equal(five.tick(20000).tempo, null);

    const fast = new FreePlayAnalyzer();
    feed(fast, run([60, 62, 64, 65, 67, 65, 64, 62], 250)); // 240 notes a minute
    assert.deepEqual(fast.tick(20000).tempo, { bpm: 120, confidence: 1 });

    const slow = new FreePlayAnalyzer({ phraseGapMs: 4000 });
    feed(slow, run([60, 62, 64, 65, 67, 65], 2000)); // 30 notes a minute
    assert.deepEqual(slow.tick(40000).tempo, { bpm: 60, confidence: 1 });
  });

  test('tempo and evenness: long and short notes in exact proportion are still steady', () => {
    // "Twinkle" rhythm: six quarters and a half note, twice.
    const beats = [1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2];
    const midis = [60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60];
    const notes = [];
    let t = 0;
    beats.forEach((b, i) => {
      notes.push([midis[i], t, 300]);
      t += b * 600;
    });
    const analyzer = new FreePlayAnalyzer();
    feed(analyzer, notes);
    const phrase = analyzer.tick(30000);
    assert.deepEqual(phrase.tempo, { bpm: 100, confidence: 1 });
    assert.equal(phrase.evennessCv, 0);
  });

  test('tempo and evenness: irregular playing has low confidence and a high variation', () => {
    const gaps = [500, 640, 390, 730, 450, 580, 820, 340, 610, 470];
    const notes = [];
    let t = 0;
    for (let i = 0; i <= gaps.length; i++) {
      notes.push([60 + (i % 5), t, 200]);
      t += gaps[i] ?? 0;
    }
    const analyzer = new FreePlayAnalyzer();
    feed(analyzer, notes);
    const phrase = analyzer.tick(30000);
    assert.ok(phrase.tempo.confidence < 0.5, `confidence ${phrase.tempo.confidence}`);
    assert.ok(phrase.tempo.bpm >= 40 && phrase.tempo.bpm <= 200);
    assert.ok(phrase.evennessCv > 0.15, `cv ${phrase.evennessCv}`);

    // A human-steady player: a few percent of jitter.
    const jitter = [12, -9, 5, -14, 8, -3, 10, -7, 2, -11];
    const steady = [];
    t = 0;
    for (let i = 0; i <= jitter.length; i++) {
      steady.push([60 + (i % 5), t, 200]);
      t += 500 + (jitter[i] ?? 0);
    }
    const human = new FreePlayAnalyzer();
    feed(human, steady);
    const good = human.tick(30000);
    assert.ok(good.tempo.confidence > 0.8, `confidence ${good.tempo.confidence}`);
    assert.ok(Math.abs(good.tempo.bpm - 120) < 3);
    assert.ok(good.evennessCv > 0 && good.evennessCv < 0.05, `cv ${good.evennessCv}`);
  });

  test('dynamics, polyphony and pedal', () => {
    const analyzer = new FreePlayAnalyzer();
    analyzer.pedal(true, 50);
    analyzer.pedal(false, 80); // pedal up again before the phrase starts
    feed(analyzer, [[60, 100, 200, 40], [62, 400, 200, 60], [64, 700, 200, 80], [65, 1000, 200, 100]]);
    const dry = analyzer.tick(5000);
    assert.deepEqual(dry.dynamics, { mean: 70, sd: 22.4, min: 40, max: 100 });
    assert.equal(dry.pedalUsed, false);
    assert.equal(dry.maxPolyphony, 1);

    feed(analyzer, [[60, 6000, 900], [64, 6100, 800], [67, 6200, 700], [72, 6300, 600]]);
    analyzer.pedal(true, 6400);
    analyzer.pedal(false, 6800);
    const wet = analyzer.tick(12000);
    assert.equal(wet.pedalUsed, true);
    assert.equal(wet.maxPolyphony, 4);

    analyzer.pedal(true, 13000); // pedal goes down first and stays down
    feed(analyzer, run([60, 62, 64, 65], 300, 14000));
    assert.equal(analyzer.tick(20000).pedalUsed, true);
  });

  test('cap: a phrase is closed at 400 notes and a new one starts', () => {
    const analyzer = new FreePlayAnalyzer();
    const midis = Array.from({ length: 450 }, (_, i) => 60 + (i % 12));
    feed(analyzer, run(midis, 100, 0, 60));
    const first = analyzer.tick(45000);
    assert.equal(first.noteCount, 400);
    assert.equal(first.startMs, 0);
    assert.equal(analyzer.tick(45100), null);
    const second = analyzer.tick(60000);
    assert.equal(second.noteCount, 50);
    assert.equal(second.startMs, 40000);
  });

  test('cap: a phrase is closed after 90 seconds', () => {
    const analyzer = new FreePlayAnalyzer();
    const midis = Array.from({ length: 100 }, (_, i) => 60 + (i % 5));
    feed(analyzer, run(midis, 1000, 0, 700));
    const first = analyzer.tick(100000);
    assert.equal(first.noteCount, 90);
    assert.ok(first.durationMs <= 90000);
    const second = analyzer.tick(110000);
    assert.equal(second.noteCount, 10);
    assert.equal(second.startMs, 90000);

    // With a key held down the whole time, tick() applies the cap by itself.
    const drone = new FreePlayAnalyzer();
    drone.noteOn(36, 64, 0);
    feed(drone, run(midis.slice(0, 85), 1000, 500, 700));
    assert.equal(drone.tick(89999), null);
    const closed = drone.tick(90000);
    assert.equal(closed.noteCount, 86);
    assert.equal(closed.notes[0].durMs, 90000);
  });

  test('snapshot shows the phrase in progress without ending it', () => {
    const analyzer = new FreePlayAnalyzer();
    assert.equal(analyzer.snapshot(0), null);
    feed(analyzer, run([60, 62, 64], 300, 0, 250));
    analyzer.noteOn(65, 64, 900);
    const snap = analyzer.snapshot(1400);
    assert.equal(snap.noteCount, 4);
    assert.equal(snap.notes[3].durMs, 500);
    assert.equal(snap.durationMs, 1400);
    analyzer.noteOff(65, 1500);
    const phrase = analyzer.tick(4000);
    assert.equal(phrase.noteCount, 4);
    assert.equal(phrase.notes[3].durMs, 600);
    assert.equal(analyzer.snapshot(4100), null);
  });

  test('a key struck twice without a note-off, and other bad input, are handled', () => {
    const analyzer = new FreePlayAnalyzer({ phraseGapMs: -1, minNotes: 'many' }); // falls back to the defaults
    for (const bad of [NaN, undefined, 'C4', 60.5, -1, 128]) {
      analyzer.noteOn(bad, 64, 0);
      analyzer.noteOff(bad, 0);
    }
    analyzer.noteOff(60, 0); // never on
    analyzer.pedal(undefined, NaN);
    assert.equal(analyzer.tick(NaN), null);
    assert.equal(analyzer.snapshot(NaN), null);

    analyzer.noteOn(60, 200, 1000);
    analyzer.noteOn(60, 0, 1300); // again, no note-off between
    analyzer.noteOn(62, NaN, 1600);
    analyzer.noteOn(64, 64, 1590); // time going back a little
    analyzer.noteOff(60, 1700);
    analyzer.noteOff(62, 1800);
    analyzer.noteOff(64, undefined);
    const phrase = analyzer.tick(1800 + 1800);
    assert.equal(phrase.noteCount, 4);
    assert.deepEqual(phrase.notes.map((n) => [n.onMs, n.durMs, n.velocity]), [
      [0, 300, 127], [300, 400, 1], [600, 200, null], [600, 200, 64],
    ]);
    assert.deepEqual(phrase.dynamics, { mean: 64, sd: 51.4, min: 1, max: 127 });
    assert.equal(new FreePlayAnalyzer(null).tick(0), null);
  });
});
