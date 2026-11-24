// The live coach: one streamed Claude request per turn, structured output, events for the browser.
//
// createCoach(...) returns coach({ messages, exercise, signal }), an async generator that yields
//   { event: 'say',    data: { delta } }      text for the learner, as it is generated
//   { event: 'reset',  data: {} }             discard the 'say' text so far (the reply restarted)
//   { event: 'action', data: { action } }     exactly once per successful turn
//   { event: 'notes',  data: { text } }       only when the coach updated its notes
//   { event: 'done',   data: { assistant, usage, model, ms, mock } }
//   { event: 'error',  data: { code, message, retryable } }
// A turn ends with exactly one 'done' or one 'error', or with nothing at all when the request was
// aborted (the learner closed the page).

import Anthropic from '@anthropic-ai/sdk';

import { SYSTEM_PROMPT, COACH_REPLY_SCHEMA } from './prompt.js';
import { SayExtractor } from './say-extractor.js';
import { parseReplyText, validateReply, salvageReply, normalizeAction, resolveAction, serializeReply, notesText } from './reply.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_EFFORT = 'low';
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const MAX_TOKENS = 16000;
/** Beta that lets the API re-run a declined request on a fallback model inside the same call. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const USAGE_COUNTERS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
const MAX_REJECTION_ERRORS = 12;

/**
 * @typedef {Object} CoachRequest
 * @property {{role: 'user'|'assistant', content: string}[]} messages  the session transcript
 * @property {object|null} [exercise]   the Exercise loaded in the browser right now
 * @property {AbortSignal} [signal]     aborted when the browser goes away
 */

/** The SDK could not find any credentials to send (raised before a request leaves the machine). */
class MissingCredentialsError extends Error {}

/**
 * Map an exception from the Anthropic SDK to the error event the browser shows.
 * Most specific class first; never matches on message text.
 * @param {unknown} err
 * @returns {{code: string, message: string, retryable: boolean}}
 */
export function mapError(err) {
  if (err instanceof MissingCredentialsError) {
    return {
      code: 'auth',
      message: 'No Claude API key was found. Put ANTHROPIC_API_KEY in .env and restart the server, or set COACH_MOCK=1 to use the offline coach.',
      retryable: false,
    };
  }
  const status = typeof err?.status === 'number' ? err.status : null;
  // A mid-stream failure arrives as a plain APIError with no status: only the API's error type
  // tells what happened. A status always wins over it.
  const type = status === null && err instanceof Anthropic.APIError ? err.type : null;
  if (err instanceof Anthropic.AuthenticationError || type === 'authentication_error') {
    return { code: 'auth', message: 'The Claude API key was rejected. Check ANTHROPIC_API_KEY in .env, then restart the server.', retryable: false };
  }
  if (err instanceof Anthropic.PermissionDeniedError || type === 'permission_error') {
    return {
      code: 'auth',
      message: 'This API key is not allowed to do that. Check ANTHROPIC_API_KEY in .env and the access of its workspace, then restart the server.',
      retryable: false,
    };
  }
  if (err instanceof Anthropic.PaymentRequiredError || type === 'billing_error') {
    return { code: 'auth', message: 'The Claude API reports a billing problem on this account. Check the plan and credits behind ANTHROPIC_API_KEY.', retryable: false };
  }
  if (err instanceof Anthropic.RateLimitError || type === 'rate_limit_error') {
    if (err?.errorCode === 'enforced_spend_limit_reached') {
      return { code: 'rate_limit', message: 'The monthly spend limit of this Claude API account is reached. Raise it in the Console to keep going.', retryable: false };
    }
    return { code: 'rate_limit', message: 'The Claude API rate limit was hit. Wait a few seconds, then try again.', retryable: true };
  }
  if (err instanceof Anthropic.NotFoundError || type === 'not_found_error') {
    return { code: 'bad_request', message: 'The Claude API does not know this model, or this key cannot use it. Check COACH_MODEL in .env.', retryable: false };
  }
  if (err instanceof Anthropic.ContentTooLargeError || type === 'request_too_large') {
    return { code: 'bad_request', message: 'This session has grown too large for the Claude API. Start a new session.', retryable: false };
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError || type === 'invalid_request_error') {
    return { code: 'bad_request', message: `The Claude API rejected the request. Check COACH_MODEL and COACH_EFFORT in .env. (${shorten(err?.apiMessage ?? err?.message)})`, retryable: false };
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.RequestTimeoutError || type === 'timeout_error') {
    return { code: 'network', message: 'The Claude API took too long to answer. Check your internet connection and try again.', retryable: true };
  }
  if (err instanceof Anthropic.APIUserAbortError) {
    return { code: 'network', message: 'The request to the Claude API was cancelled before it finished. Try again.', retryable: true };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { code: 'network', message: 'Cannot reach the Claude API. Check your internet connection and try again.', retryable: true };
  }
  if (err instanceof Anthropic.OverloadedError || status === 529 || type === 'overloaded_error') {
    return { code: 'overloaded', message: 'The Claude API is overloaded right now. Wait a few seconds, then try again.', retryable: true };
  }
  if (err instanceof Anthropic.InternalServerError || (status !== null && status >= 500) || type === 'api_error') {
    return { code: 'server', message: 'The Claude API had an internal error. Try again in a moment.', retryable: true };
  }
  if (status !== null && status >= 400) {
    return { code: 'bad_request', message: `The Claude API rejected the request with status ${status}. (${shorten(err?.apiMessage ?? err?.message)})`, retryable: false };
  }
  return { code: 'server', message: 'The coach hit an unexpected problem. Try again.', retryable: true };
}

