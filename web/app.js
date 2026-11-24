// Practice Coach: browser entry point. Wires the piano input, the exercise
// tracker, the notation, the on-screen keyboard and the coach together.

import { MidiInput } from './midi/input.js';
import { AudioEngine } from './audio/engine.js';
import { renderStaff } from './ui/staff.js';
import { Keyboard } from './ui/keyboard.js';
import { CoachSession, Speaker } from './coach-session.js';
import { fetchHealth } from './coach-client.js';
import { loadState, saveState, saveStateNow, clearState, todayKey } from './store.js';
import { buildExercise, validateExercise, withTempo, describeExercise, STARTER_EXERCISES } from '../shared/exercises.js';
import { AttemptTracker, FreePlayAnalyzer } from '../shared/tracker.js';
import * as summary from '../shared/summary.js';
import { detectChord, spellMidi } from '../shared/theory.js';
import { midiToName } from '../shared/midi.js';

const $ = (id) => document.getElementById(id);

const els = {
  pill: $('conn-pill'),
  connect: $('btn-connect'),
  title: $('ex-title'),
  goal: $('ex-goal'),
  staff: $('staff'),
  status: $('ex-status'),
  result: $('ex-result'),
  progressBar: $('ex-progress-bar'),
  start: $('btn-start'),
  demo: $('btn-demo'),
  hint: $('btn-hint'),
  next: $('btn-next'),
  parent: $('btn-parent'),
  modeWait: $('mode-wait'),
  modeTempo: $('mode-tempo'),
  bpm: $('bpm-value'),
  banner: $('pending-banner'),
  bannerText: $('pending-text'),
  liveNotes: $('live-notes'),
  livePedal: $('live-pedal'),
  countin: $('countin'),
  coachMode: $('coach-mode'),
  coachLog: $('coach-log'),
  coachInput: $('coach-input'),
  midiLog: $('midi-log'),
};

const state = loadState();
const input = new MidiInput();
const audio = new AudioEngine();
const speaker = new Speaker();
const freeplay = new FreePlayAnalyzer();

/** @type {object|null} the exercise on screen */
let exercise = null;
let staff = null;
/** @type {AttemptTracker|null} */
let tracker = null;
const attempt = { status: 'ready', wrongOnStep: 0, hintedStep: -1, lastActivity: 0, finishedAt: 0 };
let metronome = null;
let demo = null;
let rafId = 0;
let finishTimer = 0;
let view = 'exercise';
let pendingSwitch = null; // { exercise, parent } suggested by the coach mid-attempt
let lastAutoHintAt = 0;
let lastFreePlayCoachAt = 0;
let lastNoteAt = 0;
let lastNote = null;
let lastResult = null; // the most recent finished AttemptResult
let finishedCount = 0; // tries finished since the page loaded
let finishStrike = null; // { time, velocity } of the note that completed the last try (for seamless looping)
let exerciseNames = new Map(); // MIDI number -> the name this exercise spells it with
let freePlayKey = null; // last confident key guess in free play, for note spelling

const REARM_MS = 1500; // quiet time after a finished try before the next one is armed
const MIN_REPORT_GAP_MS = 8000; // tries are reported to the coach no more often than this
const LEVEL_LABELS = {
  new: 'brand new, never played',
  beginner: 'beginner, knows a few notes',
  returning: 'coming back after years away',
  intermediate: 'intermediate, plays pieces with both hands',
};
let lastKeyAt = 0; // performance.now() of the newest key press
let lastReportAt = 0; // Date.now() of the last try report sent to the coach
let heldReport = null; // newest try report, waiting for the gap to pass
let heldTimer = 0;
let sinceReport = { tries: 0, clean: 0 }; // tries finished since the last report went out
let suggestion = null; // exercise the coach offered while the learner was in free play
let connectionNotice = false; // the status line is showing a connection message
const LOOP_JOIN_MS = 2500; // how soon after the last note a second round may run straight on
let virtualOctave = 0;
let health = null;
const previousResults = new Map(); // exercise id -> last AttemptResult
const attemptCounts = new Map(); // exercise id -> attempts this visit
const rawLog = [];

const keyboard = new Keyboard($('keyboard'), {
  onNoteOn: (midi) => {
    audio.resume();
    input.noteOn(midi, 84);
  },
  onNoteOff: (midi) => input.noteOff(midi),
});

const coach = new CoachSession({
  logEl: els.coachLog,
  getSession: () => state.session,
  getExercise: () => exercise,
  buildPreamble: () => sessionStartText(),
  onAction: (action, event) => applyCoachAction(action, event),
  onNotes: (text) => {
    state.notes = text.slice(0, 1200);
    saveState(state);
  },
  onDone: (done) => recordUsage(done),
  onChange: () => saveState(state),
  speaker,
});

// ------------------------------------------------------------------ exercises

function starterExercise(index = 0) {
  const built = buildExercise(STARTER_EXERCISES[index] ?? STARTER_EXERCISES[0]);
  return built.ok ? built.exercise : null;
}

function isUsableExercise(candidate) {
  try {
    return Boolean(candidate) && validateExercise(candidate).length === 0;
  } catch {
    return false;
  }
}

/** Put an exercise on screen and get ready for a first attempt. */
function loadExercise(next, { parent = null, keepResult = false } = {}) {
  if (!isUsableExercise(next)) return false;
  stopDemo();
  exercise = next;
  pendingSwitch = null;
  finishStrike = null;
  clearTimeout(heldTimer);
  heldReport = null;
  sinceReport = { tries: 0, clean: 0 };
  exerciseNames = new Map();
  for (const step of next.steps) step.notes.forEach((midi, i) => exerciseNames.has(midi) || exerciseNames.set(midi, step.names[i]));
  // Reports and hints still waiting in the queue are about an exercise that is no longer on screen.
  coach.discardQueued((event) => (event.kind === 'attempt' || event.kind === 'hint') && event.exercise?.id !== next.id);
  els.banner.hidden = true;
  state.session.exercise = next;
  state.session.parent = parent;
  saveState(state);

  els.title.textContent = next.title;
  els.goal.textContent = next.goal;
  els.parent.hidden = !parent;
  // After a coach decision the last result stays on screen until the learner plays again.
  if (!keepResult) els.result.hidden = true;
  // Show the exercise view first: the notation needs a visible container to size itself.
  if (view !== 'exercise') showView('exercise');
  drawStaff();
  const notes = next.steps.flatMap((step) => step.notes);
  if (notes.length) keyboard.fitTo(notes);
  updateControls();
  newAttempt({ keepResult });
  return true;
}

function drawStaff() {
  staff?.destroy();
  staff = renderStaff(els.staff, exercise, {
    showNames: state.settings.showNames,
    showFingers: state.settings.showFingers,
  });
}

