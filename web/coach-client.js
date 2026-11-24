// Talks to POST /api/coach and turns its Server-Sent Events into callbacks.

/**
 * @typedef {Object} CoachHandlers
 * @property {(delta: string) => void} [onSay]
 * @property {() => void} [onReset]
 * @property {(action: object) => void} [onAction]
 * @property {(text: string) => void} [onNotes]
 * @property {(done: object) => void} [onDone]
 * @property {(error: {code: string, message: string, retryable: boolean}) => void} [onError]
 */

/**
 * Send one coach turn and stream the reply. Resolves when the stream ends.
 * Exactly one of onDone / onError is called, unless the request was aborted.
 * @param {{messages: {role: string, content: string}[], exercise: object|null}} body
 * @param {CoachHandlers} handlers
 * @param {{signal?: AbortSignal}} [options]
 */
export async function streamCoach(body, handlers, { signal } = {}) {
  let finished = false;
  const fail = (code, message, retryable = true) => {
    if (finished) return;
    finished = true;
    handlers.onError?.({ code, message, retryable });
  };

  let response;
  try {
    response = await fetch('/api/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    fail('network', 'Cannot reach the Practice Coach server. Is it still running?');
    return;
  }

  if (!response.ok || !response.body) {
    let message = `The server answered with an error (${response.status}).`;
    try {
      const data = await response.json();
      if (data?.error) message = String(data.error);
    } catch {
      // keep the generic message
    }
    fail(response.status === 429 ? 'too_many_requests' : 'server', message, response.status >= 500 || response.status === 429);
    return;
  }

  const dispatch = (event, data) => {
    switch (event) {
      case 'say':
        if (typeof data?.delta === 'string') handlers.onSay?.(data.delta);
        break;
      case 'reset':
        handlers.onReset?.();
        break;
      case 'action':
        if (data?.action) handlers.onAction?.(data.action);
        break;
      case 'notes':
        if (typeof data?.text === 'string') handlers.onNotes?.(data.text);
        break;
      case 'done':
        if (!finished) {
          finished = true;
          handlers.onDone?.(data ?? {});
        }
        break;
      case 'error':
        fail(data?.code ?? 'server', data?.message ?? 'The coach hit an error.', Boolean(data?.retryable));
        break;
      default:
        break;
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const parsed = parseEventBlock(block);
        if (parsed) dispatch(parsed.event, parsed.data);
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    fail('network', 'The connection to the coach dropped mid-reply.');
    return;
  }
  fail('network', 'The coach reply was cut off before it finished.');
}

/** Parse one SSE block ("event: x\ndata: {...}"). Returns null for comments and keep-alives. */
export function parseEventBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (!dataLines.length) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

export async function fetchHealth() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
