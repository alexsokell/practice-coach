// Notation renderer: draws an exercise as readable sheet music in SVG, one column per
// step, with note names and finger numbers. No fonts or libraries are needed for the
// music symbols: clefs, note heads and accidentals are drawn as shapes.
//
// Colors come from CSS (web/ui/staff.css) through the classes set here.

import { midiToName, parseNoteName } from '../../shared/midi.js';

const NS = 'http://www.w3.org/2000/svg';
const LETTER_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const SPACE = 10; // distance between two staff lines, in viewBox units
const HALF = SPACE / 2;
const HEAD_RX = 5.7;
const HEAD_SHIFT = 10.6; // sideways shift of a head displaced for an interval of a second
const STEM = 31;
const SCALE_WIDE = 1.25; // CSS pixels per viewBox unit
const SCALE_NARROW = 1.05; // phones: fit more notes on screen
// Staff positions are diatonic steps counted from C0: C4 (middle C) = 28.
const CLEFS = {
  treble: { bottom: 30, top: 38, middle: 34 }, // lines E4 G4 B4 D5 F5
  bass: { bottom: 18, top: 26, middle: 22 }, // lines G2 B2 D3 F3 A3
};
const STATES = ['pending', 'current', 'ok', 'error', 'missed'];

function svg(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  if (attrs) for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent?.append(node);
  return node;
}

function text(parent, x, y, content, cls) {
  const node = svg('text', { x, y, class: cls, 'text-anchor': 'middle' }, parent);
  node.textContent = content;
  return node;
}

/** Spelled name -> staff position and accidental. Falls back to a sharp spelling of the MIDI number. */
function placeNote(name, midi) {
  const parsed = parseNoteName(name) ?? parseNoteName(midiToName(midi));
  if (!parsed) return null;
  return {
    d: parsed.octave * 7 + LETTER_INDEX[parsed.letter],
    alter: parsed.alter,
    label: parsed.letter + (parsed.alter > 0 ? '#'.repeat(parsed.alter) : 'b'.repeat(-parsed.alter)),
  };
}

/** Turn the exercise into drawable columns and work out which staves are needed. */
function analyze(exercise) {
  const hand = exercise?.hand === 'left' || exercise?.hand === 'both' ? exercise.hand : 'right';
  const staves = hand === 'both' ? ['treble', 'bass'] : hand === 'left' ? ['bass'] : ['treble'];
  const steps = Array.isArray(exercise?.steps) ? exercise.steps : [];
  const columns = steps.map((step, index) => {
    const notes = [];
    const midis = Array.isArray(step?.notes) ? step.notes : [];
    midis.forEach((midi, i) => {
      const placed = placeNote(step.names?.[i], midi);
      if (!placed) return;
      const noteHand = step.hands?.[i] === 'L' ? 'L' : step.hands?.[i] === 'R' ? 'R' : hand === 'left' ? 'L' : 'R';
      const finger = Number.isInteger(step.fingers?.[i]) ? step.fingers[i] : null;
      notes.push({
        ...placed,
        midi,
        hand: noteHand,
        finger,
        staff: staves.length === 2 ? (noteHand === 'L' ? 'bass' : 'treble') : staves[0],
      });
    });
    notes.sort((a, b) => a.d - b.d || a.midi - b.midi);
    const beats = Number.isFinite(step?.beats) && step.beats > 0 ? step.beats : 1;
    return { index, beats, label: typeof step?.label === 'string' ? step.label : '', notes };
  });
  return { staves, columns, beatsPerBar: [2, 3, 4, 6].includes(exercise?.beatsPerBar) ? exercise.beatsPerBar : 4 };
}

function noteShape(beats) {
  const dotted = [0.375, 0.75, 1.5, 3, 6].some((value) => Math.abs(beats - value) < 0.01);
  if (beats >= 4) return { open: true, stem: false, flags: 0, dotted };
  if (beats >= 2) return { open: true, stem: true, flags: 0, dotted };
  if (beats >= 1) return { open: false, stem: true, flags: 0, dotted };
  if (beats >= 0.5) return { open: false, stem: true, flags: 1, dotted };
  return { open: false, stem: true, flags: 2, dotted };
}

// ---------------------------------------------------------------- symbols