function updateControls() {
  if (!exercise) return;
  els.bpm.textContent = String(exercise.bpm);
  const tempo = exercise.mode === 'tempo';
  els.modeWait.classList.toggle('is-active', !tempo);
  els.modeTempo.classList.toggle('is-active', tempo);
  els.start.textContent = tempo ? (attempt.status === 'countin' || attempt.status === 'playing' ? 'Stop' : 'Start') : 'Restart';
}

function changeTempo({ bpm = exercise.bpm, mode = exercise.mode }) {
  if (!exercise) return;
  // The learner's own choice wins over a tempo change or drill the coach had queued up.
  if (pendingSwitch?.basis) dropPendingSwitch();
  const changed = withTempo(exercise, { bpm, mode });
  if (!isUsableExercise(changed)) return;
  exercise = changed;
  state.session.exercise = changed;
  saveState(state);
  updateControls();
  newAttempt();
}

/** A fresh tracker for the current exercise. */
function newAttempt({ keepResult = false } = {}) {
  cancelAnimationFrame(rafId);
  clearTimeout(finishTimer);
  stopMetronome();
  tracker = new AttemptTracker(exercise, {
    mode: exercise.mode,
    bpm: exercise.bpm,
    anyOctave: state.settings.anyOctave,
    latencyMs: state.settings.latencyMs,
  });
  attempt.status = 'ready';
  attempt.wrongOnStep = 0;
  attempt.hintedStep = -1;
  attempt.lastActivity = 0;
  attempt.lastWrong = null;
  attempt.virtualNotes = 0;
  attempt.pianoNotes = 0;
  if (!keepResult) els.result.hidden = true;
  keyboard.releaseAll();
  for (const midi of input.held.keys()) keyboard.setDown(midi, true);
  updateControls();
  refreshProgress();
  setStatus(
    exercise.mode === 'tempo'
      ? 'Press Start, wait for the count-in, then play with the click.'
      : 'Play the first note when you are ready. The app waits for you.',
  );
}

function setStatus(text, tone = null) {
  els.status.textContent = text;
  els.status.classList.toggle('is-bad', tone === 'bad');
  els.status.classList.toggle('is-good', tone === 'good');
}

function currentStep() {
  if (!exercise || !tracker) return null;
  return exercise.steps[Math.min(tracker.stepIndex, exercise.steps.length - 1)] ?? null;
}

function pendingTargets() {
  if (!tracker || tracker.finished) return [];
  const step = currentStep();
  return tracker.pendingNotes().map((midi) => {
    const i = step ? step.notes.indexOf(midi) : -1;
    return {
      midi,
      finger: i >= 0 ? step.fingers[i] : null,
      hand: i >= 0 ? step.hands[i] : 'R',
      name: i >= 0 ? step.names[i] : midiToName(midi),
    };
  });
}

function describeTargets(targets) {
  return targets
    .map((t) => (t.finger && state.settings.showFingers ? `${t.name} (finger ${t.finger})` : t.name))
    .join(' + ');
}

function refreshProgress() {
  if (!tracker || !exercise) return;
  const total = exercise.steps.length;
  const index = Math.min(tracker.stepIndex, total);
  staff?.update(tracker.stepStates, tracker.finished ? -1 : index);
  els.progressBar.style.width = `${Math.round((index / total) * 100)}%`;
  const targets = pendingTargets();
  keyboard.setTargets(state.settings.keyHints ? targets : []);
  if (attempt.status === 'playing' && exercise.mode === 'wait' && targets.length) {
    setStatus(`Step ${index + 1} of ${total}. Next: ${describeTargets(targets)}.`);
  }
}

// ------------------------------------------------------------------ playing

function onNote(note) {
  const on = note.type === 'on';
  if (note.source === 'virtual') {
    if (on) audio.noteOn(note.midi, note.velocity);
    else audio.noteOff(note.midi);
  }
  if (on) {
    trackPracticeTime();
    lastNote = note;
    lastKeyAt = performance.now();
  }
  updateLive();

  if (view === 'freeplay') {
    keyboard.setDown(note.midi, on);
    if (on) freeplay.noteOn(note.midi, note.velocity, note.time);
    else freeplay.noteOff(note.midi, note.time);
    updateFreePlayChord();
    return;
  }
  if (!tracker || !exercise) {
    keyboard.setDown(note.midi, on);
    return;
  }
  if (!on) {
    tracker.noteOff(note.midi, note.time);
    keyboard.setDown(note.midi, false);
    return;
  }
  if (demo) stopDemo();

  if (attempt.status === 'finished') {
    // Right after a try ends, only a note that starts the exercise again counts.
    const playable = exercise.steps.filter((step) => step.notes.length);
    const inStep = (step) => Boolean(step) && step.notes.some((midi) => sameKey(midi, note.midi));
    if (exercise.mode === 'wait' && inStep(playable[0])) {
      newAttempt();
    } else if (exercise.mode === 'wait' && canLoopOn(playable, note) && inStep(playable[1])) {
      // Looping without a break: the last note of the round just played is also the first of this one.
      newAttempt();
      for (const midi of playable[0].notes) tracker.noteOn(midi, finishStrike.velocity, finishStrike.time);
      for (const midi of playable[0].notes) if (!input.held.has(midi)) tracker.noteOff(midi, finishStrike.time);
      attempt.status = 'playing';
    } else {
      keyboard.setDown(note.midi, true);
      // Still playing something: do not arm a new try in the middle of it.
      scheduleAfterAttempt();
      return;
    }
  }
  if (exercise.mode === 'tempo') {
    if (attempt.status === 'ready') {
      keyboard.setDown(note.midi, true);
      setStatus('Press Start (or the space bar) to begin the count-in.');
      return;
    }
    // Ignore warm-up notes during the count-in.
    const beatMs = 60000 / exercise.bpm;
    if (metronome && note.time < metronome.startPerfMs - beatMs * 0.45) {
      keyboard.setDown(note.midi, true);
      return;
    }
  }

  const stepBefore = tracker.stepIndex;
  const judged = tracker.noteOn(note.midi, note.velocity, note.time);
  attempt.lastActivity = performance.now();
  if (attempt.status === 'ready') {
    attempt.status = 'playing';
    els.result.hidden = true;
  }
  const bad = judged.kind === 'wrong' || judged.kind === 'extra';
  keyboard.setDown(note.midi, true, judged.kind === 'correct' ? 'ok' : bad ? 'bad' : null);

  if (judged.stepCompleted || tracker.stepIndex !== stepBefore) attempt.wrongOnStep = 0;
  refreshProgress();

  if (note.source === 'virtual') attempt.virtualNotes += 1;
  else attempt.pianoNotes += 1;

  if (judged.kind === 'wrong' && exercise.mode === 'wait') {
    attempt.wrongOnStep += 1;
    if (restartedFromTop(note)) return;
    const targets = pendingTargets();
    const opening = exercise.steps.find((step) => step.notes.length);
    const startingOver = tracker.stepIndex >= 2 && opening?.notes.some((midi) => sameKey(midi, note.midi));
    setStatus(
      `That was ${nameOf(note.midi)}. You need ${describeTargets(targets)}.${startingOver ? ' Starting over? Just keep playing from the top.' : ''}`,
      'bad',
    );
    maybeAutoHint();
  }
  if (judged.finished || tracker.finished) {
    finishStrike = { time: note.time, velocity: note.velocity };
    finishAttempt();
  }
}

