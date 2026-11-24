// The offline coach: a deterministic, rule-based stand-in for Claude. No API calls, no cost.
//
// It is used when there is no API key (or COACH_MOCK=1) so the app can be tried, and by the
// end-to-end tests. It reads the tag on the first line of the newest user turn and a few numbers
// from the report, and answers with short feedback and a sensible action. It produces the same
// event sequence as the live coach (see coach.js), streaming "say" in small chunks so the same
// code path in the browser is exercised.

import { buildExercise, STARTER_EXERCISES } from '../shared/exercises.js';
import { resolveAction, serializeReply, notesText } from './reply.js';

export const MOCK_MODEL = 'offline-coach';

const OFFLINE_NOTICE = 'This is the offline practice coach: simple built-in feedback, no AI. Add an API key to .env for the real teacher.';
const TEMPO_STEP = 8; // bpm added after two clean tries
const TEMPO_RAISES_BEFORE_MOVING_ON = 2;
const CLEAN_PERCENT = 90;
const STRUGGLE_PERCENT = 70;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The event tag on the first line of a user turn, or null. */
export function eventTag(text) {
  const match = /^\s*\[event:\s*([a-z_]+)\s*\]/i.exec(typeof text === 'string' ? text : '');
  return match ? match[1].toLowerCase() : null;
}

/** Accuracy in percent (0..100) read from an attempt report, or null when it has none. */
export function readAccuracy(text) {
  if (typeof text !== 'string') return null;
  const percentOf = (line) => {
    const match = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(line);
    if (!match) return null;
    const value = Number(match[1]);
    return value >= 0 && value <= 100 ? value : null;
  };
  const lines = text.split('\n');
  // Prefer the line that talks about accuracy; the first percentage on it is the current try
  // (a change line reads "73% -> 93%" and comes later in the report).
  for (const line of lines) {
    if (/accura|clean|correct/i.test(line)) {
      const value = percentOf(line);
      if (value !== null) return value;
      const ratio = /(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:steps?\s*)?(?:clean|correct)/i.exec(line);
      if (ratio && Number(ratio[2]) > 0 && Number(ratio[1]) <= Number(ratio[2])) return (100 * Number(ratio[1])) / Number(ratio[2]);
    }
  }
  for (const line of lines) {
    const value = percentOf(line);
    if (value !== null) return value;
  }
  return null;
}

