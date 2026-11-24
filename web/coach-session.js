// The conversation with the coach: one request at a time, a small queue,
// the visible chat log, and optional text-to-speech.

import { streamCoach } from './coach-client.js';

const MAX_MESSAGES = 60; // trim the transcript once it grows past this
const KEEP_MESSAGES = 30; // ...down to this many recent turns (even, so it starts with a user turn)
const MIN_GAP_MS = 1200; // spend guard: never fire coach requests back to back
const MAX_LOG = 120;
const COALESCED = new Set(['attempt', 'free_play', 'hint', 'next']);

/** Speaks the coach's reply sentence by sentence while it streams in. */
export class Speaker {
  constructor() {
    this.supported = typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
    this.enabled = false;
    this.buffer = '';
  }

  setEnabled(on) {
    this.enabled = Boolean(on) && this.supported;
    if (!this.enabled) this.cancel();
  }

  feed(delta) {
    if (!this.enabled) return;
    this.buffer += delta;
    for (;;) {
      // A sentence ends at . ! or ? followed by whitespace ("0.5" and "C4." mid-stream stay intact).
      const match = /[.!?]["')\]]?\s+/.exec(this.buffer);
      if (!match) break;
      const end = match.index + match[0].length;
      this.#speak(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
    }
  }

  flush() {
    if (this.enabled && this.buffer.trim()) this.#speak(this.buffer);
    this.buffer = '';
  }

  cancel() {
    this.buffer = '';
    if (this.supported) speechSynthesis.cancel();
  }

  #speak(text) {
    const spoken = text
      .replace(/\b([A-G])#/g, '$1 sharp ')
      .replace(/\b([A-G])b(?=\d|\b)/g, '$1 flat ')
      .replace(/\bbpm\b/gi, 'beats per minute')
      .trim();
    if (!spoken) return;
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.lang = 'en-US';
    utterance.rate = 1.05;
    speechSynthesis.speak(utterance);
  }
}

export class CoachSession {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.logEl            where chat bubbles go
   * @param {() => {messages: object[], log: object[]}} options.getSession   live session object (mutated in place)
   * @param {() => object|null} options.getExercise     the exercise loaded right now
   * @param {() => string} options.buildPreamble        session-start text used when the transcript is trimmed
   * @param {(action: object, event: object) => string|null} options.onAction   apply an action (event = the request it answers), return a label to show (or null)
   * @param {(text: string) => void} options.onNotes
   * @param {(done: object) => void} options.onDone
   * @param {() => void} options.onChange            persist
   * @param {Speaker} options.speaker
   */
  constructor({ logEl, getSession, getExercise, buildPreamble, onAction, onNotes, onDone, onChange, speaker }) {
    this.logEl = logEl;
    this.getSession = getSession;
    this.getExercise = getExercise;
    this.buildPreamble = buildPreamble;
    this.onAction = onAction;
    this.onNotes = onNotes;
    this.onDone = onDone;
    this.onChange = onChange;
    this.speaker = speaker;
    this.queue = [];
    this.busy = false;
    this.abort = null;
    this.lastSentAt = 0;
    this.timer = null;
    this.generation = 0; // bumped by reset() so late callbacks from an old request are ignored
  }

  get idle() {
    return !this.busy && this.queue.length === 0;
  }

  /** Drop everything in flight and clear the visible log (new session or data reset). */
  reset() {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    this.queue = [];
    this.busy = false;
    clearTimeout(this.timer);
    this.speaker.cancel();
    this.logEl.replaceChildren();
  }

  /** Re-draw a saved log after a page reload. */
  restore(log) {
    this.logEl.replaceChildren();
    for (const entry of log ?? []) this.#draw(entry);
    this.#scroll();
  }

  /**
   * Queue one event for the coach.
   * @param {{kind: string, text: string, label?: string|null, you?: string|null, exercise?: object|null}} event
   *   text: the rendered user turn; label: a small centered note in the log; you: a chat bubble from the learner.
   */
  enqueue(event) {
    if (!event?.text) return;
    if (COALESCED.has(event.kind)) {
      this.queue = this.queue.filter((queued) => queued.kind !== event.kind);
    }
    if (event.exercise === undefined) event.exercise = this.getExercise();
    this.queue.push(event);
    this.#pump();
  }

  /** Drop events still waiting in the queue (not the one in flight) that match the test. */
  discardQueued(predicate) {
    this.queue = this.queue.filter((event) => !predicate(event));
  }