/** Same key, or the same note in any octave when that setting is on. */
function sameKey(a, b) {
  return state.settings.anyOctave ? (a - b) % 12 === 0 : a === b;
}

/**
 * A slip, then the first two notes of the exercise again: the learner started over, which is what
 * most beginners do. Begin a fresh try from those two notes instead of scoring them as wrong.
 */
function restartedFromTop(note) {
  const previous = attempt.lastWrong;
  attempt.lastWrong = { midi: note.midi, velocity: note.velocity, time: note.time, step: tracker.stepIndex };
  const playable = exercise.steps.filter((step) => step.notes.length);
  if (playable.length < 4 || playable.indexOf(currentStep()) < 2) return false;
  if (playable[0].notes.length !== 1 || playable[1].notes.length !== 1) return false;
  if (!previous || previous.step !== tracker.stepIndex || note.time - previous.time > 3000) return false;
  if (!sameKey(playable[0].notes[0], previous.midi) || !sameKey(playable[1].notes[0], note.midi)) return false;
  newAttempt();
  tracker.noteOn(previous.midi, previous.velocity, previous.time);
  if (!input.held.has(previous.midi)) tracker.noteOff(previous.midi, previous.time);
  tracker.noteOn(note.midi, note.velocity, note.time);
  attempt.status = 'playing';
  attempt.lastActivity = performance.now();
  keyboard.setDown(note.midi, true, 'ok');
  refreshProgress();
  setStatus('Starting again from the first note.');
  return true;
}

/** True when the exercise ends on the notes it starts with and the learner is carrying straight on. */
function canLoopOn(playable, note) {
  if (!finishStrike || pendingSwitch || playable.length < 3) return false;
  const first = playable[0].notes;
  const last = playable[playable.length - 1].notes;
  if (first.length !== last.length || first.some((midi, i) => midi !== last[i])) return false;
  return note.time - finishStrike.time < LOOP_JOIN_MS;
}

/** The name the current exercise uses for a key (Bb, not A#, in F major). */
function nameOf(midi) {
  if (view === 'freeplay') return spellMidi(midi, freePlayKey);
  return exerciseNames.get(midi) ?? spellMidi(midi, exercise?.key ?? null);
}

/** After a finished try: load what the coach queued up, or arm the next try once the learner pauses. */
function scheduleAfterAttempt() {
  clearTimeout(finishTimer);
  finishTimer = setTimeout(() => {
    // A switch the coach has queued up is applied by applyPendingSwitch once the learner pauses.
    if (attempt.status === 'finished' && !pendingSwitch && exercise.mode === 'wait') newAttempt({ keepResult: true });
  }, REARM_MS);
}

/** True while the learner is in the middle of something a screen change would disturb. */
function learnerBusy() {
  if (view !== 'exercise') return false;
  const now = performance.now();
  if (now - lastKeyAt < 2000) return true;
  // The count-in and a metronome try run on the clock, keys or no keys: never cut them off.
  if (attempt.status === 'countin' || (attempt.status === 'playing' && exercise?.mode === 'tempo')) return true;
  return attempt.status === 'playing' && tracker && !tracker.finished && tracker.stepIndex > 0 && now - attempt.lastActivity < 5000;
}

/** Load the exercise the coach queued up, once the learner has stopped playing. */
function applyPendingSwitch() {
  if (!pendingSwitch || view !== 'exercise' || learnerBusy()) return;
  const { basis } = pendingSwitch;
  if (basis && exercise && (basis.id !== exercise.id || basis.bpm !== exercise.bpm || basis.mode !== exercise.mode)) {
    // The learner changed the exercise, its tempo or its mode by hand while this waited.
    dropPendingSwitch();
    return;
  }
  loadExercise(pendingSwitch.exercise, { parent: pendingSwitch.parent, keepResult: true });
}

function dropPendingSwitch() {
  pendingSwitch = null;
  els.banner.hidden = true;
}

/**
 * Send a try to the coach, but not more often than every MIN_REPORT_GAP_MS: a three-note drill
 * can be played twenty times a minute, and each report is a paid reply. The newest try is kept
 * and says how many tries it stands for.
 */
function reportAttempt(event, clean) {
  sinceReport.tries += 1;
  if (clean) sinceReport.clean += 1;
  heldReport = event;
  clearTimeout(heldTimer);
  const wait = lastReportAt + MIN_REPORT_GAP_MS - Date.now();
  if (wait <= 0) flushReport();
  else heldTimer = setTimeout(flushReport, wait);
}

function flushReport() {
  clearTimeout(heldTimer);
  const event = heldReport;
  heldReport = null;
  if (!event) return;
  const tally = sinceReport;
  sinceReport = { tries: 0, clean: 0 };
  if (event.exercise?.id !== exercise?.id) return; // the exercise changed while it waited
  if (tally.tries > 1) {
    event.text += `\nTries since your last reply: ${tally.tries}, of which clean: ${tally.clean}. The numbers above describe the newest try.`;
    event.label = `${event.label} (${tally.tries} tries since the last reply)`;
  }
  lastReportAt = Date.now();
  coach.enqueue(event);
}

/** After several wrong tries on one step: flash the key, and ask the coach once in a while. */
function maybeAutoHint() {
  if (attempt.wrongOnStep < 4 || attempt.hintedStep === tracker.stepIndex) return;
  // Before the first right note, wrong keys are often just warming up: ask for more evidence.
  if (tracker.stepIndex === 0 && attempt.wrongOnStep < 6) return;
  attempt.hintedStep = tracker.stepIndex;
  flashTargets();
  const now = Date.now();
  if (coach.idle && now - lastAutoHintAt > 45000) {
    lastAutoHintAt = now;
    requestHint({ auto: true });
  }
}

function flashTargets() {
  for (const target of pendingTargets()) keyboard.flash(target.midi, 'is-hint', 1400);
}

function requestHint({ auto = false } = {}) {
  if (!exercise || !tracker) return;
  if (tracker.finished || attempt.status === 'finished') {
    // The try is over: a hint is about the first step of the next one.
    if (exercise.mode !== 'wait') {
      setStatus('Press Start first. Hints work while a try is under way.');
      return;
    }
    newAttempt({ keepResult: true });
  }
  flashTargets();
  const stepRecord = tracker.result().steps[tracker.stepIndex];
  coach.enqueue({
    kind: 'hint',
    text: summary.renderHint({
      exercise,
      stepIndex: tracker.stepIndex,
      wrongNotes: stepRecord?.wrong ?? [],
      idleMs: attempt.lastActivity ? Math.round(performance.now() - attempt.lastActivity) : 0,
    }),
    label: auto ? 'Stuck on a step: asking the coach' : `Asked for a hint on step ${tracker.stepIndex + 1}`,
  });
}