function shorten(text, max = 200) {
  const flat = String(text ?? 'no details').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** The transcript as API messages, with a cache breakpoint on the newest user turn. */
function toApiMessages(messages) {
  return messages.map((message, index) => {
    if (index === messages.length - 1 && message.role === 'user') {
      return { role: 'user', content: [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }] };
    }
    return { role: message.role, content: message.content };
  });
}

/** Text of the reply: the text blocks after the last fallback block, and all text blocks. */
function replyTexts(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  let lastFallback = -1;
  blocks.forEach((block, index) => {
    if (block?.type === 'fallback') lastFallback = index;
  });
  const textOf = (list) =>
    list
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
  return { after: textOf(blocks.slice(lastFallback + 1)), all: textOf(blocks), hadFallback: lastFallback !== -1 };
}

/** Parse the reply out of a final message. Returns the parsed object or null. */
function parseFinal(message) {
  const texts = replyTexts(message);
  const parsed = parseReplyText(texts.after);
  if (parsed !== null || !texts.hadFallback) return parsed;
  // After a mid-reply fallback the new model may have continued the partial JSON instead of
  // starting over: then only the text of all blocks together parses.
  return parseReplyText(texts.all);
}

/** Add the token counters of a second request to the usage of the first. */
function mergeUsage(first, second) {
  if (!first || typeof first !== 'object') return second && typeof second === 'object' ? second : null;
  if (!second || typeof second !== 'object') return first;
  const merged = { ...first };
  for (const key of USAGE_COUNTERS) {
    if (typeof first[key] === 'number' || typeof second[key] === 'number') merged[key] = (first[key] ?? 0) + (second[key] ?? 0);
  }
  return merged;
}

function rejectionTurn(errors) {
  const listed = errors.slice(0, MAX_REJECTION_ERRORS).map((error) => `- ${shorten(error, 300)}`);
  if (errors.length > MAX_REJECTION_ERRORS) listed.push(`- (and ${errors.length - MAX_REJECTION_ERRORS} more)`);
  return [
    '[event: exercise_rejected]',
    'The app could not build the exercise in your last reply. Problems:',
    ...listed,
    'Send the same JSON reply again with a corrected "action". Keep "say" exactly as it was.',
  ].join('\n');
}

/**
 * Create the live coach.
 * @param {Object} options
 * @param {object} options.client        an Anthropic client (or a fake with the same stream methods)
 * @param {string} [options.model]
 * @param {'low'|'medium'|'high'|'xhigh'|'max'} [options.effort]
 * @param {number} [options.maxTokens]
 * @param {() => number} [options.now]   millisecond clock, for the timings in 'done'
 * @param {(message: string) => void} [options.warn]
 * @returns {((request: CoachRequest) => AsyncGenerator<{event: string, data: object}>) & {mode: 'live', model: string, effort: string}}
 */
