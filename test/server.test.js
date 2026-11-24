// Tests for server/: the HTTP server, the live coach flow (with a fake Anthropic client, so no
// network is used and no API key is needed), the offline mock coach, and the reply helpers.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';

import {
  createApp,
  readConfig,
  validateCoachBody,
  hostnameOf,
  parseAllowedHosts,
  createRateLimiter,
  resolveStaticPath,
  BODY_LIMIT_BYTES,
  MAX_MESSAGES,
  MAX_CONTENT_CHARS,
} from '../server/index.js';
import { createCoach, mapError, FALLBACK_BETA, MAX_TOKENS, DEFAULT_MODEL, DEFAULT_EFFORT } from '../server/coach.js';
import { createMockCoach, mockReply, eventTag, readAccuracy, readAttemptNumber, readStepNumbers, readFirstStepNumber, MOCK_MODEL } from '../server/mock-coach.js';
import { SYSTEM_PROMPT, COACH_REPLY_SCHEMA, ACTION_TYPES } from '../server/prompt.js';
import { parseReplyText, validateReply, normalizeAction, salvageReply, resolveAction, serializeReply, notesText } from '../server/reply.js';
import { buildExercise, validateExercise, STARTER_EXERCISES, EXERCISE_SPEC_JSON_SCHEMA } from '../shared/exercises.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- fixtures

const built = (spec) => {
  const result = buildExercise(spec);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.exercise;
};
const SCALE_SPEC = STARTER_EXERCISES.find((spec) => spec.type === 'scale' && spec.hand === 'right');
const SCALE = built(SCALE_SPEC); // 15 steps
const GOOD_SPEC = {
  type: 'five_finger',
  title: 'G five-finger pattern, right hand',
  goal: 'Keep every note the same length.',
  hand: 'right',
  bpm: 66,
  mode: 'wait',
  root: 'G',
  quality: 'major',
  pattern: 'up_down',
  start_octave: 4,
  note_beats: 1,
};
const BAD_SPEC = { ...GOOD_SPEC, root: 'H', title: 'H five-finger pattern' };

const USER_START = { role: 'user', content: '[event: session_start]\nlearner: Sam, beginner\nexercise: none' };
const usage = (extra = {}) => ({ input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000, ...extra });
const replyJson = (say, action = { type: 'none' }, notes = null) => JSON.stringify({ say, action, student_notes: notes });

function textBlockEvents(index, text, chunk = 9) {
  const events = [{ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }];
  for (let i = 0; i < text.length; i += chunk) {
    events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(i, i + chunk) } });
  }
  events.push({ type: 'content_block_stop', index });
  return events;
}