  #pump() {
    if (this.busy || !this.queue.length) return;
    const wait = this.lastSentAt + MIN_GAP_MS - Date.now();
    if (wait > 0) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.#pump(), wait);
      return;
    }
    this.#send(this.queue.shift());
  }

  async #send(event) {
    this.busy = true;
    this.lastSentAt = Date.now();
    const generation = this.generation;
    const session = this.getSession();
    const current = () => generation === this.generation;

    if (event.you) this.#log({ type: 'you', text: event.you });
    else if (event.label) this.#log({ type: 'event', text: event.label });

    session.messages.push({ role: 'user', content: event.text });
    const bubble = this.#bubble('coach', '');
    bubble.classList.add('is-streaming');
    let said = '';
    let actionLabel = null;
    this.speaker.cancel();
    this.abort = new AbortController();

    await streamCoach(
      { messages: session.messages, exercise: event.exercise ?? null },
      {
        onSay: (delta) => {
          if (!current()) return;
          said += delta;
          bubble.firstChild.textContent = said;
          this.speaker.feed(delta);
          this.#scroll();
        },
        onReset: () => {
          if (!current()) return;
          said = '';
          bubble.firstChild.textContent = '';
          this.speaker.cancel();
        },
        onAction: (action) => {
          if (!current()) return;
          actionLabel = this.onAction(action, event) ?? null;
        },
        onNotes: (text) => {
          if (current()) this.onNotes(text);
        },
        onDone: (done) => {
          if (!current()) return;
          bubble.classList.remove('is-streaming');
          this.speaker.flush();
          const assistant =
            typeof done.assistant === 'string' && done.assistant
              ? done.assistant
              : JSON.stringify({ say: said, action: { type: 'none' }, student_notes: null });
          session.messages.push({ role: 'assistant', content: assistant });
          if (said.trim()) {
            if (actionLabel) this.#attachAction(bubble, actionLabel);
            this.#remember({ type: 'coach', text: said, action: actionLabel });
          } else {
            bubble.remove();
          }
          this.#trim(session);
          this.onDone(done);
        },
        onError: (error) => {
          if (!current()) return;
          // Take the unanswered user turn back out so the transcript keeps alternating.
          if (session.messages.at(-1)?.role === 'user') session.messages.pop();
          bubble.remove();
          this.speaker.cancel();
          this.#error(error, event);
        },
      },
      { signal: this.abort.signal },
    );

    if (!current()) return;
    this.busy = false;
    this.abort = null;
    this.onChange();
    this.#pump();
  }

  /** Keep the transcript bounded: replace old turns with a fresh session preamble. */
  #trim(session) {
    if (session.messages.length <= MAX_MESSAGES) return;
    const recent = session.messages.slice(-KEEP_MESSAGES);
    session.messages.length = 0;
    session.messages.push(
      { role: 'user', content: `${this.buildPreamble()}\n(Earlier turns of this session were trimmed to save space.)` },
      {
        role: 'assistant',
        content: JSON.stringify({ say: 'Got it. Carrying on from where we were.', action: { type: 'none' }, student_notes: null }),
      },
      ...recent,
    );
  }

  #error(error, event) {
    const row = document.createElement('div');
    row.className = 'msg msg-error';
    const text = document.createElement('span');
    text.textContent = error.message || 'The coach could not answer.';
    row.append(text);
    if (error.retryable && event.kind !== 'hint') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-small';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => {
        row.remove();
        this.enqueue({ ...event, label: null, you: null });
      });
      row.append(retry);
    }
    this.logEl.append(row);
    this.#scroll();
  }

  #log(entry) {
    this.#draw(entry);
    this.#remember(entry);
    this.#scroll();
  }

  #remember(entry) {
    const session = this.getSession();
    session.log.push(entry);
    if (session.log.length > MAX_LOG) session.log.splice(0, session.log.length - MAX_LOG);
  }

  #draw(entry) {
    const bubble = this.#bubble(entry.type, entry.text);
    if (entry.action) this.#attachAction(bubble, entry.action);
  }

  #bubble(type, text) {
    const el = document.createElement('div');
    el.className = `msg msg-${type}`;
    el.append(document.createTextNode(text));
    this.logEl.append(el);
    return el;
  }

  #attachAction(bubble, label) {
    const tag = document.createElement('span');
    tag.className = 'msg-action';
    tag.textContent = label;
    bubble.append(tag);
  }

  #scroll() {
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}
