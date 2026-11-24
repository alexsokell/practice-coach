// Incremental extractor for the top-level "say" string of a streaming JSON reply.
//
// The coach's whole reply is one JSON object: {"say": "...", "action": {...}, "student_notes": null}.
// The learner should hear "say" while the rest is still being generated, so the server feeds every
// text delta from the model into this state machine and forwards only the newly decoded characters
// of the "say" value.
//
// It is a small streaming JSON scanner, not a full parser:
// - it does not need "say" to be the first key,
// - it ignores a "say" key nested inside another object or array, and "say" inside any string,
// - it decodes JSON escapes, including \uXXXX and surrogate pairs, with a chunk boundary anywhere,
// - it skips anything before the first "{" (whitespace, or a markdown code fence in degraded mode),
// - it never throws: malformed input just yields less text. The caller compares the streamed text
//   with the parsed reply at the end and corrects the difference.

const HEX = /^[0-9a-fA-F]{4}$/;
const SIMPLE_ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

// Scanner positions inside the top-level object.
const BEFORE_OBJECT = 0; // nothing but noise seen so far
const EXPECT_KEY = 1; // after "{" or ",": a key string or "}"
const EXPECT_COLON = 2; // after a key
const EXPECT_VALUE = 3; // after ":"
const AFTER_VALUE = 4; // after a value: "," or "}"
const IN_PRIMITIVE = 5; // inside a top-level number / true / false / null
const NESTED = 6; // inside a nested object or array (depth > 1)
const FINISHED = 7; // the top-level object was closed

const isHighSurrogate = (code) => code >= 0xd800 && code <= 0xdbff;

export class SayExtractor {
  constructor() {
    this.reset();
  }

  /** Forget everything and wait for a new reply. */
  reset() {
    this.where = BEFORE_OBJECT;
    this.depth = 0; // open containers, the top-level object counts as 1
    /** @type {null|'key'|'say'|'skip'} */
    this.string = null; // which kind of string we are inside, if any
    this.resume = AFTER_VALUE; // where to continue after the current string closes
    this.escape = 0; // 0 = none, 1 = just saw a backslash, 2 = reading the hex digits of \uXXXX
    this.hex = '';
    this.key = ''; // the top-level key being read, then the last one read
    this.heldHigh = ''; // a decoded high surrogate waiting for its low half
    this.sayText = '';
    this.sayStarted = false;
    this.sayDone = false;
  }

  /** Everything decoded from "say" so far. */
  get text() {
    return this.sayText;
  }

  /** True once the closing quote of the "say" value was seen (or its value was not a string). */
  get done() {
    return this.sayDone;
  }

  /** True once the whole top-level object was closed. */
  get finished() {
    return this.where === FINISHED;
  }

  /**
   * Feed the next piece of the raw reply.
   * @param {string} chunk
   * @returns {string} the newly decoded characters of the "say" value ('' when there are none)
   */
  push(chunk) {
    if (typeof chunk !== 'string' || chunk.length === 0) return '';
    let out = '';
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      if (this.string !== null) {
        out += this.#inString(ch);
        continue;
      }
      this.#outside(ch);
    }
    if (out) this.sayText += out;
    return out;
  }

  /**
   * Call when the stream is over. Returns a held half of a surrogate pair, if the text stopped
   * right after one ('' otherwise).
   * @returns {string}
   */
  end() {
    const out = this.heldHigh;
    this.heldHigh = '';
    if (out) this.sayText += out;
    return out;
  }

  /** One character while inside a string. Returns decoded "say" text to emit. */
  #inString(ch) {
    if (this.escape === 1) {
      this.escape = 0;
      if (ch === 'u') {
        this.escape = 2;
        this.hex = '';
        return '';
      }
      // An unknown escape is invalid JSON: keep the character itself and carry on.
      return this.#decoded(SIMPLE_ESCAPES[ch] ?? ch);
    }
    if (this.escape === 2) {
      this.hex += ch;
      if (this.hex.length < 4) return '';
      this.escape = 0;
      const hex = this.hex;
      this.hex = '';
      // Invalid hex digits cannot be decoded: drop the escape.
      return HEX.test(hex) ? this.#decoded(String.fromCharCode(parseInt(hex, 16))) : '';
    }
    if (ch === '\\') {
      this.escape = 1;
      return '';
    }
    if (ch === '"') return this.#closeString();
    return this.#decoded(ch);
  }

  /** A decoded character of the current string. Returns "say" text to emit. */
  #decoded(ch) {
    if (this.string === 'key') {
      if (this.key.length < 64) this.key += ch;
      return '';
    }
    if (this.string !== 'say') return '';
    // Never emit half of a surrogate pair: hold the high half until the low half arrives.
    if (this.heldHigh) {
      const held = this.heldHigh;
      this.heldHigh = '';
      if (isHighSurrogate(ch.charCodeAt(0))) {
        this.heldHigh = ch;
        return held;
      }
      return held + ch;
    }
    if (isHighSurrogate(ch.charCodeAt(0))) {
      this.heldHigh = ch;
      return '';
    }
    return ch;
  }

  #closeString() {
    const kind = this.string;
    this.string = null;
    this.where = this.resume;
    if (kind !== 'say') return '';
    this.sayDone = true;
    const out = this.heldHigh;
    this.heldHigh = '';
    return out;
  }

  /** One character while outside any string. */
  #outside(ch) {
    switch (this.where) {
      case BEFORE_OBJECT:
        if (ch === '{') {
          this.depth = 1;
          this.where = EXPECT_KEY;
        }
        return;
      case EXPECT_KEY:
        if (ch === '"') {
          this.string = 'key';
          this.key = '';
          this.resume = EXPECT_COLON;
        } else if (ch === '}') {
          this.#closeTop();
        }
        return;
      case EXPECT_COLON:
        if (ch === ':') this.where = EXPECT_VALUE;
        return;
      case EXPECT_VALUE:
        this.#valueStart(ch);
        return;
      case IN_PRIMITIVE:
      case AFTER_VALUE:
        if (ch === ',') this.where = EXPECT_KEY;
        else if (ch === '}') this.#closeTop();
        return;
      case NESTED:
        if (ch === '"') {
          this.string = 'skip';
          this.resume = NESTED;
        } else if (ch === '{' || ch === '[') {
          this.depth += 1;
        } else if (ch === '}' || ch === ']') {
          this.depth -= 1;
          if (this.depth <= 1) {
            this.depth = 1;
            this.where = AFTER_VALUE;
          }
        }
        return;
      default:
        return; // FINISHED: ignore whatever follows (a closing code fence, stray text)
    }
  }

  /** First character of a top-level value. */
  #valueStart(ch) {
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') return;
    const wanted = this.key === 'say' && !this.sayStarted;
    if (ch === '"') {
      this.string = wanted ? 'say' : 'skip';
      if (wanted) this.sayStarted = true;
      this.resume = AFTER_VALUE;
      return;
    }
    if (wanted) {
      // "say" holds something that is not a string: there is nothing to stream.
      this.sayStarted = true;
      this.sayDone = true;
    }
    if (ch === '{' || ch === '[') {
      this.depth = 2;
      this.where = NESTED;
    } else if (ch === '}') {
      this.#closeTop();
    } else if (ch === ',') {
      this.where = EXPECT_KEY;
    } else {
      this.where = IN_PRIMITIVE;
    }
  }

  #closeTop() {
    this.depth = 0;
    this.where = FINISHED;
  }
}

/** @returns {SayExtractor} */
export function createSayExtractor() {
  return new SayExtractor();
}