/** The stream events and final message the API would produce for a reply of plain `text`. */
function apiReply(text, { chunk = 9, stopReason = 'end_turn', model = 'claude-opus-5-5', use = usage(), thinking = true } = {}) {
  const events = [{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: use } }];
  const content = [];
  let index = 0;
  if (thinking) {
    // Adaptive thinking is always on for the default model: an empty thinking block comes first.
    events.push(
      { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: '' } },
      { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index },
    );
    content.push({ type: 'thinking', thinking: '', signature: 'sig' });
    index += 1;
  }
  events.push(...textBlockEvents(index, text, chunk));
  content.push({ type: 'text', text });
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: use }, { type: 'message_stop' });
  return { events, final: { id: 'msg_1', type: 'message', role: 'assistant', model, content, stop_reason: stopReason, stop_sequence: null, usage: use } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A hand-written stand-in for the Anthropic client. `script` is a list of responders, one per
 * request in order (the last one repeats), or a single responder. A responder gets the recorded
 * call and returns { events, final } and optionally:
 *   error:      thrown as soon as the stream is iterated, and by finalMessage()
 *   lateError:  thrown after the events were delivered, and by finalMessage()
 *   quietError: the iterator just ends; only finalMessage() rejects (how the SDK's iterator
 *               behaves when the error lands between two reads)
 *   hang:       after the events, wait until the request is aborted
 */
function fakeClient(script) {
  const calls = [];
  const endpoint = (name) => ({
    stream(params, options) {
      const call = { endpoint: name, params: structuredClone(params), options };
      calls.push(call);
      const responders = Array.isArray(script) ? script : [script];
      const spec = responders[Math.min(calls.length - 1, responders.length - 1)](call, calls.length - 1);
      const signal = options?.signal;
      const failure = spec.error ?? spec.lateError ?? spec.quietError ?? null;
      return {
        async *[Symbol.asyncIterator]() {
          await tick();
          if (spec.error) throw spec.error;
          for (const event of spec.events ?? []) {
            if (signal?.aborted) throw new Anthropic.APIUserAbortError();
            await tick();
            yield event;
          }
          if (spec.hang) {
            await new Promise((resolve) => {
              if (signal?.aborted) resolve();
              else signal?.addEventListener('abort', resolve, { once: true });
            });
            call.sawAbort = true;
            throw new Anthropic.APIUserAbortError();
          }
          if (spec.lateError) throw spec.lateError;
        },
        async finalMessage() {
          if (failure) throw failure;
          return spec.final;
        },
      };
    },
  });
  return { calls, beta: { messages: endpoint('beta') }, messages: endpoint('stable') };
}

const apiError = (status, type, message = `test ${type}`) =>
  Anthropic.APIError.generate(status, { type: 'error', error: { type, message } }, undefined, new Headers({ 'request-id': 'req_test' }));
const badRequest = (message = 'test bad request') => apiError(400, 'invalid_request_error', message);

/** A live coach over a fake client, with its warnings captured. */
function liveCoach(script, options = {}) {
  const client = fakeClient(script);
  const warnings = [];
  const coach = createCoach({ client, warn: (message) => warnings.push(message), ...options });
  return { coach, client, warnings };
}

async function collect(iterable) {
  const events = [];
  for await (const item of iterable) events.push(item);
  return events;
}

/** Run one turn and index the events by kind. */
async function turn(coach, { messages = [USER_START], exercise = null, signal } = {}) {
  const events = await collect(coach({ messages, exercise, signal }));
  const of = (name) => events.filter((item) => item.event === name).map((item) => item.data);
  // The text the learner ends up with: every delta after the last reset.
  let said = '';
  for (const item of events) {
    if (item.event === 'reset') said = '';
    else if (item.event === 'say') said += item.data.delta;
  }
  return { events, names: events.map((item) => item.event), said, action: of('action')[0]?.action, actions: of('action'), notes: of('notes'), done: of('done')[0], error: of('error')[0] };
}

/** Start an app on a free port. */
async function listen(t, options) {
  const server = createApp({ log: () => {}, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );
  const { port } = server.address();
  return { server, port, base: `http://127.0.0.1:${port}` };
}

/** A raw HTTP request, for the things fetch() will not send (a foreign Host, "..", odd methods). */
function raw(port, { method = 'GET', path: requestPath = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function parseSse(text) {
  const events = [];
  for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
  }
  return events;
}

async function postCoach(base, body, headers = {}) {
  const response = await fetch(`${base}/api/coach`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  const isSse = (response.headers.get('content-type') ?? '').startsWith('text/event-stream');
  return { response, status: response.status, text, events: isSse ? parseSse(text) : [], json: isSse ? null : safeJson(text) };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function tempDir(t, prefix = 'practice-coach-test-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A canned coach for the HTTP tests that do not care about the coach itself. */
function cannedCoach(events = [{ event: 'say', data: { delta: 'Hi.' } }, { event: 'action', data: { action: { type: 'none' } } }, { event: 'done', data: { assistant: '{}', usage: null, model: 'test', ms: { firstText: 0, total: 0 }, mock: true } }]) {
  const coach = async function* canned(request) {
    coach.requests.push(request);
    for (const item of events) yield item;
  };
  coach.requests = [];
  coach.mode = 'mock';
  coach.model = 'test-model';
  coach.effort = null;
  return coach;
}

// ---------------------------------------------------------------- prompt and schema

test('SYSTEM_PROMPT is a long static string', () => {
  assert.equal(typeof SYSTEM_PROMPT, 'string');
  // Well above the minimum cacheable size (roughly 4 characters per token).
  assert.ok(SYSTEM_PROMPT.length > 4000, `only ${SYSTEM_PROMPT.length} characters`);
  assert.equal(SYSTEM_PROMPT.includes('\u2014'), false, 'no em dash');
  // Nothing that looks generated at load time.
  assert.equal(/\b20\d\d-\d\d-\d\d\b/.test(SYSTEM_PROMPT), false, 'no dates');
  assert.equal(SYSTEM_PROMPT.includes('${'), false);
  assert.equal(SYSTEM_PROMPT.includes('undefined'), false);
});

test('COACH_REPLY_SCHEMA: say first, five actions, nullable notes', () => {
  assert.equal(COACH_REPLY_SCHEMA.type, 'object');
  assert.deepEqual(Object.keys(COACH_REPLY_SCHEMA.properties), ['say', 'action', 'student_notes']);
  assert.deepEqual(COACH_REPLY_SCHEMA.required, ['say', 'action', 'student_notes']);
  assert.equal(COACH_REPLY_SCHEMA.additionalProperties, false);
  assert.equal(COACH_REPLY_SCHEMA.properties.say.type, 'string');
  const variants = COACH_REPLY_SCHEMA.properties.action.anyOf;
  assert.deepEqual(
    variants.map((variant) => variant.properties.type.const),
    ['none', 'new_exercise', 'drill', 'set_tempo', 'back_to_full'],
  );
  assert.deepEqual([...ACTION_TYPES].sort(), variants.map((variant) => variant.properties.type.const).sort());
  const byType = Object.fromEntries(variants.map((variant) => [variant.properties.type.const, variant]));
  assert.deepEqual(byType.none.required, ['type']);
  assert.deepEqual(byType.back_to_full.required, ['type']);
  assert.deepEqual(byType.drill.required, ['type', 'from_step', 'to_step']);
  assert.equal(byType.drill.properties.from_step.type, 'integer');
  assert.deepEqual(byType.set_tempo.required, ['type', 'bpm', 'mode']);
  assert.deepEqual(byType.set_tempo.properties.mode.enum, ['wait', 'tempo']);
  assert.deepEqual(byType.new_exercise.required, ['type', 'exercise']);
  assert.deepEqual(byType.new_exercise.properties.exercise.anyOf, EXERCISE_SPEC_JSON_SCHEMA.anyOf);
  assert.deepEqual(COACH_REPLY_SCHEMA.properties.student_notes.anyOf, [{ type: 'string' }, { type: 'null' }]);
});

test('COACH_REPLY_SCHEMA obeys the strict structured-output limits everywhere', () => {
  const forbidden = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'oneOf', 'not', 'if', 'patternProperties'];
  let objects = 0;
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((item, index) => walk(item, `${where}[${index}]`));
    if (typeof node !== 'object' || node === null) return undefined;
    for (const key of forbidden) assert.equal(key in node, false, `${where} uses ${key}`);
    if (node.type === 'object') {
      objects += 1;
      assert.equal(node.additionalProperties, false, `${where} must set additionalProperties: false`);
      assert.deepEqual([...(node.required ?? [])].sort(), Object.keys(node.properties ?? {}).sort(), `${where} must require every property`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties') {
        for (const [name, schema] of Object.entries(value)) walk(schema, `${where}.${name}`);
      } else if (key !== 'enum' && key !== 'const' && key !== 'required') {
        walk(value, `${where}.${key}`);
      }
    }
    return undefined;
  };
  walk(COACH_REPLY_SCHEMA, 'reply');
  assert.ok(objects >= 11, 'walked the reply, the five actions and the five exercise kinds');
  // Every "#/..." reference must resolve from the root of the reply schema.
  const text = JSON.stringify(COACH_REPLY_SCHEMA);
  for (const match of text.matchAll(/"\$ref":"#\/([^"]+)"/g)) {
    let node = COACH_REPLY_SCHEMA;
    for (const part of match[1].split('/')) node = node?.[part];
    assert.ok(node, `unresolved reference #/${match[1]}`);
  }
  assert.equal(text.includes('\u2014'), false);
});

// ---------------------------------------------------------------- reply helpers

test('parseReplyText: plain JSON, code fences, surrounding prose, junk', () => {
  const object = { say: 'Hi.', action: { type: 'none' }, student_notes: null };
  const json = JSON.stringify(object);
  assert.deepEqual(parseReplyText(json), object);
  assert.deepEqual(parseReplyText(`  \n${json}\n`), object);
  assert.deepEqual(parseReplyText('```json\n' + json + '\n```'), object);
  assert.deepEqual(parseReplyText('```\n' + json + '\n```\n'), object);
  assert.deepEqual(parseReplyText('Here is my reply:\n```json\n' + json + '\n```\nDone.'), object);
  assert.deepEqual(parseReplyText(`Sure. ${json} Hope that helps.`), object);
  for (const junk of ['', '   ', 'no json here', '{"say": "cut off', '[1,2]', '"text"', '42', 'null', null, undefined, 7, {}]) {
    assert.equal(parseReplyText(junk), null, JSON.stringify(junk));
  }
});

test('normalizeAction accepts exactly the five shapes', () => {
  assert.deepEqual(normalizeAction({ type: 'none', extra: 1 }), { type: 'none' });
  assert.deepEqual(normalizeAction({ type: 'back_to_full', exercise: {} }), { type: 'back_to_full' });
  assert.deepEqual(normalizeAction({ type: 'new_exercise', exercise: GOOD_SPEC }), { type: 'new_exercise', exercise: GOOD_SPEC });
  assert.deepEqual(normalizeAction({ type: 'drill', from_step: 2, to_step: 5 }), { type: 'drill', from_step: 2, to_step: 5 });
  assert.deepEqual(normalizeAction({ type: 'set_tempo', bpm: 72, mode: 'tempo' }), { type: 'set_tempo', bpm: 72, mode: 'tempo' });
  assert.deepEqual(normalizeAction({ type: 'set_tempo', bpm: 72.4, mode: 'wait' }), { type: 'set_tempo', bpm: 72, mode: 'wait' });
  const invalid = [
    null,
    undefined,
    'none',
    [],
    {},
    { type: 'dance' },
    { type: 'new_exercise' },
    { type: 'new_exercise', exercise: null },
    { type: 'new_exercise', exercise: 'C major' },
    { type: 'new_exercise', exercise: [] },
    { type: 'drill', from_step: 2 },
    { type: 'drill', from_step: '2', to_step: 5 },
    { type: 'drill', from_step: 2.5, to_step: 5 },
    { type: 'set_tempo', bpm: 72 },
    { type: 'set_tempo', bpm: '72', mode: 'wait' },
    { type: 'set_tempo', bpm: Number.NaN, mode: 'wait' },
    { type: 'set_tempo', bpm: 72, mode: 'fast' },
  ];
  for (const action of invalid) assert.equal(normalizeAction(action), null, JSON.stringify(action));
});

test('validateReply checks say, action and student_notes by hand', () => {
  const good = validateReply({ say: 'Hi.', action: { type: 'none' }, student_notes: 'likes scales', more: true });
  assert.deepEqual(good, { ok: true, reply: { say: 'Hi.', action: { type: 'none' }, student_notes: 'likes scales' } });
  assert.equal(validateReply({ say: 'Hi.', action: { type: 'none' }, student_notes: null }).ok, true);
  assert.equal(validateReply({ say: 'Hi.', action: { type: 'none' } }).reply.student_notes, null, 'missing notes read as null');
  const bad = [
    null,
    'text',
    [],
    {},
    { say: '', action: { type: 'none' }, student_notes: null },
    { say: '   ', action: { type: 'none' }, student_notes: null },
    { say: 5, action: { type: 'none' }, student_notes: null },
    { say: 'Hi.', student_notes: null },
    { say: 'Hi.', action: { type: 'jump' }, student_notes: null },
    { say: 'Hi.', action: { type: 'none' }, student_notes: 5 },
    { say: 'Hi.', action: { type: 'none' }, student_notes: ['a'] },
  ];
  for (const value of bad) {
    const result = validateReply(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.ok(result.errors.length >= 1);
  }
});

test('salvageReply keeps what is usable', () => {
  assert.equal(salvageReply(null, ''), null);
  assert.equal(salvageReply(null, '   '), null);
  assert.equal(salvageReply({ action: { type: 'none' } }, ''), null);
  assert.deepEqual(salvageReply(null, 'Streamed text.'), { say: 'Streamed text.', action: { type: 'none' }, student_notes: null });
  assert.deepEqual(salvageReply({ say: 'Parsed.', action: { type: 'jump' }, student_notes: 4 }, 'Par'), { say: 'Parsed.', action: { type: 'none' }, student_notes: null });
  assert.deepEqual(salvageReply({ say: 'Parsed.', action: { type: 'drill', from_step: 1, to_step: 2 }, student_notes: 7 }, ''), {
    say: 'Parsed.',
    action: { type: 'drill', from_step: 1, to_step: 2 },
    student_notes: null,
  });
});

test('resolveAction: every action type, with and without a current exercise', () => {
  assert.deepEqual(resolveAction({ type: 'none' }, SCALE), { action: { type: 'none' }, spec: { type: 'none' } });
  assert.deepEqual(resolveAction({ type: 'back_to_full' }, null), { action: { type: 'back_to_full' }, spec: { type: 'back_to_full' } });

  const fresh = resolveAction({ type: 'new_exercise', exercise: GOOD_SPEC }, null);
  assert.equal(fresh.action.type, 'new_exercise');
  assert.deepEqual(validateExercise(fresh.action.exercise), []);
  assert.equal(fresh.action.exercise.steps.length, 9);
  assert.deepEqual(fresh.spec, { type: 'new_exercise', exercise: GOOD_SPEC });

  const rejected = resolveAction({ type: 'new_exercise', exercise: BAD_SPEC }, SCALE);
  assert.deepEqual(rejected.action, { type: 'none' });
  assert.deepEqual(rejected.spec, { type: 'none' });
  assert.ok(Array.isArray(rejected.errors) && rejected.errors.length >= 1);

  const drill = resolveAction({ type: 'drill', from_step: 3, to_step: 6 }, SCALE);
  assert.equal(drill.action.type, 'drill');
  assert.equal(drill.action.from_step, 3);
  assert.equal(drill.action.to_step, 6);
  assert.equal(drill.action.exercise.steps.length, 4);
  assert.deepEqual(drill.action.exercise.steps[0].notes, SCALE.steps[2].notes, '1-based inclusive range');
  assert.deepEqual(drill.action.exercise.steps[3].notes, SCALE.steps[5].notes);
  assert.deepEqual(validateExercise(drill.action.exercise), []);
  assert.deepEqual(drill.spec, { type: 'drill', from_step: 3, to_step: 6 });
  assert.equal(resolveAction({ type: 'drill', from_step: 15, to_step: 15 }, SCALE).action.exercise.steps.length, 1);
  assert.equal(resolveAction({ type: 'drill', from_step: 1, to_step: 15 }, SCALE).action.exercise.steps.length, 15);

  for (const [from, to] of [[0, 3], [3, 16], [6, 3], [-1, 2], [16, 18]]) {
    const result = resolveAction({ type: 'drill', from_step: from, to_step: to }, SCALE);
    assert.deepEqual(result.action, { type: 'none' }, `range ${from} to ${to}`);
    assert.equal(result.errors, undefined, 'a bad drill range does not ask for a correction');
  }
  assert.deepEqual(resolveAction({ type: 'drill', from_step: 3, to_step: 6 }, null).action, { type: 'none' });
  assert.deepEqual(resolveAction({ type: 'drill', from_step: 3, to_step: 6 }, {}).action, { type: 'none' });

  const tempo = resolveAction({ type: 'set_tempo', bpm: 72, mode: 'tempo' }, SCALE);
  assert.equal(tempo.action.type, 'set_tempo');
  assert.equal(tempo.action.bpm, 72);
  assert.equal(tempo.action.mode, 'tempo');
  assert.equal(tempo.action.exercise.bpm, 72);
  assert.equal(tempo.action.exercise.mode, 'tempo');
  assert.equal(tempo.action.exercise.id, SCALE.id);
  assert.deepEqual(tempo.spec, { type: 'set_tempo', bpm: 72, mode: 'tempo' });
  const clamped = resolveAction({ type: 'set_tempo', bpm: 999, mode: 'wait' }, SCALE);
  assert.equal(clamped.action.bpm, 200, 'the action reports the tempo the exercise really got');
  assert.equal(clamped.action.exercise.bpm, 200);
  assert.deepEqual(resolveAction({ type: 'set_tempo', bpm: 72, mode: 'tempo' }, null).action, { type: 'none' });

  for (const odd of [null, undefined, {}, { type: 'jump' }, 'none']) assert.deepEqual(resolveAction(odd, SCALE).action, { type: 'none' });
});

test('serializeReply and notesText', () => {
  assert.equal(serializeReply({ say: 'Hi.', action: { type: 'none' }, student_notes: undefined }), '{"say":"Hi.","action":{"type":"none"},"student_notes":null}');
  assert.equal(notesText(null), null);
  assert.equal(notesText(''), null);
  assert.equal(notesText('  \n'), null);
  assert.equal(notesText(5), null);
  assert.equal(notesText(' likes scales '), 'likes scales');
});

// ---------------------------------------------------------------- live coach: the request

test('happy path: events in order, say streamed in pieces, done carries the reply', async () => {
  const say = 'Welcome, Sam. Start with the C major scale, right hand, slowly.';
  const text = replyJson(say, { type: 'none' }, 'Sam: beginner, wants songs with both hands.');
  const { coach, client } = liveCoach(() => apiReply(text));
  const result = await turn(coach);

  assert.equal(result.error, undefined);
  const sayCount = result.names.filter((name) => name === 'say').length;
  assert.ok(sayCount >= 3, 'say arrives incrementally');
  assert.deepEqual(result.names, [...Array(sayCount).fill('say'), 'action', 'notes', 'done']);
  assert.equal(result.said, say);
  assert.deepEqual(result.action, { type: 'none' });
  assert.deepEqual(result.notes, [{ text: 'Sam: beginner, wants songs with both hands.' }]);
  assert.deepEqual(JSON.parse(result.done.assistant), { say, action: { type: 'none' }, student_notes: 'Sam: beginner, wants songs with both hands.' });
  assert.deepEqual(result.done.usage, usage(), 'usage is passed through as the API sent it');
  assert.equal(result.done.model, 'claude-opus-5-5');
  assert.equal(result.done.mock, false);
  assert.equal(typeof result.done.ms.total, 'number');
  assert.equal(typeof result.done.ms.firstText, 'number');
  assert.ok(result.done.ms.firstText <= result.done.ms.total);
  assert.equal(client.calls.length, 1);
  assert.equal(coach.mode, 'live');
  assert.equal(coach.model, DEFAULT_MODEL);
  assert.equal(coach.effort, DEFAULT_EFFORT);
});

test('the exact request: model, effort, schema, cache breakpoints, nothing forbidden', async () => {
  const { coach, client } = liveCoach(() => apiReply(replyJson('Fine.')), { model: 'claude-opus-5-5', effort: 'medium' });
  const messages = [
    USER_START,
    { role: 'assistant', content: replyJson('Welcome.') },
    { role: 'user', content: '[event: attempt]\naccuracy 93%' },
  ];
  const controller = new AbortController();
  await turn(coach, { messages, signal: controller.signal });

  assert.equal(client.calls.length, 1);
  const { endpoint, params, options } = client.calls[0];
  assert.equal(endpoint, 'beta', 'the fallback beta needs client.beta.messages');
  assert.deepEqual(Object.keys(params).sort(), ['betas', 'fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'system']);
  for (const key of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'tools', 'stream', 'stop_sequences', 'metadata']) {
    assert.equal(key in params, false, `${key} must not be sent`);
  }
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.max_tokens, 16000);
  assert.equal(MAX_TOKENS, 16000);
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(FALLBACK_BETA, 'server-side-fallback-2026-07-01');
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.output_config, { effort: 'medium', format: { type: 'json_schema', schema: structuredClone(COACH_REPLY_SCHEMA) } });
  // The system prompt: one static text block, cached.
  assert.deepEqual(params.system, [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
  // The transcript: plain strings, except the newest user turn, which carries the cache breakpoint.
  assert.deepEqual(params.messages, [
    { role: 'user', content: USER_START.content },
    { role: 'assistant', content: messages[1].content },
    { role: 'user', content: [{ type: 'text', text: messages[2].content, cache_control: { type: 'ephemeral' } }] },
  ]);
  assert.equal(params.messages.at(-1).role, 'user', 'no assistant prefill');
  // The SDK gets a signal of its own, linked to the request's signal while the turn runs (it
  // also carries the idle watchdog). The abort tests below check that a disconnect reaches it.
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
});

test('two requests with the same transcript send byte-identical prefixes (cacheable)', async () => {
  const { coach, client } = liveCoach(() => apiReply(replyJson('Fine.')));
  await turn(coach);
  await turn(coach);
  assert.equal(JSON.stringify(client.calls[0].params), JSON.stringify(client.calls[1].params));
});

test('createCoach needs a client', () => {
  assert.throws(() => createCoach({}), TypeError);
  assert.throws(() => createCoach(), TypeError);
});

// ---------------------------------------------------------------- live coach: downgrade ladder

test('ladder step 1: a 400 with the fallback beta on is retried once without it, and remembered', async () => {
  const good = () => apiReply(replyJson('Hello there.'));
  const { coach, client, warnings } = liveCoach([() => ({ error: badRequest('Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.') }), good]);

  const first = await turn(coach);
  assert.equal(first.error, undefined);
  assert.equal(first.said, 'Hello there.');
  assert.deepEqual(first.names.filter((name) => name !== 'say'), ['action', 'done'], 'no reset: nothing had been said yet');
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].endpoint, 'beta');
  assert.equal(client.calls[1].endpoint, 'stable');
  assert.equal('betas' in client.calls[1].params, false);
  assert.equal('fallbacks' in client.calls[1].params, false);
  assert.equal(client.calls[1].params.output_config.format.type, 'json_schema', 'structured outputs stay on');
  assert.deepEqual(client.calls[1].params.messages, client.calls[0].params.messages);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /server-side-fallback-2026-07-01/, 'the warning carries error.message');

  const second = await turn(coach);
  assert.equal(second.said, 'Hello there.');
  assert.equal(client.calls.length, 3, 'the next turn does not try the beta again');
  assert.equal(client.calls[2].endpoint, 'stable');
  assert.equal(warnings.length, 1, 'logged once');
});

test('ladder step 2: still a 400 with a format, retried once without it, and remembered', async () => {
  const fenced = () => apiReply('```json\n' + replyJson('Degraded but fine.', { type: 'set_tempo', bpm: 70, mode: 'wait' }) + '\n```');
  const { coach, client, warnings } = liveCoach([() => ({ error: badRequest('beta not enabled') }), () => ({ error: badRequest('output_config.format: schema too complex') }), fenced]);

  const first = await turn(coach, { exercise: SCALE });
  assert.equal(first.error, undefined);
  assert.equal(first.said, 'Degraded but fine.', 'the extractor copes with the code fence');
  assert.equal(first.action.type, 'set_tempo');
  assert.equal(first.action.exercise.bpm, 70);
  assert.equal(client.calls.length, 3);
  assert.deepEqual(client.calls.map((call) => call.endpoint), ['beta', 'stable', 'stable']);
  assert.deepEqual(client.calls[2].params.output_config, { effort: DEFAULT_EFFORT }, 'effort stays, format is gone');
  assert.deepEqual(Object.keys(client.calls[2].params).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /schema too complex/);

  await turn(coach, { exercise: SCALE });
  assert.equal(client.calls.length, 4);
  assert.equal(client.calls[3].endpoint, 'stable');
  assert.deepEqual(client.calls[3].params.output_config, { effort: DEFAULT_EFFORT });
  assert.equal(warnings.length, 2);
});

test('ladder exhausted: three 400s give bad_request, and nothing is remembered from a ladder that never worked', async () => {
  const { coach, client, warnings } = liveCoach(() => ({ error: badRequest('prompt is too long') }));
  const first = await turn(coach);
  assert.deepEqual(first.names, ['error']);
  assert.equal(first.error.code, 'bad_request');
  assert.equal(first.error.retryable, false);
  assert.match(first.error.message, /prompt is too long/);
  assert.equal(client.calls.length, 3, 'each rung is tried exactly once');
  assert.deepEqual(client.calls.map((call) => call.endpoint), ['beta', 'stable', 'stable']);

  await turn(coach);
  assert.equal(client.calls.length, 6);
  assert.equal(client.calls[3].endpoint, 'beta', 'a request-specific 400 must not switch the features off for good');
  assert.equal(warnings.length, 2, 'each downgrade is logged once per process');
});

test('other errors are not retried by the coach', async () => {
  for (const error of [apiError(429, 'rate_limit_error'), apiError(529, 'overloaded_error'), apiError(500, 'api_error'), apiError(401, 'authentication_error'), new Anthropic.APIConnectionError({ message: 'Connection error.' })]) {
    const { coach, client, warnings } = liveCoach(() => ({ error }));
    const result = await turn(coach);
    assert.deepEqual(result.names, ['error']);
    assert.equal(client.calls.length, 1, error.constructor.name);
    assert.equal(warnings.length, 0);
  }
});

// ---------------------------------------------------------------- live coach: fallback and refusal

test('a fallback block in the stream emits reset and the reply starts over', async () => {
  const partial = '{"say":"Let me tell you about';
  const finalText = replyJson('Nice and even. Try it once more.', { type: 'set_tempo', bpm: 66, mode: 'wait' }, 'Even at 60 bpm.');
  const events = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: usage() } },
    ...textBlockEvents(0, partial, 6),
    { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal' } } },
    { type: 'content_block_stop', index: 1 },
    ...textBlockEvents(2, finalText, 8),
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usage() },
    { type: 'message_stop' },
  ];
  const final = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: partial }, { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }, { type: 'text', text: finalText }],
    stop_reason: 'end_turn',
    usage: usage(),
  };
  const { coach, warnings } = liveCoach(() => ({ events, final }));
  const result = await turn(coach, { exercise: SCALE });

  assert.equal(result.error, undefined);
  const resetAt = result.names.indexOf('reset');
  assert.ok(resetAt > 0, 'some say text came before the reset');
  assert.equal(result.names.filter((name) => name === 'reset').length, 1);
  const before = result.events.slice(0, resetAt).map((item) => item.data.delta).join('');
  assert.equal(before, 'Let me tell you about');
  assert.equal(result.said, 'Nice and even. Try it once more.', 'only the text after the reset counts');
  // The reply is read from the text after the fallback block only: action and notes survive.
  assert.equal(result.action.type, 'set_tempo');
  assert.equal(result.action.exercise.bpm, 66);
  assert.deepEqual(result.notes, [{ text: 'Even at 60 bpm.' }]);
  assert.deepEqual(result.names.slice(-3), ['action', 'notes', 'done']);
  assert.deepEqual(JSON.parse(result.done.assistant), JSON.parse(finalText));
  assert.deepEqual(warnings, [], 'a clean reply after a fallback is not treated as malformed');
  assert.equal(result.done.model, 'claude-opus-5', 'the model that really answered is reported');
});

