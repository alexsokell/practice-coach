// Renders a gallery of exercises with web/ui/staff.js in headless Chromium, checks that
// notes sit on the right staff positions, and can save screenshots for a visual check.
//
//   node e2e/staff-preview.mjs [--shots DIR]

import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsFlag = process.argv.indexOf('--shots');
const shotsDir = shotsFlag > -1 ? path.resolve(process.argv[shotsFlag + 1]) : null;

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
const PAGE = `<!doctype html><meta charset="utf-8"><title>staff preview</title>
<link rel="stylesheet" href="/web/styles.css"><link rel="stylesheet" href="/web/ui/staff.css">
<body style="padding:16px"><div id="gallery" style="display:grid;gap:14px"></div>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE);
    return;
  }
  const file = path.join(root, path.normalize(url.pathname));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  let body;
  try {
    body = await readFile(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

/** Runs in the page: build the gallery and return measurements. */
async function buildGallery() {
  const { renderStaff } = await import('/web/ui/staff.js');
  let builder = null;
  try {
    builder = await import('/shared/exercises.js');
  } catch {
    builder = null; // the exercise builder may not exist yet: hand-made samples still render
  }
  const step = (names, midis, beats, fingers, hands, label) => ({
    notes: midis,
    names,
    beats,
    fingers: fingers ?? midis.map(() => null),
    hands: hands ?? midis.map(() => 'R'),
    ...(label ? { label } : {}),
  });
  const samples = [];
  const add = (title, exercise) => samples.push({ title, exercise });

  add('Positions: C4 E4 G4 B4 D5 F5 A5 C6 (treble)', {
    title: 'Treble positions',
    hand: 'right',
    beatsPerBar: 4,
    steps: [
      step(['C4'], [60], 1, [1]),
      step(['E4'], [64], 1, [3]),
      step(['G4'], [67], 1, [5]),
      step(['B4'], [71], 1),
      step(['D5'], [74], 2),
      step(['F5'], [77], 2),
      step(['A5'], [81], 4),
      step(['C6'], [84], 4),
    ],
  });
  add('Positions: C2 E2 G2 B2 D3 F3 A3 C4 (bass)', {
    title: 'Bass positions',
    hand: 'left',
    beatsPerBar: 4,
    steps: [
      step(['C2'], [36], 1, [5], ['L']),
      step(['E2'], [40], 1, [3], ['L']),
      step(['G2'], [43], 1, [1], ['L']),
      step(['B2'], [47], 1, null, ['L']),
      step(['D3'], [50], 2, null, ['L']),
      step(['F3'], [53], 2, null, ['L']),
      step(['A3'], [57], 4, null, ['L']),
      step(['C4'], [60], 4, null, ['L']),
    ],
  });
  add('Rhythm, rests, accidentals, a second, ledger lines', {
    title: 'Mixed',
    hand: 'right',
    beatsPerBar: 4,
    steps: [
      step(['F#4'], [66], 1, [2]),
      step(['F4'], [65], 1, [1]), // needs a natural
      step(['Bb4'], [70], 0.5, [4]),
      step(['A4'], [69], 0.5, [3]),
      step([], [], 1),
      step(['C4', 'D4', 'G4'], [60, 62, 67], 1.5, [1, 2, 5]), // second in a chord, dotted
      step(['E5'], [76], 0.5),
      step([], [], 2),
      step(['C#4', 'E4', 'G#4'], [61, 64, 68], 2, [1, 2, 4], null, 'C#m'),
      step(['Fx4'], [67], 0.25),
      step(['Bbb4'], [69], 0.25),
      step(['A3'], [57], 0.5),
      step(['D6'], [86], 3),
      step([], [], 4),
    ],
  });
  add('Grand staff by hand: C major, hands together', {
    title: 'Hands together',
    hand: 'both',
    beatsPerBar: 4,
    steps: [
      ['C', 5, 1], ['D', 4, 2], ['E', 3, 3], ['F', 2, 1], ['G', 1, 2], ['A', 3, 3], ['B', 2, 4], ['C', 1, 5],
    ].map(([letter, lf, rf], i) => {
      const midis = [48, 50, 52, 53, 55, 57, 59, 60];
      const up = i === 7 ? 1 : 0;
      return step([`${letter}${3 + up}`, `${letter}${4 + up}`], [midis[i], midis[i] + 12], 1, [lf, rf], ['L', 'R']);
    }),
  });

  if (builder) {
    const specs = [
      { type: 'scale', title: 'C major scale, right hand', goal: 'g', hand: 'right', bpm: 60, mode: 'wait', root: 'C', scale: 'major', octaves: 1, direction: 'up_down', start_octave: 4, note_beats: 1 },
      { type: 'scale', title: 'F# major scale, right hand', goal: 'g', hand: 'right', bpm: 60, mode: 'wait', root: 'F#', scale: 'major', octaves: 1, direction: 'up', start_octave: 4, note_beats: 1 },
      { type: 'scale', title: 'A harmonic minor, left hand', goal: 'g', hand: 'left', bpm: 60, mode: 'wait', root: 'A', scale: 'harmonic_minor', octaves: 1, direction: 'up_down', start_octave: 2, note_beats: 1 },
      { type: 'scale', title: 'C major, both hands, 2 octaves', goal: 'g', hand: 'both', bpm: 60, mode: 'wait', root: 'C', scale: 'major', octaves: 2, direction: 'up_down', start_octave: 4, note_beats: 1 },
      { type: 'chords', title: 'C F G7 C, both hands', goal: 'g', hand: 'both', bpm: 60, mode: 'wait', chords: ['C', 'F', 'G7', 'C'], style: 'block', voicing: 'root', start_octave: 4, beats_per_chord: 4 },
      { type: 'chords', title: 'C Am F G broken', goal: 'g', hand: 'right', bpm: 60, mode: 'wait', chords: ['C', 'Am', 'F', 'G'], style: 'broken', voicing: 'smooth', start_octave: 4, beats_per_chord: 4 },
      { type: 'arpeggio', title: 'Eb major arpeggio, right hand', goal: 'g', hand: 'right', bpm: 60, mode: 'wait', root: 'Eb', quality: 'major', octaves: 2, direction: 'up_down', start_octave: 4, note_beats: 1 },
    ];
    for (const spec of specs) {
      const built = builder.buildExercise(spec);
      if (built.ok) add(`Built: ${spec.title}`, built.exercise);
      else add(`BUILD FAILED: ${spec.title}: ${built.errors.join('; ')}`, { title: 'x', hand: 'right', beatsPerBar: 4, steps: [] });
    }
    for (const spec of builder.STARTER_EXERCISES ?? []) {
      const built = builder.buildExercise(spec);
      if (built.ok && built.exercise.type === 'custom') add(`Starter: ${built.exercise.title}`, built.exercise);
    }
  }

  const gallery = document.getElementById('gallery');
  const handles = [];
  for (const sample of samples) {
    const card = document.createElement('div');
    card.className = 'card';
    const heading = document.createElement('p');
    heading.className = 'muted small';
    heading.textContent = sample.title;
    const wrap = document.createElement('div');
    wrap.className = 'staff-wrap';
    card.append(heading, wrap);
    gallery.append(card);
    const handle = renderStaff(wrap, sample.exercise, {});
    const count = sample.exercise.steps.length;
    const states = sample.exercise.steps.map((_, i) => (i < count * 0.3 ? 'ok' : i < count * 0.4 ? 'error' : i < count * 0.5 ? 'missed' : 'pending'));
    handle.update(states, Math.floor(count * 0.5));
    handles.push({ handle, wrap, count });
  }

  // Measurements for the assertions.
  const headY = (card, stepIndex) => {
    const heads = handles[card].wrap.querySelectorAll(`[data-step="${stepIndex}"] ellipse`);
    return [...heads].map((h) => Number(h.getAttribute('cy')));
  };
  const lineYs = (card) =>
    [...handles[card].wrap.querySelectorAll('.staff-lines > line')]
      .filter((l) => l.getAttribute('y1') === l.getAttribute('y2'))
      .map((l) => Number(l.getAttribute('y1')));
  const first = handles[0];
  const classBefore = first.wrap.querySelector('[data-step="0"]').getAttribute('class');
  first.handle.update(first.wrap.__states ?? [], 0);
  const out = {
    samples: samples.map((s) => s.title),
    trebleLines: lineYs(0),
    treble: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => headY(0, i)[0]),
    bassLines: lineYs(1),
    bass: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => headY(1, i)[0]),
    ledgersC4: handles[0].wrap.querySelectorAll('[data-step="0"] .staff-ledger').length,
    ledgersC6: handles[0].wrap.querySelectorAll('[data-step="7"] .staff-ledger').length,
    ledgersBassC4: handles[1].wrap.querySelectorAll('[data-step="7"] .staff-ledger').length,
    accidentals: [0, 1, 2, 3, 8, 9, 10].map((i) => handles[2].wrap.querySelectorAll(`[data-step="${i}"] .staff-acc`).length),
    rests: handles[2].wrap.querySelectorAll('.staff-rest').length,
    secondOffsets: [...handles[2].wrap.querySelectorAll('[data-step="5"] ellipse')].map((h) => Number(h.getAttribute('cx'))),
    grandLineCount: lineYs(3).length,
    grandHeads: headY(3, 0),
    classBefore,
    classAfter: first.wrap.querySelector('[data-step="0"]').getAttribute('class'),
    stepGroups: handles.map((h) => h.wrap.querySelectorAll('.staff-step').length === h.count),
    labels: handles[2].wrap.querySelector('[data-step="8"] .staff-label')?.textContent ?? null,
  };
  // Re-render in place: the old SVG must be replaced, not stacked.
  renderStaff(first.wrap, samples[0].exercise, {});
  out.svgCountAfterRerender = first.wrap.querySelectorAll('svg').length;
  // destroy() removes it.
  const temp = renderStaff(handles[1].wrap, samples[1].exercise, { showNames: false, showFingers: false });
  out.noLabels = handles[1].wrap.querySelectorAll('.staff-name, .staff-finger').length;
  temp.destroy();
  out.svgCountAfterDestroy = handles[1].wrap.querySelectorAll('svg').length;
  renderStaff(handles[1].wrap, samples[1].exercise, {});
  // Odd input must not throw.
  try {
    renderStaff(document.createElement('div'), null, {});
    renderStaff(document.createElement('div'), { steps: [{ notes: [61], names: ['??'], beats: 'x' }] }, {});
    out.survivesBadInput = true;
  } catch (err) {
    out.survivesBadInput = String(err);
  }
  return out;
}

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(base);
  const m = await page.evaluate(buildGallery);
  console.log(`rendered ${m.samples.length} samples`);
  for (const title of m.samples) if (title.startsWith('BUILD FAILED')) check(title, false);

  // Treble staff: lines top to bottom are F5 D5 B4 G4 E4.
  const [f5, d5, b4, g4, e4] = [...m.trebleLines].sort((a, b) => a - b);
  const half = (e4 - g4) / 2;
  check('five treble lines, evenly spaced', m.trebleLines.length === 5 && Math.abs(e4 - f5 - half * 8) < 0.01);
  check('C4 sits one ledger line below the treble staff', Math.abs(m.treble[0] - (e4 + half * 2)) < 0.01 && m.ledgersC4 === 1, JSON.stringify(m.treble));
  check('E4 on the bottom line, G4 on the second line', Math.abs(m.treble[1] - e4) < 0.01 && Math.abs(m.treble[2] - g4) < 0.01);
  check('B4 on the middle line, D5 and F5 on the upper lines', Math.abs(m.treble[3] - b4) < 0.01 && Math.abs(m.treble[4] - d5) < 0.01 && Math.abs(m.treble[5] - f5) < 0.01);
  check('A5 is one ledger line above, C6 two', Math.abs(m.treble[6] - (f5 - half * 2)) < 0.01 && Math.abs(m.treble[7] - (f5 - half * 4)) < 0.01 && m.ledgersC6 === 2);

  // Bass staff: lines top to bottom are A3 F3 D3 B2 G2.
  const [a3, f3, d3, b2, g2] = [...m.bassLines].sort((a, b) => a - b);
  check('F3 is on the fourth line of the bass staff', Math.abs(m.bass[5] - f3) < 0.01);
  check('G2 B2 D3 A3 on their lines', [m.bass[2] - g2, m.bass[3] - b2, m.bass[4] - d3, m.bass[6] - a3].every((v) => Math.abs(v) < 0.01));
  check('middle C is one ledger line above the bass staff', Math.abs(m.bass[7] - (a3 - half * 2)) < 0.01 && m.ledgersBassC4 === 1);
  check('C2 and E2 hang below the bass staff', m.bass[0] > g2 && m.bass[1] > g2 && m.bass[0] > m.bass[1]);

  check('sharp shown, then a natural on the same line in the same bar', m.accidentals[0] === 1 && m.accidentals[1] === 1);
  check('flat shown, plain A has none', m.accidentals[2] === 1 && m.accidentals[3] === 0);
  check('chord accidentals: C# and G# drawn, E none', m.accidentals[4] === 2);
  check('double sharp and double flat are drawn', m.accidentals[5] === 1 && m.accidentals[6] === 1);
  check('rests are drawn', m.rests === 3, String(m.rests));
  check('a second in a chord offsets one head', new Set(m.secondOffsets.map((v) => v.toFixed(1))).size === 2, JSON.stringify(m.secondOffsets));
  check('chord symbol label is shown', m.labels === 'C#m');
  check('grand staff has ten lines and one head per staff', m.grandLineCount === 10 && m.grandHeads.length === 2);
  check('update() changes the step class', m.classBefore !== m.classAfter && /is-current/.test(m.classAfter), `${m.classBefore} -> ${m.classAfter}`);
  check('one group per step', m.stepGroups.every(Boolean));
  check('re-rendering replaces the old drawing', m.svgCountAfterRerender === 1);
  check('names and fingers can be hidden', m.noLabels === 0);
  check('destroy() removes the drawing', m.svgCountAfterDestroy === 0);
  check('bad input does not throw', m.survivesBadInput === true, String(m.survivesBadInput));
  check('no console errors', errors.length === 0, errors.join(' | '));

  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    await page.screenshot({ path: path.join(shotsDir, 'staff-light.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(shotsDir, 'staff-dark.png'), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.evaluate(buildGallery);
    await page.screenshot({ path: path.join(shotsDir, 'staff-phone.png'), fullPage: true });
    console.log(`screenshots in ${shotsDir}`);
  }
} catch (err) {
  failures.push(`crashed: ${err?.stack ?? err}`);
  console.log(`  FAIL crashed: ${err?.stack ?? err}`);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
