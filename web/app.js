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
import { detectChord } from '../shared/theory.js';
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
  onAction: (action) => applyCoachAction(action),
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
function loadExercise(next, { parent = null } = {}) {
  if (!isUsableExercise(next)) return false;
  stopDemo();
  exercise = next;
  pendingSwitch = null;
  els.banner.hidden = true;
  state.session.exercise = next;
  state.session.parent = parent;
  saveState(state);

  els.title.textContent = next.title;
  els.goal.textContent = next.goal;
  els.parent.hidden = !parent;
  els.result.hidden = true;
  // Show the exercise view first: the notation needs a visible container to size itself.
  if (view !== 'exercise') showView('exercise');
  drawStaff();
  const notes = next.steps.flatMap((step) => step.notes);
  if (notes.length) keyboard.fitTo(notes);
  updateControls();
  newAttempt();
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
    // Right after an attempt ends, only a note that starts the exercise again counts.
    const first = exercise.steps.find((step) => step.notes.length);
    if (exercise.mode === 'wait' && first?.notes.includes(note.midi)) {
      newAttempt();
    } else {
      keyboard.setDown(note.midi, true);
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

  if (judged.kind === 'wrong' && exercise.mode === 'wait') {
    attempt.wrongOnStep += 1;
    const targets = pendingTargets();
    setStatus(`That was ${midiToName(note.midi)}. You need ${describeTargets(targets)}.`, 'bad');
    maybeAutoHint();
  }
  if (judged.finished || tracker.finished) finishAttempt();
}

/** After several wrong tries on one step: flash the key, and ask the coach once in a while. */
function maybeAutoHint() {
  if (attempt.wrongOnStep < 4 || attempt.hintedStep === tracker.stepIndex) return;
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
  attempt.status = 'finished';
  attempt.finishedAt = performance.now();
  refreshProgress();
  updateControls();
  showResult(result);

  const count = (attemptCounts.get(exercise.id) ?? 0) + 1;
  attemptCounts.set(exercise.id, count);
  recordProgress(result);

  if (pendingSwitch) {
    // The coach already moved on while this attempt was under way.
    const { exercise: nextExercise, parent } = pendingSwitch;
    finishTimer = setTimeout(() => loadExercise(nextExercise, { parent }), 1200);
    return;
  }

  let text = summary.renderAttempt({
    exercise,
    result,
    attemptNumber: count,
    previous: previousResults.get(exercise.id) ?? null,
  });
  if (count === 1) text += `\nSteps of this exercise: ${describeExercise(exercise)}`;
  text += drillContext();
  previousResults.set(exercise.id, result);
  coach.enqueue({
    kind: 'attempt',
    text,
    label: `Try ${count}: ${Math.round(result.totals.accuracy * 100)}% clean`,
  });

  if (exercise.mode === 'wait') {
    finishTimer = setTimeout(() => {
      if (attempt.status === 'finished') newAttempt({ keepResult: true });
    }, 1500);
  }
}

function showResult(result) {
  const chips = [];
  const pct = Math.round(result.totals.accuracy * 100);
  chips.push({ text: `${pct}% clean`, tone: pct >= 90 ? 'good' : pct < 70 ? 'bad' : null });
  if (result.totals.wrongNotes) chips.push({ text: `${result.totals.wrongNotes} wrong ${result.totals.wrongNotes === 1 ? 'note' : 'notes'}`, tone: 'bad' });
  if (result.totals.missed) chips.push({ text: `${result.totals.missed} missed`, tone: 'bad' });
  if (result.mode === 'tempo') {
    const { meanOffsetMs, offsetSdMs } = result.timing;
    if (Number.isFinite(meanOffsetMs)) {
      const ms = Math.round(Math.abs(meanOffsetMs));
      chips.push({ text: ms < 25 ? 'On the beat' : `${ms} ms ${meanOffsetMs > 0 ? 'late' : 'early'} on average` });
    }
    if (Number.isFinite(offsetSdMs)) chips.push({ text: `Timing spread ${Math.round(offsetSdMs)} ms` });
  } else {
    if (Number.isFinite(result.timing.estBpm)) chips.push({ text: `About ${Math.round(result.timing.estBpm)} bpm` });
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
  const bpm = Math.round(result.mode === 'tempo' ? result.bpm : (result.timing.estBpm ?? exercise.bpm));
  const entry = progress.exercises[exercise.id] ?? { title: exercise.title, attempts: 0, bestAccuracy: 0, bestBpm: 0, lastAt: null };
  entry.title = exercise.title;
  entry.attempts += 1;
  entry.bestAccuracy = Math.max(entry.bestAccuracy, pct);
  if (result.completed && pct >= 90) entry.bestBpm = Math.max(entry.bestBpm, bpm);
  entry.lastAt = new Date().toISOString();
  progress.exercises[exercise.id] = entry;
  progress.lastPracticed = todayKey();
  progress.recent = [`${exercise.title}: ${pct}% clean at about ${bpm} bpm`, ...progress.recent].slice(0, 8);
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
  if (phrase.key) $('fp-key').textContent = `${phrase.key.tonic} ${phrase.key.mode}`;
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
    const names = held.map((midi) => midiToName(midi)).join(' ');
    const chord = held.length >= 3 ? detectChord(held) : null;
    els.liveNotes.textContent = chord ? `${names}  =  ${chord.name}` : names;
  } else if (lastNote) {
    els.liveNotes.textContent = `Last note: ${midiToName(lastNote.midi)}, loudness ${lastNote.velocity} of 127`;
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
      pill.classList.add('pill-on');
      pill.textContent = status.deviceName || (status.transport === 'ble' ? 'Bluetooth piano' : 'MIDI device');
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
  els.connect.textContent = status.state === 'connected' ? 'Piano' : 'Connect piano';
  $('connect-disconnect').hidden = status.state === 'disconnected';
  if (status.state === 'error' && status.message) showConnectError(status.message);
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
  showConnectError('');
  $('dlg-connect').showModal();
}

async function connect(kind) {
  showConnectError('');
  audio.resume();
  try {
    if (kind === 'ble') await input.connectBluetooth();
    else if (kind === 'ble-all') await input.connectBluetooth({ acceptAll: true });
    else await input.connectWebMidi();
    if (input.status.state === 'connected') $('dlg-connect').close();
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
    profile: state.profile ?? { level: 'beginner', goals: '' },
    notes: state.notes,
    progress: {
      sessions: progress.sessions,
      minutes: Math.round(progress.totalMs / 60000),
      lastPracticed: progress.lastPracticed,
      recent: progress.recent,
    },
    exercise,
  });
}

/** Apply what the coach decided. Returns a short label for the chat log. */
function applyCoachAction(action) {
  if (!action || action.type === 'none') return null;
  if (action.type === 'back_to_full') {
    const full = state.session.parent;
    if (!isUsableExercise(full)) return null;
    action = { type: 'new_exercise', exercise: full };
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
    label = `New exercise: ${next.title}`;
  }
  const midAttempt =
    view === 'exercise' &&
    tracker &&
    !tracker.finished &&
    (attempt.status === 'playing' || attempt.status === 'countin') &&
    tracker.stepIndex > 0 &&
    performance.now() - attempt.lastActivity < 5000;
  if (midAttempt) {
    pendingSwitch = { exercise: next, parent };
    els.bannerText.textContent = `Your coach has the next step ready: ${next.title}.`;
    els.banner.hidden = false;
  } else {
    loadExercise(next, { parent });
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
  const price = PRICES[usage.model];
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
    sendChat('I updated my profile. Here it is again so you can adjust: ' + JSON.stringify(state.profile));
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
  }, 200);
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
  get connection() {
    return input.status;
  },
  get coachIdle() {
    return coach.idle;
  },
};

main();