/** One line telling the coach that the loaded exercise is a slice of a bigger one. */
function drillContext() {
  const parent = state.session?.parent;
  return parent ? `\nThis exercise is a drill cut from "${parent.title}". Use the back_to_full action to return to the whole exercise.` : '';
}

function finishAttempt() {
  cancelAnimationFrame(rafId);
  clearTimeout(finishTimer);
  stopMetronome();
  const result = tracker.result();
  lastResult = result;
  finishedCount += 1;
  attempt.status = 'finished';
  attempt.finishedAt = performance.now();
  refreshProgress();
  updateControls();
  showResult(result);

  const count = (attemptCounts.get(exercise.id) ?? 0) + 1;
  attemptCounts.set(exercise.id, count);
  recordProgress(result);

  const previous = previousResults.get(exercise.id) ?? null;
  previousResults.set(exercise.id, result);

  // The coach already moved on while this try was under way: no report, the switch follows.
  if (pendingSwitch) return;

  let text = summary.renderAttempt({ exercise, result, attemptNumber: count, previous });
  if (count === 1) text += `\nSteps of this exercise: ${describeExercise(exercise)}`;
  if (attempt.virtualNotes && !attempt.pianoNotes) text += '\nPlayed on the on-screen keys: every note has the same loudness, so loudness says nothing here.';
  text += drillContext();
  reportAttempt(
    { kind: 'attempt', text, label: `Try ${count}: ${Math.round(result.totals.accuracy * 100)}% clean`, exercise },
    result.totals.accuracy >= 0.9,
  );

  if (exercise.mode === 'wait') scheduleAfterAttempt();
}

function showResult(result) {
  const chips = [];
  const pct = Math.round(result.totals.accuracy * 100);
  chips.push({ text: `${pct}% clean`, tone: pct >= 90 ? 'good' : pct < 70 ? 'bad' : null });
  if (result.totals.wrongNotes) chips.push({ text: `${result.totals.wrongNotes} wrong ${result.totals.wrongNotes === 1 ? 'note' : 'notes'}`, tone: 'bad' });
  if (result.totals.missed) chips.push({ text: `${result.totals.missed} missed`, tone: 'bad' });
  if (result.totals.mistimed) chips.push({ text: `${result.totals.mistimed} off the beat`, tone: 'bad' });
  if (result.mode === 'tempo') {
    const { meanOffsetMs, offsetSdMs } = result.timing;
    // Plain words, with limits wider than the timing error Bluetooth itself can add.
    if (Number.isFinite(meanOffsetMs)) {
      const ms = Math.abs(meanOffsetMs);
      const side = meanOffsetMs > 0 ? 'late' : 'early';
      chips.push({ text: ms < 40 ? 'With the click' : ms <= 120 ? `A little ${side}` : side === 'late' ? 'Late' : 'Early', tone: ms < 40 ? 'good' : null });
    }
    if (Number.isFinite(offsetSdMs)) {
      chips.push({ text: offsetSdMs < 40 ? 'Steady' : offsetSdMs <= 80 ? 'A bit unsteady' : 'Unsteady', tone: offsetSdMs < 40 ? 'good' : null });
    }
  } else {
    // No pace chip here: nothing sets the pace in this mode, so a bpm number would mislead.
    const cv = result.timing.evennessCv;
    if (Number.isFinite(cv)) chips.push({ text: cv < 0.1 ? 'Very even' : cv < 0.2 ? 'Fairly even' : 'Uneven rhythm', tone: cv < 0.1 ? 'good' : null });
    if (result.timing.hesitations?.length) chips.push({ text: `${result.timing.hesitations.length} ${result.timing.hesitations.length === 1 ? 'hesitation' : 'hesitations'}` });
  }
  els.result.replaceChildren(
    ...chips.map((chip) => {
      const el = document.createElement('span');
      el.className = `chip${chip.tone ? ` chip-${chip.tone}` : ''}`;
      el.textContent = chip.text;
      return el;
    }),
  );
  els.result.hidden = false;
  setStatus(
    pct === 100 ? 'Clean run. Play it again or wait for your coach.' : 'Done. Play it again from the first note, or wait for your coach.',
    pct >= 90 ? 'good' : null,
  );
}

function recordProgress(result) {
  const progress = state.progress;
  const pct = Math.round(result.totals.accuracy * 100);
  const withClick = result.mode === 'tempo';
  const bpm = Math.round(result.bpm);
  const entry = progress.exercises[exercise.id] ?? { title: exercise.title, attempts: 0, bestAccuracy: 0, bestBpm: 0, lastAt: null };
  entry.title = exercise.title;
  entry.attempts += 1;
  entry.bestAccuracy = Math.max(entry.bestAccuracy, pct);
  // Only a metronome try says anything about tempo.
  if (withClick && result.completed && pct >= 90) entry.bestBpm = Math.max(entry.bestBpm, bpm);
  entry.lastAt = new Date().toISOString();
  progress.exercises[exercise.id] = entry;
  progress.lastPracticed = todayKey();
  const how = withClick ? `with the metronome at ${bpm} bpm` : 'in learn-the-notes mode';
  progress.recent = [`${exercise.title}: ${pct}% clean ${how}`, ...progress.recent].slice(0, 8);
  saveState(state);
}

function trackPracticeTime() {
  const now = Date.now();
  if (lastNoteAt && now - lastNoteAt < 30000) state.progress.totalMs += now - lastNoteAt;
  lastNoteAt = now;
}

// ------------------------------------------------------------------ metronome mode

async function startTempoAttempt() {
  await audio.resume();
  if (!audio.ready) {
    setStatus('The browser blocked sound. Click Start again.', 'bad');
    return;
  }
  newAttempt();
  attempt.status = 'countin';
  const beats = exercise.beatsPerBar;
  metronome = audio.startMetronome({
    bpm: exercise.bpm,
    beatsPerBar: beats,
    countInBeats: beats,
    onBeat: (beatIndex, heardAtMs) => {
      const delay = Math.max(0, heardAtMs - performance.now());
      setTimeout(() => showBeat(beatIndex), delay);
    },
  });
  tracker.start(metronome.startPerfMs);
  updateControls();
  setStatus('Count-in...');
  tickLoop();
}

function showBeat(beatIndex) {
  if (attempt.status !== 'countin' && attempt.status !== 'playing') return;
  if (beatIndex < 0) {
    els.countin.textContent = String(-beatIndex);
    els.countin.hidden = false;
  } else if (beatIndex === 0) {
    els.countin.hidden = true;
    if (attempt.status === 'countin') {
      attempt.status = 'playing';
      setStatus('Play with the click.');
    }
  }
}

