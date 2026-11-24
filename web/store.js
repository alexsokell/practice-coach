// Everything the app remembers lives in this browser's localStorage.
// Nothing here is sent anywhere except the text turns that go to the coach.

const KEY = 'practice-coach:v1';

export const DEFAULT_SETTINGS = Object.freeze({
  voice: false, // read the coach's replies aloud
  liveListen: true, // let the coach comment on free play
  keyHints: true, // highlight the next key on the on-screen keyboard
  showNames: true, // note names under the notation
  showFingers: true,
  anyOctave: false, // accept the right note in any octave (small keyboards)
  latencyMs: 0, // shift the tempo grid when notes register consistently late
  demoOnPiano: false, // send the "Listen" demo to the instrument over MIDI
  volume: 0.7,
});

function freshState() {
  return {
    version: 1,
    profile: null, // { name, level, goals, about }
    notes: '', // the coach's long-term notes about the learner
    settings: { ...DEFAULT_SETTINGS },
    progress: {
      sessions: 0,
      totalMs: 0,
      lastPracticed: null, // ISO date string
      recent: [], // short lines such as "C major scale RH: 93% at 66 bpm"
      exercises: {}, // id -> { title, attempts, bestAccuracy, bestBpm, lastAt }
    },
    session: null, // { day, startedAt, messages, exercise, parent, log, usage }
  };
}

export function loadState() {
  const base = freshState();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || saved.version !== 1) return base;
    return {
      ...base,
      ...saved,
      settings: { ...DEFAULT_SETTINGS, ...(saved.settings ?? {}) },
      progress: { ...base.progress, ...(saved.progress ?? {}) },
    };
  } catch {
    return base;
  }
}

let saveTimer = null;

/** Persist soon (coalesces bursts of updates into one write). */
export function saveState(state) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveStateNow(state), 250);
}

export function saveStateNow(state) {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked (private mode): the app still works for this visit.
  }
}

export function clearState() {
  clearTimeout(saveTimer);
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

export function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