test('a fallback block before any output still works', async () => {
  const finalText = replyJson('Served by the fallback model.');
  const events = [
    { type: 'message_start', message: { model: 'claude-opus-5', content: [], usage: usage() } },
    { type: 'content_block_start', index: 0, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } } },
    { type: 'content_block_stop', index: 0 },
    ...textBlockEvents(1, finalText),
    { type: 'message_stop' },
  ];
  const final = { model: 'claude-opus-5', content: [{ type: 'fallback' }, { type: 'text', text: finalText }], stop_reason: 'end_turn', usage: usage() };
  const { coach } = liveCoach(() => ({ events, final }));
  const result = await turn(coach);
  assert.equal(result.said, 'Served by the fallback model.');
  assert.equal(result.names.at(-1), 'done');
});

test('a fallback model that continues the partial JSON still ends with the right text', async () => {
  // If the text after the fallback block is a continuation instead of a fresh start, only all
  // text blocks together parse. The learner must still end up with exactly the final "say".
  const whole = replyJson('First half and second half.', { type: 'none' });
  const cut = whole.indexOf(' and');
  const events = [
    ...textBlockEvents(0, whole.slice(0, cut), 5),
    { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } } },
    { type: 'content_block_stop', index: 1 },
    ...textBlockEvents(2, whole.slice(cut), 5),
  ];
  const final = { model: 'b', content: [{ type: 'text', text: whole.slice(0, cut) }, { type: 'fallback' }, { type: 'text', text: whole.slice(cut) }], stop_reason: 'end_turn', usage: usage() };
  const { coach } = liveCoach(() => ({ events, final }));
  const result = await turn(coach);
  assert.equal(result.error, undefined);
  assert.equal(result.said, 'First half and second half.');
  assert.equal(JSON.parse(result.done.assistant).say, 'First half and second half.');
});

test('refusal: stop_reason is checked before the content', async () => {
  // Refused before any output.
  const empty = liveCoach(() => ({ events: [{ type: 'message_start', message: {} }, { type: 'message_stop' }], final: { model: 'claude-opus-5-5', content: [], stop_reason: 'refusal', stop_details: null, usage: usage() } }));
  const first = await turn(empty.coach);
  assert.deepEqual(first.names, ['error']);
  assert.equal(first.error.code, 'refusal');
  assert.equal(first.error.retryable, false);
  assert.equal(typeof first.error.message, 'string');
  assert.equal(empty.client.calls.length, 1, 'a refusal is not retried by the coach');

  // Refused mid-reply: the partial text, even when it happens to be complete JSON, is not used.
  const partial = apiReply(replyJson('This looks complete but was refused.'), { stopReason: 'refusal' });
  const second = await turn(liveCoach(() => partial).coach);
  assert.equal(second.error.code, 'refusal');
  assert.equal(second.names.at(-1), 'error');
  assert.equal(second.names.includes('action'), false);
  assert.equal(second.names.includes('done'), false);
});

// ---------------------------------------------------------------- live coach: invalid replies

test('unparseable reply after some say was streamed: finish with action none', async () => {
  const truncated = '{"say":"Good try. Keep the thumb relaxed","action":{"type":"dri';
  const { coach } = liveCoach(() => apiReply(truncated, { stopReason: 'max_tokens' }));
  const result = await turn(coach, { exercise: SCALE });
  assert.equal(result.error, undefined);
  assert.equal(result.said, 'Good try. Keep the thumb relaxed');
  assert.deepEqual(result.action, { type: 'none' });
  assert.deepEqual(result.names.slice(-2), ['action', 'done']);
  assert.deepEqual(JSON.parse(result.done.assistant), { say: 'Good try. Keep the thumb relaxed', action: { type: 'none' }, student_notes: null });
});

test('unparseable reply with nothing streamed: invalid_reply', async () => {
  for (const text of ['I am sorry, I cannot produce JSON right now.', '', '{"action":{"type":"none"}', '[]']) {
    const { coach, client } = liveCoach(() => apiReply(text));
    const result = await turn(coach);
    assert.deepEqual(result.names, ['error'], JSON.stringify(text));
    assert.equal(result.error.code, 'invalid_reply');
    assert.equal(result.error.retryable, true);
    assert.equal(client.calls.length, 1);
  }
  // A message with no text block at all.
  const none = liveCoach(() => ({ events: [], final: { model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '', signature: 's' }], stop_reason: 'end_turn', usage: usage() } }));
  assert.equal((await turn(none.coach)).error.code, 'invalid_reply');
  const cut = liveCoach(() => apiReply('{"sa', { stopReason: 'max_tokens' }));
  assert.match((await turn(cut.coach)).error.message, /cut off/);
});

test('valid JSON with the wrong shape: say is kept, the action falls back to none', async () => {
  const cases = [
    JSON.stringify({ say: 'Shape is off.', action: { type: 'jump_around' }, student_notes: null }),
    JSON.stringify({ say: 'Shape is off.', action: { type: 'drill', from_step: 'two', to_step: 5 }, student_notes: null }),
    JSON.stringify({ say: 'Shape is off.', student_notes: null }),
    JSON.stringify({ say: 'Shape is off.', action: null, student_notes: 12 }),
  ];
  for (const text of cases) {
    const { coach, warnings } = liveCoach(() => apiReply(text));
    const result = await turn(coach, { exercise: SCALE });
    assert.equal(result.error, undefined, text);
    assert.equal(result.said, 'Shape is off.');
    assert.deepEqual(result.action, { type: 'none' });
    assert.deepEqual(result.notes, []);
    assert.deepEqual(JSON.parse(result.done.assistant), { say: 'Shape is off.', action: { type: 'none' }, student_notes: null });
    assert.equal(warnings.length, 1);
  }
  // say itself unusable and nothing streamed.
  for (const text of [JSON.stringify({ say: '', action: { type: 'none' }, student_notes: null }), JSON.stringify({ say: 5, action: { type: 'none' }, student_notes: null })]) {
    const result = await turn(liveCoach(() => apiReply(text)).coach);
    assert.equal(result.error.code, 'invalid_reply', text);
  }
});

test('the learner always ends up with exactly the final say', async () => {
  // Duplicate "say" keys: the stream shows the first, JSON.parse keeps the last.
  const duplicate = '{"say":"first version","say":"second version","action":{"type":"none"},"student_notes":null}';
  const result = await turn(liveCoach(() => apiReply(duplicate)).coach);
  assert.equal(result.said, 'second version');
  assert.equal(result.names.includes('reset'), true);
  assert.equal(JSON.parse(result.done.assistant).say, 'second version');
  // Text with every kind of escape survives the trip through the extractor in tiny chunks.
  const tricky = 'She said "slow down".\nLine two \u00e9 \ud83c\udfb9 \\ done';
  const escaped = await turn(liveCoach(() => apiReply(replyJson(tricky), { chunk: 1 })).coach);
  assert.equal(escaped.said, tricky);
  assert.equal(escaped.names.includes('reset'), false);
});

test('student_notes: sent only when it is a non-empty string', async () => {
  const withNotes = await turn(liveCoach(() => apiReply(replyJson('Hi.', { type: 'none' }, 'Comfortable at 72 bpm.'))).coach);
  assert.deepEqual(withNotes.notes, [{ text: 'Comfortable at 72 bpm.' }]);
  assert.deepEqual(withNotes.names.slice(-3), ['action', 'notes', 'done']);
  for (const notes of [null, '', '   ']) {
    const result = await turn(liveCoach(() => apiReply(replyJson('Hi.', { type: 'none' }, notes))).coach);
    assert.deepEqual(result.notes, [], JSON.stringify(notes));
    assert.deepEqual(result.names.slice(-2), ['action', 'done']);
  }
});

// ---------------------------------------------------------------- live coach: actions

test('new_exercise: the spec is built into a concrete exercise', async () => {
  const { coach, client } = liveCoach(() => apiReply(replyJson('Here is a G position warm-up.', { type: 'new_exercise', exercise: GOOD_SPEC })));
  const result = await turn(coach);
  assert.equal(result.error, undefined);
  assert.equal(result.actions.length, 1, 'exactly one action event');
  assert.equal(result.action.type, 'new_exercise');
  const exercise = result.action.exercise;
  assert.deepEqual(validateExercise(exercise), []);
  assert.equal(exercise.title, GOOD_SPEC.title);
  assert.equal(exercise.steps.length, 9);
  assert.deepEqual(exercise.steps[0].notes, [67], 'G4');
  assert.deepEqual(exercise, built(GOOD_SPEC));
  // The transcript gets the spec, not the concrete exercise.
  assert.deepEqual(JSON.parse(result.done.assistant).action, { type: 'new_exercise', exercise: GOOD_SPEC });
  assert.equal(client.calls.length, 1);
});

test('a rejected exercise triggers exactly one corrective request, and only its action is used', async () => {
  const firstText = replyJson('Try this new pattern.', { type: 'new_exercise', exercise: BAD_SPEC }, 'Likes patterns.');
  const secondText = replyJson('IGNORED SAY', { type: 'new_exercise', exercise: GOOD_SPEC }, 'IGNORED NOTES');
  const { coach, client } = liveCoach([() => apiReply(firstText, { use: usage({ input_tokens: 100, output_tokens: 30, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 }) }), () => apiReply(secondText, { use: usage({ input_tokens: 20, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 2100 }) })]);
  const messages = [USER_START, { role: 'assistant', content: replyJson('Welcome.') }, { role: 'user', content: '[event: next]\nreason: wants something new' }];
  const result = await turn(coach, { messages });

  assert.equal(result.error, undefined);
  assert.equal(client.calls.length, 2);
  assert.equal(result.said, 'Try this new pattern.', 'say stays as it was');
  assert.equal(result.names.includes('reset'), false);
  assert.equal(result.actions.length, 1);
  assert.equal(result.action.type, 'new_exercise');
  assert.deepEqual(result.action.exercise, built(GOOD_SPEC));
  assert.deepEqual(result.notes, [{ text: 'Likes patterns.' }], 'notes come from the first reply');
  assert.deepEqual(JSON.parse(result.done.assistant), { say: 'Try this new pattern.', action: { type: 'new_exercise', exercise: GOOD_SPEC }, student_notes: 'Likes patterns.' });
  assert.deepEqual(result.done.usage, { input_tokens: 120, output_tokens: 80, cache_creation_input_tokens: 2000, cache_read_input_tokens: 2100 }, 'both requests are counted');

  // The corrective request: same parameters, the transcript plus the reply plus the rejection.
  const [first, second] = client.calls;
  assert.equal(second.endpoint, first.endpoint);
  const { messages: firstMessages, ...firstRest } = first.params;
  const { messages: secondMessages, ...secondRest } = second.params;
  assert.deepEqual(secondRest, firstRest);
  assert.equal(secondMessages.length, firstMessages.length + 2);
  assert.deepEqual(secondMessages.slice(0, firstMessages.length), firstMessages, 'the cached prefix is unchanged');
  const [assistantTurn, rejection] = secondMessages.slice(-2);
  assert.equal(assistantTurn.role, 'assistant');
  assert.deepEqual(JSON.parse(assistantTurn.content), JSON.parse(firstText));
  assert.equal(rejection.role, 'user');
  assert.equal(typeof rejection.content, 'string');
  assert.ok(rejection.content.startsWith('[event: exercise_rejected]'));
  const buildErrors = buildExercise(BAD_SPEC).errors;
  assert.ok(buildErrors.length >= 1);
  for (const error of buildErrors) assert.ok(rejection.content.includes(error), `the rejection lists: ${error}`);
  assert.ok(second.options.signal instanceof AbortSignal);
});

test('a second rejected exercise falls back to action none, with no third request', async () => {
  const bad = replyJson('Try this new pattern.', { type: 'new_exercise', exercise: BAD_SPEC });
  const { coach, client } = liveCoach(() => apiReply(bad));
  const result = await turn(coach, { exercise: SCALE });
  assert.equal(result.error, undefined);
  assert.equal(client.calls.length, 2);
  // dropped tells the browser that the change announced in "say" did not happen.
  assert.deepEqual(result.action, { type: 'none', dropped: true });
  assert.equal(result.said, 'Try this new pattern.');
  assert.deepEqual(JSON.parse(result.done.assistant).action, { type: 'none' }, 'the transcript records what really happened');
});

test('the corrective request may answer with another action type, or fail', async () => {
  const bad = replyJson('Try this.', { type: 'new_exercise', exercise: BAD_SPEC });
  // A drill of the current exercise instead.
  const drill = liveCoach([() => apiReply(bad), () => apiReply(replyJson('x', { type: 'drill', from_step: 2, to_step: 4 }))]);
  const drilled = await turn(drill.coach, { exercise: SCALE });
  assert.equal(drilled.action.type, 'drill');
  assert.equal(drilled.action.exercise.steps.length, 3);
  // Explicit none.
  const none = liveCoach([() => apiReply(bad), () => apiReply(replyJson('x', { type: 'none' }))]);
  assert.deepEqual((await turn(none.coach)).action, { type: 'none' });
  // The follow-up request fails: the turn still completes, with action none.
  for (const failure of [{ error: apiError(529, 'overloaded_error') }, { quietError: apiError(500, 'api_error') }, apiReply('not json at all'), apiReply(replyJson('x', { type: 'none' }), { stopReason: 'refusal' })]) {
    const failing = liveCoach([() => apiReply(bad), () => failure]);
    const result = await turn(failing.coach);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.action, { type: 'none', dropped: true });
    assert.equal(result.names.at(-1), 'done');
    assert.equal(failing.client.calls.length, 2);
  }
});

test('drill: 1-based inclusive steps of the current exercise', async () => {
  const text = replyJson('Loop steps 3 to 6.', { type: 'drill', from_step: 3, to_step: 6 });
  const result = await turn(liveCoach(() => apiReply(text)).coach, { exercise: SCALE });
  assert.equal(result.action.type, 'drill');
  assert.equal(result.action.from_step, 3);
  assert.equal(result.action.to_step, 6);
  assert.deepEqual(result.action.exercise.steps.map((step) => step.notes), SCALE.steps.slice(2, 6).map((step) => step.notes));
  assert.deepEqual(validateExercise(result.action.exercise), []);
  assert.deepEqual(JSON.parse(result.done.assistant).action, { type: 'drill', from_step: 3, to_step: 6 });
});

test('drill without a current exercise or with a bad range: one corrective request, then the learner is told', async () => {
  const attempt = async (action, exercise) => {
    const { coach, client } = liveCoach(() => apiReply(replyJson('Loop it.', action)));
    const result = await turn(coach, { exercise });
    // The model is told what was wrong once; here it repeats the mistake.
    assert.equal(client.calls.length, 2);
    const rejection = client.calls[1].params.messages.at(-1).content;
    assert.ok(rejection.startsWith('[event: exercise_rejected]'));
    assert.match(rejection, /drill/);
    assert.equal(result.error, undefined);
    assert.equal(result.said, 'Loop it.');
    assert.deepEqual(JSON.parse(result.done.assistant).action, { type: 'none' });
    return result.action;
  };
  assert.deepEqual(await attempt({ type: 'drill', from_step: 3, to_step: 6 }, null), { type: 'none', dropped: true });
  assert.deepEqual(await attempt({ type: 'drill', from_step: 0, to_step: 6 }, SCALE), { type: 'none', dropped: true });
  assert.deepEqual(await attempt({ type: 'drill', from_step: 10, to_step: 99 }, SCALE), { type: 'none', dropped: true });
  assert.deepEqual(await attempt({ type: 'drill', from_step: 6, to_step: 3 }, SCALE), { type: 'none', dropped: true });

  // A corrected range on the second go is used.
  const fixed = liveCoach([
    () => apiReply(replyJson('Loop it.', { type: 'drill', from_step: 10, to_step: 99 })),
    () => apiReply(replyJson('Loop it.', { type: 'drill', from_step: 10, to_step: 12 })),
  ]);
  const result = await turn(fixed.coach, { exercise: SCALE });
  assert.equal(result.action.type, 'drill');
  assert.equal(result.action.exercise.steps.length, 3);
});