function drawTrebleClef(parent, x, top) {
  const g = svg('g', { class: 'staff-clef', transform: `translate(${x} ${top})` }, parent);
  svg(
    'path',
    {
      d:
        'M 7.5 49.5 C 6.5 55 14 57 15.6 51 L 10.8 -5 ' +
        'C 9.8 -12 13 -17 16.4 -16.6 C 20.4 -12 18 -3 12 3.6 ' +
        'C 5.5 11 0.6 17.6 1 25.6 C 1.5 34 8.5 40.6 15.6 39.6 ' +
        'C 22.6 38.6 25.6 31.6 23.6 26 C 21.6 20.6 14 19 10.4 22.6 ' +
        'C 6.6 26.6 8.6 33 13.6 33.4',
      fill: 'none',
      'stroke-width': 2.1,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    g,
  );
  svg('circle', { cx: 8.3, cy: 49.3, r: 2.7, class: 'staff-fill' }, g);
}

function drawBassClef(parent, x, top) {
  const g = svg('g', { class: 'staff-clef', transform: `translate(${x} ${top})` }, parent);
  svg(
    'path',
    {
      d:
        'M 4 11 C 3 3.5 8 0 13 0 C 19.5 0 23.5 5 23.5 12 C 23.5 22 14 31 2 37.5 ' +
        'C 12 30 17.6 21.6 17.6 12 C 17.6 6 15.6 2.4 12.4 2.4 C 9 2.4 6.6 5 6.4 9 Z',
      class: 'staff-fill',
      stroke: 'none',
    },
    g,
  );
  svg('circle', { cx: 6.6, cy: 10.6, r: 3.5, class: 'staff-fill' }, g);
  svg('circle', { cx: 28.5, cy: 5, r: 1.9, class: 'staff-fill' }, g);
  svg('circle', { cx: 28.5, cy: 15, r: 1.9, class: 'staff-fill' }, g);
}

function drawAccidental(parent, x, y, alter) {
  const g = svg('g', { class: 'staff-acc', transform: `translate(${x} ${y})` }, parent);
  const line = (x1, y1, x2, y2, width) => svg('line', { x1, y1, x2, y2, 'stroke-width': width, 'stroke-linecap': 'butt' }, g);
  const flat = (dx) => {
    line(dx - 2.6, -13, dx - 2.6, 5, 1.3);
    svg('path', { d: `M ${dx - 2.6} -2.4 C ${dx + 0.6} -6 ${dx + 5} -3.6 ${dx + 3.4} 0.2 C ${dx + 2.4} 2.6 ${dx - 0.4} 3.8 ${dx - 2.6} 5`, fill: 'none', 'stroke-width': 1.5 }, g);
  };
  if (alter === 1) {
    line(-1.9, -8.5, -1.9, 10, 1.2);
    line(1.9, -10, 1.9, 8.5, 1.2);
    line(-4.6, -1.8, 4.6, -4.2, 2.3);
    line(-4.6, 4.2, 4.6, 1.8, 2.3);
  } else if (alter === -1) {
    flat(0);
  } else if (alter === 0) {
    line(-2.5, -10, -2.5, 4.4, 1.2);
    line(2.5, -4.4, 2.5, 10, 1.2);
    line(-2.5, -3.2, 2.5, -5, 2.2);
    line(-2.5, 5, 2.5, 3.2, 2.2);
  } else if (alter >= 2) {
    line(-3.4, -3.4, 3.4, 3.4, 1.7);
    line(-3.4, 3.4, 3.4, -3.4, 1.7);
    for (const [cx, cy] of [[-3.4, -3.4], [3.4, 3.4], [-3.4, 3.4], [3.4, -3.4]]) {
      svg('rect', { x: cx - 1.4, y: cy - 1.4, width: 2.8, height: 2.8, class: 'staff-fill', stroke: 'none' }, g);
    }
  } else {
    flat(-3.6);
    flat(3.2);
  }
}

function drawRest(parent, x, staffTop, beats) {
  const g = svg('g', { class: 'staff-rest', transform: `translate(${x} ${staffTop})` }, parent);
  if (beats >= 4) {
    svg('rect', { x: -6, y: SPACE, width: 12, height: 4.6, class: 'staff-fill', stroke: 'none' }, g);
  } else if (beats >= 2) {
    svg('rect', { x: -6, y: SPACE * 2 - 4.6, width: 12, height: 4.6, class: 'staff-fill', stroke: 'none' }, g);
  } else if (beats >= 1) {
    svg('path', { d: 'M -2.6 8 L 3 15.4 L -2 21 L 3.4 28 C -1.6 25.6 -5.4 28.4 -1.4 33', fill: 'none', 'stroke-width': 2.1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
  } else {
    svg('circle', { cx: -2.4, cy: 16.6, r: 2.1, class: 'staff-fill' }, g);
    svg('path', { d: 'M -2.4 18.4 C 0.4 18.6 2.6 17.4 3.6 15.4 L -0.6 30', fill: 'none', 'stroke-width': 1.5, 'stroke-linecap': 'round' }, g);
  }
}

// ---------------------------------------------------------------- one staff of one column

/**
 * Draw the notes of one step that sit on one staff.
 * @returns {{left: number, right: number}} how far the drawing reaches around x
 */
function drawChord(group, notes, x, clef, yBottom, beats, memory) {
  const shape = noteShape(beats);
  const yOf = (d) => yBottom - (d - clef.bottom) * HALF;
  const min = notes[0].d;
  const max = notes[notes.length - 1].d;
  const stemDown = max - clef.middle > clef.middle - min || (max - clef.middle === clef.middle - min && max >= clef.middle);

  // Heads a second apart cannot share a column: one moves to the other side of the stem.
  const shifted = notes.map(() => false);
  if (stemDown) {
    for (let i = notes.length - 2; i >= 0; i -= 1) shifted[i] = notes[i + 1].d - notes[i].d === 1 && !shifted[i + 1];
  } else {
    for (let i = 1; i < notes.length; i += 1) shifted[i] = notes[i].d - notes[i - 1].d === 1 && !shifted[i - 1];
  }
  const side = stemDown ? -1 : 1;
  const headX = (i) => x + (shifted[i] ? side * HEAD_SHIFT : 0);
  const anyShifted = shifted.some(Boolean);
  const leftEdge = x - HEAD_RX - (stemDown && anyShifted ? HEAD_SHIFT : 0);
  const rightEdge = x + HEAD_RX + (!stemDown && anyShifted ? HEAD_SHIFT : 0);

  // Ledger lines.
  const ledger = (d) => svg('line', { x1: leftEdge - 4, x2: rightEdge + 4, y1: yOf(d), y2: yOf(d), class: 'staff-ledger' }, group);
  for (let d = clef.bottom - 2; d >= min; d -= 2) ledger(d);
  for (let d = clef.top + 2; d <= max; d += 2) ledger(d);

  // Accidentals, with the usual rule: show one when it differs from what is in force in this bar.
  const columns = []; // last staff position used in each accidental column
  let accLeft = leftEdge;
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const note = notes[i];
    const key = `${clef.bottom}:${note.d}`;
    if ((memory.get(key) ?? 0) === note.alter) continue;
    memory.set(key, note.alter);
    let column = columns.findIndex((last) => last - note.d >= 6);
    if (column === -1) {
      column = columns.length;
      columns.push(note.d);
    } else {
      columns[column] = note.d;
    }
    const ax = leftEdge - 8.5 - column * 10;
    drawAccidental(group, ax, yOf(note.d), note.alter);
    accLeft = Math.min(accLeft, ax - 6);
  }

  // Heads.
  notes.forEach((note, i) => {
    const cx = headX(i);
    const cy = yOf(note.d);
    svg(
      'ellipse',
      {
        cx,
        cy,
        rx: HEAD_RX,
        ry: 4,
        transform: `rotate(-20 ${cx} ${cy})`,
        class: shape.open ? 'staff-head staff-head-open' : 'staff-head staff-fill',
      },
      group,
    );
  });

  // Stem and flags.
  if (shape.stem) {
    const sx = x + side * (HEAD_RX - 0.5);
    const from = stemDown ? yOf(max) + 1 : yOf(min) - 1;
    const to = stemDown ? yOf(min) + STEM : yOf(max) - STEM;
    svg('line', { x1: sx, x2: sx, y1: from, y2: to, class: 'staff-stem' }, group);
    for (let f = 0; f < shape.flags; f += 1) {
      const fy = to + (stemDown ? -1 : 1) * f * 7;
      const dir = stemDown ? -1 : 1;
      svg('path', { d: `M ${sx} ${fy} c 1 ${6 * dir} 8.5 ${8 * dir} 6.5 ${17 * dir}`, class: 'staff-flag' }, group);
    }
  }

  // Augmentation dots (a dot never sits on a line: it moves up into the space).
  let right = rightEdge;
  if (shape.dotted) {
    const used = new Set();
    for (const note of notes) {
      let d = note.d;
      if ((d - clef.bottom) % 2 === 0) d += 1;
      if (used.has(d)) continue;
      used.add(d);
      svg('circle', { cx: rightEdge + 5.5, cy: yOf(d), r: 1.7, class: 'staff-fill' }, group);
    }
    right = rightEdge + 8;
  }
  if (shape.flags && !stemDown) right = Math.max(right, x + HEAD_RX + 8);
  return { left: x - accLeft, right: right - x };
}

// ---------------------------------------------------------------- public API

/**
 * Render an exercise as notation.
 * @param {HTMLElement} container
 * @param {object} exercise  an Exercise (see shared/exercises.js)
 * @param {{showNames?: boolean, showFingers?: boolean}} [options]
 * @returns {{update(stepStates: string[], currentIndex: number): void, destroy(): void, element: SVGElement}}
 */
export function renderStaff(container, exercise, { showNames = true, showFingers = true } = {}) {
  container.querySelector(':scope > svg.staff')?.remove();
  const SCALE = container.clientWidth && container.clientWidth < 520 ? SCALE_NARROW : SCALE_WIDE;
  const { staves, columns, beatsPerBar } = analyze(exercise);
  const grand = staves.length === 2;

  // Vertical layout: leave room for ledger lines, finger numbers and labels.
  const range = { treble: { min: Infinity, max: -Infinity }, bass: { min: Infinity, max: -Infinity } };
  let fingersAbove = 0;
  let fingersBelow = 0;
  let hasLabels = false;
  for (const column of columns) {
    if (column.label) hasLabels = true;
    const up = column.notes.filter((n) => n.hand === 'R' && n.finger).length;
    const down = column.notes.filter((n) => n.hand === 'L' && n.finger).length;
    fingersAbove = Math.max(fingersAbove, up);
    fingersBelow = Math.max(fingersBelow, down);
    for (const note of column.notes) {
      range[note.staff].min = Math.min(range[note.staff].min, note.d);
      range[note.staff].max = Math.max(range[note.staff].max, note.d);
    }
  }
  if (!showFingers) fingersAbove = fingersBelow = 0;
  const upper = staves[0];
  const lower = staves[staves.length - 1];
  const above = Math.max(0, range[upper].max - CLEFS[upper].top) * HALF;
  const below = Math.max(0, CLEFS[lower].bottom - range[lower].min) * HALF;
  const fingerRow = 11;
  const labelRow = hasLabels ? 15 : 0;
  const top = Math.max(grand || upper === 'treble' ? 30 : 16, 8 + labelRow + fingersAbove * fingerRow + 8 + above);
  // In a grand staff, notes between the staves need room too.
  let gap = 58;
  if (grand) {
    const trebleLow = Math.max(0, CLEFS.treble.bottom - range.treble.min) * HALF;
    const bassHigh = Math.max(0, range.bass.max - CLEFS.bass.top) * HALF;
    gap = Math.max(gap, trebleLow + bassHigh + 26);
  }
  const staffTop = { [upper]: top };
  if (grand) staffTop.bass = top + SPACE * 4 + gap;
  const lowerBottom = staffTop[lower] + SPACE * 4;
  // Stems of notes on the upper half of the staff reach a little below it: keep clear of them.
  const fingersBelowTop = lowerBottom + Math.max(below, 14) + 14;
  const namesY = fingersBelowTop + fingersBelow * fingerRow + (showNames ? 12 : 0);
  const height = Math.max(namesY + 10, lowerBottom + Math.max(below, 22) + 12);

  // Horizontal layout.
  const startX = grand ? 62 : 54;
  const widths = columns.map((column) => {
    let width = column.beats >= 3 ? 50 : column.beats >= 2 ? 42 : 34;
    const names = [...new Set(column.notes.map((n) => n.label))];
    if (showNames) width = Math.max(width, names.join(' ').length * 6.2 + 10);
    if (column.label) width = Math.max(width, column.label.length * 6.6 + 10);
    if (column.notes.some((n) => n.alter !== 0)) width += 9;
    const ds = column.notes.map((n) => n.d);
    if (ds.some((d, i) => i > 0 && d - ds[i - 1] === 1)) width += 8;
    return width;
  });
  const natural = widths.reduce((sum, w) => sum + w, 0);
  const available = (container.clientWidth || 0) / SCALE - startX - 26;
  const stretch = natural > 0 ? Math.max(1, Math.min(1.8, available / natural)) : 1;

  const root = svg('svg', { class: 'staff', role: 'img' });
  root.setAttribute(
    'aria-label',
    `${exercise?.title ?? 'Exercise'}: ${columns.length} ${columns.length === 1 ? 'step' : 'steps'} in music notation`,
  );
  const background = svg('g', { class: 'staff-lines' }, root);
  const stepsLayer = svg('g', {}, root);

  let x = startX;
  let beatInBar = 0;
  const barLines = [];
  const groups = [];
  const centers = [];
  const memory = new Map();
  const systemTop = staffTop[upper];

  columns.forEach((column, i) => {
    const width = widths[i] * stretch;
    const left = x;
    const cx = x + width / 2 + (column.notes.some((n) => n.alter !== 0) ? 4 : 0);
    const group = svg('g', { class: 'staff-step st-pending', 'data-step': i }, stepsLayer);
    svg('rect', { x: left + 1, y: 3, width: width - 2, height: height - 6, rx: 7, class: 'staff-hl' }, group);

    if (!column.notes.length) {
      for (const staff of staves) drawRest(group, cx, staffTop[staff], column.beats);
    }
    for (const staff of staves) {
      const notes = column.notes.filter((n) => n.staff === staff);
      if (!notes.length) continue;
      drawChord(group, notes, cx, CLEFS[staff], staffTop[staff] + SPACE * 4, column.beats, memory);
    }

    if (column.label) text(group, cx, 8 + 11, column.label, 'staff-label');
    if (showFingers) {
      const rightHand = column.notes.filter((n) => n.hand === 'R' && n.finger).sort((a, b) => b.d - a.d);
      rightHand.forEach((n, row) => {
        const y = top - above - 8 - (rightHand.length - 1 - row) * fingerRow;
        text(group, cx, y, String(n.finger), 'staff-finger');
      });
      const leftHand = column.notes.filter((n) => n.hand === 'L' && n.finger).sort((a, b) => b.d - a.d);
      leftHand.forEach((n, row) => text(group, cx, fingersBelowTop + row * fingerRow, String(n.finger), 'staff-finger staff-finger-l'));
    }
    if (showNames && column.notes.length) {
      const names = [...new Set(column.notes.map((n) => n.label))].join(' ');
      text(group, cx, namesY, names, 'staff-name');
    }

    groups.push(group);
    centers.push({ left, right: left + width });
    x += width;
    beatInBar += column.beats;
    if (beatInBar >= beatsPerBar - 0.001) {
      beatInBar = 0;
      memory.clear();
      if (i < columns.length - 1) {
        barLines.push(x + 3);
        x += 6;
      }
    }
  });

  const endX = x + 8;
  const width = endX + 6;

  // Staff lines, clefs and bar lines go behind the notes.
  for (const staff of staves) {
    for (let line = 0; line < 5; line += 1) {
      const y = staffTop[staff] + line * SPACE;
      svg('line', { x1: grand ? 14 : 6, x2: endX, y1: y, y2: y }, background);
    }
    if (staff === 'treble') drawTrebleClef(background, grand ? 20 : 12, staffTop[staff]);
    else drawBassClef(background, grand ? 20 : 12, staffTop[staff]);
  }
  const bar = (bx, cls) => svg('line', { x1: bx, x2: bx, y1: systemTop, y2: lowerBottom, class: cls }, background);
  for (const bx of barLines) bar(bx);
  bar(endX - 4.5);
  bar(endX - 0.9, 'staff-bar-thick');
  if (grand) {
    bar(14);
    const mid = (systemTop + lowerBottom) / 2;
    const h = lowerBottom - systemTop;
    svg(
      'path',
      {
        class: 'staff-brace',
        d:
          `M 10 ${systemTop} C 2 ${systemTop + h * 0.22} 11 ${mid - h * 0.16} 3 ${mid} ` +
          `C 11 ${mid + h * 0.16} 2 ${lowerBottom - h * 0.22} 10 ${lowerBottom}`,
      },
      background,
    );
  }

  root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  root.setAttribute('width', String(Math.round(width * SCALE)));
  root.setAttribute('height', String(Math.round(height * SCALE)));
  container.append(root);

  const applied = groups.map(() => 'pending');
  let appliedCurrent = -1;

  return {
    element: root,
    update(stepStates, currentIndex) {
      for (let i = 0; i < groups.length; i += 1) {
        const state = STATES.includes(stepStates?.[i]) ? stepStates[i] : 'pending';
        if (state !== applied[i]) {
          groups[i].classList.remove(`st-${applied[i]}`);
          groups[i].classList.add(`st-${state}`);
          applied[i] = state;
        }
      }
      const current = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < groups.length ? currentIndex : -1;
      if (current === appliedCurrent) return;
      if (appliedCurrent >= 0) groups[appliedCurrent].classList.remove('is-current');
      appliedCurrent = current;
      if (current < 0) return;
      groups[current].classList.add('is-current');
      // Keep the current step comfortably in view.
      const left = centers[current].left * SCALE;
      const right = centers[current].right * SCALE;
      const view = container.clientWidth;
      if (!view || container.scrollWidth <= view) return;
      const margin = Math.min(120, view * 0.25);
      if (left < container.scrollLeft + margin * 0.4 || right > container.scrollLeft + view - margin) {
        container.scrollTo({ left: Math.max(0, left - view * 0.3), behavior: 'smooth' });
      }
    },
    destroy() {
      root.remove();
    },
  };
}