function tickLoop() {
  rafId = requestAnimationFrame(() => {
    if (!tracker || (attempt.status !== 'countin' && attempt.status !== 'playing')) return;
    const outcome = tracker.tick(performance.now());
    if (outcome.missed.length) refreshProgress();
    if (outcome.finished || tracker.finished) {
      finishAttempt();
      return;
    }
    tickLoop();
  });
}

function stopMetronome() {
  metronome?.stop();
  metronome = null;
  els.countin.hidden = true;
}

function onStartButton() {
  if (!exercise) return;
  audio.resume();
  if (exercise.mode === 'tempo') {
    if (attempt.status === 'countin' || attempt.status === 'playing') newAttempt();
    else startTempoAttempt();
  } else {
    newAttempt();
  }
}

// ------------------------------------------------------------------ demo playback

async function toggleDemo() {
  if (demo) {
    stopDemo();
    return;
  }
  if (!exercise) return;
  await audio.resume();
  newAttempt({ keepResult: true });
  const onPiano = state.settings.demoOnPiano && input.canSend;
  if (onPiano) audio.setVolume(0);
  const beatMs = 60000 / exercise.bpm;
  const states = exercise.steps.map(() => 'pending');
  els.demo.textContent = 'Stop';
  els.demo.classList.add('is-on');
  keyboard.setTargets([]);
  const handle = audio.playSteps(exercise.steps, {
    bpm: exercise.bpm,
    onStep: (index) => {
      if (demo !== handle) return;
      const step = exercise.steps[index];
      staff?.update(states, index);
      const holdMs = Math.max(120, step.beats * beatMs * 0.9);
      for (const midi of step.notes) {
        keyboard.flash(midi, 'is-demo', holdMs);
        if (onPiano) {
          input.send([0x90, midi, 72]);
          setTimeout(() => input.send([0x80, midi, 0]), holdMs);
        }
      }
    },
  });
  demo = handle;
  handle.done.then(() => {
    if (demo === handle) stopDemo();
  });
}

function stopDemo() {
  if (!demo) return;
  const handle = demo;
  demo = null;
  handle.stop();
  audio.setVolume(state.settings.volume);
  els.demo.textContent = 'Listen';
  els.demo.classList.remove('is-on');
  if (tracker) refreshProgress();
}

// ------------------------------------------------------------------ free play

/** Switch the visible panel and tab highlight only. */
function showView(next) {
  view = next;
  const free = next === 'freeplay';
  $('view-exercise').hidden = free;
  $('view-freeplay').hidden = !free;
  $('tab-exercise').classList.toggle('is-active', !free);
  $('tab-freeplay').classList.toggle('is-active', free);
  $('tab-exercise').setAttribute('aria-selected', String(!free));
  $('tab-freeplay').setAttribute('aria-selected', String(free));
}

function setView(next) {
  if (next === view) return;
  showView(next);
  const free = next === 'freeplay';
  stopDemo();
  if (free && pendingSwitch) {
    // Free play was the learner's choice: what the coach queued up becomes an offer.
    suggestion = { exercise: pendingSwitch.exercise, parent: pendingSwitch.parent };
    $('fp-banner-text').textContent = `Your coach suggests: ${pendingSwitch.exercise.title}.`;
    $('fp-banner').hidden = false;
    dropPendingSwitch();
  }
  if (free) {
    cancelAnimationFrame(rafId);
    stopMetronome();
    keyboard.setTargets([]);
    keyboard.releaseAll();
    keyboard.setRange(36, 96);
  } else if (exercise) {
    const notes = exercise.steps.flatMap((step) => step.notes);
    if (notes.length) keyboard.fitTo(notes);
    newAttempt();
  }
}

function updateFreePlayChord() {
  const held = [...input.held.keys()];
  if (held.length >= 2) {
    const chord = detectChord(held);
    if (chord) $('fp-chord').textContent = chord.name;
  }
}

function onPhrase(phrase) {
  // Only name a key the analysis is reasonably sure of.
  const sure = phrase.key && phrase.key.confidence >= 0.3;
  $('fp-key').textContent = sure ? `${phrase.key.tonic} ${phrase.key.mode}` : 'Unclear';
  if (sure) freePlayKey = { tonic: phrase.key.tonic, mode: phrase.key.mode };
  if (phrase.tempo) $('fp-tempo').textContent = `${Math.round(phrase.tempo.bpm)} bpm`;
  if (Number.isFinite(phrase.evennessCv)) {
    $('fp-even').textContent = phrase.evennessCv < 0.1 ? 'Very even' : phrase.evennessCv < 0.2 ? 'Fairly even' : 'Uneven';
  }
  if (phrase.chords?.length) $('fp-chord').textContent = phrase.chords.at(-1).name;
  $('fp-status').textContent = `Last phrase: ${phrase.noteCount} notes in ${(phrase.durationMs / 1000).toFixed(1)} s.`;
  const now = Date.now();
  if (state.settings.liveListen && phrase.noteCount >= 8 && now - lastFreePlayCoachAt > 15000) {
    lastFreePlayCoachAt = now;
    coach.enqueue({
      kind: 'free_play',
      text: summary.renderFreePlay({ phrase }),
      label: `Free play: ${phrase.noteCount} notes`,
      exercise: null,
    });
  }
}

// ------------------------------------------------------------------ live readout

function updateLive() {
  const held = [...input.held.keys()].sort((a, b) => a - b);
  if (held.length) {
    const names = held.map((midi) => nameOf(midi)).join(' ');
    const chord = held.length >= 3 ? detectChord(held) : null;
    els.liveNotes.textContent = chord ? `${names}  =  ${chord.name}` : names;
  } else if (lastNote) {
    const loudness = lastNote.velocity < 50 ? 'soft' : lastNote.velocity > 90 ? 'loud' : 'medium loud';
    els.liveNotes.textContent = `Last note: ${nameOf(lastNote.midi)}, ${loudness}`;
  }
}

function onPedal(pedal) {
  els.livePedal.hidden = false;
  els.livePedal.classList.toggle('pill-on', pedal.down);
  els.livePedal.classList.toggle('pill-off', !pedal.down);
  if (view === 'freeplay') freeplay.pedal(pedal.down, pedal.time);
}