test('a reply stream that goes silent is given up as a network error', async () => {
  let aborted = false;
  const client = {
    beta: {
      messages: {
        stream(params, options) {
          options.signal.addEventListener('abort', () => {
            aborted = true;
          });
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'message_start', message: {} };
              // Then nothing: wait until the watchdog aborts the request.
              await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
            },
            finalMessage: async () => {
              throw new Error('never finished');
            },
          };
        },
      },
    },
    messages: { stream() { throw new Error('unused'); } },
  };
  const coach = createCoach({ client, idleMs: 40 });
  const events = [];
  for await (const event of coach({ messages: [USER_START] })) events.push(event);
  assert.equal(aborted, true, 'the upstream request is cancelled');
  assert.deepEqual(events.map((event) => event.event), ['error']);
  assert.equal(events[0].data.code, 'network');
  assert.equal(events[0].data.retryable, true);
});

test('set_tempo with and without a current exercise', async () => {
  const text = replyJson('A little faster now.', { type: 'set_tempo', bpm: 68, mode: 'tempo' });
  const withExercise = await turn(liveCoach(() => apiReply(text)).coach, { exercise: SCALE });
  assert.equal(withExercise.action.type, 'set_tempo');
  assert.equal(withExercise.action.bpm, 68);
  assert.equal(withExercise.action.mode, 'tempo');
  assert.equal(withExercise.action.exercise.bpm, 68);
  assert.equal(withExercise.action.exercise.mode, 'tempo');
  assert.equal(withExercise.action.exercise.id, SCALE.id);
  assert.deepEqual(withExercise.action.exercise.steps, SCALE.steps);
  assert.deepEqual(JSON.parse(withExercise.done.assistant).action, { type: 'set_tempo', bpm: 68, mode: 'tempo' });

  const without = await turn(liveCoach(() => apiReply(text)).coach, { exercise: null });
  assert.deepEqual(without.action, { type: 'none', dropped: true });
  assert.equal(without.names.at(-1), 'done');
});

test('back_to_full is passed through with no exercise attached', async () => {
  const text = replyJson('Back to the whole scale.', { type: 'back_to_full' });
  for (const exercise of [SCALE, null]) {
    const { coach, client } = liveCoach(() => apiReply(text));
    const result = await turn(coach, { exercise });
    assert.deepEqual(result.action, { type: 'back_to_full' });
    assert.deepEqual(result.actions, [{ action: { type: 'back_to_full' } }]);
    assert.deepEqual(JSON.parse(result.done.assistant).action, { type: 'back_to_full' });
    assert.equal(client.calls.length, 1);
  }
});

// ---------------------------------------------------------------- live coach: errors

test('mapError: each SDK error class maps to the right code', () => {
  const cases = [
    [apiError(401, 'authentication_error'), 'auth', false],
    [apiError(403, 'permission_error'), 'auth', false],
    [apiError(402, 'billing_error'), 'auth', false],
    [apiError(429, 'rate_limit_error'), 'rate_limit', true],
    [apiError(400, 'invalid_request_error'), 'bad_request', false],
    [apiError(404, 'not_found_error'), 'bad_request', false],
    [apiError(413, 'request_too_large'), 'bad_request', false],
    [apiError(422, 'invalid_request_error'), 'bad_request', false],
    [apiError(418, 'teapot'), 'bad_request', false],
    [new Anthropic.APIConnectionError({ message: 'Connection error.' }), 'network', true],
    [new Anthropic.APIConnectionTimeoutError(), 'network', true],
    [apiError(408, 'timeout_error'), 'network', true],
    [new Anthropic.APIUserAbortError(), 'network', true],
    [apiError(529, 'overloaded_error'), 'overloaded', true],
    [apiError(500, 'api_error'), 'server', true],
    [apiError(502, 'api_error'), 'server', true],
    [apiError(503, 'api_error'), 'server', true],
    [apiError(504, 'api_error'), 'server', true],
    // Mid-stream failures: a plain APIError with no status, only the error type.
    [new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers()), 'overloaded', true],
    [new Anthropic.APIError(undefined, { type: 'error', error: { type: 'api_error', message: 'Internal' } }, undefined, new Headers()), 'server', true],
    [new Anthropic.APIError(undefined, { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } }, undefined, new Headers()), 'rate_limit', true],
    [new Anthropic.APIError(undefined, { type: 'error', error: { type: 'authentication_error', message: 'No' } }, undefined, new Headers()), 'auth', false],
    [new Anthropic.APIError(undefined, { type: 'error', error: { type: 'invalid_request_error', message: 'No' } }, undefined, new Headers()), 'bad_request', false],
    [new Anthropic.AnthropicError('stream ended without producing a Message'), 'server', true],
    [new Error('something else'), 'server', true],
    [new TypeError('x is not a function'), 'server', true],
    ['just a string', 'server', true],
    [null, 'server', true],
    [undefined, 'server', true],
  ];
  for (const [error, code, retryable] of cases) {
    const mapped = mapError(error);
    const label = `${error?.constructor?.name} ${error?.status ?? ''} ${error?.type ?? ''}`;
    assert.equal(mapped.code, code, label);
    assert.equal(mapped.retryable, retryable, label);
    assert.ok(typeof mapped.message === 'string' && mapped.message.length > 10, label);
    assert.equal(mapped.message.includes('\u2014'), false);
  }
  assert.match(mapError(apiError(401, 'authentication_error')).message, /ANTHROPIC_API_KEY/);
  assert.match(mapError(apiError(403, 'permission_error')).message, /ANTHROPIC_API_KEY/);
  assert.match(mapError(apiError(404, 'not_found_error')).message, /COACH_MODEL/);
  assert.match(mapError(badRequest('max_tokens: too large')).message, /max_tokens: too large/);
  // A spend cap is a 429 that retrying will not fix.
  const capped = Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'cap', details: { error_code: 'enforced_spend_limit_reached' } } }, undefined, new Headers());
  assert.deepEqual([mapError(capped).code, mapError(capped).retryable], ['rate_limit', false]);
});

test('errors reach the browser as one error event, whenever they happen', async () => {
  const cases = [
    [{ error: apiError(401, 'authentication_error') }, 'auth'],
    [{ error: apiError(403, 'permission_error') }, 'auth'],
    [{ error: apiError(429, 'rate_limit_error') }, 'rate_limit'],
    [{ error: new Anthropic.APIConnectionError({ message: 'Connection error.' }) }, 'network'],
    [{ error: new Anthropic.APIConnectionTimeoutError() }, 'network'],
    [{ error: apiError(529, 'overloaded_error') }, 'overloaded'],
    [{ error: apiError(500, 'api_error') }, 'server'],
    [{ error: apiError(503, 'api_error') }, 'server'],
    [{ error: new Error('boom') }, 'server'],
  ];
  for (const [failure, code] of cases) {
    const result = await turn(liveCoach(() => failure).coach);
    assert.deepEqual(result.names, ['error'], code);
    assert.equal(result.error.code, code);
    assert.equal(typeof result.error.retryable, 'boolean');
  }
  // After part of the reply was streamed.
  const partial = apiReply(replyJson('This reply will break off in the middle.'));
  const late = await turn(liveCoach(() => ({ events: partial.events.slice(0, 8), lateError: new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, new Headers()) })).coach);
  assert.equal(late.names.at(-1), 'error');
  assert.equal(late.error.code, 'overloaded');
  assert.equal(late.names.filter((name) => name === 'error').length, 1);
  assert.equal(late.names.includes('done'), false);
  // The SDK's iterator can end without throwing: the error then comes from finalMessage().
  const quiet = await turn(liveCoach(() => ({ events: partial.events.slice(0, 8), quietError: new Anthropic.APIConnectionError({ message: 'socket hang up' }) })).coach);
  assert.equal(quiet.names.at(-1), 'error');
  assert.equal(quiet.error.code, 'network');
  // A stream that breaks off surfaces in the SDK as a bare AnthropicError: still a network fault.
  for (const failure of [{ lateError: new Anthropic.AnthropicError('terminated') }, { quietError: new Anthropic.AnthropicError('stream ended without producing a Message with role=assistant') }, { lateError: new TypeError('terminated') }]) {
    const broken = await turn(liveCoach(() => ({ events: partial.events.slice(0, 8), ...failure })).coach);
    assert.equal(broken.names.at(-1), 'error');
    assert.equal(broken.error.code, 'network');
    assert.equal(broken.error.retryable, true);
  }
});

test('no credentials at all: a clear auth error instead of a generic one', async () => {
  const failure = () => ({ error: new Anthropic.AnthropicError('Could not resolve authentication method.') });
  // A real client exposes apiKey and authToken; both null means nothing to sign in with.
  const keyless = fakeClient(failure);
  keyless.apiKey = null;
  keyless.authToken = null;
  const result = await turn(createCoach({ client: keyless, warn: () => {} }));
  assert.deepEqual(result.names, ['error']);
  assert.equal(result.error.code, 'auth');
  assert.equal(result.error.retryable, false);
  assert.match(result.error.message, /ANTHROPIC_API_KEY/);
  assert.equal(keyless.calls.length, 1);
  // With a key on the client the same SDK error is not blamed on the key.
  const keyed = fakeClient(failure);
  keyed.apiKey = 'test-key-not-real';
  assert.equal((await turn(createCoach({ client: keyed, warn: () => {} }))).error.code, 'server');
  // The real SDK client, constructed without credentials (nothing is sent anywhere).
  const real = new Anthropic({ apiKey: null, authToken: null, baseURL: 'http://127.0.0.1:9', maxRetries: 0, timeout: 2000 });
  if (real.apiKey === null && real.authToken === null) {
    const live = await turn(createCoach({ client: real, warn: () => {} }));
    assert.deepEqual(live.names, ['error']);
    assert.ok(['auth', 'network'].includes(live.error.code), live.error.code);
  }
});

test('an aborted request ends quietly, with no error event', async () => {
  const reply = apiReply(replyJson('This reply is cut short by the learner leaving.'));
  // Aborted between two pieces of the reply.
  const between = liveCoach(() => ({ events: reply.events, final: reply.final }));
  const first = new AbortController();
  const seen = [];
  for await (const item of between.coach({ messages: [USER_START], exercise: null, signal: first.signal })) {
    seen.push(item);
    if (seen.length === 2) first.abort();
  }
  assert.equal(seen.length, 2);
  assert.ok(seen.every((item) => item.event === 'say'), 'only say events, then silence');
  assert.equal(between.client.calls.length, 1);

  // Aborted while waiting for the API to send more.
  const waiting = liveCoach(() => ({ events: reply.events.slice(0, 7), hang: true }));
  const second = new AbortController();
  setTimeout(() => second.abort(), 30);
  const events = await collect(waiting.coach({ messages: [USER_START], exercise: null, signal: second.signal }));
  assert.deepEqual(events.map((item) => item.event), ['say']);
  assert.equal(waiting.client.calls[0].sawAbort, true);

  // Aborted before the request even started.
  const early = liveCoach(() => ({ events: reply.events, final: reply.final }));
  assert.deepEqual(await collect(early.coach({ messages: [USER_START], exercise: null, signal: AbortSignal.abort() })), []);
});

// ---------------------------------------------------------------- HTTP: the coach endpoint

test('POST /api/coach streams the live coach reply as server-sent events', async (t) => {
  const say = 'Welcome, Sam. Start slowly.';
  const { coach, client } = liveCoach(() => apiReply(replyJson(say, { type: 'new_exercise', exercise: GOOD_SPEC }, 'Sam is a beginner.')));
  const { base } = await listen(t, { coach });
  const { response, status, events } = await postCoach(base, { messages: [USER_START], exercise: null });

  assert.equal(status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  for (const name of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods', 'access-control-allow-credentials']) {
    assert.equal(response.headers.get(name), null, 'no CORS headers at all');
  }
  const names = events.map((item) => item.event);
  assert.deepEqual(names.filter((name) => name !== 'say'), ['action', 'notes', 'done']);
  assert.equal(events.filter((item) => item.event === 'say').map((item) => item.data.delta).join(''), say);
  const action = events.find((item) => item.event === 'action').data.action;
  assert.equal(action.type, 'new_exercise');
  assert.deepEqual(validateExercise(action.exercise), []);
  assert.deepEqual(events.find((item) => item.event === 'notes').data, { text: 'Sam is a beginner.' });
  const done = events.at(-1).data;
  assert.deepEqual(Object.keys(done).sort(), ['assistant', 'mock', 'model', 'ms', 'usage']);
  assert.deepEqual(JSON.parse(done.assistant), { say, action: { type: 'new_exercise', exercise: GOOD_SPEC }, student_notes: 'Sam is a beginner.' });
  assert.equal(done.mock, false);
  assert.deepEqual(client.calls[0].params.messages, [{ role: 'user', content: [{ type: 'text', text: USER_START.content, cache_control: { type: 'ephemeral' } }] }]);
  assert.ok(client.calls[0].options.signal instanceof AbortSignal);
});

test('POST /api/coach passes the validated transcript and exercise to the coach', async (t) => {
  const coach = cannedCoach();
  const { base } = await listen(t, { coach });
  const messages = [USER_START, { role: 'assistant', content: replyJson('Welcome.'), extra: 'dropped' }, { role: 'user', content: '[event: chat]\n"hello"' }];
  const { status, events } = await postCoach(base, { messages, exercise: SCALE, ignored: true });
  assert.equal(status, 200);
  assert.deepEqual(events.map((item) => item.event), ['say', 'action', 'done']);
  assert.equal(coach.requests.length, 1);
  assert.deepEqual(coach.requests[0].messages, messages.map(({ role, content }) => ({ role, content })));
  assert.deepEqual(coach.requests[0].exercise, SCALE);
  assert.ok(coach.requests[0].signal instanceof AbortSignal);
  // exercise may be left out.
  await postCoach(base, { messages: [USER_START] });
  assert.equal(coach.requests[1].exercise, null);
  // A charset on the content type is fine.
  assert.equal((await postCoach(base, { messages: [USER_START] }, { 'Content-Type': 'application/json; charset=utf-8' })).status, 200);
});

test('a coach error event is delivered and ends the response', async (t) => {
  const { coach } = liveCoach(() => ({ error: apiError(401, 'authentication_error') }));
  const { base } = await listen(t, { coach });
  const { status, events } = await postCoach(base, { messages: [USER_START], exercise: null });
  assert.equal(status, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'error');
  assert.equal(events[0].data.code, 'auth');
  assert.equal(events[0].data.retryable, false);
});

test('a coach that throws or stops early still ends with exactly one error event', async (t) => {
  const throwing = async function* broken() {
    yield { event: 'say', data: { delta: 'Hel' } };
    throw new Error('kaboom');
  };
  const logged = [];
  const first = await listen(t, { coach: throwing, log: (line) => logged.push(line) });
  const thrown = await postCoach(first.base, { messages: [USER_START] });
  assert.deepEqual(thrown.events.map((item) => item.event), ['say', 'error']);
  assert.equal(thrown.events[1].data.code, 'server');
  assert.equal(thrown.events[1].data.retryable, true);
  assert.equal(thrown.events[1].data.message.includes('kaboom'), false, 'internal details stay in the server log');
  assert.ok(logged.some((line) => line.includes('kaboom')));

  const silent = async function* quiet() {
    yield { event: 'say', data: { delta: 'Hel' } };
  };
  const second = await listen(t, { coach: silent });
  const cut = await postCoach(second.base, { messages: [USER_START] });
  assert.deepEqual(cut.events.map((item) => item.event), ['say', 'error']);

  // Anything after the terminal event is dropped.
  const chatty = cannedCoach([{ event: 'done', data: { assistant: '{}' } }, { event: 'say', data: { delta: 'late' } }, { event: 'error', data: { code: 'server' } }]);
  const third = await listen(t, { coach: chatty });
  assert.deepEqual((await postCoach(third.base, { messages: [USER_START] })).events.map((item) => item.event), ['done']);
});

test('when the browser disconnects, the upstream request is aborted', async (t) => {
  const reply = apiReply(replyJson('This reply will never be finished because the page closes.'));
  const { coach, client } = liveCoach(() => ({ events: reply.events.slice(0, 7), hang: true }));
  const { port } = await listen(t, { coach });
  const body = JSON.stringify({ messages: [USER_START], exercise: null });

  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/coach', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      res.once('data', () => {
        req.destroy(); // the learner closes the tab mid-reply
        resolve();
      });
      res.on('error', () => {});
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve() : reject(err)));
    req.end(body);
  });

  const deadline = Date.now() + 3000;
  while (!client.calls[0]?.sawAbort && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].options.signal.aborted, true);
  assert.equal(client.calls[0].sawAbort, true);
});

