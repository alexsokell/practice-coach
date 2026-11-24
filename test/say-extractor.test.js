import test from 'node:test';
import assert from 'node:assert/strict';

import { SayExtractor, createSayExtractor } from '../server/say-extractor.js';

/** Feed the chunks and return every non-empty piece the extractor produced. */
function run(chunks) {
  const extractor = new SayExtractor();
  const pieces = [];
  for (const chunk of chunks) {
    const piece = extractor.push(chunk);
    assert.equal(typeof piece, 'string');
    if (piece) pieces.push(piece);
  }
  const tail = extractor.end();
  if (tail) pieces.push(tail);
  return { pieces, text: pieces.join(''), extractor };
}

const chars = (text) => Array.from({ length: text.length }, (_, i) => text[i]);

function splitAt(text, ...points) {
  const out = [];
  let from = 0;
  for (const point of points) {
    out.push(text.slice(from, point));
    from = point;
  }
  out.push(text.slice(from));
  return out;
}

/** Small deterministic PRNG so the random chunkings are repeatable. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomChunks(text, random) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const size = 1 + Math.floor(random() * 7);
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

const hasLoneSurrogate = (text) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);

const SAMPLE_REPLY = {
  say: 'Good: 13 of 15 clean. The two slips were at the thumb crossing, so loop steps 3 to 6 slowly.',
  action: { type: 'drill', from_step: 3, to_step: 6 },
  student_notes: null,
};
const SAMPLE = JSON.stringify(SAMPLE_REPLY);

// A reply that exercises every escape form. Built by hand so the raw text really contains the
// escapes (JSON.stringify would emit most of these characters unescaped).
const TRICKY_SAY = 'He said "slow", then C:\\keys\nnew line\ttab / slash \u00e9 \u266d piano \ud83c\udfb9 done\b\f\r.';
const TRICKY_RAW =
  '{"say":"He said \\"slow\\", then C:\\\\keys\\nnew line\\ttab \\/ slash \\u00e9 \\u266D piano \\ud83c\\udfb9 done\\b\\f\\r.",' +
  '"action":{"type":"none"},"student_notes":"say \\"nothing\\""}';

test('the hand-written tricky sample is valid JSON with the expected say', () => {
  assert.equal(JSON.parse(TRICKY_RAW).say, TRICKY_SAY);
});

test('whole reply in one chunk', () => {
  const { text, extractor } = run([SAMPLE]);
  assert.equal(text, SAMPLE_REPLY.say);
  assert.equal(extractor.text, SAMPLE_REPLY.say);
  assert.equal(extractor.done, true);
  assert.equal(extractor.finished, true);
});

test('one character at a time', () => {
  const { text, pieces } = run(chars(SAMPLE));
  assert.equal(text, SAMPLE_REPLY.say);
  assert.ok(pieces.length > 10, 'text is emitted incrementally, not at the end');
});

test('every split point of the sample reply', () => {
  for (let i = 0; i <= SAMPLE.length; i += 1) {
    assert.equal(run(splitAt(SAMPLE, i)).text, SAMPLE_REPLY.say, `split at ${i}`);
  }
});

test('every split point of the tricky reply (escapes cut anywhere)', () => {
  for (let i = 0; i <= TRICKY_RAW.length; i += 1) {
    const { text, pieces } = run(splitAt(TRICKY_RAW, i));
    assert.equal(text, TRICKY_SAY, `split at ${i}`);
    for (const piece of pieces) assert.equal(hasLoneSurrogate(piece), false, `lone surrogate at split ${i}`);
  }
});

test('every pair of split points of the tricky reply', () => {
  for (let i = 0; i <= TRICKY_RAW.length; i += 3) {
    for (let j = i; j <= TRICKY_RAW.length; j += 2) {
      assert.equal(run(splitAt(TRICKY_RAW, i, j)).text, TRICKY_SAY, `splits at ${i}, ${j}`);
    }
  }
});

test('tricky reply one character at a time never emits half a surrogate pair', () => {
  const { text, pieces } = run(chars(TRICKY_RAW));
  assert.equal(text, TRICKY_SAY);
  for (const piece of pieces) assert.equal(hasLoneSurrogate(piece), false);
  assert.ok(pieces.includes('\ud83c\udfb9'), 'the pair arrives as one piece');
});

test('random chunkings of several replies', () => {
  const random = mulberry32(20261124);
  const replies = [
    SAMPLE,
    TRICKY_RAW,
    JSON.stringify({ say: 'Tab\there, quote " and backslash \\ and unicode \u00fc\u4e2d \ud83d\ude00.', action: { type: 'none' }, student_notes: 'x' }),
    JSON.stringify({ action: { type: 'none' }, student_notes: null, say: 'Say comes last here.' }, null, 2),
  ];
  for (const raw of replies) {
    const expected = JSON.parse(raw).say;
    for (let n = 0; n < 300; n += 1) {
      const { text, pieces } = run(randomChunks(raw, random));
      assert.equal(text, expected);
      for (const piece of pieces) assert.equal(hasLoneSurrogate(piece), false);
    }
  }
});

test('simple escapes decode to the right characters', () => {
  const raw = '{"say":"a\\"b\\\\c\\/d\\be\\ff\\ng\\rh\\ti"}';
  assert.equal(run([raw]).text, 'a"b\\c/d\be\ff\ng\rh\ti');
  assert.equal(run(chars(raw)).text, JSON.parse(raw).say);
});

test('an escaped backslash before the closing quote does not hide the end of the string', () => {
  const raw = '{"say":"path C:\\\\","action":{"type":"none"},"student_notes":"later"}';
  const { text, extractor } = run(chars(raw));
  assert.equal(text, 'path C:\\');
  assert.equal(extractor.done, true);
});

test('unicode escapes, upper and lower case hex', () => {
  const raw = '{"say":"\\u0041\\u00e9\\u00C9\\u266d\\u4E2D"}';
  assert.equal(run([raw]).text, 'A\u00e9\u00c9\u266d\u4e2d');
  assert.equal(run(chars(raw)).text, 'A\u00e9\u00c9\u266d\u4e2d');
});

test('escaped surrogate pair split at every position', () => {
  const raw = '{"say":"x\\ud83c\\udfb9y"}';
  for (let i = 0; i <= raw.length; i += 1) {
    const { text, pieces } = run(splitAt(raw, i));
    assert.equal(text, 'x\ud83c\udfb9y', `split at ${i}`);
    for (const piece of pieces) assert.equal(hasLoneSurrogate(piece), false, `split at ${i}`);
  }
});

test('raw (unescaped) surrogate pair split between its halves is held together', () => {
  const raw = '{"say":"x\ud83c\udfb9y"}';
  const cut = raw.indexOf('\ud83c') + 1;
  const { text, pieces } = run(splitAt(raw, cut));
  assert.equal(text, 'x\ud83c\udfb9y');
  for (const piece of pieces) assert.equal(hasLoneSurrogate(piece), false);
});

test('two astral characters in a row', () => {
  const raw = '{"say":"\\ud83c\\udfb9\\ud83c\\udfb5 and \ud83d\ude00\ud83d\ude01"}';
  const { text, pieces } = run(chars(raw));
  assert.equal(text, '\ud83c\udfb9\ud83c\udfb5 and \ud83d\ude00\ud83d\ude01');
  for (const piece of pieces) assert.equal(hasLoneSurrogate(piece), false);
});

test('a lone high surrogate is still delivered, with the next character or at the end', () => {
  assert.equal(run(chars('{"say":"a\\ud83cb"}')).text, 'a\ud83cb');
  assert.equal(run(chars('{"say":"a\\ud83c"}')).text, 'a\ud83c');
  // Stream cut right after the high half: end() flushes it.
  const extractor = new SayExtractor();
  assert.equal(extractor.push('{"say":"a\\ud83c'), 'a');
  assert.equal(extractor.end(), '\ud83c');
  assert.equal(extractor.text, 'a\ud83c');
  assert.equal(extractor.end(), '');
});

test('invalid escapes never throw', () => {
  assert.equal(run(['{"say":"a\\u12G4b"}']).text, 'ab');
  assert.equal(run(['{"say":"a\\xb"}']).text, 'axb');
  assert.equal(run(chars('{"say":"a\\u12')).text, 'a');
});

test('say does not have to be the first key', () => {
  const variants = [
    '{"action":{"type":"none"},"say":"hello","student_notes":null}',
    '{"student_notes":"notes first","action":{"type":"none"},"say":"hello"}',
    '{"student_notes":null,"n":12.5e3,"flag":true,"other":false,"say":"hello"}',
    '{"list":[1,2,[3,{"a":"b"}]],"say":"hello"}',
  ];
  for (const raw of variants) {
    assert.equal(run([raw]).text, 'hello', raw);
    assert.equal(run(chars(raw)).text, 'hello', raw);
  }
});

test('a nested "say" key is ignored', () => {
  const raw =
    '{"action":{"type":"new_exercise","say":"not this","exercise":{"say":"nor this","steps":[{"say":"nor that"}]}},"say":"the real one","student_notes":null}';
  assert.equal(run([raw]).text, 'the real one');
  assert.equal(run(chars(raw)).text, 'the real one');
});

test('"say" inside a string value is ignored', () => {
  const raw = '{"student_notes":"she wrote \\"say\\": \\"x\\" and {\\"say\\":\\"y\\"}","say":"real","action":{"type":"none"}}';
  assert.equal(run([raw]).text, 'real');
  assert.equal(run(chars(raw)).text, 'real');
});

test('braces, brackets and quotes inside nested strings do not confuse the depth', () => {
  const raw = '{"action":{"type":"new_exercise","exercise":{"title":"a } ] \\" { [ b","goal":"}}}"}},"say":"after","student_notes":null}';
  assert.equal(JSON.parse(raw).say, 'after');
  assert.equal(run([raw]).text, 'after');
  assert.equal(run(chars(raw)).text, 'after');
});

test('a key that merely contains or resembles say is not matched', () => {
  const raw = '{"says":"no","say ":"no","Say":"no","essay":"no","say":"yes"}';
  assert.equal(run([raw]).text, 'yes');
});

test('an escaped key spelling still matches', () => {
  assert.equal(run(['{"s\\u0061y":"decoded key"}']).text, 'decoded key');
});

test('only the first top-level say is streamed', () => {
  assert.equal(run(['{"say":"first","say":"second"}']).text, 'first');
});

test('whitespace and pretty printing', () => {
  const raw = ' \n\t {\n  "say" :\n   "spaced out" ,\n  "action" : { "type" : "none" } ,\n  "student_notes" : null\n}\n';
  assert.equal(run([raw]).text, 'spaced out');
  assert.equal(run(chars(raw)).text, 'spaced out');
});

test('markdown code fence around the JSON (degraded mode)', () => {
  const fenced = '```json\n' + SAMPLE + '\n```\n';
  assert.equal(run([fenced]).text, SAMPLE_REPLY.say);
  assert.equal(run(chars(fenced)).text, SAMPLE_REPLY.say);
  const plainFence = '```\n' + SAMPLE + '\n```';
  assert.equal(run(chars(plainFence)).text, SAMPLE_REPLY.say);
  for (let i = 0; i <= fenced.length; i += 1) {
    assert.equal(run(splitAt(fenced, i)).text, SAMPLE_REPLY.say, `split at ${i}`);
  }
});

test('text after the closing brace is ignored', () => {
  const raw = SAMPLE + '\n```\n{"say":"second object"}';
  const { text, extractor } = run(chars(raw));
  assert.equal(text, SAMPLE_REPLY.say);
  assert.equal(extractor.finished, true);
});

test('a say value that is not a string yields nothing', () => {
  for (const raw of ['{"say":null,"x":"y"}', '{"say":12,"x":"y"}', '{"say":{"say":"nested"},"x":"y"}', '{"say":["a","b"]}', '{"say":true}']) {
    const { text, extractor } = run(chars(raw));
    assert.equal(text, '', raw);
    assert.equal(extractor.done, true, raw);
  }
});

test('empty say and empty object', () => {
  const empty = run(['{"say":"","action":{"type":"none"}}']);
  assert.equal(empty.text, '');
  assert.equal(empty.extractor.done, true);
  const none = run(['{}']);
  assert.equal(none.text, '');
  assert.equal(none.extractor.done, false);
  assert.equal(none.extractor.finished, true);
});

test('truncated replies give what was decoded so far', () => {
  const cut = SAMPLE.slice(0, SAMPLE.indexOf('thumb'));
  const { text, extractor } = run(chars(cut));
  assert.equal(text, SAMPLE_REPLY.say.slice(0, SAMPLE_REPLY.say.indexOf('thumb')));
  assert.equal(extractor.done, false);
  assert.equal(extractor.finished, false);
});

test('text that is not JSON at all yields nothing and does not throw', () => {
  for (const raw of ['', 'Sorry, I cannot help with that.', '[1,2,3]', '"say"', 'say: hello', '\u0000\u0001', '}}}}', ']]"say":"x"']) {
    assert.equal(run(chars(raw)).text, '', JSON.stringify(raw));
  }
});

test('non-string chunks are ignored', () => {
  const extractor = new SayExtractor();
  assert.equal(extractor.push(undefined), '');
  assert.equal(extractor.push(null), '');
  assert.equal(extractor.push(42), '');
  assert.equal(extractor.push({}), '');
  assert.equal(extractor.push(''), '');
  assert.equal(extractor.push('{"say":"ok"}'), 'ok');
});

test('push returns only the new characters each time', () => {
  const extractor = new SayExtractor();
  assert.equal(extractor.push('{"sa'), '');
  assert.equal(extractor.push('y":"He'), 'He');
  assert.equal(extractor.push('llo\\'), 'llo');
  assert.equal(extractor.push('n'), '\n');
  assert.equal(extractor.push('wor'), 'wor');
  assert.equal(extractor.done, false);
  assert.equal(extractor.push('ld","action"'), 'ld');
  assert.equal(extractor.done, true);
  assert.equal(extractor.push(':{"type":"none"}}'), '');
  assert.equal(extractor.text, 'Hello\nworld');
});

test('reset starts over cleanly, even from the middle of an escape', () => {
  const extractor = createSayExtractor();
  assert.equal(extractor.push('{"say":"first reply \\u00'), 'first reply ');
  extractor.reset();
  assert.equal(extractor.text, '');
  assert.equal(extractor.done, false);
  assert.equal(extractor.push('{"say":"second"}'), 'second');
  assert.equal(extractor.text, 'second');
  extractor.reset();
  assert.equal(extractor.push('{"action":{"type":"none"},"say":"third \\ud83c'), 'third ');
  extractor.reset();
  assert.equal(extractor.push('{"say":"\\udfb9 fourth"}'), '\udfb9 fourth');
});

test('long reply fed in tiny chunks matches JSON.parse', () => {
  const say = Array.from({ length: 400 }, (_, i) => `Sentence ${i} with "quotes" and \\ slashes\n`).join('');
  const raw = JSON.stringify({ say, action: { type: 'none' }, student_notes: null });
  assert.equal(run(chars(raw)).text, say);
  assert.equal(run(randomChunks(raw, mulberry32(7))).text, say);
});
