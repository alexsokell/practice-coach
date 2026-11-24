// On-screen piano keyboard: shows what is being played, what to play next,
// and doubles as a touch/mouse instrument when no piano is connected.

import { isBlackKey, midiToName, pitchClass, PIANO_LOW, PIANO_HIGH } from '../../shared/midi.js';

const MIN_KEY_WIDTH = 26; // px per white key before the strip starts to scroll

export class Keyboard {
  /**
   * @param {HTMLElement} container
   * @param {{low?: number, high?: number, onNoteOn?: (midi: number) => void, onNoteOff?: (midi: number) => void}} [options]
   */
  constructor(container, { low = 48, high = 84, onNoteOn = null, onNoteOff = null } = {}) {
    this.container = container;
    this.onNoteOn = onNoteOn;
    this.onNoteOff = onNoteOff;
    this.keys = new Map(); // midi -> element
    this.pointers = new Map(); // pointerId -> midi
    this.targets = [];
    this.showNames = false;
    this.low = low;
    this.high = high;

    container.classList.add('kb');
    this.inner = document.createElement('div');
    this.inner.className = 'kb-inner';
    container.replaceChildren(this.inner);

    this.inner.addEventListener('pointerdown', (e) => this.#pointerDown(e));
    this.inner.addEventListener('pointermove', (e) => this.#pointerMove(e));
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
      this.inner.addEventListener(type, (e) => this.#pointerUp(e));
    }
    this.inner.addEventListener('contextmenu', (e) => e.preventDefault());

    this.resizeObserver = new ResizeObserver(() => this.#layout());
    this.resizeObserver.observe(container);
    this.setRange(low, high);
  }

  /** Show keys from `low` to `high` (widened to whole white keys, clamped to the 88-key range). */
  setRange(low, high) {
    low = Math.max(PIANO_LOW, Math.min(low, PIANO_HIGH));
    high = Math.max(PIANO_LOW, Math.min(high, PIANO_HIGH));
    if (high < low) [low, high] = [high, low];
    while (isBlackKey(low) && low > PIANO_LOW) low -= 1;
    while (isBlackKey(high) && high < PIANO_HIGH) high += 1;
    if (low === this.low && high === this.high && this.keys.size) return;
    this.low = low;
    this.high = high;
    this.#build();
  }

  /** Fit the range around a set of notes with some room on both sides (at least two octaves). */
  fitTo(midiNotes, { pad = 4, minSpan = 24 } = {}) {
    if (!midiNotes.length) return;
    let low = Math.min(...midiNotes) - pad;
    let high = Math.max(...midiNotes) + pad;
    const missing = minSpan - (high - low);
    if (missing > 0) {
      low -= Math.floor(missing / 2);
      high += Math.ceil(missing / 2);
    }
    // Snap to octave edges so the picture is stable from one exercise to the next.
    low = Math.floor(low / 12) * 12;
    high = Math.ceil((high + 1) / 12) * 12;
    this.setRange(low, high);
  }

  shift(semitones) {
    const span = this.high - this.low;
    let low = this.low + semitones;
    low = Math.max(PIANO_LOW, Math.min(low, PIANO_HIGH - span));
    this.setRange(low, low + span);
  }

  setShowNames(show) {
    this.showNames = Boolean(show);
    this.container.classList.toggle('kb-names', this.showNames);
  }

  /**
   * Mark a key as held (or released). `verdict` colors it: 'ok', 'bad' or null for neutral.
   */
  setDown(midi, down, verdict = null) {
    const el = this.keys.get(midi);
    if (!el) return;
    el.classList.toggle('is-down', down);
    el.classList.toggle('is-ok', down && verdict === 'ok');
    el.classList.toggle('is-bad', down && verdict === 'bad');
  }

  /** Briefly color a key, for hints and for the demo playback. */
  flash(midi, cls = 'is-hint', ms = 600) {
    const el = this.keys.get(midi);
    if (!el) return;
    el.classList.add(cls);
    setTimeout(() => el.classList.remove(cls), ms);
  }

  /**
   * Highlight the keys to play next.
   * @param {{midi: number, finger?: number|null, hand?: 'L'|'R'}[]} targets
   */
  setTargets(targets) {
    for (const t of this.targets) {
      const el = this.keys.get(t.midi);
      if (!el) continue;
      el.classList.remove('is-target', 'hand-l', 'hand-r');
      el.querySelector('.kb-finger')?.remove();
    }
    this.targets = targets ?? [];
    for (const t of this.targets) {
      const el = this.keys.get(t.midi);
      if (!el) continue;
      el.classList.add('is-target', t.hand === 'L' ? 'hand-l' : 'hand-r');
      const dot = document.createElement('span');
      dot.className = 'kb-finger';
      dot.textContent = t.finger ? String(t.finger) : '';
      el.append(dot);
    }
    if (this.targets.length) this.#scrollIntoView(this.targets.map((t) => t.midi));
  }

  releaseAll() {
    for (const el of this.keys.values()) el.classList.remove('is-down', 'is-ok', 'is-bad');
  }

  destroy() {
    this.resizeObserver.disconnect();
    this.container.replaceChildren();
  }

  #build() {
    const held = [...this.keys].filter(([, el]) => el.classList.contains('is-down')).map(([m]) => m);
    this.keys.clear();
    const frag = document.createDocumentFragment();
    let whiteIndex = 0;
    for (let midi = this.low; midi <= this.high; midi += 1) {
      const el = document.createElement('div');
      const black = isBlackKey(midi);
      el.className = black ? 'kb-key kb-black' : 'kb-key kb-white';
      el.dataset.midi = String(midi);
      if (black) {
        el.style.setProperty('--i', String(whiteIndex));
      } else {
        el.style.setProperty('--i', String(whiteIndex));
        whiteIndex += 1;
        const label = document.createElement('span');
        label.className = pitchClass(midi) === 0 ? 'kb-label kb-label-c' : 'kb-label';
        label.textContent = pitchClass(midi) === 0 ? midiToName(midi) : midiToName(midi, { octave: false });
        el.append(label);
        if (midi === 60) el.classList.add('kb-middle-c');
      }
      this.keys.set(midi, el);
      frag.append(el);
    }
    this.whiteCount = whiteIndex;
    this.inner.replaceChildren(frag);
    this.#layout();
    for (const midi of held) this.setDown(midi, true);
    const targets = this.targets;
    this.targets = [];
    this.setTargets(targets);
  }

  #layout() {
    const width = this.container.clientWidth;
    if (!width || !this.whiteCount) return;
    const keyWidth = Math.max(MIN_KEY_WIDTH, width / this.whiteCount);
    this.inner.style.setProperty('--kw', `${keyWidth}px`);
    this.inner.style.width = `${keyWidth * this.whiteCount}px`;
  }

  #scrollIntoView(midiNotes) {
    const els = midiNotes.map((m) => this.keys.get(m)).filter(Boolean);
    if (!els.length) return;
    const box = this.container;
    if (box.scrollWidth <= box.clientWidth) return;
    const left = Math.min(...els.map((el) => el.offsetLeft));
    const right = Math.max(...els.map((el) => el.offsetLeft + el.offsetWidth));
    const margin = 60;
    if (left < box.scrollLeft + margin || right > box.scrollLeft + box.clientWidth - margin) {
      const center = (left + right) / 2 - box.clientWidth / 2;
      box.scrollTo({ left: Math.max(0, center), behavior: 'smooth' });
    }
  }

  #keyAt(event) {
    const el = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.kb-key');
    if (!el || !this.inner.contains(el)) return null;
    return Number(el.dataset.midi);
  }

  #pointerDown(event) {
    if (event.button !== undefined && event.button > 0) return;
    const midi = this.#keyAt(event);
    if (midi === null) return;
    event.preventDefault();
    this.pointers.set(event.pointerId, midi);
    this.onNoteOn?.(midi);
  }

  #pointerMove(event) {
    if (!this.pointers.has(event.pointerId)) return;
    const previous = this.pointers.get(event.pointerId);
    const midi = this.#keyAt(event);
    if (midi === previous || midi === null) return;
    this.onNoteOff?.(previous);
    this.pointers.set(event.pointerId, midi);
    this.onNoteOn?.(midi);
  }

  #pointerUp(event) {
    if (!this.pointers.has(event.pointerId)) return;
    const midi = this.pointers.get(event.pointerId);
    this.pointers.delete(event.pointerId);
    this.onNoteOff?.(midi);
  }
}