test('a slow reply gets keep-alive pings', async (t) => {
  const slow = async function* slowCoach() {
    await new Promise((resolve) => setTimeout(resolve, 120));
    yield { event: 'done', data: { assistant: '{}' } };
  };
  const { base } = await listen(t, { coach: slow, pingMs: 20 });
  const { text, events } = await postCoach(base, { messages: [USER_START] });
  assert.ok((text.match(/^: ping$/gm) ?? []).length >= 2, 'comment lines keep the connection alive');
  assert.deepEqual(events.map((item) => item.event), ['done'], 'pings are comments, not events');
});

test('request validation: bad bodies get 400 with a JSON error', async (t) => {
  const coach = cannedCoach();
  const { base } = await listen(t, { coach });
  const user = (content = 'hi') => ({ role: 'user', content });
  const assistant = (content = '{}') => ({ role: 'assistant', content });
  const bad = [
    'not json',
    '{"messages": [',
    '[]',
    'null',
    '"text"',
    {},
    { messages: 'hello' },
    { messages: [] },
    { messages: [null] },
    { messages: ['hi'] },
    { messages: [{ role: 'system', content: 'x' }] },
    { messages: [{ role: 'user' }] },
    { messages: [{ role: 'user', content: 5 }] },
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
    { messages: [user('')] },
    { messages: [user('   ')] },
    { messages: [assistant()] },
    { messages: [user(), assistant()] },
    { messages: [user(), user()] },
    { messages: [user(), assistant(), assistant(), user()] },
    { messages: [assistant(), user()] },
    { messages: Array.from({ length: MAX_MESSAGES + 1 }, (_, i) => (i % 2 === 0 ? user() : assistant())) },
    { messages: [user('x'.repeat(250000)), assistant('y'.repeat(100000)), user('z'.repeat(50001))] },
    { messages: [user()], exercise: 'C major' },
    { messages: [user()], exercise: [] },
    { messages: [user()], exercise: 7 },
    { messages: [user()], exercise: {} },
    { messages: [user()], exercise: { ...SCALE, steps: [] } },
    { messages: [user()], exercise: { ...SCALE, bpm: 'fast' } },
  ];
  for (const body of bad) {
    const { status, json } = await postCoach(base, body);
    const label = typeof body === 'string' ? body : JSON.stringify(body).slice(0, 90);
    assert.equal(status, 400, label);
    assert.equal(typeof json?.error, 'string', label);
    assert.ok(json.error.length > 5, label);
  }
  assert.equal(coach.requests.length, 0, 'the coach is never called for an invalid request');

  // The limits themselves are accepted.
  const most = Array.from({ length: MAX_MESSAGES - 1 }, (_, i) => (i % 2 === 0 ? user() : assistant()));
  assert.equal((await postCoach(base, { messages: most })).status, 200);
  assert.equal(MAX_MESSAGES, 200);
  assert.equal(MAX_CONTENT_CHARS, 400000);
  const long = [user('x'.repeat(200000)), assistant('y'.repeat(100000)), user('z'.repeat(100000))];
  assert.equal((await postCoach(base, { messages: long })).status, 200, 'exactly 400000 characters');
});

test('validateCoachBody returns clean messages and the exercise', () => {
  const result = validateCoachBody({ messages: [{ role: 'user', content: 'hi', junk: 1 }], exercise: SCALE });
  assert.deepEqual(result, { ok: true, messages: [{ role: 'user', content: 'hi' }], exercise: SCALE });
  assert.deepEqual(validateCoachBody({ messages: [{ role: 'user', content: 'hi' }] }), { ok: true, messages: [{ role: 'user', content: 'hi' }], exercise: null });
  assert.equal(validateCoachBody({ messages: [{ role: 'user', content: 'hi' }], exercise: null }).ok, true);
  for (const body of [null, undefined, 5, 'x', [], { messages: {} }]) assert.equal(validateCoachBody(body).ok, false);
});

test('POST /api/coach requires JSON content type', async (t) => {
  const coach = cannedCoach();
  const { base, port } = await listen(t, { coach });
  const body = JSON.stringify({ messages: [USER_START] });
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', 'text/json']) {
    const { status, json } = await postCoach(base, body, { 'Content-Type': type });
    assert.equal(status, 415, type);
    assert.equal(typeof json.error, 'string');
  }
  const missing = await raw(port, { method: 'POST', path: '/api/coach', headers: { Host: `127.0.0.1:${port}`, 'Content-Length': Buffer.byteLength(body) }, body });
  assert.equal(missing.status, 415);
  assert.equal(coach.requests.length, 0);
});

test('Origin check: a page from another origin is refused with 403', async (t) => {
  const coach = cannedCoach();
  const { port } = await listen(t, { coach });
  const body = JSON.stringify({ messages: [USER_START] });
  const post = (headers) => raw(port, { method: 'POST', path: '/api/coach', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }, body });

  for (const origin of ['https://evil.example', 'http://evil.example:5173', `http://localhost:${port + 1}`, `http://localhost:${port}`, 'null', 'not a url', '']) {
    // Host is 127.0.0.1:port here, so even http://localhost:port is a different origin.
    const response = await post({ Host: `127.0.0.1:${port}`, Origin: origin });
    assert.equal(response.status, 403, origin);
    assert.equal(typeof JSON.parse(response.body).error, 'string');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal(coach.requests.length, 0);

  // Same origin, in either spelling of this machine, is fine. So is no Origin header at all.
  assert.equal((await post({ Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` })).status, 200);
  assert.equal((await post({ Host: `localhost:${port}`, Origin: `http://localhost:${port}` })).status, 200);
  assert.equal((await post({ Host: `LOCALHOST:${port}`, Origin: `http://LocalHost:${port}` })).status, 200);
  assert.equal((await post({ Host: `[::1]:${port}`, Origin: `http://[::1]:${port}` })).status, 200);
  assert.equal((await post({ Host: `127.0.0.1:${port}` })).status, 200);
  assert.equal(coach.requests.length, 5);
});

test('Host check: only localhost names and ALLOWED_HOSTS are answered (DNS rebinding guard)', async (t) => {
  const coach = cannedCoach();
  const { port } = await listen(t, { coach, allowedHosts: 'Piano.local, practice.lan' });
  const get = (host, requestPath = '/api/health') => raw(port, { path: requestPath, headers: host === undefined ? {} : { Host: host } });

  for (const host of ['evil.example', `evil.example:${port}`, 'attacker.com:80', '192.168.1.10:5173', '10.0.0.1', '0.0.0.0', 'localhost.evil.example', '127.0.0.1.evil.example', 'notlocalhost', 'localhost:abc', 'local host', 'localhost@evil.example', 'evil.example/localhost']) {
    const response = await get(host);
    assert.equal(response.status, 403, JSON.stringify(host));
    assert.equal(response.body.includes('"ok"'), false);
  }
  for (const host of ['localhost', `localhost:${port}`, '127.0.0.1', `127.0.0.1:${port}`, '[::1]', `[::1]:${port}`, 'LOCALHOST:1234', 'piano.local', 'PIANO.LOCAL:8080', `practice.lan:${port}`]) {
    assert.equal((await get(host)).status, 200, host);
  }
  // Static files and the coach endpoint are behind the same check.
  assert.equal((await get('evil.example', '/')).status, 403);
  assert.equal((await get('evil.example', '/shared/midi.js')).status, 403);
  const body = JSON.stringify({ messages: [USER_START] });
  const post = await raw(port, { method: 'POST', path: '/api/coach', headers: { Host: 'evil.example', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body });
  assert.equal(post.status, 403);
  assert.equal(coach.requests.length, 0);

  // Without ALLOWED_HOSTS the extra names are refused too.
  const plain = await listen(t, { coach: cannedCoach() });
  assert.equal((await raw(plain.port, { path: '/api/health', headers: { Host: 'piano.local' } })).status, 403);

  // An empty or missing Host header (hand-written requests) is refused as well.
  const bare = (request) =>
    new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
      let text = '';
      socket.on('data', (chunk) => (text += chunk));
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });
  assert.match(await bare('GET /api/health HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 403 /);
  assert.match(await bare('GET /api/health HTTP/1.0\r\n\r\n'), /^HTTP\/1\.1 403 /);
  assert.match(await bare('GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 200 /);
});

test('hostnameOf and parseAllowedHosts', () => {
  assert.equal(hostnameOf('localhost:5173'), 'localhost');
  assert.equal(hostnameOf('LocalHost'), 'localhost');
  assert.equal(hostnameOf('[::1]:5173'), '[::1]');
  assert.equal(hostnameOf('127.0.0.1:80'), '127.0.0.1');
  for (const bad of [undefined, null, '', 'a b', 'host:port', 'host:123456', 'a/b', 'user@host', '::1', 'host:80:80', ['localhost']]) assert.equal(hostnameOf(bad), null, String(bad));
  assert.deepEqual(parseAllowedHosts(' A.local, b.lan ,, '), ['a.local', 'b.lan']);
  assert.deepEqual(parseAllowedHosts(undefined), []);
  assert.deepEqual(parseAllowedHosts(['X.y']), ['x.y']);
});

test('body limit: more than 512 KB is refused with 413', async (t) => {
  assert.equal(BODY_LIMIT_BYTES, 512 * 1024);
  const coach = cannedCoach();
  const { base, port } = await listen(t, { coach });
  // Valid JSON that is simply too big.
  const big = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(600 * 1024) }] });
  const { status, json } = await postCoach(base, big);
  assert.equal(status, 413);
  assert.equal(typeof json.error, 'string');
  // Chunked upload without a Content-Length.
  const chunked = await raw(port, { method: 'POST', path: '/api/coach', headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }, body: big });
  assert.equal(chunked.status, 413);
  assert.equal(coach.requests.length, 0);
  // The server is still fine afterwards, and a body just under the limit is read (and then fails validation on length, not size).
  const under = JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(500 * 1024) }] });
  assert.equal((await postCoach(base, under)).status, 400);
  assert.equal((await postCoach(base, { messages: [USER_START] })).status, 200);
});

test('rate limit: over COACH_MAX_PER_MIN the reply is a too_many_requests error event', async (t) => {
  let clock = 1_000_000;
  const coach = cannedCoach();
  const { base } = await listen(t, { coach, maxPerMinute: 3, now: () => clock });
  const body = { messages: [USER_START] };
  for (let i = 0; i < 3; i += 1) {
    clock += 1000;
    assert.equal((await postCoach(base, body)).events.at(-1).event, 'done');
  }
  const limited = await postCoach(base, body);
  assert.equal(limited.status, 200, 'the error travels as an SSE event');
  assert.equal(limited.response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.deepEqual(limited.events.map((item) => item.event), ['error']);
  assert.equal(limited.events[0].data.code, 'too_many_requests');
  assert.equal(limited.events[0].data.retryable, true);
  assert.equal(typeof limited.events[0].data.message, 'string');
  assert.equal(coach.requests.length, 3, 'the coach is not called over the limit');
  // Invalid requests do not use up the budget, and refused ones do not extend the wait.
  assert.equal((await postCoach(base, { messages: [] })).status, 400);
  // The window slides: one minute after the first request there is room again.
  clock += 58_500;
  assert.equal((await postCoach(base, body)).events.at(-1).event, 'done');
  assert.equal((await postCoach(base, body)).events[0].data.code, 'too_many_requests');
  assert.equal(coach.requests.length, 4);
});

test('createRateLimiter is a sliding window', () => {
  let clock = 0;
  const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => clock });
  assert.equal(limiter.take(), true);
  clock = 400;
  assert.equal(limiter.take(), true);
  clock = 900;
  assert.equal(limiter.take(), false);
  clock = 1000;
  assert.equal(limiter.take(), true, 'the first hit has left the window');
  assert.equal(limiter.take(), false);
  clock = 1400;
  assert.equal(limiter.take(), true);
});

test('methods: only POST on /api/coach, only GET and HEAD elsewhere', async (t) => {
  const coach = cannedCoach();
  const { port } = await listen(t, { coach });
  const call = (method, requestPath) => raw(port, { method, path: requestPath, headers: { Host: `127.0.0.1:${port}` } });
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const response = await call(method, '/api/coach');
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, 'POST');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const requestPath of ['/', '/api/health', '/app.js', '/shared/midi.js', '/nope']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const response = await call(method, requestPath);
      assert.equal(response.status, 405, `${method} ${requestPath}`);
      assert.equal(response.headers.allow, 'GET, HEAD');
    }
  }
  assert.equal((await call('GET', '/api/nope')).status, 404);
  assert.equal((await call('GET', '/api')).status, 404);
  assert.equal(coach.requests.length, 0);
});

test('GET /api/health reports the mode, model and effort', async (t) => {
  const live = await listen(t, { coach: liveCoach(() => apiReply(replyJson('x')), { model: 'claude-haiku-5-5', effort: 'high' }).coach });
  const liveResponse = await fetch(`${live.base}/api/health`);
  assert.equal(liveResponse.status, 200);
  assert.match(liveResponse.headers.get('content-type'), /^application\/json/);
  assert.equal(liveResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await liveResponse.json(), { ok: true, mode: 'live', model: 'claude-haiku-5-5', effort: 'high' });

  const mock = await listen(t, { coach: createMockCoach() });
  assert.deepEqual(await (await fetch(`${mock.base}/api/health?x=1`)).json(), { ok: true, mode: 'mock', model: MOCK_MODEL, effort: null });
  const head = await raw(mock.port, { method: 'HEAD', path: '/api/health', headers: { Host: 'localhost' } });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
});

test('createApp needs a coach function', () => {
  assert.throws(() => createApp({}), TypeError);
  assert.throws(() => createApp({ coach: {} }), TypeError);
});

