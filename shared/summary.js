// Compact text renderings of what happened at the piano. Each function returns the exact text of
// one user turn for the coach (the LLM). The first line is always a tag: [event: ...].
// Line-oriented, numbers first, no prose padding. Step numbers in the text are 1-based, because
// the coach's drill action counts steps from 1.
// Pure and isomorphic. Every renderer tolerates missing or malformed input: it never throws and
// never prints a placeholder for a missing value, it leaves that piece out.

import { midiToName } from './midi.js';
import { intervalName, spellMidi } from './theory.js';
import { describeExercise } from './exercises.js';

/** Free play: note-ons this close together are shown as one group (same rule as the tracker). */
const GROUP_MS = 60;
const MAX_NOTES_SHOWN = 60;
const MAX_WRONG_SHOWN = 6;
const MAX_RECENT_SHOWN = 8;

// ---------------------------------------------------------------- formatting helpers

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function obj(value) {
  return value && typeof value === 'object' ? value : {};
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/** Any value as one clean line of text; '' for anything that is not a usable string or number. */
function line(value, max = 600) {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (isNum(value)) text = String(value);
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

function join(parts, separator = ' | ') {
  return parts.filter((part) => typeof part === 'string' && part !== '').join(separator);
}

function count(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function percent(fraction) {
  return `${Math.round(clamp01(fraction) * 100)}%`;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/** Milliseconds as seconds with one decimal, halves rounded up: 2450 -> '2.5'. */
function tenths(ms) {
  return (Math.round(ms / 100) / 10).toFixed(1);
}

/** 2400 -> '2.4 s' */
function seconds(ms) {
  return `${tenths(ms)} s`;
}

/** One decimal, without a trailing '.0'. */
function short(value) {
  const rounded = Math.round(value * 10) / 10 + 0;
  return String(rounded);
}

function isMidi(value) {
  return Number.isInteger(value) && value >= 0 && value <= 127;
}

/** Name of a played key, spelled for the key of the exercise when there is one. */
function keyName(midi, key) {
  if (!isMidi(midi)) return '';
  return spellMidi(midi, key && typeof key === 'object' ? key : null) || midiToName(midi);
}

function handWord(hand) {
  if (hand === 'right') return 'right hand';
  if (hand === 'left') return 'left hand';
  if (hand === 'both') return 'both hands';
  return '';
}

/** '"C major scale, right hand" (right hand, 15 steps)' */
function exerciseTag(exercise) {
  const ex = obj(exercise);
  const title = line(ex.title, 120) || 'untitled exercise';
  const steps = list(ex.steps).length;
  const details = join([handWord(ex.hand), steps ? count(steps, 'step') : ''], ', ');
  return details ? `"${title}" (${details})` : `"${title}"`;
}

/** 'wait mode, no metronome, suggested tempo 60 bpm' or 'tempo mode, metronome at 72 bpm' */
function modeText(mode, bpm) {
  const tempo = isNum(bpm) ? Math.round(bpm) : null;
  if (mode === 'tempo') return tempo === null ? 'tempo mode, with the metronome' : `tempo mode, metronome at ${tempo} bpm`;
  if (mode === 'wait') return tempo === null ? 'wait mode, no metronome' : `wait mode, no metronome, suggested tempo ${tempo} bpm`;
  return tempo === null ? '' : `${tempo} bpm`;
}

function fingerText(fingers) {
  if (!fingers.some((f) => f !== null)) return '';
  const shown = fingers.map((f) => (f === null ? '?' : String(f))).join(' ');
  return fingers.length === 1 ? ` (finger ${shown})` : ` (fingers ${shown})`;
}

/** The notes of one hand: 'F4 (finger 1)' or '[C4 E4 G4] (fingers 1 3 5)'. */
function notesText(notes) {
  const names = notes.map((note) => note.name);
  const body = names.length === 1 ? names[0] : `[${names.join(' ')}]`;
  return `${body}${fingerText(notes.map((note) => note.finger))}`;
}

/**
 * What a step asks for: 'F4 (finger 1)', 'G7 = [G3 B3 D4 F4] (fingers 1 2 3 5)',
 * 'L C3 (finger 5) + R C4 (finger 1)', or 'rest'.
 */
function stepText(step, key) {
  const s = obj(step);
  const names = list(s.names);
  const fingers = list(s.fingers);
  const hands = list(s.hands);
  const notes = [];
  list(s.notes).forEach((midi, i) => {
    const name = line(names[i], 12) || keyName(midi, key);
    if (!name) return;
    const finger = Number.isInteger(fingers[i]) && fingers[i] >= 1 && fingers[i] <= 5 ? fingers[i] : null;
    notes.push({ name, finger, hand: hands[i] === 'L' ? 'L' : hands[i] === 'R' ? 'R' : '' });
  });
  if (!notes.length) return 'rest';
  const left = notes.filter((note) => note.hand === 'L');
  const right = notes.filter((note) => note.hand === 'R');
  const text = left.length && right.length && left.length + right.length === notes.length
    ? `L ${notesText(left)} + R ${notesText(right)}`
    : notesText(notes);
  const label = line(s.label, 24);
  return label ? `${label} = ${text}` : text;
}

function keysText(midis, key) {
  const names = list(midis).map((midi) => keyName(midi, key)).filter(Boolean);
  if (names.length <= MAX_WRONG_SHOWN) return names.join(', ');
  return `${names.slice(0, MAX_WRONG_SHOWN).join(', ')} and ${names.length - MAX_WRONG_SHOWN} more`;
}

function loudnessLine(dynamics) {
  const d = obj(dynamics);
  if (!isNum(d.mean)) return '';
  return `Loudness (MIDI velocity 1-127): ${join([
    `mean ${Math.round(d.mean)}`,
    isNum(d.sd) ? `spread (sd) ${Math.round(d.sd)}` : '',
    isNum(d.min) ? `softest ${Math.round(d.min)}` : '',
    isNum(d.max) ? `loudest ${Math.round(d.max)}` : '',
  ])}`;
}

/** '34 ms late', '12 ms early', '0 ms (on the click)' */
function offsetText(ms) {
  const size = Math.round(Math.abs(ms));
  if (size === 0) return '0 ms (on the click)';
  return `${size} ms ${ms > 0 ? 'late' : 'early'}`;
}

function evennessText(cv) {
  return `${percent(1 - cv)}`;
}

// ---------------------------------------------------------------- attempt

function resultLine(result, stepCount) {
  const totals = obj(result.totals);
  const total = isNum(totals.steps) ? totals.steps : stepCount;
  const parts = [];
  if (result.completed === true) {
    parts.push('completed');
  } else {
    const states = list(result.steps).map((s) => obj(s).state);
    let at = states.indexOf('current');
    if (at < 0) at = states.indexOf('pending');
    const playedAny = isNum(totals.played) && totals.played > 0;
    if (at >= 0 && stepCount) parts.push(`not completed, stopped at step ${at + 1} of ${stepCount}`);
    else parts.push('not completed');
    if (!playedAny && isNum(totals.played)) parts.push('no step was played');
  }
  if (isNum(totals.clean) && isNum(total) && total > 0) {
    const accuracy = isNum(totals.accuracy) ? totals.accuracy : totals.clean / total;
    parts.push(`${totals.clean} of ${total} steps clean (${percent(accuracy)})`);
  } else if (total === 0) {
    parts.push('the exercise has no notes to play');
  }
  if (isNum(totals.wrongNotes)) parts.push(`wrong notes ${totals.wrongNotes}`);
  const tempo = result.mode === 'tempo';
  if (tempo && isNum(totals.mistimed) && totals.mistimed > 0) {
    parts.push(`right keys outside the timing window ${totals.mistimed}`);
  }
  if (isNum(totals.missed) && (tempo || totals.missed > 0)) parts.push(`missed notes ${totals.missed}`);
  if (isNum(totals.extra) && (tempo || totals.extra > 0)) {
    parts.push(`extra notes ${totals.extra}${totals.extra > 0 ? ' (before the first step or after the last)' : ''}`);
  }
  return `Result: ${join(parts)}`;
}

/** True when every played step of the exercise is one beat long (or the exercise is unknown). */
function oneBeatSteps(exercise) {
  const lengths = list(obj(exercise).steps).filter((step) => list(obj(step).notes).length).map((step) => obj(step).beats);
  return lengths.length === 0 || lengths.every((beats) => beats === 1);
}

function timingLine(result, exercise) {
  const timing = obj(result.timing);
  const parts = [];
  if (result.mode === 'tempo') {
    if (isNum(timing.meanOffsetMs)) parts.push(`mean ${offsetText(timing.meanOffsetMs)}`);
    if (isNum(timing.offsetSdMs)) parts.push(`spread (sd) ${Math.round(timing.offsetSdMs)} ms`);
    if (isNum(timing.driftMsPerBeat)) {
      const drift = timing.driftMsPerBeat;
      parts.push(`drift ${drift > 0 ? '+' : ''}${short(drift)} ms per beat (${driftWord(result, drift)})`);
    }
    return parts.length ? `Timing against the click: ${join(parts)}` : 'Timing against the click: no notes matched';
  }
  // A bpm figure assumes the written note lengths. When steps are longer than a beat (chords held
  // for four, say) and nothing sets the pace, it would read as wild rushing: give plain seconds.
  const gaps = list(result.steps).map((step) => obj(step).ioiMs).filter((ms) => isNum(ms) && ms > 0).sort((a, b) => a - b);
  if (isNum(timing.estBpm) && oneBeatSteps(exercise)) parts.push(`about ${Math.round(timing.estBpm)} bpm`);
  else if (gaps.length) parts.push(`about ${seconds(gaps[Math.floor((gaps.length - 1) / 2)])} between steps`);
  if (isNum(timing.evennessCv)) parts.push(`evenness ${evennessText(timing.evennessCv)} (100% = equal gaps)`);
  const hesitations = list(timing.hesitations).length;
  if (parts.length || hesitations) parts.push(count(hesitations, 'hesitation'));
  if (isNum(result.durationMs) && result.durationMs > 0) parts.push(`took ${seconds(result.durationMs)}`);
  return parts.length ? `Timing (estimated from the gaps between notes): ${join(parts)}` : 'Timing: too few notes to measure';
}

/**
 * Name a drift direction only when it is more than timing scatter: with a handful of notes the
 * fitted slope is rarely zero even for perfectly steady playing.
 */
function driftWord(result, drift) {
  const timing = obj(result.timing);
  const matched = isNum(timing.offsetCount) ? timing.offsetCount : list(result.steps).filter((step) => isNum(obj(step).offsetMs)).length;
  if (matched < 8) return 'too few notes to tell a trend';
  const sd = isNum(timing.offsetSdMs) ? timing.offsetSdMs : 0;
  const span = isNum(timing.offsetSpanBeats) && timing.offsetSpanBeats > 0 ? timing.offsetSpanBeats : matched - 1;
  // Total change in offset from the first matched note to the last, at this slope.
  if (Math.abs(drift) * span < Math.max(40, sd)) return 'no clear trend';
  return drift > 0 ? 'falling further behind' : 'getting further ahead';
}

function troubleLine(spot, exercise, result) {
  const index = obj(spot).index;
  if (!Number.isInteger(index) || index < 0) return '';
  const key = obj(exercise).key;
  const step = list(obj(exercise).steps)[index];
  const record = obj(list(result.steps)[index]);
  const expected = step ? stepText(step, key) : list(spot.names).map((name) => line(name, 12)).filter(Boolean).join(' ');
  const head = expected ? `- step ${index + 1}, ${expected}:` : `- step ${index + 1}:`;
  const wrong = keysText(record.wrong, key);
  const hesitation = list(obj(result.timing).hesitations).find((h) => obj(h).index === index);
  const gap = isNum(record.ioiMs)
    ? `${seconds(record.ioiMs)} gap before it${hesitation && isNum(hesitation.factor) ? ` (${short(hesitation.factor)}x the usual)` : ''}`
    : '';
  const tempo = result.mode === 'tempo';

  if (spot.reason === 'wrong_notes') {
    const stopped = record.state === 'current';
    const what = tempo
      ? `also played ${wrong || 'other keys'}`
      : `pressed ${wrong || 'other keys'} ${stopped ? 'and the attempt stopped here' : 'before the right key'}`;
    return `${head} wrong notes, ${what}${!tempo && hesitation && gap ? `; ${gap}` : ''}`;
  }
  if (spot.reason === 'hesitation') return `${head} hesitation${gap ? `, ${gap}` : ''}`;
  if (spot.reason === 'missed') {
    const missed = keysText(record.missed, key);
    const noteCount = step ? list(step.notes).length : 0;
    const partial = noteCount > 1 && list(record.missed).length < noteCount && missed;
    return `${head} ${partial ? `missed ${missed}, the rest was hit` : 'missed, not played in time'}${wrong ? `; played ${wrong} instead` : ''}`;
  }
  if (spot.reason === 'late' || spot.reason === 'early') {
    if (isNum(record.offsetMs)) return `${head} ${offsetText(record.offsetMs)}`;
    if (record.state !== 'missed') return `${head} ${spot.reason}`;
    // The right key was struck, but too far from the beat to count.
    const expectedKeys = new Set(step ? list(step.notes) : []);
    const others = keysText(list(record.wrong).filter((midi) => !expectedKeys.has(midi)), key);
    return `${head} played too ${spot.reason}, outside the timing window (counted as missed)${others ? `; also played ${others}` : ''}`;
  }
  return '';
}

function changeLine(result, previous, exercise) {
  const prev = obj(previous);
  const before = obj(prev.totals);
  const now = obj(result.totals);
  const parts = [];
  const pair = (label, a, b, unit = '') => {
    if (isNum(a) && isNum(b)) parts.push(`${label} ${a} -> ${b}${unit}`);
  };
  if (isNum(before.accuracy) && isNum(now.accuracy)) {
    parts.push(`clean ${percent(before.accuracy)} -> ${percent(now.accuracy)}`);
  }
  pair('wrong notes', before.wrongNotes, now.wrongNotes);
  const sameMode = prev.mode === result.mode;
  const t0 = obj(prev.timing);
  const t1 = obj(result.timing);
  if (sameMode && result.mode === 'tempo') {
    pair('missed notes', before.missed, now.missed);
    if (isNum(t0.meanOffsetMs) && isNum(t1.meanOffsetMs)) {
      parts.push(`mean offset ${offsetText(t0.meanOffsetMs)} -> ${offsetText(t1.meanOffsetMs)}`);
    }
    if (isNum(t0.offsetSdMs) && isNum(t1.offsetSdMs)) {
      parts.push(`spread ${Math.round(t0.offsetSdMs)} -> ${Math.round(t1.offsetSdMs)} ms`);
    }
  } else if (sameMode) {
    if (isNum(t0.estBpm) && isNum(t1.estBpm) && oneBeatSteps(exercise)) parts.push(`pace ${Math.round(t0.estBpm)} -> ${Math.round(t1.estBpm)} bpm`);
    if (isNum(t0.evennessCv) && isNum(t1.evennessCv)) {
      parts.push(`evenness ${evennessText(t0.evennessCv)} -> ${evennessText(t1.evennessCv)}`);
    }
    pair('hesitations', list(t0.hesitations).length, list(t1.hesitations).length);
  }
  if (!parts.length) return '';
  const notes = [];
  if (!sameMode || prev.bpm !== result.bpm) {
    const was = modeText(prev.mode, prev.bpm);
    if (was) notes.push(`previous try was ${was}`);
  }
  if (prev.completed === false) notes.push('previous try was not completed');
  return `Change from the previous try: ${join(parts)}${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

/**
 * One play-through of an exercise.
 * @param {{exercise: Object|null, result: Object, attemptNumber?: number, previous?: Object|null}} input
 *   result and previous are AttemptResult objects from AttemptTracker.result(); previous is the
 *   last result of the same exercise, or null
 * @returns {string}
 */
export function renderAttempt(input) {
  const { exercise, result: rawResult, attemptNumber, previous } = obj(input);
  const ex = obj(exercise);
  const result = obj(rawResult);
  const stepCount = list(ex.steps).length || list(result.steps).length;
  const mode = result.mode === 'tempo' || result.mode === 'wait' ? result.mode : ex.mode;
  const bpm = isNum(result.bpm) ? result.bpm : ex.bpm;
  const lines = ['[event: attempt]'];
  lines.push(`Exercise: ${exerciseTag(exercise)}`);
  const tryLine = join([isNum(attemptNumber) && attemptNumber >= 1 ? `Try ${Math.round(attemptNumber)}` : '', modeText(mode, bpm)]);
  if (tryLine) lines.push(tryLine);
  if (!rawResult || typeof rawResult !== 'object') {
    lines.push('Result: no data for this try');
    return lines.join('\n');
  }
  const judged = { ...result, mode };
  lines.push(resultLine(judged, stepCount));
  lines.push(timingLine(judged, exercise));
  const loudness = loudnessLine(result.dynamics);
  if (loudness) lines.push(loudness);

  const spots = list(result.troubleSpots).map((spot) => troubleLine(obj(spot), exercise, judged)).filter(Boolean);
  if (spots.length) {
    lines.push('Trouble spots (worst first):', ...spots);
    const listed = new Set(list(result.troubleSpots).map((spot) => obj(spot).index));
    const others = list(result.steps)
      .filter((s) => (obj(s).state === 'error' || obj(s).state === 'missed') && !listed.has(obj(s).index))
      .map((s) => obj(s).index + 1)
      .filter((n) => isNum(n));
    if (others.length) lines.push(`Other steps not clean: ${others.join(', ')}`);
  } else {
    lines.push('Trouble spots: none');
  }
  if (previous && typeof previous === 'object') {
    const change = changeLine(judged, previous, exercise);
    if (change) lines.push(change);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- session start

/**
 * The first turn of a session: who the learner is, the coach's own notes, progress, and the
 * exercise on screen.
 * @param {{profile: {name?: string, level?: string, goals?: string, about?: string}|null,
 *   notes: string|null, progress: {sessions?: number, minutes?: number, lastPracticed?: string, today?: string,
 *   recent?: string[]}|null, exercise: Object|null}} input
 * @returns {string}
 */
export function renderSessionStart(input) {
  const { profile, notes, progress, exercise } = obj(input);
  const who = obj(profile);
  const lines = ['[event: session_start]'];
  const learner = join([
    line(who.name, 80),
    line(who.level, 60) ? `level: ${line(who.level, 60)}` : '',
    line(who.goals, 300) ? `goals: ${line(who.goals, 300)}` : '',
    line(who.about, 300) ? `about: ${line(who.about, 300)}` : '',
  ]);
  lines.push(`Learner: ${learner || 'no profile yet'}`);
  lines.push(`Your notes from earlier sessions: ${line(notes, 1500) || 'none yet'}`);

  const p = obj(progress);
  const numbers = join([
    isNum(p.sessions) ? count(Math.round(p.sessions), 'session') : '',
    isNum(p.minutes) ? `${count(Math.round(p.minutes), 'minute')} practiced` : '',
    line(p.lastPracticed, 40) ? `last practiced ${line(p.lastPracticed, 40)}` : '',
    line(p.today, 40) ? `today is ${line(p.today, 40)}` : '',
  ]);
  lines.push(`Progress: ${numbers || 'no history yet'}`);
  const recent = list(p.recent).map((entry) => line(entry, 160)).filter(Boolean).slice(0, MAX_RECENT_SHOWN);
  if (recent.length) lines.push('Recent results, newest first:', ...recent.map((entry) => `- ${entry}`));

  lines.push(`Exercise loaded: ${exercise && typeof exercise === 'object' ? describeSafely(exercise) : 'none'}`);
  return lines.join('\n');
}

/** describeExercise, or a one-line fallback if the exercise is not in a shape it accepts. */
function describeSafely(exercise) {
  try {
    const text = describeExercise(exercise);
    if (typeof text === 'string' && text.trim()) return text.trim();
  } catch {
    // fall through to the short form
  }
  return join([exerciseTag(exercise), modeText(obj(exercise).mode, obj(exercise).bpm)]);
}

// ---------------------------------------------------------------- free play

function groupNotes(notes) {
  const groups = [];
  for (const note of notes) {
    const group = groups[groups.length - 1];
    if (group && note.onMs - group.atMs <= GROUP_MS) group.notes.push(note);
    else groups.push({ atMs: note.onMs, notes: [note] });
  }
  return groups;
}

/** 'C4:0.4 D4:0.4 [C4 E4 G4]:1.2', capped to about the last 60 notes. */
function noteSequence(phrase, key) {
  const notes = [];
  for (const raw of list(phrase.notes)) {
    const note = obj(raw);
    const name = line(note.name, 12) || keyName(note.midi, key);
    if (!name) continue;
    notes.push({ name, onMs: isNum(note.onMs) ? note.onMs : 0, durMs: isNum(note.durMs) ? note.durMs : null });
  }
  const groups = groupNotes(notes);
  let shown = 0;
  let from = groups.length;
  while (from > 0 && shown + groups[from - 1].notes.length <= MAX_NOTES_SHOWN) {
    from -= 1;
    shown += groups[from].notes.length;
  }
  if (from === groups.length && groups.length) from -= 1; // one huge group: show it anyway
  const text = groups.slice(from).map((group) => {
    const names = group.notes.map((note) => note.name);
    const durations = group.notes.map((note) => note.durMs).filter((d) => d !== null);
    const held = durations.length ? `:${tenths(Math.max(...durations))}` : '';
    return `${names.length === 1 ? names[0] : `[${names.join(' ')}]`}${held}`;
  });
  const omitted = groups.slice(0, from).reduce((sum, group) => sum + group.notes.length, 0);
  return { text: text.join(' '), omitted };
}

/**
 * A phrase the learner played freely.
 * @param {{phrase: Object}} input  phrase is a PhraseSummary from FreePlayAnalyzer
 * @returns {string}
 */
export function renderFreePlay(input) {
  const { phrase: rawPhrase } = obj(input);
  const phrase = obj(rawPhrase);
  const lines = ['[event: free_play]'];
  const key = phrase.key && typeof phrase.key === 'object' && line(phrase.key.tonic, 4) ? phrase.key : null;
  const range = obj(phrase.range);
  const noteCount = isNum(phrase.noteCount) ? phrase.noteCount : list(phrase.notes).length;
  const low = keyName(range.low, key);
  const high = keyName(range.high, key);
  lines.push(`Phrase: ${join([
    isNum(phrase.durationMs) ? seconds(phrase.durationMs) : '',
    count(noteCount, 'note'),
    low && high ? `range ${low} to ${high}` : '',
    isNum(phrase.maxPolyphony) && phrase.maxPolyphony > 0 ? `up to ${count(phrase.maxPolyphony, 'note')} at once` : '',
    phrase.pedalUsed === true ? 'sustain pedal used' : phrase.pedalUsed === false ? 'no sustain pedal' : '',
  ])}`);

  if (key) {
    const confidence = isNum(key.confidence) ? ` (confidence ${clamp01(key.confidence).toFixed(2)} of 1)` : '';
    const name = join([line(key.tonic, 4), line(key.mode, 12)], ' ');
    // A weak lead over the next key is not a finding the teacher should repeat as fact.
    if (isNum(key.confidence) && key.confidence < 0.3) lines.push(`Key guess: unclear, weak lean toward ${name}${confidence}`);
    else lines.push(`Key guess: ${name}${confidence}`);
  } else {
    lines.push('Key guess: none (too few notes or unclear)');
  }
  const tempo = obj(phrase.tempo);
  if (isNum(tempo.bpm)) {
    const confidence = isNum(tempo.confidence) ? `, confidence ${clamp01(tempo.confidence).toFixed(2)} of 1` : '';
    lines.push(`Tempo guess: about ${Math.round(tempo.bpm)} bpm (the most common gap counted as one beat, could be double or half${confidence})`);
  } else {
    lines.push('Tempo guess: none (too few notes)');
  }
  if (isNum(phrase.evennessCv)) lines.push(`Evenness of single notes: ${evennessText(phrase.evennessCv)} (100% = perfectly steady)`);
  const loudness = loudnessLine(phrase.dynamics);
  if (loudness) lines.push(loudness);
  const chords = list(phrase.chords).map((chord) => line(obj(chord).name, 16)).filter(Boolean);
  lines.push(`Chords in order: ${chords.length ? chords.slice(-24).join(', ') : 'none detected'}`);
  const sequence = noteSequence(phrase, key);
  if (sequence.text) {
    const omitted = sequence.omitted ? `(first ${sequence.omitted} omitted) ` : '';
    lines.push(`Notes in order (name:seconds held, [ ] = struck together): ${omitted}${sequence.text}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- chat, hint, next

/**
 * The learner typed or said something.
 * @param {{text: string, exercise: Object|null, trackerState: {stepIndex: number, steps: number}|null}} input
 *   trackerState: set while an attempt is in progress (stepIndex is 0-based)
 * @returns {string}
 */
export function renderChat(input) {
  const { text, exercise, trackerState } = obj(input);
  const lines = ['[event: chat]'];
  const said = line(text, 2000);
  lines.push(said ? `Learner says: "${said}"` : 'Learner says: (empty message)');
  if (exercise && typeof exercise === 'object') {
    const state = obj(trackerState);
    const total = isNum(state.steps) && state.steps > 0 ? state.steps : list(exercise.steps).length;
    let progress = 'no attempt in progress';
    if (trackerState && typeof trackerState === 'object' && Number.isInteger(state.stepIndex) && state.stepIndex >= 0) {
      progress = total && state.stepIndex < total
        ? `attempt in progress, on step ${state.stepIndex + 1} of ${total}`
        : 'attempt in progress';
    }
    lines.push(`Context: exercise ${exerciseTag(exercise)} on screen | ${join([modeText(exercise.mode, exercise.bpm), progress])}`);
  } else {
    lines.push('Context: no exercise on screen');
  }
  return lines.join('\n');
}

/**
 * The learner is stuck on one step and wants help finding it.
 * @param {{exercise: Object|null, stepIndex: number, wrongNotes: number[], idleMs: number}} input
 *   stepIndex is 0-based; wrongNotes are the MIDI numbers pressed on this step so far
 * @returns {string}
 */
export function renderHint(input) {
  const { exercise, stepIndex, wrongNotes, idleMs } = obj(input);
  const ex = obj(exercise);
  const steps = list(ex.steps);
  const lines = ['[event: hint]'];
  lines.push(`Exercise: ${join([exercise && typeof exercise === 'object' ? exerciseTag(exercise) : 'none', modeText(ex.mode, ex.bpm)])}`);
  const step = Number.isInteger(stepIndex) && stepIndex >= 0 ? steps[stepIndex] : null;
  if (step && typeof step === 'object') {
    lines.push(`Stuck on step ${stepIndex + 1} of ${steps.length}: ${stepText(step, ex.key)}`);
    // The last step before it that has notes (rests are skipped).
    let before = stepIndex - 1;
    while (before >= 0 && !list(obj(steps[before]).notes).length) before -= 1;
    if (before >= 0) {
      const prev = steps[before];
      let move = '';
      const from = list(prev.notes);
      const to = list(step.notes);
      if (from.length === 1 && to.length === 1 && isMidi(from[0]) && isMidi(to[0])) {
        const semitones = to[0] - from[0];
        move = semitones === 0
          ? ' | the same key again'
          : ` | from there: ${semitones > 0 ? 'up' : 'down'} ${count(Math.abs(semitones), 'semitone')} (${intervalName(semitones)})`;
      }
      lines.push(`Step before it (${before + 1}): ${stepText(prev, ex.key)}${move}`);
    } else {
      lines.push('Step before it: none, this is the first note');
    }
  } else {
    lines.push('Stuck on: no current step (the attempt is over or has not started)');
  }
  const wrong = keysText(wrongNotes, ex.key);
  lines.push(`Wrong keys pressed on this step so far: ${wrong || 'none'}`);
  if (isNum(idleMs) && idleMs >= 1000) lines.push(`No key pressed for ${Math.round(idleMs / 1000)} s`);
  return lines.join('\n');
}

/**
 * The learner asks for a new or the next exercise.
 * @param {{exercise: Object|null, reason: string}} input
 * @returns {string}
 */
export function renderNext(input) {
  const { exercise, reason } = obj(input);
  const lines = ['[event: next]'];
  lines.push(`Reason: ${line(reason, 300) || 'the learner asked for a new exercise'}`);
  if (exercise && typeof exercise === 'object') {
    lines.push(`Current exercise: ${join([exerciseTag(exercise), modeText(exercise.mode, exercise.bpm)])}`);
  } else {
    lines.push('Current exercise: none');
  }
  return lines.join('\n');
}