function onRaw(raw) {
  const bytes = [...raw.bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  rawLog.push(`${(raw.time / 1000).toFixed(3)}  ${raw.source.padEnd(7)} ${bytes}`);
  if (rawLog.length > 60) rawLog.shift();
  if ($('dlg-settings').open) els.midiLog.textContent = rawLog.join('\n');
}

// ------------------------------------------------------------------ connection

function onStatus(status) {
  const pill = els.pill;
  pill.className = 'pill';
  switch (status.state) {
    case 'connected':
      if (status.transport === 'webmidi' && !status.deviceName) {
        // MIDI access granted, but nothing is plugged in yet.
        pill.classList.add('pill-busy');
        pill.textContent = 'Waiting for a MIDI device';
      } else {
        pill.classList.add('pill-on');
        pill.textContent = status.deviceName || (status.transport === 'ble' ? 'Bluetooth piano' : 'MIDI device');
      }
      break;
    case 'connecting':
      pill.classList.add('pill-busy');
      pill.textContent = 'Connecting...';
      break;
    case 'reconnecting':
      pill.classList.add('pill-busy');
      pill.textContent = 'Reconnecting...';
      break;
    case 'error':
      pill.classList.add('pill-err');
      pill.textContent = 'Connection problem';
      break;
    default:
      pill.classList.add('pill-off');
      pill.textContent = 'No piano connected';
  }
  pill.title = status.message ?? '';
  els.connect.textContent = status.state === 'connected' ? 'Connection' : 'Connect piano';
  els.connect.classList.toggle('btn-primary', status.state !== 'connected');
  $('connect-disconnect').hidden = !['connected', 'connecting', 'reconnecting'].includes(status.state);
  if (status.state === 'reconnecting' && view === 'exercise') {
    connectionNotice = true;
    setStatus('The piano lost its Bluetooth connection. Trying to reconnect...', 'bad');
  } else if (status.state === 'connected' && connectionNotice) {
    connectionNotice = false;
    setStatus('The piano is connected again. Carry on.', 'good');
    refreshProgress();
  }
  if (status.state === 'error' && status.message) {
    showConnectError(status.message);
    // The dialog is usually closed when a reconnect gives up: say it where the learner is looking.
    if (!$('dlg-connect').open && view === 'exercise') {
      connectionNotice = true;
      setStatus(`${status.message} Click Connect piano.`, 'bad');
    }
  }
  if (status.state !== 'connected') keyboard.releaseAll();
}

function showConnectError(message) {
  const el = $('connect-error');
  el.textContent = message;
  el.hidden = !message;
}

function openConnectDialog() {
  const support = MidiInput.support();
  $('connect-hint').textContent = support.hint || 'Works in Chrome or Edge on a computer or Android phone.';
  $('connect-ble').disabled = !support.bluetooth;
  $('connect-ble-all').disabled = !support.bluetooth;
  $('connect-midi').disabled = !support.webmidi;
  // Keep the reason of a failed connection visible: it says what to do next.
  showConnectError(input.status.state === 'error' ? input.status.message ?? '' : '');
  $('dlg-connect').showModal();
}

async function connect(kind) {
  showConnectError('');
  audio.resume();
  try {
    if (kind === 'ble') await input.connectBluetooth();
    else if (kind === 'ble-all') await input.connectBluetooth({ acceptAll: true });
    else await input.connectWebMidi();
    const status = input.status;
    if (status.state !== 'connected') return;
    if (status.transport === 'webmidi' && !status.deviceName) {
      showConnectError(status.message || 'No MIDI device found yet. Plug one in and it will be picked up.');
      return;
    }
    $('dlg-connect').close();
  } catch (err) {
    // Closing the browser's device chooser is not an error worth showing.
    if (err?.name === 'NotFoundError' && /cancel/i.test(err.message ?? '')) return;
    showConnectError(input.status.message || err?.message || 'Could not connect.');
  }
}

// ------------------------------------------------------------------ coach

function sessionStartText() {
  const progress = state.progress;
  return summary.renderSessionStart({
    profile: { ...(state.profile ?? { goals: '' }), level: LEVEL_LABELS[state.profile?.level] ?? LEVEL_LABELS.beginner },
    notes: state.notes,
    progress: {
      today: todayKey(),
      sessions: progress.sessions,
      minutes: Math.round(progress.totalMs / 60000),
      lastPracticed: progress.lastPracticed,
      recent: progress.recent,
    },
    exercise,
  });
}

/** Apply what the coach decided. Returns a short label for the chat log. */
function applyCoachAction(action, event) {
  if (!action) return null;
  if (action.type === 'none') {
    // The coach announced a change the app could not carry out: say so instead of leaving the learner guessing.
    return action.dropped ? 'The coach tried to change the exercise, but the app could not do it. Carry on with what is on screen.' : null;
  }
  // A drill, tempo change or "back to full" refers to the exercise the report was about. If the
  // learner has loaded something else, or changed its tempo or mode by hand since, it no longer applies.
  const relative = action.type === 'drill' || action.type === 'set_tempo' || action.type === 'back_to_full';
  if (relative && event?.exercise && exercise) {
    const then = event.exercise;
    if (then.id !== exercise.id || then.bpm !== exercise.bpm || then.mode !== exercise.mode) {
      return "You changed the exercise or its tempo since that try, so the coach's change was not loaded.";
    }
  }
  // A hint is about the step the learner is on: it must not swap the exercise under them.
  if (event?.kind === 'hint') return 'Hint only: the exercise stays as it is.';
  let backToFull = false;
  if (action.type === 'back_to_full') {
    const full = state.session.parent;
    if (!isUsableExercise(full)) return null;
    action = { type: 'new_exercise', exercise: full };
    backToFull = true;
  }
  if (!isUsableExercise(action.exercise)) return null;
  const next = action.exercise;
  let parent = null;
  let label;
  if (action.type === 'drill') {
    parent = state.session.parent ?? exercise;
    label = `Drill: steps ${action.from_step} to ${action.to_step}`;
  } else if (action.type === 'set_tempo') {
    parent = state.session.parent ?? null;
    label = `${next.bpm} bpm, ${next.mode === 'tempo' ? 'with the metronome' : 'learn-the-notes mode'}`;
  } else {
    label = backToFull ? 'Back to the full exercise' : `New exercise: ${next.title}`;
  }
  if (view === 'freeplay') {
    // Do not pull the learner out of free play: offer the exercise instead.
    suggestion = { exercise: next, parent };
    $('fp-banner-text').textContent = `Your coach suggests: ${next.title}.`;
    $('fp-banner').hidden = false;
    return `Suggested: ${next.title}`;
  }
  if (learnerBusy()) {
    // basis: what a relative change was computed from, re-checked before it is applied.
    const basis = relative && exercise ? { id: exercise.id, bpm: exercise.bpm, mode: exercise.mode } : null;
    pendingSwitch = { exercise: next, parent, basis };
    els.bannerText.textContent = `Your coach has the next step ready: ${next.title}.`;
    els.banner.hidden = false;
  } else {
    loadExercise(next, { parent, keepResult: true });
  }
  return label;
}

function recordUsage(done) {
  const usage = state.session.usage;
  const u = done?.usage;
  usage.replies += 1;
  if (u) {
    usage.input += u.input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
  }
  if (done?.model) usage.model = done.model;
  saveState(state);
}

// Dollars per million tokens. Used only for the rough estimate in Settings.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
};