// ---------------------------------------------------------------- HTTP: static files

async function staticFixture(t) {
  const dir = await tempDir(t);
  const webRoot = path.join(dir, 'web');
  const sharedRoot = path.join(dir, 'shared');
  await fs.mkdir(path.join(webRoot, 'ui'), { recursive: true });
  await fs.mkdir(path.join(webRoot, '.git'), { recursive: true });
  await fs.mkdir(sharedRoot, { recursive: true });
  const files = {
    'web/index.html': '<!doctype html><title>Practice Coach</title>',
    'web/styles.css': 'body { margin: 0; }',
    'web/app.js': 'console.log("app");',
    'web/module.mjs': 'export default 1;',
    'web/data.json': '{"a":1}',
    'web/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'web/pixel.png': 'PNG',
    'web/favicon.ico': 'ICO',
    'web/app.webmanifest': '{"name":"Practice Coach"}',
    'web/font.woff2': 'WOFF',
    'web/notes.xyz': 'unknown type',
    'web/ui/staff.css': '.st-ok { color: green; }',
    'web/ui/page.HTML': '<p>upper case extension</p>',
    'web/.env': 'ANTHROPIC_API_KEY=secret',
    'web/.git/config': 'secret',
    'web/ui/.hidden.js': 'secret',
    'shared/midi.js': 'export const MIDDLE_C = 60;',
    'shared/.secret': 'secret',
    'secret.txt': 'outside both roots',
    'web-private.txt': 'a sibling whose name starts like the root',
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
  await fs.symlink(path.join(dir, 'secret.txt'), path.join(webRoot, 'link.txt'));
  const { port, base } = await listen(t, { coach: cannedCoach(), webRoot, sharedRoot });
  const get = (requestPath, method = 'GET') => raw(port, { method, path: requestPath, headers: { Host: `127.0.0.1:${port}` } });
  return { dir, webRoot, sharedRoot, port, base, get, files };
}

test('static files: index, MIME types and headers', async (t) => {
  const { get, files } = await staticFixture(t);
  const expectations = {
    '/': ['text/html; charset=utf-8', files['web/index.html']],
    '/index.html': ['text/html; charset=utf-8', files['web/index.html']],
    '/styles.css': ['text/css; charset=utf-8', files['web/styles.css']],
    '/app.js': ['text/javascript; charset=utf-8', files['web/app.js']],
    '/module.mjs': ['text/javascript; charset=utf-8', files['web/module.mjs']],
    '/data.json': ['application/json; charset=utf-8', files['web/data.json']],
    '/icon.svg': ['image/svg+xml', files['web/icon.svg']],
    '/pixel.png': ['image/png', files['web/pixel.png']],
    '/favicon.ico': ['image/x-icon', files['web/favicon.ico']],
    '/app.webmanifest': ['application/manifest+json', files['web/app.webmanifest']],
    '/font.woff2': ['font/woff2', files['web/font.woff2']],
    '/notes.xyz': ['application/octet-stream', files['web/notes.xyz']],
    '/ui/staff.css': ['text/css; charset=utf-8', files['web/ui/staff.css']],
    '/ui/page.HTML': ['text/html; charset=utf-8', files['web/ui/page.HTML']],
    '/shared/midi.js': ['text/javascript; charset=utf-8', files['shared/midi.js']],
    '/app.js?v=3&x=%zz': ['text/javascript; charset=utf-8', files['web/app.js']],
    '/ui/st%61ff.css': ['text/css; charset=utf-8', files['web/ui/staff.css']],
  };
  for (const [requestPath, [type, content]] of Object.entries(expectations)) {
    const response = await get(requestPath);
    assert.equal(response.status, 200, requestPath);
    assert.equal(response.headers['content-type'], type, requestPath);
    assert.equal(response.body, content, requestPath);
    assert.equal(response.headers['cache-control'], 'no-cache', requestPath);
    assert.equal(response.headers['x-content-type-options'], 'nosniff', requestPath);
    assert.equal(response.headers['content-length'], String(Buffer.byteLength(content)), requestPath);
    assert.equal(response.headers['access-control-allow-origin'], undefined, requestPath);
    const isHtml = type.startsWith('text/html');
    assert.equal(response.headers['content-security-policy'] !== undefined, isHtml, `CSP only on HTML: ${requestPath}`);
  }
  const csp = (await get('/')).headers['content-security-policy'];
  assert.equal(
    csp,
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
});

test('static files: HEAD sends the headers without a body', async (t) => {
  const { get, files } = await staticFixture(t);
  for (const requestPath of ['/', '/app.js', '/shared/midi.js']) {
    const full = await get(requestPath);
    const head = await get(requestPath, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.equal(head.headers['content-type'], full.headers['content-type']);
    assert.equal(head.headers['content-length'], full.headers['content-length']);
  }
  assert.equal((await get('/', 'HEAD')).headers['content-length'], String(Buffer.byteLength(files['web/index.html'])));
  assert.equal((await get('/missing.js', 'HEAD')).status, 404);
});

test('static files: missing files, directories, dotfiles and traversal are a clean 404', async (t) => {
  const { get, port } = await staticFixture(t);
  const forbidden = [
    '/missing.js',
    '/ui/missing.css',
    '/missing/dir/file.js',
    '/app.js/extra',
    '/ui',
    '/ui/',
    '/shared',
    '/shared/',
    '/shared/missing.js',
    '/.env',
    '/.git/config',
    '/ui/.hidden.js',
    '/shared/.secret',
    '/%2eenv',
    '/%2Eenv',
    '/ui/%2ehidden.js',
    '/../secret.txt',
    '/../../secret.txt',
    '/ui/../../secret.txt',
    '/ui/../app.js',
    '/./app.js',
    '/%2e%2e/secret.txt',
    '/%2E%2E/secret.txt',
    '/.%2e/secret.txt',
    '/%2e./secret.txt',
    '/..%2fsecret.txt',
    '/..%2Fsecret.txt',
    '/ui%2f..%2f..%2fsecret.txt',
    '/..%5csecret.txt',
    '/..\\secret.txt',
    '/ui\\staff.css',
    '/ui%5cstaff.css',
    '/shared/../secret.txt',
    '/shared/%2e%2e/secret.txt',
    '/shared/..%2fsecret.txt',
    '/shared/../web/app.js',
    '/shared/%2e%2e%2fweb%2fapp.js',
    '//app.js',
    '/ui//staff.css',
    '//etc/passwd',
    '/%2f%2fetc%2fpasswd',
    '/etc/passwd',
    '/app.js%00.png',
    '/%00',
    '/app.js%',
    '/%zz',
    '/%c0%ae%c0%ae/secret.txt',
    '/link.txt',
    '/../web-private.txt',
    '/index.html/',
  ];
  for (const requestPath of forbidden) {
    const response = await get(requestPath);
    assert.equal(response.status, 404, requestPath);
    assert.equal(response.body.includes('secret'), false, requestPath);
    assert.equal(response.body.includes('outside'), false, requestPath);
    assert.match(response.headers['content-type'], /^text\/plain/, requestPath);
  }
  // An absolute-form request target is not a path at all.
  const absolute = await get(`http://127.0.0.1:${port}/app.js`);
  assert.equal(absolute.status, 400);
  // The server survived all of that.
  assert.equal((await get('/app.js')).status, 200);
});

test('resolveStaticPath keeps every path inside its root', () => {
  const web = path.resolve('/srv/app/web');
  const shared = path.resolve('/srv/app/shared');
  assert.deepEqual(resolveStaticPath('/', web, shared), { root: web, file: path.join(web, 'index.html') });
  assert.deepEqual(resolveStaticPath('/ui/staff.css', web, shared), { root: web, file: path.join(web, 'ui', 'staff.css') });
  assert.deepEqual(resolveStaticPath('/shared/midi.js', web, shared), { root: shared, file: path.join(shared, 'midi.js') });
  assert.deepEqual(resolveStaticPath('/a%20b.js', web, shared), { root: web, file: path.join(web, 'a b.js') });
  for (const bad of ['', 'app.js', '/..', '/../x', '/a/../b', '/.x', '/a/.x', '/%2e%2e/x', '/a%2fb', '/a%5cb', '/a\\b', '/a%00b', '/%', '//a', '/a//b', '/shared', '/shared/', '/shared/../x', null, undefined, 5]) {
    assert.equal(resolveStaticPath(bad, web, shared), null, String(bad));
  }
});

test('GET / is a plain 404 while web/index.html does not exist', async (t) => {
  const dir = await tempDir(t);
  const { port } = await listen(t, { coach: cannedCoach(), webRoot: path.join(dir, 'web'), sharedRoot: path.join(dir, 'nowhere') });
  for (const requestPath of ['/', '/index.html', '/styles.css', '/ui/staff.css', '/app.js', '/shared/midi.js']) {
    const response = await raw(port, { path: requestPath, headers: { Host: 'localhost' } });
    assert.equal(response.status, 404, requestPath);
    assert.match(response.headers['content-type'], /^text\/plain/);
  }
  // The API still works without any static files.
  assert.equal((await raw(port, { path: '/api/health', headers: { Host: 'localhost' } })).status, 200);
});

test('the real web/ and shared/ directories are served by default', async (t) => {
  const { base } = await listen(t, { coach: cannedCoach() });
  const midi = await fetch(`${base}/shared/midi.js`);
  assert.equal(midi.status, 200);
  assert.equal(await midi.text(), await fs.readFile(path.join(REPO, 'shared', 'midi.js'), 'utf8'));
  assert.equal((await fetch(`${base}/shared/exercises.js`)).status, 200);
  assert.equal((await fetch(`${base}/server/index.js`)).status, 404, 'server code is not served');
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/definitely-missing-${Date.now()}.css`)).status, 404);
});

// ---------------------------------------------------------------- mock coach

const mockTurn = (request) => turn(createMockCoach({ chunkDelayMs: 0 }), request);
const attemptText = (lines) => ['[event: attempt]', 'exercise: C major scale, right hand (wait, 60 bpm)', ...lines].join('\n');
const said = (assistant) => JSON.parse(assistant).say;

test('mock report readers', () => {
  assert.equal(eventTag('[event: attempt]\nrest'), 'attempt');
  assert.equal(eventTag('  [event:session_start]'), 'session_start');
  assert.equal(eventTag('[Event: NEXT]'), 'next');
  for (const none of ['', 'hello', 'x [event: chat]', null, undefined, 5]) assert.equal(eventTag(none), null);

  assert.equal(readAccuracy('result: completed, accuracy 87% (13/15 clean), wrong 2\nchange: accuracy 73% -> 87%'), 87);
  assert.equal(readAccuracy('loudness 100%\naccuracy: 40 %'), 40);
  assert.equal(readAccuracy('clean 93.3%'), 93.3);
  assert.ok(Math.abs(readAccuracy('13 of 15 clean') - 86.67) < 0.01);
  assert.equal(readAccuracy('13/15 steps clean'), (100 * 13) / 15);
  assert.equal(readAccuracy('something 55% else'), 55);
  assert.equal(readAccuracy('no numbers'), null);
  assert.equal(readAccuracy('accuracy 250%'), null);
  assert.equal(readAccuracy(null), null);

  assert.equal(readAttemptNumber('[event: attempt]\nattempt 3\nprevious attempt: 73%'), 3);
  assert.equal(readAttemptNumber('attempt #12, accuracy 80%'), 12);
  assert.equal(readAttemptNumber('Try number 2'), 2);
  assert.equal(readAttemptNumber('previous attempt: 73%'), null);
  assert.equal(readAttemptNumber('nothing'), null);

  assert.deepEqual(readStepNumbers('stopped at step 5 of 15\ntrouble: step 3 (E4): wrong F4; steps 7-9 slow; steps 11, 12 and 14'), [3, 7, 9, 11, 12, 14]);
  assert.deepEqual(readStepNumbers('stopped at step 5 of 15', { positions: true }), [5]);
  assert.deepEqual(readStepNumbers('15 steps, all clean'), []);
  assert.equal(readFirstStepNumber('[event: hint]\nstuck on step 4 of 15, wrong: step 9'), 4);
  assert.equal(readFirstStepNumber('nothing here'), null);
});

test('mock coach: session_start with no exercise loads the first starter exercise', async () => {
  const result = await mockTurn({ messages: [USER_START], exercise: null });
  assert.equal(result.error, undefined);
  const sayCount = result.names.filter((name) => name === 'say').length;
  assert.ok(sayCount >= 3, 'say is streamed in small chunks');
  assert.deepEqual(result.names, [...Array(sayCount).fill('say'), 'action', 'done']);
  assert.equal(result.action.type, 'new_exercise');
  assert.deepEqual(result.action.exercise, built(STARTER_EXERCISES[0]));
  assert.equal(result.done.mock, true);
  assert.equal(result.done.usage, null);
  assert.equal(result.done.model, MOCK_MODEL);
  assert.equal(typeof result.done.ms.total, 'number');
  const reply = JSON.parse(result.done.assistant);
  assert.equal(reply.say, result.said);
  assert.deepEqual(reply.action, { type: 'new_exercise', exercise: STARTER_EXERCISES[0] });
  assert.equal(reply.student_notes, null, 'the offline coach never overwrites the real coach notes');
  assert.match(result.said, /offline/i, 'it says what it is');
  assert.deepEqual(result.notes, []);
});

test('mock coach: session_start with an exercise already loaded keeps it', async () => {
  const result = await mockTurn({ messages: [USER_START], exercise: SCALE });
  assert.deepEqual(result.action, { type: 'none' });
  assert.ok(result.said.includes(SCALE.title));
  assert.match(result.said, /offline/i);
});

test('mock coach: says it is the offline coach once per session at most', async () => {
  const first = await mockTurn({ messages: [USER_START], exercise: SCALE });
  const messages = [USER_START, { role: 'assistant', content: first.done.assistant }, { role: 'user', content: attemptText(['attempt 1', 'accuracy 80%']) }];
  const second = await mockTurn({ messages, exercise: SCALE });
  assert.match(first.said, /offline/i);
  assert.equal(/offline/i.test(second.said), false);
  const third = await mockTurn({ messages: [...messages, { role: 'assistant', content: second.done.assistant }, { role: 'user', content: '[event: next]\nreason: asked' }], exercise: SCALE });
  assert.equal(/offline/i.test(third.said), false);
  // If the very first turn of a transcript is something else, the notice goes there.
  const cold = await mockTurn({ messages: [{ role: 'user', content: attemptText(['accuracy 80%']) }], exercise: SCALE });
  assert.match(cold.said, /offline/i);
});

test('mock coach: attempt feedback follows the accuracy', async () => {
  const start = [USER_START, { role: 'assistant', content: replyJson('Welcome.') }];
  const ask = (lines, exercise = SCALE, history = start) => mockTurn({ messages: [...history, { role: 'user', content: attemptText(lines) }], exercise });

  // One clean try: stay and confirm.
  const clean = await ask(['attempt 1', 'result: completed, accuracy 100% (15/15 clean)']);
  assert.deepEqual(clean.action, { type: 'none' });
  assert.match(clean.said, /100 percent/);
  assert.match(clean.said, /Try 1/);

  // Middling: stay, name the trouble steps.
  const middling = await ask(['attempt 2', 'result: completed, accuracy 80% (12/15 clean), wrong 3', 'trouble: step 4 (F4): played F#4', 'trouble: step 9 (B4): hesitation']);
  assert.deepEqual(middling.action, { type: 'none' });
  assert.match(middling.said, /80 percent/);
  assert.match(middling.said, /steps 4 and 9/);

  // Struggling with listed trouble steps: drill them with a step on each side.
  const struggling = await ask(['attempt 3', 'result: completed, accuracy 53% (8/15 clean)', 'trouble: step 4 (F4): played F#4', 'trouble: step 5 (G4): played F4']);
  assert.equal(struggling.action.type, 'drill');
  assert.equal(struggling.action.from_step, 3);
  assert.equal(struggling.action.to_step, 6);
  assert.equal(struggling.action.exercise.steps.length, 4);
  assert.deepEqual(validateExercise(struggling.action.exercise), []);
  assert.deepEqual(JSON.parse(struggling.done.assistant).action, { type: 'drill', from_step: 3, to_step: 6 });

  // Struggling with nothing listed, or with no exercise: stay.
  assert.deepEqual((await ask(['accuracy 40%'])).action, { type: 'none' });
  assert.deepEqual((await ask(['accuracy 40%', 'trouble: step 4'], null)).action, { type: 'none' });
  // Trouble everywhere: a drill of the whole exercise would be pointless.
  assert.deepEqual((await ask(['accuracy 20%', 'trouble: steps 1, 8 and 15'])).action, { type: 'none' });
  // No numbers at all.
  const vague = await ask(['result: stopped early']);
  assert.deepEqual(vague.action, { type: 'none' });
  assert.ok(vague.said.length > 10);
});

test('mock coach: two clean attempts in a row bring in the metronome, then raise the tempo, then move on', async () => {
  const cleanTurn = (n) => ({ role: 'user', content: attemptText([`attempt ${n}`, 'result: completed, accuracy 100% (15/15 clean)']) });
  const history = [USER_START, { role: 'assistant', content: replyJson('Welcome.') }, cleanTurn(1), { role: 'assistant', content: replyJson('Clean. Once more.') }];

  // In wait mode nothing sets the pace, so the next step is the metronome, not a higher number.
  const withClick = await mockTurn({ messages: [...history, cleanTurn(2)], exercise: SCALE });
  assert.equal(SCALE.mode, 'wait');
  assert.equal(withClick.action.type, 'set_tempo');
  assert.equal(withClick.action.mode, 'tempo');
  assert.equal(withClick.action.bpm, SCALE.bpm);
  assert.equal(withClick.action.exercise.mode, 'tempo');
  assert.equal(withClick.action.exercise.id, SCALE.id);
  assert.match(withClick.said, /metronome/);

  // A chat in between does not break the streak; an action that changed the exercise does.
  const withChat = [...history, { role: 'user', content: '[event: chat]\n"is this right?"' }, { role: 'assistant', content: replyJson('Offline.') }, cleanTurn(2)];
  assert.equal((await mockTurn({ messages: withChat, exercise: SCALE })).action.type, 'set_tempo');
  const afterChange = [...history.slice(0, 3), { role: 'assistant', content: replyJson('Faster.', { type: 'set_tempo', bpm: 68, mode: 'wait' }) }, cleanTurn(2)];
  assert.deepEqual((await mockTurn({ messages: afterChange, exercise: SCALE })).action, { type: 'none' });
  // A sloppy try in between resets it too.
  const sloppy = [...history.slice(0, 2), { role: 'user', content: attemptText(['accuracy 60%']) }, { role: 'assistant', content: replyJson('Slower.') }, cleanTurn(2)];
  assert.deepEqual((await mockTurn({ messages: sloppy, exercise: SCALE })).action, { type: 'none' });

  // In tempo mode two clean tries raise the tempo by 8 and keep tempo mode.
  const inTempo = resolveAction({ type: 'set_tempo', bpm: SCALE.bpm, mode: 'tempo' }, SCALE).action.exercise;
  const raised = await mockTurn({ messages: [...history, cleanTurn(2)], exercise: inTempo });
  assert.deepEqual([raised.action.type, raised.action.mode, raised.action.bpm], ['set_tempo', 'tempo', SCALE.bpm + 8]);

  // Already one raise above the starting tempo: time for the next starter exercise.
  const fast = resolveAction({ type: 'set_tempo', bpm: SCALE.bpm + 8, mode: 'tempo' }, SCALE).action.exercise;
  const moved = await mockTurn({ messages: [...history, cleanTurn(2)], exercise: fast });
  assert.equal(moved.action.type, 'new_exercise');
  const index = STARTER_EXERCISES.indexOf(SCALE_SPEC);
  assert.deepEqual(moved.action.exercise, built(STARTER_EXERCISES[(index + 1) % STARTER_EXERCISES.length]));
});

test('mock coach: two clean tries inside a drill go back to the full exercise', async () => {
  const drill = resolveAction({ type: 'drill', from_step: 3, to_step: 6 }, SCALE).action.exercise;
  const context = `This exercise is a drill cut from "${SCALE.title}". Use the back_to_full action to return to the whole exercise.`;
  const cleanTurn = (n) => ({ role: 'user', content: attemptText([`attempt ${n}`, 'result: completed, 4 of 4 steps clean (100%)', context]) });
  const history = [
    USER_START,
    { role: 'assistant', content: replyJson('Welcome.') },
    { role: 'user', content: attemptText(['attempt 1', 'accuracy 50%', 'trouble: step 4', 'trouble: step 5']) },
    { role: 'assistant', content: replyJson('Loop steps 3 to 6.', { type: 'drill', from_step: 3, to_step: 6 }) },
  ];
  // One clean try in the drill: once more.
  const once = await mockTurn({ messages: [...history, cleanTurn(1)], exercise: drill });
  assert.deepEqual(once.action, { type: 'none' });
  // Two in a row: leave the drill. The action carries no exercise: the browser knows the parent.
  const twice = await mockTurn({ messages: [...history, cleanTurn(1), { role: 'assistant', content: once.done.assistant }, cleanTurn(2)], exercise: drill });
  assert.deepEqual(twice.action, { type: 'back_to_full' });
  assert.deepEqual(twice.actions, [{ action: { type: 'back_to_full' } }]);
  assert.deepEqual(JSON.parse(twice.done.assistant).action, { type: 'back_to_full' });
  assert.match(twice.said, /whole exercise/);
  // The drill is recognized by its title too, when the report does not mention it.
  const plainTurn = (n) => ({ role: 'user', content: attemptText([`attempt ${n}`, 'accuracy 100%']) });
  const byTitle = await mockTurn({ messages: [...history, plainTurn(1), { role: 'assistant', content: replyJson('Once more.') }, plainTurn(2)], exercise: drill });
  assert.deepEqual(byTitle.action, { type: 'back_to_full' });
});

test('mock coach: next gives the starter exercise after the current one', async () => {
  const starters = STARTER_EXERCISES.map(built);
  const ask = (exercise) => mockTurn({ messages: [USER_START, { role: 'assistant', content: replyJson('Welcome.') }, { role: 'user', content: '[event: next]\nreason: The learner pressed "Next exercise".' }], exercise });
  for (let i = 0; i < starters.length; i += 1) {
    const result = await ask(starters[i]);
    assert.equal(result.action.type, 'new_exercise');
    assert.deepEqual(result.action.exercise, starters[(i + 1) % starters.length], `after starter ${i}`);
    assert.notEqual(result.action.exercise.title, starters[i].title);
    assert.ok(result.said.includes(result.action.exercise.title));
    assert.deepEqual(JSON.parse(result.done.assistant).action, { type: 'new_exercise', exercise: STARTER_EXERCISES[(i + 1) % starters.length] });
  }
  // The same exercise at another tempo, or a drill cut from it, still counts as that exercise.
  const faster = resolveAction({ type: 'set_tempo', bpm: 100, mode: 'tempo' }, starters[2]).action.exercise;
  assert.deepEqual((await ask(faster)).action.exercise, starters[3]);
  const drill = resolveAction({ type: 'drill', from_step: 2, to_step: 5 }, starters[2]).action.exercise;
  assert.deepEqual((await ask(drill)).action.exercise, starters[3]);
  // Unknown or missing exercise: index 1.
  assert.deepEqual((await ask(built(GOOD_SPEC))).action.exercise, starters[1]);
  assert.deepEqual((await ask(null)).action.exercise, starters[1]);
  // Never the title that is already on screen.
  const sameTitle = { ...built(GOOD_SPEC), title: starters[1].title };
  assert.notEqual((await ask(sameTitle)).action.exercise.title, starters[1].title);
});

test('mock coach: hint names the expected note of the step', async () => {
  const hint = (text, exercise = SCALE) => mockTurn({ messages: [USER_START, { role: 'assistant', content: replyJson('Welcome.') }, { role: 'user', content: text }], exercise });
  const step = SCALE.steps[3];
  const result = await hint('[event: hint]\nstuck on step 4 of 15\nwrong notes so far: F#4\nidle 6 s');
  assert.deepEqual(result.action, { type: 'none' });
  assert.ok(result.said.includes('Step 4'));
  assert.ok(result.said.includes(step.names[0]), `names ${step.names[0]}`);
  if (step.fingers[0] !== null) assert.ok(result.said.includes(`finger ${step.fingers[0]}`));
  // A chord step lists every note.
  const chords = built(STARTER_EXERCISES.find((spec) => spec.type === 'chords'));
  const chordHint = await hint('[event: hint]\nstep 2 of 4', chords);
  for (const name of chords.steps[1].names) assert.ok(chordHint.said.includes(name));
  // No usable step number, a step outside the exercise, or no exercise: a generic hint, never a guess.
  for (const [text, exercise] of [['[event: hint]\nidle 12 s', SCALE], ['[event: hint]\nstep 99 of 15', SCALE], ['[event: hint]\nstep 4 of 15', null]]) {
    const generic = await hint(text, exercise);
    assert.deepEqual(generic.action, { type: 'none' });
    assert.ok(generic.said.length > 10);
    assert.equal(/Step \d+ is/.test(generic.said), false);
  }
});

test('mock coach: chat, free_play and unknown turns get a short reply with action none', async () => {
  const ask = (text) => mockTurn({ messages: [USER_START, { role: 'assistant', content: replyJson('Welcome.') }, { role: 'user', content: text }], exercise: SCALE });
  const chat = await ask('[event: chat]\nlearner says: "What should I focus on?"');
  assert.deepEqual(chat.action, { type: 'none' });
  assert.match(chat.said, /offline coach/i);
  assert.match(chat.said, /cannot/i);
  const freePlay = await ask('[event: free_play]\n12 notes, 4.2 s, range C4 to C5, key C major (0.82)');
  assert.deepEqual(freePlay.action, { type: 'none' });
  assert.ok(freePlay.said.length > 10);
  for (const text of ['[event: something_new]\nx', 'no tag at all', '[event: exercise_rejected]\n- bad']) {
    const other = await ask(text);
    assert.deepEqual(other.action, { type: 'none' });
    assert.ok(other.said.length > 10);
    assert.equal(other.names.at(-1), 'done');
  }
  for (const result of [chat, freePlay]) {
    assert.ok(result.said.length < 240, 'short enough to listen to');
    assert.equal(result.said.includes('\u2014'), false);
  }
});

test('mock coach: deterministic, tolerant of odd input, and quick', async () => {
  const request = { messages: [USER_START, { role: 'assistant', content: 'not json' }, { role: 'user', content: attemptText(['accuracy 95%']) }], exercise: SCALE };
  assert.deepEqual(mockReply(request), mockReply(request));
  for (const odd of [{}, { messages: [] }, { messages: null }, { messages: [{ role: 'user' }] }, { messages: [{ role: 'user', content: '[event: next]' }], exercise: { id: 5, steps: 'x' } }, { messages: [{ role: 'user', content: '[event: attempt]\naccuracy 10%\nstep 3' }], exercise: { steps: [] } }]) {
    const reply = mockReply(odd);
    assert.equal(typeof reply.say, 'string');
    assert.ok(validateReply(reply).ok, JSON.stringify(odd));
  }
  // With its normal pacing a whole reply stays well under 400 ms.
  const started = performance.now();
  const paced = await turn(createMockCoach(), { messages: [USER_START], exercise: null });
  assert.ok(performance.now() - started < 400, 'fast enough for the end-to-end test');
  assert.equal(paced.names.at(-1), 'done');
  const coach = createMockCoach();
  assert.deepEqual([coach.mode, coach.model, coach.effort], ['mock', MOCK_MODEL, null]);
});

test('mock coach: stops quietly when the request is aborted', async () => {
  const controller = new AbortController();
  const coach = createMockCoach({ chunkDelayMs: 5 });
  const events = [];
  for await (const item of coach({ messages: [USER_START], exercise: null, signal: controller.signal })) {
    events.push(item);
    if (events.length === 2) controller.abort();
  }
  assert.equal(events.length, 2);
  assert.ok(events.every((item) => item.event === 'say'));
});

test('mock coach over HTTP: a whole little session', async (t) => {
  const { base } = await listen(t, { coach: createMockCoach() });
  const messages = [];
  let exercise = built(STARTER_EXERCISES[0]); // the browser loads this before the session starts
  const send = async (content) => {
    messages.push({ role: 'user', content });
    const { status, events } = await postCoach(base, { messages, exercise });
    assert.equal(status, 200);
    const names = events.map((item) => item.event);
    assert.deepEqual(names.filter((name) => name !== 'say'), ['action', 'done'], content.split('\n')[0]);
    const done = events.at(-1).data;
    const action = events.find((item) => item.event === 'action').data.action;
    assert.equal(done.mock, true);
    assert.equal(events.filter((item) => item.event === 'say').map((item) => item.data.delta).join(''), said(done.assistant));
    messages.push({ role: 'assistant', content: done.assistant });
    if (action.exercise) exercise = action.exercise;
    return { action, say: said(done.assistant) };
  };

  const start = await send('[event: session_start]\nlearner: Sam, beginner\ngoals: simple songs');
  assert.ok(['none', 'new_exercise'].includes(start.action.type));
  const firstTitle = exercise.title;
  assert.equal((await send(attemptText(['attempt 1', 'accuracy 89% (8/9 clean), wrong 1', 'trouble: step 1 (C4): played C#4']))).action.type, 'none');
  assert.equal((await send(attemptText(['attempt 2', 'accuracy 100% (9/9 clean)']))).action.type, 'none');
  assert.equal((await send(attemptText(['attempt 3', 'accuracy 100% (9/9 clean)']))).action.type, 'set_tempo');
  assert.equal(exercise.title, firstTitle);
  assert.equal((await send('[event: free_play]\n12 notes')).action.type, 'none');
  assert.equal((await send('[event: chat]\n"What should I focus on?"')).action.type, 'none');
  assert.equal((await send('[event: hint]\nstuck on step 2 of 9')).action.type, 'none');
  const next = await send('[event: next]\nreason: The learner pressed "Next exercise".');
  assert.equal(next.action.type, 'new_exercise');
  assert.notEqual(exercise.title, firstTitle, 'next changes the exercise on screen');
  assert.deepEqual(exercise, built(STARTER_EXERCISES[1]));
});

test('mock coach understands the reports shared/summary.js really writes', async (t) => {
  let summary;
  try {
    summary = await import('../shared/summary.js');
  } catch {
    t.skip('shared/summary.js is not there yet');
    return;
  }
  const result = (clean) => ({
    exerciseId: SCALE.id,
    mode: 'wait',
    bpm: SCALE.bpm,
    completed: true,
    durationMs: 15000,
    steps: SCALE.steps.map((_, index) => ({ index, state: index < clean ? 'ok' : 'error', wrong: index < clean ? [] : [61], ioiMs: 1000, offsetMs: null, velocity: 70, chordSpreadMs: null })),
    totals: { steps: 15, played: 15, clean, wrongNotes: 15 - clean, missed: 0, extra: 0, accuracy: clean / 15 },
    timing: { estBpm: 60, evennessCv: 0.1, hesitations: [], meanOffsetMs: null, offsetSdMs: null, driftMsPerBeat: null },
    dynamics: { mean: 70, sd: 5, min: 60, max: 80 },
    troubleSpots: clean < 15 ? [{ index: 14, names: SCALE.steps[14].names, reason: 'wrong_notes' }] : [],
  });
  const attempt = summary.renderAttempt({ exercise: SCALE, result: result(15), attemptNumber: 1, previous: null });
  assert.equal(eventTag(attempt), 'attempt');
  assert.equal(readAccuracy(attempt.slice(attempt.indexOf('\n') + 1)), 100, attempt);
  const rough = summary.renderAttempt({ exercise: SCALE, result: result(6), attemptNumber: 2, previous: null });
  assert.equal(Math.round(readAccuracy(rough.slice(rough.indexOf('\n') + 1))), 40, rough);

  const hint = summary.renderHint({ exercise: SCALE, stepIndex: 3, wrongNotes: [66], idleMs: 6000 });
  assert.equal(eventTag(hint), 'hint');
  const hinted = await mockTurn({ messages: [USER_START, { role: 'assistant', content: replyJson('Welcome.') }, { role: 'user', content: hint }], exercise: SCALE });
  assert.ok(hinted.said.includes(SCALE.steps[3].names[0]), `${hint}\n-> ${hinted.said}`);

  assert.equal(eventTag(summary.renderNext({ exercise: SCALE, reason: 'asked' })), 'next');
  assert.equal(eventTag(summary.renderChat({ text: 'hello', exercise: SCALE, trackerState: null })), 'chat');
  assert.equal(eventTag(summary.renderSessionStart({ profile: { level: 'beginner', goals: 'songs' }, notes: '', progress: { sessions: 0, minutes: 0, recent: [] }, exercise: SCALE })), 'session_start');
});

// ---------------------------------------------------------------- configuration and the command line

test('readConfig: defaults, overrides and the mock-mode rule', () => {
  const defaults = readConfig({});
  assert.deepEqual(
    { host: defaults.host, port: defaults.port, model: defaults.model, effort: defaults.effort, maxPerMinute: defaults.maxPerMinute, allowedHosts: defaults.allowedHosts },
    { host: '127.0.0.1', port: 5173, model: 'claude-opus-5-5', effort: 'low', maxPerMinute: 20, allowedHosts: [] },
  );
  assert.equal(defaults.mock, true, 'no key: offline coach');
  assert.deepEqual(defaults.warnings, []);

  const custom = readConfig({ HOST: '0.0.0.0', PORT: '8080', COACH_MODEL: 'claude-haiku-5-5', COACH_EFFORT: 'XHigh', COACH_MAX_PER_MIN: '5', ALLOWED_HOSTS: 'a.local,b.lan', ANTHROPIC_API_KEY: 'test-key-not-real' });
  assert.deepEqual(
    { host: custom.host, port: custom.port, model: custom.model, effort: custom.effort, maxPerMinute: custom.maxPerMinute, allowedHosts: custom.allowedHosts, mock: custom.mock },
    { host: '0.0.0.0', port: 8080, model: 'claude-haiku-5-5', effort: 'xhigh', maxPerMinute: 5, allowedHosts: ['a.local', 'b.lan'], mock: false },
  );
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(readConfig({ COACH_EFFORT: effort }).effort, effort);

  // Mock mode: COACH_MOCK=1 always; no key and COACH_MOCK not 0; never with a key otherwise.
  const key = { ANTHROPIC_API_KEY: 'test-key-not-real' };
  const token = { ANTHROPIC_AUTH_TOKEN: 'test-token-not-real' };
  assert.equal(readConfig({ ...key, COACH_MOCK: '1' }).mock, true);
  assert.equal(readConfig({ ...key }).mock, false);
  assert.equal(readConfig({ ...token }).mock, false);
  assert.equal(readConfig({ ...key, COACH_MOCK: '' }).mock, false);
  assert.equal(readConfig({ ...key, COACH_MOCK: '0' }).mock, false);
  assert.equal(readConfig({ COACH_MOCK: '0' }).mock, false, 'COACH_MOCK=0 forces the API even with no key');
  assert.equal(readConfig({ COACH_MOCK: '' }).mock, true);
  assert.equal(readConfig({ ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '  ' }).mock, true, 'an empty key from .env.example counts as no key');

  // Bad values fall back to the defaults with a warning.
  const bad = readConfig({ PORT: 'abc', COACH_EFFORT: 'extreme', COACH_MAX_PER_MIN: '-3' });
  assert.deepEqual([bad.port, bad.effort, bad.maxPerMinute], [5173, 'low', 20]);
  assert.equal(bad.warnings.length, 3);
  assert.equal(readConfig({ PORT: '70000' }).port, 5173);
  assert.equal(readConfig({ PORT: '0' }).port, 0);
});

test('command line: starts in mock mode, serves, and reports a busy port clearly', async (t) => {
  const env = { ...process.env, COACH_MOCK: '1', PORT: '0', HOST: '127.0.0.1' };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const child = spawn(process.execPath, ['server/index.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  const deadline = Date.now() + 10000;
  let port = null;
  while (port === null && Date.now() < deadline) {
    const match = /http:\/\/localhost:(\d+)/.exec(output);
    if (match && /mock coach/i.test(output)) port = Number(match[1]);
    else await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(port, `the server printed its URL and mode:\n${output}`);
  assert.match(output, /OFFLINE mock coach/, 'one clear line about mock mode');
  assert.match(output, /COACH_MOCK=1/);

  const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  assert.deepEqual(health, { ok: true, mode: 'mock', model: MOCK_MODEL, effort: null });
  const { events } = await postCoach(`http://127.0.0.1:${port}`, { messages: [USER_START], exercise: null });
  assert.equal(events.at(-1).event, 'done');
  assert.equal(events.at(-1).data.mock, true);

  // A second server on the same port explains itself and exits with an error code.
  const second = spawn(process.execPath, ['server/index.js'], { cwd: REPO, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => second.kill());
  let secondOutput = '';
  second.stdout.on('data', (chunk) => (secondOutput += chunk));
  second.stderr.on('data', (chunk) => (secondOutput += chunk));
  const code = await new Promise((resolve) => second.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(secondOutput, new RegExp(`Port ${port} is already in use`));
  assert.equal(/at .*\(node:/.test(secondOutput), false, 'no stack trace for a busy port');

  // SIGTERM stops it promptly.
  const exited = new Promise((resolve) => child.on('exit', resolve));
  child.kill('SIGTERM');
  await exited;
});

// ---------------------------------------------------------------- the real SDK against a local fake API

/**
 * A local HTTP server that speaks just enough of the Messages API wire format for the real
 * Anthropic SDK client. Nothing leaves this machine and the key is a dummy. This checks what the
 * hand-written fake client cannot: the request the SDK really sends for our parameters, and that
 * the coach reads the SDK's real stream object and error classes correctly.
 */
async function fakeApi(t, responders) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: safeJson(Buffer.concat(chunks).toString('utf8')), closed: false };
      requests.push(record);
      res.on('close', () => {
        record.closed = true;
      });
      responders[Math.min(requests.length - 1, responders.length - 1)](record, res);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const client = new Anthropic({ apiKey: 'test-key-not-real', baseURL, maxRetries: 0, timeout: 5000 });
  return { requests, baseURL, client };
}

const sseFrame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
const sendSse = (events, { end = true, tail = '' } = {}) => (record, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'request-id': 'req_fake' });
  res.write(events.map(sseFrame).join('') + tail);
  if (end) res.end();
};
const sendError = (status, type, message = `fake ${type}`) => (record, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'request-id': 'req_fake' });
  res.end(JSON.stringify({ type: 'error', error: { type, message }, request_id: 'req_fake' }));
};