/** The attempt number read from an attempt report, or null. */
export function readAttemptNumber(text) {
  const match = /\b(?:attempt|try)\s*(?:number|no\.?|#)?\s*:?\s*#?(\d{1,4})\b(?!\s*%|\.\d)/i.exec(bodyOf(text));
  return match ? Number(match[1]) : null;
}

/**
 * 1-based step numbers named in a report ("step 4", "steps 4-6", "steps 3, 4 and 7"), ascending, unique.
 * "step 5 of 15" is a position in the exercise, not a trouble spot: it is left out unless
 * `positions` is set.
 */
export function readStepNumbers(text, { positions = false } = {}) {
  const found = new Set();
  const pattern = /\bsteps?\s+#?(\d{1,3}(?:\s*(?:,|and|to|-)\s*\d{1,3})*)(\s+of\s+\d+)?/gi;
  for (const match of bodyOf(text).matchAll(pattern)) {
    if (match[2] && !positions) continue;
    for (const number of match[1].match(/\d+/g) ?? []) found.add(Number(number));
  }
  return [...found].filter((n) => n >= 1).sort((a, b) => a - b);
}

/** The first step number mentioned in a report, in reading order, or null. */
export function readFirstStepNumber(text) {
  const match = /\bstep\s+#?(\d{1,3})\b/i.exec(bodyOf(text));
  return match && Number(match[1]) >= 1 ? Number(match[1]) : null;
}

/** A report without its tag line. */
function bodyOf(text) {
  if (typeof text !== 'string') return '';
  const newline = text.indexOf('\n');
  return eventTag(text) ? (newline === -1 ? '' : text.slice(newline + 1)) : text;
}

/** The starter exercises, built once. */
let starterCache = null;
function starters() {
  if (!starterCache) {
    starterCache = [];
    for (const spec of STARTER_EXERCISES) {
      const built = buildExercise(spec);
      if (built.ok) starterCache.push({ spec, exercise: built.exercise });
    }
  }
  return starterCache;
}

/** Index of the starter exercise the given exercise is (or is a drill of), or -1. */
function starterIndexOf(exercise) {
  const id = typeof exercise?.id === 'string' ? exercise.id : null;
  if (!id) return -1;
  const list = starters();
  const exact = list.findIndex((entry) => entry.exercise.id === id);
  if (exact !== -1) return exact;
  // A drill keeps its parent's id with ":from-to" appended.
  return list.findIndex((entry) => id.startsWith(`${entry.exercise.id}:`));
}

/** The starter after the current exercise, wrapping around, never one with the same title. */
function nextStarter(exercise) {
  const list = starters();
  if (!list.length) return null;
  const at = starterIndexOf(exercise);
  const start = at === -1 ? 1 % list.length : (at + 1) % list.length;
  for (let offset = 0; offset < list.length; offset += 1) {
    const candidate = list[(start + offset) % list.length];
    if (candidate.exercise.title !== exercise?.title) return candidate;
  }
  return list[start];
}

function parseAssistant(content) {
  try {
    const value = JSON.parse(content);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * How many attempts in a row, ending with the newest turn, were clean on the same exercise.
 * Walks back through the transcript and stops at the first attempt that was not clean or at a
 * reply that changed the exercise.
 */
function cleanStreak(messages) {
  let streak = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'assistant') {
      const type = parseAssistant(message.content)?.action?.type;
      if (type && type !== 'none') break;
      continue;
    }
    const tag = eventTag(message.content);
    if (tag === 'attempt') {
      const accuracy = readAccuracy(bodyOf(message.content));
      if (accuracy === null || accuracy < CLEAN_PERCENT) break;
      streak += 1;
    } else if (tag === 'session_start' || tag === 'next') {
      break;
    }
  }
  return streak;
}

const describeStepNotes = (step) => {
  const names = Array.isArray(step?.names) ? step.names.filter((name) => typeof name === 'string') : [];
  if (!names.length) return null;
  const fingers = Array.isArray(step.fingers) ? step.fingers : [];
  const withFinger = names.map((name, index) => (Number.isInteger(fingers[index]) ? `${name} with finger ${fingers[index]}` : name));
  return withFinger.length === 1 ? withFinger[0] : `${withFinger.slice(0, -1).join(', ')} and ${withFinger.at(-1)} together`;
};

const listSteps = (steps) => (steps.length === 1 ? `step ${steps[0]}` : `steps ${steps.slice(0, -1).join(', ')} and ${steps.at(-1)}`);

/**
 * Decide the reply for one turn. Pure and deterministic.
 * @param {{messages: {role: string, content: string}[], exercise: object|null}} request
 * @returns {{say: string, action: object, student_notes: null}}
 */
export function mockReply({ messages, exercise = null }) {
  const list = Array.isArray(messages) ? messages : [];
  const last = typeof list.at(-1)?.content === 'string' ? list.at(-1).content : '';
  const tag = eventTag(last);
  const body = bodyOf(last);
  const stepCount = Array.isArray(exercise?.steps) ? exercise.steps.length : 0;
  let say;
  let action = { type: 'none' };

  switch (tag) {
    case 'session_start': {
      if (exercise) {
        say = `Welcome. Start with the exercise on screen, ${exercise.title}: play it slowly and aim for every note right.`;
      } else {
        const first = starters()[0];
        if (first) {
          say = `Welcome. Let us start with ${first.exercise.title}: play it slowly and aim for every note right.`;
          action = { type: 'new_exercise', exercise: first.spec };
        } else {
          say = 'Welcome. Pick an exercise from the library to get started.';
        }
      }
      break;
    }
    case 'attempt': {
      const accuracy = readAccuracy(body);
      const trouble = readStepNumbers(body).filter((n) => n <= (stepCount || Infinity));
      const attemptNumber = readAttemptNumber(body);
      const percent = `${attemptNumber !== null ? `Try ${attemptNumber}: ` : ''}${Math.round(accuracy ?? 0)}`;
      if (accuracy === null) {
        say = 'Got that try. Play it once more, slowly and evenly.';
      } else if (accuracy >= CLEAN_PERCENT) {
        // The app says so in the report when the exercise on screen is a drill cut from a bigger one.
        const inDrill = /\bback_to_full\b|drill cut from/i.test(body) || /^Drill: /.test(String(exercise?.title ?? ''));
        if (cleanStreak(list) >= 2 && inDrill) {
          say = `${percent} percent clean, twice in a row. That spot is fixed, so back to the whole exercise.`;
          action = { type: 'back_to_full' };
        } else if (cleanStreak(list) >= 2 && exercise) {
          const startBpm = starters()[starterIndexOf(exercise)]?.exercise.bpm ?? exercise.bpm;
          const raised = exercise.bpm + TEMPO_STEP;
          const next = nextStarter(exercise);
          if (raised <= 200 && exercise.bpm < startBpm + TEMPO_STEP * TEMPO_RAISES_BEFORE_MOVING_ON) {
            say = `${percent} percent clean, twice in a row. Same exercise a little faster now, at ${raised} beats per minute.`;
            action = { type: 'set_tempo', bpm: raised, mode: exercise.mode === 'tempo' ? 'tempo' : 'wait' };
          } else if (next) {
            say = `${percent} percent clean again. You have this one, so here is something new: ${next.exercise.title}.`;
            action = { type: 'new_exercise', exercise: next.spec };
          } else {
            say = `${percent} percent clean again. Well done.`;
          }
        } else {
          say = `${percent} percent clean. Play it once more just like that to make sure it sticks.`;
        }
      } else if (accuracy >= STRUGGLE_PERCENT) {
        say = trouble.length
          ? `${percent} percent clean. Watch ${listSteps(trouble.slice(0, 3))}: slow down just before and try again.`
          : `${percent} percent clean. Take it a little slower and try again.`;
      } else {
        const from = trouble.length ? Math.max(1, trouble[0] - 1) : 0;
        const to = trouble.length ? Math.min(stepCount, trouble.at(-1) + 1) : 0;
        if (exercise && trouble.length && to > from && to - from + 1 < stepCount) {
          say = `${percent} percent clean. Let us loop just steps ${from} to ${to} slowly until they feel easy.`;
          action = { type: 'drill', from_step: from, to_step: to };
        } else {
          say = `${percent} percent clean. Go much slower, one note at a time, and do not worry about speed yet.`;
        }
      }
      break;
    }
    case 'free_play':
      say = 'I heard your free playing. The offline coach cannot say much about it, so keep exploring, or go back to the exercise when you are ready.';
      break;
    case 'chat':
      say = 'I am the offline coach, so I cannot really answer questions. Use Next exercise to move on, or add an API key to .env to talk with the real teacher.';
      break;
    case 'hint': {
      const stepNumber = readFirstStepNumber(body);
      const notes = stepNumber !== null ? describeStepNotes(exercise?.steps?.[stepNumber - 1]) : null;
      say = notes ? `Step ${stepNumber} is ${notes}.` : 'Look at the highlighted key on the keyboard below, and take your time.';
      break;
    }
    case 'next': {
      const next = nextStarter(exercise);
      if (next) {
        say = `Here is the next one: ${next.exercise.title}. ${next.exercise.goal}`.trim();
        action = { type: 'new_exercise', exercise: next.spec };
      } else {
        say = 'There is no other exercise to offer right now.';
      }
      break;
    }
    default:
      say = 'Keep going. Play the exercise on screen slowly and evenly.';
      break;
  }

  // Make clear what is answering, once: on the first reply of the transcript.
  if (tag !== 'chat' && !list.some((message) => message.role === 'assistant')) say = `${say} ${OFFLINE_NOTICE}`;
  return { say, action, student_notes: null };
}

/** Split text into small chunks of whole words, like a token stream. */
function chunksOf(text, wordsPerChunk = 3) {
  const words = text.match(/\S+\s*/g) ?? [];
  const chunks = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) chunks.push(words.slice(i, i + wordsPerChunk).join(''));
  return chunks;
}