function usageText() {
  const usage = state.session?.usage;
  if (!usage || !usage.replies) return 'No coach replies yet in this session.';
  if (health?.mode === 'mock') return `${usage.replies} replies from the offline coach. No API cost.`;
  // After a rare fallback to another model the reply names that model: price by the configured one.
  const price = PRICES[usage.model] ?? PRICES[health?.model];
  const tokens = `${usage.replies} coach replies. Tokens: ${usage.input + usage.cacheRead + usage.cacheWrite} in, ${usage.output} out.`;
  if (!price) return tokens;
  const cost =
    (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / 1e6;
  return `${tokens} Rough cost this session: $${cost.toFixed(cost < 0.1 ? 3 : 2)}.`;
}

function sendChat(text) {
  const clean = text.trim();
  if (!clean) return;
  coach.enqueue({
    kind: 'chat',
    text: summary.renderChat({
      text: clean,
      exercise: view === 'exercise' ? exercise : null,
      trackerState:
        view === 'exercise' && tracker && attempt.status === 'playing'
          ? { stepIndex: tracker.stepIndex, steps: exercise.steps.length }
          : null,
    }),
    you: clean,
  });
}

function askNext() {
  if (!exercise) return;
  if (health?.mode !== 'live' && health?.mode !== 'mock') {
    // No server: walk the built-in list so the button still does something.
    const ids = STARTER_EXERCISES.map((spec) => buildExercise(spec)).filter((b) => b.ok).map((b) => b.exercise);
    const at = ids.findIndex((ex) => ex.id === exercise.id);
    loadExercise(ids[(at + 1) % ids.length]);
    return;
  }
  coach.enqueue({
    kind: 'next',
    text: summary.renderNext({ exercise, reason: 'The learner pressed "Next exercise".' }),
    label: 'Asked for the next exercise',
  });
}

// ------------------------------------------------------------------ session

function beginSession({ fresh = false } = {}) {
  const day = todayKey();
  const saved = state.session;
  if (!fresh && saved && saved.day === day && Array.isArray(saved.messages)) {
    saved.log ??= [];
    saved.usage ??= { replies: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    // The page may have been closed while a reply was on its way: drop the unanswered turn.
    while (saved.messages.at(-1)?.role === 'user') saved.messages.pop();
    coach.restore(saved.log);
    if (!loadExercise(saved.exercise, { parent: saved.parent ?? null })) loadExercise(starterExercise());
    return;
  }
  const carried = isUsableExercise(saved?.exercise) ? saved.exercise : starterExercise();
  state.session = {
    day,
    startedAt: Date.now(),
    messages: [],
    log: [],
    exercise: null,
    parent: null,
    usage: { replies: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  state.progress.sessions += 1;
  coach.reset();
  loadExercise(carried);
  saveStateNow(state);
  coach.enqueue({ kind: 'session_start', text: sessionStartText(), label: null });
}

function openSetup({ firstRun }) {
  const profile = state.profile ?? {};
  $('setup-name').value = profile.name ?? '';
  $('setup-level').value = profile.level ?? 'beginner';
  $('setup-goals').value = profile.goals ?? '';
  $('setup-about').value = profile.about ?? '';
  $('setup-cancel').hidden = firstRun;
  $('dlg-setup').showModal();
}

function saveSetup() {
  const firstRun = !state.profile;
  state.profile = {
    name: $('setup-name').value.trim().slice(0, 40),
    level: $('setup-level').value,
    goals: $('setup-goals').value.trim().slice(0, 300),
    about: $('setup-about').value.trim().slice(0, 300),
  };
  saveStateNow(state);
  $('dlg-setup').close();
  if (firstRun) {
    beginSession({ fresh: true });
  } else {
    const { level, goals, about } = state.profile;
    const said = `I updated my profile. Level: ${LEVEL_LABELS[level] ?? level}. Goals: ${goals || 'none given'}. About me: ${about || 'nothing added'}.`;
    coach.enqueue({ kind: 'chat', text: summary.renderChat({ text: said, exercise: view === 'exercise' ? exercise : null, trackerState: null }), you: 'Profile updated.' });
  }
}

// ------------------------------------------------------------------ settings and library

function bindSetting(id, key, apply) {
  const el = $(id);
  const isCheck = el.type === 'checkbox';
  const read = () => (isCheck ? el.checked : Number(el.value));
  const write = () => {
    if (isCheck) el.checked = Boolean(state.settings[key]);
    else el.value = String(state.settings[key]);
  };
  write();
  el.addEventListener('change', () => {
    const value = read();
    state.settings[key] = isCheck ? value : Number.isFinite(value) ? value : 0;
    saveState(state);
    apply?.(state.settings[key]);
    for (const other of document.querySelectorAll(`[data-setting="${key}"]`)) {
      if (other !== el) other.checked = state.settings[key];
    }
  });
  el.dataset.setting = key;
  return write;
}

function openSettings() {
  $('set-usage').textContent = usageText();
  $('set-notes').textContent = state.notes ? `Coach's notes about you: ${state.notes}` : 'Your coach has not written any notes about you yet.';
  els.midiLog.textContent = rawLog.join('\n') || 'No MIDI messages yet.';
  $('dlg-settings').showModal();
}

function openLibrary() {
  const list = $('library-list');
  list.replaceChildren();
  for (const spec of STARTER_EXERCISES) {
    const built = buildExercise(spec);
    if (!built.ok) continue;
    const ex = built.exercise;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    const title = document.createElement('strong');
    title.textContent = ex.title;
    const goal = document.createElement('span');
    goal.textContent = ex.goal;
    button.append(title, goal);
    const best = state.progress.exercises[ex.id];
    if (best?.attempts) {
      const meta = document.createElement('span');
      meta.className = 'choice-meta';
      meta.textContent = `Best: ${best.bestAccuracy}% clean, ${best.attempts} ${best.attempts === 1 ? 'try' : 'tries'}`;
      button.append(meta);
    }
    button.addEventListener('click', () => {
      $('dlg-library').close();
      loadExercise(ex);
    });
    list.append(button);
  }
  $('dlg-library').showModal();
}

// ------------------------------------------------------------------ computer keyboard

const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16 };
const keysDown = new Map();

function typingTarget(event) {
  const tag = event.target?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable || document.querySelector('dialog[open]');
}

function onKeyDown(event) {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || typingTarget(event)) return;
  const key = event.key.toLowerCase();
  if (key === ' ') {
    if (event.target?.tagName === 'BUTTON') return;
    event.preventDefault();
    onStartButton();
    return;
  }
  if (key === 'z' || key === 'x') {
    virtualOctave = Math.max(-3, Math.min(3, virtualOctave + (key === 'z' ? -1 : 1)));
    return;
  }
  if (!(key in KEYMAP) || keysDown.has(key)) return;
  const midi = 60 + virtualOctave * 12 + KEYMAP[key];
  keysDown.set(key, midi);
  audio.resume();
  input.noteOn(midi, 84);
}

function onKeyUp(event) {
  const key = event.key.toLowerCase();
  if (!keysDown.has(key)) return;
  input.noteOff(keysDown.get(key));
  keysDown.delete(key);
}

// ------------------------------------------------------------------ wiring

function wire() {
  input.addEventListener('note', (e) => onNote(e.detail));
  input.addEventListener('pedal', (e) => onPedal(e.detail));
  input.addEventListener('status', (e) => onStatus(e.detail));
  input.addEventListener('raw', (e) => onRaw(e.detail));

  els.connect.addEventListener('click', openConnectDialog);
  $('connect-ble').addEventListener('click', () => connect('ble'));
  $('connect-ble-all').addEventListener('click', () => connect('ble-all'));
  $('connect-midi').addEventListener('click', () => connect('midi'));
  $('connect-none').addEventListener('click', () => $('dlg-connect').close());
  $('connect-disconnect').addEventListener('click', async () => {
    await input.disconnect();
    $('dlg-connect').close();
  });

  els.start.addEventListener('click', onStartButton);
  els.demo.addEventListener('click', toggleDemo);
  els.hint.addEventListener('click', () => requestHint());
  els.next.addEventListener('click', askNext);
  els.parent.addEventListener('click', () => {
    if (state.session.parent) loadExercise(state.session.parent);
  });
  $('btn-pending').addEventListener('click', () => {
    if (pendingSwitch) loadExercise(pendingSwitch.exercise, { parent: pendingSwitch.parent });
  });
  els.modeWait.addEventListener('click', () => changeTempo({ mode: 'wait' }));
  els.modeTempo.addEventListener('click', () => changeTempo({ mode: 'tempo' }));
  $('bpm-down').addEventListener('click', () => changeTempo({ bpm: exercise.bpm - 4 }));
  $('bpm-up').addEventListener('click', () => changeTempo({ bpm: exercise.bpm + 4 }));

  $('tab-exercise').addEventListener('click', () => setView('exercise'));
  $('tab-freeplay').addEventListener('click', () => setView('freeplay'));
  $('btn-library').addEventListener('click', openLibrary);
  $('kb-left').addEventListener('click', () => keyboard.shift(-12));
  $('kb-right').addEventListener('click', () => keyboard.shift(12));

  $('coach-form').addEventListener('submit', (event) => {
    event.preventDefault();
    sendChat(els.coachInput.value);
    els.coachInput.value = '';
  });
  for (const button of document.querySelectorAll('[data-quick]')) {
    button.addEventListener('click', () => sendChat(button.dataset.quick));
  }

  $('btn-settings').addEventListener('click', openSettings);
  $('setup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    saveSetup();
  });
  $('setup-cancel').addEventListener('click', () => $('dlg-setup').close());
  $('dlg-setup').addEventListener('cancel', (event) => {
    if (!state.profile) event.preventDefault(); // first run: the profile is needed
  });
  $('set-profile').addEventListener('click', () => {
    $('dlg-settings').close();
    openSetup({ firstRun: false });
  });
  $('set-newsession').addEventListener('click', () => {
    $('dlg-settings').close();
    beginSession({ fresh: true });
  });
  $('set-reset').addEventListener('click', () => {
    if (!confirm('Erase your profile, progress and coach history from this browser?')) return;
    coach.reset();
    clearState();
    location.reload();
  });

  bindSetting('set-keyhints', 'keyHints', () => refreshProgress());
  bindSetting('set-names', 'showNames', (on) => {
    keyboard.setShowNames(on);
    if (exercise) {
      drawStaff();
      refreshProgress();
    }
  });
  bindSetting('set-fingers', 'showFingers', () => {
    if (exercise) {
      drawStaff();
      refreshProgress();
    }
  });
  bindSetting('set-anyoctave', 'anyOctave', () => exercise && newAttempt());
  bindSetting('set-demopiano', 'demoOnPiano');
  bindSetting('set-volume', 'volume', (value) => audio.setVolume(value));
  bindSetting('set-latency', 'latencyMs', () => exercise && newAttempt());
  bindSetting('coach-voice', 'voice', (on) => speaker.setEnabled(on));
  bindSetting('fp-listen', 'liveListen');

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    for (const midi of keysDown.values()) input.noteOff(midi);
    keysDown.clear();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveStateNow(state);
  });
  window.addEventListener('pagehide', () => saveStateNow(state));

  setInterval(() => {
    const phrase = freeplay.tick(performance.now());
    if (phrase) onPhrase(phrase);
    applyPendingSwitch();
  }, 200);
  $('fp-banner-open').addEventListener('click', () => {
    if (!suggestion) return;
    const { exercise: offered, parent } = suggestion;
    suggestion = null;
    $('fp-banner').hidden = true;
    loadExercise(offered, { parent });
  });

  // The notation is laid out for the width it was drawn at: redraw after a real size change.
  let staffWidth = els.staff.clientWidth;
  let resizeTimer = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const width = els.staff.clientWidth;
      if (!exercise || !width || Math.abs(width - staffWidth) < 40) return;
      staffWidth = width;
      drawStaff();
      refreshProgress();
    }, 200);
  }).observe(els.staff);
}

