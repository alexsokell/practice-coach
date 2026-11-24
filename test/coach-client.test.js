import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEventBlock, streamCoach } from '../web/coach-client.js';

test('parseEventBlock reads event and JSON data', () => {
  assert.deepEqual(parseEventBlock('event: say\ndata: {"delta":"Hi"}'), { event: 'say', data: { delta: 'Hi' } });
});

test('parseEventBlock joins multi-line data and ignores comments', () => {
  const block = ': ping\nevent: done\ndata: {"a":\ndata: 1}';
  assert.deepEqual(parseEventBlock(block), { event: 'done', data: { a: 1 } });
});

test('parseEventBlock returns null for keep-alives and bad JSON', () => {
  assert.equal(parseEventBlock(': keep-alive'), null);
  assert.equal(parseEventBlock('event: say\ndata: {oops'), null);
  assert.equal(parseEventBlock(''), null);
});

/** Build a fetch stand-in that streams the given chunks as an SSE body. */
function fakeFetch(chunks, { status = 200 } = {}) {
  return async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }),
      { status, headers: { 'Content-Type': 'text/event-stream' } },
    );
}

async function run(chunks, options) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch(chunks, options);
  try {
    await streamCoach(
      { messages: [{ role: 'user', content: 'x' }], exercise: null },
      {
        onSay: (delta) => calls.push(['say', delta]),
        onReset: () => calls.push(['reset']),
        onAction: (action) => calls.push(['action', action.type]),
        onNotes: (text) => calls.push(['notes', text]),
        onDone: (done) => calls.push(['done', done.assistant]),
        onError: (error) => calls.push(['error', error.code]),
      },
    );
  } finally {
    globalThis.fetch = original;
  }
  return calls;
}

test('streamCoach dispatches events even when they are split across chunks', async () => {
  const stream =
    'event: say\ndata: {"delta":"Nice "}\n\n' +
    'event: say\ndata: {"delta":"work."}\n\n' +
    ': ping\n\n' +
    'event: action\ndata: {"action":{"type":"none"}}\n\n' +
    'event: notes\ndata: {"text":"steady"}\n\n' +
    'event: done\ndata: {"assistant":"{}"}\n\n';
  for (const size of [1, 7, 64, stream.length]) {
    const chunks = [];
    for (let i = 0; i < stream.length; i += size) chunks.push(stream.slice(i, i + size));
    assert.deepEqual(await run(chunks), [
      ['say', 'Nice '],
      ['say', 'work.'],
      ['action', 'none'],
      ['notes', 'steady'],
      ['done', '{}'],
    ]);
  }
});

test('streamCoach handles CRLF line endings', async () => {
  const calls = await run(['event: say\r\ndata: {"delta":"a"}\r\n\r\nevent: done\r\ndata: {}\r\n\r\n']);
  assert.deepEqual(calls, [['say', 'a'], ['done', undefined]]);
});

test('streamCoach reports a cut-off stream as a retryable error', async () => {
  const calls = await run(['event: say\ndata: {"delta":"a"}\n\n']);
  assert.deepEqual(calls, [['say', 'a'], ['error', 'network']]);
});

test('streamCoach reports the server error event and stops there', async () => {
  const calls = await run(['event: error\ndata: {"code":"auth","message":"bad key","retryable":false}\n\n']);
  assert.deepEqual(calls, [['error', 'auth']]);
});

test('streamCoach surfaces non-200 responses', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'messages must alternate' }), { status: 400 });
  const calls = [];
  try {
    await streamCoach({ messages: [], exercise: null }, { onError: (error) => calls.push([error.code, error.message, error.retryable]) });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(calls, [['server', 'messages must alternate', false]]);
});