test('real SDK: the request on the wire and a streamed reply', async (t) => {
  const say = 'Hello from the fake API. Play it "slowly" \ud83c\udfb9.';
  const reply = apiReply(replyJson(say, { type: 'drill', from_step: 2, to_step: 4 }, 'Sam likes scales.'), { chunk: 5 });
  const api = await fakeApi(t, [sendSse(reply.events)]);
  const coach = createCoach({ client: api.client, effort: 'low', warn: () => {} });
  const messages = [USER_START, { role: 'assistant', content: replyJson('Welcome.') }, { role: 'user', content: '[event: attempt]\naccuracy 60%' }];
  const result = await turn(coach, { messages, exercise: SCALE });

  assert.equal(result.error, undefined);
  assert.equal(result.said, say);
  assert.equal(result.action.type, 'drill');
  assert.equal(result.action.exercise.steps.length, 3);
  assert.deepEqual(result.notes, [{ text: 'Sam likes scales.' }]);
  assert.equal(result.done.model, 'claude-opus-5-5');
  assert.equal(result.done.usage.input_tokens, 120);
  assert.equal(result.done.usage.output_tokens, 40);
  assert.equal(result.done.usage.cache_creation_input_tokens, 2000);
  assert.equal(result.done.usage.cache_read_input_tokens, 0);

  assert.equal(api.requests.length, 1);
  const { method, url, headers, body } = api.requests[0];
  assert.equal(method, 'POST');
  assert.ok(url.startsWith('/v1/messages'), url);
  assert.ok(String(headers['anthropic-beta']).split(',').map((value) => value.trim()).includes('server-side-fallback-2026-07-01'), 'the beta travels as a header');
  assert.equal('betas' in body, false, 'betas is not a body field');
  assert.deepEqual(Object.keys(body).sort(), ['fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'stream', 'system']);
  assert.equal(body.stream, true);
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.max_tokens, 16000);
  assert.deepEqual(body.output_config, { effort: 'low', format: { type: 'json_schema', schema: structuredClone(COACH_REPLY_SCHEMA) } });
  assert.deepEqual(body.system, [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(body.messages.at(-1), { role: 'user', content: [{ type: 'text', text: messages[2].content, cache_control: { type: 'ephemeral' } }] });
  assert.deepEqual(body.messages.slice(0, 2), messages.slice(0, 2));
});

test('real SDK: a 400 for the beta is retried on the plain endpoint without the beta header', async (t) => {
  const reply = apiReply(replyJson('Second try worked.'));
  const api = await fakeApi(t, [sendError(400, 'invalid_request_error', 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.'), sendSse(reply.events)]);
  const warnings = [];
  const coach = createCoach({ client: api.client, warn: (message) => warnings.push(message) });
  const result = await turn(coach);
  assert.equal(result.error, undefined);
  assert.equal(result.said, 'Second try worked.');
  assert.equal(api.requests.length, 2);
  const second = api.requests[1];
  assert.equal(String(second.headers['anthropic-beta'] ?? '').includes('server-side-fallback'), false);
  assert.equal('fallbacks' in second.body, false);
  assert.equal(second.body.output_config.format.type, 'json_schema');
  assert.deepEqual(second.body.messages, api.requests[0].body.messages);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /anthropic-beta/);
  // All three rungs refused: bad_request, with the API's own words.
  const refusing = await fakeApi(t, [sendError(400, 'invalid_request_error', 'messages: something is wrong')]);
  const failed = await turn(createCoach({ client: refusing.client, warn: () => {} }));
  assert.deepEqual(failed.names, ['error']);
  assert.equal(failed.error.code, 'bad_request');
  assert.match(failed.error.message, /something is wrong/);
  assert.equal(refusing.requests.length, 3);
  assert.equal('format' in refusing.requests[2].body.output_config, false);
});

test('real SDK: fallback block, refusal and API errors', async (t) => {
  const run = async (responders) => {
    const api = await fakeApi(t, responders);
    return { api, result: await turn(createCoach({ client: api.client, warn: () => {} })) };
  };
  const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: usage() };

  // A fallback block mid-stream, in the real wire format.
  const finalText = replyJson('The fallback model answers.');
  const fallback = await run([
    sendSse([
      { type: 'message_start', message },
      ...textBlockEvents(0, '{"say":"The first model star', 7),
      { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal' } } },
      { type: 'content_block_stop', index: 1 },
      ...textBlockEvents(2, finalText, 7),
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 30 } },
      { type: 'message_stop' },
    ]),
  ]);
  assert.equal(fallback.result.error, undefined);
  assert.equal(fallback.result.names.filter((name) => name === 'reset').length, 1);
  assert.equal(fallback.result.said, 'The fallback model answers.');
  assert.equal(fallback.result.done.model, 'claude-opus-5');

  // A refusal: HTTP 200 with stop_reason "refusal".
  const refusal = await run([
    sendSse([
      { type: 'message_start', message: { ...message, model: 'claude-opus-5-5' } },
      { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', category: null, explanation: null } }, usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ]),
  ]);
  assert.deepEqual(refusal.result.names, ['error']);
  assert.equal(refusal.result.error.code, 'refusal');
  assert.equal(refusal.api.requests.length, 1);

  // HTTP errors become the SDK's typed errors, then our codes.
  for (const [status, type, code, retryable] of [
    [401, 'authentication_error', 'auth', false],
    [403, 'permission_error', 'auth', false],
    [404, 'not_found_error', 'bad_request', false],
    [429, 'rate_limit_error', 'rate_limit', true],
    [500, 'api_error', 'server', true],
    [529, 'overloaded_error', 'overloaded', true],
  ]) {
    const { api, result } = await run([sendError(status, type)]);
    assert.deepEqual(result.names, ['error'], String(status));
    assert.equal(result.error.code, code, String(status));
    assert.equal(result.error.retryable, retryable, String(status));
    assert.equal(api.requests.length, 1, `${status} is not retried by the coach`);
  }

  // An error event in the middle of the stream.
  const partial = apiReply(replyJson('This one breaks off in the middle of the sentence.'));
  const midStream = await run([sendSse(partial.events.slice(0, 9), { tail: 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n' })]);
  assert.equal(midStream.result.names.at(-1), 'error');
  assert.equal(midStream.result.error.code, 'overloaded');
  assert.ok(midStream.result.names.includes('say'));

  // The connection closes mid-reply with no error event and no stop reason.
  const dropped = await run([sendSse(partial.events.slice(0, 9))]);
  assert.equal(dropped.result.names.at(-1), 'error');
  assert.equal(dropped.result.error.code, 'network');
  assert.equal(dropped.result.error.retryable, true);

  // Nothing is listening at all.
  const dead = new Anthropic({ apiKey: 'test-key-not-real', baseURL: 'http://127.0.0.1:9', maxRetries: 0, timeout: 3000 });
  const unreachable = await turn(createCoach({ client: dead, warn: () => {} }));
  assert.deepEqual(unreachable.names, ['error']);
  assert.equal(unreachable.error.code, 'network');
});

test('real SDK: when the browser leaves, the connection to the API is closed', async (t) => {
  const reply = apiReply(replyJson('This reply is never finished because nobody is listening any more.'));
  const api = await fakeApi(t, [sendSse(reply.events.slice(0, 9), { end: false })]);
  const coach = createCoach({ client: api.client, warn: () => {} });
  const { port } = await listen(t, { coach });
  const body = JSON.stringify({ messages: [USER_START], exercise: null });

  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/coach', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      res.once('data', () => {
        req.destroy();
        resolve();
      });
      res.on('error', () => {});
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve() : reject(err)));
    req.end(body);
  });

  const deadline = Date.now() + 3000;
  while (!api.requests[0]?.closed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].closed, true, 'the upstream request was aborted');
});