async function main() {
  wire();
  keyboard.setShowNames(state.settings.showNames);
  audio.setVolume(state.settings.volume);
  speaker.setEnabled(state.settings.voice);
  if (!speaker.supported) $('coach-voice').closest('label').hidden = true;
  onStatus(input.status);

  health = await fetchHealth();
  els.coachMode.textContent = !health
    ? 'Server not reachable'
    : health.mode === 'mock'
      ? 'Offline coach (no API key set)'
      : `Claude (${health.model})`;

  if (!state.profile) {
    // Show something to play right away, then ask who is playing.
    state.session = {
      day: todayKey(),
      startedAt: Date.now(),
      messages: [],
      log: [],
      exercise: null,
      parent: null,
      usage: { replies: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    loadExercise(starterExercise());
    openSetup({ firstRun: true });
  } else {
    beginSession();
  }
}

// A read-only peek for the end-to-end tests and for debugging in the console.
window.practiceCoach = {
  get exercise() {
    return exercise;
  },
  get attemptStatus() {
    return attempt.status;
  },
  get stepIndex() {
    return tracker?.stepIndex ?? null;
  },
  get stepStates() {
    return tracker ? [...tracker.stepStates] : [];
  },
  get tempoStartMs() {
    return metronome?.startPerfMs ?? null;
  },
  get result() {
    return tracker?.result() ?? null;
  },
  get lastResult() {
    return lastResult;
  },
  get finishedCount() {
    return finishedCount;
  },
  get connection() {
    return input.status;
  },
  get coachIdle() {
    return coach.idle && !heldReport;
  },
};

main();
