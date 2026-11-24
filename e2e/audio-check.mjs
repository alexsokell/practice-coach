// Browser check for web/audio/engine.js: runs the synth, the demo player and the
// metronome in headless Chromium and asserts on timing and on rendered audio.
//
//   node e2e/audio-check.mjs

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>audio check</title>');
    return;
  }
  const file = path.join(root, path.normalize(url.pathname));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
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

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto(base);

  const result = await page.evaluate(async () => {
    const { AudioEngine } = await import('/web/audio/engine.js');
    const out = {};
    const engine = new AudioEngine();

    // Before resume: everything is a silent no-op.
    out.readyBefore = engine.ready;
    engine.noteOn(60, 80);
    engine.noteOff(60);
    engine.allNotesOff();
    engine.setVolume(0.5);

    // The demo player still walks the steps without sound.
    const silentSteps = [];
    const silent = engine.playSteps([{ notes: [60], beats: 1 }, { notes: [62], beats: 1 }], { bpm: 600, onStep: (i) => silentSteps.push(i) });
    await silent.done;
    out.silentSteps = silentSteps;

    out.resumed = await engine.resume();
    out.resumedAgain = await engine.resume();
    out.readyAfter = engine.ready;
    out.latency = engine.outputLatencyMs;

    // Chords, repeated notes, more voices than the cap.
    for (let i = 0; i < 40; i += 1) engine.noteOn(36 + i, 40 + i * 2);
    out.voicesAfterBurst = engine.voices.filter((v) => !v.released).length;
    engine.allNotesOff();
    await new Promise((r) => setTimeout(r, 400));
    out.voicesAfterOff = engine.voices.length;

    // Demo playback: 4 steps at 300 bpm (200 ms per beat).
    const steps = [
      { notes: [60], beats: 1 },
      { notes: [64, 67], beats: 1 },
      { notes: [], beats: 1 },
      { notes: [72], beats: 1 },
    ];
    const seen = [];
    const t0 = performance.now();
    const demo = engine.playSteps(steps, { bpm: 300, onStep: (i) => seen.push([i, performance.now() - t0]) });
    await demo.done;
    out.demoSteps = seen.map(([i]) => i);
    out.demoGaps = seen.slice(1).map(([, t], i) => t - seen[i][1]);
    out.demoTotal = performance.now() - t0;

    // Stopping a demo early resolves done and stops the callbacks.
    const early = [];
    const stopped = engine.playSteps(steps, { bpm: 60, onStep: (i) => early.push(i) });
    await new Promise((r) => setTimeout(r, 250));
    stopped.stop();
    await stopped.done;
    const countAtStop = early.length;
    await new Promise((r) => setTimeout(r, 1300));
    out.earlyStopStable = early.length === countAtStop && countAtStop >= 1 && countAtStop < 4;

    // Metronome at 240 bpm: beats 250 ms apart, count-in of 3.
    const beats = [];
    const metro = engine.startMetronome({ bpm: 240, beatsPerBar: 3, countInBeats: 3, onBeat: (i, t) => beats.push([i, t]) });
    out.startPerfVsNow = metro.startPerfMs - performance.now();
    await new Promise((r) => setTimeout(r, 1700));
    metro.stop();
    const countAfterStop = beats.length;
    await new Promise((r) => setTimeout(r, 600));
    out.metroStopped = beats.length === countAfterStop;
    out.beatIndexes = beats.map(([i]) => i);
    out.beatGaps = beats.slice(1).map(([, t], i) => t - beats[i][1]);
    out.beatZero = beats.find(([i]) => i === 0)?.[1] ?? null;
    out.startPerfMs = metro.startPerfMs;

    // A second start replaces the first.
    const a = engine.startMetronome({ bpm: 120, onBeat: () => {} });
    const b = engine.startMetronome({ bpm: 120, onBeat: () => {} });
    out.replaced = engine._metronome === b;
    a.stop();
    b.stop();
    engine.stopMetronome();

    // Render one note offline and inspect the samples.
    class Offline extends OfflineAudioContext {
      constructor() {
        super(1, 44100 * 2, 44100);
      }
      get state() {
        return 'running';
      }
      async resume() {}
    }
    const offlineEngine = new AudioEngine({ AudioContextClass: Offline });
    await offlineEngine.resume();
    offlineEngine.noteOn(60, 100, 0.05);
    offlineEngine.noteOn(64, 100, 0.05);
    offlineEngine.noteOn(67, 100, 0.05);
    offlineEngine.noteOff(60, 1.0);
    const buffer = await offlineEngine.ctx.startRendering();
    const data = buffer.getChannelData(0);
    let peak = 0;
    let energyEarly = 0;
    let energyLate = 0;
    let maxJump = 0;
    for (let i = 0; i < data.length; i += 1) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
      if (i > 0) maxJump = Math.max(maxJump, Math.abs(data[i] - data[i - 1]));
      if (i > 44100 * 0.06 && i < 44100 * 0.3) energyEarly += v * v;
      if (i > 44100 * 1.7) energyLate += v * v;
    }
    out.offline = { peak, energyEarly, energyLate, maxJump, silentStart: Math.abs(data[100]) };
    return out;
  });

  check('silent and not ready before resume()', result.readyBefore === false);
  check('demo walks the steps even without sound', JSON.stringify(result.silentSteps) === '[0,1]', JSON.stringify(result.silentSteps));
  check('resume() makes the engine ready', result.resumed === true && result.readyAfter === true && result.resumedAgain === true);
  check('voice count is capped', result.voicesAfterBurst <= 24, String(result.voicesAfterBurst));
  check('allNotesOff clears every voice', result.voicesAfterOff === 0, String(result.voicesAfterOff));
  check('demo fires onStep for each step in order', JSON.stringify(result.demoSteps) === '[0,1,2,3]', JSON.stringify(result.demoSteps));
  check('demo steps are about 200 ms apart', result.demoGaps.every((gap) => Math.abs(gap - 200) < 40), JSON.stringify(result.demoGaps));
  check('demo done resolves at the end', result.demoTotal > 780 && result.demoTotal < 1200, String(result.demoTotal));
  check('stopping a demo halts its callbacks', result.earlyStopStable === true);
  check(
    'metronome beat indexes run from the count-in',
    result.beatIndexes[0] === -3 && result.beatIndexes.every((v, i) => v === -3 + i) && result.beatIndexes.length >= 6,
    JSON.stringify(result.beatIndexes),
  );
  check('metronome beats are 250 ms apart', result.beatGaps.every((gap) => Math.abs(gap - 250) < 2), JSON.stringify(result.beatGaps));
  check('startPerfMs is the heard time of beat 0', Math.abs(result.beatZero - result.startPerfMs) < 1, `${result.beatZero} vs ${result.startPerfMs}`);
  check('beat 0 is after the count-in', result.startPerfVsNow > 700 && result.startPerfVsNow < 1300, String(result.startPerfVsNow));
  check('stop() ends the metronome', result.metroStopped === true);
  check('a new metronome replaces the old one', result.replaced === true);
  check('rendered note is audible', result.offline.peak > 0.02, JSON.stringify(result.offline));
  check('rendered audio never clips', result.offline.peak <= 1.0, JSON.stringify(result.offline));
  check('note decays over time', result.offline.energyLate < result.offline.energyEarly * 0.5, JSON.stringify(result.offline));
  check('no click at the start', result.offline.silentStart < 0.001 && result.offline.maxJump < 0.25, JSON.stringify(result.offline));
  check('no console errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  failures.push(`crashed: ${err?.stack ?? err}`);
  console.log(`  FAIL crashed: ${err?.stack ?? err}`);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