export function createCoach({
  client,
  model = DEFAULT_MODEL,
  effort = DEFAULT_EFFORT,
  maxTokens = MAX_TOKENS,
  now = () => performance.now(),
  warn = (message) => console.warn(message),
} = {}) {
  if (!client) throw new TypeError('createCoach needs an Anthropic client');

  // What the API accepted so far. A downgrade is remembered for the life of the process once a
  // request without the feature has gone through, so later turns do not repeat the failed try.
  const accepted = { fallbacks: true, format: true };
  const warned = new Set();

  function buildParams(apiMessages, rung) {
    const params = {
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: apiMessages,
      output_config: rung.format ? { effort, format: { type: 'json_schema', schema: COACH_REPLY_SCHEMA } } : { effort },
    };
    if (rung.fallbacks) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = 'default';
    }
    return params;
  }

  /** The next rung down after a 400, or null when there is nothing left to drop. */
  function downgrade(rung, err) {
    if (rung.fallbacks) {
      warnOnce('fallbacks', `[coach] The API rejected the request with the refusal-fallback beta on, retrying without it: ${err?.message}`);
      return { ...rung, fallbacks: false };
    }
    if (rung.format) {
      warnOnce('format', `[coach] The API rejected the request with structured outputs on, retrying without output_config.format: ${err?.message}`);
      return { ...rung, format: false };
    }
    return null;
  }

  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      warn(message);
    } catch {
      // logging must never break a turn
    }
  }

  /**
   * One model turn: stream it, walk down the downgrade ladder on a 400, yield 'say' and 'reset'
   * events (unless silent), and return the final message with the text streamed for "say".
   * Throws the SDK's error when the request fails for good.
   */
  async function* streamTurn(apiMessages, signal, { silent = false, onFirstText } = {}) {
    let rung = { ...accepted };
    for (;;) {
      const extractor = new SayExtractor();
      let said = '';
      let sawEvent = false;
      try {
        const api = rung.fallbacks ? client.beta.messages : client.messages;
        const stream = api.stream(buildParams(apiMessages, rung), { signal });
        for await (const event of stream) {
          sawEvent = true;
          if (event?.type === 'content_block_start' && event.content_block?.type === 'fallback') {
            // A fallback model took over inside the same response: its text starts the reply over.
            extractor.reset();
            said = '';
            if (!silent) yield { event: 'reset', data: {} };
          } else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const piece = extractor.push(event.delta.text);
            if (piece) {
              said += piece;
              onFirstText?.();
              if (!silent) yield { event: 'say', data: { delta: piece } };
            }
          }
        }
        // The SDK's iterator can end quietly after an error: finalMessage() is what rejects.
        const message = await stream.finalMessage();
        if (!rung.fallbacks) accepted.fallbacks = false;
        if (!rung.format) accepted.format = false;
        return { message, said };
      } catch (err) {
        if (signal?.aborted) throw err;
        if (!(err instanceof Anthropic.APIError)) {
          // Not an answer from the API. Once events were flowing, the SDK raises a bare error when
          // the stream breaks off or ends before the message is complete: that is a network fault.
          if (sawEvent) throw new Anthropic.APIConnectionError({ message: 'The response stream from the Claude API broke off.', cause: err instanceof Error ? err : undefined });
          // Before anything was sent, with no key on the client, the SDK had nothing to sign in with.
          if (err instanceof Anthropic.AnthropicError && (client.apiKey ?? null) === null && (client.authToken ?? null) === null) {
            throw new MissingCredentialsError(err.message);
          }
          throw err;
        }
        const next = err instanceof Anthropic.BadRequestError ? downgrade(rung, err) : null;
        if (!next) throw err;
        // A 400 comes before any content, so there should be nothing to take back. Be safe anyway.
        if (said && !silent) yield { event: 'reset', data: {} };
        rung = next;
      }
    }
  }

  /** Ask once for a corrected action after the app rejected an exercise. Returns a resolved action or null. */
  async function* correctAction(apiMessages, reply, errors, exercise, signal, usageBox) {
    const messages = [...apiMessages, { role: 'assistant', content: serializeReply(reply) }, { role: 'user', content: rejectionTurn(errors) }];
    const { message } = yield* streamTurn(messages, signal, { silent: true });
    usageBox.usage = mergeUsage(usageBox.usage, message?.usage ?? null);
    if (message?.stop_reason === 'refusal') return null;
    // Only the action of the second reply is used, so the rest of it does not have to be valid.
    const action = normalizeAction(parseFinal(message)?.action);
    if (!action) return null;
    const resolved = resolveAction(action, exercise);
    return resolved.problem ? null : resolved;
  }

  async function* coach({ messages, exercise = null, signal } = {}) {
    const started = now();
    let firstText = null;
    const elapsed = () => Math.max(0, Math.round(now() - started));
    const onFirstText = () => {
      if (firstText === null) firstText = elapsed();
    };

    try {
      const apiMessages = toApiMessages(Array.isArray(messages) ? messages : []);
      const { message, said } = yield* streamTurn(apiMessages, signal, { onFirstText });

      // Always look at stop_reason before the content: a refusal has empty or partial content.
      if (message?.stop_reason === 'refusal') {
        yield {
          event: 'error',
          data: { code: 'refusal', message: 'The model declined to answer this turn. Carry on playing, or word your message differently.', retryable: false },
        };
        return;
      }

      const parsed = parseFinal(message);
      const checked = validateReply(parsed);
      if (!checked.ok && (message?.stop_reason ?? null) === null) {
        // No stop reason and no complete reply: the stream broke off before the model finished.
        yield { event: 'error', data: { code: 'network', message: 'The connection to the Claude API dropped in the middle of the reply. Try again.', retryable: true } };
        return;
      }
      const reply = checked.ok ? checked.reply : salvageReply(parsed, said);
      if (!reply) {
        const why = message?.stop_reason === 'max_tokens' ? 'The reply was cut off before it was complete.' : 'The reply did not have the expected shape.';
        yield { event: 'error', data: { code: 'invalid_reply', message: `The coach's reply could not be read. ${why} Try again.`, retryable: true } };
        return;
      }
      if (!checked.ok) warnOnce(`invalid:${checked.errors.join('|')}`, `[coach] Reply did not match the expected shape (${checked.errors.join('; ')}). Kept what was usable.`);

      // The learner must end up with exactly the final "say", whatever the incremental extractor saw.
      if (reply.say !== said) {
        if (reply.say.startsWith(said)) {
          onFirstText();
          yield { event: 'say', data: { delta: reply.say.slice(said.length) } };
        } else {
          onFirstText();
          yield { event: 'reset', data: {} };
          yield { event: 'say', data: { delta: reply.say } };
        }
      }

      const usageBox = { usage: message?.usage ?? null };
      let resolved = resolveAction(reply.action, exercise);
      if (resolved.errors) {
        // The exercise did not build: one corrective request, and only its action is used.
        let corrected = null;
        try {
          corrected = yield* correctAction(apiMessages, reply, resolved.errors, exercise, signal, usageBox);
        } catch (err) {
          if (signal?.aborted) return;
          warnOnce('correction', `[coach] The follow-up request for a corrected exercise failed: ${err?.message}`);
        }
        resolved = corrected ?? { action: { type: 'none' }, spec: { type: 'none' } };
      }

      yield { event: 'action', data: { action: resolved.action } };
      const notes = notesText(reply.student_notes);
      if (notes !== null) yield { event: 'notes', data: { text: notes } };

      // Report the model that was configured, so the browser can price the usage, unless a
      // different model (a refusal fallback) produced the reply.
      const served = typeof message?.model === 'string' && message.model ? message.model : model;
      yield {
        event: 'done',
        data: {
          assistant: serializeReply({ say: reply.say, action: resolved.spec, student_notes: reply.student_notes }),
          usage: usageBox.usage,
          model: served.startsWith(model) ? model : served,
          ms: { firstText, total: elapsed() },
          mock: false,
        },
      };
    } catch (err) {
      if (signal?.aborted) return; // the learner went away: end quietly
      yield { event: 'error', data: mapError(err) };
    }
  }

  coach.mode = 'live';
  coach.model = model;
  coach.effort = effort;
  return coach;
}
