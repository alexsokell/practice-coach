// The coach reply: parsing the model's text, checking its shape by hand, and turning the action
// (which names an exercise spec or a step range) into the concrete Exercise the browser loads.
// Shared by the live coach and the offline mock coach so both behave the same.

import { buildExercise, validateExercise, sliceExercise, withTempo } from '../shared/exercises.js';

/**
 * @typedef {{type: 'none'} | {type: 'back_to_full'} | {type: 'new_exercise', exercise: object}
 *   | {type: 'drill', from_step: number, to_step: number}
 *   | {type: 'set_tempo', bpm: number, mode: 'wait'|'tempo'}} ActionSpec
 *   The action as the coach writes it.
 * @typedef {{say: string, action: ActionSpec, student_notes: string|null}} CoachReply
 */

const NONE = Object.freeze({ type: 'none' });
const MAX_NOTES_CHARS = 4000;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parse the model's reply text as JSON. With structured outputs the text is the JSON object and
 * nothing else. Without them (degraded mode) the model may wrap it in a markdown code fence or add
 * a stray sentence, so those are stripped as a second and third try.
 * @param {string} text
 * @returns {unknown|null} the parsed value, or null when no JSON object can be found
 */
export function parseReplyText(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const fence = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/i.exec(trimmed);
  if (fence) candidates.push(fence[1].trim());
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (isObject(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * Check one action by hand and return it in its canonical spec form (unknown extra keys dropped).
 * @param {unknown} action
 * @returns {ActionSpec|null} null when the action is not one of the five shapes
 */
export function normalizeAction(action) {
  if (!isObject(action)) return null;
  switch (action.type) {
    case 'none':
      return { type: 'none' };
    case 'back_to_full':
      return { type: 'back_to_full' };
    case 'new_exercise':
      return isObject(action.exercise) ? { type: 'new_exercise', exercise: action.exercise } : null;
    case 'drill':
      return Number.isInteger(action.from_step) && Number.isInteger(action.to_step)
        ? { type: 'drill', from_step: action.from_step, to_step: action.to_step }
        : null;
    case 'set_tempo':
      return Number.isFinite(action.bpm) && (action.mode === 'wait' || action.mode === 'tempo')
        ? { type: 'set_tempo', bpm: Math.round(action.bpm), mode: action.mode }
        : null;
    default:
      return null;
  }
}

/**
 * Validate the shape of a parsed reply.
 * @param {unknown} value
 * @returns {{ok: true, reply: CoachReply} | {ok: false, errors: string[]}}
 */
export function validateReply(value) {
  if (!isObject(value)) return { ok: false, errors: ['the reply is not a JSON object'] };
  const errors = [];
  if (typeof value.say !== 'string' || !value.say.trim()) errors.push('"say" must be a non-empty string');
  const action = normalizeAction(value.action);
  if (!action) errors.push('"action" is not one of the five action shapes');
  // A missing student_notes is read as null: harmless, and kinder than rejecting the whole reply.
  const notes = value.student_notes ?? null;
  if (notes !== null && typeof notes !== 'string') errors.push('"student_notes" must be a string or null');
  if (errors.length) return { ok: false, errors };
  return { ok: true, reply: { say: value.say, action, student_notes: notes } };
}

/**
 * Keep what is usable of a reply that failed validation: the spoken text if there is any, a valid
 * action or none, valid notes or null.
 * @param {unknown} value            the parsed reply, or null when it did not parse
 * @param {string} streamedSay       "say" text already sent to the learner
 * @returns {CoachReply|null} null when there is nothing to say at all
 */
export function salvageReply(value, streamedSay) {
  const parsedSay = isObject(value) && typeof value.say === 'string' && value.say.trim() ? value.say : null;
  const say = parsedSay ?? (typeof streamedSay === 'string' && streamedSay.trim() ? streamedSay : null);
  if (say === null) return null;
  const action = (isObject(value) && normalizeAction(value.action)) || { type: 'none' };
  const notes = isObject(value) && typeof value.student_notes === 'string' ? value.student_notes : null;
  return { say, action, student_notes: notes };
}

/**
 * Turn an action spec into the action event for the browser, with the concrete Exercise attached.
 * Never throws. An action that cannot be carried out (no current exercise, bad step range, an
 * exercise that does not build) comes back as { type: 'none' } with the reason in `problem`, and
 * for a rejected new exercise the build errors in `errors` so the caller can ask for a correction.
 *
 * @param {ActionSpec} spec             a normalized action
 * @param {object|null} currentExercise the exercise loaded in the browser right now
 * @returns {{action: object, spec: ActionSpec, problem?: string, errors?: string[]}}
 *   action = what to send in the 'action' event; spec = what really happened, in spec form, for
 *   the transcript.
 */
export function resolveAction(spec, currentExercise) {
  const none = (problem, errors) => ({ action: { type: 'none' }, spec: { type: 'none' }, problem, ...(errors ? { errors } : {}) });
  try {
    switch (spec?.type) {
      case 'none':
        return { action: { type: 'none' }, spec: { type: 'none' } };
      case 'back_to_full':
        return { action: { type: 'back_to_full' }, spec: { type: 'back_to_full' } };
      case 'new_exercise': {
        const built = buildExercise(spec.exercise);
        if (!built?.ok) {
          const errors = Array.isArray(built?.errors) && built.errors.length ? built.errors.map(String) : ['the exercise could not be built'];
          return none('the exercise could not be built', errors);
        }
        const invalid = validateExercise(built.exercise);
        if (invalid.length) return none('the built exercise is not valid', invalid.map(String));
        return { action: { type: 'new_exercise', exercise: built.exercise }, spec: { type: 'new_exercise', exercise: spec.exercise } };
      }
      case 'drill': {
        if (!currentExercise) return none('drill needs a current exercise');
        const count = Array.isArray(currentExercise.steps) ? currentExercise.steps.length : 0;
        const { from_step: from, to_step: to } = spec;
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > count) {
          return none(`drill range ${from} to ${to} is outside steps 1 to ${count}`);
        }
        const exercise = sliceExercise(currentExercise, from - 1, to - 1);
        const invalid = validateExercise(exercise);
        if (invalid.length) return none('the drill exercise is not valid');
        return { action: { type: 'drill', from_step: from, to_step: to, exercise }, spec: { type: 'drill', from_step: from, to_step: to } };
      }
      case 'set_tempo': {
        if (!currentExercise) return none('set_tempo needs a current exercise');
        const exercise = withTempo(currentExercise, { bpm: spec.bpm, mode: spec.mode });
        const invalid = validateExercise(exercise);
        if (invalid.length) return none('the exercise at the new tempo is not valid');
        // Report the tempo the exercise really got (withTempo clamps to 30..200).
        const bpm = exercise.bpm;
        const mode = exercise.mode;
        return { action: { type: 'set_tempo', bpm, mode, exercise }, spec: { type: 'set_tempo', bpm, mode } };
      }
      default:
        return none('unknown action type');
    }
  } catch (err) {
    return none(`the action failed: ${err?.message ?? err}`);
  }
}

/**
 * The reply as the string the browser stores back into the transcript as the assistant turn.
 * @param {CoachReply} reply  with the action in spec form
 */
export function serializeReply(reply) {
  return JSON.stringify({ say: reply.say, action: reply.action, student_notes: reply.student_notes ?? null });
}

/**
 * The text for the 'notes' event, or null when the coach did not update its notes.
 * @param {string|null} notes
 */
export function notesText(notes) {
  if (typeof notes !== 'string') return null;
  const text = notes.trim();
  return text ? text.slice(0, MAX_NOTES_CHARS) : null;
}

export { NONE as ACTION_NONE };