/**
 * Create the offline coach.
 * @param {Object} [options]
 * @param {number} [options.chunkDelayMs]  pause between 'say' chunks
 * @param {number} [options.maxStreamMs]   upper bound for the whole streamed reply
 * @param {() => number} [options.now]
 * @returns {((request: {messages: object[], exercise?: object|null, signal?: AbortSignal}) => AsyncGenerator<{event: string, data: object}>) & {mode: 'mock', model: string, effort: null}}
 */
export function createMockCoach({ chunkDelayMs = 5, maxStreamMs = 250, now = () => performance.now() } = {}) {
  async function* coach({ messages, exercise = null, signal } = {}) {
    const started = now();
    const elapsed = () => Math.max(0, Math.round(now() - started));
    let reply;
    try {
      reply = mockReply({ messages, exercise });
    } catch {
      reply = { say: 'Keep going. Play the exercise on screen slowly and evenly.', action: { type: 'none' }, student_notes: null };
    }

    const chunks = chunksOf(reply.say);
    const delay = Math.max(0, Math.min(chunkDelayMs, maxStreamMs / Math.max(1, chunks.length)));
    let firstText = null;
    for (const chunk of chunks) {
      if (delay > 0) await sleep(delay);
      if (signal?.aborted) return;
      if (firstText === null) firstText = elapsed();
      yield { event: 'say', data: { delta: chunk } };
    }
    if (signal?.aborted) return;

    const resolved = resolveAction(reply.action, exercise);
    yield { event: 'action', data: { action: resolved.action } };
    const notes = notesText(reply.student_notes);
    if (notes !== null) yield { event: 'notes', data: { text: notes } };
    yield {
      event: 'done',
      data: {
        assistant: serializeReply({ say: reply.say, action: resolved.spec, student_notes: reply.student_notes }),
        usage: null,
        model: MOCK_MODEL,
        ms: { firstText, total: elapsed() },
        mock: true,
      },
    };
  }

  coach.mode = 'mock';
  coach.model = MOCK_MODEL;
  coach.effort = null;
  return coach;
}
